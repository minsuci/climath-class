// 이름 감지 로직만 떼어내 검증한다.
// 기준은 볼트 [[2026-08-13 개진반 녹화본 학생별 분리]]에 적힌 실제 오인식 사례.
//   실행: node tools/test-detect.mjs
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "index.html"), "utf8");

// 순수 함수 구간만 잘라 실행한다 (React·Firestore에 의존하지 않는 부분)
const from = html.indexOf("const CL_PALETTE");
const to = html.indexOf("async function clMakeNote");
if (from < 0 || to < 0) { console.error("실패: 감지 함수 구간을 찾지 못했습니다"); process.exit(1); }
const code = html.slice(from, to);

const sandbox = {};
new Function("exports", code +
  "\nObject.assign(exports,{clJamo,clSim,clDetect,clCountUtt,clSegments,clSplitTranscript,CL_CLOSED,CL_OPEN});")(sandbox);
const { clSim, clDetect, clCountUtt, clSplitTranscript, CL_CLOSED, CL_OPEN } = sandbox;

const people = [
  { sid: "a", name: "승훈", aliases: [], units: ["유리함수", "무리식과 무리함수"] },
  { sid: "b", name: "지오", aliases: [], units: ["여러 가지 적분법", "도활(2)"] },
  { sid: "c", name: "태경", aliases: [], units: ["도형의 방정식"] },
];

let fail = 0;
function chk(label, got, want) {
  const ok = got === want;
  if (!ok) fail++;
  console.log((ok ? "  OK   " : "  실패 ") + label + "  →  " + got + (ok ? "" : "  (기대: " + want + ")"));
}

console.log("\n[자모 유사도] 볼트에 기록된 실제 오인식");
[["지오", "지옥"], ["승훈", "성훈"], ["승훈", "승우"], ["태경", "세경"], ["태경", "태경"]]
  .forEach(([a, b]) => console.log("  " + a + " vs " + b + "  =  " + clSim(a, b).toFixed(3)));

console.log("\n[이름 감지] 자막이 틀리게 받아써도 잡히는가");
chk("'지옥이 이거 적분으로 풀어봐'", (clDetect("지옥이 이거 적분으로 풀어봐", people) || {}).name, "지오");
chk("'성훈아 여기 분모를'",        (clDetect("성훈아 여기 분모를", people) || {}).name, "승훈");
// 승훈↔승우는 0.667. 태경↔세경 0.600과 너무 가까워 문턱을 못 내린다.
// 문턱 대신 별칭으로 해결하는 게 맞다 — 오탐 하나가 오탭 하나보다 비싸다.
chk("'승우 이거 다시' (별칭 없이)", (clDetect("승우 이거 다시", people) || {}).name || "없음", "없음");
const withAlias = people.map((p) => (p.sid === "a" ? { ...p, aliases: ["승우", "성훈"] } : p));
chk("'승우 이거 다시' (별칭 등록)", (clDetect("승우 이거 다시", withAlias) || {}).name, "승훈");

console.log("\n[오탐 방지] 사람 이름이 아닌 것");
chk("'세 개는' → 세경에는 (태경 아님)", (clDetect("세경에는 이렇게 두고", people) || {}).name || "없음", "없음");
chk("'그러니까 이렇게 되죠'",            (clDetect("그러니까 이렇게 되죠", people) || {}).name || "없음", "없음");

console.log("\n[단원 감지] 이름을 안 부르고 판서만 해도");
chk("'여러 가지 적분법 들어갑니다'", (clDetect("자 여러 가지 적분법 들어갑니다", people) || {}).name, "지오");
chk("'무리식과 무리함수 시작'",      (clDetect("무리식과 무리함수 시작할게", people) || {}).name, "승훈");

console.log("\n[수업 계량 지표] 발화 단위로 센다");
const utt = [
  { t: 1, text: "자 알겠지" }, { t: 2, text: "이해했어" }, { t: 3, text: "맞죠" },
  { t: 4, text: "왜 그런지 말해봐" },          // 패턴 둘이 걸려도 요구는 하나
  { t: 5, text: "어디서 막혔어" },
  { t: 6, text: "30초 줄테니 한 줄로 써봐" },
  { t: 7, text: "이차함수는 전부 닮음이야" },   // 어느 쪽도 아님
];
chk("폐쇄형 3발화", clCountUtt(utt, CL_CLOSED), 3);
chk("개방형 3발화", clCountUtt(utt, CL_OPEN), 3);

console.log("\n[전사 분배] 어느 말이 누구에게 한 말인가");
const segs = [
  { sid: "a", name: "승훈", kind: "lesson", unit: "무리함수", start: 0,   end: 600 },
  { sid: null, name: "",   kind: "mic",    unit: "",        start: 600, end: 900 },
  { sid: "b", name: "지오", kind: "lesson", unit: "적분",     start: 900, end: 1500 },
  { sid: "c", name: "태경", kind: "qa",     unit: "",         start: 1500, end: 1600 },
];
const tr = [
  { t: 10,   text: "무리함수 정의역부터" },      // 승훈
  { t: 590,  text: "여기까지 하고" },            // 승훈
  { t: 700,  text: "마이크 꺼진 구간 잡담" },     // 버림
  { t: 1000, text: "치환적분 들어갑니다" },       // 지오
  { t: 1550, text: "태경이 질문 응대" },          // qa → 버림
  { t: 9999, text: "수업 끝난 뒤" },              // 구간 밖 → 버림
];
const split = clSplitTranscript(tr, segs);
chk("승훈 2문장", (split.a || []).length, 2);
chk("지오 1문장", (split.b || []).length, 1);
chk("마이크꺼짐 제외", Object.values(split).flat().some((t) => t.includes("잡담")), false);
chk("질문응대 제외 (태경 없음)", split.c === undefined, true);
chk("구간 밖 제외", Object.values(split).flat().some((t) => t.includes("끝난 뒤")), false);

console.log(fail ? "\n실패 " + fail + "건\n" : "\n전부 통과\n");
process.exit(fail ? 1 : 0);
