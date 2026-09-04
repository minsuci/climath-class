// 메뉴 본문에 **그림으로** 붙여둔 학사일정을 읽는 길을 확인한다 (서운중에서 배웠다).
//
// 그림은 대조할 원문이 없다. 그래서 **요일**이 검증 장치다 — 표는 요일이 열이라,
// AI가 "21일 · 월 칸"이라고 읽었으면 2026-09-21 이 진짜 월요일이어야 한다.
// 줄을 밀려 읽거나 해를 잘못 잡으면 여기서 걸린다.
//
//   node tools/test-schedimg.mjs
import fs from "fs";
import vm from "vm";

const src = fs.readFileSync(new URL("../api/schedule.js", import.meta.url), "utf8");
// import 줄만 걷어내고 통째로 돌린다 (파일 안 함수를 그대로 부르려고)
const body = src.replace(/^import[\s\S]*?;$/m, "").replace(/^export default /m, "");
const ctx = vm.createContext({ console, fetch: () => Promise.reject(new Error("no net")), Buffer,
  process: { env: {} }, URL, setTimeout, clearTimeout });
vm.runInContext(body, ctx);
const call = (fn, ...args) => vm.runInContext(fn, ctx)(...args);

const T = [];
const ok = (n, c, e) => T.push((c ? "  OK  " : "FAIL  ") + n + (e ? "   " + e : ""));

// ---- 본문 그림 골라내기 ----
// 서운중 학사일정 페이지에서 실제로 나오는 태그들
const HTML = `
<img src="/dggb/module/file/selectImageView.do?atchFileId=1754161&fileSn=0" alt="서운중학교 로고" />
<img src="/dggb/module/image/selectDesignImageView.do?sitemapId=271297&usrimgId=23740" alt=""/>
<img src="https://seoun.sen.ms.kr/crosseditor/binary/images/007169/20260423144336430_SE3POC5X.png" title="external_image" alt="external_image" />
<img src="https://seoun.sen.ms.kr/crosseditor/binary/images/007169/20260423144646654_I54CGH4W.png" title="external_image" alt="external_image" />
<img src="/dggb/module/file/selectImageView.do;jsessionid=ABC?atchFileId=3716272&fileSn=0" />
`;
const imgs = call("contentImages", HTML, "https://seoun.sen.ms.kr/113296/subMenu.do");
ok("편집기로 붙여넣은 본문 그림을 잡는다",
  imgs.filter((u) => u.includes("crosseditor")).length === 2, imgs.join(" | "));
ok("로고는 뺀다", !imgs.some((u) => u.includes("1754161")));
ok("꾸밈 그림(usrimgId)은 뺀다", !imgs.some((u) => u.includes("usrimgId")));
ok("첨부 이미지도 받는다", imgs.some((u) => u.includes("atchFileId=3716272")));
ok("상대 주소를 절대 주소로", imgs.every((u) => u.startsWith("https://")), imgs.join(" | "));

// ---- 요일 ----
ok("요일 계산", ["2026-09-21", "2026-09-22", "2026-10-28", "2026-10-30"]
  .map((d) => call("dowOf", d)).join("") === "월화수금",
  ["2026-09-21", "2026-09-22", "2026-10-28", "2026-10-30"].map((d) => call("dowOf", d)).join(""));
ok("없는 날짜를 가려낸다", call("realDate", "2026-02-30") === false && call("realDate", "2026-09-21") === true);

// ---- 검증 ----
const V = (o) => call("verifyImagePick", o, "20260901", "20261231", "중간");
// 서운중 2학기 학사일정 그림에서 실제로 읽히는 값
ok("서운중 중간고사 9/21~9/22 는 통과",
  V({ start: "2026-09-21", end: "2026-09-22", startDow: "월", endDow: "화", evidence: "1,2,3학년 중간고사" }) === "",
  V({ start: "2026-09-21", end: "2026-09-22", startDow: "월", endDow: "화", evidence: "1,2,3학년 중간고사" }));
ok("3학년 기말 10/28~10/30 도 통과",
  call("verifyImagePick", { start: "2026-10-28", end: "2026-10-30", startDow: "수", endDow: "금",
    evidence: "3학년 기말고사" }, "20260901", "20261231", "기말") === "");
ok("요일이 어긋나면 막는다 (줄을 밀려 읽음)",
  /요일이 안 맞음/.test(V({ start: "2026-09-21", end: "2026-09-22", startDow: "화", endDow: "수", evidence: "중간고사" })),
  V({ start: "2026-09-21", end: "2026-09-22", startDow: "화", endDow: "수", evidence: "중간고사" }));
// 해를 한 해 잘못 잡으면 같은 날짜라도 요일이 밀린다 (2026-10-28 수 → 2025-10-28 화).
// 평일에 떨어지므로 주말 검사에는 안 걸리고, 오직 요일 대조만이 잡아낸다.
const WRONGYEAR = call("verifyImagePick", { start: "2025-10-28", end: "2025-10-30", startDow: "수", endDow: "금",
  evidence: "3학년 기말고사" }, "20250101", "20251231", "기말");
ok("해를 잘못 잡아도 요일에서 걸린다", /요일이 안 맞음/.test(WRONGYEAR), WRONGYEAR);
ok("주말로 읽으면 막는다",
  /주말로 읽음/.test(V({ start: "2026-09-26", end: "2026-09-27", evidence: "중간고사" })),
  V({ start: "2026-09-26", end: "2026-09-27", evidence: "중간고사" }));
ok("기간 밖은 막는다", /기간 밖/.test(V({ start: "2027-03-02", end: "2027-03-03", evidence: "중간고사" })));
ok("너무 긴 기간은 막는다 (다른 줄까지 삼킴)",
  /너무 김/.test(V({ start: "2026-09-01", end: "2026-09-30", evidence: "중간고사" })),
  V({ start: "2026-09-01", end: "2026-09-30", evidence: "중간고사" }));
ok("시작이 끝보다 늦으면 막는다", /늦음/.test(V({ start: "2026-09-22", end: "2026-09-21", evidence: "중간고사" })));
ok("없는 날짜는 막는다", /없는 날짜/.test(V({ start: "2026-02-30", end: "2026-02-30", evidence: "중간고사" })));
ok("시험이 아닌 글자를 읽었으면 막는다",
  /시험 글자가 아님/.test(V({ start: "2026-09-21", end: "2026-09-22", startDow: "월", endDow: "화", evidence: "추석연휴" })),
  V({ start: "2026-09-21", end: "2026-09-22", startDow: "월", endDow: "화", evidence: "추석연휴" }));
ok("요일을 안 알려주면 나머지 검사만 한다",
  V({ start: "2026-09-21", end: "2026-09-22", evidence: "중간고사" }) === "");

console.log(T.join("\n"));
const bad = T.filter((x) => x.startsWith("FAIL")).length;
console.log(bad ? "\n실패 " + bad + "건" : "\n전부 통과 (" + T.length + "건)");
process.exit(bad ? 1 : 0);
