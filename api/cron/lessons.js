// 하루 한 번 — 반마다 걸어둔 유튜브 재생목록을 훑어 «그날 무엇을 했는지» 를 채운다.
//
// 왜 «오늘 것» 이 아니라 «최근 며칠 중 빈 날» 인가:
//   무료 요금제 크론은 하루 한 번에 **±59분** 오차가 있다. 23:00 에 걸어도
//   23:59 에 돌 수 있고, 한 번 걸러 못 돌 수도 있다. «오늘» 을 그때 계산하면
//   시각이 밀리는 만큼 날짜가 어긋난다.
//   빈 날을 메우는 방식이면 시각이 밀려도, 한 번 걸러도, 영상을 늦게 올려도 맞다.
//   여러 번 돌아도 결과가 같다.
//
// 저장 자리는 classes/{cid}/days/{date}.lesson 이다. 새 컬렉션을 만들면 보안 규칙을
// 콘솔에 다시 붙여넣어야 하는데, days 는 이미 반 사람이 읽고 선생님이 쓴다.
//
// 선생님이 손대거나 PC 에서 자막으로 올린 것(source ≠ "title")은 덮지 않는다.
import { listDocs, getDoc, patchDoc } from "../_google.js";
import { readPlaylist, lineOf } from "../lesson.js";

const DAYS_BACK = 7;          // 이만큼 거슬러 올라가며 빈 날을 메운다
const KST = 9 * 60 * 60 * 1000;

// 서버는 UTC 로 돈다. 한국 날짜로 세어야 «오늘» 이 맞는다.
function kstToday() {
  return new Date(Date.now() + KST).toISOString().slice(0, 10);
}
function backDays(n) {
  const out = [];
  const t = Date.now() + KST;
  for (let i = 0; i < n; i++) out.push(new Date(t - i * 86400000).toISOString().slice(0, 10));
  return out;
}

export default async function handler(req, res) {
  // 크론이 부르는 것이 맞는지. CRON_SECRET 을 넣어두면 그것만 통과시킨다.
  // 안 넣어도 돌게 둔다 — 이 일은 여러 번 해도 결과가 같고, 이미 채운 날은 건드리지 않는다.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== "Bearer " + secret) {
    res.status(401).json({ error: "권한이 없습니다" }); return;
  }
  try {
    const want = backDays(DAYS_BACK);
    const classes = await listDocs("classes");
    const todo = classes.filter((c) => c.playlist && !(c.endDate && c.endDate < kstToday()));
    const log = [];

    for (const c of todo) {
      let pl;
      try { pl = await readPlaylist(c.playlist); }
      catch (e) { log.push({ 반: c.name, 오류: e.message }); continue; }
      if (!pl.ok) { log.push({ 반: c.name, 오류: pl.error }); continue; }

      const by = {};
      pl.items.forEach((x) => { if (x.date) (by[x.date] = by[x.date] || []).push(x); });

      let wrote = 0, kept = 0;
      for (const d of want) {
        const items = by[d];
        if (!items || !items.length) continue;
        const line = lineOf(items);
        if (!line) continue;
        const cur = await getDoc("classes/" + c.id + "/days/" + d).catch(() => null);
        const old = cur && cur.lesson;
        // 사람이 손댔거나 자막으로 올린 것은 덮지 않는다
        if (old && old.source && old.source !== "title") { kept++; continue; }
        if (old && old.line === line) { kept++; continue; }
        await patchDoc("classes/" + c.id + "/days/" + d, {
          lesson: { line, n: items.length, source: "title",
                    ids: items.map((x) => x.id), updated: Date.now() },
          updated: Date.now(),
        });
        wrote++;
      }
      log.push({ 반: c.name, 채움: wrote, 그대로: kept, 영상: pl.items.length });
    }
    res.status(200).json({ ok: true, 오늘: kstToday(), 훑은날: want.length,
                           재생목록있는반: todo.length, 결과: log });
  } catch (e) {
    console.error("[cron/lessons]", e);
    res.status(500).json({ error: "서버 오류: " + e.message });
  }
}
