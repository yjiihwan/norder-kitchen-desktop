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

console.log(`\n════ 통과 ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
