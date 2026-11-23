// TEST extension "Kiểm kê Circa ↔ NW" v0.2.1 bằng Node thuần (assert), KHÔNG cần trình duyệt. OFFLINE: không gọi mạng, không dùng token thật
// (token giả sinh ngẫu nhiên), mọi "máy chủ" là hàm giả trong bộ nhớ. Ghi file tạm của phần build vào thư mục tạm của hệ điều hành rồi xoá.
//
// Dùng (cwd bất kỳ):  node tools/nw-sang-circa/test-ext.js
// Phần:
//   A. Bảng API được phép (api.js): đúng 10 lệnh, lệnh ghi DUY NHẤT là POST submit-rfid-batch; chặn tạo phiên ở cả 2 bên (POST
//      …/count/sessions, POST /stock/reconciliations), đóng/duyệt/huỷ/hoàn tất/đặt lại/đổi phạm vi/đếm tay/append, /auth/refresh,
//      lệnh đã bỏ (entity/stores, auth/me), host lạ, path traversal, method sai, query lạ, body sai; bản thật ≠ bản thử.
//   B. call(): header (danh sách phiên Circa KHÔNG có X-Store-Id; lệnh gắn phiên có X-Store-Id), token không vào URL / kết quả, không gửi
//      khi bị chặn / không có token, export trả bytes, timeout (lệnh lượt quét có thời hạn riêng), trần kích thước response lượt quét.
//   C. chon.js: ghép kho (trùng, khác hoa thường, NFC, lệch dấu, gần đúng, 0 kho, 2 kho, transit, đã đóng, cây children), danh sách
//      phiên Circa / NW, đọc số / giờ / mã SP của file xuất NW.
//   D. chon.js + core.js THẬT, quy tắc chọn thẻ: khớp đơn giản; 2 phiên khớp 1 SP với thẻ khác nhau → chỉ thẻ phiên quét mới hơn
//      (bằng nhau → phiên tạo sau); 2 phiên cùng thẻ → 1 lần; ứng viên = mọi phiên có SP ≠ “Chưa đếm”, phiên mới nhất không đủ điều
//      kiện (Thiếu / khớp nhờ thủ công …) → để riêng cả SP; giờ quét không rõ ở 1 ứng viên → để riêng; khớp nhờ đếm thủ công;
//      Khớp mà “Tồn hệ thống” ≠ “Đã đếm” / thiếu cột “Tồn hệ thống”; tổng thẻ ≠ Đã đếm; Thiếu / Thừa / Chưa đếm không
//      gửi; phiên Circa đã có lượt quét khác của SP → để riêng; lượt có sẵn là thẻ của ta → chỉ gửi phần thiếu; 1 thẻ Circa không nhận →
//      để riêng cả SP; các ca an toàn thêm (dòng lỗi, Thực tế nhập, trùng mã, giờ không đọc được, lượt sai số / mã khác / sai SP).
//   E. bridge.js: đọc token từ cookie / localStorage giả, JWT hết hạn, không có tab.
//   H. background.js THẬT trong vm (chrome.* giả): người gửi (trang NW đúng đường dẫn / panel / lạ), openPanel mở tab panel, lệnh panel
//      (danh sách không X-Store-Id, kiểm tham số), khoá gửi theo phiên Circa, không còn webRequest.
//   R. KKCHON.readScans (đọc lượt quét Circa, fail-closed, v0.2.1: MỘT request, không offset) với máy chủ giả trong bộ nhớ: đọc thường,
//      lượt chen giữa summary và lượt quét / giữa lượt quét và summary sau, xoá lượt, has_more = true (trần phía máy chủ) → dừng không đọc
//      lại, has_more thiếu / không phải boolean, summary lệch / lỗi / thiếu trường, thiếu id, trùng id, product_id không đọc được, thứ tự
//      trong response bất kỳ; io.scans luôn gọi không tham số.
//   M. máy chủ giả: lượt quét "đếm tay" (sim.add / srv.addScan) qua cùng chống trùng theo mã như submit.
//   M2. máy chủ giả Circa (mock-server.js qua HTTP 127.0.0.1): id, mới nhất trước, lô chung scanned_at, có offset thì thứ tự trong nhóm
//      cùng scanned_at xáo mỗi request (lật trang lộ trùng / sót), limit lớn trả hết, summary, cấu hình dựng ca (serverCap, insertBetween…).
//   G. build-ext.js: bản thật / bản thử, manifest (quyền không có tabs, CSP extension_pages, content script), core.js trùng byte,
//      khối TEST bị cắt, soát nguồn.
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), vm = require("vm"), crypto = require("crypto"), assert = require("assert");
const D = __dirname, EXT = path.join(D, "ext");
const CFG = require("./ext/config.js");
const KKAPI = require("./ext/api.js");
const CH = require("./ext/chon.js");
const KKBRIDGE = require("./ext/bridge.js");
const NWC = require("./core.js");

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; failures.push(name); console.log("FAIL  " + name + "\n      " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n      ")); }
}
async function ta(name, fn) {
  try { await fn(); pass++; }
  catch (e) { fail++; failures.push(name); console.log("FAIL  " + name + "\n      " + String(e && e.stack || e).split("\n").slice(0, 5).join("\n      ")); }
}
const eq = assert.strictEqual, deq = assert.deepStrictEqual, ok = assert.ok;

const SID = "3b3039be-5194-4cfa-958e-0248930a0be6"; // id giả (dạng uuid)
const SID2 = "4c4149cf-6205-4dfb-a69f-135904101cf7";
const POS = "31493e74-3404-4c0e-a906-93691a6ee319";   // id cửa hàng đã có trong repo (mock-server.js)
const NWID = "5d5250d0-7316-4e0c-b7a0-246a15212d08";
const NWID2 = "6e6361e1-8427-4f1d-c8b1-357b26323e19";
const WHL = "a1a1a1a1-0000-4000-8000-000000000001";
const TESTCFG = Object.assign({}, CFG, { TEST: true, CIRCA_ADMIN: "http://127.0.0.1:47900", CIRCA_API: "http://127.0.0.1:47901", NW_APP: "http://127.0.0.1:47902", NW_API: "http://127.0.0.1:47903" });

// ================= A. bảng API =================
const realApi = KKAPI.create({ cfg: CFG, fetch: () => { throw new Error("không được gọi"); }, getToken: async () => ({ err: "no-token" }) });
const testApi = KKAPI.create({ cfg: TESTCFG, fetch: () => { throw new Error("không được gọi"); }, getToken: async () => ({ err: "no-token" }) });
const C = CFG.CIRCA_API, N = CFG.NW_API;
const submitBody = { session_id: SID, device_id: "NW-RFID", tags: ["AB0001"], items: [{ tag: "AB0002", unit_name: "gói", quantity: 8 }] };
const ALLOW = [
  ["GET", C + "/v1/inventory/count/sessions?page=1&limit=20"],
  ["GET", C + "/v1/inventory/count/sessions?page=10&limit=20"],
  ["GET", C + "/v1/inventory/count/sessions/" + SID],
  ["GET", C + "/v1/inventory/count/sessions/" + SID + "/scans?limit=60000"],
  ["GET", C + "/v1/inventory/count/sessions/" + SID + "/summary"],
  ["GET", C + "/v1/inventory/count/qr-lookup?pos_id=" + POS + "&qr_code=AB0001"],
  ["POST", C + "/v1/inventory/count/submit-rfid-batch", submitBody],
  ["GET", C + "/v1/authz/me"],
  ["GET", N + "/api/v1/warehouses"],
  ["GET", N + "/api/v1/stock/reconciliations?page=1&limit=25"],
  ["GET", N + "/api/v1/stock/reconciliations?page=8&limit=25"],
  ["GET", N + "/api/v1/stock/reconciliations/" + NWID + "?omitScannedEpcs=true"],
  ["GET", N + "/api/v1/stock/reconciliations/" + NWID + "/export?format=xlsx&scope=all&includeEpcs=true&locale=vi"]
];
for (const [m, u, b] of ALLOW) t("A cho phép " + m + " " + u.replace(/^https:\/\//, ""), () => { const c = realApi.check(m, u, b); ok(c.ok, c.why); });
t("A bảng có đúng 11 lệnh (thêm GET summary); lệnh ghi DUY NHẤT là POST submit-rfid-batch; danh sách phiên Circa không gắn cửa hàng", () => {
  eq(realApi.table.length, 11);
  deq(realApi.table.filter(e => e.method !== "GET").map(e => e.id), ["circa.submit"]);
  eq(realApi.table.filter(e => e.method === "POST")[0].path, "/v1/inventory/count/submit-rfid-batch");
  deq(realApi.table.filter(e => e.noStore).map(e => e.id), ["circa.sessions"]);
  deq(realApi.table.map(e => e.id).sort(), ["circa.authz", "circa.qrLookup", "circa.scans", "circa.session", "circa.sessions", "circa.submit", "circa.summary", "nw.export", "nw.rec", "nw.recList", "nw.warehouses"]);
  const sm = realApi.table.find(e => e.id === "circa.summary");
  eq(sm.method, "GET"); eq(sm.noStore, false); deq(sm.query, {}); eq(sm.origin, C);
  // lượt quét: đúng 1 tham số limit (không có offset trong bảng), thời hạn riêng 120 s; lệnh khác 30 s
  const sc = realApi.table.find(e => e.id === "circa.scans");
  deq(Object.keys(sc.query), ["limit"]); deq(sc.need, ["limit"]); eq(sc.query.limit.test("60000"), true); eq(sc.scans, true); eq(sc.timeoutMs, 120000);
  ok(realApi.table.every(e => !Object.prototype.hasOwnProperty.call(e.query, "offset")), "không lệnh nào nhận offset");
  ok(realApi.table.filter(e => e.id !== "circa.scans").every(e => e.timeoutMs === 30000 && !e.scans), "lệnh khác giữ 30 s");
  // không đường dẫn nào chứa từ khoá đóng / duyệt / huỷ …
  realApi.table.forEach(e => ok(!/finalize|approve|cancel|revert|reset|close|scope|manual-count|append|refresh/.test(e.path), e.path));
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
  // tạo phiên ở CẢ HAI bên
  ["POST", C + "/v1/inventory/count/sessions", { pos_id: POS }], ["POST", C + "/v1/inventory/count/sessions?page=1&limit=20", { pos_id: POS }],
  ["POST", N + "/api/v1/stock/reconciliations", { warehouseId: WHL, notes: "CIRCA ICS00242 " + SID, clientOperationId: "circa-" + SID }],
  ["POST", N + "/api/v1/stock/reconciliations", {}],
  // lệnh v0.1.0 đã bỏ
  ["GET", C + "/v1/entity/stores/" + POS], ["GET", N + "/api/v1/auth/me"],
  // danh sách phiên Circa: chỉ page 1..10, limit 20, không tham số khác
  ["GET", C + "/v1/inventory/count/sessions?page=11&limit=20"], ["GET", C + "/v1/inventory/count/sessions?page=0&limit=20"],
  ["GET", C + "/v1/inventory/count/sessions?page=1&limit=100"], ["GET", C + "/v1/inventory/count/sessions?page=1"], ["GET", C + "/v1/inventory/count/sessions"],
  ["GET", C + "/v1/inventory/count/sessions?page=1&limit=20&status=OPEN"], ["GET", C + "/v1/inventory/count/sessions?page=1&page=2&limit=20"],
  ["GET", C + "/v1/inventory/count/sessions/?page=1&limit=20"], ["GET", C + "/v1/inventory/count/session/current?pos_id=" + POS],
  ["POST", C + "/v1/inventory/count/sessions/" + SID + "/unmatched-scans/bulk-resolve-as-new-stock", {}],
  // host lạ / http / cổng / userinfo / host giả mạo
  ["GET", "https://evil.example/v1/authz/me"], ["GET", "http://api.v2.circa.vn/v1/authz/me"], ["GET", "https://api.v2.circa.vn:444/v1/authz/me"],
  ["GET", "https://x:y@api.v2.circa.vn/v1/authz/me"], ["GET", "https://api.v2.circa.vn.evil.example/v1/authz/me"], ["GET", "https://admin.v2.circa.vn/v1/authz/me"],
  ["GET", "https://circa.nextwaves.app/api/v1/warehouses"], ["GET", "https://api-circa.nextwaves.app/api/v1/public/orders/DHC1"], ["GET", "http://127.0.0.1:47901/v1/authz/me"],
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
  ["GET", N + "/api/v1/stock/reconciliations?page=1&limit=25&status=in_progress"],
  ["GET", N + "/api/v1/stock/reconciliations/" + NWID], ["GET", N + "/api/v1/warehouses?page=2"],
  ["GET", C + "/v1/inventory/count/qr-lookup?qr_code=AB0001"], ["GET", C + "/v1/inventory/count/qr-lookup?pos_id=" + POS + "&qr_code=qr.v2.circa.vn%2Fitem%2F1"],
  ["GET", C + "/v1/inventory/count/qr-lookup?pos_id=" + POS + "&qr_code=AB%200001"], ["GET", C + "/v1/authz/me?x=1"],
  ["GET", C + "/v1/inventory/count/sessions/" + SID + "/scans?limit=0"], ["GET", C + "/v1/inventory/count/sessions/" + SID + "/scans?limit=999999"],
  // lượt quét (v0.2.1): ĐÚNG limit=60000, KHÔNG offset (kể cả offset=0), không thiếu / lặp / tham số khác / limit khác
  ...["limit=60000&offset=0", "offset=0&limit=60000", "limit=60000&offset=1000", "limit=60000&offset=", "offset=0", "limit=1000&offset=0", "limit=1000&offset=1500",
    "limit=1000", "limit=5000", "limit=100", "limit=60001", "limit=59999", "limit=060000", "limit=60000.0", "limit=6e4", "limit=%2060000", "limit=60000%20", "limit=-1",
    "limit=", "", "limit=60000&limit=60000", "limit=60000&x=1", "limit=60000&page=2", "limit=60000&cursor=x", "LIMIT=60000"]
    .map(q => ["GET", C + "/v1/inventory/count/sessions/" + SID + "/scans" + (q ? "?" + q : "")]),
  ["GET", C + "/v1/inventory/count/sessions/" + SID + "/scans"], ["POST", C + "/v1/inventory/count/sessions/" + SID + "/scans?limit=60000", {}],
  // summary: chỉ GET, đúng đường dẫn, không query, id uuid chữ thường
  ["POST", C + "/v1/inventory/count/sessions/" + SID + "/summary", {}], ["PUT", C + "/v1/inventory/count/sessions/" + SID + "/summary", {}],
  ["GET", C + "/v1/inventory/count/sessions/" + SID + "/summary?x=1"], ["GET", C + "/v1/inventory/count/sessions/" + SID + "/summary?limit=1000"],
  ["GET", C + "/v1/inventory/count/sessions/" + SID + "/summary/"], ["GET", C + "/v1/inventory/count/sessions/" + SID + "/summary/x"],
  ["GET", C + "/v1/inventory/count/sessions/" + SID.toUpperCase() + "/summary"], ["GET", C + "/v1/inventory/count/sessions/abc/summary"],
  ["GET", C + "/v1/inventory/count/summary"], ["GET", C + "/v1/inventory/count/sessions/summary"], ["GET", N + "/api/v1/inventory/count/sessions/" + SID + "/summary"],
  ["GET", C + "/v1/inventory/count/sessions/" + SID + "/lines?limit=-1"], ["GET", C + "/v1/inventory/count/sessions/" + SID + "/unmatched-scans"],
  // body sai
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
  ok(testApi.check("GET", "http://127.0.0.1:47903/api/v1/warehouses").ok);
  ok(testApi.check("GET", "http://127.0.0.1:47901/v1/inventory/count/sessions?page=1&limit=20").ok);
  ok(!testApi.check("GET", "https://api.v2.circa.vn/v1/authz/me").ok);
  ok(!testApi.check("GET", "http://127.0.0.1:47903/v1/authz/me").ok, "API Circa ở cổng NW");
  ok(!testApi.check("GET", "http://localhost:47901/v1/authz/me").ok);
  ok(!testApi.check("POST", "http://127.0.0.1:47903/api/v1/stock/reconciliations", {}).ok);
});
t("A validateCfg: bản thật không nhận 127.0.0.1, bản thử không nhận host thật, TEST phải boolean; config v0.2.1 (lượt quét 1 request)", () => {
  assert.throws(() => KKAPI.validateCfg(Object.assign({}, CFG, { NW_API: "http://127.0.0.1:47903" })));
  assert.throws(() => KKAPI.validateCfg(Object.assign({}, CFG, { CIRCA_API: "https://api.v2.circa.vn.evil.example" })));
  assert.throws(() => KKAPI.validateCfg(Object.assign({}, CFG, { CIRCA_API: "https://admin.v2.circa.vn" })), "đổi chỗ 2 host");
  assert.throws(() => KKAPI.validateCfg(Object.assign({}, TESTCFG, { NW_API: "https://api-circa.nextwaves.app" })));
  assert.throws(() => KKAPI.validateCfg(Object.assign({}, CFG, { TEST: "false" })));
  ok(KKAPI.validateCfg(CFG)); ok(KKAPI.validateCfg(TESTCFG));
  eq(CFG.TEST, false); eq(CFG.VERSION, "0.2.1"); eq(CFG.CIRCA_LIST_LIMIT, 20); eq(CFG.CIRCA_LIST_PAGES, 10); eq(CFG.REC_PAGE_LIMIT, 25); eq(CFG.REC_LIST_PAGES, 8);
  eq(JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8")).version, "0.2.1");
  eq(CFG.SCAN_LIMIT, 60000); eq(CFG.SCAN_TIMEOUT_MS, 120000); eq(CFG.TIMEOUT_MS, 30000); eq(CFG.SCAN_MAX_BYTES, 60 * 1024 * 1024); ok(CFG.SCAN_MAX_BYTES < 64 * 1024 * 1024, "dưới trần tin nhắn Chrome 64 MiB");
  eq(CFG.SCAN_READ_TRIES, 3); eq(CFG.SCAN_PAGE, undefined, "không còn SCAN_PAGE"); eq(CFG.SCAN_PAGES, undefined, "không còn SCAN_PAGES");
});
t("A đường dẫn danh sách đối chiếu NW: chỉ /<locale>/stock/reconciliation", () => {
  const re = new RegExp(CFG.NW_REC_LIST_PATH);
  for (const p of ["/vi/stock/reconciliation", "/en/stock/reconciliation", "/vi/stock/reconciliation/", "/en-US/stock/reconciliation"]) ok(re.test(p), p);
  for (const p of ["/stock/reconciliation", "/vi/stock/reconciliation/" + NWID, "/vi/stock/reconciliations", "/vi/stock", "/vi/stock/reconciliation/new", "/vi/x/stock/reconciliation", "/vi/dashboard", "/"]) ok(!re.test(p), p);
});
t("A urlFor từ chối id không phải uuid chữ thường", () => {
  assert.throws(() => realApi.urlFor("circa.session", { id: "../close" }));
  assert.throws(() => realApi.urlFor("circa.session", { id: SID.toUpperCase() }));
  eq(realApi.urlFor("nw.export", { id: NWID, q: { format: "xlsx", scope: "all", includeEpcs: "true", locale: "vi" } }), N + "/api/v1/stock/reconciliations/" + NWID + "/export?format=xlsx&scope=all&includeEpcs=true&locale=vi");
  eq(realApi.urlFor("circa.sessions", { q: { page: 3, limit: 20 } }), C + "/v1/inventory/count/sessions?page=3&limit=20");
});

// ================= B. call() =================
function fakeResp(status, body, headers) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, headers: { get: k => (headers || {})[String(k).toLowerCase()] || null }, text: async () => text, arrayBuffer: async () => Uint8Array.from(Buffer.from(text, "binary")).buffer };
}
const TOK = { circa: "gia-circa-" + crypto.randomBytes(12).toString("hex"), nw: "gia.nw." + crypto.randomBytes(12).toString("hex") };
async function partB() {
  const seen = [];
  const api = KKAPI.create({ cfg: CFG, fetch: async (u, o) => { seen.push({ u, o }); return fakeResp(200, { success: true, data: { ok: 1 } }); }, getToken: async s => ({ token: TOK[s] }) });
  await ta("B Circa gắn phiên: đủ header, X-Store-Id, credentials omit, redirect error, token chỉ ở Authorization", async () => {
    const r = await api.call("circa.session", { id: SID, posId: POS });
    eq(r.status, 200);
    const s = seen.pop();
    eq(s.u, C + "/v1/inventory/count/sessions/" + SID);
    deq(s.o.headers, { "Authorization": "Bearer " + TOK.circa, "X-Circa-App": "admin", "X-Client-Id": "1", "Grpc-Timeout": "30S", "X-Store-Id": POS });
    eq(s.o.credentials, "omit"); eq(s.o.redirect, "error"); eq(s.o.cache, "no-store"); eq(s.o.method, "GET"); eq(s.o.body, undefined);
    ok(JSON.stringify(r).indexOf(TOK.circa) < 0, "token lọt vào kết quả");
    ok(s.u.indexOf(TOK.circa) < 0);
  });
  await ta("B danh sách phiên Circa: KHÔNG gửi X-Store-Id (như trang admin), không cần posId; posId truyền nhầm cũng bị bỏ", async () => {
    await api.call("circa.sessions", { q: { page: 2, limit: 20 } });
    let s = seen.pop();
    eq(s.u, C + "/v1/inventory/count/sessions?page=2&limit=20");
    deq(s.o.headers, { "Authorization": "Bearer " + TOK.circa, "X-Circa-App": "admin", "X-Client-Id": "1", "Grpc-Timeout": "30S" });
    await api.call("circa.sessions", { q: { page: 1, limit: 20 }, posId: POS });
    s = seen.pop(); eq(s.o.headers["X-Store-Id"], undefined);
  });
  await ta("B GET summary + scans (MỘT request limit=60000, không offset): đúng URL, X-Store-Id = pos của phiên, không body; Grpc-Timeout lượt quét 120S, lệnh khác 30S", async () => {
    await api.call("circa.summary", { id: SID, posId: POS });
    let s = seen.pop();
    eq(s.u, C + "/v1/inventory/count/sessions/" + SID + "/summary"); eq(s.o.method, "GET"); eq(s.o.body, undefined); eq(s.o.headers["X-Store-Id"], POS); eq(s.o.headers["Grpc-Timeout"], "30S");
    const r = await api.call("circa.scans", { id: SID, posId: POS, q: { limit: 60000 } });
    s = seen.pop();
    eq(s.u, C + "/v1/inventory/count/sessions/" + SID + "/scans?limit=60000"); eq(s.o.headers["X-Store-Id"], POS); eq(s.o.method, "GET"); eq(s.o.body, undefined);
    deq(s.o.headers, { "Authorization": "Bearer " + TOK.circa, "X-Circa-App": "admin", "X-Client-Id": "1", "Grpc-Timeout": "120S", "X-Store-Id": POS });
    eq(r.status, 200); eq(r.size, Buffer.byteLength(JSON.stringify({ success: true, data: { ok: 1 } })), "lượt quét trả size = byte thân response");
    await api.call("circa.scans", { id: SID, posId: POS, q: { limit: 60000, offset: 0 } });
    eq(seen.pop().u, C + "/v1/inventory/count/sessions/" + SID + "/scans?limit=60000", "urlFor bỏ khoá ngoài bảng (offset) — không bao giờ vào URL");
    eq((await api.call("circa.summary", { id: SID, posId: POS })).size, undefined, "lệnh khác không đếm byte");
  });
  await ta("B POST submit: Content-Type JSON, body đúng, X-Store-Id = pos của phiên", async () => {
    await api.call("circa.submit", { posId: POS, body: submitBody });
    const s = seen.pop();
    eq(s.u, C + "/v1/inventory/count/submit-rfid-batch"); eq(s.o.method, "POST"); deq(JSON.parse(s.o.body), submitBody);
    eq(s.o.headers["Content-Type"], "application/json; charset=UTF-8"); eq(s.o.headers["X-Store-Id"], POS);
  });
  await ta("B NW GET: Bearer NW, Accept JSON, không có header Circa", async () => {
    await api.call("nw.recList", { q: { page: 1, limit: 25 } });
    const s = seen.pop();
    eq(s.o.headers["Authorization"], "Bearer " + TOK.nw); eq(s.o.headers["X-Store-Id"], undefined); eq(s.o.headers["X-Circa-App"], undefined); eq(s.o.headers.Accept, "application/json");
  });
  await ta("B bị chặn → không gọi fetch, không đọc token; lệnh gắn phiên thiếu posId → no-store; lệnh v0.1.0 không còn", async () => {
    let tok = 0;
    const api2 = KKAPI.create({ cfg: CFG, fetch: async () => { throw new Error("không được gọi"); }, getToken: async () => { tok++; return { token: TOK.nw }; } });
    eq((await api2.call("nw.recList", { q: { page: 9, limit: 25 } })).err, "blocked");
    eq((await api2.call("circa.sessions", { q: { page: 11, limit: 20 } })).err, "blocked");
    eq((await api2.call("circa.session", { id: SID })).err, "no-store");
    eq((await api2.call("circa.scans", { id: SID, q: { limit: 60000 } })).err, "no-store");
    eq((await api2.call("circa.scans", { id: SID, posId: POS, q: { limit: 5000 } })).err, "blocked", "limit khác 60000");
    eq((await api2.call("circa.scans", { id: SID, posId: POS, q: { limit: 1000 } })).err, "blocked", "limit 1000 cũ");
    eq((await api2.call("circa.scans", { id: SID, posId: POS })).err, "blocked", "thiếu limit");
    eq((await api2.call("circa.scans", { id: SID, posId: POS, q: { offset: 0 } })).err, "blocked", "chỉ offset, thiếu limit");
    eq((await api2.call("circa.summary", { id: SID })).err, "no-store", "summary cũng phải có X-Store-Id");
    eq((await api2.call("circa.summary", { id: "../x", posId: POS })).err, "blocked");
    eq((await api2.call("nw.recCreate", { body: {} })).err, "blocked", "lệnh tạo phiên NW không còn");
    eq((await api2.call("circa.store", { id: POS, posId: POS })).err, "blocked");
    eq((await api2.call("nw.me")).err, "blocked");
    eq((await api2.call("không-có", {})).err, "blocked");
    eq(tok, 0);
  });
  await ta("B không có token / token sai dạng → không gọi fetch", async () => {
    let n = 0;
    const api3 = KKAPI.create({ cfg: CFG, fetch: async () => { n++; return fakeResp(200, {}); }, getToken: async s => s === "nw" ? { err: "no-tab" } : { token: "abc\r\nX-Evil: 1aaaaaaaaaaaa" } });
    const r = await api3.call("nw.warehouses");
    eq(r.err, "no-tab"); eq(r.side, "nw");
    eq((await api3.call("circa.authz", { posId: POS })).err, "no-token");
    eq((await api3.call("circa.sessions", { q: { page: 1, limit: 20 } })).err, "no-token");
    eq(n, 0);
  });
  await ta("B export: trả bytes; JSON hỏng → badJson; lỗi mạng → status 0 network", async () => {
    const api4 = KKAPI.create({ cfg: CFG, fetch: async (u) => /export/.test(u) ? fakeResp(200, "PK\u0003\u0004xlsx", { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }) : /warehouses/.test(u) ? fakeResp(502, "<html>bad gateway</html>") : (() => { throw new Error("ECONNRESET"); })(), getToken: async s => ({ token: TOK[s] }) });
    const e = await api4.call("nw.export", { id: NWID, q: { format: "xlsx", scope: "all", includeEpcs: "true", locale: "vi" } });
    eq(e.status, 200); ok(e.bytes instanceof Uint8Array); eq(e.size, 8);
    const m = await api4.call("nw.warehouses");
    eq(m.status, 502); eq(m.badJson, true);
    const w = await api4.call("nw.recList", { q: { page: 1, limit: 25 } });
    eq(w.status, 0); eq(w.err, "network");
  });
  await ta("B timeout → status 0 timeout (kèm timeoutMs); lệnh lượt quét dùng thời hạn riêng (dài hơn), lệnh khác thời hạn chung", async () => {
    const hang = (u, o) => new Promise((res, rej) => { o.signal.addEventListener("abort", () => rej(new Error("aborted"))); });
    const api5 = KKAPI.create({ cfg: CFG, timeoutMs: 50, fetch: hang, getToken: async s => ({ token: TOK[s] }) });
    const r = await api5.call("nw.warehouses");
    eq(r.status, 0); eq(r.err, "timeout"); eq(r.timeoutMs, 50);
    const api6 = KKAPI.create({ cfg: Object.assign({}, CFG, { TIMEOUT_MS: 40, SCAN_TIMEOUT_MS: 260 }), fetch: hang, getToken: async s => ({ token: TOK[s] }) });
    const t0 = Date.now(), rs = await api6.call("circa.scans", { id: SID, posId: POS, q: { limit: 60000 } }), dt = Date.now() - t0;
    eq(rs.err, "timeout"); eq(rs.timeoutMs, 260); ok(dt >= 240, "lượt quét chờ đủ thời hạn riêng, không cắt ở 40 ms: " + dt);
    const t1 = Date.now(), rq = await api6.call("circa.summary", { id: SID, posId: POS }), dq = Date.now() - t1;
    eq(rq.err, "timeout"); eq(rq.timeoutMs, 40); ok(dq < 200, "summary cắt ở thời hạn chung: " + dq);
    // thời hạn bao cả lúc tải thân response (thân treo sau header → vẫn timeout)
    const api7 = KKAPI.create({ cfg: Object.assign({}, CFG, { SCAN_TIMEOUT_MS: 80 }), fetch: async (u, o) => ({ status: 200, headers: { get: () => null }, text: () => hang(u, o) }), getToken: async s => ({ token: TOK[s] }) });
    const rb = await api7.call("circa.scans", { id: SID, posId: POS, q: { limit: 60000 } });
    eq(rb.status, 0); eq(rb.err, "timeout", "thân response treo → timeout, không coi là đã nhận");
  });
  await ta("B trần kích thước response lượt quét: đếm BYTE UTF-8 (không phải số ký tự); vượt → too-big, không trả j; lệnh khác không áp trần", async () => {
    const body = JSON.stringify({ success: true, data: { scans: [{ id: "1", product_name: "ả".repeat(400) }], has_more: false } });
    const bytes = Buffer.byteLength(body);
    ok(body.length < 1000 && bytes > 1000, "mẫu: " + body.length + " ký tự, " + bytes + " byte");
    const mk = max => KKAPI.create({ cfg: Object.assign({}, CFG, { SCAN_MAX_BYTES: max }), fetch: async () => fakeResp(200, body), getToken: async s => ({ token: TOK[s] }) });
    const r1 = await mk(1000).call("circa.scans", { id: SID, posId: POS, q: { limit: 60000 } });
    eq(r1.status, 0); eq(r1.err, "too-big"); eq(r1.j, undefined); eq(r1.size, bytes); ok(/vượt trần/.test(r1.msg) && /64 MiB/.test(r1.msg), r1.msg);
    const r2 = await mk(bytes).call("circa.scans", { id: SID, posId: POS, q: { limit: 60000 } });
    eq(r2.status, 200); eq(r2.size, bytes); eq(r2.j.data.scans.length, 1, "đúng bằng trần → nhận");
    const r3 = await mk(10).call("circa.scans", { id: SID, posId: POS, q: { limit: 60000 } });
    eq(r3.err, "too-big"); ok(/hơn /.test(r3.msg), "số ký tự đã hơn trần → báo 'hơn …'");
    const r4 = await mk(1000).call("circa.summary", { id: SID, posId: POS });
    eq(r4.status, 200, "summary không áp trần lượt quét");
    eq(KKAPI._utf8Len("aé€😀"), 1 + 2 + 3 + 4); eq(KKAPI._utf8Len("\ud800x"), 4, "surrogate lẻ = 3 byte");
  });
}

// ================= C. chon.js: ghép kho, danh sách, số / giờ =================
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
function nested(childName, alsoAtRoot) {
  const list = JSON.parse(JSON.stringify(WHS)), child = whx(WH_CHILD, childName, "warehouse", null, [], "a1a1a1a1-0000-4000-8000-000000000006");
  list.find(w => w.name === "CIRCA TAM VIET").children = [child];
  if (alsoAtRoot) list.push(JSON.parse(JSON.stringify(child)));
  return list;
}
t("C ghép kho: trùng tên đúng 1 kho warehouse đang mở (bỏ transit, kho đã đóng, kho lệch dấu)", () => { const m = CH.matchWarehouse("CIRCA LUMINA", WHS); ok(m.ok); eq(m.wh.id, WHL); });
t("C ghép kho: khác hoa thường + khoảng trắng đầu/cuối vẫn khớp", () => { const m = CH.matchWarehouse("  circa lumina ", WHS); ok(m.ok); eq(m.wh.id, WHL); });
t("C ghép kho: chuẩn hoá NFC (tên tổ hợp NFD khớp tên dựng sẵn)", () => {
  const nfd = "CIRCA LUMÍNA".normalize("NFD");
  ok(nfd !== "CIRCA LUMÍNA");
  const m = CH.matchWarehouse(nfd, WHS); ok(m.ok); eq(m.wh.id, "a1a1a1a1-0000-4000-8000-000000000005");
});
t("C ghép kho: lệch dấu → không khớp (không bỏ dấu)", () => {
  const m = CH.matchWarehouse("CIRCA LÚMINA", WHS); eq(m.ok, false); eq(m.why, "none");
  eq(CH.matchWarehouse("CIRCA TÂM VIỆT", [{ id: WHL, name: "CIRCA TAM VIET", locationType: "warehouse", closedAt: null }]).ok, false);
});
t("C ghép kho: không khớp gần đúng (khoảng trắng giữa, tiền tố, hậu tố)", () => {
  eq(CH.matchWarehouse("CIRCA  LUMINA", WHS).ok, false); eq(CH.matchWarehouse("LUMINA", WHS).ok, false); eq(CH.matchWarehouse("CIRCA LUMINA 2", WHS).ok, false);
});
t("C ghép kho: 0 kho → none; 2 kho cùng tên → many", () => {
  const m0 = CH.matchWarehouse("CIRCA SIGNATURE", WHS); eq(m0.ok, false); eq(m0.why, "none"); eq(m0.count, 0);
  const m2 = CH.matchWarehouse("CIRCA LUMINA", WHS.concat([whx("a1a1a1a1-0000-4000-8000-00000000000d", "Circa Lumina", "warehouse")])); eq(m2.ok, false); eq(m2.why, "many"); eq(m2.count, 2);
});
t("C ghép kho: chỉ transit / chỉ kho đã đóng → none; closedAt undefined = đang mở; id không phải uuid bị bỏ; đầu vào hỏng", () => {
  eq(CH.matchWarehouse("CIRCA LUMINA", [WHS[2]]).why, "none");
  eq(CH.matchWarehouse("CIRCA LUMINA", [WHS[3]]).why, "none");
  eq(CH.matchWarehouse("In transit", WHS).why, "none");
  ok(CH.matchWarehouse("CIRCA LUMINA", [{ id: WHL, name: "CIRCA LUMINA", locationType: "warehouse" }]).ok);
  eq(CH.matchWarehouse("CIRCA LUMINA", [{ id: "kho-1", name: "CIRCA LUMINA", locationType: "warehouse", closedAt: null }]).ok, false);
  eq(CH.matchWarehouse("", WHS).why, "bad-input"); eq(CH.matchWarehouse("X", null).why, "bad-input");
});
t("C ghép kho dạng cây: kho con (children) được ghép; kho con trùng tên kho gốc → many; kho con có cả ở gốc (cùng id) → 1; 3 cấp", () => {
  const m = CH.matchWarehouse("CIRCA KHO CON", nested("CIRCA KHO CON")); ok(m.ok, JSON.stringify(m)); eq(m.wh.id, WH_CHILD);
  const m2 = CH.matchWarehouse("CIRCA LUMINA", nested("CIRCA LUMINA")); eq(m2.ok, false); eq(m2.why, "many"); eq(m2.count, 2);
  const m3 = CH.matchWarehouse("CIRCA KHO CON", nested("CIRCA KHO CON", true)); ok(m3.ok); eq(m3.wh.id, WH_CHILD);
  const deep = [whx(WHL, "A", "warehouse", null, [whx("a1a1a1a1-0000-4000-8000-00000000000b", "B", "warehouse", null, [whx("a1a1a1a1-0000-4000-8000-00000000000c", "CIRCA SÂU", "warehouse")])])];
  eq(CH.matchWarehouse("CIRCA SÂU", deep).wh.id, "a1a1a1a1-0000-4000-8000-00000000000c");
});
t("C warehousesOf: mảng gốc; {data}; còn trang sau → null; không phải mảng → null", () => {
  eq(CH.warehousesOf(WHS).list.length, WHS.length); eq(CH.warehousesOf({ data: WHS }).list.length, WHS.length);
  eq(CH.warehousesOf({ data: [], totalPages: 2, page: 1 }).list, null); eq(CH.warehousesOf({ x: 1 }).list, null);
});
t("C recListOf (NW): totalPages ở gốc / meta; thiếu hoặc sai → null (không đoán); mảng trần / không có data → null", () => {
  eq(CH.recListOf({ data: [], total: 0, page: 1, limit: 25, totalPages: 3 }).totalPages, 3);
  eq(CH.recListOf({ data: [], meta: { totalPages: 2 } }).totalPages, 2);
  eq(CH.recListOf({ data: [], total: 0, page: 1, limit: 25 }).totalPages, null);
  eq(CH.recListOf({ data: [], totalPages: "x" }).totalPages, null);
  eq(CH.recListOf({ data: [], totalPages: "4" }).totalPages, 4);
  eq(CH.recListOf([{ id: 1 }]), null); eq(CH.recListOf({ items: [] }), null);
  eq(CH.recWarehouseId({ warehouseId: WHL.toUpperCase() }), WHL); eq(CH.recWarehouseId({ warehouse: { id: WHL } }), WHL); eq(CH.recWarehouseId({}), "");
});
t("C circaListOf / circaRow: data.list + total; thiếu total → null; id / pos_id không phải uuid → bỏ dòng; chỉ giữ trường cần", () => {
  const j = { success: true, data: { list: [{ id: SID, code: "ICS00242", pos_id: POS, pos_name: "CIRCA LUMINA", status: "OPEN", counting_mode: "QR", created_at: "2026-11-22T03:00:00Z", created_by_name: "A", total_lines: 5, completed_lines: 1, secret: "x" }], total: 239, status_counts: { OPEN: 17 } } };
  const L = CH.circaListOf(j); eq(L.total, 239); eq(L.list.length, 1);
  deq(CH.circaRow(L.list[0]), { id: SID, code: "ICS00242", pos_id: POS, pos_name: "CIRCA LUMINA", status: "OPEN", counting_mode: "QR", created_at: "2026-11-22T03:00:00Z", created_by_name: "A", total_lines: 5, completed_lines: 1 });
  eq(CH.circaListOf({ success: true, data: { list: [] } }).total, null);
  eq(CH.circaListOf({ success: false, data: { list: [] } }), null); eq(CH.circaListOf({ data: {} }), null);
  eq(CH.circaRow({ id: "abc", pos_id: POS }), null); eq(CH.circaRow({ id: SID, pos_id: "x" }), null);
});
t("C hasCapability: mảng chuỗi, mảng object, lồng nhau, không đọc được → null", () => {
  eq(CH.hasCapability({ data: { permissions: ["inventory_count.view", "inventory_count.manage"] } }, "inventory_count.manage"), true);
  eq(CH.hasCapability({ data: { roles: [{ code: "STOCKTAKE", permissions: [{ code: "inventory_count.manage", scope: "CLIENT" }] }] } }, "inventory_count.manage"), true);
  eq(CH.hasCapability({ data: { capabilities: [{ name: "inventory_count.view" }] } }, "inventory_count.manage"), false);
  eq(CH.hasCapability({ data: { principal: { id: "x", type: "PERSON" } } }, "inventory_count.manage"), null);
  eq(CH.hasCapability(null, "inventory_count.manage"), null);
  eq(CH.hasCapability({ data: { permissions: ["inventory_count.manage_extra"] } }, "inventory_count.manage"), false);
});
t("C intOf: số nguyên, chuỗi chữ số, dấu chấm ngăn nghìn đúng nhóm 3; dấu lạ → null (không đoán)", () => {
  eq(CH.intOf("12"), 12); eq(CH.intOf(" 0 "), 0); eq(CH.intOf(7), 7); eq(CH.intOf("1.234"), 1234); eq(CH.intOf("12.345.678"), 12345678);
  for (const v of ["1,234", "1.5", "1.23", "12.3456", "1 234", "-1", "", "abc", 1.5, -2, null, undefined, "1.234,5"]) eq(CH.intOf(v), null, JSON.stringify(v));
});
t("C parsePid như NWC: CIRCA-123 / 123 / số; khác → null", () => {
  eq(CH.parsePid("CIRCA-89580"), 89580); eq(CH.parsePid("circa_12"), 12); eq(CH.parsePid("123"), 123); eq(CH.parsePid(5), 5);
  for (const v of ["CIRCA-ABC", "", "CIRCA-", "12a", 0, -1]) eq(CH.parsePid(v), null, JSON.stringify(v));
});
t("C timeOf: dd/mm/yyyy HH:MM:SS (so sánh được, giữ giờ trong file); ngày không có thật / sai dạng → null; số Excel cùng thang", () => {
  const a = CH.timeOf("22/11/2026 12:54:05"), b = CH.timeOf("22/11/2026 12:54:06"), c = CH.timeOf("01/12/2026 00:00:00");
  ok(a < b && b < c); eq(CH.fmtTime(a), "22/11/2026 12:54:05");
  for (const v of ["31/02/2026 10:00:00", "22/13/2026 10:00:00", "22/11/2026 24:00:00", "2026-11-22 10:00:00", "22/11/2026", "", null]) eq(CH.timeOf(v), null, JSON.stringify(v));
  eq(CH.timeOf(Date.UTC(2026, 10, 22, 12) / 86400000 + 25569), CH.timeOf("22/11/2026 12:00:00"), "ô ngày Excel");
});

// ================= D. quy tắc chọn thẻ (chon.js + core.js THẬT) =================
const DSH = { pid: "Mã SP", name: "Tên sản phẩm", unit: "ĐVT", ton: "Tồn hệ thống", daDem: "Đã đếm", rfid: "RFID", thuCong: "Thủ công", status: "Trạng thái" };
// một phiên NW giả: products [{pid, status, daDem, daDemRaw, thuCong, unit, ton, noDs, tags:[{epc, uid, qty, time, thucTe, st, pidRaw}]}]
// → {a: analyzeSession, ds, ct, parsed}
function ses(id, createdAt, products, o) {
  o = o || {};
  const ds = [], ct = [];
  for (const p of products) {
    const sum = (p.tags || []).reduce((s, x) => s + x.qty, 0), daDem = p.daDem == null ? sum : p.daDem, tc = p.thuCong || 0;
    if (!p.noDs) ds.push({ [DSH.pid]: "CIRCA-" + p.pid, [DSH.name]: "SP " + p.pid, [DSH.unit]: p.unit || "cái", [DSH.ton]: String(p.ton == null ? daDem : p.ton), [DSH.daDem]: p.daDemRaw || String(daDem),
      [DSH.rfid]: String(daDem - tc), [DSH.thuCong]: String(tc), [DSH.status]: p.status || "Khớp" });
    for (const x of p.tags || []) ct.push({ "Mã SP": x.pidRaw || "CIRCA-" + p.pid, "Tên sản phẩm": "SP " + p.pid, "EPC": x.epc, "UID": x.uid || "", "Số lượng thẻ": String(x.qty), "Thực tế nhập": x.thucTe || "",
      "ĐVT": p.unit || "cái", "Lần quét cuối": x.time === undefined ? "22/11/2026 10:00:00" : x.time, "Trạng thái": x.st || "Đã quét" });
  }
  const parsed = NWC.parseSession(ct, o.la || []);
  return { a: CH.analyzeSession({ id, createdAt }, o.ds || ds, ct, parsed), ds, ct, parsed };
}
const U1 = (unit, rate, base) => ({ unit, convert_rate: rate, base_unit: !!base });
const dOf = pid => ({ product_id: pid, product_name: "SP " + pid, unit_name: "cái", retail_units: [U1("cái", 1, true), U1("hộp", 10)] });
// lookups: mọi EPC Circa nhận (đúng SP của thẻ), UID 404; EPC trong `unknown` → 404
function lk(tags, unknown) {
  const m = {};
  tags.forEach(x => { m[x.uid] = null; m[x.epc] = (unknown || []).includes(x.epc) ? null : dOf(x.pid); });
  return m;
}
let SEQ = 0;
const tg = (pid, qty, time, o) => Object.assign({ pid, epc: "AB" + String(++SEQ).padStart(22, "0"), uid: "U" + SEQ, qty, time }, o || {});
const T1 = "22/11/2026 09:00:00", T2 = "22/11/2026 10:00:00";
const ISO1 = "2026-11-22T01:00:00.000Z", ISO2 = "2026-11-22T02:00:00.000Z";
function run(sessions, lookups, scans) {
  const pick = CH.choose(sessions.map(s => s.a));
  const fin = CH.finish(NWC, pick, lookups, scans || []);
  const bodies = fin.P3 ? NWC.batches(fin.P3.items, SID, "NW-RFID", scans || []) : null;
  return { pick, fin, bodies, codes: bodies ? bodies.flatMap(NWC.bodyCodes) : [], rows: fin.P3 ? CH.previewRows(fin, bodies.excluded) : null, aside: Object.fromEntries((fin.aside || []).map(a => [a.pid, a.reason])) };
}
t("D khớp đơn giản: SP Khớp, Thủ công 0, tổng thẻ = Đã đếm → gửi mọi thẻ; Đã đếm có dấu chấm ngăn nghìn vẫn đọc", () => {
  const x = [tg(1, 1000, T1), tg(1, 234, T1)];
  const s = ses(NWID, ISO1, [{ pid: 1, tags: x, daDemRaw: "1.234" }]);
  eq(Object.keys(s.a.eligible).length, 1); eq(s.a.eligible[1].qty, 1234); eq(s.a.eligible[1].daDem, 1234);
  const r = run([s], lk(x));
  deq(r.codes.sort(), x.map(y => y.epc).sort()); eq(r.fin.aside.length, 0); ok(r.fin.P3.sum.okToSend, r.fin.P3.sum.blockers.join("; "));
  eq(r.rows.rows[0].status, "gui"); eq(r.rows.rows[0].nwId, NWID); eq(r.rows.total.send, 2);
});
t("D 2 phiên cùng Khớp 1 SP với tập thẻ KHÁC nhau → chỉ thẻ của phiên có Lần quét cuối lớn nhất (không gộp)", () => {
  const old = [tg(2, 1, "22/11/2026 11:00:00"), tg(2, 1, T1)], neu = [tg(2, 1, T2), tg(2, 1, T2), tg(2, 1, T2)];
  // phiên NWID tạo SAU nhưng quét SP này sớm hơn (max 10:00 < 11:00) → lấy phiên NWID2
  const r = run([ses(NWID, ISO2, [{ pid: 2, tags: neu }]), ses(NWID2, ISO1, [{ pid: 2, tags: old }])], lk(old.concat(neu)));
  eq(r.pick.products.length, 1); eq(r.pick.products[0].nwId, NWID2);
  deq(r.codes.sort(), old.map(y => y.epc).sort());
  eq(r.pick.products[0].cands.length, 2); eq(r.fin.aside.length, 0);
});
t("D Lần quét cuối bằng nhau → phiên createdAt mới hơn; bằng cả 2 → để riêng; giờ không đọc được ở 1 phiên → để riêng", () => {
  const a = [tg(3, 1, T2)], b = [tg(3, 1, T2), tg(3, 1, T1)];
  let r = run([ses(NWID, ISO1, [{ pid: 3, tags: a }]), ses(NWID2, ISO2, [{ pid: 3, tags: b }])], lk(a.concat(b)));
  eq(r.pick.products[0].nwId, NWID2); deq(r.codes.sort(), b.map(y => y.epc).sort());
  r = run([ses(NWID, ISO1, [{ pid: 3, tags: a }]), ses(NWID2, ISO1, [{ pid: 3, tags: b }])], lk(a.concat(b)));
  eq(r.pick.products.length, 0); eq(r.aside[3], "khong-chon-duoc-phien"); eq(r.codes.length, 0);
  const bad = [tg(3, 1, "22-11-2026 10:00")];
  r = run([ses(NWID, ISO1, [{ pid: 3, tags: a }]), ses(NWID2, ISO2, [{ pid: 3, tags: bad }])], lk(a.concat(bad)));
  eq(r.aside[3], "khong-chon-duoc-phien"); ok(/Lần quét cuối/.test(r.fin.aside[0].detail));
  // chỉ 1 phiên có SP thì giờ hỏng không sao
  r = run([ses(NWID2, ISO2, [{ pid: 3, tags: bad }])], lk(bad)); eq(r.codes.length, 1);
});
t("D 2 phiên cùng thẻ → gửi 1 lần (phiên quét sau)", () => {
  const x = tg(4, 1, T1);
  const r = run([ses(NWID, ISO1, [{ pid: 4, tags: [x] }]), ses(NWID2, ISO2, [{ pid: 4, tags: [Object.assign({}, x, { time: T2 })] }])], lk([x]));
  deq(r.codes, [x.epc]); eq(r.pick.products[0].nwId, NWID2); eq(r.fin.aside.length, 0);
});
t("D khớp nhờ đếm thủ công → để riêng “Khớp nhờ đếm thủ công”, không gửi thẻ nào của SP", () => {
  const x = [tg(5, 1, T1)];
  const s = ses(NWID, ISO1, [{ pid: 5, tags: x, daDem: 3, thuCong: 2 }]);
  eq(s.a.aside[0].reason, "thu-cong");
  const r = run([s], lk(x)); eq(r.aside[5], "thu-cong"); eq(r.codes.length, 0);
  eq(r.rows.rows[0].status, "de-rieng"); ok(/thủ công/.test(r.rows.rows[0].label));
});
t("D tổng Số lượng thẻ ≠ Đã đếm → để riêng “file xuất không nhất quán”; Đã đếm không đọc được → cũng vậy", () => {
  const x = [tg(6, 1, T1), tg(6, 1, T1)];
  let r = run([ses(NWID, ISO1, [{ pid: 6, tags: x, daDem: 3 }])], lk(x));
  eq(r.aside[6], "khong-nhat-quan"); ok(/≠ “Đã đếm” 3/.test(r.fin.aside[0].detail)); eq(r.codes.length, 0);
  r = run([ses(NWID, ISO1, [{ pid: 6, tags: x, daDemRaw: "2,0" }])], lk(x)); eq(r.aside[6], "khong-nhat-quan");
  // Khớp, Đã đếm 0, không thẻ → chỉ đếm, không liệt kê
  const s = ses(NWID, ISO1, [{ pid: 60, tags: [], daDem: 0 }]); eq(s.a.khopZero, 1); eq(s.a.aside.length, 0);
});
t("D SP Thiếu / Thừa / Chưa đếm không gửi, chỉ đếm theo trạng thái", () => {
  const x = [tg(7, 1, T1)], y = [tg(8, 1, T1)], z = [tg(9, 1, T1)], w = [tg(10, 1, T1)];
  const s = ses(NWID, ISO1, [{ pid: 7, tags: x, status: "Thiếu", ton: 2 }, { pid: 8, tags: y, status: "Thừa", ton: 0 }, { pid: 9, tags: z, status: "Chưa đếm", daDem: 0 }, { pid: 10, tags: w }]);
  deq(s.a.counts, { "Thiếu": 1, "Thừa": 1, "Chưa đếm": 1, "Khớp": 1 });
  const r = run([s], lk(x.concat(y, z, w)));
  deq(r.pick.products.map(p => p.pid), [10]); eq(r.fin.aside.length, 0); deq(r.codes, [w[0].epc]);
});
t("D phiên Circa đã có lượt quét KHÁC (không phải thẻ của ta) của SP → để riêng CẢ SP", () => {
  const x = [tg(11, 1, T1), tg(11, 1, T1)], y = [tg(12, 1, T1)];
  const scans = [{ qr_code: "1794000000000Q1", product_id: 11, scanned_qty: 1, unit_code: "cái", conversion_factor: 1, base_qty: 1, device_id: "PDA" }];
  const r = run([ses(NWID, ISO1, [{ pid: 11, tags: x }, { pid: 12, tags: y }])], lk(x.concat(y)), scans);
  eq(r.aside[11], "luot-khac"); ok(/1794000000000Q1/.test(r.fin.aside[0].detail)); deq(r.codes, [y[0].epc]);
});
t("D lượt quét có sẵn đều là thẻ của ta (đúng số) → chỉ gửi thẻ còn thiếu; đủ hết → “đã có”, không gửi", () => {
  const x = [tg(13, 1, T1), tg(13, 1, T1), tg(13, 1, T1)];
  const sc = q => ({ qr_code: q.epc, product_id: 13, scanned_qty: 1, unit_code: "cái", conversion_factor: 1, base_qty: 1, device_id: "NW-RFID" });
  let r = run([ses(NWID, ISO1, [{ pid: 13, tags: x }])], lk(x), [sc(x[0])]);
  eq(r.fin.aside.length, 0); deq(r.codes.sort(), [x[1].epc, x[2].epc].sort()); eq(r.bodies.excluded.length, 1);
  eq(r.rows.rows[0].status, "gui-thieu"); eq(r.rows.rows[0].have, 1); eq(r.rows.rows[0].send, 2);
  r = run([ses(NWID, ISO1, [{ pid: 13, tags: x }])], lk(x), x.map(sc));
  eq(r.codes.length, 0); eq(r.rows.rows[0].status, "da-co"); eq(r.bodies.length, 0);
});
t("D lượt có sẵn của thẻ ta nhưng sai số / nhiều lượt / sai SP / bằng mã khác của thẻ → để riêng SP (cách an toàn)", () => {
  const x = [tg(14, 1, T1, { uid: "E14UID" + SEQ })];
  const base = { product_id: 14, scanned_qty: 1, unit_code: "cái", conversion_factor: 1, base_qty: 1, device_id: "NW-RFID" };
  let r = run([ses(NWID, ISO1, [{ pid: 14, tags: x }])], lk(x), [Object.assign({}, base, { qr_code: x[0].epc, base_qty: 10, scanned_qty: 1, unit_code: "hộp", conversion_factor: 10 })]);
  eq(r.aside[14], "luot-khac"); ok(/sai-so/.test(r.fin.aside[0].detail));
  r = run([ses(NWID, ISO1, [{ pid: 14, tags: x }])], lk(x), [Object.assign({}, base, { qr_code: x[0].epc }), Object.assign({}, base, { qr_code: x[0].epc.toLowerCase() })]);
  eq(r.aside[14], "luot-khac");
  r = run([ses(NWID, ISO1, [{ pid: 14, tags: x }])], lk(x), [Object.assign({}, base, { qr_code: x[0].epc, product_id: 99 })]);
  eq(r.aside[14], "luot-khac"); ok(/SP 99/.test(r.fin.aside[0].detail));
  r = run([ses(NWID, ISO1, [{ pid: 14, tags: x }])], lk(x), [Object.assign({}, base, { qr_code: x[0].uid })]);
  eq(r.aside[14], "luot-khac"); ok(/mã khác của thẻ/.test(r.fin.aside[0].detail)); eq(r.codes.length, 0);
});
t("D 1 thẻ Circa không nhận → để riêng CẢ SP (không gửi một phần); SP khác vẫn gửi", () => {
  const x = [tg(15, 1, T1), tg(15, 1, T1)], y = [tg(16, 1, T1)];
  const r = run([ses(NWID, ISO1, [{ pid: 15, tags: x }, { pid: 16, tags: y }])], lk(x.concat(y), [x[1].epc]));
  eq(r.aside[15], "the-khong-gui"); ok(/Circa không nhận 1\/2/.test(r.fin.aside[0].detail)); deq(r.codes, [y[0].epc]);
  eq(r.fin.P3.sum.modes["khong-nhan"], 0, "kế hoạch gửi không còn thẻ không nhận");
});
t("D thẻ bị giữ (EPC trỏ SP khác trên Circa) → để riêng cả SP", () => {
  const x = [tg(17, 1, T1), tg(17, 1, T1)];
  const L = lk(x); L[x[0].epc] = dOf(999);
  const r = run([ses(NWID, ISO1, [{ pid: 17, tags: x }])], L);
  eq(r.aside[17], "the-khong-gui"); ok(/giữ lại 1\/2/.test(r.fin.aside[0].detail)); eq(r.codes.length, 0);
});
t("D lệch quy đổi → gửi kèm đơn vị gốc như NWC (quy tắc gửi không đổi)", () => {
  const x = [tg(18, 8, T1)];
  const r = run([ses(NWID, ISO1, [{ pid: 18, tags: x }])], lk(x));
  eq(r.bodies[0].items[0].unit_name, "cái"); eq(r.bodies[0].items[0].quantity, 8); eq(r.rows.rows[0].circaBase, 8);
});
t("D mã (EPC/UID) trùng giữa 2 SP khác nhau trong tập đã chọn → để riêng cả 2 SP", () => {
  const x = tg(19, 1, T1), y = tg(20, 1, T2, { epc: x.epc });
  const r = run([ses(NWID, ISO1, [{ pid: 19, tags: [x] }]), ses(NWID2, ISO2, [{ pid: 20, tags: [y] }])], Object.assign(lk([x]), lk([y])));
  eq(r.aside[19], "trung-ma"); eq(r.aside[20], "trung-ma"); eq(r.codes.length, 0);
});
t("D dòng lỗi / bị bỏ qua / có “Thực tế nhập” trong Chi tiết quét → để riêng SP của dòng đó; dòng không rõ SP → phiên không dùng được", () => {
  const ok1 = [tg(21, 1, T1)];
  let s = ses(NWID, ISO1, [{ pid: 21, tags: ok1 }, { pid: 22, tags: [tg(22, 1, T1, { st: "Chưa quét" })], daDem: 1 }]);
  eq(s.a.aside.find(e => e.pid === 22).reason, "khong-nhat-quan"); ok(s.a.eligible[21]);
  s = ses(NWID, ISO1, [{ pid: 21, tags: ok1 }, { pid: 23, tags: [tg(23, 1, T1, { thucTe: "1" })] }]);
  eq(s.a.aside.find(e => e.pid === 23).reason, "khong-nhat-quan"); ok(/Thực tế nhập/.test(s.a.aside.find(e => e.pid === 23).detail));
  s = ses(NWID, ISO1, [{ pid: 21, tags: ok1 }, { pid: 24, tags: [tg(24, 1, T1)], daDem: 2 }]);
  s.ct.push(Object.assign({}, s.ct[1], { "Số lượng thẻ": "1.000" }));
  const s2 = CH.analyzeSession({ id: NWID, createdAt: ISO1 }, s.ds, s.ct, NWC.parseSession(s.ct, []));
  eq(s2.aside.find(e => e.pid === 24).reason, "khong-nhat-quan");
  const s3 = ses(NWID, ISO1, [{ pid: 21, tags: ok1 }, { pid: 25, tags: [tg(25, 1, T1, { pidRaw: "CIRCA-XYZ" })], noDs: true }]);
  ok(s3.a.fatal && /không xác định được sản phẩm/.test(s3.a.fatal), s3.a.fatal);
  const pick = CH.choose([s3.a]); eq(pick.fatal.length, 1); eq(pick.products.length, 0);
  // một phiên fatal chặn cả lần chọn (không gửi gì từ phiên khác)
  const pick2 = CH.choose([ses(NWID2, ISO2, [{ pid: 26, tags: [tg(26, 1, T1)] }]).a, s3.a]); eq(pick2.fatal.length, 1); eq(pick2.products.length, 0);
  // chọn 2 lần cùng một phiên → fatal
  const one = ses(NWID2, ISO2, [{ pid: 26, tags: [tg(26, 1, T1)] }]).a;
  eq(CH.choose([one, one]).fatal.length, 1);
});
t("D Danh sách kiểm kê thiếu cột “Thủ công” → phiên không dùng được; SP 2 dòng → để riêng; thẻ của SP không có trong DS → chỉ đếm", () => {
  const x = [tg(27, 1, T1)];
  const s = ses(NWID, ISO1, [{ pid: 27, tags: x }]);
  const ds = s.ds.map(r => { const o = Object.assign({}, r); delete o["Thủ công"]; return o; });
  ok(/Thủ công/.test(CH.analyzeSession({ id: NWID, createdAt: ISO1 }, ds, s.ct, s.parsed).fatal));
  const a2 = CH.analyzeSession({ id: NWID, createdAt: ISO1 }, s.ds.concat(s.ds), s.ct, s.parsed);
  eq(a2.aside[0].reason, "khong-nhat-quan"); ok(/nhiều dòng/.test(a2.aside[0].detail));
  const a3 = CH.analyzeSession({ id: NWID, createdAt: ISO1 }, [], s.ct, s.parsed);
  eq(a3.notInDs, 1); eq(Object.keys(a3.eligible).length, 0);
});
t("D thẻ chưa tra (lỗi mạng) → finish chờ tra lại (pending), không để riêng, không lập kế hoạch", () => {
  const x = [tg(28, 1, T1)];
  const L = lk(x); delete L[x[0].epc];
  const pick = CH.choose([ses(NWID, ISO1, [{ pid: 28, tags: x }]).a]);
  const fin = CH.finish(NWC, pick, L, []);
  eq(fin.pending, true); eq(fin.chuaTra, 1); eq(fin.P3, undefined); eq(fin.aside.length, 0);
});
t("D bảng xem trước: dòng tổng; thứ tự gửi → gửi phần thiếu → đã có → để riêng", () => {
  const a = [tg(30, 1, T1)], b = [tg(31, 1, T1), tg(31, 1, T1)], c = [tg(32, 1, T1)], d = [tg(33, 1, T1)];
  const sc = q => ({ qr_code: q.epc, product_id: q.pid, scanned_qty: 1, unit_code: "cái", conversion_factor: 1, base_qty: 1 });
  const r = run([ses(NWID, ISO1, [{ pid: 30, tags: a }, { pid: 31, tags: b }, { pid: 32, tags: c }, { pid: 33, tags: d, thuCong: 1, daDem: 2 }])], lk(a.concat(b, c, d)), [sc(b[0]), sc(c[0])]);
  deq(r.rows.rows.map(x => [x.pid, x.status]), [[30, "gui"], [31, "gui-thieu"], [32, "da-co"], [33, "de-rieng"]]);
  const T = r.rows.total;
  eq(T.gui, 1); eq(T["gui-thieu"], 1); eq(T["da-co"], 1); eq(T["de-rieng"], 1); eq(T.tags, 4); eq(T.nwQty, 4); eq(T.circaBase, 4); eq(T.send, 2); eq(T.have, 2); eq(T.sendSp, 2);
  eq(T.asideTags, 1); eq(T.asideQty, 1);
});
t("D tái hiện mục 2: R1 09:00 Khớp RFID 3 thẻ; R2 10:00 Khớp nhờ Thủ công 1 → để riêng (phiên mới nhất R2), KHÔNG gửi thẻ R1", () => {
  const r1 = [tg(40, 1, T1), tg(40, 1, T1), tg(40, 1, T1)], r2 = [tg(40, 1, T2), tg(40, 1, T2)];
  const r = run([ses(NWID, ISO1, [{ pid: 40, tags: r1 }]), ses(NWID2, ISO2, [{ pid: 40, tags: r2, daDem: 3, thuCong: 1 }])], lk(r1.concat(r2)));
  eq(r.pick.products.length, 0); eq(r.codes.length, 0); eq(r.aside[40], "thu-cong");
  const a = r.fin.aside[0]; eq(a.nwId, NWID2); ok(a.detail.indexOf(NWID2.slice(0, 8)) >= 0 && /phiên mới nhất/.test(a.detail) && /Thủ công = 1/.test(a.detail), a.detail);
  ok(a.detail.indexOf(NWID.slice(0, 8)) >= 0, "nêu phiên cũ hơn"); eq(a.cands.length, 2);
  // đảo thứ tự chọn phiên: kết quả như nhau
  const rr = run([ses(NWID2, ISO2, [{ pid: 40, tags: r2, daDem: 3, thuCong: 1 }]), ses(NWID, ISO1, [{ pid: 40, tags: r1 }])], lk(r1.concat(r2)));
  eq(rr.codes.length, 0); eq(rr.aside[40], "thu-cong");
});
t("D phiên cũ Khớp + phiên mới Thiếu (quét sau) → để riêng “Phiên NW mới hơn không khớp”, nêu phiên + trạng thái, không gửi", () => {
  const old = [tg(41, 1, T1), tg(41, 1, T1)], neu = [tg(41, 1, T2)];
  const r = run([ses(NWID, ISO1, [{ pid: 41, tags: old }]), ses(NWID2, ISO2, [{ pid: 41, tags: neu, status: "Thiếu", ton: 2 }])], lk(old.concat(neu)));
  eq(r.codes.length, 0); eq(r.aside[41], "phien-moi-khong-khop"); eq(r.fin.aside[0].nwId, NWID2);
  ok(/phiên mới nhất 6e6361e1 \(quét 22\/11\/2026 10:00:00\) ghi “Thiếu”/.test(r.fin.aside[0].detail), r.fin.aside[0].detail);
  eq(r.rows.rows[0].status, "de-rieng"); ok(/mới hơn không khớp/.test(r.rows.rows[0].label));
  // phiên mới Thiếu mà KHÔNG có thẻ nào (giờ quét không rõ) → không chọn được phiên
  const r2 = run([ses(NWID, ISO1, [{ pid: 41, tags: old }]), ses(NWID2, ISO2, [{ pid: 41, tags: [], status: "Thiếu", daDem: 0, ton: 2 }])], lk(old));
  eq(r2.codes.length, 0); eq(r2.aside[41], "khong-chon-duoc-phien"); ok(/6e6361e1 \(không có dòng nào/.test(r2.fin.aside[0].detail), r2.fin.aside[0].detail);
});
t("D phiên cũ Khớp + phiên mới “Chưa đếm” → gửi từ phiên cũ (phiên Chưa đếm không ảnh hưởng)", () => {
  const old = [tg(42, 1, T1), tg(42, 2, T1)];
  const r = run([ses(NWID, ISO1, [{ pid: 42, tags: old }]), ses(NWID2, ISO2, [{ pid: 42, tags: [], status: "Chưa đếm", daDem: 0, ton: 3 }])], lk(old));
  deq(r.codes.sort(), old.map(y => y.epc).sort()); eq(r.pick.products[0].nwId, NWID); eq(r.fin.aside.length, 0); eq(r.pick.products[0].cands.length, 1);
});
t("D phiên cũ Thiếu + phiên mới Khớp → gửi thẻ phiên mới; phiên cũ Khớp-thủ-công + phiên mới Khớp đủ điều kiện → gửi phiên mới", () => {
  const old = [tg(43, 1, T1)], neu = [tg(43, 1, T2), tg(43, 1, T2)];
  let r = run([ses(NWID, ISO1, [{ pid: 43, tags: old, status: "Thiếu", ton: 2 }]), ses(NWID2, ISO2, [{ pid: 43, tags: neu }])], lk(old.concat(neu)));
  deq(r.codes.sort(), neu.map(y => y.epc).sort()); eq(r.pick.products[0].nwId, NWID2); eq(r.fin.aside.length, 0);
  const o2 = [tg(44, 1, T1)], n2 = [tg(44, 1, T2)];
  r = run([ses(NWID, ISO1, [{ pid: 44, tags: o2, daDem: 2, thuCong: 1 }]), ses(NWID2, ISO2, [{ pid: 44, tags: n2 }])], lk(o2.concat(n2)));
  deq(r.codes, [n2[0].epc]); eq(r.pick.products[0].nwId, NWID2);
});
t("D Thiếu ở cả 2 phiên → không gửi, không liệt kê để riêng (chỉ đếm theo trạng thái)", () => {
  const a = [tg(45, 1, T1)], b = [tg(45, 1, T2)];
  const r = run([ses(NWID, ISO1, [{ pid: 45, tags: a, status: "Thiếu", ton: 3 }]), ses(NWID2, ISO2, [{ pid: 45, tags: b, status: "Thiếu", ton: 3 }])], lk(a.concat(b)));
  eq(r.codes.length, 0); eq(r.fin.aside.length, 0); eq(r.pick.products.length, 0);
});
t("D Khớp nhưng “Tồn hệ thống” ≠ “Đã đếm” / không đọc được → để riêng “file xuất không nhất quán”; thiếu cột “Tồn hệ thống” → phiên không dùng được", () => {
  const x = [tg(46, 1, T1), tg(46, 1, T1)];
  let r = run([ses(NWID, ISO1, [{ pid: 46, tags: x, ton: 5 }])], lk(x));
  eq(r.aside[46], "khong-nhat-quan"); ok(/“Tồn hệ thống” 5 ≠ “Đã đếm” 2/.test(r.fin.aside[0].detail), r.fin.aside[0].detail); eq(r.codes.length, 0);
  r = run([ses(NWID, ISO1, [{ pid: 46, tags: x, ton: "?" }])], lk(x));
  eq(r.aside[46], "khong-nhat-quan"); ok(/Tồn hệ thống/.test(r.fin.aside[0].detail));
  // Tồn có dấu chấm ngăn nghìn: 1.234 = 1234 → vẫn gửi
  const y = [tg(47, 1000, T1), tg(47, 234, T1)];
  r = run([ses(NWID, ISO1, [{ pid: 47, tags: y, ton: "1.234", daDemRaw: "1.234" }])], lk(y)); eq(r.codes.length, 2);
  const s = ses(NWID, ISO1, [{ pid: 46, tags: x }]);
  const ds = s.ds.map(o => { const c = Object.assign({}, o); delete c["Tồn hệ thống"]; return c; });
  ok(/Tồn hệ thống/.test(CH.analyzeSession({ id: NWID, createdAt: ISO1 }, ds, s.ct, s.parsed).fatal));
  // phiên mới hơn Khớp nhưng Tồn ≠ Đã đếm → để riêng cả SP dù phiên cũ Khớp đủ điều kiện
  const o = [tg(48, 1, T1)], n = [tg(48, 1, T2)];
  r = run([ses(NWID, ISO1, [{ pid: 48, tags: o }]), ses(NWID2, ISO2, [{ pid: 48, tags: n, ton: 4 }])], lk(o.concat(n)));
  eq(r.codes.length, 0); eq(r.aside[48], "khong-nhat-quan"); ok(/phiên mới nhất 6e6361e1/.test(r.fin.aside[0].detail));
});
t("D đối chiếu cuối chỉ xét SP đã gửi: lượt SP khác của phiên Circa không làm CHƯA ĐẠT; lượt lạ trên SP đã gửi → CHƯA ĐẠT", () => {
  const x = [tg(34, 1, T1)];
  const r = run([ses(NWID, ISO1, [{ pid: 34, tags: x }])], lk(x));
  const mine = { qr_code: x[0].epc, product_id: 34, scanned_qty: 1, unit_code: "cái", conversion_factor: 1, base_qty: 1 };
  const other = { qr_code: "QR-KHAC", product_id: 777, scanned_qty: 5, unit_code: "cái", conversion_factor: 1, base_qty: 5 };
  let R = CH.reconcileOurs(NWC, r.fin.P3, [mine, other]);
  eq(R.ok, true); eq(R.others.length, 1); eq(R.ours.length, 0); eq(R.circaBase, 1); eq(R.otherSp, 1);
  R = CH.reconcileOurs(NWC, r.fin.P3, [mine, other, Object.assign({}, other, { qr_code: "QR-2", product_id: 34, base_qty: 1 })]);
  eq(R.ok, false); eq(R.ours.length, 1); eq(R.circaBase, 2);
  eq(CH.reconcileOurs(NWC, r.fin.P3, [other]).ok, false, "thiếu lượt của thẻ ta");
});

// ================= E. bridge.js =================
async function partE() {
  await ta("E đọc token NW từ localStorage auth-storage; hỏng / thiếu → null", async () => {
    const runIt = (ls) => { const g = { window: { localStorage: { getItem: k => ls[k] == null ? null : ls[k] } }, JSON }; return vm.runInNewContext("(" + KKBRIDGE.kkReadNwToken.toString() + ")()", g); };
    eq(runIt({ "auth-storage": JSON.stringify({ state: { accessToken: "abc.def.ghi" } }) }), "abc.def.ghi");
    eq(runIt({}), null); eq(runIt({ "auth-storage": "{hỏng" }), null); eq(runIt({ "auth-storage": JSON.stringify({ state: {} }) }), null);
    eq(runIt({ "auth-storage": JSON.stringify({ state: { accessToken: 5 } }) }), null);
  });
  await ta("E đọc cookie session_token (giải mã %), không nhầm cookie khác", async () => {
    const runIt = (c) => vm.runInNewContext("(" + KKBRIDGE.kkReadCircaToken.toString() + ")()", { document: { cookie: c }, decodeURIComponent, String });
    eq(runIt("a=1; session_token=abc%2Edef; b=2"), "abc.def"); eq(runIt("my_session_token=x"), null); eq(runIt(""), null);
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

// ================= H. background.js THẬT trong vm =================
// Nạp background.js THẬT + importScripts các file thật của ext/ vào một realm riêng; chrome.* và fetch là bản giả (không mạng).
function swWorld() {
  const L = { msg: [], rm: [] }, session = new Map(), local = new Map(), created = [], log = [];
  const tabs = [{ id: 11, url: CFG.CIRCA_ADMIN + "/kiem-ke-ton-kho", index: 0, windowId: 1, active: true }, { id: 21, url: CFG.NW_APP + "/vi/stock/reconciliation", index: 2, windowId: 1 }];
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
      query: async q => tabs.filter(x => !q || !q.url || x.url.indexOf(q.url.replace(/\*$/, "")) === 0),
      get: async id => { const x = tabs.find(y => y.id === id); if (!x) throw new Error("No tab with id"); return x; },
      create: async o => { const x = { id: 100 + created.length, url: o.url, index: o.index, windowId: 1 }; created.push(o); tabs.push(x); return x; },
      update: async (id) => tabs.find(x => x.id === id),
      onRemoved: { addListener: f => L.rm.push(f) }
    },
    scripting: { executeScript: async ({ func }) => [{ result: func.name === "kkReadNwToken" ? TOK.nw : TOK.circa }] }
    // KHÔNG có chrome.webRequest: v0.2.0 không còn quyền này, background phải chạy được khi thiếu nó
  };
  const fetchFn = async (u, o) => {
    const url = new URL(u);
    log.push({ u, m: o.method, p: url.pathname, q: Object.fromEntries(url.searchParams), store: o.headers["X-Store-Id"] || null, body: o.body ? JSON.parse(o.body) : undefined });
    if (/export$/.test(url.pathname)) return fakeResp(200, "PK\u0003\u0004", { "content-type": "application/octet-stream" });
    if (url.pathname === "/v1/authz/me") return fakeResp(200, { success: true, data: { permissions: ["inventory_count.manage"] } });
    return fakeResp(200, { success: true, data: { list: [], total: 0, scans: [] } });
  };
  const ctx = { chrome, fetch: fetchFn, setTimeout, clearTimeout, AbortController, URL, URLSearchParams,
    btoa: s => Buffer.from(s, "binary").toString("base64"), atob: s => Buffer.from(s, "base64").toString("binary") };
  ctx.self = ctx;
  ctx.importScripts = (...files) => files.forEach(f => vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), ctx, { filename: f }));
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(EXT, "background.js"), "utf8"), ctx, { filename: "background.js" });
  const PANEL = EXT_ORIGIN + "/panel.html";
  // tin nhắn tới SW thật được structured-clone sang realm của SW: giả bằng JSON.parse của context
  const inCtx = vm.runInContext("(function (s) { return JSON.parse(s); })", ctx), clone = o => inCtx(JSON.stringify(o));
  return {
    ctx, tabs, created, log, L, session, local, PANEL,
    send: (msg, sender) => new Promise(res => { let done = false; const keep = L.msg[0](clone(msg), clone(sender), r => { done = true; res(r === undefined ? r : JSON.parse(JSON.stringify(r))); }); if (!keep && !done) res("(không trả lời)"); }),
    nw: (tabId, p) => ({ id: "kkthu", tab: { id: tabId, url: CFG.NW_APP + (p || "/vi/stock/reconciliation"), index: 2 }, frameId: 0, url: CFG.NW_APP + (p || "/vi/stock/reconciliation"), origin: CFG.NW_APP }),
    admin: tabId => ({ id: "kkthu", tab: { id: tabId, url: CFG.CIRCA_ADMIN + "/kiem-ke-ton-kho/" + SID, index: 0 }, frameId: 0, url: CFG.CIRCA_ADMIN + "/kiem-ke-ton-kho/" + SID, origin: CFG.CIRCA_ADMIN }),
    panel: tabId => ({ id: "kkthu", tab: { id: tabId, url: PANEL }, url: PANEL, origin: EXT_ORIGIN })
  };
}
async function partH() {
  await ta("H trang NW (đúng đường dẫn danh sách) → openPanel mở đúng 1 tab panel.html (không tham số), cạnh tab NW; không gọi mạng", async () => {
    const S = swWorld();
    const r = await S.send({ op: "openPanel" }, S.nw(21));
    eq(r.ok, true); eq(S.created.length, 1); eq(S.created[0].url, S.PANEL); eq(S.created[0].index, 3); eq(S.created[0].openerTabId, 21);
    eq(S.log.length, 0, "mở panel không gọi mạng");
  });
  await ta("H trang NW sai đường dẫn / lệnh khác → từ chối; khung con / origin lạ / extension khác / trang admin → bỏ qua, không trả lời", async () => {
    const S = swWorld();
    for (const p of ["/vi/dashboard", "/vi/stock/reconciliation/" + NWID, "/stock/reconciliation"]) { const r = await S.send({ op: "openPanel" }, S.nw(21, p)); eq(r.ok, false, p); }
    eq((await S.send({ op: "circaList", page: 1 }, S.nw(21))).ok, false, "trang NW không được gọi lệnh panel");
    eq((await S.send({ op: "submit", id: SID, pos: POS, body: { session_id: SID } }, S.nw(21))).ok, false);
    const n = S.nw(21);
    eq(await S.send({ op: "openPanel" }, Object.assign({}, n, { frameId: 3 })), "(không trả lời)");
    eq(await S.send({ op: "openPanel" }, Object.assign({}, n, { id: "khac" })), "(không trả lời)");
    eq(await S.send({ op: "openPanel" }, Object.assign({}, n, { url: "https://evil.example/vi/stock/reconciliation", origin: "https://evil.example" })), "(không trả lời)");
    eq(await S.send({ op: "openPanel" }, S.admin(11)), "(không trả lời)", "không còn xử lý tin từ trang admin");
    eq(await S.send({ op: "created", id: SID, pos: POS }, S.admin(11)), "(không trả lời)", "lệnh v0.1.0");
    eq(await S.send("openPanel", S.nw(21)), "(không trả lời)", "tin không phải object");
    eq(S.created.length, 0); eq(S.log.length, 0);
  });
  await ta("H panel: danh sách phiên Circa GET page/limit=20 KHÔNG X-Store-Id; trang ngoài 1..10 → từ chối, không gọi mạng", async () => {
    const S = swWorld(), P = S.panel(41);
    const r = await S.send({ op: "circaList", page: 3 }, P);
    eq(r.ok, true); eq(S.log.length, 1); eq(S.log[0].p, "/v1/inventory/count/sessions"); deq(S.log[0].q, { page: "3", limit: "20" }); eq(S.log[0].store, null);
    for (const pg of [0, 11, "1", 1.5, null]) eq((await S.send({ op: "circaList", page: pg }, P)).ok, false, String(pg));
    for (const pg of [0, 9, "2"]) eq((await S.send({ op: "nwRecList", page: pg }, P)).ok, false, String(pg));
    eq(S.log.length, 1);
    eq((await S.send({ op: "nwRecList", page: 8 }, P)).ok, true); deq(S.log[1].q, { page: "8", limit: "25" });
    const init = await S.send({ op: "init" }, P);
    eq(init.ok, true); eq(init.cfg.version, "0.2.1"); eq(init.cfg.circaPages, 10); eq(init.cfg.recPages, 8);
    eq(init.cfg.scanLimit, 60000); eq(init.cfg.scanTimeout, 120000); eq(init.cfg.scanMaxBytes, 62914560); eq(init.cfg.scanTries, 3); eq(init.cfg.scanGap, 1500); eq(init.cfg.timeout, 30000);
    eq(init.cfg.scanPage, undefined); eq(init.cfg.scanPages, undefined);
    eq(init.cfg.admin, undefined, "init không còn trả origin admin"); eq(init.cfg.nwApp, undefined, "init không còn trả origin web NW");
  });
  await ta("H panel: lệnh gắn phiên Circa dùng X-Store-Id = pos truyền vào; thiếu / sai id hoặc pos → từ chối; export trả base64", async () => {
    const S = swWorld(), P = S.panel(41);
    eq((await S.send({ op: "circaSession", id: SID, pos: POS }, P)).ok, true);
    eq(S.log[0].p, "/v1/inventory/count/sessions/" + SID); eq(S.log[0].store, POS);
    await S.send({ op: "lookup", id: SID, pos: POS, code: "AB01" }, P);
    eq(S.log[1].p, "/v1/inventory/count/qr-lookup"); deq(S.log[1].q, { pos_id: POS, qr_code: "AB01" }); eq(S.log[1].store, POS);
    const az = await S.send({ op: "circaAuthz", id: SID, pos: POS }, P); eq(az.r.manage, true); eq(az.r.j, undefined, "không trả nguyên authz/me ra panel");
    const sr = await S.send({ op: "scans", id: SID, pos: POS }, P);
    eq(sr.ok, true); eq(S.log[3].p, "/v1/inventory/count/sessions/" + SID + "/scans"); deq(S.log[3].q, { limit: "60000" }, "MỘT request limit=60000, không offset"); eq(S.log[3].store, POS);
    eq(typeof sr.r.size, "number", "background chuyển size (byte thân response) cho panel");
    await S.send({ op: "scanSummary", id: SID, pos: POS }, P);
    eq(S.log[4].p, "/v1/inventory/count/sessions/" + SID + "/summary"); deq(S.log[4].q, {}); eq(S.log[4].store, POS); eq(S.log[4].m, "GET");
    const n0 = S.log.length;
    // lệnh scans có offset / page (kể cả 0, null, chuỗi) → từ chối, không gọi mạng
    for (const m of [{ op: "circaSession", id: SID }, { op: "circaSession", pos: POS }, { op: "scans", id: "x", pos: POS }, { op: "scans", id: SID }, { op: "nwExport" }, { op: "nwRec", nwId: "../x" }, { op: "khong-co", id: SID, pos: POS },
      { op: "scans", id: SID, pos: POS, offset: 0 }, { op: "scans", id: SID, pos: POS, offset: 1000 }, { op: "scans", id: SID, pos: POS, offset: 1537 }, { op: "scans", id: SID, pos: POS, offset: "0" },
      { op: "scans", id: SID, pos: POS, offset: null }, { op: "scans", id: SID, pos: POS, page: 1 }, { op: "scans", id: SID, pos: POS, page: 0 },
      { op: "scanSummary", id: SID }, { op: "scanSummary", id: "x", pos: POS }, { op: "lookup", id: SID, pos: POS, code: "a b" }]) {
      const rr = await S.send(m, P);
      ok(!rr.ok || (rr.r && rr.r.status === 0) , JSON.stringify(m));
    }
    eq(S.log.length, n0, "không gọi mạng khi tham số sai / có offset");
    const ro = await S.send({ op: "scans", id: SID, pos: POS, offset: 0 }, P);
    eq(ro.ok, false); eq(ro.refused, true); ok(/không nhận offset/.test(ro.msg), ro.msg);
    const e = await S.send({ op: "nwExport", nwId: NWID }, P);
    eq(e.ok, true); eq(Buffer.from(e.r.b64, "base64").toString("binary"), "PK\u0003\u0004");
    eq(S.log.filter(x => x.m !== "GET").length, 0);
  });
  await ta("H khoá gửi theo phiên Circa: chưa giữ khoá → submit bị từ chối (không gọi mạng); panel B bị từ chối khi A giữ; đóng tab → nhả; session_id phải là phiên đã chọn", async () => {
    const S = swWorld();
    const A = S.panel(31), B2 = S.panel(32); S.tabs.push({ id: 31, url: A.url, windowId: 1 }, { id: 32, url: B2.url, windowId: 1 });
    const body = { session_id: SID, device_id: "NW-RFID", tags: ["AB0001"] };
    const s0 = await S.send({ op: "submit", id: SID, pos: POS, body }, A); eq(s0.ok, false); eq(s0.refused, true); eq(S.log.length, 0);
    eq((await S.send({ op: "beginSend", id: SID }, A)).ok, true);
    const b1 = await S.send({ op: "beginSend", id: SID }, B2); eq(b1.ok, false); ok(/panel khác/.test(b1.msg));
    eq((await S.send({ op: "beginSend", id: SID2 }, B2)).ok, true, "phiên Circa khác: khoá riêng");
    eq((await S.send({ op: "submit", id: SID, pos: POS, body }, B2)).ok, false); eq(S.log.length, 0);
    eq((await S.send({ op: "submit", id: SID, pos: POS, body: Object.assign({}, body, { session_id: SID2 }) }, A)).ok, false, "body.session_id khác phiên");
    const s2 = await S.send({ op: "submit", id: SID, pos: POS, body }, A); eq(s2.ok, true); eq(S.log.length, 1);
    eq(S.log[0].m, "POST"); eq(S.log[0].p, "/v1/inventory/count/submit-rfid-batch"); eq(S.log[0].store, POS); deq(S.log[0].body, body);
    eq((await S.send({ op: "beginSend", id: SID }, A)).ok, true, "cùng tab lấy lại được");
    await S.send({ op: "endSend", id: SID }, B2); eq((await S.send({ op: "beginSend", id: SID }, B2)).ok, false, "tab khác không nhả được khoá");
    await S.send({ op: "endSend", id: SID }, A);
    eq((await S.send({ op: "beginSend", id: SID }, B2)).ok, true);
    S.L.rm.forEach(f => f(32)); await new Promise(r => setTimeout(r, 20));
    eq((await S.send({ op: "beginSend", id: SID }, A)).ok, true, "tab B đóng → khoá nhả");
    S.tabs.splice(S.tabs.findIndex(x => x.id === 31), 1);
    eq((await S.send({ op: "beginSend", id: SID }, S.panel(33))).ok, true, "tab giữ khoá đã chết → tab khác chiếm được");
    eq(S.local.size, 0, "không ghi chrome.storage.local");
  });
  await ta("H background không dùng webRequest / storage.local, chỉ 1 listener tin nhắn", async () => {
    const S = swWorld();
    eq(S.L.msg.length, 1);
    const src = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
    ok(!/webRequest/.test(src)); ok(!/storage\.local/.test(src));
  });
}

// ================= G. build =================
async function partG() {
  const B = require("./build-ext.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kk-ext-"));
  try {
    await ta("G build bản thật + bản thử; core.js trùng byte; host đúng; manifest v0.2.1 (quyền, content script NW duy nhất)", async () => {
      const r = B.build({ outDir: path.join(tmp, "real") });
      deq(r.hosts, ["https://admin.v2.circa.vn/*", "https://api.v2.circa.vn/*", "https://circa.nextwaves.app/*", "https://api-circa.nextwaves.app/*"]);
      eq(r.version, "0.2.1");
      const rc = fs.readFileSync(path.join(tmp, "real", "config.js"), "utf8");
      ok(/VERSION: "0\.2\.1",/.test(rc) && /SCAN_LIMIT: 60000,/.test(rc) && /SCAN_TIMEOUT_MS: 120000,/.test(rc) && /SCAN_MAX_BYTES: 62914560,/.test(rc) && /TIMEOUT_MS: 30000,/.test(rc), "bản thật: cấu hình đọc lượt quét");
      ok(!/SCAN_PAGE/.test(rc), "bản thật: không còn SCAN_PAGE / SCAN_PAGES");
      const realCode = ["api.js", "panel.js", "chon.js"].map(f => fs.readFileSync(path.join(tmp, "real", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1")).join("\n");
      ok(!/\boffset\b/i.test(realCode), "bản thật: mã api.js / panel.js / chon.js không có offset");
      ok(!/chạm trần|maxPages|SCAN_PAGES|scanPages/.test(realCode), "bản thật: không còn mã lật trang / thông báo chạm trần");
      const T = { admin: "http://127.0.0.1:47910", circaApi: "http://127.0.0.1:47911", nwApp: "http://127.0.0.1:47912", nwApi: "http://127.0.0.1:47913" };
      const r2 = B.build({ outDir: path.join(tmp, "test"), test: T });
      deq(r2.hosts, Object.values(T).map(x => x + "/*"));
      const coreSha = crypto.createHash("sha256").update(fs.readFileSync(path.join(D, "core.js"))).digest("hex");
      eq(r.files["core.js"].sha256, coreSha); eq(r2.files["core.js"].sha256, coreSha);
      const realTxt = B.OWN.map(f => fs.readFileSync(path.join(tmp, "real", f), "utf8")).join("\n");
      ok(!/127\.0\.0\.1|localhost/.test(realTxt)); ok(!B.LOOPBACK.test(realTxt), "bản thật còn 127.0.0.1 dạng thoát");
      ok(!B.TEST_MARKS.test(realTxt), "bản thật còn mã thử: " + (B.TEST_MARKS.exec(realTxt) || [])[0]);
      for (const s of ["TEST_ORIGIN", "__KK_TEST__", "__KK_PANEL__", "TEST-BEGIN", "dropSubmit", "testThrow", "throwAfterSubmit", "throwInStep"]) ok(realTxt.indexOf(s) < 0, "bản thật còn " + s);
      for (const s of ["testThrow", "throwAfterSubmit", "throwInStep"]) ok(B.TEST_MARKS.test(s), "TEST_MARKS phải có " + s);
      ok(/SCAN_READ_GAP_MS: 1500,/.test(fs.readFileSync(path.join(tmp, "real", "config.js"), "utf8")), "bản thật giữ khoảng chờ đọc lại 1500 ms");
      const realCs = fs.readFileSync(path.join(tmp, "real", "content-nw.js"), "utf8");
      ok(!/["']open["']/.test(realCs) && /var mode = "closed";/.test(realCs), "bản thật: shadow root đóng");
      const testTxt = B.OWN.map(f => fs.readFileSync(path.join(tmp, "test", f), "utf8")).join("\n");
      for (const h of Object.values(B.REAL)) ok(testTxt.indexOf(h) < 0, "bản thử còn " + h);
      for (const s of ["__KK_TEST__", "__KK_PANEL__", "TEST_ORIGIN", "testThrow", "throwAfterSubmit", "throwInStep"]) ok(testTxt.indexOf(s) >= 0, "bản thử phải còn móc thử " + s);
      const tc = require(path.join(tmp, "test", "config.js"));
      eq(tc.TEST, true); eq(tc.CIRCA_API, T.circaApi); ok(KKAPI.validateCfg(tc));
      const realApiMod = require(path.join(tmp, "real", "api.js"));
      assert.throws(() => realApiMod.validateCfg(tc), /bản thử/); ok(realApiMod.validateCfg(CFG));
      for (const v of ["real", "test"]) for (const f of B.OWN.filter(x => /\.js$/.test(x))) new vm.Script(fs.readFileSync(path.join(tmp, v, f), "utf8"), { filename: v + "/" + f });
      const man = JSON.parse(fs.readFileSync(path.join(tmp, "real", "manifest.json"), "utf8"));
      eq(man.version, "0.2.1");
      deq(man.permissions, ["storage", "scripting"], "không còn quyền tabs");
      eq(man.content_scripts.length, 1); deq(man.content_scripts[0].matches, ["https://circa.nextwaves.app/*"]); deq(man.content_scripts[0].js, ["config.js", "content-nw.js"]);
      eq(man.content_scripts[0].world, undefined); eq(man.content_scripts[0].all_frames, false);
      ok(!JSON.stringify(man).includes("webRequest") && !JSON.stringify(man.content_scripts).includes("admin.v2.circa.vn"));
      eq(man.content_security_policy.extension_pages, "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src https://api.v2.circa.vn https://api-circa.nextwaves.app");
      deq(B.cspProblems(man, [B.REAL.circaApi, B.REAL.nwApi]), []);
      const panel = fs.readFileSync(path.join(tmp, "real", "panel.html"), "utf8");
      ok(/connect-src 'none'/.test(panel), "panel không được tự gọi mạng");
      eq((panel.match(/<script\b/g) || []).length, 5); ok(!/<script>/.test(panel), "không có script nội tuyến"); ok(/src="chon\.js"/.test(panel));
      for (const f of ["watch-circa.js", "content-circa.js", "link.js"]) ok(!fs.existsSync(path.join(tmp, "real", f)), f);
      const tm = JSON.parse(fs.readFileSync(path.join(tmp, "test", "manifest.json"), "utf8"));
      deq(tm.content_scripts[0].matches, [T.nwApp + "/*"]);
      deq(tm.permissions, ["storage", "scripting"]);
      ok(/; connect-src http:\/\/127\.0\.0\.1:47911 http:\/\/127\.0\.0\.1:47913$/.test(tm.content_security_policy.extension_pages), "bản thử: connect-src = 2 API giả");
      deq(B.cspProblems(tm, [T.circaApi, T.nwApi]), []);
      // bảng API của bản thật: đúng 1 POST
      const apiReal = fs.readFileSync(path.join(tmp, "real", "api.js"), "utf8");
      eq((apiReal.match(/method:\s*"POST"/g) || []).length, 1); ok(!/method:\s*"(PUT|PATCH|DELETE)"/.test(apiReal));
    });
    await ta("G CSP extension_pages: thiếu default-src / connect-src thừa host / * / unsafe / chỉ thị lạ → lỗi; build từ chối manifest có quyền tabs hoặc CSP sai", async () => {
      const man0 = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8")), A2 = [B.REAL.circaApi, B.REAL.nwApi];
      deq(B.cspProblems(man0, A2), []);
      const csp0 = man0.content_security_policy.extension_pages;
      const withCsp = v => Object.assign({}, man0, { content_security_policy: { extension_pages: v } });
      for (const v of [csp0.replace("default-src 'self'; ", ""), csp0 + " https://evil.example", csp0.replace("connect-src ", "connect-src * "), csp0.replace(" https://api-circa.nextwaves.app", ""),
        csp0.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"), csp0 + "; img-src https:", csp0.replace("connect-src https://api.v2.circa.vn", "connect-src https://admin.v2.circa.vn https://api.v2.circa.vn"),
        csp0 + "; connect-src 'self'", csp0.replace("default-src 'self'", "default-src *")])
        ok(B.cspProblems(withCsp(v), A2).length, v);
      ok(B.cspProblems(Object.assign({}, man0, { content_security_policy: undefined }), A2).length, "không có CSP");
      // build với manifest nguồn bị thay CHỈ TRONG BỘ NHỚ (bọc fs.readFileSync, không ghi file nguồn): quyền tabs / CSP lỏng → từ chối
      const MF = path.join(EXT, "manifest.json"), srcBak = fs.readFileSync(MF, "utf8"), rf0 = fs.readFileSync;
      const tryMan = (m) => { fs.readFileSync = function (p) { return path.resolve(String(p)) === MF ? JSON.stringify(m, null, 2) : rf0.apply(fs, arguments); }; try { B.build({ outDir: path.join(tmp, "bad") }); return null; } catch (e) { return e.message; } finally { fs.readFileSync = rf0; } };
      ok(/permissions/.test(tryMan(Object.assign({}, man0, { permissions: ["storage", "scripting", "tabs"] })) || ""), "quyền tabs phải bị từ chối");
      ok(/CSP/.test(tryMan(withCsp(csp0 + " https://evil.example")) || ""), "connect-src thừa host phải bị từ chối");
      ok(/CSP/.test(tryMan(withCsp(csp0.replace("default-src 'self'; ", ""))) || ""), "thiếu default-src phải bị từ chối");
      eq(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"), srcBak, "manifest nguồn trả nguyên");
    });
    await ta("G build dọn file v0.1.0 còn sót trong thư mục bản dựng cũ", async () => {
      const d = path.join(tmp, "old");
      fs.mkdirSync(d, { recursive: true });
      for (const f of ["watch-circa.js", "content-circa.js", "link.js"]) fs.writeFileSync(path.join(d, f), "// cũ");
      B.build({ outDir: d });
      for (const f of ["watch-circa.js", "content-circa.js", "link.js"]) ok(!fs.existsSync(path.join(d, f)), f);
    });
    await ta("G bản thử: scanGapMs / scanTimeoutMs / scanMaxBytes đổi đúng hằng (bản thật giữ 1.500 ms, 3 lần, 120 s, 60 MiB)", async () => {
      B.build({ outDir: path.join(tmp, "gap"), test: { admin: "http://127.0.0.1:47920", circaApi: "http://127.0.0.1:47921", nwApp: "http://127.0.0.1:47922", nwApi: "http://127.0.0.1:47923", scanGapMs: 7, scanTimeoutMs: 9000, scanMaxBytes: 123456 } });
      const c = fs.readFileSync(path.join(tmp, "gap", "config.js"), "utf8");
      ok(/SCAN_READ_GAP_MS: 7,/.test(c), "bản thử: khoảng chờ 7 ms"); ok(/SCAN_READ_TRIES: 3,/.test(c));
      ok(/SCAN_TIMEOUT_MS: 9000,/.test(c) && /SCAN_MAX_BYTES: 123456,/.test(c) && /\bTIMEOUT_MS: 30000,/.test(c) && /SCAN_LIMIT: 60000,/.test(c), "bản thử: thời hạn / trần lượt quét đổi, thời hạn chung giữ");
      eq(CFG.SCAN_READ_GAP_MS, 1500); eq(CFG.SCAN_READ_TRIES, 3); eq(CFG.SCAN_TIMEOUT_MS, 120000);
    });
    await ta("G build từ chối host bản thử không phải 127.0.0.1", async () => {
      assert.throws(() => B.build({ outDir: path.join(tmp, "x"), test: { admin: "http://localhost:1", circaApi: "http://127.0.0.1:2", nwApp: "http://127.0.0.1:3", nwApi: "http://127.0.0.1:4" } }));
    });
    await ta("G soát nguồn bắt được innerHTML / alert / eval / fetch ngoài api.js / console / /auth/refresh / XMLHttpRequest / lưu ngoài chrome.storage", async () => {
      const base = { "background.js": "x = { fetch: function (u, o) { return fetch(u, o); } };" };
      deq(B.lintSources(base), []);
      for (const [f, s] of [["panel.js", "el.innerHTML = x;"], ["panel.js", "alert('x')"], ["panel.js", "if (confirm('x')) {}"], ["chon.js", "eval('1')"], ["panel.js", "fetch('https://x')"],
        ["panel.js", "console.log(token)"], ["api.js", "var u = '/api/v1/auth/refresh';"], ["api.js", "self.fetch(u)"], ["chon.js", "globalThis . fetch (u)"], ["panel.js", "self['fetch'](u)"],
        ["content-nw.js", "new XMLHttpRequest()"], ["panel.js", "new WebSocket(u)"], ["chon.js", "new EventSource(u)"], ["bridge.js", "console .log(t)"], ["content-nw.js", "localStorage.setItem('a', 1)"],
        ["content-nw.js", "fetch('https://x')"], ["background.js", "x = { fetch: function (u, o) { return fetch(u, o); } }; navigator.sendBeacon(u, b)"]]) {
        ok(B.lintSources(Object.assign({}, base, { [f]: s })).length, f + ": " + s);
      }
      ok(B.lintSources({ "background.js": "fetch(a); fetch(b);" }).length);
      // v0.2.1: mã api.js / panel.js / chon.js không được có offset (lật trang); chú thích thì được
      for (const [f, s] of [["panel.js", "bg('scans', { offset: 0 })"], ["api.js", "q: { limit: /^1000$/, offset: /^\\d+$/ }"], ["chon.js", "io.page(st.offset)"], ["panel.js", "x.OFFSET = 1"]])
        ok(B.lintSources(Object.assign({}, base, { [f]: s })).some(x => /offset/.test(x)), f + ": " + s);
      deq(B.lintSources(Object.assign({}, base, { "panel.js": "// không gửi offset\n/* offset trên Circa thật trùng / sót */ var a = 1;" })), [], "chú thích nhắc offset không tính");
      ok(B.lintSources({ "background.js": "x = { fetch: function (u, o) { return fetch(u, o); } }; /*TEST-BEGIN*/ y" }).length, "dấu không cân bị soát");
      deq(B.lintSources(Object.assign({}, base, { "panel.js": "// alert( trong chú thích\nconfirmBox('x');" })), []);
    });
    await ta("G khối TEST-BEGIN/END: cân, không lồng; cutTest cắt sạch; LOOPBACK bắt 127.0.0.1 dạng thường / thoát", async () => {
      ok(B.testBlocksOk("a /*TEST-BEGIN*/ b /*TEST-END*/ c /*TEST-BEGIN*/ d /*TEST-END*/"));
      for (const s of ["/*TEST-BEGIN*/ x", "/*TEST-END*/ x /*TEST-BEGIN*/", "/*TEST-BEGIN*/ /*TEST-BEGIN*/ /*TEST-END*/ /*TEST-END*/"]) ok(!B.testBlocksOk(s), s);
      eq(B.cutTest("a;\n  /*TEST-BEGIN*/\n  var T = 1;\n  /*TEST-END*/\nb;\n"), "a;\nb;\n");
      for (const s of ["127.0.0.1", "/^http:\\/\\/127\\.0\\.0\\.1:\\d+$/", "127\\x2e0\\x2e0\\x2e1", "127\\u002e0\\u002e0", "127[.]0[.]0", "http://LOCALHOST:1", "[::1]"]) ok(B.LOOPBACK.test(s), s);
      ok(!B.LOOPBACK.test("version 1.27.0 · 0.0.1"), "không bắt nhầm");
    });
    await ta("G nguồn ext/ hiện tại sạch; không còn file / tham chiếu v0.1.0", async () => {
      const files = {}; for (const f of B.OWN) files[f] = fs.readFileSync(path.join(EXT, f), "utf8");
      deq(B.lintSources(files), []);
      for (const f of ["watch-circa.js", "content-circa.js", "link.js"]) ok(!fs.existsSync(path.join(EXT, f)), f);
      // bỏ chú thích (chú thích được nhắc nguồn gốc "link.js v0.1.0")
      const code = Object.values(files).join("\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
      const hit = /content-circa|watch-circa|link\.js|webRequest|createGate|judgeFound|recCreate/.exec(code);
      ok(!hit, "còn tham chiếu luồng v0.1.0: " + (hit && hit[0]));
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ================= R. đọc lượt quét phiên Circa (KKCHON.readScans, hàm thuần với io giả) =================
// v0.2.1: MỘT request lượt quét (io.scans(), không tham số), không lật trang.
// Máy chủ giả trong bộ nhớ: list = lượt hiện có (MỚI NHẤT TRƯỚC như Circa thật); summary = list.length (+ off); scans() = cả list, has_more=false.
// hooks: afterSum(k, st) (sửa list sau khi trả summary thứ k), afterScans(k, st) (sửa list sau khi trả lượt quét lần thứ k),
//        scansOf(list, k) → {scans, has_more} | r thay cách trả, sumOf(list, k) → r. st.calls = chuỗi "S" / "L" theo thứ tự gọi.
function rScans(n, o) {
  o = o || {};
  const out = []; let t = Date.UTC(2026, 10, 22, 8, 0, 0);
  for (let i = 0; i < n; i++) {
    if (i % 100 === 0) t += 3000;
    out.push({ id: (o.idp || "id-") + i, qr_code: "AB" + String(i).padStart(22, "0"), product_id: 910000 + (i % 50), scanned_qty: 1, unit_code: "cái", conversion_factor: 1, base_qty: 1, device_id: "NW-RFID", scanned_at: new Date(t).toISOString() });
  }
  return out.reverse(); // mới nhất trước
}
function rServer(list, hooks) {
  hooks = hooks || {};
  const st = { list: list.slice(), calls: [], scanArgs: [], sums: 0, scansN: 0, sleeps: [] };
  const ok200 = data => ({ status: 200, j: { success: true, data } });
  st.io = {
    summary: async () => {
      st.sums++; st.calls.push("S");
      const r = hooks.sumOf ? hooks.sumOf(st.list, st.sums) : ok200({ session_id: SID, total_scans: st.list.length + (hooks.off || 0) });
      if (hooks.afterSum) hooks.afterSum(st.sums, st);
      return r;
    },
    scans: async function () {
      st.scansN++; st.calls.push("L"); st.scanArgs.push(arguments.length);
      const r = hooks.scansOf ? hooks.scansOf(st.list, st.scansN) : { scans: st.list.slice(), has_more: false };
      if (hooks.afterScans) hooks.afterScans(st.scansN, st);
      return r && r.status !== undefined ? r : ok200(r);
    },
    sleep: async ms => { st.sleeps.push(ms); }
  };
  return st;
}
const RO = { tries: 3, gapMs: 1500 };
const idsOf = a => a.map(s => s.id);
const newQR = (k, pre) => ({ id: (pre || "new-") + k, qr_code: "1799Q" + (pre || "") + k, product_id: 999, base_qty: 1, scanned_at: "2026-11-22T09:00:00Z" });
async function partR() {
  await ta("R đọc thường: 2.600 lượt bằng MỘT request (không tham số); summary trước + sau; T1 = T2 = số id; không ngủ", async () => {
    const base = rScans(2600), S = rServer(base);
    const r = await CH.readScans(S.io, RO);
    eq(r.ok, true, r.msg); eq(r.scans.length, 2600); eq(r.total, 2600); eq(r.rows, 2600); deq(S.calls, ["S", "L", "S"]); deq(S.scanArgs, [0], "io.scans gọi không tham số (không offset)"); deq(S.sleeps, []);
    deq(idsOf(r.scans), idsOf(base)); eq(r.attempts.length, 1); eq(r.attempts[0].t1, 2600); eq(r.attempts[0].t2, 2600); eq(r.attempts[0].dup, 0); eq(r.attempts[0].rows, 2600); eq(r.attempts[0].ids, 2600);
    eq(r.pages, undefined, "không còn số trang");
  });
  await ta("R phiên rỗng: T = 0, scans [] has_more=false → ĐẠT, 0 lượt", async () => {
    const S = rServer([]);
    const r = await CH.readScans(S.io, RO);
    eq(r.ok, true); eq(r.scans.length, 0); deq(S.calls, ["S", "L", "S"]);
  });
  await ta("R 60.000 lượt (đúng giới hạn một request), has_more=false → ĐẠT đủ 60.000 id", async () => {
    const base = rScans(60000), S = rServer(base);
    const r = await CH.readScans(S.io, RO);
    eq(r.ok, true, r.msg); eq(r.scans.length, 60000); eq(new Set(idsOf(r.scans)).size, 60000); deq(S.calls, ["S", "L", "S"]);
  });
  await ta("R D1 lượt mới chen giữa summary trước và lượt quét (1 lần): lần 1 lệch tổng (T1 2.600, nhận 2.603), đọc lại sau 1.500 ms → ĐẠT 2.603 id", async () => {
    const S = rServer(rScans(2600), { afterSum: (k, st) => { if (k === 1) st.list = [0, 1, 2].map(i => newQR(i)).concat(st.list); } });
    const r = await CH.readScans(S.io, RO);
    eq(r.ok, true, r.msg); eq(r.scans.length, 2603); eq(new Set(idsOf(r.scans)).size, 2603); eq(r.attempts.length, 2); deq(S.sleeps, [1500]);
    const a = r.attempts[0]; eq(a.why, "lệch tổng"); eq(a.t1, 2600); eq(a.t2, 2603); eq(a.ids, 2603); eq(a.dup, 0);
    deq(S.calls, ["S", "L", "S", "S", "L", "S"], "đọc lại từ đầu: summary → lượt quét → summary");
  });
  await ta("R D1b lượt mới chen giữa lượt quét và summary sau (1 lần): lần 1 lệch tổng (T1 2.600 = id 2.600, T2 2.603) → đọc lại ĐẠT 2.603", async () => {
    const S = rServer(rScans(2600), { afterScans: (k, st) => { if (k === 1) st.list = [0, 1, 2].map(i => newQR(i)).concat(st.list); } });
    const r = await CH.readScans(S.io, RO);
    eq(r.ok, true, r.msg); eq(r.scans.length, 2603); eq(r.attempts.length, 2);
    const a = r.attempts[0]; eq(a.why, "lệch tổng"); eq(a.t1, 2600); eq(a.t2, 2603); eq(a.ids, 2600, "số id = T1 mà T2 khác: phải so cả T2");
  });
  await ta("R lượt mới chen vào MỌI lần đọc (đang có người quét): 3 lần đều lệch → lỗi “Không đọc được ổn định …” kèm T1, T2, số lượt nhận, số id", async () => {
    let n = 0;
    const S = rServer(rScans(1500), { afterScans: (k, st) => { st.list = [newQR(++n, "live-")].concat(st.list); } });
    const r = await CH.readScans(S.io, RO);
    eq(r.ok, false); eq(r.kind, "unstable"); eq(r.attempts.length, 3); deq(S.sleeps, [1500, 1500]);
    ok(r.msg.indexOf(CH.SCAN_UNSTABLE) === 0, r.msg);
    ok(/Đã đọc 3 lần, lần nào cũng lệch: lần 1: tổng theo summary trước 1\.500 \/ sau 1\.501, nhận 1\.500 lượt, đọc được 1\.500 id khác nhau; lần 2: tổng theo summary trước 1\.501 \/ sau 1\.502/.test(r.msg), r.msg);
    ok(/lần 3: tổng theo summary trước 1\.502 \/ sau 1\.503, nhận 1\.502 lượt/.test(r.msg), r.msg);
  });
  await ta("R D2 xoá 1 lượt giữa summary trước và lượt quét: lần 1 lệch tổng (T1 2.601, id 2.600 = T2) → đọc lại ĐẠT đúng tập", async () => {
    const base = rScans(2601), delId = base[5].id;
    const S = rServer(base, { afterSum: (k, st) => { if (k === 1) st.list = st.list.filter(s => s.id !== delId); } });
    const r = await CH.readScans(S.io, RO);
    eq(r.ok, true, r.msg); eq(r.scans.length, 2600); eq(r.attempts.length, 2);
    eq(r.attempts[0].why, "lệch tổng"); eq(r.attempts[0].t1, 2601); eq(r.attempts[0].t2, 2600); eq(r.attempts[0].ids, 2600, "số id = T2 mà T1 khác: phải so cả T1");
    deq(new Set(idsOf(r.scans)), new Set(idsOf(base).filter(x => x !== delId)));
  });
  await ta("R has_more = true (trần phía máy chủ: trả 1.000 / 2.600 lượt) → DỪNG ngay: kind more, 1 lần đọc, KHÔNG đọc tiếp / đọc lại, không lấy summary sau", async () => {
    const S = rServer(rScans(2600), { scansOf: list => ({ scans: list.slice(0, 1000), has_more: true }) });
    const r = await CH.readScans(S.io, RO);
    eq(r.ok, false); eq(r.kind, "more"); eq(r.attempts.length, 1); deq(S.calls, ["S", "L"]); deq(S.sleeps, []); eq(r.scans, undefined);
    eq(r.msg, "Phiên Circa có nhiều lượt quét hơn một lần đọc trả về (đã nhận 1.000 lượt, summary ghi 2.600 lượt, Circa báo has_more = true): extension không đọc đủ được lượt quét của phiên này nên không dùng — DỪNG, không đọc tiếp. Đọc lại cũng không đủ: báo người phụ trách extension.");
    eq(r.attempts[0].rows, 1000); eq(r.attempts[0].t1, 2600);
    // has_more = true kể cả khi đã nhận đủ số summary → vẫn dừng (không đoán)
    const S2 = rServer(rScans(5), { scansOf: list => ({ scans: list.slice(), has_more: true }) });
    const r2 = await CH.readScans(S2.io, RO);
    eq(r2.kind, "more"); deq(S2.calls, ["S", "L"]);
    // has_more = true mà response có id trùng / thiếu id → vẫn là more (dừng), không đọc lại
    const S3 = rServer(rScans(5), { scansOf: list => ({ scans: list.concat([list[0], { qr_code: "x" }]), has_more: true }) });
    eq((await CH.readScans(S3.io, RO)).kind, "more"); deq(S3.calls, ["S", "L"]);
  });
  await ta("R has_more thiếu / null / chuỗi “false” / 0 / 1 / object → kind no-has-more, 1 lần đọc, không đọc lại (kể cả khi số lượt khớp summary)", async () => {
    for (const hm of [undefined, null, "false", "true", 0, 1, {}]) {
      const S = rServer(rScans(700), { scansOf: list => { const d = { scans: list.slice() }; if (hm !== undefined) d.has_more = hm; return d; } });
      const r = await CH.readScans(S.io, RO);
      eq(r.ok, false); eq(r.kind, "no-has-more", String(hm)); eq(r.attempts.length, 1); deq(S.calls, ["S", "L"]);
      ok(/^Phản hồi lượt quét của phiên Circa không có has_more dạng true \/ false \(/.test(r.msg) && /nhận 700 lượt, summary ghi 700\): không biết đã nhận đủ lượt quét chưa — DỪNG\.$/.test(r.msg), r.msg);
      ok(hm === undefined ? /thiếu trường/.test(r.msg) : /đang là /.test(r.msg), r.msg);
    }
  });
  await ta("R summary lệch số lượt (+1) ở mọi lần → 3 lần lệch tổng → lỗi không ổn định", async () => {
    const S = rServer(rScans(1200), { off: 1 });
    const r = await CH.readScans(S.io, RO);
    eq(r.ok, false); eq(r.kind, "unstable"); eq(r.attempts.length, 3); ok(r.attempts.every(a => a.t1 === 1201 && a.t2 === 1201 && a.ids === 1200 && a.rows === 1200 && a.why === "lệch tổng"));
    ok(/trước 1\.201 \/ sau 1\.201, nhận 1\.200 lượt, đọc được 1\.200 id khác nhau/.test(r.msg), r.msg);
  });
  await ta("R lượt thiếu id / id rỗng / id không phải chuỗi / phần tử null → hỏng ngay, nêu lượt thứ mấy, không đọc lại", async () => {
    for (const bad of [x => { delete x.id; }, x => { x.id = ""; }, x => { x.id = "  "; }, x => { x.id = 123; }, x => { x.id = null; }]) {
      const base = rScans(1500); bad(base[1200]);
      const S = rServer(base);
      const r = await CH.readScans(S.io, RO);
      eq(r.ok, false); eq(r.kind, "no-id"); eq(r.attempts.length, 1); deq(S.calls, ["S", "L"]);
      eq(r.msg, "Phiên Circa trả 1 lượt quét không có id (lượt thứ 1201): không khử trùng được — DỪNG.");
    }
    const base = rScans(10); base[3] = null;
    const r = await CH.readScans(rServer(base).io, RO);
    eq(r.kind, "no-id");
    const many = rScans(20); [1, 4, 6, 8, 10, 12].forEach(i => { delete many[i].id; });
    ok(/6 lượt quét không có id \(lượt thứ 2, 5, 7, 9, 11…\)/.test((await CH.readScans(rServer(many).io, RO)).msg));
  });
  await ta("R id trùng trong response → hỏng (trùng), đọc lại; 3 lần đều trùng → không ổn định, nêu số id trùng", async () => {
    const base = rScans(500); base[10].id = base[9].id;
    const S = rServer(base);
    const r = await CH.readScans(S.io, RO);
    eq(r.ok, false); eq(r.kind, "unstable"); eq(r.attempts.length, 3); ok(r.attempts.every(a => a.dup === 1 && a.why === "trùng id" && a.rows === 500 && a.ids === 499));
    deq(S.calls, ["S", "L", "S", "S", "L", "S", "S", "L", "S"]);
    ok(/nhận 500 lượt, đọc được 499 id khác nhau, 1 id trùng/.test(r.msg), r.msg);
    // trùng 1 lần rồi hết trùng → đọc lại ĐẠT
    const S2 = rServer(rScans(300), { scansOf: (list, k) => ({ scans: k === 1 ? list.concat([list[list.length - 1]]) : list.slice(), has_more: false }) });
    const r2 = await CH.readScans(S2.io, RO);
    eq(r2.ok, true); eq(r2.scans.length, 300); eq(r2.attempts.length, 2); eq(r2.attempts[0].dup, 1);
  });
  await ta("R product_id null / thiếu / rỗng / chữ / 0 / số lẻ / âm → không dùng được (kind product, số lượt + id mẫu); chuỗi chữ số dùng được", async () => {
    const base = rScans(1500);
    const mut = [[1100, null], [1101, undefined], [1102, ""], [1103, "abc"], [1104, 0], [1105, 1.5], [1106, -3], [1107, "CIRCA-1"], [1108, {}]];
    mut.forEach(([i, v]) => { if (v === undefined) delete base[i].product_id; else base[i].product_id = v; });
    base[50].product_id = "8158";
    const r = await CH.readScans(rServer(base).io, RO);
    eq(r.ok, false); eq(r.kind, "product"); eq(r.nBad, mut.length); eq(r.attempts.length, 1);
    deq(r.samples, mut.slice(0, 5).map(([i]) => base[i].id));
    ok(/9\/1\.500 lượt quét không đọc được product_id/.test(r.msg) && r.msg.indexOf(base[1100].id) >= 0, r.msg);
    const b2 = rScans(20); b2[3].product_id = "8158";
    eq((await CH.readScans(rServer(b2).io, RO)).ok, true, "product_id dạng chuỗi chữ số");
  });
  await ta("R summary lỗi HTTP (401) / không có total_scans / total_scans sai dạng / success:false → dừng ngay, không đọc lại, KHÔNG gọi lượt quét", async () => {
    const cases = [
      [() => ({ status: 401, j: { success: false, errors: [{ code: "Unauthenticated" }] } }), "http"],
      [() => ({ status: 0, err: "network", msg: "x" }), "http"],
      [() => ({ status: 200, j: { success: true, data: { session_id: SID } } }), "shape"],
      [() => ({ status: 200, j: { success: true, data: { total_scans: -1 } } }), "shape"],
      [() => ({ status: 200, j: { success: true, data: { total_scans: 1.5 } } }), "shape"],
      [() => ({ status: 200, j: { success: false, data: { total_scans: 3 } } }), "shape"],
      [() => ({ status: 200, j: null, badJson: true }), "shape"]
    ];
    for (const [f, kind] of cases) {
      const S = rServer(rScans(3), { sumOf: f });
      const r = await CH.readScans(S.io, RO);
      eq(r.ok, false); eq(r.kind, kind, JSON.stringify(f())); eq(r.attempts.length, 1); deq(S.calls, ["S"]); eq(S.scansN, 0);
    }
    const S401 = rServer(rScans(3), { sumOf: cases[0][0] });
    const r401 = await CH.readScans(S401.io, RO);
    eq(r401.r.status, 401, "trả r để panel nhắc đăng nhập lại");
    const Sstr = rServer(rScans(3), { sumOf: () => ({ status: 200, j: { success: true, data: { total_scans: "3" } } }) });
    eq((await CH.readScans(Sstr.io, RO)).ok, true, "total_scans dạng chuỗi chữ số");
  });
  await ta("R summary SAU lỗi → dừng (không đọc lại); lượt quét lỗi HTTP 500 / thiếu data.scans / success:false / bg-lost / too-big → dừng ngay", async () => {
    let S = rServer(rScans(5), { sumOf: (l, k) => k === 1 ? { status: 200, j: { success: true, data: { total_scans: 5 } } } : { status: 500, j: null } });
    let r = await CH.readScans(S.io, RO);
    eq(r.kind, "http"); eq(r.attempts.length, 1); ok(/^Không đọc được tổng số lượt quét của phiên Circa \(summary, sau khi đọc lượt quét\): /.test(r.msg), r.msg);
    for (const pr of [{ status: 500, j: { success: false } }, { status: 200, j: { success: true, data: {} } }, { status: 200, j: { success: false, data: { scans: [], has_more: false } } },
      { status: 200, j: { success: true, data: { scans: {}, has_more: false } } }, { status: 0, err: "bg-lost", msg: "Message exceeded maximum allowed size of 64MiB." },
      { status: 0, err: "too-big", msg: "thân response lượt quét 63,0 MB, vượt trần 60,0 MB" }, { status: 0, err: "timeout", msg: "x", timeoutMs: 120000 }]) {
      S = rServer(rScans(1500), { scansOf: () => pr });
      r = await CH.readScans(S.io, RO);
      eq(r.ok, false); eq(r.kind, "http"); eq(r.attempts.length, 1); deq(S.calls, ["S", "L"]); ok(/^Không đọc được lượt quét của phiên Circa: /.test(r.msg), r.msg);
      if (pr.status === 200) ok(/\(thiếu data\.scans\)$/.test(r.msg), r.msg);
      if (pr.msg) ok(r.msg.indexOf(pr.msg) >= 0, "nêu lý do: " + r.msg);
    }
  });
  await ta("R thứ tự lượt trong response bất kỳ (xáo, kể cả trong nhóm cùng scanned_at) → ĐẠT đúng tập id (đọc theo id, không theo vị trí)", async () => {
    const hh = s => parseInt(crypto.createHash("md5").update(s).digest("hex").slice(0, 8), 16);
    for (let seed = 0; seed < 5; seed++) {
      const base = rScans(2600);
      let req = 0;
      const S = rServer(base, { scansOf: list => ({ scans: list.slice().sort((a, b) => hh(a.id + seed + "-" + (++req)) - hh(b.id + seed + "-" + req)), has_more: false }) });
      const r = await CH.readScans(S.io, RO);
      eq(r.ok, true, r.msg); deq(new Set(idsOf(r.scans)), new Set(idsOf(base)));
    }
  });
  await ta("R tuỳ chọn cũ (limit, maxPages) không còn tác dụng: vẫn MỘT request; io không có scans → ném lỗi (panel bọc thành lỗi)", async () => {
    const S = rServer(rScans(3000));
    const r = await CH.readScans(S.io, { limit: 1000, maxPages: 1, tries: 3, gapMs: 0 });
    eq(r.ok, true); eq(r.scans.length, 3000); deq(S.calls, ["S", "L", "S"]);
    const io = { summary: async () => ({ status: 200, j: { success: true, data: { total_scans: 1 } } }), page: async () => ({ status: 200, j: { success: true, data: { scans: [], has_more: false } } }) };
    await assert.rejects(() => CH.readScans(io, RO), TypeError, "io kiểu cũ (page) không được dùng nữa");
  });
  await ta("R io.scans / io.summary ném lỗi → readScans ném (panel bọc thành lỗi, không đứng)", async () => {
    const io = { summary: async () => ({ status: 200, j: { success: true, data: { total_scans: 1 } } }), scans: async () => { throw new Error("hỏng"); }, sleep: async () => {} };
    await assert.rejects(() => CH.readScans(io, RO), /hỏng/);
  });
}

// ================= M2. máy chủ giả Circa (mock-server.js) sát Circa thật: id, mới nhất trước, lô chung scanned_at, offset xáo nhóm cùng scanned_at, summary, cấu hình ca =================
async function partM2() {
  const M = require("./mock-server.js");
  const srv = await M.start({ port: 0 });
  const d = pid => ({ product_id: pid, product_name: "SP " + pid, unit_name: "cái", retail_units: [{ unit: "cái", convert_rate: 1, base_unit: true }] });
  const H = { Authorization: "Bearer gia", "X-Store-Id": POS };
  const get = async p => { const r = await fetch(srv.url + p, { headers: H }); return { status: r.status, j: await r.json() }; };
  const post = async (p, b) => { const r = await fetch(srv.url + p, { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, H), body: JSON.stringify(b) }); return { status: r.status, j: await r.json() }; };
  try {
    const SC = sid => "/v1/inventory/count/sessions/" + sid + "/scans?limit=60000";
    await ta("M2 lượt quét có id + scanned_at; trả mới nhất trước; mọi lượt của 1 lô chung 1 scanned_at; limit lớn (không offset) trả hết, has_more=false, đọc lại y hệt; summary.total_scans = số lượt", async () => {
      srv.reset();
      const s = srv.addSession({ code: "ICS1" });
      for (let i = 0; i < 5; i++) srv.addScan(s.id, { qr_code: "QR" + i, product_id: 7, scanned_qty: 1, unit_code: "cái", conversion_factor: 1, base_qty: 1, device_id: "PDA" });
      const codes = []; for (let i = 0; i < 150; i++) { codes.push("AB" + String(i).padStart(22, "0")); srv.setLookup(codes[i], d(8)); }
      eq((await post("/v1/inventory/count/submit-rfid-batch", { session_id: s.id, device_id: "NW-RFID", tags: codes.slice(0, 100) })).status, 200);
      eq((await post("/v1/inventory/count/submit-rfid-batch", { session_id: s.id, device_id: "NW-RFID", tags: codes.slice(100) })).status, 200);
      const all = (await get(SC(s.id))).j.data;
      eq(all.scans.length, 155); eq(all.has_more, false);
      ok(all.scans.every(x => typeof x.id === "string" && x.id.length === 36), "mọi lượt có id uuid");
      ok(all.scans.every((x, i) => i === 0 || x.scanned_at <= all.scans[i - 1].scanned_at), "giảm dần scanned_at");
      const g = {}; all.scans.forEach(x => { g[x.scanned_at] = (g[x.scanned_at] || 0) + 1; });
      deq(Object.values(g).sort((a, b) => b - a).slice(0, 2), [100, 50], "lô 100 và lô 50 mỗi lô chung 1 scanned_at");
      deq(all.scans.slice(0, 50).map(x => x.qr_code).sort(), codes.slice(100).sort(), "lô gửi sau ở đầu");
      deq(all.scans.slice(150).map(x => x.qr_code), ["QR4", "QR3", "QR2", "QR1", "QR0"], "lượt đếm tay cũ nhất ở cuối, mới trước");
      ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(all.scans[0].scanned_at), "dạng thời điểm như Circa thật (6 chữ số lẻ giây)");
      const sm = await get("/v1/inventory/count/sessions/" + s.id + "/summary");
      eq(sm.status, 200); eq(sm.j.data.total_scans, 155); eq(sm.j.data.session_id, s.id);
      eq((await get(SC(s.id))).j.data.scans.map(x => x.id).join(), all.scans.map(x => x.id).join(), "đọc lại (không offset): cùng id, cùng thứ tự");
      const l100 = (await get("/v1/inventory/count/sessions/" + s.id + "/scans?limit=100")).j.data;
      eq(l100.scans.length, 100); eq(l100.has_more, true, "limit nhỏ hơn số lượt (không offset) → 100 lượt đầu + has_more");
      const s2 = srv.addSession({ code: "ICS2", scans: [{ id: "id-that-1", qr_code: "X1", product_id: 1, base_qty: 1, scanned_at: "2026-11-21T11:36:13.325787Z" }] });
      const x1 = (await get(SC(s2.id))).j.data.scans[0];
      eq(x1.id, "id-that-1"); eq(x1.scanned_at, "2026-11-21T11:36:13.325787Z", "lượt có sẵn giữ id / scanned_at truyền vào");
      const ent = srv.log.filter(e => /\/scans$/.test(e.path)).pop();
      ok(ent.bytes > 0 && ent.scansOut === 1, "log máy chủ giả ghi byte thân response lượt quét");
    });
    await ta("M2 CÓ offset (như Circa thật): thứ tự trong nhóm cùng scanned_at xáo mỗi request → lật trang limit=70 trùng / sót lượt; không offset thì ổn định; addScanBatch = 1 lô chung scanned_at", async () => {
      srv.reset();
      const s = srv.addSession({ code: "ICS5" });
      for (let b = 0; b < 3; b++) eq(srv.addScanBatch(s.id, Array.from({ length: 100 }, (_, i) => ({ qr_code: "LO" + b + "-" + i, product_id: 7, scanned_qty: 1, unit_code: "cái", conversion_factor: 1, base_qty: 1, device_id: "PDA" }))), 100);
      srv.addScan(s.id, { qr_code: "QRLE", product_id: 8, scanned_qty: 1, unit_code: "cái", conversion_factor: 1, base_qty: 1, device_id: "PDA" });
      eq(srv.addScanBatch(s.id, [{ qr_code: "LO0-1" }]), 0, "mã đã có → không thêm");
      const full = (await get(SC(s.id))).j.data.scans;
      eq(full.length, 301);
      const grp = {}; full.forEach(x => { grp[x.scanned_at] = (grp[x.scanned_at] || 0) + 1; });
      deq(Object.values(grp).sort((a, b) => b - a), [100, 100, 100, 1], "3 lô × 100 chung scanned_at + 1 lượt lẻ");
      // cùng trang offset=0, hai request: thứ tự trong nhóm khác nhau (xác suất trùng ≈ 1/100!)
      const a1 = (await get("/v1/inventory/count/sessions/" + s.id + "/scans?limit=1000&offset=0")).j.data.scans.map(x => x.id).join();
      const a2 = (await get("/v1/inventory/count/sessions/" + s.id + "/scans?limit=1000&offset=0")).j.data.scans.map(x => x.id).join();
      ok(a1 !== a2, "offset=0 hai lần: thứ tự trong nhóm khác nhau");
      ok(a1.split(",").sort().join() === full.map(x => x.id).sort().join(), "một trang đủ lớn vẫn đủ tập id");
      // lật trang limit=70: nhóm bị cắt giữa chừng → trùng / sót
      let worst = 0;
      for (let k = 0; k < 3; k++) {
        const ids = [];
        for (let off = 0; ; off += 70) { const dd = (await get("/v1/inventory/count/sessions/" + s.id + "/scans?limit=70&offset=" + off)).j.data; ids.push(...dd.scans.map(x => x.id)); if (!dd.has_more) break; }
        eq(ids.length, 301, "đủ số dòng");
        worst = Math.max(worst, ids.length - new Set(ids).size);
      }
      ok(worst > 0, "lật trang bằng offset lộ id trùng (" + worst + ") — mã lỡ lật trang sẽ bị bắt");
      eq((await get(SC(s.id))).j.data.scans.map(x => x.id).join(), full.map(x => x.id).join(), "không offset: thứ tự ổn định");
    });
    await ta("M2 cấu hình dựng ca: serverCap, insertBetween (sau lượt quét / sau summary), scansDup, scansDupAfterSubmit, noHasMore / hasMoreAs, padScans, summaryOff / summaryNoTotal / summaryFail, dropId", async () => {
      srv.reset();
      const s = srv.addSession({ code: "ICS3" });
      for (let i = 0; i < 25; i++) srv.addScan(s.id, { qr_code: "Q" + i, product_id: 7, scanned_qty: 1, unit_code: "cái", conversion_factor: 1, base_qty: 1, device_id: "PDA" });
      const P = () => get(SC(s.id)).then(r => r.j.data);
      const SUM = async () => (await get("/v1/inventory/count/sessions/" + s.id + "/summary")).j.data.total_scans;
      const base = (await P()).scans.map(x => x.id);
      srv.cfg = { serverCap: 10 };
      let d1 = await P(); eq(d1.scans.length, 10); eq(d1.has_more, true, "trần phía máy chủ: 10 / 25 lượt, has_more=true"); deq(d1.scans.map(x => x.id), base.slice(0, 10));
      srv.cfg = { serverCap: 25 };
      d1 = await P(); eq(d1.scans.length, 25); eq(d1.has_more, false, "trần ≥ số lượt → has_more=false");
      srv.cfg = { scansDup: true };
      d1 = await P(); eq(d1.scans.length, 26); eq(d1.scans[25].id, d1.scans[24].id, "lượt cuối lặp lại (cùng id)"); eq(d1.has_more, false);
      srv.cfg = { noHasMore: true };
      d1 = await P(); ok(!Object.prototype.hasOwnProperty.call(d1, "has_more"), "bỏ has_more");
      srv.cfg = { hasMoreAs: "false" };
      d1 = await P(); eq(d1.has_more, "false");
      srv.cfg = { padScans: 5 };
      d1 = await P(); ok(d1.scans.every(x => x.pad === "ảảảảả"));
      const e1 = srv.log.filter(e => /\/scans$/.test(e.path)).pop();
      srv.cfg = {};
      await P();
      const e0 = srv.log.filter(e => /\/scans$/.test(e.path)).pop();
      eq(e1.bytes - e0.bytes, 25 * (Buffer.byteLength(',"pad":"ảảảảả"')), "padScans phóng to đúng số byte");
      srv.cfg = { dropId: ["Q3"] };
      d1 = await P(); eq(d1.scans.find(x => x.qr_code === "Q3").id, undefined); ok(d1.scans.filter(x => x.qr_code !== "Q3").every(x => x.id));
      srv.cfg = { summaryOff: 2 };
      eq(await SUM(), 27);
      srv.cfg = { summaryNoTotal: true };
      eq(await SUM(), undefined);
      srv.cfg = { insertBetween: { n: 2 } };
      eq(await SUM(), 25, "at mặc định (scans): summary không chen");
      await P();
      eq(await SUM(), 27, "chen 2 lượt sau request lượt quét");
      d1 = await P(); eq(d1.scans[0].product_id, 990001, "lượt chen vào là mới nhất"); eq(d1.scans.length, 27);
      eq(await SUM(), 27, "không every → chỉ chen 1 lần");
      srv.cfg = { insertBetween: { n: 3, at: "summary" } };
      eq(await SUM(), 27, "summary trả số TRƯỚC khi chen");
      eq((await P()).scans.length, 30, "lượt quét sau đó đã có 3 lượt chen (giữa summary và lượt quét)");
      eq(await SUM(), 30, "không every → chỉ chen 1 lần");
      srv.cfg = { insertBetween: { n: 1, at: "summary", every: true } };
      eq(await SUM(), 30); eq(await SUM(), 31, "every → mỗi summary đều chen");
      srv.cfg = { scansDupAfterSubmit: 1 };
      d1 = await P(); eq(new Set(d1.scans.map(x => x.id)).size, d1.scans.length, "chưa gửi lô nào → chưa lặp");
      srv.setLookup("ABX1", d(8));
      await post("/v1/inventory/count/submit-rfid-batch", { session_id: s.id, device_id: "NW-RFID", tags: ["ABX1"] });
      d1 = await P(); eq(new Set(d1.scans.map(x => x.id)).size, d1.scans.length - 1, "đã gửi 1 lô → bắt đầu lặp 1 lượt");
      srv.cfg = { summaryFail: 503 };
      eq((await get("/v1/inventory/count/sessions/" + s.id + "/summary")).status, 503);
      srv.cfg = {};
      eq((await get("/v1/inventory/count/sessions/aaaaaaaa-0000-4000-8000-000000000000/summary")).status, 404);
      const r401 = await fetch(srv.url + "/v1/inventory/count/sessions/" + s.id + "/summary", { headers: { "X-Store-Id": POS } });
      eq(r401.status, 401, "summary cần Authorization");
      const r400 = await fetch(srv.url + "/v1/inventory/count/sessions/" + s.id + "/summary", { headers: { Authorization: "Bearer gia" } });
      eq(r400.status, 400, "summary cần X-Store-Id");
    });
    await ta("M2 hàm đọc readScans chạy trên máy chủ giả thật (HTTP), io như panel (một request limit=60000): lượt QR của P ở vị trí 1.200 (> 1.000) → đọc đủ 2.001, P có trong lượt đọc; serverCap 1.000 → more, không đọc thêm", async () => {
      srv.reset();
      const s = srv.addSession({ code: "ICS4" });
      const mk = (p, i) => ({ qr_code: p + i, product_id: 800000 + (i % 7), scanned_qty: 1, unit_code: "cái", conversion_factor: 1, base_qty: 1, device_id: "PDA" });
      for (let b = 0; b < 8; b++) srv.addScanBatch(s.id, Array.from({ length: 100 }, (_, i) => mk("OLD", b * 100 + i)));
      srv.addScan(s.id, { qr_code: "1799999999999Q7", product_id: 900100, scanned_qty: 1, unit_code: "cái", conversion_factor: 1, base_qty: 1, device_id: "PDA-QR" });
      for (let b = 0; b < 12; b++) srv.addScanBatch(s.id, Array.from({ length: 100 }, (_, i) => mk("NEW", b * 100 + i)));
      const urls = [];
      const io = { summary: () => get("/v1/inventory/count/sessions/" + s.id + "/summary"), scans: function () { urls.push(arguments.length); return get(SC(s.id)); }, sleep: async () => {} };
      const k0 = srv.log.length;
      const r = await CH.readScans(io, RO);
      eq(r.ok, true, r.msg); eq(r.scans.length, 2001); deq(urls, [0]);
      eq(r.scans.findIndex(x => x.qr_code === "1799999999999Q7"), 1200, "lượt QR của P ở vị trí 1.200");
      const sq = srv.log.slice(k0).filter(e => /\/scans$/.test(e.path));
      eq(sq.length, 1); deq(sq[0].query, { limit: "60000" }, "máy chủ chỉ nhận 1 request, không offset");
      srv.cfg = { serverCap: 1000 };
      const k1 = srv.log.length;
      const r2 = await CH.readScans(io, RO);
      eq(r2.ok, false); eq(r2.kind, "more"); ok(/đã nhận 1\.000 lượt, summary ghi 2\.001 lượt/.test(r2.msg), r2.msg);
      deq(srv.log.slice(k1).map(e => /summary$/.test(e.path) ? "S" : "L"), ["S", "L"], "dừng sau 1 request, không đọc tiếp / đọc lại");
    });
  } finally { await srv.close(); }
}

// ================= M. máy chủ giả: lượt quét "đếm tay" đi qua cùng chống trùng như Circa thật (sim.js) =================
async function partM() {
  await ta("M sim.add / mock addScan: mã đã có → bỏ qua (false); gửi lại mã đó → duplicates, không thêm lượt thứ hai (không gọi mạng)", async () => {
    const sim = require("./sim.js"), M = require("./mock-server.js");
    const d = { product_id: 7, product_name: "SP 7", unit_name: "cái", retail_units: [{ unit: "cái", convert_rate: 1, base_unit: true }] };
    const scan = { qr_code: "AB0000TAY1", product_id: 7, scanned_qty: 1, unit_code: "cái", conversion_factor: 1, base_qty: 1, device_id: "PDA" };
    const S = sim.session([]);
    eq(S.add(scan), true); eq(S.add(Object.assign({}, scan, { qr_code: "ab0000tay1" })), false, "khác hoa thường vẫn trùng");
    const r = S.submit({ session_id: SID, device_id: "NW-RFID", tags: ["AB0000TAY1"] }, { AB0000TAY1: d });
    eq(r.inserted, 0); eq(r.duplicates, 1); eq(S.scans().length, 1); eq(S.scans()[0].device_id, "PDA", "giữ lượt đếm tay ban đầu");
    const srv = await M.start({ port: 0 });
    try {
      const s1 = srv.addSession({ code: "ICS1" });
      eq(srv.addScan(s1.id, scan), true); eq(srv.addScan(s1.id, scan), false);
      const r2 = srv.sessions.get(s1.id).sim.submit({ session_id: s1.id, device_id: "NW-RFID", tags: ["AB0000TAY1"] }, { AB0000TAY1: d });
      eq(r2.duplicates, 1); eq(srv.sessions.get(s1.id).sim.scans().length, 1);
    } finally { await srv.close(); }
  });
}

(async () => {
  await partB();
  await partE();
  await partH();
  await partR();
  await partM();
  await partM2();
  await partG();
  console.log("\n" + pass + " đạt, " + fail + " lỗi");
  if (fail) { console.log("Lỗi: " + failures.join(" | ")); process.exitCode = 1; }
})();
