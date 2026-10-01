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
  if (!(Number(e.minutes) > 0)) return "제한 시간이 없어요";
  if (!Array.isArray(e.questions) || !e.questions.length) return "문항이 없어요";
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
  }
  if (e.lock != null && typeof e.lock !== "boolean") return "lock 은 true/false";
  return null;
}

// 학생이 보는 목록 — **정답(ans)만 뺀다.** 나머지는 그대로
async function rebuildList() {
  const all = await listDocs("examKeys").catch(() => []);
  const exams = all.map((e) => ({
    id: e.id, title: e.title, minutes: e.minutes,
    cids: e.cids || [], sids: e.sids || [], test: !!e.test, lock: !!e.lock, order: e.order || 0,
    questions: (e.questions || []).map((q) => ({ n: q.n, type: q.type, ...(q.pt != null ? { pt: q.pt } : {}),
                                                 ...(q.label ? { label: q.label } : {}) })),
  })).sort((a, b) => (a.order - b.order) || String(a.title).localeCompare(String(b.title), "ko"));
  await patchDoc(LIST_PATH, { exams, updated: Date.now() });
  return exams.length;
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
    ...(e.k === "ans" ? { v: e.v == null ? null : String(e.v).slice(0, 20) } : {}),
  })) : [];
  const limitSec = Math.max(60, Math.min(6 * 3600, Number(b.limitSec) || key.minutes * 60));
  const endT = Math.max(0, Math.min(limitSec + OVER_MAX, Number(b.endT) || 0));
  const startedAt = Number(b.startedAt) || Date.now();
  const overSec = Math.max(0, Math.round((endT - limitSec) * 10) / 10);
  const inAns = overSec > 0 ? answersAt(ev, limitSec) : null;

  const norm = (q, raw) => (raw == null || raw === "" ? null : (q.type === "mc" ? Number(raw) : String(raw).slice(0, 20)));
  const qs = key.questions.map((q) => {
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
  const tAll = tally(qs, {});
  const t = overSec > 0 ? tally(qs, {}, true) : tAll;   // 공식 점수는 **시간 안** — 학교 시험과 같은 조건
  const date = kstDate(startedAt);
  const now = Date.now();
  const log = {
    rid, cid, sid, name, examId, title: key.title, minutes: key.minutes,
    limitSec, endT, startedAt, reason: b.reason === "time" ? "time" : "submit",
    date, questions: qs, ev, override: {}, ...(key.lock ? { lock: true } : {}),
    score: t.score, got: t.got, totalPt: t.totalPt, correct: t.correct, n: t.n, pending: t.pending,
    ...(overSec > 0 ? { overSec, all: { score: tAll.score, got: tAll.got, correct: tAll.correct, pending: tAll.pending } } : {}),
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
  const tAll = tally(questions, override);
  const t = log.overSec > 0 ? tally(questions, override, true) : tAll;
  const patch = { questions, override, score: t.score, got: t.got, correct: t.correct, pending: t.pending,
                  ...(log.overSec > 0 ? { all: { score: tAll.score, got: tAll.got, correct: tAll.correct, pending: tAll.pending } } : {}) };
  await patchDoc(path, patch);
  if (!log.teacher && !log.voided) {
    await patchDoc("classes/" + cid + "/days/" + date + "/scores/" + rid, { score: t.score, correct: t.correct }).catch(() => {});
  }
  res.status(200).json({ ok: true, log: { ...log, ...patch } });
}

// ───────────── 핸들러 ─────────────
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
        let sids = [];
        const names = Array.isArray(e.names) ? e.names.map((x) => String(x).trim()).filter(Boolean) : [];
        if (names.length) {
          const cids = Array.isArray(e.cids) ? e.cids.map(String) : [];
          if (!cids.length) { res.status(400).json({ error: "names 를 쓰려면 cids(반)도 적어야 해요" }); return; }
          const rows = [];
          for (const c of cids) {
            const cl = await getDoc("classes/" + c).catch(() => null);
            if (!cl) { res.status(400).json({ error: "반이 없어요: " + c }); return; }
            (cl.roster || []).forEach((r) => r && r.id && rows.push(r));
          }
          for (const nm of names) {
            const hit = rows.filter((r) => String(r.name || "").trim() === nm);
            // 한 학생이 반 둘에 있으면(정규반 + 개진반) 이름이 두 번 잡힌다 — 같은 사람(pid)이면 두 자리 다 연다
            const people = new Set(hit.map((r) => r.pid || r.id));
            if (!hit.length || people.size !== 1) { res.status(400).json({ error: (hit.length ? "명단에 둘 이상: " : "명단에 없는 이름: ") + nm }); return; }
            hit.forEach((r) => sids.push(r.id));
          }
        }
        // patchDoc 은 보낸 칸만 고친다. 전에 있던 cids·test 가 남지 않게 **전부 적는다**
        await patchDoc("examKeys/" + e.id, {
          title: String(e.title).trim(), minutes: Number(e.minutes),
          questions: e.questions.map((q) => ({ n: q.n, type: q.type, ...(q.ans != null ? { ans: q.ans } : {}),
                                               ...(q.label ? { label: String(q.label).trim() } : {}),
                                               ...(q.pt != null ? { pt: q.pt } : {}) })),
          cids: Array.isArray(e.cids) ? e.cids.map(String) : [], sids, names, test: !!e.test, lock: !!e.lock,
          order: Number(e.order) || 0, updated: Date.now(),
        });
        const n = await rebuildList();
        res.status(200).json({ ok: true, id: e.id, listed: n }); return;
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
      res.status(400).json({ error: "그런 동작이 없어요" }); return;
    }

    const claims = await verifyIdToken(body.idToken);
    if (!claims) { res.status(403).json({ error: "로그인이 풀렸어요. 다시 들어와 주세요." }); return; }
    if (body.action === "submit") return await submit(res, claims, body);
    if (body.action === "fix") return await fixAnswer(res, claims, body);
    res.status(400).json({ error: "그런 동작이 없어요" });
  } catch (e) {
    console.error("[exam]", e);
    res.status(500).json({ error: "서버 오류: " + e.message });
  }
}
