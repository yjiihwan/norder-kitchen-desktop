// N오더 주방 데스크톱 앱 — staging 파트너 화면(/partner/*) 전용 래퍼.
// 정책: N오더는 staging 까지만 구현·검증한다. prod URL 을 넣지 않는다.
const {
  app, BrowserWindow, Menu, Notification, powerSaveBlocker,
  dialog, ipcMain, session,
} = require("electron");
const path = require("path");
const printing = require("./printing");
const sampleOrder = require("./sample-order");
const { loadSettingsFile, saveSettingsFile } = require("./settings");

const DEFAULT_SERVER = "https://norder-web-staging.up.railway.app";
const START_PATH = "/partner/delivery";
// 일시정지 조작부는 「전체 센터」 뷰(inst 필터 없음)에 있다 — 센터 탭에 머물러 있으면
// 전체 일괄 멈춤/재개가 안 보이므로 inst 를 떼고 들어간다.
const PAUSE_PATH = "/partner/delivery?tab=new";
const PARTITION = "persist:norder-kitchen";
const OFFLINE_FILE = path.join(__dirname, "offline.html");

// ── 설정(userData/settings.json) ─────────────────────────────
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
function loadSettings() {
  // expectLogin: 로그인해 쓰던 기기인지 — 로그인 화면으로 떨어졌을 때 «로그인 풀림» 경보를 낼지 판단(처음 설치·직접 로그아웃은 조용히)
  const base = { autoLaunch: false, kiosk: false, expectLogin: false, serverUrl: DEFAULT_SERVER, printer: { ...printing.DEFAULT_PRINTER } };
  return loadSettingsFile(settingsFile(), base);
}
function saveSettings(s) {
  saveSettingsFile(settingsFile(), s);
}

let settings;
let win = null;
let blockerId = null;

// 검증용 — 설정·쿠키를 임시 폴더에 두고 띄운다(수동 실행에는 무영향)
if (process.env.NORDER_USER_DATA) app.setPath("userData", process.env.NORDER_USER_DATA);

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
    markKitchenAppRequests();
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

function isOfflinePage(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.protocol === "file:" && path.normalize(decodeURIComponent(u.pathname)) === path.normalize(OFFLINE_FILE);
  } catch { return false; }
}

let outage = false;
function showOffline(kind, failedUrl) {
  if (!win) return;
  let retry = settings.serverUrl + START_PATH;
  // 서버 오류(5xx)는 그 화면만의 문제일 수 있어 주문판으로 되돌아간다(같은 화면 재시도 무한 반복 방지)
  if (kind !== "server") try { const u = new URL(failedUrl); if (u.origin === serverOrigin() && u.pathname.startsWith("/partner")) retry = u.href; } catch { /* */ }
  win.loadFile(OFFLINE_FILE, { query: { kind, url: retry } }).catch(() => {});
  if (!outage) { // 끊길 때 한 번만 OS 알림 — 주방이 화면을 안 보고 있어도 알 수 있게
    outage = true;
    new Notification({
      title: kind === "crash" ? "N오더 · 화면 다시 불러오는 중" : "N오더 · 서버 연결 끊김",
      body: "연결될 때까지 새 주문 알림과 자동 인쇄가 멈춰요. 인터넷 연결을 확인해 주세요.",
      urgency: "critical",
    }).show();
  }
}

/**
 * 운영 결정 #9 — 서버 요청에 «주방 앱» 표시 헤더를 붙인다. 서버는 **로그인할 때만** 이 헤더를 보고
 * 서명된 세션에 client=kitchen_app 을 싣고, 그 세션만 쓰는 동안(대기열 5초 조회) 만료를 민다.
 * 서버 origin 요청에만 붙인다(외부 도메인에 새지 않게).
 */
function markKitchenAppRequests() {
  const ses = session.fromPartition(PARTITION);
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    let mine = false;
    try { mine = new URL(details.url).origin === serverOrigin(); } catch { /* */ }
    if (mine) details.requestHeaders["X-NOrder-Client"] = `kitchen_app/${app.getVersion()}`;
    cb({ requestHeaders: details.requestHeaders });
  });
}

// 대기 중 신규 주문 수를 Dock(맥) 배지로 — 윈도우는 작업표시줄 깜빡임(flashFrame)으로 대신한다
function setPendingBadge(count) {
  try { app.setBadgeCount(Math.max(0, count | 0)); } catch { /* 미지원 */ }
  if (count <= 0 && win) win.flashFrame(false);
}

function setAttention(on) {
  if (!win) return;
  win.flashFrame(on);
  if (process.platform === "darwin") app.dock?.setBadge(on ? "!" : "");
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
    if (!allowed(url) && !isOfflinePage(url)) win.webContents.loadURL(settings.serverUrl + START_PATH);
  };
  win.webContents.on("did-navigate-in-page", (_e, url, isMainFrame) => { if (isMainFrame) bounce(url); });
  win.webContents.on("did-navigate", (_e, url, httpCode) => {
    if (httpCode >= 500 && allowed(url)) { showOffline("server", url); return; }
    bounce(url);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // 오프라인·서버 오류·렌더러 충돌 — 흰 빈 창 대신 안내 화면 + 자동 재시도(offline.html)
  win.webContents.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = ERR_ABORTED(다른 이동으로 취소) — 오류 아님
    showOffline("network", url);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    if (details.reason === "clean-exit") return;
    showOffline("crash", settings.serverUrl + START_PATH);
  });
  win.webContents.on("did-finish-load", () => {
    if (win && allowed(win.webContents.getURL())) outage = false;
  });

  win.on("closed", () => { win = null; });
  win.loadURL(settings.serverUrl + START_PATH);
}

// ── 신규 주문 알림 (preload 가 DOM 감시 후 호출) ──────────────
// 운영 결정 #7 — repeat=true 는 수락·거절 전까지 30초마다 다시 오는 알림
ipcMain.on("norder:new-orders", (_e, { count, repeat }) => {
  if (!win) return;
  new Notification({
    title: repeat ? "N오더 · 아직 수락하지 않은 주문" : "N오더 · 신규 주문",
    body: repeat
      ? `새 주문 ${count}건이 아직 수락·거절을 기다려요. 수락 마감 전에 확인해 주세요.`
      : `새 주문 ${count}건이 접수 대기 중입니다. 수락 마감 전에 확인해 주세요.`,
    urgency: "critical",
  }).show();
  setPendingBadge(count);
  win.flashFrame(true);
  if (win.isMinimized()) win.restore();
  win.show();
});
ipcMain.on("norder:pending", (_e, { count }) => setPendingBadge(count));
ipcMain.on("norder:alert-ack", () => { if (win) win.flashFrame(false); });

// ── 로그인 풀림(세션 12시간 만료 등) — preload 가 로그인 화면을 감지하면 1분마다 호출 ──
ipcMain.handle("norder:logged-out", () => {
  if (!win || !settings.expectLogin) return { alert: false };
  new Notification({
    title: "N오더 · 다시 로그인해 주세요",
    body: "주방 앱 로그인이 풀려 새 주문을 받을 수 없어요. 다시 로그인해야 주문 알림과 자동 인쇄가 동작해요.",
    urgency: "critical",
  }).show();
  setAttention(true);
  if (win.isMinimized()) win.restore();
  win.show();
  return { alert: true };
});
ipcMain.on("norder:logged-in", () => {
  setAttention(false);
  if (!settings.expectLogin) { settings.expectLogin = true; saveSettings(settings); }
});

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

// 대기열 자동 인쇄를 찜해도 되는지 — 인쇄 꺼짐·자동 인쇄 꺼짐이면 찜하지 않는다(같은 매장 다른 PC 몫으로 남긴다)
ipcMain.handle("norder:print-enabled", () => settings.printer.mode !== "off" && settings.printer.autoPrint !== false);
ipcMain.on("norder:print-failed", (_e, { orderNo }) => {
  new Notification({
    title: "N오더 · 주문서 인쇄 실패",
    body: `주문 ${orderNo || ""} 주문서를 인쇄하지 못했어요. 프린터를 확인해 주세요. 1분 뒤 다시 인쇄해요.`,
    urgency: "critical",
  }).show();
  win?.flashFrame(true);
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
/**
 * 주문을 보다가 한 번에 일시정지 조작부로. 경로는 /partner 로 시작하므로 allowed() 를 통과한다.
 * ⛔ 신규 주문 감시·알림음·전면 팝업·자동 인쇄에는 손대지 않는다 — 단순 이동일 뿐이다.
 */
function gotoPause() {
  if (!win) return;
  win.loadURL(settings.serverUrl + PAUSE_PATH);
  win.webContents.once("did-finish-load", () => {
    win?.webContents.executeJavaScript(
      'document.querySelector(\'[data-testid="pn-dlv-status-banner"]\')?.scrollIntoView({ block: "start" });',
    ).catch(() => {});
  });
}

function buildMenu() {
  const template = [
    {
      label: "앱",
      submenu: [
        { label: "주문판으로 이동", accelerator: "CmdOrCtrl+H", click: () => win?.loadURL(settings.serverUrl + START_PATH) },
        { label: "배달 일시정지 화면으로 이동", accelerator: "CmdOrCtrl+Shift+P", click: () => gotoPause() },
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
            settings.expectLogin = false; // 직접 로그아웃 — 로그인 풀림 경보 끔
            saveSettings(settings);
            setAttention(false);
            await session.fromPartition(PARTITION).clearStorageData();
            win?.loadURL(settings.serverUrl + "/partner/login");
          },
        },
        { type: "separator" },
        { role: "quit", label: "종료" },
      ],
    },
    // 맥은 «편집» 메뉴가 있어야 입력칸에서 Cmd+C/V/X/A/Z 가 동작한다(윈도우는 영향 없음)
    { role: "editMenu", label: "편집" },
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
          label: "컴퓨터를 켜면 자동 실행", type: "checkbox", checked: settings.autoLaunch,
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
