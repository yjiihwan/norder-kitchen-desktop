// N오더 주방 데스크톱 앱 — staging 파트너 화면(/partner/*) 전용 래퍼.
// 정책: N오더는 staging 까지만 구현·검증한다. prod URL 을 넣지 않는다.
const {
  app, BrowserWindow, Menu, Notification, powerSaveBlocker,
  dialog, ipcMain, session,
} = require("electron");
const path = require("path");
const fs = require("fs");
const printing = require("./printing");
const sampleOrder = require("./sample-order");

const DEFAULT_SERVER = "https://norder-web-staging.up.railway.app";
const START_PATH = "/partner/delivery";
const PARTITION = "persist:norder-kitchen";

// ── 설정(userData/settings.json) ─────────────────────────────
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
function loadSettings() {
  const base = { autoLaunch: false, kiosk: false, serverUrl: DEFAULT_SERVER, printer: { ...printing.DEFAULT_PRINTER } };
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return { ...base, ...saved, printer: { ...base.printer, ...(saved.printer || {}) } };
  } catch {
    return base;
  }
}
function saveSettings(s) {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); } catch { /* 디스크 오류 시 다음 부팅에 기본값 */ }
}

let settings;
let win = null;
let blockerId = null;

// 주방 태블릿 대체 환경 — 알림음은 제스처 없이 즉시 재생돼야 한다.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId("kr.co.ngym.norder.kitchen"); // Windows 알림 표기 필수
    settings = loadSettings();
    blockerId = powerSaveBlocker.start("prevent-display-sleep");
    global.__norderBlockerId = blockerId; // E2E 검증용 노출
    createWindow();
    buildMenu();
    // E2E 검증용 — 실기 프린터 없이 설정창을 자동으로 띄운다(수동 실행에는 무영향)
    if (process.env.NORDER_OPEN_PRINTER_SETTINGS === "1") openPrinterSettings();
  });
}

function serverOrigin() {
  return new URL(settings.serverUrl).origin;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 640,
    title: "N오더 주방 (staging)",
    backgroundColor: "#ffffff",
    kiosk: settings.kiosk,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      partition: PARTITION,
      spellcheck: false,
    },
  });

  // 식당(파트너) 화면만 노출 — 그 외 경로·외부 도메인 이동 차단
  const allowed = (rawUrl) => {
    try {
      const u = new URL(rawUrl);
      return u.origin === serverOrigin() && u.pathname.startsWith("/partner");
    } catch { return false; }
  };
  win.webContents.on("will-navigate", (e, url) => {
    if (!allowed(url)) e.preventDefault();
  });
  // Next.js Link 는 SPA 내비게이션이라 will-navigate 가 안 뜬다 — 사후 감지 후 즉시 복귀
  const bounce = (url) => {
    if (!allowed(url)) win.webContents.loadURL(settings.serverUrl + START_PATH);
  };
  win.webContents.on("did-navigate-in-page", (_e, url, isMainFrame) => { if (isMainFrame) bounce(url); });
  win.webContents.on("did-navigate", (_e, url) => bounce(url));
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  win.on("closed", () => { win = null; });
  win.loadURL(settings.serverUrl + START_PATH);
}

// ── 신규 주문 알림 (preload 가 DOM 감시 후 호출) ──────────────
ipcMain.on("norder:new-orders", (_e, { count }) => {
  if (!win) return;
  new Notification({
    title: "N오더 · 신규 주문",
    body: `새 주문 ${count}건이 접수 대기 중입니다. 수락 마감 전에 확인해 주세요.`,
    urgency: "critical",
  }).show();
  win.flashFrame(true);
  if (win.isMinimized()) win.restore();
  win.show();
});
ipcMain.on("norder:alert-ack", () => { if (win) win.flashFrame(false); });

// ── 주방프린터 인쇄 (preload 브릿지 → printing.js) ────────────
// 호출 출처를 파트너 화면(staging 서버 origin)으로 제한 — 임의 페이지의 인쇄 남용 차단.
ipcMain.handle("norder:print-order", async (e, payload) => {
  try {
    if (new URL(e.senderFrame.url).origin !== serverOrigin()) {
      return { ok: false, error: "허용되지 않은 출처" };
    }
  } catch { return { ok: false, error: "허용되지 않은 출처" }; }
  return printing.printOrder(payload, settings.printer);
});

// ── 프린터 설정 창 ───────────────────────────────────────────
let psWin = null;
function openPrinterSettings() {
  if (psWin) { psWin.show(); psWin.focus(); return; }
  psWin = new BrowserWindow({
    width: 620, height: 760, parent: win ?? undefined, title: "프린터 설정",
    backgroundColor: "#f7f7f9", minimizable: false, maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, "printer-settings-preload.js"),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  psWin.setMenuBarVisibility(false);
  psWin.loadFile(path.join(__dirname, "printer-settings.html"));
  psWin.on("closed", () => { psWin = null; });
}

ipcMain.handle("printer:get-state", async () => {
  let osPrinters = [];
  try { osPrinters = await (win ?? psWin).webContents.getPrintersAsync(); } catch { /* 프린터 없음 */ }
  return { printer: settings.printer, osPrinters };
});
ipcMain.handle("printer:save", (_e, printer) => {
  settings.printer = { ...printing.DEFAULT_PRINTER, ...printer };
  saveSettings(settings);
  return { ok: true };
});
ipcMain.handle("printer:test", (_e, printer) =>
  printing.printOrder(sampleOrder(), { ...printing.DEFAULT_PRINTER, ...printer }, { force: true }));
ipcMain.handle("printer:preview", (_e, printer) =>
  printing.printOrder(sampleOrder(), { ...printing.DEFAULT_PRINTER, ...printer, mode: "preview" }, { force: true }));

// ── 메뉴 ─────────────────────────────────────────────────────
function buildMenu() {
  const template = [
    {
      label: "앱",
      submenu: [
        { label: "주문판으로 이동", accelerator: "CmdOrCtrl+H", click: () => win?.loadURL(settings.serverUrl + START_PATH) },
        { label: "새로고침", accelerator: "CmdOrCtrl+R", click: () => win?.webContents.reload() },
        { type: "separator" },
        {
          label: "로그아웃(세션 초기화)",
          click: async () => {
            const r = await dialog.showMessageBox(win, {
              type: "question", buttons: ["로그아웃", "취소"], defaultId: 1, cancelId: 1,
              message: "로그아웃하고 로그인 화면으로 이동합니다.",
            });
            if (r.response !== 0) return;
            await session.fromPartition(PARTITION).clearStorageData();
            win?.loadURL(settings.serverUrl + "/partner/login");
          },
        },
        { type: "separator" },
        { role: "quit", label: "종료" },
      ],
    },
    {
      label: "화면",
      submenu: [
        {
          label: "전체화면(키오스크) 모드", type: "checkbox", checked: settings.kiosk, accelerator: "F11",
          click: (item) => {
            settings.kiosk = item.checked;
            saveSettings(settings);
            win?.setKiosk(item.checked);
          },
        },
        { type: "separator" },
        { role: "zoomIn", label: "확대" },
        { role: "zoomOut", label: "축소" },
        { role: "resetZoom", label: "원래 크기" },
      ],
    },
    {
      label: "설정",
      submenu: [
        { label: "프린터 설정…", accelerator: "CmdOrCtrl+P", click: () => openPrinterSettings() },
        { type: "separator" },
        {
          label: "윈도우 부팅 시 자동 실행", type: "checkbox", checked: settings.autoLaunch,
          click: (item) => {
            settings.autoLaunch = item.checked;
            saveSettings(settings);
            app.setLoginItemSettings({ openAtLogin: item.checked });
          },
        },
        { type: "separator" },
        {
          label: "알림 테스트(소리·팝업)",
          click: () => {
            win?.webContents.send("norder:test-alarm");
            new Notification({ title: "N오더 · 알림 테스트", body: "소리와 팝업이 정상 동작하면 준비 완료입니다." }).show();
          },
        },
        {
          label: "정보",
          click: () => dialog.showMessageBox(win, {
            message: "N오더 주방 (staging 전용)",
            detail: `버전 ${app.getVersion()}\n서버 ${settings.serverUrl}\n절전 방지 ${powerSaveBlocker.isStarted(blockerId) ? "켜짐" : "꺼짐"}`,
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
