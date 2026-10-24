// 학원 교재 정답 창고를 앱(서버 shelf)에 올린다 — 선생님은 앱 «교재 고르기»에서 과목 → 교재 → 권을 골라 반에 건다.
//
//   node tools/shelf-push.mjs                     창고 폴더 전부 올리기 (같은 교재는 덮어쓴다 — 이미 건 반은 다음에 «다시 걸기» 때 새 정답)
//   node tools/shelf-push.mjs --dry               무엇이 어느 과목·교재·권으로 보일지 표만
//   node tools/shelf-push.mjs --only 코어-공수1-1  그 교재만
//   node tools/shelf-push.mjs --dir <폴더>         창고 폴더 (기본: 바탕화면 변형교재\_클래스앱도구\교재 정답)
//
// 창고 파일은 _교재정답_scripts 가 만든 것 — { id: "과제-<key>", title, units?, questions: [{ n, type, ans?, label?, u? }] }
// 파일 이름(<key>.json)이 «시리즈-과목권» 꼴이다: 코어-공수1-1 · 베켐-대수2 · 베이스-대수 · 96-대수2 · BASE-공수1-1
// 열쇠는 tools/lesson-key.json (exam-push 와 같은 것). 저장소에 안 들어간다.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = (process.env.CLIMATH_URL || "https://climath-class.vercel.app") + "/api/exam";
const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const has = (k) => args.includes(k);
const DIR = arg("--dir") || path.join(process.env.USERPROFILE || "", "Desktop", "변형교재", "_클래스앱도구", "교재 정답");

// 시리즈 — 칩에 보일 이름 · 아랫줄 · 순서
const SERIES = {
  "코어": ["코어", "Unlimited Core"], "챌린지": ["챌린지", "Unlimited Challenge"], "베이스": ["베이스", "Unlimited Base"],
  "베켐": ["베이스캠프", "내신 Basecamp"], "96": ["96%", "내신 96%"], "퍼펙트": ["퍼펙트", "내신 Perfect"], "BASE": ["BASE", "BASE"],
};
const ORDER = ["코어", "챌린지", "베이스", "베켐", "96", "퍼펙트", "BASE"];   // 객체 키 순서는 «96» 같은 숫자 키가 맨 앞으로 간다 — 따로 둔다
const SUBJ = { "공수1": "공통수학1", "공수2": "공통수학2", "대수": "대수", "미적1": "미적분Ⅰ", "미적2": "미적분Ⅱ" };

export function shelfMeta(key, title) {
  const [ser, rest = ""] = key.split(/-(.*)/s);
  const m = /^(공수1|공수2|대수|미적1|미적2)/.exec(rest);
  if (!SERIES[ser] || !m) return null;
  const v = /(\d+)권(.*)$/.exec(title || "");
  const vol = v ? v[1] + "권" + v[2].trim() : "한 권";
  const si = ORDER.indexOf(ser);
  return { subj: SUBJ[m[1]], series: SERIES[ser][0], seriesName: SERIES[ser][1], vol, order: si * 100 + (v ? Number(v[1]) : 0) };
}

function key() {
  const p = path.join(HERE, "lesson-key.json");
  if (!fs.existsSync(p)) { console.error("lesson-key.json 이 없습니다: " + p); process.exit(1); }
  return JSON.parse(fs.readFileSync(p, "utf8")).key;
}

async function main() {
  if (!fs.existsSync(DIR)) { console.error("창고 폴더가 없습니다: " + DIR); process.exit(1); }
  const only = arg("--only");
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json") && !f.endsWith(".review.json") && (!only || f === only + ".json"));
  if (!files.length) { console.error("올릴 교재가 없습니다" + (only ? " — " + only : "")); process.exit(1); }
  const books = [];
  for (const f of files) {
    const k = f.slice(0, -5), b = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
    const meta = shelfMeta(k, b.title);
    if (!meta) { console.error("이름을 못 읽음(시리즈-과목권 꼴이 아님): " + f); process.exit(1); }
    if (b.id !== "과제-" + k) { console.error(f + " — id 가 «과제-" + k + "» 가 아님: " + b.id); process.exit(1); }
    books.push({ key: k, title: b.title, units: b.units || [], meta, questions: b.questions });
  }
  books.sort((a, b) => a.meta.subj.localeCompare(b.meta.subj) || a.meta.order - b.meta.order);
  for (const b of books) {
    const auto = b.questions.filter((q) => q.type !== "essay").length;
    console.log([b.meta.subj, b.meta.series, b.meta.vol, b.key, b.questions.length + "문항", "바로 채점 " + auto].join("  ·  "));
  }
  console.log("— " + books.length + "권");
  if (has("--dry")) return;
  const tk = key();
  for (let i = 0; i < books.length; i += 6) {   // 한 번에 6권씩 (요청 크기)
    const part = books.slice(i, i + 6);
    const r = await fetch(APP, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ toolKey: tk, action: "shelfPut", books: part }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.error("실패: " + (j.error || r.status) + " — " + part.map((b) => b.key).join(", ")); process.exit(1); }
    console.log("올림 " + part.map((b) => b.key).join(", ") + " (창고 " + j.total + "권)");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
