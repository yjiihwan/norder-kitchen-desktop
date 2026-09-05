// 빌드 산출물 서명 상태 검증 게이트. 사용: node build/verify-mac-sign.js [--expect adhoc|developer-id] [--strict-gatekeeper]
// 종료코드 0=PASS. 결과 JSON을 stdout 마지막 줄에 출력한다.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const expect = argVal("--expect") || "any";
const strictGatekeeper = args.includes("--strict-gatekeeper");

const dist = path.join(__dirname, "..", "dist");
const appDir = path.join(dist, "mac-universal");
const app = fs.existsSync(appDir) ? fs.readdirSync(appDir).map((f) => path.join(appDir, f)).find((f) => f.endsWith(".app")) : null;
const dmg = fs.existsSync(dist) ? fs.readdirSync(dist).filter((f) => f.endsWith(".dmg")).map((f) => path.join(dist, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] : null;

const run = (cmd, a) => { const r = spawnSync(cmd, a, { encoding: "utf8" }); return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") }; };
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail: String(detail || "").trim().slice(0, 400) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).trim().split("\n")[0].slice(0, 160) : ""}`); };

check("app 존재", !!app, app);
if (!app) { console.log(JSON.stringify({ pass: false, checks })); process.exit(1); }

const dv = run("codesign", ["-dvvv", "--entitlements", "-", app]);
check("codesign -dvvv", dv.ok, dv.out);
const authority = /Authority=([^\n]+)/.exec(dv.out)?.[1] || null;
const adhoc = /Signature=adhoc/.test(dv.out);
const kind = adhoc ? "adhoc" : /Developer ID Application/.test(dv.out) ? "developer-id" : "unknown";
check("서명 종류 판정", kind !== "unknown", `${kind}${authority ? " / " + authority : ""}`);
check("Hardened Runtime 플래그", /flags=0x[0-9a-f]+\(.*runtime.*\)/i.test(dv.out), /flags=[^\n]+/.exec(dv.out)?.[0]);
check("entitlements: allow-jit", /com\.apple\.security\.cs\.allow-jit/.test(dv.out), "com.apple.security.cs.allow-jit");
check("entitlements: allow-unsigned-executable-memory", /allow-unsigned-executable-memory/.test(dv.out));
check("TeamIdentifier/Identifier", /Identifier=kr\.co\.ngym\.norder\.kitchen/.test(dv.out), /Identifier=[^\n]+/.exec(dv.out)?.[0]);

const verify = run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
check("codesign --verify --deep --strict", verify.ok, verify.out);

const helpers = fs.readdirSync(path.join(app, "Contents", "Frameworks")).filter((f) => f.endsWith(".app"));
for (const h of helpers) {
  const hv = run("codesign", ["-dvvv", path.join(app, "Contents", "Frameworks", h)]);
  check(`헬퍼 hardened: ${h}`, hv.ok && /\(.*runtime.*\)/.test(hv.out), /flags=[^\n]+/.exec(hv.out)?.[0]);
}

const arches = run("lipo", ["-archs", path.join(app, "Contents", "MacOS", path.basename(app, ".app"))]);
check("universal(x86_64 arm64)", /x86_64/.test(arches.out) && /arm64/.test(arches.out), arches.out);

if (expect !== "any") check(`기대 서명 종류=${expect}`, kind === expect, kind);

const spctl = run("spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
if (kind === "developer-id" || strictGatekeeper) check("Gatekeeper spctl --assess (공증 필요)", spctl.ok, spctl.out);
else console.log(`INFO  spctl --assess: ${spctl.out.trim().split("\n")[0]} (ad-hoc 빌드는 공증 전이라 거부가 정상)`);

if (kind === "developer-id") {
  const st = run("xcrun", ["stapler", "validate", app]);
  check("stapler validate (app 공증 티켓)", st.ok, st.out);
}
if (dmg) {
  check("dmg 존재", true, path.basename(dmg));
  const ddv = run("codesign", ["-dv", dmg]);
  if (kind === "developer-id") {
    check("dmg Developer ID 서명", ddv.ok && /Developer ID Application/.test(ddv.out), ddv.out);
    const dst = run("xcrun", ["stapler", "validate", dmg]);
    check("stapler validate (dmg 공증 티켓)", dst.ok, dst.out);
  } else console.log(`INFO  dmg 서명: ${ddv.ok ? "signed" : "unsigned (ad-hoc 빌드 정상)"}`);
} else check("dmg 존재", false, "dist/*.dmg 없음");

const pass = checks.every((c) => c.ok);
console.log(`\n${pass ? "✅ PASS" : "❌ FAIL"} ${checks.filter((c) => c.ok).length}/${checks.length}`);
console.log(JSON.stringify({ pass, kind, authority, checks }));
process.exit(pass ? 0 : 1);
