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

import { createCustomToken, getDoc, listDocs, patchDoc } from "./_google.js";

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
  if (!found.length) {
    await noteFail(key, rate);
    res.status(404).json({ error: "명단에 없는 이름이에요. 띄어쓰기 없이 정확히 입력했는지 확인해주세요." });
    return;
  }
  const live = found.filter((x) => !classEnded(x.cls));
  if (!live.length) {
    res.status(403).json({ error: "수강이 종료된 반이에요. 기록은 보관되어 있으니 선생님께 문의해주세요." });
    return;
  }

  const ok = await verifyStudentPin(nm, String(pin), live);
  if (!ok) {
    await noteFail(key, rate);
    const left = MAX_TRIES - (rate.n + 1);
    res.status(401).json({ error: "PIN이 올바르지 않아요." + (left <= 3 && left > 0 ? " (" + left + "번 남음)" : "") });
    return;
  }
  await clearFails(key);
  const cids = live.map((x) => x.cls.id);
  const token = createCustomToken("s_" + nm, { role: "student", sname: nm, cids });
  res.status(200).json({ token, name: nm, cids });
}

// 앱의 verifyPersonPin과 같은 순서: 통합 PIN → 반별 구 PIN(성공 시 이전) → 기본값
async function verifyStudentPin(nm, pin, live) {
  const g = await getDoc("userPins/" + encodeURIComponent(nm));
  if (g && g.pin) return pin === String(g.pin);

  for (const x of live) {
    const sp = await getDoc("classes/" + x.cls.id + "/students/" + x.member.id);
    if (sp && sp.pin && pin === String(sp.pin)) {
      try { await patchDoc("userPins/" + encodeURIComponent(nm), { pin }); } catch (e) {}
      return true;
    }
  }
  for (const x of live) {
    if (pin === String(x.member.defaultPin || DEFAULT_PIN)) return true;
  }
  return false;
}

// 학생 비밀번호 변경. userPins는 클라이언트가 못 쓰므로 여기를 거친다.
// 지금 PIN을 함께 받는다 — 로그인된 브라우저를 잠깐 빌린 사람이 비번을 바꿔버리는 걸 막는다.
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
  if (!live.length) { res.status(404).json({ error: "명단에 없는 이름이에요" }); return; }

  if (!(await verifyStudentPin(nm, String(oldPin || ""), live))) {
    await noteFail(key, rate);
    res.status(401).json({ error: "지금 쓰는 PIN이 올바르지 않아요" }); return;
  }
  await clearFails(key);
  await patchDoc("userPins/" + encodeURIComponent(nm), { pin: String(newPin), time: Date.now() });
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
