// ESC/POS 명령 빌더 — 라인 모델(receipt.js) → 감열 프린터용 바이트 버퍼.
// 한글: CP949(EUC-KR 확장) 2바이트 인코딩 + FS & (한글/한자 모드) — 국내 감열 프린터 표준.
const iconv = require("iconv-lite");
const { kvText } = require("./receipt");

const ESC = 0x1b, GS = 0x1d, FS = 0x1c, LF = 0x0a;

function buildEscpos(lines, opts = {}) {
  const cols = opts.cols || 48; // 80mm=48, 58mm=32
  const chunks = [];
  const push = (...bytes) => chunks.push(Buffer.from(bytes));

  push(ESC, 0x40);        // 초기화
  push(FS, 0x26);         // 한글 2바이트 모드 켜기
  push(ESC, 0x74, 0x00);  // 코드페이지 기본(한글 모델은 CP949 내장)

  for (const l of lines) {
    if (l.hr) {
      push(ESC, 0x61, 0x00); // 왼쪽 정렬
      push(ESC, 0x45, 0x00); // 강조 해제
      push(GS, 0x21, 0x00);  // 확대 해제 — 직전 확대체가 남아 구분선이 넘치는 것 방지
      chunks.push(iconv.encode("-".repeat(cols), "cp949"));
      push(LF);
      continue;
    }
    if (l.feed) { push(ESC, 0x64, l.feed); continue; }

    push(ESC, 0x61, l.align === "center" ? 0x01 : l.align === "right" ? 0x02 : 0x00);
    push(ESC, 0x45, l.bold ? 0x01 : 0x00);
    push(GS, 0x21, l.size === 2 ? 0x11 : 0x00); // 가로·세로 2배 | 기본
    const raw = l.kvLeft != null ? kvText(l, cols) : String(l.text ?? "");
    chunks.push(iconv.encode(raw, "cp949"));
    push(LF);
  }

  push(GS, 0x21, 0x00);
  push(ESC, 0x45, 0x00);
  push(GS, 0x56, 0x42, 0x00); // 용지 이송 후 부분 컷
  return Buffer.concat(chunks);
}

/**
 * 미니 에뮬레이터 — 우리가 만든 버퍼를 다시 파싱해 «프린터가 찍을 텍스트»를 복원한다.
 * 실물 프린터 없이 CP949 인코딩·정렬·확대를 육안 검증하는 용도(검증 게이트).
 */
function emulate(buf, cols = 48) {
  const out = [];
  let i = 0, align = "left", bold = false, size = 1, text = Buffer.alloc(0);
  const flush = () => {
    const decoded = iconv.decode(text, "cp949");
    out.push({ text: decoded, align, bold, size });
    text = Buffer.alloc(0);
  };
  while (i < buf.length) {
    const b = buf[i];
    if (b === ESC) {
      const c = buf[i + 1];
      if (c === 0x40) { i += 2; continue; }
      if (c === 0x61) { align = buf[i + 2] === 1 ? "center" : buf[i + 2] === 2 ? "right" : "left"; i += 3; continue; }
      if (c === 0x45) { bold = buf[i + 2] === 1; i += 3; continue; }
      if (c === 0x64) { for (let k = 0; k < buf[i + 2]; k++) out.push({ text: "", align, bold, size: 1 }); i += 3; continue; }
      if (c === 0x74) { i += 3; continue; }
      i += 2; continue;
    }
    if (b === GS) {
      const c = buf[i + 1];
      if (c === 0x21) { size = buf[i + 2] === 0x11 ? 2 : 1; i += 3; continue; }
      if (c === 0x56) { i += 4; continue; } // 컷
      i += 2; continue;
    }
    if (b === FS) { i += 2; continue; }
    if (b === LF) { flush(); i += 1; continue; }
    // 텍스트 바이트 — 다음 제어문자 전까지 모은다
    let j = i;
    while (j < buf.length && ![ESC, GS, FS, LF].includes(buf[j])) j++;
    text = Buffer.concat([text, buf.slice(i, j)]);
    i = j;
  }
  return { lines: out, cols };
}

module.exports = { buildEscpos, emulate };
