// TEST extension "Kiểm kê Circa ↔ NW" bằng Node thuần (assert), KHÔNG cần trình duyệt. OFFLINE: không gọi mạng, không dùng token thật
// (token giả sinh ngẫu nhiên), mọi "máy chủ" là hàm giả trong bộ nhớ. Ghi file tạm của phần build vào thư mục tạm của hệ điều hành rồi xoá.
//
// Dùng (cwd bất kỳ):  node tools/nw-sang-circa/test-ext.js
// Phần:
//   A. Bảng API được phép (api.js): cho phép đúng các lệnh trong kế hoạch; chặn finalize/approve/cancel/revert/reset/scope/manual-count/
//      append/auth/refresh, POST tạo phiên Circa, host lạ, path traversal, method sai, query lạ, body sai; bản thật ≠ bản thử.
//   B. call(): header, token không vào URL / kết quả, không gửi khi bị chặn / không có token, timeout.
//   C. Ghép tên kho (link.js): trùng, khác hoa thường, lệch dấu, 0 kho, 2 kho, transit, đã đóng, kho dạng cây (children); notes /
//      clientOperationId; quyền Circa; quyền NW dạng thật (permissionNames / permissions object); recListOf (totalPages); judgeFound;
//      cổng webRequest (createGate) và giới hạn tần suất.
//   D. Máy trạng thái liên kết (link.js + api.js thật + máy chủ giả trong bộ nhớ, dạng response NW thật 22/11): tin giả, phiên > 10 phút,
//      không QR, kích hoạt 2 lần, đã có phiên theo notes, không có tab NW → pending → tạo bù, 401, 5xx, thiếu quyền, no-warehouse, tìm nhiều
//      trang, xung đột; NW không chống trùng; totalPages không đọc được → 0 POST; phiên NW đã huỷ/hoàn tất → nw-closed; POST sai kho/phạm vi.
//   E. bridge.js: đọc token từ cookie / localStorage giả, JWT hết hạn, không có tab.
//   F. watch-circa.js trong vm: request không quan sát → đúng Promise gốc; request quan sát → Promise gương; unhandledrejection như cũ;
//      chỉ đọc clone, nuốt lỗi, báo created / seen / store, XHR.
//   H. background.js THẬT trong vm (chrome.* giả): tin 'created' giả không có sự kiện webRequest → chỉ hỏi; lọc sự kiện webRequest;
//      tin rác bị giới hạn, không ghi; khoá gửi theo phiên; openPanel chuyển tới tab panel đang mở; phiên NW đã đóng khoá panel.
//   G. build-ext.js: bản thật / bản thử, core.js trùng byte, khối TEST bị cắt khỏi bản thật, soát nguồn (innerHTML, alert, fetch ngoài
//      api.js, self./window.fetch, XMLHttpRequest, sendBeacon, WebSocket, console[…), 127.0.0.1 dạng thoát.
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), vm = require("vm"), crypto = require("crypto"), assert = require("assert");
const D = __dirname, EXT = path.join(D, "ext");
const CFG = require("./ext/config.js");
const KKAPI = require("./ext/api.js");
const KKLINK = require("./ext/link.js");
const KKBRIDGE = require("./ext/bridge.js");

let pass = 0, fail = 0;
const failures = [], pending = [];
function t(name, fn) {
  try { const r = fn(); if (r && typeof r.then === "function") { pending.push(r.then(() => { pass++; }, e => { fail++; failures.push(name); console.log("FAIL  " + name + "\n      " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n      ")); })); return; } pass++; }
  catch (e) { fail++; failures.push(name); console.log("FAIL  " + name + "\n      " + String(e && e.message || e).split("\n").join("\n      ")); }
}
async function ta(name, fn) {
  try { await fn(); pass++; }
  catch (e) { fail++; failures.push(name); console.log("FAIL  " + name + "\n      " + String(e && e.stack || e).split("\n").slice(0, 5).join("\n      ")); }
}
const eq = assert.strictEqual, deq = assert.deepStrictEqual, ok = assert.ok;
// phần F cố ý để Promise bị từ chối không ai bắt rồi bắt sau: có listener này thì Node không in PromiseRejectionHandledWarning
process.on("rejectionHandled", () => {});

const SID = "3b3039be-5194-4cfa-958e-0248930a0be6"; // id giả (dạng uuid)
const SID2 = "4c4149cf-6205-4dfb-a69f-135904101cf7";
const POS = "31493e74-3404-4c0e-a906-93691a6ee319";   // id cửa hàng đã có trong repo (mock-server.js)
const POS_X = "99999999-0000-4000-8000-000000000009";
const NWID = "5d5250d0-7316-4e0c-b7a0-246a15212d08";
const WHL = "a1a1a1a1-0000-4000-8000-000000000001";
const TESTCFG = Object.assign({}, CFG, { TEST: true, CIRCA_ADMIN: "http://127.0.0.1:47900", CIRCA_API: "http://127.0.0.1:47901", NW_APP: "http://127.0.0.1:47902", NW_API: "http://127.0.0.1:47903" });

// ================= A. bảng API =================
const realApi = KKAPI.create({ cfg: CFG, fetch: () => { throw new Error("không được gọi"); }, getToken: async () => ({ err: "no-token" }) });
const testApi = KKAPI.create({ cfg: TESTCFG, fetch: () => { throw new Error("không được gọi"); }, getToken: async () => ({ err: "no-token" }) });
const C = CFG.CIRCA_API, N = CFG.NW_API;
const submitBody = { session_id: SID, device_id: "NW-RFID", tags: ["AB0001"], items: [{ tag: "AB0002", unit_name: "gói", quantity: 8 }] };
const recBody = { warehouseId: WHL, notes: "CIRCA ICS00242 " + SID, clientOperationId: "circa-" + SID };
const ALLOW = [
  ["GET", C + "/v1/inventory/count/sessions/" + SID],
  ["GET", C + "/v1/inventory/count/sessions/" + SID + "/scans?limit=5000"],
  ["GET", C + "/v1/inventory/count/qr-lookup?pos_id=" + POS + "&qr_code=AB0001"],
  ["POST", C + "/v1/inventory/count/submit-rfid-batch", submitBody],
  ["GET", C + "/v1/entity/stores/" + POS],
  ["GET", C + "/v1/authz/me"],
  ["GET", N + "/api/v1/auth/me"],
  ["GET", N + "/api/v1/warehouses"],
  ["GET", N + "/api/v1/stock/reconciliations?page=1&limit=25"],
  ["GET", N + "/api/v1/stock/reconciliations?page=8&limit=25"],
  ["GET", N + "/api/v1/stock/reconciliations/" + NWID + "?omitScannedEpcs=true"],
  ["POST", N + "/api/v1/stock/reconciliations", recBody],
  ["GET", N + "/api/v1/stock/reconciliations/" + NWID + "/export?format=xlsx&scope=all&includeEpcs=true&locale=vi"]
];
for (const [m, u, b] of ALLOW) t("A cho phép " + m + " " + u.replace(/^https:\/\//, ""), () => { const c = realApi.check(m, u, b); ok(c.ok, c.why); });
t("A bảng có đúng 12 lệnh, 2 lệnh POST (submit-rfid-batch, tạo phiên NW)", () => {
  eq(realApi.table.length, 12);
  deq(realApi.table.filter(e => e.method === "POST").map(e => e.id).sort(), ["circa.submit", "nw.recCreate"]);
});
const BLOCK = [
  // đóng / duyệt / huỷ / hoàn tất / đặt lại / đổi phạm vi / đếm tay / append ở cả 2 bên
  ...["close", "cancel", "approve", "unapprove", "sync", "submit-for-review", "finalize", "revert", "reset", "scope", "manual-count", "append", "add-products", "sync-preview-job"]
    .map(x => ["POST", C + "/v1/inventory/count/sessions/" + SID + "/" + x, {}]),
  ...["finalize", "approve", "cancel", "revert", "reset", "scope", "manual-count", "append", "complete", "close", "refresh"]
    .map(x => ["POST", N + "/api/v1/stock/reconciliations/" + NWID + "/" + x, {}]),
  ["PATCH", N + "/api/v1/stock/reconciliations/" + NWID, { scopeType: "product" }],
  ["PUT", N + "/api/v1/stock/reconciliations/" + NWID + "/scope", {}],
  ["POST", N + "/api/v1/auth/refresh", {}], ["GET", N + "/api/v1/auth/refresh"], ["POST", N + "/api/v1/auth/login", {}],
  // tạo phiên Circa (trang admin tự làm), danh sách phiên Circa, phiên hiện hành
  ["POST", C + "/v1/inventory/count/sessions", { pos_id: POS }], ["GET", C + "/v1/inventory/count/sessions?page=1&limit=20"],
  ["GET", C + "/v1/inventory/count/session/current?pos_id=" + POS],
  ["POST", C + "/v1/inventory/count/sessions/" + SID + "/unmatched-scans/bulk-resolve-as-new-stock", {}],
  // host lạ / http / cổng / userinfo / host giả mạo
  ["GET", "https://evil.example/v1/authz/me"], ["GET", "http://api.v2.circa.vn/v1/authz/me"], ["GET", "https://api.v2.circa.vn:444/v1/authz/me"],
  ["GET", "https://x:y@api.v2.circa.vn/v1/authz/me"], ["GET", "https://api.v2.circa.vn.evil.example/v1/authz/me"], ["GET", "https://admin.v2.circa.vn/v1/authz/me"],
  ["GET", "https://circa.nextwaves.app/api/v1/auth/me"], ["GET", "https://api-circa.nextwaves.app/api/v1/public/orders/DHC1"], ["GET", "http://127.0.0.1:47901/v1/authz/me"],
  // path traversal / mã hoá
  ["GET", C + "/v1/inventory/count/sessions/" + SID + "/../" + SID], ["POST", C + "/v1/inventory/count/sessions/" + SID + "/%2e%2e/close", {}],
  ["GET", C + "/v1/inventory/count/sessions/" + SID + "%2Fscans?limit=1"], ["GET", C + "/v1/inventory/count/sessions/" + SID + "/scans/?limit=1"],
  ["GET", C + "//v1/authz/me"], ["GET", C + "/v1/authz/me#x"], ["GET", C + "/V1/authz/me"], ["GET", C + "/v1/authz/me/"],
  ["GET", C + "/v1/inventory/count/sessions/" + SID.toUpperCase()], ["GET", C + "/v1/inventory/count/sessions/abc"], ["GET", C + "/v1/inventory/count/sessions/" + SID + "\\close"],
  // method sai
  ["DELETE", C + "/v1/inventory/count/sessions/" + SID], ["PUT", C + "/v1/inventory/count/sessions/" + SID, {}], ["POST", C + "/v1/inventory/count/sessions/" + SID, {}],
  ["GET", C + "/v1/inventory/count/submit-rfid-batch"], ["DELETE", N + "/api/v1/stock/reconciliations/" + NWID], ["get", C + "/v1/authz/me"],
  ["POST", N + "/api/v1/stock/reconciliations/" + NWID + "/export?format=xlsx&scope=all&includeEpcs=true&locale=vi", {}],
  // query lạ / thiếu / lặp
  ["GET", N + "/api/v1/stock/reconciliations/" + NWID + "/export?format=xlsx&scope=epcs&includeEpcs=true&locale=vi"],
  ["GET", N + "/api/v1/stock/reconciliations/" + NWID + "/export?format=csv&scope=all&includeEpcs=true&locale=vi"],
  ["GET", N + "/api/v1/stock/reconciliations/" + NWID + "/export?format=xlsx&scope=all&includeEpcs=true&locale=vi&x=1"],
  ["GET", N + "/api/v1/stock/reconciliations/" + NWID + "/export?format=xlsx&scope=all&includeEpcs=true"],
  ["GET", N + "/api/v1/stock/reconciliations?page=9&limit=25"], ["GET", N + "/api/v1/stock/reconciliations?page=1&limit=100"],
  ["GET", N + "/api/v1/stock/reconciliations?page=1&page=2&limit=25"], ["GET", N + "/api/v1/stock/reconciliations"],
  ["GET", N + "/api/v1/stock/reconciliations/" + NWID], ["GET", N + "/api/v1/warehouses?page=2"],
  ["GET", C + "/v1/inventory/count/qr-lookup?qr_code=AB0001"], ["GET", C + "/v1/inventory/count/qr-lookup?pos_id=" + POS + "&qr_code=qr.v2.circa.vn%2Fitem%2F1"],
  ["GET", C + "/v1/inventory/count/qr-lookup?pos_id=" + POS + "&qr_code=AB%200001"], ["GET", C + "/v1/authz/me?x=1"],
  ["GET", C + "/v1/inventory/count/sessions/" + SID + "/scans?limit=0"], ["GET", C + "/v1/inventory/count/sessions/" + SID + "/scans?limit=999999"],
  // body sai
  ["POST", N + "/api/v1/stock/reconciliations", Object.assign({}, recBody, { scopeType: "product" })],
  ["POST", N + "/api/v1/stock/reconciliations", Object.assign({}, recBody, { notes: "ghi chú khác" })],
  ["POST", N + "/api/v1/stock/reconciliations", Object.assign({}, recBody, { clientOperationId: "circa-" + SID2 })],
  ["POST", N + "/api/v1/stock/reconciliations", { warehouseId: WHL, notes: recBody.notes }],
  ["POST", C + "/v1/inventory/count/submit-rfid-batch", Object.assign({}, submitBody, { session_id: "x" })],
  ["POST", C + "/v1/inventory/count/submit-rfid-batch", Object.assign({}, submitBody, { extra: 1 })],
  ["POST", C + "/v1/inventory/count/submit-rfid-batch", { session_id: SID, device_id: "NW-RFID", tags: Array.from({ length: 101 }, (_, i) => "AB" + i) }],
  ["POST", C + "/v1/inventory/count/submit-rfid-batch", { session_id: SID, device_id: "NW-RFID" }],
  ["POST", C + "/v1/inventory/count/submit-rfid-batch", { session_id: SID, device_id: "NW-RFID", items: [{ tag: "AB1", unit_name: "gói", quantity: 0 }] }],
  ["GET", C + "/v1/authz/me", {}]
];
for (const [m, u, b] of BLOCK) t("A chặn " + m + " " + u.replace(/^https?:\/\//, "") + (b && Object.keys(b).length ? " (body)" : ""), () => { const c = realApi.check(m, u, b); ok(!c.ok, "lẽ ra phải chặn"); });
t("A bản thử chỉ nhận 127.0.0.1 đúng cổng cấu hình, chặn host thật", () => {
  ok(testApi.check("GET", "http://127.0.0.1:47901/v1/authz/me").ok);
  ok(testApi.check("GET", "http://127.0.0.1:47903/api/v1/auth/me").ok);
  ok(!testApi.check("GET", "https://api.v2.circa.vn/v1/authz/me").ok);
  ok(!testApi.check("GET", "http://127.0.0.1:47903/v1/authz/me").ok, "API Circa ở cổng NW");
  ok(!testApi.check("GET", "http://localhost:47901/v1/authz/me").ok);
});
t("A validateCfg: bản thật không nhận 127.0.0.1, bản thử không nhận host thật, TEST phải boolean", () => {
  assert.throws(() => KKAPI.validateCfg(Object.assign({}, CFG, { NW_API: "http://127.0.0.1:47903" })));
  assert.throws(() => KKAPI.validateCfg(Object.assign({}, CFG, { CIRCA_API: "https://api.v2.circa.vn.evil.example" })));
  assert.throws(() => KKAPI.validateCfg(Object.assign({}, CFG, { CIRCA_API: "https://admin.v2.circa.vn" })), "đổi chỗ 2 host");
  assert.throws(() => KKAPI.validateCfg(Object.assign({}, TESTCFG, { NW_API: "https://api-circa.nextwaves.app" })));
  assert.throws(() => KKAPI.validateCfg(Object.assign({}, CFG, { TEST: "false" })));
  ok(KKAPI.validateCfg(CFG)); ok(KKAPI.validateCfg(TESTCFG));
  eq(CFG.TEST, false); eq(CFG.AUTO_COUNTING_MODE, "QR"); eq(CFG.AUTO_WINDOW_MS, 600000);
});
t("A urlFor từ chối id không phải uuid chữ thường", () => {
  assert.throws(() => realApi.urlFor("circa.session", { id: "../close" }));
  assert.throws(() => realApi.urlFor("circa.session", { id: SID.toUpperCase() }));
  eq(realApi.urlFor("nw.export", { id: NWID, q: { format: "xlsx", scope: "all", includeEpcs: "true", locale: "vi" } }), N + "/api/v1/stock/reconciliations/" + NWID + "/export?format=xlsx&scope=all&includeEpcs=true&locale=vi");
});

// ================= B. call() =================
function fakeResp(status, body, headers) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, headers: { get: k => (headers || {})[String(k).toLowerCase()] || null }, text: async () => text, arrayBuffer: async () => Uint8Array.from(Buffer.from(text)).buffer };
}
const TOK = { circa: "gia-circa-" + crypto.randomBytes(12).toString("hex"), nw: "gia.nw." + crypto.randomBytes(12).toString("hex") };
async function partB() {
  const seen = [];
  const api = KKAPI.create({ cfg: CFG, fetch: async (u, o) => { seen.push({ u, o }); return fakeResp(200, { success: true, data: { ok: 1 } }); }, getToken: async s => ({ token: TOK[s] }) });
  await ta("B Circa: đủ header, X-Store-Id, credentials omit, redirect error, token chỉ ở Authorization", async () => {
    const r = await api.call("circa.session", { id: SID, posId: POS });
    eq(r.status, 200);
    const s = seen.pop();
    eq(s.u, C + "/v1/inventory/count/sessions/" + SID);
    deq(s.o.headers, { "Authorization": "Bearer " + TOK.circa, "X-Circa-App": "admin", "X-Client-Id": "1", "Grpc-Timeout": "30S", "X-Store-Id": POS });
    eq(s.o.credentials, "omit"); eq(s.o.redirect, "error"); eq(s.o.cache, "no-store"); eq(s.o.method, "GET"); eq(s.o.body, undefined);
    ok(JSON.stringify(r).indexOf(TOK.circa) < 0, "token lọt vào kết quả");
    ok(s.u.indexOf(TOK.circa) < 0);
  });
  await ta("B NW POST: Content-Type JSON, body đúng, không có header Circa", async () => {
    await api.call("nw.recCreate", { body: recBody });
    const s = seen.pop();
    eq(s.u, N + "/api/v1/stock/reconciliations"); eq(s.o.method, "POST"); deq(JSON.parse(s.o.body), recBody);
    eq(s.o.headers["Authorization"], "Bearer " + TOK.nw); eq(s.o.headers["Content-Type"], "application/json; charset=UTF-8"); eq(s.o.headers["X-Store-Id"], undefined);
  });
  await ta("B bị chặn → không gọi fetch, không đọc token", async () => {
    let tok = 0;
    const api2 = KKAPI.create({ cfg: CFG, fetch: async () => { throw new Error("không được gọi"); }, getToken: async () => { tok++; return { token: TOK.nw }; } });
    const r = await api2.call("nw.recCreate", { body: Object.assign({}, recBody, { notes: "x" }) });
    eq(r.status, 0); eq(r.err, "blocked"); eq(tok, 0);
    const r2 = await api2.call("nw.recList", { q: { page: 9, limit: 25 } });
    eq(r2.err, "blocked");
    const r3 = await api2.call("circa.session", { id: SID });
    eq(r3.err, "no-store", "thiếu X-Store-Id");
    const r4 = await api2.call("không-có", {});
    eq(r4.err, "blocked");
  });
  await ta("B không có token / token sai dạng → không gọi fetch", async () => {
    let n = 0;
    const api3 = KKAPI.create({ cfg: CFG, fetch: async () => { n++; return fakeResp(200, {}); }, getToken: async s => s === "nw" ? { err: "no-tab" } : { token: "abc\r\nX-Evil: 1aaaaaaaaaaaa" } });
    const r = await api3.call("nw.me");
    eq(r.err, "no-tab"); eq(r.side, "nw");
    const r2 = await api3.call("circa.authz", { posId: POS });
    eq(r2.err, "no-token");
    eq(n, 0);
  });
  await ta("B export: trả bytes; JSON hỏng → badJson; lỗi mạng → status 0 network", async () => {
    const api4 = KKAPI.create({ cfg: CFG, fetch: async (u) => /export/.test(u) ? fakeResp(200, "PK\u0003\u0004xlsx", { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }) : /auth\/me/.test(u) ? fakeResp(502, "<html>bad gateway</html>") : (() => { throw new Error("ECONNRESET"); })(), getToken: async s => ({ token: TOK[s] }) });
    const e = await api4.call("nw.export", { id: NWID, q: { format: "xlsx", scope: "all", includeEpcs: "true", locale: "vi" } });
    eq(e.status, 200); ok(e.bytes instanceof Uint8Array); eq(e.size, 8);
    const m = await api4.call("nw.me");
    eq(m.status, 502); eq(m.badJson, true);
    const w = await api4.call("nw.warehouses");
    eq(w.status, 0); eq(w.err, "network");
  });
  await ta("B timeout → status 0 timeout", async () => {
    const api5 = KKAPI.create({ cfg: CFG, timeoutMs: 50, fetch: (u, o) => new Promise((res, rej) => { o.signal.addEventListener("abort", () => rej(new Error("aborted"))); }), getToken: async s => ({ token: TOK[s] }) });
    const r = await api5.call("nw.me");
    eq(r.status, 0); eq(r.err, "timeout");
  });
}

// ================= C. ghép kho, notes, quyền =================
// dạng /warehouses thật (22/11): mảng phẳng, mỗi kho có parentId, children:[], locationType, closedAt. id GIẢ.
const whx = (id, name, type, closedAt, children, parentId) => ({ id, name, locationType: type, parentId: parentId || null, children: children || [], closedAt: closedAt || null });
const WHS = [
  whx(WHL, "CIRCA LUMINA", "warehouse"),
  whx("a1a1a1a1-0000-4000-8000-000000000002", "CIRCA FLORITA", "warehouse"),
  whx("a1a1a1a1-0000-4000-8000-000000000003", "CIRCA LUMINA", "transit"),
  whx("a1a1a1a1-0000-4000-8000-000000000004", "circa lumina", "warehouse", "2026-01-01T00:00:00Z"),
  whx("a1a1a1a1-0000-4000-8000-000000000005", "CIRCA LUMÍNA", "warehouse"),
  whx("a1a1a1a1-0000-4000-8000-000000000006", "CIRCA TAM VIET", "warehouse"),
  whx("a1a1a1a1-0000-4000-8000-000000000008", "In transit", "transit")
];
const WH_CHILD = "a1a1a1a1-0000-4000-8000-000000000007";
// kho con nằm trong children của "CIRCA TAM VIET"
function nested(childName, alsoAtRoot) {
  const list = JSON.parse(JSON.stringify(WHS)), child = whx(WH_CHILD, childName, "warehouse", null, [], "a1a1a1a1-0000-4000-8000-000000000006");
  list.find(w => w.name === "CIRCA TAM VIET").children = [child];
  if (alsoAtRoot) list.push(JSON.parse(JSON.stringify(child)));
  return list;
}
t("C trùng tên đúng 1 kho warehouse đang mở (bỏ transit, kho đã đóng, kho lệch dấu)", () => {
  const m = KKLINK.matchWarehouse("CIRCA LUMINA", WHS);
  ok(m.ok); eq(m.wh.id, WHL);
});
t("C khác hoa thường + khoảng trắng đầu/cuối vẫn khớp", () => { const m = KKLINK.matchWarehouse("  circa lumina ", WHS); ok(m.ok); eq(m.wh.id, WHL); });
t("C chuẩn hoá NFC: tên tổ hợp (NFD) khớp tên dựng sẵn", () => {
  const nfd = "CIRCA LUMÍNA".normalize("NFD");
  ok(nfd !== "CIRCA LUMÍNA");
  const m = KKLINK.matchWarehouse(nfd, WHS); ok(m.ok); eq(m.wh.id, "a1a1a1a1-0000-4000-8000-000000000005");
});
t("C lệch dấu → không khớp (không bỏ dấu)", () => {
  const m = KKLINK.matchWarehouse("CIRCA LÚMINA", WHS); eq(m.ok, false); eq(m.why, "none");
  const m2 = KKLINK.matchWarehouse("CIRCA TÂM VIỆT", [{ id: WHL, name: "CIRCA TAM VIET", locationType: "warehouse", closedAt: null }]); eq(m2.ok, false);
});
t("C không khớp gần đúng (khoảng trắng giữa, tiền tố)", () => {
  eq(KKLINK.matchWarehouse("CIRCA  LUMINA", WHS).ok, false);
  eq(KKLINK.matchWarehouse("LUMINA", WHS).ok, false);
  eq(KKLINK.matchWarehouse("CIRCA LUMINA 2", WHS).ok, false);
});
t("C 0 kho → none; 2 kho cùng tên → many", () => {
  const m0 = KKLINK.matchWarehouse("CIRCA SIGNATURE", WHS); eq(m0.ok, false); eq(m0.why, "none"); eq(m0.count, 0);
  const two = WHS.concat([whx("a1a1a1a1-0000-4000-8000-00000000000d", "Circa Lumina", "warehouse")]);
  const m2 = KKLINK.matchWarehouse("CIRCA LUMINA", two); eq(m2.ok, false); eq(m2.why, "many"); eq(m2.count, 2);
});
t("C chỉ transit / chỉ kho đã đóng → none; closedAt undefined = đang mở; id không phải uuid bị bỏ", () => {
  eq(KKLINK.matchWarehouse("CIRCA LUMINA", [WHS[2]]).why, "none");
  eq(KKLINK.matchWarehouse("CIRCA LUMINA", [WHS[3]]).why, "none");
  ok(KKLINK.matchWarehouse("CIRCA LUMINA", [{ id: WHL, name: "CIRCA LUMINA", locationType: "warehouse" }]).ok);
  eq(KKLINK.matchWarehouse("CIRCA LUMINA", [{ id: "kho-1", name: "CIRCA LUMINA", locationType: "warehouse", closedAt: null }]).ok, false);
  eq(KKLINK.matchWarehouse("", WHS).why, "bad-input"); eq(KKLINK.matchWarehouse("X", null).why, "bad-input");
});
t("C notes / clientOperationId đúng mẫu", () => {
  eq(KKLINK.notesFor("ICS00242", SID), "CIRCA ICS00242 " + SID);
  eq(KKLINK.clientOpId(SID), "circa-" + SID);
  ok(KKLINK.notesHas("CIRCA ICS00242 " + SID.toUpperCase(), SID));
  ok(!KKLINK.notesHas(null, SID));
  eq(KKAPI._bodyRecCreate({ warehouseId: WHL, notes: KKLINK.notesFor("ICS00242", SID), clientOperationId: KKLINK.clientOpId(SID) }), "");
});
t("C hasCapability: mảng chuỗi, mảng object, lồng nhau, không đọc được → null", () => {
  eq(KKLINK.hasCapability({ data: { permissions: ["inventory_count.view", "inventory_count.manage"] } }, "inventory_count.manage"), true);
  eq(KKLINK.hasCapability({ data: { roles: [{ code: "STOCKTAKE", permissions: [{ code: "inventory_count.manage", scope: "CLIENT" }] }] } }, "inventory_count.manage"), true);
  eq(KKLINK.hasCapability({ data: { capabilities: [{ name: "inventory_count.view" }] } }, "inventory_count.manage"), false);
  eq(KKLINK.hasCapability({ data: { principal: { id: "x", type: "PERSON" } } }, "inventory_count.manage"), null);
  eq(KKLINK.hasCapability(null, "inventory_count.manage"), null);
  eq(KKLINK.hasCapability({ data: { permissions: ["inventory_count.manage_extra"] } }, "inventory_count.manage"), false);
});
t("C quyền NW dạng THẬT 22/11: permissions = object {id,name,description}, permissionNames = chuỗi → đọc permissionNames", () => {
  const me = { id: "u", permissions: [{ id: "p1", name: "stock.view", description: "x" }, { id: "p2", name: "warehouse.view", description: "y" }], permissionNames: ["stock.view", "stock.reconcile", "warehouse.view"] };
  ok(KKLINK.nwPermissions(me).indexOf("stock.reconcile") >= 0, "ưu tiên permissionNames");
  ok(KKLINK.nwPermissions({ data: me }).indexOf("stock.reconcile") >= 0);
  ok(KKLINK.nwPermissions({ permissionNames: ["stock.view"], permissions: ["stock.reconcile"] }).indexOf("stock.reconcile") < 0, "có permissionNames thì không lấy permissions");
});
t("C quyền NW: không có permissionNames → permissions[].name (object) hoặc chuỗi; ở gốc / data / user; không có → null", () => {
  deq(KKLINK.nwPermissions({ permissions: [{ id: 1, name: "stock.reconcile", description: "" }, { id: 2 }, null] }), ["stock.reconcile"]);
  deq(KKLINK.nwPermissions({ permissions: ["stock.reconcile"] }), ["stock.reconcile"]);
  deq(KKLINK.nwPermissions({ data: { permissions: ["a.b", 1] } }), ["a.b"]);
  deq(KKLINK.nwPermissions({ user: { permissions: [] } }), []);
  eq(KKLINK.nwPermissions({ id: 1 }), null);
});
t("C kho dạng cây: kho con (children) trùng tên được ghép; kho con trùng tên kho gốc → many; kho con có cả ở gốc (cùng id) → 1", () => {
  const m = KKLINK.matchWarehouse("CIRCA KHO CON", nested("CIRCA KHO CON")); ok(m.ok, JSON.stringify(m)); eq(m.wh.id, WH_CHILD);
  const m2 = KKLINK.matchWarehouse("CIRCA LUMINA", nested("CIRCA LUMINA")); eq(m2.ok, false); eq(m2.why, "many"); eq(m2.count, 2);
  const m3 = KKLINK.matchWarehouse("CIRCA KHO CON", nested("CIRCA KHO CON", true)); ok(m3.ok); eq(m3.wh.id, WH_CHILD);
  // cây sâu 3 cấp
  const deep = [whx(WHL, "A", "warehouse", null, [whx("a1a1a1a1-0000-4000-8000-00000000000b", "B", "warehouse", null, [whx("a1a1a1a1-0000-4000-8000-00000000000c", "CIRCA SÂU", "warehouse")])])];
  eq(KKLINK.matchWarehouse("CIRCA SÂU", deep).wh.id, "a1a1a1a1-0000-4000-8000-00000000000c");
  // "In transit" (transit) không bao giờ được ghép
  eq(KKLINK.matchWarehouse("In transit", WHS).why, "none");
});
t("C recListOf: totalPages ở gốc; meta.totalPages; thiếu / sai → null (chưa tìm hết); mảng trần = đủ", () => {
  eq(KKLINK.recListOf({ j: { data: [], total: 0, page: 1, limit: 25, totalPages: 3 } }).totalPages, 3);
  eq(KKLINK.recListOf({ j: { data: [], meta: { totalPages: 2 } } }).totalPages, 2);
  eq(KKLINK.recListOf({ j: { data: [], total: 0, page: 1, limit: 25 } }).totalPages, null);
  eq(KKLINK.recListOf({ j: { data: [], totalPages: "x" } }).totalPages, null);
  eq(KKLINK.recListOf({ j: { data: [], totalPages: "4" } }).totalPages, 4);
  eq(KKLINK.recListOf({ j: [{ id: 1 }] }).totalPages, 1);
  eq(KKLINK.recListOf({ j: { items: [] } }), null);
});
t("C judgeFound: kho đúng + in_progress → linked; huỷ/hoàn tất/duyệt → nw-closed; không có kho / kho khác / scope khác / trạng thái lạ → conflict", () => {
  const f = (x) => Object.assign({ id: NWID, warehouseId: WHL, status: "in_progress", scopeType: "warehouse", notes: "CIRCA X " + SID }, x);
  eq(KKLINK.judgeFound(f({}), WHL).state, "linked");
  eq(KKLINK.judgeFound(f({ warehouseId: undefined, warehouse: { id: WHL } }), WHL).state, "linked");
  for (const s of ["cancelled", "completed", "approved"]) { const j = KKLINK.judgeFound(f({ status: s }), WHL); eq(j.state, "nw-closed"); eq(j.nwStatus, s); }
  eq(KKLINK.judgeFound(f({ warehouseId: undefined }), WHL).state, "conflict");
  eq(KKLINK.judgeFound(f({ warehouseId: "a1a1a1a1-0000-4000-8000-000000000002" }), WHL).state, "conflict");
  eq(KKLINK.judgeFound(f({ scopeType: "product" }), WHL).state, "conflict");
  eq(KKLINK.judgeFound(f({ status: "draft" }), WHL).state, "conflict");
});
t("C cổng webRequest: sự kiện trong 30 s, cùng tab, mỗi sự kiện 1 sessionId; tab khác / quá hạn → không", async () => {
  let n = 1000000;
  const G = KKLINK.createGate({ now: () => n, windowMs: 30000, waitMs: 0, sleep: async ms => { n += ms; } });
  eq(await G.claim(7, SID), null, "chưa có sự kiện");
  G.record(7, n);
  deq(await G.claim(7, SID), { t: n });
  deq(await G.claim(7, SID), { t: n }, "tin lặp cùng sessionId dùng lại sự kiện đó");
  eq(await G.claim(7, SID2), null, "sự kiện đã dùng cho sessionId khác");
  G.record(8, n); eq(await G.claim(7, SID2), null, "sự kiện của tab khác");
  G.record(7, n); n += 31000; eq(await G.claim(7, SID2), null, "quá 30 s");
  G.record(-1, n); G.record("x", n); eq(G._events().filter(e => e.tabId === -1 || e.tabId === "x").length, 0);
  // chờ sự kiện tới muộn (tin trang tới trước webRequest)
  const G2 = KKLINK.createGate({ now: () => n, windowMs: 30000, waitMs: 3000, sleep: async ms => { n += ms; if (n >= t0 + 500 && !G2._events().length) G2.record(9, n); } });
  const t0 = n; const c = await G2.claim(9, SID); ok(c && c.t >= t0, "nhận sự kiện tới muộn trong thời gian chờ");
  const t1 = n; eq(await G2.claim(10, SID), null); ok(n - t1 >= 3000, "chờ tối đa waitMs rồi bỏ");
});
t("C giới hạn tần suất: tối đa N lần / cửa sổ, theo khoá", () => {
  let n = 0;
  const R = KKLINK.createRateLimiter({ now: () => n, max: 3, windowMs: 60000 });
  deq([R.hit(1), R.hit(1), R.hit(1), R.hit(1), R.hit(2)], [true, true, true, false, true]);
  n += 60001; eq(R.hit(1), true);
});
t("C verifySession / inWindow", () => {
  const raw = { id: SID, code: "ICS00242", pos_id: POS, status: "OPEN", counting_mode: "QR", created_at: "2026-11-22T03:00:00.123456789Z" };
  const v = KKLINK.verifySession(raw, SID, POS); ok(v.ok); eq(v.s.code, "ICS00242"); eq(v.s.createdMs, Date.parse("2026-11-22T03:00:00.123Z"));
  eq(KKLINK.verifySession(raw, SID2, POS).ok, false);
  eq(KKLINK.verifySession(raw, SID, POS_X).ok, false);
  eq(KKLINK.verifySession(Object.assign({}, raw, { code: "<img>" }), SID, POS).ok, false);
  const seen = Date.parse("2026-11-22T03:05:00Z");
  ok(KKLINK.inWindow(v.s.createdMs, seen, CFG));
  ok(!KKLINK.inWindow(Date.parse("2026-11-22T02:54:59Z"), seen, CFG));
  ok(!KKLINK.inWindow(Date.parse("2026-11-22T03:08:00Z"), seen, CFG));
  ok(!KKLINK.inWindow(null, seen, CFG));
});

// ================= D. máy trạng thái =================
// Máy chủ giả trong bộ nhớ cho CẢ Circa và NW, nối qua api.js THẬT (mọi lệnh đi qua check()).
function flatWh(list) { const out = []; (function w(a) { (a || []).forEach(x => { out.push(x); w(x.children); }); })(list); return out; }
function world(o) {
  o = o || {};
  const W = {
    now: o.now || Date.parse("2026-11-22T03:05:00Z"),
    sessions: {}, stores: { [POS]: "CIRCA LUMINA" }, warehouses: JSON.parse(JSON.stringify(WHS)), recs: [], perms: ["stock.view", "stock.reconcile"],
    tokens: { circa: TOK.circa, nw: TOK.nw }, log: [], faults: {}, createAnyway: false, sets: [],
    // dạng NW: meShape "real" (mặc định: object + permissionNames) | "objectsOnly" | "strings"; noTotalPages / metaTotalPages; noDedupe
    meShape: "real", noTotalPages: false, metaTotalPages: false, noDedupe: false
  };
  W.addSession = (id, x) => { W.sessions[id] = Object.assign({ id, code: "ICS00242", pos_id: POS, status: "OPEN", counting_mode: "QR", created_at: new Date(W.now - 60000).toISOString() }, x || {}); };
  // phiên NW dạng thật: id, warehouseId, status, scopeType, notes, createdAt, warehouse{…}
  W.addRec = (x) => {
    x = x || {};
    const wh = x.warehouse || { id: WHL, name: "CIRCA LUMINA" };
    const r = Object.assign({ id: crypto.randomUUID(), warehouseId: wh.id, status: "in_progress", scopeType: "warehouse", notes: null, warehouse: wh, createdAt: new Date(W.now - W.recs.length * 1000).toISOString() }, x);
    if (x.noWarehouse) { delete r.warehouseId; delete r.warehouse; delete r.noWarehouse; }
    W.recs.push(r); return r;
  };
  const fault = (key) => { const f = W.faults[key]; if (!f) return null; return Array.isArray(f) ? f.shift() || null : f; };
  async function fetchFn(url, opts) {
    const u = new URL(url), p = u.pathname, m = opts.method, q = Object.fromEntries(u.searchParams);
    const side = u.origin === CFG.NW_API ? "nw" : "circa";
    const e = { side, m, p, q, body: opts.body ? JSON.parse(opts.body) : undefined, store: opts.headers["X-Store-Id"] || null, auth: opts.headers.Authorization };
    W.log.push(e);
    const f = fault(m + " " + p.replace(/[0-9a-f-]{36}/g, ":id"));
    if (f) {
      if (f.record && m === "POST" && side === "nw") W.addRec({ notes: e.body.notes, clientOperationId: e.body.clientOperationId, warehouse: { id: e.body.warehouseId, name: "?" } });
      if (f.throw) throw new Error(f.throw);
      return fakeResp(f.status, f.body || { message: "lỗi giả" });
    }
    if (e.auth !== "Bearer " + TOK[side]) return fakeResp(401, { message: "Unauthorized" });
    let x;
    if (side === "circa") {
      if ((x = /^\/v1\/inventory\/count\/sessions\/([0-9a-f-]{36})$/.exec(p))) { const s = W.sessions[x[1]]; return s ? fakeResp(200, { success: true, data: { session: s } }) : fakeResp(404, { success: false, errors: [{ code: "NotFoundError" }] }); }
      if ((x = /^\/v1\/entity\/stores\/([0-9a-f-]{36})$/.exec(p))) { const n = W.stores[x[1]]; return n ? fakeResp(200, { success: true, data: { pos_id: x[1], pos_code: "POS0012", pos_name: n, status: "ACTIVE" } }) : fakeResp(404, {}); }
      return fakeResp(404, {});
    }
    if (p === "/api/v1/auth/me") {
      const me = { id: "u", permissions: W.perms.map((n, i) => ({ id: "p" + i, name: n, description: "" })), permissionNames: W.perms.slice() };
      if (W.meShape === "objectsOnly") delete me.permissionNames;
      if (W.meShape === "strings") { me.permissions = W.perms.slice(); delete me.permissionNames; }
      return fakeResp(200, me);
    }
    if (p === "/api/v1/warehouses") return fakeResp(200, W.warehouses);
    if (p === "/api/v1/stock/reconciliations" && m === "GET") {
      const page = +q.page, limit = +q.limit, all = W.recs.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const tp = Math.max(1, Math.ceil(all.length / limit)), o = { data: all.slice((page - 1) * limit, page * limit), total: all.length, page, limit, totalPages: tp };
      if (W.noTotalPages || W.metaTotalPages) delete o.totalPages;
      if (W.metaTotalPages) o.meta = { totalPages: tp };
      return fakeResp(200, o);
    }
    if (p === "/api/v1/stock/reconciliations" && m === "POST") {
      const b = e.body, old = W.noDedupe ? null : W.recs.find(r => r.clientOperationId === b.clientOperationId);
      if (old) return fakeResp(201, old);
      const w = flatWh(W.warehouses).find(z => z.id === b.warehouseId);
      return fakeResp(201, W.addRec({ notes: b.notes, clientOperationId: b.clientOperationId, warehouse: { id: w.id, name: w.name }, createdAt: new Date(W.now + W.recs.length).toISOString() }));
    }
    return fakeResp(404, {});
  }
  const mem = new Map();
  const store = {
    get: async k => { const v = mem.get(k); return v === undefined ? undefined : JSON.parse(v); },
    set: async (k, v) => { W.sets.push({ k, state: v.state, at: W.log.length }); mem.set(k, JSON.stringify(v)); },
    remove: async k => { mem.delete(k); },
    all: async () => { const o2 = {}; for (const [k, v] of mem) o2[k] = JSON.parse(v); return o2; }
  };
  W.mem = mem; W.store = store; W.fetchFn = fetchFn;
  W.api = KKAPI.create({ cfg: CFG, fetch: fetchFn, getToken: async s => W.tokens[s] ? { token: W.tokens[s] } : { err: "no-tab" }, now: () => W.now });
  W.L = KKLINK.createLinker({ api: W.api, store, cfg: CFG, now: () => W.now });
  // linker MỚI trên cùng storage (giả service worker khởi động lại: mất khoá / bộ đệm trong bộ nhớ)
  W.newLinker = () => { W.L = KKLINK.createLinker({ api: W.api, store, cfg: CFG, now: () => W.now }); return W.L; };
  W.posts = () => W.log.filter(e => e.m === "POST" && e.p === "/api/v1/stock/reconciliations");
  W.nwCalls = () => W.log.filter(e => e.side === "nw");
  W.dump = () => [...mem.values()].join("\n");
  return W;
}
async function partD() {
  await ta("D1 tự tạo: GET phiên → pending TRƯỚC khi gọi NW → 1 POST đúng notes / clientOperationId / kho → linked", async () => {
    const W = world(); W.addSession(SID);
    const r = await W.L.onCreated(SID, POS, W.now);
    eq(r.state, "linked", r.msg); eq(r.nwId, W.recs[0].id); eq(r.created, true); eq(r.warehouseId, WHL); eq(r.storeName, "CIRCA LUMINA"); eq(r.code, "ICS00242");
    const p = W.posts(); eq(p.length, 1);
    deq(p[0].body, { warehouseId: WHL, notes: "CIRCA ICS00242 " + SID, clientOperationId: "circa-" + SID });
    eq(W.log[0].side, "circa"); eq(W.log[0].p, "/v1/inventory/count/sessions/" + SID); eq(W.log[0].store, POS);
    const firstNw = W.log.findIndex(e => e.side === "nw"), firstPending = W.sets.find(s => s.state === "pending");
    ok(firstPending && firstPending.at <= firstNw, "pending phải ghi trước lần gọi NW đầu tiên");
    ok(W.dump().indexOf(TOK.nw) < 0 && W.dump().indexOf(TOK.circa) < 0, "token lọt vào storage");
  });
  await ta("D2 tin giả: id không phải uuid → bỏ, 0 lệnh gọi", async () => {
    const W = world();
    for (const bad of ["", "abc", SID + "/../close", null, 42, { id: SID }]) eq((await W.L.onCreated(bad, POS, W.now)).state, "rejected");
    eq(W.log.length, 0); eq(W.mem.size, 0);
  });
  await ta("D3 tin giả: uuid không có phiên (404) → không ghi gì, 0 lệnh NW", async () => {
    const W = world();
    const r = await W.L.onCreated(SID, POS, W.now);
    eq(r.state, "error"); eq(W.nwCalls().length, 0); eq(W.mem.size, 0);
  });
  await ta("D4 tin giả: pos trang báo khác pos của phiên → không tạo", async () => {
    const W = world(); W.addSession(SID, { pos_id: POS_X }); W.stores[POS_X] = "CIRCA KHÁC";
    const r = await W.L.onCreated(SID, POS, W.now);
    eq(r.state, "error"); eq(W.nwCalls().length, 0); eq(W.mem.size, 0);
  });
  await ta("D5 tin giả: không có pos → unknown-store, 0 lệnh gọi", async () => {
    const W = world(); W.addSession(SID);
    eq((await W.L.onCreated(SID, null, W.now)).state, "unknown-store"); eq(W.log.length, 0);
  });
  await ta("D6 phiên tạo > 10 phút trước lúc thấy → không tự tạo, không ghi, 0 lệnh NW", async () => {
    const W = world(); W.addSession(SID, { created_at: new Date(W.now - 11 * 60000).toISOString() });
    const r = await W.L.onCreated(SID, POS, W.now);
    eq(r.state, "ignored"); eq(W.nwCalls().length, 0); eq(W.mem.size, 0);
  });
  await ta("D7 phiên không phải QR → skipped (ghi để thanh báo), 0 lệnh NW; kích hoạt lại vẫn skipped", async () => {
    const W = world(); W.addSession(SID, { counting_mode: "RFID" });
    const r = await W.L.onCreated(SID, POS, W.now);
    eq(r.state, "skipped"); ok(/không phải phiên QR/.test(r.msg)); eq(W.nwCalls().length, 0);
    eq((await W.L.onCreated(SID, POS, W.now)).state, "skipped"); eq(W.nwCalls().length, 0);
  });
  await ta("D8 phiên Circa đã CANCELLED → không tạo, 0 lệnh NW", async () => {
    const W = world(); W.addSession(SID, { status: "CANCELLED" });
    eq((await W.L.onCreated(SID, POS, W.now)).state, "closed"); eq(W.nwCalls().length, 0);
  });
  await ta("D9 kích hoạt 2 lần cùng lúc (+ 1 lần sau) → đúng 1 POST, cùng 1 phiên NW", async () => {
    const W = world(); W.addSession(SID);
    const [a, b] = await Promise.all([W.L.onCreated(SID, POS, W.now), W.L.onCreated(SID, POS, W.now)]);
    const c = await W.L.onCreated(SID, POS, W.now);
    eq(a.state, "linked"); eq(b.state, "linked"); eq(c.state, "linked"); eq(a.nwId, b.nwId); eq(W.posts().length, 1); eq(W.recs.length, 1);
  });
  await ta("D10 đã có phiên NW theo notes (trang 1) → liên kết, 0 POST", async () => {
    const W = world(); W.addSession(SID);
    for (let i = 0; i < 5; i++) W.addRec({ notes: "khác " + i });
    const ex = W.addRec({ notes: "CIRCA ICS00242 " + SID });
    const r = await W.L.onCreated(SID, POS, W.now);
    eq(r.state, "linked"); eq(r.nwId, ex.id); eq(r.created, false); eq(W.posts().length, 0);
  });
  await ta("D11 phiên NW theo notes ở trang 3 → tìm qua nhiều trang, 0 POST", async () => {
    const W = world(); W.addSession(SID);
    const ex = W.addRec({ notes: "CIRCA ICS00242 " + SID, createdAt: new Date(W.now - 10 * 86400000).toISOString() });
    for (let i = 0; i < 60; i++) W.addRec({ notes: "khác " + i });
    const r = await W.L.onCreated(SID, POS, W.now);
    eq(r.state, "linked"); eq(r.nwId, ex.id); eq(W.posts().length, 0);
    deq(W.log.filter(e => e.p === "/api/v1/stock/reconciliations" && e.m === "GET").map(e => e.q.page), ["1", "2", "3"]);
  });
  await ta("D12 > 8 trang phiên NW → chỉ tìm 8 trang (page ≤ 8), rồi POST (clientOperationId chống trùng)", async () => {
    const W = world(); W.addSession(SID);
    for (let i = 0; i < 230; i++) W.addRec({ notes: "khác " + i });
    const r = await W.L.onCreated(SID, POS, W.now);
    eq(r.state, "linked"); eq(W.posts().length, 1); ok(/còn trang sau/.test(r.msg), r.msg);
    eq(Math.max(...W.log.filter(e => e.p === "/api/v1/stock/reconciliations" && e.m === "GET").map(e => +e.q.page)), 8);
  });
  await ta("D13 không có tab NW → pending (nw-tab), 0 lệnh HTTP tới NW; mở tab NW → tạo bù 1 POST", async () => {
    const W = world(); W.addSession(SID); W.tokens.nw = null;
    const r = await W.L.onCreated(SID, POS, W.now);
    eq(r.state, "pending"); eq(r.reason, "nw-tab"); ok(/circa\.nextwaves\.app/.test(r.msg)); eq(W.nwCalls().length, 0);
    W.tokens.nw = TOK.nw; W.now += 20 * 60000; // tạo bù sau 20 phút: không áp điều kiện 10 phút nữa (đã duyệt lúc thấy)
    const out = await W.L.onNwTab();
    eq(out.length, 1); eq(out[0].state, "linked"); eq(W.posts().length, 1);
    eq((await W.L.onNwTab()).length, 0, "không chạy lại bản ghi đã linked");
  });
  await ta("D14 NW 401 → pending nw-tab; probe từ thanh trạng thái tự thử lại (≤ 1 lần / 30 s) → linked", async () => {
    const W = world(); W.addSession(SID); W.tokens.nw = "token-cu-het-han-aaaaaaaa";
    const r = await W.L.onCreated(SID, POS, W.now);
    eq(r.state, "pending"); eq(r.reason, "nw-tab"); ok(/hết hạn/.test(r.msg)); eq(W.posts().length, 0);
    W.tokens.nw = TOK.nw;
    const p1 = await W.L.probe(SID, POS);
    eq(p1.state, "linked"); eq(W.posts().length, 1);
  });
  await ta("D15 probe: pending nw-tab thử lại tối đa 1 lần / 30 s", async () => {
    const W = world(); W.addSession(SID); W.tokens.nw = null;
    await W.L.onCreated(SID, POS, W.now);
    const n0 = W.log.length;
    await W.L.probe(SID, POS); const n1 = W.log.length;
    await W.L.probe(SID, POS); const n2 = W.log.length;
    W.now += 31000; await W.L.probe(SID, POS); const n3 = W.log.length;
    ok(n1 >= n0); eq(n2, n1, "lần probe thứ 2 trong 30 s không được gọi gì"); ok(n3 >= n2);
  });
  await ta("D16 POST 503 → pending loi-mang; có tab NW KHÔNG tự chạy lại; bấm Thử lại → tìm notes trước", async () => {
    const W = world(); W.addSession(SID);
    W.faults["POST /api/v1/stock/reconciliations"] = [{ status: 503, record: true }];
    const r = await W.L.onCreated(SID, POS, W.now);
    eq(r.state, "pending"); eq(r.reason, "loi-mang"); eq(W.posts().length, 1);
    eq((await W.L.onNwTab()).length, 0); eq(W.posts().length, 1);
    const r2 = await W.L.retry(SID);
    eq(r2.state, "linked"); eq(r2.created, false, "máy chủ đã ghi trước khi lỗi: tìm thấy theo notes"); eq(W.posts().length, 1); eq(W.recs.length, 1);
  });
  await ta("D17 POST timeout / lỗi mạng (chưa ghi) → pending; Thử lại → POST lại cùng clientOperationId → 1 phiên", async () => {
    const W = world(); W.addSession(SID);
    W.faults["POST /api/v1/stock/reconciliations"] = [{ throw: "ECONNRESET" }];
    eq((await W.L.onCreated(SID, POS, W.now)).reason, "loi-mang");
    const r2 = await W.L.retry(SID);
    eq(r2.state, "linked"); eq(W.posts().length, 2); eq(W.recs.length, 1);
    eq(W.posts()[0].body.clientOperationId, W.posts()[1].body.clientOperationId);
  });
  await ta("D18 GET danh sách NW 500 → pending loi-mang, 0 POST", async () => {
    const W = world(); W.addSession(SID);
    W.faults["GET /api/v1/stock/reconciliations"] = { status: 500 };
    const r = await W.L.onCreated(SID, POS, W.now);
    eq(r.state, "pending"); eq(r.reason, "loi-mang"); eq(W.posts().length, 0);
  });
  await ta("D19 thiếu quyền stock.reconcile → no-permission, 0 POST, không gọi /warehouses", async () => {
    const W = world(); W.addSession(SID); W.perms = ["stock.view"];
    const r = await W.L.onCreated(SID, POS, W.now);
    eq(r.state, "no-permission"); eq(W.posts().length, 0); eq(W.log.filter(e => e.p === "/api/v1/warehouses").length, 0);
  });
  await ta("D20 POST 403 → no-permission", async () => {
    const W = world(); W.addSession(SID);
    W.faults["POST /api/v1/stock/reconciliations"] = { status: 403 };
    eq((await W.L.onCreated(SID, POS, W.now)).state, "no-permission");
  });
  await ta("D21 không có kho trùng tên → no-warehouse, 0 POST; đổi tên kho rồi Thử lại → linked", async () => {
    const W = world(); W.addSession(SID); W.stores[POS] = "CIRCA TÂM VIỆT";
    const r = await W.L.onCreated(SID, POS, W.now);
    eq(r.state, "no-warehouse"); eq(r.reason, "none"); ok(/CIRCA TÂM VIỆT/.test(r.msg)); eq(W.posts().length, 0);
    W.warehouses.push({ id: "a1a1a1a1-0000-4000-8000-00000000000a", name: "CIRCA TÂM VIỆT", locationType: "warehouse", closedAt: null });
    const r2 = await W.L.retry(SID);
    eq(r2.state, "linked"); eq(W.posts().length, 1); eq(W.posts()[0].body.warehouseId, "a1a1a1a1-0000-4000-8000-00000000000a");
  });
  await ta("D22 2 kho trùng tên → no-warehouse (many), 0 POST", async () => {
    const W = world(); W.addSession(SID);
    W.warehouses.push(whx("a1a1a1a1-0000-4000-8000-00000000000d", "circa lumina", "warehouse"));
    const r = await W.L.onCreated(SID, POS, W.now);
    eq(r.state, "no-warehouse"); eq(r.reason, "many"); eq(W.posts().length, 0);
  });
  await ta("D23 2 phiên NW cùng notes → conflict, 0 POST; phiên NW theo notes ở kho khác → conflict", async () => {
    const W = world(); W.addSession(SID);
    W.addRec({ notes: "CIRCA ICS00242 " + SID }); W.addRec({ notes: "CIRCA ICS00242 " + SID });
    eq((await W.L.onCreated(SID, POS, W.now)).state, "conflict"); eq(W.posts().length, 0);
    const W2 = world(); W2.addSession(SID);
    W2.addRec({ notes: "CIRCA ICS00242 " + SID, warehouse: { id: "a1a1a1a1-0000-4000-8000-000000000002", name: "CIRCA FLORITA" } });
    eq((await W2.L.onCreated(SID, POS, W2.now)).state, "conflict"); eq(W2.posts().length, 0);
  });
  await ta("D24 POST trả phiên có notes khác → conflict (không liên kết)", async () => {
    const W = world(); W.addSession(SID);
    W.faults["POST /api/v1/stock/reconciliations"] = [{ status: 201, body: { id: NWID, status: "in_progress", notes: "THU-CHONG-TRUNG" } }];
    eq((await W.L.onCreated(SID, POS, W.now)).state, "conflict");
  });
  await ta("D25 probe phiên cũ chưa liên kết → unlinked (chỉ hỏi), 0 POST, không ghi storage; ask → tạo (bỏ điều kiện 10 phút)", async () => {
    const W = world(); W.addSession(SID, { created_at: new Date(W.now - 3 * 86400000).toISOString() });
    const p = await W.L.probe(SID, POS);
    eq(p.state, "unlinked"); eq(p.nwChecked, true); eq(W.posts().length, 0); eq(W.mem.size, 0);
    const a = await W.L.ask(SID, POS);
    eq(a.state, "linked"); eq(W.posts().length, 1); eq(a.mode, "ask");
  });
  await ta("D26 probe: đã có phiên NW theo notes (đúng kho) → linked, 0 POST; kho khác tên → conflict", async () => {
    const W = world(); W.addSession(SID, { created_at: new Date(W.now - 86400000).toISOString() });
    const ex = W.addRec({ notes: "CIRCA ICS00242 " + SID });
    const p = await W.L.probe(SID, POS);
    eq(p.state, "linked"); eq(p.nwId, ex.id); eq(W.posts().length, 0);
    const W2 = world(); W2.addSession(SID);
    W2.addRec({ notes: "CIRCA ICS00242 " + SID, warehouse: { id: "a1a1a1a1-0000-4000-8000-000000000002", name: "CIRCA FLORITA" } });
    eq((await W2.L.probe(SID, POS)).state, "conflict"); eq(W2.mem.size, 0);
  });
  await ta("D27 probe: không có tab NW → unlinked (nwChecked false), 0 POST; phiên RFID → skipped; không pos → unknown-store", async () => {
    const W = world(); W.addSession(SID); W.tokens.nw = null;
    const p = await W.L.probe(SID, POS);
    eq(p.state, "unlinked"); eq(p.nwChecked, false); eq(W.posts().length, 0);
    const W2 = world(); W2.addSession(SID, { counting_mode: "RFID" });
    eq((await W2.L.probe(SID, POS)).state, "skipped"); eq(W2.nwCalls().length, 0);
    eq((await W2.L.probe(SID2, null)).state, "unknown-store");
  });
  await ta("D28 ask phiên RFID → skipped, 0 POST; ask phiên CLOSED → không tạo", async () => {
    const W = world(); W.addSession(SID, { counting_mode: "RFID" });
    eq((await W.L.ask(SID, POS)).state, "skipped"); eq(W.posts().length, 0);
    const W2 = world(); W2.addSession(SID, { status: "CLOSED" });
    eq((await W2.L.ask(SID, POS)).state, "closed"); eq(W2.posts().length, 0);
  });
  await ta("D29 Circa 401 khi tự tạo → pending circa-tab (chưa duyệt); mở lại admin → kiểm cửa sổ theo lúc thấy → linked", async () => {
    const W = world(); W.addSession(SID); W.tokens.circa = null;
    const r = await W.L.onCreated(SID, POS, W.now);
    eq(r.state, "pending"); eq(r.reason, "circa-tab"); eq(W.nwCalls().length, 0);
    W.tokens.circa = TOK.circa; W.now += 30 * 60000;
    const out = await W.L.onAdminTab();
    eq(out[0].state, "linked"); eq(W.posts().length, 1);
  });
  await ta("D30 Circa 401 khi tự tạo, phiên thật ra đã > 10 phút trước lúc thấy → không tạo", async () => {
    const W = world(); W.addSession(SID, { created_at: new Date(W.now - 15 * 60000).toISOString() }); W.tokens.circa = null;
    await W.L.onCreated(SID, POS, W.now);
    W.tokens.circa = TOK.circa;
    const out = await W.L.onAdminTab();
    eq(out[0].state, "ignored"); eq(W.posts().length, 0);
  });
  await ta("D31 bản ghi 'linking' bị bỏ dở (service worker dừng) → linker MỚI: probe đánh dấu pending gián đoạn; Thử lại an toàn", async () => {
    const W = world(); W.addSession(SID);
    W.faults["POST /api/v1/stock/reconciliations"] = [{ status: 500, record: true }];
    await W.L.onCreated(SID, POS, W.now);
    const k = KKLINK.KEY + SID, rec = JSON.parse(W.mem.get(k));
    rec.state = "linking"; rec.updatedAt = new Date(W.now - 5 * 60000).toISOString(); W.mem.set(k, JSON.stringify(rec));
    const L2 = W.newLinker(); // service worker khởi động lại: không còn khoá / bộ đệm / lastAuto trong bộ nhớ
    const p = await L2.probe(SID, POS);
    eq(p.state, "pending"); eq(p.reason, "gian-doan");
    const r = await L2.retry(SID);
    eq(r.state, "linked"); eq(r.created, false, "đã ghi trước khi gián đoạn: tìm thấy theo notes"); eq(W.recs.length, 1); eq(W.posts().length, 1);
  });
  await ta("D32 view() không có token, chỉ trường hiển thị", async () => {
    const W = world(); W.addSession(SID);
    const r = await W.L.onCreated(SID, POS, W.now);
    const v = KKLINK.view(Object.assign({}, r, { secret: "x", history: [1] }));
    eq(v.secret, undefined); eq(v.history, undefined); eq(v.nwId, r.nwId);
  });
  await ta("D33 mọi lệnh link.js gửi đều qua bảng API (không lệnh nào ngoài 8 lệnh luồng A)", async () => {
    const W = world(); W.addSession(SID);
    await W.L.onCreated(SID, POS, W.now);
    const kinds = [...new Set(W.log.map(e => e.m + " " + e.p.replace(/[0-9a-f-]{36}/g, ":id")))].sort();
    deq(kinds, ["GET /api/v1/auth/me", "GET /api/v1/stock/reconciliations", "GET /api/v1/warehouses", "GET /v1/entity/stores/:id", "GET /v1/inventory/count/sessions/:id", "POST /api/v1/stock/reconciliations"]);
  });
  await ta("D34 /auth/me dạng THẬT (permissions object + permissionNames có stock.reconcile) → linked (trước đây luôn báo thiếu quyền)", async () => {
    for (const shape of ["real", "objectsOnly", "strings"]) {
      const W = world(); W.addSession(SID); W.meShape = shape;
      const r = await W.L.onCreated(SID, POS, W.now);
      eq(r.state, "linked", shape + ": " + r.msg); ok(!/Không đọc được danh sách quyền/.test(r.msg), shape + ": đọc được quyền"); eq(W.posts().length, 1);
    }
    const W2 = world(); W2.addSession(SID); W2.perms = ["stock.view", "warehouse.view"];
    eq((await W2.L.onCreated(SID, POS, W2.now)).state, "no-permission"); eq(W2.posts().length, 0);
  });
  await ta("D35 NW KHÔNG chống trùng clientOperationId + danh sách notes đầy (60 phiên khác) → vẫn đúng 1 phiên NW", async () => {
    const W = world(); W.addSession(SID); W.noDedupe = true;
    for (let i = 0; i < 60; i++) W.addRec({ notes: "CIRCA ICS0" + (1000 + i) + " " + crypto.randomUUID() });
    const r = await W.L.onCreated(SID, POS, W.now);
    eq(r.state, "linked"); eq(W.posts().length, 1);
    // mất storage + SW khởi động lại, kích hoạt lại / hỏi / thử lại → tìm theo notes (trang 1 vì mới nhất), 0 POST thêm
    W.mem.clear(); W.newLinker();
    eq((await W.L.onCreated(SID, POS, W.now)).created, false);
    W.mem.clear(); W.newLinker();
    eq((await W.L.ask(SID, POS)).state, "linked");
    eq(W.posts().length, 1); eq(W.recs.filter(x => KKLINK.notesHas(x.notes, SID)).length, 1);
    // POST lỗi mạng nhưng NW đã ghi (không chống trùng) → Thử lại tìm theo notes trước → vẫn 1 phiên
    const W2 = world(); W2.addSession(SID); W2.noDedupe = true;
    W2.faults["POST /api/v1/stock/reconciliations"] = [{ throw: "ECONNRESET", record: true }];
    eq((await W2.L.onCreated(SID, POS, W2.now)).reason, "loi-mang");
    const r2 = await W2.L.retry(SID);
    eq(r2.state, "linked"); eq(r2.created, false); eq(W2.posts().length, 1); eq(W2.recs.length, 1);
  });
  await ta("D36 danh sách phiên NW không có totalPages → DỪNG, 0 POST (không coi là 1 trang); meta.totalPages → dùng được", async () => {
    const W = world(); W.addSession(SID); W.noTotalPages = true;
    const r = await W.L.onCreated(SID, POS, W.now);
    eq(r.state, "error"); eq(r.reason, "nw-list"); ok(/totalPages/.test(r.msg)); eq(W.posts().length, 0);
    eq((await W.L.retry(SID)).state, "error"); eq(W.posts().length, 0);
    const p = await world().L.probe(SID, POS); ok(p); // không ném lỗi
    const W1 = world(); W1.addSession(SID); W1.noTotalPages = true;
    const pr = await W1.L.probe(SID, POS);
    eq(pr.state, "unlinked"); eq(pr.nwChecked, false); eq(W1.posts().length, 0);
    const W2 = world(); W2.addSession(SID); W2.metaTotalPages = true;
    for (let i = 0; i < 30; i++) W2.addRec({ notes: "khác " + i });
    const r2 = await W2.L.onCreated(SID, POS, W2.now);
    eq(r2.state, "linked"); eq(W2.posts().length, 1);
    deq(W2.log.filter(e => e.p === "/api/v1/stock/reconciliations" && e.m === "GET").map(e => e.q.page), ["1", "2"]);
  });
  await ta("D37 phiên NW liên kết (theo notes) đã huỷ / hoàn tất / duyệt → nw-closed, KHÔNG tạo phiên khác (onCreated, retry, ask, probe)", async () => {
    for (const st of ["cancelled", "completed", "approved"]) {
      const W = world(); W.addSession(SID);
      const ex = W.addRec({ notes: "CIRCA ICS00242 " + SID, status: st });
      const r = await W.L.onCreated(SID, POS, W.now);
      eq(r.state, "nw-closed", st); eq(r.nwId, ex.id); eq(r.nwStatus, st); eq(W.posts().length, 0);
      eq((await W.L.retry(SID)).state, "nw-closed"); eq((await W.L.ask(SID, POS)).state, "nw-closed"); eq((await W.L.onCreated(SID, POS, W.now)).state, "nw-closed");
      eq(W.posts().length, 0);
    }
    // phiên đã liên kết rồi NW huỷ: probe từ URL (bản ghi mất) → nw-closed
    const W2 = world(); W2.addSession(SID);
    const r = await W2.L.onCreated(SID, POS, W2.now); eq(r.state, "linked");
    W2.recs[0].status = "cancelled"; W2.mem.clear(); W2.newLinker();
    const p = await W2.L.probe(SID, POS);
    eq(p.state, "nw-closed"); eq(p.nwStatus, "cancelled"); eq(W2.posts().length, 1);
    eq((await W2.L.ask(SID, POS)).state, "nw-closed"); eq(W2.posts().length, 1);
  });
  await ta("D38 phiên NW theo notes không có kho (warehouseId / warehouse) → conflict, 0 POST; chỉ có warehouseId đúng kho → linked", async () => {
    const W = world(); W.addSession(SID);
    W.addRec({ notes: "CIRCA ICS00242 " + SID, noWarehouse: true });
    eq((await W.L.onCreated(SID, POS, W.now)).state, "conflict"); eq(W.posts().length, 0);
    const W1 = world(); W1.addSession(SID, { created_at: new Date(W1.now - 86400000).toISOString() });
    W1.addRec({ notes: "CIRCA ICS00242 " + SID, noWarehouse: true });
    eq((await W1.L.probe(SID, POS)).state, "conflict"); eq(W1.mem.size, 0);
    const W2 = world(); W2.addSession(SID);
    const ex = W2.addRec({ notes: "CIRCA ICS00242 " + SID, noWarehouse: true }); ex.warehouseId = WHL;
    eq((await W2.L.onCreated(SID, POS, W2.now)).nwId, ex.id); eq(W2.posts().length, 0);
  });
  await ta("D39 POST trả scopeType khác warehouse / kho khác / không có kho → conflict (không liên kết)", async () => {
    const bodies = [
      { id: NWID, status: "in_progress", notes: "CIRCA ICS00242 " + SID, scopeType: "product", warehouseId: WHL },
      { id: NWID, status: "in_progress", notes: "CIRCA ICS00242 " + SID, scopeType: "warehouse", warehouseId: "a1a1a1a1-0000-4000-8000-000000000002", warehouse: { id: "a1a1a1a1-0000-4000-8000-000000000002" } },
      { id: NWID, status: "in_progress", notes: "CIRCA ICS00242 " + SID, scopeType: "warehouse" }
    ];
    for (const b of bodies) {
      const W = world(); W.addSession(SID);
      W.faults["POST /api/v1/stock/reconciliations"] = [{ status: 201, body: b }];
      const r = await W.L.onCreated(SID, POS, W.now);
      eq(r.state, "conflict", JSON.stringify(b)); eq(r.reason, "nw-post");
    }
  });
  await ta("D40 kho dạng cây: cửa hàng trùng tên kho CON → tạo ở kho con; kho con trùng tên kho gốc → no-warehouse many, 0 POST", async () => {
    const W = world(); W.addSession(SID); W.stores[POS] = "CIRCA KHO CON"; W.warehouses = nested("CIRCA KHO CON");
    const r = await W.L.onCreated(SID, POS, W.now);
    eq(r.state, "linked"); eq(W.posts()[0].body.warehouseId, WH_CHILD);
    const W2 = world(); W2.addSession(SID); W2.warehouses = nested("CIRCA LUMINA");
    const r2 = await W2.L.onCreated(SID, POS, W2.now);
    eq(r2.state, "no-warehouse"); eq(r2.reason, "many"); eq(W2.posts().length, 0);
  });
  await ta("D41 probe thấy phiên NW theo notes nhưng không còn kho trùng tên cửa hàng → conflict, không ghi", async () => {
    const W = world(); W.addSession(SID); W.stores[POS] = "CIRCA ĐỔI TÊN";
    W.addRec({ notes: "CIRCA ICS00242 " + SID });
    const p = await W.L.probe(SID, POS);
    eq(p.state, "conflict"); eq(W.mem.size, 0); eq(W.posts().length, 0);
  });
  await ta("D42 probe với giới hạn tần suất: lần tra mới thứ N+1 trong cửa sổ → rate-limited, 0 lệnh gọi", async () => {
    const W = world(); let n = 0;
    const L = KKLINK.createLinker({ api: W.api, store: W.store, cfg: CFG, now: () => W.now, rate: KKLINK.createRateLimiter({ now: () => n, max: 3, windowMs: 60000 }) });
    for (let i = 0; i < 3; i++) eq((await L.probe(crypto.randomUUID(), POS, { rateKey: 5 })).state, "error");
    const before = W.log.length;
    eq((await L.probe(crypto.randomUUID(), POS, { rateKey: 5 })).state, "rate-limited");
    eq(W.log.length, before); eq(W.mem.size, 0, "tin rác không ghi bản ghi");
  });
}

// ================= E. bridge =================
async function partE() {
  await ta("E đọc token NW từ localStorage auth-storage; hỏng / thiếu → null", async () => {
    const run = (ls) => { const g = { window: { localStorage: { getItem: k => ls[k] == null ? null : ls[k] } }, JSON }; return vm.runInNewContext("(" + KKBRIDGE.kkReadNwToken.toString() + ")()", g); };
    eq(run({ "auth-storage": JSON.stringify({ state: { accessToken: "abc.def.ghi" } }) }), "abc.def.ghi");
    eq(run({}), null); eq(run({ "auth-storage": "{hỏng" }), null); eq(run({ "auth-storage": JSON.stringify({ state: {} }) }), null);
    eq(run({ "auth-storage": JSON.stringify({ state: { accessToken: 5 } }) }), null);
  });
  await ta("E đọc cookie session_token (giải mã %), không nhầm cookie khác", async () => {
    const run = (c) => vm.runInNewContext("(" + KKBRIDGE.kkReadCircaToken.toString() + ")()", { document: { cookie: c }, decodeURIComponent, String });
    eq(run("a=1; session_token=abc%2Edef; b=2"), "abc.def"); eq(run("my_session_token=x"), null); eq(run(""), null);
  });
  await ta("E createBridge: không có tab → no-tab; JWT hết hạn → token-expired; tab sau có token → dùng", async () => {
    const X = require("./mock-ext-server.js");
    const now = Date.now(), live = X.fakeJwt(Math.floor(now / 1000) + 3600), dead = X.fakeJwt(Math.floor(now / 1000) - 10);
    let tabs = [], results = {};
    const br = KKBRIDGE.createBridge({ cfg: CFG, now: () => now, tabs: { query: async q => { ok(q.url === CFG.NW_APP + "/*" || q.url === CFG.CIRCA_ADMIN + "/*"); return tabs; } },
      scripting: { executeScript: async o => { eq(o.world, undefined, "phải chạy world ISOLATED (mặc định)"); return [{ result: results[o.target.tabId] }]; } } });
    eq((await br.readToken("nw")).err, "no-tab");
    tabs = [{ id: 1, active: true }]; results = { 1: dead };
    eq((await br.readToken("nw")).err, "token-expired");
    tabs = [{ id: 1, active: true }, { id: 2, active: false, lastAccessed: 5 }]; results = { 1: dead, 2: live };
    eq((await br.readToken("nw")).token, live);
    results = { 1: null, 2: null };
    eq((await br.readToken("nw")).err, "no-token");
    eq((await br.readToken("khac")).err, "no-token");
    eq(KKBRIDGE.jwtExpMs("khong-phai-jwt"), null);
  });
}

// ================= F. watch-circa.js =================
function loadWatch(win) { vm.runInNewContext(fs.readFileSync(path.join(EXT, "watch-circa.js"), "utf8"), { window: win, JSON, WeakMap, String, Object, Array, Error }); }
function fakeWin() {
  const posted = [];
  const W = {
    location: { origin: CFG.CIRCA_ADMIN, href: CFG.CIRCA_ADMIN + "/kiem-ke-ton-kho" }, URL, Promise,
    postMessage: function (m, o) { posted.push({ m: JSON.parse(JSON.stringify(m)), o }); }, posted
  };
  return W;
}
function watchUnhandled() {
  const ev = [], on = (reason, promise) => { ev.push({ reason, promise }); };
  process.on("unhandledRejection", on);
  return { ev, off: () => process.removeListener("unhandledRejection", on) };
}
function resp(status, obj, opts) {
  opts = opts || {};
  return { status, clone: () => { if (opts.cloneThrows) throw new Error("clone hỏng"); return { text: async () => typeof obj === "string" ? obj : JSON.stringify(obj) }; }, marker: opts.marker };
}
const tick = () => new Promise(r => setTimeout(r, 5));
async function partF() {
  await ta("F fetch: request cần quan sát → Promise gương resolve ĐÚNG Response gốc, giữ this/đối số; POST tạo phiên 200 → created {id, pos}", async () => {
    const W = fakeWin(), calls = [];
    let orig, origResp;
    W.fetch = function (u, i) { calls.push({ self: this, args: [].slice.call(arguments) }); origResp = resp(200, { success: true, data: { session: { id: SID.toUpperCase(), pos_id: POS, code: "ICS1" } } }); orig = Promise.resolve(origResp); return orig; };
    loadWatch(W);
    const init = { method: "POST", body: JSON.stringify({ pos_id: POS }), headers: { "Content-Type": "application/json" } };
    const p = W.fetch.call(W, CFG.CIRCA_API + "/v1/inventory/count/sessions", init);
    ok(p instanceof Promise, "trả Promise (dựng bằng Promise của trang)");
    eq(calls[0].self, W); eq(calls[0].args[1], init); eq(calls[0].args.length, 2);
    ok((await p) === origResp, "resolve đúng đối tượng Response gốc");
    await tick();
    deq(W.posted.map(x => x.m), [{ kind: "created", id: SID, pos: POS, kk: "kk-circa-nw-1" }]);
    eq(W.posted[0].o, CFG.CIRCA_ADMIN, "postMessage chỉ tới cùng origin");
  });
  await ta("F fetch: request KHÔNG cần quan sát → trả ĐÚNG Promise gốc (không bọc)", async () => {
    const W = fakeWin(); let orig;
    W.fetch = () => (orig = Promise.resolve(resp(200, {})));
    loadWatch(W);
    for (const [m, u] of [["GET", CFG.CIRCA_API + "/v1/authz/me"], ["GET", CFG.CIRCA_API + "/v1/inventory/count/sessions?page=1"], ["POST", "https://evil.example/v1/inventory/count/sessions"],
      ["GET", CFG.CIRCA_ADMIN + "/x"], ["POST", CFG.CIRCA_API + "/v1/inventory/count/submit-rfid-batch"], ["GET", CFG.CIRCA_API + "/v1/inventory/count/sessions/" + SID + "/scans"]]) {
      const p = W.fetch(u, { method: m }); ok(p === orig, m + " " + u);
    }
  });
  await ta("F fetch: lỗi trang KHÔNG bắt vẫn tới trang (unhandledrejection đúng 1 lần, cùng lý do, đúng Promise trang nhận); trang bắt → 0", async () => {
    const U = watchUnhandled();
    try {
      const err = new Error("mạng hỏng (giả)"); let mk = () => Promise.reject(err), orig;
      const W = fakeWin(); W.fetch = () => (orig = mk()); loadWatch(W);
      // 1) request cần quan sát, trang không bắt
      const p1 = W.fetch(CFG.CIRCA_API + "/v1/inventory/count/sessions", { method: "POST" });
      await tick(); await tick();
      eq(U.ev.length, 1, "đúng 1 unhandledrejection"); eq(U.ev[0].reason, err); ok(U.ev[0].promise === p1, "trên đúng Promise trang nhận");
      ok(U.ev[0].promise !== orig, "Promise gốc đã được phần quan sát xử lý, không báo 2 lần");
      p1.catch(() => {}); U.ev.length = 0;
      // 2) trang bắt lỗi → 0
      const p2 = W.fetch(CFG.CIRCA_API + "/v1/inventory/count/sessions/" + SID);
      await assert.rejects(p2, e => e === err);
      await tick(); await tick(); eq(U.ev.length, 0);
      // 3) request không cần quan sát, trang không bắt → 1 sự kiện trên chính Promise gốc (như không có extension)
      const p3 = W.fetch(CFG.CIRCA_API + "/v1/authz/me");
      ok(p3 === orig);
      await tick(); await tick();
      eq(U.ev.length, 1); ok(U.ev[0].promise === p3); eq(U.ev[0].reason, err);
      p3.catch(() => {});
      // 4) đối chứng: không có extension → cùng hành vi (1 sự kiện, cùng lý do)
      U.ev.length = 0; const base = mk(); await tick(); await tick();
      eq(U.ev.length, 1); eq(U.ev[0].reason, err); base.catch(() => {});
      await tick();
    } finally { U.off(); }
  });
  await ta("F fetch: GET phiên → seen; GET danh sách phiên / host khác / 500 → không báo; header X-Store-Id → store", async () => {
    const W = fakeWin();
    W.fetch = (u) => Promise.resolve(/sessions\/[0-9a-f-]{36}$/.test(String(u)) && !/evil/.test(String(u)) ? resp(200, { data: { session: { id: SID, pos_id: POS } } }) : /five/.test(String(u)) ? resp(500, {}) : resp(200, { data: { session: { id: SID, pos_id: POS } } }));
    loadWatch(W);
    await W.fetch(CFG.CIRCA_API + "/v1/inventory/count/sessions/" + SID); await tick();
    await W.fetch(CFG.CIRCA_API + "/v1/inventory/count/sessions?page=1&limit=20"); await tick();
    await W.fetch("https://evil.example/v1/inventory/count/sessions/" + SID); await tick();
    await W.fetch(CFG.CIRCA_API + "/v1/inventory/count/sessions/" + SID + "?five=1", { method: "GET" }); await tick();
    await W.fetch(CFG.CIRCA_API + "/v1/authz/me", { headers: { "X-Store-Id": POS } }); await tick();
    await W.fetch(CFG.CIRCA_API + "/v1/authz/me", { headers: { "x-store-id": "không-phải-uuid" } }); await tick();
    deq(W.posted.map(x => x.m.kind), ["seen", "store"]);
    eq(W.posted[0].m.id, SID); eq(W.posted[1].m.pos, POS);
  });
  await ta("F fetch: lỗi trong phần quan sát (clone hỏng, JSON hỏng, postMessage hỏng) bị nuốt; Promise bị từ chối vẫn trả nguyên cho trang", async () => {
    const W = fakeWin();
    let unhandled = 0; const onU = () => { unhandled++; }; process.on("unhandledRejection", onU);
    W.postMessage = () => { throw new Error("hỏng"); };
    const rej = Promise.reject(new Error("mạng hỏng")); rej.catch(() => {});
    let n = 0;
    W.fetch = () => { n++; return n === 1 ? Promise.resolve(resp(200, {}, { cloneThrows: true })) : n === 2 ? Promise.resolve(resp(200, "{hỏng")) : n === 3 ? rej : Promise.resolve(resp(200, { data: { session: { id: SID, pos_id: POS } } })); };
    loadWatch(W);
    await W.fetch(CFG.CIRCA_API + "/v1/inventory/count/sessions", { method: "POST" });
    await W.fetch(CFG.CIRCA_API + "/v1/inventory/count/sessions", { method: "POST" });
    const p3 = W.fetch(CFG.CIRCA_API + "/v1/inventory/count/sessions", { method: "POST" });
    ok(p3 !== rej, "request cần quan sát → Promise gương");
    await assert.rejects(p3, /mạng hỏng/);
    await W.fetch(CFG.CIRCA_API + "/v1/inventory/count/sessions", { method: "POST" });
    await tick(); await tick();
    process.removeListener("unhandledRejection", onU);
    eq(unhandled, 0);
  });
  await ta("F fetch: Request object (url + method trên Request) vẫn nhận ra", async () => {
    const W = fakeWin();
    W.fetch = () => Promise.resolve(resp(201, { data: { session: { id: SID, pos_id: POS } } }));
    loadWatch(W);
    await W.fetch({ url: CFG.CIRCA_API + "/v1/inventory/count/sessions", method: "POST", headers: null }); await tick();
    eq(W.posted[0].m.kind, "created");
  });
  await ta("F XHR: gọi open/send/setRequestHeader gốc đúng đối số; loadend 200 → created; X-Store-Id → store", async () => {
    const W = fakeWin(), log = [];
    function XHR() { this.l = {}; this.status = 0; this.responseType = ""; this.responseText = ""; }
    XHR.prototype.open = function () { log.push(["open", [].slice.call(arguments)]); return "open-ret"; };
    XHR.prototype.send = function (b) { log.push(["send", b]); return "send-ret"; };
    XHR.prototype.setRequestHeader = function (k, v) { log.push(["set", k, v]); };
    XHR.prototype.addEventListener = function (ev, fn) { (this.l[ev] = this.l[ev] || []).push(fn); };
    W.XMLHttpRequest = XHR;
    loadWatch(W);
    const x = new W.XMLHttpRequest();
    eq(x.open("POST", CFG.CIRCA_API + "/v1/inventory/count/sessions", true), "open-ret");
    x.setRequestHeader("X-Store-Id", POS);
    const body = JSON.stringify({ pos_id: POS });
    eq(x.send(body), "send-ret");
    deq(log, [["open", ["POST", CFG.CIRCA_API + "/v1/inventory/count/sessions", true]], ["set", "X-Store-Id", POS], ["send", body]]);
    x.status = 200; x.responseText = JSON.stringify({ success: true, data: { session: { id: SID, pos_id: POS } } });
    x.l.loadend.forEach(f => f());
    deq(W.posted.map(p => p.m.kind), ["store", "created"]);
    const y = new W.XMLHttpRequest();
    y.open("POST", CFG.CIRCA_API + "/v1/inventory/count/sessions"); y.send("{}"); y.status = 400; y.responseText = "{}";
    y.l.loadend.forEach(f => f());
    const z = new W.XMLHttpRequest();
    z.open("GET", "/v1/inventory/count/sessions/" + SID); z.send(null);
    eq(z.l.loadend, undefined, "đường dẫn tương đối thuộc origin admin, không phải API → không theo dõi");
    eq(W.posted.length, 2);
  });
}

// ================= H. background.js trong vm (chrome.* giả, máy chủ giả của phần D) =================
// Nạp background.js THẬT + importScripts các file thật của ext/. cfgOver: ghi đè vài hằng số (rút ngắn thời gian chờ).
function swWorld(W, cfgOver) {
  const L = { msg: [], web: [], upd: [], rm: [] }, local = new Map(), session = new Map(), created = [], updated = [];
  const tabs = [{ id: 11, url: CFG.CIRCA_ADMIN + "/kiem-ke-ton-kho", index: 0, windowId: 1, active: true }, { id: 12, url: CFG.CIRCA_ADMIN + "/kiem-ke-ton-kho", index: 1, windowId: 1 },
    { id: 21, url: CFG.NW_APP + "/", index: 2, windowId: 1 }];
  const area = m => ({
    get: async k => { const o = {}; if (k == null) { for (const [a, b] of m) o[a] = JSON.parse(b); return o; } (Array.isArray(k) ? k : [k]).forEach(x => { if (m.has(x)) o[x] = JSON.parse(m.get(x)); }); return o; },
    set: async o => { for (const k of Object.keys(o)) m.set(k, JSON.stringify(o[k])); },
    remove: async k => { (Array.isArray(k) ? k : [k]).forEach(x => m.delete(x)); }
  });
  const EXT_ORIGIN = "chrome-extension://kkthu";
  const chrome = {
    runtime: { id: "kkthu", getURL: p => EXT_ORIGIN + "/" + p, onMessage: { addListener: f => L.msg.push(f) } },
    storage: { local: area(local), session: area(session) },
    tabs: {
      query: async q => tabs.filter(t => !q || !q.url || t.url.indexOf(q.url.replace(/\*$/, "")) === 0),
      get: async id => { const t = tabs.find(x => x.id === id); if (!t) throw new Error("No tab with id"); return t; },
      create: async o => { const t = { id: 100 + created.length, url: o.url, index: o.index, windowId: 1 }; created.push(o); tabs.push(t); return t; },
      update: async (id, o) => { updated.push({ id, o }); return tabs.find(x => x.id === id); },
      sendMessage: async () => {},
      onUpdated: { addListener: f => L.upd.push(f) }, onRemoved: { addListener: f => L.rm.push(f) }
    },
    windows: { update: async () => ({}) },
    scripting: { executeScript: async ({ func }) => [{ result: func.name === "kkReadNwToken" ? W.tokens.nw : W.tokens.circa }] },
    webRequest: { onCompleted: { addListener: (f, filter) => L.web.push({ f, filter }) } }
  };
  // chỉ đưa vào những gì SW có mà vm không có sẵn; Object/Array/Promise… dùng bản riêng của context (như một realm SW thật)
  const ctx = { chrome, fetch: (u, o) => W.fetchFn(u, o), setTimeout, clearTimeout, AbortController, URL, URLSearchParams,
    btoa: s => Buffer.from(s, "binary").toString("base64"), atob: s => Buffer.from(s, "base64").toString("binary") };
  ctx.self = ctx;
  ctx.importScripts = (...files) => files.forEach(f => {
    vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), ctx, { filename: f });
    if (f === "config.js" && cfgOver) ctx.KKCFG = Object.freeze(Object.assign({}, ctx.KKCFG, cfgOver));
  });
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(EXT, "background.js"), "utf8"), ctx, { filename: "background.js" });
  const PANEL = EXT_ORIGIN + "/panel.html";
  // tin nhắn tới SW thật được structured-clone sang realm của SW: giả bằng JSON.parse của context
  const inCtx = vm.runInContext("(function (s) { return JSON.parse(s); })", ctx), clone = o => inCtx(JSON.stringify(o));
  return {
    ctx, local, session, tabs, created, updated, L,
    send: (msg, sender) => new Promise(res => { let done = false; const keep = L.msg[0](clone(msg), clone(sender), r => { done = true; res(r === undefined ? r : JSON.parse(JSON.stringify(r))); }); if (!keep && !done) res("(không trả lời)"); }),
    admin: (tabId, id) => ({ id: "kkthu", tab: { id: tabId, url: CFG.CIRCA_ADMIN + "/kiem-ke-ton-kho/" + (id || SID), index: 0 }, frameId: 0, url: CFG.CIRCA_ADMIN + "/kiem-ke-ton-kho/" + (id || SID), origin: CFG.CIRCA_ADMIN }),
    panel: (tabId, id) => ({ id: "kkthu", tab: { id: tabId, url: PANEL + "?circa=" + (id || SID) }, url: PANEL + "?circa=" + (id || SID), origin: EXT_ORIGIN }),
    // sự kiện webRequest.onCompleted (mặc định: đúng lệnh tạo phiên của trang admin)
    web: (tabId, d) => L.web.forEach(x => x.f(Object.assign({ method: "POST", statusCode: 200, tabId, frameId: 0, url: CFG.CIRCA_API + "/v1/inventory/count/sessions", initiator: CFG.CIRCA_ADMIN, type: "xmlhttprequest" }, d || {}))),
    links: () => [...local.keys()].filter(k => k.indexOf("link:") === 0),
    PANEL
  };
}
async function partH() {
  const fresh = (W, id) => W.addSession(id || SID, { created_at: new Date(Date.now() - 60000).toISOString() });
  const FAST = { CREATE_GATE_WAIT_MS: 60 };
  await ta("H webRequest: lọc đúng URL tạo phiên Circa, loại xmlhttprequest; manifest có quyền webRequest", async () => {
    const W = world(), S = swWorld(W, FAST);
    eq(S.L.web.length, 1); eq(JSON.stringify(S.L.web[0].filter), JSON.stringify({ urls: [CFG.CIRCA_API + "/v1/inventory/count/sessions"], types: ["xmlhttprequest"] }));
    ok(JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8")).permissions.indexOf("webRequest") >= 0);
  });
  await ta("H tin 'created' GIẢ cho phiên QR THẬT (tạo 1 phút trước, đúng cửa hàng) KHÔNG có sự kiện webRequest → 0 POST, chỉ hỏi (unlinked), không ghi bản ghi", async () => {
    const W = world(), S = swWorld(W, FAST); fresh(W);
    const r = await S.send({ op: "created", id: SID, pos: POS }, S.admin(11));
    eq(r.ok, true); eq(r.gated, false); eq(r.v.state, "unlinked", r.v.msg); eq(W.posts().length, 0); deq(S.links(), []);
  });
  await ta("H có sự kiện webRequest (POST 200 từ chính tab đó) → tự tạo 1 phiên NW (linked)", async () => {
    const W = world(), S = swWorld(W, FAST); fresh(W);
    S.web(11);
    const r = await S.send({ op: "created", id: SID, pos: POS }, S.admin(11));
    eq(r.gated, true); eq(r.v.state, "linked", r.v.msg); eq(W.posts().length, 1);
    eq((await S.send({ op: "created", id: SID, pos: POS }, S.admin(11))).v.state, "linked", "tin lặp cùng phiên"); eq(W.posts().length, 1);
  });
  await ta("H sự kiện webRequest sai (tab khác, status 201/500, GET, URL có query, initiator khác, khung con, tabId -1) → không nhận → 0 POST", async () => {
    const bad = [[12, {}], [11, { statusCode: 201 }], [11, { statusCode: 500 }], [11, { method: "GET" }], [11, { url: CFG.CIRCA_API + "/v1/inventory/count/sessions?x=1" }],
      [11, { initiator: "https://evil.example" }], [11, { initiator: undefined }], [11, { frameId: 3 }], [-1, {}]];
    for (const [tab, d] of bad) {
      const W = world(), S = swWorld(W, FAST); fresh(W);
      S.web(tab, d);
      const r = await S.send({ op: "created", id: SID, pos: POS }, S.admin(11));
      eq(r.gated, false, JSON.stringify([tab, d])); eq(W.posts().length, 0);
    }
  });
  await ta("H mỗi sự kiện dùng cho 1 sessionId: tin 'created' thứ 2 (phiên khác, cũng thật) → chỉ hỏi, 0 POST thêm", async () => {
    const W = world(), S = swWorld(W, FAST); fresh(W, SID); fresh(W, SID2);
    S.web(11);
    eq((await S.send({ op: "created", id: SID, pos: POS }, S.admin(11))).v.state, "linked");
    const r2 = await S.send({ op: "created", id: SID2, pos: POS }, S.admin(11));
    eq(r2.gated, false); eq(r2.v.state, "unlinked"); eq(W.posts().length, 1);
  });
  await ta("H sự kiện quá CREATE_GATE_MS → không nhận", async () => {
    const W = world(), S = swWorld(W, Object.assign({}, FAST, { CREATE_GATE_MS: 100 })); fresh(W);
    S.web(11); await new Promise(r => setTimeout(r, 250));
    const r = await S.send({ op: "created", id: SID, pos: POS }, S.admin(11));
    eq(r.gated, false); eq(W.posts().length, 0);
  });
  await ta("H tin rác (40 'created' + 40 'status' uuid ngẫu nhiên từ 1 tab) → không ghi bản ghi; lệnh GET Circa bị giới hạn (≤ 10 + 20)", async () => {
    const W = world(), S = swWorld(W, FAST);
    const rs = [];
    for (let i = 0; i < 40; i++) rs.push(await S.send({ op: "created", id: crypto.randomUUID(), pos: POS }, S.admin(12)));
    const g1 = W.log.filter(e => e.side === "circa").length;
    for (let i = 0; i < 40; i++) rs.push(await S.send({ op: "status", id: crypto.randomUUID(), pos: POS }, S.admin(12)));
    const g2 = W.log.filter(e => e.side === "circa").length;
    deq(S.links(), []); eq(W.nwCalls().length, 0);
    ok(g1 <= 10, "GET Circa do 'created' rác: " + g1); ok(g2 <= 20, "tổng GET Circa: " + g2 + " (probe chung giới hạn 20/phút/tab)");
    ok(rs.filter(r => r.v && r.v.state === "rate-limited").length >= 40, "phần lớn tin bị chặn tần suất");
    // tab khác không bị ảnh hưởng
    fresh(W);
    eq((await S.send({ op: "status", id: SID, pos: POS }, S.admin(11))).v.state, "unlinked");
  });
  await ta("H người gửi lạ (id extension khác, khung con, trang khác origin) → bỏ qua, không trả lời", async () => {
    const W = world(), S = swWorld(W, FAST); fresh(W); S.web(11);
    const a = S.admin(11);
    eq(await S.send({ op: "created", id: SID, pos: POS }, Object.assign({}, a, { id: "khac" })), "(không trả lời)");
    eq(await S.send({ op: "created", id: SID, pos: POS }, Object.assign({}, a, { frameId: 2 })), "(không trả lời)");
    eq(await S.send({ op: "created", id: SID, pos: POS }, Object.assign({}, a, { url: "https://evil.example/", origin: "https://evil.example" })), "(không trả lời)");
    eq(W.log.length, 0);
  });
  await ta("H khoá gửi theo phiên: panel B bị từ chối khi panel A giữ khoá; submit không giữ khoá → từ chối (không gọi mạng); đóng tab → nhả khoá", async () => {
    const W = world(), S = swWorld(W, FAST); fresh(W); S.web(11);
    eq((await S.send({ op: "created", id: SID, pos: POS }, S.admin(11))).v.state, "linked");
    const A = S.panel(31), B2 = S.panel(32); S.tabs.push({ id: 31, url: A.url, windowId: 1 }, { id: 32, url: B2.url, windowId: 1 });
    const body = { session_id: SID, device_id: "NW-RFID", tags: ["AB0001"] };
    const n0 = W.log.length;
    const s0 = await S.send({ op: "submit", id: SID, body }, A); eq(s0.ok, false); eq(s0.refused, true); eq(W.log.length, n0, "chưa giữ khoá → không gọi mạng");
    eq((await S.send({ op: "beginSend", id: SID }, A)).ok, true);
    const b1 = await S.send({ op: "beginSend", id: SID }, B2); eq(b1.ok, false); ok(/panel khác/.test(b1.msg));
    const s1 = await S.send({ op: "submit", id: SID, body }, B2); eq(s1.ok, false); eq(W.log.length, n0);
    const s2 = await S.send({ op: "submit", id: SID, body }, A); eq(s2.ok, true); ok(W.log.length > n0, "panel giữ khoá gửi được");
    eq((await S.send({ op: "beginSend", id: SID }, A)).ok, true, "cùng tab lấy lại được");
    await S.send({ op: "endSend", id: SID }, B2); eq((await S.send({ op: "beginSend", id: SID }, B2)).ok, false, "tab khác không nhả được khoá");
    await S.send({ op: "endSend", id: SID }, A);
    eq((await S.send({ op: "beginSend", id: SID }, B2)).ok, true);
    // tab B đóng → khoá nhả
    S.L.rm.forEach(f => f(32)); await new Promise(r => setTimeout(r, 20));
    eq((await S.send({ op: "beginSend", id: SID }, A)).ok, true);
    // tab giữ khoá đã chết (không còn trong tabs) → tab khác chiếm được
    S.tabs.splice(S.tabs.findIndex(t => t.id === 31), 1);
    eq((await S.send({ op: "beginSend", id: SID }, S.panel(33))).ok, true);
  });
  await ta("H openPanel: chưa có tab panel → mở 1 tab; bấm lại → chuyển tới tab cũ (không mở tab mới); phiên chưa liên kết → từ chối", async () => {
    const W = world(), S = swWorld(W, FAST); fresh(W); S.web(11);
    await S.send({ op: "created", id: SID, pos: POS }, S.admin(11));
    const o1 = await S.send({ op: "openPanel", id: SID }, S.admin(11));
    eq(o1.ok, true); eq(S.created.length, 1); eq(S.created[0].url, S.PANEL + "?circa=" + SID);
    const o2 = await S.send({ op: "openPanel", id: SID }, S.admin(11));
    eq(o2.focused, true); eq(S.created.length, 1); eq(S.updated.length, 1); eq(JSON.stringify(S.updated[0].o), JSON.stringify({ active: true })); eq(S.updated[0].id, 100);
    const o3 = await S.send({ op: "openPanel", id: SID2 }, S.admin(11)); eq(o3.ok, false); eq(S.created.length, 1);
  });
  await ta("H panel: phiên NW đã đóng (nw-closed) → mọi lệnh panel bị từ chối; init trả trạng thái nw-closed", async () => {
    const W = world(), S = swWorld(W, FAST); fresh(W); S.web(11);
    W.addRec({ notes: "CIRCA ICS00242 " + SID, status: "cancelled" });
    eq((await S.send({ op: "created", id: SID, pos: POS }, S.admin(11))).v.state, "nw-closed");
    const P = S.panel(41);
    eq((await S.send({ op: "init", id: SID }, P)).v.state, "nw-closed");
    for (const op of ["circaSession", "nwRec", "nwExport", "beginSend", "submit"]) eq((await S.send({ op, id: SID, body: { session_id: SID } }, P)).ok, false, op);
    eq((await S.send({ op: "openPanel", id: SID }, S.admin(11))).ok, false);
    eq(W.posts().length, 0);
  });
}

// ================= G. build =================
async function partG() {
  const B = require("./build-ext.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kk-ext-"));
  try {
    await ta("G build bản thật + bản thử; core.js trùng byte; host đúng", async () => {
      const r = B.build({ outDir: path.join(tmp, "real") });
      deq(r.hosts, ["https://admin.v2.circa.vn/*", "https://api.v2.circa.vn/*", "https://circa.nextwaves.app/*", "https://api-circa.nextwaves.app/*"]);
      const T = { admin: "http://127.0.0.1:47910", circaApi: "http://127.0.0.1:47911", nwApp: "http://127.0.0.1:47912", nwApi: "http://127.0.0.1:47913" };
      const r2 = B.build({ outDir: path.join(tmp, "test"), test: T });
      deq(r2.hosts, Object.values(T).map(x => x + "/*"));
      const coreSha = crypto.createHash("sha256").update(fs.readFileSync(path.join(D, "core.js"))).digest("hex");
      eq(r.files["core.js"].sha256, coreSha); eq(r2.files["core.js"].sha256, coreSha);
      const realTxt = B.OWN.map(f => fs.readFileSync(path.join(tmp, "real", f), "utf8")).join("\n");
      ok(!/127\.0\.0\.1|localhost/.test(realTxt)); ok(!B.LOOPBACK.test(realTxt), "bản thật còn 127.0.0.1 dạng thoát");
      ok(!B.TEST_MARKS.test(realTxt), "bản thật còn mã thử: " + (B.TEST_MARKS.exec(realTxt) || [])[0]);
      for (const s of ["TEST_ORIGIN", "__KK_TEST__", "__KK_PANEL__", "TEST-BEGIN", "dropSubmit"]) ok(realTxt.indexOf(s) < 0, "bản thật còn " + s);
      const realCs = fs.readFileSync(path.join(tmp, "real", "content-circa.js"), "utf8");
      ok(!/["']open["']/.test(realCs) && /var mode = "closed";/.test(realCs), "bản thật: shadow root đóng");
      const testTxt = B.OWN.map(f => fs.readFileSync(path.join(tmp, "test", f), "utf8")).join("\n");
      for (const h of Object.values(B.REAL)) ok(testTxt.indexOf(h) < 0, "bản thử còn " + h);
      for (const s of ["__KK_TEST__", "__KK_PANEL__", "TEST_ORIGIN"]) ok(testTxt.indexOf(s) >= 0, "bản thử phải còn móc thử " + s);
      const tc = require(path.join(tmp, "test", "config.js"));
      eq(tc.TEST, true); eq(tc.CIRCA_API, T.circaApi);
      ok(KKAPI.validateCfg(tc));
      // api.js của BẢN THẬT (đã cắt TEST_ORIGIN) từ chối mọi cấu hình TEST = true
      const realApiMod = require(path.join(tmp, "real", "api.js"));
      assert.throws(() => realApiMod.validateCfg(tc), /bản thử/); ok(realApiMod.validateCfg(CFG));
      // mọi file .js của 2 bản biên dịch được
      for (const v of ["real", "test"]) for (const f of B.OWN.filter(x => /\.js$/.test(x))) new vm.Script(fs.readFileSync(path.join(tmp, v, f), "utf8"), { filename: v + "/" + f });
      const man = JSON.parse(fs.readFileSync(path.join(tmp, "real", "manifest.json"), "utf8"));
      deq(man.permissions, ["storage", "scripting", "tabs", "webRequest"]);
      eq(man.content_scripts[0].world, "MAIN"); deq(man.content_scripts[0].js, ["watch-circa.js"]); eq(man.content_scripts[0].run_at, "document_start");
      deq(man.content_scripts[1].js, ["config.js", "content-circa.js"]); eq(man.content_scripts[1].world, undefined);
      ok(/script-src 'self'/.test(man.content_security_policy.extension_pages));
      const panel = fs.readFileSync(path.join(tmp, "real", "panel.html"), "utf8");
      ok(/connect-src 'none'/.test(panel), "panel không được tự gọi mạng");
      eq((panel.match(/<script\b/g) || []).length, 4); ok(!/<script>/.test(panel), "không có script nội tuyến");
    });
    await ta("G build từ chối host bản thử không phải 127.0.0.1", async () => {
      assert.throws(() => B.build({ outDir: path.join(tmp, "x"), test: { admin: "http://localhost:1", circaApi: "http://127.0.0.1:2", nwApp: "http://127.0.0.1:3", nwApi: "http://127.0.0.1:4" } }));
    });
    await ta("G soát nguồn bắt được innerHTML / alert / eval / fetch ngoài api.js / console / /auth/refresh", async () => {
      const base = { "background.js": "x = { fetch: function (u, o) { return fetch(u, o); } };" };
      deq(B.lintSources(base), []);
      ok(B.lintSources(Object.assign({}, base, { "panel.js": "el.innerHTML = x;" })).length);
      ok(B.lintSources(Object.assign({}, base, { "panel.js": "alert('x')" })).length);
      ok(B.lintSources(Object.assign({}, base, { "panel.js": "if (confirm('x')) {}" })).length);
      ok(B.lintSources(Object.assign({}, base, { "link.js": "eval('1')" })).length);
      ok(B.lintSources(Object.assign({}, base, { "panel.js": "fetch('https://x')" })).length);
      ok(B.lintSources(Object.assign({}, base, { "panel.js": "console.log(token)" })).length);
      ok(B.lintSources(Object.assign({}, base, { "api.js": "var u = '/api/v1/auth/refresh';" })).length);
      ok(B.lintSources({ "background.js": "fetch(a); fetch(b);" }).length);
      deq(B.lintSources(Object.assign({}, base, { "panel.js": "// alert( trong chú thích\nconfirmBox('x');" })), []);
    });
    await ta("G soát nguồn bắt self./window./globalThis.fetch(, [\"fetch\"], XMLHttpRequest ngoài watch, sendBeacon, WebSocket, EventSource, console[", async () => {
      const base = { "background.js": "x = { fetch: function (u, o) { return fetch(u, o); } };" };
      for (const [f, s] of [["api.js", "self.fetch(u)"], ["background.js", "x = { fetch: function (u, o) { return fetch(u, o); } }; window.fetch(u)"], ["link.js", "globalThis . fetch (u)"],
        ["panel.js", "self['fetch'](u)"], ["panel.js", "new XMLHttpRequest()"], ["background.js", "x = { fetch: function (u, o) { return fetch(u, o); } }; navigator.sendBeacon(u, b)"],
        ["panel.js", "new WebSocket(u)"], ["link.js", "new EventSource(u)"], ["api.js", "console['log'](t)"], ["bridge.js", "console .log(t)"]]) {
        ok(B.lintSources(Object.assign({}, base, { [f]: s })).length, f + ": " + s);
      }
      deq(B.lintSources(Object.assign({}, base, { "watch-circa.js": "var XHR = W.XMLHttpRequest; W.fetch = wFetch; var w = function fetch(a) { return oFetch.apply(this, arguments); };" })), []);
    });
    await ta("G khối TEST-BEGIN/END: cân, không lồng; cutTest cắt sạch; LOOPBACK bắt 127.0.0.1 dạng thường / thoát / \\x2e, localhost", async () => {
      ok(B.testBlocksOk("a /*TEST-BEGIN*/ b /*TEST-END*/ c /*TEST-BEGIN*/ d /*TEST-END*/"));
      for (const s of ["/*TEST-BEGIN*/ x", "/*TEST-END*/ x /*TEST-BEGIN*/", "/*TEST-BEGIN*/ /*TEST-BEGIN*/ /*TEST-END*/ /*TEST-END*/"]) ok(!B.testBlocksOk(s), s);
      ok(B.lintSources({ "background.js": "x = { fetch: function (u, o) { return fetch(u, o); } }; /*TEST-BEGIN*/ y" }).length, "dấu không cân bị soát");
      eq(B.cutTest("a;\n  /*TEST-BEGIN*/\n  var T = 1;\n  /*TEST-END*/\nb;\n"), "a;\nb;\n");
      for (const s of ["127.0.0.1", "/^http:\\/\\/127\\.0\\.0\\.1:\\d+$/", "127\\x2e0\\x2e0\\x2e1", "127\\u002e0\\u002e0", "127[.]0[.]0", "http://LOCALHOST:1", "[::1]"]) ok(B.LOOPBACK.test(s), s);
      ok(!B.LOOPBACK.test("version 1.27.0 · 0.0.1"), "không bắt nhầm");
    });
    await ta("G nguồn ext/ hiện tại sạch (không innerHTML, alert, eval, console, fetch ngoài api.js)", async () => {
      const files = {}; for (const f of B.OWN) files[f] = fs.readFileSync(path.join(EXT, f), "utf8");
      deq(B.lintSources(files), []);
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

(async () => {
  await partB();
  await partD();
  await partE();
  await partF();
  await partH();
  await partG();
  await Promise.all(pending);
  console.log("\n" + pass + " đạt, " + fail + " lỗi");
  if (fail) { console.log("Lỗi: " + failures.join(" | ")); process.exitCode = 1; }
})();
