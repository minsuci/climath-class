// CLIMATH 수업기록 초안 - Vercel Serverless Function (Google Gemini)
// 수업 로그의 받아쓴 원문을 학생별 수업기록으로 요약한다.
// 결과는 dailyNotes에 저장되고 학습관리 보고서에 그대로 실린다.
//
// api/hint.js 와 키(GEMINI_API_KEY)를 같이 쓰지만 프롬프트가 완전히 다르다.
// hint.js는 "답을 주지 마"가 핵심이고, 여기는 "일어난 일만 적어"가 핵심이다.

const MODEL = "gemini-2.5-flash-lite";

const SYSTEM_PROMPT = `너는 대치동 수학학원 선생님의 조교다.
수업 녹음을 받아쓴 원문을 받아서, 학부모에게 나갈 **수업기록**으로 정리한다.

정리 규칙:
- 3~5문장. 한 문단. 항목 나열이나 제목 없이 줄글로.
- **그 수업에서 실제로 다룬 것만** 쓴다. 원문에 없는 내용을 지어내지 마.
- 다룬 개념·문제 유형을 구체적인 수학 용어로 적는다. ("함수를 배웠습니다" ✗ / "무리함수의 정의역과 그래프 개형을 다뤘습니다" ○)
- 학생이 막혔거나 질문한 대목이 원문에 보이면 한 문장으로 덧붙인다.
- 과장하지 않는다. "열심히 했습니다" 같은 빈말은 쓰지 마.
- 받아쓰기라 음성 인식 오류가 섞여 있다. 수학적으로 말이 안 되는 단어는
  문맥으로 바로잡아 이해하되(예: "롯트"→"루트", "이차 함수"→"이차함수"), 확신이 없으면 그 부분은 빼라.
- 원문이 너무 짧거나 수업 내용이 안 보이면, 지어내지 말고
  "기록할 만한 수업 내용이 확인되지 않습니다."라고만 답한다.

말투: '~했습니다' 체. 담백하게.
수식 기호나 LaTeX는 쓰지 마. 학부모가 읽는 글이라 한글로 풀어 쓴다.`;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST만 허용돼요" }); return; }

  const key = process.env.GEMINI_API_KEY;
  if (!key) { res.status(500).json({ error: "서버에 API 키가 설정되지 않았어요 (GEMINI_API_KEY)" }); return; }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const text = (body && body.text ? String(body.text) : "").trim();
    const student = (body && body.student) || "";
    const units = Array.isArray(body && body.units) ? body.units.filter(Boolean) : [];
    if (text.length < 30) {
      res.status(400).json({ error: "받아쓴 내용이 너무 짧아요" }); return;
    }

    // 비용·속도 보호: 원문이 아주 길면 앞뒤를 살려 가운데를 줄인다
    const MAX = 24000;
    const src = text.length <= MAX
      ? text
      : text.slice(0, MAX * 0.6) + "\n…(중략)…\n" + text.slice(-MAX * 0.4);

    const prompt =
      (student ? `학생: ${student}\n` : "") +
      (units.length ? `판서한 단원: ${units.join(", ")}\n` : "") +
      `\n--- 수업 녹음 원문 ---\n${src}\n--- 원문 끝 ---\n\n` +
      `위 수업의 수업기록을 규칙대로 써라.`;

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 600 },
        }),
      }
    );

    if (!r.ok) {
      const t = await r.text();
      res.status(502).json({ error: "AI 호출 실패: " + t.slice(0, 300) });
      return;
    }
    const data = await r.json();
    const out = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    const note = out.map((p) => p.text || "").join("").trim();
    if (!note) { res.status(502).json({ error: "AI가 빈 답을 줬어요" }); return; }
    res.status(200).json({ note });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
