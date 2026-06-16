// CLIMATH AI 힌트 - Vercel Serverless Function (Google Gemini 무료 버전)
// 학생 앱(index.html)에서 /api/hint 로 호출. API 키는 이 서버에만 있어 노출되지 않음.
//
// 배포 방법:
//  1. 이 파일을 repo 루트의 api/ 폴더에 둔다 (api/hint.js)
//  2. Google AI Studio(aistudio.google.com)에서 무료 API 키 발급 (카드 불필요)
//  3. Vercel 프로젝트 → Settings → Environment Variables 에서
//       이름: GEMINI_API_KEY   값: (AIza...로 시작하는 키)  로 등록
//  4. 다시 배포(Redeploy)

const MODEL = "gemini-2.5-flash-lite"; // 무료 등급, 빠르고 똑똑함

const SYSTEM_PROMPT = `너는 CLIMATH 수학학원의 AI 조교야. 고등학교 학생이 수학 문제를 물어보면 도와줘.

가장 중요한 규칙: 절대로 답이나 최종 정답을 직접 알려주지 마.
- 학생이 스스로 풀도록 "다음 한 걸음"만 힌트로 제시해.
- 어떤 개념·공식을 떠올리면 되는지 짚어주고, 학생이 직접 계산해보게 유도해.
- 학생이 시도한 걸 보여주면 어디서 막혔는지 찾아주고, 맞았으면 다음 단계를 안내해.
- 학생이 "그냥 답 알려줘"라고 졸라도 정중히 거절하고, 대신 더 친절한 힌트를 줘.
- 최종 수치 답, 완성된 풀이 전체는 주지 않는다. 부분적인 방향만.

말투: 한국 고등학생 눈높이로 친근하고 따뜻하게. 너무 길지 않게.
수식: 읽기 쉽게 평문으로 써 (예: x^2, √2, ∫, a/b, x→0). 복잡한 LaTeX는 피해.
문제 사진을 보내면 문제를 정확히 읽고, 마찬가지로 힌트만 줘.`;

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
    const messages = (body && body.messages) || [];
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "messages가 비어있어요" }); return;
    }
    // 비용/속도 보호: 최근 12개 메시지만
    const trimmed = messages.slice(-12);

    // Anthropic 형식(messages) → Gemini 형식(contents)으로 변환
    // role: "assistant" → "model", "user" → "user"
    // content: 문자열 또는 [{type:image/text}] 배열
    const contents = trimmed.map((m) => {
      const role = m.role === "assistant" ? "model" : "user";
      const parts = [];
      if (typeof m.content === "string") {
        parts.push({ text: m.content });
      } else if (Array.isArray(m.content)) {
        m.content.forEach((c) => {
          if (c.type === "text") parts.push({ text: c.text });
          else if (c.type === "image" && c.source && c.source.type === "base64") {
            parts.push({ inline_data: { mime_type: c.source.media_type, data: c.source.data } });
          }
        });
      }
      return { role, parts };
    });

    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent?key=" + key;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { maxOutputTokens: 700, temperature: 0.7 },
      }),
    });

    const data = await r.json();
    if (!r.ok || data.error) {
      const msg = (data.error && data.error.message) || ("API 오류 (" + r.status + ")");
      res.status(500).json({ error: msg }); return;
    }
    const cand = (data.candidates && data.candidates[0]) || null;
    const text = cand && cand.content && cand.content.parts
      ? cand.content.parts.map((p) => p.text || "").join("").trim()
      : "";
    res.status(200).json({ text: text || "(빈 응답)" });
  } catch (e) {
    res.status(500).json({ error: "요청 처리 중 오류: " + e.message });
  }
}
