// 주문서(영수증) 레이아웃 — ESC/POS·HTML 미리보기·OS 인쇄가 같은 라인 모델을 쓴다.
// 폭: 80mm=48칸 / 58mm=32칸 (Font A 기준, 한글=2칸).

/** CP949 기준 표시 폭 — ASCII 1칸, 그 외(한글 등) 2칸. 열 폭 == CP949 바이트 수. */
function dw(str) {
  let w = 0;
  for (const ch of str) w += ch.codePointAt(0) <= 0x7f ? 1 : 2;
  return w;
}

function padEnd(str, width) {
  const gap = width - dw(str);
  return gap > 0 ? str + " ".repeat(gap) : str;
}

/**
 * kv 라인({ kvLeft, kvRight }) → ESC/POS·에뮬레이터용 공백 패딩 문자열.
 * HTML 렌더는 비례폭 폰트라 패딩 대신 flex 양끝 정렬을 쓴다(renderReceiptHtml).
 */
function kvText(l, cols) {
  const eff = l.size === 2 ? Math.floor(cols / 2) : cols;
  const gap = eff - dw(l.kvLeft) - dw(l.kvRight);
  return l.kvLeft + " ".repeat(Math.max(1, gap)) + l.kvRight;
}

/** 표시 폭 기준 줄바꿈 — 한글 중간에서도 칸 수로 자른다(단어 경계 우선). */
function wrap(text, cols) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    let line = "";
    for (const word of raw.split(" ")) {
      const cand = line === "" ? word : `${line} ${word}`;
      if (dw(cand) <= cols) { line = cand; continue; }
      if (line !== "") { out.push(line); line = ""; }
      let chunk = "";
      for (const ch of word) {
        if (dw(chunk + ch) > cols) { out.push(chunk); chunk = ch; }
        else chunk += ch;
      }
      line = chunk;
    }
    out.push(line);
  }
  return out;
}

const won = (n) => `${Number(n).toLocaleString("ko-KR")}원`;

/** pg timestamptz ::text ("2026-08-11 03:12:45.123+00") → KST "2026-08-11 12:12" */
function fmtKst(pgText) {
  if (!pgText) return null;
  let iso = String(pgText).replace(" ", "T");
  if (/[+-]\d{2}$/.test(iso)) iso += ":00";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(pgText);
  const p = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d).reduce((a, x) => ((a[x.type] = x.value), a), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/**
 * 인쇄 전표 payload(/api/partner/print/[orderId]) → 라인 모델.
 * line: { text, align?, bold?, size? (1|2), hr?, feed? }
 */
function buildReceiptLines(payload, cols) {
  const L = [];
  const text = (t, opt = {}) => L.push({ text: t, ...opt });
  const hr = () => L.push({ hr: true });
  // 좌·우 양끝 정렬 — 한 줄에 안 들어가면 두 줄(우측은 오른쪽 정렬)로 나눈다
  const kvLines = (l, r, opt = {}) => {
    const eff = opt.size === 2 ? Math.floor(cols / 2) : cols;
    if (dw(l) + dw(r) + 1 <= eff) L.push({ kvLeft: l, kvRight: r, ...opt });
    else { text(l, opt); text(r, { ...opt, align: "right" }); }
  };

  text("N오더 주문서", { align: "center", bold: true, size: 2 });
  if (payload.reprint) text("(재인쇄)", { align: "center" });
  if (payload.staging) text("* 테스트(staging) 주문 *", { align: "center" });
  hr();

  // 주문번호·픽업코드 — 주방/센터 식별의 핵심이라 확대체
  text(`주문번호 ${payload.orderNo}`, { bold: true });
  text(`픽업코드 ${payload.pickupCode}`, { bold: true, size: 2 });
  hr();

  const ordered = fmtKst(payload.orderedAt);
  const accepted = fmtKst(payload.acceptedAt);
  const eta = fmtKst(payload.etaAt);
  if (ordered) kvLines("주문시각", ordered);
  if (accepted) kvLines("수락시각", accepted);
  if (payload.estMinutes) kvLines("예상소요", `${payload.estMinutes}분`);
  if (eta) kvLines("도착예정", eta, { bold: true });
  hr();

  // 메뉴 — 이름 줄 + «수량 x 단가 / 줄 금액» 줄 (옵션 개념은 데이터 모델에 없음)
  text("메뉴", { bold: true });
  for (const it of payload.items || []) {
    for (const l of wrap(it.name, cols)) text(l, { bold: true });
    kvLines(`  ${it.qty} x ${won(it.unitPriceKrw)}`, won(it.lineAmountKrw));
  }
  if (!payload.items || payload.items.length === 0) text("(품목 정보 없음)");
  hr();

  if (payload.customerMemo) {
    text("고객 요청사항", { bold: true });
    for (const l of wrap(payload.customerMemo, cols)) text(l, { bold: true, size: cols >= 48 ? 1 : 1 });
    hr();
  }

  text("배달 목적지(센터)", { bold: true });
  text(payload.centerName || "-");
  if (payload.centerAddress) for (const l of wrap(payload.centerAddress, cols)) text(l);
  if (payload.centerPhone) kvLines("센터 연락처", payload.centerPhone);
  for (const l of wrap("* 고객 전달은 센터 인포데스크에서 픽업코드로", cols)) text(l);
  hr();

  const a = payload.amounts || {};
  kvLines("상품금액", won(a.itemsKrw ?? 0));
  if (Number(a.discountKrw) > 0) kvLines("할인", `-${won(a.discountKrw)}`);
  if (Number(a.deliveryFeeKrw) > 0) kvLines("배달비", won(a.deliveryFeeKrw));
  kvLines("결제금액", won(a.totalKrw ?? 0), { bold: true, size: 2 });
  hr();

  const shop = [payload.restaurantName, payload.branchLabel].filter(Boolean).join(" ");
  if (shop) text(shop, { align: "center" });
  if (ordered) text(`인쇄 ${fmtKst(new Date().toISOString())}`, { align: "center" });
  L.push({ feed: 3 });
  return L;
}

/**
 * 미리보기·OS 인쇄·래스터 공용 HTML — 감열지 느낌의 고정폭 렌더. widthMm: 58|80
 * opts.pxWidth: 지정 시 body 를 정확히 그 픽셀 폭으로(래스터 인쇄용 — 203dpi 도트폭에 맞춰
 * 폰트·여백을 비례 확대해 렌더 → 캡처 픽셀 == 프린터 도트 1:1).
 */
function renderReceiptHtml(lines, widthMm, opts = {}) {
  const basePx = (widthMm / 25.4) * 96; // CSS mm 폭의 px 환산(96dpi)
  const k = opts.pxWidth ? opts.pxWidth / basePx : 1;
  const px = (n) => `${Math.round(n * k * 10) / 10}px`;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = lines.map((l) => {
    if (l.hr) return `<div class="hr"></div>`;
    if (l.feed) return `<div style="height:${Math.round(l.feed * 8 * k)}px"></div>`;
    const cls = [
      l.align === "center" ? "c" : l.align === "right" ? "r" : "",
      l.bold ? "b" : "",
      l.size === 2 ? "x2" : "",
    ].filter(Boolean).join(" ");
    if (l.kvLeft != null) {
      return `<div class="ln kv ${cls}"><span>${esc(l.kvLeft)}</span><span>${esc(l.kvRight)}</span></div>`;
    }
    return `<div class="ln ${cls}">${esc(l.text) || "&nbsp;"}</div>`;
  }).join("\n");
  const padV = (4 / 25.4) * 96, padH = (3 / 25.4) * 96; // 4mm 3mm 의 px 환산
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${widthMm}mm auto; margin: 0; }
    html, body { margin: 0; padding: 0; background: #fff; }
    body { width: ${opts.pxWidth ? `${opts.pxWidth}px` : `${widthMm}mm`}; }
    .paper { padding: ${px(padV)} ${px(padH)}; font-family: "AppleSDGothicNeo", "Malgun Gothic", monospace;
             font-size: ${px(widthMm >= 80 ? 12 : 11)}; line-height: 1.45; color: #000; }
    .ln { white-space: pre-wrap; word-break: break-all; }
    .kv { display: flex; justify-content: space-between; gap: ${px(8)}; }
    .kv span:last-child { white-space: nowrap; }
    .c { text-align: center; } .r { text-align: right; } .b { font-weight: 700; }
    .x2 { font-size: ${px(widthMm >= 80 ? 22 : 18)}; font-weight: 700; }
    .hr { border-top: ${Math.max(1, Math.round(k))}px dashed #000; margin: ${px(4)} 0; }
  </style></head><body><div class="paper">${body}</div></body></html>`;
}

module.exports = { buildReceiptLines, renderReceiptHtml, dw, wrap, kvText, fmtKst, won };
