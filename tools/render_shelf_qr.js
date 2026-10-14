// v0.4.5 무인 선반 QR 스티커 렌더 검증 — 실행: npx electron tools/render_shelf_qr.js <payload.json> <출력폴더>
// 80mm·58mm 각각 ① HTML(OS 인쇄 경로) ② 래스터(203dpi 프린터 도트 그대로 — 기본 인쇄 경로) ③ ESC/POS 텍스트 모드 복원
const { app, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const { buildReceiptLines, renderReceiptHtml } = require("../src/receipt");
const { buildEscpos, emulate } = require("../src/escpos");
const { renderPreviewPng, renderRasterBitmap } = require("../src/printing");

const payload = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const out = path.resolve(process.argv[3] || "preview_out/shelf_qr");
fs.mkdirSync(out, { recursive: true });

app.on("window-all-closed", () => {});
app.whenReady().then(async () => { try {
  for (const [mm, cols, dots] of [[80, 48, 576], [58, 32, 384]]) {
    const lines = buildReceiptLines(payload, cols);
    await renderPreviewPng(renderReceiptHtml(lines, mm), mm, path.join(out, `sticker_${mm}mm_html.png`));
    const r = await renderRasterBitmap(renderReceiptHtml(lines, mm, { pxWidth: dots }), dots);
    const bgra = Buffer.alloc(r.widthDots * r.height * 4, 0xff);
    for (let y = 0; y < r.height; y++) for (let x = 0; x < r.widthDots; x++) {
      if (r.data[y * r.rowBytes + (x >> 3)] & (0x80 >> (x & 7))) { const o = (y * r.widthDots + x) * 4; bgra[o] = bgra[o + 1] = bgra[o + 2] = 0; }
    }
    fs.writeFileSync(path.join(out, `sticker_${mm}mm_raster203dpi.png`),
      nativeImage.createFromBitmap(bgra, { width: r.widthDots, height: r.height }).toPNG());
    const em = emulate(buildEscpos(lines, { cols }), cols);
    fs.writeFileSync(path.join(out, `sticker_${mm}mm_escpos_text.txt`), em.lines.map((l) => l.text).join("\n"));
  }
  console.log("rendered", out); } catch (e) { console.error("FAIL", e); }
  app.quit();
});
