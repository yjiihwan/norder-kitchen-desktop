// afterPack 훅 — macOS 서명 경로의 폴백 담당.
//
// 자격증명(Developer ID)이 있으면 electron-builder 내장 서명·공증(hardenedRuntime·entitlements·notarize)이 이어서 실행되므로 여기선 아무것도 하지 않는다.
// 없으면 electron-builder는 서명을 건너뛰는데, arm64 macOS는 무서명 바이너리 실행을 거부하므로
// 같은 옵션(hardened runtime + 동일 entitlements)으로 ad-hoc(-) 서명해 기존 «무서명 dmg» 릴리스 흐름을 유지한다.
const { execFileSync } = require("child_process");
const path = require("path");

const isTrue = (v) => /^(1|true|yes)$/i.test(String(v || "").trim());

function hasDeveloperIdInKeychain() {
  try {
    const out = execFileSync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
    return out.includes("Developer ID Application:");
  } catch {
    return false;
  }
}

// electron-builder가 실제 Developer ID 서명을 수행할지 예측(macCodeSign.findIdentity 규칙과 동일한 입력)
function realSigningExpected(macConfig) {
  if (macConfig.identity === null) return false;
  if (process.env.CSC_LINK || process.env.CSC_NAME || macConfig.identity) return true;
  const autoDiscovery = process.env.CSC_IDENTITY_AUTO_DISCOVERY;
  if (autoDiscovery != null && !isTrue(autoDiscovery)) return false;
  return hasDeveloperIdInKeychain();
}

exports.default = async function macSignFallback(context) {
  if (context.electronPlatformName !== "darwin") return;
  // universal 빌드는 아치별 temp 팩을 먼저 만든다 — 여기서 서명하면 병합 시 SHA 불일치로 실패. 최종 팩만 처리.
  if (context.appOutDir.includes("-temp")) return;

  const macConfig = context.packager.platformSpecificBuildOptions || {};
  if (realSigningExpected(macConfig)) {
    console.log("  • [mac-sign] Developer ID 자격증명 감지 — electron-builder 내장 서명·공증에 위임 (ad-hoc 건너뜀)");
    return;
  }

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resDir = context.packager.info.buildResourcesDir;
  const entitlements = macConfig.entitlements ? path.resolve(resDir, "..", macConfig.entitlements) : path.join(resDir, "entitlements.mac.plist");
  const entitlementsInherit = macConfig.entitlementsInherit
    ? path.resolve(resDir, "..", macConfig.entitlementsInherit)
    : path.join(resDir, "entitlements.mac.inherit.plist");
  const hardenedRuntime = macConfig.hardenedRuntime !== false;

  console.log(`  • [mac-sign] 자격증명 없음 — ad-hoc(-) 서명 폴백 (hardenedRuntime=${hardenedRuntime}, entitlements=${path.basename(entitlements)})`);
  const { signApp } = await import("@electron/osx-sign");
  await signApp({
    app: appPath,
    identity: "-",
    identityValidation: false,
    platform: "darwin",
    type: "distribution",
    version: context.packager.config.electronVersion || undefined,
    preAutoEntitlements: macConfig.preAutoEntitlements !== false,
    optionsForFile: (filePath) => ({
      hardenedRuntime,
      entitlements: filePath === appPath ? entitlements : entitlementsInherit,
    }),
  });
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=1", appPath], { stdio: "inherit" });
};
