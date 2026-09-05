// 위험신호의 «자동 신호» 규칙을 돌려본다.
//
// ⚠ 규칙을 여기에 베껴 쓰지 않는다. index.html 에서 뽑아 온다 —
//   베껴 두면 본문이 바뀐 뒤에도 시험은 계속 통과한다 (실제로 당했다).
import { readFileSync } from "fs";
const H = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const src = /<script type="text\/plain" id="__appSource">([\s\S]*?)<\/script>/.exec(H)[1];

const grab = (name) => {
  let i = src.indexOf("function " + name + "(");
  if (i < 0) throw new Error("없음: " + name);
  // ⚠ «async» 를 빼먹으면 안쪽 await 가 문법 오류가 된다
  if (src.slice(i - 6, i) === "async ") i -= 6;
  return src.slice(i, src.indexOf("\n}", i) + 2);
};
const grabConst = (name) => {
  const m = new RegExp("^const " + name + " = .*$", "m").exec(src);
  if (!m) throw new Error("없음: " + name);
  return m[0];
};

// ---- 가짜 자료 ----
// 수업일 8/03 ~ 8/31 (최신순으로 넣는다 — listDays 가 그렇게 준다)
const DAYS = ["2026-08-31", "2026-08-28", "2026-08-24", "2026-08-21",
              "2026-08-17", "2026-08-14", "2026-08-10", "2026-08-07", "2026-08-03"];
let ATT = {};      // { 날짜: [출석한 sid...] }  — 없는 날 = 출석을 안 찍은 날
let ROWS = [];     // 점수
let ROSTER = [];

const CLS = { id: "c1", name: "고1S" };
const g = {
  ymd: (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10),
  isEnded: (st) => !!(st && st.endDate && "2026-09-05" > st.endDate),
  attendsOn: () => true,
  activeClasses: () => [{ ...CLS, roster: ROSTER }],
  listDays: async () => DAYS.slice(),
  attCol: (cid, date) => ({
    get: async () => {
      const ids = ATT[date];
      return { empty: !ids || !ids.length, forEach: (f) => (ids || []).forEach((id) => f({ id })) };
    },
  }),
  loadScoreHistory: async () => ({ rows: ROWS.slice() }),
};

const code = [
  grabConst("AUTO_DAYS"), grabConst("AUTO_BACK"),
  grabConst("AUTO_GAP"), grabConst("AUTO_DROP"),
  grab("computeAutoSignals"),
  "return computeAutoSignals;",
].join("\n");
const computeAutoSignals = new Function(...Object.keys(g), code)(...Object.values(g));

// ---- 검사 ----
let bad = 0;
const eq = (got, want, what) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { console.log("  ✗ " + what + "\n     받음: " + a + "\n     기대: " + b); bad++; }
  else console.log("  ✓ " + what);
};
const keys = (arr, sid) => {
  const x = arr.find((v) => v.sid === sid);
  return x ? { lv: x.lv, r: x.reasons.map((r) => r.key).sort() } : null;
};

async function run(title, setup, check) {
  ATT = {}; ROWS = []; ROSTER = [];
  setup();
  console.log("\n" + title);
  check(await computeAutoSignals());
}

const ALL = ["a", "b", "c", "d"];
const present = (date, except = []) => { ATT[date] = ALL.filter((x) => !except.includes(x)); };
const four = () => ALL.map((id) => ({ id, name: id.toUpperCase() }));

await run("연속 결석 2회는 «위험»", () => {
  ROSTER = four();
  DAYS.forEach((d) => present(d));
  present("2026-08-31", ["a"]);
  present("2026-08-28", ["a"]);
}, (out) => {
  eq(keys(out, "a"), { lv: 3, r: ["run"] }, "a — 연속 결석 2회");
  eq(keys(out, "b"), null, "b — 신호 없음");
});

await run("띄엄띄엄 3회 결석은 «주의»", () => {
  ROSTER = four();
  DAYS.forEach((d) => present(d));
  ["2026-08-31", "2026-08-24", "2026-08-14"].forEach((d) => present(d, ["a"]));
}, (out) => eq(keys(out, "a"), { lv: 2, r: ["many"] }, "a — 8회 중 3회"));

await run("출석을 한 명도 안 찍은 날은 수업일이 아니다", () => {
  ROSTER = four();
  // 8/31 은 점수만 넣고 출석은 안 찍었다 — 이 날을 세면 전원 결석이 된다
  DAYS.slice(1).forEach((d) => present(d));
}, (out) => eq(out.length, 0, "전원 결석으로 잡히지 않는다"));

await run("반 평균보다 낮은 게 2회면 «주의»", () => {
  ROSTER = four();
  DAYS.forEach((d) => present(d));
  ["2026-08-24", "2026-08-28", "2026-08-31"].forEach((d) => {
    ROWS.push({ date: d, sid: "a", score: 60, time: 1 });
    ROWS.push({ date: d, sid: "b", score: 85, time: 1 });
    ROWS.push({ date: d, sid: "c", score: 90, time: 1 });
    ROWS.push({ date: d, sid: "d", score: 80, time: 1 });
  });
}, (out) => {
  eq(keys(out, "a"), { lv: 2, r: ["low"] }, "a — 평균 84 대비 60점");
  eq(keys(out, "d"), null, "d — 평균과 비슷하면 안 뜬다");
});

await run("셋 미만이면 평균을 안 내므로 «낮음» 도 없다", () => {
  ROSTER = four();
  DAYS.forEach((d) => present(d));
  ["2026-08-24", "2026-08-28", "2026-08-31"].forEach((d) => {
    ROWS.push({ date: d, sid: "a", score: 40, time: 1 });
    ROWS.push({ date: d, sid: "b", score: 95, time: 1 });
  });
}, (out) => eq(out.length, 0, "둘뿐이면 아무 신호도 없다"));

await run("같은 날 여러 번 낸 것은 마지막 것만", () => {
  ROSTER = four();
  DAYS.forEach((d) => present(d));
  ["2026-08-24", "2026-08-28", "2026-08-31"].forEach((d) => {
    ROWS.push({ date: d, sid: "a", score: 20, time: 1 });   // 연습 삼아 낸 것
    ROWS.push({ date: d, sid: "a", score: 85, time: 9 });   // 진짜
    ROWS.push({ date: d, sid: "b", score: 85, time: 1 });
    ROWS.push({ date: d, sid: "c", score: 88, time: 1 });
    ROWS.push({ date: d, sid: "d", score: 82, time: 1 });
  });
}, (out) => eq(keys(out, "a"), null, "a — 마지막 85점이라 신호 없음"));

await run("점수 하락은 «관심»", () => {
  ROSTER = four();
  DAYS.forEach((d) => present(d));
  const mine = { "2026-08-17": 90, "2026-08-21": 88, "2026-08-28": 70, "2026-08-31": 68 };
  Object.keys(mine).forEach((d) => {
    ROWS.push({ date: d, sid: "a", score: mine[d], time: 1 });
    ROWS.push({ date: d, sid: "b", score: mine[d], time: 1 });   // 반이 통째로 내려가도
    ROWS.push({ date: d, sid: "c", score: mine[d], time: 1 });   // 본인 기준으로는 하락이다
  });
}, (out) => eq(keys(out, "a"), { lv: 1, r: ["drop"] }, "a — 89 → 69"));

await run("종강한 학생은 빠진다", () => {
  ROSTER = [{ id: "a", name: "A", endDate: "2026-08-01" }, { id: "b", name: "B" }];
  DAYS.forEach((d) => { ATT[d] = ["b"]; });
}, (out) => eq(out.length, 0, "종강자는 결석으로 안 센다"));

console.log(bad ? "\n실패 " + bad + "건" : "\n다 통과");
process.exit(bad ? 1 : 0);
