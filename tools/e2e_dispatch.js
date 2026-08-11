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
    copiesDefault: currentForm().copies,
    copiesSeg: document.querySelectorAll('[data-testid=ps-copies] [data-c]').length,
    copiesOn: document.querySelector('[data-testid=ps-copies] .on')?.dataset.c ?? null,
  })`);
  ok("설정창 JS 오류 없음", errors.length === 0, errors.join(" | "));
  ok("초기 선택 = 이미지 인쇄(raster)", state.rasterChecked && !state.textChecked);
  ok("폼 escposOutput = raster", state.formOutput === "raster");
  ok("매수 세그 1~5매 렌더", state.copiesSeg === 5);
  ok("매수 기본값 = 1매", state.copiesDefault === 1 && state.copiesOn === "1");

  // 2매 클릭 → 폼 반영·선택 표시 확인 후 스크린샷(설정 화면 증빙)
  const after = await w.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-testid=ps-copies] [data-c="2"]').click();
    return { form: currentForm().copies, on: document.querySelector('[data-testid=ps-copies] .on')?.dataset.c ?? null };
  })()`);
  ok("2매 클릭 → 폼 copies=2", after.form === 2 && after.on === "2");

  const h = await w.webContents.executeJavaScript("document.body.scrollHeight");
  w.setSize(620, Math.min(h + 10, 1600));
  await new Promise((r) => setTimeout(r, 300));
  const img = await w.webContents.capturePage();
  const file = path.join(outDir, "desktop_settings_v040.png");
  fs.writeFileSync(file, img.toPNG());
  console.log("saved", file);
  w.destroy();
}

// 설정 지속성 — 실제 저장·로드 코드(src/settings.js)를 임시 파일로 왕복 검증
function checkSettingsPersistence() {
  const { loadSettingsFile, saveSettingsFile } = require("../src/settings");
  const base = { serverUrl: "x", printer: { ...printing.DEFAULT_PRINTER } };
  const tmp = path.join(outDir, "e2e-settings.json");

  saveSettingsFile(tmp, { ...base, printer: { ...printing.DEFAULT_PRINTER, copies: 3 } });
  const re = loadSettingsFile(tmp, base);
  ok("저장→로드 후 copies=3 유지", re.printer.copies === 3);

  // 구버전(v0.3.0 이하) 설정 파일 — copies 없음 → 기본 1 승계
  fs.writeFileSync(tmp, JSON.stringify({ printer: { mode: "network", ip: "1.2.3.4" } }));
  const old = loadSettingsFile(tmp, base);
  ok("구버전 설정 파일 → copies 기본 1", printing.copiesOf(old.printer) === 1 && old.printer.mode === "network");
  fs.unlinkSync(tmp);
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

    console.log("═ 인쇄 매수(copies) — 자동·재인쇄·중복방지");
    // ④ raster 매수 3 — 단일 전표 대비 정확히 3배 수신(장마다 컷 포함)
    fp.reset();
    r = await printing.printOrder(sampleOrder(), {
      mode: "network", ip: "127.0.0.1", port: fp.port, widthMm: 80, escposOutput: "raster",
    }, { force: true });
    await new Promise((s) => setTimeout(s, 400));
    const oneLen = fp.received().length;
    const oneH = emulateRaster(fp.received()).height;
    fp.reset();
    r = await printing.printOrder(sampleOrder(), {
      mode: "network", ip: "127.0.0.1", port: fp.port, widthMm: 80, escposOutput: "raster", copies: 3,
    }, { force: true });
    await new Promise((s) => setTimeout(s, 400));
    const tripleBuf = fp.received();
    ok("copies=3 전송 ok (copies 반환)", r.ok === true && r.copies === 3, JSON.stringify(r));
    ok("raster copies=3: 수신량 = 1매의 3배", tripleBuf.length === oneLen * 3, `${tripleBuf.length} ≠ 3×${oneLen}`);
    ok("raster copies=3: 비트맵 높이 3배", emulateRaster(tripleBuf).height === oneH * 3);

    // ⑤ text 매수 2 — 전표 헤더가 2번 복원
    fp.reset();
    r = await printing.printOrder(sampleOrder(), {
      mode: "network", ip: "127.0.0.1", port: fp.port, widthMm: 80, escposOutput: "text", copies: 2,
    }, { force: true });
    await new Promise((s) => setTimeout(s, 400));
    const txt2 = emulate(fp.received(), 48).lines.map((l) => l.text).join("\n");
    ok("text copies=2: 전표 2장 복원", (txt2.match(/N오더 주문서/g) || []).length === 2);

    // ⑥ copies 범위 강제(0·9·비숫자 → 1~5 클램프)
    ok("copiesOf 클램프", printing.copiesOf({ copies: 0 }) === 1 && printing.copiesOf({ copies: 9 }) === 5
      && printing.copiesOf({ copies: "3" }) === 3 && printing.copiesOf({}) === 1);

    // ⑦ 미리보기 매수 2 — PNG 2장 생성
    r = await printing.printOrder(sampleOrder(), { mode: "preview", widthMm: 80, copies: 2 }, { force: true, silentPreview: true });
    ok("preview copies=2: 파일 2장", r.ok && r.previewFiles?.length === 2 && r.previewFiles.every((f) => fs.existsSync(f)),
      JSON.stringify(r));

    // ⑧ 중복 방지와의 공존 — 같은 orderId 자동 인쇄 2회차만 skip, 재인쇄는 매수대로 통과
    const netP = (extra) => ({
      mode: "network", ip: "127.0.0.1", port: fp.port, escposOutput: "raster", autoPrint: true, ...extra,
    });
    fp.reset();
    r = await printing.printOrder(sampleOrder({ orderId: "e2e-dup-1" }), netP({ copies: 2 }));
    await new Promise((s) => setTimeout(s, 400));
    ok("자동 인쇄 1회차: 2매 정상 출력", r.ok === true && !r.skipped && fp.received().length === oneLen * 2);
    r = await printing.printOrder(sampleOrder({ orderId: "e2e-dup-1" }), netP({ copies: 2 }));
    ok("자동 인쇄 2회차(새로고침 재발동): skip", r.ok === true && r.skipped === "duplicate");
    // 재인쇄 전표는 «(재인쇄)» 줄이 붙어 길이가 다르다 — 재인쇄 1매를 기준으로 2매 비교
    fp.reset();
    r = await printing.printOrder(sampleOrder({ orderId: "e2e-dup-1", reprint: true }), netP({ copies: 1 }));
    await new Promise((s) => setTimeout(s, 400));
    const reprintOneLen = fp.received().length;
    ok("재인쇄 1매: skip 없이 출력", r.ok === true && !r.skipped && reprintOneLen > 0);
    fp.reset();
    r = await printing.printOrder(sampleOrder({ orderId: "e2e-dup-1", reprint: true }), netP({ copies: 2 }));
    await new Promise((s) => setTimeout(s, 400));
    ok("재인쇄 copies=2: 2매 출력", r.ok === true && !r.skipped && fp.received().length === reprintOneLen * 2);

    console.log("═ 설정 지속성(src/settings.js)");
    checkSettingsPersistence();

    fp.close();
    console.log(`\n════ 통과 ${pass}/${pass + fail}`);
    app.exit(fail ? 1 : 0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
