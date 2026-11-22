/* Extension "Kiểm kê Circa ↔ NW": CẤU HÌNH (config.js). Không chứa khoá / token.
 * Nạp ở: service worker (importScripts), content script ISOLATED của trang admin, panel.html. Node: module.exports (test-ext.js).
 * build-ext.js giữ nguyên file này cho BẢN THẬT; BẢN THỬ thay 4 origin thật bằng origin máy cục bộ (có cổng) và đặt TEST = true.
 * api.js kiểm lại 4 origin lúc nạp: bản thật chỉ nhận đúng 4 host thật, bản thử chỉ nhận origin máy cục bộ.
 */
(function (root) {
  "use strict";
  var C = {
    VERSION: "0.1.0",
    TEST: false,
    // 4 origin (không có dấu / cuối). NW_API là origin; đường dẫn /api/v1/… nằm trong bảng API của api.js.
    CIRCA_ADMIN: "https://admin.v2.circa.vn",
    CIRCA_API: "https://api.v2.circa.vn",
    NW_APP: "https://circa.nextwaves.app",
    NW_API: "https://api-circa.nextwaves.app",
    // trang chi tiết phiên kiểm kê trên admin: /kiem-ke-ton-kho/<uuid>
    ADMIN_SESSION_PATH: "/kiem-ke-ton-kho/",
    // (không có link sâu tới phiên NW: đường dẫn trang chi tiết chưa kiểm; thanh trạng thái chỉ link NW_APP + "/" kèm id + ghi chú)
    // chỉ TỰ tạo phiên NW cho phiên Circa có counting_mode này (giả định user "Đồng ý" 22/11)
    AUTO_COUNTING_MODE: "QR",
    // chỉ tự tạo khi phiên Circa tạo trong khoảng này trước lúc extension thấy lệnh tạo
    AUTO_WINDOW_MS: 10 * 60 * 1000,
    // tin "created" của trang chỉ được nhận khi CHÍNH extension thấy (webRequest) POST tạo phiên 200 từ tab đó trong khoảng này;
    // mỗi sự kiện dùng cho 1 sessionId. Chờ sự kiện tối đa CREATE_GATE_WAIT_MS (tin trang có thể tới trước webRequest).
    CREATE_GATE_MS: 30000,
    CREATE_GATE_WAIT_MS: 3000,
    // giới hạn tần suất tin từ 1 tab: "created" và tra phiên mới (status chưa có bản ghi), mỗi loại tối đa N lần / RATE_WINDOW_MS
    RATE_CREATED: 10,
    RATE_PROBE: 20,
    RATE_WINDOW_MS: 60000,
    // lệch đồng hồ cho phép (created_at muộn hơn lúc thấy)
    CLOCK_SKEW_MS: 2 * 60 * 1000,
    // tìm phiên NW theo notes: tối đa số trang × số dòng/trang
    REC_SEARCH_PAGES: 8,
    REC_PAGE_LIMIT: 25,
    // timeout một lệnh gọi (ms)
    TIMEOUT_MS: 30000,
    // phiên "đang tạo" quá lâu (service worker bị dừng giữa chừng) → coi là gián đoạn
    LINKING_STALE_MS: 2 * 60 * 1000,
    // thử lại tự động bản ghi chờ tab NW: tối đa 1 lần / khoảng này / phiên
    AUTO_RETRY_MS: 30000,
    // device_id ghi vào lượt quét Circa (giống trang nw-sang-circa.html)
    DEVICE_ID: "NW-RFID",
    // lượt quét tối đa đọc 1 lần (giống trang nw-sang-circa.html)
    SCAN_LIMIT: 5000,
    // panel gửi lại NGUYÊN lô khi 5xx / timeout: tối đa số lần, chờ 1 s, 2 s, 4 s (nhân hệ số dưới, bản thử rút ngắn)
    SUBMIT_RETRIES: 3,
    RETRY_BASE_MS: 1000
  };
  var F = Object.freeze(C);
  if (typeof module === "object" && module && module.exports) module.exports = F;
  if (root) root.KKCFG = F;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this));
