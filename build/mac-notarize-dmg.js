// afterAllArtifactBuild 훅 — 공증 자격증명이 있을 때만 .dmg 자체를 공증·스테이플한다.
//
// electron-builder는 .app만 공증·스테이플하고 dmg는 서명만 한다. dmg까지 스테이플하면
// 오프라인 첫 실행에서도 Gatekeeper가 티켓을 즉시 확인한다. 자격증명이 없으면 조용히 건너뛴다.
const { execFileSync, spawnSync } = require("child_process");
const path = require("path");

function notaryAuthArgs() {
  const e = process.env;
  if (e.APPLE_ID && e.APPLE_APP_SPECIFIC_PASSWORD && e.APPLE_TEAM_ID) {
    return ["--apple-id", e.APPLE_ID, "--password", e.APPLE_APP_SPECIFIC_PASSWORD, "--team-id", e.APPLE_TEAM_ID];
  }
  if (e.APPLE_API_KEY && e.APPLE_API_KEY_ID && e.APPLE_API_ISSUER) {
    return ["--key", e.APPLE_API_KEY, "--key-id", e.APPLE_API_KEY_ID, "--issuer", e.APPLE_API_ISSUER];
  }
  if (e.APPLE_KEYCHAIN_PROFILE) {
    return ["--keychain-profile", e.APPLE_KEYCHAIN_PROFILE, ...(e.APPLE_KEYCHAIN ? ["--keychain", e.APPLE_KEYCHAIN] : [])];
  }
  return null;
}

function isDeveloperIdSigned(dmgPath) {
  const r = spawnSync("codesign", ["-dv", dmgPath], { encoding: "utf8" });
  return r.status === 0 && /Authority=Developer ID Application/.test(r.stderr + r.stdout);
}

exports.default = async function notarizeDmg(context) {
  if (process.platform !== "darwin") return [];
  const dmgs = (context.artifactPaths || []).filter((p) => p.endsWith(".dmg"));
  if (dmgs.length === 0) return [];
  const auth = notaryAuthArgs();
  if (!auth) {
    console.log("  • [mac-notarize-dmg] 공증 자격증명 없음 — dmg 공증·스테이플 건너뜀");
    return [];
  }
  for (const dmg of dmgs) {
    if (!isDeveloperIdSigned(dmg)) {
      console.log(`  • [mac-notarize-dmg] ${path.basename(dmg)} 는 Developer ID 서명이 아님 — 건너뜀`);
      continue;
    }
    console.log(`  • [mac-notarize-dmg] notarytool submit --wait: ${path.basename(dmg)}`);
    execFileSync("xcrun", ["notarytool", "submit", dmg, "--wait", ...auth], { stdio: "inherit" });
    execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
    execFileSync("xcrun", ["stapler", "validate", dmg], { stdio: "inherit" });
  }
  return [];
};
