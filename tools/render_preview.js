// 미리보기 PNG 일괄 생성(육안 검증 게이트용) — 실행: npx electron tools/render_preview.js [출력폴더]
//  1) 80mm·58mm HTML 전표(OS 인쇄 폴백과 동일 렌더)
//  2) ESC/POS 에뮬레이터 복원 뷰(감열 프린터가 실제로 찍는 텍스트) — CP949 왕복 결과
const { app, nativeImage } = require("electron");
const path = require("path");
const fsMod = require("fs");
const { buildReceiptLines, renderReceiptHtml, dw } = require("../src/receipt");
const { buildEscpos, emulate, buildEscposRaster, emulateRaster } = require("../src/escpos");
const { renderPreviewPng, renderRasterBitmap, dotsOf } = require("../src/printing");
const sampleOrder = require("../src/sample-order");

const outDir = path.resolve(process.argv[2] || path.join(__dirname, "..", "preview_out"));
require("fs").mkdirSync(outDir, { recursive: true });

function emulatorHtml(decoded, cols, widthMm) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const pad = (l) => {
    const limit = l.size === 2 ? Math.floor(cols / 2) : cols;
    const gap = limit - dw(l.text);
    if (l.align === "center") {
      const left = Math.floor(Math.max(0, gap) / 2);
      return " ".repeat(left) + l.text;
    }
    if (l.align === "right") return " ".repeat(Math.max(0, gap)) + l.text;
    return l.text;
  };
  const body = decoded.map((l) => {
    const cls = [l.bold ? "b" : "", l.size === 2 ? "x2" : ""].filter(Boolean).join(" ");
    return `<div class="ln ${cls}">${esc(pad(l)) || "&nbsp;"}</div>`;
  }).join("\n");
  // Menlo ASCII 폭 ≈ 0.602em — cols 칸이 인쇄 폭(여백 제외) 안에 정확히 들어가는 크기로 환산
  const fontPx = Math.floor((((widthMm - 6) / 25.4) * 96) / (cols * 0.602) * 10) / 10;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin:0; background:#fff; width:${widthMm}mm; }
    .paper { padding:4mm 3mm; font-family:"Menlo","Consolas","AppleSDGothicNeo",monospace;
             font-size:${fontPx}px; line-height:1.45; color:#000; }
    .ln { white-space:pre; } .b { font-weight:700; }
    .x2 { font-size:${fontPx * 2}px; font-weight:700; letter-spacing:0; }
  </style></head><body><div class="paper">${body}</div></body></html>`;
}

app.on("window-all-closed", () => { /* 렌더 창을 순차로 여닫는다 — 자동 종료 금지 */ });

app.whenReady().then(async () => {
  try {
    for (const [widthMm, cols] of [[80, 48], [58, 32]]) {
      const payload = sampleOrder();
      const lines = buildReceiptLines(payload, cols);

      const htmlFile = path.join(outDir, `receipt_html_${widthMm}mm.png`);
      await renderPreviewPng(renderReceiptHtml(lines, widthMm), widthMm, htmlFile);
      console.log("saved", htmlFile);

      const { lines: decoded } = emulate(buildEscpos(lines, { cols }), cols);
      const emuFile = path.join(outDir, `receipt_escpos_emulated_${widthMm}mm.png`);
      await renderPreviewPng(emulatorHtml(decoded, cols, widthMm), widthMm, emuFile);
      console.log("saved", emuFile);

      // 래스터(이미지 인쇄) — 전송 버퍼를 역파싱해 «프린터가 찍는 픽셀» 그대로 복원
      const dots = dotsOf(widthMm);
      const raster = await renderRasterBitmap(renderReceiptHtml(lines, widthMm, { pxWidth: dots }), dots);
      const dec = emulateRaster(buildEscposRaster(raster));
      if (!dec.data.equals(raster.data)) throw new Error(`래스터 라운드트립 불일치 (${widthMm}mm)`);
      const bgra = Buffer.alloc(dec.widthDots * dec.height * 4, 0xff);
      for (let y = 0; y < dec.height; y++) {
        for (let x = 0; x < dec.widthDots; x++) {
          if (dec.data[y * dec.rowBytes + (x >> 3)] & (0x80 >> (x & 7))) {
            const o = (y * dec.widthDots + x) * 4;
            bgra[o] = bgra[o + 1] = bgra[o + 2] = 0;
          }
        }
      }
      const rasterFile = path.join(outDir, `receipt_raster_${widthMm}mm.png`);
      fsMod.writeFileSync(rasterFile,
        nativeImage.createFromBitmap(bgra, { width: dec.widthDots, height: dec.height }).toPNG());
      console.log("saved", rasterFile, `(${dec.widthDots}x${dec.height} dots, roundtrip OK)`);
    }
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
