// 강의노트를 누가 봤는지 남긴다.
//
// 왜 서버인가 — 보안 규칙은 noteUnits 아래를 **선생님만 쓰게** 막아 두었다.
// 학생이 직접 쓰게 하려면 규칙을 고쳐야 하는데, 규칙은 콘솔에 붙여넣어야 적용된다.
// 안 붙여넣으면 조회가 조용히 하나도 안 쌓인다 — 그런 실패가 제일 나쁘다.
// 여기서 서비스 계정으로 쓰면 배포만으로 바로 돈다.
//
// 저장 자리: classes/{cid}/noteUnits/{uid}/files/{fid}/views/{sid}
//            { name, n, first, last }
import { verifyIdToken, getDoc, patchDoc } from "./_google.js";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST만 받습니다" }); return; }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const claims = await verifyIdToken(body.idToken);
    if (!claims) { res.status(403).json({ error: "권한이 없습니다" }); return; }

    const cid = String(body.cid || ""), uid = String(body.uid || "");
    const fid = String(body.fid || ""), sid = String(body.sid || "");
    if (!cid || !uid || !fid || !sid) { res.status(400).json({ error: "빠진 값이 있습니다" }); return; }

    // 선생님이 자기 노트를 열어본 것은 **세지 않는다.** 세면 «학생이 복습했나» 를
    // 보려고 만든 숫자가 내가 확인차 눌러본 횟수로 채워진다.
    if (claims.role !== "student") { res.status(200).json({ ok: true, counted: false, why: "선생님" }); return; }

    // 학생 토큰에는 학생ID가 없다(이름과 소속 반만). 그래서 반 명단에서
    // 그 자리(sid)의 이름이 토큰의 이름과 같은지 본다 — 남의 이름으로 못 남기게.
    if (!(claims.cids || []).includes(cid)) { res.status(403).json({ error: "그 반 학생이 아닙니다" }); return; }
    const cls = await getDoc("classes/" + cid).catch(() => null);
    if (!cls) { res.status(404).json({ error: "반이 없습니다" }); return; }
    const row = (cls.roster || []).find((r) => r && r.id === sid);
    if (!row || row.name !== claims.sname) {
      res.status(403).json({ error: "명단과 이름이 맞지 않습니다" }); return;
    }

    const path = "classes/" + cid + "/noteUnits/" + uid + "/files/" + fid + "/views/" + sid;
    const cur = await getDoc(path).catch(() => null);
    const now = Date.now();
    await patchDoc(path, {
      name: row.name,
      n: ((cur && cur.n) || 0) + 1,
      first: (cur && cur.first) || now,
      last: now,
    });
    res.status(200).json({ ok: true, counted: true, n: ((cur && cur.n) || 0) + 1 });
  } catch (e) {
    console.error("[noteview]", e);
    res.status(500).json({ error: "서버 오류: " + e.message });
  }
}
