// 설치파일(exe·dmg)을 직접 열어 어느 서버에 붙는지 확인하는 게이트.
// 실행: node build/verify-channel.js dist/NOrder-Kitchen-Setup-0.4.7.exe dist/NOrder-Kitchen-0.4.7-universal.dmg ...
// 파일 이름에 -staging 이 있으면 테스트서버, 없으면 실서버(norder.shop)여야 통과.
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

function inspect(asarPath) {
  const pkg = JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8"));
  const channelSrc = asar.extractFile(asarPath, "src/channel.js").toString("utf8");
  const mainSrc = asar.extractFile(asarPath, "src/main.js").toString("utf8");
  const channel = EXPECT[pkg.norderChannel] ? pkg.norderChannel : "staging"; // channel.js 와 같은 규칙
  const m = channelSrc.match(new RegExp(`${channel}:\\s*\\{\\s*server:\\s*"([^"]+)",\\s*title:\\s*"([^"]+)"`));
  return {
    version: pkg.version, norderChannel: pkg.norderChannel, channel,
    server: m && m[1], title: m && m[2],
    mainUsesChannel: mainSrc.includes("const DEFAULT_SERVER = channel.server;"),
    allowsPasswordPage: mainSrc.includes('"/admin/password"'),
  };
}

let failed = 0;
for (const file of process.argv.slice(2)) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "norder-verify-"));
  const want = /-staging\.(exe|dmg)$/.test(file) ? "staging" : "prod";
  try {
    const r = file.endsWith(".exe") ? readAsarFromExe(file, tmp) : readAsarFromDmg(file, tmp);
    const ok = r.channel === want && r.server === EXPECT[want] && r.mainUsesChannel && r.allowsPasswordPage
      && (want === "prod" ? !r.title.includes("staging") : r.title.includes("staging"));
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
