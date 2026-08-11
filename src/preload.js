// 신규 주문 감시 — P-7 «신규 (N)» 탭 카운트를 2초마다 읽어 증가 시 알림.
// 페이지 자체가 15초 폴링(router.refresh)으로 갱신되므로 서버 API 를 따로 때리지 않는다.
const { contextBridge, ipcRenderer } = require("electron");

// 주방프린터 브릿지 — 파트너 웹(print-client.tsx)이 수락 직후·재인쇄 시 호출한다.
contextBridge.exposeInMainWorld("norderKitchen", {
  printOrder: (payload) => ipcRenderer.invoke("norder:print-order", payload),
});

const POLL_MS = 2000;
const CHIME_REPEATS = 3;

let prev = null;
let audioCtx = null;

function readNewCount() {
  const el = document.querySelector('[data-testid="pn-dlv-tab-new"]');
  if (!el) return null;
  const m = /\((\d+)\)/.exec(el.textContent || "");
  return m ? Number(m[1]) : null;
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

setInterval(() => {
  const count = readNewCount();
  if (count === null) { prev = null; return; } // 로그인 화면 등 — 기준점 리셋
  if (prev !== null && count > prev) alarm(count);
  prev = count;
}, POLL_MS);
