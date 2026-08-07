const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, ShadingType, AlignmentType, BorderStyle, HeadingLevel,
  ImageRun, Footer, PageNumber, PageBreak, VerticalAlign, HeightRule,
} = require("docx");

/* ── 팔레트 ───────────────────────────────────────────── */
const NAVY = "1B3A5C";
const ACC  = "C2410C";
const GREY = "64748B";
const LINE = "D6DEE8";
const BOX  = "F4F7FA";
const WARM = "FDF5EA";
const ANSB = "F0F5F1";
const W    = 9638;                      // 본문 폭 (DXA)
const FONT = "맑은 고딕";

/* ── 인라인 서식 파서: **굵게**, ^지수 / ^{여러글자} ──── */
function rich(text, base = {}) {
  const runs = [];
  text.split("**").forEach((seg, i) => {
    const bold = base.bold || i % 2 === 1;
    let buf = "", j = 0;
    const flush = () => { if (buf) { runs.push(new TextRun({ ...base, bold, text: buf })); buf = ""; } };
    while (j < seg.length) {
      if (seg[j] === "^") {
        flush(); j++;
        let sup = "";
        if (seg[j] === "{") { j++; while (j < seg.length && seg[j] !== "}") sup += seg[j++]; j++; }
        else { sup = seg[j] ?? ""; j++; }
        runs.push(new TextRun({ ...base, bold, text: sup, superScript: true }));
      } else { buf += seg[j++]; }
    }
    flush();
  });
  return runs.length ? runs : [new TextRun({ ...base, text: "" })];
}

/* ── 문단 헬퍼 ───────────────────────────────────────── */
const p = (text = "", o = {}) => new Paragraph({
  children: rich(text, { size: o.size ?? 21, color: o.color ?? "1F2937", font: FONT, italics: o.italics }),
  alignment: o.align,
  spacing: { before: o.before ?? 0, after: o.after ?? 90, line: o.line ?? 300 },
  indent: o.indent,
});

const spacer = (h = 120) => new Paragraph({ spacing: { after: h }, children: [] });

/* 회차 배너 */
function banner(no, title, sub) {
  return new Table({
    columnWidths: [W], width: { size: W, type: WidthType.DXA },
    borders: noBorders(),
    rows: [new TableRow({ children: [new TableCell({
      width: { size: W, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: NAVY, color: "auto" },
      margins: { top: 260, bottom: 260, left: 340, right: 340 },
      children: [
        new Paragraph({ spacing: { after: 60 }, children: rich(`CLIMATH 성인수학 · ${no}회차`, { size: 18, color: "9DB6CE", font: FONT }) }),
        new Paragraph({ spacing: { after: 70 }, children: rich(title, { size: 34, color: "FFFFFF", bold: true, font: FONT }) }),
        new Paragraph({ children: rich(sub, { size: 19, color: "C7D6E5", font: FONT }) }),
      ],
    })] })],
  });
}

const noBorders = () => ({
  top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  insideHorizontal: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  insideVertical: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
});

/* 블록 머리 (시간 + 제목) */
function blockHead(time, title) {
  return new Table({
    columnWidths: [W], width: { size: W, type: WidthType.DXA }, borders: noBorders(),
    rows: [new TableRow({ children: [new TableCell({
      width: { size: W, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: NAVY, color: "auto" },
      margins: { top: 130, bottom: 130, left: 240, right: 240 },
      children: [new Paragraph({ children: [
        ...rich(time, { size: 18, color: "9DB6CE", font: FONT }),
        new TextRun({ text: "   ", font: FONT }),
        ...rich(title, { size: 24, color: "FFFFFF", bold: true, font: FONT }),
      ] })],
    })] })],
  });
}

/* 소제목 */
const h3 = (t) => new Paragraph({
  children: rich(t, { size: 23, color: NAVY, bold: true, font: FONT }),
  spacing: { before: 260, after: 130 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: LINE, space: 6 } },
});

const h4 = (t) => new Paragraph({
  children: rich(t, { size: 21, color: ACC, bold: true, font: FONT }),
  spacing: { before: 200, after: 90 },
});

/* 컬러 박스 */
function box(lines, o = {}) {
  const fill = o.fill ?? BOX;
  const bar = o.bar ?? NAVY;
  return new Table({
    columnWidths: [W], width: { size: W, type: WidthType.DXA },
    borders: { ...noBorders(), left: { style: BorderStyle.SINGLE, size: 18, color: bar } },
    rows: [new TableRow({ cantSplit: true, children: [new TableCell({
      width: { size: W, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill, color: "auto" },
      margins: { top: 190, bottom: 190, left: 300, right: 280 },
      children: lines.length ? lines : [p("")],
    })] })],
  });
}

/* 가운데 정렬 수식 줄 */
const eq = (t, o = {}) => new Paragraph({
  children: rich(t, { size: o.size ?? 22, color: o.color ?? "1F2937", font: FONT, bold: o.bold }),
  alignment: AlignmentType.CENTER,
  spacing: { before: o.before ?? 40, after: o.after ?? 40, line: 300 },
});

/* 들여쓴 수식 줄 (유도용) */
const step = (t, o = {}) => new Paragraph({
  children: rich(t, { size: 21, color: o.color ?? "1F2937", font: FONT, bold: o.bold }),
  indent: { left: 400 },
  spacing: { after: 50, line: 290 },
});

/* 인용 / 멘트 */
const quote = (t) => new Paragraph({
  children: rich(t, { size: 21, color: NAVY, font: FONT, italics: true }),
  indent: { left: 300 },
  spacing: { before: 100, after: 140, line: 310 },
  border: { left: { style: BorderStyle.SINGLE, size: 12, color: ACC, space: 10 } },
});

/* 일반 표 */
function table(headers, rows, widths, o = {}) {
  const cell = (txt, i, head) => new TableCell({
    width: { size: widths[i], type: WidthType.DXA },
    shading: { type: ShadingType.CLEAR, fill: head ? NAVY : (o.zebra && o.r % 2 ? BOX : "FFFFFF"), color: "auto" },
    margins: { top: 110, bottom: 110, left: 160, right: 160 },
    verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({
      children: rich(String(txt), { size: 20, color: head ? "FFFFFF" : "1F2937", bold: head, font: FONT }),
      alignment: o.center?.includes(i) ? AlignmentType.CENTER : undefined,
      spacing: { after: 0, line: 280 },
    })],
  });
  return new Table({
    columnWidths: widths, width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 6, color: LINE },
      bottom: { style: BorderStyle.SINGLE, size: 6, color: LINE },
      left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
      right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: LINE },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "EDF1F6" },
    },
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((h, i) => cell(h, i, true)) }),
      ...rows.map((r, ri) => { o.r = ri; return new TableRow({ children: r.map((c, i) => cell(c, i, false)) }); }),
    ],
  });
}

/* 답안 기입용 밑줄 n줄 — 인접 문단의 같은 테두리는 병합되므로 표로 그린다 */
function ruled(n, width = W - 500) {
  return [
    new Paragraph({ spacing: { after: 130 }, children: [] }),
    new Table({
      columnWidths: [width], width: { size: width, type: WidthType.DXA },
      indent: { size: 240, type: WidthType.DXA },
      borders: {
        top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
        left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
        right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
        insideVertical: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
        bottom: { style: BorderStyle.SINGLE, size: 4, color: "C8D3E0" },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "C8D3E0" },
      },
      rows: Array.from({ length: n }, () => new TableRow({
        height: { value: 440, rule: HeightRule.ATLEAST },
        children: [new TableCell({
          width: { size: width, type: WidthType.DXA },
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          children: [new Paragraph({ spacing: { after: 0 }, children: [] })],
        })],
      })),
    }),
    new Paragraph({ spacing: { after: 0 }, children: [] }),
  ];
}

/* 문제 격자 (n열) — 아래 여백 또는 밑줄이 풀이 공간 */
function probs(items, cols = 2, space = 320, rule = 0) {
  const cw = Math.floor(W / cols);
  const widths = Array(cols).fill(cw);
  const rows = [];
  for (let i = 0; i < items.length; i += cols) {
    const chunk = items.slice(i, i + cols);
    while (chunk.length < cols) chunk.push("");
    rows.push(new TableRow({ cantSplit: true, children: chunk.map((t) => new TableCell({
      width: { size: cw, type: WidthType.DXA },
      margins: { top: 90, bottom: rule ? 200 : space, left: 60, right: 200 },
      children: [
        ...String(t).split("\n").map((ln) => new Paragraph({
          children: rich(ln, { size: 21, font: FONT }), spacing: { after: 0, line: 290 },
        })),
        ...(rule && t ? ruled(rule) : []),
      ],
    })) }));
  }
  return new Table({ columnWidths: widths, width: { size: W, type: WidthType.DXA }, borders: noBorders(), rows });
}

/* 정답 항목 */
const ansItem = (no, ans, sol) => new Paragraph({
  children: [
    ...rich(`${no} `, { size: 20, color: GREY, font: FONT }),
    ...rich(ans, { size: 20, color: ACC, bold: true, font: FONT }),
    ...(sol ? rich(`   ${sol}`, { size: 19, color: "475569", font: FONT }) : []),
  ],
  spacing: { after: 70, line: 285 },
  indent: { left: 120, hanging: 0 },
});

const ansHead = (t) => new Paragraph({
  children: rich(t, { size: 21, color: NAVY, bold: true, font: FONT }),
  spacing: { before: 220, after: 110 },
});
/* ══ 문서 조립 ══════════════════════════════════════════
   body(문단 배열)를 A4 문서로 묶어 파일로 쓴다.
   꼬리말은 "CLIMATH 성인수학 · N회차 · 쪽번호".
   ══════════════════════════════════════════════════════ */
function buildDoc({ lesson, body, outPath }) {
  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: 21, color: "1F2937" } } } },
    sections: [{
      properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
      footers: { default: new Footer({ children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({
          font: FONT, size: 17, color: GREY,
          children: [`CLIMATH 성인수학  ·  ${lesson}회차  ·  `, PageNumber.CURRENT],
        })],
      })] }) },
      children: body,
    }],
  });
  return Packer.toBuffer(doc).then((buf) => {
    require("fs").writeFileSync(outPath, buf);
    console.log("작성 완료:", outPath.split("/").pop(), buf.length, "bytes");
  });
}

module.exports = {
  NAVY, ACC, GREY, LINE, BOX, WARM, ANSB, W, FONT,
  rich, p, spacer, banner, noBorders, blockHead, h3, h4, box,
  eq, step, quote, table, ruled, probs, ansItem, ansHead, buildDoc,
  Paragraph, TextRun, PageBreak, ImageRun, AlignmentType, BorderStyle, WidthType,
};
