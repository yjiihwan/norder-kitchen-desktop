// E2E(실물 프린터 없이) — ① 설정창 로드·초기값·스크린샷 ② printOrder 실경로 검증:
// 로컬 가상 프린터(TCP 수신 서버)로 network 모드 raster/text 전송 → 수신 버퍼 구조 검사.
// 실행: npx electron tools/e2e_dispatch.js [출력폴더]
const { app, BrowserWindow, ipcMain } = require("electron");
const net = require("net");
const path = require("path");
const fs = require("fs");
const printing = require("../src/printing");
const { emulateRaster, emulate } = require("../src/escpos");
const sampleOrder = require("../src/sample-order");

const outDir = path.resolve(process.argv[2] || path.join(__dirname, "..", "preview_out"));
fs.mkdirSync(outDir, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

// 가상 프린터 — 127.0.0.1 임시 포트로 ESC/POS 바이트를 받는다(외부 연결 없음)
function fakePrinter() {
  return new Promise((resolve) => {
    let chunks = [];
    const srv = net.createServer((sock) => {
      sock.on("data", (d) => chunks.push(d));
    });
    srv.listen(0, "127.0.0.1", () => resolve({
      port: srv.address().port,
      received: () => Buffer.concat(chunks),
      reset: () => { chunks = []; },
      close: () => srv.close(),
    }));
  });
}

async function captureSettings() {
  // 실제 IPC 계약대로 응답하는 최소 핸들러(스크린샷·초기화 검증용)
  ipcMain.handle("printer:get-state", () => ({
    printer: { ...printing.DEFAULT_PRINTER },
    osPrinters: [
      { name: "EPSON TM-T88 Receipt", displayName: "EPSON TM-T88 Receipt", isDefault: true },
      { name: "Generic 58mm POS", displayName: "Generic 58mm POS", isDefault: false },
    ],
  }));
  const w = new BrowserWindow({
    show: false, width: 620, height: 980,
    webPreferences: {
      preload: path.join(__dirname, "../src/printer-settings-preload.js"),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });
  const errors = [];
  w.webContents.on("console-message", (_e, level, msg) => { if (level >= 3) errors.push(msg); });
  await w.loadFile(path.join(__dirname, "../src/printer-settings.html"));
  await new Promise((r) => setTimeout(r, 500));
  const state = await w.webContents.executeJavaScript(`({
    rasterChecked: document.querySelector('input[name=escposOutput][value=raster]').checked,
    textChecked: document.querySelector('input[name=escposOutput][value=text]').checked,
    formOutput: document.querySelector('input[name=escposOutput]:checked')?.value ?? null,
  })`);
  const h = await w.webContents.executeJavaScript("document.body.scrollHeight");
  w.setSize(620, Math.min(h + 10, 1400));
  await new Promise((r) => setTimeout(r, 300));
  const img = await w.webContents.capturePage();
  const file = path.join(outDir, "desktop_settings_v030.png");
  fs.writeFileSync(file, img.toPNG());
  console.log("saved", file);
  ok("설정창 JS 오류 없음", errors.length === 0, errors.join(" | "));
  ok("초기 선택 = 이미지 인쇄(raster)", state.rasterChecked && !state.textChecked);
  ok("폼 escposOutput = raster", state.formOutput === "raster");
  w.destroy();
}

app.on("window-all-closed", () => { /* 창을 순차로 여닫는다 — 자동 종료 금지 */ });

app.whenReady().then(async () => {
  try {
    console.log("═ 설정창");
    await captureSettings();

    console.log("═ printOrder 실경로 (가상 프린터, network 모드)");
    const fp = await fakePrinter();

    // ① raster(기본) — 수신 버퍼가 순수 래스터인지
    let r = await printing.printOrder(sampleOrder(), {
      mode: "network", ip: "127.0.0.1", port: fp.port, widthMm: 80, escposOutput: "raster",
    }, { force: true });
    await new Promise((s) => setTimeout(s, 400));
    let buf = fp.received();
    ok("raster 전송 ok", r.ok === true, JSON.stringify(r));
    const dec = emulateRaster(buf);
    ok("raster 수신: 초기화·컷 포함", dec.init && dec.cut);
    ok("raster 수신: 576도트 비트맵", dec.widthDots === 576 && dec.height > 300, `${dec.widthDots}x${dec.height}`);

    // ② text(옵션) — 기존 CP949 경로 회귀 없음
    fp.reset();
    r = await printing.printOrder(sampleOrder(), {
      mode: "network", ip: "127.0.0.1", port: fp.port, widthMm: 80, escposOutput: "text",
    }, { force: true });
    await new Promise((s) => setTimeout(s, 400));
    buf = fp.received();
    ok("text 전송 ok", r.ok === true, JSON.stringify(r));
    const txt = emulate(buf, 48).lines.map((l) => l.text).join("\n");
    ok("text 수신: 주문서 내용 복원", txt.includes("N오더 주문서") && txt.includes("픽업코드"));

    // ③ 58mm raster
    fp.reset();
    r = await printing.printOrder(sampleOrder(), {
      mode: "network", ip: "127.0.0.1", port: fp.port, widthMm: 58, escposOutput: "raster",
    }, { force: true });
    await new Promise((s) => setTimeout(s, 400));
    ok("58mm raster: 384도트", emulateRaster(fp.received()).widthDots === 384);

    fp.close();
    console.log(`\n════ 통과 ${pass}/${pass + fail}`);
    app.exit(fail ? 1 : 0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
