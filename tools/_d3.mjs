import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const pg = await b.newPage({ viewport: { width: 430, height: 932 } });
const errs = []; pg.on("pageerror", (e) => errs.push("PAGEERROR " + e.message));
await pg.goto("http://127.0.0.1:8899/preview.html?admin=1"); await pg.waitForTimeout(1200);
await pg.getByText("한민수").first().click({ force: true });
await pg.locator("input[type=password], input[inputmode=numeric]").first().fill("2030");
await pg.keyboard.press("Enter"); await pg.waitForTimeout(700);
await pg.getByText("개별진도 목요").first().click({ force: true }); await pg.waitForTimeout(500);
await pg.evaluate(() => { const el = [...document.querySelectorAll("span,button,div")].find((e) => e.textContent.trim() === "수업 로그"); (el.closest("button") || el).click(); });
await pg.waitForTimeout(700);
console.log("화면 진입 직후 잠금상태:", await pg.evaluate(() => clUnlocked));
// 첫 터치 = "수업 시작" 버튼. pointerdown 이 click 보다 먼저라 그 사이에 풀려야 한다
await pg.getByRole("button", { name: /기록 시작|수업 시작/ }).click();
await pg.waitForTimeout(900);
console.log("첫 터치 뒤 잠금:", await pg.evaluate(() => clUnlocked),
            "| ctx:", await pg.evaluate(() => clCtx && clCtx.state),
            "| sink:", await pg.evaluate(() => !!clSinkEl && !clSinkEl.paused));
console.log("저장된 값:", await pg.evaluate(() => {
  const k = Object.keys(window.__store).find((x) => x.includes("lessonLogs"));
  const d = window.__store[k];
  return "beeped=" + d.beeped + " beepAt-startedAt=" + (d.beepAt ? (d.beepAt - d.startedAt) + "ms" : "없음");
}));
// 학생 하나 누르고 종료
await pg.getByText("지오").first().click({ force: true }); await pg.waitForTimeout(400);
pg.on("dialog", (d) => d.accept());
await pg.getByRole("button", { name: "수업 종료" }).click(); await pg.waitForTimeout(1200);
console.log("종료 뒤:", await pg.evaluate(() => {
  const k = Object.keys(window.__store).find((x) => x.includes("lessonLogs"));
  const d = window.__store[k];
  return "endBeepAt-endedAt=" + (d.endBeepAt ? (d.endBeepAt - d.endedAt) + "ms" : "없음") + " | beepAt=" + (d.beepAt ? "있음" : "없음");
}));
console.log("AudioContext 재사용(하나만):", await pg.evaluate(() => clCtx ? "1개" : "없음"));
console.log("ERRORS:", errs.length ? errs.join("\n") : "none");
await b.close();
