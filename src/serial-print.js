// COM(시리얼) 단자 프린터 직접 인쇄 — 배달앱(쿠팡이츠 등)과 같은 포트를 나눠 쓰는 매장용.
// 포트는 인쇄하는 동안만 열고 끝나면 바로 닫는다(계속 잡고 있으면 배달앱 인쇄가 막힌다).
// 포트가 사용 중이면 짧게 몇 번 다시 시도하고, 그래도 안 되면 쉬운 말로 실패를 돌려준다(재인쇄는 호출 측 흐름).

const FALLBACK_PORTS = ["COM1", "COM2", "COM3", "COM4", "COM5", "COM6"];
const BAUD_RATES = [9600, 19200, 38400, 57600, 115200];
const FLOWS = ["none", "rtscts", "xonxoff", "dsrdtr"];

const DEFAULT_SERIAL = {
  comPath: "",
  comBaud: 9600,
  comDataBits: 8,
  comParity: "none",   // none | even | odd
  comStopBits: 1,      // 1 | 2
  comFlow: "none",     // none | rtscts | xonxoff | dsrdtr
};

const BUSY_TEXT = "다른 프로그램(예: 배달앱)이 프린터를 사용 중입니다. 잠시 뒤 [주문서 재인쇄]를 눌러 주세요.";

// 네이티브 모듈은 COM 방식을 쓸 때만 불러온다 — 로드 실패가 앱 시작·다른 인쇄 방식을 막지 않게.
function loadSerialPort() {
  return require("serialport").SerialPort;
}

function serialOptions(p) {
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  return {
    path: String(p.comPath || ""),
    baudRate: pick(Number(p.comBaud), BAUD_RATES, 9600),
    dataBits: pick(Number(p.comDataBits), [7, 8], 8),
    parity: pick(p.comParity, ["none", "even", "odd"], "none"),
    stopBits: pick(Number(p.comStopBits), [1, 2], 1),
    flow: pick(p.comFlow, FLOWS, "none"),
  };
}

// Windows: «COM2: Access denied» / Unix: «Cannot lock port»·EBUSY — 둘 다 다른 프로그램이 잡고 있다는 뜻.
const isBusyError = (e) => /access denied|cannot lock|resource busy|ebusy|eacces|resource temporarily unavailable/i.test(String(e?.message || e));
const isMissingError = (e) => /file not found|no such file|enoent|not exist/i.test(String(e?.message || e));

function friendlyError(e, path) {
  if (isBusyError(e)) return BUSY_TEXT;
  if (isMissingError(e)) return `${path} 단자를 찾을 수 없어요. 프린터 케이블이 꽂힌 단자 번호(COM)를 확인해 주세요.`;
  return `COM 프린터 인쇄 실패(${path}) — ${String(e?.message || e).slice(0, 160)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openPort(SerialPort, o) {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({
      path: o.path, baudRate: o.baudRate, dataBits: o.dataBits, parity: o.parity, stopBits: o.stopBits,
      rtscts: o.flow === "rtscts", xon: o.flow === "xonxoff", xoff: o.flow === "xonxoff",
      autoOpen: false, lock: true,
    });
    port.open((err) => (err ? reject(err) : resolve(port)));
  });
}

const closePort = (port) => new Promise((resolve) => {
  if (!port?.isOpen) return resolve();
  port.close(() => resolve());
});

// DTR/DSR 흐름제어는 드라이버가 직접 해 주지 않는다 — 프린터가 DSR 을 내리면(버퍼 가득) 올라올 때까지 기다린다.
async function waitDsr(port, deadline) {
  for (;;) {
    let st;
    try { st = await new Promise((res, rej) => port.get((e, s) => (e ? rej(e) : res(s)))); }
    catch { return; } // 신호를 못 읽는 포트(가상 포트 등) — 기다리지 않고 보낸다
    if (st?.dsr) return;
    if (Date.now() > deadline) throw new Error("프린터가 준비되지 않았어요(DSR). 흐름제어 설정을 «없음»으로 바꿔 보세요.");
    await sleep(50);
  }
}

async function writeAll(port, buf, o, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const CHUNK = o.flow === "dsrdtr" ? 256 : buf.length;
  const write = (b) => new Promise((resolve, reject) => {
    port.write(b, (e) => (e ? reject(e) : port.drain((e2) => (e2 ? reject(e2) : resolve()))));
  });
  for (let i = 0; i < buf.length; i += CHUNK) {
    if (o.flow === "dsrdtr") await waitDsr(port, deadline);
    await write(buf.subarray(i, i + CHUNK));
  }
}

// 전송 시간 = 바이트×10비트/속도. 흐름제어로 멈출 수 있으니 두 배 + 여유 5초.
const writeTimeoutOf = (bytes, baud) => Math.ceil((bytes * 10 * 1000) / baud) * 2 + 5000;

/**
 * @param {Buffer} buf ESC/POS 바이트
 * @param {object} printer 설정(com* 필드)
 * @param {{ attempts?: number, retryDelayMs?: number, SerialPort?: any }} [opts] 테스트에서 포트 구현을 주입
 */
async function sendToSerial(buf, printer, opts = {}) {
  const o = serialOptions(printer);
  if (!o.path) throw new Error("COM 단자가 선택되지 않았어요");
  let SerialPort;
  try { SerialPort = opts.SerialPort || loadSerialPort(); }
  catch (e) { throw new Error(`이 컴퓨터에서 COM 단자 인쇄를 준비하지 못했어요 — ${String(e.message).slice(0, 120)}`); }

  const attempts = opts.attempts ?? 6;
  const retryDelayMs = opts.retryDelayMs ?? 700;
  let port = null;
  let tries = 0;
  for (;;) {
    tries++;
    try { port = await openPort(SerialPort, o); break; }
    catch (e) {
      if (!isBusyError(e) || tries >= attempts) {
        const err = new Error(friendlyError(e, o.path));
        err.busy = isBusyError(e);
        err.tries = tries;
        throw err;
      }
      await sleep(retryDelayMs);
    }
  }

  const timeoutMs = writeTimeoutOf(buf.length, o.baudRate);
  let timer;
  try {
    await Promise.race([
      writeAll(port, buf, o, timeoutMs),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(
        `프린터가 응답하지 않아요(${o.path}). 프린터 전원과 통신 속도·흐름제어 설정을 확인해 주세요.`)), timeoutMs); }),
    ]);
  } catch (e) {
    throw new Error(e.message.startsWith("프린터") ? e.message : friendlyError(e, o.path));
  } finally {
    clearTimeout(timer);
    await closePort(port);
  }
  return { tries };
}

/** PC 의 COM 포트 목록. 못 읽으면 COM1~COM6 을 직접 고를 수 있게 돌려준다. */
async function listComPorts(opts = {}) {
  let detected = [];
  let error = null;
  try {
    const SerialPort = opts.SerialPort || loadSerialPort();
    detected = (await SerialPort.list()).map((p) => ({
      path: p.path,
      label: p.friendlyName && !p.friendlyName.includes(p.path) ? `${p.path} — ${p.friendlyName}` : (p.friendlyName || p.path),
    }));
  } catch (e) { error = String(e?.message || e); }
  const have = new Set(detected.map((p) => p.path.toUpperCase()));
  const manual = FALLBACK_PORTS.filter((n) => !have.has(n)).map((n) => ({ path: n, label: n }));
  return { detected, manual, error };
}

module.exports = {
  DEFAULT_SERIAL, BAUD_RATES, FLOWS, BUSY_TEXT, FALLBACK_PORTS,
  sendToSerial, listComPorts, serialOptions, isBusyError, writeTimeoutOf,
};
