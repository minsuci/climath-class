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
const BUDGET = KEY ? 6 : 46;      // 한 번 부를 때 쓸 수 있는 나이스 요청 수

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
                  official: hit.SCHUL_NM, officeName: hit.ATPT_OFCDC_SC_NM };
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
      await sleep(70);
      continue;
    }
    rows.forEach((r) => {
      const k = r.AA_YMD + "|" + r.EVENT_NM;
      if (!seen[k]) { seen[k] = 1; out.push(r); }
    });
    await sleep(70);
  }
  return { rows: out, truncated };
}

// "2학기 중간고사"는 잡고 "성적확인 및 이의신청"은 안 잡는다
function isExam(nm, kind) {
  const s = String(nm || "");
  if (!/(중간|기말|지필)/.test(s)) return false;
  if (/(성적|이의|발표|정정|준비|대비|안내|미실시|없음)/.test(s)) return false;
  if (kind && s.indexOf(kind) < 0) return false;
  return true;
}
const GRADE_FIELD = { "고1": "ONE_GRADE_EVENT_YN", "고2": "TW_GRADE_EVENT_YN", "고3": "THREE_GRADE_EVENT_YN" };

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
    res.status(200).json({ school, official: s.official, officeName: s.officeName,
                           byGrade, found: exams.length,
                           // 나이스에 일정이 아예 없는 학교와, 일정은 있는데 시험만 안 올린 학교는 다르다
                           hasAny: rows.length > 0,
                           truncated, hasKey: !!KEY });
  } catch (e) {
    console.error("[schedule]", e);
    res.status(500).json({ error: "서버 오류: " + e.message });
  }
}
