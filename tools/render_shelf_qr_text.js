// v0.4.5 텍스트 모드(ESC/POS 네이티브 QR, GS ( k) 스티커 검증 — 프린터가 실제로 찍는 모습으로 그린다.
// 실행: npx electron tools/render_shelf_qr_text.js <payload.json> <출력폴더>
//  글자 = Font A(12×24도트) · QR = 모델2 · 셀 6도트 · 오류정정 M(앱이 보내는 GS ( k 파라미터 그대로) · 정렬 ESC a
//  QR 행렬 생성에만 `qrcode` 라이브러리를 쓴다(앱 본체에는 없음 — 서버 node_modules 폴백).
const { app, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const { buildReceiptLines } = require("../src/receipt");
const { buildEscpos, emulate } = require("../src/escpos");
const { renderRasterBitmap } = require("../src/printing");
let QRCode; try { QRCode = require("qrcode"); } catch { QRCode = require(path.join(process.env.HOME, "norder_app/node_modules/qrcode")); }

const CELL = 6, QUIET = 4;
function qrSvg(url) {
  const m = QRCode.create(url, { errorCorrectionLevel: "M" }).modules; // 프린터와 같은 조건: 최소 버전 자동 선택
  const n = m.size, px = (n + QUIET * 2) * CELL;
  let r = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m.get(y, x))
    r += `<rect x="${(x + QUIET) * CELL}" y="${(y + QUIET) * CELL}" width="${CELL}" height="${CELL}"/>`;
  return { html: `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${r}</g></svg>`, version: (n - 17) / 4, px };
}
function html(decoded, cols, dots) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = decoded.map((l) => {
    if (l.text.startsWith("[QR] ")) return `<div class="ln" style="text-align:center">${qrSvg(l.text.slice(5)).html}</div>`;
    const limit = l.size === 2 ? Math.floor(cols / 2) : cols;
    const w = [...l.text].reduce((a, c) => a + (c.charCodeAt(0) > 0x7f ? 2 : 1), 0);
    const gap = Math.max(0, limit - w), left = l.align === "center" ? Math.floor(gap / 2) : l.align === "right" ? gap : 0;
    return `<div class="ln${l.bold ? " b" : ""}${l.size === 2 ? " x2" : ""}">${esc(" ".repeat(left) + l.text) || "&nbsp;"}</div>`;
  }).join("");
  // Font A 12×24 도트: 한 칸 12px, 줄 24px. 한글은 2칸(24px) — 폰트 폭 비율로 맞춘다.
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;background:#fff;width:${dots}px}
    .ln{font-family:"Menlo","AppleSDGothicNeo",monospace;font-size:19.9px;line-height:24px;white-space:pre;letter-spacing:0}
    .b{font-weight:700}.x2{font-size:39.8px;line-height:48px;font-weight:700}
    svg{display:inline-block;vertical-align:top}
  </style></head><body>${body}</body></html>`;
}
const payload = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const out = path.resolve(process.argv[3] || "preview_out/shelf_qr_text"); fs.mkdirSync(out, { recursive: true });
app.on("window-all-closed", () => {});
app.whenReady().then(async () => { try {
  for (const [mm, cols, dots] of [[80, 48, 576], [58, 32, 384]]) {
    const buf = buildEscpos(buildReceiptLines(payload, cols), { cols });
    const em = emulate(buf, cols);
    const qrLines = em.lines.filter((l) => l.text.startsWith("[QR] "));
    const r = await renderRasterBitmap(html(em.lines, cols, dots), dots);
    const bgra = Buffer.alloc(r.widthDots * r.height * 4, 0xff);
    for (let y = 0; y < r.height; y++) for (let x = 0; x < r.widthDots; x++)
      if (r.data[y * r.rowBytes + (x >> 3)] & (0x80 >> (x & 7))) { const o = (y * r.widthDots + x) * 4; bgra[o] = bgra[o + 1] = bgra[o + 2] = 0; }
    fs.writeFileSync(path.join(out, `sticker_${mm}mm_escpos_text_emulated.png`), nativeImage.createFromBitmap(bgra, { width: r.widthDots, height: r.height }).toPNG());
    const info = qrLines.map((l) => { const q = qrSvg(l.text.slice(5)); return { url: l.text.slice(5), version: q.version, mm: +(q.px / 203 * 25.4).toFixed(1) }; });
    fs.writeFileSync(path.join(out, `sticker_${mm}mm_escpos_text_qr.json`), JSON.stringify({ mm, cols, dots, bytes: buf.length, qr: info }, null, 2));
    console.log(mm + "mm", JSON.stringify(info));
  }
  console.log("rendered", out); } catch (e) { console.error("FAIL", e); process.exitCode = 1; }
  app.quit();
});
