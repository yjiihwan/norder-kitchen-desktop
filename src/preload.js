// 신규 주문 감시 — 배달 주문판(전체 센터)에선 «신규 (N)» 탭·신규 카드 id 를 2초마다 읽고,
// 그 밖의 식당 화면(메뉴·정산·매장 전환 직후 홈 등)에선 20초마다 신규 탭 HTML 을 받아 같은 값을 읽는다.
// 주문판은 페이지 자체가 15초 폴링(router.refresh)하므로 거기선 서버를 따로 때리지 않는다.
const { contextBridge, ipcRenderer } = require("electron");

// 주방프린터 브릿지 — 파트너 웹(print-client.tsx)이 수락 직후·재인쇄 시 호출한다.
contextBridge.exposeInMainWorld("norderKitchen", {
  printOrder: (payload) => ipcRenderer.invoke("norder:print-order", payload),
});

const POLL_MS = 2000;
const FETCH_MS = 20_000;          // 주문판 밖에서 신규 주문 확인 간격
const HEALTH_MS = 30_000;         // 서버 연결 확인 간격
const LOGIN_REMIND_MS = 60_000;   // 로그인 풀림 알림 반복 간격
const CHIME_REPEATS = 3;
const BOARD_PATH = "/partner/delivery";
const SEEN_KEY = "norderKitchen.seen"; // 새로고침·화면 이동 뒤에도 이미 알린 주문을 다시 울리지 않도록

let audioCtx = null;

// ── 기준점(이미 본 신규 주문) ────────────────────────────────
function loadSeen() {
  try {
    const v = JSON.parse(sessionStorage.getItem(SEEN_KEY) || "null");
    if (v && typeof v.count === "number") return { count: v.count, ids: new Set(v.ids || []) };
  } catch { /* 없음 */ }
  return null;
}
function saveSeen(s) {
  try { sessionStorage.setItem(SEEN_KEY, JSON.stringify({ count: s.count, ids: [...s.ids].slice(-500) })); } catch { /* */ }
}

// ── 신규 주문 읽기 ───────────────────────────────────────────
// 웹이 그리는 «센터 탭과 무관한 전체 신규 수»(pn-new-total)를 먼저 읽고, 없으면(옛 서버) 신규 탭 숫자로.
function readSnapshot(doc) {
  const total = doc.querySelector('[data-testid="pn-new-total"]')?.getAttribute("data-count");
  if (total != null && /^\d+$/.test(total)) return { count: Number(total), ids: null };
  const el = doc.querySelector('[data-testid="pn-dlv-tab-new"]');
  if (!el) return null;
  const m = /\((\d+)\)/.exec(el.textContent || "");
  if (!m) return null;
  return { count: Number(m[1]), ids: null };
}
function readCardIds(doc) {
  return [...doc.querySelectorAll('[data-testid^="pn-dlv-card-"]')]
    .map((c) => c.getAttribute("data-testid").slice("pn-dlv-card-".length));
}
// 주문판에서 화면 숫자가 매장 전체 신규 수인 경우만 화면을 읽는다 — pn-new-total 이 있거나 «전체 센터» 보기.
// (옛 서버에서 센터 탭을 고르면 탭 숫자가 그 센터 것만 세므로 전체 수를 따로 받는다)
function onBoardAll() {
  if (location.pathname !== BOARD_PATH) return false;
  if (document.querySelector('[data-testid="pn-new-total"]')) return true;
  return !new URLSearchParams(location.search).get("inst");
}
function readFromPage() {
  const snap = readSnapshot(document);
  if (!snap) return null;
  const q = new URLSearchParams(location.search);
  const tab = q.get("tab");
  // 카드 id 는 «전체 센터 · 신규 탭»일 때만 신규 주문 전체와 같다
  if ((!tab || tab === "new") && !q.get("inst")) snap.ids = readCardIds(document);
  return snap;
}

let lastFetch = 0;
let fetched = null; // { snap } | { loggedOut: true } | null
async function fetchSnapshot() {
  lastFetch = Date.now();
  try {
    const api = await fetch("/api/partner/pending-count", { credentials: "same-origin", cache: "no-store" });
    if (api.status === 401) { fetched = { loggedOut: true }; return; }
    if (api.ok && (api.headers.get("content-type") || "").includes("application/json")) {
      const j = await api.json();
      if (Array.isArray(j.ids)) { fetched = { snap: { count: Number(j.count) || 0, ids: j.ids } }; return; }
    }
  } catch { /* 옛 서버엔 API 가 없다 — 아래 주문판 HTML 로 */ }
  try {
    const res = await fetch(`${BOARD_PATH}?tab=new`, { credentials: "same-origin", cache: "no-store" });
    const path = new URL(res.url).pathname;
    if (path.startsWith("/partner/login")) { fetched = { loggedOut: true }; return; }
    if (!res.ok || path !== BOARD_PATH) { fetched = null; return; }
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const snap = readSnapshot(doc);
    if (snap) snap.ids = readCardIds(doc);
    fetched = snap ? { snap } : null;
  } catch { fetched = null; }
}

// «딩동» 2음 — 본체(board-client.tsx)와 같은 음형, 반복 재생으로 강화
function chime(times) {
  try {
    audioCtx = audioCtx || new AudioContext();
    for (let r = 0; r < times; r++) {
      const base = audioCtx.currentTime + r * 1.2;
      for (const [freq, at] of [[880, 0], [1174.7, 0.18]]) {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.001, base + at);
        gain.gain.exponentialRampToValueAtTime(0.35, base + at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, base + at + 0.5);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(base + at);
        osc.stop(base + at + 0.55);
      }
    }
  } catch { /* 오디오 미지원 — 팝업만 */ }
}

function dismissOverlay() {
  document.getElementById("norder-desktop-alert")?.remove();
  ipcRenderer.send("norder:alert-ack");
}

function showOverlay(count, isTest) {
  dismissOverlay();
  const el = document.createElement("div");
  el.id = "norder-desktop-alert";
  el.setAttribute("data-testid", "desktop-alert");
  el.style.cssText = [
    "position:fixed", "inset:0", "z-index:2147483647",
    "background:rgba(20,20,28,.55)", "display:flex", "align-items:center", "justify-content:center",
    "cursor:pointer",
  ].join(";");
  el.innerHTML = `
    <div style="background:#FF0065;color:#fff;border-radius:20px;padding:40px 56px;text-align:center;
                box-shadow:0 12px 48px rgba(0,0,0,.35);max-width:80%;">
      <div style="font-size:56px;line-height:1">🔔</div>
      <div style="font-size:34px;font-weight:800;margin-top:12px;word-break:keep-all;">
        ${isTest ? "알림 테스트" : `신규 주문 ${count}건`}
      </div>
      <div style="font-size:18px;margin-top:10px;opacity:.92;word-break:keep-all;">
        ${isTest ? "소리·팝업이 정상 동작합니다. 화면을 누르면 닫힙니다." : "수락 마감 전에 확인해 주세요. 화면을 누르면 주문판으로 이동합니다."}
      </div>
    </div>`;
  el.addEventListener("click", () => {
    dismissOverlay();
    if (!isTest) location.href = "/partner/delivery?tab=new";
  });
  document.body.appendChild(el);
  setTimeout(() => { if (document.getElementById("norder-desktop-alert") === el) dismissOverlay(); }, 60_000);
}

function alarm(count, isTest = false) {
  chime(CHIME_REPEATS);
  showOverlay(count, isTest);
  if (!isTest) ipcRenderer.send("norder:new-orders", { count });
}

ipcRenderer.on("norder:test-alarm", () => alarm(0, true));

// ── 상단 상태 띠(로그인 풀림·연결 끊김) — 로그인 입력칸을 가리지 않게 위쪽 띠로만 ─────
function setStatusBar(kind, title, body) {
  let el = document.getElementById("norder-desktop-status");
  if (!kind) { el?.remove(); return; }
  if (!document.body) return;
  if (!el) {
    el = document.createElement("div");
    el.id = "norder-desktop-status";
    el.style.cssText = [
      "position:fixed", "top:0", "left:0", "right:0", "z-index:2147483646",
      "padding:14px 20px", "color:#fff", "font:600 17px/1.4 -apple-system,'Malgun Gothic',sans-serif",
      "text-align:center", "word-break:keep-all", "box-shadow:0 4px 16px rgba(0,0,0,.25)",
    ].join(";");
    document.body.appendChild(el);
  }
  el.setAttribute("data-testid", `desktop-status-${kind}`);
  el.style.background = kind === "logged-out" ? "#C81E3C" : "#3A3A48";
  el.innerHTML = `<div style="font-size:20px;font-weight:800">${title}</div><div style="font-weight:500;opacity:.95">${body}</div>`;
}

// ── 로그인 풀림(세션 12시간 만료·로그아웃·비번 변경) ───────────
let lastLoginAlert = 0;
async function onLoggedOut() {
  if (Date.now() - lastLoginAlert < LOGIN_REMIND_MS) return;
  lastLoginAlert = Date.now();
  let alert = false;
  try { ({ alert } = await ipcRenderer.invoke("norder:logged-out")); } catch { /* */ }
  if (!alert) return; // 처음 설치·메뉴에서 직접 로그아웃한 경우엔 조용히
  chime(CHIME_REPEATS);
  setStatusBar("logged-out", "로그인이 풀렸어요 — 다시 로그인해야 주문을 받아요",
    "로그인할 때까지 새 주문 알림과 자동 인쇄가 멈춰요.");
}
let reportedIn = false;
function onLoggedIn() {
  lastLoginAlert = 0;
  if (document.querySelector('[data-testid="desktop-status-logged-out"]')) setStatusBar(null);
  if (!reportedIn) { reportedIn = true; ipcRenderer.send("norder:logged-in"); }
}

// ── 연결 끊김(인터넷·서버) ───────────────────────────────────
let healthFails = 0;
let lastHealth = 0;
function showDisconnected() {
  setStatusBar("offline", "서버에 연결할 수 없어요 — 새 주문을 받을 수 없어요",
    "인터넷 연결을 확인해 주세요. 다시 연결되면 화면을 자동으로 새로 불러와요.");
}
async function checkHealth() {
  lastHealth = Date.now();
  let up = navigator.onLine;
  if (up) {
    try { up = (await fetch("/favicon.ico", { method: "HEAD", cache: "no-store" })).status < 500; } catch { up = false; }
  }
  if (up) {
    if (healthFails >= 2) {
      // 주문판은 옛 화면이 남아 있으니 새로 불러오고, 입력 중일 수 있는 다른 화면은 띠만 걷는다
      if (location.pathname === BOARD_PATH) { location.reload(); return; }
      setStatusBar(null);
    }
    healthFails = 0;
  } else {
    healthFails++;
    if (healthFails >= 2) showDisconnected();
  }
}

if (/^https?:$/.test(location.protocol)) {
  window.addEventListener("offline", () => { healthFails = 2; showDisconnected(); });
  window.addEventListener("online", () => { if (healthFails >= 2) void checkHealth(); });

  let seen = loadSeen(); // null = 이번 실행에서 아직 기준점 없음 → 첫 확인에 신규가 있으면 한 번 울린다

  setInterval(() => {
    if (location.pathname.startsWith("/partner/login")) { void onLoggedOut(); return; }
    if (Date.now() - lastHealth >= HEALTH_MS) void checkHealth();

    let snap = null;
    if (onBoardAll()) snap = readFromPage();
    else {
      if (Date.now() - lastFetch >= FETCH_MS) void fetchSnapshot();
      if (fetched?.loggedOut) { void onLoggedOut(); return; }
      snap = fetched?.snap ?? null;
      fetched = null; // 한 번 읽은 결과는 다음 fetch 까지 재사용하지 않는다
    }
    if (!snap) return;
    onLoggedIn();

    // 못 본 주문 id 가 있으면 알림(수락 1건 + 새 주문 1건이 겹쳐 수가 같아도 잡힌다). id 를 못 읽는 화면은 수 증가로.
    let fresh;
    if (snap.ids) fresh = seen ? snap.ids.some((id) => !seen.ids.has(id)) : snap.count > 0;
    else fresh = seen ? snap.count > seen.count : snap.count > 0;
    if (fresh) alarm(snap.count);
    const ids = new Set(seen?.ids ?? []);
    for (const id of snap.ids ?? []) ids.add(id);
    seen = { count: snap.count, ids };
    saveSeen(seen);
  }, POLL_MS);
}
