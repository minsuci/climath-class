// index.html 안 <script type="text/plain" id="__appSource"> 블록만 뽑아 JSX 문법 검사.
// 브라우저와 같은 조건(presets:["react"], sourceType:"script")으로 변환해본다.
//   실행: node tools/check-jsx.mjs
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { transformSync } from "@babel/core";
import presetReact from "@babel/preset-react";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "index.html"), "utf8");

const m = html.match(
  /<script type="text\/plain" id="__appSource">([\s\S]*?)<\/script>/
);
if (!m) {
  console.error("실패: __appSource 블록을 찾지 못했습니다. index.html 구조가 바뀌었나요?");
  process.exit(1);
}

// 블록이 index.html 몇 번째 줄에서 시작하는지 (에러 줄 번호를 원본 기준으로 환산)
const offset = html.slice(0, m.index).split("\n").length;
const src = m[1];

// 브라우저 콘솔에서 보기 편하도록 추출본도 남겨둔다
const extracted = join(root, "tools", "appsrc.js");
writeFileSync(extracted, src);

try {
  transformSync(src, { presets: [presetReact], sourceType: "script", filename: "appsrc.js" });
  console.log(`OK — JSX 문법 이상 없음 (${src.split("\n").length}줄, index.html ${offset}행부터)`);
} catch (e) {
  const line = e.loc ? e.loc.line : null;
  console.error("JSX 문법 오류");
  console.error("  " + e.message.split("\n")[0]);
  if (line) console.error(`  → index.html 약 ${offset + line - 1}행 (추출본 ${extracted} 의 ${line}행)`);
  process.exit(1);
}
