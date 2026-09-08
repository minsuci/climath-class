// 명단 고치기가 정말 닫혔나 (2026-09-08).
//
// 학생 명단을 고치는 자리를 팀체크 한 곳으로 모았다. 화면에서 단추만 감추면
// **함수는 그대로 열려 있다** — 다른 화면에서 부르거나, 옛 화면이 남아 있으면 그대로 쓰인다.
// 그래서 쓰기 함수 자체가 막혔는지를 센다.
//
// ⚠ 규칙을 여기 베껴 쓰지 않는다. index.html 에서 뽑아 온다.
import { readFileSync } from "fs";
const H = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const src = /<script type="text\/plain" id="__appSource">([\s\S]*?)<\/script>/.exec(H)[1];

const T = [];
const ok = (n, c, e) => T.push((c ? "  OK  " : "FAIL  ") + n + (e ? "   " + e : ""));

const head = (name) => {
  let i = src.indexOf("function " + name + "(");
  if (i < 0) throw new Error("없음: " + name);
  return src.slice(i, i + 400);
};

// ---- 막은 것 ----
// 사람을 만들고 고치고 지우는 것, 반에 넣고 빼는 것, 반 명단 줄을 사람에게 잇는 것.
const BLOCKED = ["saveStudent", "deleteStudent", "linkRosterToStudent", "assignToClass", "unassignFromClass"];
BLOCKED.forEach((f) => {
  ok(f + " 는 문지기를 먼저 부른다", /^\s*(async\s+)?function[^{]*\{\s*rosterGuard\(\);/.test(head(f)), head(f).slice(0, 90).replace(/\n/g, " "));
});
ok("깃발이 켜져 있다", /^const ROSTER_RO = true;/m.test(src));
ok("문지기는 깃발이 켜져 있으면 던진다",
  /function rosterGuard\(\)\s*\{\s*if \(ROSTER_RO\) throw new Error\(ROSTER_RO_MSG\);/.test(src));
ok("어디로 가야 하는지 말해 준다", /팀체크/.test(/const ROSTER_RO_MSG = [\s\S]*?;\n/.exec(src)[0]));
ok("팀체크 주소가 적혀 있다", /const TEAM_ROSTER_URL = "https:\/\/climath-team1\.vercel\.app/.test(src));

// ---- 남긴 것 ----
// 반 안에서 순서를 바꾸고, 선생님↔학생을 바꾸고, 학생별 등원요일·교재를 정하는 것은
// 담임이 수업하며 하는 일이다. 이것까지 닫으면 앱이 반쪽이 된다.
ok("반 명단 저장 자체는 안 막았다 (순서·선생님 전환이 쓴다)", !/function saveClassRoster\([\s\S]{0,120}rosterGuard/.test(src), head("saveClassRoster").slice(0, 90).replace(/\n/g, " "));
ok("PIN 초기화는 남았다", !/async function resetStudentPin\([\s\S]{0,120}rosterGuard/.test(src));
ok("선생님↔학생 전환 단추는 그대로", /onClick=\{\(\) => toTeacher\(st\)\}>선생님<\/button>/.test(src) &&
  !/ROSTER_RO && <button className="cm-link" disabled=\{busy\} onClick=\{\(\) => toTeacher/.test(src));
ok("순서 바꾸기 단추는 그대로", /onClick=\{\(\) => move\(i, -1\)\}/.test(src));

// ---- 화면에서도 가렸나 ----
// 함수가 막혀 있어도 단추가 보이면 눌러 보고 «저장 실패» 를 본다. 그건 고장으로 읽힌다.
ok("새 학생 줄을 가렸다", /\{!ROSTER_RO && \(\s*<tr>/.test(src));
ok("이름·학교·학년·담임 칸을 잠갔다", (src.match(/disabled=\{busy \|\| ROSTER_RO\}/g) || []).length >= 4,
  String((src.match(/disabled=\{busy \|\| ROSTER_RO\}/g) || []).length));
ok("삭제 단추를 가렸다", /\{!ROSTER_RO && \(\s*<button className="cm-link" style=\{\{color: "#d6453f", padding: 0\}\}/.test(src));
ok("반 배정 단추를 잠갔다", /disabled=\{busy \|\| ROSTER_RO\}\s*\n\s*onClick=\{\(\) => toggle\(c, inIt\)\}/.test(src));
ok("반 설정의 «학생 넣기» 를 가렸다", /\{canEdit && !ROSTER_RO && !picking && \(/.test(src));
ok("«이름»·«빼기» 를 가렸다", /\{!ROSTER_RO && <button className="cm-link" disabled=\{busy\} onClick=\{\(\) => renameStudent\(st\)\}/.test(src));
ok("학생 명단 화면에 어디서 고치는지 띠가 뜬다", /보기 전용이에요[\s\S]{0,200}팀체크/.test(src));
ok("반 설정에도 안내가 뜬다", /학생을 넣고 빼는 것은 <b>팀체크<\/b>에서 해요/.test(src));

// ---- 진단은 남기고 고치는 단추만 잠갔다 ----
// «안 이어진 명단 항목» 상자는 그대로 보여야 한다. 그게 보여야 팀체크에 가서 고칠 생각을 한다.
ok("안 이어진 항목 상자는 그대로 있다", /학생 정보가 없는 명단 항목/.test(src));
ok("«잇기» 단추는 잠갔다", (src.match(/disabled=\{(busy|filling) \|\| ROSTER_RO\}/g) || []).length >= 4,
  String((src.match(/disabled=\{(busy|filling) \|\| ROSTER_RO\}/g) || []).length));
ok("잠근 단추는 왜 잠갔는지 말해 준다", (src.match(/title=\{ROSTER_RO \? ROSTER_RO_MSG : undefined\}/g) || []).length >= 4);
ok("학년 한 번에 넣기를 잠갔다", /학년 없는 <b>\{shown\.length\}명<\/b>이에요\. 학년은 <b>팀체크<\/b>에서 넣어요/.test(src));
ok("참여표 쪽에도 어디서 잇는지 적었다", /잇는 것은 팀체크에서 해요/.test(src));

// ---- 되돌릴 수 있나 ----
// 급할 때 한 줄로 되돌아가야 한다. 깃발을 끄면 옛 화면이 그대로 돌아오는지 본다.
ok("깃발 하나로 되돌아간다 (ROSTER_RO 를 쓰는 곳만)",
  (src.match(/ROSTER_RO(?!_)/g) || []).length >= 12, String((src.match(/ROSTER_RO(?!_)/g) || []).length));

// ---- 정말 던지나 ----
// 글자만 맞춰 보면 문지기가 «있는 것처럼» 보이기만 할 수 있다. 진짜로 돌려서 막히는지 본다.
{
  const grab = (name) => {
    let i = src.indexOf("function " + name + "(");
    if (src.slice(i - 6, i) === "async ") i -= 6;
    return src.slice(i, src.indexOf("\n}", i) + 2);
  };
  const flags = /const ROSTER_RO = [\s\S]*?function rosterGuard\(\)[^\n]*\n/.exec(src)[0];
  const box = {};
  new Function("box", flags + grab("saveStudent") + grab("assignToClass") +
    "\nbox.saveStudent = saveStudent; box.assignToClass = assignToClass;" +
    "\nbox.RO = ROSTER_RO; box.MSG = ROSTER_RO_MSG;")(box);
  ok("깃발이 켜진 채로 배포된다", box.RO === true);
  const threw = (fn) => fn().then(() => "", (e) => e.message);
  Promise.all([threw(() => box.saveStudent("p1", { name: "가" })),
               threw(() => box.assignToClass("c1", { pid: "p1" }))])
    .then(([a, b]) => {
      ok("saveStudent 는 정말 던진다", /팀체크/.test(a), a.split(/\n/)[0]);
      ok("assignToClass 도 정말 던진다", /팀체크/.test(b), b.split(/\n/)[0]);
      ok("던지는 말에 팀체크 주소가 들어 있다", /climath-team1/.test(box.MSG));
      done();
    });
}

function done() {
  console.log(T.join("\n"));
  const bad = T.filter((x) => x.startsWith("FAIL")).length;
  console.log(bad ? "\n실패 " + bad + "건" : "\n전부 통과 (" + T.length + "건)");
  process.exit(bad ? 1 : 0);
}
