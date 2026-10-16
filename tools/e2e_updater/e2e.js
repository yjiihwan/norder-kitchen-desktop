// 자동 업데이트 검증(맥에서 윈도우 업데이트 경로를 돌린다 — 확인·이름 검사·받기·SHA512 검증까지. 설치·재실행은 윈도우에서만).
// 실행: npx electron tools/e2e_updater           (로컬 가짜 통로)
//       E2E_REAL=1 npx electron tools/e2e_updater (실제 GitHub 통로 — 릴리스가 올라간 뒤)
// 이 폴더의 package.json version(0.4.10)이 «설치된 앱 버전» 역할을 한다.
const { app, dialog } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { NsisUpdater } = require("electron-updater");
const U = require("../../src/updater");
const channel = require("../../src/channel");

const results = [];
const ok = (name, cond, extra = "") => { results.push({ name, pass: !!cond, extra }); console.log(`${cond ? "PASS" : "FAIL"} ${name} ${extra}`); };
let dialogs = 0;
dialog.showMessageBox = async () => { dialogs++; return { response: 1 }; };
dialog.showErrorBox = () => { dialogs++; };
let uncaught = 0;
process.on("uncaughtException", (e) => { uncaught++; console.log("UNCAUGHT", e.message); });
process.on("unhandledRejection", (e) => { uncaught++; console.log("UNHANDLED", e?.message); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "norder-upd-e2e-"));
app.setPath("userData", path.join(tmp, "userData"));
fs.mkdirSync(app.getPath("userData"), { recursive: true });
const cacheDir = path.join(app.getPath("cache"), "norder-kitchen-updater");

function serve(root) {
  const log = [];
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split("?")[0]);
    log.push(p);
    const f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end("nf"); }
    res.setHeader("content-length", fs.statSync(f).size);
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, log, base: `http://127.0.0.1:${srv.address().port}` })));
}

function yml(version, url, file) {
  const buf = fs.readFileSync(file);
  const sha512 = crypto.createHash("sha512").update(buf).digest("base64");
  return `version: ${version}\nfiles:\n  - url: ${url}\n    sha512: ${sha512}\n    size: ${buf.length}\npath: ${url}\nsha512: ${sha512}\nreleaseDate: '2026-10-16T00:00:00.000Z'\n`;
}

function run(channelName, feed, opts = {}) {
  return new Promise((resolve) => {
    const states = [];
    const h = U.startUpdater({
      app, channelName, feed, platform: opts.platform || "win32", forceDev: true,
      firstCheckMs: 10, intervalMs: 3_600_000, log: (m) => opts.logs?.push(m),
      fetchText: opts.fetchText,
      // 맥에서 돌리므로 통로 파일 이름 규칙만 윈도우로(staging.yml·latest.yml — 맥이면 -mac.yml 을 찾는다)
      createNsisUpdater: () => { const u = new NsisUpdater(); u._testOnlyOptions = { platform: "win32" }; return u; },
      onState: (s) => states.push(s),
    });
    const t0 = Date.now();
    const iv = setInterval(() => {
      const st = h.getState();
      if (st.kind === "ready" || st.kind === "available-manual" || Date.now() - t0 > (opts.waitMs || 8000)) {
        clearInterval(iv); h.stop(); resolve({ st, states, h });
      }
    }, 100);
  });
}

async function local() {
  // 순수 함수
  ok("이름: prod 정상", U.installerNameOk("prod", "https://x/releases/download/v0.4.10/NOrder-Kitchen-Setup-0.4.10.exe"));
  ok("이름: prod 가 staging exe 거부", !U.installerNameOk("prod", "https://x/NOrder-Kitchen-Setup-0.4.10-staging.exe"));
  ok("이름: staging 정상", U.installerNameOk("staging", "https://x/NOrder-Kitchen-Setup-0.4.11-staging.exe"));
  ok("이름: staging 이 prod exe 거부", !U.installerNameOk("staging", "https://x/NOrder-Kitchen-Setup-0.4.11.exe"));
  ok("이름: 이름 고정 사본(웹용)은 둘 다 거부", !U.installerNameOk("prod", "NOrder-Kitchen-Setup.exe") && !U.installerNameOk("staging", "NOrder-Kitchen-Setup-staging.exe"));
  ok("버전 비교", U.isNewer("0.4.11", "0.4.10") && !U.isNewer("0.4.10", "0.4.10") && !U.isNewer("0.4.9", "0.4.10") && U.isNewer("0.5.0", "0.4.10"));
  ok("채널 통로 분리", channel.update.url.includes("staging-channel") && channel.update.channel === "staging", JSON.stringify(channel.update));

  // 가짜 통로: latest/ (실서버) · staging-channel/ (테스트) · v0.4.11/ (설치파일)
  const root = path.join(tmp, "srv");
  for (const d of ["latest", "staging-channel", "v0.4.11", "swap-s", "swap-p"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  const prodExe = path.join(root, "v0.4.11/NOrder-Kitchen-Setup-0.4.11.exe");
  const stgExe = path.join(root, "v0.4.11/NOrder-Kitchen-Setup-0.4.11-staging.exe");
  fs.writeFileSync(prodExe, crypto.randomBytes(95 * 1024 * 1024)); // 실제와 비슷한 크기 — 받는 동안 멈춤 측정
  fs.writeFileSync(stgExe, Buffer.concat([crypto.randomBytes(1024 * 1024), Buffer.from("staging")]));
  const { srv, log, base } = await serve(root);
  fs.writeFileSync(path.join(root, "latest/latest.yml"), yml("0.4.11", `${base}/v0.4.11/NOrder-Kitchen-Setup-0.4.11.exe`, prodExe));
  fs.writeFileSync(path.join(root, "staging-channel/staging.yml"), yml("0.4.11", `${base}/v0.4.11/NOrder-Kitchen-Setup-0.4.11-staging.exe`, stgExe));
  // 뒤바뀐 yml — staging.yml 이 실서버 exe 를, latest.yml 이 staging exe 를 가리킴
  fs.writeFileSync(path.join(root, "swap-s/staging.yml"), yml("0.4.11", `${base}/v0.4.11/NOrder-Kitchen-Setup-0.4.11.exe`, prodExe));
  fs.writeFileSync(path.join(root, "swap-p/latest.yml"), yml("0.4.11", `${base}/v0.4.11/NOrder-Kitchen-Setup-0.4.11-staging.exe`, stgExe));

  const clean = () => fs.rmSync(cacheDir, { recursive: true, force: true });

  clean(); log.length = 0;
  let r = await run("staging", { url: `${base}/staging-channel`, channel: "staging" });
  ok("staging 앱: 0.4.11-staging 감지→받기→ready", r.st.kind === "ready" && r.st.version === "0.4.11", JSON.stringify(r.states));
  ok("staging 앱: staging.yml·staging exe 만 요청", log.every((p) => p.startsWith("/staging-channel/staging.yml") || p.endsWith("-staging.exe")) && log.some((p) => p.endsWith("-staging.exe")), JSON.stringify(log));
  const got = fs.readdirSync(path.join(cacheDir, "pending")).filter((f) => f.endsWith(".exe"));
  ok("받은 파일 = staging exe(SHA 일치)", got.length === 1 && fs.readFileSync(path.join(cacheDir, "pending", got[0])).equals(fs.readFileSync(stgExe)), got.join(","));

  clean(); log.length = 0;
  let lag = 0; let last = Date.now();
  const lagIv = setInterval(() => { const n = Date.now(); lag = Math.max(lag, n - last - 20); last = n; }, 20);
  r = await run("prod", { url: `${base}/latest`, channel: "latest" }, { waitMs: 60000 });
  clearInterval(lagIv);
  ok("prod 앱: 0.4.11 감지→받기(95MB)→ready", r.st.kind === "ready", JSON.stringify(r.states));
  ok("prod 앱: latest.yml·prod exe 만 요청(staging 파일 0)", log.every((p) => !p.includes("staging")), JSON.stringify(log));
  ok("받는 동안 메인 이벤트 루프 최대 지연 < 250ms(주문 알림 IPC 처리 가능)", lag < 250, `${lag}ms`);

  clean(); log.length = 0;
  r = await run("staging", { url: `${base}/swap-s`, channel: "staging" }, { waitMs: 3000 });
  ok("뒤바뀐 staging.yml(실서버 exe) → 받지 않음", r.st.kind === "none" && !log.some((p) => p.endsWith(".exe")), JSON.stringify(log));
  clean(); log.length = 0;
  r = await run("prod", { url: `${base}/swap-p`, channel: "latest" }, { waitMs: 3000 });
  ok("뒤바뀐 latest.yml(staging exe) → 받지 않음", r.st.kind === "none" && !log.some((p) => p.endsWith(".exe")), JSON.stringify(log));
  clean(); log.length = 0;
  r = await run("prod", { url: `${base}/staging-channel`, channel: "latest" }, { waitMs: 3000 });
  ok("prod 앱이 staging 통로를 봐도 latest.yml 없음 → 아무 일 없음", r.st.kind === "none" && !log.some((p) => p.endsWith(".exe")), JSON.stringify(log));
  clean(); log.length = 0;
  r = await run("staging", { url: `${base}/latest`, channel: "staging" }, { waitMs: 3000 });
  ok("staging 앱이 실서버 통로를 봐도 staging.yml 없음 → 아무 일 없음", r.st.kind === "none" && !log.some((p) => p.endsWith(".exe")), JSON.stringify(log));

  // 오프라인·접속 불가
  const logs = [];
  r = await run("prod", { url: "http://127.0.0.1:39127/x", channel: "latest" }, { waitMs: 6000, logs });
  ok("오프라인(연결 거부) → 조용히 none", r.st.kind === "none", logs.slice(-1)[0]?.slice(0, 120));
  logs.length = 0;
  r = await run("staging", { url: "https://norder-update.invalid/x", channel: "staging" }, { waitMs: 6000, logs });
  ok("GitHub 접속 불가(DNS 실패) → 조용히 none", r.st.kind === "none", logs.slice(-1)[0]?.slice(0, 120));

  // 맥 — 안내만
  r = await run("prod", channel.update && { ...channel.update, url: `${base}/latest`, channel: "latest", macDownload: "https://dl/mac.dmg" }, { platform: "darwin", fetchText: async (u) => (await fetch(u)).text() });
  ok("맥: 새 버전 «안내»만(available-manual, 받기 없음)", r.st.kind === "available-manual" && r.st.downloadUrl === "https://dl/mac.dmg");
  r = await run("prod", { url: "x", channel: "latest", macDownload: "y" }, { platform: "darwin", waitMs: 1500, fetchText: async () => { throw new Error("offline"); } });
  ok("맥: 오프라인이면 조용히 none", r.st.kind === "none");

  srv.close();
  clean();
}

async function real() {
  const RELEASES = "https://github.com/yjiihwan/norder-kitchen-desktop/releases";
  const clean = () => fs.rmSync(cacheDir, { recursive: true, force: true });
  clean();
  let r = await run("staging", { url: `${RELEASES}/download/staging-channel`, channel: "staging" }, { waitMs: 240000 });
  ok(`[실제] staging 0.4.10 앱 → ${process.env.E2E_EXPECT_STAGING || "0.4.11"} 감지·받기`, r.st.kind === "ready" && r.st.version === (process.env.E2E_EXPECT_STAGING || "0.4.11"), JSON.stringify(r.states));
  if (r.st.kind === "ready") {
    const got = fs.readdirSync(path.join(cacheDir, "pending")).filter((f) => f.endsWith(".exe"));
    const sha = got[0] && crypto.createHash("sha256").update(fs.readFileSync(path.join(cacheDir, "pending", got[0]))).digest("hex");
    ok("[실제] 받은 파일", /-staging\.exe$/.test(got[0] || ""), `${got[0]} sha256=${sha}`);
  }
  clean();
  const logs = [];
  r = await run("prod", { url: `${RELEASES}/latest/download`, channel: "latest" }, { waitMs: 30000, logs });
  ok(`[실제] prod 0.4.10 앱 → 업데이트 없음(Latest=${process.env.E2E_EXPECT_PROD || "0.4.10"})`, r.st.kind === "none", logs.filter((l) => /version|Update/.test(l)).slice(-2).join(" | ").slice(0, 200));
  clean();
}

app.whenReady().then(async () => {
  try { process.env.E2E_REAL === "1" ? await real() : await local(); } catch (e) { ok("예외 없음", false, e.stack); }
  ok("오류창 0개", dialogs === 0, String(dialogs));
  ok("처리 안 된 예외 0개", uncaught === 0, String(uncaught));
  const fail = results.filter((x) => !x.pass).length;
  console.log(`\n${results.length - fail}/${results.length} PASS`);
  if (process.env.E2E_OUT) fs.writeFileSync(process.env.E2E_OUT, JSON.stringify(results, null, 2));
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(fail ? 1 : 0);
});
