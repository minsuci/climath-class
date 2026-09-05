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
import { verifyIdToken } from "./_google.js";

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

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST만 받습니다" }); return; }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const claims = await verifyIdToken(body.idToken);
    if (!claims || (claims.role !== "teacher" && claims.role !== "owner")) {
      res.status(403).json({ error: "권한이 없습니다" }); return;
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
