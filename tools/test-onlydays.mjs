// 정규반 «나오는 요일» (onlyDays, 2026-09-18).
// 고1S(월금)인데 월요일만 오는 학생 — 금요일 출석 명단·결석 알림·출석부·등원 회차에서 빠져야 한다.
// ⚠ 규칙을 여기 베껴 쓰지 않는다. index.html 에서 뽑아 온다.
import { readFileSync } from "fs";
const H = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const src = /<script type="text\/plain" id="__appSource">([\s\S]*?)<\/script>/.exec(H)[1];

const T = [];
const ok = (n, c, e) => T.push((c ? "  OK  " : "FAIL  ") + n + (e ? "   " + e : ""));

// 함수 하나를 중괄호 짝으로 잘라 온다
const fn = (name) => {
  const i = src.indexOf("function " + name + "(");
  if (i < 0) throw new Error("없음: " + name);
  let j = src.indexOf("{", i), depth = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error("짝 없음: " + name);
};
const lib = new Function(
  "const isIndividual = (c) => c && c.type === 'individual';\n" +
  fn("isActiveOn") + "\n" + fn("attendsOn") + "\n" + fn("studentDows") + "\n" +
  "return { attendsOn, studentDows };")();

const S = { id: "c1", name: "고1S", classDays: [1, 5] };
const K = { id: "k1", name: "개진반", type: "individual", classDays: [] };
const mon = { id: "r1", name: "진유준", onlyDays: [1] };
const all = { id: "r2", name: "김서진" };
const empty = { id: "r3", name: "빈칸", onlyDays: [] };
const oldDays = { id: "r4", name: "옛요일", days: [4] };

ok("금요일(9/18) — 월요일만 오는 학생은 수업 대상이 아니다", lib.attendsOn(S, mon, "2026-09-18") === false);
ok("월요일(9/14) — 수업 대상", lib.attendsOn(S, mon, "2026-09-14") === true);
ok("칸이 없는 학생은 전처럼 (반 요일은 호출부가 거른다)", lib.attendsOn(S, all, "2026-09-18") === true);
ok("빈 칸도 반 요일 전부", lib.attendsOn(S, empty, "2026-09-18") === true);
ok("⚠ 정규반 줄의 옛 days 는 안 본다", lib.attendsOn(S, oldDays, "2026-09-18") === true);
ok("개진반은 그대로 학생 days", lib.attendsOn(K, { days: [4] }, "2026-09-17") === true && lib.attendsOn(K, { days: [4] }, "2026-09-18") === false);
ok("수강 기간 밖이면 여전히 아니다", lib.attendsOn(S, { onlyDays: [1], endDate: "2026-09-10" }, "2026-09-14") === false);

ok("studentDows — 월만", JSON.stringify(lib.studentDows(S, mon)) === "[1]");
ok("studentDows — 칸 없으면 반 요일", JSON.stringify(lib.studentDows(S, all)) === "[1,5]");
ok("studentDows — 반 요일 밖 값은 버린다", JSON.stringify(lib.studentDows(S, { onlyDays: [1, 3] })) === "[1]");
ok("studentDows — 개진반은 학생 요일", JSON.stringify(lib.studentDows(K, { days: [4] })) === "[4]");

// 쓰는 곳이 다 바뀌었나 — «정규반이면 cls.classDays» 를 직접 쓰는 곳이 남으면 그 화면만 금요일에 결석이 된다
const left = (src.match(/isIndividual\(cls\) \? \(\(?st\.days \|\| \[\]\)(\.slice\(\))?\)? : \(\(?cls\.classDays \|\| \[\]\)/g) || []);
ok("학생 요일을 «개진반이면 days, 아니면 반 요일» 로 직접 고르는 곳이 남지 않았다 (studentDows 로)", left.length === 0, JSON.stringify(left));
ok("등원 회차(수강료) — studentDows", /: studentDows\(cls, st\);\s+\/\/ 나오는 요일만 센다/.test(src));
ok("오늘 출석 명단 — attendsOn 으로 거른다 (금요일엔 안 뜬다)", /cls\.roster\.filter\(\(r\) => !r\.teacher && attendsOn\(cls, r, date\)\)/.test(src));
ok("결석 알림(buildAttendRows) — attendsOn 으로 거른다", /if \(!attendsOn\(cls, st, d\)\) continue;/.test(src));
ok("월간 출석부 — 안 오는 요일 칸은 «·» · 분모에서 뺀다", /cls: "cm-ab-off", t: "·"/.test(src) && /\{attCount\}\/\{myDays\.length\}/.test(src) && !/\{attCount\}\/\{days\.length\}/.test(src));
ok("월간 출석부 — 이름 밑에 «월만»", /\{st\.onlyDays\.map\(\(d\) => DAY_NAMES\[d\]\)\.join\("·"\)\}만/.test(src));

console.log(T.join("\n"));
const bad = T.filter((x) => x.indexOf("FAIL") === 0).length;
console.log(bad ? "\n실패 " + bad + "건" : "\n전부 통과 (" + T.length + "건)");
process.exitCode = bad ? 1 : 0;
