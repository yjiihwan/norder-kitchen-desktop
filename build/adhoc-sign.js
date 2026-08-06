// arm64 macOS는 무서명 바이너리 실행을 거부한다 — 배포 인증서 없이도 돌게 ad-hoc 서명(-)을 강제.
const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  // 아치별 temp 팩을 서명하면 universal 병합이 SHA 불일치로 실패 — 최종 팩만 서명
  if (context.appOutDir.includes("-temp")) return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
};
