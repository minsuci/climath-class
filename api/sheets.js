// 팀장 대시보드(team.html)가 구글시트를 읽는 통로.
//
// 브라우저에서 시트를 직접 읽으려면 (1) 시트를 "링크가 있는 모든 사용자"로 열거나
// (2) 구글 OAuth 클라이언트를 따로 만들어야 한다. 둘 다 싫다 — 남이 만든 시트는
// 공개로 못 바꾸고, OAuth는 콘솔 설정이 한 겹 더 든다.
// 대신 앱이 이미 가진 서비스 계정으로 읽는다. 시트를 그 계정 이메일에 "뷰어"로
// 공유하기만 하면 된다 (whoami 가 그 이메일을 알려준다).
//
// 누가 부르는지는 Firebase ID 토큰으로 확인하고 **owner만** 통과시킨다.
// 시트에는 학생 이름·성적·상담 내용이 있다. 선생님 전체에도 열지 않는다.
//
// 요청: POST { idToken, action: "whoami" | "meta" | "values", spreadsheetId?, range? }
// 처음 쓸 때 구글 클라우드 콘솔에서 이 프로젝트의 Google Sheets API 를 켜야 한다.
// 안 켜져 있으면 구글이 403 으로 알려주고, 여기서 그 뜻을 한국어로 풀어 보낸다.

import { serviceAccount, verifyIdToken, googleAccessToken } from "./_google.js";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const BASE = "https://sheets.googleapis.com/v4/spreadsheets/";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST만 받습니다" }); return; }
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  body = body || {};

  try {
    const claims = await verifyIdToken(body.idToken);
    if (!claims || claims.role !== "owner") { res.status(403).json({ error: "관리자만 쓸 수 있습니다" }); return; }

    const sa = serviceAccount();
    if (body.action === "whoami") { res.status(200).json({ email: sa.client_email, project: sa.project_id }); return; }

    const id = String(body.spreadsheetId || "").trim();
    if (!/^[A-Za-z0-9_-]{20,}$/.test(id)) { res.status(400).json({ error: "시트 id가 이상합니다" }); return; }
    const token = await googleAccessToken(SCOPE);
    const h = { Authorization: "Bearer " + token };

    if (body.action === "meta") {
      const r = await fetch(BASE + id + "?fields=properties.title,sheets.properties(title,index,gridProperties(rowCount,columnCount))", { headers: h });
      const j = await r.json().catch(() => null);
      if (!r.ok) { res.status(r.status).json({ error: explain(r.status, j, sa) }); return; }
      res.status(200).json({
        title: j.properties && j.properties.title,
        tabs: (j.sheets || []).map((s) => ({
          title: s.properties.title, index: s.properties.index,
          rows: s.properties.gridProperties && s.properties.gridProperties.rowCount,
          cols: s.properties.gridProperties && s.properties.gridProperties.columnCount,
        })),
      });
      return;
    }

    if (body.action === "values") {
      const range = String(body.range || "A1:AZ300");
      const r = await fetch(BASE + id + "/values/" + encodeURIComponent(range) +
        "?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING", { headers: h });
      const j = await r.json().catch(() => null);
      if (!r.ok) { res.status(r.status).json({ error: explain(r.status, j, sa) }); return; }
      res.status(200).json({ range: j.range, values: j.values || [] });
      return;
    }

    res.status(400).json({ error: "알 수 없는 요청입니다" });
  } catch (e) {
    console.error("[sheets]", e);
    res.status(500).json({ error: "서버 오류: " + e.message });
  }
}

// 구글이 주는 오류를 "그래서 뭘 하면 되는지"로 바꾼다.
function explain(status, j, sa) {
  const msg = (j && j.error && j.error.message) || ("" + status);
  if (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) {
    return "Google Sheets API가 꺼져 있습니다. 구글 클라우드 콘솔에서 프로젝트 " + sa.project_id +
      " 의 Sheets API를 켜 주세요. (https://console.cloud.google.com/apis/library/sheets.googleapis.com?project=" + sa.project_id + ")";
  }
  if (status === 403) return "이 시트를 " + sa.client_email + " 에게 '뷰어'로 공유해 주세요.";
  if (status === 404) return "시트를 찾을 수 없습니다. 주소의 id를 확인해 주세요.";
  if (/Unable to parse range/i.test(msg)) return "탭 이름이나 범위가 맞지 않습니다: " + msg;
  return msg;
}
