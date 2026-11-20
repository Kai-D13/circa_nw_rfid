// Kiểm engine với core.js / rfid-core.js THẬT của v0.8.0.5 (đường dẫn truyền qua argv[2]).
const path = require("path");
const assert = require("assert");
const SRC = path.resolve(process.argv[2]);
const CORE = require(path.join(SRC, "core.js"));
const RFID = require(path.join(SRC, "rfid-core.js"));
const E = require("../lib/backfill-engine.js");

const OID = "08905332-6d69-4067-9751-c74100daf0a1";
const IT_POC = "11111111-1111-4111-8111-111111111111";
const IT_DIA = "22222222-2222-4222-8222-222222222222";
const U_POC = "857b3e49-d737-44f9-b8db-85496a8a90a8";
const U_DIA = "1e4c377d-fb9d-4b3d-aa14-65b67b85c2bf";

function orderJson(over) {
  const o = Object.assign(
    {
      id: OID,
      code: "DHC01299037",
      status: "COMPLETED",
      type: "OFFLINE",
      created_date: "2026-10-24T14:19:39.574Z",
      completed_date: "2026-10-24T14:21:44.581Z",
      updated_date: "2026-10-24T14:21:44.600Z",
      items: [
        { id: IT_POC, product_id: 591171, sku_code: "CIRCA.92ABV84F", quantity: 1, unit: "chai", unit_id: U_POC, base_quantity: 1, qr_code: "1784888774605C16", qr_codes: ["1784888774605C16"], product: { retail_units: [{ id: U_POC, unit: "chai", convert_rate: 1, base_unit: true }] } },
        { id: IT_DIA, product_id: 8278, sku_code: "CIRCA.UNI-DIA-001", quantity: 1, unit: "gói", unit_id: U_DIA, base_quantity: 8, qr_code: "1784593522634C5", qr_codes: ["1784593522634C5"], product: { retail_units: [{ id: U_DIA, unit: "gói", convert_rate: 8, base_unit: false }, { id: "33333333-3333-4333-8333-333333333333", unit: "miếng", convert_rate: 1, base_unit: true }] } },
      ],
    },
    over || {}
  );
  return { success: true, data: { order: o } };
}
// activity-log đúng như anh Dean dán (DHC01299037)
const LOG = [
  { id: "da891549-3b44-4f9c-9bec-3f266229fdda", action: "ORDER_COMPLETED", status: "SUCCESS", created_at: "2026-10-24T14:21:44.581Z", detail: { args: ["CASH", 22325] }, metadata: {} },
  { id: "3cd510ae-0327-46f1-bdc8-d362860b9276", action: "ITEM_ADDED", status: "SUCCESS", created_at: "2026-10-24T14:19:44.015Z", detail: { args: ["1", 12325] }, metadata: { product_id: "591171", qr_code: "1784888774605C16", sku_code: "CIRCA.92ABV84F", unit: "chai", unit_id: U_POC, via: "qr" } },
  { id: "74a4d76e-dd87-4eb8-8302-b0955d2b8740", action: "ITEM_ADDED", status: "SUCCESS", created_at: "2026-10-24T14:19:41.923Z", detail: { args: ["1", 10000] }, metadata: { product_id: "8278", qr_code: "1784593522634C5", sku_code: "CIRCA.UNI-DIA-001", unit: "gói", unit_id: U_DIA, via: "qr" } },
  { id: "404d4687-1dac-438b-8d6a-554fa923cb29", action: "ORDER_CREATED", status: "SUCCESS", created_at: "2026-10-24T14:19:39.574Z", detail: null, metadata: {} },
];
const EPC_DIA = "1784593522634C06FFFFFFFF";
const NW = {
  "/tags/by-uid/1784888774605C16": { status: 200, json: { uid: "1784888774605C16", mapped: false, epc: null, status: null, productId: null } },
  "/printing/labels/generations/1784888774605C16": { status: 404, json: { message: "CIRCA_LABEL_GENERATION_NOT_FOUND", statusCode: 404 } },
  "/tags/by-uid/1784593522634C5": { status: 200, json: { uid: "1784593522634C5", mapped: true, epc: EPC_DIA, status: "active", productId: "x" } },
};
const fetchJson = async (url) => {
  const p = url.replace("https://nw/api", "");
  return NW[p] || { status: 500, json: {} };
};
const holding = (held, extra) => CORE.parseNotifyEpcHolding(200, Object.assign({ epc: EPC_DIA, found: true, status: "active", unitUid: "1784593522634C5", circaProductId: "8278", unit: "miếng", unitRatio: 1, baseUnit: "miếng", baseQuantity: held }, extra || {}), EPC_DIA);

async function run(oj, log, ev, allocated) {
  const now = "2026-10-30T10:00:00.000Z";
  const ord = E.buildOrd(CORE, oj, now);
  const syn = E.synthesize(CORE, oj, log, ord);
  const codes = [...new Set(syn.events.filter((e) => e.source === "qr").map((e) => e.qrCode))];
  const outcomes = new Map();
  for (const c of codes) outcomes.set(c, await E.lookupCode(RFID, fetchJson, "https://nw/api", c, CORE.looksLikeUid));
  const events = E.applyLookups(CORE, syn.events, outcomes, now);
  const pre = E.previewOrder(CORE, { ord, events, evidence: {}, posActionDiag: syn.posActionDiag });
  const evidence = {};
  for (const epc of pre.epcs) evidence[epc] = ev;
  const fin = E.previewOrder(CORE, { ord, events, evidence, posActionDiag: syn.posActionDiag, allocated });
  return { ord, syn, events, pre, fin };
}

(async () => {
  // 1. DHC01299037: Diana (1 gói = 8 miếng, EPC active còn 50) → trừ 8; Pocari UID không có EPC → không trừ.
  {
    const r = await run(orderJson(), LOG, holding(50));
    assert.strictEqual(r.fin.state, "prepared", JSON.stringify(r.fin.reasons));
    assert.strictEqual(r.fin.payloadJson, JSON.stringify({ orderId: "DHC01299037", tags: [{ epc: EPC_DIA, quantity: 8 }] }));
    const poc = r.fin.items.find((x) => x.itemId === IT_POC);
    assert.strictEqual(poc.status, "no_rfid");
    assert.strictEqual(E.orderVerdict("DHC01299037", null, 200, r.fin).verdict, "blocked");
    console.log("1 OK DHC01299037 payload", r.fin.payloadJson);
  }
  // 2. Tem chỉ còn 5 miếng < 8 → UID fail (không trừ một phần); không còn EPC đạt → needs_review.
  {
    const r = await run(orderJson(), LOG, holding(5));
    assert.strictEqual(r.fin.state, "needs_review");
    assert.ok(r.fin.manual.some((m) => /quantity_exceeds_tags|tag_not_full_unit/.test(m.code)), JSON.stringify(r.fin.manual));
    console.log("2 OK tem thiếu lượng →", r.fin.reasons.map((x) => x.code).join(","), "| manual", r.fin.manual.map((m) => m.code).join(","));
  }
  // 3. Cộng dồn trong lượt: tem còn 10, đơn trước đã xếp 8 → còn 2 < 8 → giữ.
  {
    const r = await run(orderJson(), LOG, holding(10), new Map([[EPC_DIA, 8]]));
    assert.strictEqual(r.fin.state, "needs_review");
    console.log("3 OK cộng dồn EPC giữa các đơn");
  }
  // 4. Sửa số lượng tay (1 → 2 gói) trên dòng Diana → core giữ dòng (quantity_edited); Pocari không EPC → no_passing_epc.
  {
    const oj = orderJson();
    oj.data.order.items[1].quantity = 2;
    oj.data.order.items[1].base_quantity = 16;
    const log = LOG.concat([{ id: "55555555-5555-4555-8555-555555555555", action: "ITEM_QUANTITY_CHANGED", status: "SUCCESS", created_at: "2026-10-24T14:20:00.000Z", detail: { args: ["1", "2"] }, metadata: { product_id: "8278", sku_code: "CIRCA.UNI-DIA-001", unit: "gói", via: "manual" } }]);
    const r = await run(oj, log, holding(50));
    const dia = r.fin.items.find((x) => x.itemId === IT_DIA);
    assert.strictEqual(dia.status, "held");
    assert.ok(dia.reasons.includes("quantity_edited"), dia.reasons.join(","));
    assert.strictEqual(r.fin.state, "needs_review");
    console.log("4 OK sửa lượng tay → giữ dòng:", dia.reasons.join(","));
  }
  // 5. Đơn ONLINE → core chặn ở cổng đơn.
  {
    const r = await run(orderJson({ type: "ONLINE" }), LOG, holding(50));
    assert.strictEqual(r.fin.reasons[0].code, "order_type");
    console.log("5 OK đơn ONLINE → order_type");
  }
  // 6. Quét 2 UID cho 2 gói (1 → 2 qua quét) → mỗi EPC trừ đúng 1 gói (8) khi tem đúng 1 gói.
  {
    const oj = orderJson();
    const it = oj.data.order.items[1];
    it.quantity = 2;
    it.base_quantity = 16;
    it.qr_codes = ["1784593522634C5", "1784593522634C9"];
    const log = LOG.concat([{ id: "66666666-6666-4666-8666-666666666666", action: "ITEM_QUANTITY_CHANGED", status: "SUCCESS", created_at: "2026-10-24T14:20:10.000Z", detail: { args: ["1", "2"] }, metadata: { product_id: "8278", qr_code: "1784593522634C9", sku_code: "CIRCA.UNI-DIA-001", unit: "gói", via: "qr" } }]);
    const EPC2 = "1784593522634C09FFFFFFFF";
    NW["/tags/by-uid/1784593522634C9"] = { status: 200, json: { uid: "1784593522634C9", mapped: true, epc: EPC2, status: "active" } };
    const now = "2026-10-30T10:00:00.000Z";
    const ord = E.buildOrd(CORE, oj, now);
    const syn = E.synthesize(CORE, oj, log, ord);
    const outcomes = new Map();
    for (const c of ["1784888774605C16", "1784593522634C5", "1784593522634C9"]) outcomes.set(c, await E.lookupCode(RFID, fetchJson, "https://nw/api", c, CORE.looksLikeUid));
    const events = E.applyLookups(CORE, syn.events, outcomes, now);
    const mk = (epc, uid) => CORE.parseNotifyEpcHolding(200, { epc, found: true, status: "active", unitUid: uid, circaProductId: "8278", unit: "gói", unitRatio: 8, baseUnit: "miếng", baseQuantity: 8 }, epc);
    const fin = E.previewOrder(CORE, { ord, events, evidence: { [EPC_DIA]: mk(EPC_DIA, "1784593522634C5"), [EPC2]: mk(EPC2, "1784593522634C9") }, posActionDiag: syn.posActionDiag });
    assert.strictEqual(fin.state, "prepared", JSON.stringify(fin.reasons) + JSON.stringify(fin.manual));
    assert.deepStrictEqual(JSON.parse(fin.payloadJson).tags.map((t) => t.quantity), [8, 8]);
    console.log("6 OK 2 UID / 2 gói →", fin.payloadJson);
  }
  // 7. POS ghi sửa lượng 1→4 via "qr" kèm MÃ CŨ của dòng → thao tác sửa lượng (quantity_edited), không phải quét lại.
  {
    const oj = orderJson();
    oj.data.order.items[1].quantity = 4;
    oj.data.order.items[1].base_quantity = 32;
    const log = LOG.concat([{ id: "77777777-7777-4777-8777-777777777777", action: "ITEM_QUANTITY_CHANGED", status: "SUCCESS", created_at: "2026-10-24T14:20:20.000Z", detail: { args: ["1", "4"] }, metadata: { product_id: "8278", qr_code: "1784593522634C5", sku_code: "CIRCA.UNI-DIA-001", unit: "gói", via: "qr" } }]);
    const r = await run(oj, log, holding(50));
    const dia = r.fin.items.find((x) => x.itemId === IT_DIA);
    assert.strictEqual(dia.status, "held");
    assert.ok(dia.reasons.includes("quantity_edited") && !dia.reasons.includes("uid_rescanned"), dia.reasons.join(","));
    console.log("7 OK sửa lượng via qr cùng mã → quantity_edited:", dia.reasons.join(","));
  }
  console.log("ALL ENGINE TESTS PASSED");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
