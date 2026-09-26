// 실전 시험 — 결과 화면에서 번호를 누르면 그 문항 그림을 보여 준다.
//
// 채점(api/exam.js)과 파일을 가른 까닭: 학생이 시험을 보는 중에도 이쪽은 고쳐 배포할 수 있게.
// 제출 길에는 손대지 않는다.
//
// 저장 자리
//   examImgs/{examId}__{n}   { png: base64, w, h }  문제 그림
//   examImgs/{examId}__{n}s  해설 그림 (해설 쪽이 있는 시험지만)      — 규칙 맨 아래 «전부 거절» 에 걸려
//                            서비스 계정만 읽는다. 시험 전에 문제가 새지 않게
//
// 누가 받나: 선생님은 언제나. 학생은 **그 시험을 제출한 기록이 있을 때만** —
// 기록(examLogs)의 이름이 로그인한 이름과 같아야 한다.
//
// 넣기는 PC 도구로 (tools/exam-img.py, 도구 열쇠 team/tools.lessonKey)
import { verifyIdToken, getDoc, patchDoc, listDocs, deleteDoc } from "./_google.js";

const ID_RE = /^[0-9A-Za-z가-힣_.\-]{2,80}$/;
const imgPath = (examId, n, kind) => "examImgs/" + examId + "__" + n + (kind === "sol" ? "s" : "");

async function toolOk(k) {
  if (!k) return false;
  const d = await getDoc("team/tools").catch(() => null);
  return !!(d && d.lessonKey && d.lessonKey === k);
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST만 받습니다" }); return; }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const examId = String(body.examId || "");
    if (!ID_RE.test(examId)) { res.status(400).json({ error: "시험지 id 가 이상해요" }); return; }

    if (body.toolKey) {
      if (!(await toolOk(body.toolKey))) { res.status(403).json({ error: "도구 열쇠가 맞지 않아요" }); return; }
      if (body.action === "imgPut") {
        const n = Number(body.n), png = String(body.png || "");
        if (!Number.isInteger(n) || n <= 0) { res.status(400).json({ error: "번호가 이상해요" }); return; }
        if (!/^[A-Za-z0-9+/=]+$/.test(png) || png.length > 900000) { res.status(400).json({ error: "그림이 없거나 너무 커요" }); return; }
        await patchDoc(imgPath(examId, n, body.kind), { png, w: Number(body.w) || 0, h: Number(body.h) || 0, updated: Date.now() });
        res.status(200).json({ ok: true }); return;
      }
      if (body.action === "imgList") {
        const all = await listDocs("examImgs").catch(() => []);
        const ids = all.filter((d) => d.id.startsWith(examId + "__")).map((d) => d.id.split("__")[1]);
        const ns = ids.filter((x) => /^\d+$/.test(x)).map(Number).sort((a, b) => a - b);
        const sols = ids.filter((x) => /^\d+s$/.test(x)).map((x) => parseInt(x, 10)).sort((a, b) => a - b);
        res.status(200).json({ ok: true, ns, sols }); return;
      }
      if (body.action === "imgDel") {
        const all = await listDocs("examImgs").catch(() => []);
        const mine = all.filter((d) => d.id.startsWith(examId + "__"));
        for (const d of mine) await deleteDoc("examImgs/" + d.id);
        res.status(200).json({ ok: true, deleted: mine.length }); return;
      }
      // 학생이 막힐 때 확인용 — 서버가 그 기록을 어떻게 읽는지 그대로 보여 준다
      if (body.action === "peek") {
        const log = await getDoc("classes/" + String(body.cid) + "/days/" + String(body.date) + "/examLogs/" + String(body.rid)).catch((e) => ({ err: e.message }));
        const img = await getDoc(imgPath(examId, 1, "q")).catch((e) => ({ err: e.message }));
        res.status(200).json({ ok: true, log: log && { err: log.err, examId: log.examId, name: log.name, cid: log.cid, date: log.date },
                               img1: !!(img && img.png) }); return;
      }
      res.status(400).json({ error: "그런 동작이 없어요" }); return;
    }

    const claims = await verifyIdToken(body.idToken);
    if (!claims) { res.status(403).json({ error: "로그인이 풀렸어요. 다시 들어와 주세요." }); return; }
    const n = Number(body.n);
    if (!Number.isInteger(n) || n <= 0) { res.status(400).json({ error: "번호가 이상해요" }); return; }

    let teacher = claims.role === "teacher" || claims.role === "owner";
    // 학생 화면 «선생님 모드» (명단에 teacher 표시가 붙은 학생 계정) 도 선생님으로 본다
    if (!teacher && body.cid && (claims.cids || []).includes(String(body.cid))) {
      const cls = await getDoc("classes/" + String(body.cid)).catch(() => null);
      if (cls && (cls.roster || []).some((r) => r && r.teacher && r.name === claims.sname)) teacher = true;
    }
    if (!teacher) {
      // 그 시험을 **낸** 학생만. 기록의 이름이 로그인한 이름과 같은지 본다
      const cid = String(body.cid || ""), date = String(body.date || ""), rid = String(body.rid || "");
      if (!(claims.cids || []).includes(cid)) { res.status(403).json({ error: "그 반 학생이 아니에요" }); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[A-Za-z0-9_-]{6,40}$/.test(rid)) { res.status(400).json({ error: "기록이 이상해요" }); return; }
      const log = await getDoc("classes/" + cid + "/days/" + date + "/examLogs/" + rid).catch(() => null);
      // 어느 조건에서 막혔는지 남긴다 — 화면에는 한 문장, 서버 기록에는 까닭
      const why = !log ? "no-log" : log.examId !== examId ? "exam" : log.name !== claims.sname ? "name" : "";
      if (why) {
        console.log("[examimg] 403", why, cid, date, rid, examId, "| log:", log && log.examId, "| name-match:", !!log && log.name === claims.sname);
        res.status(403).json({ error: "제출한 시험만 문제를 볼 수 있어요 (" + why + ")" }); return;
      }
    }
    const sol = body.kind === "sol";
    const img = await getDoc(imgPath(examId, n, sol ? "sol" : "q")).catch(() => null);
    if (!img || !img.png) { res.status(404).json({ error: sol ? "이 시험지는 해설이 없어요" : "이 문항 그림은 아직 없어요" }); return; }
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.status(200).json({ ok: true, png: img.png, w: img.w || 0, h: img.h || 0 });
  } catch (e) {
    console.error("[examimg]", e);
    res.status(500).json({ error: "서버 오류: " + e.message });
  }
}
