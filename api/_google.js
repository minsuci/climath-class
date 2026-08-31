// Google 서비스 계정으로 (1) Firebase 커스텀 토큰 발급 (2) Firestore REST 접근.
//
// firebase-admin을 안 쓴다. 루트에 package.json이 생기면 Vercel 빌드 동작이 바뀌는데
// (CLAUDE.md 참고) 이 앱은 "빌드 없는 단일 HTML"이 전제라 그 위험을 지지 않는다.
// 커스텀 토큰은 규격이 공개된 JWT일 뿐이고 Firestore에는 REST가 있어서, node 기본
// crypto만으로 전부 된다.
//
// 필요한 환경변수 (Vercel → Settings → Environment Variables):
//   FIREBASE_SERVICE_ACCOUNT = 서비스 계정 JSON 전체를 한 줄로 붙여넣은 것
//   (Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성)

import crypto from "crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const IDENTITY_AUD =
  "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit";

let _sa = null;
export function serviceAccount() {
  if (_sa) return _sa;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT 환경변수가 없습니다");
  let j;
  try { j = JSON.parse(raw); }
  catch (e) { throw new Error("FIREBASE_SERVICE_ACCOUNT가 올바른 JSON이 아닙니다"); }
  // Vercel 환경변수에 넣을 때 줄바꿈이 \n 두 글자로 들어가는 경우가 많다
  if (j.private_key && j.private_key.indexOf("\\n") >= 0) {
    j.private_key = j.private_key.replace(/\\n/g, "\n");
  }
  if (!j.client_email || !j.private_key || !j.project_id) {
    throw new Error("서비스 계정 JSON에 client_email/private_key/project_id가 필요합니다");
  }
  _sa = j;
  return _sa;
}

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function signJwt(payload) {
  const sa = serviceAccount();
  const header = { alg: "RS256", typ: "JWT" };
  const body = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(payload));
  const sig = crypto.createSign("RSA-SHA256").update(body).sign(sa.private_key);
  return body + "." + b64url(sig);
}

// ---- (1) 커스텀 토큰: 클라이언트가 signInWithCustomToken()으로 받는다 ----
// claims는 그대로 request.auth.token 에 실려 보안 규칙에서 읽힌다.
// 규격상 claims 전체가 1000바이트를 넘으면 안 되므로 작게 유지할 것.
export function createCustomToken(uid, claims) {
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    iss: sa.client_email,
    sub: sa.client_email,
    aud: IDENTITY_AUD,
    iat: now,
    exp: now + 3600,
    uid: String(uid),
    claims: claims || {},
  });
}

// ---- (1-b) 클라이언트가 보낸 ID 토큰 검증 ----
// 선생님 전용 엔드포인트를 만들려면 "누가 부르는지"를 서버가 알아야 한다.
// 구글 공개키로 서명을 확인하므로 위조할 수 없다. 클라이언트가 보낸 role을
// 그냥 믿으면 안 된다 — 그건 다시 클라이언트를 믿는 것이다.
const CERT_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
let _certs = null; // { at, map }

async function googleCerts() {
  if (_certs && Date.now() - _certs.at < 60 * 60 * 1000) return _certs.map;
  const r = await fetch(CERT_URL);
  if (!r.ok) throw new Error("구글 공개키를 못 받았습니다");
  const map = await r.json();
  _certs = { at: Date.now(), map };
  return map;
}

// 통과하면 claims를, 아니면 null을 준다 (던지지 않는다 — 호출부에서 403으로 처리)
export async function verifyIdToken(idToken) {
  try {
    const sa = serviceAccount();
    const parts = String(idToken || "").split(".");
    if (parts.length !== 3) return null;
    const dec = (x) => JSON.parse(Buffer.from(x.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const header = dec(parts[0]);
    const payload = dec(parts[1]);
    if (header.alg !== "RS256" || !header.kid) return null;

    const certs = await googleCerts();
    const cert = certs[header.kid];
    if (!cert) return null;

    const sig = Buffer.from(parts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const ok = crypto.createVerify("RSA-SHA256").update(parts[0] + "." + parts[1]).verify(cert, sig);
    if (!ok) return null;

    const now = Math.floor(Date.now() / 1000);
    if (payload.aud !== sa.project_id) return null;
    if (payload.iss !== "https://securetoken.google.com/" + sa.project_id) return null;
    if (!payload.exp || payload.exp < now) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// ---- (2) Firestore REST ----
const _toks = {}; // scope -> { value, exp }
async function accessToken(scope) {
  const sc = scope || "https://www.googleapis.com/auth/datastore";
  const now = Math.floor(Date.now() / 1000);
  const _tok = _toks[sc];
  if (_tok && _tok.exp > now + 60) return _tok.value;
  const sa = serviceAccount();
  const assertion = signJwt({
    iss: sa.client_email,
    scope: sc,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) {
    throw new Error("구글 토큰 발급 실패: " + (j.error_description || j.error || r.status));
  }
  _toks[sc] = { value: j.access_token, exp: now + (j.expires_in || 3600) };
  return _toks[sc].value;
}

// ---- (3) 실제로 게시된 보안 규칙 읽기 ----
// 규칙은 저장소에 커밋해도 콘솔에 붙여넣어야 적용된다. 그래서 "올렸나?"가 계속 헷갈렸다.
// 지금 걸려 있는 것을 서버에서 직접 확인한다 (읽기 전용).
export async function getPublishedRules() {
  const sa = serviceAccount();
  const t = await accessToken("https://www.googleapis.com/auth/firebase.readonly");
  const h = { Authorization: "Bearer " + t };
  const rel = await fetch(
    "https://firebaserules.googleapis.com/v1/projects/" + sa.project_id + "/releases/cloud.firestore",
    { headers: h });
  const relJ = await rel.json();
  if (!rel.ok) throw new Error((relJ.error && relJ.error.message) || ("release " + rel.status));
  const rs = await fetch("https://firebaserules.googleapis.com/v1/" + relJ.rulesetName, { headers: h });
  const rsJ = await rs.json();
  if (!rs.ok) throw new Error((rsJ.error && rsJ.error.message) || ("ruleset " + rs.status));
  const files = ((rsJ.source && rsJ.source.files) || []).map((f) => f.content || "").join("\n");
  return { updated: relJ.updateTime || rsJ.createTime || "", source: files };
}

const docBase = () => {
  const sa = serviceAccount();
  return "https://firestore.googleapis.com/v1/projects/" + sa.project_id +
         "/databases/(default)/documents";
};

// Firestore REST는 값에 타입이 붙어 온다 ({stringValue:"..."}). 평범한 JS 값으로 되돌린다.
function fromValue(v) {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromValue);
  if ("mapValue" in v) return fromFields(v.mapValue.fields || {});
  return null;
}
function fromFields(fields) {
  const out = {};
  for (const k of Object.keys(fields || {})) out[k] = fromValue(fields[k]);
  return out;
}
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === "object") return { mapValue: { fields: toFields(v) } };
  return { nullValue: null };
}
function toFields(obj) {
  const out = {};
  for (const k of Object.keys(obj || {})) out[k] = toValue(obj[k]);
  return out;
}

async function call(path, init) {
  const t = await accessToken();
  const r = await fetch(path, {
    ...init,
    headers: { Authorization: "Bearer " + t, "Content-Type": "application/json", ...(init && init.headers) },
  });
  if (r.status === 404) return null;
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = (j && j.error && j.error.message) || r.status;
    throw new Error("Firestore: " + msg);
  }
  return j;
}

// 문서 하나 읽기. 없으면 null. path 예: "teachers/abc123"
export async function getDoc(path) {
  const j = await call(docBase() + "/" + path, { method: "GET" });
  if (!j) return null;
  return { id: path.split("/").pop(), ...fromFields(j.fields || {}) };
}

// 컬렉션 전체 읽기. path 예: "teachers"
export async function listDocs(path) {
  const out = [];
  let pageToken = "";
  do {
    const url = docBase() + "/" + path + "?pageSize=300" + (pageToken ? "&pageToken=" + pageToken : "");
    const j = await call(url, { method: "GET" });
    if (!j) break;
    for (const d of j.documents || []) {
      out.push({ id: d.name.split("/").pop(), ...fromFields(d.fields || {}) });
    }
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return out;
}

// 문서 쓰기(부분 갱신). 넘긴 필드만 바꾼다.
export async function patchDoc(path, data) {
  const mask = Object.keys(data).map((k) => "updateMask.fieldPaths=" + encodeURIComponent(k)).join("&");
  await call(docBase() + "/" + path + "?" + mask, {
    method: "PATCH",
    body: JSON.stringify({ fields: toFields(data) }),
  });
}
