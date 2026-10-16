// E2E — COM(시리얼) 단자 인쇄, 실물 프린터 없이:
//  ① 가상 시리얼 쌍(pty, com0com 대용)으로 printOrder(serial) → 받은 바이트 = 만든 ESC/POS, CP949 한글 복원
//  ② 다른 프로세스가 포트를 잡고 있으면 재시도 → 놓으면 이어서 인쇄 / 끝까지 잡혀 있으면 «배달앱 사용 중» 안내 + busy 표시
//  ③ 인쇄 뒤 포트가 닫혀 다른 프로그램이 바로 열 수 있음  ④ 윈도우 오류 문구(«COM2: Access denied») 분류
//  ⑤ 설정창: COM 항목·포트 목록·통신 설정 저장값 왕복 + 스크린샷(기존 항목 위치 비교)
// 실행: npx electron tools/e2e_serial.js [출력폴더]
const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const iconv = require("iconv-lite");
const { SerialPort } = require("serialport");
const printing = require("../src/printing");
const serial = require("../src/serial-print");
const { buildReceiptLines } = require("../src/receipt");
const { buildEscpos, emulate } = require("../src/escpos");
const sampleOrder = require("../src/sample-order");

const outDir = path.resolve(process.argv[2] || path.join(__dirname, "..", "preview_out", "serial"));
fs.mkdirSync(outDir, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ptyPair(tag) {
  const file = path.join(outDir, `pty-${tag}.bin`);
  fs.writeFileSync(file, "");
  const py = spawn("python3", [path.join(__dirname, "pty_pair.py"), file]);
  return new Promise((resolve) => py.stdout.once("data", (d) => resolve({
    path: d.toString().trim(),
    received: () => fs.readFileSync(file),
    reset: () => fs.writeFileSync(file, ""),
    close: () => py.stdin.end(),
  })));
}

const holdPort = (p) => new Promise((resolve, reject) => {
  const sp = new SerialPort({ path: p, baudRate: 9600, autoOpen: false, lock: true });
  sp.open((e) => (e ? reject(e) : resolve(sp)));
});
const release = (sp) => new Promise((r) => sp.close(() => r()));

async function settingsWindow(htmlFile, state, tag) {
  ipcMain.removeHandler("printer:get-state");
  ipcMain.handle("printer:get-state", async () => state);
  const w = new BrowserWindow({
    show: false, width: 640, height: 820,
    webPreferences: {
      preload: path.join(__dirname, "../src/printer-settings-preload.js"),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });
  const errors = [];
  w.webContents.on("console-message", (_e, level, msg) => { if (level >= 3) errors.push(msg); });
  await w.loadFile(htmlFile);
  await sleep(500);
  return { w, errors, tag };
}

async function shot(w, file) {
  const h = await w.webContents.executeJavaScript("document.body.scrollHeight");
  w.setSize(640, h + 10);
  await sleep(350);
  fs.writeFileSync(file, (await w.webContents.capturePage()).toPNG());
  console.log("saved", file);
}

// 기존 항목들의 박스 — 잘림(폭 넘침)·겹침 확인용
const LAYOUT_JS = `(() => {
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right }; };
  return {
    vw: document.documentElement.clientWidth,
    scrollW: document.documentElement.scrollWidth,
    ip: r('[data-testid=ps-ip]'), port: r('[data-testid=ps-port]'), usb: r('[data-testid=ps-usb-printer]'),
    sys: r('[data-testid=ps-sys-printer]'), com: r('[data-testid=ps-com-path]'), flow: r('[data-testid=ps-com-flow]'),
    save: r('[data-testid=ps-save]'),
    overflow: [...document.querySelectorAll('.card *')].filter((e) => e.getBoundingClientRect().right > document.querySelector('.wrap').getBoundingClientRect().right + 1).map((e) => e.tagName + '.' + (e.getAttribute('data-testid') || e.className)).slice(0, 5),
  };
})()`;

app.on("window-all-closed", () => { /* 렌더 창이 닫혀도 테스트는 계속 */ });
app.whenReady().then(async () => {
  try {
    const osPrinters = [
      { name: "EPSON TM-T88 Receipt", displayName: "EPSON TM-T88 Receipt", isDefault: true },
      { name: "Generic 58mm POS", displayName: "Generic 58mm POS", isDefault: false },
    ];
    const P = (port, extra) => ({
      ...printing.DEFAULT_PRINTER, mode: "serial", comPath: port, comBaud: 9600, escposOutput: "text", autoPrint: true, ...extra,
    });

    console.log("═ ① 가상 시리얼 쌍 — 텍스트(CP949) 인쇄");
    const pty = await ptyPair("main");
    let r = await printing.printOrder(sampleOrder(), P(pty.path), { force: true });
    await sleep(500);
    ok("serial text 인쇄 ok", r.ok === true, JSON.stringify(r));
    const expect = buildEscpos(buildReceiptLines(sampleOrder(), 48), { cols: 48 });
    const got = pty.received();
    ok(`받은 바이트 = 만든 ESC/POS (${got.length}B)`, got.equals(expect), `got=${got.length} expect=${expect.length}`);
    const txt = emulate(got, 48).lines.map((l) => l.text).join("\n");
    ok("CP949 복원 — 한글 주문서 문구", txt.includes("N오더 주문서") && txt.includes("픽업코드"));
    ok("깨진 글자(U+FFFD) 없음", !txt.includes("�"));
    const han = iconv.encode("한글", "cp949");
    ok("한글이 CP949 바이트로 전송(«주문서» = C1 D6 B9 AE BC AD)", han.toString("hex") === "c7d1b1db" && got.includes(iconv.encode("주문서", "cp949")) && !got.includes(Buffer.from("주문서", "utf8")));
    fs.writeFileSync(path.join(outDir, "serial_text_decoded.txt"), txt);

    console.log("═ ③ 인쇄 뒤 포트가 닫혀 있음(배달앱이 바로 열 수 있음)");
    const other = await holdPort(pty.path).catch((e) => e);
    ok("인쇄 직후 다른 프로그램이 포트 열기 성공", other instanceof SerialPort, String(other?.message));
    if (other instanceof SerialPort) await release(other);

    console.log("═ 매수·이미지 인쇄도 COM 으로");
    pty.reset();
    r = await printing.printOrder(sampleOrder(), P(pty.path, { copies: 2 }), { force: true });
    await sleep(500);
    ok("copies=2: 2배 바이트", r.ok && pty.received().length === expect.length * 2, `${pty.received().length}`);
    pty.reset();
    r = await printing.printOrder(sampleOrder(), P(pty.path, { escposOutput: "raster", comBaud: 115200 }), { force: true });
    await sleep(800);
    const rasterLen = pty.received().length;
    ok(`raster 전송 ok (${rasterLen}B — 9600bps 면 약 ${Math.round(rasterLen / 960)}초)`, r.ok && rasterLen > 10000, JSON.stringify(r));

    console.log("═ ② 다른 프로세스가 포트 점유");
    // 별도 프로세스(배달앱 역할)가 잡게 한다 — 같은 프로세스 잠금이 아니라 실제 프로세스 간 잠금을 본다
    const holder = spawn(process.execPath, ["-e", `
      const { SerialPort } = require(${JSON.stringify(require.resolve("serialport"))});
      const sp = new SerialPort({ path: ${JSON.stringify(pty.path)}, baudRate: 9600, autoOpen: false, lock: true });
      sp.open((e) => { console.log(e ? "ERR " + e.message : "HELD"); });
      process.stdin.on("data", () => sp.close(() => { console.log("RELEASED"); process.exit(0); }));
    `], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    const holderOut = [];
    holder.stdout.on("data", (d) => holderOut.push(d.toString()));
    while (!holderOut.join("").includes("HELD")) { if (holderOut.join("").includes("ERR")) break; await sleep(50); }
    ok("배달앱 역할 프로세스가 포트 점유", holderOut.join("").includes("HELD"), holderOut.join(""));

    // 끝까지 점유 → 짧은 재시도 후 안내
    let t0 = Date.now();
    r = await printing.printOrder(sampleOrder({ orderId: "busy-1" }), P(pty.path), { serial: { attempts: 4, retryDelayMs: 300 } });
    const dt = Date.now() - t0;
    ok("점유 중 → 실패(ok=false)", r.ok === false);
    ok("안내 문구 «다른 프로그램(예: 배달앱)이 프린터를 사용 중입니다»", r.error?.startsWith("다른 프로그램(예: 배달앱)이 프린터를 사용 중입니다"), r.error);
    ok("busy 표시(알림·띠 문구용)", r.busy === true);
    ok(`재시도 4번 했음(걸린 시간 ${dt}ms ≥ 900ms)`, dt >= 900 && dt < 5000);
    // 실패한 주문은 «찍힘» 처리 안 됨 → 다음 자동 재시도에서 다시 찍힌다
    pty.reset();
    holder.stdin.write("x\n");
    while (!holderOut.join("").includes("RELEASED")) await sleep(50);
    r = await printing.printOrder(sampleOrder({ orderId: "busy-1" }), P(pty.path));
    await sleep(500);
    ok("실패했던 같은 주문 → 다음 시도에서 인쇄(중복 차단에 안 걸림)", r.ok === true && !r.skipped && pty.received().length === expect.length, JSON.stringify(r));

    // 점유 중 시작 → 재시도 도중 풀림 → 이어서 인쇄
    const held = await holdPort(pty.path);
    pty.reset();
    setTimeout(() => { void release(held); }, 1000);
    t0 = Date.now();
    r = await printing.printOrder(sampleOrder(), P(pty.path), { force: true, serial: { attempts: 6, retryDelayMs: 400 } });
    await sleep(500);
    ok(`재시도 도중 풀리면 이어서 인쇄 (${Date.now() - t0}ms)`, r.ok === true && pty.received().length === expect.length, JSON.stringify(r));

    console.log("═ ④ 윈도우 오류 문구 분류(모의 포트)");
    const mockPort = (msgs) => {
      let n = 0;
      return class { constructor() { this.isOpen = false; }
        open(cb) { const m = msgs[Math.min(n++, msgs.length - 1)]; if (m) cb(new Error(m)); else { this.isOpen = true; cb(null); } }
        write(_b, cb) { cb(null); } drain(cb) { cb(null); } close(cb) { this.isOpen = false; cb(); }
        get count() { return n; } };
    };
    let M = mockPort(["Opening COM2: Access denied", "Opening COM2: Access denied", null]);
    let res = await serial.sendToSerial(Buffer.from("x"), { comPath: "COM2" }, { SerialPort: M, retryDelayMs: 10 }).catch((e) => e);
    ok("«COM2: Access denied» 2번 → 3번째 성공", res?.tries === 3, String(res?.message || JSON.stringify(res)));
    M = mockPort(["Opening COM2: Access denied"]);
    res = await serial.sendToSerial(Buffer.from("x"), { comPath: "COM2" }, { SerialPort: M, attempts: 3, retryDelayMs: 10 }).catch((e) => e);
    ok("계속 Access denied → 사용 중 안내", res instanceof Error && res.busy && res.message === serial.BUSY_TEXT, res?.message);
    M = mockPort(["Opening COM7: File not found"]);
    res = await serial.sendToSerial(Buffer.from("x"), { comPath: "COM7" }, { SerialPort: M, retryDelayMs: 10 }).catch((e) => e);
    ok("없는 단자 → 재시도 없이 «COM7 단자를 찾을 수 없어요»", res instanceof Error && !res.busy && res.tries === 1 && res.message.includes("COM7 단자를 찾을 수 없어요"), res?.message);
    r = await printing.printOrder(sampleOrder(), { mode: "serial", comPath: "" }, { force: true });
    ok("단자 미선택 → 안내", r.ok === false && r.error.includes("COM 단자가 선택되지 않았어요"));

    console.log("═ 포트 목록");
    let lst = await serial.listComPorts();
    ok(`실제 목록 조회 ok (찾음 ${lst.detected.length}개)`, lst.error === null, lst.error);
    lst = await serial.listComPorts({ SerialPort: { list: async () => { throw new Error("레지스트리 읽기 실패"); } } });
    ok("목록 못 읽음 → COM1~COM6 직접 선택", lst.detected.length === 0 && lst.manual.map((p) => p.path).join() === "COM1,COM2,COM3,COM4,COM5,COM6");
    lst = await serial.listComPorts({ SerialPort: { list: async () => [{ path: "COM2", friendlyName: "통신 포트(COM2)" }, { path: "COM9", friendlyName: "USB Serial Port (COM9)" }] } });
    ok("찾은 단자 COM2·COM9 + 나머지 COM1·3~6 직접", lst.detected.map((p) => p.path).join() === "COM2,COM9" && lst.manual.length === 5);

    console.log("═ ⑤ 설정창");
    const comPorts = lst;
    // 이전본(v0.4.8) 화면 — 비교 기준
    const oldHtml = path.join(outDir, "printer-settings.v048.html");
    fs.writeFileSync(oldHtml, execFileSync("git", ["show", "7908cab:src/printer-settings.html"], { cwd: path.join(__dirname, "..") }));
    fs.copyFileSync(path.join(__dirname, "../src/printer-settings-preload.js"), path.join(outDir, "printer-settings-preload.js"));
    const base = { printer: { ...printing.DEFAULT_PRINTER, mode: "usbraw", osPrinterName: "EPSON TM-T88 Receipt" }, osPrinters, comPorts };
    let s = await settingsWindow(oldHtml, base, "old");
    const oldLayout = await s.w.webContents.executeJavaScript(LAYOUT_JS);
    await shot(s.w, path.join(outDir, "settings_v048_before.png"));
    s.w.destroy();

    s = await settingsWindow(path.join(__dirname, "../src/printer-settings.html"), base, "new");
    ok("새 설정창 JS 오류 없음", s.errors.length === 0, s.errors.join(" | "));
    const newLayout = await s.w.webContents.executeJavaScript(LAYOUT_JS);
    ok("가로 넘침 없음", newLayout.scrollW <= newLayout.vw && newLayout.overflow.length === 0, JSON.stringify(newLayout.overflow));
    ok("네트워크 IP·포트 칸 위치 그대로", JSON.stringify(newLayout.ip) === JSON.stringify(oldLayout.ip) && JSON.stringify(newLayout.port) === JSON.stringify(oldLayout.port));
    ok("USB 프린터 목록 위치·크기 그대로", JSON.stringify(newLayout.usb) === JSON.stringify(oldLayout.usb), `${JSON.stringify(oldLayout.usb)} → ${JSON.stringify(newLayout.usb)}`);
    ok("일반 인쇄 목록 폭 그대로(COM 항목만큼 아래로)", newLayout.sys.w === oldLayout.sys.w && newLayout.sys.x === oldLayout.sys.x && newLayout.sys.y > oldLayout.sys.y);
    const st = await s.w.webContents.executeJavaScript(`({
      usbSel: document.querySelector('select[name=usbPrinter]').value,
      usbOpts: document.querySelectorAll('select[name=usbPrinter] option').length,
      comGroups: [...document.querySelectorAll('select[name=comPath] optgroup')].map((g) => g.label + ':' + g.children.length),
      hint: document.getElementById('comRasterHint').hidden,
    })`);
    ok("USB 선택값 유지(EPSON)", st.usbSel === "EPSON TM-T88 Receipt" && st.usbOpts === 3);
    ok("COM 목록: 찾은 단자 2 + 직접 5", st.comGroups.join("|") === "이 PC에서 찾은 단자:2|직접 선택:5", st.comGroups.join("|"));
    ok("USB 모드에선 COM 안내 숨김", st.hint === true);
    await shot(s.w, path.join(outDir, "settings_v049_usb_selected.png"));

    // COM 선택 → 텍스트 자동 선택, 값 바꿔 저장 → 폼 값 확인
    let saved = null;
    ipcMain.removeHandler("printer:save");
    ipcMain.handle("printer:save", (_e, p) => { saved = p; return { ok: true }; });
    const form = await s.w.webContents.executeJavaScript(`(async () => {
      const r = document.querySelector('[data-testid=ps-mode-serial]'); r.click();
      const set = (n, v) => { const e = document.querySelector('select[name=' + n + ']'); e.value = v; };
      set('comPath', 'COM2'); set('comBaud', '19200'); set('comFlow', 'dsrdtr');
      const before = document.getElementById('comRasterHint').hidden;
      document.querySelector('input[name=escposOutput][value=raster]').click();
      const rasterHint = !document.getElementById('comRasterHint').hidden;
      document.querySelector('input[name=escposOutput][value=text]').click();
      document.getElementById('save').click();
      await new Promise((r) => setTimeout(r, 200));
      return { before, rasterHint, msg: document.getElementById('msg').textContent };
    })()`);
    ok("COM 고르면 텍스트 인쇄 자동 선택(안내 숨김)", form.before === true);
    ok("COM + 이미지 인쇄면 «텍스트 권장» 안내 표시", form.rasterHint === true);
    ok("저장값: mode=serial·COM2·19200·8N1·DTR/DSR·text", saved && saved.mode === "serial" && saved.comPath === "COM2" && saved.comBaud === 19200
      && saved.comDataBits === 8 && saved.comParity === "none" && saved.comStopBits === 1 && saved.comFlow === "dsrdtr" && saved.escposOutput === "text", JSON.stringify(saved));
    await shot(s.w, path.join(outDir, "settings_v049_com_selected.png"));
    s.w.destroy();

    // 저장 → 재실행 로드 왕복(src/settings.js) 후 화면에 다시 채워지는지
    const { loadSettingsFile, saveSettingsFile } = require("../src/settings");
    const tmp = path.join(outDir, "e2e-settings.json");
    saveSettingsFile(tmp, { printer: { ...printing.DEFAULT_PRINTER, ...saved } });
    const re = loadSettingsFile(tmp, { printer: { ...printing.DEFAULT_PRINTER } });
    ok("설정 파일 왕복 — COM 값 유지", re.printer.comPath === "COM2" && re.printer.comBaud === 19200 && re.printer.comFlow === "dsrdtr");
    fs.writeFileSync(tmp, JSON.stringify({ printer: { mode: "usbraw", osPrinterName: "X" } }));
    const old = loadSettingsFile(tmp, { printer: { ...printing.DEFAULT_PRINTER } });
    ok("옛 설정 파일(0.4.8) → USB 그대로 + COM 기본 9600·8N1", old.printer.mode === "usbraw" && old.printer.osPrinterName === "X" && old.printer.comBaud === 9600 && old.printer.comFlow === "none");

    s = await settingsWindow(path.join(__dirname, "../src/printer-settings.html"),
      { printer: re.printer, osPrinters, comPorts: { detected: [], manual: serial.FALLBACK_PORTS.map((p) => ({ path: p, label: p })), error: "x" } }, "reload");
    const back = await s.w.webContents.executeJavaScript(`({
      mode: document.querySelector('input[name=mode]:checked').value, com: document.querySelector('select[name=comPath]').value,
      baud: document.querySelector('select[name=comBaud]').value, flow: document.querySelector('select[name=comFlow]').value,
      groups: [...document.querySelectorAll('select[name=comPath] optgroup')].map((g) => g.label),
    })`);
    ok("다시 열면 COM2·19200·DTR/DSR 채워짐", back.mode === "serial" && back.com === "COM2" && back.baud === "19200" && back.flow === "dsrdtr", JSON.stringify(back));
    ok("목록 못 읽으면 «직접 선택» 그룹만", back.groups.length === 1 && back.groups[0].includes("직접 선택"), back.groups.join());
    await shot(s.w, path.join(outDir, "settings_v049_com_fallback.png"));
    s.w.destroy();

    pty.close();
    console.log(`\n════ 통과 ${pass}/${pass + fail}`);
    app.exit(fail ? 1 : 0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
