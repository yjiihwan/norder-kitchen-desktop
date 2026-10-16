// 자동 업데이트(0.4.10~).
// 윈도우: 켤 때(1분 뒤)와 1시간마다 확인 → 조용히 받아 두고 → 앱을 끌 때 설치, 또는 사람이 «재시작해서 업데이트»를 누를 때만 설치.
//   영업 중에 저절로 재시작하지 않는다(재시작 동안 주문 알림이 멈추므로).
// 맥: ad-hoc 서명이라 Squirrel.Mac 이 설치를 거부한다 → electron-updater 를 쓰지 않고 새 버전 «안내»만 한다.
// 실패(오프라인·GitHub 접속 불가·파일 없음)는 기록만 하고 화면에 아무것도 띄우지 않는다.
const fs = require("fs");
const path = require("path");

const FIRST_CHECK_MS = 60_000;
const INTERVAL_MS = 60 * 60_000;

// 받기 전에 설치파일 이름을 한 번 더 본다 — 통로 주소가 잘못 바뀌어도 다른 채널 설치파일은 받지 않는다.
const INSTALLER_NAME = {
  prod: /^NOrder-Kitchen-Setup-\d+\.\d+\.\d+\.exe$/,
  staging: /^NOrder-Kitchen-Setup-\d+\.\d+\.\d+-staging\.exe$/,
};

function installerNameOk(channelName, urlOrName) {
  const re = INSTALLER_NAME[channelName];
  if (!re || typeof urlOrName !== "string") return false;
  let name = urlOrName;
  try { name = decodeURIComponent(new URL(urlOrName).pathname.split("/").pop()); } catch { name = urlOrName.split("/").pop(); }
  return re.test(name);
}

function updateInfoOk(channelName, info) {
  const files = Array.isArray(info?.files) ? info.files : [];
  return files.length > 0 && files.every((f) => installerNameOk(channelName, f.url));
}

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || "").trim());
  return m ? m.slice(1, 4).map(Number) : null;
}

function isNewer(remote, current) {
  const a = parseVersion(remote), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function ymlVersion(text) {
  const m = /^version:\s*['"]?([0-9][^\s'"]*)/m.exec(String(text || ""));
  return m ? m[1] : null;
}

function appUpdateYml(feed) {
  return [
    "provider: generic",
    `url: ${feed.url}`,
    `channel: ${feed.channel}`,
    "updaterCacheDirName: norder-kitchen-updater",
    "",
  ].join("\n");
}

/**
 * deps: app, channelName, feed(channel.update), onState(state), log(msg), platform, createNsisUpdater(), fetchText(url)
 * 상태: { kind: "none" | "downloading" | "ready" | "available-manual", version, downloadUrl? }
 */
function startUpdater(deps) {
  const {
    app, channelName, feed, onState = () => {}, log = () => {},
    platform = process.platform,
    firstCheckMs = FIRST_CHECK_MS, intervalMs = INTERVAL_MS,
  } = deps;
  let state = { kind: "none" };
  const set = (s) => { state = s; try { onState(s); } catch { /* */ } };
  const timers = [];
  const schedule = (fn) => {
    timers.push(setTimeout(fn, firstCheckMs));
    timers.push(setInterval(fn, intervalMs));
  };
  const stop = () => timers.forEach((t) => { clearTimeout(t); clearInterval(t); });

  if (platform === "darwin") {
    const fetchText = deps.fetchText || (async (url) => {
      const { net } = require("electron");
      const r = await net.fetch(`${url}?t=${Date.now()}`, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    });
    const check = async () => {
      try {
        const v = ymlVersion(await fetchText(`${feed.url}/${feed.channel}.yml`));
        if (v && isNewer(v, app.getVersion())) set({ kind: "available-manual", version: v, downloadUrl: feed.macDownload });
      } catch (e) { log(`mac check: ${e.message}`); }
    };
    schedule(check);
    return { getState: () => state, checkNow: check, installNow: () => false, stop };
  }

  if (platform !== "win32") return { getState: () => state, checkNow: async () => {}, installNow: () => false, stop };

  let u;
  try {
    const cfg = path.join(app.getPath("userData"), "norder-update.yml");
    fs.writeFileSync(cfg, appUpdateYml(feed));
    u = deps.createNsisUpdater ? deps.createNsisUpdater() : new (require("electron-updater").NsisUpdater)();
    if (deps.forceDev) { // 검증용 — 설치 안 한(개발) 실행에서도 확인·받기까지 돌린다(맥에서 윈도우 경로를 돌릴 땐 통로 파일 이름도 윈도우 규칙으로)
      u.forceDevUpdateConfig = true;
      if (deps.testPlatform) u._testOnlyOptions = { platform: deps.testPlatform };
    }
    u.updateConfigPath = cfg;
    u.channel = feed.channel;
    u.allowDowngrade = false;   // channel 설정이 true 로 바꾸므로 다시 끈다
    u.allowPrerelease = false;
    u.autoDownload = false;      // 이름 확인 뒤에 직접 받는다
    u.autoInstallOnAppQuit = true;
    u.autoRunAppAfterInstall = true;
    u.disableDifferentialDownload = true; // 90MB 통째로 — 조각 받기 실패 경로를 없앤다
    u.logger = { info: (m) => log(m), warn: (m) => log(m), error: (m) => log(m), debug: () => {} };
  } catch (e) {
    log(`updater init: ${e.message}`);
    return { getState: () => state, checkNow: async () => {}, installNow: () => false, stop };
  }

  let busy = false;
  const check = async () => {
    if (busy || state.kind === "ready") return;
    busy = true;
    try {
      const r = await u.checkForUpdates();
      const info = r?.updateInfo;
      if (!r?.isUpdateAvailable || !info) return;
      if (!updateInfoOk(channelName, info)) {
        log(`blocked: ${channelName} 앱이 다른 채널 설치파일을 가리키는 업데이트 정보를 받음 ${JSON.stringify(info.files?.map((f) => f.url))}`);
        return;
      }
      set({ kind: "downloading", version: info.version });
      await u.downloadUpdate();
      set({ kind: "ready", version: info.version });
    } catch (e) {
      log(`check/download: ${e.message}`);
      if (state.kind === "downloading") set({ kind: "none" });
    } finally {
      busy = false;
    }
  };
  schedule(check);

  return {
    getState: () => state,
    checkNow: check,
    // 사람이 누를 때만 — 조용히 설치하고 다시 켠다
    installNow: () => {
      if (state.kind !== "ready") return false;
      setImmediate(() => u.quitAndInstall(true, true));
      return true;
    },
    stop,
    _updater: u,
  };
}

module.exports = { startUpdater, installerNameOk, updateInfoOk, isNewer, ymlVersion, appUpdateYml, INSTALLER_NAME };
