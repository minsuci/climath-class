// CLIMATH 로그인 - 서버에서 PIN을 검사하고 Firebase 커스텀 토큰을 발급한다.
//
// 왜 서버로 옮겼나:
//   예전에는 브라우저가 teachers 컬렉션을 통째로 받아(PIN 평문 포함) `pin !== picked.pin`으로
//   비교했다. 검사하는 코드도 정답도 사용자 손 안에 있어서 아무 의미가 없었다.
//   이제 PIN은 브라우저로 내려가지 않고, 통과하면 위조 불가능한 토큰만 받는다.
//   그 토큰의 claims를 Firestore 보안 규칙이 읽어 서버에서 접근을 막는다.
//
// 엔드포인트 (전부 POST /api/auth):
//   { action:"teachers" }                       → 로그인 화면용 이름 목록 (PIN 없음)
//   { action:"login", kind:"teacher", tid, pin } → { token }
//   { action:"login", kind:"student", name, pin }→ { token, name }
//   { action:"register", name, pin }             → 선생님 가입 신청 (status:"pending")

// _google.js 는 반드시 .js 여야 한다. Vercel이 이 파일들을 CJS로 로드하면서
// 진입 파일의 ESM 문법만 변환해 주기 때문에, 지역 파일을 .mjs로 두면
// require()가 ESM을 못 읽어 함수 전체가 죽는다(ERR_REQUIRE_ESM → 로그인 불가).
import { createCustomToken, verifyIdToken, getDoc, listDocs, patchDoc, deleteDoc, getPublishedRules } from "./_google.js";

const norm = (s) => String(s || "").replace(/\s+/g, "");
const todayStr = () => new Date().toISOString().slice(0, 10);
const DEFAULT_PIN = "1234";

// ---- 시도 횟수 제한 ----
// PIN이 4자리라 1만 가지뿐이다. 검사를 서버로 옮긴 순간부터 전부 넣어보는 게 가능해지므로
// 이게 없으면 오히려 전보다 나빠진다.
const MAX_TRIES = 8;
const WINDOW_MS = 10 * 60 * 1000;

async function checkRate(key) {
  const doc = await getDoc("authAttempts/" + encodeURIComponent(key));
  const now = Date.now();
  if (!doc) return { ok: true, n: 0 };
  if (now - (doc.first || 0) > WINDOW_MS) return { ok: true, n: 0 }; // 창이 지났으면 초기화
  return { ok: (doc.n || 0) < MAX_TRIES, n: doc.n || 0, first: doc.first };
}
async function noteFail(key, prev) {
  const now = Date.now();
  const fresh = !prev.first || now - prev.first > WINDOW_MS;
  await patchDoc("authAttempts/" + encodeURIComponent(key), {
    n: fresh ? 1 : prev.n + 1,
    first: fresh ? now : prev.first,
    last: now,
  });
}
async function clearFails(key) {
  await patchDoc("authAttempts/" + encodeURIComponent(key), { n: 0, first: 0, last: Date.now() });
}

// 종강한 반은 학생 로그인 대상이 아니다 (앱의 isClassEnded와 같은 기준)
const classEnded = (c) => !!(c && c.endDate && todayStr() > c.endDate);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST만 됩니다" }); return; }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  try {
    if (body.action === "teachers") return await listTeacherNames(res);
    if (body.action === "register") return await register(res, body);
    if (body.action === "changePin") return await changePin(res, body);
    if (body.action === "resetStudentPin") return await resetStudentPin(res, body);
    if (body.action === "changeTeacherPin") return await changeTeacherPin(res, body);
    if (body.action === "defaultPinReport") return await defaultPinReport(res, body);
    if (body.action === "rulesCheck") return await rulesCheck(res);
    if (body.action === "claimClass") return await claimClass(res, body);
    if (body.action === "login" && body.kind === "teacher") return await loginTeacher(res, body);
    if (body.action === "login" && body.kind === "student") return await loginStudent(res, body);
    res.status(400).json({ error: "알 수 없는 요청입니다" });
  } catch (e) {
    console.error("[auth]", e);
    res.status(500).json({ error: "서버 오류: " + e.message });
  }
}

// 로그인 화면에 뿌릴 목록. PIN은 절대 내보내지 않는다.
async function listTeacherNames(res) {
  const ts = await listDocs("teachers");
  ts.sort((a, b) => (a.time || 0) - (b.time || 0));
  res.status(200).json({
    teachers: ts.map((t) => ({ tid: t.id, name: t.name, role: t.role || "teacher", status: t.status || "active" })),
  });
}

async function loginTeacher(res, { tid, pin }) {
  if (!tid || !pin) { res.status(400).json({ error: "입력이 부족합니다" }); return; }
  const key = "t:" + tid;
  const rate = await checkRate(key);
  if (!rate.ok) {
    res.status(429).json({ error: "시도가 너무 많아요. 10분 뒤에 다시 해주세요." });
    return;
  }
  const t = await getDoc("teachers/" + tid);
  if (!t) { res.status(404).json({ error: "없는 선생님입니다" }); return; }
  if ((t.status || "active") === "pending") {
    res.status(403).json({ error: "관리자 승인 대기 중입니다." });
    return;
  }
  if (String(t.pin || "") !== String(pin)) {
    await noteFail(key, rate);
    const left = MAX_TRIES - (rate.n + 1);
    res.status(401).json({ error: "PIN이 올바르지 않습니다" + (left <= 3 && left > 0 ? " (" + left + "번 남음)" : "") });
    return;
  }
  await clearFails(key);
  // classIds는 claims에 넣지 않는다 — 반이 늘면 1000바이트 제한에 걸리고, 담당이 바뀌어도
  // 다시 로그인할 때까지 옛 값이 남는다. 규칙이 teachers/{tid}를 직접 읽게 한다.
  const token = createCustomToken("t_" + tid, { role: t.role === "owner" ? "owner" : "teacher", tid });
  res.status(200).json({ token, tid, name: t.name, role: t.role || "teacher" });
}

async function loginStudent(res, { name, pin }) {
  const nm = norm(name);
  if (!nm || !pin) { res.status(400).json({ error: "입력이 부족합니다" }); return; }
  const key = "s:" + nm;
  const rate = await checkRate(key);
  if (!rate.ok) {
    res.status(429).json({ error: "시도가 너무 많아요. 10분 뒤에 다시 해주세요." });
    return;
  }

  const classes = await listDocs("classes");
  const found = [];
  for (const c of classes) {
    const m = (c.roster || []).find((r) => norm(r.name) === nm);
    if (m) found.push({ cls: c, member: m });
  }
  const live = found.filter((x) => !classEnded(x.cls));

  // ⚠ 로그인은 오래 **반 명단만** 봤다. 그래서 학생 명단에 만들어 놓고 반에 안 넣으면
  //    «명단에 없는 이름이에요» 가 떴다 — 이름을 잘못 친 줄 알게 되는 문구라
  //    진짜 원인(반 배정 안 함)을 찾기가 어렵다.
  //    학생 명단(students)에 있으면 들여보내고, 반이 없다는 것을 화면이 말하게 한다.
  let person = null;
  if (!live.length) {
    const people = await listDocs("students");
    person = people.find((p) => norm(p.name) === nm) || null;
  }
  if (!found.length && !person) {
    await noteFail(key, rate);
    res.status(404).json({ error: "명단에 없는 이름이에요. 띄어쓰기 없이 정확히 입력했는지 확인해주세요." });
    return;
  }
  if (!live.length && !person) {
    res.status(403).json({ error: "수강이 종료된 반이에요. 기록은 보관되어 있으니 선생님께 문의해주세요." });
    return;
  }

  const how = await verifyStudentPin(nm, String(pin), live);
  const ok = !!how;
  if (!ok) {
    await noteFail(key, rate);
    const left = MAX_TRIES - (rate.n + 1);
    res.status(401).json({ error: "PIN이 올바르지 않아요." + (left <= 3 && left > 0 ? " (" + left + "번 남음)" : "") });
    return;
  }
  await clearFails(key);
  const cids = live.map((x) => x.cls.id);
  const token = createCustomToken("s_" + nm, { role: "student", sname: nm, cids });
  // 초기 비번으로 들어왔으면 앱이 비밀번호 변경을 먼저 시킨다.
  // 이름만 알면 1234로 들어가지는 계정이 남아 있는 게 지금 가장 큰 구멍이다.
  res.status(200).json({ token, name: nm, cids, mustChangePin: how === "default",
                         // 반이 아직 없다. 앱이 «이름이 틀렸다» 가 아니라
                         // «아직 반이 없다» 고 말하게 하려고 알려준다.
                         noClass: !live.length });
}

// 앱의 verifyPersonPin과 같은 순서: 통합 PIN → 반별 구 PIN(성공 시 이전) → 기본값
// 통과하면 어느 경로였는지를 문자열로, 실패하면 "" 를 준다.
// "default" 면 초기 비번을 그대로 쓰는 중이라는 뜻이다.
async function verifyStudentPin(nm, pin, live) {
  const g = await getDoc("userPins/" + encodeURIComponent(nm));
  if (g && g.pin) return pin === String(g.pin) ? "personal" : "";

  for (const x of live) {
    const sp = await getDoc("classes/" + x.cls.id + "/students/" + x.member.id);
    if (sp && sp.pin && pin === String(sp.pin)) {
      try { await patchDoc("userPins/" + encodeURIComponent(nm), { pin }); } catch (e) {}
      return "legacy";
    }
  }
  // 반이 없는 학생(아직 배정 전)은 기댈 defaultPin 이 없다. 기본값으로 본다 —
  // 안 그러면 명단에 있는데 PIN 이 틀렸다고 나온다.
  const defs = live.length ? live.map((x) => String(x.member.defaultPin || DEFAULT_PIN))
                           : [DEFAULT_PIN];
  if (defs.indexOf(pin) >= 0) return "default";
  return "";
}

// 초기 비번을 그대로 쓰는 학생 목록. 선생님만 부를 수 있다 —
// 아무나 받아가면 "이 이름들은 1234로 들어간다"는 지도가 되어버린다.
// 지금 화면에서 부르는 곳은 없다 (선생님 홈의 안내 배너를 없앴다).
// 규격은 그대로 두었다 — 초기 PIN 현황이 다시 필요해지면 붙이면 된다.
async function defaultPinReport(res, { idToken }) {
  const claims = await verifyIdToken(idToken);
  if (!claims || (claims.role !== "teacher" && claims.role !== "owner")) {
    res.status(403).json({ error: "권한이 없습니다" }); return;
  }
  let allowed = null; // null = 전체(관리자)
  if (claims.role !== "owner") {
    const t = await getDoc("teachers/" + claims.tid);
    allowed = (t && t.classIds) || [];
  }
  const classes = (await listDocs("classes")).filter(
    (c) => !classEnded(c) && (allowed === null || allowed.indexOf(c.id) >= 0));

  // 통합 PIN을 가진 이름들을 한 번에 받아온다 (학생마다 따로 읽으면 읽기 수가 폭증한다)
  const personal = new Set((await listDocs("userPins")).filter((d) => d.pin).map((d) => norm(d.id)));

  const out = [];
  for (const c of classes) {
    const legacy = {};
    try { (await listDocs("classes/" + c.id + "/students")).forEach((d) => { if (d.pin) legacy[d.id] = 1; }); }
    catch (e) {}
    const names = (c.roster || [])
      .filter((r) => !r.teacher && !personal.has(norm(r.name)) && !legacy[r.id])
      .map((r) => r.name);
    if (names.length) out.push({ cid: c.id, cname: c.name, names });
  }
  const total = out.reduce((n, g) => n + g.names.length, 0);
  res.status(200).json({ total, groups: out });
}

// 학생 비밀번호 변경. userPins는 클라이언트가 못 쓰므로 여기를 거친다.
// 지금 PIN을 함께 받는다 — 로그인된 브라우저를 잠깐 빌린 사람이 비번을 바꿔버리는 걸 막는다.
// 학생 PIN 초기화 — 선생님이 «비번 까먹었어요» 를 받아줄 자리.
//
// 지우는 것으로 초기화한다. 새 값을 넣지 않는다 —
//   userPins/{이름}                     개인 PIN. 이걸 지우면
//   classes/{반}/students/{자리}.pin    옛 반별 PIN. 이것도 지워야 한다
//   → 남는 것은 반 명단의 defaultPin(없으면 1234)뿐이고,
//     그걸로 들어오면 앱이 mustChangePin 으로 새 PIN 을 먼저 받는다.
//
// 옛 반별 PIN 을 안 지우면 «초기화했는데 옛 비번으로 계속 들어가진다» 가 된다.
// verifyStudentPin 이 개인 → 반별 → 기본 순으로 보기 때문이다.
//
// 담임은 **자기 반 학생만** 초기화한다 (개인정보보호법 · 취합표준 6항).
async function resetStudentPin(res, { idToken, name }) {
  const claims = await verifyIdToken(idToken);
  if (!claims || (claims.role !== "teacher" && claims.role !== "owner")) {
    res.status(403).json({ error: "권한이 없습니다" }); return;
  }
  const nm = norm(name);
  if (!nm) { res.status(400).json({ error: "이름을 넘겨주세요" }); return; }

  let allowed = null;                       // null = 전체(관리자)
  if (claims.role !== "owner") {
    const t = await getDoc("teachers/" + claims.tid);
    allowed = (t && t.classIds) || [];
  }

  const classes = await listDocs("classes");
  const mine = [];                          // 이 이름이 든, 내가 볼 수 있는 반
  for (const c of classes) {
    if (allowed && allowed.indexOf(c.id) < 0) continue;
    const m = (c.roster || []).find((r) => norm(r.name) === nm && !r.teacher);
    if (m) mine.push({ cls: c, member: m });
  }
  // ⚠ 반 명단에만 있는 게 아니다. 학생 명단에 만들어 놓고 아직 반에 안 넣은 학생도
  //    비번을 까먹는다 — 로그인도 그래서 고쳤다. 여기서도 students 를 같이 본다.
  let people = [];
  if (!mine.length) {
    people = (await listDocs("students")).filter((p) => norm(p.name) === nm);
    if (!people.length) {
      res.status(404).json({ error: "그 이름을 찾을 수 없어요" }); return;
    }
    // 반이 없는 학생은 «담당 반» 으로 가릴 수가 없다. 관리자이거나,
    // 학생 명단에 내가 담임으로 적힌 경우만 연다.
    if (claims.role !== "owner" && !people.some((p) => p.homeroom === claims.tid)) {
      res.status(403).json({ error: "아직 반이 없는 학생이에요. 관리자나 담임 선생님이 해주셔야 해요" });
      return;
    }
  }
  // ⚠ 이름이 겹치면 누구 것을 지우는지 알 수 없다. PIN 은 이름 하나에 하나뿐이라
  //    한 사람만 초기화할 방법이 없다 — 동명이인은 이름을 A·B·C 로 갈라야 한다.
  const dup = mine.length ? mine.filter((x) => x.member.pid).map((x) => x.member.pid)
                          : people.map((p) => p.id);
  if (new Set(dup).size > 1) {
    res.status(409).json({ error: "같은 이름이 둘 이상이에요. 이름을 A·B·C 로 나눈 뒤 다시 해주세요" });
    return;
  }

  await deleteDoc("userPins/" + encodeURIComponent(nm));
  for (const x of mine) {
    await deleteDoc("classes/" + x.cls.id + "/students/" + x.member.id);
  }
  // 반이 없으면 기댈 defaultPin 도 없다. 로그인도 이때는 기본값으로 본다.
  const def = String((mine.length && mine[0].member.defaultPin) || DEFAULT_PIN);
  res.status(200).json({ ok: true, name: nm, pin: def,
                         classes: mine.map((x) => x.cls.name),
                         noClass: !mine.length });
}

async function changePin(res, { name, oldPin, newPin }) {
  const nm = norm(name);
  if (!nm || !/^\d{4}$/.test(String(newPin || ""))) {
    res.status(400).json({ error: "새 PIN 4자리를 입력해주세요" }); return;
  }
  const key = "c:" + nm;
  const rate = await checkRate(key);
  if (!rate.ok) { res.status(429).json({ error: "시도가 너무 많아요. 10분 뒤에 다시 해주세요." }); return; }

  const classes = await listDocs("classes");
  const live = [];
  for (const c of classes) {
    if (classEnded(c)) continue;
    const m = (c.roster || []).find((r) => norm(r.name) === nm);
    if (m) live.push({ cls: c, member: m });
  }
  // ⚠ 반 명단만 보면 안 된다. 반이 아직 없는 학생도 초기 PIN 을 바꿔야 한다 —
  //    로그인·PIN 초기화도 같은 이유로 고쳤다. 여기가 그 네 번째 자리였다.
  //    (반 없는 학생은 verifyStudentPin 이 기본값 1234 로 봐준다)
  if (!live.length) {
    const people = await listDocs("students");
    if (!people.some((p) => norm(p.name) === nm)) {
      res.status(404).json({ error: "명단에 없는 이름이에요" }); return;
    }
  }

  if (!(await verifyStudentPin(nm, String(oldPin || ""), live))) {
    await noteFail(key, rate);
    res.status(401).json({ error: "지금 쓰는 PIN이 올바르지 않아요" }); return;
  }
  await clearFails(key);
  await patchDoc("userPins/" + encodeURIComponent(nm), { pin: String(newPin), time: Date.now() });
  res.status(200).json({ ok: true });
}

// 지금 걸려 있는 보안 규칙에 무엇이 들어 있는지 확인한다.
// 규칙 원문은 저장소에 공개돼 있으므로 항목 유무만 돌려줘도 새는 것이 없다.
// 로그인 없이도 부를 수 있게 둔다 — 규칙이 안 걸려 로그인이 막혔을 때가 정작 확인이 필요한 때다.
// 방금 만든 반을 만든 사람의 담당으로 넣는다.
//
// 왜 서버에서 하나: 담당 반은 teachers/{tid}.classIds 에 있고, 규칙의 teaches()가
// 그걸 보고 쓰기 권한을 준다. 그래서 선생님이 자기 문서의 classIds를 직접 쓰게 열면
// **아무 반 id나 적어 넣어 남의 반 편집 권한을 가져갈 수 있다.**
// 여기서는 반 문서의 createdBy가 본인일 때만, 그 반 하나만 더한다.
async function claimClass(res, { idToken, cid }) {
  const claims = await verifyIdToken(idToken);
  if (!claims || (claims.role !== "teacher" && claims.role !== "owner")) {
    res.status(403).json({ error: "권한이 없습니다" }); return;
  }
  const tid = claims.tid;
  if (!tid || !cid) { res.status(400).json({ error: "잘못된 요청입니다" }); return; }

  const c = await getDoc("classes/" + cid);
  if (!c) { res.status(404).json({ error: "없는 반입니다" }); return; }
  if (String(c.createdBy || "") !== String(tid)) {
    res.status(403).json({ error: "본인이 만든 반이 아닙니다" }); return;
  }
  const t = await getDoc("teachers/" + tid);
  if (!t) { res.status(404).json({ error: "없는 선생님입니다" }); return; }

  const ids = Array.isArray(t.classIds) ? t.classIds.slice() : [];
  if (ids.indexOf(cid) < 0) {
    ids.push(cid);
    await patchDoc("teachers/" + tid, { classIds: ids });
  }
  res.status(200).json({ ok: true, classIds: ids });
}

async function rulesCheck(res) {
  try {
    const r = await getPublishedRules();
    const has = (needle) => r.source.indexOf(needle) >= 0;
    const count = (needle) => r.source.split(needle).length - 1;
    res.status(200).json({
      updated: r.updated,
      항목: {
        "students(학생 명단)": has("match /students/"),
        "exams(내신)": has("match /exams/"),
        "appConfig(회차·학교목록)": has("match /appConfig/"),
        "config/flyer(안내문 초안)": has("match /config/flyer"),
        "익명차단(role 확인)": has("request.auth.token.role"),
        "반 생성(선생님 누구나)": has("request.resource.data.createdBy"),
        "반 삭제(관리자만)": has("allow delete: if isOwner()"),
        // 콘솔에 붙여넣을 때 전체 교체가 안 되면 옛 규칙이 아래에 남는다.
        // 그러면 같은 블록이 두 번 들어가고, Firestore는 규칙을 OR로 합치므로
        // 옛 허용이 새 제한을 덮어쓴다 — 통과한 것처럼 보이면서 실제로는 다 열린다.
        "중복 없음(전체 교체됨)": count("match /databases/") === 1 && count("match /classes/") === 1,
      },
      길이: r.source.length,
    });
  } catch (e) {
    res.status(500).json({ error: "규칙을 읽지 못했습니다: " + e.message });
  }
}

// 선생님이 자기 PIN을 바꾼다. 관리자도 자기 것은 여기서만 바꿀 수 있다
// (선생님 관리 화면의 PIN 초기화는 "다른" 선생님용이라 본인은 대상이 아니다).
// 지금 PIN을 반드시 함께 받는다 — 로그인된 화면을 잠깐 빌린 사람이 못 바꾸게.
async function changeTeacherPin(res, { tid, oldPin, newPin }) {
  if (!tid || !/^\d{4}$/.test(String(newPin || ""))) {
    res.status(400).json({ error: "새 PIN 4자리를 입력해주세요" }); return;
  }
  if (String(oldPin || "") === String(newPin)) {
    res.status(400).json({ error: "지금 쓰는 PIN과 다른 값으로 정해주세요" }); return;
  }
  const key = "tc:" + tid;
  const rate = await checkRate(key);
  if (!rate.ok) { res.status(429).json({ error: "시도가 너무 많아요. 10분 뒤에 다시 해주세요." }); return; }

  const t = await getDoc("teachers/" + tid);
  if (!t) { res.status(404).json({ error: "없는 선생님입니다" }); return; }
  if (String(t.pin || "") !== String(oldPin || "")) {
    await noteFail(key, rate);
    res.status(401).json({ error: "지금 쓰는 PIN이 올바르지 않습니다" }); return;
  }
  await clearFails(key);
  await patchDoc("teachers/" + tid, { pin: String(newPin) });
  res.status(200).json({ ok: true });
}

// 선생님 가입 신청. 승인 전에는 로그인이 안 된다.
async function register(res, { name, pin }) {
  const nm = String(name || "").trim();
  if (!nm || !/^\d{4}$/.test(String(pin || ""))) {
    res.status(400).json({ error: "이름과 PIN 4자리를 입력해주세요" }); return;
  }
  const ts = await listDocs("teachers");
  if (ts.some((t) => norm(t.name) === norm(nm))) {
    res.status(409).json({ error: "이미 등록된 이름입니다" }); return;
  }
  const tid = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await patchDoc("teachers/" + tid, {
    name: nm, pin: String(pin), classIds: [], role: "teacher", status: "pending", time: Date.now(),
  });
  res.status(200).json({ ok: true });
}
