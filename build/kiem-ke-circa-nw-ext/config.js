/* Extension "Kiểm kê Circa ↔ NW": CẤU HÌNH (config.js). Không chứa khoá / token.
 * Nạp ở: service worker (importScripts), content script trang NW (content-nw.js), panel.html. Node: module.exports (test-ext.js).
 * build-ext.js giữ nguyên file này cho BẢN THẬT; BẢN THỬ thay 4 origin thật bằng origin máy cục bộ (có cổng) và đặt TEST = true.
 * api.js kiểm lại 4 origin lúc nạp: bản thật chỉ nhận đúng 4 host thật, bản thử chỉ nhận origin máy cục bộ.
 */
(function (root) {
  "use strict";
  var C = {
    VERSION: "0.2.0",
    TEST: false,
    // 4 origin (không có dấu / cuối). NW_API là origin; đường dẫn /api/v1/… nằm trong bảng API của api.js.
    // CIRCA_ADMIN chỉ dùng để đọc cookie session_token (bridge.js); extension không chạy script nào khác trên trang admin.
    CIRCA_ADMIN: "https://admin.v2.circa.vn",
    CIRCA_API: "https://api.v2.circa.vn",
    NW_APP: "https://circa.nextwaves.app",
    NW_API: "https://api-circa.nextwaves.app",
    // trang danh sách đối chiếu trên web NW: /<locale>/stock/reconciliation (đúng đường dẫn này, không phải trang con)
    NW_REC_LIST_PATH: "^/[A-Za-z]{2}(?:-[A-Za-z]{2,4})?/stock/reconciliation/?$",
    // danh sách phiên Circa: limit 20 / trang, đọc tối đa 10 trang
    CIRCA_LIST_LIMIT: 20,
    CIRCA_LIST_PAGES: 10,
    // danh sách phiên NW: limit 25 / trang, đọc tối đa 8 trang
    REC_PAGE_LIMIT: 25,
    REC_LIST_PAGES: 8,
    // timeout một lệnh gọi (ms)
    TIMEOUT_MS: 30000,
    // device_id ghi vào lượt quét Circa (giống trang nw-sang-circa.html)
    DEVICE_ID: "NW-RFID",
    // lượt quét đã lưu của phiên Circa (KKCHON.readScans): summary (total_scans) → lật trang limit=1000&offset=<số lượt đã nhận>
    // tới khi has_more=false → summary lần nữa; chỉ dùng khi tổng trước = tổng sau = số id khác nhau đã đọc.
    // Tối đa 60 trang, chạm trần → báo lỗi, không coi là đã đọc hết.
    SCAN_PAGE: 1000,
    SCAN_PAGES: 60,
    // lần đọc hỏng vì trùng id / lệch tổng → đọc lại từ đầu: tổng cộng tối đa SCAN_READ_TRIES lần, cách nhau SCAN_READ_GAP_MS (bản thử rút ngắn)
    SCAN_READ_TRIES: 3,
    SCAN_READ_GAP_MS: 1500,
    // panel gửi lại NGUYÊN lô khi 5xx / timeout: tối đa số lần, chờ 1 s, 2 s, 4 s (nhân hệ số dưới, bản thử rút ngắn)
    SUBMIT_RETRIES: 3,
    RETRY_BASE_MS: 1000
  };
  var F = Object.freeze(C);
  if (typeof module === "object" && module && module.exports) module.exports = F;
  if (root) root.KKCFG = F;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this));
