// 나이스(NEIS) 교육정보 개방 포털에서 학교 학사일정을 읽어온다.
//
// 왜 서버에서 하나:
//   (1) 브라우저에서 부르면 CORS에 막힌다.
//   (2) 학교 코드를 한 번 찾아두면 다시 안 찾도록 Firestore에 적어둔다.
//   (3) 키를 쓰게 되면 그 키가 클라이언트로 나가면 안 된다.
//
// ⚠ 키가 없으면 **한 번에 5건**만 오고, 그때는 pIndex(페이지 넘기기)가 **먹지 않는다**
//    — 2페이지를 불러도 1페이지와 같은 5건이 온다. 그래서 키가 없을 때는
//    날짜 창을 반씩 잘라 "5건 이하"가 될 때까지 좁혀가며 받는다. 요청 수가 늘어나므로
//    한 번에 **학교 하나씩만** 처리한다.
//    Vercel 환경변수 NEIS_API_KEY 를 넣으면 한 번에 1000건까지 와서 요청 한 번으로 끝난다.
//    (무료. open.neis.go.kr 에서 발급)
//
// 못 하는 것: **수학 시험 날짜**. 학사일정에는 "2학기 중간고사"까지만 있고
// 과목별 시간표는 안 들어간다. 그건 계속 손으로 넣거나 학생이 내야 한다.

import { verifyIdToken, getDoc, patchDoc } from "./_google.js";

const NEIS = "https://open.neis.go.kr/hub";
const KEY = process.env.NEIS_API_KEY || "";
const PAGE = KEY ? 1000 : 5;
// 창을 쪼개 받다 보면 요청이 꽤 든다. 일정이 촘촘한 학교(단대부고는 두 달에 99건)는
// 예산이 모자라 잘리고, 잘린 조각에 시험이 안 들어 있으면 "시험 없음"으로 잘못 보였다.
const BUDGET = KEY ? 6 : 90;      // 한 번 부를 때 쓸 수 있는 나이스 요청 수

// 짧은 이름 → 정식 이름으로 규칙만으로는 못 펴는 것들
const ALIAS = {
  "건대부고": "건국대학교사범대학부속고등학교",
  "한대부고": "한양대학교사범대학부속고등학교",
  "중대부고": "중앙대학교사범대학부속고등학교",
  "단대부고": "단국대학교사범대학부속고등학교",
};
// 숙명여고 → 숙명여자고등학교 / 경기고 → 경기고등학교
function officialName(n) {
  if (ALIAS[n]) return ALIAS[n];
  if (/여고$/.test(n)) return n.replace(/여고$/, "여자고등학교");
  if (/고$/.test(n)) return n.replace(/고$/, "고등학교");
  return n;
}
// 나이스 이름 검색은 앞부분 일치라 "숙명여고"로는 안 걸리고 "숙명"으로 걸린다
function searchStem(n) {
  if (ALIAS[n]) return ALIAS[n];
  return n.replace(/여고$/, "").replace(/고$/, "");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callNeis(path, params) {
  const p = new URLSearchParams({ Type: "json", pIndex: "1", pSize: String(PAGE), ...params });
  if (KEY) p.set("KEY", KEY);
  const r = await fetch(NEIS + "/" + path + "?" + p.toString());
  if (!r.ok) return { rows: [], total: 0 };
  const j = await r.json().catch(() => null);
  const box = j && j[path];
  if (!box) return { rows: [], total: 0 };   // RESULT 만 오면 자료 없음
  const head = (box[0] && box[0].head) || [];
  return { rows: (box[1] && box[1].row) || [], total: (head[0] && head[0].list_total_count) || 0 };
}

// ---- 학교 코드 찾기 (한 번 찾으면 appConfig/neisCodes 에 적어둔다) ----
let memo = null;
async function loadCodes() {
  if (memo) return memo;
  const d = await getDoc("appConfig/neisCodes").catch(() => null);
  memo = (d && d.map) || {};
  return memo;
}
async function resolveSchool(short, budget) {
  const codes = await loadCodes();
  if (codes[short] && codes[short].code) return codes[short];

  const want = officialName(short);
  const pick = (rows) => rows.find((r) => r.SCHUL_NM === want) || (rows.length === 1 ? rows[0] : null);

  budget.n--;
  let { rows } = await callNeis("schoolInfo",
    { ATPT_OFCDC_SC_CODE: "B10", SCHUL_KND_SC_NM: "고등학교", SCHUL_NM: searchStem(short) });
  let hit = pick(rows);
  if (!hit) {                       // 서울에 없으면 전국에서 정식 이름으로
    await sleep(80);
    budget.n--;
    ({ rows } = await callNeis("schoolInfo", { SCHUL_KND_SC_NM: "고등학교", SCHUL_NM: want }));
    hit = pick(rows);
  }
  if (!hit) return null;
  const found = { code: hit.SD_SCHUL_CODE, office: hit.ATPT_OFCDC_SC_CODE,
                  official: hit.SCHUL_NM, officeName: hit.ATPT_OFCDC_SC_NM,
                  hmpg: hit.HMPG_ADRES || "" };
  memo = { ...(memo || {}), [short]: found };
  await patchDoc("appConfig/neisCodes", { map: memo }).catch(() => {});
  return found;
}

// ---- 날짜 ----
const ymd = (s) => String(s || "").replace(/-/g, "");
const dash = (s) => String(s).slice(0, 4) + "-" + String(s).slice(4, 6) + "-" + String(s).slice(6, 8);
const toDate = (s) => new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
const fmt = (d) => d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
const shiftDay = (s, n) => { const d = toDate(s); d.setDate(d.getDate() + n); return fmt(d); };
const midDay = (a, b) => fmt(new Date((toDate(a).getTime() + toDate(b).getTime()) / 2));

// 창을 반씩 잘라가며 전부 받는다. 키가 있으면 첫 요청에 다 온다.
async function scheduleRows(office, code, from, to, budget) {
  const seen = {};
  const out = [];
  const stack = [[from, to]];
  let truncated = false;
  while (stack.length) {
    if (budget.n <= 0) { truncated = true; break; }
    const [a, b] = stack.pop();
    budget.n--;
    const { rows, total } = await callNeis("SchoolSchedule",
      { ATPT_OFCDC_SC_CODE: office, SD_SCHUL_CODE: code, AA_FROM_YMD: a, AA_TO_YMD: b });
    if (total > rows.length && a < b) {      // 다 못 받았으면 창을 반으로
      const m = midDay(a, b);
      stack.push([a, m], [shiftDay(m, 1), b]);
      await sleep(40);
      continue;
    }
    rows.forEach((r) => {
      const k = r.AA_YMD + "|" + r.EVENT_NM;
      if (!seen[k]) { seen[k] = 1; out.push(r); }
    });
    await sleep(40);
  }
  return { rows: out, truncated };
}

// "2학기 중간고사"는 잡고 "성적확인 및 이의신청"은 안 잡는다.
//
// 학교마다 부르는 이름이 다르다. 경기도 쪽은 "1차 지필평가 / 2차 지필평가"라고 쓴다 —
// kind를 글자 그대로 맞추면(indexOf("중간")) 그런 학교가 통째로 빠진다.
const KIND_RE = {
  "중간": /(중간|1\s*차\s*지필|지필\s*평가\s*1|1\s*회\s*고사)/,
  "기말": /(기말|2\s*차\s*지필|지필\s*평가\s*2|2\s*회\s*고사)/,
};
function isExam(nm, kind) {
  const s = String(nm || "");
  if (!/(중간|기말|지필|고사)/.test(s)) return false;
  // 모의고사·학력평가는 내신이 아니다
  if (/(모의|학력평가|수능|모평)/.test(s)) return false;
  if (/(성적|이의|발표|정정|준비|대비|안내|미실시|없음|출제|보안|연수)/.test(s)) return false;
  if (kind) { const re = KIND_RE[kind]; if (re && !re.test(s)) return false; }
  return true;
}
const GRADE_FIELD = { "고1": "ONE_GRADE_EVENT_YN", "고2": "TW_GRADE_EVENT_YN", "고3": "THREE_GRADE_EVENT_YN" };

// ---- 학교 홈페이지에서 긁기 (나이스에 시험이 안 올라온 학교) ----
//
// 서울 교육청 웹호스팅을 쓰는 학교는 생김새가 같다. 메뉴 어딘가에 "월간일정 / 학사일정 /
// 학교일정"이 있고, 그 페이지에 viewType=list 로 POST 하면 표가 그대로 온다:
//     2026-10-01(목) 00시 | 2026-10-02(금) 23시 | 중간고사
// 달력형은 눈으로 보라고 만든 것이라 목록형을 쓴다.
//
// 게시판에 PDF·한글파일·이미지로 올리는 학교(경기고·언남고·휘문고 같은)는 여기서 못 잡는다.
// 그건 형식이 학교마다 달라서 일반화가 안 된다 — 그런 학교는 손으로 넣어야 한다.
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36" };

function monthsBetween(from, to) {
  const out = [];
  let y = Number(from.slice(0, 4)), m = Number(from.slice(4, 6));
  const ey = Number(to.slice(0, 4)), em = Number(to.slice(4, 6));
  while (y < ey || (y === ey && m <= em)) {
    out.push([String(y), String(m).padStart(2, "0")]);
    m++; if (m > 12) { m = 1; y++; }
    if (out.length > 6) break;
  }
  return out;
}
const toText = (h) => h.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "")
  .replace(/<[^>]+>/g, "|").replace(/&nbsp;/g, " ").replace(/[ \t\r\n]+/g, " ").replace(/\|+/g, "|");

async function findScheduleMenus(base) {
  const r = await fetch(base, { headers: UA, redirect: "follow" });
  if (!r.ok) return [];
  const html = await r.text();
  const re = /href="([^"]*\/\d+\/subMenu\.do[^"]*)"[^>]*>([\s\S]{0,120}?)<\/a>/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const t = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, "");
    if (!/일정|학사|캘린더/.test(t)) continue;
    if (/급식/.test(t)) continue;                       // 급식일정은 아니다
    const href = m[1].startsWith("http") ? m[1] : new URL(m[1], base).toString();
    if (out.indexOf(href) < 0) out.push(href);
    if (out.length >= 3) break;
  }
  return out;
}

async function homepageExams(hmpg, from, to, kind, budget) {
  if (!hmpg) return null;
  const base = hmpg.replace(/^http:/, "https:").replace(/\/+$/, "") + "/";
  let menus;
  budget.n--;
  try { menus = await findScheduleMenus(base); } catch (e) { return null; }
  if (!menus.length) return null;

  const rows = [];
  for (const url of menus) {
    for (const [y, mm] of monthsBetween(from, to)) {
      if (budget.n <= 0) break;
      budget.n--;
      let t = "";
      try {
        const body = new URLSearchParams({ viewType: "list", srhSchdulYear: y, srhSchdulMonth: mm });
        const r = await fetch(url, { method: "POST", body,
          headers: { ...UA, "Content-Type": "application/x-www-form-urlencoded" } });
        t = toText(await r.text());
      } catch (e) { continue; }
      // 칸 사이가 "| |" 처럼 여러 개로 나오므로 구분자를 넉넉히 잡는다
      const re = /(\d{4}-\d{2}-\d{2})\([월화수목금토일]\)[^|]*[|\s]+(\d{4}-\d{2}-\d{2})\([월화수목금토일]\)[^|]*[|\s]+([^|]{1,40})/g;
      let m;
      while ((m = re.exec(t))) rows.push({ s: m[1], e: m[2], nm: m[3].trim() });
      await sleep(40);
    }
    if (rows.length) break;      // 쓸 만한 메뉴를 찾았으면 더 안 본다
  }
  if (!rows.length) return null;
  const exams = rows.filter((r) => isExam(r.nm, kind));
  if (!exams.length) return { hasAny: true, byGrade: {} };

  // "중간고사(1,2)" 처럼 학년이 붙어 있으면 그 학년만. 없으면 전 학년.
  const byGrade = {};
  ["고1", "고2", "고3"].forEach((g) => {
    const n = g.slice(1);
    const mine = exams.filter((r) => {
      const t = r.nm.match(/\(([\d,\s]+)\)/);
      return t ? t[1].split(",").map((x) => x.trim()).indexOf(n) >= 0 : true;
    });
    if (!mine.length) return;
    const ds = [];
    mine.forEach((r) => { ds.push(r.s.replace(/-/g, ""), r.e.replace(/-/g, "")); });
    ds.sort();
    byGrade[g] = { start: dash(ds[0]), end: dash(ds[ds.length - 1]), days: mine.length, name: mine[0].nm };
  });
  return { hasAny: true, byGrade, viaHomepage: true };
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST만 받습니다" }); return; }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const claims = await verifyIdToken(body.idToken);
    if (!claims || (claims.role !== "teacher" && claims.role !== "owner")) {
      res.status(403).json({ error: "권한이 없습니다" }); return;
    }
    const school = String(body.school || "").trim();
    const from = ymd(body.from), to = ymd(body.to);
    if (!school) { res.status(400).json({ error: "학교를 넘겨주세요" }); return; }
    if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to) || from > to) {
      res.status(400).json({ error: "기간을 올바르게 넘겨주세요" }); return;
    }
    const kind = body.kind || "";
    const budget = { n: BUDGET };

    const s = await resolveSchool(school, budget);
    if (!s) { res.status(200).json({ school, error: "나이스에서 학교를 못 찾았어요", hasKey: !!KEY }); return; }

    const { rows, truncated } = await scheduleRows(s.office, s.code, from, to, budget);
    const exams = rows.filter((r) => isExam(r.EVENT_NM, kind));
    const byGrade = {};
    Object.keys(GRADE_FIELD).forEach((g) => {
      const f = GRADE_FIELD[g];
      // 학년 표시를 안 하는 학교도 있다. 그때는 전 학년 공통으로 본다.
      const mine = exams.filter((r) => r[f] === "Y");
      const use = mine.length ? mine : exams.filter((r) => !r[f]);
      if (!use.length) return;
      const ds = Array.from(new Set(use.map((r) => r.AA_YMD))).sort();
      byGrade[g] = { start: dash(ds[0]), end: dash(ds[ds.length - 1]),
                     days: ds.length, name: use[0].EVENT_NM };
    });
    // 나이스에 시험이 없으면 학교 홈페이지를 본다
    let viaHomepage = false, hasAny = rows.length > 0;
    if (!Object.keys(byGrade).length) {
      const hp = await homepageExams(s.hmpg, from, to, kind, budget);
      if (hp && Object.keys(hp.byGrade || {}).length) {
        Object.assign(byGrade, hp.byGrade);
        viaHomepage = true; hasAny = true;
      } else if (hp) hasAny = true;
    }
    res.status(200).json({ school, official: s.official, officeName: s.officeName,
                           byGrade, found: exams.length,
                           // 나이스에 일정이 아예 없는 학교와, 일정은 있는데 시험만 안 올린 학교는 다르다
                           hasAny, viaHomepage, homepage: s.hmpg || "",
                           truncated, hasKey: !!KEY });
  } catch (e) {
    console.error("[schedule]", e);
    res.status(500).json({ error: "서버 오류: " + e.message });
  }
}
