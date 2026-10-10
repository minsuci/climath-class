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
// 답 고정(lock) — 푸는 동안은 자유롭게 고치고, **제출한 뒤에는** 학생이 결과(O/X)를 못 고친다.
//   고치는 건 선생님만: 결과 화면 O/X 고침 · «답 고치기»(action "fix", 여기서 다시 채점)
import { verifyIdToken, getDoc, patchDoc, listDocs, deleteDoc } from "./_google.js";

const TOOLKEY_PATH = "team/tools";
const LIST_PATH = "appConfig/examList";
const MAX_EV = 3000;
// 시간이 끝나도 바로 걷지 않는다 — 더 풀게 두고, 시간 뒤에 적은 답은 따로 채점한다(«시간 초과»).
// 끝없이 열려 있지 않게 이만큼 지나면 그때 저절로 낸다
const OVER_MAX = 30 * 60;          // 50분에 문항 25개면 넉넉히 몇 백. 이보다 많으면 무언가 잘못된 것

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
// 점수는 **100점 기준**으로 낸다. 점수 칸의 다른 줄(학생이 «17/22» 로 적는 것)이
// round(맞은/전체×100) 이라, 같은 날 반 평균에 섞여도 뜻이 맞아야 한다.
// inTime: 시간 안 점수 — 시간이 끝난 뒤 답이 바뀐 문항(late)은 끝난 순간의 답(autoIn)으로 센다
// ⚠ 공식 점수는 **낸 답 그대로**다(inTime 없이). 시간 안 점수는 참고(코칭)로만 log.inTime 에 남긴다.
//   2026-10-02 마왕님: «시간 지나도 낸 건 낸 거야» — 전엔 시간 안 점수가 공식이었다
function tally(qs, override, inTime) {
  const ok = (q) => (inTime && q.late ? q.autoIn : override && q.n in override ? override[q.n] : q.auto);
  const hasPt = qs.every((q) => typeof q.pt === "number" && q.pt > 0);
  const totalPt = hasPt ? qs.reduce((a, q) => a + q.pt, 0) : qs.length;
  const got = qs.reduce((a, q) => a + (ok(q) ? (hasPt ? q.pt : 1) : 0), 0);
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
  if (hw && e.units != null && !(Array.isArray(e.units) && e.units.every((u) => typeof u === "string" && u.trim() && u.length <= 30))) return "units 는 단원 이름(30자 안) 목록";
  const seen = {};
  for (const q of e.questions) {
    if (!Number.isInteger(q.n) || q.n <= 0) return "문항 번호가 이상해요: " + JSON.stringify(q);
    if (seen[q.n]) return q.n + "번이 두 번 있어요";
    seen[q.n] = 1;
    if (!["mc", "short", "essay"].includes(q.type)) return q.n + "번 종류가 이상해요: " + q.type;
    if (q.type === "mc" && !(Number.isInteger(q.ans) && q.ans >= 1 && q.ans <= 5)) return q.n + "번 객관식 답은 1~5";
    if (q.type === "short") {
      const ks = [].concat(q.ans);
      if (!ks.length || ks.some((k) => !String(k == null ? "" : k).trim())) return q.n + "번 단답형 답이 없어요";
    }
    if (q.pt != null && !(typeof q.pt === "number" && q.pt > 0)) return q.n + "번 배점이 이상해요";
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

async function rebuildList() {
  const all = await listDocs("examKeys").catch(() => []);
  const exams = all.map((e) => ({
    id: e.id, title: e.title, minutes: e.minutes,
    cids: e.cids || [], sids: e.sids || [], test: !!e.test, lock: !!e.lock, order: e.order || 0,
    ...(e.kind === "hw" ? { kind: "hw", units: e.units || [] } : {}),
    questions: (e.questions || []).map((q) => ({ n: q.n, type: q.type, ...(q.pt != null ? { pt: q.pt } : {}),
                                                 ...(q.label ? { label: q.label } : {}), ...(q.u != null ? { u: q.u } : {}) })),
  })).sort((a, b) => (a.order - b.order) || String(a.title).localeCompare(String(b.title), "ko"));
  await patchDoc(LIST_PATH, { exams, updated: Date.now() });
  return exams.length;
}

// ───────────── 문항별 채점 줄 — 제출(submit)과 옮기기(examMove)가 같이 쓴다 ─────────────
function gradeRows(key, answers, ev, limitSec, overSec) {
  const inAns = overSec > 0 ? answersAt(ev, limitSec) : null;
  const norm = (q, raw) => (raw == null || raw === "" ? null : (q.type === "mc" ? Number(raw) : String(raw).slice(0, 20)));
  return key.questions.map((q) => {
    const mine = norm(q, answers[q.n]);
    const row = { n: q.n, type: q.type, ...(q.pt != null ? { pt: q.pt } : {}), ...(q.label ? { label: q.label } : {}),
                  key: q.type === "essay" ? null : q.ans, answer: mine, auto: autoCorrect(q, mine) };
    // 시간이 끝난 뒤 답이 바뀌었으면 끝난 순간의 답을 따로 둔다. 그때 비어 있었으면 시간 안에는 틀림
    if (inAns) {
      const was = norm(q, inAns[q.n]);
      if (String(was) !== String(mine)) Object.assign(row, { late: true, answerIn: was, autoIn: was == null ? false : autoCorrect(q, was) });
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
    ...(e.k === "ans" ? { v: e.v == null ? null : String(e.v).slice(0, 20) } : {}),
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
  const raw = b.value == null ? "" : String(b.value).trim().slice(0, 20);
  const mine = raw === "" ? null : (kq.type === "mc" ? Number(raw) : raw);
  if (kq.type === "mc" && mine != null && !(Number.isInteger(mine) && mine >= 1 && mine <= 5)) { res.status(400).json({ error: "객관식은 1~5" }); return; }
  const old = log.questions[i];
  const who = claims.tid ? await getDoc("teachers/" + claims.tid).catch(() => null) : null;
  const { late: _l, answerIn: _a, autoIn: _x, ...rest } = old;   // 선생님이 정한 답은 시간 안 답으로 본다
  const row = { ...rest, answer: mine, auto: autoCorrect(kq, mine),
                fixed: { from: old.answer == null ? null : old.answer, by: (who && who.name) || claims.tid || claims.role, at: Date.now() } };
  const questions = log.questions.map((q, k) => (k === i ? row : q));
  const override = { ...(log.override || {}) }; delete override[n];
  const t = tally(questions, override);
  const patch = { questions, override, score: t.score, got: t.got, correct: t.correct, pending: t.pending,
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
  if (claims.role === "teacher" || claims.role === "owner") return { name: (row && row.name) || "", teacher: true };
  if (!(claims.cids || []).includes(cid)) { res.status(403).json({ error: "그 반 학생이 아니에요" }); return null; }
  if (!row || row.name !== claims.sname) { res.status(403).json({ error: "명단과 이름이 맞지 않아요" }); return null; }
  return { name: row.name, teacher: !!row.teacher };
}
const hwEv = (ev) => (Array.isArray(ev) ? ev.slice(0, MAX_EV).map((e) => ({
  t: Math.max(0, Number(e.t) || 0), k: e.k === "ans" ? "ans" : "go", q: Number(e.q) || 0,
  ...(e.k === "ans" ? { v: e.v == null ? null : String(e.v).slice(0, 20) } : {}),
})) : []);
const hwNorm = (q, raw) => (raw == null || raw === "" ? null : (q.type === "mc" ? Number(raw) : String(raw).slice(0, 20)));
const r1 = (x) => Math.round(x * 10) / 10;

async function hwSubmit(res, claims, b) {
  const cid = String(b.cid || ""), sid = String(b.sid || ""), bookId = String(b.bookId || ""), rid = String(b.rid || "");
  if (!cid || !sid || !bookId) { res.status(400).json({ error: "빠진 값이 있어요" }); return; }
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(rid)) { res.status(400).json({ error: "기록 번호가 이상해요" }); return; }
  const who = await hwWho(res, claims, cid, sid); if (!who) return;
  const key = await getDoc("examKeys/" + bookId).catch(() => null);
  if (!key || key.kind !== "hw") { res.status(404).json({ error: "그 교재가 없어요" }); return; }
  if ((key.cids || []).length && !key.cids.includes(cid) && !who.teacher) { res.status(403).json({ error: "이 반 교재가 아니에요" }); return; }
  const byN = {}; (key.questions || []).forEach((q) => { byN[q.n] = q; });
  const nums = [...new Set((Array.isArray(b.nums) ? b.nums : []).map(Number))].filter((n) => byN[n]).sort((x, y) => x - y);
  if (!nums.length) { res.status(400).json({ error: "푼 번호가 없어요" }); return; }
  if (nums.length > HW_MAX_Q) { res.status(400).json({ error: "한 번에 " + HW_MAX_Q + "문항까지만 낼 수 있어요" }); return; }
  const answers = b.answers && typeof b.answers === "object" ? b.answers : {};
  const ev = hwEv(b.ev);
  const endT = Math.max(0, Math.min(HW_MAX_SEC, Number(b.endT) || 0));
  const startedAt = Number(b.startedAt) || Date.now();
  const sec = hwSecs(ev, endT);
  const questions = nums.map((n) => {
    const q = byN[n], mine = hwNorm(q, answers[n]);
    return { n, type: q.type, ...(q.label ? { label: q.label } : {}), ...(q.u != null ? { u: q.u } : {}),
             answer: mine, auto: mine == null ? false : autoCorrect(q, mine), sec: r1(sec[n] || 0) };
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
  await patchDoc(base + "/hwLogs/" + rid, log);
  res.status(200).json({ ok: true, log });
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
  res.status(200).json({ ok: true, log: { ...log, ...patch } });
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
          questions: e.questions.map((q) => ({ n: q.n, type: q.type, ...(q.ans != null ? { ans: q.ans } : {}),
                                               ...(q.label ? { label: String(q.label).trim() } : {}),
                                               ...(q.pt != null ? { pt: q.pt } : {}),
                                               ...(q.u != null ? { u: q.u } : {}), ...(q.p != null ? { p: q.p } : {}) })),
          cids: Array.isArray(e.cids) ? e.cids.map(String) : [], sids, names, test: !!e.test, lock: !!e.lock, hkEmpty: !!e.hkEmpty,   // hkEmpty = 학결모 «걸어 둘 학생 없이 숨겨 둔» 시험지 (학생을 걸면 열린다)
          order: Number(e.order) || 0, updated: Date.now(),
        });
        const n = await rebuildList();
        res.status(200).json({ ok: true, id: e.id, listed: n }); return;
      }
      // 올라가 있는 시험지의 sids 를 지금 명단으로 다시 맞춘다 (10/8 «반ID/자리ID» 로 바꾼 뒤 한 번 · 몇 번 돌려도 같다)
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
      if (body.action === "examDel") {
        await deleteDoc("examKeys/" + String(body.id || ""));
        const n = await rebuildList();
        res.status(200).json({ ok: true, listed: n }); return;
      }
      // 반 ID 와 명단 이름 — 시험지에 cids·names 를 적으려고
      if (body.action === "classes") {
        const cs = await listDocs("classes").catch(() => []);
        res.status(200).json({ ok: true, classes: cs.map((c) => ({ id: c.id, name: c.name || "",
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
      // 과제 채점 기록 — 극복 문제(쌓인 오답 → 내신대비 자료)를 만들 때 PC 로 받는다. cid 를 안 주면 과제 교재가 걸린 반 전부
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
    if (body.action === "submit") return await submit(res, claims, body);
    if (body.action === "fix") return await fixAnswer(res, claims, body);
    if (body.action === "hkExam") return await hkExam(res, claims, body);
    if (body.action === "hwSubmit") return await hwSubmit(res, claims, body);
    if (body.action === "hwRetry") return await hwRetry(res, claims, body);
    if (body.action === "hkRemove") return await hkRemove(res, claims, body);
    res.status(400).json({ error: "그런 동작이 없어요" });
  } catch (e) {
    console.error("[exam]", e);
    res.status(500).json({ error: "서버 오류: " + e.message });
  }
}
