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

// ── QA 극단 케이스(--qa) — 옵션 많은 주문·긴 이름·큰 금액·CP949 밖 글자·아주 긴 주문 + 연결 안내 화면 ──
function rasterToPng(d) {
  const bgra = Buffer.alloc(d.widthDots * d.height * 4, 0xff);
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.widthDots; x++) {
      if (d.data[y * d.rowBytes + (x >> 3)] & (0x80 >> (x & 7))) {
        const o = (y * d.widthDots + x) * 4;
        bgra[o] = bgra[o + 1] = bgra[o + 2] = 0;
      }
    }
  }
  return nativeImage.createFromBitmap(bgra, { width: d.widthDots, height: d.height }).toPNG();
}

async function renderQaCases(dir) {
  const { BrowserWindow } = require("electron");
  const extreme = sampleOrder({ orderNo: "ENZYME77-260925-0099", items: [
    { name: "특대 왕갈비 숯불구이 정식 (공깃밥·된장찌개·계절나물 포함) 프리미엄 한정판", qty: 12, unitPriceKrw: 1234500, lineAmountKrw: 14814000,
      options: ["사이즈 · 특대(곱빼기보다 훨씬 많이, 2~3인분 양으로 나갑니다) (+15,000원)", "맵기 · 아주매운맛",
        "추가 토핑 · 모차렐라&체다 <더블> 치즈 ×3 (+4,500원)", "소스 · «시그니처» 소스 · 🌶️ 핫칠리", "Café Latte · Größe XL",
        "포장 · ㈜한상 전용용기", "음료 · 콜라 ×2 (+4,000원)", "사이드 · 계란찜", "사이드 · 김치전", "사이드 · 잡채",
        "밥 · 현미밥으로 변경", "수저 · 필요 없음"] },
    { name: "ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ-no-space-long-english-name", qty: 1, unitPriceKrw: 0, lineAmountKrw: 0, options: ["무료옵션 · 기본"] },
  ] });
  const many = sampleOrder({ orderNo: "ENZYME77-260925-0100", items: Array.from({ length: 40 }, (_, i) => ({
    name: `메뉴 ${i + 1}번 불고기 덮밥`, qty: 1, unitPriceKrw: 9000, lineAmountKrw: 9000, options: ["사이즈 · 곱빼기 (+1,500원)", "맵기 · 순한맛"] })) });
  for (const [mm, cols] of [[80, 48], [58, 32]]) {
    const lines = buildReceiptLines(extreme, cols);
    const f = path.join(dir, `PK_extreme_html_${mm}mm.png`);
    await renderPreviewPng(renderReceiptHtml(lines, mm), mm, f); console.log("saved", f);
    const { lines: dec } = emulate(buildEscpos(lines, { cols }), cols);
    fsMod.writeFileSync(path.join(dir, `PK_extreme_text_${mm}mm.txt`), dec.map((l) => l.text).join("\n"));
    const r = await renderRasterBitmap(renderReceiptHtml(lines, mm, { pxWidth: dotsOf(mm) }), dotsOf(mm));
    fsMod.writeFileSync(path.join(dir, `PK_extreme_raster_${mm}mm.png`), rasterToPng(r));
  }
  const ml = buildReceiptLines(many, 48);
  const mr = await renderRasterBitmap(renderReceiptHtml(ml, 80, { pxWidth: dotsOf(80) }), dotsOf(80));
  fsMod.writeFileSync(path.join(dir, "PK_many_raster_80mm.png"), rasterToPng(mr));
  console.log(`many: lines ${ml.length} · raster height ${mr.height} (예전 상한 6000)`);
  // 상한 초과 주문 — 조용히 잘리지 않고 오류로 알리는지
  const huge = sampleOrder({ items: Array.from({ length: 160 }, (_, i) => ({ name: `메뉴 ${i + 1}`, qty: 1, unitPriceKrw: 1, lineAmountKrw: 1, options: ["a · b", "c · d"] })) });
  try {
    await renderRasterBitmap(renderReceiptHtml(buildReceiptLines(huge, 48), 80, { pxWidth: dotsOf(80) }), dotsOf(80));
    console.log("huge: 오류 없음(상한 안)");
  } catch (e) { console.log("huge: 오류 →", e.message); }

  for (const kind of ["network", "server", "crash"]) {
    const w = new BrowserWindow({ show: false, width: 1000, height: 640, webPreferences: { offscreen: true, sandbox: true } });
    await w.loadFile(path.join(__dirname, "..", "src", "offline.html"), { query: { kind, url: "https://norder-web-staging.up.railway.app/partner/delivery" } });
    await new Promise((r) => setTimeout(r, 400));
    const f = path.join(dir, `PK-06_${kind}.png`);
    fsMod.writeFileSync(f, (await w.webContents.capturePage()).toPNG()); console.log("saved", f);
    w.destroy();
  }
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
    if (process.argv.includes("--qa")) await renderQaCases(outDir);
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
