// 인쇄 파이프라인 자동 검증 — 실물 프린터 없이:
//  1) 라인 모델 → ESC/POS 버퍼 → 미니 에뮬레이터 복원 → 원문 일치(CP949 라운드트립)
//  2) U+FFFD(인코딩 깨짐) 부재  3) 열 폭 초과 부재(확대체는 cols/2)
// 실행: node tools/verify_print.cjs
const { buildReceiptLines, kvText } = require("../src/receipt");
const { buildEscpos, emulate } = require("../src/escpos");
const sampleOrder = require("../src/sample-order");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

const dw = (s) => [...s].reduce((a, ch) => a + (ch.codePointAt(0) <= 0x7f ? 1 : 2), 0);

for (const [label, cols, widthMm] of [["80mm", 48, 80], ["58mm", 32, 58]]) {
  console.log(`\n═ ${label} (${cols}칸)`);
  const payload = sampleOrder({ reprint: false });
  const lines = buildReceiptLines(payload, cols);
  const buf = buildEscpos(lines, { cols });
  const { lines: decoded } = emulate(buf, cols);

  // 컷 명령·초기화 존재
  ok("ESC @ 초기화로 시작", buf[0] === 0x1b && buf[1] === 0x40);
  ok("FS & 한글 모드 포함", buf.includes(0x1c) && buf[3] === 0x26);
  ok("GS V 부분컷으로 종료", buf[buf.length - 4] === 0x1d && buf[buf.length - 3] === 0x56);

  // 라운드트립: 텍스트 라인(피드 제외) 원문 일치
  const srcTexts = [];
  for (const l of lines) {
    if (l.hr) srcTexts.push("-".repeat(cols));
    else if (l.feed) { for (let k = 0; k < l.feed; k++) srcTexts.push(""); }
    else if (l.kvLeft != null) srcTexts.push(kvText(l, cols));
    else srcTexts.push(String(l.text ?? ""));
  }
  const decTexts = decoded.map((l) => l.text);
  ok(`라인 수 일치 (${srcTexts.length})`, srcTexts.length === decTexts.length,
    `src=${srcTexts.length} dec=${decTexts.length}`);
  let mismatch = -1;
  for (let i = 0; i < Math.min(srcTexts.length, decTexts.length); i++) {
    if (srcTexts[i] !== decTexts[i]) { mismatch = i; break; }
  }
  ok("CP949 라운드트립 전 라인 원문 일치", mismatch === -1,
    mismatch >= 0 ? `#${mismatch}: "${srcTexts[mismatch]}" ≠ "${decTexts[mismatch]}"` : "");
  ok("U+FFFD(깨진 문자) 없음", !decTexts.some((t) => t.includes("�")));

  // 폭 검사
  const over = [];
  decoded.forEach((l, i) => {
    const limit = l.size === 2 ? Math.floor(cols / 2) : cols;
    if (dw(l.text) > limit) over.push(`#${i}(${dw(l.text)}>${limit}): ${l.text}`);
  });
  ok("열 폭 초과 라인 없음", over.length === 0, over.join(" | "));

  // 핵심 내용 포함 검사
  const all = decTexts.join("\n");
  for (const must of ["N오더 주문서", payload.orderNo, payload.pickupCode, "얼큰순두부찌개",
    "프로틴 닭가슴살", "덜 맵게", payload.centerName, "32,000원", "결제금액", "테스트(staging)"]) {
    ok(`내용 포함: ${must}`, all.includes(must));
  }
}

// 재인쇄 표기
{
  const lines = buildReceiptLines(sampleOrder({ reprint: true }), 48);
  ok("\n재인쇄 표기 «(재인쇄)» 포함", lines.some((l) => l.text === "(재인쇄)"));
}

// CP949 밖 문자(이모지 등) — 폭 계산은 2칸, 인코딩은 대체문자로 안전 강등되는지
{
  const { buildEscpos: be, emulate: em } = require("../src/escpos");
  const buf = be([{ text: "이모지🔥테스트" }], { cols: 48 });
  const dec = em(buf).lines[0].text;
  ok("CP949 밖 문자는 '?' 강등(크래시 없음)", dec.includes("이모지") && dec.includes("테스트"));
}

// ── 래스터(이미지 인쇄 — 전 기종 호환 기본 경로) ─────────────
{
  console.log("\n═ 래스터(GS v 0) — 이미지 인쇄");
  const { buildEscposRaster, emulateRaster, RASTER_BAND_ROWS } = require("../src/escpos");

  // 합성 비트맵(결정적 패턴, 3밴드 걸치는 높이) → 빌드 → 역파싱 → 비트 단위 일치
  const rowBytes = 72, height = 600; // 576 도트 × 600줄
  const data = Buffer.alloc(rowBytes * height);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37 + ((i >> 5) * 11)) & 0xff;
  const buf = buildEscposRaster({ widthDots: 576, height, rowBytes, data });
  const r = emulateRaster(buf);

  ok("ESC @ 초기화 포함", r.init);
  ok("GS V 부분컷 포함", r.cut);
  ok("도트폭 복원 576", r.widthDots === 576, `got ${r.widthDots}`);
  ok(`높이 복원 ${height}`, r.height === height, `got ${r.height}`);
  ok("픽셀 데이터 비트 단위 일치", r.data.equals(data));

  // 밴드 분할 — 저가 기종 수신 버퍼 대비
  let bands = 0;
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0x1d && buf[i + 1] === 0x76 && buf[i + 2] === 0x30) bands++;
  }
  const expectBands = Math.ceil(height / RASTER_BAND_ROWS);
  ok(`밴드 분할 ${expectBands}개 (${RASTER_BAND_ROWS}줄 단위)`, bands === expectBands, `got ${bands}`);

  // 한글·코드페이지 명령 부재 — 래스터 경로는 펌웨어 의존 명령이 없어야 기종 무관
  let fsAmp = false, escT = false;
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 0x1c && buf[i + 1] === 0x26) fsAmp = true;
    if (buf[i] === 0x1b && buf[i + 1] === 0x74) escT = true;
  }
  ok("FS &(한글 모드)·ESC t(코드페이지) 명령 없음", !fsAmp && !escT);

  // 크기 불일치 방어
  let threw = false;
  try { buildEscposRaster({ widthDots: 576, height: 10, rowBytes: 72, data: Buffer.alloc(5) }); }
  catch { threw = true; }
  ok("래스터 크기 불일치 시 예외", threw);

  // 58mm 도트폭
  const buf58 = buildEscposRaster({ widthDots: 384, height: 8, rowBytes: 48, data: Buffer.alloc(48 * 8, 0xaa) });
  ok("58mm 도트폭 복원 384", emulateRaster(buf58).widthDots === 384);
}

// ── 기본값·설정 UI — 기종 호환(이미지 인쇄)이 기본이어야 한다 ──
{
  console.log("\n═ 기본값·설정 UI");
  const { DEFAULT_PRINTER } = require("../src/printing"); // electron 미기동이어도 상수는 안전
  ok("기본 인쇄 방식 = raster(전 기종 호환)", DEFAULT_PRINTER.escposOutput === "raster");
  const htmlSrc = require("fs").readFileSync(require("path").join(__dirname, "../src/printer-settings.html"), "utf8");
  ok("설정창에 이미지/텍스트 선택 존재", htmlSrc.includes('name=escposOutput') || htmlSrc.includes('name="escposOutput"'));
  ok("설정창 저장 폼에 escposOutput 포함", htmlSrc.includes("escposOutput:"));
}

console.log(`\n════ 통과 ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
