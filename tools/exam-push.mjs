// 실전 시험지를 앱에 올린다 — 정답은 서버(examKeys)에만, 학생 목록엔 정답 뺀 것만 간다.
//
//   node tools/exam-push.mjs --file "…\시험 시간기록\exams.js"          올리기 (같은 id 는 덮어쓴다)
//   node tools/exam-push.mjs --file … --dry                            검사만
//   node tools/exam-push.mjs --list                                     올라가 있는 것
//   node tools/exam-push.mjs --del <id>                                 빼기
//   node tools/exam-push.mjs --classes [이름 일부]                      반 ID 와 명단 (cids·names 적을 때)
//
// 파일은 바탕화면 원형과 같은 모양이다 — `window.EXAMS = [ … ]` (exams.js) 또는 JSON 배열.
// 분기 시작에 기출백서 답지로 이 파일을 한 번에 만들고, 이 도구로 한 번에 올린다.
//
//   { id, title, minutes, questions: [{ n, type: "mc"|"short"|"essay", ans, pt }],
//     cids?: [반ID…]  (없으면 모든 반)
//     names?: [학생 이름…]  (그 학생만 본다. cids 필요. 명단 표기 그대로 — 동명이인은 A·B·C 까지)
//     test?: true      (선생님 모드에서만 보인다 — 올려서 확인할 때)
//     lock?: true      (답 고정 — 제출한 뒤에는 학생이 결과를 못 고친다. 선생님이 O/X·«답 고치기» 로 고친다)
//     order?: 숫자     (목록 순서) }
//
// 열쇠는 tools/lesson-key.json (강의노트 도구와 같은 것). 저장소에 안 들어간다.
import fs from "fs";
import vm from "vm";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = (process.env.CLIMATH_URL || "https://climath-class.vercel.app") + "/api/exam";
const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const has = (k) => args.includes(k);

function key() {
  const p = path.join(HERE, "lesson-key.json");
  if (!fs.existsSync(p)) { console.error("lesson-key.json 이 없습니다: " + p); process.exit(1); }
  return JSON.parse(fs.readFileSync(p, "utf8")).key;
}
async function call(payload) {
  const r = await fetch(APP, {
    method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ ...payload, toolKey: key() }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("서버가 거절했습니다 (" + r.status + "): " + (j.error || ""));
  return j;
}

// exams.js 는 `window.EXAMS = […]` 라 JSON 이 아니다. 샌드박스에서 돌려 값만 꺼낸다
function readExams(file) {
  const src = fs.readFileSync(file, "utf8");
  if (/^\s*\[/.test(src)) return JSON.parse(src);
  const box = { window: {} };
  vm.runInNewContext(src, box, { timeout: 1000 });
  const v = box.window.EXAMS || box.EXAMS;
  if (!Array.isArray(v)) throw new Error("window.EXAMS 배열을 못 찾았습니다");
  return v;
}

function summary(e) {
  const qs = e.questions || [];
  const kind = (t) => qs.filter((q) => q.type === t).length;
  const pt = qs.every((q) => typeof q.pt === "number") ? qs.reduce((a, q) => a + q.pt, 0) : null;
  return `${e.id}  「${e.title}」 ${e.minutes}분 · ${qs.length}문항 (객관식 ${kind("mc")} · 단답 ${kind("short")} · 서술 ${kind("essay")})`
    + (pt != null ? ` · 배점합 ${Math.round(pt * 10) / 10}` : " · 배점 없음(개수로 셈)")
    + (e.test ? "  [시험용 — 선생님만]" : "") + (e.lock ? "  [답 고정 — 선생님만 고침]" : "") + ((e.cids || []).length ? `  [반 ${e.cids.length}곳만]` : "")
    + ((e.names || []).length ? `  [학생: ${e.names.join(", ")}]` : "");
}

(async () => {
  if (has("--list")) {
    const { exams } = await call({ action: "examKeys" });
    if (!exams.length) console.log("(올라가 있는 시험지 없음)");
    exams.forEach((e) => console.log(summary(e)));
    return;
  }
  // 시험지를 잘못 골라 낸 제출을 옮긴다 — 서버가 옮길 시험지의 정답으로 다시 채점하고, 옛 기록은 «취소» 처리
  //   node tools/exam-push.mjs --move <rid> --cid <반ID> --date 2026-10-02 --to <시험지id>
  if (arg("--move")) {
    const r = await call({ action: "examMove", rid: arg("--move"), cid: arg("--cid"), date: arg("--date"), to: arg("--to") });
    console.log(`옮김 → ${r.rid}  ${r.score}점 · ${r.correct}/${r.n}` + (r.pending ? ` · 미채점 ${r.pending}` : ""));
    r.questions.forEach((q) => console.log(`  ${q.n}번  ${q.answer == null ? "(빈칸)" : q.answer}  ${q.auto === null ? "손채점" : q.auto ? "O" : "X"}`));
    return;
  }
  // 시간을 넘겨 낸 기록을 «낸 답 그대로» 점수로 다시 매긴다 (10/2 전 기록용 · 몇 번 돌려도 같다)
  //   node tools/exam-push.mjs --rescore [--cid <반ID>] [--since 2026-09-26] [--dry]
  if (has("--rescore")) {
    const r = await call({ action: "examRescore", cid: arg("--cid") || undefined, since: arg("--since") || undefined, dry: has("--dry") });
    r.done.forEach((x) => console.log(`  ${x.date}  ${x.name}  ${x.examId}  ${x.from} → ${x.to}점` + (x.voided ? "  (취소됨)" : "") + (x.teacher ? "  (선생님 모드)" : "")));
    console.log((r.dry ? "(--dry — 안 고침) " : "다시 매김 ") + r.done.length + "건");
    return;
  }
  // 코칭용 결과 꺼내기 — 파일로 떨군다. 시험지 스캔과 같이 넣어 문항별 코칭을 쓴다
  //   node tools/exam-push.mjs --logs <반ID> [--since 2026-09-01] [--out 결과.json]
  if (arg("--logs")) {
    const { logs } = await call({ action: "examLogs", cid: arg("--logs"), since: arg("--since") || undefined });
    const out = arg("--out") || ("examlogs_" + arg("--logs") + ".json");
    fs.writeFileSync(out, JSON.stringify(logs, null, 1));
    logs.forEach((l) => console.log(`${l.date}  ${l.name}  「${l.title}」 ${l.score}점 · ${l.correct}/${l.n}`
      + ` · ${Math.floor(l.endT / 60)}분${l.pending ? " · 미채점 " + l.pending : ""}${l.teacher ? "  (선생님)" : ""}`));
    console.log("\n" + logs.length + "건 → " + out);
    return;
  }
  // 학생 지정(names)을 지금 명단으로 다시 맞춘다 — 자리 ID 를 «반ID/자리ID» 로 바꾼 뒤 (10/8) · 몇 번 돌려도 같다
  //   node tools/exam-push.mjs --resids [--dry]
  if (has("--resids")) {
    const r = await call({ action: "examResids", dry: has("--dry") });
    r.done.forEach((x) => console.log(`  ${x.id}  ` + (x.error ? "✗ " + x.error : x.same ? "그대로" : x.from.join(",") + "  →  " + x.to.join(","))));
    console.log((r.dry ? "(--dry — 안 고침) " : "맞춤 ") + r.done.filter((x) => !x.same && !x.error).length + "건");
    return;
  }
  if (has("--classes")) {
    const q = arg("--classes") && !arg("--classes").startsWith("--") ? arg("--classes") : "";
    const { classes } = await call({ action: "classes" });
    classes.filter((c) => !q || (c.name + c.id).includes(q))
      .forEach((c) => console.log(`${c.id}  「${c.name}」 ${c.names.length}명: ${c.names.join(", ")}`));
    return;
  }
  if (arg("--del")) {
    const r = await call({ action: "examDel", id: arg("--del") });
    console.log("뺐습니다 — 남은 시험지 " + r.listed + "개");
    return;
  }
  const file = arg("--file");
  if (!file) { console.error("--file 또는 --list / --del 이 필요합니다"); process.exit(1); }
  const exams = readExams(file);
  console.log(exams.length + "개 읽음");
  // 배점합이 100 이 아니면 알린다. 틀린 게 아닐 수도 있지만(가산점·서술 배점) 답지를
  // 옮겨 적다 하나 빠뜨리면 여기서 제일 먼저 드러난다.
  for (const e of exams) {
    console.log("  " + summary(e));
    const qs = e.questions || [];
    const pt = qs.every((q) => typeof q.pt === "number") ? Math.round(qs.reduce((a, q) => a + q.pt, 0) * 10) / 10 : null;
    if (pt != null && pt !== 100) console.log("    ⚠ 배점합이 100 이 아닙니다 (" + pt + ")");
    const ns = qs.map((q) => q.n).sort((a, b) => a - b);
    const gap = ns.filter((n, i) => i && n !== ns[i - 1] + 1);
    if (gap.length) console.log("    ⚠ 번호가 건너뜁니다: " + gap.join(", ") + " 앞");
  }
  if (has("--dry")) { console.log("\n(--dry — 올리지 않았습니다)"); return; }
  for (const e of exams) {
    const r = await call({ action: "examPut", exam: e });
    console.log("올림 — " + r.id);
  }
  const { exams: now } = await call({ action: "examKeys" });
  console.log("\n지금 올라가 있는 것 " + now.length + "개");
})().catch((e) => { console.error(e.message); process.exit(1); });
