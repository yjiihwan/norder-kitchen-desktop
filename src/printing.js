// 인쇄 디스패처(메인 프로세스) — 설정에 따라 네트워크(9100)/OS 프린터 큐 RAW(USB)/OS 기본 인쇄/미리보기.
// 실물이 없어도 검증 가능하도록 «미리보기» 모드는 전표를 PNG로 렌더해 연다.
const { BrowserWindow, shell, app } = require("electron");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { buildReceiptLines, renderReceiptHtml } = require("./receipt");
const { buildEscpos } = require("./escpos");

const DEFAULT_PRINTER = {
  mode: "preview",          // preview | network | usbraw | system | off
  ip: "", port: 9100,       // network
  osPrinterName: "",        // usbraw(윈도우 프린터 큐 이름) · system(장치 이름)
  widthMm: 80,              // 80 | 58
  autoPrint: true,          // 수락 시 자동 인쇄
};

const colsOf = (widthMm) => (Number(widthMm) === 58 ? 32 : 48);

// ── 네트워크 ESC/POS (IP:9100) ───────────────────────────────
function sendToNetwork(buf, ip, port) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: ip, port: Number(port) || 9100, timeout: 5000 });
    sock.on("connect", () => sock.end(buf));
    sock.on("close", () => resolve());
    sock.on("timeout", () => { sock.destroy(); reject(new Error(`프린터 연결 시간 초과 (${ip}:${port})`)); });
    sock.on("error", (e) => reject(new Error(`프린터 연결 실패 (${ip}:${port}) — ${e.message}`)));
  });
}

// ── OS 프린터 큐 RAW (USB — 드라이버로 설치된 큐에 ESC/POS 바이트 그대로) ──
// 윈도우: winspool RawPrinterHelper(P/Invoke) 파워셸 스크립트를 임시 폴더에 풀어 실행.
const WIN_RAW_PS = `
param([string]$PrinterName, [string]$FilePath)
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.IO;
using System.Runtime.InteropServices;
public class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
  public static void Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("OpenPrinter 실패: " + printer);
    try {
      var di = new DOCINFOA { pDocName = "NOrder Receipt", pDataType = "RAW" };
      if (!StartDocPrinter(h, 1, di)) throw new Exception("StartDocPrinter 실패");
      StartPagePrinter(h);
      IntPtr p = Marshal.AllocHGlobal(bytes.Length);
      Marshal.Copy(bytes, 0, p, bytes.Length);
      int written;
      bool ok = WritePrinter(h, p, bytes.Length, out written);
      Marshal.FreeHGlobal(p);
      EndPagePrinter(h);
      EndDocPrinter(h);
      if (!ok) throw new Exception("WritePrinter 실패");
    } finally { ClosePrinter(h); }
  }
}
"@
$bytes = [System.IO.File]::ReadAllBytes($FilePath)
[RawPrinter]::Send($PrinterName, $bytes)
`;

function sendToOsQueueRaw(buf, printerName) {
  return new Promise((resolve, reject) => {
    const tmpRaw = path.join(os.tmpdir(), `norder-raw-${Date.now()}.bin`);
    fs.writeFileSync(tmpRaw, buf);
    const done = (err) => { try { fs.unlinkSync(tmpRaw); } catch { /* 임시파일 잔존 무해 */ } err ? reject(err) : resolve(); };
    if (process.platform === "win32") {
      const tmpPs = path.join(os.tmpdir(), `norder-rawprint-${Date.now()}.ps1`);
      fs.writeFileSync(tmpPs, WIN_RAW_PS, "utf8");
      execFile("powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmpPs, "-PrinterName", printerName, "-FilePath", tmpRaw],
        { windowsHide: true, timeout: 20000 },
        (err, _out, stderr) => {
          try { fs.unlinkSync(tmpPs); } catch { /* 무해 */ }
          done(err ? new Error(`RAW 인쇄 실패(${printerName}) — ${String(stderr || err.message).slice(0, 200)}`) : null);
        });
    } else {
      // macOS/리눅스 — CUPS 큐로 raw 전송 (테스트용)
      execFile("lp", ["-d", printerName, "-o", "raw", tmpRaw], { timeout: 20000 },
        (err, _out, stderr) => done(err ? new Error(`lp raw 인쇄 실패(${printerName}) — ${String(stderr || err.message).slice(0, 200)}`) : null));
    }
  });
}

// ── OS 기본 인쇄 폴백 (드라이버 렌더링 — ESC/POS 미지원 프린터용) ──
function printViaSystem(html, widthMm, deviceName) {
  return new Promise((resolve, reject) => {
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    const finish = (err) => { try { w.destroy(); } catch { /* 이미 닫힘 */ } err ? reject(err) : resolve(); };
    w.webContents.once("did-finish-load", () => {
      w.webContents.print({
        silent: true,
        deviceName: deviceName || undefined,
        margins: { marginType: "none" },
        pageSize: { width: widthMm * 1000, height: 297000 }, // 마이크론 단위 — 높이는 넉넉히
      }, (ok, reason) => finish(ok ? null : new Error(`OS 인쇄 실패 — ${reason || "알 수 없음"}`)));
    });
    w.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    setTimeout(() => finish(new Error("OS 인쇄 시간 초과")), 30000);
  });
}

// ── 미리보기 (실물 없이 검증 — PNG 렌더 후 열기) ──────────────
function renderPreviewPng(html, widthMm, outPath) {
  return new Promise((resolve, reject) => {
    const pxWidth = Math.round((widthMm / 25.4) * 96) + 2;
    const w = new BrowserWindow({
      show: false, width: pxWidth, height: 1200,
      webPreferences: { sandbox: true, offscreen: true },
    });
    const fail = (e) => { try { w.destroy(); } catch { /* */ } reject(e); };
    w.webContents.once("did-finish-load", async () => {
      try {
        const h = await w.webContents.executeJavaScript("document.body.scrollHeight");
        w.setSize(pxWidth, Math.min(Math.max(h + 8, 200), 6000));
        await new Promise((r) => setTimeout(r, 250)); // 오프스크린 리페인트 대기
        const img = await w.webContents.capturePage();
        fs.writeFileSync(outPath, img.toPNG());
        try { w.destroy(); } catch { /* */ }
        resolve(outPath);
      } catch (e) { fail(e); }
    });
    w.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    setTimeout(() => fail(new Error("미리보기 렌더 시간 초과")), 20000);
  });
}

// ── 진입점 ───────────────────────────────────────────────────
const printedOnce = new Set(); // 자동 인쇄 중복 방지(세션 내) — 재인쇄는 통과

async function printOrder(payload, printer, opts = {}) {
  const p = { ...DEFAULT_PRINTER, ...printer };
  if (p.mode === "off") return { ok: false, error: "인쇄가 꺼져 있어요 (설정 > 프린터 설정)" };
  if (!payload || payload.kind !== "norder-delivery-receipt") {
    return { ok: false, error: "전표 데이터 형식이 올바르지 않아요" };
  }
  if (!payload.reprint && payload.orderId && printedOnce.has(payload.orderId)) {
    return { ok: true, skipped: "duplicate" };
  }
  if (!payload.reprint && !p.autoPrint && !opts.force) return { ok: true, skipped: "autoPrint-off" };

  const cols = colsOf(p.widthMm);
  const lines = buildReceiptLines(payload, cols);
  try {
    if (p.mode === "network") {
      if (!p.ip) return { ok: false, error: "프린터 IP가 설정되지 않았어요" };
      await sendToNetwork(buildEscpos(lines, { cols }), p.ip, p.port);
    } else if (p.mode === "usbraw") {
      if (!p.osPrinterName) return { ok: false, error: "프린터(큐 이름)가 선택되지 않았어요" };
      await sendToOsQueueRaw(buildEscpos(lines, { cols }), p.osPrinterName);
    } else if (p.mode === "system") {
      await printViaSystem(renderReceiptHtml(lines, p.widthMm), p.widthMm, p.osPrinterName);
    } else { // preview
      const dir = path.join(app.getPath("userData"), "print-previews");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `receipt-${(payload.orderNo || "test").replace(/[^\w-]/g, "_")}-${Date.now()}.png`);
      await renderPreviewPng(renderReceiptHtml(lines, p.widthMm), p.widthMm, file);
      if (!opts.silentPreview) shell.openPath(file);
      if (!payload.reprint && payload.orderId) printedOnce.add(payload.orderId);
      return { ok: true, previewFile: file };
    }
    if (!payload.reprint && payload.orderId) printedOnce.add(payload.orderId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { printOrder, DEFAULT_PRINTER, colsOf, renderPreviewPng };
