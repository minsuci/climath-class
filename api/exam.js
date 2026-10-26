// 실전 시험 — 학생이 태블릿으로 시험을 보고, 제출하면 **여기서** 채점한다.
//
// 왜 서버인가 — 정답이 학생 기기에 내려가면 안 된다. 바탕화면 원형(시간기록.html)은
// exams.js 에 정답을 그대로 두었는데, 한 기기에서만 돌 때는 괜찮아도 반 전체가 쓰면
// 소스를 연 한 명이 반 전체에 돌릴 수 있다.
//
// 저장 자리 (보안 규칙을 한 줄도 안 고친다)
//   examKeys/{examId}                    정답 포함 원본. 규칙 맨 아래 «전부 거절» 에 걸려
//                                        **서비스 계정만** 읽는다
//   appConfig/examList                   정답을 뺀 목록. 로그인한 누구나 읽는다
//   classes/{cid}/days/{날짜}/examLogs/{rid}   문항별 답·시간 흐름 전부
//   classes/{cid}/days/{날짜}/scores/{rid}     점수 한 줄 — 보고서·위험신호·점수 추이가
//                                              손대지 않아도 이걸 받아 간다
//
// 도구 열쇠(team/tools.lessonKey)로 시험지를 넣고 뺀다 — tools/exam-push.py
//
// 답 고정(lock) — 푸는 동안은 자유롭게 고치고, **제출한 뒤에는** 학생이 객관식 결과(O/X)를 못 고친다.
//   10/15~ 주관식(단답·서술)은 학생이 결과 화면에서 직접 O/X (selfOv 에 표시 · 화면 MockExamResult canMarkSub)
//   고치는 건 선생님만: 결과 화면 O/X 고침 · «답 고치기»(action "fix", 여기서 다시 채점)
import { verifyIdToken, getDoc, patchDoc, listDocs, deleteDoc, getDocV, patchDocIf } from "./_google.js";
import { createHash } from "crypto";

const TOOLKEY_PATH = "team/tools";
const LIST_PATH = "appConfig/examList";
const MAX_EV = 3000;
// 시간이 끝나도 바로 걷지 않는다 — 더 풀게 두고, 시간 뒤에 적은 답은 따로 채점한다(«시간 초과»).
// 끝없이 열려 있지 않게 이만큼 지나면 그때 저절로 낸다
const OVER_MAX = 30 * 60;          // 50분에 문항 25개면 넉넉히 몇 백. 이보다 많으면 무언가 잘못된 것

// 선생님 AI 연결(10/16 · #86) — 선생님 앱에 로그인한 선생님이면 도구 열쇠(lessonKey)를 그대로 받아 간다.
// 마왕님 결정: 선생님별 열쇠는 복잡해진다 — «선생님 링크로 들어오면 열쇠는 다 줘». 그 열쇠로 클로드 · GPT 가
// 나스 «클래스앱 도구»를 써서 반 자료를 읽는다. 열쇠가 새면 team/tools.lessonKey 를 바꾸고 다들 다시 받으면 된다
async function aiKeyGet(res, claims) {
  if (!(claims.role === "teacher" || claims.role === "owner")) { res.status(403).json({ error: "선생님만 받을 수 있어요" }); return; }
  const d = await getDoc(TOOLKEY_PATH).catch(() => null);
  if (!d || !d.lessonKey) { res.status(500).json({ error: "도구 열쇠가 아직 없어요 — 관리자에게 말해 주세요" }); return; }
  res.status(200).json({ ok: true, key: d.lessonKey });
}

async function toolOk(k) {
  if (!k) return false;
  const d = await getDoc(TOOLKEY_PATH).catch(() => null);
  return !!(d && d.lessonKey && d.lessonKey === k);
}

// ───────────── 채점 (원형과 같은 규칙 — 검증된 것을 그대로 옮겼다) ─────────────
// 단답형: 공백 무시 · 긴 붙임표도 빼기로 · -3/2 와 -1.5 를 같게 본다
function numVal(s) {
  s = String(s).replace(/\s/g, "").replace(/[−–]/g, "-");
  const m = s.match(/^(-?)(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (m) { const v = Number(m[2]) / Number(m[3]); return m[1] ? -v : v; }
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}
function sameShort(mine, key) {
  const a = String(mine).replace(/\s/g, "").replace(/[−–]/g, "-");
  const b = String(key).replace(/\s/g, "").replace(/[−–]/g, "-");
  if (a === b) return true;
  const x = numVal(a), y = numVal(b);
  return !isNaN(x) && !isNaN(y) && Math.abs(x - y) < 1e-9;
}
// true / false / null(서술형 — 사람이 채점)
function autoCorrect(q, mine) {
  if (q.type === "essay") return null;
  if (mine == null || mine === "") return false;
  if (q.type === "mc") return Number(mine) === Number(q.ans);
  return [].concat(q.ans).some((k) => sameShort(mine, k));
}
// 꼬리문제(parts) — 한 번호에 답 칸이 (1)(2)… 여럿. 칸마다 채점하고 배점을 나눠 준다(10/19 마왕님).
//   key: {n, type:"short", pt, parts:[{label:"(1)", ans, pt?, g?}], any?}  any = 칸 순서 상관없음(«30 또는 −22» 같은 두 값)
//   g = 묶음 이름 — 같은 g 칸끼리만 순서 상관없음(«a,b,c 와 t=2 또는 6» 처럼 일부만 순서가 없을 때)
//   기록 줄: answer = 칸별 답 배열 · pa = 칸별 O/X 배열 · auto = 다 맞았나 · O/X 고침은 override["19.1"] 처럼 «번호.칸»
// 모두 고르기(multi) — 객관식인데 ans 가 배열. 고른 것이 정답 묶음과 **똑같아야** 맞음
const isMulti = (q) => q.type === "mc" && Array.isArray(q.ans);
const hasParts = (q) => Array.isArray(q.parts) && q.parts.length > 0;
function gradeParts(q, arr) {
  const ks = q.parts.map((p) => [].concat(p.ans != null ? p.ans : p.key));
  const a = arr || [];
  const grp = (i) => (q.any ? "*" : q.parts[i].g != null ? "g" + q.parts[i].g : "i" + i);
  const used = new Set();
  return ks.map((_, i) => {
    if (!a[i]) return false;
    const j = ks.findIndex((k, j) => !used.has(j) && grp(j) === grp(i) && k.some((x) => sameShort(a[i], x)));
    if (j < 0) return false;
    used.add(j); return true;
  });
}
function gradeQ(q, mine) {
  if (hasParts(q)) { const pa = gradeParts(q, mine); return { auto: pa.every(Boolean), pa }; }
  if (isMulti(q)) return { auto: mine != null && JSON.stringify(mine) === JSON.stringify([...q.ans].map(Number).sort()) };
  return { auto: autoCorrect(q, mine) };
}
// 칸마다 배점 비율(합 1). 칸 배점이 다 있으면 그 비율, 없으면 똑같이
function partW(q) {
  const ps = q.parts, all = ps.every((p) => typeof p.pt === "number" && p.pt > 0);
  const sum = all ? ps.reduce((a, p) => a + p.pt, 0) : 0;
  return ps.map((p) => (all ? p.pt / sum : 1 / ps.length));
}
// 칸별 O/X (고침 반영). inTime 이고 시간 뒤에 바뀐 문항이면 끝난 순간의 답으로
function partOks(q, override, inTime) {
  if (inTime && q.late) return q.parts.map((_, i) => !!(q.paIn || [])[i]);
  return q.parts.map((_, i) => { const k = q.n + "." + (i + 1); return override && k in override ? override[k] : !!(q.pa || [])[i]; });
}
// 점수는 **100점 기준**으로 낸다. 점수 칸의 다른 줄(학생이 «17/22» 로 적는 것)이
// round(맞은/전체×100) 이라, 같은 날 반 평균에 섞여도 뜻이 맞아야 한다.
// inTime: 시간 안 점수 — 시간이 끝난 뒤 답이 바뀐 문항(late)은 끝난 순간의 답(autoIn)으로 센다
// ⚠ 공식 점수는 **낸 답 그대로**다(inTime 없이). 시간 안 점수는 참고(코칭)로만 log.inTime 에 남긴다.
//   2026-10-02 마왕님: «시간 지나도 낸 건 낸 거야» — 전엔 시간 안 점수가 공식이었다
// 꼬리문제는 맞은 칸 비율만큼 점수 · «맞은 문제» 는 칸이 다 맞아야 하나로 센다
function tally(qs, override, inTime) {
  const one = (q) => (inTime && q.late ? q.autoIn : override && q.n in override ? override[q.n] : q.auto);
  const ok = (q) => (hasParts(q) ? partOks(q, override, inTime).every(Boolean) : one(q));
  const frac = (q) => { if (!hasParts(q)) return one(q) ? 1 : 0; const w = partW(q); return partOks(q, override, inTime).reduce((a, o, i) => a + (o ? w[i] : 0), 0); };
  const hasPt = qs.every((q) => typeof q.pt === "number" && q.pt > 0);
  const totalPt = hasPt ? qs.reduce((a, q) => a + q.pt, 0) : qs.length;
  const got = qs.reduce((a, q) => a + frac(q) * (hasPt ? q.pt : 1), 0);
  return {
    got: Math.round(got * 10) / 10, totalPt: Math.round(totalPt * 10) / 10,
    correct: qs.filter((q) => ok(q)).length, n: qs.length,
    pending: qs.filter((q) => ok(q) === null).length,
    score: totalPt > 0 ? Math.round((got / totalPt) * 100) : 0,
  };
}
function inTimeOf(qs, override) {
  const t = tally(qs, override, true);
  return { score: t.score, got: t.got, correct: t.correct, pending: t.pending };
}

// 시간 흐름(ev)을 limit 초까지 되감아 그때의 답을 낸다. 기기가 보낸 답(answers)은 «끝까지» 의 답이다
function answersAt(ev, limit) {
  const a = {};
  for (const e of ev || []) {
    if (e.k !== "ans" || !(e.t <= limit)) continue;
    if (e.v == null || e.v === "") delete a[e.q]; else a[e.q] = e.v;
  }
  return a;
}

// 서버는 UTC 로 돈다. 수업 날짜는 한국 날짜여야 한다 — 밤 9시 시험이 «다음 날» 로 가면 안 된다
const kstDate = (ms) => new Date(Number(ms) + 9 * 3600e3).toISOString().slice(0, 10);

// ───────────── 시험지 모양 검사 ─────────────
function checkExam(e) {
  if (!e || typeof e !== "object") return "시험지가 비었어요";
  if (!/^[0-9A-Za-z가-힣_.\-]{2,80}$/.test(String(e.id || ""))) return "id 가 이상해요: " + e.id;
  if (!String(e.title || "").trim()) return "제목이 없어요";
  const hw = e.kind === "hw";   // 과제 교재 — 시간 제한 없이 위로 센다. 문항이 수백 개
  if (e.kind != null && !hw) return "kind 는 hw 만";
  if (!hw && !(Number(e.minutes) > 0)) return "제한 시간이 없어요";
  if (!Array.isArray(e.questions) || !e.questions.length) return "문항이 없어요";
  if (e.questions.length > (hw ? 4000 : 200)) return "문항이 너무 많아요";
  if (hw && e.link != null && !(typeof e.link === "string" && e.link.trim() && e.link.length <= 40)) return "link 는 반 교재 이름(40자 안)";
  // wb = 오답 과제(10/26) — 학생 한 명에게 건 오답 모음. 과제 교재와 똑같이 채점하고, 앱은 «오답 과제» 탭에 따로 띄운다
  if (e.wb != null && (typeof e.wb !== "boolean" || (e.wb && !hw))) return "wb 는 과제 교재(kind hw)에만 true/false";
  if (hw && e.units != null && !(Array.isArray(e.units) && e.units.every((u) => typeof u === "string" && u.trim() && u.length <= 30))) return "units 는 단원 이름(30자 안) 목록";
  const seen = {};
  for (const q of e.questions) {
    if (!Number.isInteger(q.n) || q.n <= 0) return "문항 번호가 이상해요: " + JSON.stringify(q);
    if (seen[q.n]) return q.n + "번이 두 번 있어요";
    seen[q.n] = 1;
    if (!["mc", "short", "essay"].includes(q.type)) return q.n + "번 종류가 이상해요: " + q.type;
    const c15 = (x) => Number.isInteger(x) && x >= 1 && x <= 5;
    if (q.type === "mc" && Array.isArray(q.ans)) {   // 모두 고르기
      if (hw) return q.n + "번 — 과제 교재엔 «모두 고르기» 를 못 써요";
      if (q.ans.length < 2 || !q.ans.every(c15) || new Set(q.ans).size !== q.ans.length) return q.n + "번 모두 고르기 답은 1~5 중 둘 이상(겹침 없이)";
    } else if (q.type === "mc" && !c15(q.ans)) return q.n + "번 객관식 답은 1~5";
    if (q.parts != null) {   // 꼬리문제
      if (hw) return q.n + "번 — 과제 교재엔 꼬리문제(parts)를 못 써요";
      if (q.type !== "short") return q.n + "번 꼬리문제는 type short 로";
      if (q.ans != null) return q.n + "번 꼬리문제는 ans 대신 parts 안에 답을 적어요";
      if (!Array.isArray(q.parts) || q.parts.length < 2 || q.parts.length > 6) return q.n + "번 parts 는 칸 2~6개";
      for (const p of q.parts) {
        if (!p || !(typeof p.label === "string" && p.label.trim() && p.label.length <= 8)) return q.n + "번 칸 이름(label, 8자 안)이 이상해요";
        const ks = [].concat(p.ans);
        if (!ks.length || ks.some((k) => !String(k == null ? "" : k).trim())) return q.n + "번 " + p.label + " 답이 없어요";
        if (p.pt != null && !(typeof p.pt === "number" && p.pt > 0)) return q.n + "번 " + p.label + " 배점이 이상해요";
        if (p.g != null && !(typeof p.g === "string" && p.g.trim() && p.g.length <= 8)) return q.n + "번 " + p.label + " 묶음(g)은 8자 안 글자";
      }
      if (q.any != null && typeof q.any !== "boolean") return q.n + "번 any 는 true/false";
    } else if (q.any != null) return q.n + "번 any 는 꼬리문제에만";
    if (q.type === "short" && q.parts == null) {
      const ks = [].concat(q.ans);
      if (!ks.length || ks.some((k) => !String(k == null ? "" : k).trim())) return q.n + "번 단답형 답이 없어요";
    }
    if (q.pt != null && !(typeof q.pt === "number" && q.pt > 0)) return q.n + "번 배점이 이상해요";
    if (q.o != null && !(typeof q.o === "string" && q.o.trim() && q.o.length <= 40)) return q.n + "번 o(원래 문항 «교재:번호:종류»)는 40자 안 글자";
    if (q.label != null && !(typeof q.label === "string" && q.label.trim() && q.label.length <= 16)) return q.n + "번 이름(label)이 이상해요";
    if (q.u != null && !(hw && Number.isInteger(q.u) && q.u >= 0 && q.u < (e.units || []).length)) return q.n + "번 단원(u)이 이상해요";
    if (q.p != null && !(hw && Number.isInteger(q.p) && q.p > 0)) return q.n + "번 쪽(p)이 이상해요";
  }
  if (e.lock != null && typeof e.lock !== "boolean") return "lock 은 true/false";
  return null;
}

// 학생이 보는 목록 — **정답(ans)만 뺀다.** 나머지는 그대로
// names(학생 이름) → sids. names 가 있으면 그 학생들만 본다. 목록(appConfig/examList)은 로그인한
// 누구나 읽으니 이름은 싣지 않고 자리 ID 로 바꿔 둔다. 명단에 없는 이름은 여기서 막는다.
// ⚠ 자리 ID 는 **반마다 따로** 매긴다(s1, s2…). 반 둘에 연 시험지에 «s2» 만 적으면 다른 반의 s2 도
//    보게 된다(10/8 — 고1S·고1TOP 에 연 중동고 1회). 그래서 «반ID/자리ID» 로 적는다
async function resolveSids(cids, names) {
  if (!names.length) return { sids: [] };
  if (!cids.length) return { error: "names 를 쓰려면 cids(반)도 적어야 해요" };
  const rows = [];
  for (const c of cids) {
    const cl = await getDoc("classes/" + c).catch(() => null);
    if (!cl) return { error: "반이 없어요: " + c };
    (cl.roster || []).forEach((r) => r && r.id && rows.push({ ...r, cid: c }));
  }
  const sids = [];
  for (const nm of names) {
    const hit = rows.filter((r) => String(r.name || "").trim() === nm);
    // 한 학생이 반 둘에 있으면(정규반 + 개진반) 이름이 두 번 잡힌다 — 같은 사람(pid)이면 두 자리 다 연다
    const people = new Set(hit.map((r) => r.pid || r.cid + "/" + r.id));
    if (!hit.length || people.size !== 1) return { error: (hit.length ? "명단에 둘 이상: " : "명단에 없는 이름: ") + nm };
    hit.forEach((r) => sids.push(r.cid + "/" + r.id));
  }
  return { sids };
}

// 창고 교재(학원 교재 정답 · shelf)는 한 권이 400~500문항이라 목록(appConfig/examList · 문서 하나 1MB 한도)에
// 문항을 그대로 실으면 42권이면 775KB 다. 종류 글자 줄(t) · 단원 구간(u) · 이름표 구간(l)으로 줄여 싣고 화면이 풀어 쓴다(hwExpand).
// n 은 1부터 연번이어야 한다(창고 교재는 그렇게 만든다)
function shelfCompact(qs) {
  const T = { mc: "m", short: "s", essay: "e" };
  const t = qs.map((q) => T[q.type] || "e").join("");
  const u = [], l = [];
  qs.forEach((q, i) => {
    if (q.u != null && (!u.length || u[u.length - 1][1] !== q.u)) u.push([i, q.u]);
    const m = /^(.*?)(\d+)번$/.exec(q.label || "");
    const last = l[l.length - 1];
    if (m && !(last && last[1] === m[1] && last[2] + (i - last[0]) === Number(m[2]))) l.push([i, m[1], Number(m[2])]);
  });
  return { t, ...(u.length ? { u } : {}), ...(l.length ? { l } : {}) };
}

async function rebuildList() {
  const all = await listDocs("examKeys").catch(() => []);
  const exams = all.map((e) => ({
    id: e.id, title: e.title, minutes: e.minutes,
    cids: e.cids || [], sids: e.sids || [], test: !!e.test, lock: !!e.lock, order: e.order || 0,
    ...(e.kind === "hw" ? { kind: "hw", units: e.units || [], link: e.link || "", ...(e.free ? { free: true } : {}), ...(e.wb ? { wb: true } : {}) } : {}),
    ...(e.shelf ? { shelf: e.shelf, allc: e.allc || [], qc: shelfCompact(e.questions || []), questions: [] } : {}),
    ...(e.shelf ? {} : { questions: (e.questions || []).map((q) => ({ n: q.n, type: q.type, ...(q.pt != null ? { pt: q.pt } : {}),
                                                 ...(q.label ? { label: q.label } : {}), ...(q.u != null ? { u: q.u } : {}),
                                                 ...(hasParts(q) ? { parts: q.parts.map((p) => ({ label: p.label, ...(p.g != null ? { g: p.g } : {}) })), ...(q.any ? { any: true } : {}) } : {}),
                                                 ...(isMulti(q) ? { multi: true } : {}) })) }),
  })).sort((a, b) => (a.order - b.order) || String(a.title).localeCompare(String(b.title), "ko"));
  await patchDoc(LIST_PATH, { exams, updated: Date.now() });
  return exams.length;
}

// ───────────── 문항별 채점 줄 — 제출(submit)과 옮기기(examMove)가 같이 쓴다 ─────────────
// 학생 답 다듬기 — 꼬리문제는 칸 수만큼의 글자 배열(빈 칸 ""), 모두 고르기는 고른 번호 배열(오름차순)
function normAns(q, raw) {
  if (raw == null || raw === "") return null;
  if (hasParts(q)) {
    const a = [].concat(raw);
    const out = q.parts.map((_, i) => (a[i] == null ? "" : String(a[i]).trim().slice(0, 20)));
    return out.some(Boolean) ? out : null;
  }
  if (isMulti(q)) {
    const a = typeof raw === "string" ? raw.split(/[^0-9]+/) : [].concat(raw);
    const s = [...new Set(a.map(Number).filter((x) => Number.isInteger(x) && x >= 1 && x <= 5))].sort((x, y) => x - y);
    return s.length ? s : null;
  }
  return q.type === "mc" ? Number(raw) : String(raw).slice(0, 20);
}
function gradeRows(key, answers, ev, limitSec, overSec) {
  const inAns = overSec > 0 ? answersAt(ev, limitSec) : null;
  return key.questions.map((q) => {
    const mine = normAns(q, answers[q.n]), g = gradeQ(q, mine);
    const row = { n: q.n, type: q.type, ...(q.pt != null ? { pt: q.pt } : {}), ...(q.label ? { label: q.label } : {}),
                  key: q.type === "essay" || hasParts(q) ? null : q.ans, answer: mine, auto: g.auto,
                  ...(q.type === "essay" && q.sol ? { sol: q.sol } : {}),   // 서술형 정답 글 — 낸 뒤 학생이 보고 스스로 O/X (10/26)
                  ...(hasParts(q) ? { parts: q.parts.map((p) => ({ label: p.label, key: p.ans, ...(p.pt != null ? { pt: p.pt } : {}), ...(p.g != null ? { g: p.g } : {}) })), pa: g.pa, ...(q.any ? { any: true } : {}) } : {}),
                  ...(isMulti(q) ? { multi: true } : {}) };
    // 시간이 끝난 뒤 답이 바뀌었으면 끝난 순간의 답을 따로 둔다. 그때 비어 있었으면 시간 안에는 틀림
    if (inAns) {
      const was = normAns(q, inAns[q.n]);
      if (String(was) !== String(mine)) {
        const gi = was == null ? { auto: false, pa: hasParts(q) ? q.parts.map(() => false) : undefined } : gradeQ(q, was);
        Object.assign(row, { late: true, answerIn: was, autoIn: gi.auto, ...(hasParts(q) ? { paIn: gi.pa } : {}) });
      }
    }
    return row;
  });
}

// ───────────── 다른 시험지로 옮기기 (도구) ─────────────
// 학생이 시험지를 잘못 골라 낸 것(10/2 양성은 — 2회를 풀고 1회 칸에 냄). 같은 답·같은 시간 흐름을
// 옮길 시험지의 정답으로 **여기서 다시 채점해** 새 기록으로 두고, 옛 기록은 선생님 «이 제출 취소» 와
// 똑같이 취소한다(voided + voidedScore 사본, 점수 칸 삭제). 옛 기록은 지우지 않는다 — «복원» 으로 되돌릴 수 있다.
async function moveLog(res, b) {
  const cid = String(b.cid || ""), date = String(b.date || ""), rid = String(b.rid || ""), to = String(b.to || "");
  if (!cid || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !rid || !to) { res.status(400).json({ error: "cid·date·rid·to 가 필요해요" }); return; }
  const base = "classes/" + cid + "/days/" + date;
  const old = await getDoc(base + "/examLogs/" + rid).catch(() => null);
  if (!old) { res.status(404).json({ error: "그 기록이 없어요" }); return; }
  if (old.voided) { res.status(400).json({ error: "이미 취소된 기록이에요" }); return; }
  if (old.examId === to) { res.status(400).json({ error: "같은 시험지예요" }); return; }
  const key = await getDoc("examKeys/" + to).catch(() => null);
  if (!key) { res.status(404).json({ error: "옮길 시험지가 없어요: " + to }); return; }
  const answers = {};
  (old.questions || []).forEach((q) => { if (q.answer != null) answers[q.n] = q.answer; });
  const qs = gradeRows(key, answers, old.ev || [], old.limitSec, old.overSec || 0);
  const t = tally(qs, {});
  const nrid = (rid + "m").slice(0, 40);
  const now = Date.now();
  const { voided: _v, voidedScore: _s, id: _i, all: _al, inTime: _it, ...keep } = old;
  const log = {
    ...keep, rid: nrid, examId: to, title: key.title, minutes: key.minutes, questions: qs, override: {},
    ...(key.lock ? { lock: true } : {}),
    score: t.score, got: t.got, totalPt: t.totalPt, correct: t.correct, n: t.n, pending: t.pending,
    ...(old.overSec > 0 ? { inTime: inTimeOf(qs, {}) } : {}),
    movedFrom: { examId: old.examId, rid, at: now }, time: now,
  };
  await patchDoc(base + "/examLogs/" + nrid, log);
  let copy = null;
  if (!old.teacher) {
    copy = await getDoc(base + "/scores/" + rid).catch(() => null);
    await patchDoc(base + "/scores/" + nrid, {
      sid: old.sid, name: old.name, score: t.score, correct: t.correct, total: t.n,
      label: key.title, time: now, examLog: nrid,
    });
  }
  await patchDoc(base + "/examLogs/" + rid, { voided: { at: now, by: "tool:examMove → " + to }, voidedScore: copy ? stripId(copy) : null });
  if (copy) await deleteDoc(base + "/scores/" + rid);
  res.status(200).json({ ok: true, rid: nrid, score: t.score, correct: t.correct, n: t.n, pending: t.pending,
                         questions: qs.map((q) => ({ n: q.n, answer: q.answer, auto: q.auto })) });
}
const stripId = (d) => { const { id: _i, ...r } = d || {}; return r; };

// ───────────── «지금 시험 중» 실시간 O/X (10/26) ─────────────
// 학생 기기가 답이 바뀔 때마다 지금 답을 보낸다. 정답은 서버에만 있으니 채점도 여기서 하고 examLiveMarks 에 둔다.
// ⚠ 반 친구끼리 서로 읽히는 examLive(days 아래)에는 O/X 를 안 쓴다 — 시험 중에 남의 정오가 보이면 안 된다.
//    examLiveMarks 는 규칙에 없어(«전부 거절») 학생 기기가 못 읽는다. 학생에게는 O/X 를 돌려주지 않는다(답 맞히기 통로가 되지 않게)
const liveMarkPath = (cid, date, sid) => "examLiveMarks/" + cid + "__" + date + "__" + sid;
async function liveMark(res, claims, b) {
  const cid = String(b.cid || ""), sid = String(b.sid || ""), examId = String(b.examId || ""), rid = String(b.rid || ""), date = String(b.date || "");
  if (!cid || !sid || !examId || !/^[A-Za-z0-9_-]{6,40}$/.test(rid) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: "빠진 값이 있어요" }); return; }
  const who = await hwWho(res, claims, cid, sid); if (!who) return;
  const key = await getDoc("examKeys/" + examId).catch(() => null);
  if (!key || key.kind === "hw") { res.status(404).json({ error: "그 시험지가 없어요" }); return; }
  const answers = b.answers && typeof b.answers === "object" ? b.answers : {};
  const m = {};   // 번호 → o 맞음 · x 틀림 · h 꼬리문제 일부 · p 서술형(선생님 채점). 안 적은 번호는 없음
  for (const q of key.questions || []) {
    const mine = normAns(q, answers[q.n]);
    if (mine == null || (Array.isArray(mine) && !mine.some((v) => v != null && v !== ""))) continue;
    if (q.type === "essay") { m[q.n] = "p"; continue; }
    const g = gradeQ(q, mine);
    m[q.n] = g.auto ? "o" : g.pa && g.pa.some(Boolean) ? "h" : "x";
  }
  await patchDoc(liveMarkPath(cid, date, sid), { cid, date, sid, rid, examId, m, at: Date.now() });
  res.status(200).json({ ok: true });
}
// 선생님 판 — 지금 시험 중인 학생들의 O/X. {cid, date, sids:[…]}
async function liveMarks(res, claims, b) {
  if (!(claims.role === "teacher" || claims.role === "owner")) { res.status(403).json({ error: "선생님만 볼 수 있어요" }); return; }
  const cid = String(b.cid || ""), date = String(b.date || "");
  const sids = Array.isArray(b.sids) ? [...new Set(b.sids.map(String))].slice(0, 80) : [];
  if (!cid || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: "빠진 값이 있어요" }); return; }
  const marks = {};
  await Promise.all(sids.map(async (sid) => {
    const d = await getDoc(liveMarkPath(cid, date, sid)).catch(() => null);
    if (d) marks[sid] = { rid: d.rid, m: d.m || {} };
  }));
  res.status(200).json({ ok: true, marks });
}

// ───────────── 제출 ─────────────
async function submit(res, claims, b) {
  const cid = String(b.cid || ""), sid = String(b.sid || ""), examId = String(b.examId || "");
  const rid = String(b.rid || "");
  if (!cid || !sid || !examId) { res.status(400).json({ error: "빠진 값이 있어요" }); return; }
  // rid 는 기기가 만든다. 같은 rid 로 다시 보내면 **같은 자리에 덮어쓴다** —
  // 제출 직후 연결이 끊겨 다시 누르면 기록이 두 개가 되는 일을 막는다.
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(rid)) { res.status(400).json({ error: "기록 번호가 이상해요" }); return; }

  let teacher = claims.role === "teacher" || claims.role === "owner";
  const cls = await getDoc("classes/" + cid).catch(() => null);
  if (!cls) { res.status(404).json({ error: "반이 없어요" }); return; }
  let name = String(b.name || "");
  if (!teacher) {
    // 학생 토큰에는 학생ID가 없다(이름과 소속 반만). 명단의 그 자리 이름이
    // 토큰의 이름과 같은지 본다 — 남의 이름으로 제출하지 못하게. (noteview 와 같은 방식)
    if (!(claims.cids || []).includes(cid)) { res.status(403).json({ error: "그 반 학생이 아니에요" }); return; }
    const row = (cls.roster || []).find((r) => r && r.id === sid);
    if (!row || row.name !== claims.sname) { res.status(403).json({ error: "명단과 이름이 맞지 않아요" }); return; }
    name = row.name;
    // 학생 화면의 «선생님 모드» 는 명단에 teacher 표시가 붙은 학생 계정이다. 서버엔 학생으로 오지만
    // 선생님이 확인하려고 본 것이니 점수 칸에 쓰지 않는다
    if (row.teacher) teacher = true;
  }

  const key = await getDoc("examKeys/" + examId).catch(() => null);
  if (!key) { res.status(404).json({ error: "그 시험지가 없어요 (지워졌을 수 있어요)" }); return; }

  const answers = b.answers && typeof b.answers === "object" ? b.answers : {};
  const ev = Array.isArray(b.ev) ? b.ev.slice(0, MAX_EV).map((e) => ({
    t: Number(e.t) || 0, k: e.k === "ans" ? "ans" : "go", q: Number(e.q) || 0,
    ...(e.k === "ans" ? { v: e.v == null ? null : Array.isArray(e.v) ? e.v.slice(0, 6).map((x) => (x == null ? "" : String(x).slice(0, 20))) : String(e.v).slice(0, 20) } : {}),
  })) : [];
  const limitSec = Math.max(60, Math.min(6 * 3600, Number(b.limitSec) || key.minutes * 60));
  const endT = Math.max(0, Math.min(limitSec + OVER_MAX, Number(b.endT) || 0));
  const startedAt = Number(b.startedAt) || Date.now();
  const overSec = Math.max(0, Math.round((endT - limitSec) * 10) / 10);
  const qs = gradeRows(key, answers, ev, limitSec, overSec);
  const t = tally(qs, {});   // 공식 점수는 **낸 답 그대로** — 시간을 넘겨 낸 것도 점수다(10/2)
  const date = kstDate(startedAt);
  const now = Date.now();
  const log = {
    rid, cid, sid, name, examId, title: key.title, minutes: key.minutes,
    limitSec, endT, startedAt, reason: b.reason === "time" ? "time" : "submit",
    date, questions: qs, ev, override: {}, ...(key.lock ? { lock: true } : {}),
    score: t.score, got: t.got, totalPt: t.totalPt, correct: t.correct, n: t.n, pending: t.pending,
    ...(overSec > 0 ? { overSec, inTime: inTimeOf(qs, {}) } : {}),
    teacher, time: now,
  };
  const base = "classes/" + cid + "/days/" + date;
  // ⚠ 날짜 문서가 없으면 목록(listDays)에 그 날이 안 잡혀 점수가 **보고서에서 사라진다.**
  //    하위 컬렉션만 있는 문서는 목록 조회에 안 나온다. updated 한 칸만 건드린다 —
  //    patchDoc 은 보낸 칸만 고치므로 크론이 써 둔 lesson 은 그대로다.
  await patchDoc(base, { updated: now });
  await patchDoc(base + "/examLogs/" + rid, log);
  // 선생님 모드로 본 것은 **점수 칸에 안 쓴다.** 써 두면 반 평균·위험신호가 흔들린다.
  if (!teacher) {
    await patchDoc(base + "/scores/" + rid, {
      sid, name, score: t.score, correct: t.correct, total: t.n,
      label: key.title, time: now, examLog: rid,
    });
  }
  res.status(200).json({ ok: true, log });
}

// ───────────── 선생님이 답을 고친다 ─────────────
// 답 고정 시험에서 학생이 잘못 누른 답을 선생님이 바꾼다. 정답은 여기(서버)에만 있으니
// 다시 채점도 여기서 한다. 고친 흔적(fixed)을 문항에 남기고, 그 문항의 O/X 고침(override)은 푼다.
async function fixAnswer(res, claims, b) {
  if (!(claims.role === "teacher" || claims.role === "owner")) { res.status(403).json({ error: "선생님만 답을 고칠 수 있어요" }); return; }
  const cid = String(b.cid || ""), date = String(b.date || ""), rid = String(b.rid || ""), n = Number(b.n);
  if (!cid || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[A-Za-z0-9_-]{6,40}$/.test(rid) || !Number.isInteger(n)) {
    res.status(400).json({ error: "빠진 값이 있어요" }); return;
  }
  const path = "classes/" + cid + "/days/" + date + "/examLogs/" + rid;
  const log = await getDoc(path).catch(() => null);
  if (!log) { res.status(404).json({ error: "그 기록이 없어요" }); return; }
  const key = await getDoc("examKeys/" + log.examId).catch(() => null);
  const kq = key && (key.questions || []).find((q) => q.n === n);
  const i = (log.questions || []).findIndex((q) => q.n === n);
  if (!kq || i < 0) { res.status(404).json({ error: n + "번 정답을 찾지 못했어요" }); return; }
  // 꼬리문제는 칸별 배열(value: ["30","-22"]) · 모두 고르기는 «2,5» 나 [2,5]
  const raw = Array.isArray(b.value) ? b.value : b.value == null ? "" : String(b.value).trim().slice(0, 20);
  const mine = hasParts(kq) || isMulti(kq) ? normAns(kq, raw) : raw === "" ? null : (kq.type === "mc" ? Number(raw) : raw);
  if (kq.type === "mc" && !isMulti(kq) && mine != null && !(Number.isInteger(mine) && mine >= 1 && mine <= 5)) { res.status(400).json({ error: "객관식은 1~5" }); return; }
  const old = log.questions[i];
  const who = claims.tid ? await getDoc("teachers/" + claims.tid).catch(() => null) : null;
  const { late: _l, answerIn: _a, autoIn: _x, paIn: _p, ...rest } = old;   // 선생님이 정한 답은 시간 안 답으로 본다
  const g = gradeQ(kq, mine);
  const row = { ...rest, answer: mine, auto: g.auto, ...(g.pa ? { pa: g.pa } : {}),
                fixed: { from: old.answer == null ? null : old.answer, by: (who && who.name) || claims.tid || claims.role, at: Date.now() } };
  const questions = log.questions.map((q, k) => (k === i ? row : q));
  // 그 번호의 O/X 고침은 푼다 — 꼬리문제면 «번호.칸» 도 전부
  const mineKey = (k) => k === String(n) || k.startsWith(n + ".");
  const override = { ...(log.override || {}) }; Object.keys(override).filter(mineKey).forEach((k) => delete override[k]);
  const selfOv = { ...(log.selfOv || {}) }; Object.keys(selfOv).filter(mineKey).forEach((k) => delete selfOv[k]);   // 학생이 스스로 고친 표시도 푼다
  const t = tally(questions, override);
  const patch = { questions, override, selfOv, score: t.score, got: t.got, correct: t.correct, pending: t.pending,
                  ...(log.overSec > 0 ? { inTime: inTimeOf(questions, override), all: null } : {}) };
  await patchDoc(path, patch);
  if (!log.teacher && !log.voided) {
    await patchDoc("classes/" + cid + "/days/" + date + "/scores/" + rid, { score: t.score, correct: t.correct }).catch(() => {});
  }
  res.status(200).json({ ok: true, log: { ...log, ...patch } });
}

// ───────────── 학결모 반에서 선생님이 학교 시험지를 학생에게 걸고 뺀다 (10/8 · 임시) ─────────────
// 학교결정 모의고사를 대치 밖(서초 · 평촌)에서도 받는다. 거기 선생님이 학생을 넣고 바로 학교를 고르게 한다.
// 열쇠(toolKey) 없이 부르므로 좁게 막는다: openRoster 표시가 있는 반 · 그 반 담당 · 학교 시험지만.
const HK_TITLE = "학교 결정 모의고사 · ";
const isHkSchoolExam = (k) => !!k && String(k.title || "").startsWith(HK_TITLE) && !String(k.id || "").startsWith("학교결정모의-공통");
// 담당 확인 — openRoster 반 · 그 반 담당(관리자는 다) · 명단의 학생 한 줄
async function hkGate(res, claims, cid, sid) {
  if (!(claims.role === "teacher" || claims.role === "owner")) { res.status(403).json({ error: "선생님만 할 수 있어요" }); return null; }
  const cls = cid ? await getDoc("classes/" + cid).catch(() => null) : null;
  if (!cls) { res.status(404).json({ error: "반이 없어요" }); return null; }
  if (!cls.openRoster) { res.status(403).json({ error: "학교결정 모의고사 반에서만 할 수 있어요" }); return null; }
  if (claims.role !== "owner") {
    const t = claims.tid ? await getDoc("teachers/" + claims.tid).catch(() => null) : null;
    if (!t || !(t.classIds || []).includes(cid)) { res.status(403).json({ error: "담당 반이 아니에요" }); return null; }
  }
  const row = (cls.roster || []).find((r) => r && r.id === sid && !r.teacher);
  if (!row) { res.status(404).json({ error: "이 반 명단에 없는 학생이에요" }); return null; }
  return { cls, row };
}
// 시험지의 학생 지정을 바꿔 쓴다. ⚠ 학생 지정이 비면 «반 전체에 열림» 이 되어 cids 의 모든 반 학생에게
// 열린다 — 그래서 마지막 학생이 빠지면 시험지를 **숨긴다**(test = 선생님만 보임, hkEmpty 표시).
// 다시 학생을 걸면 hkEmpty 인 것만 도로 연다(원래 시험용이던 것은 건드리지 않는다).
async function hkSetNames(key, names, cids) {
  if (!names.length) {
    await patchDoc("examKeys/" + key.id, { names: [], cids: [], sids: [], test: true, hkEmpty: true, updated: Date.now() });
    return { hidden: true };
  }
  const got = await resolveSids(cids, names);
  if (got.error) return { error: got.error };
  cids = cids.filter((c) => got.sids.some((x) => x.startsWith(c + "/")));   // 걸린 학생이 없는 반은 뺀다
  await patchDoc("examKeys/" + key.id, { names, cids, sids: got.sids, updated: Date.now(),
                                         ...(key.hkEmpty ? { test: false, hkEmpty: false } : {}) });
  return { ok: true };
}
async function hkExam(res, claims, b) {
  const cid = String(b.cid || ""), sid = String(b.sid || ""), examId = String(b.examId || ""), on = b.on !== false;
  const g = await hkGate(res, claims, cid, sid); if (!g) return;
  const key = await getDoc("examKeys/" + examId).catch(() => null);
  if (!isHkSchoolExam(key)) { res.status(400).json({ error: "학교결정 모의고사 학교 시험지만 고를 수 있어요" }); return; }
  key.id = key.id || examId;
  const nm = String(g.row.name).trim();
  let names = (key.names || []).map((x) => String(x).trim()).filter(Boolean);
  let cids = (key.cids || []).map(String);
  if (on) { if (!names.includes(nm)) names.push(nm); if (!cids.includes(cid)) cids.push(cid); }
  else names = names.filter((x) => x !== nm);
  const r = await hkSetNames(key, names, cids);
  if (r.error) { res.status(400).json({ error: r.error }); return; }
  await rebuildList();
  res.status(200).json({ ok: true, examId, names: names.length, hidden: !!r.hidden });
}
// 학결모 반에서 학생을 지운다 (잘못 넣은 학생 · 안 오는 학생). 화면에서 하면 반 명단 · 사람 · 시험지 세 곳이
// 따로 놀아서 서버가 한 번에 한다.
//   1. 반 명단에서 뺀다   2. 다른 반에 없는 사람이면 학생 명단(students)에서도 지운다
//   3. 그 이름이 걸린 시험지에서 뺀다 — 다른 반에 같은 사람이 남아 있으면 그대로 둔다
// 이미 낸 시험 기록(days/…/examLogs · scores)은 지우지 않는다.
async function hkRemove(res, claims, b) {
  const cid = String(b.cid || ""), sid = String(b.sid || "");
  const g = await hkGate(res, claims, cid, sid); if (!g) return;
  const row = g.row, nm = String(row.name).trim();
  await patchDoc("classes/" + cid, { roster: (g.cls.roster || []).filter((r) => !(r && r.id === sid)) });
  let personGone = false;
  if (row.pid) {
    const cs = await listDocs("classes").catch(() => []);
    const elsewhere = cs.some((c) => c.id !== cid && (c.roster || []).some((r) => r && r.pid === row.pid));
    if (!elsewhere) { await deleteDoc("students/" + row.pid).catch(() => {}); personGone = true; }
  }
  const keys = await listDocs("examKeys").catch(() => []);
  const exams = [], problems = [];
  for (const k of keys) {
    const names = (k.names || []).map((x) => String(x).trim()).filter(Boolean);
    const cids = (k.cids || []).map(String);
    if (!names.includes(nm) || !cids.includes(cid)) continue;
    const still = await resolveSids(cids, names);           // 다른 반에 그 사람이 남았으면 이름은 그대로 두고 자리만 다시
    const r = await hkSetNames(k, still.error ? names.filter((x) => x !== nm) : names, cids);
    if (r.error) problems.push(k.id + ": " + r.error); else exams.push({ id: k.id, hidden: !!r.hidden });
  }
  await rebuildList();
  res.status(200).json({ ok: true, name: nm, pid: row.pid || "", personGone, exams, problems });
}

// ───────────── 핸들러 ─────────────
// ───────────── 과제 채점 (2026-10-10 · 고1 기말대비 «초개인화») ─────────────
// 학생이 집에서 교재(수평교 · 퀀텀점프 · 기출백서)를 풀고 **푼 번호의 답만** 앱에 적는다. 시간은 위로 센다.
// 교재는 examKeys 에 kind:"hw" 로 통째로 올려 둔다(문항 수백 개) — 과제마다 범위는 학생이 고른다.
//   classes/{cid}/days/{날짜}/hwLogs/{rid}   한 번 낸 것. 실전 시험(examLogs)과 섞이지 않게 따로 둔다
//   ⚠ 점수 칸(scores)에는 **쓰지 않는다** — 과제 정답률이 테스트 점수 추이 · 위험신호에 섞이면 안 된다
//   ⚠ 정답(key)은 기록에 **남기지 않는다** — 틀린 것을 다시 푸는데(hwRetry) 기록에서 답이 보이면 안 된다
// 첫 시도(auto)는 그대로 두고, 다시 푼 것은 tries[] 에 쌓는다. fin = 마지막 시도가 맞았나
const HW_MAX_Q = 400;          // 한 번에 낼 수 있는 문항 수
const HW_MAX_SEC = 12 * 3600;  // 쉰 시간을 뺀 «푼 시간» 이 이보다 길면 잘못된 것
// 문항마다 머문 시간(초). ev 의 t 는 «쉰 시간을 뺀» 시계라 그대로 더하면 된다
function hwSecs(ev, endT) {
  const gos = (ev || []).filter((e) => e.k === "go"), sec = {};
  gos.forEach((e, i) => {
    const to = i + 1 < gos.length ? gos[i + 1].t : endT;
    if (to > e.t) sec[e.q] = (sec[e.q] || 0) + (to - e.t);
  });
  return sec;
}
// 학생이 자기 자리로 내는지 (submit 과 같은 방식). 선생님(또는 명단의 선생님 표시 학생)은 teacher:true
async function hwWho(res, claims, cid, sid) {
  const cls = await getDoc("classes/" + cid).catch(() => null);
  if (!cls) { res.status(404).json({ error: "반이 없어요" }); return null; }
  const row = (cls.roster || []).find((r) => r && r.id === sid);
  if (claims.role === "teacher" || claims.role === "owner") return { name: (row && row.name) || "", teacher: true, cls };
  // 토큰의 반 목록(cids)은 **로그인한 때** 것이다 — 그 뒤에 반에 들어갔으면 빠져 있다(10/10 한민수: 오래된 로그인으로 «그 반 학생이 아니에요»).
  // 지금 명단의 그 자리 이름이 토큰의 이름과 같으면 받는다
  const nn = (s) => String(s || "").replace(/\s+/g, "");
  if (!row || !claims.sname || nn(row.name) !== nn(claims.sname)) {
    res.status(403).json({ error: (claims.cids || []).includes(cid) ? "명단과 이름이 맞지 않아요" : "그 반 학생이 아니에요" }); return null;
  }
  return { name: row.name, teacher: !!row.teacher, cls };
}
// 원래 있던 «과제» 번호표(classes/{cid}/homework/{sid}.books[교재])와 잇는다 — 과제 채점에 답을 적은 번호를 «한 것» 으로 칠한다.
// 교재의 link 와 **이름이 같은 반 교재**가 있을 때만. 개진반은 학생마다 교재가 따로라 그 학생 줄의 books 를 본다.
// 학생이 번호표에서 직접 칠한 것은 그대로 두고 더하기만 한다(빼지 않는다)
async function hwMarkDone(cls, sid, name, link, nums) {
  if (!cls || !link || !nums.length) return null;
  const row = (cls.roster || []).find((r) => r && r.id === sid);
  const books = cls.type === "individual" ? ((row && row.books) || []) : (cls.books || []);
  const bk = books.find((b) => b && b.name === link);
  if (!bk) return null;
  const path = "classes/" + cls.id + "/homework/" + sid;
  const cur = await getDoc(path).catch(() => null);
  const had = ((cur && cur.books && cur.books[link]) || []).map(Number);
  const all = [...new Set(had.concat(nums.filter((n) => !bk.total || n <= bk.total)))].sort((a, b) => a - b);
  if (all.length === had.length) return link;
  // books 를 통째로 다시 쓴다(읽은 것 + 이 교재). 한 칸만 고치는 경로(books.`이름`)는 한글 이름 따옴표가 틀리면
  // 다른 교재 칸까지 날아갈 수 있어서 쓰지 않는다
  await patchDoc(path, { name, books: { ...((cur && cur.books) || {}), [link]: all } }, ["name", "books"]);
  return link;
}
const hwEv = (ev) => (Array.isArray(ev) ? ev.slice(0, MAX_EV).map((e) => {
  const t = Math.max(0, Number(e.t) || 0);
  // away = 풀기 화면을 떠났다 돌아옴(t 떠난 때 · r 돌아온 때 — 둘 다 «푼 시간» 시계, s 실제로 떠나 있던 초) · pz = 쉬기(s 쉰 초)
  if (e.k === "away") return { t, k: "away", r: Math.max(t, Number(e.r) || t), s: Math.max(0, Math.min(HW_MAX_SEC, Number(e.s) || 0)) };
  if (e.k === "pz") return { t, k: "pz", s: Math.max(0, Math.min(HW_MAX_SEC, Number(e.s) || 0)) };
  return { t, k: e.k === "ans" ? "ans" : "go", q: Number(e.q) || 0,
           ...(e.k === "ans" ? { v: e.v == null ? null : String(e.v).slice(0, 20) } : {}) };
}) : []);
const hwNorm = (q, raw) => (raw == null || raw === "" ? null : (q.type === "mc" ? Number(raw) : String(raw).slice(0, 20)));
const r1 = (x) => Math.round(x * 10) / 10;

// ===== 조각 — 과제 보상 (설계 확정 2026-10-12) =====
// 볼트 «20 작업/조각 보상 — 과제 집중 설계.md». 마왕님이 정한 규칙:
//   처음 맞힘 1조각 · 틀린 것 다시 풀어 맞힘 1조각 · 번호 순 5연속 정답 +1 · 상한 없음
//   이탈(풀기 화면을 5초 넘게 떠남)은 하루 단위로 세고 3번째마다 −10(다시 1부터, 0에서 멈춤)
//   조각 20 = 구슬 1. 구슬을 열면 확률로 기프티콘 또는 꽝. 재고 없는 게 뽑히면 구슬을 안 쓴다(«나중에 다시»)
// 장부 classes/{cid}/pieces/{sid} — 쓰기는 서버만, 조건부 쓰기(getDocV · patchDocIf)로 겹침을 막는다
const PC = {
  // 조각 주는 교재 — 마왕님이 정한 것만(10/24 «내가 직접 설정해야 들어간다»). 반이 대상이어도 이 목록에 없는 교재는 조각·이탈 없음.
  // appConfig/pieces.books 가 있으면 그것(pieces.mjs --books). 학원 교재 고르기로 건 교재 · 선생님 도구로 올린 교재는 저절로 안 들어간다
  books: ["수평교-2026-2기말", "퀀텀점프-2026-2기말"],
  cids: ["s-mongeum", "jasago"],   // 대상 반 — 10/12 고1S · 고1자사고반(TOP 은 뺌). appConfig/pieces.cids 가 있으면 그것(10/13 TOP 더함 — pieces.mjs --cids)
  cost: 20,        // 구슬 하나 = 조각 20
  streak: 5,       // 번호 순 연속 정답 다섯마다 +1
  awayMin: 5,      // 이만큼(초) 이하로 떠난 건 안 센다
  awayEvery: 3,    // 하루에 이탈 3번째마다
  awayPen: 10,     // 조각 −10 (0에서 멈춤)
};
const pcPath = (cid, sid) => "classes/" + cid + "/pieces/" + sid;
const PC_LOG = 150, PC_AWAY = 300;
async function pcCfg() {
  const { doc, v } = await getDocV("appConfig/pieces");
  const d = doc || {};
  return { items: (d.items || []).filter((x) => x && x.id && x.name), cids: Array.isArray(d.cids) && d.cids.length ? d.cids : PC.cids,
           books: Array.isArray(d.books) ? d.books : PC.books, v, doc: d };
}
// 이 반 · 이 교재가 조각을 주나 — 반(cids)과 교재(books) 둘 다
const pcBookOn = (cfg, cid, bookId) => !!cfg && cfg.cids.includes(cid) && cfg.books.includes(String(bookId || ""));
// 낸 것 하나에서 번 조각 — 처음 맞힌 문제 + 번호 순 5연속. 안 적은 번호 · 스스로 채점 기다리는 것은 건너뛴다(끊지도 잇지도 않음)
function hwPieces(questions) {
  let first = 0, streaks = 0, run = 0;
  [...(questions || [])].sort((a, b) => a.n - b.n).forEach((q) => {
    if (q.answer == null || q.auto === null || q.lect) return;   // lect = 수업에서 풀어 준 번호(10/15) — 조각 없음, 연속도 안 끊음
    if (q.auto === true) { first++; if (++run >= PC.streak) { streaks++; run = 0; } } else run = 0;
  });
  return { first, streaks, pts: first + streaks };
}
// 수업에서 풀어 준 번호(10/15 마왕님) — 선생님이 반·교재마다 그때그때 표시한다. hwLect/{cid} {b:{교재id:[번호]}, at, by}.
// 표시된 뒤에 낸 답만 조각이 없다(낸 때 questions[].lect 로 박아 둔다). 그 전에 낸 것은 예습이라 그대로 — 회수하지 않는다
// 10/15 오후: «홀수 기본 보류»(odd) — 원장님 반(TOP)처럼 무엇을 풀어 줬는지 모를 때, 홀수 번호는 처음부터 수업 풀이로 보고 보류한다.
// 나중에 «풀기»(rel 에 넣음 · 직접 표시한 번호는 b 에서 뺌) 하면 그 번호를 맞힌 학생에게 그때 지급(hwLectPay) — 회수가 아니라 «나중에 더 받는» 꼴.
// 장부 held = 보류 중인 조각 수(보여 주기용). 5연속 덤은 낼 때 한 번만 세고, 나중 지급 땐 다시 세지 않는다
const hwLectPath = (cid) => "hwLect/" + cid;
const hwLectNorm = (d) => ({ b: (d && d.b) || {}, odd: !!(d && d.odd), rel: (d && d.rel) || {} });
async function hwLectGet(cid) { return hwLectNorm(await getDoc(hwLectPath(cid)).catch(() => null)); }
const hwLectHas = (L, bookId, n) => (L.b[bookId] || []).map(Number).includes(n) || (L.odd && n % 2 === 1 && !(L.rel[bookId] || []).map(Number).includes(n));
// 보류를 푼 번호 — 이 반 기록에서 그 교재·번호가 lect 이고 (처음 맞힘 또는 다시 맞힘) 인 줄을 찾아 1조각씩. 줄의 lect 를 걷어 두 번 안 준다
async function hwLectPay(cid, bookId, nums) {
  const want = new Set(nums.map(Number)), per = {};
  const days = (await listDocs("classes/" + cid + "/days").catch(() => [])).map((d) => d.id);
  for (const d of days) {
    const ls = await listDocs("classes/" + cid + "/days/" + d + "/hwLogs").catch(() => []);
    for (const l0 of ls) {
      if (l0.bookId !== bookId || l0.teacher || !(l0.questions || []).some((q) => q.lect && want.has(q.n))) continue;
      const path = "classes/" + cid + "/days/" + d + "/hwLogs/" + (l0.rid || l0.id);
      for (let k = 0; k < 5; k++) {
        const { doc: l, v } = await getDocV(path); if (!l) break;
        let pay = 0;
        const questions = (l.questions || []).map((q) => {
          if (!q.lect || !want.has(q.n)) return q;
          const ok = q.auto === true || (q.auto === false && q.fin === true);
          if (ok) pay++;
          const { lect, ...rest } = q;
          return { ...rest, lectFreed: Date.now(), ...(ok ? { lectPaid: true } : {}) };
        });
        if (await patchDocIf(path, { questions }, ["questions"], v)) {
          if (pay) { const x = per[l.sid] || (per[l.sid] = { name: l.name, pay: 0 }); x.pay += pay; }
          break;
        }
      }
    }
  }
  for (const [sid, x] of Object.entries(per)) {
    await pcEdit(cid, sid, (L) => ({ name: x.name, bal: (L.bal || 0) + x.pay, earned: (L.earned || 0) + x.pay, held: Math.max(0, (L.held || 0) - x.pay),
      log: [...(L.log || []), { t: Date.now(), k: "lect", book: bookId, nums: [...want].slice(0, 40), d: x.pay }].slice(-PC_LOG) })).catch((e) => console.error("[lectPay]", e));
  }
  return Object.entries(per).map(([sid, x]) => ({ sid, name: x.name, pay: x.pay }));
}
// 장부 고치기 — 읽고 fn 으로 바꿔 «그 사이 아무도 안 고쳤을 때만» 쓴다. 남이 먼저 썼으면 다시
async function pcEdit(cid, sid, fn) {
  for (let i = 0; i < 6; i++) {
    const { doc, v } = await getDocV(pcPath(cid, sid));
    const d = doc || {};
    const next = fn(d);
    if (!next) return { before: d, next: null };
    if (await patchDocIf(pcPath(cid, sid), next, Object.keys(next), v)) return { before: d, next };
  }
  throw new Error("조각 장부가 바빠요 — 잠깐 뒤에 다시");
}
async function pcAdd(cid, sid, name, pts, rec, held) {
  const r = await pcEdit(cid, sid, (d) => ({ name, bal: (d.bal || 0) + pts, earned: (d.earned || 0) + pts, ...(held ? { held: (d.held || 0) + held } : {}),
    log: [...(d.log || []), { t: Date.now(), ...rec, d: pts, ...(held ? { held } : {}) }].slice(-PC_LOG) }));
  return { add: pts, bal: r.next.bal, held: r.next.held };
}
const pcToday = (d) => (d.awayDay === kstDate(Date.now()) ? { n: d.awayN || 0, tot: d.awayTot || 0 } : { n: 0, tot: 0 });
// 재고 없는 상품이 뽑히면 그 값의 교환권(10/12 마왕님) — 이름은 «6,000원 교환권»
// 10/13 실물 상품을 칸으로 묶으면서(«작은 간식» 처럼) 금액이 아니라 상품 이름으로 — «작은 간식 교환권»
const pcVoucherName = (x) => x.name + " 교환권";
// 오늘만 이벤트(10/12) — appConfig/pieces.event {day 한국 날짜, title, cap 한 사람 당첨 한도, items[{id,name,pct,price,stock}]}.
// 그날은 상품표 대신 이것으로 뽑고, 한 사람이 cap 개를 받으면 그날은 구슬을 더 못 연다(남은 구슬은 다음 날)
const pcEvt = (cfg) => { const e = cfg.doc.event; return e && e.day === kstDate(Date.now()) && Array.isArray(e.items) && e.items.length ? e : null; };
const pcEvWon = (d, ev) => (ev && d.evDay === ev.day ? d.evWins || 0 : 0);
// 재고 하나 빼기/돌려놓기 — 조건부. true 됨 · false 재고 없음 · null 그 상품이 없음. 무제한(stock null)은 늘 true
async function pcStockMove(id, delta, inEvent) {
  for (let k = 0; k < 6; k++) {
    const c = await pcCfg(), e = c.doc.event || null;
    const list = inEvent ? (e && e.items) || [] : c.items;
    const x = list.find((y) => y.id === id);
    if (!x) return null;
    if (x.stock == null) return true;
    if (x.stock + delta < 0) return false;
    const its = list.map((y) => (y.id === id ? { ...y, stock: y.stock + delta } : y));
    if (await patchDocIf("appConfig/pieces", inEvent ? { event: { ...e, items: its } } : { items: its }, [inEvent ? "event" : "items"], c.v)) return true;
  }
  throw new Error("상품표가 바빠요 — 잠깐 뒤에 다시");
}
// ── 기프티콘 쿠폰 사진(10/12) — 선생님이 넣은 바코드 사진을 당첨된 학생이 앱에서 본다.
// pieceCoupons/{사진 해시 앞 24자} {item 상품 id, img data URL, at, by, used:{cid,sid,pid,name,at}|null}
// 클라이언트 규칙은 이 컬렉션을 못 읽는다(firestore.rules 맨 끝 «나머지 다 막음») — 서버가 주인 확인 뒤에만 사진을 준다.
// 같은 사진은 해시가 같아 두 번 못 들어간다(10/12 같은 쿠폰 사진 두 장을 받음). 목록은 appConfig/pieceCouponIdx 에 사진 없이
const PC_CIDX = "appConfig/pieceCouponIdx";
const pcCouponPath = (id) => "pieceCoupons/" + id;
async function pcCouponIdxEdit(fn) {
  for (let k = 0; k < 8; k++) {
    const { doc, v } = await getDocV(PC_CIDX);
    const list = fn(((doc || {}).list || []).slice());
    if (await patchDocIf(PC_CIDX, { list }, ["list"], v)) return list;
  }
  throw new Error("쿠폰 목록이 바빠요 — 잠깐 뒤에 다시");
}
async function pcCouponAdd(item, img, by) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(img || ""));
  if (!m) return { error: "사진(png · jpg)이 아니에요" };
  if (m[2].length > 900000) return { error: "사진이 너무 커요(650KB 까지)" };
  const id = createHash("sha256").update(m[2]).digest("hex").slice(0, 24);
  const ok = await patchDocIf(pcCouponPath(id), { item: String(item), img, at: Date.now(), by, used: null }, ["item", "img", "at", "by", "used"], null);
  if (!ok) return { error: "같은 쿠폰 사진이 이미 들어 있어요", dup: true, id };
  await pcCouponIdxEdit((l) => [...l.filter((x) => x.id !== id), { id, item: String(item), at: Date.now(), used: null }]);
  // 사진 한 장 = 재고 하나(10/13) — 산 만큼 사진을 넣으면 재고가 맞는다. 상품표에 있으면 그쪽, 없고 이벤트에 있으면 이벤트 재고
  const st = await pcStockMove(String(item), +1, pcInEvent(await pcCfg(), String(item))).catch(() => null);
  return { ok: true, id, stocked: st === true };
}
const pcInEvent = (cfg, id) => !cfg.items.some((x) => x.id === id) && ((cfg.doc.event || {}).items || []).some((x) => x.id === id);
// 학생 — 내 상품의 쿠폰 사진. 처음 누를 때 그 상품의 남은 쿠폰 하나를 붙인다(쿠폰 문서를 조건부로 잡아 두 사람이 같은 것을 못 받는다)
async function pcCoupon(res, claims, b) {
  const cid = String(b.cid || ""), sid = String(b.sid || ""), pid = String(b.pid || "");
  const who = await hwWho(res, claims, cid, sid); if (!who) return;
  const d = (await getDoc(pcPath(cid, sid)).catch(() => null)) || {};
  const p = (d.prizes || []).find((x) => x.pid === pid);
  if (!p || p.blank || p.voucher) { res.status(400).json({ error: "볼 수 있는 상품이 없어요" }); return; }
  if (p.coupon) {
    const c = await getDoc(pcCouponPath(p.coupon)).catch(() => null);
    if (!c || !c.used || c.used.cid !== cid || c.used.sid !== sid) { res.status(404).json({ error: "쿠폰 사진을 못 찾았어요 — 선생님께 말해 주세요" }); return; }
    res.status(200).json({ ok: true, img: c.img, name: p.name }); return;
  }
  if (p.given) { res.status(400).json({ error: "선생님이 이미 직접 준 상품이에요" }); return; }
  const idx = ((await getDoc(PC_CIDX).catch(() => null)) || {}).list || [];
  for (const x of idx.filter((y) => y.item === p.id && !y.used)) {
    const { doc, v } = await getDocV(pcCouponPath(x.id));
    if (!doc || doc.used) continue;
    const used = { cid, sid, pid, name: who.name, at: Date.now() };
    if (!(await patchDocIf(pcCouponPath(x.id), { used }, ["used"], v))) continue;   // 남이 먼저 잡음 — 다음 것
    let other = "";
    try {
      await pcEdit(cid, sid, (L) => {
        const q = (L.prizes || []).find((y) => y.pid === pid);
        if (!q || q.coupon) { other = q ? q.coupon : "gone"; return null; }   // 두 번 눌러 이미 붙었다
        return { prizes: L.prizes.map((y) => (y.pid === pid ? { ...y, coupon: x.id, given: true, givenAt: Date.now(), givenBy: "app" } : y)) };
      });
    } catch (e) { other = "busy"; }
    if (other) {   // 잡은 쿠폰을 놓는다
      await patchDoc(pcCouponPath(x.id), { used: null });
      if (other !== "gone" && other !== "busy") { const c = await getDoc(pcCouponPath(other)).catch(() => null); if (c) { res.status(200).json({ ok: true, img: c.img, name: p.name }); return; } }
      res.status(409).json({ error: "잠깐 뒤에 다시 눌러 주세요" }); return;
    }
    await pcCouponIdxEdit((l) => l.map((y) => (y.id === x.id ? { ...y, used } : y))).catch(() => null);
    res.status(200).json({ ok: true, img: doc.img, name: p.name, first: true }); return;
  }
  res.status(404).json({ error: "아직 쿠폰 사진이 안 들어왔어요 — 선생님께 말해 주세요", none: true });
}
// 교환권을 지금 바꿀 수 있나(재고가 채워졌나)
const pcSwapOk = (cfg, p) => {
  const list = p.ev ? ((cfg.doc.event || {}).items || []) : cfg.items, x = list.find((y) => y.id === p.id);
  return !!x && (x.stock == null || x.stock > 0);
};
const pcRules = () => ({ cost: PC.cost, streak: PC.streak, awayMin: PC.awayMin, awayEvery: PC.awayEvery, awayPen: PC.awayPen });
async function pcMe(res, claims, b) {
  const cid = String(b.cid || ""), sid = String(b.sid || "");
  const who = await hwWho(res, claims, cid, sid); if (!who) return;
  const cfg = await pcCfg();
  if (!cfg.cids.includes(cid)) { res.status(200).json({ ok: true, on: false }); return; }
  const d = (await getDoc(pcPath(cid, sid)).catch(() => null)) || {};
  const td = pcToday(d), ev = pcEvt(cfg);
  res.status(200).json({ ok: true, on: true, teacher: !!who.teacher, bal: d.bal || 0, earned: d.earned || 0, opened: d.opened || 0,
    awayN: td.n, awayTot: td.tot, rules: pcRules(), lect: await hwLectGet(cid), held: d.held || 0, books: cfg.books,
    prizes: (d.prizes || []).slice(-60).map((p) => (p.voucher && !p.given ? { ...p, canSwap: pcSwapOk(cfg, p) } : p)),
    hasItems: cfg.items.length > 0 || !!ev,   // 확률표는 학생에게 안 보인다(10/12)
    event: ev ? { title: ev.title || "", cap: ev.cap || 1, won: pcEvWon(d, ev), names: ev.items.map((x) => x.name),
                  sure: ev.items.reduce((s, x) => s + (Number(x.pct) || 0), 0) >= 99.99 } : null });
}
// 이탈 — 앱이 돌아온 순간 바로 보낸다(제출 때 몰아 보내면 «그만두기» 로 기록이 사라진다). aid 로 두 번 받지 않는다
async function hwAway(res, claims, b) {
  const cid = String(b.cid || ""), sid = String(b.sid || "");
  const who = await hwWho(res, claims, cid, sid); if (!who) return;
  const s = Math.max(0, Math.min(86400, Math.round(Number(b.s) || 0)));
  if (s <= PC.awayMin) { res.status(200).json({ ok: true, skipped: true }); return; }
  if (who.teacher) { res.status(200).json({ ok: true, teacher: true }); return; }
  const cfg = await pcCfg();
  if (!cfg.cids.includes(cid)) { res.status(200).json({ ok: true, on: false }); return; }
  if (!cfg.books.includes(String(b.book || ""))) { res.status(200).json({ ok: true, on: false, book: false }); return; }   // 조각 안 주는 교재
  const aid = String(b.aid || "").slice(0, 40), now = Date.now(), today = kstDate(now);
  let dup = false, lost = 0, hit = false;
  const r = await pcEdit(cid, sid, (d) => {
    if (aid && (d.aways || []).some((x) => x.aid === aid)) { dup = true; return null; }
    const td = pcToday(d);
    let n = td.n + 1;
    hit = n >= PC.awayEvery; lost = 0;
    if (hit) { lost = Math.min(d.bal || 0, PC.awayPen); n = 0; }
    const rec = { aid, t: now, s, day: today, k: td.tot + 1, ...(Number(b.q) ? { q: Number(b.q) } : {}), ...(b.book ? { book: String(b.book).slice(0, 40) } : {}),
                  ...(hit ? { pen: lost } : {}) };
    return { name: who.name, awayDay: today, awayN: n, awayTot: td.tot + 1, bal: (d.bal || 0) - lost,
             aways: [...(d.aways || []), rec].slice(-PC_AWAY),
             ...(hit ? { log: [...(d.log || []), { t: now, k: "away", d: -lost }].slice(-PC_LOG) } : {}) };
  });
  const d = r.next || r.before, td = pcToday(d);
  res.status(200).json({ ok: true, dup, hit: dup ? false : hit, lost: dup ? 0 : lost, n: td.n, tot: td.tot, bal: d.bal || 0, rules: pcRules() });
}
// 구슬 열기 — 조각 20개. 뽑기는 확률표 그대로(꽝 = 100 − 합). 오늘 이벤트가 있으면 그 표로, 한 사람 cap 개까지.
// 재고를 먼저 하나 잡고(조건부) 장부를 쓴다 — 장부가 겹쳐 못 쓰면 잡은 재고를 돌려놓고 다시.
// 재고 없는 게 뽑히면 구슬은 쓰고 그 값의 교환권(재고가 채워지면 학생이 앱에서 바꾼다 — pcSwap)
async function pcOpen(res, claims, b) {
  const cid = String(b.cid || ""), sid = String(b.sid || "");
  const who = await hwWho(res, claims, cid, sid); if (!who) return;
  for (let i = 0; i < 6; i++) {
    const cfg = await pcCfg();
    if (!cfg.cids.includes(cid)) { res.status(400).json({ error: "이 반은 조각을 안 써요" }); return; }
    const ev = pcEvt(cfg), pool = ev ? ev.items : cfg.items;
    const { doc, v } = await getDocV(pcPath(cid, sid));
    const d = doc || {};
    if ((d.bal || 0) < PC.cost) { res.status(400).json({ error: "조각이 " + PC.cost + "개 있어야 구슬을 열 수 있어요" }); return; }
    if (!pool.length) { res.status(400).json({ error: "아직 구슬에 든 상품이 없어요. 선생님께 말해 주세요" }); return; }
    const won = pcEvWon(d, ev), cap = ev ? ev.cap || 1 : 0;
    if (ev && won >= cap) { res.status(400).json({ error: "오늘은 한 사람에 " + cap + "개까지예요 — 남은 구슬은 내일 열 수 있어요", capped: true }); return; }
    let r = Math.random() * 100, pick = null;
    for (const x of pool) { r -= Number(x.pct) || 0; if (r < 0) { pick = x; break; } }
    let held = false, voucher = false;
    if (pick && pick.stock != null) {
      const got = pick.stock > 0 ? await pcStockMove(pick.id, -1, !!ev) : false;
      if (got === null) continue;                 // 그새 상품표가 바뀜 — 다시 뽑는다
      if (got) held = true; else voucher = true;
    }
    const now = Date.now();
    const pid = now.toString(36) + Math.random().toString(36).slice(2, 6), tag = ev ? { ev: ev.day } : {};
    const prize = voucher ? { pid, id: pick.id, name: pcVoucherName(pick), of: pick.name, price: Number(pick.price) || 0, voucher: true, at: now, given: false, ...tag }
                : pick ? { pid, id: pick.id, name: pick.name, at: now, given: false, ...tag }
                       : { pid, id: "blank", name: "꽝", at: now, blank: true };
    const next = { name: who.name, bal: d.bal - PC.cost, opened: (d.opened || 0) + 1, ...(pick ? { prizes: [...(d.prizes || []), prize].slice(-200) } : {}),
                   ...(ev && pick ? { evDay: ev.day, evWins: won + 1 } : {}),
                   log: [...(d.log || []), { t: now, k: "open", d: -PC.cost, prize: prize.name }].slice(-PC_LOG) };
    if (await patchDocIf(pcPath(cid, sid), next, Object.keys(next), v)) {
      res.status(200).json({ ok: true, prize, bal: next.bal, ...(ev ? { event: { cap, won: won + (pick ? 1 : 0) } } : {}) }); return;
    }
    if (held) await pcStockMove(pick.id, +1, !!ev).catch(() => null);   // 장부를 못 썼다 — 잡은 재고를 돌려놓는다
  }
  res.status(409).json({ error: "잠깐 뒤에 다시 눌러 주세요" });
}
// 교환권 → 상품. 재고가 채워졌을 때 학생이 앱에서 누른다. 재고를 먼저 잡고 장부를 바꾼다(겹치면 재고를 돌려놓음)
async function pcSwap(res, claims, b) {
  const cid = String(b.cid || ""), sid = String(b.sid || ""), pid = String(b.pid || "");
  const who = await hwWho(res, claims, cid, sid); if (!who) return;
  const cfg = await pcCfg();
  if (!cfg.cids.includes(cid)) { res.status(400).json({ error: "이 반은 조각을 안 써요" }); return; }
  const d = (await getDoc(pcPath(cid, sid)).catch(() => null)) || {};
  const p = (d.prizes || []).find((x) => x.pid === pid);
  if (!p || !p.voucher || p.given) { res.status(400).json({ error: "바꿀 교환권이 없어요" }); return; }
  const got = await pcStockMove(p.id, -1, !!p.ev);
  if (got === null) { res.status(400).json({ error: "그 상품이 상품표에서 빠졌어요 — 선생님께 말해 주세요" }); return; }
  if (!got) { res.status(400).json({ error: "아직 재고가 없어요 — 채워지면 바꿀 수 있어요" }); return; }
  let bad = "", prize = null;
  try {
    await pcEdit(cid, sid, (x) => {
      const ps = x.prizes || [], q = ps.find((y) => y.pid === pid);
      if (!q || !q.voucher || q.given) { bad = "바꿀 교환권이 없어요"; return null; }
      prize = { ...q, name: q.of || q.name, voucher: false, swappedAt: Date.now() };
      return { prizes: ps.map((y) => (y.pid === pid ? prize : y)), log: [...(x.log || []), { t: Date.now(), k: "swap", d: 0, prize: prize.name }].slice(-PC_LOG) };
    });
  } catch (e) { bad = e.message; }
  if (bad) { await pcStockMove(p.id, +1, !!p.ev).catch(() => null); res.status(400).json({ error: bad }); return; }
  res.status(200).json({ ok: true, prize });
}
// ───────────── 학원 교재 고르기 (10/24) — 선생님 앱 «반 설정 → 학원 교재 고르기» ─────────────
// 창고(shelf/{key}) 한 권은 examKeys/«과제-{key}» 문서 하나 — 여러 반이 같이 쓴다(반마다 복사하면 목록이 1MB 를 넘는다).
//   cids  — 건 반들
//   allc  — 그중 «반 전체»로 건 반(학생 지정이 없는 반). sids 가 있어도 이 반 학생은 다 낸다
//   sids  — «반ID/자리ID» — 학생만 골라 건 반의 학생들
//   link  — 반 교재(번호표) 이름 = 창고 짧은 이름(«코어 공수1-1»). 반 교재에 같은 이름이 없으면 따로 카드로 뜬다
// 마지막 반이 빠지면 test(선생님만 보임)로 숨긴다 — cids 가 비면 «모든 반» 이 되기 때문. 기록(hwLogs)은 그대로 남는다
const SHELF_PRE = "과제-";
const shelfName = (key) => String(key).replace("-", " ");   // 첫 «-» 만 — «코어-공수1-1» → «코어 공수1-1»
async function shelfAct(res, claims, b) {
  const cid = String(b.cid || "");
  if (!(await pcTeacher(res, claims, cid))) return;
  if (b.action === "shelfList") {
    const idx = await getDoc("shelf/_index").catch(() => null);
    res.status(200).json({ ok: true, books: (idx && idx.books) || [] }); return;
  }
  if (!cid) { res.status(400).json({ error: "반이 필요해요" }); return; }
  const key = String(b.key || "");
  if (!/^[0-9A-Za-z가-힣_.\-]{2,40}$/.test(key)) { res.status(400).json({ error: "교재가 이상해요" }); return; }
  const id = SHELF_PRE + key, path = "examKeys/" + id;
  const cls = await getDoc("classes/" + cid).catch(() => null);
  if (!cls) { res.status(404).json({ error: "반이 없어요" }); return; }
  let book = null;
  if (b.action === "shelfHang") {
    book = await getDoc("shelf/" + key).catch(() => null);
    if (!book) { res.status(404).json({ error: "창고에 없는 교재예요" }); return; }
  }
  const ids = new Set((cls.roster || []).filter((r) => r && r.id && !r.teacher).map((r) => r.id));
  const pick = b.action === "shelfHang" && Array.isArray(b.sids) ? [...new Set(b.sids.map(String))] : [];
  if (pick.some((x) => !ids.has(x))) { res.status(400).json({ error: "이 반 명단에 없는 학생이 있어요" }); return; }
  // 같은 교재를 두 선생님이 동시에 걸면 cids 가 엇갈린다 — 읽은 판이 그대로일 때만 쓴다(아니면 다시)
  for (let tries = 0; tries < 5; tries++) {
    const { doc: cur, v } = await getDocV(path);
    if (cur && (cur.kind !== "hw" || cur.shelf !== key)) { res.status(409).json({ error: "같은 이름의 다른 교재가 있어요 — 관리자에게" }); return; }
    const others = (cur ? cur.sids || [] : []).filter((x) => !String(x).startsWith(cid + "/"));
    let cids = (cur ? cur.cids || [] : []).filter((x) => x !== cid);
    let allc = (cur ? cur.allc || [] : []).filter((x) => x !== cid);
    let sids = others;
    if (b.action === "shelfHang") {
      cids = cids.concat(cid);
      if (pick.length) sids = others.concat(pick.map((x) => cid + "/" + x));
      else allc = allc.concat(cid);
    } else if (!cur) { res.status(200).json({ ok: true }); return; }
    // 반 전체로 건 반만 남았으면 sids 는 비워도 된다 — 그래도 남겨 두면 «정해진 학생만» 이 다른 반에 새지 않게 allc 가 막는다
    const src = book || cur;
    const data = {
      title: String(src.title || key), kind: "hw", shelf: key, units: src.units || [], link: shelfName(key),
      questions: src.questions || [], cids, allc, sids, names: [],
      test: !cids.length, lock: false, free: false, order: cur ? cur.order || 0 : 0, updated: Date.now(),
    };
    if (await patchDocIf(path, data, null, v)) {
      // 번호표에도 — 반 교재(이름 · 문항 수)로 넣는다. 개별진도반은 학생마다 교재라 안 넣는다(따로 카드로 뜬다)
      let books = null;
      if (b.action === "shelfHang" && b.board && cls.type !== "individual") {
        const nm = shelfName(key), cb = cls.books || [];
        if (!cb.some((x) => (x && x.name) === nm)) {
          books = cb.concat({ name: nm, total: (src.questions || []).length });
          await patchDoc("classes/" + cid, { books });
        }
      }
      await rebuildList();
      res.status(200).json({ ok: true, id, cids, open: !data.test, ...(books ? { books } : {}) }); return;
    }
  }
  res.status(409).json({ error: "다른 선생님이 같은 교재를 막 바꿨어요 — 다시 눌러 주세요" });
}

// 선생님 — 담당 반인지(관리자는 다)
async function pcTeacher(res, claims, cid) {
  if (!(claims.role === "teacher" || claims.role === "owner")) { res.status(403).json({ error: "선생님만 할 수 있어요" }); return false; }
  if (cid && claims.role !== "owner") {
    const tt = claims.tid ? await getDoc("teachers/" + claims.tid).catch(() => null) : null;
    if (!tt || !(tt.classIds || []).includes(cid)) { res.status(403).json({ error: "담당 반이 아니에요" }); return false; }
  }
  return true;
}
async function pcTeacherAct(res, claims, b) {
  const cid = String(b.cid || "");
  if (b.action === "hwLectGet") {
    if (!(await pcTeacher(res, claims, cid))) return;
    res.status(200).json({ ok: true, lect: await hwLectGet(cid) }); return;
  }
  if (b.action === "hwLectSet") {   // {cid, bookId, nums:[], on} 번호 켜기/끄기 · {cid, odd:true|false} 홀수 기본 보류. 조건부로 겹침 막음
    if (!(await pcTeacher(res, claims, cid))) return;
    if (!cid) { res.status(400).json({ error: "반이 필요해요" }); return; }
    const bookId = String(b.bookId || ""), on = b.on !== false, setOdd = typeof b.odd === "boolean";
    const nums = [...new Set((Array.isArray(b.nums) ? b.nums : []).map(Number).filter((n) => Number.isFinite(n)))];
    if (!setOdd && (!bookId || !nums.length)) { res.status(400).json({ error: "교재 · 번호가 필요해요" }); return; }
    for (let k = 0; k < 6; k++) {
      const { doc, v } = await getDocV(hwLectPath(cid));
      const L = hwLectNorm(doc), B = { ...L.b }, R = { ...L.rel };
      const freed = [];
      if (setOdd) L.odd = b.odd;
      else {
        const cur = new Set((B[bookId] || []).map(Number)), rel = new Set((R[bookId] || []).map(Number));
        nums.forEach((n) => {
          const was = hwLectHas(L, bookId, n), oddDef = L.odd && n % 2 === 1;
          if (on) { rel.delete(n); if (!oddDef) cur.add(n); }
          else { cur.delete(n); if (oddDef) rel.add(n); if (was) freed.push(n); }
        });
        B[bookId] = [...cur].sort((x, y) => x - y); if (!B[bookId].length) delete B[bookId];
        R[bookId] = [...rel].sort((x, y) => x - y); if (!R[bookId].length) delete R[bookId];
      }
      const next = { b: B, odd: L.odd, rel: R, at: Date.now(), by: claims.tid || claims.role };
      if (await patchDocIf(hwLectPath(cid), next, ["b", "odd", "rel", "at", "by"], v)) {
        const paid = freed.length ? await hwLectPay(cid, bookId, freed) : [];
        res.status(200).json({ ok: true, lect: hwLectNorm(next), paid }); return;
      }
    }
    res.status(409).json({ error: "잠깐 뒤에 다시" }); return;
  }
  if (b.action === "pcItemsGet") {
    if (!(await pcTeacher(res, claims, ""))) return;
    const c = await pcCfg();
    res.status(200).json({ ok: true, items: c.items, cids: c.cids, by: c.doc.by, at: c.doc.at, rules: pcRules(), event: c.doc.event || null, today: kstDate(Date.now()) }); return;
  }
  if (b.action === "pcCouponAdd") {
    if (!(await pcTeacher(res, claims, ""))) return;
    const r = await pcCouponAdd(b.item, b.img, claims.tid || claims.role);
    res.status(r.error ? (r.dup ? 409 : 400) : 200).json(r); return;
  }
  if (b.action === "pcCouponDel") {
    if (!(await pcTeacher(res, claims, ""))) return;
    const id = String(b.id || ""), c = await getDoc(pcCouponPath(id)).catch(() => null);
    if (!c) { res.status(404).json({ error: "그 쿠폰이 없어요" }); return; }
    if (c.used) { res.status(400).json({ error: c.used.name + " 학생이 이미 받은 쿠폰이에요" }); return; }
    await deleteDoc(pcCouponPath(id));
    await pcCouponIdxEdit((l) => l.filter((x) => x.id !== id));
    await pcStockMove(c.item, -1, pcInEvent(await pcCfg(), c.item)).catch(() => null);   // 사진을 빼면 재고도 하나 뺀다
    res.status(200).json({ ok: true }); return;
  }
  // 오늘만 이벤트 — 날짜는 서버가 오늘(한국)로 찍는다. off 면 지운다. 재고를 다시 적으면 채운 것(교환권은 학생이 앱에서 바꾼다)
  if (b.action === "pcEventSet") {
    if (!(await pcTeacher(res, claims, ""))) return;
    if (b.off) { await patchDoc("appConfig/pieces", { event: null }); res.status(200).json({ ok: true, event: null }); return; }
    const raw = Array.isArray(b.items) ? b.items : [];
    const items = raw.slice(0, 10).map((x, i) => ({
      id: String(x.id || ("e" + Date.now().toString(36) + i)).slice(0, 40), name: String(x.name || "").trim().slice(0, 40),
      pct: Math.max(0, Math.min(100, Math.round((Number(x.pct) || 0) * 100) / 100)),
      price: Math.max(0, Math.min(1000000, Math.round(Number(x.price) || 0))),
      stock: x.stock == null || x.stock === "" ? null : Math.max(0, Math.floor(Number(x.stock) || 0)),
    })).filter((x) => x.name);
    if (!items.length) { res.status(400).json({ error: "이벤트 상품이 없어요" }); return; }
    const sum = items.reduce((s, x) => s + x.pct, 0);
    if (sum > 100.0001) { res.status(400).json({ error: "확률 합이 100% 를 넘어요" }); return; }
    const event = { day: kstDate(Date.now()), title: String(b.title || "").trim().slice(0, 40), cap: Math.max(1, Math.min(20, Math.floor(Number(b.cap) || 1))),
                    items, by: claims.tid || claims.role, at: Date.now() };
    await patchDoc("appConfig/pieces", { event });
    res.status(200).json({ ok: true, event }); return;
  }
  if (b.action === "pcItemsSet") {
    if (!(await pcTeacher(res, claims, ""))) return;
    const raw = Array.isArray(b.items) ? b.items : null;
    if (!raw || raw.length > 40) { res.status(400).json({ error: "상품 목록이 이상해요" }); return; }
    const items = raw.map((x, i) => ({
      id: String(x.id || ("p" + Date.now().toString(36) + i)).slice(0, 40), name: String(x.name || "").trim().slice(0, 40),
      pct: Math.max(0, Math.min(100, Math.round((Number(x.pct) || 0) * 100) / 100)),
      price: Math.max(0, Math.min(1000000, Math.round(Number(x.price) || 0))),
      stock: x.stock == null || x.stock === "" ? null : Math.max(0, Math.floor(Number(x.stock) || 0)),
    })).filter((x) => x.name);
    const sum = items.reduce((s, x) => s + x.pct, 0);
    if (sum > 100.0001) { res.status(400).json({ error: "확률 합이 100% 를 넘어요 (" + Math.round(sum * 100) / 100 + "%)" }); return; }
    await patchDoc("appConfig/pieces", { items, by: claims.tid || claims.role, at: Date.now() });
    res.status(200).json({ ok: true, items }); return;
  }
  if (!(await pcTeacher(res, claims, cid))) return;
  if (!cid) { res.status(400).json({ error: "반이 없어요" }); return; }
  if (b.action === "pcBoard") {
    const cfg = await pcCfg();
    const rows = await listDocs("classes/" + cid + "/pieces").catch(() => []);
    const coupons = (((await getDoc(PC_CIDX).catch(() => null)) || {}).list || []).map((x) => ({ id: x.id, item: x.item, at: x.at, used: x.used ? { name: x.used.name, at: x.used.at } : null }));
    res.status(200).json({ ok: true, on: cfg.cids.includes(cid), rules: pcRules(), event: cfg.doc.event || null, items: cfg.items, today: kstDate(Date.now()), coupons, rows: rows.map((d) => {
      const td = pcToday(d);
      return { sid: d.id, name: d.name, bal: d.bal || 0, earned: d.earned || 0, opened: d.opened || 0, awayN: td.n, awayTot: td.tot,
               aways: (d.aways || []).slice(-80), prizes: (d.prizes || []).slice(-60), log: (d.log || []).slice(-30) };
    }) }); return;
  }
  const sid = String(b.sid || "");
  if (!sid) { res.status(400).json({ error: "학생이 없어요" }); return; }
  let bad = "";
  const r = await pcEdit(cid, sid, (d) => {
    if (b.action === "pcGive") {
      const pid = String(b.pid || ""), ps = d.prizes || [];
      if (!ps.some((p) => p.pid === pid)) { bad = "그 상품이 없어요"; return null; }
      return { prizes: ps.map((p) => (p.pid === pid ? { ...p, given: !b.undo, givenAt: b.undo ? null : Date.now(), givenBy: claims.tid || claims.role } : p)) };
    }
    if (b.action === "pcAdjust") {
      const delta = Math.round(Number(b.delta) || 0);
      if (!delta || Math.abs(delta) > 1000) { bad = "바꿀 조각 수가 이상해요"; return null; }
      const bal = Math.max(0, (d.bal || 0) + delta);
      return { name: d.name || String(b.name || ""), bal, log: [...(d.log || []), { t: Date.now(), k: "adj", d: bal - (d.bal || 0), why: String(b.why || "").slice(0, 60), by: claims.tid || claims.role }].slice(-PC_LOG) };
    }
    bad = "그런 동작이 없어요"; return null;
  });
  if (bad) { res.status(400).json({ error: bad }); return; }
  res.status(200).json({ ok: true, ...r.next });
}

async function hwSubmit(res, claims, b) {
  const cid = String(b.cid || ""), sid = String(b.sid || ""), bookId = String(b.bookId || ""), rid = String(b.rid || "");
  if (!cid || !sid || !bookId) { res.status(400).json({ error: "빠진 값이 있어요" }); return; }
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(rid)) { res.status(400).json({ error: "기록 번호가 이상해요" }); return; }
  const who = await hwWho(res, claims, cid, sid); if (!who) return;
  const key = await getDoc("examKeys/" + bookId).catch(() => null);
  if (!key || key.kind !== "hw") { res.status(404).json({ error: "그 교재가 없어요" }); return; }
  if ((key.cids || []).length && !key.cids.includes(cid) && !who.teacher) { res.status(403).json({ error: "이 반 교재가 아니에요" }); return; }
  // 창고 교재는 반을 다 빼면 cids 가 빈다 — 빈 cids 를 «모든 반» 으로 읽지 않는다
  if (key.shelf && !(key.cids || []).includes(cid)) { res.status(403).json({ error: "이 반에서 뺀 교재예요" }); return; }
  if ((key.sids || []).length && !who.teacher && !(key.allc || []).includes(cid) && !key.sids.includes(cid + "/" + sid) && !key.sids.includes(sid)) { res.status(403).json({ error: "이 교재는 정해진 학생만 낼 수 있어요" }); return; }
  const byN = {}; (key.questions || []).forEach((q) => { byN[q.n] = q; });
  const nums = [...new Set((Array.isArray(b.nums) ? b.nums : []).map(Number))].filter((n) => byN[n]).sort((x, y) => x - y);
  if (!nums.length) { res.status(400).json({ error: "푼 번호가 없어요" }); return; }
  if (nums.length > HW_MAX_Q) { res.status(400).json({ error: "한 번에 " + HW_MAX_Q + "문항까지만 낼 수 있어요" }); return; }
  const answers = b.answers && typeof b.answers === "object" ? b.answers : {};
  const ev = hwEv(b.ev);
  const endT = Math.max(0, Math.min(HW_MAX_SEC, Number(b.endT) || 0));
  const startedAt = Number(b.startedAt) || Date.now();
  const sec = hwSecs(ev, endT);
  const LT = await hwLectGet(cid);
  const questions = nums.map((n) => {
    const q = byN[n], mine = hwNorm(q, answers[n]);
    return { n, type: q.type, ...(q.label ? { label: q.label } : {}), ...(q.u != null ? { u: q.u } : {}),
             answer: mine, auto: mine == null ? false : key.free ? true : autoCorrect(q, mine), sec: r1(sec[n] || 0), ...(hwLectHas(LT, bookId, n) ? { lect: true } : {}) };
  });
  const date = kstDate(startedAt), now = Date.now();
  const log = {
    rid, cid, sid, name: who.name, bookId, title: key.title, date, startedAt, endT: r1(endT),
    pausedSec: Math.max(0, Math.round(Number(b.pausedSec) || 0)),
    nums, questions, ev,
    n: questions.length, correct: questions.filter((q) => q.auto === true).length,
    blank: questions.filter((q) => q.answer == null).length, pending: questions.filter((q) => q.auto === null).length,
    teacher: who.teacher, time: now,
  };
  const base = "classes/" + cid + "/days/" + date;
  await patchDoc(base, { updated: now });   // 날짜 문서가 없으면 날짜 목록에 안 잡힌다 (submit 과 같은 까닭)
  // ⚠ 기록 쓰기 — 10/10 e114ae0 에서 이 줄이 빠져 채점만 되고 아무것도 안 남았다(다시 들어가면 처음부터). 지우지 말 것
  await patchDoc(base + "/hwLogs/" + rid, log);
  // 번호표에 칠하기 — 실패해도 제출은 된 것이다(기록은 이미 남았다)
  let marked = null;
  if (!who.teacher) {
    marked = await hwMarkDone({ ...who.cls, id: cid }, sid, who.name, key.link, questions.filter((q) => q.answer != null).map((q) => q.n)).catch(() => null);
    if (marked) await patchDoc(base + "/hwLogs/" + rid, { marked });
  }
  // 조각 — 대상 반 · 학생만. 실패해도 제출은 된 것이다
  let pieces = null;
  if (!who.teacher) {
    const cfg = await pcCfg().catch(() => null);
    if (pcBookOn(cfg, cid, bookId)) {
      const p = hwPieces(questions), held = questions.filter((q) => q.lect && q.auto === true).length;   // 보류 — 나중에 풀면 들어올 것
      const pc = p.pts > 0 || held > 0 ? await pcAdd(cid, sid, who.name, p.pts, { k: "hw", rid }, held).catch((e) => { console.error("[pieces]", e); return null; }) : { add: 0 };
      if (pc) { pieces = { ...p, add: pc.add, held, ...(pc.bal != null ? { bal: pc.bal } : {}) }; await patchDoc(base + "/hwLogs/" + rid, { pieces: { first: p.first, streaks: p.streaks, pts: pc.add, ...(held ? { held } : {}) } }).catch(() => {}); }
    }
  }
  res.status(200).json({ ok: true, log: { ...log, ...(marked ? { marked } : {}), ...(pieces ? { pieces: { first: pieces.first, streaks: pieces.streaks, pts: pieces.add, ...(pieces.held ? { held: pieces.held } : {}) } } : {}) }, ...(pieces && pieces.bal != null ? { bal: pieces.bal } : {}) });
}

// 틀린 문항만 다시 푼 것. 첫 시도(auto · answer)는 손대지 않는다
async function hwRetry(res, claims, b) {
  const cid = String(b.cid || ""), date = String(b.date || ""), rid = String(b.rid || "");
  if (!cid || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[A-Za-z0-9_-]{6,40}$/.test(rid)) { res.status(400).json({ error: "빠진 값이 있어요" }); return; }
  const path = "classes/" + cid + "/days/" + date + "/hwLogs/" + rid;
  const log = await getDoc(path).catch(() => null);
  if (!log) { res.status(404).json({ error: "그 기록이 없어요" }); return; }
  const who = await hwWho(res, claims, cid, log.sid); if (!who) return;
  const key = await getDoc("examKeys/" + log.bookId).catch(() => null);
  if (!key) { res.status(404).json({ error: "교재가 없어요" }); return; }
  const byN = {}; (key.questions || []).forEach((q) => { byN[q.n] = q; });
  const answers = b.answers && typeof b.answers === "object" ? b.answers : {};
  const secs = b.secs && typeof b.secs === "object" ? b.secs : {};
  const now = Date.now();
  let changed = 0;
  const questions = (log.questions || []).map((row) => {
    if (!(row.n in answers) || row.auto !== false || row.fin === true) return row;
    const q = byN[row.n]; if (!q) return row;
    const mine = hwNorm(q, answers[row.n]);
    if (mine == null) return row;
    const ok = autoCorrect(q, mine);
    changed++;
    return { ...row, tries: [...(row.tries || []), { a: mine, ok, sec: r1(Math.max(0, Math.min(HW_MAX_SEC, Number(secs[row.n]) || 0))), at: now }].slice(-10), fin: ok };
  });
  if (!changed) { res.status(400).json({ error: "다시 낸 답이 없어요" }); return; }
  const patch = { questions, retried: now, fixed: questions.filter((q) => q.auto === false && q.fin === true).length };
  await patchDoc(path, patch);
  const fixPc = (rows) => rows.filter((q) => q.auto === false && q.fin === true && !q.lect).length;   // 수업 풀이는 다시 맞혀도 조각 없음
  const newly = fixPc(questions) - fixPc(log.questions || []);
  const fixHeld = (rows) => rows.filter((q) => q.auto === false && q.fin === true && q.lect).length;
  const heldN = fixHeld(questions) - fixHeld(log.questions || []);
  let pc = null;
  if (!who.teacher && (newly > 0 || heldN > 0)) {
    const cfg = await pcCfg().catch(() => null);
    if (pcBookOn(cfg, cid, log.bookId)) pc = await pcAdd(cid, log.sid, who.name, Math.max(0, newly), { k: "retry", rid }, Math.max(0, heldN)).catch(() => null);
  }
  res.status(200).json({ ok: true, log: { ...log, ...patch }, ...(pc ? { pieces: pc.add, bal: pc.bal } : {}) });
}

// 앱 번호판으로 못 적는 답(√ · 순서쌍 · 부등식 · 증명)은 교재에서 type:"essay" 로 둔다. 학생이 «다 풀었음» 을 누르고,
// 낸 뒤 책의 빠른정답을 보고 스스로 O/X 한다 — 그게 그 문항의 첫 시도다(self:true). 한 번 정하면 못 바꾼다
async function hwSelf(res, claims, b) {
  const cid = String(b.cid || ""), date = String(b.date || ""), rid = String(b.rid || "");
  if (!cid || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[A-Za-z0-9_-]{6,40}$/.test(rid)) { res.status(400).json({ error: "빠진 값이 있어요" }); return; }
  const path = "classes/" + cid + "/days/" + date + "/hwLogs/" + rid;
  const log = await getDoc(path).catch(() => null);
  if (!log) { res.status(404).json({ error: "그 기록이 없어요" }); return; }
  const who = await hwWho(res, claims, cid, log.sid); if (!who) return;
  const marks = b.marks && typeof b.marks === "object" ? b.marks : {};
  let changed = 0;
  const questions = (log.questions || []).map((row) => {
    if (!(String(row.n) in marks) || row.auto !== null || row.answer == null) return row;
    changed++;
    return { ...row, auto: marks[row.n] === true, self: true };
  });
  if (!changed) { res.status(400).json({ error: "정할 문항이 없어요" }); return; }
  const patch = { questions, correct: questions.filter((q) => q.auto === true).length, pending: questions.filter((q) => q.auto === null).length };
  await patchDoc(path, patch);
  // 스스로 채점에서 O = 처음 맞힘 → 조각 1 (5연속은 낼 때 건너뛴 것이라 안 센다)
  const okPc = (rows) => rows.filter((q) => q.auto === true && !q.lect).length;
  const gain = okPc(questions) - okPc(log.questions || []);
  const okHeld = (rows) => rows.filter((q) => q.auto === true && q.lect).length;
  const heldN = okHeld(questions) - okHeld(log.questions || []);
  let pc = null;
  if (!who.teacher && (gain > 0 || heldN > 0)) {
    const cfg = await pcCfg().catch(() => null);
    if (pcBookOn(cfg, cid, log.bookId)) pc = await pcAdd(cid, log.sid, who.name, Math.max(0, gain), { k: "self", rid }, Math.max(0, heldN)).catch(() => null);
  }
  res.status(200).json({ ok: true, log: { ...log, ...patch }, ...(pc ? { pieces: pc.add, bal: pc.bal } : {}) });
}

// ───────────── 실전 시험 — 끝난 뒤 틀린 문제 다시 풀기 (10/26 마왕님 «실전 시험 오답하는 기능 넣고 거기서도 데이터를 쌓자») ─────────────
// 점수는 **처음 낸 답 그대로** — 다시 푼 것은 score · scores 칸 · 조각 어디에도 안 들어간다. 문항 줄에 tries[] · fin 만 붙는다(과제 hwRetry 와 같은 꼴).
// 한 번에 한 문항. 꼬리문제 · 서술형은 자동 채점이 안 돼서 뺀다. seen = 정답 · 해설을 보고 푼 것(이유를 안 묻는다)
async function examRetry(res, claims, b) {
  const cid = String(b.cid || ""), date = String(b.date || ""), rid = String(b.rid || ""), n = Number(b.n);
  if (!cid || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[A-Za-z0-9_-]{6,40}$/.test(rid) || !Number.isInteger(n)) { res.status(400).json({ error: "빠진 값이 있어요" }); return; }
  const path = "classes/" + cid + "/days/" + date + "/examLogs/" + rid;
  const log = await getDoc(path).catch(() => null);
  if (!log) { res.status(404).json({ error: "그 기록이 없어요" }); return; }
  if (log.voided) { res.status(400).json({ error: "취소된 제출이에요" }); return; }
  const who = await hwWho(res, claims, cid, log.sid); if (!who) return;
  const key = await getDoc("examKeys/" + log.examId).catch(() => null);
  const kq = key && (key.questions || []).find((q) => q.n === n);
  const i = (log.questions || []).findIndex((q) => q.n === n);
  if (!kq || i < 0) { res.status(404).json({ error: n + "번 정답을 찾지 못했어요" }); return; }
  if (hasParts(kq) || kq.type === "essay") { res.status(400).json({ error: "이 문제는 앱에서 다시 채점할 수 없어요" }); return; }
  const row = log.questions[i], ov = log.override || {};
  if ((String(n) in ov ? ov[n] : row.auto) !== false) { res.status(400).json({ error: "틀린 문제만 다시 풀어요" }); return; }
  if (row.fin === true) { res.status(400).json({ error: "이미 다시 풀어 맞혔어요" }); return; }
  const mine = normAns(kq, b.answer);
  if (mine == null) { res.status(400).json({ error: "답을 적어요" }); return; }
  const ok = gradeQ(kq, mine).auto === true, now = Date.now();
  const t = { a: mine, ok, sec: r1(Math.max(0, Math.min(3600, Number(b.sec) || 0))), at: now, ...(b.seen ? { seen: true } : {}) };
  const questions = log.questions.map((q, k) => (k === i ? { ...q, tries: [...(q.tries || []), t].slice(-10), fin: ok } : q));
  await patchDoc(path, { questions, retried: now });
  res.status(200).json({ ok: true, right: ok, log: { ...log, questions, retried: now } });
}

// ───────────── 서술형 정답 글 — 이미 낸 기록 (10/26) ─────────────
// sol 칸이 생기기 전에 낸 기록은 기록에 정답 글이 없다. 그 기록을 낸 학생(또는 선생님)에게만 시험지의 서술형 정답 글을 준다
async function essaySol(res, claims, b) {
  const cid = String(b.cid || ""), date = String(b.date || ""), rid = String(b.rid || "");
  if (!cid || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[A-Za-z0-9_-]{6,40}$/.test(rid)) { res.status(400).json({ error: "빠진 값이 있어요" }); return; }
  const log = await getDoc("classes/" + cid + "/days/" + date + "/examLogs/" + rid).catch(() => null);
  if (!log) { res.status(404).json({ error: "그 기록이 없어요" }); return; }
  const who = await hwWho(res, claims, cid, log.sid); if (!who) return;
  const key = await getDoc("examKeys/" + log.examId).catch(() => null);
  const sols = {};
  for (const q of (key && key.questions) || []) if (q.type === "essay" && q.sol) sols[q.n] = q.sol;
  res.status(200).json({ ok: true, sols });
}

// ───────────── «처음엔 왜 틀렸어?» — 다시 풀어 맞힌 문항에만 (10/26) ─────────────
// 다시 맞힘 = «알았다» 는 증거 → 그때만 실수 종류를 묻는다. 못 고친 것은 몰라서 틀린 것이라 안 묻는다.
// 과제(hw)는 why 만 · 실전(exam)은 why + rushed(시간에 쫓겼어 — 시험 상황에서만 뜻이 있다). why 는 null 이면 지움
const WHY = ["calc", "copy", "cond", "ask", "case", "method"];   // 화면 WHY_LIST 와 같게
async function whyMark(res, claims, b) {
  const kind = b.kind === "exam" ? "exam" : "hw";
  const cid = String(b.cid || ""), date = String(b.date || ""), rid = String(b.rid || ""), n = Number(b.n);
  if (!cid || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[A-Za-z0-9_-]{6,40}$/.test(rid) || !Number.isInteger(n)) { res.status(400).json({ error: "빠진 값이 있어요" }); return; }
  if (b.why != null && !WHY.includes(b.why)) { res.status(400).json({ error: "모르는 이유예요" }); return; }
  const path = "classes/" + cid + "/days/" + date + "/" + (kind === "exam" ? "examLogs/" : "hwLogs/") + rid;
  const log = await getDoc(path).catch(() => null);
  if (!log) { res.status(404).json({ error: "그 기록이 없어요" }); return; }
  const who = await hwWho(res, claims, cid, log.sid); if (!who) return;
  const i = (log.questions || []).findIndex((q) => q.n === n);
  const row = i >= 0 ? log.questions[i] : null, ov = log.override || {};
  const firstX = row && (kind === "exam" ? (String(n) in ov ? ov[n] : row.auto) === false : row.auto === false);
  const last = row && (row.tries || []).slice(-1)[0];
  if (!firstX || row.fin !== true || (kind === "hw" && (row.lect || row.lectFreed)) || (last && last.seen)) { res.status(400).json({ error: "다시 풀어 맞힌 문제에만 적어요" }); return; }
  const nx = { ...row };
  if ("why" in b) nx.why = b.why == null ? null : b.why;
  if (kind === "exam" && "rushed" in b) nx.rushed = !!b.rushed;
  const questions = log.questions.map((q, k) => (k === i ? nx : q));
  await patchDoc(path, { questions });
  res.status(200).json({ ok: true, log: { ...log, questions } });
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST만 받습니다" }); return; }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    // 시험지 넣고 빼기 — PC 도구(tools/exam-push.py)만
    if (body.toolKey) {
      if (!(await toolOk(body.toolKey))) { res.status(403).json({ error: "도구 열쇠가 맞지 않아요" }); return; }
      if (body.action === "examPut") {
        const e = body.exam, err = checkExam(e);
        if (err) { res.status(400).json({ error: err }); return; }
        // names 가 있으면 그 학생들만 본다. 이름을 반 명단의 ID 로 바꿔 둔다 —
        // 목록은 로그인한 누구나 읽으니 이름은 싣지 않고, 명단에 없는 이름은 여기서 막는다
        const names = Array.isArray(e.names) ? e.names.map((x) => String(x).trim()).filter(Boolean) : [];
        const got = await resolveSids(Array.isArray(e.cids) ? e.cids.map(String) : [], names);
        if (got.error) { res.status(400).json({ error: got.error }); return; }
        const sids = got.sids;
        // patchDoc 은 보낸 칸만 고친다. 전에 있던 cids·test 가 남지 않게 **전부 적는다**
        await patchDoc("examKeys/" + e.id, {
          title: String(e.title).trim(), minutes: Number(e.minutes) || 0,
          kind: e.kind === "hw" ? "hw" : null, units: e.kind === "hw" ? (e.units || []).map((u) => String(u).trim()) : null,
          link: e.kind === "hw" && e.link ? String(e.link).trim() : null,   // 반 «과제» 번호표의 교재 이름 — 낸 번호를 거기 칠한다
          wb: e.kind === "hw" && e.wb ? true : null,   // 오답 과제(10/26) — 학생 «오답 과제» 탭 · 풀면서 문항 그림(api/examimg)
          questions: e.questions.map((q) => ({ n: q.n, type: q.type, ...(q.ans != null ? { ans: q.ans } : {}),
                                               ...(q.label ? { label: String(q.label).trim() } : {}),
                                               ...(q.pt != null ? { pt: q.pt } : {}),
                                               ...(q.u != null ? { u: q.u } : {}), ...(q.p != null ? { p: q.p } : {}),
                                               ...(q.parts ? { parts: q.parts.map((p) => ({ label: String(p.label).trim(), ans: p.ans, ...(p.pt != null ? { pt: p.pt } : {}), ...(p.g != null ? { g: String(p.g) } : {}) })) } : {}),
                                               ...(q.any ? { any: true } : {}),
                                               ...(q.o ? { o: String(q.o).trim() } : {}),   // 오답 과제 — 원래 문항(교재:번호:원본|숫자|묻는 말). 학습기록이 잇는다
                                               ...(q.type === "essay" && q.sol ? { sol: String(q.sol).slice(0, 400) } : {}) })),
          cids: Array.isArray(e.cids) ? e.cids.map(String) : [], sids, names, test: !!e.test, lock: !!e.lock, free: !!e.free,   // free = 시험용 과제 교재 — 답을 적으면 다 정답(조각 흐름 시험, 10/12) hkEmpty: !!e.hkEmpty,   // hkEmpty = 학결모 «걸어 둘 학생 없이 숨겨 둔» 시험지 (학생을 걸면 열린다)
          order: Number(e.order) || 0, updated: Date.now(),
        });
        const n = await rebuildList();
        res.status(200).json({ ok: true, id: e.id, listed: n }); return;
      }
      // 올라가 있는 시험지의 sids 를 지금 명단으로 다시 맞춘다 (10/8 «반ID/자리ID» 로 바꾼 뒤 한 번 · 몇 번 돌려도 같다)
      // 서술형 정답 글 넣기 (10/26) — {id, sols: {번호: 글}}. 이미 연 시험지에도 이 칸만 더한다(채점 · 목록은 그대로, 목록엔 안 실린다)
      if (body.action === "examSol") {
        const id = String(body.id || ""), sols = body.sols && typeof body.sols === "object" ? body.sols : {};
        const key = await getDoc("examKeys/" + id).catch(() => null);
        if (!key) { res.status(404).json({ error: "그 시험지가 없어요: " + id }); return; }
        const bad = Object.keys(sols).filter((n) => { const q = (key.questions || []).find((x) => String(x.n) === n); return !q || q.type !== "essay"; });
        if (bad.length) { res.status(400).json({ error: id + " — 서술형이 아닌 번호: " + bad.join(", ") }); return; }
        const questions = key.questions.map((q) => (q.type === "essay" && String(q.n) in sols ? { ...q, sol: String(sols[q.n]).slice(0, 400) } : q));
        await patchDoc("examKeys/" + id, { questions, updated: Date.now() });
        res.status(200).json({ ok: true, id, n: Object.keys(sols).length }); return;
      }
      if (body.action === "examResids") {
        const all = await listDocs("examKeys").catch(() => []);
        const done = [];
        for (const k of all) {
          const names = (k.names || []).map((x) => String(x).trim()).filter(Boolean);
          if (!names.length) continue;
          const got = await resolveSids((k.cids || []).map(String), names);
          if (got.error) { done.push({ id: k.id, error: got.error }); continue; }
          const same = JSON.stringify(got.sids) === JSON.stringify(k.sids || []);
          if (!same && !body.dry) await patchDoc("examKeys/" + k.id, { sids: got.sids });
          done.push({ id: k.id, from: k.sids || [], to: got.sids, same });
        }
        if (!body.dry) await rebuildList();
        res.status(200).json({ ok: true, dry: !!body.dry, done }); return;
      }
      // 반의 기본 시험지(appConfig/examPick.by) — {cid, id}. id 가 비면 기본을 푼다 (10/22)
      if (body.action === "examPick") {
        const cid = String(body.cid || ""), id = String(body.id || "");
        if (!cid) { res.status(400).json({ error: "cid 가 필요해요" }); return; }
        const cur = (await getDoc("appConfig/examPick").catch(() => null)) || {};
        const by = { ...(cur.by || {}), [cid]: id };
        await patchDoc("appConfig/examPick", { by, updated: Date.now() });
        res.status(200).json({ ok: true, by }); return;
      }
      // 학원 교재 정답 창고 올리기 (10/24) — {books:[{key, meta, title, units, questions}]}. shelf/{key} 에 통째, shelf/_index 에 목록.
      // shelf 는 보안 규칙상 앱(학생·선생님)이 직접 못 읽는다 — 정답이 들어 있다. 선생님은 shelfList/shelfHang 으로만
      if (body.action === "shelfPut") {
        const books = Array.isArray(body.books) ? body.books : [];
        if (!books.length) { res.status(400).json({ error: "books 가 비었어요" }); return; }
        for (const b of books) {
          if (!/^[0-9A-Za-z가-힣_.\-]{2,40}$/.test(String(b.key || "")) || !Array.isArray(b.questions) || !b.questions.length) { res.status(400).json({ error: "이상한 교재: " + b.key }); return; }
          const bad = b.questions.findIndex((q, i) => q.n !== i + 1 || !["mc", "short", "essay"].includes(q.type));
          if (bad >= 0) { res.status(400).json({ error: b.key + " " + (bad + 1) + "번째 문항 — n 은 1부터 연번 · type 은 mc/short/essay" }); return; }
          await patchDoc("shelf/" + b.key, { key: b.key, title: String(b.title || b.key), units: b.units || [], meta: b.meta || {}, questions: b.questions, updated: Date.now() });
        }
        const cur = (await getDoc("shelf/_index").catch(() => null)) || {};
        const idx = {}; (cur.books || []).forEach((m) => { idx[m.key] = m; });
        books.forEach((b) => { idx[b.key] = { key: b.key, title: String(b.title || b.key), ...(b.meta || {}), n: b.questions.length,
          auto: b.questions.filter((q) => q.type !== "essay").length }; });
        await patchDoc("shelf/_index", { books: Object.values(idx), updated: Date.now() });
        res.status(200).json({ ok: true, put: books.length, total: Object.keys(idx).length }); return;
      }
      if (body.action === "examDel") {
        await deleteDoc("examKeys/" + String(body.id || ""));
        const n = await rebuildList();
        res.status(200).json({ ok: true, listed: n }); return;
      }
      // 반 ID 와 명단 이름 — 시험지에 cids·names 를 적으려고
      if (body.action === "classes") {
        const cs = await listDocs("classes").catch(() => []);
        res.status(200).json({ ok: true, classes: cs.map((c) => ({ id: c.id, name: c.name || "", books: c.books || [],
          names: (c.roster || []).filter((r) => r && r.name).map((r) => r.name) })) }); return;
      }
      if (body.action === "examKeys") {
        res.status(200).json({ ok: true, exams: await listDocs("examKeys").catch(() => []) }); return;
      }
      // 코칭용으로 결과를 꺼낸다. 이 PC 에는 클래스앱 열쇠가 없어서, 결과 JSON 을
      // 받으려면 이 길이 필요하다 (시험지 스캔과 같이 넣어 문항별 코칭을 쓴다).
      if (body.action === "examLogs") {
        const cid = String(body.cid || "");
        if (!cid) { res.status(400).json({ error: "반(cid)이 필요해요" }); return; }
        const since = String(body.since || "0000-00-00");
        const days = (await listDocs("classes/" + cid + "/days").catch(() => []))
          .map((d) => d.id).filter((d) => d >= since).sort().reverse().slice(0, 120);
        const logs = [];
        for (const d of days) {
          const ls = await listDocs("classes/" + cid + "/days/" + d + "/examLogs").catch(() => []);
          ls.forEach((l) => { if (!body.sid || l.sid === body.sid) logs.push(l); });
        }
        logs.sort((a, b) => (b.time || 0) - (a.time || 0));
        res.status(200).json({ ok: true, logs }); return;
      }
      if (body.action === "examMove") return await moveLog(res, body);
      // 반 «과제» 교재 목록에 하나 더하거나 문항 수를 고친다 (과제 채점과 잇느라 · 10/10). 지우는 길은 없다 — 앱 반 설정에서
      // 반 «과제» 교재 목록을 통째로 바꾼다 (10/10 — 기말부터 수평교 (기말) · 퀀텀점프 둘만). dry 면 바꿀 모양만
      if (body.action === "classBooksSet") {
        const cid = String(body.cid || "");
        const books = Array.isArray(body.books) ? body.books.map((b) => ({ name: String(b.name || "").trim(), total: Number(b.total) })) : null;
        if (!cid || !books || !books.length || books.some((b) => !b.name || !(Number.isInteger(b.total) && b.total > 0))) { res.status(400).json({ error: "cid · books[{name,total}] 가 필요해요" }); return; }
        const cl = await getDoc("classes/" + cid).catch(() => null);
        if (!cl) { res.status(404).json({ error: "반이 없어요" }); return; }
        if (!body.dry) await patchDoc("classes/" + cid, { books });
        res.status(200).json({ ok: true, dry: !!body.dry, cid, before: cl.books || [], books }); return;
      }
      // 반의 «과제» 체크 기록(homework)과 «질문한 번호»(questioned)를 비운다 — 새로 시작할 때.
      // 지우기 전 문서를 그대로 돌려준다(도구가 파일로 남긴다). dry 면 돌려주기만 하고 안 지운다
      // 과제 채점 기록 하나 지우기 — 선생님 모드로 시험 삼아 낸 것 등. 지운 문서를 돌려준다(도구가 파일로 남긴다)
      if (body.action === "hwLogDel") {
        const cid = String(body.cid || ""), date = String(body.date || ""), rid = String(body.rid || "");
        if (!cid || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !rid) { res.status(400).json({ error: "cid · date · rid 가 필요해요" }); return; }
        const path = "classes/" + cid + "/days/" + date + "/hwLogs/" + rid;
        const log = await getDoc(path).catch(() => null);
        if (!log) { res.status(404).json({ error: "그 기록이 없어요" }); return; }
        if (!body.dry) await deleteDoc(path);
        res.status(200).json({ ok: true, dry: !!body.dry, log }); return;
      }
      if (body.action === "hwReset") {
        const cid = String(body.cid || "");
        if (!cid || !(await getDoc("classes/" + cid).catch(() => null))) { res.status(404).json({ error: "반이 없어요" }); return; }
        const hw = await listDocs("classes/" + cid + "/homework").catch(() => []);
        const qd = await listDocs("classes/" + cid + "/questioned").catch(() => []);
        if (!body.dry) {
          for (const d of hw) await deleteDoc("classes/" + cid + "/homework/" + d.id);
          for (const d of qd) await deleteDoc("classes/" + cid + "/questioned/" + d.id);
        }
        res.status(200).json({ ok: true, dry: !!body.dry, cid, homework: hw, questioned: qd }); return;
      }
      if (body.action === "classBook") {
        const cid = String(body.cid || ""), name = String(body.name || "").trim(), total = Number(body.total);
        if (!cid || !name || !(Number.isInteger(total) && total > 0)) { res.status(400).json({ error: "cid · name · total 이 필요해요" }); return; }
        const cl = await getDoc("classes/" + cid).catch(() => null);
        if (!cl) { res.status(404).json({ error: "반이 없어요" }); return; }
        const books = (cl.books || []).map((b) => ({ ...b }));
        const hit = books.find((b) => b.name === name);
        const before = hit ? hit.total : null;
        if (hit) hit.total = total; else books.push({ name, total });
        if (!body.dry) await patchDoc("classes/" + cid, { books });
        res.status(200).json({ ok: true, dry: !!body.dry, cid, name, before, total, books }); return;
      }
      // 과제 채점 기록 — 극복 문제(쌓인 오답 → 내신대비 자료)를 만들 때 PC 로 받는다. cid 를 안 주면 과제 교재가 걸린 반 전부
      // 조건부 쓰기(patchDocIf)가 진짜 Firestore 에서 도는지 — 시험 문서 하나를 만들고 · 고치고 · 낡은 시각으로 막히는지 보고 지운다
      if (body.action === "pcSelfTest") {
        const p = "appConfig/pcSelfTest", out = {};
        await deleteDoc(p);
        out.create = await patchDocIf(p, { n: 1 }, ["n"], null);
        out.createAgain = await patchDocIf(p, { n: 9 }, ["n"], null);          // 이미 있으니 false 여야
        const a1 = await getDocV(p);
        out.update = await patchDocIf(p, { n: 2 }, ["n"], a1.v);
        out.stale = await patchDocIf(p, { n: 3 }, ["n"], a1.v);                 // 낡은 시각 — false 여야
        out.final = (await getDocV(p)).doc;
        await deleteDoc(p);
        res.status(200).json({ ok: out.create === true && out.createAgain === false && out.update === true && out.stale === false && out.final && out.final.n === 2, ...out }); return;
      }
      // 다시 풀기 · 이유 시험(10/26) — 진짜 Firestore 에 쓰고 읽어 본다. 버리는 시험지 · 기록(2000-01-01)을 만들고 끝나면 지운다.
      // 가짜 서버는 «응답 200» 만 보고 기록 문서는 안 봤다(10/10 사고) — 여기선 문서를 다시 읽어 칸이 생겼는지 본다
      if (body.action === "retrySelfTest") {
        const cid = String(body.cid || ""); if (!cid) { res.status(400).json({ error: "cid 가 필요해요" }); return; }
        const kid = "_selftest-retry", rid = "selftest" + Date.now().toString(36), date = "2000-01-01";
        const ep = "classes/" + cid + "/days/" + date + "/examLogs/" + rid, hp = "classes/" + cid + "/days/" + date + "/hwLogs/" + rid;
        const T = { role: "owner", tid: "tool" }, out = {};
        const run = async (fn, b) => { const o = {}; await fn({ status(c) { o.code = c; return this; }, json(j) { o.body = j; } }, T, { cid, date, rid, ...b }); return o; };
        try {
          await patchDoc("examKeys/" + kid, { title: "selftest", questions: [{ n: 1, type: "mc", ans: 2 }, { n: 2, type: "short", ans: "3/4" }] });
          await patchDoc(ep, { rid, cid, sid: "_selftest", examId: kid, date, override: {}, score: 0, teacher: true,
            questions: [{ n: 1, type: "mc", answer: 5, auto: false }, { n: 2, type: "short", answer: "1", auto: false }] });
          await patchDoc(hp, { rid, cid, sid: "_selftest", bookId: kid, date, teacher: true,
            questions: [{ n: 1, type: "mc", answer: 5, auto: false, tries: [{ a: 2, ok: true, at: 1 }], fin: true }] });
          out.wrong = await run(examRetry, { n: 1, answer: 3, sec: 5 });
          out.right = await run(examRetry, { n: 1, answer: 2, sec: 4 });
          out.again = await run(examRetry, { n: 1, answer: 2 });                       // 이미 맞힘 — 400
          out.seen = await run(examRetry, { n: 2, answer: "0.75", seen: true });
          out.why = await run(whyMark, { kind: "exam", n: 1, why: "copy", rushed: true });
          out.whySeen = await run(whyMark, { kind: "exam", n: 2, why: "calc" });        // 보고 푼 것 — 400
          out.whyBad = await run(whyMark, { kind: "exam", n: 1, why: "misread" });       // 옛 코드 — 400
          out.whyHw = await run(whyMark, { kind: "hw", n: 1, why: "cond" });
          const e = await getDoc(ep), h = await getDoc(hp), q1 = e.questions[0], q2 = e.questions[1];
          const ok = out.wrong.body.right === false && out.right.body.right === true && out.again.code === 400 && out.seen.body.right === true
            && out.why.code === 200 && out.whySeen.code === 400 && out.whyBad.code === 400 && out.whyHw.code === 200
            && q1.tries.length === 2 && q1.fin === true && q1.why === "copy" && q1.rushed === true && q1.answer === 5 && q1.auto === false
            && q2.tries[0].seen === true && !q2.why && e.score === 0 && h.questions[0].why === "cond";
          out.result = { ok, codes: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.code || 200])), exam: e.questions, score: e.score, hw: h.questions };
        } finally {
          // ⚠ 응답을 보낸 뒤에 지우면 Vercel 이 함수를 멈춰 안 지워질 수 있다 — 먼저 지우고, 정말 없어졌는지 다시 읽은 뒤 답한다
          await deleteDoc(ep); await deleteDoc(hp); await deleteDoc("examKeys/" + kid);
        }
        const left = (await Promise.all([ep, hp, "examKeys/" + kid].map((x) => getDoc(x).catch(() => null)))).filter(Boolean).length;
        res.status(200).json({ ...(out.result || { ok: false }), ok: !!(out.result && out.result.ok) && left === 0, left });
        return;
      }
      // 조각 운영 — PC 도구(tools/pieces.mjs). op: get(설정 · 반별 장부) · event(오늘만 이벤트, pcEventSet 과 같음) · items(상품표) · resetLedger(장부 지우기 — 도구가 먼저 받아 둔다)
      if (body.action === "pcAdmin") {
        const TOOL = { role: "owner", tid: "tool" };
        if (body.op === "get") {
          const cfg = await pcCfg(), cids = Array.isArray(body.cids) && body.cids.length ? body.cids.map(String) : cfg.cids, ledgers = {};
          for (const c of cids) ledgers[c] = await listDocs("classes/" + c + "/pieces").catch(() => []);
          res.status(200).json({ ok: true, cfg: cfg.doc, cids: cfg.cids, books: cfg.books, today: kstDate(Date.now()), ledgers }); return;
        }
        if (body.op === "event") return await pcTeacherAct(res, TOOL, { ...body, action: "pcEventSet" });
        if (body.op === "items") return await pcTeacherAct(res, TOOL, { ...body, action: "pcItemsSet" });
        if (body.op === "lect") return await pcTeacherAct(res, TOOL, { ...body, action: body.get ? "hwLectGet" : "hwLectSet" });   // 수업 풀이 · 홀수 기본 보류(10/15)
        if (body.op === "cids") {   // 대상 반 바꾸기 — 있는 반만
          const want = Array.isArray(body.cids) ? [...new Set(body.cids.map(String))] : [];
          const have = new Set((await listDocs("classes").catch(() => [])).map((c) => c.id)), bad = want.filter((c) => !have.has(c));
          if (!want.length || bad.length) { res.status(400).json({ error: "없는 반: " + (bad.join(", ") || "(빈 목록)") }); return; }
          await patchDoc("appConfig/pieces", { cids: want, at: Date.now() });
          res.status(200).json({ ok: true, cids: want }); return;
        }
        if (body.op === "books") {   // 조각 주는 교재 정하기 — 있는 과제 교재만(10/24)
          const want = Array.isArray(body.books) ? [...new Set(body.books.map(String))] : [];
          const have = new Set((await listDocs("examKeys").catch(() => [])).filter((e) => e.kind === "hw").map((e) => e.id)), bad = want.filter((x) => !have.has(x));
          if (bad.length) { res.status(400).json({ error: "없는 과제 교재: " + bad.join(", ") }); return; }
          await patchDoc("appConfig/pieces", { books: want, at: Date.now() });
          res.status(200).json({ ok: true, books: want }); return;
        }
        if (body.op === "couponAdd") { const r = await pcCouponAdd(body.item, body.img, "tool"); res.status(r.error ? (r.dup ? 409 : 400) : 200).json(r); return; }
        if (body.op === "coupons") { res.status(200).json({ ok: true, list: (((await getDoc(PC_CIDX).catch(() => null)) || {}).list || []) }); return; }
        if (body.op === "resetLedger") {
          const cid = String(body.cid || ""), sids = Array.isArray(body.sids) ? body.sids.map(String) : [];
          if (!cid || !sids.length) { res.status(400).json({ error: "cid · sids 가 필요해요" }); return; }
          for (const s of sids) await deleteDoc(pcPath(cid, s));
          res.status(200).json({ ok: true, cid, deleted: sids.length }); return;
        }
        // 받은 상품만 되살린다(10/16) — 장부를 지우며 받아 간 기프티콘까지 사라졌던 것. 조각·구슬 칸은 안 건드린다.
        // {cid, items:[{sid, name, prizes:[…]}]} — 이미 있는 상품(pid 같음)은 건너뛴다
        if (body.op === "prizesRestore") {
          const cid = String(body.cid || ""), items = Array.isArray(body.items) ? body.items : [];
          if (!cid || !items.length) { res.status(400).json({ error: "cid · items 가 필요해요" }); return; }
          const out = [];
          for (const it of items) {
            const sid = String(it.sid || ""), add = (Array.isArray(it.prizes) ? it.prizes : []).filter((x) => x && x.pid);
            if (!sid || !add.length) continue;
            let n = 0;
            await pcEdit(cid, sid, (d) => {
              const have = new Set((d.prizes || []).map((x) => x.pid)), more = add.filter((x) => !have.has(x.pid));
              n = more.length; if (!n) return null;
              return { name: d.name || String(it.name || ""), prizes: [...(d.prizes || []), ...more],
                       log: [...(d.log || []), { t: Date.now(), k: "restore", d: 0, prize: more.map((x) => x.name).join(", ") }].slice(-PC_LOG) };
            });
            out.push({ sid, restored: n });
          }
          res.status(200).json({ ok: true, cid, out }); return;
        }
        res.status(400).json({ error: "op 는 get · event · items · resetLedger · prizesRestore" }); return;
      }
      if (body.action === "hwLogs") {
        const since = String(body.since || "0000-00-00");
        let cids = body.cid ? [String(body.cid)] : [];
        if (!cids.length) {
          const ks = (await listDocs("examKeys").catch(() => [])).filter((k) => k.kind === "hw");
          cids = [...new Set(ks.flatMap((k) => k.cids || []))];
        }
        const logs = [];
        for (const cid of cids) {
          const days = (await listDocs("classes/" + cid + "/days").catch(() => [])).map((d) => d.id).filter((d) => d >= since);
          for (const d of days) {
            const ls = await listDocs("classes/" + cid + "/days/" + d + "/hwLogs").catch(() => []);
            ls.forEach((l) => { if ((!body.sid || l.sid === body.sid) && (!body.bookId || l.bookId === body.bookId)) logs.push(l); });
          }
        }
        logs.sort((a, b) => (a.time || 0) - (b.time || 0));
        res.status(200).json({ ok: true, logs }); return;
      }
      // 시간을 넘겨 낸 기록을 «낸 답 그대로» 점수로 다시 매긴다(10/2 전에 낸 것). 몇 번 돌려도 같다
      if (body.action === "examRescore") {
        const since = String(body.since || "0000-00-00");
        const cids = body.cid ? [String(body.cid)] : (await listDocs("classes").catch(() => [])).map((c) => c.id);
        const done = [];
        for (const cid of cids) {
          const days = (await listDocs("classes/" + cid + "/days").catch(() => [])).map((d) => d.id).filter((d) => d >= since);
          for (const d of days) {
            const ls = await listDocs("classes/" + cid + "/days/" + d + "/examLogs").catch(() => []);
            for (const l of ls) {
              if (!(l.overSec > 0) || !Array.isArray(l.questions)) continue;
              const rid = l.rid || l.id, ov = l.override || {};
              const t = tally(l.questions, ov);
              const patch = { score: t.score, got: t.got, correct: t.correct, pending: t.pending, inTime: inTimeOf(l.questions, ov), all: null };
              if (body.dry !== true) {
                await patchDoc("classes/" + cid + "/days/" + d + "/examLogs/" + rid, patch);
                if (!l.teacher && !l.voided) await patchDoc("classes/" + cid + "/days/" + d + "/scores/" + rid, { score: t.score, correct: t.correct }).catch(() => {});
              }
              done.push({ cid, date: d, name: l.name, examId: l.examId, voided: !!l.voided, teacher: !!l.teacher, from: l.score, to: t.score });
            }
          }
        }
        res.status(200).json({ ok: true, dry: body.dry === true, done }); return;
      }
      res.status(400).json({ error: "그런 동작이 없어요" }); return;
    }

    const claims = await verifyIdToken(body.idToken);
    if (!claims) { res.status(403).json({ error: "로그인이 풀렸어요. 다시 들어와 주세요." }); return; }
    if (body.action === "aiKeyGet") return await aiKeyGet(res, claims);
    if (body.action === "submit") return await submit(res, claims, body);
    if (body.action === "liveMark") return await liveMark(res, claims, body);
    if (body.action === "liveMarks") return await liveMarks(res, claims, body);
    if (body.action === "fix") return await fixAnswer(res, claims, body);
    if (body.action === "hkExam") return await hkExam(res, claims, body);
    if (body.action === "hwSubmit") return await hwSubmit(res, claims, body);
    if (body.action === "hwRetry") return await hwRetry(res, claims, body);
    if (body.action === "hwSelf") return await hwSelf(res, claims, body);
    if (body.action === "examRetry") return await examRetry(res, claims, body);
    if (body.action === "essaySol") return await essaySol(res, claims, body);
    if (body.action === "whyMark") return await whyMark(res, claims, body);
    if (body.action === "pcMe") return await pcMe(res, claims, body);
    if (body.action === "pcOpen") return await pcOpen(res, claims, body);
    if (body.action === "pcSwap") return await pcSwap(res, claims, body);
    if (body.action === "pcCoupon") return await pcCoupon(res, claims, body);
    if (body.action === "hwAway") return await hwAway(res, claims, body);
    if (["pcItemsGet", "pcItemsSet", "pcEventSet", "pcCouponAdd", "pcCouponDel", "pcBoard", "pcGive", "pcAdjust", "hwLectGet", "hwLectSet"].includes(body.action)) return await pcTeacherAct(res, claims, body);
    if (body.action === "hkRemove") return await hkRemove(res, claims, body);
    if (["shelfList", "shelfHang", "shelfDrop"].includes(body.action)) return await shelfAct(res, claims, body);
    res.status(400).json({ error: "그런 동작이 없어요" });
  } catch (e) {
    console.error("[exam]", e);
    res.status(500).json({ error: "서버 오류: " + e.message });
  }
}
