// 릴리스 올릴 파일을 release_out/<버전>/ 에 모은다 — 설치파일 검사(verify-channel) → 이름 고정 사본 → 업데이트 파일(yml) → SHA256SUMS.
// 실행: node build/release-prep.js <버전> <태그> [--staging-only]
//   예) node build/release-prep.js 0.4.10 v0.4.10
//       node build/release-prep.js 0.4.11 v0.4.11-staging-test --staging-only   (테스트서버 전용 시험판)
// yml 의 설치파일 주소는 «버전 태그 릴리스»의 절대 주소다 — latest.yml(실서버)·staging.yml(테스트)이 어느 릴리스에 붙어 있든 정확한 파일을 가리킨다.
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { installerNameOk } = require("../src/updater");

const RELEASES = "https://github.com/yjiihwan/norder-kitchen-desktop/releases";
const [version, tag, flag] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version || "") || !tag) {
  console.error("사용법: node build/release-prep.js <버전 x.y.z> <태그> [--staging-only]");
  process.exit(2);
}
const stagingOnly = flag === "--staging-only";
const pkgVersion = require("../package.json").version;
if (pkgVersion !== version) { console.error(`package.json 버전(${pkgVersion}) ≠ ${version}`); process.exit(2); }

const dist = path.join(__dirname, "..", "dist");
const out = path.join(__dirname, "..", "release_out", version);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const files = {
  stagingExe: `NOrder-Kitchen-Setup-${version}-staging.exe`,
  stagingDmg: `NOrder-Kitchen-${version}-universal-staging.dmg`,
  ...(stagingOnly ? {} : { prodExe: `NOrder-Kitchen-Setup-${version}.exe`, prodDmg: `NOrder-Kitchen-${version}-universal.dmg` }),
};
for (const f of Object.values(files)) if (!fs.existsSync(path.join(dist, f))) { console.error(`없음: dist/${f}`); process.exit(1); }

execFileSync(process.execPath, [path.join(__dirname, "verify-channel.js"), ...Object.values(files).map((f) => path.join(dist, f))], { stdio: "inherit" });

const place = (src, name) => {
  const to = path.join(out, name);
  try { fs.linkSync(path.join(dist, src), to); } catch { fs.copyFileSync(path.join(dist, src), to); }
  return to;
};
const hash = (file, algo, enc) => crypto.createHash(algo).update(fs.readFileSync(file)).digest(enc);

function writeYml(channelName, ymlName, exeName) {
  const url = `${RELEASES}/download/${tag}/${exeName}`;
  if (!installerNameOk(channelName, url)) throw new Error(`${ymlName}: 설치파일 이름이 ${channelName} 규칙과 다름 — ${exeName}`);
  const exe = path.join(out, exeName);
  const sha512 = hash(exe, "sha512", "base64");
  const size = fs.statSync(exe).size;
  const yml = [
    `version: ${version}`,
    "files:",
    `  - url: ${url}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${url}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(out, ymlName), yml);
}

// 버전 태그 릴리스에 올릴 것
const tagAssets = [place(files.stagingExe, files.stagingExe), place(files.stagingDmg, files.stagingDmg)];
// staging-channel 릴리스에 올릴 것(테스트서버 다운로드 화면·테스트 앱 업데이트)
const stagingChannelDir = path.join(out, "staging-channel");
fs.mkdirSync(stagingChannelDir);
const stagingAssets = [
  ["NOrder-Kitchen-Setup-staging.exe", files.stagingExe],
  ["NOrder-Kitchen-universal-staging.dmg", files.stagingDmg],
].map(([fixed, src]) => {
  const to = path.join(stagingChannelDir, fixed);
  try { fs.linkSync(path.join(dist, src), to); } catch { fs.copyFileSync(path.join(dist, src), to); }
  return to;
});
writeYml("staging", "staging.yml", files.stagingExe);
fs.renameSync(path.join(out, "staging.yml"), path.join(stagingChannelDir, "staging.yml"));
stagingAssets.push(path.join(stagingChannelDir, "staging.yml"));

if (!stagingOnly) {
  tagAssets.push(place(files.prodExe, files.prodExe), place(files.prodDmg, files.prodDmg));
  // 이름 고정 사본 — 웹 다운로드 화면이 releases/latest/download/<이 이름> 을 가리킨다(버전이 올라도 웹 수정 불필요)
  tagAssets.push(place(files.prodExe, "NOrder-Kitchen-Setup.exe"), place(files.prodDmg, "NOrder-Kitchen-universal.dmg"));
  writeYml("prod", "latest.yml", files.prodExe);
  tagAssets.push(path.join(out, "latest.yml"));
}

const sums = [...tagAssets, ...stagingAssets].map((f) =>
  `${hash(f, "sha256", "hex")}  ${fs.statSync(f).size}  ${path.relative(out, f)}`);
fs.writeFileSync(path.join(out, "SHA256SUMS.txt"), sums.join("\n") + "\n");
console.log(sums.join("\n"));
console.log(`\n버전 태그(${tag}) 릴리스에 올릴 파일:\n  ${tagAssets.map((f) => path.relative(process.cwd(), f)).join("\n  ")}`);
console.log(`staging-channel 릴리스에 올릴 파일(--clobber):\n  ${stagingAssets.map((f) => path.relative(process.cwd(), f)).join("\n  ")}`);
