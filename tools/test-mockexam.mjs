// 실전 시험 규칙을 돌려본다 — 채점(서버) · 시간 계산(화면) · 둘의 점수가 같은지.
//
// ⚠ 규칙을 여기에 베껴 쓰지 않는다. api/exam.js 와 index.html 에서 뽑아 온다 —
//   베껴 두면 본문이 바뀐 뒤에도 시험은 계속 통과한다.
import { readFileSync } from "fs";
import vm from "vm";

const SERVER = readFileSync(new URL("../api/exam.js", import.meta.url), "utf8");
const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const APP = /<script type="text\/plain" id="__appSource">([\s\S]*?)<\/script>/.exec(HTML)[1];

const fn = (src, name) => {
  let i = src.indexOf("function " + name + "(");
  if (i < 0) throw new Error("없음: " + name);
  if (src.slice(i - 6, i) === "async ") i -= 6;
  return src.slice(i, src.indexOf("\n}", i) + 2);
};
const line = (src, name) => {
  const m = new RegExp("^const " + name + " = .*$", "m").exec(src);
  if (!m) throw new Error("없음: " + name);
  return m[0];
};

const S = new Function([
  fn(SERVER, "numVal"), fn(SERVER, "sameShort"), fn(SERVER, "autoCorrect"),
  fn(SERVER, "tally"), line(SERVER, "kstDate"), fn(SERVER, "checkExam"), fn(SERVER, "answersAt"),
  "return { numVal, sameShort, autoCorrect, tally, kstDate, checkExam, answersAt };",
].join("\n"))();
const C = new Function([
  line(APP, "mxAnswered"), fn(APP, "mxSegments"), fn(APP, "mxTally"),
  fn(APP, "mxAnalyze"), fn(APP, "mxNextOpen"),
  "return { mxAnswered, mxSegments, mxTally, mxAnalyze, mxNextOpen };",
].join("\n"))();

let bad = 0;
const eq = (got, want, what) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { console.log("  ✗ " + what + "\n     받음: " + a + "\n     기대: " + b); bad++; }
  else console.log("  ✓ " + what);
};

// ── 채점 ──
console.log("\n단답형 채점");
eq(S.sameShort("-3/2", "-1.5"), true, "-3/2 = -1.5");
eq(S.sameShort(" 12 ", "12"), true, "공백 무시");
eq(S.sameShort("−3", "-3"), true, "긴 빼기표(−)도 빼기");
eq(S.sameShort("6/4", "3/2"), true, "약분 전 분수도 같다");
eq(S.sameShort("2", "3"), false, "다르면 틀림");
eq(S.autoCorrect({ type: "short", ans: ["1/2", "0.5"] }, "0.50"), true, "답이 여럿이면 하나만 맞아도");
eq(S.autoCorrect({ type: "mc", ans: 3 }, "3"), true, "객관식 — 글자로 와도 같다");
eq(S.autoCorrect({ type: "mc", ans: 3 }, null), false, "안 푼 객관식은 틀림");
eq(S.autoCorrect({ type: "essay" }, "✓"), null, "서술형은 사람이 채점");

// ── 점수 ──
console.log("\n점수 (100점 기준)");
const qs = [
  { n: 1, type: "mc", pt: 30, auto: true },
  { n: 2, type: "short", pt: 30, auto: false },
  { n: 3, type: "essay", pt: 40, auto: null },
];
eq(S.tally(qs, {}).score, 30, "배점 30/100 → 30점");
eq(S.tally(qs, { 2: true, 3: true }).score, 100, "고친 O/X 가 반영된다");
eq(S.tally(qs, {}).pending, 1, "서술형 미채점 1");
eq(S.tally(qs.map(({ pt, ...q }) => q), {}).score, 33, "배점이 없으면 개수로 — 1/3 → 33점");
const odd = [{ n: 1, type: "mc", pt: 3.5, auto: true }, { n: 2, type: "mc", pt: 3.5, auto: false }];
eq(S.tally(odd, {}).score, 50, "배점합이 100 이 아니어도 100점 기준으로");

console.log("\n서버와 화면이 같은 점수를 내나 (무작위 300판)");
let diff = 0;
for (let k = 0; k < 300; k++) {
  const n = 5 + (k % 20), withPt = k % 3 !== 0;
  const qq = Array.from({ length: n }, (_, i) => {
    const type = ["mc", "short", "essay"][(i * 7 + k) % 3];
    return { n: i + 1, type, ...(withPt ? { pt: 2 + ((i * 13 + k) % 7) * 0.5 } : {}),
             auto: type === "essay" ? null : (i + k) % 2 === 0 };
  });
  const ov = {}; qq.forEach((q) => { if ((q.n + k) % 5 === 0) ov[q.n] = (q.n % 2 === 0); });
  // 시간 초과 기록: 몇 문항은 시간 뒤에 답이 바뀌었다(late)
  qq.forEach((q) => { if ((q.n + k) % 4 === 0) Object.assign(q, { late: true, autoIn: (q.n + k) % 3 === 0 }); });
  for (const inTime of [false, true]) {
    const a = S.tally(qq, ov, inTime), b = C.mxTally(qq, ov, inTime);
    if (["score", "got", "totalPt", "correct", "pending", "n"].some((f) => a[f] !== b[f])) diff++;
  }
}
eq(diff, 0, "300판 전부 같다 (시간 안 점수도)");

console.log("\n시간 초과");
const evO = [{ t: 0, k: "go", q: 1 }, { t: 100, k: "ans", q: 1, v: "3" }, { t: 200, k: "ans", q: 2, v: "12" },
             { t: 3100, k: "ans", q: 1, v: "4" }, { t: 3200, k: "ans", q: 3, v: "✓" }, { t: 3300, k: "ans", q: 2, v: null }];
eq(S.answersAt(evO, 3000), { 1: "3", 2: "12" }, "시간 끝(3000초) 순간의 답으로 되감는다");
eq(S.answersAt(evO, 3250), { 1: "4", 2: "12", 3: "✓" }, "지운 답(v:null)은 그 뒤에야 지워진다");
const qo = [
  { n: 1, type: "mc", auto: true, late: true, autoIn: false },    // 시간 뒤에 고쳐서 맞힘
  { n: 2, type: "short", auto: true },                            // 시간 안에 맞힘
  { n: 3, type: "essay", auto: null, late: true, autoIn: false }, // 시간 뒤에 다 풂
];
eq(S.tally(qo, {}, true).correct, 1, "시간 안: 시간 뒤에 고친 답은 안 친다");
eq(S.tally(qo, {}).correct, 2, "끝까지: 시간 뒤에 고친 답도 친다");
eq(S.tally(qo, { 3: true }, true).correct, 1, "시간 뒤에 푼 서술형은 O 로 바꿔도 시간 안 점수엔 안 들어간다");
eq(S.tally(qo, { 3: true }).correct, 3, "끝까지 점수엔 들어간다");
eq(S.tally(qo, { 2: false }, true).correct, 0, "시간 안에 적은 답의 O/X 고침은 시간 안 점수에 들어간다");

// ── 시간 흐름 ──
// 원형에서 확인한 흐름: 5번을 넘기고 20번까지 푼 뒤 5번으로 돌아온다
console.log("\n시간 흐름");
const ev = [{ t: 0, k: "go", q: 1 }];
let t = 0;
for (let q = 1; q <= 20; q++) {
  if (q !== 1) ev.push({ t, k: "go", q });
  if (q === 5) { t += 120; continue; }                // 5번에서 2분 헤매다 넘김
  t += 60; ev.push({ t, k: "ans", q, v: 1 });
}
ev.push({ t, k: "go", q: 5 }); t += 465; ev.push({ t, k: "ans", q: 5, v: 2 });   // 돌아와서 7분 45초
t += 30; ev.push({ t, k: "ans", q: 5, v: 3 });                                    // 답을 한 번 바꿈
const log = {
  ev, endT: t + 10,
  questions: Array.from({ length: 20 }, (_, i) => ({ n: i + 1, type: "mc", pt: 5, answer: 1, auto: true })),
  override: {},
};
const A = C.mxAnalyze(log);
const r5 = A.rows.find((r) => r.q.n === 5);
eq(r5.visits, 2, "5번에 두 번 들렀다");
eq(r5.sec, 120 + 465 + 30 + 10, "5번 시간 = 처음 2분 + 돌아와서 505초 = 625초 (10:25)");
eq(r5.changes - 1, 1, "5번 답을 한 번 바꿨다");
eq(A.rows.find((r) => r.q.n === 6).visits, 1, "6번은 한 번");
eq(Math.round(A.rows.reduce((a, r) => a + r.sec, 0)), log.endT, "문항 시간의 합 = 쓴 시간 (빈틈 없음)");

// ── 다음 문제 ──
console.log("\n답을 적으면 다음 «안 푼» 문제로");
const st = (answers) => ({ questions: [1, 2, 3, 4, 5].map((n) => ({ n })), answers });
eq(C.mxNextOpen(st({ 1: 3 }), 1), 2, "차례로 풀면 n+1");
eq(C.mxNextOpen(st({ 1: 3, 2: 1, 3: 2 }), 1), 4, "앞 문제로 돌아가 고치면 바로 뒤가 아니라 안 푼 곳으로");
eq(C.mxNextOpen(st({ 2: 1, 3: 1, 4: 1, 5: 1 }), 5), 1, "끝까지 가면 앞에서 안 푼 것으로 돌아간다");
eq(C.mxNextOpen(st({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 }), 3), null, "다 풀었으면 그 자리에");
eq(C.mxNextOpen(st({ 1: 1, 2: "", 3: 1 }), 1), 2, "빈 문자열은 안 푼 것");

// ── 날짜 ──
console.log("\n수업 날짜 (서버는 UTC 로 돈다)");
eq(S.kstDate(Date.UTC(2026, 8, 26, 14, 30)), "2026-09-26", "한국 밤 11시 30분 → 그날");
eq(S.kstDate(Date.UTC(2026, 8, 26, 15, 30)), "2026-09-27", "한국 0시 30분 → 다음 날");

// ── 시험지 검사 ──
console.log("\n시험지 검사");
const box = { window: {} };
vm.runInNewContext(readFileSync("C:/Users/user/Desktop/시험 시간기록/exams.js", "utf8"), box);
eq(S.checkExam(box.window.EXAMS[0]), null, "바탕화면 원형의 샘플 시험지는 통과");
const base = { id: "t-1", title: "t", minutes: 50, questions: [{ n: 1, type: "mc", ans: 3 }] };
eq(S.checkExam({ ...base, questions: [{ n: 1, type: "mc", ans: 3 }, { n: 1, type: "mc", ans: 2 }] }), "1번이 두 번 있어요", "번호가 겹치면 거절");
eq(S.checkExam({ ...base, questions: [{ n: 1, type: "mc", ans: 6 }] }), "1번 객관식 답은 1~5", "객관식 답 6 은 거절");
eq(S.checkExam({ ...base, questions: [{ n: 1, type: "short", ans: ["", "1"] }] }), "1번 단답형 답이 없어요", "빈 단답 답은 거절");
eq(S.checkExam({ ...base, id: "a/b" }), "id 가 이상해요: a/b", "id 에 / 는 안 된다 (문서 경로가 된다)");
eq(S.checkExam({ ...base, id: "영동고-2025-1학기-중간" }), null, "한글 id 는 된다");
eq(S.checkExam({ ...base, questions: [{ n: 1, type: "mc", ans: 3, label: "서술형1" }] }), null, "학교 번호(label)는 된다");
eq(S.checkExam({ ...base, questions: [{ n: 1, type: "mc", ans: 3, label: "" }] }), "1번 이름(label)이 이상해요", "빈 label 은 거절");

console.log(bad ? "\n실패 " + bad + "건" : "\n다 통과");
process.exit(bad ? 1 : 0);
