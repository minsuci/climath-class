// 그날 수업에서 무엇을 했는지 — 유튜브 재생목록의 **제목**에서 읽는다.
//
// 왜 제목인가:
//   제목이 「8/31(월) 수평교 95-116(2)」 처럼 날짜·교재·범위를 이미 담고 있다.
//   선생님이 손으로 쓴 것이라 **지어낼 여지가 없다.**
//
// 왜 자막이 아닌가:
//   ① yt-dlp 는 윈도우 실행파일이라 여기서 못 돈다
//   ② 자막 요청은 유튜브가 막는다 (실측 429). 데이터센터 IP는 더 심하다
//   ③ 자막은 숫자를 조용히 바꾼다 — 「y²곱」 「12미만」 처럼.
//      개념은 읽히지만 값·문항번호는 못 믿는다
//   개념까지 넣고 싶으면 PC 에서 뽑아 올리는 편이 낫다.
import { verifyIdToken, getDoc, patchDoc, listDocs } from "./_google.js";

const UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
  "Accept-Language": "ko-KR,ko;q=0.9",
};

export const listId = (s) => {
  const m = String(s || "").match(/[?&]list=([\w-]+)/) || String(s || "").match(/^([\w-]{10,})$/);
  return m ? m[1] : "";
};

// 재생목록 한 판을 읽어 [{ id, title, date }] 로 만든다.
//
// ⚠ 유튜브가 담는 모양이 자주 바뀐다. 지금은 제목이
//   "title":{"content":"…"} 로, 영상 id 는 그 앞쪽 "videoId":"…" 로 있다.
//   제목 위치를 기준으로 **가장 가까운 앞쪽 videoId** 를 짝지운다.
export async function readPlaylist(url) {
  const id = listId(url);
  if (!id) return { ok: false, error: "재생목록 주소가 아니에요" };
  const r = await fetch("https://www.youtube.com/playlist?list=" + id, { headers: UA, redirect: "follow" });
  if (!r.ok) return { ok: false, error: "유튜브가 " + r.status + " 로 답했어요" };
  const h = await r.text();

  const titles = [];
  const tre = /"title":\{"content":"((?:[^"\\]|\\.){3,120})"\}/g;
  let m;
  while ((m = tre.exec(h))) titles.push([m.index, m[1]]);
  const vids = [];
  const vre = /"videoId":"([\w-]{11})"/g;
  while ((m = vre.exec(h))) vids.push([m.index, m[1]]);
  if (!titles.length || !vids.length) {
    return { ok: false, error: "재생목록을 읽지 못했어요 (유튜브 화면 구조가 바뀌었거나 막혔어요)",
             hint: { 크기: h.length, 제목: titles.length, 영상: vids.length } };
  }

  const seen = {}, out = [];
  for (const [pos, raw] of titles) {
    let v = "";
    for (const [p, id2] of vids) { if (p < pos) v = id2; else break; }
    if (!v || seen[v]) continue;
    seen[v] = 1;
    const title = raw.replace(/\\u([\dA-Fa-f]{4})/g, (_, c) => String.fromCharCode(parseInt(c, 16)))
                     .replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim();
    out.push({ id: v, title, date: dateOf(title) });
  }
  return { ok: true, items: out };
}

// 「8/31(월) …」 → 2026-08-31. 해는 안 적혀 있으므로 **오늘을 기준으로 가까운 해**를 고른다
// (1월에 12월 영상을 보면 작년이다).
export function dateOf(title, today) {
  const m = String(title || "").match(/^\s*(\d{1,2})\s*[\/.]\s*(\d{1,2})/);
  if (!m) return "";
  const t = today ? new Date(today + "T00:00:00") : new Date();
  const mm = Number(m[1]), dd = Number(m[2]);
  if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return "";
  let y = t.getFullYear();
  const p = (yy) => yy + "-" + String(mm).padStart(2, "0") + "-" + String(dd).padStart(2, "0");
  const diff = (yy) => Math.abs(new Date(p(yy) + "T00:00:00") - t);
  if (diff(y - 1) < diff(y)) y = y - 1;
  else if (diff(y + 1) < diff(y)) y = y + 1;
  return p(y);
}

// 그날 영상 제목들 → 한 줄. 제목에서 날짜를 떼고 「(1)」 같은 회차 표시를 지운 뒤
// 같은 것을 묶는다. 「수평교 풀이(1)」 「수평교 풀이(2)」 는 한 번만 적는다.
export function lineOf(items) {
  const parts = [];
  for (const it of items) {
    let t = String(it.title || "")
      .replace(/^\s*\d{1,2}\s*[\/.]\s*\d{1,2}\s*(\([월화수목금토일]\))?\s*/, "")
      .replace(/\s*\(\d+\)\s*$/, "")
      .trim();
    if (t && parts.indexOf(t) < 0) parts.push(t);
  }
  return parts.join(" · ");
}


// ---- 자막으로 개념까지 (PC 도구가 부른다) ----
//
// 나눠 맡는 이유: yt-dlp 는 윈도우 실행파일이라 여기서 못 돌고, Gemini 키는 여기 있다.
// **PC 는 유튜브에서만 되는 일(자막 받기)만 하고, 요약·저장은 서버가 한다.**
// 그래야 PC 에 AI 키도, 파이어베이스 열쇠도 두지 않는다.
//
// 도구 열쇠는 team/tools 에 둔다 — 규칙상 어떤 클라이언트도 못 읽는 자리다.
const TOOLKEY_PATH = "team/tools";

async function toolOk(k) {
  if (!k) return false;
  const d = await getDoc(TOOLKEY_PATH).catch(() => null);
  return !!(d && d.lessonKey && d.lessonKey === k);
}

// ⚠ 자막은 숫자를 조용히 바꾼다 — 「y²곱」 「12미만」 「19번(실제 9번)」.
//    그래서 **값·문항번호는 쓰지 말라**고 못박는다. 개념만 남긴다.
const CAP_PROMPT = `너는 대치동 수학학원 선생님의 조교다.
수업 녹화의 **자동 자막**을 받아서, 학부모가 읽을 «그날 다룬 내용» 한 줄을 만든다.

규칙:
- **한 문장. 40자 안팎.** 길면 안 된다.
- 다룬 **개념·단원**만 적는다. ("이차함수의 최대·최소와 판별식을 다뤘습니다")
- **숫자를 쓰지 마라.** 자동 자막은 분수·문항번호를 틀리게 옮긴다
  (「23/4」가 「2 23」로, 「9번」이 「19번」으로 나온다). 값·번호·쪽수는 절대 적지 마라.
- 원문에 없는 내용을 지어내지 마라.
- 인사말·잡담·"오늘은 여기까지" 같은 것은 빼라.
- 개념이 안 보이면 지어내지 말고 "수업 내용이 확인되지 않습니다." 라고만 답하라.

말투: '~를 다뤘습니다' 체. 담백하게. 수식 기호나 LaTeX 는 쓰지 마라.`;

// 아직 개념이 안 들어간 날 목록. PC 도구가 «무엇을 받아야 하나» 를 여기서 얻는다.
async function capTodo(res, days) {
  const n = Math.min(400, Math.max(1, Number(days) || 30));
  const t = Date.now() + 9 * 3600 * 1000;
  const want = {};
  for (let i = 0; i < n; i++) want[new Date(t - i * 86400000).toISOString().slice(0, 10)] = 1;

  const classes = await listDocs("classes");
  const out = [];
  for (const c of classes) {
    if (!c.playlist) continue;
    if (c.endDate && c.endDate < new Date(t).toISOString().slice(0, 10)) continue;
    const ds = await listDocs("classes/" + c.id + "/days").catch(() => []);
    for (const d of ds) {
      if (!want[d.id]) continue;
      const L = d.lesson;
      // 제목으로만 채워진 날이 대상이다. 자막으로 이미 했거나 사람이 고친 것은 건드리지 않는다.
      if (!L || !L.line || L.source !== "title") continue;
      if (!(L.ids || []).length) continue;
      out.push({ cid: c.id, cname: c.name, date: d.id, ids: L.ids, title: L.line });
    }
  }
  out.sort((a, b) => (a.date < b.date ? 1 : -1));
  res.status(200).json({ ok: true, todo: out });
}

// 자막 원문 → 한 줄 → days/{날짜}.lesson 에 저장
async function capPut(res, { cid, date, text, keepTitle }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) { res.status(500).json({ error: "서버에 GEMINI_API_KEY 가 없어요" }); return; }
  const src = String(text || "").trim();
  if (src.length < 200) { res.status(400).json({ error: "자막이 너무 짧아요" }); return; }

  // 길면 앞뒤를 살리고 가운데를 줄인다 (비용·속도)
  const MAX = 24000;
  const body = src.length <= MAX ? src
    : src.slice(0, MAX * 0.6) + "\n…(중략)…\n" + src.slice(-MAX * 0.4);

  const r = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=" + key,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: CAP_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: "--- 자막 ---\n" + body + "\n--- 끝 ---\n\n한 줄로 써라." }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 200 },
      }) });
  if (!r.ok) { res.status(502).json({ error: "AI 호출 실패: " + (await r.text()).slice(0, 200) }); return; }
  const data = await r.json();
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  const line = parts.map((p) => p.text || "").join("").trim().replace(/\s+/g, " ");
  if (!line || /확인되지 않습니다/.test(line)) {
    res.status(200).json({ ok: true, skipped: true, why: "개념이 안 보였어요" }); return;
  }
  // 교재·범위(제목)도 같이 남긴다 — 개념만 있으면 «무슨 교재였나» 를 잃는다
  const full = keepTitle ? line + " (" + keepTitle + ")" : line;
  await patchDoc("classes/" + cid + "/days/" + date, {
    lesson: { line: full, source: "caption", concept: line, title: keepTitle || "", updated: Date.now() },
    updated: Date.now(),
  });
  res.status(200).json({ ok: true, line: full });
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST만 받습니다" }); return; }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    // PC 도구는 파이어베이스 로그인을 못 한다. 좁은 열쇠 하나로만 연다.
    if (body.toolKey) {
      if (!(await toolOk(body.toolKey))) { res.status(403).json({ error: "도구 열쇠가 맞지 않아요" }); return; }
      if (body.action === "todo") return await capTodo(res, body.days);
      if (body.action === "put") return await capPut(res, body);
      res.status(400).json({ error: "그런 동작이 없어요" }); return;
    }

    const claims = await verifyIdToken(body.idToken);
    if (!claims || (claims.role !== "teacher" && claims.role !== "owner")) {
      res.status(403).json({ error: "권한이 없습니다" }); return;
    }
    // 도구 열쇠 만들기 — 관리자만. 만든 값은 한 번만 보여준다.
    if (body.action === "makeToolKey") {
      if (claims.role !== "owner") { res.status(403).json({ error: "관리자만 만들 수 있어요" }); return; }
      const k = "lk_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      await patchDoc(TOOLKEY_PATH, { lessonKey: k, updated: Date.now() });
      res.status(200).json({ ok: true, key: k }); return;
    }
    const pl = await readPlaylist(body.playlist);
    if (!pl.ok) { res.status(502).json(pl); return; }

    // 날짜를 주면 그날 것만, 안 주면 날짜별로 묶어서 준다
    if (body.date) {
      const items = pl.items.filter((x) => x.date === body.date);
      res.status(200).json({ ok: true, date: body.date, items, line: lineOf(items) });
      return;
    }
    const by = {};
    pl.items.forEach((x) => { if (x.date) (by[x.date] = by[x.date] || []).push(x); });
    const days = Object.keys(by).sort().reverse()
      .map((d) => ({ date: d, n: by[d].length, line: lineOf(by[d]) }));
    res.status(200).json({ ok: true, total: pl.items.length, days });
  } catch (e) {
    console.error("[lesson]", e);
    res.status(500).json({ error: "서버 오류: " + e.message });
  }
}
