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
  "중간": /(중간|1\s*차\s*(지필|정기)|지필\s*평가\s*1|1\s*[회차]\s*(고사|시험))/,
  "기말": /(기말|2\s*차\s*(지필|정기)|지필\s*평가\s*2|2\s*[회차]\s*(고사|시험))/,
};
// 학교마다 부르는 말이 다르다. 중흥고는 2025년엔 "지필평가"라고 쓰다가 2026년에
// "정기시험"으로 바꿨다 — 낱말을 좁게 잡으면 그런 학교가 통째로 사라진다.
const EXAM_WORD = /(중간|기말|지필|고사|정기\s*시험|정기\s*평가)/;
// ⚠ "시험"까지 넓히면 대학수학능력시험이 딸려 온다. 반드시 먼저 걸러낸다.
const NOT_EXAM = /(모의|학력평가|수능|모평|대학수학능력|학업성취도|검정|자격)/;
function isExam(nm, kind) {
  const s = String(nm || "");
  if (!EXAM_WORD.test(s)) return false;
  // 모의고사·학력평가·수능은 내신이 아니다
  if (NOT_EXAM.test(s)) return false;
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

let lastMenus = [];
async function homepageExams(hmpg, from, to, kind, budget) {
  if (!hmpg) return null;
  const base = hmpg.replace(/^http:/, "https:").replace(/\/+$/, "") + "/";
  let menus;
  budget.n--;
  try { menus = await findScheduleMenus(base); } catch (e) { return null; }
  if (!menus.length) return null;

  lastMenus = menus;
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

// ---- 3단계: 게시판에 붙은 문서에서 읽기 ----
//
// 달력 페이지가 아니라 게시판에 PDF·한글파일로만 올리는 학교가 있다(경기고·언남고).
// 서울 교육청 CMS는 게시판도 생김새가 같아서 여기까지는 규칙으로 간다:
//   메뉴 페이지에서 bbsId → selectBoardListAjax.do 로 글 목록 → "학사일정" 글 고르기
//   → selectBoardDetailAjax.do 로 첨부 atchFileId → 문서뷰어(Synap)
// 뷰어는 변환된 글자층을 thumbnailxml 로 준다. PDF를 직접 뜯지 않아도 글자가 나온다.
//   ⚠ 목록/상세 AJAX는 **세션 쿠키가 있어야** 내용을 준다. 없으면 빈 껍데기가 온다.
//
// 마지막으로 그 글자에서 날짜를 뽑는 일만 남는데, 학사력은 학교마다 표 모양이 완전히
// 달라서(월별 세로표, 일자 가로표…) 규칙으로 짜면 학교마다 깨진다. 그건 AI에게 맡기되,
// **지어낼 수 없게 검증한다** — 답으로 준 날짜의 숫자가 원문에서 실제로 시험 낱말 바로
// 앞에 붙어 있어야만 받아들인다.
const SYNAP = "http://viewhosting.ssem.or.kr:8080/SynapDocViewServer";

async function boardDocText(menuUrl, budget) {
  const origin = new URL(menuUrl).origin;
  budget.n--;
  const first = await fetch(menuUrl, { headers: UA });
  const cookie = (first.headers.getSetCookie ? first.headers.getSetCookie() : [])
    .map((c) => c.split(";")[0]).join("; ");
  const page = await first.text();
  const bbsId = (page.match(/name="bbsId"[^>]*value="([^"]+)"/) || [])[1];
  if (!bbsId) return null;                       // 게시판이 아니다
  const H = { ...UA, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
              "X-Requested-With": "XMLHttpRequest", Referer: menuUrl, Cookie: cookie };

  budget.n--;
  const list = await (await fetch(origin + "/dggb/module/board/selectBoardListAjax.do", {
    method: "POST", headers: H,
    body: new URLSearchParams({ bbsId, bbsTyCode: "base", pageIndex: "1",
      customRecordCountPerPage: "30", searchCondition: "", searchKeyword: "", cmntSe: "N" }),
  })).text();
  const re = /fnView\('([^']+)',\s*'([^']+)'\)[^>]*>([\s\S]{0,140}?)<\/a>/g;
  const posts = [];
  let m;
  while ((m = re.exec(list))) posts.push({ bbsId: m[1], nttId: m[2],
    title: m[3].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() });
  const want = /학사\s*일정|학사\s*력|학사력|연간\s*일정/;
  const yr = new Date().getFullYear();
  const hit = posts.find((x) => want.test(x.title) && x.title.indexOf(String(yr)) >= 0)
           || posts.find((x) => want.test(x.title));
  if (!hit) return null;

  budget.n--;
  const html = await (await fetch(origin + "/dggb/module/board/selectBoardDetailAjax.do", {
    method: "POST", headers: H,
    body: new URLSearchParams({ bbsId: hit.bbsId, nttId: hit.nttId, bbsTyCode: "base",
      pageIndex: "1", cmntSe: "N", customRecordCountPerPage: "30" }),
  })).text();
  const fid = (html.match(/name="atchFileId"[^>]*value="([^"]+)"/) || [])[1];
  if (!fid) return null;

  // ⚠ fileSn 은 **1부터** 시작한다. 0으로 부르면 빈 HTML 이 200 으로 와서
  //    "첨부가 없다"로 잘못 읽힌다. 경기고 학사일정 PDF 가 여기서 안 잡혔다.
  //    (실제 다운로드 경로는 /dggb/board/boardFile/downFile.do?atchFileId=…&fileSn=1)
  for (const sn of ["1", "2", "3"]) {
    if (budget.n <= 0) break;
    budget.n--;
    try {
      // ⚠ filePath 는 URL 인코딩해서 넘긴다. 안 하면 주소 안의 & 에서 잘려 엉뚱한 것을
      //    변환한다 — status 의 format 이 PDF 가 아니라 TXT 로 오고 글자가 스물몇 자만 온다.
      //    지금 서울 CMS 주소에는 & 가 없어서 우연히 되고 있을 뿐이다.
      const inner = origin + ":443/dggb/cnvrFileDown.do?atchFileId=" + fid + ":" + sn;
      const job = SYNAP + "/job?fid=" + fid + "_" + sn +
        "&filePath=" + encodeURIComponent(inner) +
        "&convertType=1&fileType=URL&sync=true";
      const r = await fetch(job, { headers: UA, redirect: "follow" });
      const key = (r.url.match(/key=([0-9a-f]+)/) || [])[1];
      if (!key) continue;
      const st = await (await fetch(SYNAP + "/status/" + key, { headers: UA })).json().catch(() => null);
      const pages = Math.min((st && st.pageNum) || 1, 14);
      let text = "";
      for (let pg = 0; pg < pages; pg++) {
        if (budget.n <= 0) break;
        budget.n--;
        const x = await (await fetch(SYNAP + "/thumbnailxml/" + key + "/" + pg + "?dpi=96", { headers: UA })).text();
        text += x.replace(/<[^>]+>/g, " ")
                 .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
                 .replace(/\s+/g, "");
      }
      if (text.length > 400 && /(고사|평가)/.test(text)) return { text, title: hit.title };
    } catch (e) { /* 다음 첨부 */ }
  }
  return null;
}

// 그 날 숫자가 원문에서 정말 시험 낱말 바로 앞에 붙어 있나.
// 앞에 다른 숫자가 없어야 한다는 조건은 못 건다 — 표에서는 날짜가 "…10 12중간고사…"
// 처럼 줄줄이 붙어 나와서 앞 글자가 숫자인 게 정상이다.
// **고른 시험 종류만** 본다. 아무 시험 낱말이나 받아주면, 2학기 구간의
// "27기말고사"에 붙은 "7기말" 때문에 10월 7일이 중간고사로 통과해 버린다.
const DAY_WORD = {
  "중간": "(?:중간|1\\s*차\\s*(?:지필|정기))",
  "기말": "(?:기말|2\\s*차\\s*(?:지필|정기))",
};
function dayHasExam(text, ymdStr, kind) {
  const d = Number(ymdStr.slice(8, 10));
  const w = DAY_WORD[kind] || "(?:중간|기말|지필|정기)";
  return new RegExp("" + d + "\\s*(?:2?학기)?\\s*" + w).test(text);
}
// 검증에 쓸 구간을 학기로 좁힌다. 한 문서에 1학기·2학기가 다 들어 있어서,
// 전체를 훑으면 1학기의 "27중간고사"가 2학기 10월 7일을 통과시켜 버린다.
function semesterSlice(text, from) {
  const mm = Number(from.slice(4, 6));
  const second = mm >= 8 || mm <= 2;          // 8월~2월이면 2학기
  const mark = text.indexOf(second ? "2학기" : "1학기");
  if (mark < 0) return text;
  if (!second) {
    const nxt = text.indexOf("2학기", mark);
    return nxt > mark ? text.slice(mark, nxt) : text.slice(mark);
  }
  return text.slice(mark);
}

// 왜 못 읽었는지 화면에 보여주려고 남긴다. 조용히 null 만 돌려주면 어디서 막혔는지 알 수 없다.
let lastDocReason = "";
async function examFromDoc(text, school, from, to, kind) {
  lastDocReason = "";
  const key = process.env.GEMINI_API_KEY;
  if (!key) { lastDocReason = "AI 키 없음"; return null; }
  const body = {
    system_instruction: { parts: [{ text:
      "너는 한국 고등학교 학사일정 표에서 시험 기간만 뽑아내는 도구다. " +
      "JSON 하나만 출력한다. 설명·코드블록·군더더기 금지. " +
      "원문에 없는 날짜는 절대 만들지 마라. 확실하지 않으면 {\"none\":true} 를 내라." }] },
    contents: [{ role: "user", parts: [{ text:
      school + " 학사일정 문서에서 뽑은 글자다. 표라서 칸 구분이 없어졌고 띄어쓰기도 지워졌다.\n" +
      "여기서 " + from.slice(0, 4) + "-" + from.slice(4, 6) + "-" + from.slice(6, 8) + " 부터 " +
      to.slice(0, 4) + "-" + to.slice(4, 6) + "-" + to.slice(6, 8) + " 사이에 있는 " +
      (kind || "중간") + "고사(지필평가) 기간을 찾아라.\n" +
      "시작일 = 첫 시험날, 종료일 = 마지막 시험날. 중간에 공휴일로 끊겨도 처음과 끝으로 잡는다.\n" +
      "1학기 시험이나 모의고사·학력평가는 제외한다.\n\n" +
      "형식: {\"start\":\"YYYY-MM-DD\",\"end\":\"YYYY-MM-DD\",\"grades\":[\"고1\",\"고2\",\"고3\"]}\n" +
      "학년 구분이 없으면 grades 는 세 학년 모두 넣는다. 못 찾으면 {\"none\":true}\n\n" +
      "--- 원문 ---\n" + text.slice(0, 12000) + "\n--- 끝 ---" }] }],
    // ⚠ gemini-2.5 계열은 답하기 전에 "생각"에 토큰을 쓴다. maxOutputTokens 가 작으면
    // 생각만 하다 끝나서 **빈 답**이 온다(오류가 아니라 그냥 비어 있어서 알아채기 어렵다).
    // 생각을 끄고, 상한도 넉넉히 준다.
    generationConfig: { temperature: 0, maxOutputTokens: 800, responseMimeType: "application/json",
                        thinkingConfig: { thinkingBudget: 0 } },
  };
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=" + key,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { lastDocReason = "AI 호출 실패 " + r.status; return null; }
  const j = await r.json().catch(() => null);
  const out = ((((j || {}).candidates || [])[0] || {}).content || {}).parts || [];
  const rawTxt = out.map((x) => x.text || "").join("").trim();
  if (!rawTxt) {
    const fin = (((j || {}).candidates || [])[0] || {}).finishReason || "";
    lastDocReason = "AI가 빈 답" + (fin ? " (" + fin + ")" : "");
    return null;
  }
  let v = null;
  try { v = JSON.parse(rawTxt); } catch (e) { lastDocReason = "AI 답을 못 읽음: " + rawTxt.slice(0, 60); return null; }
  if (!v || v.none || !v.start || !v.end) { lastDocReason = "문서에서 못 찾음"; return null; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.start) || !/^\d{4}-\d{2}-\d{2}$/.test(v.end)) {
    lastDocReason = "날짜 모양이 이상함"; return null;
  }

  // ---- 검증 ---- 지어낸 날짜를 걸러낸다
  const a = ymd(v.start), b = ymd(v.end);
  if (a < from || b > to || a > b) { lastDocReason = "기간 밖: " + v.start + "~" + v.end; return null; }
  const scope = semesterSlice(text, from);
  if (!dayHasExam(scope, v.start, kind) || !dayHasExam(scope, v.end, kind)) {
    lastDocReason = "원문에 없는 날짜라 막음: " + v.start + "~" + v.end; return null;
  }

  const grades = Array.isArray(v.grades) && v.grades.length ? v.grades : ["고1", "고2", "고3"];
  const byGrade = {};
  grades.forEach((g) => { if (GRADE_FIELD[g]) byGrade[g] = { start: v.start, end: v.end, days: 0, name: (kind || "중간") + "고사" }; });
  return Object.keys(byGrade).length ? byGrade : null;
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
    // 나이스에 시험이 없으면 학교 홈페이지를 본다 (달력 → 게시판 문서 순)
    let via = "", hasAny = rows.length > 0;
    if (Object.keys(byGrade).length) via = "neis";
    if (!via) {
      lastMenus = [];
      const hp = await homepageExams(s.hmpg, from, to, kind, budget);
      if (hp && Object.keys(hp.byGrade || {}).length) {
        Object.assign(byGrade, hp.byGrade); via = "homepage"; hasAny = true;
      } else if (hp) hasAny = true;
    }
    let docTitle = "";
    if (!via && lastMenus.length && budget.n > 0) {
      for (const url of lastMenus) {
        const doc = await boardDocText(url, budget).catch(() => null);
        if (!doc) continue;
        const g = await examFromDoc(doc.text, s.official, from, to, kind).catch(() => null);
        if (g) { Object.assign(byGrade, g); via = "doc"; hasAny = true; docTitle = doc.title; break; }
        hasAny = true;
      }
    }
    res.status(200).json({ school, official: s.official, officeName: s.officeName,
                           byGrade, found: exams.length,
                           // 나이스에 일정이 아예 없는 학교와, 일정은 있는데 시험만 안 올린 학교는 다르다
                           hasAny, via, docTitle, docReason: via === "doc" ? "" : lastDocReason,
                           homepage: s.hmpg || "",
                           truncated, hasKey: !!KEY });
  } catch (e) {
    console.error("[schedule]", e);
    res.status(500).json({ error: "서버 오류: " + e.message });
  }
}
