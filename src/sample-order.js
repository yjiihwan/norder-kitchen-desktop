// 테스트 인쇄·미리보기용 샘플 전표 — 실제 API payload(/api/partner/print)와 동일 형태.
module.exports = function sampleOrder(overrides = {}) {
  const now = new Date();
  const iso = (d) => d.toISOString();
  return {
    kind: "norder-delivery-receipt",
    v: 1,
    staging: true,
    orderId: null, // 중복 방지 대상 아님
    orderNo: "20260811-TEST-0001",
    status: "ACCEPTED",
    pickupCode: "4821",
    orderedAt: iso(new Date(now.getTime() - 3 * 60000)),
    acceptedAt: iso(now),
    estMinutes: 30,
    etaAt: iso(new Date(now.getTime() + 30 * 60000)),
    centerName: "엔짐 피트니스 강남점",
    centerAddress: "서울특별시 강남구 테헤란로 123, 4층 (역삼동)",
    centerPhone: "02-1234-5678",
    restaurantName: "한상차림",
    branchLabel: "역삼점",
    customerMemo: "덜 맵게 부탁드려요! 수저는 2개 주세요.",
    items: [
      { name: "얼큰순두부찌개 정식", qty: 2, unitPriceKrw: 9500, lineAmountKrw: 19000 },
      { name: "프로틴 닭가슴살 샐러드보울(곡물추가)", qty: 1, unitPriceKrw: 12000, lineAmountKrw: 12000 },
      { name: "현미밥", qty: 1, unitPriceKrw: 1000, lineAmountKrw: 1000 },
    ],
    amounts: { itemsKrw: 32000, discountKrw: 0, deliveryFeeKrw: 0, totalKrw: 32000 },
    reprint: false,
    ...overrides,
  };
};
