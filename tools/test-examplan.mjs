// 판정 규칙을 손으로 베끼지 않는다 — examPlan 안의 그 줄들을 통째로 뽑아 쓴다.
// (베껴 쓰면 서버만 고쳤을 때 시험이 옛 규칙을 계속 통과시킨다. 실제로 한 번 당했다.)
import { readFileSync } from "fs";
const src = readFileSync("C:/Users/user/Desktop/climath-class/api/schedule.js", "utf8");
const g = (re, what) => {
  const m = src.match(re);
  if (!m) throw new Error("못 찾음: " + what);
  return m[0];
};

const RULE = g(/ {2}const hasFree = [\s\S]*?const twice = [^\n]*\n/, "판정 규칙");
const f = new Function(
  [g(/const KIND_RE = \{[\s\S]*?\n\};/, "KIND_RE"),
   g(/const KIND_FREE = [^\n]*\n/, "KIND_FREE"),
   g(/const KIND_LABEL = [^\n]*\n/, "KIND_LABEL"),
   g(/const examLabel = [^\n]*\n/, "examLabel"),
   g(/function semesterRange\(from\) \{[\s\S]*?\n\}/, "semesterRange"),
   g(/function midSeasonEnd\(semFrom\) \{[\s\S]*?\n\}/, "midSeasonEnd"),
   // blocks(=[{s,e,nm}]) 와 a(=학기 시작)를 받아 그 줄들을 그대로 돌린다
   "function plan(blocks, a) {\n" + RULE + "  return { twice, pending };\n}",
  ].join("\n") + "\nreturn {examLabel, semesterRange, midSeasonEnd, plan};")();
const { examLabel, semesterRange, midSeasonEnd, plan } = f;

const B = (d, nm) => ({ s: d, e: d, nm });
const run = (blocks, pullFrom) => plan(blocks, semesterRange(pullFrom)[0]);

const PULL = "20260901";  // 2학기 중간 회차를 부르는 중
console.log("중간 철 끝나는 날:", midSeasonEnd(semesterRange(PULL)[0]), "\n");

const CASES = [
  ["봉은중",     [B("20261012", "3학년 지필고사")],                                "중간고사", "기말 아직"],
  ["대명중",     [B("20261026", "3학년기말고사")],                                 "졸업고사", ""],
  ["아주중",     [B("20261028", "3학년기말고사")],                                 "졸업고사", ""],
  ["원촌중",     [B("20261028", "3학년기말고사")],                                 "졸업고사", ""],
  ["언북중",     [B("20261029", "3학년기말고사")],                                 "졸업고사", ""],
  ["숙명여중",   [B("20261102", "3학년기말고사")],                                 "졸업고사", ""],
  ["언주중",     [B("20261028", "졸업고사")],                                      "졸업고사", ""],
  ["중대부중",   [B("20261103", "졸업고사")],                                      "졸업고사", ""],
  ["봉은중(둘)", [B("20261012", "3학년 지필고사"), B("20261210", "3학년 지필고사")], "중간고사", ""],
  ["보통중",     [B("20261013", "2학기 중간고사"), B("20261208", "2학기 기말고사")], "중간고사", ""],
  ["경기식",     [B("20261013", "1차 지필평가"), B("20261208", "2차 지필평가")],     "중간고사", ""],
  ["이른졸업",   [B("20261012", "졸업고사")],                                      "졸업고사", ""],
];

let bad = 0;
console.log("학교          덩어리                                판정      기말아직");
console.log("-".repeat(80));
for (const [nm, blocks, want, wantPending] of CASES) {
  const p = run(blocks, PULL);
  const got = examLabel("중간", p.twice);
  const pend = p.pending ? "기말 아직" : "";
  const okk = got === want && pend === wantPending;
  if (!okk) bad++;
  const desc = blocks.map((b) => b.s.slice(4, 6) + "/" + b.s.slice(6) + " " + b.nm).join(" + ");
  console.log(`${okk ? "OK " : "XX "}${nm.padEnd(12)}${desc.padEnd(38)}${got.padEnd(10)}${pend}`);
}

console.log("\n1학기(3~7월) — 졸업고사는 2학기 이야기다. 하나뿐이어도 졸업고사면 안 된다");
for (const [d, nm] of [["20260428", "중간고사"], ["20260706", "기말고사"]]) {
  const p = run([B(d, nm)], "20260401");
  const got = examLabel(nm.startsWith("중간") ? "중간" : "기말", p.twice);
  const okk = got !== "졸업고사";
  if (!okk) bad++;
  console.log(`   ${okk ? "OK " : "XX "}${d.slice(4, 6)}/${d.slice(6)} ${nm} 하나뿐 → ${got}`);
}
console.log(bad ? `\n어긋난 것 ${bad}건` : "\n모두 맞음");
