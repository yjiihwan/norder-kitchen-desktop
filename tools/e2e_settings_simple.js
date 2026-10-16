// E2E — 단순화한 프린터 설정창(0.4.9), 실물 프린터 없이:
//  ① 0.4.8 설정 파일 8종을 넣고 열면 기존 프린터가 그대로 선택되고, 손대지 않은 폼 값 = 원래 저장값(인쇄 경로 동일)
//  ② 기본 화면엔 프린터 선택·용지 폭·매수·자동 인쇄·[테스트 인쇄]·고급 설정 접힘만 보인다 / 고급 설정 펼침·접힘
//  ③ 고르면 바로 저장(COM → 텍스트·serial, 설치된 프린터 → 이미지·usbraw, 드라이버 체크 → system)
//  ④ 회귀: 같은 주문을 0.4.8 printing.js 와 새 printing.js 로 USB(RAW) 인쇄 → 프린터 큐로 가는 바이트 동일, 네트워크도 동일
//  ⑤ 실제 창 크기(620×760) 스크린샷 + 0.4.8·0.4.9(staging 첫판) 화면
// 실행: npx electron tools/e2e_settings_simple.js [출력폴더]
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const net = require("net");

// printing.js 가 require 시점에 execFile 을 잡아 두므로 먼저 바꿔 끼운다 — lp/powershell 대신 보낸 바이트를 기록.
const rawSent = [];
const realExecFile = cp.execFile;
cp.execFile = (cmd, args, opts, cb) => {
  if (cmd === "lp" || cmd === "powershell.exe") {
    const file = args[args.length - 1];
    rawSent.push({ cmd, queue: cmd === "lp" ? args[1] : args[args.indexOf("-PrinterName") + 1], bytes: fs.readFileSync(file) });
    (typeof opts === "function" ? opts : cb)(null, "", "");
    return;
  }
  return realExecFile(cmd, args, opts, cb);
};

const { app, BrowserWindow, ipcMain } = require("electron");
const root = path.join(__dirname, "..");
const outDir = path.resolve(process.argv[2] || path.join(root, "preview_out", "settings_simple"));
fs.mkdirSync(outDir, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 620, H = 760; // main.js 프린터 설정 창 크기

function oldTree(rev, tag) {
  const dir = path.join(outDir, `src_${tag}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["printing.js", "receipt.js", "escpos.js", "printer-settings.html", "printer-settings-preload.js", "sample-order.js"]) {
    try { fs.writeFileSync(path.join(dir, f), cp.execFileSync("git", ["show", `${rev}:src/${f}`], { cwd: root })); } catch { /* 옛 판에 없는 파일 */ }
  }
  return dir;
}

let saved = [];
async function settingsWindow(htmlFile, state, height = H) {
  ipcMain.removeHandler("printer:get-state");
  ipcMain.handle("printer:get-state", async () => state);
  ipcMain.removeHandler("printer:save");
  ipcMain.handle("printer:save", (_e, p) => { saved.push(p); return { ok: true }; });
  const w = new BrowserWindow({
    show: false, width: W, height,
    webPreferences: {
      preload: path.join(root, "src/printer-settings-preload.js"),
      contextIsolation: true, nodeIntegration: false, offscreen: true,
    },
  });
  const errors = [];
  w.webContents.on("console-message", (_e, level, msg) => { if (level >= 3) errors.push(msg); });
  await w.loadFile(htmlFile);
  await sleep(500);
  return { w, errors };
}
const js = (w, code) => w.webContents.executeJavaScript(code);
async function shot(w, file, full = false) {
  if (full) {
    const h = await js(w, "document.body.scrollHeight");
    w.setSize(W, h + 10);
    await sleep(350);
  }
  fs.writeFileSync(file, (await w.webContents.capturePage()).toPNG());
  console.log("    saved", path.basename(file));
}

// 화면에 실제로 보이는 조작 요소(접힌 고급 설정·숨긴 줄 제외)
const VISIBLE_JS = `(() => {
  const seen = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && !e.closest('details:not([open]) > :not(summary)'); };
  return [...document.querySelectorAll('select, input, button, summary')].filter(seen).map((e) =>
    e.dataset.testid || e.name || (e.closest('[data-testid]')?.dataset.testid + ':' + e.textContent.trim()));
})()`;
// 잘림·밀림: 가로 넘침, 카드 밖으로 나간 요소, 한 줄 버튼 글자가 줄바꿈된 것
const LAYOUT_JS = `(() => {
  const vw = document.documentElement.clientWidth;
  const bad = [];
  document.querySelectorAll('.card').forEach((c) => { const cb = c.getBoundingClientRect();
    c.querySelectorAll('select, input, button, .seg, h2, label').forEach((e) => { const b = e.getBoundingClientRect();
      if (b.width && (b.right > cb.right + 0.5 || b.left < cb.left - 0.5)) bad.push((e.dataset.testid || e.name || e.tagName) + ' 카드 밖'); }); });
  document.querySelectorAll('.seg button, .btn').forEach((b) => { if (b.getBoundingClientRect().height > 44) bad.push(b.textContent + ' 줄바꿈'); });
  return { vw, scrollW: document.documentElement.scrollWidth, bad };
})()`;

const OS_PRINTERS = [
  { name: "EPSON TM-T88 Receipt", displayName: "EPSON TM-T88 Receipt", isDefault: true },
  { name: "SLK-TS100", displayName: "SLK-TS100", isDefault: false },
  { name: "Microsoft Print to PDF", displayName: "Microsoft Print to PDF", isDefault: false },
];
const COM_PORTS = {
  detected: [{ path: "COM2", label: "COM2 — 통신 포트" }],
  manual: ["COM1", "COM3", "COM4", "COM5", "COM6"].map((p) => ({ path: p, label: p })),
  error: null,
};

// 0.4.8 이 실제로 쓰던 형태(DEFAULT_PRINTER 8개 키 + 저장값). H 는 0.4.9 staging 첫판(COM) 사용 매장.
const OLD_DEFAULT = { mode: "preview", ip: "", port: 9100, osPrinterName: "", widthMm: 80, autoPrint: true, copies: 1, escposOutput: "raster" };
const FIXTURES = [
  { id: "A_usb", printer: { ...OLD_DEFAULT, mode: "usbraw", osPrinterName: "EPSON TM-T88 Receipt", copies: 2 }, pick: "os:EPSON TM-T88 Receipt" },
  { id: "B_usb_text58", printer: { ...OLD_DEFAULT, mode: "usbraw", osPrinterName: "SLK-TS100", escposOutput: "text", widthMm: 58 }, pick: "os:SLK-TS100" },
  { id: "C_system", printer: { ...OLD_DEFAULT, mode: "system", osPrinterName: "Microsoft Print to PDF" }, pick: "os:Microsoft Print to PDF" },
  { id: "D_network", printer: { ...OLD_DEFAULT, mode: "network", ip: "192.168.0.50", port: 9100, autoPrint: false }, pick: "net" },
  { id: "E_preview", printer: { ...OLD_DEFAULT }, pick: "preview" },
  { id: "F_off", printer: { ...OLD_DEFAULT, mode: "off" }, pick: "off" },
  { id: "G_usb_gone", printer: { ...OLD_DEFAULT, mode: "usbraw", osPrinterName: "OLD-PRINTER", copies: 3 }, pick: "os:OLD-PRINTER" },
  { id: "H_com_staging", printer: { ...OLD_DEFAULT, mode: "serial", escposOutput: "text", comPath: "COM2", comBaud: 19200, comDataBits: 8, comParity: "none", comStopBits: 1, comFlow: "dsrdtr" }, pick: "com:COM2" },
];
const KEYS = ["mode", "osPrinterName", "ip", "port", "widthMm", "autoPrint", "copies", "escposOutput", "comPath", "comBaud", "comDataBits", "comParity", "comStopBits", "comFlow"];

function tcpPrinter() {
  const got = [];
  const srv = net.createServer((s) => { const chunks = []; s.on("data", (d) => chunks.push(d)); s.on("end", () => got.push(Buffer.concat(chunks))); });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, port: srv.address().port, got })));
}

app.on("window-all-closed", () => { /* 창을 순차로 여닫는다 — 자동 종료 금지 */ });
app.whenReady().then(async () => {
  try {
    const newHtml = path.join(root, "src/printer-settings.html");
    const printing = require("../src/printing");
    const { loadSettingsFile } = require("../src/settings");
    const forms = {};

    console.log("═ ① 0.4.8 설정 파일 → 새 화면");
    for (const fx of FIXTURES) {
      const file = path.join(outDir, `settings_${fx.id}.json`);
      fs.writeFileSync(file, JSON.stringify({ serverUrl: "https://norder.shop", expectLogin: true, printer: fx.printer }, null, 2));
      const s = loadSettingsFile(file, { printer: { ...printing.DEFAULT_PRINTER } });
      saved = [];
      const win = await settingsWindow(newHtml, { printer: s.printer, osPrinters: OS_PRINTERS, comPorts: COM_PORTS });
      const st = await js(win.w, `({ pick: document.querySelector('select[name=printer]').value,
        label: document.querySelector('select[name=printer]').selectedOptions[0]?.textContent, form: currentForm() })`);
      const diff = KEYS.filter((k) => k in fx.printer && st.form[k] !== fx.printer[k]);
      ok(`${fx.id}: «${st.label}» 선택된 채로 열림`, win.errors.length === 0 && st.pick === fx.pick, `${st.pick} ${win.errors.join("|")}`);
      ok(`${fx.id}: 그대로 두면 인쇄 설정 = 0.4.8 저장값`, diff.length === 0, diff.map((k) => `${k}:${fx.printer[k]}→${st.form[k]}`).join(", "));
      ok(`${fx.id}: 열기만 해서는 저장 안 함`, saved.length === 0);
      forms[fx.id] = st.form;
      if (fx.id === "A_usb" || fx.id === "D_network" || fx.id === "H_com_staging") await shot(win.w, path.join(outDir, `new_${fx.id}_${W}x${H}.png`));
      win.w.destroy();
    }

    console.log("═ ② 기본 화면 구성·고급 설정·레이아웃");
    saved = [];
    const base = { printer: loadSettingsFile("/nonexistent", { printer: { ...printing.DEFAULT_PRINTER, mode: "usbraw", osPrinterName: "SLK-TS100" } }).printer, osPrinters: OS_PRINTERS, comPorts: COM_PORTS };
    let s = await settingsWindow(newHtml, base);
    const vis = await js(s.w, VISIBLE_JS);
    const expected = ["ps-printer", "ps-width:80mm", "ps-width:58mm", ...[1, 2, 3, 4, 5].map((c) => `ps-copies:${c}매`), "ps-auto", "ps-test", "ps-advanced-toggle"];
    ok("기본 화면 요소 = 프린터 선택·용지 폭·매수·자동 인쇄·테스트 인쇄·고급 설정(접힘)", JSON.stringify(vis) === JSON.stringify(expected), JSON.stringify(vis));
    const gone = await js(s.w, `({ modeRadios: document.querySelectorAll('input[name=mode]').length, outRadios: document.querySelectorAll('input[name=escposOutput]').length,
      saveBtn: !!document.querySelector('[data-testid=ps-save]'), previewBtn: !!document.querySelector('[data-testid=ps-preview]') })`);
    ok("연결 방식 6개·인쇄 방식 라디오·저장/미리보기 버튼 없음", gone.modeRadios === 0 && gone.outRadios === 0 && !gone.saveBtn && !gone.previewBtn, JSON.stringify(gone));
    const groups = await js(s.w, `[...document.querySelectorAll('select[name=printer] optgroup')].map((g) => g.label + '=' + [...g.children].map((o) => o.textContent).join(' / '))`);
    console.log("    목록:", groups.join("\n          "));
    ok("목록: 설치된 프린터 3 · COM 찾은 1 + 직접 5 · 네트워크 · 기타(미리보기·끄기)",
      groups.length === 5 && groups[0].includes("SLK-TS100 (설치된 프린터)") && groups[1].includes("COM2 (직접 연결)") && groups[3].includes("IP 직접 입력") && groups[4].includes("끄기"));
    let lay = await js(s.w, LAYOUT_JS);
    ok("620폭: 가로 넘침·카드 밖·버튼 줄바꿈 없음", lay.scrollW <= lay.vw && lay.bad.length === 0, JSON.stringify(lay));
    const fitsWindow = await js(s.w, `document.body.scrollHeight`);
    ok(`기본 화면이 창(높이 ${H}) 안에 다 들어감 (내용 ${fitsWindow}px)`, fitsWindow <= H);
    await shot(s.w, path.join(outDir, `new_default_${W}x${H}.png`));

    await js(s.w, `document.querySelector('[data-testid=ps-advanced-toggle]').click()`);
    await sleep(150);
    const openVis = await js(s.w, VISIBLE_JS);
    const openState = await js(s.w, `({ open: document.getElementById('adv').open, baud: document.querySelector('select[name=comBaud]').value,
      bits: document.querySelector('select[name=comDataBits]').value, parity: document.querySelector('select[name=comParity]').value,
      stop: document.querySelector('select[name=comStopBits]').value, flow: document.querySelector('select[name=comFlow]').value,
      out: document.querySelector('select[name=outputMode]').value })`);
    ok("고급 설정 펼침 → COM 세부값·인쇄 방식·드라이버 인쇄 보임", openState.open && ["comBaud", "comDataBits", "comParity", "comStopBits", "comFlow", "outputMode", "sysDriver"].every((n) => openVis.includes(`ps-${{ comBaud: "com-baud", comDataBits: "com-databits", comParity: "com-parity", comStopBits: "com-stopbits", comFlow: "com-flow", outputMode: "output", sysDriver: "sys-driver" }[n]}`)), JSON.stringify(openVis));
    ok("COM 기본값 9600·8·없음·1·흐름제어 없음, 인쇄 방식 자동", openState.baud === "9600" && openState.bits === "8" && openState.parity === "none" && openState.stop === "1" && openState.flow === "none" && openState.out === "auto", JSON.stringify(openState));
    lay = await js(s.w, LAYOUT_JS);
    ok("고급 설정 펼친 상태도 넘침·잘림 없음", lay.scrollW <= lay.vw && lay.bad.length === 0, JSON.stringify(lay));
    await shot(s.w, path.join(outDir, `new_advanced_open_${W}x${H}.png`));
    await shot(s.w, path.join(outDir, `new_advanced_open_full.png`), true);
    s.w.setSize(W, H);
    await js(s.w, `document.querySelector('[data-testid=ps-advanced-toggle]').click()`);
    await sleep(150);
    const closedVis = await js(s.w, VISIBLE_JS);
    ok("다시 누르면 접힘(기본 화면 요소로 복귀)", JSON.stringify(closedVis) === JSON.stringify(expected));

    // 목록을 펼친 모습 — 네이티브 드롭다운은 캡처되지 않아 같은 목록을 펼친 상자로 보여 준다(설명용).
    await js(s.w, `(() => { const e = document.querySelector('select[name=printer]'); e.size = e.options.length + e.querySelectorAll('optgroup').length; })()`);
    await sleep(200);
    await shot(s.w, path.join(outDir, `new_list_expanded_illustration.png`), true);
    s.w.destroy();

    console.log("═ ③ 고르면 바로 저장");
    saved = [];
    s = await settingsWindow(newHtml, base);
    const pickAndSave = async (v, extra = "") => {
      saved = [];
      await js(s.w, `(() => { ${extra} const e = document.querySelector('select[name=printer]'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('change')); })()`);
      await sleep(150);
      return saved[saved.length - 1];
    };
    let p = await pickAndSave("com:COM2");
    ok("COM2 고름 → serial·COM2·텍스트·9600 8N1 저장", p && p.mode === "serial" && p.comPath === "COM2" && p.escposOutput === "text" && p.comBaud === 9600 && p.comFlow === "none", JSON.stringify(p));
    const msg = await js(s.w, `document.getElementById('msg').textContent`);
    ok("저장 안내 문구 표시", msg.startsWith("저장됐어요"), msg);
    await shot(s.w, path.join(outDir, `new_com_selected_${W}x${H}.png`));
    p = await pickAndSave("os:SLK-TS100");
    ok("설치된 프린터 고름 → usbraw·이미지", p && p.mode === "usbraw" && p.osPrinterName === "SLK-TS100" && p.escposOutput === "raster", JSON.stringify(p));
    p = await pickAndSave("os:SLK-TS100", "document.querySelector('input[name=sysDriver]').checked = true;");
    ok("고급 «드라이버로 일반 인쇄» 켬 → system", p && p.mode === "system" && p.osPrinterName === "SLK-TS100", JSON.stringify(p));
    await js(s.w, `document.querySelector('input[name=sysDriver]').checked = false`);
    p = await pickAndSave("net");
    const netShown = await js(s.w, `!document.getElementById('netRow').hidden`);
    ok("네트워크 고름 → IP·포트 칸 나타남, mode=network", netShown && p && p.mode === "network", JSON.stringify(p));
    saved = [];
    await js(s.w, `(() => { const e = document.querySelector('input[name=ip]'); e.value = '192.168.0.77'; e.dispatchEvent(new Event('change')); })()`);
    await sleep(150);
    ok("IP 입력 → 저장", saved.at(-1)?.ip === "192.168.0.77");
    await shot(s.w, path.join(outDir, `new_network_selected_${W}x${H}.png`));
    p = await pickAndSave("");
    ok("«프린터를 선택하세요»로 돌리면 기존 설정을 덮지 않음", p === undefined);
    s.w.destroy();

    console.log("═ ④ 회귀 — 같은 주문, 0.4.8 printing.js vs 새 printing.js");
    const v048 = oldTree("7908cab", "v048");
    const oldPrinting = require(path.join(v048, "printing.js"));
    const order = require("../src/sample-order")();
    for (const id of ["A_usb", "B_usb_text58", "G_usb_gone"]) {
      rawSent.length = 0;
      const r0 = await oldPrinting.printOrder({ ...order, reprint: true }, FIXTURES.find((f) => f.id === id).printer);
      const r1 = await printing.printOrder({ ...order, reprint: true }, forms[id]);
      ok(`${id} USB(RAW): 두 판 모두 성공 · 같은 큐 · 같은 바이트(${rawSent[0]?.bytes.length}B)`, r0.ok && r1.ok && rawSent.length === 2
        && rawSent[0].queue === rawSent[1].queue && rawSent[0].bytes.equals(rawSent[1].bytes), JSON.stringify({ r0, r1, n: rawSent.length }));
    }
    const tp = await tcpPrinter();
    const netOld = { ...FIXTURES.find((f) => f.id === "D_network").printer, ip: "127.0.0.1", port: tp.port };
    const netNew = { ...forms.D_network, ip: "127.0.0.1", port: tp.port };
    const n0 = await oldPrinting.printOrder({ ...order, reprint: true }, netOld);
    const n1 = await printing.printOrder({ ...order, reprint: true }, netNew);
    for (let i = 0; i < 30 && tp.got.length < 2; i++) await sleep(100); // 수신 쪽 end 이벤트가 늦게 올 수 있다
    ok(`D_network 네트워크: 두 판 같은 바이트(${tp.got[0]?.length}B)`, n0.ok && n1.ok && tp.got.length === 2 && tp.got[0].equals(tp.got[1]), JSON.stringify({ n0, n1, lens: tp.got.map((b) => b.length), firstDiff: tp.got.length === 2 ? tp.got[0].findIndex((x, i) => x !== tp.got[1][i]) : null }));
    tp.srv.close();
    ok("C_system 일반 인쇄: 새 화면이 넘기는 값 = mode system·같은 장치 이름(인쇄 코드는 0.4.8과 diff 0)", forms.C_system.mode === "system" && forms.C_system.osPrinterName === "Microsoft Print to PDF");

    console.log("═ ⑤ 이전 화면(비교용)");
    const oldState = { printer: { ...OLD_DEFAULT, mode: "usbraw", osPrinterName: "SLK-TS100" }, osPrinters: OS_PRINTERS };
    s = await settingsWindow(path.join(v048, "printer-settings.html"), oldState);
    await shot(s.w, path.join(outDir, `old_v048_${W}x${H}.png`));
    await shot(s.w, path.join(outDir, `old_v048_full.png`), true);
    s.w.destroy();
    const v049a = oldTree("74436c1", "v049_staging_first");
    s = await settingsWindow(path.join(v049a, "printer-settings.html"), { ...oldState, comPorts: COM_PORTS });
    await shot(s.w, path.join(outDir, `old_v049first_full.png`), true);
    s.w.destroy();
    s = await settingsWindow(newHtml, base);
    await shot(s.w, path.join(outDir, `new_default_full.png`), true);
    s.w.destroy();

    console.log(`\n════ 통과 ${pass}/${pass + fail}`);
    app.exit(fail ? 1 : 0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
