// 조각 운영 도구 (2026-10-12) — 열쇠는 tools/lesson-key.json (exam-push 와 같은 것)
//
//   node tools/pieces.mjs --get                                   설정 · 오늘 이벤트 · 반별 장부(조각 · 받을 상품)
//   node tools/pieces.mjs --event "CU 바나나우유 240ml" --stock 2 [--pct 100] [--cap 1] [--title "오늘만 — 바나나우유"] [--id ev-banana]
//                                                                 오늘만 이벤트 켜기 · 재고 다시 적기(같은 --id 면 교환권이 그 재고로 바뀐다)
//   node tools/pieces.mjs --event-off                             이벤트 끄기
//   node tools/pieces.mjs --items-clear                           평소 상품표 비우기(상품이 없으면 구슬이 안 열린다 — 구슬은 그대로)
//   node tools/pieces.mjs --reset <반ID> [학생ID…]                장부 지우기 — 먼저 tools/logs/pieces-backup-*.json 에 받아 둔다
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = (process.env.CLIMATH_URL || "https://climath-class.vercel.app") + "/api/exam";
const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const has = (k) => args.includes(k);
const key = JSON.parse(fs.readFileSync(path.join(HERE, "lesson-key.json"), "utf8")).key;
async function call(body) {
  const r = await fetch(APP, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ toolKey: key, action: "pcAdmin", ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error("✗ " + r.status + " " + (j.error || "")); process.exit(1); }
  return j;
}
function show(j) {
  const ev = j.cfg.event;
  console.log("오늘(한국) " + j.today + " · 대상 반 " + j.cids.join(", "));
  console.log("상품표: " + ((j.cfg.items || []).map((x) => x.name + " " + (x.pct != null ? x.pct + "%" : "(확률 없음 — 옛 판)") + " 재고 " + (x.stock == null ? "∞" : x.stock)).join(" · ") || "비어 있음"));
  console.log("이벤트: " + (ev ? ev.day + (ev.day === j.today ? " (오늘 켜짐)" : " (지난 것)") + " · " + (ev.title || "") + " · 한 사람 " + ev.cap + "개 · " + ev.items.map((x) => x.name + " " + x.pct + "% 재고 " + (x.stock == null ? "∞" : x.stock)).join(" · ") : "없음"));
  for (const [c, rows] of Object.entries(j.ledgers)) {
    console.log("— " + c + " 장부 " + rows.length + "개");
    for (const d of rows) console.log("   " + d.id + " " + (d.name || "") + " · 조각 " + (d.bal || 0) + " · 모은 " + (d.earned || 0) + " · 연 구슬 " + (d.opened || 0)
      + (d.day || d.dayPts != null || d.focus ? " · ⚠ 옛 판 칸 있음" : "") + " · 받을 상품 " + ((d.prizes || []).filter((p) => !p.given).map((p) => p.name).join(", ") || "-"));
  }
}
if (has("--get")) show(await call({ op: "get" }));
else if (has("--event-off")) { await call({ op: "event", off: true }); console.log("이벤트 끔"); }
else if (has("--event")) {
  const j = await call({ op: "event", title: arg("--title") || "", cap: Number(arg("--cap") || 1),
    items: [{ id: arg("--id") || "ev-1", name: arg("--event"), pct: Number(arg("--pct") || 100), stock: arg("--stock") == null ? null : Number(arg("--stock")) }] });
  console.log("이벤트 켬: " + JSON.stringify(j.event));
}
else if (has("--items-clear")) { await call({ op: "items", items: [] }); console.log("평소 상품표 비움"); }
else if (has("--reset")) {
  const cid = arg("--reset"), j = await call({ op: "get", cids: [cid] });
  const rows = j.ledgers[cid] || [], pick = args.slice(args.indexOf("--reset") + 2).filter((x) => !x.startsWith("--"));
  const sids = (pick.length ? rows.filter((d) => pick.includes(d.id)) : rows).map((d) => d.id);
  if (!sids.length) { console.log("지울 장부가 없어요"); process.exit(0); }
  fs.mkdirSync(path.join(HERE, "logs"), { recursive: true });
  const f = path.join(HERE, "logs", "pieces-backup-" + cid + "-" + Date.now() + ".json");
  fs.writeFileSync(f, JSON.stringify(rows.filter((d) => sids.includes(d.id)), null, 1));
  console.log("받아 둠: " + f);
  if (has("--dry")) { console.log("(--dry) 지울 것: " + sids.join(", ")); process.exit(0); }
  const r = await call({ op: "resetLedger", cid, sids });
  console.log("장부 " + r.deleted + "개 지움");
}
else console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n"));
