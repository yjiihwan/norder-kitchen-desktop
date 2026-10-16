// 설치파일(exe·dmg)을 직접 열어 어느 서버에 붙는지 확인하는 게이트.
// 실행: node build/verify-channel.js dist/NOrder-Kitchen-Setup-0.4.7.exe dist/NOrder-Kitchen-0.4.7-universal.dmg ...
// 파일 이름에 -staging 이 있으면 테스트서버, 없으면 실서버(norder.shop)여야 통과.
// 0.4.10~ 자동 업데이트 통로(실서버=latest/latest.yml, 테스트=staging-channel/staging.yml)와 electron-updater 포함도 본다.
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const asar = require("@electron/asar");

const EXPECT = { prod: "https://norder.shop", staging: "https://norder-web-staging.up.railway.app" };
const SEVEN_ZIP = process.env.SEVEN_ZIP
  || path.join(os.homedir(), "Library/Caches/electron-builder/7zip@1.0.0/7zip-darwin-arm64-fti70/bin/7zz");

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) { const r = findFile(p, name); if (r) return r; }
    else if (e.name === name) return p;
  }
  return null;
}

function readAsarFromExe(file, tmp) {
  execFileSync(SEVEN_ZIP, ["x", "-y", `-o${tmp}/outer`, file], { stdio: "ignore" });
  const inner = findFile(`${tmp}/outer`, "app-64.7z");
  if (!inner) throw new Error("app-64.7z 없음");
  execFileSync(SEVEN_ZIP, ["x", "-y", `-o${tmp}/inner`, inner, "resources/app.asar"], { stdio: "ignore" });
  return inspect(path.join(tmp, "inner/resources/app.asar"));
}

function readAsarFromDmg(file, tmp) {
  const mnt = path.join(tmp, "mnt");
  fs.mkdirSync(mnt);
  execFileSync("hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mnt, file], { stdio: "ignore" });
  try {
    const app = fs.readdirSync(mnt).find((n) => n.endsWith(".app"));
    return inspect(path.join(mnt, app, "Contents/Resources/app.asar"));
  } finally {
    execFileSync("hdiutil", ["detach", mnt, "-force"], { stdio: "ignore" });
  }
}

// 채널·자동 업데이트 통로는 설치파일 안의 channel.js 를 실제로 불러 읽는다(소스 정규식보다 정확).
const EXPECT_UPDATE = {
  prod: { url: "https://github.com/yjiihwan/norder-kitchen-desktop/releases/latest/download", channel: "latest" },
  staging: { url: "https://github.com/yjiihwan/norder-kitchen-desktop/releases/download/staging-channel", channel: "staging" },
};

function inspect(asarPath) {
  const pkgBuf = asar.extractFile(asarPath, "package.json");
  const pkg = JSON.parse(pkgBuf.toString("utf8"));
  const mainSrc = asar.extractFile(asarPath, "src/main.js").toString("utf8");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "norder-chan-"));
  try {
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "package.json"), pkgBuf);
    fs.writeFileSync(path.join(dir, "src/channel.js"), asar.extractFile(asarPath, "src/channel.js"));
    const env = { ...process.env }; delete env.NORDER_CHANNEL;
    const c = JSON.parse(execFileSync(process.execPath, ["-e",
      "const c=require(process.argv[1]);process.stdout.write(JSON.stringify({channel:c.CHANNEL,server:c.server,title:c.title,update:c.update}))",
      path.join(dir, "src/channel.js")], { env }).toString());
    let hasUpdater = false;
    try { asar.extractFile(asarPath, "node_modules/electron-updater/package.json"); hasUpdater = true; } catch { /* */ }
    return {
      version: pkg.version, norderChannel: pkg.norderChannel, ...c,
      mainUsesChannel: mainSrc.includes("const DEFAULT_SERVER = channel.server;"),
      allowsPasswordPage: mainSrc.includes('"/admin/password"'),
      updaterWired: mainSrc.includes("feed: channel.update") && hasUpdater,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let failed = 0;
for (const file of process.argv.slice(2)) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "norder-verify-"));
  const want = /-staging\.(exe|dmg)$/.test(file) ? "staging" : "prod";
  try {
    const r = file.endsWith(".exe") ? readAsarFromExe(file, tmp) : readAsarFromDmg(file, tmp);
    const ok = r.channel === want && r.server === EXPECT[want] && r.mainUsesChannel && r.allowsPasswordPage
      && (want === "prod" ? !r.title.includes("staging") : r.title.includes("staging"))
      && r.update?.url === EXPECT_UPDATE[want].url && r.update?.channel === EXPECT_UPDATE[want].channel
      && r.updaterWired;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"} ${path.basename(file)} expect=${want} ${JSON.stringify(r)}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${path.basename(file)} ${e.message}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
