// 학원 운영DB(창구)로 보내는 문.
//
// 창구는 구글 앱스스크립트 웹앱이고 **토큰 하나로 열린다.**
// 그래서 브라우저에서 직접 부르면 안 된다 — index.html 은 로그인 없이도 받아지므로
// 토큰을 넣는 순간 누구나 학원 기록을 읽고 쓸 수 있게 된다.
// 여기(서버)에만 토큰을 두고, 선생님인지 확인한 뒤 대신 부른다.
//
// 규격: X:\클라이매쓰\AI업무\시스템\취합표준.md · 명세\명세-출결.md
//
// 필요한 환경변수 (Vercel):
//   OPSDB_URL    창구 주소 (…/exec)
//   OPSDB_TOKEN  창구 토큰
import { verifyIdToken, getDoc, patchDoc } from "./_google.js";

// 주소·토큰은 환경변수가 먼저다. 없으면 team/opsdb 에서 읽는다.
//
// team/ 은 보안 규칙에서 아무 데도 안 걸려 **어떤 클라이언트도 못 읽는다**
// (맨 끝 catch-all 이 전부 막는다). 서비스 계정만 통과하므로 서버 전용 서랍이다.
// 환경변수를 손댈 수 없을 때 여기에 넣으면 배포 없이 바로 돈다.
const CFG_PATH = "team/opsdb";
let _cfg = null;
async function config() {
  if (process.env.OPSDB_URL && process.env.OPSDB_TOKEN) {
    return { url: process.env.OPSDB_URL, token: process.env.OPSDB_TOKEN, where: "환경변수" };
  }
  if (_cfg) return _cfg;
  const d = await getDoc(CFG_PATH).catch(() => null);
  if (d && d.url && d.token) { _cfg = { url: d.url, token: d.token, where: "team/opsdb" }; return _cfg; }
  return null;
}

// 창구가 받는 것 중 **이 앱이 쓰는 것만** 연다.
// 통째로 열면 이 문이 곧 창구의 복사본이 된다 — 앱이 안 쓰는 기능까지
// 로그인만 하면 부를 수 있게 된다.
const READ = ["query", "attend_summary", "student_summary", "list", "match_students"];
const WRITE = ["import_rows", "record_attendance"];
const OK_ACTIONS = READ.concat(WRITE);

// 창구는 302 로 googleusercontent 에 답을 놔둔다. fetch 는 그 리다이렉트를
// GET 으로 따라가는데, POST 본문은 이미 전달된 뒤라 답을 받는 데는 문제가 없다.
async function call(cfg, payload) {
  const r = await fetch(cfg.url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ ...payload, token: cfg.token }),
    redirect: "follow",
  });
  const text = await r.text();
  try { return { ok: r.ok, body: JSON.parse(text) }; }
  catch (e) { return { ok: false, body: { ok: false, error: "창구가 JSON이 아닌 것을 돌려줬어요", 원문: text.slice(0, 400) } }; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST만 받습니다" }); return; }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const claims = await verifyIdToken(body.idToken);
    if (!claims || (claims.role !== "teacher" && claims.role !== "owner")) {
      res.status(403).json({ error: "권한이 없습니다" }); return;
    }

    // 주소·토큰 넣기 — 관리자만. 넣은 값은 다시 못 읽는다(꼬리 몇 자만 알려준다).
    if (body.setup) {
      if (claims.role !== "owner") { res.status(403).json({ error: "관리자만 넣을 수 있습니다" }); return; }
      const u = String(body.setup.url || ""), t = String(body.setup.token || "");
      if (!/^https:\/\/script\.google\.com\//.test(u) || !t) {
        res.status(400).json({ error: "주소는 script.google.com 이어야 하고 토큰이 있어야 합니다" }); return;
      }
      await patchDoc(CFG_PATH, { url: u, token: t, updated: Date.now() });
      _cfg = null;
      res.status(200).json({ ok: true, saved: true, tokenTail: "…" + t.slice(-4) }); return;
    }

    const cfg = await config();
    if (!cfg) {
      res.status(503).json({ error: "운영DB 주소·토큰이 아직 없어요 (OPSDB_URL·OPSDB_TOKEN 또는 team/opsdb)" });
      return;
    }

    const payload = body.payload || {};
    const action = String(payload.action || "");
    if (OK_ACTIONS.indexOf(action) < 0) {
      res.status(400).json({ error: "여기서 부를 수 없는 동작입니다: " + action }); return;
    }
    // ⚠ 클라이언트가 보낸 토큰은 무시한다. 서버 것만 쓴다.
    delete payload.token;

    // 담임은 자기 반만 기록·조회한다 (개인정보보호법 — 취합표준 6항).
    // 반 이름으로 오므로 담당 반 이름들과 대조한다. 관리자는 통과.
    if (claims.role !== "owner" && payload["반"]) {
      const t = await getDoc("teachers/" + claims.tid).catch(() => null);
      const ids = (t && t.classIds) || [];
      const names = [];
      for (const cid of ids) {
        const c = await getDoc("classes/" + cid).catch(() => null);
        if (c && c.name) names.push(c.name);
      }
      // 앱 반 이름과 창구 반 이름이 조금 다를 수 있어(«반» 유무) 느슨하게 본다
      const norm = (s) => String(s || "").replace(/\s|반$/g, "");
      if (!names.some((n) => norm(n) === norm(payload["반"]))) {
        res.status(403).json({ error: "담당하지 않은 반이에요: " + payload["반"] }); return;
      }
    }

    const r = await call(cfg, payload);
    res.status(r.ok ? 200 : 502).json(r.body);
  } catch (e) {
    console.error("[opsdb]", e);
    res.status(500).json({ error: "서버 오류: " + e.message });
  }
}
