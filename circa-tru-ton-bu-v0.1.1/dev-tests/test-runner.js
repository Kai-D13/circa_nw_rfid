// Kiểm runner (kiểm tra + gửi) với core.js thật và mạng giả lập. node test-runner.js <thư mục ext>
const path = require("path");
const assert = require("assert");
const crypto = require("crypto");
const EXT = path.resolve(process.argv[2]);
const CORE = require(path.join(EXT, "lib/core.js"));
const RFID = require(path.join(EXT, "lib/rfid-core.js"));
const E = require(path.join(EXT, "lib/backfill-engine.js"));
const R = require(path.join(EXT, "lib/backfill-runner.js"));

const SRC_CORE = process.argv[3] ? path.resolve(process.argv[3]) : null;
if (SRC_CORE) {
  const h = (p) => crypto.createHash("sha256").update(require("fs").readFileSync(p)).digest("hex");
  assert.strictEqual(h(path.join(EXT, "lib/core.js")), h(path.join(SRC_CORE, "core.js")), "core.js phải trùng byte với v0.8.0.5");
  assert.strictEqual(h(path.join(EXT, "lib/rfid-core.js")), h(path.join(SRC_CORE, "rfid-core.js")), "rfid-core.js phải trùng byte với v0.8.0.5");
  console.log("0 OK core.js / rfid-core.js trùng byte với v0.8.0.5");
}

const BASE = "https://nw.test/api/v1/public";
const STORE = "c476efb2-415c-429a-978e-d389b4b06607";
const U_DIA = "1e4c377d-fb9d-4b3d-aa14-65b67b85c2bf";
const EPC = "1784593522634C06FFFFFFFF";
function order(id, code, completed, over) {
  return {
    success: true,
    data: {
      order: Object.assign(
        {
          id, code, status: "COMPLETED", type: "OFFLINE", pos_id: STORE, created_date: completed, completed_date: completed, updated_date: completed,
          items: [{ id: id.replace(/^.{8}/, "aaaaaaaa"), product_id: 8278, sku_code: "CIRCA.UNI-DIA-001", product_name: "Diana", quantity: 1, unit: "gói", unit_id: U_DIA, base_quantity: 8, qr_code: "1784593522634C5", qr_codes: ["1784593522634C5"], product: { retail_units: [{ id: U_DIA, unit: "gói", convert_rate: 8, base_unit: false }, { id: "33333333-3333-4333-8333-333333333333", unit: "miếng", convert_rate: 1, base_unit: true }] } }],
        },
        over || {}
      ),
    },
  };
}
const logFor = (id, t) => [{ id: id.replace(/^.{8}/, "bbbbbbbb"), action: "ITEM_ADDED", status: "SUCCESS", created_at: t, detail: { args: ["1", 10000] }, metadata: { product_id: "8278", qr_code: "1784593522634C5", sku_code: "CIRCA.UNI-DIA-001", unit: "gói", via: "qr" } }];

function env(opts) {
  const o = Object.assign({ held: 50, nwOrders: {}, postStatus: 201 }, opts || {});
  const calls = [];
  const store = {};
  const posts = [];
  const orders = {
    "11111111-1111-4111-8111-111111111111": order("11111111-1111-4111-8111-111111111111", "DHC01300001", "2026-10-25T01:00:00.000Z"),
    "22222222-2222-4222-8222-222222222222": order("22222222-2222-4222-8222-222222222222", "DHC01300002", "2026-10-25T02:00:00.000Z"),
    "33333333-3333-4333-8333-333333333333": order("33333333-3333-4333-8333-333333333333", "DHC01299037", "2026-10-25T03:00:00.000Z"),
    "44444444-4444-4444-8444-444444444444": order("44444444-4444-4444-8444-444444444444", "DHC01300004", "2026-10-25T04:00:00.000Z", { type: "ONLINE" }),
    "55555555-5555-4555-8555-555555555555": order("55555555-5555-4555-8555-555555555555", "DHC01300005", "2026-10-25T05:00:00.000Z", { pos_id: "other-store" }),
  };
  const state = { held: o.held, nwOrders: Object.assign({}, o.nwOrders) };
  const deps = {
    CORE, RFID, E, nwBase: BASE, storeId: STORE, blocklist: E.DEFAULT_BLOCKLIST.slice(),
    now: () => "2026-10-31T01:00:00.000Z",
    sha256: async (t) => crypto.createHash("sha256").update(String(t)).digest("hex"),
    storeGet: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null),
    storeSet: async (k, v) => {
      store[k] = JSON.parse(JSON.stringify(v));
      calls.push("store:" + k + ":" + v.state);
    },
    posFetchOrder: async (id) => ({ status: orders[id] ? 200 : 404, json: orders[id] || null, log: orders[id] ? logFor(id, orders[id].data.order.created_date) : [], logStatus: 200 }),
    nwFetch: async (method, p, x) => {
      calls.push(method + " " + p);
      if (method === "GET" && p.startsWith("/orders/")) {
        const code = decodeURIComponent(p.slice(8));
        return state.nwOrders[code] ? { status: 200, json: state.nwOrders[code] } : { status: 404, json: { message: "ORDER_NOT_FOUND" } };
      }
      if (method === "GET" && p === "/tags/by-uid/1784593522634C5") return { status: 200, json: { uid: "1784593522634C5", mapped: true, epc: EPC, status: "active" } };
      if (method === "GET" && p.startsWith("/integrations/circa/epcs/")) return { status: 200, json: { epc: EPC, found: true, status: state.held > 0 ? "active" : "sold", unitUid: "1784593522634C5", circaProductId: "8278", unit: "miếng", unitRatio: 1, baseUnit: "miếng", baseQuantity: state.held } };
      if (method === "POST" && p === R.NOTIFY_PATH) {
        posts.push({ body: x.bodyText, key: x.idempotencyKey, storedBefore: JSON.parse(JSON.stringify(store["bf:" + JSON.parse(x.bodyText).orderId] || null)) });
        if (o.postTransport) return { transport: o.postTransport };
        const body = JSON.parse(x.bodyText);
        state.held -= body.tags.reduce((a, t) => a + t.quantity, 0);
        state.nwOrders[body.orderId] = { orderNumber: "CIR-" + body.orderId, status: "DONE", items: body.tags.map((t) => ({ tagEpc: t.epc, baseQuantity: t.quantity, product: { externalProductId: "8278" } })) };
        return { status: o.postStatus, json: { success: true, imported: true, orderId: "nw-1", externalOrderId: body.orderId, stockOut: { outcome: "STOCKED_OUT" }, settledEpcs: body.tags.map((t) => t.epc) }, replay: "false" };
      }
      return { status: 500, json: {} };
    },
  };
  return { deps, calls, store, posts, state };
}

(async () => {
  // 1. parseInput
  {
    const p = R.parseInput("POS_name,order_code,order_id\nCIRCA FLORITA,DHC01300001,11111111-1111-4111-8111-111111111111\n11111111-1111-4111-8111-111111111111\nDHC01300009\n22222222-2222-4222-8222-222222222222");
    assert.strictEqual(p.orders.length, 2);
    assert.strictEqual(p.orders[0].code, "DHC01300001");
    assert.strictEqual(p.dups, 1);
    assert.strictEqual(p.errors[0].reason, "missing_order_id");
    console.log("1 OK parseInput");
  }
  // 2. check: 2 đơn dùng chung 1 EPC còn 12 → đơn trước đạt (8), đơn sau chỉ còn 4 → cần xem lại; blocklist; ONLINE; sai store
  {
    const { deps, calls } = env({ held: 12 });
    const run = R.createRunner(deps);
    const res = await run.check(R.parseInput(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"].join("\n")).orders);
    const by = Object.fromEntries(res.map((r) => [r.code || r.orderId, r]));
    assert.strictEqual(by.DHC01300001.verdict, "ready");
    assert.strictEqual(by.DHC01300001.payloadJson, JSON.stringify({ orderId: "DHC01300001", tags: [{ epc: EPC, quantity: 8 }] }));
    assert.strictEqual(by.DHC01300002.verdict, "needs_review");
    assert.strictEqual(by.DHC01299037.verdict, "blocked");
    assert.strictEqual(by.DHC01300004.verdict, "needs_review");
    assert.strictEqual(by.DHC01300004.reason, "order_type");
    assert.strictEqual(by.DHC01300005.verdict, "check_error");
    assert.strictEqual(by.DHC01300005.reason, "wrong_store");
    assert.ok(!calls.some((c) => c.startsWith("POST")), "kiểm tra không được POST");
    console.log("2 OK check: cộng dồn EPC, blocklist, ONLINE, sai store, 0 POST");
  }
  // 3. send: ghi bền submitting TRƯỚC POST, Idempotency-Key = DHC, body = payload đã kiểm, đối soát khớp; gửi lại bị chặn
  {
    const { deps, calls, store, posts } = env({ held: 50 });
    const run = R.createRunner(deps);
    const [r] = await run.check(R.parseInput("11111111-1111-4111-8111-111111111111").orders);
    assert.strictEqual(r.verdict, "ready");
    const s = await run.send(r);
    assert.strictEqual(s.state, "confirmed", JSON.stringify(s));
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].key, "DHC01300001");
    assert.strictEqual(posts[0].body, r.payloadJson);
    assert.strictEqual(posts[0].storedBefore.state, "submitting");
    assert.strictEqual(store["bf:DHC01300001"].state, "confirmed");
    assert.strictEqual(store["bf:DHC01300001"].reconcile, "match");
    const iGet = calls.lastIndexOf("GET /orders/DHC01300001", calls.indexOf("POST " + R.NOTIFY_PATH));
    assert.ok(iGet >= 0 && iGet < calls.indexOf("POST " + R.NOTIFY_PATH), "phải GET /orders/{DHC} ngay trước POST");
    const again = await run.send(r);
    assert.strictEqual(again.state, "skipped");
    assert.strictEqual(posts.length, 1);
    const re = await run.check(R.parseInput("11111111-1111-4111-8111-111111111111").orders);
    assert.ok(["on_nextwaves", "sent"].indexOf(re[0].verdict) >= 0, re[0].verdict);
    console.log("3 OK send: ghi bền trước POST, Idempotency-Key, đối soát, không gửi lần 2");
  }
  // 4. Agent gửi cùng DHC trong lúc chờ xác nhận → GET trước POST thấy 200 → không POST
  {
    const { deps, posts, state } = env({ held: 50 });
    const run = R.createRunner(deps);
    const [r] = await run.check(R.parseInput("11111111-1111-4111-8111-111111111111").orders);
    state.nwOrders.DHC01300001 = { orderNumber: "CIR-DHC01300001", items: [] };
    const s = await run.send(r);
    assert.strictEqual(s.state, "on_nextwaves");
    assert.strictEqual(posts.length, 0);
    console.log("4 OK DHC vừa có trên Nextwaves → huỷ gửi");
  }
  // 5. Lượng tem đổi giữa lúc kiểm và lúc gửi → payload khác → không POST
  {
    const { deps, posts, state } = env({ held: 50 });
    const run = R.createRunner(deps);
    const [r] = await run.check(R.parseInput("11111111-1111-4111-8111-111111111111").orders);
    state.held = 3;
    const s = await run.send(r);
    assert.strictEqual(s.state, "changed");
    assert.strictEqual(posts.length, 0);
    console.log("5 OK tem đổi lượng → changed, không POST");
  }
  // 6. Timeout khi POST → ambiguous, dừng hàng đợi; resolve: 404 → chỉ gửi lại đúng body + key khi cho phép
  {
    const e = env({ held: 50, postTransport: "timeout" });
    const run = R.createRunner(e.deps);
    const [r] = await run.check(R.parseInput("11111111-1111-4111-8111-111111111111").orders);
    const s = await run.send(r);
    assert.strictEqual(s.state, "ambiguous");
    assert.ok(s.stop);
    const r1 = await run.resolveAmbiguous("DHC01300001", false);
    assert.strictEqual(r1.state, "resendable");
    assert.strictEqual(e.posts.length, 1);
    console.log("6 OK timeout → ambiguous, dừng; gửi lại chỉ khi người bấm");
  }
  // 7. Trang đóng giữa lúc POST: bản ghi submitting → ambiguous khi mở lại
  {
    const { deps, store } = env();
    store["bf:DHC01300009"] = { code: "DHC01300009", state: "submitting", payloadJson: "{}", payloadHash: "x" };
    const run = R.createRunner(deps);
    const fixed = await run.recover(Object.keys(store));
    assert.deepStrictEqual(fixed, ["DHC01300009"]);
    assert.strictEqual(store["bf:DHC01300009"].state, "ambiguous");
    console.log("7 OK recover submitting → ambiguous");
  }
  // 8. 401 khi POST → rejected, dừng
  {
    const e = env({ held: 50, postStatus: 401 });
    const run = R.createRunner(e.deps);
    const [r] = await run.check(R.parseInput("11111111-1111-4111-8111-111111111111").orders);
    const s = await run.send(r);
    assert.ok(s.stop && s.state !== "confirmed", JSON.stringify(s));
    console.log("8 OK HTTP 401 → " + s.state + ", dừng hàng đợi");
  }
  console.log("ALL RUNNER TESTS PASSED");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
