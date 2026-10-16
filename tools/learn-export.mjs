// 학습 기록 쌓기 — 11월 중순 개인화의 재료 (2026-10-16 · 마왕님 «쌓여서 개인화 재료가 되어야 해»)
//
//   node tools/learn-export.mjs            모든 반의 실전 시험 · 과제 기록을 받아 한 줄 = 학생 × 문항 × 한 번 낸 것 으로 쌓는다
//   node tools/learn-export.mjs --dry      받기만 하고 쓰지 않는다(몇 줄인지만)
//
// 쌓는 곳: %USERPROFILE%\.climath\learn-data\
//   학습기록.jsonl   한 줄 = {kind(시험|과제), date, cid, cls, sid, name, src(시험지·교재 id), srcName, rid, n, type,
//                    unit, also, concept, lv, pt, answer, key, first(처음 채점 o/x/null), final(마지막 o/x/null), retries, sec, late, score}
//                    **지우지 않는다** — 앱에서 기록·시험지가 지워져도 여기엔 남는다(같은 rid·번호는 새 값으로 덮음)
//   학습기록.csv     위와 같은 것(엑셀용) — 매번 jsonl 에서 다시 만든다
//   raw\YYYY-MM-DD\  그날 받은 원본(시험지 정의 · 반 명단 · 결과) — 무엇이 바뀌었는지 되짚을 때
// 단원 꼬리표: 과제 교재는 교재의 units · 문항 u. 실전 시험은 꼬리표 파일(TAGS 아래)이 있으면 붙인다.
// 빼는 것: 선생님 모드로 낸 것 · «이 제출 취소» 된 것.
// 매일 밤 작업 스케줄러가 돌린다(«클래스앱 학습기록», 23:40). 기록 ~\.climath\learn-data\log.txt
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = (process.env.CLIMATH_URL || "https://climath-class.vercel.app") + "/api/exam";
const key = JSON.parse(fs.readFileSync(path.join(HERE, "lesson-key.json"), "utf8")).key;
const OUT = path.join(os.homedir(), ".climath", "learn-data");
const TAGS = [path.join(os.homedir(), "Desktop", "변형교재", "_기출백서기말_exam", "단원꼬리표.json")];   // {examId: {n: {unit, also, concept, lv}}}
const DRY = process.argv.includes("--dry");
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

async function call(body) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(APP, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ toolKey: key, ...body }) });
    const j = await r.json().catch(() => null);
    if (r.ok) return j;
    if (i === 2) throw new Error(body.action + " " + r.status + " " + ((j && j.error) || ""));
    await new Promise((s) => setTimeout(s, 1500));
  }
}
const log = (m) => { console.log(m); if (!DRY) { fs.mkdirSync(OUT, { recursive: true }); fs.appendFileSync(path.join(OUT, "log.txt"), new Date().toISOString() + "  " + m + "\n"); } };
function secsOf(l) {   // 실전 시험 — 문항 이동(go)에서 문항별 머문 초
  const ev = (l.ev || []).filter((e) => e.k === "go").sort((a, b) => a.t - b.t), s = {};
  let cur = null, last = 0;
  for (const e of ev) { if (cur != null) s[cur] = (s[cur] || 0) + (e.t - last); cur = e.q; last = e.t; }
  if (cur != null) s[cur] = (s[cur] || 0) + Math.max(0, (l.endT || last) - last);
  return s;
}
const ox = (v) => (v === true ? "o" : v === false ? "x" : null);

async function main() {
  const tags = {};
  for (const f of TAGS) if (fs.existsSync(f)) Object.assign(tags, JSON.parse(fs.readFileSync(f, "utf8")));
  const [{ classes }, { exams }] = await Promise.all([call({ action: "classes" }), call({ action: "examKeys" })]);
  const keyOf = {}; exams.forEach((e) => { keyOf[e.id] = e; });
  // 앱에서 지운 시험지도 단원·이름을 잇게 — 지우기 전에 받아 둔 사본(10/16)
  const bk = path.join(HERE, "logs", "examKeys-backup-1016.json");
  if (fs.existsSync(bk)) JSON.parse(fs.readFileSync(bk, "utf8")).forEach((e) => { if (!keyOf[e.id]) keyOf[e.id] = e; });
  const raw = { classes, exams, examLogs: {}, hwLogs: {} };
  const rows = [];
  for (const c of classes) {
    const [{ logs: el }, { logs: hl }] = await Promise.all([call({ action: "examLogs", cid: c.id }), call({ action: "hwLogs", cid: c.id })]);
    raw.examLogs[c.id] = el; raw.hwLogs[c.id] = hl;
    for (const l of el) {
      if (l.teacher || l.voided) continue;
      const sec = secsOf(l), t = tags[l.examId] || {}, k = keyOf[l.examId] || {};
      const kq = {}; (k.questions || []).forEach((q) => { kq[q.n] = q; });
      for (const q of l.questions || []) {
        const ov = l.override && q.n in l.override ? l.override[q.n] : q.auto, tg = t[q.n] || t[String(q.n)] || {};
        rows.push({ kind: "시험", date: l.date, cid: c.id, cls: c.name, sid: l.sid, name: l.name, src: l.examId, srcName: l.title, rid: l.rid, n: q.n, type: q.type,
          unit: tg.unit || (kq[q.n] && kq[q.n].label) || null, also: tg.also || [], concept: tg.concept || null, lv: tg.lv || null,
          pt: q.pt != null ? q.pt : null, answer: q.answer, key: q.key != null ? q.key : null, first: ox(ov), final: ox(ov), retries: 0,
          sec: Math.round((sec[q.n] || 0) * 10) / 10, late: !!q.late, score: l.score });
      }
    }
    for (const l of hl) {
      if (l.teacher || l.voided) continue;
      const k = keyOf[l.bookId] || {}, units = k.units || [];
      const kq = {}; (k.questions || []).forEach((q) => { kq[q.n] = q; });
      for (const q of l.questions || []) {
        const u = q.u != null ? q.u : kq[q.n] ? kq[q.n].u : null;
        rows.push({ kind: "과제", date: l.date, cid: c.id, cls: c.name, sid: l.sid, name: l.name, src: l.bookId, srcName: l.title, rid: l.rid, n: q.n, type: q.type,
          unit: u != null && units[u] ? units[u] : null, also: [], concept: null, lv: null, pt: null, answer: q.answer,
          key: kq[q.n] && kq[q.n].ans != null ? kq[q.n].ans : null, first: ox(q.auto), final: ox(q.fin != null ? q.fin : q.auto),
          retries: (q.tries || []).length, sec: q.sec != null ? q.sec : null, late: false, score: null, lect: !!(q.lect || q.lectFreed) });
      }
    }
  }
  if (DRY) { log("(dry) 반 " + classes.length + " · 줄 " + rows.length); return; }
  fs.mkdirSync(path.join(OUT, "raw", today), { recursive: true });
  fs.writeFileSync(path.join(OUT, "raw", today, "raw.json"), JSON.stringify(raw));
  // 쌓기 — 지우지 않는다. 같은 (종류·반·rid·번호)는 새 값으로
  const F = path.join(OUT, "학습기록.jsonl"), all = new Map();
  const id = (r) => [r.kind, r.cid, r.rid, r.n].join("|");
  if (fs.existsSync(F)) fs.readFileSync(F, "utf8").split("\n").filter(Boolean).forEach((s) => { const r = JSON.parse(s); all.set(id(r), r); });
  const before = all.size;
  rows.forEach((r) => all.set(id(r), r));
  const list = [...all.values()].sort((a, b) => (a.date + a.name + a.src + String(a.n).padStart(4, "0")).localeCompare(b.date + b.name + b.src + String(b.n).padStart(4, "0")));
  fs.writeFileSync(F + ".tmp", list.map((r) => JSON.stringify(r)).join("\n") + "\n"); fs.renameSync(F + ".tmp", F);
  const cols = ["kind", "date", "cls", "name", "srcName", "n", "type", "unit", "concept", "lv", "first", "final", "retries", "sec", "late", "answer", "key", "pt", "score", "src", "cid", "sid", "rid"];
  const esc = (v) => { const s = v == null ? "" : Array.isArray(v) ? v.join("/") : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  fs.writeFileSync(path.join(OUT, "학습기록.csv"), "﻿" + cols.join(",") + "\n" + list.map((r) => cols.map((c) => esc(r[c])).join(",")).join("\n") + "\n");
  const students = new Set(list.map((r) => r.name)).size;
  log("반 " + classes.length + " · 오늘 받은 줄 " + rows.length + " · 쌓인 줄 " + list.length + " (새로 " + (list.length - before) + ") · 학생 " + students + "명");
}
main().catch((e) => { log("실패: " + e.message); process.exit(1); });
