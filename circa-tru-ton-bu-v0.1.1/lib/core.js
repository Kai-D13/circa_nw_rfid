// core.js — logic thuần (không dùng chrome.*) dùng chung cho content script,
// page hook, service worker, popup và test. Mọi hàm ở đây phải chạy được trong Node.
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  // Tên global cố ý dài để không va vào biến của trang POS (page-hook chạy ở MAIN world).
  root.__CIRCA_QR_SCAN_LOG_CORE__ = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // Mã đơn POS quan sát được: DHC01178426 (chữ hoa + chuỗi số).
  const ORDER_CODE_RE = /^#?\s*([A-Z]{2,6}\d{5,})\s*$/;
  // Màn được ghi mã QR: /ban-hang/<UUID>. Route khác không ghi.
  // v0.8.0 (stakeholder 27/10/2026, PM audit 27/10): NGỪNG bắt màn chuyển hàng /chuyen-hang/<UUID> — không ghi lượt, không nhận
  // thông tin phiếu / sản phẩm ở màn đó. RECORD_TYPE.TRANSFER_OUT giữ để đọc / xem / xuất bản ghi cũ.
  const WORK_ROUTE_RE = /^\/(ban-hang)\/([0-9a-f-]{36})(?:\/|$)/i;
  // v0.8.0: màn chuyển hàng — extension không ghi gì ở đây nên tab mồ côi cũng KHÔNG chặn phím / chuột ở màn này (isTransferRoute).
  const TRANSFER_ROUTE_RE = /^\/chuyen-hang(?:\/|$)/i;
  // v0.7 Batch D: sale_order_action = một thao tác trên dòng hàng POS (đổi số lượng / xoá dòng) — KHÔNG phải lượt quét.
  // v0.7.4 (spec PM 07/10/2026, phương án A): SALE_ORDER_STATUS = dấu vết vòng đời đơn trên tab data — MỘT dòng cho mỗi trạng
  // thái đơn bán mà extension quan sát được (kể cả đơn không quét), khoá ổn định theo (orderId, trạng thái).
  const RECORD_TYPE = Object.freeze({ SALE_ORDER: "sale_order", TRANSFER_OUT: "transfer_out", SALE_ORDER_ACTION: "sale_order_action", SALE_ORDER_STATUS: "sale_order_status" });
  const RECORD_TYPE_LABELS = Object.freeze({ sale_order: "Bán hàng", transfer_out: "Chuyển hàng", sale_order_action: "Thao tác POS", sale_order_status: "Trạng thái đơn" });
  const ROUTE_RECORD_TYPE = Object.freeze({ "ban-hang": RECORD_TYPE.SALE_ORDER, "chuyen-hang": RECORD_TYPE.TRANSFER_OUT });

  const KEYS = Object.freeze({
    event: "ev:",
    order: "ord:",
    qr: "qr:", // thông tin sản phẩm POS trả về khi tra một mã QR (POST /v2/product)
    settings: "settings",
    diag: "diag",
    // Hàng chờ ghi chưa được service worker xác nhận. Nằm trong chrome.storage.local (cùng kho với
    // dữ liệu chính) vì localStorage của trang KHÔNG chắc sống sót khi tắt trình duyệt/máy —
    // đã kiểm chứng: sau khi tắt hẳn Chrome, chrome.storage.local còn nguyên, localStorage rỗng.
    // Mỗi mục một key riêng để các tab cùng origin không ghi đè hàng chờ của nhau.
    pendEvent: "pend:ev:",
    pendOrder: "pend:ord:",
    pendQr: "pend:qr:",
    // v0.1.2–v0.1.4 để hàng chờ trong localStorage; chuyển sang kho mới khi khởi động.
    outboxEventPrefix: "circaQrScanLog.outbox.v2.event:",
    outboxOrderPrefix: "circaQrScanLog.outbox.v2.order:",
    outboxQrPrefix: "circaQrScanLog.outbox.v2.qr:",
    // v0.1.1 gom cả hàng chờ vào một key; được chuyển sang dạng mỗi mục một key khi khởi động.
    legacyOutbox: "circaQrScanLog.outbox.v1",
    legacyOrderOutbox: "circaQrScanLog.orderOutbox.v1",
    // 0.2.0: cập nhật lượt RFID (P0/P1/P2) chờ worker xác nhận. Mỗi mục một key eventId:seq.
    pendEventUpdate: "pend:evu:",
    // 0.2.0 (Batch C): trạng thái đồng bộ Google Sheet của cả máy (lần gửi gần nhất, lỗi, lịch thử lại).
    // Hàng chờ Sheet KHÔNG có key riêng: suy ra từ từng lượt (revision > syncedRevision).
    syncState: "sync:state",
    // 0.3: dòng hàng POS vừa đổi (response POST .../item) chờ worker gắn vào đúng lượt. Key: eventId.
    pendItem: "pend:item:",
    sheetEndpoint: "sheetEndpoint",
    // v0.7.10.2: máy chủ API của tenant Nextwaves (https://api-<tenant>.nextwaves.app) — đi cùng token: khoá API chỉ hợp lệ trên máy chủ
    // của tenant đã tạo nó. Trống = tenant mặc định circa-medly (như mọi bản trước).
    nextwavesApiBase: "nextwavesApiBase",
    // 0.4: mã trạm POS của máy này (POS-01 / POS-02). Chưa chọn thì vẫn lưu lượt nhưng KHÔNG gửi Sheet.
    posStationId: "posStationId",
    // 0.4: bộ đếm số thứ tự theo trạm — ghi CÙNG một lần set với lượt được cấp số.
    // 0.5: mỗi loại chứng từ một bộ đếm riêng: station:seq:<trạm>:<recordType>. Khoá 0.4 (không hậu tố)
    // là bộ đếm lượt bán cũ, được chuyển sang khoá mới đúng MỘT lần (xem stationSeqMigrated).
    stationSeqPrefix: "station:seq:",
    // KHÔNG dùng tiền tố station:seq: — cờ này không phải bộ đếm, và mọi chỗ lọc theo tiền tố đó
    // (kể cả test mô phỏng lỗi ghi) không được nhầm nó với một bộ đếm.
    stationSeqMigrated: "station:migrated",
    // 0.4: trạng thái bộ cấp số / backfill (chỉ để quan sát; điểm tiếp tục thật là chính các lượt chưa có số).
    stationState: "station:state",
    // 0.6: job trừ tồn Nextwaves của MỘT đơn POS. Đây là khoá DUY NHẤT mà bộ trừ tồn được ghi —
    // không lượt (ev:) hay đơn (ord:) nào bị đụng tới, nên không dòng Sheet nào phải đồng bộ lại.
    stockout: "stockout:",
    // 0.6: cấu hình pilot {enabled, orderIds} do popup ghi, worker đọc.
    stockoutPilot: "stockoutPilot",
    // v0.7 Gate 0: dấu đã đóng băng trừ tồn {frozenAt, version} — worker ghi một lần. KHÔNG dùng tiền tố
    // stockout: (popup và mọi chỗ lọc theo tiền tố đó coi mọi khoá stockout:* là một job).
    stockoutFrozen: "stockoutFrozen",
    // v0.7 Batch D: thao tác dòng hàng POS (đổi số lượng / xoá dòng) chờ worker ghi. Key: eventId của thao tác.
    pendAction: "pend:act:",
    // v0.7 Batch D: chẩn đoán ngắn của lời gọi /item không phân loại được (tối đa POS_ACTION_DIAG_MAX mục, mới nhất trước).
    // Không lên Sheet, không tạo bản ghi ev:.
    posActionDiag: "posActionDiag",
    // v0.7 Batch C: mốc cài v0.7 {at, version} — worker ghi ĐÚNG MỘT lần, không bao giờ sửa. Chỉ trạng thái đơn có mốc
    // SAU mốc này mới vào completed_items (không backfill đơn cũ).
    v07InstalledAt: "v07InstalledAt",
    // v0.7 Batch C: một dòng hàng của đơn thành công → ci:<orderId>|<itemId>. Hàng chờ tab completed_items = chính các bản
    // ghi này (revision > syncedRevision), TÁCH khỏi hàng chờ tab data (ev:).
    completed: "ci:",
    // v0.7 Batch C: trạng thái đồng bộ riêng của tab completed_items (lỗi / lịch thử lại không đụng sync:state của data).
    completedSyncState: "sync:ci",
    // v0.7 Batch C: chẩn đoán ngắn (đơn thành công trước mốc cài, thiếu mốc trạng thái, cùng mốc khác nội dung). Tối đa 50.
    completedDiag: "completedDiag",
    // v0.7.1: sàn bộ đếm của một trạm đọc từ Sheet {floors: {sale_order, transfer_out, sale_order_action}, at}. KHÔNG dùng
    // tiền tố station:seq: (mọi chỗ lọc theo tiền tố đó coi khoá là bộ đếm).
    stationFloorPrefix: "station:floor:",
    // v0.7.1: dấu "đã đối soát xong" phiên bản đơn {sig, at} — ordsync:<orderId>. KHÔNG dùng tiền tố ord: (popup và mọi
    // chỗ lọc theo tiền tố đó coi khoá là bản ghi đơn).
    orderSync: "ordsync:",
    // v0.7.3: job trừ tồn Phase 1 (POST /integrations/circa/orders/notify) của MỘT đơn — notify:<orderId>. Chỉ worker ghi, dưới
    // khoá của chính nó; không giữ kèm khoá nào khác (đọc ord:/ev: không khoá). Không đụng ev: → không đổi revision / Sheet.
    notify: "notify:",
    // v0.7.3: cấu hình pilot {orderIds, senderStationId, updatedAt} — popup của máy gửi ghi, worker đọc. KHÔNG có dấu ":" nên
    // không lọt vào lọc tiền tố notify:.
    notifyPilot: "notifyPilot",
    // v0.7.7: công tắc tự động trừ tồn {enabled, enabledAt, updatedAt} — popup của CHÍNH máy đó ghi (mỗi máy cấu hình riêng), worker
    // đọc. Mặc định tắt.
    notifyAuto: "notifyAuto",
    // v0.7.7: sổ trừ tồn của MỘT đơn (tab stock_out) — so:<orderId>. Chỉ worker ghi, dưới khoá của chính nó (đọc notify:/ci:/ord:
    // không khoá). Hàng chờ tab stock_out = các dòng có revision > acked của chính bản ghi.
    ledger: "so:",
    // v0.7.7: trạng thái đồng bộ riêng của tab stock_out (lỗi / lịch thử lại không đụng tab data / completed_items).
    ledgerSyncState: "sync:so",
    // v0.7.7: mốc cài v0.7.7 {at, version} — worker ghi ĐÚNG MỘT lần. Chỉ đơn COMPLETED SAU mốc này vào sổ (không backfill).
    ledgerInstalledAt: "v077InstalledAt",
    // v0.7.9.1 (spec PM 16/10/2026): mốc cài {at, version, held: [orderId]} — worker ghi ĐÚNG MỘT lần, SAU khi đã giữ mọi job
    // "Cần kiểm tra" có từ trước (notifyHoldJob). Luật bỏ qua mảnh QR lỗi (notifyUnplacedDismissal) chỉ áp cho đơn COMPLETED sau mốc.
    // v0.7.10 (PM 17/10/2026 — trừ theo từng UID, v0.7.9.1 không cài): khoá mới → lần đầu v0.7.10 chạy giữ lại mọi job "Cần kiểm tra"
    // (luật mới gửi được phần đạt của đơn đã bị chặn — đơn đó phải ở lại đối soát thủ công).
    // v0.7.10.1 (audit PM 17/10/2026, P1 — v0.7.10 không cài): bỏ khoá vĩnh viễn. Mốc {at, version, legacy: [orderId]} — legacy = job
    // CHƯA gửi có lúc ghi mốc; không sửa job nào. Đơn cũ (notifyPreUpgrade) không bao giờ tự gửi; gửi tay qua pilot sau khi người vận
    // hành xác nhận đơn chưa được xử lý trên Nextwaves.
    notifyFixInstalledAt: "v07101InstalledAt",
    // v0.7.10.5 (spec PM 23/10/2026 — một tem, đổi đơn vị bán; v0.7.10.4 không cài): mốc cài {at, version} — worker ghi ĐÚNG MỘT lần,
    // không sửa job nào. Luật một tem đổi đơn vị chỉ áp cho đơn được TẠO và HOÀN TẤT sau mốc (audit PM 23/10: không dựa vào
    // status_updated_at — đơn cũ mở / sửa lại có mốc trạng thái mới): đơn đã bị giữ trước khi nâng cấp (vd DHC01294054, danh sách xử lý tay)
    // giữ nguyên kết quả cũ, không bao giờ tự gửi bằng luật mới. Thiếu mốc → luật cũ (giữ dòng).
    unitChangeInstalledAt: "v07105InstalledAt",
    // v0.8.0 (stakeholder 27/10/2026, PM audit 27/10): tab data NGỪNG ghi. Mốc {at, version, dataUnsynced} — worker ghi ĐÚNG MỘT lần
    // (lần đầu worker v0.8.0 chạy), kèm số bản ghi còn chưa lên tab data lúc đó (syncCounts): không gửi nữa, vẫn nằm trên máy và
    // trong file xuất JSON; popup báo số này (không bỏ âm thầm).
    dataStoppedAt: "v080InstalledAt",
  });

  const MSG = Object.freeze({
    SAVE_EVENT: "SAVE_EVENT",
    UPSERT_EVENT: "UPSERT_EVENT", // 0.2.0: lượt RFID — tạo nếu chưa có, vá theo seq nếu đã có
    UPSERT_ORDER: "UPSERT_ORDER",
    UPSERT_QR: "UPSERT_QR",
    SAVE_DIAG: "SAVE_DIAG",
    PING: "PING",
    SYNC_NOW: "SYNC_NOW", // Batch C: popup "Đồng bộ lại" — chỉ gửi dữ liệu đã có lên Sheet
    // v0.7.1: tab vừa mở / F5 nhờ worker dọn hàng chờ pend:* NGAY (tab không còn tự quét lại kho chờ). Không mang dữ liệu.
    DRAIN_PENDING: "DRAIN_PENDING",
    ITEM_INFO: "ITEM_INFO", // 0.3: dòng hàng POS của CHÍNH lượt này (số lượng, đơn vị, giá)
    // 0.6.0.1: popup xin worker mở lại job trừ tồn đã hết lượt thử vì lỗi hạ tầng. Popup KHÔNG tự ghi
    // khoá stockout: — worker vẫn là nơi ghi duy nhất, và chỉ nó biết job có đang chạy dở hay không.
    STOCKOUT_RETRY: "STOCKOUT_RETRY",
    // v0.7 Batch A: ngay trước phím đầu của lượt RFID — worker ghi bản ghi lượt (result "unconfirmed") rồi dấu chống
    // trùng "submitted", CHỈ trả ACK khi cả hai đã ghi xong. Thay cho chuỗi UPSERT_EVENT (hàng chờ) rồi SET_MARK.
    PREPARE_RFID_SEND: "PREPARE_RFID_SEND",
    // v0.7 Batch D: một thao tác dòng hàng POS đã phân loại chắc chắn (item_quantity_set / item_delete) — worker tạo
    // bản ghi ev: bất biến. Cùng eventId gửi lại là no-op.
    POS_ITEM_ACTION: "POS_ITEM_ACTION",
    // v0.7 Batch D: lời gọi /item không phân loại được → một dòng chẩn đoán ngắn, không tạo bản ghi.
    POS_ACTION_DIAG: "POS_ACTION_DIAG",
    // v0.7.3: popup duyệt gửi trừ tồn MỘT đơn pilot {orderId, payloadHash} — worker kiểm lại mọi cổng rồi mới POST một lần.
    NOTIFY_APPROVE: "NOTIFY_APPROVE",
    // v0.7.3: popup xin dựng lại bản xem trước của đơn pilot (tra lại lượng tag) {orderId}. Không bao giờ gửi.
    NOTIFY_RECHECK: "NOTIFY_RECHECK",
    // v0.7.5: popup xin GỬI LẠI ĐÚNG yêu cầu đã đóng băng (payload + Idempotency-Key) của job "không rõ kết quả" {orderId, payloadHash}.
    NOTIFY_RESEND: "NOTIFY_RESEND",
  });

  const VERDICT = Object.freeze({ ACCEPTED: "accepted", REVIEW: "review", DISCARD: "discard" });
  const INPUT_MODE = Object.freeze({ NORMAL: "normal", ALT_DECIMAL: "alt_decimal" });

  const REASON_LABELS = Object.freeze({
    short: "Mã ngắn hơn ngưỡng",
    slow: "Tốc độ phím giống gõ tay",
    no_terminator: "Không có phím kết thúc (Enter/Tab)",
    typing: "Gõ tay",
    single_key: "Chỉ một phím",
    too_little_evidence: "Quá ít phím để kết luận",
    not_on_sales_route: "Ngoài màn bán hàng / chuyển hàng",
    empty: "Rỗng",
    altcode_unknown: "Có mã Alt không đổi được ra ký tự",
    legacy_altcode_unverified: "Dãy mã Alt của bản cũ, chưa đối chứng được với POS",
  });

  const DEFAULT_SETTINGS = Object.freeze({
    // Phím kết thúc do máy quét gửi. Rỗng = chế độ "không suffix" (chốt lượt bằng khoảng nghỉ).
    terminators: ["Enter", "Tab"],
    // Chế độ có phím kết thúc: khoảng nghỉ tách đoạn. Đủ lớn để một mã bị khựng giữa chừng
    // không bị cắt đôi; đoạn chỉ được xác nhận khi có phím kết thúc.
    segmentGapMs: 300,
    // v0.7.6 (DHC01245140 + 5 lượt khác 30/09–07/10): máy quét chế độ mã Alt đôi khi KHỰNG 310–510 ms giữa một mã rồi gửi
    // tiếp phần còn lại + Enter; POS vẫn nhận nguyên mã (ô nhập gom tới Enter) nhưng extension cắt đôi ở ngưỡng 300 ms. Đoạn
    // đang mở đã giống máy quét (≥ reviewBelowLength phím, nhịp trung bình ≤ maxAvgGapMs) mà chưa có phím kết thúc thì chờ tối đa
    // stallGapMs trước khi khép — phần tiếp theo nối vào CÙNG lượt như POS. Đoạn giống gõ tay vẫn khép ở segmentGapMs.
    stallGapMs: 1500,
    // Chế độ không suffix: khoảng nghỉ chốt lượt.
    noTerminatorGapMs: 80,
    // Tốc độ trung bình tối đa (ms/phím) để tự tin đó là máy quét.
    maxAvgGapMs: 40,
    // Tốc độ trung bình lớn hơn ngưỡng này chắc chắn là gõ tay.
    typingAvgGapMs: 100,
    // Ngắn hơn ngưỡng này thì không tự ghi nhận, đưa vào "cần kiểm tra".
    reviewBelowLength: 4,
  });

  const SETTING_LIMITS = Object.freeze({
    segmentGapMs: [50, 2000],
    stallGapMs: [50, 5000],
    noTerminatorGapMs: [20, 500],
    maxAvgGapMs: [5, 200],
    typingAvgGapMs: [10, 1000],
    reviewBelowLength: [1, 64],
  });

  function normalizeSettings(input) {
    const out = Object.assign({}, DEFAULT_SETTINGS);
    if (!input || typeof input !== "object") return out;
    for (const key of Object.keys(SETTING_LIMITS)) {
      const n = Number(input[key]);
      const [lo, hi] = SETTING_LIMITS[key];
      if (Number.isFinite(n)) out[key] = Math.min(hi, Math.max(lo, Math.round(n)));
    }
    if (Array.isArray(input.terminators)) {
      out.terminators = input.terminators.filter((k) => k === "Enter" || k === "Tab");
    }
    if (out.typingAvgGapMs < out.maxAvgGapMs) out.typingAvgGapMs = out.maxAvgGapMs;
    return out;
  }

  function isUuid(value) {
    return typeof value === "string" && UUID_RE.test(value);
  }

  // { type: "sale_order", id: <uuid> } hoặc null nếu không phải màn bán hàng (v0.8.0: màn chuyển hàng → null).
  function parseWorkContext(pathname) {
    const m = String(pathname || "").match(WORK_ROUTE_RE);
    if (!m || !isUuid(m[2])) return null;
    return { type: ROUTE_RECORD_TYPE[m[1].toLowerCase()], id: m[2].toLowerCase() };
  }

  // ID đơn bán trên URL (v0.8.0: không còn phiếu chuyển). Tên giữ nguyên để tương thích.
  function parseOrderIdFromPath(pathname) {
    const c = parseWorkContext(pathname);
    return c ? c.id : null;
  }

  function isTransferRoute(pathname) {
    return TRANSFER_ROUTE_RE.test(String(pathname || ""));
  }

  // Thiếu / lạ = lượt bán (bản ghi trước 0.1.8 không có recordType). Hai loại còn lại phải GHI RÕ.
  function recordTypeOf(x) {
    const t = x && x.recordType;
    return t === RECORD_TYPE.TRANSFER_OUT || t === RECORD_TYPE.SALE_ORDER_ACTION || t === RECORD_TYPE.SALE_ORDER_STATUS ? t : RECORD_TYPE.SALE_ORDER;
  }

  // ---- Chuyển hàng: mỗi phiếu chỉ giữ MỘT bản ghi cho mỗi mã QR (stakeholder 2026-09-17) ----
  // Người dùng quét cùng một sản phẩm hai lần (thêm vào phiếu, rồi xác nhận khi PICKING). Khoá sự kiện
  // được tính cố định từ (ID phiếu, mã QR) nên lần quét sau ghi vào đúng khoá cũ, không sinh bản ghi thứ hai.
  // Hàm băm cyrb128 (32 hex) đổi ra dạng UUID; không dùng cho bảo mật, chỉ để có khoá ổn định.
  function stableUuid(input) {
    const str = String(input);
    let h1 = 1779033703;
    let h2 = 3144134277;
    let h3 = 1013904242;
    let h4 = 2773480762;
    for (let i = 0; i < str.length; i++) {
      const k = str.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    h1 ^= h2 ^ h3 ^ h4;
    h2 ^= h1;
    h3 ^= h1;
    h4 ^= h1;
    const hex = [h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, "0")).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20, 32);
  }

  function transferEventId(transferId, qrCode) {
    return stableUuid(RECORD_TYPE.TRANSFER_OUT + "|" + String(transferId).toLowerCase() + "|" + qrCode);
  }

  // Quyết định ghi khi đã có bản ghi cùng khoá (chỉ áp dụng cho chuyển hàng):
  //  - chưa có            → ghi mới
  //  - có, đang "cần kiểm tra" mà lượt mới "ghi nhận" → nâng lên bản ghi nhận, giữ thời gian quét đầu tiên
  //  - còn lại            → giữ nguyên bản cũ, không ghi
  // 0.5: bản ghi chuyển hàng cũng là một dòng Sheet, nên worker sở hữu revision / trạm / trường đồng bộ
  // y như lượt bán. Content gửi trường nào trong nhóm đó cũng bị bỏ.
  function newTransferRecord(event, ord, nowIso) {
    const rec = Object.assign({}, event);
    for (const f of WORKER_OWNED_FIELDS) delete rec[f];
    rec.recordType = RECORD_TYPE.TRANSFER_OUT;
    rec.uid = textOrNull(rec.qrCode); // chốt 0.5: uid của dòng chuyển hàng = mã đã trích
    for (const f of STATION_FIELDS) rec[f] = null;
    Object.assign(rec, orderSnapshot(ord));
    rec.revision = 1;
    rec.updatedAt = nowIso;
    rec.syncedRevision = 0;
    rec.syncedAt = null;
    return rec;
  }

  function dedupeTransferEvent(existing, incoming, ord, nowIso) {
    if (!existing) return { write: true, record: newTransferRecord(incoming, ord, nowIso), duplicate: false };
    if (existing.status === VERDICT.REVIEW && incoming.status === VERDICT.ACCEPTED) {
      // Nâng "cần kiểm tra" lên "ghi nhận": giữ thời điểm quét đầu tiên VÀ mọi trường của worker
      // (revision, trạm, trạng thái đồng bộ, snapshot phiếu) — chỉ phần nội dung của content được thay.
      const next = Object.assign({}, existing);
      for (const [k, v] of Object.entries(incoming)) {
        if (WORKER_OWNED_FIELDS.indexOf(k) >= 0 || k === "scannedAt" || k === "eventId") continue;
        next[k] = v;
      }
      next.recordType = RECORD_TYPE.TRANSFER_OUT;
      next.uid = textOrNull(next.qrCode);
      const r = finishUpdate(existing, next, nowIso);
      return { write: r.changed, record: r.record, duplicate: true };
    }
    return { write: false, record: existing, duplicate: true };
  }

  function parseOrderCodeText(text) {
    const m = String(text || "").trim().match(ORDER_CODE_RE);
    return m ? m[1] : null;
  }

  function shortId(uuid) {
    const v = String(uuid || "");
    return v.length > 8 ? "…" + v.slice(-4) : v;
  }

  function isPrintableKey(key) {
    return typeof key === "string" && key.length === 1;
  }

  function isImeKey(ev) {
    return ev.key === "Process" || ev.key === "Unidentified" || ev.keyCode === 229;
  }

  // Phân loại một đoạn phím đã khép lại. Ba kết luận:
  //  accepted: tự tin là máy quét, ghi nhận là lượt quét hoàn chỉnh
  //  review:   không chắc (ngắn, chậm, thiếu phím kết thúc...) → lưu nhưng đánh dấu "cần kiểm tra"
  //  discard:  chắc chắn không phải lượt quét trên màn bán hàng → chỉ ghi chẩn đoán
  function classifySegment(s, settings) {
    const st = normalizeSettings(settings);
    const terminatorMode = st.terminators.length > 0;
    const hasTerminator = !!s.terminator;
    const len = s.text.length;
    const measurable = s.keyCount >= 2;
    const fast = measurable && s.avgGapMs <= st.maxAvgGapMs;
    const longEnough = len >= st.reviewBelowLength;
    const A = () => ({ verdict: VERDICT.ACCEPTED, reason: null });
    const R = (reason) => ({ verdict: VERDICT.REVIEW, reason });
    const D = (reason) => ({ verdict: VERDICT.DISCARD, reason });

    if (len === 0) return D("empty");
    if (!s.context || !s.context.orderId) return D("not_on_sales_route");
    // Có ký tự ghép từ mã Alt nhưng không đổi được: lưu lại để kiểm tra, không tự coi là mã đúng.
    if (s.altUnknown > 0 && measurable && s.avgGapMs <= st.typingAvgGapMs) return R("altcode_unknown");

    if (terminatorMode) {
      if (hasTerminator) {
        if (longEnough && fast) return A();
        if (measurable && s.avgGapMs > st.typingAvgGapMs) return D("typing");
        if (!measurable) return D("single_key");
        if (s.keyCount < 3 && !fast) return D("too_little_evidence");
        if (!longEnough) return R("short");
        return R("slow");
      }
      // Đoạn khép lại vì khoảng nghỉ, không có phím kết thúc: không bao giờ tự ghi nhận.
      if (longEnough && fast) return R("no_terminator");
      return D(fast ? "short" : "typing");
    }

    // Chế độ không suffix: chốt bằng khoảng nghỉ, chỉ dựa vào tốc độ.
    if (longEnough && fast) return A();
    if (fast) return R("short");
    return D("typing");
  }

  // Đổi chuỗi chữ số của một mã Alt ra ký tự. Theo quy ước Windows:
  //  - Có số 0 đứng đầu (Alt+0116): bảng mã ANSI. Chỉ nhận 32–126 và 160–255 (trùng Latin-1).
  //  - Không có số 0 đầu (Alt+116): bảng mã OEM, giá trị lấy theo modulo 256. Chỉ nhận 32–126 (ASCII).
  // Ngoài các khoảng này thì không đoán, trả null.
  function altCodeToChar(digits) {
    const s = String(digits || "");
    if (!/^[0-9]{1,5}$/.test(s)) return null;
    const n = parseInt(s, 10);
    if (s.length > 1 && s[0] === "0") {
      if ((n >= 32 && n <= 126) || (n >= 160 && n <= 255)) return String.fromCharCode(n);
      return null;
    }
    const m = n % 256;
    return m >= 32 && m <= 126 ? String.fromCharCode(m) : null;
  }

  // Bản ≤ v0.1.6 lưu dãy chữ số của mã Alt thay vì ký tự (ví dụ "116104117…" = "thu…").
  // Với ký tự ASCII in được, cách tách là duy nhất: số bắt đầu bằng "1" gồm 3 chữ số (100–126),
  // còn lại gồm 2 chữ số (32–99). Trả null nếu chuỗi không tách được trọn vẹn theo quy tắc đó.
  function decodeLegacyAltDigits(raw) {
    const s = String(raw || "");
    if (s.length < 20 || !/^[0-9]+$/.test(s)) return null;
    let out = "";
    let i = 0;
    while (i < s.length) {
      const width = s[i] === "1" ? 3 : 2;
      if (i + width > s.length) return null;
      const n = parseInt(s.slice(i, i + width), 10);
      if (width === 3 ? n < 100 || n > 126 : n < 32 || n > 99) return null;
      out += String.fromCharCode(n);
      i += width;
    }
    return out;
  }

  // Tập mã QR mà chính POS xác nhận: mã POS ghi trên dòng hàng của đơn, và mã POS đã gửi đi tra sản phẩm.
  function buildQrEvidence(orders, qrs) {
    const set = new Set();
    for (const o of orders || []) for (const it of (o && o.posItems) || []) for (const q of it.qrCodes || []) set.add(q);
    for (const q of qrs || []) if (q && q.qrCode) set.add(q.qrCode);
    return set;
  }

  // Mã hiệu lực của một lượt quét khi xem và xuất. Luôn tính từ qrRaw đã lưu, không sửa dữ liệu gốc.
  // Chỉ bản ghi của các bản ≤ v0.1.6 (chưa có inputMode) mới có thể là dãy số mã Alt:
  //  - giải mã được VÀ mã giải ra có trong dữ liệu POS  → dùng mã đã giải (recovered)
  //  - giải mã được nhưng không có đối chứng            → giữ nguyên, đánh dấu "cần kiểm tra" (unverified)
  //  - không phải dãy mã Alt                             → dùng như thường
  // Bản ghi mới luôn có inputMode nên không bao giờ bị đoán lại.
  function resolveScan(e, evidence) {
    const raw = String((e && e.qrRaw) || "");
    const direct = extractQrCode(raw) || (e && e.qrCode) || "";
    const base = { text: raw, code: direct, recovered: false, unverified: false, reason: null };
    if (evidence && evidence.has(direct)) return base;
    const legacyRecord = !(e && e.inputMode);
    if (!legacyRecord) return base;
    const decoded = decodeLegacyAltDigits(raw);
    if (!decoded) return base;
    const code = extractQrCode(decoded);
    if (evidence && evidence.has(code)) return { text: decoded, code, recovered: true, unverified: false, reason: null };
    return { text: raw, code: direct, recovered: false, unverified: true, reason: "legacy_altcode_unverified" };
  }

  // Kết luận hiển thị của một lượt: trạng thái đã lưu, cộng thêm "cần kiểm tra" nếu là dãy mã Alt chưa đối chứng.
  function displayStatus(e, scan) {
    if (e && e.status === VERDICT.REVIEW) return { status: VERDICT.REVIEW, reason: e.reason || null };
    if (scan && scan.unverified) return { status: VERDICT.REVIEW, reason: scan.reason };
    return { status: VERDICT.ACCEPTED, reason: null };
  }

  // Tổng / số khoảng giữa các phím, bỏ các khoảng khựng (> segmentGapMs).
  function activeGaps(times, segmentGapMs) {
    let sum = 0;
    let count = 0;
    for (let i = 1; i < times.length; i++) {
      const g = times[i] - times[i - 1];
      if (g > segmentGapMs) continue;
      sum += g;
      count += 1;
    }
    return { sum, count };
  }

  // Máy trạng thái gom dòng phím của scanner USB-HID thành từng đoạn.
  // Không tự đặt timer; phía gọi phải gọi tick(now) sau mỗi phím để khép đoạn khi nghỉ.
  class ScanBurstDetector {
    constructor(settings, hooks) {
      this.settings = normalizeSettings(settings);
      this.hooks = hooks || {};
      this.burst = null;
    }

    updateSettings(settings) {
      this.settings = normalizeSettings(settings);
    }

    get active() {
      return this.burst !== null;
    }

    // Khoảng nghỉ khép đoạn theo chế độ hiện tại. Có phím kết thúc + đoạn đang mở giống máy quét → chờ khựng (stallGapMs).
    get gapLimit() {
      const s = this.settings;
      if (!(s.terminators.length > 0)) return s.noTerminatorGapMs;
      const b = this.burst;
      if (b && b.times.length >= s.reviewBelowLength) {
        const a = activeGaps(b.times, s.segmentGapMs);
        if (a.count > 0 && a.sum / a.count <= s.maxAvgGapMs) return Math.max(s.segmentGapMs, s.stallGapMs);
      }
      return s.segmentGapMs;
    }

    _start(t, context) {
      this.burst = {
        chars: [],
        times: [],
        imeCount: 0,
        backspaces: 0,
        altDigits: "", // chữ số đang gom của một mã Alt (Alt giữ + phím số)
        altDigitsLog: [], // toàn bộ các nhóm mã Alt máy quét gửi, giữ nguyên để truy vết
        altChars: 0, // số ký tự ghép từ mã Alt
        altUnknown: 0, // mã Alt không đổi được ra ký tự in được
        inputText: "",
        compositionText: "",
        startedAt: t,
        lastAt: t,
        // Ngữ cảnh chụp tại phím đầu tiên (orderId, focus...) — không đọc lại sau đó.
        context: context || null,
      };
    }

    // Máy quét cấu hình "gõ bằng mã Alt" (quan sát trên POS production 2026-09-16): mỗi ký tự là
    // Alt giữ + các phím số, ví dụ Alt+116 = "t". Windows ghép ra ký tự cho POS, nhưng trang chỉ
    // nhận các keydown chữ số. Gom chữ số rồi đổi ra một ký tự khi nhả Alt, khi Alt được bấm cho
    // ký tự kế tiếp, hoặc trước bất kỳ phím nào khác.
    _flushAlt() {
      const b = this.burst;
      if (!b || !b.altDigits) return;
      const ch = altCodeToChar(b.altDigits);
      b.altDigitsLog.push(b.altDigits);
      b.altDigits = "";
      if (ch === null) {
        b.chars.push("�");
        b.altUnknown++;
      } else {
        b.chars.push(ch);
      }
      b.altChars++;
    }

    // ev: { key, code?, altKey?, timeStamp, repeat?, keyCode?, context? }
    keydown(ev) {
      if (!ev || ev.repeat) return null;
      const t = Number(ev.timeStamp) || 0;
      const key = ev.key;
      const s = this.settings;
      let closed = null;

      if (this.burst && t - this.burst.lastAt > this.gapLimit) closed = this._close(null, t);

      // Phím số khi đang giữ Alt: đọc theo mã vật lý (Numpad0..9) để không phụ thuộc đèn NumLock.
      const numpad = /^Numpad([0-9])$/.exec(String(ev.code || ""));
      if (ev.altKey && numpad) {
        if (!this.burst) this._start(t, ev.context);
        this.burst.altDigits += numpad[1];
        this.burst.times.push(t);
        this.burst.lastAt = t;
        return closed;
      }
      if (key === "Alt") {
        if (this.burst) this._flushAlt();
        return closed;
      }
      if (this.burst) this._flushAlt();

      if (s.terminators.includes(key)) {
        if (this.burst) closed = this._close(key, t);
        return closed;
      }

      // Bộ gõ tiếng Việt (Unikey/EVKey) sửa từ bằng cách gửi Backspace rồi gõ lại (kể cả khôi phục
      // nguyên văn khi từ không phải tiếng Việt). Phải phát lại đúng chuỗi sửa đó để tái tạo văn bản
      // cuối cùng mà POS nhận; nếu bỏ qua Backspace sẽ gom cả ký tự trung gian ("thuoc·óci·thuocsi...").
      if (key === "Backspace") {
        if (!this.burst) return closed;
        if (this.burst.chars.length) this.burst.chars.pop();
        this.burst.backspaces++;
        this.burst.times.push(t);
        this.burst.lastAt = t;
        return closed;
      }

      const printable = isPrintableKey(key);
      const ime = !printable && isImeKey(ev);
      if (!printable && !ime) return closed; // Shift, Ctrl, mũi tên... bỏ qua

      if (!this.burst) this._start(t, ev.context);
      if (printable) this.burst.chars.push(key);
      else this.burst.imeCount++;
      this.burst.times.push(t);
      this.burst.lastAt = t;
      return closed;
    }

    // ev: { data, inputType, timeStamp } — kênh dự phòng khi bàn phím đi qua IME tiếng Việt.
    input(ev) {
      if (!this.burst || !ev) return;
      const t = Number(ev.timeStamp) || 0;
      if (t - this.burst.lastAt > this.gapLimit) return;
      if (ev.inputType === "deleteContentBackward") {
        if (this.burst.compositionText) this.burst.compositionText = this.burst.compositionText.slice(0, -1);
        else this.burst.inputText = this.burst.inputText.slice(0, -1);
        return;
      }
      if (typeof ev.data !== "string" || !ev.data) return;
      if (ev.inputType === "insertCompositionText") this.burst.compositionText = ev.data;
      else if (ev.inputType === "insertText" || ev.inputType === "insertFromPaste") this.burst.inputText += ev.data;
    }

    // ev: { key } — nhả Alt kết thúc một mã Alt.
    keyup(ev) {
      if (ev && ev.key === "Alt" && this.burst) this._flushAlt();
    }

    tick(now) {
      if (this.burst && now - this.burst.lastAt > this.gapLimit) return this._close(null, now);
      return null;
    }

    // Khép ngay đoạn đang mở (dùng khi trang sắp unload).
    flush(now) {
      return this.burst ? this._close(null, now) : null;
    }

    _close(terminator, now) {
      this._flushAlt();
      const b = this.burst;
      this.burst = null;

      const kbText = b.chars.join("");
      const inputText = b.inputText + b.compositionText;
      let text = kbText;
      let channel = "keydown";
      if (b.imeCount > 0 && inputText.length > kbText.length) {
        text = inputText;
        channel = "input";
      }

      const keyCount = b.times.length;
      const durationMs = Math.max(0, b.lastAt - b.startedAt);
      // v0.7.6: nhịp trung bình tính trên các khoảng KHÔNG phải khựng (> segmentGapMs) — một lần khựng của máy quét không làm
      // lượt bị coi là gõ tay. Lượt không khựng: giống hệt trước (durationMs / (keyCount − 1)). maxGapMs giữ khoảng khựng để truy vết.
      const act = activeGaps(b.times, this.settings.segmentGapMs);
      const avgGapMs = act.count > 0 ? act.sum / act.count : 0;
      let maxGapMs = 0;
      for (let i = 1; i < b.times.length; i++) maxGapMs = Math.max(maxGapMs, b.times[i] - b.times[i - 1]);

      const summary = {
        text,
        terminator: terminator || null,
        channel,
        keyCount,
        durationMs: Math.round(durationMs),
        avgGapMs: Math.round(avgGapMs * 10) / 10,
        maxGapMs: Math.round(maxGapMs),
        imeCount: b.imeCount,
        backspaces: b.backspaces,
        altChars: b.altChars,
        altUnknown: b.altUnknown,
        // Loại đầu vào: "normal" = máy quét gửi ký tự thường; "alt_decimal" = gửi bằng Alt + mã số thập phân.
        inputMode: b.altChars > 0 ? INPUT_MODE.ALT_DECIMAL : INPUT_MODE.NORMAL,
        // Dữ liệu gốc máy quét gửi (các nhóm mã Alt, cách nhau bằng dấu cách) để truy vết; null nếu gõ thường.
        altDigits: b.altChars > 0 ? b.altDigitsLog.join(" ") : null,
        startedAt: b.startedAt,
        endedAt: now,
        context: b.context,
      };
      const c = classifySegment(summary, this.settings);
      summary.verdict = c.verdict;
      summary.reason = c.reason;
      if (typeof this.hooks.onSegment === "function") this.hooks.onSegment(summary);
      return summary;
    }
  }

  // QR của Circa/thuocsi là URL, đã gặp ít nhất hai dạng trên POS thật:
  //   thuocsi.vn/qr/1778832278088L2289      → POS lưu 1778832278088L2289
  //   qr.v2.circa.vn/item/1786736341375C2   → POS lưu 1786736341375C2
  // Nên lấy đoạn cuối của đường dẫn thay vì bám vào một tiền tố cố định.
  // Chuỗi không phải URL (mã thuần) được giữ nguyên. qrRaw luôn giữ nguyên văn.
  const QR_URL_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(\/[^\s?#]*)/i;
  function extractQrCode(raw) {
    const s = String(raw || "").trim();
    if (!s || s.indexOf("/") === -1) return s;
    const m = s.match(QR_URL_RE);
    if (!m) return s;
    const segments = m[1].split("/").filter(Boolean);
    const last = segments.length ? segments[segments.length - 1] : "";
    return last || s;
  }

  // ---- Trích thông tin đơn từ response POS (chỉ giữ trường tối thiểu, không PII) ----
  function looksLikeOrder(o) {
    return !!(o && typeof o === "object" && isUuid(o.id) && typeof o.code === "string" && parseOrderCodeText(o.code) && typeof o.status === "string");
  }

  function pickOrder(json) {
    if (!json || typeof json !== "object") return null;
    if (json.data && looksLikeOrder(json.data.order)) return json.data.order;
    if (looksLikeOrder(json.data)) return json.data;
    if (looksLikeOrder(json.order)) return json.order;
    if (looksLikeOrder(json)) return json;
    return null;
  }

  function stringOrNull(v) {
    return typeof v === "string" && v ? v : null;
  }

  function extractOrderInfo(json) {
    const order = pickOrder(json);
    if (!order) return null;
    const items = Array.isArray(order.items) ? order.items : [];
    return {
      recordType: RECORD_TYPE.SALE_ORDER,
      orderId: order.id.toLowerCase(),
      orderCode: parseOrderCodeText(order.code),
      status: stringOrNull(order.status),
      paymentStatus: stringOrNull(order.payment_status),
      paymentMethod: stringOrNull(order.payment_method),
      isPaymentSuccess: typeof order.is_payment_success === "boolean" ? order.is_payment_success : null,
      completedDate: stringOrNull(order.completed_date),
      // 0.6: loại đơn ở CẤP ĐƠN ("OFFLINE" = bán tại quầy). Điều kiện bắt buộc của pilot trừ tồn.
      // KHÔNG trùng với event.orderType (cấp lượt, từ POST /item, đã nằm trên Sheet) và KHÔNG được
      // thêm vào ORDER_SNAPSHOT_FIELDS/TRANSFER_SNAPSHOT_FIELDS: làm vậy sẽ đè cột Sheet của mọi lượt.
      orderType: stringOrNull(order.type),
      // Mốc do POS ghi trên chính bản ghi đơn: dùng để biết response nào mới hơn.
      updatedDate: stringOrNull(order.updated_date) || stringOrNull(order.status_updated_at),
      // v0.7 Batch C: mốc của TRẠNG THÁI hiện tại (so với v07InstalledAt) — khác updatedDate (mốc của cả bản ghi đơn).
      statusUpdatedAt: stringOrNull(order.status_updated_at),
      // v0.7 Batch C: 9 trường nghiệp vụ của từng dòng hàng (data.order.items[] — không phải modified_items), nguồn của
      // completed_items. Giá = item.unit_price; tên / mã từ item.product khi cấp item rỗng.
      saleItems: saleItemsOf(order),
      // v0.7.3: ngày tạo đơn + dòng hàng phục vụ trừ tồn (base_quantity, quy đổi) — cùng luật "thuộc CHÍNH response" như saleItems.
      createdDate: stringOrNull(order.created_date),
      stockItems: stockItemsOf(order),
      posItems: items.map((it) => ({
        itemId: stringOrNull(it && it.id),
        skuCode: stringOrNull(it && it.sku_code),
        productName: stringOrNull(it && it.product_name),
        unit: stringOrNull(it && it.unit),
        quantity: it && Number.isFinite(Number(it.quantity)) ? Number(it.quantity) : null,
        qrCode: stringOrNull(it && it.qr_code),
        qrCodes: Array.isArray(it && it.qr_codes) ? it.qr_codes.filter((q) => typeof q === "string") : [],
      })),
    };
  }

  // Phiếu chuyển hàng: response của /v1/inventory/transfer-request(-out)/<id>[/items|/item|/status].
  // Chỉ giữ mã phiếu, trạng thái, mốc cập nhật và mã QR POS ghi trên từng dòng; bỏ tên người tạo,
  // tên/địa chỉ cửa hàng, giá và mô tả sản phẩm.
  function looksLikeTransfer(d) {
    return !!(
      d &&
      typeof d === "object" &&
      isUuid(d.id) &&
      typeof d.code === "string" &&
      parseOrderCodeText(d.code) &&
      typeof d.status === "string" &&
      typeof d.type === "string" &&
      /^TRANSFER/i.test(d.type)
    );
  }

  function realDateOrNull(v) {
    const t = parseTime(v);
    return t !== null && new Date(t).getUTCFullYear() >= 2000 ? v : null; // "0001-01-01T00:00:00Z" = chưa có
  }

  function extractTransferInfo(json) {
    const d = json && typeof json === "object" ? json.data : null;
    if (!looksLikeTransfer(d)) return null;
    const items = Array.isArray(d.transfer_items) ? d.transfer_items : [];
    return {
      recordType: RECORD_TYPE.TRANSFER_OUT,
      orderId: d.id.toLowerCase(),
      orderCode: parseOrderCodeText(d.code),
      status: stringOrNull(d.status),
      transferType: stringOrNull(d.type),
      completedDate: realDateOrNull(d.completed_at),
      updatedDate: stringOrNull(d.updated_at),
      posItems: items.map((it) => ({
        itemId: stringOrNull(it && it.id),
        skuCode: stringOrNull(it && it.sku_code),
        productName: stringOrNull(it && it.product && it.product.name),
        unit: stringOrNull(it && it.unit),
        quantity: Number.isFinite(Number(it && it.quantity)) ? Number(it.quantity) : null,
        qrCode: null,
        qrCodes: Array.isArray(it && it.details) ? it.details.map((x) => x && x.qr_code).filter((q) => typeof q === "string" && q) : [],
      })),
    };
  }

  const TERMINAL_STATUSES = new Set(["COMPLETED", "CANCELLED", "CANCELED", "RETURNED", "REJECTED"]);

  function parseTime(iso) {
    const t = Date.parse(String(iso || ""));
    return Number.isFinite(t) ? t : null;
  }

  // Response tới muộn có được phép ghi đè không? Chỉ dùng mốc thời gian do POS ghi trên đơn,
  // không dùng thời điểm extension nhận.
  function isStaleOrderInfo(existing, incoming) {
    if (!existing) return false;
    const a = parseTime(existing.updatedDate);
    const b = parseTime(incoming.updatedDate);
    if (a !== null && b !== null) return b < a;
    if (a !== null && b === null) return true; // bản không có mốc: không đủ bằng chứng để đè bản đã có mốc
    if (a === null && b !== null) return false; // bản ghi cũ (v0.1.0) chưa có mốc: tin response có mốc của POS
    // Cả hai không có mốc: không cho hạ trạng thái đã kết thúc.
    if (existing.status && TERMINAL_STATUSES.has(existing.status) && incoming.status && incoming.status !== existing.status) return true;
    return false;
  }

  const ORDER_FIELDS = [
    "recordType",
    "orderCode",
    "status",
    "transferType",
    "paymentStatus",
    "paymentMethod",
    "isPaymentSuccess",
    "completedDate",
    "orderType", // 0.6 — chỉ ở bản ghi ord:, KHÔNG bao giờ chép sang lượt (xem extractOrderInfo)
    "updatedDate",
    "posItems",
    "createdDate", // v0.7.3 — ngày tạo không đổi theo phiên bản: thiếu ở response sau thì giữ bản đã có
    // v0.7 Batch C: statusUpdatedAt / saleItems KHÔNG nằm ở đây — chúng thuộc CHÍNH response đang gộp (mergeOrderInfo).
  ];

  // Gộp thông tin đơn mới (từ response POS) vào bản ghi cũ.
  function mergeOrderInfo(existing, incoming, nowIso) {
    const prev = existing && typeof existing === "object" ? existing : null;
    const next = Object.assign({}, prev || {}, { orderId: incoming.orderId });
    next.firstSeenAt = (prev && prev.firstSeenAt) || nowIso;
    next.lastSeenAt = nowIso;
    if (isStaleOrderInfo(prev, incoming)) {
      next.staleResponses = (prev.staleResponses || 0) + 1;
      return next;
    }
    for (const k of ORDER_FIELDS) {
      if (incoming[k] !== undefined && incoming[k] !== null) next[k] = incoming[k];
    }
    // v0.7 Batch C (P1 audit C): danh sách dòng và mốc trạng thái là của CHÍNH response này. Response thiếu items[] (hoặc
    // thiếu status_updated_at) KHÔNG được để lại danh sách / số lượng / giá / mốc của snapshot cũ cho phiên bản mới —
    // saleItems = null và completedVerdict từ chối. saleItemsVersion = updated_date của response đã cho danh sách đó.
    // Chỉ tên / mã sản phẩm của CÙNG itemId được giữ qua các response (productNames): response POST/DELETE / hoàn tất đơn
    // có thể không kèm product.
    if (recordTypeOf(incoming) === RECORD_TYPE.SALE_ORDER) {
      const names = mergeProductNames(prev, incoming.saleItems);
      if (Object.keys(names).length) next.productNames = names;
      const has = Array.isArray(incoming.saleItems);
      next.saleItems = has ? fillSaleItemNames(incoming.saleItems, names) : null;
      next.saleItemsVersion = has ? textOrNull(incoming.updatedDate) : null;
      next.statusUpdatedAt = textOrNull(incoming.statusUpdatedAt);
      // v0.7.3: dòng hàng trừ tồn cũng thuộc CHÍNH response — thiếu items[] thì null, không giữ danh sách của phiên bản cũ.
      const hasStock = Array.isArray(incoming.stockItems);
      next.stockItems = hasStock ? incoming.stockItems : null;
      next.stockItemsVersion = hasStock ? textOrNull(incoming.updatedDate) : null;
      // v0.7.9: mã đơn (DHC) của CHÍNH response mang danh sách dòng — định danh gửi /orders/notify. Response thiếu mã → null.
      next.stockItemsCode = hasStock ? textOrNull(incoming.orderCode) : null;
    }
    next.source = "api";
    next.observedAt = nowIso;
    return next;
  }

  // Bỏ các trường chỉ là dấu thời gian quan sát, để so sánh "nội dung có đổi không".
  function stripVolatile(o) {
    if (!o) return o;
    const c = Object.assign({}, o);
    delete c.firstSeenAt;
    delete c.lastSeenAt;
    delete c.observedAt;
    delete c.staleResponses;
    delete c.notFoundCount;
    return c;
  }

  function isChanged(a, b) {
    return JSON.stringify(a) !== JSON.stringify(b);
  }

  // ---- Thông tin sản phẩm của một mã QR (POS gọi POST /v2/product với body {qr_code}) ----
  // Mã QR chỉ nằm trong REQUEST body; response không chứa nó, nên phải ghép hai phía.
  // Chỉ giữ các trường mô tả chính mã QR đó (SKU, đơn vị, lô, hạn dùng...), không lưu giá,
  // tồn kho tức thời hay cấu hình bán — những thứ đổi theo thời gian và không phải danh tính mã.
  function numberOrNull(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // Chỉ nhận dữ liệu nhỏ, dạng thuần (object/array) để không nuốt cả cây JSON lạ vào storage.
  function smallPlainOrNull(v, maxChars = 2000) {
    if (v === null || v === undefined) return null;
    if (typeof v !== "object") return null;
    try {
      const s = JSON.stringify(v);
      return s && s.length <= maxChars ? JSON.parse(s) : null;
    } catch (_) {
      return null;
    }
  }

  function parseMaybeJson(v) {
    if (!v) return null;
    if (typeof v === "object") return v;
    if (typeof v !== "string") return null;
    try {
      return JSON.parse(v);
    } catch (_) {
      return null;
    }
  }

  // Lấy qr_code từ request body của POS. Trả null nếu đây là lời gọi /v2/product khác
  // (ví dụ tra tồn kho theo product_ids của extension SalesUp) — không phải tra theo mã QR.
  function qrCodeFromRequestBody(body) {
    const json = parseMaybeJson(body);
    if (!json || typeof json !== "object") return null;
    const raw = json.qr_code;
    if (typeof raw !== "string" || !raw.trim()) return null;
    return extractQrCode(raw);
  }

  function emptyQrInfo(qrCode, productCount, found) {
    return {
      qrCode,
      productCount,
      found,
      qrSkuCode: null,
      qrSellerCode: null,
      qrUnitId: null,
      qrUnit: null,
      qrType: null,
      qrLotId: null,
      qrLotDate: null,
      qrLocationId: null,
      qrLocationDetailId: null,
      qrConvertRate: null,
      qrDocCode: null,
      isCircaProduct: null,
      totalNetSkuReserved: null,
      reservationBySkuCode: null,
      saleLimits: null,
      productId: null,
      productName: null,
      productCode: null,
      unitName: null,
      unitConvertRate: null,
      expiredDate: null,
    };
  }

  // ---- 0.3: dòng hàng POS vừa thêm/sửa theo mã QR ----
  // ĐÚNG MỘT endpoint, khoá chặt theo host + method + đường dẫn (re-audit 0.3.0: matcher cũ nhận cả
  // "/v9/not-the-pos-order/item" và "/v1/order/pos/item"):
  //     POST https://api.v2.circa.vn/v1/order/pos/<orderId>/item
  // Mã QR chỉ nằm trong REQUEST, dòng hàng vừa đổi chỉ có trong RESPONSE (`modified_items`) → ghép hai phía
  // bằng chính lời gọi đó: `requestId` sinh LÚC BẮT ĐẦU request (xem page-hook.js), không phải lúc response về.
  const ORDER_ITEM_HOST = "api.v2.circa.vn";
  const ORDER_ITEM_PATH_RE = /^\/v1\/order\/pos\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/item$/i;

  // Trả { orderId } khi lời gọi ĐÚNG là endpoint thêm dòng hàng; null cho mọi thứ khác.
  function orderItemRequest(url, method, base) {
    if (String(method || "").toUpperCase() !== "POST") return null;
    let u = null;
    try {
      u = base ? new URL(String(url), String(base)) : new URL(String(url));
    } catch (_) {
      return null;
    }
    if (u.protocol !== "https:" || u.hostname !== ORDER_ITEM_HOST) return null;
    const m = ORDER_ITEM_PATH_RE.exec(u.pathname);
    return m ? { orderId: m[1].toLowerCase() } : null;
  }

  // Bước 1 — lúc REQUEST bắt đầu: đơn (trên đường dẫn) + mã QR (trong body). Không có mã QR nghĩa là POS thêm
  // hàng bằng cách khác (tìm theo tên) → không phải việc của extension.
  function orderItemStart(url, method, requestBody, base) {
    const req = orderItemRequest(url, method, base);
    if (!req) return null;
    const qrCode = qrCodeFromRequestBody(requestBody);
    return qrCode ? { orderId: req.orderId, qrCode } : null;
  }

  // Bước 2 — lúc RESPONSE về: dòng hàng của CHÍNH lời gọi đó. `start` là kết quả bước 1 của đúng lời gọi này.
  // Không bao giờ lấy `modified_items[0]`; khớp 0 hoặc nhiều dòng thì bỏ qua (mơ hồ, không đoán).
  function orderItemInfoFor(start, responseJson) {
    if (!start || !isUuid(start.orderId) || !start.qrCode) return null;
    const data = responseJson && typeof responseJson.data === "object" && responseJson.data ? responseJson.data : null;
    if (!data || !isUuid(data.id) || data.id.toLowerCase() !== start.orderId) return null;
    const modified = Array.isArray(data.modified_items) ? data.modified_items : null;
    if (!modified) return null;
    const hits = modified.filter((it) => it && typeof it === "object" && extractQrCode(it.qr_code) === start.qrCode);
    if (hits.length !== 1) return null;
    const it = hits[0];
    // v0.7.12.1: modified_items không kèm qr_codes → số phần tử nhật ký lấy từ dòng CÙNG id trong data.items[] của chính response (chỉ trên máy).
    const id = stringOrNull(it.id);
    const lines = Array.isArray(data.items) && id ? data.items.filter((x) => x && typeof x.id === "string" && x.id.toLowerCase() === id.toLowerCase()) : [];
    return {
      orderId: start.orderId,
      qrCode: start.qrCode,
      orderType: stringOrNull(data.type), // loại đơn của CHÍNH lượt này (OFFLINE/…), theo response POST /item
      modifiedItemId: id,
      modifiedQuantity: numberOrNull(it.quantity),
      modifiedUnit: stringOrNull(it.unit),
      modifiedUnitPrice: numberOrNull(it.unit_price),
      modifiedTotalAmount: numberOrNull(it.total_amount),
      modifiedQrCount: lines.length === 1 ? qrLogCount(lines[0]) : null,
    };
  }

  // Tiện cho test và cho nơi có sẵn cả request lẫn response.
  function extractOrderItemInfo(url, method, requestBody, responseJson, base) {
    return orderItemInfoFor(orderItemStart(url, method, requestBody, base), responseJson);
  }

  // Màn chuyển hàng tra mã QR bằng GET /v1/pos/<posId>/qr/<mã>?query=… — mã nằm trên đường dẫn.
  const TRANSFER_QR_PATH_RE = /^\/v1\/pos\/[0-9a-f-]{36}\/qr\/([^/?#]+)\/?$/i;

  function qrCodeFromTransferQrPath(pathname) {
    const m = String(pathname || "").match(TRANSFER_QR_PATH_RE);
    if (!m) return null;
    let raw = m[1];
    try {
      raw = decodeURIComponent(raw);
    } catch (_) {
      /* giữ nguyên */
    }
    return extractQrCode(raw) || null;
  }

  // Chỉ giữ trường mô tả chính mã QR: SKU, đơn vị, lô, HSD; vị trí/chứng từ nhập chỉ lấy khi lô có đúng
  // một vị trí (không đoán). Không lưu giá, tồn kho, ảnh.
  function extractTransferQrInfo(pathname, json) {
    const qrCode = qrCodeFromTransferQrPath(pathname);
    if (!qrCode || !json || typeof json !== "object") return null;
    const d = json.data && typeof json.data === "object" ? json.data : null;
    const found = !!(d && (d.product_id || d.sku));
    const info = emptyQrInfo(qrCode, found ? 1 : 0, found);
    if (!found) return info;
    info.productId = numberOrNull(d.product_id);
    info.productName = stringOrNull(d.product_name);
    info.qrSkuCode = stringOrNull(d.sku);
    info.qrSellerCode = stringOrNull(d.seller_code);
    const lot = d.lot_detail && typeof d.lot_detail === "object" ? d.lot_detail : {};
    info.qrLotId = stringOrNull(lot.id);
    info.qrLotDate = stringOrNull(lot.lot_date);
    info.expiredDate = stringOrNull(lot.expired_date);
    const unit = d.retail_unit_detail && typeof d.retail_unit_detail === "object" ? d.retail_unit_detail : {};
    info.qrUnitId = stringOrNull(unit.id);
    info.unitName = stringOrNull(unit.unit);
    info.unitConvertRate = numberOrNull(unit.convert_rate);
    const locations = Array.isArray(lot.simplify_location_details) ? lot.simplify_location_details : [];
    if (locations.length === 1 && locations[0] && typeof locations[0] === "object") {
      info.qrLocationId = stringOrNull(locations[0].location_id);
      info.qrLocationDetailId = stringOrNull(locations[0].id);
      info.qrDocCode = typeof locations[0].doc_code === "string" ? locations[0].doc_code : null;
    }
    return info;
  }

  function extractQrProductInfo(requestBody, responseJson) {
    const qrCode = qrCodeFromRequestBody(requestBody);
    if (!qrCode) return null;
    const products = responseJson && responseJson.data && Array.isArray(responseJson.data.products) ? responseJson.data.products : null;
    if (!products) return null;
    const entry = products.find((p) => p && typeof p === "object" && (typeof p.qr_sku_code === "string" || p.product)) || null;
    const info = {
      qrCode,
      productCount: products.length,
      found: !!entry,
      qrSkuCode: null,
      qrSellerCode: null,
      qrUnitId: null,
      qrUnit: null,
      qrType: null,
      qrLotId: null,
      qrLotDate: null,
      qrLocationId: null,
      qrLocationDetailId: null,
      qrConvertRate: null,
      qrDocCode: null,
      isCircaProduct: null,
      totalNetSkuReserved: null,
      reservationBySkuCode: null,
      saleLimits: null,
      productId: null,
      productName: null,
      productCode: null,
      unitName: null,
      unitConvertRate: null,
      expiredDate: null,
      // 0.2.1: lô trong stock_details được khớp bằng gì — "lot_id" (qr_lot_id) hoặc "lot_date" (qr_lot_id rỗng,
      // khớp qr_lot_date). null: không khớp được lô nào chắc chắn (SKU/HSD lấy từ stock thì để trống).
      stockMatchedBy: null,
    };
    if (!entry) return info;

    info.qrSkuCode = stringOrNull(entry.qr_sku_code);
    info.qrSellerCode = stringOrNull(entry.qr_seller_code);
    info.qrUnitId = stringOrNull(entry.qr_unit_id);
    info.qrUnit = typeof entry.qr_unit === "string" ? entry.qr_unit : null;
    info.qrType = stringOrNull(entry.qr_type);
    info.qrLotId = stringOrNull(entry.qr_lot_id);
    info.qrLotDate = stringOrNull(entry.qr_lot_date);
    info.qrLocationId = stringOrNull(entry.qr_location_id);
    info.qrLocationDetailId = stringOrNull(entry.qr_location_detail_id);
    info.qrConvertRate = numberOrNull(entry.qr_convert_rate);
    info.qrDocCode = typeof entry.qr_doc_code === "string" ? entry.qr_doc_code : null;
    info.isCircaProduct = typeof entry.is_circa_product === "boolean" ? entry.is_circa_product : null;
    info.totalNetSkuReserved = numberOrNull(entry.total_net_sku_reserved);
    info.reservationBySkuCode = smallPlainOrNull(entry.reservation_by_sku_code);
    info.saleLimits = smallPlainOrNull(entry.sale_limits);

    const product = entry.product && typeof entry.product === "object" ? entry.product : null;
    if (product) {
      info.productId = numberOrNull(product.product_id);
      info.productName = stringOrNull(product.product_name);
      info.productCode = stringOrNull(product.product_code);
      const units = Array.isArray(product.retail_units) ? product.retail_units : [];
      const unit = units.find((u) => u && u.unit_id === info.qrUnitId) || null;
      if (unit) {
        info.unitName = stringOrNull(unit.unit_name);
        info.unitConvertRate = numberOrNull(unit.convert_rate);
      }
    }
    // SKU / hạn dùng của đúng lô trên mã QR. Ưu tiên qr_lot_id. Có response (audit 19/09/2026, sản phẩm
    // CIRCA.NUL-PHO-003) để qr_sku_code và qr_lot_id RỖNG, còn SKU/lô/HSD thật nằm ở stock_details: khi qr_lot_id
    // rỗng thì khớp theo qr_lot_date. Chỉ nhận khi mọi stock khớp cho ra MỘT cặp (sku_code, expired_date) —
    // cùng lô ở nhiều vị trí vẫn là một cặp; hai cặp khác nhau là mơ hồ → để trống, không đoán.
    const stocks = Array.isArray(entry.stock_details) ? entry.stock_details.filter((st) => st && typeof st === "object") : [];
    let matched = [];
    if (info.qrLotId) {
      matched = stocks.filter((st) => st.lot_id === info.qrLotId);
      if (matched.length) info.stockMatchedBy = "lot_id";
    } else if (info.qrLotDate) {
      // Có qr_sku_code thì stock phải cùng SKU; không có thì mọi SKU của lô đó đều được xét (và phải trùng nhau).
      matched = stocks.filter((st) => st.lot_date === info.qrLotDate && (!info.qrSkuCode || st.sku_code === info.qrSkuCode));
      if (matched.length) info.stockMatchedBy = "lot_date";
    }
    const pairs = new Set(matched.map((st) => JSON.stringify([stringOrNull(st.sku_code), stringOrNull(st.expired_date)])));
    if (pairs.size === 1) {
      const [sku, expired] = JSON.parse([...pairs][0]);
      if (!info.qrSkuCode && sku) info.qrSkuCode = sku;
      info.expiredDate = expired;
    } else if (pairs.size > 1) {
      info.stockMatchedBy = null; // mơ hồ: không chọn thay người dùng
    }
    return info;
  }

  const QR_FIELDS = [
    "stockMatchedBy",
    "qrSkuCode",
    "qrSellerCode",
    "qrUnitId",
    "qrUnit",
    "qrType",
    "qrLotId",
    "qrLotDate",
    "qrLocationId",
    "qrLocationDetailId",
    "qrConvertRate",
    "qrDocCode",
    "isCircaProduct",
    "totalNetSkuReserved",
    "reservationBySkuCode",
    "saleLimits",
    "productId",
    "productName",
    "productCode",
    "unitName",
    "unitConvertRate",
    "expiredDate",
    "productCount",
    "found",
  ];

  // Gộp thông tin mã QR. Lần tra sau chỉ ghi đè bằng dữ liệu tìm thấy sản phẩm;
  // một lần tra "không thấy" không được xoá thông tin đã có của mã đó.
  function mergeQrInfo(existing, incoming, nowIso) {
    const prev = existing && typeof existing === "object" ? existing : null;
    const next = Object.assign({}, prev || {}, { qrCode: incoming.qrCode });
    next.firstSeenAt = (prev && prev.firstSeenAt) || nowIso;
    next.lastSeenAt = nowIso;
    if (prev && prev.found && !incoming.found) {
      next.notFoundCount = (prev.notFoundCount || 0) + 1;
      return next;
    }
    for (const k of QR_FIELDS) {
      if (incoming[k] !== undefined && incoming[k] !== null) next[k] = incoming[k];
    }
    if (!incoming.found) next.notFoundCount = (prev && prev.notFoundCount) || 0;
    next.observedAt = nowIso;
    return next;
  }

  function validateEvent(e) {
    if (!e || typeof e !== "object") return "not_object";
    if (!isUuid(e.eventId)) return "eventId";
    if (!isUuid(e.orderId)) return "orderId";
    // v0.7 Batch D: thao tác dòng hàng POS — không có mã quét, không có kết luận accepted/review.
    if (e.recordType === RECORD_TYPE.SALE_ORDER_ACTION) {
      if (typeof e.scannedAt !== "string" || parseTime(e.scannedAt) === null) return "scannedAt";
      return validateActionEvent(e);
    }
    if (e.recordType === RECORD_TYPE.SALE_ORDER_STATUS) {
      if (typeof e.scannedAt !== "string" || parseTime(e.scannedAt) === null) return "scannedAt";
      return validateStatusEvent(e);
    }
    const rfid = e.source === SOURCE.RFID;
    // Lượt RFID được tạo ngay khi có EPC; UID (và chuỗi QR) chỉ có sau khi Nextwaves trả lời.
    if (typeof e.qrRaw !== "string" || (!e.qrRaw && !rfid)) return "qrRaw";
    if (typeof e.scannedAt !== "string" || parseTime(e.scannedAt) === null) return "scannedAt";
    if (e.status !== VERDICT.ACCEPTED && e.status !== VERDICT.REVIEW) return "status";
    if (e.recordType !== undefined && e.recordType !== null && e.recordType !== RECORD_TYPE.SALE_ORDER && e.recordType !== RECORD_TYPE.TRANSFER_OUT) return "recordType";
    if (e.source === undefined || e.source === null) return null; // bản ghi trước 0.2.0 và chuyển hàng
    // ---- nhật ký chung (0.2.0) ----
    if (e.source !== SOURCE.QR && !rfid) return "source";
    if (recordTypeOf(e) !== RECORD_TYPE.SALE_ORDER) return "source"; // chuyển hàng không vào nhật ký chung
    if (e.action !== ACTION.SCAN && e.action !== ACTION.READD) return "action";
    if (e.seq !== undefined && !(Number.isInteger(e.seq) && e.seq >= 0)) return "seq";
    // UID / EPC / QR là CHUỖI từ đầu tới cuối — không bước nào được đi qua kiểu số.
    for (const f of ["uid", "epc", "qrCode"]) if (e[f] !== undefined && e[f] !== null && typeof e[f] !== "string") return f;
    if (rfid && !EPC_RE.test(e.epc)) return "epc";
    if (e.mappingStatus !== undefined && MAPPING_VALUES.indexOf(e.mappingStatus) < 0) return "mappingStatus";
    if (e.result !== undefined && e.result !== null && RESULT_VALUES.indexOf(e.result) < 0) return "result";
    if (e.timing !== undefined && e.timing !== null && (!rfid || !isRfidTiming(e.timing))) return "timing";
    return null;
  }

  // v0.7 Batch A — thời lượng kỹ thuật của một lượt RFID. Mỗi giá trị là số ms (nguyên, 0…1 giờ) hoặc null khi mốc
  // đó không xảy ra. Mốc 0 = lúc reader đưa EPC tới (lượt quét) hoặc lúc người dùng bấm (Thử lại / Cho phép thêm lại).
  //   markMs      kiểm dấu chống trùng xong            createdMs   lượt được tạo (= scannedAt; null khi Thử lại)
  //   nextwavesMs worker nhận xong response Nextwaves  savedMs     PREPARE_RFID_SEND trả ACK (lượt + dấu đã ghi)
  //   keysMs      phím đầu tiên phát vào trang POS     lookupMs    POS nhận xong response /v2/product
  //   cartMs      extension thấy giỏ đổi (dò 150 ms)   doneMs      lượt kết thúc
  // Hai thời lượng riêng (không tính từ mốc 0): nextwavesFetchMs = lời gọi Nextwaves trong worker, prepareMs =
  // PREPARE_RFID_SEND tính từ lúc gửi tới lúc có ACK. Không lưu mốc giờ tuyệt đối nào khác ngoài scannedAt sẵn có.
  const RFID_TIMING_KEYS = Object.freeze([
    "markMs",
    "createdMs",
    "nextwavesMs",
    "nextwavesFetchMs",
    "savedMs",
    "prepareMs",
    "keysMs",
    "lookupMs",
    "cartMs",
    "doneMs",
  ]);
  const RFID_TIMING_MAX_MS = 3600000;
  function isRfidTiming(t) {
    if (!t || typeof t !== "object" || Array.isArray(t)) return false;
    for (const k of Object.keys(t)) {
      if (RFID_TIMING_KEYS.indexOf(k) < 0) return false;
      const v = t[k];
      if (v !== null && !(Number.isInteger(v) && v >= 0 && v <= RFID_TIMING_MAX_MS)) return false;
    }
    return true;
  }

  // ======================= Nhật ký lượt quét/đọc chung QR + RFID (0.2.0) =======================
  // Một bản ghi ev:<eventId> cho mỗi LƯỢT (không phải mỗi sản phẩm trong giỏ). Chỉ bản ghi bán hàng
  // có `source` mới thuộc nhật ký chung và mới được đồng bộ lên Sheet; bản ghi trước 0.2.0 và bản
  // ghi chuyển hàng giữ nguyên hình dạng cũ.
  //
  // Ai được ghi trường nào — tách rõ để không bên nào xoá dữ liệu của bên kia:
  //   content QR   : tạo lượt (bất biến sau đó).
  //   content RFID : tạo lượt, rồi cập nhật CONTENT_UPDATE_FIELDS theo seq tăng dần.
  //   worker       : kết quả tra UID → EPC (LOOKUP_FIELDS), snapshot đơn (ORDER_SNAPSHOT_FIELDS),
  //                  revision / updatedAt / syncedRevision.
  // `revision` chỉ tăng khi một cột của dòng Sheet thật sự đổi.
  // v0.7 Batch D: "pos" = thao tác dòng hàng do POS thực hiện (bản ghi sale_order_action), không phải lượt quét / đọc.
  const SOURCE = Object.freeze({ QR: "qr", RFID: "rfid", POS: "pos" });
  const ACTION = Object.freeze({ SCAN: "scan", READD: "readd" });
  // 0.3: MAPPED_MULTIPLE = mã QR cha sinh nhiều tem con đã map. Trạng thái CUỐI: không tự chọn tem nào,
  // không thử lại; người vận hành đọc resolvedChildren để xử lý.
  const MAPPING = Object.freeze({ PENDING: "pending", MAPPED: "mapped", UNMAPPED: "unmapped", ERROR: "error", MAPPED_MULTIPLE: "mapped_multiple" });
  const MAPPING_VALUES = Object.freeze([MAPPING.PENDING, MAPPING.MAPPED, MAPPING.UNMAPPED, MAPPING.ERROR, MAPPING.MAPPED_MULTIPLE]);
  const RESULT = Object.freeze({ NOT_SENT: "not_sent", ADDED: "added", UNCONFIRMED: "unconfirmed", REJECTED: "rejected" });
  const RESULT_VALUES = Object.freeze([RESULT.NOT_SENT, RESULT.ADDED, RESULT.UNCONFIRMED, RESULT.REJECTED]);
  const EPC_RE = /^(?:[0-9A-F]{2})+$/;
  // Mã UID Nextwaves quan sát được: 1789791653507C6, 1789791392728LL1, 17589432884030116, 1778832278088L2289.
  const UID_RE = /^[0-9A-Za-z]{8,64}$/;

  // Đúng thứ tự header tab `data`; apps-script/sheet-upsert.js HEADERS phải bằng hệt (tests/build.test.js).
  const SHEET_HEADERS = Object.freeze([
    "eventId",
    "revision",
    "scannedAt",
    "orderId",
    "orderCode",
    "source",
    "action",
    "qrRaw",
    "uid",
    "epc",
    "mappingStatus",
    "scanStatus",
    "result",
    "orderStatus",
    "completedAt",
    "updatedAt",
    "quantity", // 0.2.2 — Apps Script nâng Sheet 16 cột cũ bằng cách thêm đúng header này
    // 0.3 — 10 cột cuối. Apps Script nâng được từ cả Sheet 16 cột lẫn 17 cột; thứ tự này là hợp đồng.
    "resolvedUid", // UID tem con duy nhất đã map của mã QR cha (chỉ khi đúng một tem)
    "generationId",
    "mappedChildCount",
    "resolvedChildren", // JSON rút gọn danh sách tem con, có thể bị cắt (truncated) khi quá dài
    "orderType", // loại đơn theo response POST /item của chính lượt này
    "modifiedItemId",
    "modifiedQuantity", // số lượng dòng hàng NGAY SAU lượt quét này (khác cột quantity: số cuối khi đơn hoàn tất)
    "modifiedUnit",
    "modifiedUnitPrice", // Sheet 0.3 CÓ chứa giá bán — xem docs/UPGRADE-0.3.0.md trước khi chia sẻ Sheet
    "modifiedTotalAmount",
    // 0.4 — 6 cột cuối: snapshot sản phẩm của CHÍNH lượt + trạm POS. Apps Script nâng được từ 16 / 17 / 27 cột.
    "sku",
    "productName",
    "productCode",
    "productId", // chuỗi, không để Sheet tự đổi sang số
    "posStationId",
    "stationSequence", // số thứ tự tăng riêng trên từng trạm — lộ ra khoảng trống nếu mất dòng
    // 0.5: loại chứng từ của dòng. `recordType` cho biết dòng là lượt bán hay lượt chuyển hàng;
    // `transferType` là chiều thật của phiếu (TRANSFER_OUT / TRANSFER_IN…), trống với dòng bán hàng.
    "recordType",
    "transferType",
  ]);

  // v0.7 Batch A: `timing` = thời lượng kỹ thuật của lượt RFID (ms), content ghi, KHÔNG phải cột Sheet (không tăng revision).
  const CONTENT_UPDATE_FIELDS = Object.freeze(["qrRaw", "qrCode", "uid", "epc", "mappingStatus", "mappingError", "result", "resultReason", "timing"]);
  // Đã có giá trị thì không bản cập nhật nào được xoá — gửi thiếu trường không được làm mất UID/EPC.
  const STICKY_FIELDS = Object.freeze(["qrRaw", "qrCode", "uid", "epc"]);
  // 0.3: kết quả tra generation của mã QR cha. Chỉ worker ghi.
  const GENERATION_FIELDS = Object.freeze(["resolvedUid", "generationId", "mappedChildCount", "resolvedChildren"]);
  const LOOKUP_FIELDS = Object.freeze(
    ["epc", "mappingStatus", "mappingError", "mappingCheckedAt", "mappingAttempts", "mappingNextAt", "mappingInfraAttempts"].concat(GENERATION_FIELDS)
  );
  // 0.3: dòng hàng POS của chính lượt. modifiedRequestId là danh tính lời gọi POST /item — KHÔNG lên Sheet,
  // chỉ để một response chỉ được gắn vào đúng một lượt.
  const ITEM_SHEET_FIELDS = Object.freeze(["orderType", "modifiedItemId", "modifiedQuantity", "modifiedUnit", "modifiedUnitPrice", "modifiedTotalAmount"]);
  const ITEM_FIELDS = Object.freeze(ITEM_SHEET_FIELDS.concat(["modifiedRequestId"]));
  // v0.7.12.1: modifiedQrCount = số phần tử qr_codes của dòng sau lời gọi của lượt (orderItemInfoFor) — chỉ trên máy, không lên Sheet. Chỉ
  // ghi lúc gắn dòng (applyItemInfo); bản ghi lượt mới KHÔNG có khoá này (hình dạng bản ghi cũ giữ nguyên; thiếu = không chứng minh được).
  const ITEM_LOCAL_FIELDS = Object.freeze(["modifiedQrCount"]);
  const ITEM_INFO_FIELDS = Object.freeze(ITEM_FIELDS.concat(ITEM_LOCAL_FIELDS));
  const ORDER_SNAPSHOT_FIELDS = Object.freeze(["orderCode", "orderStatus", "completedAt", "orderUpdatedAt", "orderItemQuantity", "transferType"]);
  // 0.5: lượt chuyển hàng chỉ nhận thông tin phiếu. KHÔNG có orderItemQuantity: phiếu chuyển cũng có dòng hàng
  // kèm mã QR, nên dùng chung đường của đơn bán sẽ điền nhầm cột quantity của dòng chuyển hàng.
  const TRANSFER_SNAPSHOT_FIELDS = Object.freeze(["orderCode", "orderStatus", "completedAt", "orderUpdatedAt", "transferType"]);
  // Trường đồng bộ Sheet: chỉ worker ghi, không bao giờ tăng revision (không nằm trong sheetContent).
  // sheetStation*: cặp trạm ĐANG nằm trên dòng Sheet, do ACK trả về (0.5). Chỉ để giải thích vì sao
  // số thứ tự của máy này khuyết trên Sheet; không phải nội dung dòng nên không bao giờ tăng revision.
  const SYNC_FIELDS = Object.freeze(["syncedRevision", "syncedAt", "syncError", "syncErrorRevision", "syncErrorAt", "sheetStationId", "sheetStationSequence"]);
  // 0.4: snapshot sản phẩm của chính lượt, chép từ qr:<mã> (response POS /v2/product). Chỉ worker ghi.
  const PRODUCT_FIELDS = Object.freeze(["sku", "productName", "productCode", "productId"]);
  // 0.4: trạm + số thứ tự. Chỉ bộ cấp số của worker ghi; content gửi lên thì bị bỏ.
  const STATION_FIELDS = Object.freeze(["posStationId", "stationSequence"]);
  const WORKER_OWNED_FIELDS = Object.freeze(["revision", "updatedAt"].concat(SYNC_FIELDS, ORDER_SNAPSHOT_FIELDS, GENERATION_FIELDS, ITEM_INFO_FIELDS, PRODUCT_FIELDS, STATION_FIELDS));

  // ---- 0.4: trạm POS ----
  const POS_STATION_IDS = Object.freeze(["POS-01", "POS-02"]);
  function normalizeStationId(value) {
    const s = typeof value === "string" ? value.trim().toUpperCase() : "";
    return POS_STATION_IDS.indexOf(s) >= 0 ? s : null;
  }
  function hasStation(e) {
    return !!e && normalizeStationId(e.posStationId) !== null && Number.isInteger(e.stationSequence) && e.stationSequence >= 1;
  }
  // 0.5: khoá bộ đếm của một (trạm, loại chứng từ). Khoá 0.4 không có hậu tố và chỉ đếm lượt bán.
  // v0.7 Batch D: thao tác POS có bộ đếm riêng station:seq:<trạm>:sale_order_action — số của lượt bán / chuyển hàng không đổi.
  function stationRecordType(recordType) {
    return recordType === RECORD_TYPE.TRANSFER_OUT || recordType === RECORD_TYPE.SALE_ORDER_ACTION || recordType === RECORD_TYPE.SALE_ORDER_STATUS ? recordType : RECORD_TYPE.SALE_ORDER;
  }
  function stationSeqKey(stationId, recordType) {
    return KEYS.stationSeqPrefix + stationId + ":" + stationRecordType(recordType);
  }
  // Giá trị cờ đã chuyển bộ đếm sang khoá 0.5 (ghi cùng lần với giá trị được chép).
  const STATION_SEQ_MIGRATION = "0.5.0";
  function legacyStationSeqKey(stationId) {
    return KEYS.stationSeqPrefix + stationId;
  }

  // ---- 0.4: snapshot sản phẩm của chính lượt ----
  // Mã dùng để tìm qr:<mã>: khớp CHÍNH XÁC mã trích từ qrRaw, rồi qrCode, rồi uid (lượt RFID chỉ có sau P1).
  function productKeyOf(e) {
    if (!e || typeof e !== "object") return null;
    return textOrNull(extractQrCode(e.qrRaw)) || textOrNull(e.qrCode) || textOrNull(e.uid);
  }
  function hasProductSnapshot(e) {
    return !!e && PRODUCT_FIELDS.some((f) => !isBlankValue(e[f]));
  }
  // Snapshot từ bản ghi qr:<mã>. Chỉ khi POS đã tìm THẤY sản phẩm; response rỗng (products: []) không phải snapshot.
  // SKU lấy từ qrSkuCode — đã gồm fallback stock_details khớp chắc chắn của 0.2.1, mơ hồ thì để trống.
  function productSnapshotOf(q) {
    if (!q || typeof q !== "object" || q.found !== true) return null;
    const snap = {
      sku: textOrNull(q.qrSkuCode),
      productName: textOrNull(q.productName),
      productCode: textOrNull(q.productCode),
      productId: q.productId === null || q.productId === undefined || q.productId === "" ? null : String(q.productId),
    };
    return PRODUCT_FIELDS.some((f) => snap[f] !== null) ? snap : null;
  }
  // Bản vá sản phẩm cho một lượt, hoặc null khi không có gì để gắn. Lượt ĐÃ có snapshot thì đóng băng: response
  // sau này (đổi tên, đổi SKU, hay rỗng) không bao giờ sửa lịch sử của lượt đó.
  function productPatch(e, q) {
    if (!isLogEvent(e) || hasProductSnapshot(e)) return null;
    const key = productKeyOf(e);
    if (!key || !q || q.qrCode !== key) return null;
    return productSnapshotOf(q);
  }

  // ---- 0.4: bộ cấp số thứ tự tại trạm ----
  // Lượt cần cấp số, theo đúng thứ tự cấp: scannedAt tăng dần, rồi eventId. Chỉ lượt bán hàng của nhật ký chung.
  // 0.5: mỗi loại chứng từ một hàng chờ và một bộ đếm riêng, nên số thứ tự của từng loại vẫn tăng
  // theo thời gian quét. recordType bắt buộc phải truyền vào: không có "hàng chờ chung".
  function stationQueue(events, recordType) {
    const want = stationRecordType(recordType);
    return (events || [])
      .filter((e) => isSheetEvent(e) && recordTypeOf(e) === want && isUuid(e.eventId) && !hasStation(e))
      .sort((a, b) => String(a.scannedAt || "").localeCompare(String(b.scannedAt || "")) || String(a.eventId).localeCompare(String(b.eventId)));
  }
  // Một bản vá DUY NHẤT cho lượt: trạm + số + (nếu có) snapshot sản phẩm — một lần tăng revision.
  function stationPatch(e, q, stationId, sequence) {
    const st = normalizeStationId(stationId);
    if (!isSheetEvent(e) || hasStation(e) || !st || !Number.isInteger(sequence) || sequence < 1) return null;
    const patch = Object.assign({}, productPatch(e, q) || {}, { posStationId: st, stationSequence: sequence });
    // 0.5: lượt chuyển hàng của bản cũ chưa có uid — điền mã đã trích trong CÙNG lần cấp số (một lần tăng revision).
    if (isTransferEvent(e) && isBlankValue(e.uid)) {
      const code = textOrNull(extractQrCode(e.qrRaw)) || textOrNull(e.qrCode);
      if (code) patch.uid = code;
    }
    return patch;
  }

  const isBlankValue = (v) => v === null || v === undefined || v === "";
  const textOrNull = (v) => (typeof v === "string" && v ? v : null);
  const cell = (v) => (v === null || v === undefined ? "" : String(v));

  function isLogEvent(e) {
    return !!e && typeof e === "object" && (e.source === SOURCE.QR || e.source === SOURCE.RFID) && recordTypeOf(e) === RECORD_TYPE.SALE_ORDER;
  }

  // 0.5: lượt chuyển hàng. Nhận diện bằng recordType GHI RÕ, không qua recordTypeOf — bản ghi bán hàng
  // trước 0.2.0 (không có source, không có recordType) không bao giờ được coi là chuyển hàng.
  function isTransferEvent(e) {
    return !!e && typeof e === "object" && e.recordType === RECORD_TYPE.TRANSFER_OUT;
  }
  // Lượt được phép lên tab `data`: lượt bán của nhật ký chung (0.2.0), lượt chuyển hàng (0.5) hoặc thao tác POS (v0.7 D).
  function isSheetEvent(e) {
    return isLogEvent(e) || isTransferEvent(e) || isActionEvent(e) || isStatusEvent(e);
  }

  function looksLikeUid(uid) {
    return typeof uid === "string" && UID_RE.test(uid);
  }

  // Phần của bản ghi đơn (ord:) mà mỗi lượt mang theo. Lấy từ bản đơn ĐÃ gộp — bản đó đã chặn
  // response cũ bằng updated_date của POS — nên snapshot không bao giờ lùi về trạng thái cũ.
  function orderSnapshot(ord) {
    const o = ord || {};
    return {
      orderCode: textOrNull(o.orderCode),
      orderStatus: textOrNull(o.status),
      completedAt: textOrNull(o.completedDate),
      orderUpdatedAt: textOrNull(o.updatedDate),
      // 0.5: chiều của phiếu chuyển hàng. Đơn bán không có trường này → null → ô Sheet trống.
      transferType: textOrNull(o.transferType),
    };
  }

  // 0.2.2 — số lượng của dòng hàng POS chứa đúng UID của lượt. Chỉ khi đơn (bản đã gộp, đã chặn response cũ)
  // đang COMPLETED. Mỗi dòng hàng: gom qr_code + qr_codes, bỏ mã trùng, rồi so khớp CHÍNH XÁC với UID.
  // Đúng một dòng khớp → quantity của dòng đó. Không khớp, khớp nhiều dòng, lượt chưa có UID → null.
  // KHÔNG bao giờ suy từ số lần UID xuất hiện trong qr_codes: POS lặp mã (response thật: quantity 1, UID lặp).
  // 0.6: phần tìm dòng hàng chuyển sang orderItemFor (dùng chung với bộ trừ tồn). Ở đây CHỈ truyền uid
  // nên đường khớp vẫn đúng y như cũ — bộ trừ tồn mới là nơi ưu tiên modifiedItemId.
  const ORDER_COMPLETED = "COMPLETED";
  function orderItemQuantityFor(ord, uid) {
    if (typeof uid !== "string" || !uid) return null;
    const { item } = orderItemFor(ord, { uid });
    const q = item ? item.quantity : null;
    return typeof q === "number" && Number.isFinite(q) ? q : null;
  }

  // Phần đơn mà MỘT lượt mang theo: snapshot chung của đơn + quantity theo UID của chính lượt đó.
  function eventOrderSnapshot(ord, uid) {
    return Object.assign(orderSnapshot(ord), { orderItemQuantity: orderItemQuantityFor(ord, uid) });
  }

  // Các cột của dòng Sheet, trừ revision/updatedAt. So sánh cái này quyết định có tăng revision không.
  function sheetContent(e) {
    return {
      eventId: cell(e.eventId),
      scannedAt: cell(e.scannedAt),
      orderId: cell(e.orderId),
      orderCode: cell(e.orderCode),
      source: cell(e.source),
      action: cell(e.action),
      qrRaw: cell(e.qrRaw),
      uid: cell(e.uid),
      epc: cell(e.epc),
      mappingStatus: cell(e.mappingStatus),
      scanStatus: cell(e.status),
      result: cell(e.result),
      orderStatus: cell(e.orderStatus),
      completedAt: cell(e.completedAt),
      quantity: cell(e.orderItemQuantity), // số → chuỗi RAW ("1"), không làm tròn
      resolvedUid: cell(e.resolvedUid),
      generationId: cell(e.generationId),
      mappedChildCount: cell(e.mappedChildCount),
      resolvedChildren: cell(e.resolvedChildren),
      orderType: cell(e.orderType),
      modifiedItemId: cell(e.modifiedItemId),
      modifiedQuantity: cell(e.modifiedQuantity),
      modifiedUnit: cell(e.modifiedUnit),
      modifiedUnitPrice: cell(e.modifiedUnitPrice),
      modifiedTotalAmount: cell(e.modifiedTotalAmount),
      sku: cell(e.sku),
      productName: cell(e.productName),
      productCode: cell(e.productCode),
      productId: cell(e.productId),
      posStationId: cell(e.posStationId),
      stationSequence: cell(e.stationSequence),
      // Bản ghi bán hàng trước 0.1.8 không có recordType — recordTypeOf trả "sale_order" cho chúng.
      recordType: cell(recordTypeOf(e)),
      transferType: cell(e.transferType),
    };
  }

  // Dòng Sheet ĐẦY ĐỦ của bản ghi hiện tại — không bao giờ là bản vá.
  function sheetRow(e) {
    const c = sheetContent(e);
    const row = {};
    for (const h of SHEET_HEADERS) row[h] = h === "revision" ? e.revision : h === "updatedAt" ? cell(e.updatedAt) : c[h];
    return row;
  }

  // Lượt mới vào kho. Trường worker sở hữu luôn do worker đặt, bất kể content gửi gì.
  function newEventRecord(event, ord, nowIso) {
    const rec = Object.assign({}, event);
    for (const f of WORKER_OWNED_FIELDS) delete rec[f];
    rec.seq = Number.isInteger(event.seq) && event.seq >= 0 ? event.seq : 0;
    if (event.source === SOURCE.QR) {
      // Lượt QR: UID là mã trích từ QR; EPC do worker tra sau, không chặn lượt quét.
      rec.uid = typeof event.uid === "string" && event.uid ? event.uid : textOrNull(event.qrCode);
      rec.epc = null;
      rec.mappingStatus = MAPPING.PENDING;
      rec.mappingError = null;
      rec.mappingCheckedAt = null;
      rec.mappingAttempts = 0;
      rec.mappingNextAt = null;
      rec.mappingInfraAttempts = 0;
      rec.result = null;
      rec.resultReason = null;
    } else {
      rec.uid = textOrNull(event.uid);
      rec.mappingStatus = MAPPING_VALUES.indexOf(event.mappingStatus) >= 0 ? event.mappingStatus : MAPPING.PENDING;
      rec.mappingError = textOrNull(event.mappingError);
      rec.result = RESULT_VALUES.indexOf(event.result) >= 0 ? event.result : RESULT.NOT_SENT;
      rec.resultReason = textOrNull(event.resultReason);
    }
    for (const f of GENERATION_FIELDS) rec[f] = null;
    for (const f of ITEM_FIELDS) rec[f] = null;
    for (const f of PRODUCT_FIELDS) rec[f] = null;
    for (const f of STATION_FIELDS) rec[f] = null;
    Object.assign(rec, eventOrderSnapshot(ord, rec.uid));
    rec.revision = 1;
    rec.updatedAt = nowIso;
    rec.syncedRevision = 0;
    rec.syncedAt = null;
    return rec;
  }

  function finishUpdate(existing, next, nowIso) {
    const bumped = isChanged(sheetContent(existing), sheetContent(next));
    if (bumped) {
      next.revision = (Number(existing.revision) || 0) + 1;
      next.updatedAt = nowIso;
    }
    const changed = bumped || isChanged(existing, next);
    return { record: changed ? next : existing, changed, bumped };
  }

  // Cập nhật từ content RFID. seq phải lớn hơn seq đã lưu: bản tới muộn / gửi lại là no-op, nên hai
  // hàng chờ song song hay một lần gửi lại không bao giờ kéo lượt về trạng thái cũ.
  // ord (0.2.2, tuỳ chọn): bản đơn hiện tại — UID của lượt RFID thường chỉ có từ bước P1, nên quantity được tính lại
  // theo UID mới trong CÙNG lần cập nhật (một lần tăng revision).
  function mergeContentUpdate(existing, incoming, nowIso, ord) {
    if (!existing || !incoming) return { record: existing, changed: false, bumped: false, error: "missing" };
    if (existing.source !== incoming.source || existing.orderId !== incoming.orderId || existing.source !== SOURCE.RFID) {
      return { record: existing, changed: false, bumped: false, error: "mismatch" };
    }
    const seq = Number.isInteger(incoming.seq) ? incoming.seq : 0;
    if (seq <= (Number(existing.seq) || 0)) return { record: existing, changed: false, bumped: false, stale: true };
    const next = Object.assign({}, existing);
    for (const f of CONTENT_UPDATE_FIELDS) {
      if (!(f in incoming)) continue;
      if (STICKY_FIELDS.indexOf(f) >= 0 && isBlankValue(incoming[f]) && !isBlankValue(existing[f])) continue;
      next[f] = incoming[f];
    }
    next.seq = seq;
    if (ord !== undefined) next.orderItemQuantity = orderItemQuantityFor(ord, next.uid);
    return finishUpdate(existing, next, nowIso);
  }

  // Cập nhật do worker tự làm (kết quả tra EPC, snapshot đơn): chỉ các trường được liệt kê.
  function mergeWorkerUpdate(existing, patch, fields, nowIso) {
    if (!existing) return { record: existing, changed: false, bumped: false };
    const next = Object.assign({}, existing);
    for (const f of fields) {
      if (!(f in patch)) continue;
      if (STICKY_FIELDS.indexOf(f) >= 0 && isBlankValue(patch[f]) && !isBlankValue(existing[f])) continue;
      next[f] = patch[f];
    }
    return finishUpdate(existing, next, nowIso);
  }

  // ---- Tra UID → EPC cho lượt QR (worker) ----
  // Lỗi mạng / HTTP / response sai: thử lại, giãn dần, tối đa LOOKUP_MAX_ATTEMPTS lần. Lỗi xác thực
  // (chưa có token, 401/403) KHÔNG tính vào số lần: sửa token xong là tra được.
  const LOOKUP_MAX_ATTEMPTS = 8;
  const LOOKUP_AUTH_RETRY_MS = 5 * 60 * 1000;

  function lookupBackoffMs(attempts) {
    return Math.min(60 * 1000 * Math.pow(2, Math.max(0, attempts - 1)), 60 * 60 * 1000);
  }

  function lookupWanted(e, nowMs, opts) {
    if (!isLogEvent(e) || e.source !== SOURCE.QR) return false;
    if (e.mappingStatus !== MAPPING.PENDING && e.mappingStatus !== MAPPING.ERROR) return false;
    if ((Number(e.mappingAttempts) || 0) >= LOOKUP_MAX_ATTEMPTS) return false;
    if (opts && opts.ignoreBackoff) return true;
    if (opts && opts.authRetry && e.mappingError === "auth") return true;
    const next = e.mappingNextAt ? parseTime(e.mappingNextAt) : null;
    return next === null || next <= nowMs;
  }

  // 0.3 — ba loại lỗi, hậu quả khác hẳn nhau (auditor chốt 20/09/2026):
  //   auth     : chưa có token / 401 / 403 — KHÔNG tiêu lượt thử, chờ đổi token hoặc bấm tra lại.
  //   infra    : mạng, timeout, 5xx, route chưa deploy — KHÔNG tiêu lượt thử nghiệp vụ, giãn 5 phút → 30 phút
  //              → 2 giờ → tối đa 6 giờ. Hạ tầng hỏng không được làm một lượt "hết lượt thử" rồi im lặng.
  //   contract : response sai hợp đồng — DỪNG tra tự động, chờ người kiểm tra (nới parser cho xanh là điều cấm).
  const INFRA_BACKOFF_MS = Object.freeze([5 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000, 6 * 60 * 60 * 1000]);
  function infraBackoffMs(n) {
    const i = Math.min(Math.max(1, Number(n) || 1), INFRA_BACKOFF_MS.length) - 1;
    return INFRA_BACKOFF_MS[i];
  }

  // Phần generation của một kết quả tra (rỗng khi không gọi tới bước này).
  function generationPart(outcome) {
    const g = (outcome && outcome.generation) || null;
    return {
      generationId: g ? textOrNull(g.generationId) : null,
      mappedChildCount: g && Number.isInteger(g.mappedChildCount) ? g.mappedChildCount : null,
      resolvedChildren: g ? textOrNull(g.resolvedChildren) : null,
    };
  }

  // outcome: { kind: "mapped", epc, resolvedUid?, generation? } | { kind: "mapped_multiple", generation }
  //        | { kind: "unmapped", generation? } | { kind: "invalid", error }
  //        | { kind: "contract", error } | { kind: "error", error, auth?, infra? }
  function lookupPatch(e, outcome, nowIso, nowMs) {
    const attempts = Number(e && e.mappingAttempts) || 0;
    const kind = outcome && outcome.kind;
    if (kind === "mapped") {
      return Object.assign(
        { epc: outcome.epc, mappingStatus: MAPPING.MAPPED, mappingError: null, mappingCheckedAt: nowIso, mappingAttempts: attempts + 1, mappingNextAt: null, resolvedUid: textOrNull(outcome.resolvedUid) },
        generationPart(outcome)
      );
    }
    if (kind === "mapped_multiple") {
      // Nhiều tem con đã map: KHÔNG chọn tem nào, không thử lại. Lưu đủ danh sách để người xử lý.
      return Object.assign(
        { epc: null, mappingStatus: MAPPING.MAPPED_MULTIPLE, mappingError: null, mappingCheckedAt: nowIso, mappingAttempts: attempts + 1, mappingNextAt: null, resolvedUid: null },
        generationPart(outcome)
      );
    }
    if (kind === "unmapped") {
      return Object.assign(
        { epc: null, mappingStatus: MAPPING.UNMAPPED, mappingError: null, mappingCheckedAt: nowIso, mappingAttempts: attempts + 1, mappingNextAt: null, resolvedUid: null },
        generationPart(outcome)
      );
    }
    if (kind === "contract") {
      return {
        mappingStatus: MAPPING.ERROR,
        mappingError: "contract:" + String((outcome && outcome.error) || "unknown"),
        mappingCheckedAt: nowIso,
        mappingAttempts: LOOKUP_MAX_ATTEMPTS, // dừng tra tự động; chỉ "tra lại" thủ công mới chạy tiếp
        mappingNextAt: null,
      };
    }
    if (kind === "invalid") {
      // Không phải UID (chuỗi rác của lượt cần kiểm tra): không gọi API, không thử lại.
      return { mappingStatus: MAPPING.ERROR, mappingError: String(outcome.error || "uid_invalid"), mappingCheckedAt: nowIso, mappingAttempts: LOOKUP_MAX_ATTEMPTS, mappingNextAt: null };
    }
    const auth = !!(outcome && outcome.auth);
    const infra = !auth && !!(outcome && outcome.infra);
    const infraAttempts = (Number(e && e.mappingInfraAttempts) || 0) + (infra ? 1 : 0);
    const n = auth || infra ? attempts : attempts + 1;
    const wait = auth ? LOOKUP_AUTH_RETRY_MS : infra ? infraBackoffMs(infraAttempts) : lookupBackoffMs(n);
    const patch = {
      mappingStatus: MAPPING.ERROR,
      mappingError: auth ? "auth" : String((outcome && outcome.error) || "error"),
      mappingCheckedAt: nowIso,
      mappingAttempts: n,
      mappingNextAt: new Date(nowMs + wait).toISOString(),
    };
    if (infra) patch.mappingInfraAttempts = infraAttempts;
    return patch;
  }

  // ---- 0.3: gắn dòng hàng POS vào đúng lượt (worker) ----
  // Một response POST /item chỉ được gắn vào ĐÚNG MỘT lượt. `requestId` do page-hook sinh cho từng lời gọi là
  // danh tính của lời gọi đó, nên: lượt đã nhận lời gọi khác thì không bị ghi đè; cùng requestId gửi lại là
  // no-op (kết quả y hệt); lượt khác đã nhận chính lời gọi này thì lượt sau không được nhận nữa.
  function itemInfoVerdict(event, info, siblings) {
    if (!isLogEvent(event)) return { ok: false, reason: "not_log_event" };
    if (!info || typeof info !== "object") return { ok: false, reason: "no_info" };
    if (!isUuid(info.orderId) || event.orderId !== info.orderId) return { ok: false, reason: "order_mismatch" };
    const code = textOrNull(event.uid) || textOrNull(event.qrCode);
    if (!code || code !== info.qrCode) return { ok: false, reason: "qr_mismatch" };
    const requestId = textOrNull(info.requestId);
    if (!requestId) return { ok: false, reason: "no_request_id" };
    const held = textOrNull(event.modifiedRequestId);
    if (held && held !== requestId) return { ok: false, reason: "already_claimed" };
    if (!held) {
      for (const other of siblings || []) {
        if (!other || other.eventId === event.eventId) continue;
        if (textOrNull(other.modifiedRequestId) === requestId) return { ok: false, reason: "taken_by_other" };
      }
    }
    return { ok: true, repeat: held === requestId };
  }

  function itemInfoPatch(info) {
    const patch = { modifiedRequestId: textOrNull(info.requestId) };
    for (const f of ITEM_SHEET_FIELDS) patch[f] = info[f] === undefined ? null : info[f];
    patch.modifiedQrCount = qrCountOrNull(info.modifiedQrCount);
    return patch;
  }

  // ---- 0.3: gắn dòng hàng POS vào đúng lượt (content script) ----
  // Ba mốc, theo đúng vòng đời một lời gọi POS:
  //   arm()     — vừa ghi một lượt quét/đọc, lượt này đang chờ POS thêm dòng hàng.
  //   bind()    — POS BẮT ĐẦU gọi /item: chốt ngay lượt nào thuộc lời gọi nào (theo đơn + mã QR, cũ trước).
  //               Từ lúc này mọi thứ đi theo `requestId`, nên response về muộn hay về ngược thứ tự đều không lẫn.
  //   take()    — response về: lấy đúng lượt đã chốt của lời gọi đó, dùng một lần.
  //   release() — lời gọi hỏng (mạng, 5xx, body lạ): ĐÓNG binding, không để response lần sau lấy nhầm lượt này.
  // Re-audit 0.3.0 (P1): bản cũ sinh requestId lúc response về rồi chọn lượt theo thứ tự — hai lời gọi cùng mã
  // trả ngược thứ tự, hay lời gọi đầu lỗi còn lời gọi sau thành công, đều gắn sai lượt.
  const ITEM_CLAIM_TTL_MS = 60000; // lượt vừa quét chờ POS gọi /item
  const ITEM_BINDING_TTL_MS = 120000; // lời gọi đã bắt đầu, chờ response
  class ItemBindings {
    constructor(claimTtlMs, bindingTtlMs) {
      this.claimTtlMs = Number.isFinite(claimTtlMs) && claimTtlMs > 0 ? claimTtlMs : ITEM_CLAIM_TTL_MS;
      this.bindingTtlMs = Number.isFinite(bindingTtlMs) && bindingTtlMs > 0 ? bindingTtlMs : ITEM_BINDING_TTL_MS;
      this.armed = [];
      this.bound = new Map();
    }
    prune(nowMs) {
      const now = Number.isFinite(nowMs) ? nowMs : Date.now();
      this.armed = this.armed.filter((c) => now - c.at <= this.claimTtlMs);
      for (const [id, b] of this.bound) if (now - b.at > this.bindingTtlMs) this.bound.delete(id);
    }
    arm(claim, nowMs) {
      if (!claim || !isUuid(claim.orderId) || !textOrNull(claim.qrCode) || !textOrNull(claim.eventId)) return false;
      const now = Number.isFinite(nowMs) ? nowMs : Date.now();
      this.armed.push({ eventId: claim.eventId, orderId: claim.orderId, qrCode: claim.qrCode, at: now });
      this.prune(now);
      return true;
    }
    bind(requestId, orderId, qrCode, nowMs) {
      const id = textOrNull(requestId);
      if (!id || this.bound.has(id)) return null;
      const now = Number.isFinite(nowMs) ? nowMs : Date.now();
      this.prune(now);
      const i = this.armed.findIndex((c) => c.orderId === orderId && c.qrCode === qrCode);
      if (i < 0) return null; // lời gọi không thuộc lượt nào của tab này (thêm hàng ở máy khác, POS tự sửa)
      const claim = this.armed.splice(i, 1)[0];
      const binding = { eventId: claim.eventId, orderId: claim.orderId, qrCode: claim.qrCode, requestId: id, at: now };
      this.bound.set(id, binding);
      return binding;
    }
    take(requestId) {
      const id = textOrNull(requestId);
      if (!id) return null;
      const binding = this.bound.get(id) || null;
      if (binding) this.bound.delete(id);
      return binding;
    }
    release(requestId) {
      const id = textOrNull(requestId);
      return !!id && this.bound.delete(id);
    }
  }

  // ======================= v0.7 Batch D — thao tác dòng hàng POS =======================
  // Theo dõi MỌI lời gọi POST / DELETE https://api.v2.circa.vn/v1/order/pos/<orderId>/item (cùng host + đường dẫn khoá
  // chặt của 0.3). Luật PM chốt 27/09:
  //   - POST gắn được vào một lượt QR/RFID của extension (ItemBindings, kể cả quét lại CÙNG mã) = lượt quét → KHÔNG sinh
  //     thao tác;
  //   - POST không gắn lượt quét + tập mã QR DISTINCT của dòng không đổi + quantity đổi (v0.7.10.4: hoặc đơn vị bán đổi) + snapshot
  //     trước chắc chắn → MỘT item_quantity_set, quantity / đơn vị và giá lấy từ response;
  //   - DELETE thành công, dòng có trong snapshot trước và không còn trong response → MỘT item_delete (sản phẩm + đơn giá
  //     từ snapshot trước, quantity / thành tiền = 0);
  //   - còn lại (ghép hoặc snapshot không chắc) → chẩn đoán ngắn, không đoán.
  // Ghép bằng requestId (sinh lúc request BẮT ĐẦU) + orderId (đường dẫn, phải trùng data.id của response) + item_id trong
  // body request. KHÔNG dùng độ dài qr_codes: POS nối thêm mã vào qr_codes ở MỌI lần POST có qr_code, kể cả bấm +/−.
  const POS_ACTION = Object.freeze({ QUANTITY_SET: "item_quantity_set", DELETE: "item_delete" });
  const POS_ACTION_VALUES = Object.freeze([POS_ACTION.QUANTITY_SET, POS_ACTION.DELETE]);
  // v0.7.10.4 (spec PM 23/10/2026): item_quantity_set gồm cả đổi đơn vị bán (số lượng có thể giữ nguyên) — cùng mã thao tác, Apps Script
  // và tab data không đổi; previousUnit (chỉ trên máy) cho biết đơn vị trước lời gọi.
  const POS_ACTION_LABELS = Object.freeze({ item_quantity_set: "Sửa số lượng/đơn vị", item_delete: "Xoá dòng" });
  const POS_ACTION_DIAG_MAX = 50;
  // Lý do chẩn đoán (không tạo thao tác). Popup hiện nhãn, file xuất giữ mã.
  const POS_ACTION_DIAG_LABELS = Object.freeze({
    response_order_mismatch: "Response không phải của đơn trên đường dẫn",
    response_without_items: "Response không có danh sách dòng hàng",
    request_unreadable: "Không đọc được body request",
    no_item_id: "Request không có item_id (không ghép được dòng)",
    concurrent: "Có lời gọi /item khác của cùng đơn đang chạy song song",
    no_snapshot: "Chưa có snapshot đơn trước lời gọi",
    item_not_in_snapshot: "Dòng hàng không có trong snapshot trước",
    item_still_present: "DELETE xong dòng hàng vẫn còn",
    item_missing_after: "Response không còn dòng hàng của request",
    unbound_scan: "Tập mã QR tăng mà không gắn được lượt quét",
    qr_set_changed: "Tập mã QR đổi bất thường",
    bad_quantity: "Số lượng không đọc được",
    no_quantity_change: "Số lượng và đơn vị không đổi",
  });
  const POS_TRACKER_MAX_ORDERS = 20;

  const finiteOrNull = (v) =>
    typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;

  // { orderId, method } khi lời gọi ĐÚNG là POST hoặc DELETE lên endpoint dòng hàng; null cho mọi thứ khác.
  function orderItemCall(url, method, base) {
    const m = String(method || "").toUpperCase();
    if (m !== "POST" && m !== "DELETE") return null;
    let u = null;
    try {
      u = base ? new URL(String(url), String(base)) : new URL(String(url));
    } catch (_) {
      return null;
    }
    if (u.protocol !== "https:" || u.hostname !== ORDER_ITEM_HOST) return null;
    const hit = ORDER_ITEM_PATH_RE.exec(u.pathname);
    return hit ? { orderId: hit[1].toLowerCase(), method: m } : null;
  }

  // Trường TỐI THIỂU của body request: item_id (danh tính dòng — khoá ghép), mã QR, quantity. Body không phải JSON object → null.
  function orderItemRequestFields(body) {
    const json = parseMaybeJson(body);
    if (!json || typeof json !== "object" || Array.isArray(json)) return null;
    const id = typeof json.item_id === "string" ? json.item_id.trim().toLowerCase() : "";
    const raw = typeof json.qr_code === "string" ? json.qr_code.trim() : "";
    return { itemId: isUuid(id) ? id : null, qrCode: raw ? extractQrCode(raw) : null, quantity: finiteOrNull(json.quantity) };
  }

  // Tập mã QR DISTINCT của một dòng (qr_code + qr_codes, đã trích đoạn cuối URL), sắp xếp để so sánh.
  function posQrSet(it) {
    const set = new Set();
    const add = (v) => {
      if (typeof v === "string" && v.trim()) set.add(extractQrCode(v));
    };
    add(it && it.qr_code);
    if (it && Array.isArray(it.qr_codes)) it.qr_codes.forEach(add);
    return [...set].sort();
  }
  // v0.7.12.1 (PM audit 24/10/2026): số phần tử của nhật ký qr_codes (POS nối thêm ở MỌI POST /item có qr_code — quét, + / −, đổi đơn vị;
  // thanh toán / hoàn tất không nối). Cùng cách đếm với posItems (chỉ phần tử chuỗi) để so với response COMPLETED. null = không có mảng.
  function qrLogCount(it) {
    return it && Array.isArray(it.qr_codes) ? it.qr_codes.filter((q) => typeof q === "string").length : null;
  }
  function qrCountOrNull(v) {
    return Number.isInteger(v) && v >= 0 ? v : null;
  }

  // Snapshot tối thiểu của MỘT dòng hàng. Tên / mã sản phẩm: item.product (GET đơn) → product của modified_items cùng id
  // (response POST/DELETE trả items[] KHÔNG kèm product) → product_name / product_code cấp item (thường rỗng).
  function posItemSnapshot(it, product) {
    if (!it || typeof it !== "object") return null;
    const id = typeof it.id === "string" ? it.id.toLowerCase() : "";
    if (!isUuid(id)) return null;
    const own = it.product && typeof it.product === "object" ? it.product : null;
    const p = own || (product && typeof product === "object" ? product : null);
    return {
      itemId: id,
      quantity: finiteOrNull(it.quantity),
      unit: stringOrNull(it.unit),
      unitPrice: finiteOrNull(it.unit_price),
      totalAmount: finiteOrNull(it.total_amount),
      sku: stringOrNull(it.sku_code),
      productId: it.product_id === null || it.product_id === undefined || it.product_id === "" ? null : String(it.product_id),
      productName: stringOrNull(p && p.name) || stringOrNull(it.product_name),
      productCode: stringOrNull(p && p.code) || stringOrNull(it.product_code),
      qrSet: posQrSet(it),
      qrCount: qrLogCount(it),
    };
  }

  // Snapshot đơn từ một response POS (GET đơn: data.order; POST/DELETE /item: data). Chỉ trường tối thiểu, không PII.
  // itemsComplete = response CÓ danh sách items (mảng) — chỉ khi đó mới kết luận được "dòng không còn".
  // Dòng hàng của một bản ghi đơn POS: order.items[] (danh sách CUỐI), tên / mã bổ sung từ modified_items cùng id.
  function posOrderItems(order) {
    const products = new Map();
    for (const m of Array.isArray(order.modified_items) ? order.modified_items : []) {
      if (m && typeof m.id === "string" && m.product && typeof m.product === "object") products.set(m.id.toLowerCase(), m.product);
    }
    const items = [];
    for (const it of Array.isArray(order.items) ? order.items : []) {
      const s = posItemSnapshot(it, it && typeof it.id === "string" ? products.get(it.id.toLowerCase()) : null);
      if (s) items.push(s);
    }
    return items;
  }

  // v0.7 Batch C: 9 trường nghiệp vụ của từng dòng (không có tập mã QR). null khi response không có danh sách items.
  function saleItemsOf(order) {
    if (!order || !Array.isArray(order.items)) return null;
    return posOrderItems(order).map((it) => ({
      itemId: it.itemId,
      quantity: it.quantity,
      unit: it.unit,
      unitPrice: it.unitPrice,
      totalAmount: it.totalAmount,
      sku: it.sku,
      productId: it.productId,
      productName: it.productName,
      productCode: it.productCode,
    }));
  }
  // Tên / mã sản phẩm đã biết theo itemId: {itemId: {name, code}}. Gộp bản đang giữ (hoặc danh sách cũ của bản ghi trước bản
  // sửa này) với danh sách mới — giá trị mới khác rỗng thắng. CHỈ tên / mã: số lượng, giá, tập dòng không bao giờ được giữ.
  function mergeProductNames(prev, incomingItems) {
    const out = {};
    const put = (id, name, code) => {
      if (!isUuid(id)) return;
      const cur = out[id] || { name: null, code: null };
      out[id] = { name: textOrNull(name) || cur.name, code: textOrNull(code) || cur.code };
    };
    const p = prev && typeof prev === "object" ? prev : {};
    if (p.productNames && typeof p.productNames === "object") for (const [id, v] of Object.entries(p.productNames)) put(id, v && v.name, v && v.code);
    else if (Array.isArray(p.saleItems)) for (const it of p.saleItems) if (it) put(it.itemId, it.productName, it.productCode);
    if (Array.isArray(incomingItems)) for (const it of incomingItems) if (it) put(it.itemId, it.productName, it.productCode);
    return out;
  }
  function fillSaleItemNames(items, names) {
    return items.map((it) => {
      const known = it && names[it.itemId];
      return known ? Object.assign({}, it, { productName: it.productName || known.name || null, productCode: it.productCode || known.code || null }) : it;
    });
  }

  function posOrderSnapshot(json) {
    const order = pickOrder(json);
    if (!order) return null;
    const items = posOrderItems(order);
    const updatedDate = stringOrNull(order.updated_date) || stringOrNull(order.status_updated_at);
    return {
      orderId: order.id.toLowerCase(),
      orderCode: parseOrderCodeText(order.code),
      status: stringOrNull(order.status),
      orderType: stringOrNull(order.type),
      completedDate: stringOrNull(order.completed_date),
      updatedDate,
      updatedMs: parseTime(updatedDate),
      itemsComplete: Array.isArray(order.items),
      items,
    };
  }

  // Gộp snapshot mới vào snapshot đang giữ của CÙNG đơn. Response tới muộn (updated_date cũ hơn) hoặc không có mốc khi bản
  // đang giữ có mốc → giữ nguyên (không ghi lùi). Tên / mã sản phẩm của một dòng không đổi: response không kèm product thì
  // giữ tên / mã đã biết của cùng itemId.
  function mergePosOrderSnapshot(prev, next) {
    if (!next || !next.itemsComplete) return prev || null;
    if (!prev || prev.orderId !== next.orderId) return next;
    if (prev.updatedMs !== null && (next.updatedMs === null || next.updatedMs < prev.updatedMs)) return prev;
    const known = new Map(prev.items.map((it) => [it.itemId, it]));
    const items = next.items.map((it) => {
      const old = known.get(it.itemId);
      return old ? Object.assign({}, it, { productName: it.productName || old.productName, productCode: it.productCode || old.productCode }) : it;
    });
    return Object.assign({}, next, { items });
  }

  // Sổ theo dõi của page-hook (MAIN world): snapshot mới nhất theo đơn + các lời gọi /item đang chạy. Hàm thuần (không
  // đụng DOM / mạng) để test được bằng response thật.
  //   observe(json)  — mọi response đơn POS (GET đơn, POST/DELETE /item) cập nhật snapshot (chặn ghi lùi).
  //   begin(...)     — lời gọi BẮT ĐẦU: chụp snapshot TRƯỚC; có lời gọi khác của cùng đơn đang chạy → mọi lời gọi đó bị
  //                    đánh dấu `concurrent` (snapshot trước không còn chắc).
  //   setFields(...) — trường tối thiểu của body request (có sau, vì body của Request là stream).
  //   settle(...)    — response về: trả quan sát {before, after} của ĐÚNG dòng trong request, hoặc null khi lời gọi hỏng.
  class PosItemTracker {
    constructor(opts) {
      const o = opts || {};
      this.maxOrders = Number.isInteger(o.maxOrders) && o.maxOrders > 0 ? o.maxOrders : POS_TRACKER_MAX_ORDERS;
      this.callTtlMs = Number.isFinite(o.callTtlMs) && o.callTtlMs > 0 ? o.callTtlMs : ITEM_BINDING_TTL_MS;
      this.orders = new Map();
      this.calls = new Map();
    }
    observeSnapshot(next) {
      if (!next || !next.itemsComplete) return false;
      const prev = this.orders.get(next.orderId) || null;
      const merged = mergePosOrderSnapshot(prev, next);
      if (merged === prev) return false;
      this.orders.delete(next.orderId); // đưa về cuối: đơn cũ nhất bị bỏ trước
      this.orders.set(next.orderId, merged);
      while (this.orders.size > this.maxOrders) this.orders.delete(this.orders.keys().next().value);
      return true;
    }
    observe(json) {
      return this.observeSnapshot(posOrderSnapshot(json));
    }
    snapshot(orderId) {
      return this.orders.get(orderId) || null;
    }
    begin(requestId, orderId, method, nowMs) {
      const id = textOrNull(requestId);
      if (!id || !isUuid(orderId)) return null;
      const now = Number.isFinite(nowMs) ? nowMs : Date.now();
      for (const [k, c] of this.calls) if (now - c.at > this.callTtlMs) this.calls.delete(k); // response không bao giờ về
      const same = [...this.calls.values()].filter((c) => c.orderId === orderId);
      for (const c of same) c.concurrent = true;
      const call = { requestId: id, orderId, method: String(method || "").toUpperCase(), at: now, before: this.snapshot(orderId), concurrent: same.length > 0, fields: undefined };
      this.calls.set(id, call);
      return call;
    }
    setFields(requestId, fields) {
      const c = this.calls.get(requestId);
      if (c) c.fields = fields || null;
    }
    settle(requestId, ok, status, json, atIso) {
      const call = this.calls.get(requestId) || null;
      if (!call) return null;
      this.calls.delete(requestId);
      if (!ok || !json) return null; // lời gọi hỏng (mạng, HTTP lỗi, body lạ): không có thao tác nào
      const after = posOrderSnapshot(json);
      this.observeSnapshot(after); // SAU khi đã chụp "trước" của chính lời gọi này
      const f = call.fields || null;
      const itemId = f ? f.itemId : null;
      const pick = (snap) => (snap && itemId ? snap.items.find((it) => it.itemId === itemId) || null : null);
      return {
        requestId: call.requestId,
        orderId: call.orderId,
        method: call.method,
        status: Number(status) || null,
        at: typeof atIso === "string" ? atIso : new Date().toISOString(),
        request: f ? { itemId: f.itemId, qrCode: f.qrCode, quantity: f.quantity } : null,
        concurrent: !!call.concurrent,
        before: { known: !!call.before, updatedDate: call.before ? call.before.updatedDate : null, item: pick(call.before) },
        after: after
          ? {
              orderId: after.orderId,
              orderCode: after.orderCode,
              status: after.status,
              orderType: after.orderType,
              completedDate: after.completedDate,
              updatedDate: after.updatedDate,
              itemsComplete: after.itemsComplete,
              item: pick(after),
            }
          : null,
      };
    }
  }

  // Sổ CHUNG của hai content script (content.js + rfid-content.js chạy cùng isolated world): requestId của POST /item đã
  // được ItemBindings của MỘT trong hai luồng gắn vào lượt quét. Không xoá lúc take(): quan sát thao tác của cùng lời gọi
  // tới SAU ORDER_ITEM_START, và phải thấy lời gọi đó là lượt quét.
  class ScanRequestRegistry {
    constructor(ttlMs) {
      this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : ITEM_BINDING_TTL_MS + ITEM_CLAIM_TTL_MS;
      this.ids = new Map();
    }
    prune(nowMs) {
      const now = Number.isFinite(nowMs) ? nowMs : Date.now();
      for (const [id, at] of this.ids) if (now - at > this.ttlMs) this.ids.delete(id);
    }
    add(requestId, nowMs) {
      const id = textOrNull(requestId);
      if (!id) return false;
      const now = Number.isFinite(nowMs) ? nowMs : Date.now();
      this.prune(now);
      this.ids.set(id, now);
      return true;
    }
    has(requestId, nowMs) {
      this.prune(nowMs);
      return this.ids.has(textOrNull(requestId));
    }
  }
  const SCAN_REGISTRY_GLOBAL = "__CIRCA_QR_SCAN_LOG_SCAN_REQUESTS__";
  function sharedScanRegistry(scope) {
    const s = scope && typeof scope === "object" ? scope : {};
    if (!(s[SCAN_REGISTRY_GLOBAL] instanceof ScanRequestRegistry)) s[SCAN_REGISTRY_GLOBAL] = new ScanRequestRegistry();
    return s[SCAN_REGISTRY_GLOBAL];
  }

  function sameQrSet(a, b) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
  }
  function qrSuperset(big, small) {
    return Array.isArray(big) && Array.isArray(small) && big.length > small.length && small.every((x) => big.indexOf(x) >= 0);
  }

  // Phân loại MỘT quan sát (kết quả PosItemTracker.settle). bound = POST này đã gắn vào lượt quét của extension.
  //   { kind: "scan" } | { kind: "action", action } | { kind: "diag", reason } | { kind: "ignore" }
  function classifyPosItemCall(obs, bound) {
    if (!obs || typeof obs !== "object" || !isUuid(obs.orderId) || !textOrNull(obs.requestId)) return { kind: "ignore" };
    if (obs.method === "POST" && bound) return { kind: "scan" }; // kể cả quét lại CÙNG mã (tập mã không đổi, quantity +1)
    const d = (reason) => ({ kind: "diag", reason });
    const after = obs.after;
    if (!after || after.orderId !== obs.orderId) return d("response_order_mismatch");
    if (!after.itemsComplete) return d("response_without_items");
    const req = obs.request;
    if (!req) return d("request_unreadable");
    if (!isUuid(req.itemId)) return d("no_item_id");
    if (obs.concurrent) return d("concurrent");
    if (!obs.before || !obs.before.known) return d("no_snapshot");
    const b = obs.before.item;
    const a = after.item;
    if (!b || b.itemId !== req.itemId) return d("item_not_in_snapshot");
    if (obs.method === "DELETE") return a ? d("item_still_present") : { kind: "action", action: POS_ACTION.DELETE };
    if (obs.method !== "POST") return { kind: "ignore" };
    if (!a || a.itemId !== req.itemId) return d("item_missing_after");
    if (!sameQrSet(b.qrSet, a.qrSet)) return d(qrSuperset(a.qrSet, b.qrSet) ? "unbound_scan" : "qr_set_changed");
    if (a.quantity === null || b.quantity === null) return d("bad_quantity");
    // v0.7.10.4 (spec PM 23/10/2026): đổi đơn vị bán (viên → vỉ…) giữ nguyên con số quantity vẫn là MỘT item_quantity_set. Đơn vị thiếu
    // ở một phía + số lượng không đổi → không kết luận được có đổi gì → chẩn đoán như cũ (dòng bị giữ).
    if (a.quantity === b.quantity && (!a.unit || !b.unit || a.unit === b.unit)) return d("no_quantity_change");
    return { kind: "action", action: POS_ACTION.QUANTITY_SET };
  }

  // Khoá ổn định của một thao tác: cùng lời gọi (requestId) gửi lại bao nhiêu lần cũng ra đúng một eventId.
  function posActionEventId(action, orderId, itemId, requestId) {
    return stableUuid(RECORD_TYPE.SALE_ORDER_ACTION + "|" + action + "|" + String(orderId).toLowerCase() + "|" + String(itemId).toLowerCase() + "|" + requestId);
  }

  // Bản ghi thao tác content gửi worker (sau classifyPosItemCall → action). item_quantity_set: số lượng / đơn vị / giá /
  // thành tiền từ RESPONSE; item_delete: sản phẩm + đơn vị + đơn giá từ snapshot TRƯỚC, quantity / thành tiền = 0.
  // `order`: mã / trạng thái / mốc của đơn trong CHÍNH response này (worker so với bản đơn đã gộp, bản mới hơn thắng).
  function posActionInfo(obs, action, extVersion) {
    const del = action === POS_ACTION.DELETE;
    const b = obs.before.item;
    const a = obs.after.item;
    const src = del ? b : a;
    const itemId = obs.request.itemId;
    const pick = (f) => (src && src[f] !== null && src[f] !== undefined ? src[f] : b && b[f] !== undefined ? b[f] : null);
    return {
      eventId: posActionEventId(action, obs.orderId, itemId, obs.requestId),
      recordType: RECORD_TYPE.SALE_ORDER_ACTION,
      source: SOURCE.POS,
      action,
      orderId: obs.orderId,
      scannedAt: obs.at,
      requestId: obs.requestId,
      method: obs.method,
      previousQuantity: b.quantity,
      previousUnit: b.unit, // v0.7.10.4: đơn vị của dòng ngay TRƯỚC lời gọi (snapshot trước) — chỉ trên máy, không lên Sheet
      // v0.7.12.1: số phần tử qr_codes của dòng trước (snapshot trước) / sau (response) lời gọi — chỉ trên máy; DELETE: dòng không còn → null.
      previousQrCount: qrCountOrNull(b.qrCount),
      modifiedQrCount: del ? null : qrCountOrNull(a.qrCount),
      orderType: obs.after.orderType,
      modifiedItemId: itemId,
      modifiedQuantity: del ? 0 : a.quantity,
      modifiedUnit: del ? b.unit : a.unit,
      modifiedUnitPrice: del ? b.unitPrice : a.unitPrice,
      modifiedTotalAmount: del ? 0 : a.totalAmount,
      sku: pick("sku"),
      productName: pick("productName"),
      productCode: pick("productCode"),
      productId: pick("productId"),
      order: { orderCode: obs.after.orderCode, status: obs.after.status, completedDate: obs.after.completedDate, updatedDate: obs.after.updatedDate },
      extVersion: String(extVersion || ""),
    };
  }

  // Dòng chẩn đoán ngắn (không PII, không giá): đủ để QA đối chiếu lời gọi nào không thành thao tác và vì sao.
  function posActionDiagEntry(obs, reason) {
    const o = obs && typeof obs === "object" ? obs : {};
    const cut = (v, n) => (typeof v === "string" && v ? v.slice(0, n) : null);
    return {
      at: cut(o.at, 40) || new Date().toISOString(),
      orderId: isUuid(o.orderId) ? o.orderId : null,
      orderCode: o.after ? cut(o.after.orderCode, 20) : null,
      method: o.method === "POST" || o.method === "DELETE" ? o.method : null,
      requestId: cut(o.requestId, 64),
      itemId: o.request && isUuid(o.request.itemId) ? o.request.itemId : null,
      reason: POS_ACTION_DIAG_LABELS[reason] ? reason : "unknown",
    };
  }
  function normalizePosActionDiag(entry) {
    if (!entry || typeof entry !== "object") return null;
    const e = posActionDiagEntry(
      { at: entry.at, orderId: entry.orderId, method: entry.method, requestId: entry.requestId, request: { itemId: entry.itemId }, after: { orderCode: entry.orderCode } },
      entry.reason
    );
    return e.orderId ? e : null;
  }

  function isActionEvent(e) {
    return !!e && typeof e === "object" && e.recordType === RECORD_TYPE.SALE_ORDER_ACTION && e.source === SOURCE.POS;
  }

  // Snapshot đơn cho bản ghi thao tác: bản đơn ĐÃ gộp (ord:, đã chặn response cũ) so với đơn trong response của chính thao
  // tác — bản có updated_date mới hơn thắng (mergeOrderInfo). Không bao giờ ghi lùi.
  function actionOrderSnapshot(ord, fromResponse) {
    const r = fromResponse && typeof fromResponse === "object" ? fromResponse : null;
    const o = r
      ? mergeOrderInfo(ord, { orderId: (ord && ord.orderId) || "", orderCode: textOrNull(r.orderCode), status: textOrNull(r.status), completedDate: textOrNull(r.completedDate), updatedDate: textOrNull(r.updatedDate) }, "")
      : ord;
    return orderSnapshot(o);
  }
  // Chép snapshot đơn (ord: đã gộp) vào một thao tác khi đơn đổi — KHÔNG ghi lùi: thao tác đang mang đơn của response mới
  // hơn bản ord: (hoặc ord: không có mốc) thì giữ nguyên.
  function actionSnapshotPatch(current, ord) {
    if (!isActionEvent(current) || !ord || typeof ord !== "object") return null;
    const have = parseTime(current.orderUpdatedAt);
    const incoming = parseTime(ord.updatedDate);
    if (have !== null && (incoming === null || incoming < have)) return null;
    return orderSnapshot(ord);
  }
  // Trường đơn mà một thao tác mang theo (và được chép lại khi đơn đổi). KHÔNG có orderItemQuantity: cột quantity là số lượng
  // theo UID của lượt quét khi đơn COMPLETED — thao tác không có UID nên ô này trống.
  const ACTION_SNAPSHOT_FIELDS = Object.freeze(["orderCode", "orderStatus", "completedAt", "orderUpdatedAt"]);
  const ACTION_INFO_FIELDS = Object.freeze(["eventId", "recordType", "source", "action", "orderId", "scannedAt", "requestId", "method", "previousQuantity", "previousUnit", "previousQrCount", "modifiedQrCount", "extVersion"]);

  // Bản ghi thao tác mới vào kho (worker). Chỉ các trường liệt kê được chép từ content; trường đồng bộ / trạm do worker đặt.
  function newActionRecord(info, ord, nowIso) {
    const i = info && typeof info === "object" ? info : {};
    const rec = {};
    for (const f of ACTION_INFO_FIELDS) rec[f] = i[f] === undefined ? null : i[f];
    // v0.7.12.1: số đếm sai kiểu → trống (gate nhật ký giữ dòng), không bỏ cả thao tác.
    rec.previousQrCount = qrCountOrNull(i.previousQrCount);
    rec.modifiedQrCount = qrCountOrNull(i.modifiedQrCount);
    for (const f of ITEM_SHEET_FIELDS) rec[f] = i[f] === undefined ? null : i[f];
    rec.sku = textOrNull(i.sku);
    rec.productName = textOrNull(i.productName);
    rec.productCode = textOrNull(i.productCode);
    rec.productId = i.productId === null || i.productId === undefined || i.productId === "" ? null : String(i.productId);
    for (const f of GENERATION_FIELDS) rec[f] = null;
    for (const f of STATION_FIELDS) rec[f] = null;
    Object.assign(rec, actionOrderSnapshot(ord, i.order));
    delete rec.transferType;
    rec.orderItemQuantity = null;
    rec.revision = 1;
    rec.updatedAt = nowIso;
    rec.syncedRevision = 0;
    rec.syncedAt = null;
    return rec;
  }

  const isNumOrNull = (v) => v === null || v === undefined || (typeof v === "number" && Number.isFinite(v));
  function validateActionEvent(e) {
    if (e.source !== SOURCE.POS) return "source";
    if (POS_ACTION_VALUES.indexOf(e.action) < 0) return "action";
    if (!isUuid(e.modifiedItemId)) return "modifiedItemId";
    if (!textOrNull(e.requestId)) return "requestId";
    const q = e.modifiedQuantity;
    if (typeof q !== "number" || !Number.isFinite(q) || q < 0) return "modifiedQuantity";
    if (!isNumOrNull(e.modifiedUnitPrice) || !isNumOrNull(e.modifiedTotalAmount)) return "price";
    for (const f of ["previousQrCount", "modifiedQrCount"]) if (e[f] !== null && e[f] !== undefined && qrCountOrNull(e[f]) === null) return f;
    if (e.action === POS_ACTION.DELETE && (q !== 0 || e.modifiedTotalAmount !== 0)) return "modifiedQuantity";
    // Khoá ổn định là hợp đồng: bản ghi có eventId khác công thức không phải do bộ phân loại sinh ra.
    if (e.eventId !== posActionEventId(e.action, e.orderId, e.modifiedItemId, e.requestId)) return "eventId";
    return null;
  }

  // ======================= v0.7.4 — dấu vết vòng đời đơn trên tab data (sale_order_status) =======================
  // Spec PM 07/10/2026 (phương án A): mỗi đơn bán extension quan sát được có bản ghi trên data, KỂ CẢ đơn không có lượt quét;
  // MỘT bản ghi cho mỗi trạng thái quan sát được (PENDING, COMPLETED, CANCELLED…). Nguồn: bản ghi ord: ĐÃ GỘP (response cũ tới
  // muộn đã bị chặn bằng updated_date) — không bao giờ ghi lùi trạng thái. Khoá = stableUuid(sale_order_status|orderId|status):
  // reload / gửi lại / mở lại đơn không sinh dòng thứ hai. Không lượt quét giả nào được dựng từ trạng thái đơn.
  const ORDER_STATUS_ACTION = "order_status";
  function isStatusEvent(e) {
    return !!e && typeof e === "object" && e.recordType === RECORD_TYPE.SALE_ORDER_STATUS && e.source === SOURCE.POS;
  }
  function orderStatusEventId(orderId, status) {
    return stableUuid(RECORD_TYPE.SALE_ORDER_STATUS + "|" + String(orderId).toLowerCase() + "|" + String(status));
  }
  // Mốc của trạng thái: status_updated_at của POS; COMPLETED thiếu thì completed_date; cuối cùng updated_date. Không dùng giờ
  // extension nhận (trừ khi POS không cho mốc nào — ghi rõ ở observedAt).
  function orderStatusTime(o) {
    return textOrNull(o.statusUpdatedAt) || (o.status === ORDER_COMPLETED ? textOrNull(o.completedDate) : null) || textOrNull(o.updatedDate);
  }
  // Bản ghi trạng thái của snapshot đơn hiện tại, hoặc null (không phải đơn bán / thiếu id / thiếu trạng thái).
  function orderStatusRecord(ord, nowIso) {
    const o = ord && typeof ord === "object" ? ord : null;
    if (!o || !isUuid(o.orderId) || recordTypeOf(o) !== RECORD_TYPE.SALE_ORDER) return null;
    const status = textOrNull(o.status);
    if (!status) return null;
    const at = orderStatusTime(o);
    // Trường của lượt quét / dòng hàng / sản phẩm / trạm để trống TRƯỚC (ITEM_FIELDS có orderType của dòng hàng) rồi mới gán
    // trường của đơn — gán sau sẽ bị xoá.
    const rec = {};
    for (const f of GENERATION_FIELDS) rec[f] = null;
    for (const f of ITEM_FIELDS) rec[f] = null;
    for (const f of PRODUCT_FIELDS) rec[f] = null;
    for (const f of STATION_FIELDS) rec[f] = null;
    Object.assign(rec, {
      eventId: orderStatusEventId(o.orderId, status),
      recordType: RECORD_TYPE.SALE_ORDER_STATUS,
      source: SOURCE.POS,
      action: ORDER_STATUS_ACTION,
      orderId: o.orderId,
      orderCode: textOrNull(o.orderCode),
      orderStatus: status,
      orderType: textOrNull(o.orderType) ? String(o.orderType).trim().toUpperCase() : null,
      completedAt: status === ORDER_COMPLETED ? textOrNull(o.completedDate) : null,
      orderUpdatedAt: textOrNull(o.updatedDate),
      scannedAt: at && parseTime(at) !== null ? at : nowIso,
      statusTimeSource: at && parseTime(at) !== null ? "pos" : "observed",
      observedAt: nowIso,
    });
    rec.revision = 1;
    rec.updatedAt = nowIso;
    rec.syncedRevision = 0;
    rec.syncedAt = null;
    return rec;
  }
  // Bản ghi trạng thái đã có: CHỈ điền ô còn trống (mã đơn / loại đơn / hoàn tất lúc) — trạng thái và mốc của nó bất biến.
  const ORDER_STATUS_FILL_FIELDS = Object.freeze(["orderCode", "orderType", "completedAt"]);
  function orderStatusFill(existing, fresh) {
    if (!isStatusEvent(existing) || !fresh || existing.eventId !== fresh.eventId) return null;
    const patch = {};
    for (const f of ORDER_STATUS_FILL_FIELDS) if (isBlankValue(existing[f]) && !isBlankValue(fresh[f])) patch[f] = fresh[f];
    return Object.keys(patch).length ? patch : null;
  }
  function validateStatusEvent(e) {
    if (e.source !== SOURCE.POS) return "source";
    if (e.action !== ORDER_STATUS_ACTION) return "action";
    if (!textOrNull(e.orderStatus)) return "orderStatus";
    if (e.eventId !== orderStatusEventId(e.orderId, e.orderStatus)) return "eventId";
    return null;
  }

  // ======================= v0.7 Batch C — tab completed_items =======================
  // Nguồn: data.order.items[] của snapshot đơn (GET đơn khi mở /ban-hang/<id>, hoặc response đơn khác) đã gộp vào ord: —
  // KHÔNG phải modified_items. Một dòng hàng của đơn đạt trạng thái THÀNH CÔNG, có mốc trạng thái SAU v07InstalledAt →
  // một bản ghi bền ci:<orderId>|<itemId>; khoá Sheet (orderId, modifiedItemId). Snapshot mới hơn (updated_date của POS)
  // thay snapshot cũ; cũ hơn bỏ qua; cùng mốc khác nội dung = xung đột → giữ bản đang có + chẩn đoán (HANDOFF 6.1 #18).
  const COMPLETED_TARGET = "completed_items";
  // A:I nghiệp vụ + J:K kỹ thuật (người vận hành ẩn). Phải bằng hệt SheetUpsert.COMPLETED_HEADERS (tests/completed-items.test.js).
  const COMPLETED_HEADERS = Object.freeze([
    "modifiedItemId",
    "modifiedQuantity",
    "modifiedUnit",
    "modifiedUnitPrice",
    "modifiedTotalAmount",
    "sku",
    "productName",
    "productCode",
    "productId",
    "orderId",
    "orderUpdatedAt",
  ]);
  const COMPLETED_BUSINESS_FIELDS = Object.freeze(COMPLETED_HEADERS.slice(0, 9));
  // v0.7.2: L posStationId (mã trạm cấu hình lúc TẠO bản ghi — trạm logic), M orderCode (từ ord:). Không phải trường nghiệp
  // vụ của dòng: không làm tăng revision, chỉ điền khi đang thiếu. Phải bằng hệt SheetUpsert.COMPLETED_EXTRA_HEADERS.
  const COMPLETED_EXTRA_FIELDS = Object.freeze(["posStationId", "orderCode"]);
  const COMPLETED_HEADERS_V2 = Object.freeze(COMPLETED_HEADERS.concat(COMPLETED_EXTRA_FIELDS));
  const SYNC_CAPABILITY_COMPLETED_V2 = "completed_items:station_order";
  // v0.7.2 (audit lại PM 04/10): bản ghi 13 trường đi trong phong bì v5. Apps Script đã phát hành (≤ 0.7.1) chỉ nhận v1–v4 và
  // trả bad_envelope TRƯỚC khi đọc / ghi — POST rơi vào bản cũ (đổi / hoàn tác deployment giữa GET và POST) không ghi được gì.
  // Phải bằng hệt SheetUpsert.COMPLETED_LM_ENVELOPE_VERSION.
  const COMPLETED_LM_ENVELOPE_VERSION = 5;
  // Trạng thái thành công theo loại đơn (PM 26/09, HANDOFF 6.1 #3). Loại đơn khác / trạng thái khác → không ghi.
  const COMPLETED_STATUSES = Object.freeze({
    ONLINE: Object.freeze(["AWAITING_SHIPMENT", "PICKING", "READY_TO_PICK", "SHIPPING", "COMPLETE_SHIPPING", "COMPLETED"]),
    OFFLINE: Object.freeze(["AWAITING_CONFIRM", "COMPLETED"]),
  });
  const SYNC_CAPABILITY_COMPLETED = "target:completed_items";
  const COMPLETED_DIAG_MAX = 50;
  const COMPLETED_DIAG_LABELS = Object.freeze({
    before_marker: "Trạng thái thành công có mốc TRƯỚC lúc cài v0.7 (không backfill)",
    no_status_time: "Đơn thành công nhưng không có mốc trạng thái",
    no_updated_date: "Đơn thành công nhưng không có updated_date",
    no_marker: "Chưa có mốc cài v0.7",
    items_missing: "Response trạng thái thành công không kèm danh sách dòng hàng — chờ response đầy đủ (không dùng danh sách cũ)",
    same_version_conflict: "Cùng updated_date nhưng nội dung dòng khác — giữ bản đang có",
  });

  // So hai mốc giờ ISO của POS tới micro giây: ms trước, rồi phần lẻ sau ms (POS ghi 6 chữ số). null khi không đọc được.
  // Apps Script có bản sao đúng thuật toán này (SheetUpsert.versionCompare) — tests/completed-items.test.js đối chứng.
  function posTimeCompare(a, b) {
    const ta = parseTime(a);
    const tb = parseTime(b);
    if (ta === null || tb === null) return null;
    if (ta !== tb) return ta < tb ? -1 : 1;
    const sub = (s) => {
      const m = /T\d{2}:\d{2}:\d{2}\.(\d+)/.exec(String(s));
      return ((m ? m[1] : "") + "000000000").slice(3, 9);
    };
    const fa = sub(a);
    const fb = sub(b);
    return fa === fb ? 0 : fa < fb ? -1 : 1;
  }

  // Mốc của trạng thái hiện tại: status_updated_at; riêng COMPLETED được dùng completed_date khi thiếu (#18). Không bao giờ
  // dùng giờ extension nhận response.
  function completedStatusAt(ord) {
    const o = ord || {};
    return textOrNull(o.statusUpdatedAt) || (o.status === ORDER_COMPLETED ? textOrNull(o.completedDate) : null);
  }

  // Đơn này có được ghi vào completed_items không. { ok, reason, diag } — diag = lý do đáng ghi chẩn đoán (đơn ĐÃ thành công
  // nhưng không đủ điều kiện); trạng thái chưa thành công là chuyện bình thường, không chẩn đoán.
  function completedVerdict(ord, marker) {
    const o = ord && typeof ord === "object" ? ord : null;
    const no = (reason, diag) => ({ ok: false, reason, diag: !!diag });
    if (!o || !isUuid(o.orderId) || recordTypeOf(o) !== RECORD_TYPE.SALE_ORDER) return no("not_sale_order");
    const list = COMPLETED_STATUSES[String(o.orderType || "").trim().toUpperCase()];
    if (!list) return no("order_type");
    if (list.indexOf(o.status) < 0) return no("not_success_status");
    if (!marker || parseTime(marker.at) === null) return no("no_marker", true);
    const at = completedStatusAt(o);
    if (!at || parseTime(at) === null) return no("no_status_time", true);
    if (!(posTimeCompare(at, marker.at) > 0)) return no("before_marker", true);
    if (!textOrNull(o.updatedDate) || parseTime(o.updatedDate) === null) return no("no_updated_date", true);
    // P1 audit C: danh sách dòng phải đến từ response của CHÍNH phiên bản đơn đang xét (không bao giờ là danh sách cũ).
    if (!Array.isArray(o.saleItems) || posTimeCompare(o.saleItemsVersion, o.updatedDate) !== 0) return no("items_missing", true);
    return { ok: true, reason: null, diag: false, statusAt: at };
  }

  // Đơn bán ở trạng thái thành công (chưa xét mốc) — worker chỉ đọc / ghi mốc cài cho những đơn này.
  function completedCandidate(ord) {
    const o = ord && typeof ord === "object" ? ord : null;
    if (!o || !isUuid(o.orderId) || recordTypeOf(o) !== RECORD_TYPE.SALE_ORDER) return false;
    const list = COMPLETED_STATUSES[String(o.orderType || "").trim().toUpperCase()];
    return !!list && list.indexOf(o.status) >= 0;
  }

  // Snapshot từng dòng của đơn đủ điều kiện (chỉ trường được phép: ID đơn / dòng, trạng thái / mốc, 9 trường nghiệp vụ).
  function completedItemsOf(ord, marker) {
    const v = completedVerdict(ord, marker);
    if (!v.ok) return Object.assign({ items: [] }, v);
    const items = [];
    for (const it of ord.saleItems) {
      if (!it || !isUuid(it.itemId)) continue;
      items.push({
        orderId: ord.orderId,
        modifiedItemId: it.itemId,
        modifiedQuantity: typeof it.quantity === "number" && Number.isFinite(it.quantity) ? it.quantity : null,
        modifiedUnit: textOrNull(it.unit),
        modifiedUnitPrice: typeof it.unitPrice === "number" && Number.isFinite(it.unitPrice) ? it.unitPrice : null,
        modifiedTotalAmount: typeof it.totalAmount === "number" && Number.isFinite(it.totalAmount) ? it.totalAmount : null,
        sku: textOrNull(it.sku),
        productName: textOrNull(it.productName),
        productCode: textOrNull(it.productCode),
        productId: it.productId === null || it.productId === undefined || it.productId === "" ? null : String(it.productId),
        orderUpdatedAt: ord.updatedDate,
        orderCode: textOrNull(ord.orderCode),
        orderStatus: ord.status,
        orderType: String(ord.orderType).trim().toUpperCase(),
        statusAt: v.statusAt,
      });
    }
    return { ok: true, reason: null, diag: false, items };
  }

  function completedKey(orderId, itemId) {
    return KEYS.completed + String(orderId).toLowerCase() + "|" + String(itemId).toLowerCase();
  }
  function isCompletedRecord(r) {
    return !!r && typeof r === "object" && isUuid(r.orderId) && isUuid(r.modifiedItemId) && Number.isInteger(r.revision) && r.revision >= 1;
  }
  // Dòng tab completed_items (11 ô — hoặc 13 khi Web App + tab hỗ trợ L:M; mọi ô là chuỗi RAW — như tab data).
  function completedRow(r, columns) {
    const row = {};
    for (const h of columns === COMPLETED_HEADERS_V2.length ? COMPLETED_HEADERS_V2 : COMPLETED_HEADERS) row[h] = cell(r[h]);
    return row;
  }
  // v0.7.2 (audit PM 03/10, P2): sau lúc TẠO bản ghi chỉ được điền M orderCode (từ ord:, khi đang thiếu). L posStationId
  // KHÔNG BAO GIỜ được điền sau lúc tạo — cấu hình trạm lúc đối soát không chứng minh trạm đã ghi nhận dòng ban đầu
  // (bản ghi ci: tạo trước v0.7.2 giữ L trống). null khi không có gì để điền.
  function completedExtrasFill(existing, snap) {
    return isBlankValue(existing.orderCode) && !isBlankValue(snap.orderCode) ? { orderCode: snap.orderCode } : null;
  }
  const COMPLETED_STATE_FIELDS = Object.freeze(["orderStatus", "orderType", "statusAt"]);

  // Gộp snapshot một dòng vào bản ghi đang có. { write, record, outcome: created | updated | same | stale | conflict }.
  // revision chỉ tăng khi một ô của dòng Sheet đổi (snapshot mới hơn luôn đổi ô orderUpdatedAt).
  function mergeCompletedItem(existing, snap, nowIso) {
    if (!existing) {
      const rec = {};
      for (const h of COMPLETED_HEADERS) rec[h] = snap[h] === undefined ? null : snap[h];
      for (const f of COMPLETED_STATE_FIELDS) rec[f] = snap[f] === undefined ? null : snap[f];
      for (const f of COMPLETED_EXTRA_FIELDS) rec[f] = isBlankValue(snap[f]) ? null : snap[f];
      Object.assign(rec, { revision: 1, updatedAt: nowIso, firstSeenAt: nowIso, syncedRevision: 0, syncedAt: null });
      return { write: true, record: rec, outcome: "created" };
    }
    const cmp = posTimeCompare(snap.orderUpdatedAt, existing.orderUpdatedAt);
    if (cmp === null) return { write: false, record: existing, outcome: "stale" };
    if (cmp < 0) return { write: false, record: existing, outcome: "stale" };
    const differs = COMPLETED_BUSINESS_FIELDS.some((f) => cell(snap[f]) !== cell(existing[f]));
    if (cmp === 0) {
      if (!differs) return { write: false, record: existing, outcome: "same" };
      // Cùng mốc, khác nội dung: không đoán bản nào đúng — giữ bản đang có. Ghi dấu (không phải ô Sheet, không tăng revision)
      // để lần gặp lại đúng xung đột đó không ghi chẩn đoán lần nữa.
      if (existing.conflictVersion === snap.orderUpdatedAt) return { write: false, record: existing, outcome: "conflict", repeat: true };
      return { write: true, record: Object.assign({}, existing, { conflictVersion: snap.orderUpdatedAt, conflictAt: nowIso }), outcome: "conflict" };
    }
    const next = Object.assign({}, existing, completedExtrasFill(existing, snap) || {});
    for (const h of COMPLETED_HEADERS) next[h] = snap[h] === undefined ? null : snap[h];
    for (const f of COMPLETED_STATE_FIELDS) next[f] = snap[f] === undefined ? null : snap[f];
    delete next.conflictVersion;
    delete next.conflictAt;
    next.revision = (Number(existing.revision) || 0) + 1;
    next.updatedAt = nowIso;
    return { write: true, record: next, outcome: "updated" };
  }

  // v0.7.4 (spec PM 07/10/2026): đơn thành công SAU mốc cài mà completed_items CHƯA phản ánh đủ response cuối — báo rõ trên popup
  // (không im lặng coi là đủ). Tính từ trạng thái HIỆN TẠI (tự hết khi đơn đã đủ), không từ lịch sử chẩn đoán.
  //   items_missing   : response trạng thái thành công không kèm items[] của chính phiên bản đó (chờ response đầy đủ);
  //   no_status_time / no_updated_date : thiếu mốc của POS;
  //   items_not_written: số dòng ci: của đơn ở đúng phiên bản (orderUpdatedAt) ít hơn số dòng của response cuối.
  // Đối chiếu theo orderId + itemId (không theo mã DHC).
  function completedIncompleteOrders(orders, completedRecords, marker) {
    const byOrder = new Map();
    for (const r of Array.isArray(completedRecords) ? completedRecords : []) {
      if (!r || !isUuid(r.orderId)) continue;
      if (!byOrder.has(r.orderId)) byOrder.set(r.orderId, []);
      byOrder.get(r.orderId).push(r);
    }
    const out = [];
    for (const o of orders || []) {
      if (!completedCandidate(o)) continue;
      const v = completedVerdict(o, marker);
      if (!v.ok) {
        if (["items_missing", "no_status_time", "no_updated_date"].indexOf(v.reason) >= 0) out.push({ orderId: o.orderId, orderCode: textOrNull(o.orderCode), reason: v.reason });
        continue;
      }
      const ids = new Set(o.saleItems.filter((it) => it && isUuid(it.itemId)).map((it) => it.itemId));
      const written = (byOrder.get(o.orderId) || []).filter((r) => ids.has(r.modifiedItemId) && posTimeCompare(r.orderUpdatedAt, o.updatedDate) === 0);
      const have = new Set(written.map((r) => r.modifiedItemId));
      if ([...ids].some((id) => !have.has(id))) out.push({ orderId: o.orderId, orderCode: textOrNull(o.orderCode), reason: "items_not_written", missing: [...ids].filter((id) => !have.has(id)).length });
    }
    return out.sort((a, b) => String(a.orderCode || a.orderId).localeCompare(String(b.orderCode || b.orderId)));
  }

  function completedDiagEntry(orderId, itemId, reason, nowIso) {
    return {
      at: typeof nowIso === "string" ? nowIso : new Date().toISOString(),
      orderId: isUuid(orderId) ? String(orderId).toLowerCase() : null,
      itemId: isUuid(itemId) ? String(itemId).toLowerCase() : null,
      reason: COMPLETED_DIAG_LABELS[reason] ? reason : "unknown",
    };
  }

  // ---- đồng bộ tab completed_items (hàng chờ, trạng thái lỗi, lịch thử lại riêng) ----
  function completedSyncStatusOf(r) {
    if (!isCompletedRecord(r)) return "none";
    if (syncedRevisionOf(r) >= r.revision) return "synced";
    if (r.syncErrorRevision === r.revision) return "rejected";
    return "pending";
  }
  // v0.7.2: số dòng đã đồng bộ mà ACK (phong bì v5) cho biết Sheet để trống L — dòng tạo trước v0.7.2 / do máy bản cũ tạo.
  // Popup hiện con số này (không âm thầm), không tự gán trạm.
  function completedSheetLBlankCount(records) {
    let n = 0;
    for (const r of records || []) if (completedSyncStatusOf(r) === "synced" && r.sheetPosStationId === "") n += 1;
    return n;
  }
  function completedCounts(records) {
    const c = { local: 0, pending: 0, synced: 0, rejected: 0 };
    for (const r of records || []) {
      const st = completedSyncStatusOf(r);
      if (st === "none") continue;
      c.local += 1;
      c[st] += 1;
    }
    return c;
  }
  function selectCompletedBatch(records, opts) {
    const o = opts || {};
    const max = Math.max(0, Math.min(Number(o.max) || SYNC_BATCH_MAX, SYNC_BATCH_MAX));
    const exclude = o.exclude || null;
    const list = [];
    for (const r of records || []) {
      const st = completedSyncStatusOf(r);
      if (st !== "pending" && !(o.includeRejected && st === "rejected")) continue;
      if (exclude && exclude.has(completedKey(r.orderId, r.modifiedItemId) + ":" + r.revision)) continue;
      list.push(r);
    }
    list.sort((a, b) => String(a.updatedAt || "").localeCompare(String(b.updatedAt || "")) || completedKey(a.orderId, a.modifiedItemId).localeCompare(completedKey(b.orderId, b.modifiedItemId)));
    return list.slice(0, max);
  }
  // Phong bì v4, target completed_items. Bản ghi = đúng 11 ô của dòng Sheet (không revision, không trạng thái).
  // v0.7.2 opts.columns = 13: dòng gồm L posStationId + M orderCode (chỉ khi preflight v2 báo tab đủ 13 tiêu đề).
  // 11 trường → phong bì v4 (như v0.7.0); 13 trường → phong bì v5 (chỉ Apps Script v0.7.2 nhận).
  function completedEnvelope(records, extVersion, opts) {
    const columns = opts && opts.columns === COMPLETED_HEADERS_V2.length ? COMPLETED_HEADERS_V2.length : COMPLETED_HEADERS.length;
    const v = columns === COMPLETED_HEADERS_V2.length ? COMPLETED_LM_ENVELOPE_VERSION : SYNC_ENVELOPE_V4;
    return { v, schemaVersion: SYNC_SCHEMA_VERSION, target: COMPLETED_TARGET, extVersion: String(extVersion || ""), records: (records || []).map((r) => completedRow(r, columns)) };
  }
  // v0.7.2: GET ?target=completed_items&v=2. Audit PM 03/10 (P1): client v0.7.2 CHỈ gửi khi Web App hỗ trợ L:M VÀ tab có đúng
  // tiêu đề L1 posStationId / M1 orderCode — không đoán cột, và KHÔNG gửi 11 trường để nhận ACK (dòng đã ACK không tự gửi lại
  // khi sửa tiêu đề sau đó). Chưa đủ → lỗi rõ, dòng completed_items chờ trên máy; sửa xong là gửi đủ 13 trường.
  // { ok: true, columns: 13, columnsState: "ok13" } hoặc { ok: false, error }.
  function parseCompletedPreflightV2(json) {
    const caps = json && typeof json === "object" && Array.isArray(json.capabilities) ? json.capabilities : [];
    if (caps.indexOf(SYNC_CAPABILITY_COMPLETED_V2) < 0) {
      // Apps Script cũ (bỏ qua v=2): vẫn kiểm như v0.7.0 để báo đúng lỗi nền (thiếu tab, tiêu đề A:K sai…), rồi báo cần v0.7.2.
      const old = parseCompletedPreflight(json);
      return old.ok ? { ok: false, error: "server_no_completed_lm" } : old;
    }
    const fail = (error) => ({ ok: false, error });
    if (json.schemaVersion !== SYNC_SCHEMA_VERSION) return fail("server_outdated");
    if (caps.indexOf(SYNC_CAPABILITY_COMPLETED) < 0) return fail("server_no_completed");
    if (json.ok !== true) return fail(typeof json.error === "string" && json.error ? json.error.slice(0, 200) : "not_ok");
    if (json.target !== COMPLETED_TARGET) return fail("server_no_completed");
    if (!Array.isArray(json.headers) || json.headers.length !== COMPLETED_HEADERS_V2.length) return fail("server_outdated");
    if (json.headerState === "empty") return fail("completed_items_headers_empty");
    if (json.headerState !== "ok") return fail("completed_items_headers_mismatch");
    if (!COMPLETED_HEADERS.every((h, i) => typeof json.headers[i] === "string" && json.headers[i].trim() === h)) return fail("completed_items_headers_mismatch");
    // Web App báo ok13 VÀ tự kiểm đúng tên L:M; thiếu / sai → lỗi (dòng chờ trên máy).
    const lm = COMPLETED_EXTRA_FIELDS.every((h, i) => typeof json.headers[COMPLETED_HEADERS.length + i] === "string" && json.headers[COMPLETED_HEADERS.length + i].trim() === h);
    if (json.columnsState === "ok13" && lm) return { ok: true, columns: COMPLETED_HEADERS_V2.length, columnsState: "ok13" };
    return fail(json.columnsState === "ok11" ? "completed_items_lm_missing" : "completed_items_lm_mismatch");
  }
  // GET /exec?target=completed_items TRƯỚC POST đầu tiên của đợt: đúng Code.gs v0.7 (capability) và tab có ĐÚNG 11 tiêu đề.
  function parseCompletedPreflight(json) {
    const fail = (error) => ({ ok: false, error });
    if (!json || typeof json !== "object" || Array.isArray(json)) return fail("bad_response");
    if (json.schemaVersion !== SYNC_SCHEMA_VERSION) return fail("server_outdated");
    const caps = Array.isArray(json.capabilities) ? json.capabilities : [];
    if (caps.indexOf(SYNC_CAPABILITY_COMPLETED) < 0) return fail("server_no_completed");
    if (json.ok !== true) return fail(typeof json.error === "string" && json.error ? json.error.slice(0, 200) : "not_ok");
    if (json.target !== COMPLETED_TARGET) return fail("server_no_completed");
    if (!Array.isArray(json.headers) || json.headers.length !== COMPLETED_HEADERS.length) return fail("server_outdated");
    if (json.headerState === "empty") return fail("completed_items_headers_empty");
    if (json.headerState !== "ok") return fail("completed_items_headers_mismatch");
    // P2 audit C: không tin riêng headerState — tự so đúng tên từng tiêu đề A:K.
    if (!COMPLETED_HEADERS.every((h, i) => typeof json.headers[i] === "string" && json.headers[i].trim() === h)) return fail("completed_items_headers_mismatch");
    return { ok: true };
  }
  // ACK theo KHOÁ (orderId, modifiedItemId) + PHIÊN BẢN đã gửi (orderUpdatedAt). Thiếu / sai phiên bản / lặp / trạng thái lạ
  // → dòng đó vẫn chờ. "skipped" = Sheet đã giữ phiên bản ≥ bản gửi (kể cả do trạm khác ghi) → là ACK.
  // v0.7.2 (audit lại PM 04/10) opts.columns = 13 (phong bì v5): CHỈ nhận khi phản hồi xác nhận hợp đồng 13 cột (v 5 +
  // contract + columns 13) — thiếu / sai → không ACK dòng nào (completed_items_ack_unconfirmed). Mỗi ACK phải mang L:M
  // THỰC TẾ của dòng trên Sheet: "appended" phải đúng L:M vừa gửi; "updated" phải có M (Apps Script điền M khi trống);
  // "skipped" nhận L:M đang có (L trống = dòng do bản cũ tạo — không tự gán trạm). Lệch → dòng đó vẫn chờ
  // (completed_items_lm_unverified, trả trong lmSuspect để đánh dấu nghi vấn). L:M trên Sheet được trả kèm ACK
  // (sheetPosStationId / sheetOrderCode) để lưu đối chiếu.
  // Dòng NGHI VẤN (bản ghi có lmSuspect — từng nhận phản hồi không xác nhận / L:M lệch: một lần ghi trước có thể đã ghi A:K
  // mà thiếu L:M): "skipped" / "updated" chỉ là ACK khi Sheet THỰC SỰ có L:M (L trống mà bản ghi có trạm, hoặc M trống mà
  // bản ghi có mã đơn → không ACK; chuyển thành lỗi riêng completed_items_lm_review — cần người kiểm, không tự gán trạm).
  function parseCompletedResponse(sent, json, opts) {
    const list = sent || [];
    const lmMode = !!(opts && opts.columns === COMPLETED_HEADERS_V2.length);
    const none = (error) => ({ ok: false, error, acked: [], rejected: [], missing: list.length });
    if (!json || typeof json !== "object" || Array.isArray(json)) return none("bad_response");
    if (json.schemaVersion !== SYNC_SCHEMA_VERSION) return none("server_outdated");
    if (json.ok !== true) {
      // Apps Script cũ không biết phong bì v5 (từ chối trước khi ghi) → cùng lỗi với preflight gặp bản cũ.
      if (lmMode && json.error === "bad_envelope") return none("server_no_completed_lm");
      return none(typeof json.error === "string" && json.error ? json.error.slice(0, 200) : "not_ok");
    }
    if (lmMode && !(json.v === COMPLETED_LM_ENVELOPE_VERSION && json.contract === SYNC_CAPABILITY_COMPLETED_V2 && json.columns === COMPLETED_HEADERS_V2.length)) return none("completed_items_ack_unconfirmed");
    if (!Array.isArray(json.acks)) return none("no_acks");
    const keyOf = (o) => String(o.orderId).toLowerCase() + "|" + String(o.modifiedItemId).toLowerCase();
    const sentByKey = new Map(list.map((r) => [keyOf(r), r]));
    const lmSuspect = [];
    const review = [];
    const count = new Map();
    for (const a of json.acks) if (a && typeof a.orderId === "string" && typeof a.modifiedItemId === "string") count.set(keyOf(a), (count.get(keyOf(a)) || 0) + 1);
    const acked = [];
    for (const a of json.acks) {
      if (!a || typeof a.orderId !== "string" || typeof a.modifiedItemId !== "string") continue;
      const k = keyOf(a);
      const s = sentByKey.get(k);
      if (!s || count.get(k) !== 1 || a.orderUpdatedAt !== s.orderUpdatedAt || SYNC_ACK_STATUSES.indexOf(a.status) < 0) continue;
      const one = { orderId: s.orderId, modifiedItemId: s.modifiedItemId, orderUpdatedAt: s.orderUpdatedAt, revision: s.revision, status: a.status };
      if (lmMode) {
        if (typeof a.posStationId !== "string" || typeof a.orderCode !== "string") {
          lmSuspect.push({ orderId: s.orderId, modifiedItemId: s.modifiedItemId });
          continue;
        }
        const sentL = cell(s.posStationId);
        const sentM = cell(s.orderCode);
        const okLm = a.status === "appended" ? a.posStationId === sentL && a.orderCode === sentM : a.status === "updated" ? a.orderCode !== "" || sentM === "" : true;
        if (!okLm) {
          lmSuspect.push({ orderId: s.orderId, modifiedItemId: s.modifiedItemId });
          continue;
        }
        if (s.lmSuspect && ((a.posStationId === "" && sentL !== "") || (a.orderCode === "" && sentM !== ""))) {
          review.push({ orderId: s.orderId, modifiedItemId: s.modifiedItemId, revision: s.revision, error: "completed_items_lm_review" });
          continue;
        }
        one.sheetPosStationId = a.posStationId;
        one.sheetOrderCode = a.orderCode;
      }
      acked.push(one);
    }
    const ackedKeys = new Set(acked.map(keyOf));
    const rejected = [];
    for (const r of Array.isArray(json.rejected) ? json.rejected : []) {
      if (!r || typeof r.orderId !== "string" || typeof r.modifiedItemId !== "string") continue;
      const k = keyOf(r);
      const s = sentByKey.get(k);
      if (!s || ackedKeys.has(k) || rejected.some((x) => keyOf(x) === k)) continue;
      rejected.push({ orderId: s.orderId, modifiedItemId: s.modifiedItemId, revision: s.revision, error: String(r.error || "rejected").slice(0, 200) });
    }
    for (const r of review) if (!rejected.some((x) => keyOf(x) === keyOf(r))) rejected.push(r);
    const missing = list.length - acked.length - rejected.length;
    return { ok: true, error: lmSuspect.length > 0 ? "completed_items_lm_unverified" : missing > 0 ? "ack_missing" : null, acked, rejected, missing, lmSuspect };
  }
  // v0.7.2 (audit lại PM 04/10): đánh dấu bản ghi NGHI VẤN — phản hồi POST 13 trường không xác nhận hợp đồng / L:M lệch, nên một
  // lần ghi có thể đã để A:K trên Sheet mà thiếu L:M. Giữ mốc đầu tiên; chỉ một ACK đã đối chiếu thấy Sheet có L:M mới xoá.
  function markCompletedLmSuspect(existing, reason, nowIso) {
    if (!isCompletedRecord(existing) || existing.lmSuspect) return { record: existing, changed: false };
    return { record: Object.assign({}, existing, { lmSuspect: { at: nowIso, reason: String(reason || "unknown").slice(0, 80) } }), changed: true };
  }
  // Số dòng đang chờ người kiểm L:M trên Sheet (lỗi completed_items_lm_review).
  function completedLmReviewCount(records) {
    let n = 0;
    for (const r of records || []) if (completedSyncStatusOf(r) === "rejected" && r.syncError === "completed_items_lm_review") n += 1;
    return n;
  }
  // Áp ACK vào bản ghi MỚI NHẤT: chỉ khi bản ghi còn đúng phiên bản đã gửi (snapshot mới hơn tới giữa chừng → vẫn chờ).
  function applyCompletedAck(existing, ack, nowIso) {
    const same = { record: existing, changed: false };
    if (!isCompletedRecord(existing) || !ack || existing.orderUpdatedAt !== ack.orderUpdatedAt) return same;
    const rev = ack.revision;
    if (!Number.isInteger(rev) || rev < 1 || rev > existing.revision || rev <= syncedRevisionOf(existing)) return same;
    const next = Object.assign({}, existing, { syncedRevision: rev, syncedAt: nowIso });
    // v0.7.2: L:M thực tế của dòng trên Sheet theo ACK phong bì v5 (chỉ để đối chiếu / xuất JSON — không phải ô Sheet của
    // bản ghi, không đổi revision, không bao giờ dùng để gán trạm).
    // ACK đã đối chiếu (parseCompletedResponse chỉ cho dòng nghi vấn qua khi Sheet có L:M) → hết nghi vấn.
    if (typeof ack.sheetPosStationId === "string" && typeof ack.sheetOrderCode === "string") {
      Object.assign(next, { sheetPosStationId: ack.sheetPosStationId, sheetOrderCode: ack.sheetOrderCode });
      delete next.lmSuspect;
    }
    if (Number.isInteger(existing.syncErrorRevision) && existing.syncErrorRevision <= rev) {
      next.syncError = null;
      next.syncErrorRevision = null;
      next.syncErrorAt = null;
    }
    return { record: next, changed: true };
  }
  function applyCompletedRejection(existing, rejection, nowIso) {
    const same = { record: existing, changed: false };
    if (!isCompletedRecord(existing) || !rejection || rejection.revision !== existing.revision) return same;
    if (existing.syncErrorRevision === rejection.revision && existing.syncError === rejection.error) return same;
    return { record: Object.assign({}, existing, { syncError: rejection.error, syncErrorRevision: rejection.revision, syncErrorAt: nowIso }), changed: true };
  }

  // ---- Đồng bộ Google Sheet (0.2.0, Batch C) ----
  // Hàng chờ = chính các lượt có revision > syncedRevision; không có key hàng chờ riêng nên không có gì để lệch với
  // bản ghi. Chỉ lượt bán hàng của nhật ký chung: bản ghi trước 0.2.0 (không source) và chuyển hàng không lên Sheet.
  const SYNC_BATCH_MAX = 20; // = SheetUpsert.MAX_BATCH (tests/sync.test.js so hai hằng số)
  const SYNC_TIMEOUT_MS = 45000; // phải lớn hơn LOCK_WAIT_MS của Code.gs (10 s) cộng thời gian đọc chỉ mục và ghi
  const SYNC_ACK_STATUSES = Object.freeze(["appended", "updated", "skipped"]);
  // 0.4: phiên bản hợp đồng Sheet (33 cột). Apps Script PHẢI trả đúng số này; server cũ vẫn ACK nhưng bỏ 6 cột
  // mới, nên ACK không kèm schemaVersion 4 thì KHÔNG được coi là đã đồng bộ (= SheetUpsert.SCHEMA_VERSION).
  const SYNC_SCHEMA_VERSION = 5;
  // 0.5: phong bì v3 là phong bì ĐẦU TIÊN được phép mang lượt chuyển hàng. Apps Script vẫn nhận v1/v2
  // của các bản cũ nhưng chỉ coi chúng là lượt bán.
  const SYNC_ENVELOPE_VERSION = 3;
  // v0.7 Batch D: phong bì v4 (vẫn schemaVersion 5, vẫn 35 cột) = phong bì ĐẦU TIÊN được mang thao tác POS
  // (sale_order_action), kèm target "data". CHỈ gửi khi GET /exec báo capability SYNC_CAPABILITY_ACTIONS — Apps Script
  // chưa nâng cấp trả bad_envelope cho v4, nên thao tác được GIỮ trong hàng chờ, còn lượt bán / chuyển hàng vẫn đi v3.
  const SYNC_ENVELOPE_V4 = 4;
  const SYNC_TARGET_DATA = "data";
  const SYNC_CAPABILITY_ACTIONS = "data:sale_order_action";
  // v0.7.4: bản ghi trạng thái đơn chỉ gửi khi Web App báo capability này (Apps Script v0.7.4, phong bì v4). Chưa có → bản ghi
  // nằm chờ trên máy, lượt bán / chuyển hàng / thao tác vẫn đi.
  const SYNC_CAPABILITY_STATUSES = "data:sale_order_status";
  // Apps Script chưa có capability: chỉ còn thao tác chờ thì không GET lại mỗi phút — kiểm lại sau khoảng này (hoặc khi
  // người dùng bấm Đồng bộ lại / có lượt bán cần gửi).
  const SYNC_ACTION_RECHECK_MS = 10 * 60 * 1000;
  // Web App đã deploy: https://script.google.com/macros/s/<id>/exec. Không nhận /dev, không nhận host khác.
  const SHEET_ENDPOINT_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;

  function normalizeSheetEndpoint(value) {
    const s = typeof value === "string" ? value.trim() : "";
    return SHEET_ENDPOINT_RE.test(s) ? s : null;
  }

  // ---------- v0.7.10.2: tenant Nextwaves ----------
  // Mỗi tenant Nextwaves có máy chủ API riêng: trang https://<tenant>.nextwaves.app ↔ API https://api-<tenant>.nextwaves.app, và khoá API
  // chỉ hợp lệ trên máy chủ của tenant đã tạo nó (20/10/2026: khoá tạo ở circa.nextwaves.app gọi api-circa-medly → 401
  // INVALID_API_CREDENTIALS; gọi api-circa → 200). Mọi URL Nextwaves (rfid-core) viết với máy chủ mặc định; worker (nextwavesFetch, đường
  // gọi duy nhất) đổi phần máy chủ sang tenant đã cấu hình. Chưa cấu hình = mặc định circa-medly, đúng như mọi bản trước.
  const NEXTWAVES_DEFAULT_API_BASE = "https://api-circa-medly.nextwaves.app";
  const NEXTWAVES_HOST_RE = /^(?:api-)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.nextwaves\.app$/;
  function nextwavesBaseOfUrl(value) {
    let u;
    try {
      u = new URL(value);
    } catch (_) {
      return null;
    }
    if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
    const m = NEXTWAVES_HOST_RE.exec(u.hostname.toLowerCase());
    return m ? "https://api-" + m[1] + ".nextwaves.app" : null;
  }
  // "Mã cài đặt" của trang API access (Nextwaves Agent): nwc-agent://connect?api=<địa chỉ API>&key=<nwc_pk_…:nwc_sk_…>.
  // Trả { apiBase, token } khi có đủ hai phần hợp lệ; còn lại null.
  function parseNextwavesInstallCode(value) {
    const m = /^nwc-agent:\/\/connect\?(.*)$/i.exec(typeof value === "string" ? value.trim() : "");
    if (!m) return null;
    const q = new URLSearchParams(m[1]);
    const apiBase = nextwavesBaseOfUrl(String(q.get("api") || "").trim());
    const token = String(q.get("key") || "").trim();
    return apiBase && token ? { apiBase, token } : null;
  }
  // Nhận địa chỉ trang tenant (https://circa.nextwaves.app/vi/settings/api-access), địa chỉ API (https://api-circa.nextwaves.app), tên miền
  // không có https://, hoặc Mã cài đặt. Trả địa chỉ API chuẩn "https://api-<tenant>.nextwaves.app"; null khi rỗng / không phải https /
  // không phải tên miền *.nextwaves.app.
  function normalizeNextwavesTenant(value) {
    const s = typeof value === "string" ? value.trim() : "";
    if (!s) return null;
    const code = parseNextwavesInstallCode(s);
    if (code) return code.apiBase;
    return nextwavesBaseOfUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : "https://" + s);
  }
  // Máy chủ API đang dùng: giá trị đã lưu (chuẩn hoá) hoặc mặc định.
  function nextwavesApiBase(stored) {
    return normalizeNextwavesTenant(stored) || NEXTWAVES_DEFAULT_API_BASE;
  }
  // URL viết với máy chủ mặc định → cùng đường dẫn trên máy chủ `base`. URL khác giữ nguyên.
  function withNextwavesBase(url, base) {
    const u = String(url);
    const b = nextwavesApiBase(base);
    return u.startsWith(NEXTWAVES_DEFAULT_API_BASE + "/") ? b + u.slice(NEXTWAVES_DEFAULT_API_BASE.length) : u;
  }
  // Trừ tồn: máy chủ mà yêu cầu đóng băng của job đã (hoặc sẽ) được gửi tới. Job đóng băng trước v0.7.10.2 không ghi máy chủ — khi đó
  // chỉ có một máy chủ (mặc định), nên đó chính là nơi đã gửi.
  function notifyApiBaseOf(job) {
    const f = job && job.frozen;
    return (f && normalizeNextwavesTenant(f.apiBase)) || NEXTWAVES_DEFAULT_API_BASE;
  }

  function isSyncable(e) {
    return isSheetEvent(e) && isUuid(e.eventId) && isUuid(e.orderId) && Number.isInteger(e.revision) && e.revision >= 1;
  }

  function syncedRevisionOf(e) {
    const n = e ? e.syncedRevision : 0;
    return Number.isInteger(n) && n > 0 ? n : 0;
  }

  // "none": không lên Sheet (bản ghi cũ, chuyển hàng) · "station": lượt đã lưu nhưng chưa có mã trạm / số thứ tự
  // (0.4) · "synced": Sheet đã có đúng revision hiện tại · "rejected": Apps Script từ chối đúng revision hiện tại ·
  // "pending": chờ đồng bộ.
  function syncStatusOf(e) {
    if (!isSyncable(e)) return "none";
    if (!hasStation(e)) return "station";
    if (syncedRevisionOf(e) >= e.revision) return "synced";
    if (e.syncErrorRevision === e.revision) return "rejected";
    return "pending";
  }

  // Lô kế tiếp: lượt chờ lâu nhất trước (updatedAt), tối đa SYNC_BATCH_MAX. Lượt bị từ chối ở revision hiện tại chỉ
  // gửi lại khi revision đổi hoặc người dùng bấm "Đồng bộ lại" (includeRejected). exclude: "eventId:revision" đã gửi
  // trong lần chạy này — không gửi lại cùng một bản hai lần trong một lần chạy.
  // opts.actions === false: bỏ thao tác POS (Apps Script đang chạy chưa nhận được chúng) — chúng nằm lại hàng chờ.
  function selectSyncBatch(events, opts) {
    const o = opts || {};
    const max = Math.max(0, Math.min(Number(o.max) || SYNC_BATCH_MAX, SYNC_BATCH_MAX));
    const exclude = o.exclude || null;
    const list = [];
    for (const e of events || []) {
      const st = syncStatusOf(e);
      if (st !== "pending" && !(o.includeRejected && st === "rejected")) continue;
      if (exclude && exclude.has(e.eventId + ":" + e.revision)) continue;
      if (o.actions === false && isActionEvent(e)) continue;
      if (o.statuses === false && isStatusEvent(e)) continue;
      list.push(e);
    }
    list.sort((a, b) => String(a.updatedAt || "").localeCompare(String(b.updatedAt || "")) || String(a.eventId).localeCompare(String(b.eventId)));
    return list.slice(0, max);
  }

  // Thân POST: bản ghi ĐẦY ĐỦ của từng lượt (sheetRow), không bao giờ là bản vá.
  // opts.v4: Web App đã báo capability thao tác POS → phong bì v4 + target "data" cho MỌI lô (một đường gửi duy nhất).
  function syncEnvelope(events, extVersion, opts) {
    const records = (events || []).map(sheetRow);
    if (opts && opts.v4) return { v: SYNC_ENVELOPE_V4, schemaVersion: SYNC_SCHEMA_VERSION, target: SYNC_TARGET_DATA, extVersion: String(extVersion || ""), records };
    return { v: SYNC_ENVELOPE_VERSION, schemaVersion: SYNC_SCHEMA_VERSION, extVersion: String(extVersion || ""), records };
  }

  // Kết luận cho ĐÚNG lô đã gửi. Một lượt chỉ được coi là đã lên Sheet khi có đúng một ACK khớp eventId + revision
  // đã gửi + trạng thái appended/updated/skipped. ACK thiếu, sai revision, lặp, trạng thái lạ → lượt đó vẫn chờ.
  function parseSyncResponse(sent, json) {
    const none = (error) => ({ ok: false, error, acked: [], rejected: [], missing: (sent || []).length });
    if (!json || typeof json !== "object" || Array.isArray(json)) return none("bad_response");
    // Kiểm TRƯỚC mọi thứ khác: Apps Script cũ vẫn trả ok + acks nhưng chỉ ghi 27 cột. Tin ACK đó là mất 6 cột mới
    // vĩnh viễn (extension không gửi lại revision đã ACK).
    if (json.schemaVersion !== SYNC_SCHEMA_VERSION) return none("server_outdated");
    if (json.ok !== true) return none(typeof json.error === "string" && json.error ? json.error.slice(0, 200) : "not_ok");
    if (!Array.isArray(json.acks)) return none("no_acks");
    const sentRevision = new Map((sent || []).map((e) => [e.eventId, e.revision]));
    const ackCount = new Map();
    for (const a of json.acks) if (a && typeof a.eventId === "string") ackCount.set(a.eventId, (ackCount.get(a.eventId) || 0) + 1);
    const acked = [];
    for (const a of json.acks) {
      if (!a || !sentRevision.has(a.eventId) || ackCount.get(a.eventId) !== 1) continue;
      if (a.revision !== sentRevision.get(a.eventId) || SYNC_ACK_STATUSES.indexOf(a.status) < 0) continue;
      acked.push({ eventId: a.eventId, revision: a.revision, status: a.status, station: ackStationPair(a) });
    }
    const ackedIds = new Set(acked.map((a) => a.eventId));
    const rejected = [];
    for (const r of Array.isArray(json.rejected) ? json.rejected : []) {
      if (!r || !sentRevision.has(r.eventId) || ackedIds.has(r.eventId) || rejected.some((x) => x.eventId === r.eventId)) continue;
      rejected.push({ eventId: r.eventId, revision: sentRevision.get(r.eventId), error: String(r.error || "rejected").slice(0, 200) });
    }
    const missing = (sent || []).length - acked.length - rejected.length;
    return { ok: true, error: missing > 0 ? "ack_missing" : null, acked, rejected, missing };
  }

  // 0.4.0.1: kiểm Web App bằng GET /exec TRƯỚC mọi POST của một đợt đồng bộ. Kiểm schemaVersion ở ACK là quá muộn:
  // POST đã tới server, server cũ đã ghi 27 cột. Không đạt thì đợt đó gửi 0 POST và không đổi lượt nào.
  // headerState "empty" (tab data chưa có dòng tiêu đề, bước cài đặt mới trong apps-script/README.md) cũng cho qua:
  // chỉ Code.gs 0.4 tới được bước này, và nó ghi đủ 33 tiêu đề cùng lô đầu tiên.
  const PREFLIGHT_HEADER_STATES = Object.freeze(["ok", "legacy", "empty"]);
  function parseSchemaPreflight(json) {
    const fail = (error) => ({ ok: false, error });
    if (!json || typeof json !== "object" || Array.isArray(json)) return fail("bad_response");
    if (json.schemaVersion !== SYNC_SCHEMA_VERSION) return fail("server_outdated");
    if (json.ok !== true) return fail(typeof json.error === "string" && json.error ? json.error.slice(0, 200) : "not_ok");
    // Code.gs 0.4 trả dòng 1 THỰC TẾ đệm đủ 33 ô. Số khác là một bản script khác bản đã phát hành.
    if (!Array.isArray(json.headers) || json.headers.length !== SHEET_HEADERS.length) return fail("server_outdated");
    if (json.headerState === "mismatch") return fail("headers_mismatch");
    if (PREFLIGHT_HEADER_STATES.indexOf(json.headerState) < 0) return fail("server_outdated");
    // v0.7: capabilities do Code.gs v0.7 báo (Code.gs 0.5 không có trường này → danh sách rỗng, vẫn là server hợp lệ cho v3).
    const capabilities = Array.isArray(json.capabilities) ? json.capabilities.filter((c) => typeof c === "string" && c) : [];
    return { ok: true, headerState: json.headerState, capabilities };
  }
  // Web App này có nhận thao tác POS (phong bì v4, target data) không.
  function syncAllowsActions(pre) {
    return !!(pre && pre.ok === true && Array.isArray(pre.capabilities) && pre.capabilities.indexOf(SYNC_CAPABILITY_ACTIONS) >= 0);
  }
  // Web App này có nhận bản ghi trạng thái đơn không (cần CẢ phong bì v4 lẫn capability riêng).
  function syncAllowsStatuses(pre) {
    return syncAllowsActions(pre) && pre.capabilities.indexOf(SYNC_CAPABILITY_STATUSES) >= 0;
  }

  // 0.5: cặp trạm mà Apps Script báo là ĐANG nằm trên dòng Sheet. Chỉ nhận khi đủ CẢ HAI và cả hai hợp lệ —
  // thiếu một nửa, sai kiểu, số ≤ 0 hay mã trạm lạ thì bỏ qua cờ (không phải lỗi đồng bộ).
  function ackStationPair(a) {
    if (!a || typeof a !== "object") return null;
    const id = normalizeStationId(a.sheetStationId);
    const seq = a.sheetStationSequence;
    if (!id || !Number.isInteger(seq) || seq < 1) return null;
    return { sheetStationId: id, sheetStationSequence: seq };
  }

  // Áp một ACK vào bản ghi MỚI NHẤT (worker đọc lại dưới khoá của lượt). Chỉ đổi trường đồng bộ: không đè nội dung,
  // không tăng revision. ACK của revision cũ chỉ đánh dấu revision đó — revision mới hơn vẫn nằm trong hàng chờ.
  function applySyncAck(existing, ack, nowIso) {
    const same = { record: existing, changed: false };
    if (!isSyncable(existing) || !ack || ack.eventId !== existing.eventId) return same;
    const rev = ack.revision;
    if (!Number.isInteger(rev) || rev < 1 || rev > existing.revision) return same;
    let next = existing;
    // Cờ trạm đi kèm MỌI ACK khớp (kể cả "skipped"): dòng có thể đã thuộc trạm khác từ lần gửi trước.
    const st = ack.station;
    if (st && (existing.sheetStationId !== st.sheetStationId || existing.sheetStationSequence !== st.sheetStationSequence)) {
      next = Object.assign({}, next, st);
    }
    if (rev > syncedRevisionOf(existing)) {
      next = Object.assign({}, next, { syncedRevision: rev, syncedAt: nowIso });
      if (Number.isInteger(existing.syncErrorRevision) && existing.syncErrorRevision <= rev) {
        next.syncError = null;
        next.syncErrorRevision = null;
        next.syncErrorAt = null;
      }
    }
    return next === existing ? same : { record: next, changed: true };
  }

  // Apps Script từ chối bản ghi (dữ liệu sai hình dạng). Chỉ đánh dấu khi revision bị từ chối vẫn là revision hiện tại;
  // revision đã đổi thì bản mới sẽ được gửi, không treo lỗi của bản cũ.
  function applySyncRejection(existing, rejection, nowIso) {
    const same = { record: existing, changed: false };
    if (!isSyncable(existing) || !rejection || rejection.eventId !== existing.eventId || rejection.revision !== existing.revision) return same;
    if (existing.syncErrorRevision === rejection.revision && existing.syncError === rejection.error) return same;
    return { record: Object.assign({}, existing, { syncError: rejection.error, syncErrorRevision: rejection.revision, syncErrorAt: nowIso }), changed: true };
  }

  // Thử lại sau lỗi mạng / timeout / ACK sai: 5 s, 10 s, 20 s… tối đa 5 phút.
  function syncBackoffMs(failures) {
    const n = Math.max(1, Math.floor(Number(failures) || 1));
    return Math.min(5000 * Math.pow(2, n - 1), 5 * 60 * 1000);
  }

  // Đếm cho popup: lượt trên máy theo trạng thái đồng bộ.
  function syncCounts(events) {
    const c = { local: 0, pending: 0, synced: 0, rejected: 0, notSynced: 0, station: 0 };
    for (const e of events || []) {
      const st = syncStatusOf(e);
      if (st === "none") c.notSynced += 1;
      else {
        c.local += 1;
        c[st] += 1;
      }
    }
    return c;
  }

  // v0.8.0: bản ghi (lượt bán / chuyển hàng / thao tác POS / trạng thái đơn) CHƯA lên tab data lúc ngừng ghi tab data — chờ gửi,
  // chờ mã trạm / số thứ tự, hoặc bị Apps Script từ chối ở revision hiện tại. Ghi vào mốc v0.8.0 để popup báo; không gửi nữa.
  function dataUnsyncedSummary(events) {
    const c = syncCounts(events);
    let oldestAt = null;
    for (const e of events || []) {
      const st = syncStatusOf(e);
      if (st !== "pending" && st !== "station" && st !== "rejected") continue;
      const at = textOrNull(e.scannedAt);
      if (at && (!oldestAt || at < oldestAt)) oldestAt = at;
    }
    return { pending: c.pending, station: c.station, rejected: c.rejected, total: c.pending + c.station + c.rejected, oldestAt };
  }
  function isDataBacklog(e) {
    const st = syncStatusOf(e);
    return st === "pending" || st === "station" || st === "rejected";
  }

  // v0.8.0.1 (PM audit gói v0.8.0, P1): hàng chờ pend:* còn trên máy lúc ngừng ghi tab data — ĐẾM RIÊNG với dataUnsyncedSummary, không cộng:
  // mục hàng chờ có thể thuộc đúng bản ghi ev: đã đếm ở đó (alsoInDataUnsynced). Mục lượt / thao tác (ev, evu, act, item) giữ eventId, mọi mục giữ
  // khoá — sau khi worker dọn hàng chờ, dataStopPendingStatus đếm được bản ghi được ghi / sửa trên máy từ chúng mà không lên tab data.
  const DATA_STOP_PEND_LIST_MAX = 2000;
  const PEND_EVENT_PREFIXES = Object.freeze([KEYS.pendEvent, KEYS.pendEventUpdate, KEYS.pendAction, KEYS.pendItem]);
  function pendingAtStopSummary(all) {
    const raw = all || {};
    const byType = {};
    const keys = [];
    const ids = new Set();
    const overlap = new Set();
    for (const key of Object.keys(raw).sort()) {
      if (!pendOpOf(key)) continue;
      const t = key.split(":")[1];
      byType[t] = (byType[t] || 0) + 1;
      keys.push(key);
      const v = raw[key];
      if (!PEND_EVENT_PREFIXES.some((p) => key.startsWith(p)) || !v || typeof v.eventId !== "string" || !v.eventId) continue;
      if (isDataBacklog(raw[KEYS.event + v.eventId])) overlap.add(v.eventId);
      else ids.add(v.eventId);
    }
    const eventIds = [...ids];
    return {
      total: keys.length,
      byType,
      events: eventIds.length,
      alsoInDataUnsynced: overlap.size,
      keys: keys.slice(0, DATA_STOP_PEND_LIST_MAX),
      eventIds: eventIds.slice(0, DATA_STOP_PEND_LIST_MAX),
      truncated: keys.length > DATA_STOP_PEND_LIST_MAX || eventIds.length > DATA_STOP_PEND_LIST_MAX,
    };
  }
  // Trạng thái HIỆN TẠI của hàng chờ lúc ngừng (tính từ kho, không ghi gì — worker khởi động lại không làm sai): còn bao nhiêu mục chưa xử lý; khi đã
  // hết, bao nhiêu bản ghi lượt / thao tác (ngoài số đã tính ở dataUnsynced) đang nằm trên máy mà không lên tab data, bao nhiêu mục không thành bản ghi.
  function dataStopPendingStatus(marker, all) {
    const p = marker && marker.pendingAtStop;
    if (!p || typeof p !== "object" || !Array.isArray(p.keys)) return null;
    const raw = all || {};
    const remaining = p.keys.filter((k) => raw[k] !== undefined).length;
    let written = 0;
    let absent = 0;
    for (const id of Array.isArray(p.eventIds) ? p.eventIds : []) {
      const e = raw[KEYS.event + id];
      if (!e) absent += 1;
      else if (isDataBacklog(e)) written += 1;
    }
    return { total: Number(p.total) || 0, remaining, done: remaining === 0, written, absent, alsoInDataUnsynced: Number(p.alsoInDataUnsynced) || 0, truncated: !!p.truncated };
  }
  const PEND_TYPE_LABELS = Object.freeze({ ev: "lượt quét", evu: "cập nhật lượt RFID", act: "thao tác POS", ord: "đơn", qr: "mã QR", item: "dòng hàng" });
  // Dòng popup về mốc ngừng ghi tab data: (1) bản ghi ev: chưa lên tab data và (2) hàng chờ chưa xử lý — hai số riêng, kèm trạng thái (2) hiện tại.
  function dataStopNotice(marker, all) {
    if (!marker || typeof marker.at !== "string") return null;
    const a = marker.dataUnsynced || {};
    const aTotal = Number(a.total) || 0;
    const p = marker.pendingAtStop;
    const parts = [];
    parts.push(
      aTotal
        ? "(1) " + aTotal + " bản ghi trên máy chưa lên tab data (chờ gửi " + (a.pending || 0) + " · chờ số trạm " + (a.station || 0) + " · bị từ chối " + (a.rejected || 0) + ")"
        : "(1) 0 bản ghi chưa lên tab data"
    );
    const st = dataStopPendingStatus(marker, all);
    if (!st) parts.push("(2) mốc này không ghi hàng chờ trên máy (bản ứng viên trước v0.8.0.1)");
    else if (!st.total) parts.push("(2) 0 mục hàng chờ trên máy");
    else {
      const types = Object.keys(PEND_TYPE_LABELS)
        .filter((t) => p.byType && p.byType[t])
        .map((t) => p.byType[t] + " " + PEND_TYPE_LABELS[t]);
      let s = "(2) " + st.total + " mục hàng chờ trên máy chưa xử lý (" + types.join(" · ") + ")";
      if (st.alsoInDataUnsynced) s += ", trong đó " + st.alsoInDataUnsynced + " thuộc bản ghi đã tính ở (1) — không cộng hai số";
      if (!st.done) s += ". Hàng chờ (2) hiện còn " + st.remaining + " mục chưa xử lý — worker đang xử lý";
      else {
        s += ". Hàng chờ (2) hiện đã xử lý hết: " + st.written + " bản ghi lượt / thao tác được ghi hoặc sửa trên máy sau mốc, không lên tab data (ngoài số ở (1))";
        if (st.absent) s += " · " + st.absent + " mục không thành bản ghi (sai định dạng / lượt đã xoá)";
      }
      if (st.truncated) s += " (mốc chỉ giữ danh sách " + DATA_STOP_PEND_LIST_MAX + " mục đầu — số còn lại / đã ghi chỉ tính trên danh sách đó)";
      parts.push(s);
    }
    const bad = aTotal > 0 || !!(st && st.total > 0);
    return {
      bad,
      text: "Lúc nâng cấp v" + (marker.version || "?") + " (" + formatLocal(marker.at) + "): " + parts.join("; ") + "." + (bad ? " Không gửi nữa — vẫn nằm trên máy và trong file xuất JSON." : ""),
    };
  }

  // ---- 0.6: pilot trừ tồn Nextwaves (POST /api/v1/public/orders/sync) ----
  // Ba bất biến của tính năng này, mọi lần sửa sau phải giữ:
  //   1. Job CHỈ ghi khoá stockout:<orderId>. Không lượt nào tăng revision → không dòng Sheet nào bị
  //      đồng bộ lại vì trừ tồn.
  //   2. Job ĐỌC ord:/ev: nhưng KHÔNG giữ khoá của chúng. Thay đổi xen giữa bị phát hiện SAU bằng so
  //      bằng chứng (stockoutEvidence → conflict), không chặn TRƯỚC bằng khoá.
  //   3. payload tính đúng MỘT lần rồi ghi storage; mọi lần gửi lại dùng nguyên văn bản đã ghi.
  //      /orders/sync idempotent theo externalOrderId (đã xác minh) nên gửi lại là an toàn.
  const NEXTWAVES_MEDLY_WAREHOUSE_ID = "1c06123b-9781-4950-b01a-62e749b02d64";
  const STOCKOUT_ORDER_TYPE = "OFFLINE";
  const STOCKOUT_ALLOWLIST_MAX = 1; // pilot: đúng một đơn
  const STOCKOUT_MAX_ATTEMPTS = 8;
  // Chờ tra EPC tối đa, tính từ completedDate. Hết hạn thì đóng băng với phần chưa tra được ghi rõ là
  // bỏ qua: đơn đã xong thì không ai quét thêm nữa, thà trừ thiếu (người bù tay) còn hơn treo im lặng.
  const STOCKOUT_WAIT_MAX_MS = 30 * 60 * 1000;

  // Chuẩn hoá đơn vị để SO KHỚP (không phải để hiển thị): NFC → chữ thường → NFC lại (toLowerCase có
  // thể phá chuẩn hoá ở vài ký tự) → gộp mọi khoảng trắng (\s của JS đã gồm NBSP; POS có dán đơn vị
  // kèm NBSP) → cắt hai đầu. KHÔNG bỏ dấu: "hop" và "hộp" là hai đơn vị khác nhau, bỏ dấu là tự tạo
  // ra trùng khớp giả.
  function normalizeUnit(v) {
    if (typeof v !== "string") return null;
    const s = v.normalize("NFC").toLowerCase().normalize("NFC").replace(/\s+/g, " ").trim();
    return s || null;
  }

  // Fail-closed: danh sách rỗng, hoặc bất kỳ phần tử nào không chuẩn hoá được → KHÔNG coi là trùng khớp.
  // Thiếu dữ liệu không bao giờ được biến thành "giống nhau".
  function unitsAgree(list) {
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) return false;
    let first = null;
    for (const v of arr) {
      const u = normalizeUnit(v);
      if (!u) return false;
      if (first === null) first = u;
      else if (u !== first) return false;
    }
    return true;
  }

  // EPC chặt: chuỗi hex, độ dài chẵn, trả về chữ hoa. Bản sao luật của rfid-core.strictEpc — core.js
  // KHÔNG được phụ thuộc rfid-core.js (popup.html chỉ nạp core.js). tests/stockout.test.js đối chứng
  // hai bộ trên cùng một bảng đầu vào để chúng không trôi lệch nhau.
  function normalizeEpcStrict(value) {
    return typeof value === "string" && /^[0-9A-Fa-f]+$/.test(value) && value.length % 2 === 0 ? value.toUpperCase() : null;
  }

  // Re-audit 0.6.0.1 (P1): cờ `enabled` một mình KHÔNG đủ để gửi. Phải kèm "phiếu duyệt" gắn chặt với
  // CHÍNH bản xem thử đã đóng băng — cùng đơn, cùng mốc đóng băng, cùng số gửi/bỏ qua. Nhờ vậy:
  //   - cấu hình `enabled:true` còn sót từ bản 0.6.0 (chưa có khái niệm phiếu duyệt) KHÔNG gửi được;
  //   - đang bật cho đơn A rồi đổi ô ID sang đơn B mà vẫn để tick: phiếu duyệt của A không khớp B;
  //   - bản xem thử được tính lại (mốc đóng băng mới) thì phiếu duyệt cũ hết hiệu lực.
  // Người duyệt là người đã nhìn thấy đúng hai con số đó trên màn hình, nên phiếu duyệt là bằng chứng
  // duy nhất có thể kiểm được ở phía worker.
  function normalizeStockoutApproval(raw, orderIds) {
    const a = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
    if (!a) return null;
    const orderId = typeof a.orderId === "string" ? a.orderId.trim().toLowerCase() : "";
    const frozenAt = typeof a.frozenAt === "string" && a.frozenAt.trim() ? a.frozenAt.trim() : "";
    const send = Number.isInteger(a.send) ? a.send : -1;
    const skip = Number.isInteger(a.skip) ? a.skip : -1;
    if (!isUuid(orderId) || !frozenAt || send < 1 || skip < 0) return null;
    // Duyệt cho đơn không còn trong allowlist thì coi như không có: đổi đơn là phải duyệt lại.
    if (Array.isArray(orderIds) && orderIds.indexOf(orderId) < 0) return null;
    return { orderId, frozenAt, send, skip };
  }

  // Cấu hình pilot do người vận hành nhập trong popup. Fail-closed ở mọi bước: chỉ đúng true mới là bật
  // (chuỗi "true" hay số 1 đều thành false), chỉ UUID mới vào allowlist, tối đa một đơn.
  function normalizeStockoutPilot(raw) {
    const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const ids = [];
    for (const v of Array.isArray(o.orderIds) ? o.orderIds : []) {
      const id = typeof v === "string" ? v.trim().toLowerCase() : "";
      if (isUuid(id) && ids.indexOf(id) < 0) ids.push(id);
    }
    const orderIds = ids.slice(0, STOCKOUT_ALLOWLIST_MAX);
    return { enabled: o.enabled === true, orderIds, approval: normalizeStockoutApproval(o.approval, orderIds) };
  }

  // Cổng CUỐI trước khi POST, do worker gọi. Popup có thể bị bỏ qua (cấu hình cũ, sửa tay storage,
  // đổi đơn khi đang bật) nên quyết định gửi hay không KHÔNG được dựa vào việc popup đã kiểm hộ.
  function stockoutApproved(job, pilot) {
    const p = normalizeStockoutPilot(pilot);
    if (!p.enabled) return { ok: false, reason: "disabled" };
    if (!p.approval) return { ok: false, reason: "no_approval" };
    if (!job || !job.payload || !job.frozenAt) return { ok: false, reason: "no_preview" };
    const id = String(job.orderId || "").toLowerCase();
    if (p.approval.orderId !== id) return { ok: false, reason: "approval_other_order" };
    if (p.approval.frozenAt !== job.frozenAt) return { ok: false, reason: "approval_stale" };
    if (String(job.payload.externalOrderId || "").toLowerCase() !== id) return { ok: false, reason: "payload_mismatch" };
    const send = Array.isArray(job.payload.items) ? job.payload.items.length : 0;
    const skip = Array.isArray(job.skipped) ? job.skipped.length : 0;
    if (p.approval.send !== send || p.approval.skip !== skip) return { ok: false, reason: "approval_counts" };
    return { ok: true, reason: null };
  }

  // Phiếu duyệt dựng từ chính job đang hiện trên màn hình. Popup gọi hàm này thay vì tự ghép object,
  // để hai bên (popup dựng, worker kiểm) không bao giờ hiểu khác nhau về "duyệt cái gì".
  function stockoutApprovalFor(job) {
    if (!job || !job.payload || !job.frozenAt || !isUuid(String(job.orderId || "").toLowerCase())) return null;
    return {
      orderId: String(job.orderId).toLowerCase(),
      frozenAt: job.frozenAt,
      send: Array.isArray(job.payload.items) ? job.payload.items.length : 0,
      skip: Array.isArray(job.skipped) ? job.skipped.length : 0,
    };
  }

  // Cổng nghiệp vụ. CỐ Ý không xét pilot.enabled: cờ tắt vẫn phải chạy tới bước xem thử (tính danh sách
  // gửi/bỏ qua rồi dừng, không POST). Thứ tự kiểm cố định, lý do đầu tiên thắng.
  // Dùng ord.orderType (loại đơn ở CẤP ĐƠN, 0.6) — KHÔNG phải event.orderType (cấp lượt, từ POST /item,
  // đã nằm trên Sheet). Hai trường trùng tên, ở hai loại bản ghi khác nhau.
  function stockoutGate(ord, pilot) {
    const p = normalizeStockoutPilot(pilot);
    const o = ord && typeof ord === "object" ? ord : null;
    if (!o || !isUuid(String(o.orderId || "").toLowerCase())) return { ok: false, reason: "no_order" };
    if (recordTypeOf(o) !== RECORD_TYPE.SALE_ORDER) return { ok: false, reason: "record_type" };
    if (p.orderIds.indexOf(String(o.orderId).toLowerCase()) < 0) return { ok: false, reason: "not_in_allowlist" };
    if (String(o.orderType || "").trim().toUpperCase() !== STOCKOUT_ORDER_TYPE) return { ok: false, reason: "order_type" };
    if (o.status !== ORDER_COMPLETED) return { ok: false, reason: "order_not_completed" };
    if (!textOrNull(o.completedDate)) return { ok: false, reason: "no_completed_date" };
    return { ok: true, reason: null };
  }

  // GET /api/v1/public/tags/{epc} — CÁC TRƯỜNG LỒNG NHAU (xác minh bằng lời gọi thật 24/09/2026).
  // Response KHÔNG có top-level externalProductId / unit / warehouseId: đọc chúng là đọc undefined, tức
  // là tự bịa ra dữ liệu. Đây là CỬA DUY NHẤT đọc JSON của tag, không nơi nào khác được chạm vào.
  // Đơn vị của tem: unitConversion.variantUnit khi có unitConversion, thiếu hẳn unitConversion thì lùi về
  // product.baseUnitOfMeasure (hai tem "chai" của đơn pilot rơi vào nhánh lùi này). Có unitConversion mà
  // thiếu variantUnit là response sai hình dạng, KHÔNG phải cái cớ để lùi — lùi sai là so sai đơn vị.
  // unitQuantity và unitConversion.ratio CỐ Ý bị bỏ qua: pilot trừ theo tem, không quy đổi.
  function parseNextwavesTag(json, expectedEpc) {
    if (!json || typeof json !== "object" || Array.isArray(json)) return { ok: false, reason: "bad_response" };
    const trimmed = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const idText = (v) => (typeof v === "number" && Number.isFinite(v) ? String(v) : trimmed(v));
    const wrapped = !("epc" in json) && json.data && typeof json.data === "object" && !Array.isArray(json.data);
    const d = wrapped ? json.data : json;
    const epc = normalizeEpcStrict(d.epc);
    if (!epc) return { ok: false, reason: "tag_contract:epc" };
    if (epc !== normalizeEpcStrict(expectedEpc)) return { ok: false, reason: "epc_mismatch", epc };
    const status = trimmed(d.status);
    if (!status) return { ok: false, reason: "tag_contract:status", epc };
    const unitUid = trimmed(d.unitUid);
    if (!unitUid) return { ok: false, reason: "tag_contract:unitUid", epc };
    const homeWarehouseId = trimmed(d.homeWarehouseId);
    if (!homeWarehouseId) return { ok: false, reason: "tag_contract:homeWarehouseId", epc };
    const product = d.product && typeof d.product === "object" && !Array.isArray(d.product) ? d.product : null;
    if (!product) return { ok: false, reason: "tag_contract:product", epc };
    const externalProductId = idText(product.externalProductId);
    if (!externalProductId) return { ok: false, reason: "tag_contract:product.externalProductId", epc };
    const baseUnitOfMeasure = trimmed(product.baseUnitOfMeasure);
    if (!baseUnitOfMeasure) return { ok: false, reason: "tag_contract:product.baseUnitOfMeasure", epc };
    const conv = d.unitConversion && typeof d.unitConversion === "object" && !Array.isArray(d.unitConversion) ? d.unitConversion : null;
    const variantUnit = conv ? trimmed(conv.variantUnit) : null;
    if (conv && !variantUnit) return { ok: false, reason: "tag_contract:unitConversion.variantUnit", epc };
    return { ok: true, epc, status, unitUid, homeWarehouseId, externalProductId, baseUnitOfMeasure, variantUnit, unit: variantUnit || baseUnitOfMeasure };
  }

  // Lượt chưa có EPC nhưng CÒN cơ hội tra ra (đang chờ hoặc lỗi mà chưa hết lượt thử). Dùng chính
  // lookupWanted của bộ tra UID → EPC, bỏ qua backoff: ở đây chỉ hỏi "còn cơ hội không", không phải
  // "đến giờ tra chưa". Lượt RFID không có EPC thì không bao giờ có (EPC do reader đọc lúc tạo).
  function stockoutMayResolveEpc(e) {
    return lookupWanted(e, 0, { ignoreBackoff: true });
  }

  // Gộp lượt QR và RFID của cùng một đơn theo EPC: một tem có thể vừa được reader đọc vừa được quét QR.
  // Hai lượt đưa hai giá trị KHÁC nhau và cùng khác rỗng → conflict (không đoán bên nào đúng). Một bên
  // rỗng một bên có → lấy bên có: lượt RFID thường không bắt được POST /item nên thiếu dòng hàng.
  //   candidates — tem tra được EPC, sẵn sàng tiền kiểm;
  //   unresolved — lượt sẽ KHÔNG bao giờ có EPC (chưa map / map nhiều / hết lượt thử) → phải hiện rõ
  //                trên màn xem thử là "bỏ qua", không được lặng lẽ biến mất;
  //   notReady   — lượt còn cơ hội có EPC → job đứng ở waiting cho tới khi hết hoặc quá hạn chờ.
  function stockoutCandidates(ord, events) {
    const orderId = ord && ord.orderId ? String(ord.orderId) : "";
    const list = (Array.isArray(events) ? events : []).filter((e) => isLogEvent(e) && String(e.orderId) === orderId);
    const byEpc = new Map();
    const pending = new Map();
    const notReady = [];
    const merge = (c, key, value) => {
      if (value === null || value === undefined || value === "") return;
      if (c[key] === null) c[key] = value;
      else if (c[key] !== value && !c.conflict) c.conflict = key;
    };
    for (const e of list) {
      const epc = normalizeEpcStrict(e.epc);
      const uid = textOrNull(e.uid) || textOrNull(e.qrCode);
      if (!epc) {
        const key = uid || String(e.eventId || "");
        const slot = pending.get(key) || { uid, eventIds: [], mayResolve: false };
        slot.eventIds.push(e.eventId);
        if (stockoutMayResolveEpc(e)) {
          slot.mayResolve = true;
          notReady.push(e.eventId);
        }
        pending.set(key, slot);
        continue;
      }
      const c = byEpc.get(epc) || { epc, eventIds: [], uid: null, uids: [], tagUid: null, productId: null, unit: null, itemId: null, conflict: null };
      c.eventIds.push(e.eventId);
      // 0.6.0.5 — DANH TÍNH TEM là `tagUid` = resolvedUid || uid, KHÔNG phải mã đã quét.
      //   · lượt QR mã CHA: `uid` là mã in trên hộp, `resolvedUid` mới là UID tem con (bộ generation 0.3);
      //   · lượt RFID của chính tem đó: `uid` đã là UID tem con, không có resolvedUid.
      // Hai lượt đó cùng chỉ vào một tem nên phải gộp làm MỘT ứng viên. Gộp theo `uid` như trước sẽ coi
      // "mã cha ≠ mã con" là xung đột và bỏ qua oan một tem hợp lệ.
      merge(c, "tagUid", textOrNull(e.resolvedUid) || uid);
      // Mã đã quét giữ riêng: chỉ dùng để tìm dòng hàng POS (POS lưu đúng mã người ta quét), không bao
      // giờ dùng làm danh tính tem.
      if (uid && c.uids.indexOf(uid) < 0) c.uids.push(uid);
      if (!c.uid) c.uid = uid;
      merge(c, "productId", e.productId === null || e.productId === undefined || e.productId === "" ? null : String(e.productId));
      merge(c, "unit", textOrNull(e.modifiedUnit));
      merge(c, "itemId", textOrNull(e.modifiedItemId));
      byEpc.set(epc, c);
    }
    const candidates = Array.from(byEpc.values()).sort((a, b) => a.epc.localeCompare(b.epc));
    const all = Array.from(pending.values()).sort((a, b) => String(a.uid || "").localeCompare(String(b.uid || "")));
    return { candidates, unresolved: all.filter((p) => !p.mayResolve), pending: all, notReady };
  }

  // 0.6: dòng hàng POS của một lượt. Ưu tiên modifiedItemId — danh tính dòng do chính POS trả về lúc
  // thêm hàng — vì đơn pilot có quantity trống nhưng modifiedItemId đủ; không có thì lùi về khớp UID
  // (qrCode + qrCodes) đúng như bộ 0.2.2 vẫn làm. Đúng một dòng khớp mới nhận.
  function orderItemFor(ord, cand) {
    const o = ord && typeof ord === "object" ? ord : null;
    if (!o || o.status !== ORDER_COMPLETED) return { item: null, reason: "order_not_completed" };
    const items = (Array.isArray(o.posItems) ? o.posItems : []).filter((it) => it && typeof it === "object");
    const c = cand && typeof cand === "object" ? cand : {};
    const itemId = textOrNull(c.itemId);
    if (itemId) {
      const hits = items.filter((it) => textOrNull(it.itemId) === itemId);
      if (hits.length === 1) return { item: hits[0], reason: null };
      if (hits.length > 1) return { item: null, reason: "pos_item_ambiguous" };
    }
    // Đường lùi: khớp theo MÃ ĐÃ QUÉT (POS lưu đúng mã người vận hành quét — có thể là mã cha). Một tem
    // có thể được ghi nhận bằng nhiều mã khác nhau (quét QR mã cha rồi đọc RFID), nên thử tất cả.
    const uids = (Array.isArray(c.uids) && c.uids.length ? c.uids : [c.uid]).filter((u) => typeof u === "string" && u);
    if (!uids.length) return { item: null, reason: "pos_item_not_found" };
    const hits = [];
    for (const it of items) {
      const codes = new Set();
      if (typeof it.qrCode === "string" && it.qrCode) codes.add(it.qrCode);
      for (const q of Array.isArray(it.qrCodes) ? it.qrCodes : []) if (typeof q === "string" && q) codes.add(q);
      if (uids.some((u) => codes.has(u))) hits.push(it);
    }
    if (hits.length === 1) return { item: hits[0], reason: null };
    return { item: null, reason: hits.length > 1 ? "pos_item_ambiguous" : "pos_item_not_found" };
  }

  const STOCKOUT_SKIP_REASONS = Object.freeze([
    "candidate_conflict",
    "tag_contract_error",
    "tag_not_active",
    "warehouse_mismatch",
    "uid_mismatch",
    "product_mismatch",
    "pos_item_not_found",
    "pos_item_ambiguous",
    "unit_unknown",
    "unit_mismatch",
    "epc_unresolved",
  ]);
  const STOCKOUT_SKIP_LABELS = Object.freeze({
    candidate_conflict: "Hai lượt quét cùng tem nhưng dữ liệu lệch nhau",
    tag_contract_error: "Nextwaves trả dữ liệu tem sai hình dạng",
    tag_not_active: "Tem không ở trạng thái active",
    warehouse_mismatch: "Tem thuộc kho khác",
    uid_mismatch: "UID trên tem khác UID đã quét",
    product_mismatch: "Sản phẩm của tem khác sản phẩm đã quét",
    pos_item_not_found: "Không tìm được dòng hàng POS",
    pos_item_ambiguous: "Khớp nhiều dòng hàng POS",
    unit_unknown: "Thiếu đơn vị để đối chiếu",
    unit_mismatch: "Đơn vị không trùng nhau",
    epc_unresolved: "Chưa tra được EPC của mã này",
  });

  // Tiền kiểm một tem. Thứ tự cố định, lý do đầu tiên thắng — để màn xem thử và test luôn ra cùng một
  // kết luận cho cùng một dữ liệu. Đơn vị: tem và lượt quét (modifiedUnit) là BẮT BUỘC; đơn vị của dòng
  // hàng POS chỉ tham gia khi có, vì đơn pilot có dòng thiếu trường này.
  function stockoutItemVerdict(cand, tag, ord) {
    const c = cand && typeof cand === "object" ? cand : {};
    const base = {
      epc: normalizeEpcStrict(c.epc),
      uid: textOrNull(c.uid),
      eventIds: Array.isArray(c.eventIds) ? c.eventIds.slice() : [],
    };
    const no = (reason, detail) => Object.assign({ ok: false, reason, detail: detail || null }, base);
    if (c.conflict) return no("candidate_conflict", c.conflict);
    if (!tag || tag.ok !== true) return no("tag_contract_error", (tag && tag.reason) || "bad_response");
    if (String(tag.status).trim().toLowerCase() !== "active") return no("tag_not_active", tag.status);
    if (tag.homeWarehouseId !== NEXTWAVES_MEDLY_WAREHOUSE_ID) return no("warehouse_mismatch", tag.homeWarehouseId);
    // UID tem phải khớp CHÍNH XÁC đúng MỘT giá trị: `tagUid` (= resolvedUid nếu có, ngược lại mã đã quét).
    // KHÔNG chấp nhận "khớp mã cha hoặc mã con": đã tra ra tem con mà Nextwaves lại trả UID mã cha thì đó
    // là dữ liệu mâu thuẫn, phải dừng chứ không phải trừ tồn.
    const expected = textOrNull(c.tagUid);
    if (!expected || tag.unitUid !== expected) return no("uid_mismatch", tag.unitUid);
    const productId = c.productId === null || c.productId === undefined || c.productId === "" ? null : String(c.productId).trim();
    if (!productId || productId !== tag.externalProductId) return no("product_mismatch", tag.externalProductId);
    const found = orderItemFor(ord, c);
    if (!found.item) return no(found.reason === "pos_item_ambiguous" ? "pos_item_ambiguous" : "pos_item_not_found", found.reason);
    const tagUnit = normalizeUnit(tag.unit);
    const scanUnit = normalizeUnit(c.unit);
    if (!tagUnit || !scanUnit) return no("unit_unknown", tagUnit ? "modifiedUnit" : "tag");
    const posUnit = normalizeUnit(found.item.unit);
    const units = posUnit ? [tagUnit, scanUnit, posUnit] : [tagUnit, scanUnit];
    if (!unitsAgree(units)) return no("unit_mismatch", units.join(" / "));
    return Object.assign({ ok: true, reason: null, productId, unit: scanUnit, posItemId: textOrNull(found.item.itemId), tagUid: expected }, base);
  }

  // Payload /orders/sync. externalOrderId = ORDER ID (UUID) của POS: đây là khoá idempotent của
  // Nextwaves nên nó phải cố định theo đơn và được đóng băng cùng payload; mã DHC chỉ đi vào notes.
  // items CHỈ mang epc — không quantity, không unitPrice, không productId (pilot trừ theo tem).
  function stockoutPayload(ord, items) {
    const o = ord && typeof ord === "object" ? ord : {};
    const list = [];
    for (const it of Array.isArray(items) ? items : []) {
      const epc = normalizeEpcStrict(it && it.epc);
      if (epc) list.push({ epc });
    }
    const code = textOrNull(o.orderCode);
    return {
      externalOrderId: String(o.orderId || ""),
      warehouseId: NEXTWAVES_MEDLY_WAREHOUSE_ID,
      items: list,
      payments: [],
      notes: code ? "Circa POS " + code : "Circa POS",
    };
  }

  // Ảnh chụp phần dữ liệu đơn mà payload phụ thuộc vào; so bằng isChanged để phát hiện đơn đã đổi sau
  // khi đóng băng (→ conflict). CỐ Ý không gồm updatedDate/observedAt: POS tick mốc liên tục trong khi
  // nội dung không đổi, đưa chúng vào sẽ biến mọi lần đồng bộ đơn thành một xung đột giả.
  function stockoutEvidence(ord, candidates) {
    const o = ord && typeof ord === "object" ? ord : {};
    const items = [];
    for (const c of Array.isArray(candidates) ? candidates : []) {
      const epc = normalizeEpcStrict(c && c.epc);
      if (!epc) continue;
      items.push({
        epc,
        // Danh tính tem + mọi mã đã quét ra nó: đổi bất kỳ thứ nào cũng là đổi cái đang trừ.
        tagUid: textOrNull(c.tagUid),
        uids: (Array.isArray(c.uids) ? c.uids.slice() : [c.uid]).filter(Boolean).sort(),
        productId: c.productId === null || c.productId === undefined || c.productId === "" ? null : String(c.productId),
        unit: normalizeUnit(c.unit),
        itemId: textOrNull(c.itemId),
      });
    }
    items.sort((a, b) => a.epc.localeCompare(b.epc));
    return { orderStatus: textOrNull(o.status), completedAt: textOrNull(o.completedDate), items };
  }

  // Ghép tất cả lại: ứng viên + kết quả tra tem → danh sách gửi / bỏ qua + payload + bằng chứng.
  // Đây chính là nội dung màn xem thử, và cũng là thứ được đóng băng khi bật cờ. tags: Map hoặc object
  // theo EPC → kết quả parseNextwavesTag.
  // opts.includeNotReady: đã hết hạn chờ tra EPC → cả lượt "còn cơ hội" cũng phải hiện ra là bỏ qua,
  // không được lặng lẽ biến mất khỏi màn xem thử chỉ vì về lý thuyết chúng còn tra được.
  function stockoutPlanFor(ord, events, tags, opts) {
    const parts = stockoutCandidates(ord, events);
    const candidates = parts.candidates;
    const unresolved = opts && opts.includeNotReady ? parts.pending : parts.unresolved;
    const get = (epc) => (tags instanceof Map ? tags.get(epc) : tags && typeof tags === "object" ? tags[epc] : null);
    const items = [];
    const skipped = [];
    for (const c of candidates) {
      const v = stockoutItemVerdict(c, get(c.epc), ord);
      if (v.ok) items.push({ epc: v.epc, uid: v.uid, tagUid: v.tagUid, productId: v.productId, unit: v.unit, posItemId: v.posItemId, eventIds: v.eventIds });
      else skipped.push({ epc: v.epc, uid: v.uid, eventIds: v.eventIds, reason: v.reason, detail: v.detail });
    }
    for (const u of unresolved) skipped.push({ epc: null, uid: u.uid, eventIds: u.eventIds.slice(), reason: "epc_unresolved", detail: null });
    return { payload: stockoutPayload(ord, items), items, skipped, evidence: stockoutEvidence(ord, candidates) };
  }

  // ---- Response của POST /orders/sync ----
  const ORDERS_SYNC_ID_FIELDS = Object.freeze(["id", "orderId", "code", "orderCode"]);

  // CHƯA CÓ FIXTURE THẬT cho created:true / created:false (đang chờ nhà cung cấp trả lời). Khẳng định
  // DUY NHẤT dám đưa ra hôm nay: hợp đồng đã xác minh nói response có cờ `created` kiểu boolean. Tên
  // trường định danh đơn thì CHƯA biết → chỉ lấy nếu có, không bắt buộc, không đoán thêm. Khi có fixture
  // thật: sửa ĐÚNG hàm này, phần định tuyến theo status không phải đụng vào. Không nới parser cho xanh.
  function ordersSyncCreatedFlag(d) {
    if (!d || typeof d !== "object" || Array.isArray(d)) return { ok: false, reason: "contract:bad_body" };
    if (typeof d.created !== "boolean") return { ok: false, reason: "contract:no_created" };
    let orderRef = null;
    for (const f of ORDERS_SYNC_ID_FIELDS) {
      const v = d[f];
      const t = typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "string" && v.trim() ? v.trim() : null;
      if (t) {
        orderRef = t;
        break;
      }
    }
    return { ok: true, created: d.created, orderRef };
  }

  // Định tuyến theo HTTP status là phần ỔN ĐỊNH, tách khỏi phần khẳng định nội dung 2xx ở trên.
  //   auth     — 401/403: chờ đổi token, không tiêu lượt thử.
  //   rejected — 400: Nextwaves từ chối về nghiệp vụ (đã thấy CART_EMPTY thật). KHÔNG thử lại: gửi lại
  //              y hệt cũng bị từ chối y hệt, chỉ tốn lượt và che mất việc cần người xem.
  //   infra    — 429/5xx/mã lạ/mạng: thử lại giãn dần, hết lượt thì chuyển người xem.
  //   contract — 2xx nhưng sai hợp đồng: dừng, giữ nguyên response để đối chiếu.
  function nextwavesSyncVerdict(status, json, payload) {
    const code = Number(status) || 0;
    const sample = smallPlainOrNull(json);
    const message = json && typeof json === "object" && typeof json.message === "string" ? json.message.trim() : "";
    if (code === 401 || code === 403) return { ok: false, kind: "auth", status: code, reason: "auth", message, sample };
    if (code >= 200 && code < 300) {
      const wrapped =
        json && typeof json === "object" && !("created" in json) && json.data && typeof json.data === "object" && !Array.isArray(json.data);
      const d = wrapped ? json.data : json;
      const want = payload && payload.externalOrderId ? String(payload.externalOrderId) : "";
      const got = d && typeof d === "object" && typeof d.externalOrderId === "string" ? d.externalOrderId.trim() : "";
      if (want && got && got !== want) {
        return { ok: false, kind: "contract", status: code, reason: "contract:external_order_id_mismatch", message, sample };
      }
      const flag = ordersSyncCreatedFlag(d);
      if (!flag.ok) return { ok: false, kind: "contract", status: code, reason: flag.reason, message, sample };
      return { ok: true, kind: "ok", status: code, created: flag.created, orderRef: flag.orderRef, sample };
    }
    if (code === 400) return { ok: false, kind: "rejected", status: code, reason: "rejected:" + (message || code), message, sample };
    return { ok: false, kind: "infra", status: code, reason: "infra:" + (code || "network"), message, sample };
  }

  // ---- Máy trạng thái của job trừ tồn ----
  const STOCKOUT_STATE = Object.freeze({
    WAITING: "waiting",
    RESOLVING: "resolving",
    READY: "ready",
    SUBMITTING: "submitting",
    RETRY_WAIT: "retry_wait",
    SYNCED: "synced",
    MANUAL_REVIEW: "manual_review",
    CONFLICT: "conflict",
    AUTH_REQUIRED: "auth_required",
  });
  const STOCKOUT_TERMINAL = Object.freeze([STOCKOUT_STATE.SYNCED, STOCKOUT_STATE.MANUAL_REVIEW, STOCKOUT_STATE.CONFLICT]);
  const STOCKOUT_STATE_LABELS = Object.freeze({
    waiting: "Đang chờ tra EPC",
    resolving: "Đang tra tem trên Nextwaves",
    ready: "Đã tính xong, chờ gửi",
    submitting: "Đang gửi",
    retry_wait: "Gửi lỗi tạm, chờ gửi lại",
    synced: "Đã trừ tồn",
    manual_review: "Cần người kiểm tra",
    conflict: "Đơn đã đổi sau khi tính, cần tính lại",
    auth_required: "Cần token Nextwaves",
  });
  // retry_wait dành riêng cho giai đoạn SAU khi đã đóng băng ("còn payload, chờ gửi lại"); lỗi tạm lúc
  // đang tra tem giữ nguyên resolving. Nhìn state là biết đã có payload hay chưa, không cần trường phụ.
  const STOCKOUT_BACKOFF_MS = Object.freeze([30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000]);
  function stockoutBackoffMs(attempts) {
    const n = Math.max(1, Math.floor(Number(attempts) || 1));
    return STOCKOUT_BACKOFF_MS[Math.min(n, STOCKOUT_BACKOFF_MS.length) - 1];
  }

  function stockoutDue(job, nowMs) {
    if (!job) return false;
    const next = job.nextAt ? parseTime(job.nextAt) : null;
    return next === null || next <= (Number(nowMs) || 0);
  }

  function newStockoutJob(ord, nowIso, extVersion) {
    const o = ord && typeof ord === "object" ? ord : {};
    return {
      orderId: String(o.orderId || ""),
      orderCode: textOrNull(o.orderCode),
      extVersion: textOrNull(extVersion),
      state: STOCKOUT_STATE.WAITING,
      reason: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      gate: { orderType: textOrNull(o.orderType), orderStatus: textOrNull(o.status), completedDate: textOrNull(o.completedDate) },
      frozenAt: null,
      payload: null,
      items: [],
      skipped: [],
      evidence: null,
      attempts: 0,
      nextAt: null,
      lastError: null,
      lastAttemptAt: null,
      postedAt: null,
      response: null,
    };
  }

  // Hết hạn chờ tra EPC: tính từ completedDate của đơn (mốc do POS ghi), không phải từ lúc tạo job —
  // job có thể được tạo rất lâu sau khi đơn xong (ví dụ cài bản mới cho một đơn đã COMPLETED).
  function stockoutWaitExpired(job, ord, nowMs) {
    const base = parseTime((ord && ord.completedDate) || (job && job.createdAt) || null);
    if (base === null) return false;
    return (Number(nowMs) || 0) - base >= STOCKOUT_WAIT_MAX_MS;
  }

  // Đóng băng MỘT lần. Đã có payload thì đây là no-op: mọi lần gửi lại dùng nguyên văn bản đã ghi, kể cả
  // sau khi worker chết giữa lúc POST. Không dòng nào gửi được → manual_review, KHÔNG bao giờ POST giỏ
  // rỗng (Nextwaves trả 400 CART_EMPTY — đã có fixture thật).
  function stockoutFreeze(job, plan, nowIso) {
    const j = Object.assign({}, job);
    if (j.payload) return { job: j, changed: false };
    const p = plan || {};
    j.payload = p.payload || null;
    j.items = Array.isArray(p.items) ? p.items : [];
    j.skipped = Array.isArray(p.skipped) ? p.skipped : [];
    j.evidence = p.evidence || null;
    j.frozenAt = nowIso;
    j.attempts = 0;
    j.nextAt = null;
    j.lastError = null;
    if (j.payload && Array.isArray(j.payload.items) && j.payload.items.length) {
      j.state = STOCKOUT_STATE.READY;
      j.reason = null;
    } else {
      j.state = STOCKOUT_STATE.MANUAL_REVIEW;
      j.reason = "no_items";
    }
    j.updatedAt = nowIso;
    return { job: j, changed: true };
  }

  function stockoutSignature(j) {
    const x = j || {};
    return { state: x.state, reason: x.reason, attempts: x.attempts, nextAt: x.nextAt, payload: x.payload, response: x.response };
  }

  function applyStockoutVerdict(job, verdict, nowIso, nowMs) {
    const j = Object.assign({}, job);
    const v = verdict || {};
    j.lastAttemptAt = nowIso;
    if (v.ok === true) {
      j.state = STOCKOUT_STATE.SYNCED;
      j.reason = null;
      j.lastError = null;
      j.nextAt = null;
      j.postedAt = nowIso;
      j.response = { status: v.status || 200, created: v.created === true, orderRef: v.orderRef || null, sample: v.sample || null };
    } else if (v.kind === "auth") {
      j.state = STOCKOUT_STATE.AUTH_REQUIRED;
      j.reason = "auth";
      j.lastError = v.message || v.reason || "auth";
      j.nextAt = null;
    } else if (v.kind === "rejected" || v.kind === "contract") {
      j.state = STOCKOUT_STATE.MANUAL_REVIEW;
      j.reason = v.reason || v.kind;
      j.lastError = v.message || v.reason || null;
      j.nextAt = null;
      j.response = { status: v.status || 0, created: null, orderRef: null, sample: v.sample || null };
    } else {
      j.attempts = (Number(j.attempts) || 0) + 1;
      j.lastError = v.reason || v.message || "infra";
      if (j.attempts >= STOCKOUT_MAX_ATTEMPTS) {
        j.state = STOCKOUT_STATE.MANUAL_REVIEW;
        j.reason = "infra_exhausted";
        j.nextAt = null;
      } else {
        j.state = j.payload ? STOCKOUT_STATE.RETRY_WAIT : STOCKOUT_STATE.RESOLVING;
        j.reason = "infra";
        j.nextAt = new Date((Number(nowMs) || 0) + stockoutBackoffMs(j.attempts)).toISOString();
      }
    }
    j.updatedAt = nowIso;
    return { job: j, changed: isChanged(stockoutSignature(job), stockoutSignature(j)) };
  }

  // Worker khởi động lại giữa lúc POST: không lời gọi nào còn giữ job. Gửi lại nguyên văn payload là an
  // toàn (idempotent theo externalOrderId) và cũng là cách duy nhất biết lần trước có tới nơi hay không.
  function stockoutRecover(job, nowIso) {
    if (!job || job.state !== STOCKOUT_STATE.SUBMITTING) return { job, changed: false };
    const j = Object.assign({}, job, { state: STOCKOUT_STATE.RETRY_WAIT, reason: "restart", nextAt: null, updatedAt: nowIso });
    return { job: j, changed: true };
  }

  // Đổi token: mở lại job đang kẹt vì xác thực, về đúng chặng dở dang (đã đóng băng thì chờ gửi).
  function stockoutAfterToken(job, nowIso) {
    if (!job || job.state !== STOCKOUT_STATE.AUTH_REQUIRED) return { job, changed: false };
    const j = Object.assign({}, job, {
      state: job.payload ? STOCKOUT_STATE.READY : STOCKOUT_STATE.RESOLVING,
      reason: null,
      nextAt: null,
      updatedAt: nowIso,
    });
    return { job: j, changed: true };
  }

  // Re-audit 0.6.0 (P1): CHỈ được bật gửi thật khi đã có bản xem thử đóng băng của ĐÚNG đơn đó.
  // Không bao giờ để người dùng bật "rồi tính sau" — bật cùng lúc với lúc nhập ID đơn là thao tác
  // dễ nhất và cũng là thao tác nguy hiểm nhất: nó cho phép trừ tồn mà chưa ai nhìn thấy danh sách.
  // Hàm thuần để popup không tự nghĩ ra luật riêng, và để test/mutation canh được.
  const STOCKOUT_ENABLE_LABELS = Object.freeze({
    no_order_id: "Chưa nhập ID đơn hợp lệ",
    no_job: "Chưa có bản xem thử cho đơn này — lưu ID đơn, đợi tới một phút rồi Làm mới",
    no_preview: "Bản xem thử chưa tính xong — đợi tới một phút rồi Làm mới",
    payload_mismatch: "Bản xem thử thuộc đơn khác",
    no_items: "Không tem nào đủ điều kiện gửi",
    already_synced: "Đơn này đã trừ tồn xong",
    not_ready: "Bản xem thử chưa ở trạng thái sẵn sàng gửi",
    // Lý do worker từ chối gửi dù cờ đang bật (stockoutApproved).
    disabled: "Chưa bật gửi thật",
    no_approval: "Chưa duyệt bản xem thử — mở mục cấu hình pilot và lưu lại để duyệt",
    approval_other_order: "Phiếu duyệt thuộc đơn khác",
    approval_stale: "Bản xem thử đã được tính lại — cần duyệt lại",
    approval_counts: "Số tem gửi/bỏ qua đã đổi so với lúc duyệt — cần duyệt lại",
  });

  function stockoutEnableVerdict(job, orderId) {
    const id = typeof orderId === "string" ? orderId.trim().toLowerCase() : "";
    const send = job && job.payload && Array.isArray(job.payload.items) ? job.payload.items.length : 0;
    const skip = job && Array.isArray(job.skipped) ? job.skipped.length : 0;
    const no = (reason) => ({ ok: false, reason, send, skip });
    if (!isUuid(id)) return no("no_order_id");
    if (!job || String(job.orderId || "").toLowerCase() !== id) return no("no_job");
    if (job.state === STOCKOUT_STATE.SYNCED) return no("already_synced");
    if (!job.payload || !job.frozenAt) return no("no_preview");
    if (String(job.payload.externalOrderId || "").toLowerCase() !== id) return no("payload_mismatch");
    if (send < 1) return no("no_items");
    if (job.state !== STOCKOUT_STATE.READY) return no("not_ready");
    return { ok: true, reason: null, send, skip };
  }

  // Re-audit 0.6.0 (P2): đường phục hồi duy nhất cho job đã hết lượt thử vì lỗi hạ tầng. Giữ NGUYÊN
  // payload và externalOrderId đã đóng băng (nên vẫn idempotent), chỉ đặt lại bộ đếm và lịch chờ.
  // KHÔNG mở lại job bị Nextwaves từ chối, sai hợp đồng, hay đơn đã đổi — những thứ đó cần người xem.
  function stockoutReopen(job, nowIso) {
    const reopenable = job && job.state === STOCKOUT_STATE.MANUAL_REVIEW && job.reason === "infra_exhausted" && job.payload;
    if (!reopenable) return { job, changed: false };
    const j = Object.assign({}, job, {
      state: STOCKOUT_STATE.RETRY_WAIT,
      reason: "reopened",
      attempts: 0,
      nextAt: null,
      lastError: null,
      updatedAt: nowIso,
    });
    return { job: j, changed: true };
  }

  function stockoutCounts(jobs) {
    const c = { jobs: 0, send: 0, skip: 0, synced: 0, attention: 0 };
    for (const j of jobs || []) {
      if (!j) continue;
      c.jobs += 1;
      c.send += j.payload && Array.isArray(j.payload.items) ? j.payload.items.length : 0;
      c.skip += Array.isArray(j.skipped) ? j.skipped.length : 0;
      if (j.state === STOCKOUT_STATE.SYNCED) c.synced += 1;
      if (j.state === STOCKOUT_STATE.MANUAL_REVIEW || j.state === STOCKOUT_STATE.CONFLICT || j.state === STOCKOUT_STATE.AUTH_REQUIRED) {
        c.attention += 1;
      }
    }
    return c;
  }

  // ---- Hàng chờ ghi bền: mục được ghi vào "spill" (localStorage) TRƯỚC khi gửi, chỉ xoá đúng mục đó khi có ACK.
  // Mỗi mục một key riêng: nhiều tab cùng origin không ghi đè hàng chờ của nhau; tab nào cũng có thể gửi lại
  // mục còn sót của tab khác đã đóng (ghi phía worker idempotent theo khoá).
  // transport(item) -> Promise<{ ok, error?, fatal? }>. fatal = ngừng thử (ví dụ extension vừa được nạp lại,
  // content script cũ không còn nói chuyện được với service worker; dữ liệu chờ ở spill tới khi F5).
  function memorySpill() {
    const items = new Map();
    return {
      // Không bền qua đóng tab: migration không được xoá nguồn cũ khi chỉ ghi được vào đây.
      persistent: false,
      readAll() {
        const out = {};
        for (const [k, v] of items) out[k] = v;
        return out;
      },
      put(key, item) {
        items.set(key, item);
        return true;
      },
      remove(key) {
        items.delete(key);
        return true;
      },
    };
  }

  function storageSpill(storage, prefix) {
    return {
      persistent: true,
      readAll() {
        const out = {};
        try {
          const keys = [];
          for (let i = 0; i < storage.length; i++) {
            const k = storage.key(i);
            if (k && k.startsWith(prefix)) keys.push(k);
          }
          for (const k of keys) {
            try {
              const v = JSON.parse(storage.getItem(k));
              if (v && typeof v === "object") out[k.slice(prefix.length)] = v;
            } catch (_) {
              /* mục hỏng: bỏ qua, không đụng tới các mục khác */
            }
          }
        } catch (_) {
          /* localStorage bị chặn */
        }
        return out;
      },
      put(key, item) {
        try {
          storage.setItem(prefix + key, JSON.stringify(item));
          return true;
        } catch (_) {
          return false; // đầy quota / bị chặn: phía gọi phải báo "chưa tạo được bản lưu tạm"
        }
      },
      remove(key) {
        try {
          storage.removeItem(prefix + key);
          return true;
        } catch (_) {
          return false;
        }
      },
    };
  }

  // v0.7.4 (sự cố DHC01242317, 06/10/2026): extension được nạp lại (cập nhật) mà tab POS CHƯA tải lại → content script cũ
  // "mồ côi": chrome.runtime / chrome.storage ném "Extension context invalidated", mọi lượt / response tab đó bắt được trước
  // đây chỉ còn trong bộ nhớ tab và mất khi F5. Bản lưu tạm BỀN: ghi chrome.storage.local (pend:*) như cũ; ghi không được thì
  // ghi localStorage của trang (cùng origin POS, CÒN qua F5) dưới ORPHAN_SPILL_PREFIX + <tiền tố pend> + <khoá hàng chờ>.
  // Sau F5, content script MỚI chuyển các mục đó về đúng pend:* (migrateLegacyOutbox, giữ nguyên khoá → chạy lại không nhân
  // đôi) rồi nhờ worker ghi; worker chống trùng theo eventId / requestId như mọi lần gửi lại.
  const ORPHAN_SPILL_PREFIX = "circa-qr-orphan:v1:";
  function durableSpill(primary, fallback) {
    const tryPut = async (spill, key, item) => {
      if (!spill) return false;
      try {
        return (await spill.put(key, item)) === true;
      } catch (_) {
        return false;
      }
    };
    return {
      persistent: true,
      primary: primary || null,
      fallback: fallback || null,
      async readAll() {
        try {
          return primary ? (await primary.readAll()) || {} : {};
        } catch (_) {
          return {};
        }
      },
      async put(key, item) {
        if (await tryPut(primary, key, item)) return true;
        return tryPut(fallback, key, item);
      },
      async remove(key) {
        let ok = false;
        for (const s of [primary, fallback]) {
          if (!s) continue;
          try {
            ok = (await s.remove(key)) === true || ok;
          } catch (_) {
            /* bỏ qua */
          }
        }
        return ok;
      },
    };
  }

  // Bản lưu tạm trong chrome.storage.local. Các hàm trả Promise; SaveQueue luôn await nên
  // dùng chung được với hai bản đồng bộ ở trên.
  function chromeStorageSpill(area, prefix) {
    const call = (fn, arg) =>
      new Promise((resolve, reject) => {
        try {
          fn.call(area, arg, (v) => {
            const err = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError;
            if (err) reject(new Error(err.message));
            else resolve(v);
          });
        } catch (e) {
          reject(e);
        }
      });
    return {
      persistent: true,
      async readAll() {
        const out = {};
        try {
          const all = await call(area.get, null);
          for (const [k, v] of Object.entries(all || {})) {
            if (k.startsWith(prefix) && v && typeof v === "object") out[k.slice(prefix.length)] = v;
          }
        } catch (_) {
          /* extension context mất: coi như không có hàng chờ cũ */
        }
        return out;
      },
      async put(key, item) {
        try {
          await call(area.set, { [prefix + key]: item });
          return true;
        } catch (_) {
          return false;
        }
      },
      async remove(key) {
        try {
          await call(area.remove, prefix + key);
          return true;
        } catch (_) {
          return false;
        }
      },
    };
  }

  // Chuyển hàng chờ của các bản cũ (localStorage) sang kho mới (chrome.storage.local).
  // Hai quy tắc bắt buộc:
  //  1. Chỉ xoá nguồn cũ SAU KHI kho mới xác nhận ghi xong. Ghi lỗi => giữ nguyên nguồn cũ.
  //  2. Chạy lại phải idempotent: khoá mục giữ đúng như bản cũ nên ghi hai lần vẫn ra một mục.
  // plan.perItem:   [{ prefix, spill }]                 — bản v0.1.2–v0.1.4, mỗi mục một key
  // plan.aggregate: [{ key, spill, keyOf(item, k) }]    — bản v0.1.1, gom mọi mục trong một key
  async function migrateLegacyOutbox(storage, plan) {
    const summary = { movedItems: 0, removedKeys: 0, keptKeys: 0, failed: 0 };
    if (!storage || !plan) return summary;

    const listKeys = (prefix) => {
      const out = [];
      try {
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          if (k && k.startsWith(prefix)) out.push(k);
        }
      } catch (_) {
        /* localStorage bị chặn */
      }
      return out;
    };
    const readJson = (k) => {
      try {
        const raw = storage.getItem(k);
        return raw ? JSON.parse(raw) : null;
      } catch (_) {
        return undefined; // phân biệt "không đọc/parse được" với "không có"
      }
    };
    const removeKey = (k) => {
      try {
        storage.removeItem(k);
        summary.removedKeys++;
      } catch (_) {
        summary.keptKeys++;
      }
    };
    const put = async (spill, key, item) => {
      try {
        return (await spill.put(key, item)) === true;
      } catch (_) {
        return false;
      }
    };

    for (const entry of plan.perItem || []) {
      // Kho mới không bền (context mất, chỉ còn bộ nhớ) => tuyệt đối không đụng vào nguồn cũ.
      if (!entry || !entry.spill || entry.spill.persistent !== true) continue;
      for (const k of listKeys(entry.prefix)) {
        const item = readJson(k);
        if (!item || typeof item !== "object") {
          summary.keptKeys++; // mục hỏng: giữ lại, không tự xoá dữ liệu không đọc được
          continue;
        }
        const key = k.slice(entry.prefix.length); // giữ nguyên khoá cũ => chạy lại không nhân đôi
        if (await put(entry.spill, key, item)) {
          summary.movedItems++;
          removeKey(k);
        } else {
          summary.failed++;
          summary.keptKeys++;
        }
      }
    }

    for (const entry of plan.aggregate || []) {
      if (!entry || !entry.spill || entry.spill.persistent !== true) continue;
      const obj = readJson(entry.key);
      if (obj === null || obj === undefined) {
        if (obj === undefined) summary.keptKeys++;
        continue;
      }
      if (typeof obj !== "object") {
        summary.keptKeys++;
        continue;
      }
      const items = Object.entries(obj);
      if (!items.length) {
        removeKey(entry.key);
        continue;
      }
      let allOk = true;
      for (const [legacyKey, item] of items) {
        if (!item || typeof item !== "object") {
          allOk = false;
          continue;
        }
        const key = typeof entry.keyOf === "function" ? entry.keyOf(item, legacyKey) : legacyKey;
        if (await put(entry.spill, key, item)) summary.movedItems++;
        else {
          allOk = false;
          summary.failed++;
        }
      }
      // Một mục lỗi => giữ nguyên cả key tổng để lần sau thử lại toàn bộ.
      if (allOk) removeKey(entry.key);
      else summary.keptKeys++;
    }
    return summary;
  }

  class SaveQueue {
    constructor(opts) {
      const o = opts || {};
      this.keyOf = o.keyOf || ((item) => item.eventId);
      this.spill = o.spill || memorySpill();
      this.transport = o.transport;
      this.schedule = o.schedule || ((fn, ms) => setTimeout(fn, ms));
      this.onChange = o.onChange || (() => {});
      this.backoffMs = o.backoffMs || [300, 600, 1200, 2400, 4800, 10000];
      this.pending = new Map(); // key -> { item, version, attempts, inFlight, restored, spilled, lastError }
      this.stopped = false;
      this.lastSpillFailed = false; // lần ghi bản lưu tạm gần nhất thất bại (localStorage đầy/bị chặn)
    }

    get size() {
      return this.pending.size;
    }

    // Số mục đang chờ mà KHÔNG có bản lưu tạm (mất nếu tab đóng trước khi ACK).
    // v0.7.4: các mục đang chờ KHÔNG có bản lưu tạm (mất nếu tab tải lại / đóng) — để tab mồ côi liệt kê cho người dùng ghi lại.
    unspilledItems() {
      const out = [];
      for (const e of this.pending.values()) if (!e.spilled) out.push(e.item);
      return out;
    }

    get unspilledCount() {
      let n = 0;
      for (const e of this.pending.values()) if (!e.spilled) n++;
      return n;
    }

    // Quét lại spill: nhận mọi mục chưa có trong bộ nhớ (của tab này lần trước, hoặc của tab khác đã đóng).
    // Không ghi lại, không xoá mục nào ở đây.
    async restore() {
      let items = {};
      try {
        items = (await this.spill.readAll()) || {};
      } catch (_) {
        items = {};
      }
      let n = 0;
      for (const [key, item] of Object.entries(items)) {
        if (this.pending.has(key) || !item || typeof item !== "object") continue;
        this.pending.set(key, { item, version: 1, attempts: 0, inFlight: false, restored: true, spilled: true, lastError: null });
        n++;
      }
      return n;
    }

    async enqueue(item) {
      const key = this.keyOf(item);
      let entry = this.pending.get(key);
      if (entry) {
        // Cùng khoá: giữ bản mới nhất và tăng version; ACK của bản đang bay sẽ không xoá được bản này.
        entry.item = item;
        entry.version += 1;
        entry.restored = false;
      } else {
        entry = { item, version: 1, attempts: 0, inFlight: false, restored: false, spilled: false, lastError: null };
        this.pending.set(key, entry);
      }
      // Ghi bản lưu tạm TRƯỚC khi gửi: tab/trình duyệt chết giữa chừng thì lần sau vẫn gửi lại được.
      entry.spilled = await this._spill(key, item);
      if (!entry.spilled) this.onChange({ type: "spill_failed", key, item });
      if (entry.inFlight) return false;
      return this.attempt(key);
    }

    async _spill(key, item) {
      let ok = false;
      try {
        ok = (await this.spill.put(key, item)) === true;
      } catch (_) {
        ok = false;
      }
      this.lastSpillFailed = !ok;
      return ok;
    }

    async attempt(key) {
      const entry = this.pending.get(key);
      if (!entry || entry.inFlight || this.stopped) return false;
      entry.inFlight = true;
      const sentVersion = entry.version;
      let res;
      try {
        res = await this.transport(entry.item);
      } catch (e) {
        res = { ok: false, error: e && e.message ? e.message : String(e), fatal: !!(e && e.fatal) };
      }
      entry.inFlight = false;
      if (res && res.ok) {
        if (entry.version !== sentVersion) {
          // Bản mới hơn vào trong lúc gửi: ACK này chỉ xác nhận bản cũ. Giữ mục, gửi tiếp bản mới.
          this.onChange({ type: "superseded", key, item: entry.item });
          return this.attempt(key);
        }
        this.pending.delete(key);
        try {
          await this.spill.remove(key);
        } catch (_) {
          /* bỏ qua */
        }
        this.onChange({ type: "saved", key, item: entry.item, restored: entry.restored, response: res });
        return true;
      }
      entry.attempts += 1;
      entry.lastError = (res && res.error) || "unknown";
      // Worker từ chối vì dữ liệu sai định dạng ("invalid_…"): gửi lại bao nhiêu lần cũng không ghi được.
      // Bỏ khỏi hàng chờ để không treo cảnh báo "chưa lưu" mãi; lượt quét hợp lệ không bao giờ rơi vào nhánh này
      // vì đã được kiểm tra trước khi đưa vào hàng chờ.
      if (res && /^invalid/.test(String(res.error || "")) && entry.version === sentVersion) {
        this.pending.delete(key);
        try {
          await this.spill.remove(key);
        } catch (_) {
          /* bỏ qua */
        }
        this.onChange({ type: "discarded", key, item: entry.item, error: entry.lastError });
        return false;
      }
      this.onChange({ type: "failed", key, item: entry.item, error: entry.lastError, attempts: entry.attempts, fatal: !!(res && res.fatal) });
      if (res && res.fatal) {
        this.stopped = true;
        return false;
      }
      const delay = this.backoffMs[Math.min(entry.attempts - 1, this.backoffMs.length - 1)];
      this.schedule(() => this.attempt(key), delay);
      return false;
    }

    retryAll() {
      if (this.stopped) return 0;
      let n = 0;
      for (const [key, entry] of this.pending) {
        if (!entry.inFlight) {
          n++;
          this.attempt(key);
        }
      }
      return n;
    }

    list() {
      return [...this.pending.values()].map((e) => ({ item: e.item, attempts: e.attempts, lastError: e.lastError, spilled: e.spilled }));
    }
  }

  // ---- Xuất CSV (chỉ để xem nhanh; Excel mở trực tiếp sẽ đổi kiểu mã toàn chữ số) ----
  function csvEscape(v) {
    const s = v === null || v === undefined ? "" : String(v);
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function toCsv(columns, rows) {
    const lines = [columns.map((c) => csvEscape(c.label)).join(",")];
    for (const row of rows) lines.push(columns.map((c) => csvEscape(row[c.key])).join(","));
    return "﻿" + lines.join("\r\n") + "\r\n";
  }

  // ---- Xuất Excel (.xlsx) ----
  // Excel tự đổi chuỗi toàn chữ số thành số và chỉ giữ 15 chữ số, nên mã QR như 17589432884030116
  // bị làm tròn khi mở CSV. File .xlsx ghi mọi ô dưới dạng chữ (inline string, định dạng "@"),
  // Excel mở ra giữ nguyên. Không dùng thư viện: gói zip kiểu "store" (không nén) tự viết.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function zipStore(files, date) {
    const enc = new TextEncoder();
    const d = date instanceof Date && !Number.isNaN(d0(date)) ? date : new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const dosDate = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
      const crc = crc32(data);
      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      local.set(name, 30);
      chunks.push(local, data);

      const cd = new Uint8Array(46 + name.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      cd.set(name, 46);
      central.push(cd);
      offset += local.length + data.length;
    }
    const cdSize = central.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    const out = new Uint8Array(offset + cdSize + end.length);
    let p = 0;
    for (const c of chunks) {
      out.set(c, p);
      p += c.length;
    }
    for (const c of central) {
      out.set(c, p);
      p += c.length;
    }
    out.set(end, p);
    return out;
  }

  function d0(date) {
    return date.getTime();
  }

  // Bỏ ký tự XML 1.0 không cho phép (ký tự điều khiển), rồi thoát ký tự đặc biệt.
  function xmlText(v) {
    return String(v)
      .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function columnName(index) {
    let n = index + 1;
    let s = "";
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function cellValue(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "boolean") return v ? "true" : "false";
    return String(v);
  }

  function buildXlsx(columns, rows, opts) {
    const o = opts || {};
    const sheetName = xmlText(String(o.sheetName || "Sheet1").replace(/[\[\]:*?\/\\]/g, " ").slice(0, 31));
    const widths = columns.map((c) => {
      let w = String(c.label).length;
      for (let i = 0; i < rows.length && i < 500; i++) w = Math.max(w, cellValue(rows[i][c.key]).length);
      return Math.min(60, Math.max(10, w + 2));
    });
    const lines = [];
    const header = columns.map((c, i) => `<c r="${columnName(i)}1" t="inlineStr" s="1"><is><t xml:space="preserve">${xmlText(c.label)}</t></is></c>`).join("");
    lines.push(`<row r="1">${header}</row>`);
    rows.forEach((row, ri) => {
      const r = ri + 2;
      const cells = columns
        .map((c, i) => {
          const v = cellValue(row[c.key]);
          if (v === "") return "";
          return `<c r="${columnName(i)}${r}" t="inlineStr" s="2"><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`;
        })
        .join("");
      lines.push(`<row r="${r}">${cells}</row>`);
    });
    const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const sheet =
      XML +
      `<worksheet xmlns="${NS}" xmlns:r="${REL}">` +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      "<cols>" +
      widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("") +
      "</cols>" +
      `<sheetData>${lines.join("")}</sheetData>` +
      "</worksheet>";
    const styles =
      XML +
      `<styleSheet xmlns="${NS}">` +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>' +
      '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      "</styleSheet>";
    const workbook = XML + `<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
    const workbookRels =
      XML +
      `<Relationships xmlns="${PKG}">` +
      `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/>` +
      "</Relationships>";
    const rootRels = XML + `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
    const contentTypes =
      XML +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      "</Types>";
    return zipStore(
      [
        { name: "[Content_Types].xml", data: contentTypes },
        { name: "_rels/.rels", data: rootRels },
        { name: "xl/workbook.xml", data: workbook },
        { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
        { name: "xl/styles.xml", data: styles },
        { name: "xl/worksheets/sheet1.xml", data: sheet },
      ],
      o.date
    );
  }

  const EXPORT_COLUMNS = Object.freeze([
    { key: "recordTypeLabel", label: "Loại chứng từ" },
    { key: "orderCode", label: "Mã chứng từ" },
    { key: "orderId", label: "ID chứng từ (URL)" },
    { key: "qrRaw", label: "Mã QR (nguyên văn)" },
    { key: "qrCode", label: "Mã trích (đoạn cuối URL)" },
    { key: "source", label: "Nguồn (qr/rfid)" },
    { key: "action", label: "Thao tác (scan/readd/item_quantity_set/item_delete)" },
    { key: "uid", label: "UID" },
    { key: "epc", label: "EPC" },
    { key: "mappingStatus", label: "Tra UID ↔ EPC" },
    { key: "result", label: "Kết quả RFID" },
    { key: "inputMode", label: "Loại đầu vào" },
    { key: "note", label: "Ghi chú" },
    { key: "qrSkuCode", label: "SKU" },
    { key: "productName", label: "Tên sản phẩm" },
    { key: "productCode", label: "Mã sản phẩm" },
    { key: "productId", label: "Product ID" },
    { key: "unitName", label: "Đơn vị" },
    { key: "qrUnitId", label: "qr_unit_id" },
    { key: "qrLotDate", label: "qr_lot_date" },
    { key: "expiredDate", label: "Hạn dùng" },
    { key: "qrConvertRate", label: "qr_convert_rate" },
    { key: "isCircaProduct", label: "is_circa_product" },
    { key: "qrSellerCode", label: "qr_seller_code" },
    { key: "qrDocCode", label: "qr_doc_code" },
    { key: "qrLotId", label: "qr_lot_id" },
    { key: "qrLocationId", label: "qr_location_id" },
    { key: "qrLocationDetailId", label: "qr_location_detail_id" },
    { key: "status", label: "Kết luận (accepted/review)" },
    { key: "reason", label: "Lý do cần kiểm tra" },
    { key: "scannedAt", label: "Thời gian quét (ISO)" },
    { key: "scannedAtLocal", label: "Thời gian quét (máy)" },
    { key: "orderStatus", label: "Trạng thái đơn" },
    { key: "completedAt", label: "Hoàn tất lúc (POS)" },
    { key: "orderItemQuantity", label: "Số lượng trên đơn hoàn tất" },
    { key: "orderType", label: "Loại đơn (POS)" },
    { key: "modifiedQuantity", label: "Số lượng sau lượt quét / thao tác" },
    { key: "modifiedUnit", label: "Đơn vị dòng hàng" },
    { key: "modifiedUnitPrice", label: "Đơn giá" },
    { key: "modifiedTotalAmount", label: "Thành tiền" },
    { key: "modifiedItemId", label: "ID dòng hàng POS" },
    { key: "resolvedUid", label: "UID tem con đã map" },
    { key: "generationId", label: "Generation ID" },
    { key: "mappedChildCount", label: "Số tem con đã map" },
    { key: "resolvedChildren", label: "Danh sách tem con (JSON)" },
    { key: "paymentStatus", label: "Trạng thái thanh toán" },
    { key: "paymentMethod", label: "Phương thức thanh toán" },
    { key: "terminator", label: "Phím kết thúc" },
    { key: "channel", label: "Kênh thu" },
    { key: "eventId", label: "Event ID" },
  ]);

  function formatLocal(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  // v0.8.0: cột "Số lượng trên đơn hoàn tất" — cùng phép tính worker từng chép vào lượt (eventOrderSnapshot): dòng hàng POS chứa
  // đúng UID của lượt trên bản đơn ĐÃ gộp đang COMPLETED. Không tính được (đơn chưa COMPLETED, không khớp, không phải lượt bán) →
  // giá trị đang có trên bản ghi (lượt do bản trước v0.8.0 chép).
  function exportOrderItemQuantity(ord, e) {
    const q = isLogEvent(e) && ord && ord.orderId === e.orderId ? orderItemQuantityFor(ord, e.uid) : null;
    if (q !== null) return q;
    return e && e.orderItemQuantity !== undefined ? e.orderItemQuantity : null;
  }

  // evidence: tập mã POS xác nhận (buildQrEvidence). Bỏ trống thì tự dựng từ orders + qrs truyền vào.
  function buildExportRows(orders, events, qrs, evidence) {
    const byId = new Map();
    for (const o of orders || []) byId.set(o.orderId, o);
    const byQr = new Map();
    for (const q of qrs || []) if (q && q.qrCode) byQr.set(q.qrCode, q);
    const ev = evidence || buildQrEvidence(orders, qrs);
    const blank = (v) => (v === null || v === undefined ? "" : v);
    const sorted = (events || []).slice().sort((a, b) => String(a.scannedAt).localeCompare(String(b.scannedAt)));
    return sorted.map((e) => {
      const o = byId.get(e.orderId) || {};
      if (isActionEvent(e)) return actionExportRow(e, o);
      // Tính lại từ qrRaw (nguồn chuẩn) thay vì tin qrCode đã lưu: bản ghi cũ do phiên bản
      // trước tách sai hoặc lưu dãy mã Alt vẫn nối đúng, không cần chuyển đổi dữ liệu.
      const scan = resolveScan(e, ev);
      const code = scan.code;
      const q = byQr.get(code) || {};
      const shown = displayStatus(e, scan);
      return {
        recordTypeLabel: RECORD_TYPE_LABELS[recordTypeOf(o.recordType ? o : e)],
        orderCode: o.orderCode || "",
        orderId: e.orderId,
        qrRaw: scan.text,
        qrCode: code,
        // Bản ghi trước 0.2.0 không có source: ô trống, không đoán.
        source: blank(e.source),
        action: blank(e.action),
        uid: blank(e.uid),
        epc: blank(e.epc),
        mappingStatus: blank(e.mappingStatus),
        result: blank(e.result),
        inputMode: e.inputMode || (scan.recovered || scan.unverified ? INPUT_MODE.ALT_DECIMAL : ""),
        note: scan.recovered ? "Khôi phục từ dãy mã Alt, đã đối chứng mã POS" : scan.unverified ? "Dãy mã Alt của bản cũ, chưa đối chứng được" : "",
        qrSkuCode: blank(q.qrSkuCode),
        productName: blank(q.productName),
        productCode: blank(q.productCode),
        productId: blank(q.productId),
        unitName: blank(q.unitName),
        qrUnitId: blank(q.qrUnitId),
        qrLotDate: blank(q.qrLotDate),
        expiredDate: blank(q.expiredDate),
        qrConvertRate: blank(q.qrConvertRate),
        isCircaProduct: blank(q.isCircaProduct),
        qrSellerCode: blank(q.qrSellerCode),
        qrDocCode: blank(q.qrDocCode),
        qrLotId: blank(q.qrLotId),
        qrLocationId: blank(q.qrLocationId),
        qrLocationDetailId: blank(q.qrLocationDetailId),
        status: shown.status,
        reason: shown.reason ? REASON_LABELS[shown.reason] || shown.reason : "",
        scannedAt: e.scannedAt,
        scannedAtLocal: formatLocal(e.scannedAt),
        orderStatus: o.status || "",
        completedAt: blank(o.completedDate),
        // Số lượng dòng hàng chứa UID của lượt trên đơn COMPLETED. v0.8.0: worker không còn chép snapshot đơn vào lượt
        // (fanOutOrderSnapshot) → tính từ bản đơn đã gộp lúc xuất; đơn chưa COMPLETED / không khớp → giá trị cũ của lượt (bản trước).
        orderItemQuantity: blank(exportOrderItemQuantity(o, e)),
        // 0.3: của chính lượt — worker gắn từ response POST /item và từ generation; không tính lại ở đây.
        orderType: blank(e.orderType),
        modifiedQuantity: blank(e.modifiedQuantity),
        modifiedUnit: blank(e.modifiedUnit),
        modifiedUnitPrice: blank(e.modifiedUnitPrice),
        modifiedTotalAmount: blank(e.modifiedTotalAmount),
        modifiedItemId: blank(e.modifiedItemId),
        resolvedUid: blank(e.resolvedUid),
        generationId: blank(e.generationId),
        mappedChildCount: blank(e.mappedChildCount),
        resolvedChildren: blank(e.resolvedChildren),
        paymentStatus: o.paymentStatus || "",
        paymentMethod: o.paymentMethod || "",
        terminator: e.terminator || "",
        channel: e.channel || "",
        eventId: e.eventId,
      };
    });
  }

  // v0.7 Batch D: dòng xuất của một thao tác POS — không có mã quét / kết luận quét; sản phẩm, số lượng và giá là của
  // CHÍNH bản ghi thao tác (không tra lại qr:). Cùng bộ cột với lượt quét để file xuất vẫn là một bảng.
  function actionExportRow(e, o) {
    const row = {};
    for (const c of EXPORT_COLUMNS) row[c.key] = "";
    const blank = (v) => (v === null || v === undefined ? "" : v);
    return Object.assign(row, {
      recordTypeLabel: RECORD_TYPE_LABELS[RECORD_TYPE.SALE_ORDER_ACTION],
      orderCode: blank(e.orderCode) || o.orderCode || "",
      orderId: e.orderId,
      source: blank(e.source),
      action: blank(e.action),
      note: POS_ACTION_LABELS[e.action] || "",
      qrSkuCode: blank(e.sku),
      productName: blank(e.productName),
      productCode: blank(e.productCode),
      productId: blank(e.productId),
      scannedAt: e.scannedAt,
      scannedAtLocal: formatLocal(e.scannedAt),
      orderStatus: blank(e.orderStatus) || o.status || "",
      completedAt: blank(e.completedAt),
      orderType: blank(e.orderType),
      modifiedQuantity: blank(e.modifiedQuantity),
      modifiedUnit: blank(e.modifiedUnit),
      modifiedUnitPrice: blank(e.modifiedUnitPrice),
      modifiedTotalAmount: blank(e.modifiedTotalAmount),
      modifiedItemId: blank(e.modifiedItemId),
      paymentStatus: o.paymentStatus || "",
      paymentMethod: o.paymentMethod || "",
      eventId: e.eventId,
    });
  }

  // Số mã QR phân biệt POS ghi trên các dòng hàng. qr_codes của POS lặp nhiều lần cùng một mã
  // (dữ liệu production: 70 dòng nhưng chỉ 21 mã), nên không đếm số dòng.
  function distinctPosCodes(posItems) {
    const set = new Set();
    for (const it of posItems || []) for (const q of it.qrCodes || []) set.add(q);
    return set;
  }

  // Tham khảo: lượt extension ghi nhận so với mã POS ghi trên dòng hàng.
  // POS không phải bằng chứng đầy đủ mọi lượt quét (mã không tìm thấy sản phẩm không có ở đó).
  // posHas = POS có ghi mã này trên đơn hay không (không đếm lặp).
  function reconcile(events, posItems, evidence) {
    const pos = distinctPosCodes(posItems);
    const ev = evidence || pos;
    const accepted = new Map();
    const review = new Map();
    for (const e of events || []) {
      const scan = resolveScan(e, ev);
      const m = displayStatus(e, scan).status === VERDICT.REVIEW ? review : accepted;
      m.set(scan.code, (m.get(scan.code) || 0) + 1);
    }
    const codes = new Set([...accepted.keys(), ...review.keys(), ...pos]);
    const rows = [];
    for (const code of codes) rows.push({ code, scannedCount: accepted.get(code) || 0, reviewCount: review.get(code) || 0, posHas: pos.has(code) });
    rows.sort((a, b) => a.code.localeCompare(b.code));
    return rows;
  }

  // ======================= v0.7.1 — sự cố POS-02 30/09/2026 (retry storm) =======================

  // So sánh KHÔNG phụ thuộc thứ tự khoá. chrome.storage trả object đã sắp khoá theo bảng chữ cái ở mọi cấp, nên
  // JSON.stringify của bản đọc lại khác bản vừa dựng dù nội dung y hệt. Mọi phép "đổi / không đổi" mới của v0.7.1 dùng
  // chuỗi chuẩn hoá này. isChanged giữ nguyên cho mã trừ tồn đã đóng băng (HANDOFF mục 3 — không sửa tiếp).
  function canonicalize(v) {
    if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : canonicalize(x)));
    if (!v || typeof v !== "object") return v;
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = canonicalize(v[k]);
    return out;
  }
  function canonicalJson(v) {
    return JSON.stringify(canonicalize(v));
  }
  function sameContent(a, b) {
    return canonicalJson(a) === canonicalJson(b);
  }

  // Dấu "đã đối soát xong" của một phiên bản đơn (KEYS.orderSync + orderId): chữ ký = băm của bản đơn đã gộp (bỏ trường
  // dễ đổi), mốc cài v0.7 (completed_items phụ thuộc mốc) và phiên bản luật fan-out (đổi luật → mọi dấu cũ hết hiệu lực).
  // Hai response cùng updated_date mà khác items[] cho bản gộp khác → chữ ký khác → đối soát lại đúng contract Batch C.
  // v0.7.2 GIỮ "0.7.1" (audit PM 03/10, P2): bản ghi ci: cũ KHÔNG được gán trạm theo cấu hình hiện tại, nên không cần đối soát
  // lại mọi đơn khi nâng cấp; M (mã đơn) được điền khi dòng đồng bộ lại tự nhiên (snapshot mới hơn).
  // v0.7.4 GIỮ "0.7.1": bản ghi trạng thái đơn được ghi ở MỌI lần nhận response đơn (trước bước bỏ qua theo dấu), nên không cần
  // đối soát lại các đơn đã có dấu (đối soát lại sẽ điền M cho dòng ci: cũ — trái hành vi v0.7.2 đã duyệt).
  const FANOUT_RULES_VERSION = "0.7.1";
  function orderReconcileSignature(merged, marker) {
    return stableUuid(canonicalJson({ order: stripVolatile(merged), marker: marker && marker.at ? marker.at : null, rules: FANOUT_RULES_VERSION }));
  }

  // ---- sàn bộ đếm theo trạm (đọc từ Sheet) ----
  // GET /exec mặc định (Apps Script v0.7.1) trả stationFloors = { "POS-01": {sale_order, transfer_out, sale_order_action}, … }
  // = số thứ tự lớn nhất đã có trên tab data. Thiếu trạm / thiếu loại / giá trị lạ → null (KHÔNG coi là 0).
  // Chỉ dùng để KHỞI TẠO bộ đếm khi kho bị tạo lại; điều kiện: mỗi mã trạm production chỉ một máy ghi (PM 01/10/2026).
  // v0.7.4: thêm bộ đếm trạng thái đơn. Sàn của BA loại cũ là bắt buộc (như v0.7.1); sàn trạng thái đơn chỉ có từ Apps Script
  // v0.7.4 — thiếu thì CHỈ loại đó chưa được cấp số (bản ghi chờ trên máy), ba loại cũ vẫn chạy (không coi thiếu là 0).
  const STATION_RECORD_TYPES = Object.freeze([RECORD_TYPE.SALE_ORDER, RECORD_TYPE.TRANSFER_OUT, RECORD_TYPE.SALE_ORDER_ACTION, RECORD_TYPE.SALE_ORDER_STATUS]);
  const STATION_RECORD_TYPES_REQUIRED = Object.freeze([RECORD_TYPE.SALE_ORDER, RECORD_TYPE.TRANSFER_OUT, RECORD_TYPE.SALE_ORDER_ACTION]);
  function parseStationFloors(json, stationId) {
    const st = normalizeStationId(stationId);
    if (!st || !json || typeof json !== "object") return null;
    const all = json.stationFloors;
    if (!all || typeof all !== "object" || Array.isArray(all)) return null;
    const f = all[st];
    if (!f || typeof f !== "object" || Array.isArray(f)) return null;
    const out = {};
    for (const t of STATION_RECORD_TYPES_REQUIRED) {
      if (!Number.isInteger(f[t]) || f[t] < 0) return null;
      out[t] = f[t];
    }
    const s = f[RECORD_TYPE.SALE_ORDER_STATUS];
    if (Number.isInteger(s) && s >= 0) out[RECORD_TYPE.SALE_ORDER_STATUS] = s;
    return out;
  }
  function stationFloorKey(stationId) {
    return KEYS.stationFloorPrefix + stationId;
  }
  // Sàn của một loại chứng từ trong bản ghi đã lưu, hoặc null khi chưa biết.
  function stationFloorOf(record, recordType) {
    const f = record && record.floors;
    const n = f && f[stationRecordType(recordType)];
    return Number.isInteger(n) && n >= 0 ? n : null;
  }

  // ---- hàng chờ pend: ----
  // Khoá pend của lượt quét. Lượt chuyển hàng có eventId cố định theo (phiếu, mã) và có thể được quét lại → thêm scannedAt
  // để mỗi bản lưu tạm là BẤT BIẾN (worker xoá đúng bản đã xử lý, không bao giờ xoá bản mới hơn tab vừa ghi).
  function pendEventKey(e) {
    return e && e.recordType === RECORD_TYPE.TRANSFER_OUT ? e.eventId + ":" + String(e.scannedAt || "") : e && e.eventId;
  }
  // Thứ tự worker dọn hàng chờ: lượt quét / RFID / thao tác (dữ liệu gốc) trước, đơn / sản phẩm / dòng hàng sau.
  const PEND_OPS = Object.freeze([
    Object.freeze({ prefix: KEYS.pendEvent, type: MSG.SAVE_EVENT, field: "event" }),
    Object.freeze({ prefix: KEYS.pendEventUpdate, type: MSG.UPSERT_EVENT, field: "event" }),
    Object.freeze({ prefix: KEYS.pendAction, type: MSG.POS_ITEM_ACTION, field: "info" }),
    Object.freeze({ prefix: KEYS.pendOrder, type: MSG.UPSERT_ORDER, field: "info" }),
    Object.freeze({ prefix: KEYS.pendQr, type: MSG.UPSERT_QR, field: "info" }),
    Object.freeze({ prefix: KEYS.pendItem, type: MSG.ITEM_INFO, field: "info" }),
  ]);
  function pendOpOf(key) {
    if (typeof key !== "string") return null;
    for (let i = 0; i < PEND_OPS.length; i++) if (key.startsWith(PEND_OPS[i].prefix)) return Object.assign({ priority: i }, PEND_OPS[i]);
    return null;
  }
  function comparePendKeys(a, b) {
    return pendOpOf(a).priority - pendOpOf(b).priority || (a < b ? -1 : a > b ? 1 : 0);
  }
  // Danh sách khoá pend theo thứ tự ưu tiên, XOAY VÒNG bắt đầu sau `cursor` (khoá xử lý cuối của lượt trước): mục lỗi lặp
  // lại ở đầu danh sách không chặn mãi các mục phía sau.
  function pendDrainOrder(keys, cursor) {
    const list = (keys || []).filter((k) => pendOpOf(k)).sort(comparePendKeys);
    if (!cursor || !pendOpOf(cursor) || !list.length) return list;
    const i = list.findIndex((k) => comparePendKeys(k, cursor) > 0);
    return i <= 0 ? list : list.slice(i).concat(list.slice(0, i));
  }

  // ---- dữ liệu popup ----
  // Dựng dữ liệu hiển thị của popup từ toàn bộ storage (một lần lúc mở / bấm "Cập nhật dữ liệu hiển thị"). `_raw` giữ bản
  // thô để applyStorageChanges áp thay đổi của storage.onChanged mà KHÔNG đọc lại storage (popup 0.7.0 đọc lại ~3 MB mỗi
  // thay đổi nhỏ).
  // ======================================================================================================================
  // v0.7.3 — Phase 1 trừ tồn Nextwaves qua POST /api/v1/public/integrations/circa/orders/notify (plan PM 06/10/2026).
  // /orders/sync cũ vẫn FROZEN (bộ 0.6 ở trên không đổi). Mọi hàm dưới đây THUẦN: worker đọc ord:/ev: + bằng chứng tem rồi gọi.
  // ======================================================================================================================
  const NOTIFY_MAX_TAGS = 200; // Nextwaves: tối đa 200 tag / order; Phase 1 không tự chia nhiều POST
  const NOTIFY_PILOT_MAX_ORDERS = 5;
  const NOTIFY_STATE = Object.freeze({
    NEEDS_REVIEW: "needs_review",
    PREPARED: "prepared",
    SUBMITTING: "submitting",
    CONFIRMED: "confirmed",
    REJECTED: "rejected",
    AMBIGUOUS: "ambiguous",
  });
  // Đã bắt đầu POST (hoặc đã có kết quả): job KHÔNG BAO GIỜ được dựng lại payload, duyệt lại hay gửi lần hai (Phase 1).
  const NOTIFY_STARTED_STATES = Object.freeze([NOTIFY_STATE.SUBMITTING, NOTIFY_STATE.CONFIRMED, NOTIFY_STATE.REJECTED, NOTIFY_STATE.AMBIGUOUS]);
  const NOTIFY_STATE_LABELS = Object.freeze({
    needs_review: "Cần kiểm tra",
    prepared: "Sẵn sàng — chờ duyệt",
    submitting: "Đang gửi",
    confirmed: "Đã trừ tồn",
    rejected: "Bị từ chối",
    ambiguous: "Không rõ kết quả — cần đối soát",
  });
  const NOTIFY_REASON_LABELS = Object.freeze({
    order_not_found: "Đơn chưa có trên máy này (chưa mở đơn trên POS của máy gửi)",
    not_sale_order: "Không phải đơn bán",
    order_type: "Không phải đơn OFFLINE",
    order_not_completed: "Đơn chưa COMPLETED",
    order_code_missing: "Thiếu mã đơn",
    // v0.7.9: orderId / Idempotency-Key gửi Nextwaves = mã DHC của response POS cuối.
    order_code_final_missing: "Response POS cuối (có danh sách dòng) không kèm mã DHC — mở lại đơn trên POS để nhận response đầy đủ",
    order_code_invalid: "Mã đơn ở response POS cuối không phải mã DHC hợp lệ — không gửi bằng mã khác",
    created_date_missing: "Thiếu ngày tạo đơn",
    completed_date_missing: "Thiếu ngày hoàn tất",
    updated_date_missing: "Thiếu updated_date",
    items_missing: "Response COMPLETED chưa có danh sách dòng hàng — mở lại đơn trên POS để nhận response đầy đủ",
    items_empty: "Đơn không có dòng hàng",
    item_no_scan: "Dòng hàng không có lượt quét QR/RFID nào",
    unplaced_scan: "Lượt quét không gắn được dòng hàng (thiếu modifiedItemId)",
    mapping_pending: "QR chưa tra được EPC",
    mapping_error: "Tra EPC lỗi (không phải 'không gắn RFID')",
    mapping_multiple: "Mã QR cha có nhiều tem con — không tự chọn",
    rfid_epc_missing: "Lượt RFID thiếu EPC",
    mixed_rfid: "Dòng vừa có tem RFID vừa có QR không gắn RFID — không chia được lượng",
    product_mismatch: "Sản phẩm của lượt / tem khác sản phẩm của dòng",
    epc_conflict: "Một EPC ứng với nhiều UID",
    uid_conflict: "Một UID ứng với nhiều EPC",
    epc_multi_item: "Một EPC nằm ở nhiều dòng hàng",
    base_quantity_missing: "Thiếu base_quantity",
    convert_rate_missing: "Không tìm được convert_rate của đơn vị bán (product.retail_units)",
    base_unit_missing: "Không xác định được đơn vị cơ bản (base_unit) của sản phẩm",
    conversion_mismatch: "quantity × convert_rate ≠ base_quantity",
    quantity_invalid: "base_quantity không hợp lệ (phải > 0)",
    tag_holding_unknown: "Chưa biết lượng còn trong tag",
    product_unverified: "Thiếu sản phẩm của tag (circaProductId) hoặc của dòng — chưa chứng minh tag đúng sản phẩm",
    uid_unverified: "Lượt QR: thiếu UID tem của Nextwaves (unitUid) hoặc UID đã quét — chưa chứng minh đúng tem",
    tag_holding_error: "Tra lượng tag lỗi",
    tag_inactive: "Tag không còn hoạt động",
    tag_empty: "Tag không còn lượng",
    quantity_exceeds_tags: "Lượng cần trừ lớn hơn lượng các tag đang giữ",
    quantity_exceeds_latest_tag: "Lượng của dòng lớn hơn lượng còn trong EPC quét sau cùng — không cộng EPC quét trước (chỉ trừ nhiều tem khi số tem = số đơn vị bán)",
    scan_not_on_this_machine: "Dòng hàng có mã QR mà máy gửi không có lượt quét nào — có thể thao tác ở máy khác (đơn chuyển trạm)",
    // v0.7.6 — không còn sinh từ v0.7.7 (lượt RFID "added" đủ điều kiện là bằng chứng); giữ nhãn cho job cũ.
    code_rfid_only: "Mã của dòng chỉ có lượt RFID trên máy gửi, không có lượt QR — chưa đủ chứng minh (chờ PM chốt luật cho dòng RFID)",
    // v0.7.7 (spec PM 12/10/2026)
    code_rfid_unconfirmed: "Mã của dòng chỉ có lượt RFID chưa xác nhận đã vào POS (không phải 'added') trên máy gửi — không đủ chứng minh",
    rfid_uid_not_on_line: "Tag đọc bằng RFID có UID không nằm trong mã POS ghi trên dòng này (UID lệch / thiếu)",
    local_data_pending: "Máy gửi còn dữ liệu của đơn chưa ghi xong (hàng chờ) — chờ ghi xong rồi kiểm tra lại",
    completed_items_mismatch: "completed_items của đơn chưa khớp danh sách dòng của response cuối (thiếu / lệch số lượng / đơn vị)",
    scan_order_ambiguous: "Thứ tự quét các tag không rõ (quét lại xen kẽ)",
    // v0.7.8 (PM 14/10/2026): dòng bán N đơn vị có đúng N tem — mỗi tem phải trọn một đơn vị bán, khớp một-một mã POS của dòng.
    // v0.7.8.2: áp cho MỌI EPC vào payload (cả dòng một tem, + / −), không chỉ nhánh nhiều tem.
    tag_base_unit_mismatch: "Đơn vị cơ sở của tem (baseUnit Nextwaves) thiếu / khác đơn vị cơ sở của dòng POS — không so được lượng",
    tag_unit_ratio_mismatch: "Nhiều tem cho một dòng: tem không phải đúng một đơn vị bán của dòng (unitRatio Nextwaves thiếu / khác convert_rate) — không chia ước lượng",
    tag_not_full_unit: "Nhiều tem cho một dòng: tem không còn nguyên một đơn vị bán (lượng còn khác convert_rate) — không lấy phần thiếu từ tem khác",
    tag_code_mismatch: "Nhiều tem cho một dòng: tem và mã POS ghi trên dòng không khớp một-một (số mã khác số tem, tem không mang / mang nhiều mã POS)",
    too_many_tags: "Quá 200 tag trong một đơn",
    no_rfid_tags: "Đơn không có tag RFID nào để trừ",
    // v0.7.10 (PM 17/10/2026, finding 2): danh sách dòng của response COMPLETED không được bỏ âm thầm.
    items_integrity: "Danh sách dòng của response COMPLETED không nguyên vẹn (dòng thiếu ID / ID trùng / số dòng khác response) — giữ cả đơn",
    // v0.7.10 (PM 17/10/2026, finding 1 + bảng luật): lý do giữ CẢ DÒNG (dòng khác của đơn vẫn gửi).
    // v0.7.10.4: giữ nguyên văn (sổ stock_out đã ghi nhãn này); thao tác đổi đơn vị hiện rõ ở chi tiết ("1 viên→1 vỉ").
    quantity_edited: "Dòng có thao tác đổi số lượng trên POS (+ / − / sửa tay) — giữ cả dòng, không dùng một EPC trừ nhiều đơn vị",
    quantity_edit_unclear: "Dòng có lời gọi sửa dòng hàng mà extension không phân loại được — giữ cả dòng",
    quantity_history_unknown: "Lượt quét của dòng thiếu số lượng POS trả về sau lượt — không chứng minh được diễn biến số lượng, giữ cả dòng",
    quantity_history_mismatch: "Số lượng / đơn vị POS sau từng lượt quét không đi đúng 1, 2, …, N theo từng mã mới — có thay đổi ngoài lượt quét, giữ cả dòng",
    uid_count_mismatch: "Số UID riêng biệt đã quét và POS ghi trên dòng khác số đơn vị bán — giữ cả dòng",
    uid_rescanned: "Một UID được quét (POS cộng) nhiều lần trên dòng — giữ cả dòng",
    scan_code_not_on_line: "Lượt QR của dòng không mang đúng một mã POS ghi trên dòng — không chứng minh được mã thuộc dòng, giữ cả dòng",
    no_passing_epc: "Không có EPC nào đạt để trừ — các dòng / UID có EPC đều giữ xử lý thủ công (0 POST)",
    // v0.7.10.4 (spec PM 23/10/2026 — một tem, đổi đơn vị bán): lý do giữ CẢ DÒNG của luật mới.
    unit_change_multi_uid: "Dòng đổi đơn vị bán có nhiều hơn một UID / lượt quét — chưa có căn cứ chia lượng cho nhiều EPC, giữ cả dòng",
    unit_change_chain_broken: "Diễn biến số lượng / đơn vị của dòng (sau lượt quét → từng thao tác sửa → response cuối) không liền mạch — thiếu response hoặc có thay đổi extension không quan sát được, giữ cả dòng",
    // v0.7.10.5 (audit PM 23/10/2026)
    quantity_edited_before_unit_change: "Dòng có thao tác sửa số lượng (+ / − / sửa tay) TRƯỚC lần đổi đơn vị đầu tiên — chưa xác định phần thêm thuộc EPC nào, giữ cả dòng",
    unit_change_product_unverified: "Thao tác sửa dòng thiếu mã sản phẩm (hoặc dòng cuối thiếu) — không chứng minh thao tác thuộc đúng sản phẩm, giữ cả dòng",
    // v0.7.12 (PM audit 24/10/2026): chỉ đổi đơn vị bán, giá trị số lượng giữ nguyên mới được trừ; dòng chuyển máy; máy chỉ quan sát.
    unit_change_quantity_edited: "Dòng đổi đơn vị bán có thao tác làm đổi GIÁ TRỊ số lượng (+ / − / nhập tay, hoặc một lời gọi vừa đổi đơn vị vừa đổi lượng) — chỉ đổi đơn vị với số lượng giữ nguyên mới được trừ, giữ cả dòng",
    cross_station_action_history_unknown: "Mã QR trên dòng không có lượt quét ở máy này — dòng được quét / sửa ở máy hoặc tab khác, lịch sử thao tác không đủ để chứng minh, giữ cả dòng",
    // v0.7.12.1: máy quan sát = không có LƯỢT QUÉT nào của đơn (thao tác + / − ở máy này không phải bằng chứng quét) — audit PM 24/10, ca "máy thao tác nhưng thiếu QR".
    observed_other_station: "Máy này không có lượt quét nào của đơn — đơn được quét ở máy khác (thao tác + / − ở máy này, nếu có, không phải bằng chứng quét); máy này chỉ quan sát, không gửi (đối chiếu dòng sổ của máy đã quét)",
    line_write_unseen: "Nhật ký mã QR của dòng trên POS (qr_codes) có lời gọi ghi mà máy này không ghi nhận — dòng được quét / sửa ở máy hoặc tab khác, lời gọi không phân loại được hoặc thiếu số đếm; không chứng minh được dòng không bị sửa lượng, giữ cả dòng",
    partial_summary: "Trừ một phần — phần còn lại xử lý thủ công",
  });

  // Dòng hàng phục vụ trừ tồn — CHỈ từ data.order.items[] của CHÍNH response (không bao giờ ghép danh sách cũ). Quy đổi lấy từ
  // item.product.retail_units: đơn vị bán = phần tử có id === item.unit_id; đơn vị cơ bản = phần tử base_unit === true.
  // null khi response không có items[] (vd response POST /item) — mergeOrderInfo khi đó đặt stockItems = null.
  function stockItemsOf(order) {
    if (!order || !Array.isArray(order.items)) return null;
    const out = [];
    for (const it of order.items) {
      if (!it || typeof it !== "object") continue;
      const id = typeof it.id === "string" ? it.id.toLowerCase() : "";
      if (!isUuid(id)) continue;
      const p = it.product && typeof it.product === "object" ? it.product : null;
      const units = p && Array.isArray(p.retail_units) ? p.retail_units.filter((u) => u && typeof u === "object") : null;
      const unitId = typeof it.unit_id === "string" && it.unit_id ? it.unit_id.toLowerCase() : null;
      const sale = units && unitId ? units.filter((u) => typeof u.id === "string" && u.id.toLowerCase() === unitId) : [];
      const base = units ? units.filter((u) => u.base_unit === true) : [];
      out.push({
        itemId: id,
        productId: it.product_id === null || it.product_id === undefined || it.product_id === "" ? null : String(it.product_id),
        quantity: finiteOrNull(it.quantity),
        unit: stringOrNull(it.unit),
        unitId,
        baseQuantity: finiteOrNull(it.base_quantity),
        convertRate: sale.length === 1 ? finiteOrNull(sale[0].convert_rate) : null,
        saleUnit: sale.length === 1 ? stringOrNull(sale[0].unit) : null,
        baseUnit: base.length === 1 ? stringOrNull(base[0].unit) : null,
        baseRate: base.length === 1 ? finiteOrNull(base[0].convert_rate) : null,
        // v0.7.5: TẬP mã QR (phân biệt) POS ghi trên dòng — qr_codes lặp lại cùng mã nhiều lần nên chỉ dùng tập, không dùng số bản.
        qrCodes: [...new Set([it.qr_code].concat(Array.isArray(it.qr_codes) ? it.qr_codes : []).filter((q) => typeof q === "string" && q))].sort(),
      });
    }
    return out;
  }

  // v0.7.10 (audit PM 17/10/2026, finding 2): stockItemsOf bỏ phần tử không có ID dòng hợp lệ — bỏ âm thầm thì dòng đó không bao giờ được
  // xét. Đối chiếu với posItems của CÙNG response (mergeOrderInfo: stockItems khác null ⇒ posItems cùng response, giữ MỌI phần tử của
  // items[]): cùng số dòng, mọi ID là UUID, không trùng, cùng tập ID. → null (nguyên vẹn) | chi tiết lỗi.
  function stockItemsIntegrityProblem(o) {
    const raw = Array.isArray(o.posItems) ? o.posItems : null;
    if (!raw) return "pos_items_missing";
    const ids = raw.map((x) => (x && typeof x.itemId === "string" ? x.itemId.toLowerCase() : ""));
    const bad = ids.filter((id) => !isUuid(id)).length;
    if (bad) return "item_id_invalid:" + bad;
    if (new Set(ids).size !== ids.length) return "item_id_duplicate";
    const kept = new Set(o.stockItems.map((it) => it && it.itemId));
    if (kept.size !== o.stockItems.length || raw.length !== o.stockItems.length || ids.some((id) => !kept.has(id))) return "items_dropped:" + raw.length + "/" + o.stockItems.length;
    return null;
  }

  // v0.7.9 (stakeholder + audit PM 14/10/2026): đơn MỚI phải tra được bằng mã DHC trên Nextwaves → orderId trong body /orders/notify
  // và Idempotency-Key = mã DHC (OFFLINE: "DHC" + chữ số). UUID POS vẫn là khoá nội bộ (job notify:<UUID>, data, completed_items,
  // stock_out, allowlist pilot). Job đã bắt đầu gửi bằng UUID (trước v0.7.9) giữ nguyên từng byte — xem notifyFrozenProblem.
  const NOTIFY_ORDER_CODE_RE = /^DHC\d{5,}$/;

  // Cổng dữ liệu đơn: OFFLINE + COMPLETED + đủ mốc + items[] của CHÍNH phiên bản đơn (stockItemsVersion = updatedDate).
  // Thanh toán 200 / PENDING / is_payment_success chưa bao giờ là điều kiện đủ.
  function notifyOrderVerdict(ord) {
    const o = ord && typeof ord === "object" ? ord : null;
    const no = (reason) => ({ ok: false, reason });
    if (!o) return no("order_not_found");
    if (!isUuid(o.orderId) || recordTypeOf(o) !== RECORD_TYPE.SALE_ORDER) return no("not_sale_order");
    if (String(o.orderType || "").trim().toUpperCase() !== "OFFLINE") return no("order_type");
    if (o.status !== ORDER_COMPLETED) return no("order_not_completed");
    if (!textOrNull(o.orderCode)) return no("order_code_missing");
    if (parseTime(o.createdDate) === null) return no("created_date_missing");
    if (parseTime(o.completedDate) === null) return no("completed_date_missing");
    if (parseTime(o.updatedDate) === null) return no("updated_date_missing");
    if (!Array.isArray(o.stockItems) || posTimeCompare(o.stockItemsVersion, o.updatedDate) !== 0) return no("items_missing");
    if (!o.stockItems.length) return no("items_empty");
    const broken = stockItemsIntegrityProblem(o);
    if (broken) return { ok: false, reason: "items_integrity", detail: broken };
    // v0.7.9: orderId / Idempotency-Key gửi Nextwaves = mã DHC của response POS cuối (cùng response mang danh sách dòng).
    if (!textOrNull(o.stockItemsCode)) return no("order_code_final_missing");
    if (!NOTIFY_ORDER_CODE_RE.test(o.stockItemsCode)) return no("order_code_invalid");
    return { ok: true, reason: null };
  }

  // Lượt có tham gia đối chiếu không:
  //   placed   — có modifiedItemId (POS đã trả dòng hàng cho chính lượt này), bất kể phân loại;
  //   unplaced — lượt có khả năng đã vào POS (QR accepted / RFID added|unconfirmed) nhưng không gắn được dòng → chặn;
  //   null     — lượt không vào POS (QR review/discard, RFID không gửi / bị từ chối): bỏ qua.
  function notifyScanRole(e) {
    if (!isLogEvent(e)) return null;
    if (textOrNull(e.modifiedItemId)) return "placed";
    if (e.source === SOURCE.QR) return e.status === VERDICT.ACCEPTED ? "unplaced" : null;
    return e.result === RESULT.ADDED || e.result === RESULT.UNCONFIRMED ? "unplaced" : null;
  }

  // v0.7.9.1 (audit PM 16/10/2026 — DHC01272069, POS-02): máy quét khựng ~1,8 s giữa mã (> stallGapMs) → extension cắt đôi; mảnh đuôi
  // "3176011" + Enter thành lượt QR "accepted" không gắn dòng (unplaced) và chặn cả đơn, dù POS không tạo dòng nào từ lần quét đó. Lượt
  // QR "unplaced" KHÔNG còn chặn trừ tồn CHỈ khi có bằng chứng dứt khoát (spec PM, mục 2):
  //   - QR "accepted", không modifiedItemId, không EPC, không UID tem con;
  //   - mã bị từ chối rõ ràng: tra EPC dừng ở bước kiểm định dạng (mappingError uid_invalid — không phải lỗi mạng / token / HTTP / chưa
  //     tra) VÀ không mã nào của lượt có dạng UID tem Circa (UID_RE) — mã như vậy không thể là tem Circa;
  //   - không mã nào của lượt (mã quét, UID, đoạn cuối URL) nằm trong qr_codes của BẤT KỲ dòng nào ở response cuối (so không phân biệt
  //     hoa thường) — mã có trong dòng cuối vẫn chặn;
  //   - đơn COMPLETED SAU mốc cài v0.7.9.1 (fixMarker): đơn trước mốc giữ luật cũ, không mở khoá đơn đã bị chặn / đã đối soát tay.
  // v0.7.10.1 (PM 17/10/2026 chốt): "không xuất hiện trong BẤT KỲ mã nào của response POS cuối" — so với mọi mã của mọi dòng: qr_codes,
  // qr_code, sku_code (so NGUYÊN mã, không phân biệt hoa thường; không so chuỗi con: mảnh đuôi của mã đã quét lại đủ — như "3176011" của
  // "1783333023176011" — là đúng ca cần bỏ qua). Mốc cài là mốc v0.7.10.1 (KEYS.notifyFixInstalledAt).
  // Mọi dòng cuối vẫn phải đủ bằng chứng riêng (item_no_scan, scan_not_on_this_machine, completed_items_mismatch... kiểm như cũ trong
  // buildNotifyPreview). Không đụng lượt: vẫn nằm nguyên trong nhật ký / tab data; job ghi lại ở preview.dismissed để truy vết.
  // Không có nhánh "POS xác nhận không tạo dòng": extension không lưu kết quả POS theo từng lượt khi POS không gọi /item.
  //   → null (vẫn chặn) | { eventId, uid, qrRaw, scannedAt, reason }
  const NOTIFY_DISMISS_MAPPING_ERROR = "uid_invalid";
  function notifyUnplacedDismissal(e, ord, fixMarker) {
    if (!isLogEvent(e) || e.source !== SOURCE.QR || e.status !== VERDICT.ACCEPTED || textOrNull(e.modifiedItemId)) return null;
    if (normalizeEpcStrict(e.epc) || textOrNull(e.resolvedUid)) return null;
    if (e.mappingStatus !== MAPPING.ERROR || e.mappingError !== NOTIFY_DISMISS_MAPPING_ERROR) return null;
    const codes = [e.qrCode, e.uid, extractQrCode(e.qrRaw)].map((c) => (typeof c === "string" ? c.trim() : "")).filter(Boolean);
    if (codes.some(looksLikeUid)) return null;
    const o = ord && typeof ord === "object" ? ord : {};
    const markerAt = fixMarker && typeof fixMarker === "object" ? textOrNull(fixMarker.at) : null;
    if (parseTime(markerAt) === null || !(posTimeCompare(completedStatusAt(o), markerAt) > 0)) return null;
    const onPos = new Set();
    for (const list of [o.stockItems, o.posItems]) {
      for (const it of Array.isArray(list) ? list : []) {
        if (!it || typeof it !== "object") continue;
        for (const c of (Array.isArray(it.qrCodes) ? it.qrCodes : []).concat([it.qrCode, it.skuCode])) if (typeof c === "string" && c.trim()) onPos.add(c.trim().toLowerCase());
      }
    }
    if (codes.some((c) => onPos.has(c.toLowerCase()))) return null;
    return { eventId: e.eventId, uid: textOrNull(e.uid), qrRaw: textOrNull(e.qrRaw), scannedAt: textOrNull(e.scannedAt), reason: "uid_invalid_not_on_pos" };
  }

  // Bằng chứng tem của một lượt: { kind: "tag", epc, tagUid } | { kind: "no_rfid" } | { kind: "review", code, detail }.
  // Lỗi tra EPC (mạng, auth, hợp đồng) KHÔNG BAO GIỜ là "không gắn RFID" — chỉ by-uid/generation trả rõ chưa map mới là no_rfid.
  function notifyScanTag(e) {
    if (e.source === SOURCE.RFID) {
      const epc = normalizeEpcStrict(e.epc);
      return epc ? { kind: "tag", epc, tagUid: textOrNull(e.uid) } : { kind: "review", code: "rfid_epc_missing" };
    }
    const st = e.mappingStatus;
    if (st === MAPPING.MAPPED) {
      const epc = normalizeEpcStrict(e.epc);
      return epc ? { kind: "tag", epc, tagUid: textOrNull(e.resolvedUid) || textOrNull(e.uid) } : { kind: "review", code: "mapping_error", detail: "mapped_without_epc" };
    }
    if (st === MAPPING.UNMAPPED) return { kind: "no_rfid" };
    if (st === MAPPING.MAPPED_MULTIPLE) return { kind: "review", code: "mapping_multiple" };
    if (st === MAPPING.ERROR) return { kind: "review", code: "mapping_error", detail: textOrNull(e.mappingError) };
    return { kind: "review", code: "mapping_pending" };
  }

  // Bằng chứng lượng tag (worker dựng từ Nextwaves): { ok, held, active, productId, reason, checkedAt }.
  //   requireUid: tag có lượt QR → phải chứng minh được tem đã quét chính là tem Nextwaves gắn EPC này (cả hai UID phải có và trùng).
  //   Lượt RFID: EPC do reader đọc trực tiếp từ tem — UID chỉ đối chiếu khi cả hai cùng có.
  // Thiếu sản phẩm (circaProductId của tag hoặc product_id của dòng) = chưa chứng minh tag thuộc đúng sản phẩm → chặn (audit PM 06/10).
  function tagHoldingProblem(ev, itemProductId, tagUid, requireUid) {
    if (!ev || typeof ev !== "object") return "tag_holding_unknown";
    if (ev.ok !== true) return "tag_holding_error";
    if (ev.active === false) return "tag_inactive";
    if (typeof ev.held !== "number" || !Number.isFinite(ev.held)) return "tag_holding_unknown";
    if (ev.held <= 0) return "tag_empty";
    const tagProduct = ev.productId === null || ev.productId === undefined || ev.productId === "" ? null : String(ev.productId);
    const lineProduct = itemProductId === null || itemProductId === undefined || itemProductId === "" ? null : String(itemProductId);
    if (!tagProduct || !lineProduct) return "product_unverified";
    if (tagProduct !== lineProduct) return "product_mismatch";
    const unitUid = textOrNull(ev.unitUid);
    const scanned = textOrNull(tagUid);
    if (requireUid && (!unitUid || !scanned)) return "uid_unverified";
    if (unitUid && scanned && unitUid !== scanned) return "uid_conflict";
    return null;
  }

  // ======================================================================================================================
  // v0.7.10 — trừ tồn theo TỪNG UID (PM 17/10/2026). Thay luật "EPC quét sau cùng" (PM 07/10) và "N tem / N đơn vị hoặc dừng cả đơn"
  // (PM 14/10). Một dòng POS chỉ được trừ khi CHỨNG MINH được: số UID riêng biệt đã quét trên máy gửi và POS ghi trên dòng = số đơn vị bán,
  // mỗi UID đúng một lượt quét, và số lượng POS trả về sau từng lượt quét đi đúng 1, 2, …, N (không có thay đổi nào ngoài lượt quét).
  //   - dòng đạt: mỗi UID là một đơn vị bán; UID có EPC đạt kiểm tra → EPC đó trừ trọn một đơn vị (convert_rate); UID có EPC lỗi → giữ
  //     UID đó xử lý thủ công (UID khác của dòng vẫn trừ); UID Nextwaves xác nhận không gắn RFID → chỉ ghi sổ, không trừ;
  //   - dòng không chứng minh được (+ / − / sửa số lượng, số UID ≠ số đơn vị, UID quét lặp, UID / EPC trùng, mã không thuộc dòng, thiếu
  //     lượt quét trên máy gửi, quy đổi lỗi) → giữ CẢ dòng, 0 EPC của dòng vào payload;
  //   - chưa rõ (EPC chưa tra xong, lỗi mạng / token / HTTP / hợp đồng) → chờ, 0 POST cả đơn (không gửi một phần khi còn chưa rõ).
  // Mọi EPC đạt của mọi dòng vào MỘT payload (một POST cho một đơn, như v0.7.9). Phần giữ lại nằm ở preview.manual / job.manual.
  // ======================================================================================================================
  const NOTIFY_RULE = "per_uid";
  // Lỗi tra lượng tag là kết luận DỨT KHOÁT của Nextwaves (UID đó giữ xử lý thủ công). Lỗi khác (mạng, token, HTTP, sai hợp đồng) là
  // "không rõ" → chờ, không gửi phần nào của đơn.
  const NOTIFY_HOLDING_DEFINITIVE = Object.freeze(["epc_not_found"]);

  // Mã của một lượt (để ghép với mã POS ghi trên dòng): QR → đoạn cuối URL, mã quét, UID, UID tem con; RFID → UID đọc được.
  function notifyScanCodes(e) {
    const list = e.source === SOURCE.RFID ? [e.uid] : [e.uid, e.qrCode, e.resolvedUid, extractQrCode(e.qrRaw)];
    return [...new Set(list.map((c) => (typeof c === "string" ? c.trim() : "")).filter(Boolean))];
  }

  // v0.7.10 (audit PM 17/10/2026, finding 1): diễn biến số lượng của MỘT dòng. Không chỉ đếm mã ở trạng thái cuối:
  //   - thao tác đổi số lượng extension quan sát được (sale_order_action item_quantity_set — bấm + / −, sửa tay) → quantity_edited;
  //   - lời gọi /item của CHÍNH dòng mà extension không phân loại được (posActionDiag có itemId) → quantity_edit_unclear;
  //   - bằng chứng KHÔNG phụ thuộc đường sửa (kể cả đường extension không quan sát được: endpoint / method khác, máy kia): POS trả số
  //     lượng của dòng sau MỖI lượt quét (modifiedQuantity) và ở response COMPLETED. Dòng đạt chỉ khi N lượt quét gắn dòng mang N mã POS
  //     khác nhau, số lượng sau các lượt đúng là {1, 2, …, N}, đơn vị không đổi và số lượng cuối = N = số mã POS. Mọi thay đổi số lượng /
  //     đơn vị ngoài lượt quét làm lệch một mốc (lượt kế tiếp hoặc response cuối). Chỉ thay đổi tự triệt tiêu GIỮA hai mốc liên tiếp (vd
  //     + rồi − trước lượt quét kế) là không thấy — và không đổi tương ứng đơn vị ↔ UID lúc hoàn tất.
  //   → { problems: [{ code, detail?, eventId? }], codeOf: Map(eventId → mã POS) }
  function notifyLineHistory(it, list, posCodes, edits, unclear) {
    const problems = [];
    if (edits && edits.length) problems.push({ code: "quantity_edited", detail: edits.join(", ") });
    if (unclear && unclear.length) problems.push({ code: "quantity_edit_unclear", detail: unclear.join(", ") });
    const codeOf = new Map();
    const perCode = new Map();
    for (const e of list) {
      const mine = notifyScanCodes(e).filter((c) => posCodes.has(c));
      if (mine.length !== 1) {
        problems.push({ code: e.source === SOURCE.RFID ? "rfid_uid_not_on_line" : "scan_code_not_on_line", eventId: e.eventId, detail: mine.length ? mine.join(", ") : "no_pos_code" });
        continue;
      }
      codeOf.set(e.eventId, mine[0]);
      perCode.set(mine[0], (perCode.get(mine[0]) || 0) + 1);
    }
    for (const [c, k] of [...perCode].sort()) if (k > 1) problems.push({ code: "uid_rescanned", detail: c + " × " + k });
    const qs = list.map((e) => e.modifiedQuantity);
    if (qs.some((q) => typeof q !== "number" || !Number.isFinite(q))) problems.push({ code: "quantity_history_unknown" });
    else {
      const steps = qs.slice().sort((a, b) => a - b);
      if (steps.some((q, i) => q !== i + 1)) problems.push({ code: "quantity_history_mismatch", detail: "SL sau từng lượt " + steps.join(", ") });
    }
    const units = [...new Set(list.map((e) => textOrNull(e.modifiedUnit) || "—"))].sort();
    if (!textOrNull(it.unit) || units.length !== 1 || units[0] !== it.unit) problems.push({ code: "quantity_history_mismatch", detail: "đơn vị " + units.join("/") + " → " + (it.unit || "—") });
    if (!(Number.isInteger(it.quantity) && it.quantity === list.length && it.quantity === posCodes.size)) {
      problems.push({ code: "uid_count_mismatch", detail: "UID " + posCodes.size + " · lượt " + list.length + " · SL " + (it.quantity === null ? "—" : it.quantity) });
    }
    return { problems, codeOf };
  }

  // v0.7.10.4 (spec PM 23/10/2026 — một tem, đổi đơn vị bán). POS thêm dòng bằng đơn vị bán mặc định (vd "viên"); dược sĩ đổi sang vỉ /
  // hộp, hoặc đổi đơn vị rồi nhập lượng (bán một phần hộp / vỉ có tem — tem ở lại cửa hàng, Nextwaves trừ từng phần cùng EPC qua các DHC
  // khác nhau). Luật từng UID (17/10) giữ mọi dòng đổi đơn vị → case bán bình thường luôn bị giữ. Luật này cho dòng có ĐÚNG MỘT UID / EPC
  // quét trên máy gửi và gắn với chính dòng:
  //   - áp khi đơn được TẠO và HOÀN TẤT sau mốc cài (v0.7.10.5), dòng có ít nhất một thao tác đổi đơn vị (previousUnit ≠ modifiedUnit, cả
  //     hai có) và đơn vị cuối khác đơn vị ngay sau lượt quét (đổi rồi đổi lại = chỉ sửa lượng → luật từng UID, giữ dòng);
  //   - chứng cứ: một lượt quét, một mã POS trên dòng và đó là mã của lượt; số lượng sau lượt quét = 1, có đơn vị; KHÔNG có thao tác sửa
  //     lượng nào TRƯỚC lần đổi đơn vị đầu tiên (audit PM 23/10: tăng lượng từ một lượt quét khi chưa biết phần thêm thuộc EPC nào → giữ
  //     dòng; đổi đơn vị trước rồi nhập lượng trong đơn vị mới → được xét); chuỗi diễn biến LIỀN MẠCH: không thao tác nào trước lượt quét,
  //     mỗi thao tác bắt đầu đúng ở (số lượng, đơn vị) mốc trước để lại, sau thao tác cuối = response COMPLETED (thiếu response / thay đổi
  //     extension không thấy — ở máy khác, lời gọi lạ — làm lệch một mốc); MỌI thao tác mang mã sản phẩm và = sản phẩm dòng cuối (thiếu →
  //     giữ); không có lời gọi /item của dòng mà extension không phân loại được;
  //   - lượng (buildNotifyPreview): base_quantity của response cuối, đã kiểm = quantity × convert_rate của đơn vị cuối; KHÔNG ép unitRatio
  //     của tem bằng convert_rate (tem có thể là cả hộp); EPC còn ≥ base_quantity (tra lại ngay trước POST như mọi EPC).
  // Bấm + / − không đổi đơn vị, nhiều UID trên dòng → giữ dòng (chưa có căn cứ chia lượng cho nhiều EPC).
  const NOTIFY_LINE_RULE_UNIT_CHANGE = "single_uid_unit_change";
  // v0.7.10.5 (audit PM 23/10/2026, finding 2): đơn phải được TẠO (created_date) VÀ HOÀN TẤT (completed_date) sau mốc — không dùng
  // status_updated_at (đơn hoàn tất trước nâng cấp rồi được mở / sửa lại có mốc trạng thái sau mốc nhưng vẫn là đơn cũ).
  function notifyUnitChangeMarkerOk(ord, marker) {
    const at = marker && typeof marker === "object" ? textOrNull(marker.at) : null;
    if (parseTime(at) === null) return false;
    const o = ord && typeof ord === "object" ? ord : {};
    const created = textOrNull(o.createdDate);
    const completed = textOrNull(o.completedDate);
    return !!created && !!completed && posTimeCompare(created, at) > 0 && posTimeCompare(completed, at) > 0;
  }
  function isUnitChangeAction(a) {
    const from = textOrNull(a && a.previousUnit);
    const to = textOrNull(a && a.modifiedUnit);
    return !!from && !!to && from !== to;
  }
  // v0.7.12.1 (PM audit 24/10/2026, P1 "sửa lượng ở máy khác"): POS nối mã vào items[].qr_codes ở MỌI POST /item có qr_code — quét (+1), + / −,
  // đổi đơn vị (fixture pos-item-actions/README, DHC01294054, DHC01296932); thanh toán / hoàn tất không nối. Lượt quét / thao tác trên máy ghi số
  // phần tử qr_codes của dòng SAU lời gọi (modifiedQrCount; thao tác thêm previousQrCount = snapshot trước). Chuỗi lời gọi ghi của máy này phải phủ
  // kín nhật ký của dòng: sắp theo số đếm sau, mỗi lời gọi bắt đầu đúng ở số đếm lời gọi trước để lại, số đếm sau lời gọi cuối = số phần tử
  // qr_codes của response COMPLETED. Bước nối: lượt quét đúng 1 (không cần số đếm trước — hai lượt quét song song vẫn khớp vì POS xếp tuần tự);
  // thao tác CHỈ đổi đơn vị (số lượng giữ nguyên) đúng 2 (DHC01294054: quét 1 + đổi 2 = 3; DHC01296932: quét 1 + đổi 2 + quét lại 1 = 4) và số
  // đếm trước = số lời gọi trước để lại; thao tác đổi lượng ≥ 1 (dòng đó đã bị giữ vì sửa lượng). Dòng được trừ chỉ gồm lượt quét + đổi đơn vị
  // thuần nên mọi bước đều xác định: lời gọi ghi ở máy / tab khác — kể cả xen giữa khi trang máy này chưa tải lại (số đếm trước cũ, bước dài hơn)
  // — luôn làm lệch một bước hoặc số cuối. POS nối khác mô hình → giữ dòng (an toàn), không bao giờ ngược lại. v0.7.12.2: CHỈ phủ lời gọi CÓ
  // qr_code — đường ghi không nối qr_codes (nhập lượng tay, thêm theo tên, trang / API khác) không thấy được → nhánh đổi đơn vị chỉ gửi tay
  // (notifyUnitChangeLines).
  //   finalCount: số phần tử qr_codes của dòng trong response cuối (posItems); scans / acts: lượt quét / item_quantity_set của dòng trên máy này.
  //   → null | chi tiết (thiếu số đếm, nhật ký đứt, nhật ký cuối dài hơn) — có lời gọi ghi máy này không thấy hoặc không chứng minh được.
  const POS_LOG_STEP_SCAN = 1;
  const POS_LOG_STEP_UNIT_CHANGE = 2;
  function notifyLineWriteProblem(finalCount, scans, acts) {
    if (!Number.isInteger(finalCount)) return "response cuối không có qr_codes";
    const writes = (scans || [])
      .map((e) => ({ scan: true, unitOnly: false, before: null, after: e && e.modifiedQrCount }))
      .concat((acts || []).map((a) => ({ scan: false, unitOnly: isUnitChangeAction(a) && a.previousQuantity === a.modifiedQuantity, before: a && a.previousQrCount, after: a && a.modifiedQrCount })));
    const missing = writes.filter((w) => qrCountOrNull(w.after) === null || (!w.scan && qrCountOrNull(w.before) === null)).length;
    if (missing) return "thiếu số đếm qr_codes ở " + missing + "/" + writes.length + " lời gọi của máy này";
    writes.sort((x, y) => x.after - y.after);
    let prev = 0;
    for (const w of writes) {
      const ok = w.scan ? w.after === prev + POS_LOG_STEP_SCAN : w.before === prev && (w.unitOnly ? w.after === w.before + POS_LOG_STEP_UNIT_CHANGE : w.after > w.before);
      if (!ok) return "qr_codes " + prev + " → " + (w.scan ? "lượt quét " : (w.unitOnly ? "đổi đơn vị " : "thao tác ") + w.before + "→") + w.after;
      prev = w.after;
    }
    return finalCount === prev ? null : "qr_codes cuối " + finalCount + " ≠ " + prev + " sau lời gọi cuối của máy này";
  }
  //   list        : lượt quét gắn dòng (đã sắp theo giờ quét); lineActions: item_quantity_set của dòng (đã sắp theo giờ).
  //   → null (không áp — luật từng UID như cũ) | { problems: [{ code, detail?, eventId? }], codeOf: Map(eventId → mã POS), path }
  function notifyUnitChangeLine(it, list, posCodes, lineActions, unclear) {
    const acts = Array.isArray(lineActions) ? lineActions : [];
    if (!acts.some(isUnitChangeAction)) return null;
    const first = list[0];
    const scanUnit = first ? textOrNull(first.modifiedUnit) : null;
    if (!first || (scanUnit && scanUnit === it.unit)) return null;
    const shown = (v) => (v === null || v === undefined ? "—" : String(v));
    const problems = [];
    const codeOf = new Map();
    const odd = Array.isArray(unclear) ? unclear : [];
    if (odd.length) problems.push({ code: "quantity_edit_unclear", detail: odd.join(", ") });
    if (list.length !== 1 || posCodes.size !== 1) {
      problems.push({ code: "unit_change_multi_uid", detail: "UID " + posCodes.size + " · lượt " + list.length });
      return { problems, codeOf, path: null };
    }
    const mine = notifyScanCodes(first).filter((c) => posCodes.has(c));
    if (mine.length !== 1) {
      problems.push({ code: first.source === SOURCE.RFID ? "rfid_uid_not_on_line" : "scan_code_not_on_line", eventId: first.eventId, detail: mine.length ? mine.join(", ") : "no_pos_code" });
      return { problems, codeOf, path: null };
    }
    codeOf.set(first.eventId, mine[0]);
    const q0 = first.modifiedQuantity;
    if (typeof q0 !== "number" || !Number.isFinite(q0) || !scanUnit) {
      problems.push({ code: "quantity_history_unknown" });
      return { problems, codeOf, path: null };
    }
    if (q0 !== 1) problems.push({ code: "quantity_history_mismatch", detail: "SL sau lượt quét " + q0 });
    const step = (q, u) => shown(q) + " " + shown(u);
    // v0.7.10.5 (audit PM 23/10/2026, finding 1): mọi thao tác TRƯỚC lần đổi đơn vị đầu tiên là sửa lượng (+ / − / sửa tay; thao tác bản cũ
    // không có previousUnit cũng tính) — vd 1 viên → 2 viên → 2 vỉ → giữ cả dòng. Đổi đơn vị kèm lượng trong CÙNG một lời gọi là lần đổi
    // đơn vị đầu tiên (không phải sửa lượng trước đó).
    const lead = acts.slice(0, acts.findIndex(isUnitChangeAction));
    if (lead.length) problems.push({ code: "quantity_edited_before_unit_change", detail: lead.map((a) => shown(a.previousQuantity) + "→" + step(a.modifiedQuantity, textOrNull(a.modifiedUnit))).join(", ") });
    // v0.7.12 (PM audit 24/10/2026, luật 2): TỪ lần đổi đơn vị đầu tiên trở đi, thao tác nào làm đổi GIÁ TRỊ số lượng (+ / − / nhập tay, kể cả
    // một lời gọi vừa đổi đơn vị vừa đổi lượng — vd 1 hộp → 8 viên) → giữ cả dòng. Chỉ đổi đơn vị với số lượng giữ nguyên (1 viên → 1 vỉ →
    // 1 hộp) mới được xét trừ base_quantity cuối (lượng cơ sở đổi theo hệ số đơn vị mới là hợp lệ).
    const fromFirstUnit = acts.slice(acts.findIndex(isUnitChangeAction));
    const valueEdits = fromFirstUnit.filter((a) => typeof a.previousQuantity === "number" && typeof a.modifiedQuantity === "number" && a.modifiedQuantity !== a.previousQuantity);
    if (valueEdits.length) problems.push({ code: "unit_change_quantity_edited", detail: valueEdits.map((a) => step(a.previousQuantity, textOrNull(a.previousUnit)) + "→" + step(a.modifiedQuantity, textOrNull(a.modifiedUnit))).join(", ") });
    const path = [step(q0, scanUnit)];
    const at0 = String(first.scannedAt || "");
    const lineProduct = it.productId === null || it.productId === undefined || it.productId === "" ? null : String(it.productId);
    let cur = { q: q0, u: scanUnit };
    let broken = null;
    for (const a of acts) {
      const pu = textOrNull(a.previousUnit);
      const nu = textOrNull(a.modifiedUnit);
      if (String(a.scannedAt || "") < at0) broken = broken || "thao tác trước lượt quét";
      else if (a.previousQuantity !== cur.q || pu !== cur.u) broken = broken || "trước thao tác " + step(a.previousQuantity, pu) + " ≠ " + step(cur.q, cur.u);
      // v0.7.10.5 (audit PM 23/10, mục 3): thao tác thiếu mã sản phẩm (hoặc dòng cuối thiếu) không chứng minh được thuộc đúng sản phẩm → giữ.
      const ap = a.productId === null || a.productId === undefined || a.productId === "" ? null : String(a.productId);
      if (!ap || !lineProduct) {
        if (!problems.some((p) => p.code === "unit_change_product_unverified")) problems.push({ code: "unit_change_product_unverified", eventId: a.eventId, detail: !ap ? "thao tác thiếu mã sản phẩm" : "dòng cuối thiếu mã sản phẩm" });
      } else if (ap !== lineProduct && !problems.some((p) => p.code === "product_mismatch")) problems.push({ code: "product_mismatch", eventId: a.eventId });
      if (typeof a.modifiedQuantity !== "number" || !Number.isFinite(a.modifiedQuantity) || !nu) {
        broken = broken || "thao tác thiếu số lượng / đơn vị";
        break;
      }
      cur = { q: a.modifiedQuantity, u: nu };
      path.push(step(cur.q, cur.u));
    }
    if (!broken && (cur.q !== it.quantity || cur.u !== it.unit)) broken = "sau thao tác cuối " + step(cur.q, cur.u) + " ≠ response cuối " + step(it.quantity, it.unit);
    if (broken) problems.push({ code: "unit_change_chain_broken", detail: broken });
    return { problems, codeOf, path: path.join(" → ") };
  }

  // v0.7.10: kiểm lượng của MỘT EPC (UID đã đạt chứng minh dòng + bằng chứng tag): mỗi UID là đúng một đơn vị bán (convert_rate C).
  //   - mọi EPC: baseUnit Nextwaves = đơn vị cơ sở của dòng (v0.7.8.2);
  //   - dòng N ≥ 2 đơn vị: tem đúng một đơn vị bán (unitRatio = C) và còn nguyên (lượng còn = C) — như nhánh nhiều tem v0.7.8;
  //   - dòng 1 đơn vị: lượng còn ≥ base_quantity (như v0.7.5–v0.7.9 cho dòng một tem).
  //   → null (đạt) | { code, extra }
  function notifyUnitTagProblem(ev, epc, held, it, n) {
    const unitProblem = tagBaseUnitProblem(ev, epc, it.baseUnit);
    if (unitProblem) return { code: "tag_base_unit_mismatch", extra: unitProblem };
    const C = it.convertRate;
    const same = (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v - C) <= 1e-9;
    const shown = (v) => (v === null || v === undefined ? "—" : String(v));
    if (n >= 2) {
      if (!same(ev && ev.unitRatio)) return { code: "tag_unit_ratio_mismatch", extra: { epc, detail: "unitRatio " + shown(ev && ev.unitRatio) + " / convert_rate " + C } };
      if (!same(held)) return { code: "tag_not_full_unit", extra: { epc, detail: "còn " + shown(held) + " / convert_rate " + C } };
      return null;
    }
    if (!(typeof held === "number" && it.baseQuantity <= held + 1e-9)) return { code: "quantity_exceeds_tags", extra: { epc, detail: "cần " + shown(it.baseQuantity) + " / còn " + shown(held) } };
    return null;
  }

  // v0.7.8.1 / v0.7.8.2 (audit PM 14/10/2026): quantity của payload tính theo đơn vị cơ sở của dòng POS → tag phải cùng đơn vị cơ sở
  // (baseUnit Nextwaves). So sau NFC, bỏ khoảng trắng đầu / cuối, không phân biệt hoa thường ("Viên " = "viên"; "ml" ≠ "viên").
  //   → null (cùng đơn vị) | { epc, detail } cho lý do tag_base_unit_mismatch (thiếu / khác).
  function baseUnitKey(v) {
    return typeof v === "string" && v.trim() ? v.normalize("NFC").trim().toLowerCase() : null;
  }
  function tagBaseUnitProblem(ev, epc, lineBaseUnit) {
    const tagUnit = baseUnitKey(ev && ev.baseUnit);
    if (tagUnit && tagUnit === baseUnitKey(lineBaseUnit)) return null;
    const shown = (v) => (v === null || v === undefined ? "—" : String(v));
    return { epc, detail: "baseUnit " + shown(ev && ev.baseUnit) + " / POS " + shown(lineBaseUnit) };
  }

  // Bản xem trước trừ tồn của MỘT đơn. Thuần — cùng đầu vào cho cùng kết quả (không phụ thuộc thứ tự khoá / thứ tự lượt).
  //   ord         : bản ghi ord: đã gộp (có stockItems / stockItemsVersion).
  //   events      : các bản ghi ev: (lọc theo đơn bên trong) — lượt quét và (v0.7.10) thao tác POS sale_order_action.
  //   tagEvidence : { [EPC]: bằng chứng lượng tag } (tagHoldingProblem).
  // → { state, reasons[], manual[], items[], excluded[], unplaced[], dismissed[], epcs[], payload|null, payloadJson|null, tagCount, rule, summary }
  //   reasons = lý do cấp ĐƠN (chặn mọi POST: cổng đơn, dữ liệu chưa ghi xong, lượt không gắn dòng, completed_items lệch, chưa rõ...).
  //   manual (v0.7.10) = phần giữ lại xử lý thủ công: { code, scope: "line" | "uid", itemId, uid?, epc?, eventId?, detail? } — KHÔNG chặn
  //   các dòng / UID khác. payload chỉ có khi reasons rỗng và có ít nhất một EPC đạt (state prepared); needs_review không có payload.
  //   opts (v0.7.5): { pendingLocal: số mục hàng chờ pend:* của đơn trên máy gửi, completedRecords: bản ghi ci: của đơn }.
  //   opts.fixMarker (v0.7.9.1): mốc cài — thiếu thì không lượt nào được bỏ qua (luật cũ).
  //   opts.posActionDiag (v0.7.10): chẩn đoán lời gọi /item không phân loại được (KEYS.posActionDiag) — dòng có chẩn đoán bị giữ.
  //   opts.unitChangeMarker (v0.7.10.4 / v0.7.10.5): mốc cài — luật một tem đổi đơn vị chỉ áp cho đơn được TẠO và HOÀN TẤT sau mốc (thiếu mốc → luật cũ).
  function buildNotifyPreview(ord, events, tagEvidence, opts) {
    const po = opts && typeof opts === "object" ? opts : {};
    const reasons = [];
    const seen = new Set();
    const add = (code, extra) => {
      const r = Object.assign({ code }, extra || {});
      const k = canonicalJson(r);
      if (!seen.has(k)) {
        seen.add(k);
        reasons.push(r);
      }
    };
    const manual = [];
    const seenManual = new Set();
    const keep = (entry) => {
      const k = canonicalJson(entry);
      if (!seenManual.has(k)) {
        seenManual.add(k);
        manual.push(entry);
      }
    };
    const o = ord && typeof ord === "object" ? ord : {};
    const out = {
      orderId: isUuid(o.orderId) ? o.orderId : null,
      orderCode: textOrNull(o.orderCode),
      state: NOTIFY_STATE.NEEDS_REVIEW,
      reasons,
      manual,
      rule: NOTIFY_RULE,
      items: [],
      excluded: [],
      unplaced: [],
      dismissed: [], // v0.7.9.1: lượt QR "unplaced" không chặn (notifyUnplacedDismissal) — chỉ để truy vết
      epcs: [],
      payload: null,
      payloadJson: null,
      tagCount: 0,
      summary: null,
    };
    const gate = notifyOrderVerdict(ord);
    if (!gate.ok) {
      add(gate.reason, gate.detail ? { detail: gate.detail } : null);
      return out;
    }
    const evidence = tagEvidence && typeof tagEvidence === "object" ? tagEvidence : {};
    // v0.7.5: dữ liệu của đơn phải đã LƯU BỀN trên máy gửi (không còn mục hàng chờ chưa ghi) trước khi lập payload.
    if (Number(po.pendingLocal) > 0) add("local_data_pending", { count: Number(po.pendingLocal) });
    const names = o.productNames && typeof o.productNames === "object" ? o.productNames : {};
    const itemsById = new Map();
    for (const it of o.stockItems) if (it && isUuid(it.itemId)) itemsById.set(it.itemId, it);
    const scans = (Array.isArray(events) ? events : [])
      .filter((e) => isLogEvent(e) && e.orderId === o.orderId)
      .slice()
      .sort((a, b) => String(a.scannedAt || "").localeCompare(String(b.scannedAt || "")) || String(a.eventId || "").localeCompare(String(b.eventId || "")));

    const byItem = new Map(); // itemId → lượt đã gắn dòng
    const epcUids = new Map(); // EPC → Set(tagUid)
    const uidEpcs = new Map(); // tagUid → Set(EPC)
    const epcItems = new Map(); // EPC → Set(itemId)
    for (const e of scans) {
      const role = notifyScanRole(e);
      if (!role) continue;
      if (role === "unplaced") {
        const dismissed = notifyUnplacedDismissal(e, o, po.fixMarker);
        if (dismissed) {
          out.dismissed.push(dismissed);
          continue;
        }
        out.unplaced.push({ eventId: e.eventId, source: e.source, uid: textOrNull(e.uid), epc: normalizeEpcStrict(e.epc), scannedAt: textOrNull(e.scannedAt) });
        add("unplaced_scan", { eventId: e.eventId });
        continue;
      }
      const itemId = String(e.modifiedItemId).toLowerCase();
      if (!itemsById.has(itemId)) {
        // Dòng đã bị xoá khỏi danh sách cuối: không tham gia payload.
        out.excluded.push({ eventId: e.eventId, itemId, reason: "item_removed", epc: normalizeEpcStrict(e.epc), uid: textOrNull(e.uid) });
        continue;
      }
      const list = byItem.get(itemId) || [];
      list.push(e);
      byItem.set(itemId, list);
      const t = notifyScanTag(e);
      if (t.kind === "tag") {
        if (!epcUids.has(t.epc)) epcUids.set(t.epc, new Set());
        if (t.tagUid) epcUids.get(t.epc).add(t.tagUid);
        if (t.tagUid) {
          if (!uidEpcs.has(t.tagUid)) uidEpcs.set(t.tagUid, new Set());
          uidEpcs.get(t.tagUid).add(t.epc);
        }
        if (!epcItems.has(t.epc)) epcItems.set(t.epc, new Set());
        epcItems.get(t.epc).add(itemId);
      }
    }
    // v0.7.10 (PM 17/10/2026 — "UID/EPC trùng → giữ cả dòng"): EPC / UID trùng giữ MỌI dòng có EPC / UID đó, không chặn cả đơn.
    const dupEpc = new Map(); // EPC → mã lý do
    const dupUid = new Set();
    for (const [epc, uids] of epcUids) if (uids.size > 1) dupEpc.set(epc, "epc_conflict");
    for (const [uid, epcs] of uidEpcs) if (epcs.size > 1) dupUid.add(uid);
    for (const [epc, ids] of epcItems) if (ids.size > 1 && !dupEpc.has(epc)) dupEpc.set(epc, "epc_multi_item");
    // v0.7.10 (finding 1): thao tác đổi số lượng extension quan sát được + lời gọi /item không phân loại được — theo dòng.
    const shown = (v) => (v === null || v === undefined ? "—" : String(v));
    const edits = new Map(); // itemId → ["1→2 chai", …]
    const actions = (Array.isArray(events) ? events : [])
      .filter((a) => isActionEvent(a) && a.orderId === o.orderId && a.action === POS_ACTION.QUANTITY_SET && isUuid(a.modifiedItemId))
      .sort((a, b) => String(a.scannedAt || "").localeCompare(String(b.scannedAt || "")) || String(a.eventId || "").localeCompare(String(b.eventId || "")));
    const lineActs = new Map(); // v0.7.10.4: itemId → item_quantity_set của dòng (đã sắp theo giờ) — luật một tem đổi đơn vị
    for (const a of actions) {
      const id = a.modifiedItemId.toLowerCase();
      // v0.7.10.4: thao tác đổi đơn vị ghi rõ đơn vị trước ("1 viên→1 vỉ"); thao tác chỉ đổi lượng giữ dạng cũ ("1→2 vỉ").
      const from = isUnitChangeAction(a) ? " " + a.previousUnit : "";
      edits.set(id, (edits.get(id) || []).concat([shown(a.previousQuantity) + from + "→" + shown(a.modifiedQuantity) + (textOrNull(a.modifiedUnit) ? " " + a.modifiedUnit : "")]));
      lineActs.set(id, (lineActs.get(id) || []).concat([a]));
    }
    const unitMarkerOk = notifyUnitChangeMarkerOk(o, po.unitChangeMarker);
    // v0.7.12.1: số phần tử qr_codes từng dòng của response cuối (posItems cùng response với stockItems — stockItemsIntegrityProblem).
    const posLog = new Map();
    for (const p of Array.isArray(o.posItems) ? o.posItems : []) if (p && typeof p.itemId === "string" && Array.isArray(p.qrCodes)) posLog.set(p.itemId.toLowerCase(), p.qrCodes.length);
    const unclear = new Map(); // itemId → [lý do chẩn đoán]
    const diags = (Array.isArray(po.posActionDiag) ? po.posActionDiag : []).filter((d) => d && d.orderId === o.orderId && isUuid(d.itemId));
    for (const d of diags.slice().sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")))) unclear.set(d.itemId, (unclear.get(d.itemId) || []).concat([String(d.reason || "unknown")]));

    const payloadTags = [];
    const candidateEpcs = new Set(); // EPC cần bằng chứng lượng (dòng chưa bị giữ)
    const sortedItems = [...itemsById.values()].sort((a, b) => a.itemId.localeCompare(b.itemId));
    for (const it of sortedItems) {
      const nm = names[it.itemId] || {};
      const row = {
        itemId: it.itemId,
        productId: it.productId,
        productName: textOrNull(nm.name),
        productCode: textOrNull(nm.code),
        quantity: it.quantity,
        unit: it.unit,
        baseQuantity: it.baseQuantity,
        baseUnit: it.baseUnit,
        convertRate: it.convertRate,
        status: "ok",
        reasons: [],
        tags: [],
        noRfidEventIds: [],
        uids: [],
      };
      // v0.7.10: flag = giữ CẢ dòng (xử lý thủ công; dòng khác của đơn vẫn xét). wait = chờ / chưa rõ → lý do cấp đơn, 0 POST.
      const flag = (code, extra) => {
        row.status = "held";
        if (row.reasons.indexOf(code) < 0) row.reasons.push(code);
        keep(Object.assign({ code, scope: "line", itemId: it.itemId }, extra || {}));
      };
      const wait = (code, extra) => {
        if (row.reasons.indexOf(code) < 0) row.reasons.push(code);
        add(code, Object.assign({ itemId: it.itemId }, extra || {}));
      };
      out.items.push(row);
      const posCodes = new Set(Array.isArray(it.qrCodes) ? it.qrCodes : []);
      const list = byItem.get(it.itemId) || [];
      const tags = new Map(); // EPC → { epc, uid, eventIds, first, last, qr, rfid }
      for (const e of list) {
        if (e.productId !== null && e.productId !== undefined && e.productId !== "" && it.productId && String(e.productId) !== String(it.productId)) {
          flag("product_mismatch", { eventId: e.eventId });
        }
        const t = notifyScanTag(e);
        if (t.kind !== "tag") continue;
        const at = String(e.scannedAt || "");
        const cur = tags.get(t.epc) || { epc: t.epc, uid: t.tagUid, eventIds: [], first: at, last: at, qr: false, rfid: false };
        cur.eventIds.push(e.eventId);
        if (!cur.uid) cur.uid = t.tagUid;
        if (e.source === SOURCE.QR) cur.qr = true;
        else cur.rfid = true;
        if (at < cur.first) cur.first = at;
        if (at > cur.last) cur.last = at;
        tags.set(t.epc, cur);
      }
      if (!list.length) flag("item_no_scan");
      // v0.7.5 (PM 07/10/2026 — đơn có thể chuyển giữa POS-01 / POS-02): mỗi mã QR POS ghi trên dòng phải có ít nhất một lượt quét
      // TRÊN MÁY GỬI (mã quét, UID, UID tem con, đoạn cuối URL). Thiếu → dữ liệu cục bộ không đủ (có thể quét ở máy khác) → giữ dòng.
      // Audit PM 08/10 (P1): CHỈ lượt QR "accepted" gắn đúng dòng chứng minh mã QR đã quét tại máy gửi.
      // v0.7.7 (spec PM 12/10/2026): lượt RFID "added" trên máy gửi, reader đọc được EPC, UID trùng mã POS ghi trên đúng dòng này cũng
      // chứng minh mã đó. RFID "unconfirmed" / khác "added" mà mang đúng mã → code_rfid_unconfirmed; không có lượt nào →
      // scan_not_on_this_machine.
      const qrProof = new Set();
      const rfidProof = new Set();
      const rfidWeak = new Set();
      for (const e of list) {
        if (e.source === SOURCE.QR && e.status === VERDICT.ACCEPTED) {
          for (const c of [e.qrCode, e.uid, e.resolvedUid, extractQrCode(e.qrRaw)]) if (textOrNull(c)) qrProof.add(c);
        } else if (e.source === SOURCE.RFID && textOrNull(e.uid)) {
          (e.result === RESULT.ADDED && normalizeEpcStrict(e.epc) ? rfidProof : rfidWeak).add(e.uid);
        }
      }
      for (const c of posCodes) {
        if (qrProof.has(c) || rfidProof.has(c)) continue;
        // v0.7.12 (PM audit 24/10/2026): đơn sau mốc cài → tên lý do nói rõ dòng chuyển máy / thiếu lịch sử thao tác (đơn cũ giữ mã cũ).
        flag(rfidWeak.has(c) ? "code_rfid_unconfirmed" : unitMarkerOk ? "cross_station_action_history_unknown" : "scan_not_on_this_machine", { detail: c });
      }
      // v0.7.12.1 (PM audit 24/10/2026): đơn sau mốc → mọi lời gọi ghi lên dòng (nhật ký qr_codes của POS) phải là lượt / thao tác của máy này.
      // Bắt cả ca mã đã quét ở máy này nhưng dòng bị + / − ở máy khác (giá trị cuối có thể trùng chuỗi trên máy).
      if (unitMarkerOk && list.length) {
        const wp = notifyLineWriteProblem(posLog.get(it.itemId), list, lineActs.get(it.itemId));
        if (wp) flag("line_write_unseen", { detail: wp });
      }
      // v0.7.10 (finding 1): diễn biến số lượng — + / − / sửa tay, lời gọi không phân loại được, mốc số lượng sau từng lượt quét.
      // v0.7.10.4: dòng một tem đổi đơn vị bán (đơn sau mốc cài) → chứng cứ riêng (notifyUnitChangeLine) thay cho mốc 1, 2, …, N.
      const uc = unitMarkerOk && list.length ? notifyUnitChangeLine(it, list, posCodes, lineActs.get(it.itemId), unclear.get(it.itemId)) : null;
      if (uc) {
        row.rule = NOTIFY_LINE_RULE_UNIT_CHANGE;
        row.unitChange = uc.path;
      }
      const hist = uc || (list.length ? notifyLineHistory(it, list, posCodes, edits.get(it.itemId), unclear.get(it.itemId)) : { problems: [], codeOf: new Map() });
      for (const p of hist.problems) flag(p.code, Object.assign(p.eventId ? { eventId: p.eventId } : {}, p.detail ? { detail: p.detail } : {}));
      // UID / EPC trùng (trong đơn) → giữ dòng.
      for (const t of tags.values()) {
        if (dupEpc.has(t.epc)) flag(dupEpc.get(t.epc), { epc: t.epc });
        if (t.uid && dupUid.has(t.uid)) flag("uid_conflict", { epc: t.epc, detail: t.uid });
      }
      // Phân loại từng UID (một lượt / một mã POS mỗi UID — đã chứng minh ở trên khi dòng chưa bị giữ).
      const uidRows = new Map(); // mã POS → { uid, eventId, source, epc, kind, reasons, held, quantity }
      for (const e of list) {
        const code = hist.codeOf.get(e.eventId);
        if (!code || uidRows.has(code)) continue;
        const t = notifyScanTag(e);
        uidRows.set(code, { uid: code, eventId: e.eventId, source: e.source, epc: t.kind === "tag" ? t.epc : null, kind: t.kind === "tag" ? "tag" : t.kind === "no_rfid" ? "no_epc" : "review", reasons: [], held: null, quantity: null, review: t.kind === "review" ? t : null });
      }
      const held = row.status === "held";
      const fail = (u, code, extra) => {
        u.kind = "fail";
        if (u.reasons.indexOf(code) < 0) u.reasons.push(code);
        keep(Object.assign({ code, scope: "uid", itemId: it.itemId, uid: u.uid }, extra || {}));
      };
      if (!held) {
        for (const u of uidRows.values()) {
          if (u.kind === "no_epc") row.noRfidEventIds.push(u.eventId);
          if (u.kind !== "review") continue;
          const t = u.review;
          const extra = Object.assign({ eventId: u.eventId }, t.detail ? { detail: t.detail } : {});
          // Dứt khoát (giữ UID): mã không phải UID tem (uid_invalid), mã cha nhiều tem con, RFID thiếu EPC. Còn lại (chưa tra, lỗi mạng /
          // token / hợp đồng, "mapped" mà thiếu EPC) → chờ, 0 POST cả đơn.
          if (t.code === "mapping_multiple" || t.code === "rfid_epc_missing" || (t.code === "mapping_error" && t.detail === NOTIFY_DISMISS_MAPPING_ERROR)) fail(u, t.code, extra);
          else {
            u.kind = "wait";
            wait(t.code, extra);
          }
        }
      }
      const tagRows = [...uidRows.values()].filter((u) => u.kind === "tag");
      if (!held && tagRows.length) {
        // Quy đổi: base_quantity của response cuối, kiểm chéo quantity × convert_rate của đơn vị bán (lỗi → giữ cả dòng).
        const Q = it.baseQuantity;
        if (Q === null) flag("base_quantity_missing");
        else if (!(Q > 0)) flag("quantity_invalid");
        if (it.convertRate === null || !(it.convertRate > 0)) flag("convert_rate_missing");
        if (!it.baseUnit || it.baseRate !== 1) flag("base_unit_missing");
        if (Q !== null && Q > 0 && it.convertRate > 0) {
          if (it.quantity === null || Math.abs(it.quantity * it.convertRate - Q) > 1e-9) flag("conversion_mismatch");
          else if (it.saleUnit !== null && it.unit !== null && it.saleUnit !== it.unit) flag("conversion_mismatch", { detail: "unit_name" });
        }
      }
      const byFirst = [...tags.values()].sort((a, b) => b.first.localeCompare(a.first) || a.epc.localeCompare(b.epc));
      if (row.status !== "held") {
        for (const t of byFirst) {
          const u = tagRows.find((x) => x.epc === t.epc);
          if (!u) continue;
          candidateEpcs.add(t.epc);
          const ev = evidence[t.epc];
          // v0.7.7: tag của lượt RFID cũng phải có unitUid Nextwaves trùng UID đã đọc (UID đó là bằng chứng mã POS của dòng).
          const problem = tagHoldingProblem(ev, it.productId, t.uid, t.qr || t.rfid);
          t.held = ev && typeof ev.held === "number" && Number.isFinite(ev.held) ? ev.held : null;
          u.held = t.held;
          const detail = ev && ev.reason ? { detail: String(ev.reason) } : {};
          if (problem === "tag_holding_unknown" || (problem === "tag_holding_error" && NOTIFY_HOLDING_DEFINITIVE.indexOf(ev.reason) < 0)) {
            u.kind = "wait";
            wait(problem, Object.assign({ epc: t.epc }, detail));
            continue;
          }
          if (problem) {
            fail(u, problem, Object.assign({ epc: t.epc }, detail));
            continue;
          }
          // v0.7.10.4: một tem cho cả dòng đổi đơn vị → kiểm như dòng một tem (baseUnit + còn ≥ base_quantity), không đòi unitRatio = C.
          const unitProblem = notifyUnitTagProblem(ev, t.epc, t.held, it, uc ? 1 : it.quantity);
          if (unitProblem) {
            fail(u, unitProblem.code, unitProblem.extra);
            continue;
          }
          u.kind = "pass";
          u.quantity = uc ? it.baseQuantity : it.convertRate;
        }
      }
      const isHeld = row.status === "held";
      const uidList = isHeld ? [...posCodes].sort().map((c) => uidRows.get(c) || { uid: c, eventId: null, source: null, epc: null, reasons: [], held: null, quantity: null }) : [...uidRows.values()].sort((a, b) => a.uid.localeCompare(b.uid));
      row.uids = uidList.map((u) => ({ uid: u.uid, eventId: u.eventId, source: u.source, epc: u.epc, kind: isHeld ? "held" : u.kind, reasons: isHeld ? [] : u.reasons.slice(), held: u.held, quantity: isHeld ? null : u.quantity }));
      row.tags = byFirst.map((t) => {
        const u = row.uids.find((x) => x.epc === t.epc);
        return { epc: t.epc, uid: t.uid, eventIds: t.eventIds.slice(), firstScanAt: t.first, lastScanAt: t.last, held: typeof t.held === "number" ? t.held : null, quantity: u && u.kind === "pass" ? u.quantity : null };
      });
      if (isHeld) continue;
      const count = (k) => row.uids.filter((u) => u.kind === k).length;
      const pass = count("pass");
      const failed = count("fail");
      if (count("wait")) row.status = "review";
      else if (!failed) row.status = pass ? "ok" : "no_rfid";
      else row.status = pass ? "partial" : "failed";
      for (const u of row.uids) if (u.kind === "pass") payloadTags.push({ epc: u.epc, quantity: u.quantity });
    }
    // v0.7.12 (PM audit 24/10/2026 + luật máy gửi PM 13/10): đơn sau mốc cài có mã QR trên dòng mà máy này KHÔNG có lượt quét nào của đơn
    // → máy chỉ quan sát (đơn quét ở máy khác): lý do cấp đơn, không gửi; sổ vẫn ghi (trạng thái "observer", dòng uid_observer không mang lượng)
    // để đơn không biến mất khỏi đối soát khi máy đã quét không thấy response COMPLETED.
    // v0.7.12.1 (audit PM 24/10, P1 dòng observer): thao tác + / − ở máy này KHÔNG làm máy thành máy quét — trước đây máy chỉ có thao tác ghi
    // dòng "Cần kiểm tra" mang lượng, cộng trùng với dòng của máy đã quét trong hàng chờ thủ công.
    if (unitMarkerOk && scans.length === 0 && sortedItems.some((it) => Array.isArray(it.qrCodes) && it.qrCodes.length > 0)) add("observed_other_station");
    // v0.7.5: completed_items dùng để ĐỐI CHIẾU dòng hàng (không phải nguồn tính lượng): ci: của đúng phiên bản đơn phải có đủ mọi
    // itemId với cùng số lượng + đơn vị bán, không dòng thừa.
    if (Array.isArray(po.completedRecords)) {
      const rows = po.completedRecords.filter((r) => r && r.orderId === o.orderId && posTimeCompare(r.orderUpdatedAt, o.updatedDate) === 0);
      for (const it of sortedItems) {
        const r = rows.filter((x) => x.modifiedItemId === it.itemId);
        if (r.length !== 1 || r[0].modifiedQuantity !== it.quantity || textOrNull(r[0].modifiedUnit) !== it.unit) add("completed_items_mismatch", { itemId: it.itemId });
      }
      if (rows.some((x) => !itemsById.has(x.modifiedItemId))) add("completed_items_mismatch", { detail: "extra_rows" });
    }
    out.epcs = [...candidateEpcs].sort();
    const uidsOf = (k) => out.items.reduce((n, r) => n + r.uids.filter((u) => u.kind === k).length, 0);
    out.summary = { lines: out.items.length, passEpcs: payloadTags.length, failedUids: uidsOf("fail"), noEpcUids: uidsOf("no_epc"), heldLines: out.items.filter((r) => r.status === "held").length };
    if (!reasons.length) {
      if (!payloadTags.length) add(manual.length ? "no_passing_epc" : "no_rfid_tags");
      else if (payloadTags.length > NOTIFY_MAX_TAGS) add("too_many_tags", { count: payloadTags.length });
    }
    out.tagCount = payloadTags.length;
    if (reasons.length) return out;
    payloadTags.sort((a, b) => a.epc.localeCompare(b.epc));
    // Thứ tự khoá cố định (orderId, tags; epc, quantity) → chuỗi JSON ổn định = đúng chuỗi được băm và được gửi.
    // v0.7.9: orderId = mã DHC của response POS cuối (đã qua notifyOrderVerdict), không phải UUID POS.
    out.payload = { orderId: o.stockItemsCode, tags: payloadTags.map((t) => ({ epc: t.epc, quantity: t.quantity })) };
    out.payloadJson = JSON.stringify(out.payload);
    out.state = NOTIFY_STATE.PREPARED;
    return out;
  }

  // Lượng còn trong tag — GET /api/v1/public/integrations/circa/epcs/{epc}. Hợp đồng theo response THẬT 06/10/2026
  // (tests/fixtures/notify/nextwaves-epc-*.json): 200 kể cả khi không có tag (found:false); trường phẳng
  //   epc, found, status ("active"), unitUid, circaProductId (= product_id POS), unit, unitRatio (lượng cơ sở của cả gói),
  //   baseUnit, baseQuantity (lượng CÒN trong tag, đơn vị cơ sở — tag đã mở: 30 / unitRatio 100), warehouseId, lot, expiry.
  // Sai hợp đồng (thiếu found / EPC lệch / baseQuantity không phải số) → lỗi "contract:*", không đoán.
  function parseNotifyEpcHolding(status, json, epc) {
    if (status === 401 || status === 403) return { ok: false, reason: "auth:http_" + status };
    if (!Number.isInteger(status) || status < 200 || status > 299) return { ok: false, reason: "http_" + status };
    const j = json && typeof json === "object" && !Array.isArray(json) ? json : null;
    if (!j) return { ok: false, reason: "contract:not_object" };
    if (j.found === false) return { ok: false, reason: "epc_not_found" };
    if (j.found !== true) return { ok: false, reason: "contract:found" };
    const want = normalizeEpcStrict(epc);
    if (!want || normalizeEpcStrict(j.epc) !== want) return { ok: false, reason: "contract:epc_mismatch" };
    if (typeof j.baseQuantity !== "number" || !Number.isFinite(j.baseQuantity) || j.baseQuantity < 0) return { ok: false, reason: "contract:base_quantity" };
    if (typeof j.status !== "string" || !j.status) return { ok: false, reason: "contract:status" };
    return {
      ok: true,
      held: j.baseQuantity,
      active: j.status.toLowerCase() === "active",
      status: j.status,
      productId: j.circaProductId === null || j.circaProductId === undefined || j.circaProductId === "" ? null : String(j.circaProductId),
      unitUid: textOrNull(j.unitUid),
      unit: textOrNull(j.unit),
      unitRatio: typeof j.unitRatio === "number" && Number.isFinite(j.unitRatio) ? j.unitRatio : null,
      baseUnit: textOrNull(j.baseUnit),
      warehouseId: textOrNull(j.warehouseId),
    };
  }

  // Kết quả POST /orders/notify → { state: confirmed | rejected | ambiguous, reason, result }. result đã lược: chỉ mã / outcome /
  // EPC / thông điệp ngắn — không header, không token, không response thô.
  //   res: { transport?, status?, json? } của lớp mạng chung.
  function notifyVerdict(res, payload) {
    const S = NOTIFY_STATE;
    const r = res && typeof res === "object" ? res : {};
    const short = (v, n) => (typeof v === "string" ? v.slice(0, n || 200) : v === null || v === undefined ? null : typeof v === "object" ? canonicalJson(v).slice(0, n || 200) : String(v).slice(0, n || 200));
    const epcList = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? normalizeEpcStrict(x) : x && typeof x === "object" ? normalizeEpcStrict(x.epc) : null)) : null);
    if (r.transport) {
      // Lớp mạng chặn TRƯỚC khi fetch (thiếu token, cổng notify từ chối): chắc chắn chưa có request nào rời máy.
      if (r.transport === "no_token" || r.transport === "notify_blocked") return { state: S.REJECTED, reason: "not_sent:" + r.transport, result: { transport: r.transport } };
      // Timeout / mạng: request có thể đã tới Nextwaves → không rõ, KHÔNG tự gửi lại.
      return { state: S.AMBIGUOUS, reason: "transport:" + r.transport, result: { transport: r.transport } };
    }
    const j = r.json && typeof r.json === "object" && !Array.isArray(r.json) ? r.json : null;
    const stockOut = j && j.stockOut && typeof j.stockOut === "object" ? j.stockOut : null;
    const result = {
      httpStatus: Number.isInteger(r.status) ? r.status : null,
      success: j && typeof j.success === "boolean" ? j.success : null,
      imported: j && typeof j.imported === "boolean" ? j.imported : null,
      // ID đơn bên Nextwaves (KHÔNG phải UUID Circa — audit PM 06/10, P1): chỉ ghi lại để đối soát.
      nextwavesOrderId: j ? short(j.orderId, 80) : null,
      // v0.7.9: định danh Circa mà Nextwaves ghi nhận (nếu response có) — phải là orderId đã gửi (DHC; UUID với job cũ).
      externalOrderId: j && typeof j.externalOrderId === "string" ? short(j.externalOrderId.trim(), 80) : null,
      created: j && typeof j.created === "boolean" ? j.created : null,
      rfidLines: j && Number.isFinite(j.rfidLines) ? j.rfidLines : null,
      untaggedLines: j && Number.isFinite(j.untaggedLines) ? j.untaggedLines : null,
      // Header Idempotent-Replay: "true"/"false" như server gửi; không có header → null (không suy diễn).
      replay: typeof r.replay === "string" ? r.replay.trim().toLowerCase() === "true" : null,
      status: j ? short(j.status, 60) : null,
      skipped: j ? short(j.skipped, 120) : null,
      outcome: stockOut ? short(stockOut.outcome, 60) : null,
      detail: stockOut ? short(stockOut.detail, 300) : null,
      // Lỗi Nextwaves: { message: "INVALID_API_CREDENTIALS", error: "Unauthorized", statusCode: 401 } — mã nằm ở message.
      code: j ? short(j.code || j.errorCode || (typeof j.message === "string" && /^[A-Z][A-Z0-9_]+$/.test(j.message) ? j.message : null) || (j.error && typeof j.error === "object" ? j.error.code : j.error), 120) : null,
      message: j ? short(j.message, 200) : null,
      settledEpcs: j ? epcList(j.settledEpcs) : null,
      assignedEpcs: j ? epcList(j.assignedEpcs) : null,
    };
    const st = result.httpStatus;
    if (st === null) return { state: S.AMBIGUOUS, reason: "no_status", result };
    if (st >= 500) return { state: S.AMBIGUOUS, reason: "http_" + st, result };
    if (st < 200 || st > 299) {
      // 4xx: Nextwaves từ chối rõ trước khi xử lý (xác thực, plugin tắt, dữ liệu sai). 408/409/425/429 không nói rõ đơn đã được
      // xử lý hay chưa (hết giờ chờ, trùng / xung đột, quá tải) → không rõ.
      if (st >= 400 && [408, 409, 425, 429].indexOf(st) < 0) return { state: S.REJECTED, reason: "http_" + st + (result.code ? ":" + result.code : ""), result };
      // Tài liệu Nextwaves v2: 409 IDEMPOTENCY_KEY_REUSED = key đã dùng cho endpoint khác → từ chối rõ (không xử lý, không gửi lại).
      if (st === 409 && result.code === "IDEMPOTENCY_KEY_REUSED") return { state: S.REJECTED, reason: "http_409:IDEMPOTENCY_KEY_REUSED", result };
      return { state: S.AMBIGUOUS, reason: "http_" + st + (result.code ? ":" + result.code : ""), result };
    }
    if (!j) return { state: S.AMBIGUOUS, reason: "body_not_json", result };
    if (result.imported === false && result.skipped) return { state: S.REJECTED, reason: "skipped:" + result.skipped, result };
    const outcome = result.outcome ? String(result.outcome).toUpperCase() : null;
    if (outcome === "FAILED" || outcome === "REFUSED" || outcome === "NO_RFID") return { state: S.REJECTED, reason: "outcome:" + outcome, result };
    if (outcome !== "STOCKED_OUT" || result.success !== true || result.imported !== true) return { state: S.AMBIGUOUS, reason: "outcome_unclear", result };
    const p = payload && typeof payload === "object" ? payload : {};
    const want = (Array.isArray(p.tags) ? p.tags : []).map((t) => t.epc).sort();
    // v0.7.9: Nextwaves trả externalOrderId khác định danh đã gửi → không nhận là đã trừ cho đơn này; đối soát tay (không gửi lại).
    if (result.externalOrderId !== null && result.externalOrderId !== String(p.orderId || "")) return { state: S.AMBIGUOUS, reason: "external_order_mismatch", result };
    const settled = Array.isArray(result.settledEpcs) ? result.settledEpcs.filter(Boolean) : null;
    if (!settled) return { state: S.AMBIGUOUS, reason: "settled_epcs_missing", result };
    const missing = want.filter((x) => settled.indexOf(x) < 0);
    if (missing.length) return { state: S.AMBIGUOUS, reason: "epc_not_settled:" + missing.length, result };
    // v0.7.10 (PM 17/10/2026): settledEpcs phải KHỚP đúng các EPC đã gửi — có EPC không nằm trong yêu cầu / phần tử không đọc được →
    // không báo trừ thành công (đối soát tay, không gửi lại).
    const extra = [...new Set(settled)].filter((x) => want.indexOf(x) < 0);
    if (extra.length || settled.length !== result.settledEpcs.length) return { state: S.AMBIGUOUS, reason: "epc_settled_mismatch:" + (extra.length || result.settledEpcs.length - settled.length), result };
    return { state: S.CONFIRMED, reason: "stocked_out", result };
  }

  // Cấu hình pilot (popup máy gửi ghi): { orderIds: UUID[] (≤ 5), senderStationId, updatedAt }. Giá trị lạ → rỗng (fail-closed).
  function normalizeNotifyPilot(v) {
    const o = v && typeof v === "object" && !Array.isArray(v) ? v : {};
    const ids = [];
    for (const x of Array.isArray(o.orderIds) ? o.orderIds : []) {
      const id = typeof x === "string" ? x.trim().toLowerCase() : "";
      if (isUuid(id) && ids.indexOf(id) < 0) ids.push(id);
    }
    return { orderIds: ids.slice(0, NOTIFY_PILOT_MAX_ORDERS), senderStationId: normalizeStationId(o.senderStationId), updatedAt: textOrNull(o.updatedAt) };
  }
  // Máy này có được dựng job / gửi cho đơn này không: đúng máy gửi (mã trạm cấu hình = trạm được chỉ định) + đơn trong allowlist.
  function notifyPilotAllows(pilot, stationId, orderId) {
    const p = normalizeNotifyPilot(pilot);
    const st = normalizeStationId(stationId);
    if (!p.senderStationId) return { ok: false, reason: "no_sender" };
    if (!st || st !== p.senderStationId) return { ok: false, reason: "not_sender_station" };
    const id = typeof orderId === "string" ? orderId.toLowerCase() : "";
    if (p.orderIds.indexOf(id) < 0) return { ok: false, reason: "not_in_allowlist" };
    return { ok: true, reason: null };
  }

  // Idempotency-Key của lần gửi ĐẦU (tài liệu Nextwaves 06/10: dùng orderId của body; ≤ 128 ký tự).
  // v0.7.9: = orderId của payload = mã DHC của chính job (response POS cuối). Gửi lại luôn dùng frozen.idempotencyKey.
  function notifyIdempotencyKey(job) {
    const code = job && job.payload && typeof job.payload.orderId === "string" ? job.payload.orderId : "";
    return NOTIFY_ORDER_CODE_RE.test(code) && code === textOrNull(job.orderCode) ? code : null;
  }

  function notifyStarted(job) {
    return !!job && NOTIFY_STARTED_STATES.indexOf(job.state) >= 0;
  }

  // Snapshot đơn ghi vào job (chỉ trường cần đối soát — không response thô, không khách hàng).
  function notifyOrderSnapshot(ord) {
    const o = ord && typeof ord === "object" ? ord : {};
    return {
      orderId: textOrNull(o.orderId),
      orderCode: textOrNull(o.orderCode),
      orderType: textOrNull(o.orderType),
      status: textOrNull(o.status),
      createdDate: textOrNull(o.createdDate),
      completedDate: textOrNull(o.completedDate),
      updatedDate: textOrNull(o.updatedDate),
      items: Array.isArray(o.stockItems) ? o.stockItems.map((it) => Object.assign({}, it)) : null,
    };
  }

  const NOTIFY_HISTORY_MAX = 30;
  function notifyHistory(job, entry) {
    const prev = job && Array.isArray(job.history) ? job.history : [];
    return prev.concat([entry]).slice(-NOTIFY_HISTORY_MAX);
  }

  // v0.7.10.1 (audit PM 17/10/2026, P1): v0.7.9.1 / v0.7.10 khoá VĨNH VIỄN mọi job "Cần kiểm tra" lúc nâng cấp — nhưng "Cần kiểm tra"
  // không chứng minh đơn đã được trừ thủ công (DHC01272338 / DHC01272069 chưa xử lý). Thay bằng: ĐƠN CŨ (chưa từng gửi, có từ trước mốc
  // cài) KHÔNG BAO GIỜ tự gửi (notifyAutoOrderVerdict); bản xem trước vẫn dựng theo luật hiện hành để đối chiếu; GỬI TAY qua pilot chỉ khi
  // người vận hành xác nhận đơn CHƯA được xử lý trên Nextwaves (notifyLegacySendVerdict). Job đã bắt đầu gửi không đổi gì (payload / key
  // đóng băng như cũ). Đơn cũ = job chưa gửi có lúc ghi mốc (fixMarker.legacy) HOẶC đơn không có mốc COMPLETED SAU mốc cài (kể cả thiếu
  // bản ghi đơn / thiếu mốc POS).
  //   → null (đơn sau mốc) | "pre_upgrade" | "no_fix_marker" (chưa có mốc — không gửi gì)
  const NOTIFY_PRE_UPGRADE = "pre_upgrade";
  function notifyPreUpgrade(orderId, ord, fixMarker) {
    const m = fixMarker && typeof fixMarker === "object" ? fixMarker : null;
    const at = m ? textOrNull(m.at) : null;
    if (parseTime(at) === null) return "no_fix_marker";
    const id = String(orderId || "").toLowerCase();
    if (Array.isArray(m.legacy) && m.legacy.some((x) => String(x || "").toLowerCase() === id)) return NOTIFY_PRE_UPGRADE;
    const o = ord && typeof ord === "object" ? ord : null;
    if (!o || !(posTimeCompare(completedStatusAt(o), at) > 0)) return NOTIFY_PRE_UPGRADE;
    return null;
  }
  // Cổng thêm của GỬI TAY (approveNotify, sau notifySendVerdict): đơn cũ cần xác nhận của người vận hành — cờ legacyConfirmed của CHÍNH lần
  // bấm gửi (popup chỉ gửi cờ khi ô "đã kiểm Nextwaves: đơn CHƯA được xử lý thủ công" được tick). → { ok, reason }
  function notifyLegacySendVerdict(pre, confirmed) {
    if (!pre) return { ok: true, reason: null };
    if (pre !== NOTIFY_PRE_UPGRADE) return { ok: false, reason: pre };
    return confirmed === true ? { ok: true, reason: null } : { ok: false, reason: "legacy_unconfirmed" };
  }
  // v0.7.12.2 (PM handoff 24/10/2026, P1 giới hạn an toàn của auto): nhật ký qr_codes (notifyLineWriteProblem) chỉ thấy lời gọi POST /item CÓ
  // qr_code; POS chưa có nguồn lịch sử theo dòng phủ mọi đường ghi (nhập lượng tay, thêm theo tên sản phẩm, trang quản trị / API khác, mở lại
  // đơn — bản đồ ở dist/review/v0.7.12.2-pos-write-paths.md). Dòng thường: mỗi đơn vị bán ứng đúng một tem quét trên máy gửi (SL = số UID =
  // số lượt, notifyLineHistory) → lượng gửi không dựa vào "không có sửa ẩn". Dòng một tem chỉ đổi đơn vị: phần base_quantity vượt đơn vị đã
  // quét chỉ đúng khi KHÔNG có sửa lượng nào — code không chứng minh được → job có dòng đó (đạt mọi chứng cứ khác) KHÔNG BAO GIỜ tự gửi
  // (notifyAutoSendVerdict); gửi tay (đơn pilot) chỉ khi CHÍNH lần bấm mang xác nhận đã xem nhật ký hoạt động của đơn trên POS.
  //   → itemId các dòng một tem đổi đơn vị có EPC đạt (hoặc EPC nằm trong payload) — rỗng = job không thuộc nhánh này.
  function notifyUnitChangeLines(job) {
    const items = job && job.preview && Array.isArray(job.preview.items) ? job.preview.items : [];
    const sent = new Set((job && job.payload && Array.isArray(job.payload.tags) ? job.payload.tags : []).map((t) => t && t.epc).filter(Boolean));
    return items.filter((it) => it && it.rule === NOTIFY_LINE_RULE_UNIT_CHANGE && Array.isArray(it.uids) && it.uids.some((u) => u && (u.kind === "pass" || sent.has(u.epc)))).map((it) => it.itemId);
  }
  // Cổng thêm của GỬI TAY (approveNotify): cờ unitChangeConfirmed của CHÍNH lần bấm (popup chỉ gửi khi ô xác nhận được tick cho đúng payload).
  function notifyUnitChangeSendVerdict(job, confirmed) {
    if (!notifyUnitChangeLines(job).length) return { ok: true, reason: null };
    return confirmed === true ? { ok: true, reason: null } : { ok: false, reason: "unit_change_history_unconfirmed" };
  }

  // Job sau một lần dựng lại bản xem trước (chỉ khi CHƯA bắt đầu gửi). Payload đổi → phiếu duyệt cũ mất hiệu lực.
  // → { job, changed }. Bằng chứng tem (tagEvidence) đi kèm job để đối soát.
  // v0.7.10.1: không còn job bị giữ — khoá hold của job do v0.7.9.1 / v0.7.10 ghi (máy thử) rơi ở lần dựng lại; đơn cũ do notifyPreUpgrade xét.
  function notifyJobAfterPreview(prev, ord, preview, tagEvidence, payloadHash, nowIso, orderId) {
    if (notifyStarted(prev)) return { job: prev, changed: false };
    const p = prev && typeof prev === "object" ? prev : null;
    const view = preview;
    const next = {
      orderId: view.orderId || (p && p.orderId) || (isUuid(orderId) ? orderId : null),
      orderCode: view.orderCode || (p && p.orderCode) || null,
      state: view.state,
      reasons: view.reasons,
      snapshot: notifyOrderSnapshot(ord),
      preview: { items: view.items, excluded: view.excluded, unplaced: view.unplaced, tagCount: view.tagCount },
      tagEvidence: tagEvidence && typeof tagEvidence === "object" ? tagEvidence : {},
      payload: view.payload,
      payloadJson: view.payloadJson,
      payloadHash: view.payload ? payloadHash || null : null,
      approval: null,
      attempt: null,
      result: null,
      createdAt: (p && p.createdAt) || nowIso,
      updatedAt: p ? p.updatedAt : nowIso,
      history: p && Array.isArray(p.history) ? p.history : [],
    };
    // Chỉ thêm khoá khi có lượt bỏ qua: job không có lượt nào giữ nguyên nội dung như v0.7.9 (không ghi lại job / sổ vô cớ).
    if (Array.isArray(view.dismissed) && view.dismissed.length) next.preview.dismissed = view.dismissed;
    // v0.7.10: luật trừ theo từng UID — phần giữ lại xử lý thủ công + tóm tắt (job dựng bởi bản cũ không có các khoá này).
    if (view.rule) {
      next.manual = Array.isArray(view.manual) ? view.manual : [];
      next.preview.rule = view.rule;
      next.preview.summary = view.summary || null;
    }
    const same = p && sameContent(notifyJobContent(p), notifyJobContent(next));
    if (same) return { job: p, changed: false };
    next.updatedAt = nowIso;
    if (!p || p.state !== next.state || p.payloadHash !== next.payloadHash) {
      next.history = notifyHistory(next, { at: nowIso, from: p ? p.state : null, to: next.state, payloadHash: next.payloadHash, reasons: next.reasons.map((r) => r.code).slice(0, 10) });
    }
    return { job: next, changed: true };
  }
  function notifyJobContent(j) {
    const c = Object.assign({}, j || {});
    delete c.updatedAt;
    delete c.createdAt;
    delete c.history;
    // tagEvidence (kể cả checkedAt) là nội dung: worker dựa vào checkedAt đã lưu để giãn nhịp tra lại lượng tag.
    return c;
  }

  // v0.7.10 (PM 17/10/2026, finding 4): trạng thái đơn phải nói đúng kết quả. Nextwaves xác nhận mọi EPC ĐÃ GỬI không có nghĩa mọi EPC
  // của đơn đã được xử lý — job còn phần giữ lại (manual) → "Đã trừ một phần; còn EPC cần xử lý thủ công", kèm số EPC đã xác nhận /
  // đã gửi và số UID / dòng còn phải xử lý thủ công. Popup và sổ stock_out dùng chung.
  const NOTIFY_PARTIAL_LABELS = Object.freeze({
    confirmed: "Đã trừ một phần; còn EPC cần xử lý thủ công",
    prepared: "Sẵn sàng gửi một phần — phần còn lại xử lý thủ công",
  });
  function notifyOutcome(job) {
    const j = job && typeof job === "object" ? job : {};
    const manual = Array.isArray(j.manual) ? j.manual.filter((m) => m && typeof m === "object") : [];
    const failedUids = new Set(manual.filter((m) => m.scope === "uid").map((m) => m.itemId + "|" + m.uid)).size;
    const heldLines = new Set(manual.filter((m) => m.scope === "line").map((m) => m.itemId)).size;
    const started = notifyStarted(j);
    const sent = payloadQuantities(started ? (j.frozen && j.frozen.payloadJson) || j.payloadJson : j.payloadJson) || new Map();
    const settled = new Set(j.result && Array.isArray(j.result.settledEpcs) ? j.result.settledEpcs : []);
    const confirmedEpcs = j.state === NOTIFY_STATE.CONFIRMED ? [...sent.keys()].filter((epc) => settled.has(epc)).length : 0;
    const partial = manual.length > 0;
    const summary = j.preview && j.preview.summary && typeof j.preview.summary === "object" ? j.preview.summary : null;
    return {
      state: textOrNull(j.state),
      partial,
      label: partial && NOTIFY_PARTIAL_LABELS[j.state] ? NOTIFY_PARTIAL_LABELS[j.state] : NOTIFY_STATE_LABELS[j.state] || textOrNull(j.state),
      sentEpcs: started ? sent.size : 0,
      plannedEpcs: started ? 0 : sent.size,
      confirmedEpcs,
      failedUids,
      heldLines,
      noEpcUids: summary && Number.isInteger(summary.noEpcUids) ? summary.noEpcUids : 0,
    };
  }

  // Cổng GỬI cuối cùng (worker, trong khoá notify:<đơn>): đúng máy, đúng allowlist, job prepared, phiếu duyệt khớp payload hash.
  function notifySendVerdict(job, pilot, stationId, approvalHash) {
    const allow = notifyPilotAllows(pilot, stationId, job && job.orderId);
    if (!allow.ok) return allow;
    if (!job || typeof job !== "object") return { ok: false, reason: "no_job" };
    if (notifyStarted(job)) return { ok: false, reason: "already_started" };
    if (job.state !== NOTIFY_STATE.PREPARED) return { ok: false, reason: "not_prepared" };
    if (!job.payload || !job.payloadJson || !job.payloadHash) return { ok: false, reason: "no_payload" };
    if (typeof approvalHash !== "string" || approvalHash !== job.payloadHash) return { ok: false, reason: "hash_mismatch" };
    // Chuỗi được gửi là payloadJson (đúng chuỗi đã băm); object payload chỉ để hiển thị — hai bên phải cùng nội dung.
    let parsed = null;
    try {
      parsed = JSON.parse(job.payloadJson);
    } catch (_) {
      parsed = null;
    }
    if (!parsed || !sameContent(parsed, job.payload)) return { ok: false, reason: "payload_tampered" };
    return { ok: true, reason: null };
  }

  // v0.7.7: cổng gửi của CHẾ ĐỘ AUTO (worker, trong khoá notify:<đơn>, sau khi dựng lại với lượng tag tra MỚI). Không có phiếu
  // duyệt của người — thay vào đó công tắc auto + máy gửi + đơn trong phạm vi auto do worker kiểm (notifyAutoActive /
  // notifyAutoOrderVerdict) trước khi gọi hàm này. Như notifySendVerdict: job prepared, chưa bắt đầu, chuỗi gửi = payload.
  function notifyAutoSendVerdict(job) {
    if (!job || typeof job !== "object") return { ok: false, reason: "no_job" };
    if (notifyStarted(job)) return { ok: false, reason: "already_started" };
    if (job.state !== NOTIFY_STATE.PREPARED) return { ok: false, reason: "not_prepared" };
    if (!job.payload || !job.payloadJson || !job.payloadHash) return { ok: false, reason: "no_payload" };
    let parsed = null;
    try {
      parsed = JSON.parse(job.payloadJson);
    } catch (_) {
      parsed = null;
    }
    if (!parsed || !sameContent(parsed, job.payload) || parsed.orderId !== notifyIdempotencyKey(job)) return { ok: false, reason: "payload_tampered" };
    // v0.7.12.2: dòng một tem chỉ đổi đơn vị → chỉ gửi tay sau khi người kiểm xem nhật ký POS (notifyUnitChangeLines).
    if (notifyUnitChangeLines(job).length) return { ok: false, reason: "unit_change_manual_only" };
    return { ok: true, reason: null };
  }

  // v0.7.5 (PM 07/10/2026 + tài liệu Nextwaves v2): kết quả "không rõ" vì request có thể chưa được xử lý (timeout, mất kết nối,
  // worker dừng giữa chừng, 5xx, 408 / 409 IN_PROGRESS / 425 / 429) → được GỬI LẠI THỦ CÔNG, đúng NGUYÊN payload đã đóng băng và
  // đúng Idempotency-Key của lần đầu (Nextwaves trả lại response cũ, không trừ lần hai). Server đã trả 2xx mà kết quả không rõ
  // (outcome lạ, thiếu / lệch settledEpcs, body không phải JSON) → KHÔNG gửi lại (tài liệu: không retry nguyên request) — đối soát tay.
  const NOTIFY_RESENDABLE_RE = /^(transport:|http_5\d\d$|http_408$|http_409(:[A-Z0-9_]+)?$|http_425$|http_429$|worker_restart$)/;
  function notifyResendable(job) {
    if (!job || job.state !== NOTIFY_STATE.AMBIGUOUS) return false;
    const reason = String((job.result && job.result.reason) || "");
    return NOTIFY_RESENDABLE_RE.test(reason);
  }
  // Audit PM 08/10 (P1): yêu cầu đóng băng phải nguyên vẹn TRƯỚC khi gửi lại — JSON đúng hình dạng payload (1–200 tag, EPC chuẩn
  // không trùng, quantity > 0), chuỗi đúng dạng JSON.stringify của chính nó, orderId của chuỗi = Idempotency-Key đóng băng. Hash tính
  // lại từ chuỗi (SHA-256) do worker kiểm (bất đồng bộ) ngay sau hàm này, vẫn trước POST.
  // v0.7.9: định danh đóng băng = UUID POS của job (job bắt đầu gửi TRƯỚC v0.7.9 — giữ nguyên từng byte, không bao giờ chuyển sang
  // DHC) HOẶC mã DHC của chính job (job gửi từ v0.7.9). Định danh khác → không gửi lại.
  function notifyFrozenProblem(job) {
    const f = job && job.frozen;
    if (!f || typeof f !== "object") return "not_frozen";
    if (typeof f.payloadJson !== "string" || !f.payloadJson || typeof f.payloadHash !== "string" || typeof f.idempotencyKey !== "string" || !f.idempotencyKey) return "not_frozen";
    if (!/^[0-9a-f]{64}$/.test(f.payloadHash)) return "frozen_hash_invalid";
    const key = f.idempotencyKey;
    const code = textOrNull(job.orderCode);
    if (!((isUuid(job.orderId) && key === job.orderId) || (code && NOTIFY_ORDER_CODE_RE.test(code) && key === code))) return "frozen_key_mismatch";
    let p;
    try {
      p = JSON.parse(f.payloadJson);
    } catch (_) {
      return "frozen_json_invalid";
    }
    if (!p || typeof p !== "object" || Array.isArray(p)) return "frozen_json_invalid";
    if (p.orderId !== key) return "frozen_order_mismatch";
    const tags = Array.isArray(p.tags) ? p.tags : null;
    if (!tags || !tags.length || tags.length > NOTIFY_MAX_TAGS) return "frozen_tags_invalid";
    const seen = new Set();
    for (const t of tags) {
      const ok = t && typeof t === "object" && typeof t.epc === "string" && normalizeEpcStrict(t.epc) === t.epc && !seen.has(t.epc) && typeof t.quantity === "number" && Number.isFinite(t.quantity) && t.quantity > 0;
      if (!ok) return "frozen_tags_invalid";
      seen.add(t.epc);
    }
    if (JSON.stringify({ orderId: p.orderId, tags: tags.map((t) => ({ epc: t.epc, quantity: t.quantity })) }) !== f.payloadJson) return "frozen_json_invalid";
    return null;
  }

  function notifyResendVerdict(job, pilot, stationId, payloadHash) {
    let allow = notifyPilotAllows(pilot, stationId, job && job.orderId);
    // v0.7.7: job do AUTO gửi (không nằm trong allowlist) — người vận hành trên đúng máy gửi được gửi lại thủ công đúng yêu cầu cũ.
    if (!allow.ok && allow.reason === "not_in_allowlist" && job && job.approval && job.approval.auto === true) allow = { ok: true, reason: null };
    if (!allow.ok) return allow;
    if (!job || typeof job !== "object") return { ok: false, reason: "no_job" };
    if (job.state !== NOTIFY_STATE.AMBIGUOUS) return { ok: false, reason: "not_ambiguous" };
    if (!notifyResendable(job)) return { ok: false, reason: "not_resendable" };
    const fp = notifyFrozenProblem(job);
    if (fp) return { ok: false, reason: fp };
    const f = job.frozen;
    if (typeof payloadHash !== "string" || payloadHash !== f.payloadHash) return { ok: false, reason: "hash_mismatch" };
    return { ok: true, reason: null };
  }

  // Worker khởi động lại lúc job đang "submitting" (POST đã có thể tới Nextwaves): KHÔNG gửi lại — ambiguous, chờ đối soát.
  // v0.7.7: job của chế độ auto ghi kèm lịch tự gửi lại (cùng chuỗi + key đóng băng) — xem notifyAutoRetryPlan.
  function notifyRecoverJob(job, nowIso) {
    if (!job || job.state !== NOTIFY_STATE.SUBMITTING) return { job, changed: false };
    const next = Object.assign({}, job, { state: NOTIFY_STATE.AMBIGUOUS, result: { reason: "worker_restart", at: nowIso }, updatedAt: nowIso });
    next.history = notifyHistory(job, { at: nowIso, from: job.state, to: next.state, reason: "worker_restart" });
    return { job: notifyAutoStamp(next, parseTime(nowIso)), changed: true };
  }

  // ======================================================================================================================
  // v0.7.7 — tự động trừ tồn OFFLINE (spec PM 12/10/2026). Cùng máy trạng thái notify:<orderId>, cùng đường POST.
  //  - Công tắc notifyAuto {enabled, enabledAt, updatedAt} do popup của CHÍNH máy đó ghi; mặc định tắt. Auto chỉ chạy khi công tắc
  //    bật, có mốc bật hợp lệ VÀ máy này đã tự cấp quyền gửi (notifyPilot.senderStationId = mã trạm của chính nó). Không cần
  //    allowlist. Audit PM 12/10 (lần 2): mỗi POS tự cấp quyền + bật auto → cả POS-01 và POS-02 cùng bật được; mỗi máy chỉ gửi đơn có
  //    đủ bằng chứng trên chính nó (đơn của máy kia → "Cần kiểm tra"); sổ stock_out có mã trạm trong khoá dòng.
  //  - Chỉ đơn OFFLINE có mốc COMPLETED SAU mốc bật auto. Đơn đã có job đã gửi (thủ công / auto) không bao giờ có request mới.
  //  - Tự gửi lại ĐÚNG chuỗi + Idempotency-Key đóng băng cho lý do notifyResendable (timeout, mạng, worker dừng, 5xx, 408,
  //    409 IN_PROGRESS, 425, 429): tối đa 5 lượt tính cả lần đầu, nhịp 2 s → 5 s → 15 s → 60 s (tài liệu Nextwaves), trong 23 giờ
  //    kể từ lần đầu (Nextwaves giữ response 24 giờ). Thời điểm đến hạn tính từ job (bền) — worker thức dậy là tiếp tục.
  // ======================================================================================================================
  const NOTIFY_AUTO_MAX_ATTEMPTS = 5;
  const NOTIFY_AUTO_RETRY_DELAYS_MS = Object.freeze([2000, 5000, 15000, 60000]);
  const NOTIFY_AUTO_WINDOW_MS = 23 * 60 * 60 * 1000;
  const NOTIFY_AUTO_LABELS = Object.freeze({
    auto_off: "Tự động trừ tồn đang tắt",
    no_sender: "Máy này chưa được quyền gửi — chỉ ghi quan sát",
    not_sender_station: "Quyền gửi đã lưu cho mã trạm khác (đổi mã trạm?) — máy này chỉ ghi quan sát",
    completed_before_auto: "Đơn COMPLETED trước lúc bật tự động — không tự gửi",
    awaiting_approval: "Đơn pilot — chờ người duyệt gửi",
    auto_pending: "Đủ điều kiện — tự động gửi ở lượt kế tiếp",
    not_auto: "Gửi thủ công — không tự gửi lại",
    exhausted: "Đã tự gửi đủ 5 lượt — dừng, cần đối soát",
    window_expired: "Quá 23 giờ kể từ lần gửi đầu — dừng tự gửi lại, cần đối soát",
    not_resendable: "Kết quả không cho phép gửi lại — cần đối soát",
    frozen_problem: "Yêu cầu đóng băng không nguyên vẹn — không gửi lại, cần đối soát",
    frozen_hash_mismatch: "Chuỗi đóng băng băm lại không khớp hash đã lưu — dừng tự gửi lại, cần đối soát",
    auto_retry_at: "Tự gửi lại đúng yêu cầu cũ lúc",
    pos_changed_after_send: "POS đổi / hoàn đơn sau khi đã gửi trừ tồn — cần đối soát (không tự gửi lại, không hoàn tồn)",
    // v0.7.10.1 (audit PM 17/10/2026, P1): đơn cũ (notifyPreUpgrade) — không khoá, không tự gửi; gửi tay cần xác nhận.
    pre_upgrade: "Đơn có từ TRƯỚC khi cài v0.7.10.1 — không tự gửi; đối chiếu Nextwaves, chỉ gửi tay (đơn pilot) khi người vận hành xác nhận đơn CHƯA được xử lý thủ công",
    no_fix_marker: "Chưa ghi được mốc cài v0.7.10.1 — chưa gửi",
    legacy_unconfirmed: "Đơn có từ trước khi cài v0.7.10.1 — chưa xác nhận đơn CHƯA được xử lý thủ công trên Nextwaves, không gửi",
    legacy_confirmed: "Đơn có từ trước khi cài v0.7.10.1 — người vận hành đã xác nhận CHƯA xử lý thủ công trên Nextwaves trước khi gửi tay",
    // v0.7.12.2 (PM handoff 24/10/2026, P1 giới hạn auto): dòng một tem chỉ đổi đơn vị (notifyUnitChangeLines) — không tự gửi; gửi tay cần xác nhận.
    unit_change_manual_only: "Có dòng một tem chỉ đổi đơn vị bán — KHÔNG tự gửi: POS chưa có nguồn lịch sử phủ mọi đường sửa dòng (nhập lượng tay, thêm theo tên sản phẩm, trang / API khác) để máy chứng minh không có sửa lượng; chỉ gửi tay (đơn pilot) sau khi người kiểm xem nhật ký hoạt động của đơn trên POS",
    unit_change_history_unconfirmed: "Có dòng một tem chỉ đổi đơn vị bán — chưa xác nhận đã xem nhật ký hoạt động của đơn trên POS, không gửi",
    unit_change_history_confirmed: "Dòng một tem chỉ đổi đơn vị bán — người vận hành xác nhận nhật ký hoạt động của đơn trên POS chỉ có thêm / quét và đổi đơn vị (không đổi số lượng, không xoá / thêm lại dòng) trước khi gửi tay",
  });

  function normalizeNotifyAuto(v) {
    const o = v && typeof v === "object" && !Array.isArray(v) ? v : {};
    const enabledAt = textOrNull(o.enabledAt) && parseTime(o.enabledAt) !== null ? o.enabledAt : null;
    return { enabled: o.enabled === true && !!enabledAt, enabledAt, updatedAt: textOrNull(o.updatedAt) };
  }
  // Máy này có đang chạy auto không: công tắc bật (kèm mốc) + đúng máy gửi được chỉ định.
  function notifyAutoActive(auto, pilot, stationId) {
    const a = normalizeNotifyAuto(auto);
    const p = normalizeNotifyPilot(pilot);
    const st = normalizeStationId(stationId);
    if (!a.enabled) return { ok: false, reason: "auto_off" };
    if (!p.senderStationId) return { ok: false, reason: "no_sender" };
    if (!st || st !== p.senderStationId) return { ok: false, reason: "not_sender_station" };
    return { ok: true, reason: null };
  }
  // Đơn có thuộc phạm vi auto: đơn bán OFFLINE, đang COMPLETED, mốc COMPLETED (status_updated_at / completed_date của POS) SAU mốc bật.
  // v0.7.10.1 (audit PM 17/10/2026, P1): và KHÔNG phải đơn cũ so với mốc cài v0.7.10.1 (notifyPreUpgrade — thiếu mốc cũng không gửi).
  function notifyAutoOrderVerdict(ord, auto, fixMarker) {
    const a = normalizeNotifyAuto(auto);
    const o = ord && typeof ord === "object" ? ord : null;
    if (!o || !isUuid(o.orderId) || recordTypeOf(o) !== RECORD_TYPE.SALE_ORDER) return { ok: false, reason: "not_sale_order" };
    if (String(o.orderType || "").trim().toUpperCase() !== "OFFLINE") return { ok: false, reason: "order_type" };
    if (o.status !== ORDER_COMPLETED) return { ok: false, reason: "order_not_completed" };
    if (!a.enabledAt) return { ok: false, reason: "auto_off" };
    if (!(posTimeCompare(completedStatusAt(o), a.enabledAt) > 0)) return { ok: false, reason: "completed_before_auto" };
    const pre = notifyPreUpgrade(o.orderId, o, fixMarker);
    if (pre) return { ok: false, reason: pre };
    return { ok: true, reason: null };
  }

  // Lịch tự gửi lại của MỘT job auto "không rõ kết quả" → { due, at (ms) | null, reason }. Chỉ job có lần gửi gần nhất do auto
  // (attempt.auto) — người bấm gửi lại thủ công thì auto không gửi tiếp. Mốc lần đầu: auto.firstAt (= frozen.at của lần auto đầu).
  function notifyAutoRetryPlan(job, nowMs) {
    const no = (reason) => ({ due: false, at: null, reason });
    if (!job || !job.attempt || job.attempt.auto !== true) return no("not_auto");
    if (job.state !== NOTIFY_STATE.AMBIGUOUS) return no("not_ambiguous");
    // Worker đã dừng tự gửi lại job này (vd chuỗi đóng băng băm lại không khớp hash) — không thử nữa.
    if (job.auto && textOrNull(job.auto.halt)) return no(job.auto.halt);
    if (!notifyResendable(job)) return no("not_resendable");
    if (notifyFrozenProblem(job)) return no("frozen_problem");
    const n = Number.isInteger(job.attempt.n) && job.attempt.n >= 1 ? job.attempt.n : 1;
    if (n >= NOTIFY_AUTO_MAX_ATTEMPTS) return no("exhausted");
    const first = parseTime(job.auto && job.auto.firstAt);
    const last = parseTime(job.result && job.result.at);
    if (first === null || last === null) return no("frozen_problem");
    const at = last + NOTIFY_AUTO_RETRY_DELAYS_MS[Math.min(n - 1, NOTIFY_AUTO_RETRY_DELAYS_MS.length - 1)];
    if (at > first + NOTIFY_AUTO_WINDOW_MS || (Number.isFinite(nowMs) && nowMs > first + NOTIFY_AUTO_WINDOW_MS)) return no("window_expired");
    return { due: Number.isFinite(nowMs) && nowMs >= at, at, reason: null };
  }
  // Ghi lịch tự gửi lại vào job (để popup / sổ đọc, không phải nguồn quyết định — worker luôn tính lại bằng notifyAutoRetryPlan).
  function notifyAutoStamp(job, nowMs) {
    if (!job || !job.attempt || job.attempt.auto !== true) return job;
    const plan = notifyAutoRetryPlan(job, nowMs);
    return Object.assign({}, job, { auto: Object.assign({}, job.auto || {}, { nextAt: plan.at === null ? null : new Date(plan.at).toISOString(), stop: plan.at === null ? plan.reason : null }) });
  }

  // v0.7.7: POS đổi đơn SAU khi đã gửi (job đã bắt đầu) → { status, updatedDate, items } để đánh dấu cần đối soát; null khi không đổi.
  // Đổi = trạng thái khác lúc đóng băng, hoặc phiên bản đơn MỚI hơn có danh sách dòng (itemId / quantity / unit / base_quantity) khác.
  // Phiên bản mới chưa kèm items[] (vd response POST /item) chưa đủ để kết luận — chờ response đầy đủ.
  function notifyPosChange(job, ord) {
    if (!notifyStarted(job) || !ord || typeof ord !== "object") return null;
    const snap = job.snapshot && typeof job.snapshot === "object" ? job.snapshot : {};
    const lines = (list) => canonicalJson((Array.isArray(list) ? list : []).map((it) => [it.itemId, it.quantity, it.unit, it.baseQuantity]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    const statusChanged = !!textOrNull(ord.status) && !!textOrNull(snap.status) && ord.status !== snap.status;
    const newer = posTimeCompare(ord.updatedDate, snap.updatedDate) > 0;
    const itemsChanged = newer && Array.isArray(ord.stockItems) && posTimeCompare(ord.stockItemsVersion, ord.updatedDate) === 0 && lines(ord.stockItems) !== lines(snap.items);
    if (!statusChanged && !itemsChanged) return null;
    return { status: textOrNull(ord.status), updatedDate: textOrNull(ord.updatedDate), itemsChanged };
  }

  // Lý do dựng lại job (chưa gửi) ở nhịp tick: những lý do có thể tự hết khi dữ liệu trên máy về đủ (lượt chưa gắn dòng, EPC chưa
  // tra xong, hàng chờ, completed_items chưa ghi, lượng tag tra lỗi). Ngoài khoảng NOTIFY_REFRESH_WINDOW_MS sau khi job tạo thì
  // chỉ dựng lại khi đơn đổi (upsertOrder) — không đọc lại storage mỗi phút cho đơn đã đứng yên.
  // v0.7.10: + items_integrity (mở lại đơn → response đầy đủ), mapping_error (lỗi mạng / token của lượt tra EPC — chờ, không gửi phần nào).
  const NOTIFY_TRANSIENT_REASONS = Object.freeze(["tag_holding_unknown", "tag_holding_error", "local_data_pending", "mapping_pending", "items_missing", "completed_items_mismatch", "unplaced_scan", "item_no_scan", "order_not_found", "items_integrity", "mapping_error", "observed_other_station"]);
  const NOTIFY_REFRESH_MIN_MS = 60 * 1000;
  const NOTIFY_REFRESH_WINDOW_MS = 2 * 60 * 60 * 1000;
  function notifyRefreshWanted(job, nowMs) {
    if (!job) return true;
    if (notifyStarted(job)) return false;
    const updated = parseTime(job.updatedAt);
    const created = parseTime(job.createdAt);
    if (updated !== null && nowMs - updated < NOTIFY_REFRESH_MIN_MS) return false;
    if (created !== null && nowMs - created > NOTIFY_REFRESH_WINDOW_MS) return false;
    return (Array.isArray(job.reasons) ? job.reasons : []).some((r) => r && NOTIFY_TRANSIENT_REASONS.indexOf(r.code) >= 0);
  }

  // ======================================================================================================================
  // v0.7.7 — sổ trừ tồn: tab Sheet `stock_out` (spec PM 12/10/2026, mục 4–5). Cả hai máy ghi QUAN SÁT của mình; chỉ máy gửi POST.
  //  - Một dòng cho mỗi (máy ghi, orderId, modifiedItemId, EPC); dòng không EPC có khoá EPC trống; job thiếu danh sách dòng → MỘT dòng
  //    cấp đơn (itemId + EPC trống) để đơn không biến mất khỏi sổ.
  //  - Dựng THUẦN từ job notify:<đơn> (+ sku từ ci:). Job đã gửi: lượng yêu cầu lấy từ chuỗi ĐÃ ĐÓNG BĂNG (frozen.payloadJson),
  //    không tính lại từ POS; lượng xác nhận CHỈ điền khi job confirmed (STOCKED_OUT + EPC trong settledEpcs).
  //  - Bản ghi local so:<orderId> {rows, tombstones, revision, acked{rowKey: revision}}: nội dung đổi → revision + 1 (mọi dòng mang
  //    revision đó). Dòng không còn trong bản mới (dòng bị bỏ, EPC đổi trước khi gửi) → dòng "removed" giữ khoá cũ để Sheet không
  //    còn số cũ nằm sai.
  //  - Đồng bộ riêng (sync:so), phong bì v4 target "stock_out", upsert theo rowKey + revision — lỗi Sheet không chạm job / POST.
  // ======================================================================================================================
  const LEDGER_TARGET = "stock_out";
  // Phải bằng hệt SheetUpsert.LEDGER_HEADERS. A:X nghiệp vụ, Y:AF kỹ thuật (người vận hành ẩn). rowKey = trạm|orderId|itemId|EPC.
  const LEDGER_HEADERS = Object.freeze([
    "orderCode",
    "completedAt",
    "posStationId",
    "productCode",
    "productName",
    "sku",
    "quantity",
    "unit",
    "baseQuantity",
    "baseUnit",
    "uid",
    "epc",
    "tagHeld",
    "requestedQuantity",
    "confirmedQuantity",
    "lineStatus",
    "state",
    "stateLabel",
    "reasons",
    "nextwavesOrderId",
    "attempts",
    "replay",
    "sentAt",
    "resultAt",
    "orderId",
    "modifiedItemId",
    "productId",
    "payloadHash",
    "idempotencyKey",
    "updatedAt",
    "revision",
    "rowKey",
  ]);
  const SYNC_CAPABILITY_LEDGER = "target:stock_out";
  // v0.7.10: PARTIAL = Nextwaves xác nhận mọi EPC đã gửi nhưng đơn còn UID / dòng giữ xử lý thủ công (job.manual).
  const LEDGER_STATE = Object.freeze({ CONFIRMED: "confirmed", PARTIAL: "partial", SUBMITTING: "submitting", AMBIGUOUS: "ambiguous", REJECTED: "rejected", BLOCKED: "blocked", READY: "ready", OBSERVER: "observer" });
  const LEDGER_STATE_LABELS = Object.freeze({
    // v0.7.12: máy chỉ quan sát đơn quét ở máy khác — không gửi; phần trừ / giữ nằm ở dòng sổ của máy đã quét.
    observer: "Máy quan sát — đơn quét ở máy khác, không gửi từ máy này",
    confirmed: "Đã trừ tồn",
    submitting: "Đang gửi — CHƯA xác nhận trừ",
    ambiguous: "Không rõ kết quả — CHƯA xác nhận trừ, cần đối soát",
    rejected: "Bị từ chối — không trừ",
    blocked: "Cần kiểm tra — không gửi",
    ready: "Đủ điều kiện — chưa gửi",
    partial: "Đã trừ một phần; còn EPC cần xử lý thủ công",
  });
  const LEDGER_LINE_STATUS_LABELS = Object.freeze({
    deduct: "EPC trong yêu cầu trừ",
    planned: "Sẽ trừ khi gửi",
    older_epc: "EPC quét trước — không trừ",
    no_rfid: "Dòng không gắn RFID — không trừ",
    review: "Dòng cần kiểm tra",
    order: "Đơn chưa có danh sách dòng",
    removed: "Không còn trong bản mới nhất",
    // v0.7.10.1 (audit PM 17/10/2026): dòng của job luật per_uid (v0.7.10+) mang tiền tố "uid_" — quantity / baseQuantity = PHẦN dòng hàng
    // mà dòng sổ đại diện (dòng EPC: 1 đơn vị bán; dòng tổng hợp khoá EPC trống: phần chưa trừ). Dòng không tiền tố (bản ≤ v0.7.9) ghi lượng
    // CẢ dòng hàng trên mọi dòng sổ — không cộng lẫn hai loại. Cộng "uid_*" (trừ removed) của một modifiedItemId = số lượng bán.
    // v0.7.12.1: uid_observer (máy quan sát) không mang lượng và không bao giờ được cộng — ledgerManualTotals.
    // v0.7.10.4: dòng một tem đổi đơn vị — dòng sổ EPC = cả dòng hàng (quantity = số lượng bán, baseQuantity = lượng yêu cầu trừ).
    uid_planned: "EPC đạt — sẽ trừ khi gửi (dòng sổ = 1 đơn vị bán; một tem đổi đơn vị: cả dòng)",
    uid_deduct: "EPC trong yêu cầu trừ (dòng sổ = 1 đơn vị bán; một tem đổi đơn vị: cả dòng)",
    uid_review: "Cần kiểm tra — không trừ (lượng = phần dòng hàng của dòng sổ này)",
    uid_manual: "UID / EPC lỗi — chưa trừ, xử lý thủ công (lượng = phần chưa trừ)",
    uid_no_rfid: "UID không gắn RFID — không trừ (lượng = phần không gắn RFID)",
    uid_order: "Đơn chưa có danh sách dòng",
    uid_observer: "Máy quan sát — không trừ, không cộng vào hàng chờ thủ công / tổng lượng (lượng bán chỉ ghi trong lý do)",
  });
  const LEDGER_REASONS_MAX = 1000;

  function ledgerRowKey(station, orderId, itemId, epc) {
    return [cell(station), String(orderId || "").toLowerCase(), String(itemId || "").toLowerCase(), cell(epc).toUpperCase()].join("|");
  }
  function ledgerReasonText(r) {
    const label = NOTIFY_REASON_LABELS[r.code] || NOTIFY_AUTO_LABELS[r.code] || r.code;
    const bits = [r.code];
    if (r.epc) bits.push("EPC " + r.epc);
    if (r.uid) bits.push("UID " + r.uid);
    if (r.eventId) bits.push("lượt " + String(r.eventId).slice(0, 8));
    if (r.detail) bits.push(String(r.detail));
    return label + " [" + bits.join(" · ") + "]";
  }

  // Trạng thái cấp đơn trên sổ + lý do bổ sung (vì sao chưa gửi / lịch tự gửi lại / POS đổi sau khi gửi).
  //   ctx: { station, autoActive: {ok, reason}, autoOrder: {ok, reason}, pilotAllowed: bool, nowMs, preUpgrade: notifyPreUpgrade(...) }
  // v0.7.10.1: đơn cũ chưa gửi ghi rõ "pre_upgrade" (mọi trạng thái); đơn cũ đã gửi tay ghi lần xác nhận của người vận hành.
  function ledgerOrderState(job, ctx) {
    const c = ctx || {};
    const extra = [];
    let state;
    if (notifyStarted(job)) {
      state = job.state === NOTIFY_STATE.CONFIRMED && notifyOutcome(job).partial ? LEDGER_STATE.PARTIAL : job.state;
      if (job.state === NOTIFY_STATE.AMBIGUOUS) {
        // Job auto: lịch tự gửi lại / vì sao dừng. Job gửi tay: auto không gửi lại — người vận hành đối soát / bấm gửi lại.
        const plan = notifyAutoRetryPlan(job, c.nowMs);
        if (plan.at !== null) extra.push({ code: "auto_retry_at", detail: new Date(plan.at).toISOString() });
        else extra.push({ code: plan.reason });
      }
      if (job.posChange) extra.push({ code: "pos_changed_after_send", detail: [job.posChange.status, job.posChange.updatedDate].filter(Boolean).join(" · ") });
      const oc = notifyOutcome(job);
      if (oc.partial) extra.push({ code: "partial_summary", detail: "EPC đã xác nhận " + oc.confirmedEpcs + "/" + oc.sentEpcs + " · UID lỗi " + oc.failedUids + " · dòng giữ " + oc.heldLines + " · UID không gắn RFID " + oc.noEpcUids });
      if (job.approval && job.approval.legacyConfirmed === true) extra.push({ code: "legacy_confirmed", detail: textOrNull(job.approval.at) });
      if (job.approval && job.approval.unitChangeConfirmed === true) extra.push({ code: "unit_change_history_confirmed", detail: textOrNull(job.approval.at) });
    } else {
      state = job && job.state === NOTIFY_STATE.PREPARED ? LEDGER_STATE.READY : LEDGER_STATE.BLOCKED;
      if (state === LEDGER_STATE.BLOCKED && (Array.isArray(job && job.reasons) ? job.reasons : []).some((r) => r && r.code === "observed_other_station")) state = LEDGER_STATE.OBSERVER;
      const act = c.autoActive || { ok: false, reason: "auto_off" };
      if (act.reason === "not_sender_station" || act.reason === "no_sender") extra.push({ code: act.reason });
      else if (state === LEDGER_STATE.READY) {
        // v0.7.12.2: job có dòng một tem chỉ đổi đơn vị không bao giờ tự gửi — sổ ghi lý do thay cho "tự động gửi ở lượt kế tiếp".
        const unitManual = notifyUnitChangeLines(job).length > 0;
        if (c.pilotAllowed && !act.ok) extra.push({ code: "awaiting_approval" });
        else if (!act.ok) extra.push({ code: act.reason });
        else if (c.autoOrder && !c.autoOrder.ok) extra.push({ code: c.autoOrder.reason });
        else if (!unitManual) extra.push({ code: "auto_pending" });
        if (unitManual) extra.push({ code: "unit_change_manual_only" });
        const oc = notifyOutcome(job);
        if (oc.partial) extra.push({ code: "partial_summary", detail: "EPC sẽ gửi " + oc.plannedEpcs + " · UID lỗi " + oc.failedUids + " · dòng giữ " + oc.heldLines + " · UID không gắn RFID " + oc.noEpcUids });
      }
      if (c.preUpgrade === NOTIFY_PRE_UPGRADE && !extra.some((r) => r.code === NOTIFY_PRE_UPGRADE)) extra.push({ code: NOTIFY_PRE_UPGRADE });
    }
    return { state, extra };
  }

  // Lượng theo EPC của một chuỗi payload ({orderId, tags:[{epc, quantity}]}). null khi chuỗi hỏng.
  function payloadQuantities(json) {
    let p;
    try {
      p = JSON.parse(String(json || ""));
    } catch (_) {
      return null;
    }
    const out = new Map();
    for (const t of p && Array.isArray(p.tags) ? p.tags : []) if (t && typeof t.epc === "string") out.set(t.epc, t.quantity);
    return out;
  }

  // Các dòng sổ của MỘT job (chưa có revision / updatedAt). ctx như ledgerOrderState + completedRecords (ci: của đơn, lấy sku).
  function ledgerRows(job, ctx) {
    const c = ctx || {};
    if (!job || !isUuid(job.orderId)) return [];
    const station = normalizeStationId(c.station);
    if (!station) return [];
    const snap = job.snapshot && typeof job.snapshot === "object" ? job.snapshot : {};
    const started = notifyStarted(job);
    const sentJson = started ? (job.frozen && job.frozen.payloadJson) || job.payloadJson : null;
    const sentQty = started ? payloadQuantities(sentJson) || new Map() : null;
    const res = job.result && typeof job.result === "object" ? job.result : {};
    const settled = new Set(Array.isArray(res.settledEpcs) ? res.settledEpcs : []);
    const confirmed = job.state === NOTIFY_STATE.CONFIRMED;
    const { state, extra } = ledgerOrderState(job, c);
    const allReasons = (Array.isArray(job.reasons) ? job.reasons : []).concat(extra);
    const reasonsFor = (itemId) =>
      allReasons
        .filter((r) => r && (!r.itemId || r.itemId === itemId))
        .map(ledgerReasonText)
        .join("; ")
        .slice(0, LEDGER_REASONS_MAX);
    const skuOf = new Map();
    for (const r of Array.isArray(c.completedRecords) ? c.completedRecords : []) {
      if (!r || r.orderId !== job.orderId || !isUuid(r.modifiedItemId)) continue;
      const prev = skuOf.get(r.modifiedItemId);
      if (!prev || posTimeCompare(r.orderUpdatedAt, prev.orderUpdatedAt) > 0) skuOf.set(r.modifiedItemId, r);
    }
    const snapItems = new Map((Array.isArray(snap.items) ? snap.items : []).filter((it) => it && isUuid(it.itemId)).map((it) => [it.itemId, it]));
    const attempt = job.attempt && typeof job.attempt === "object" ? job.attempt : null;
    const common = {
      orderCode: textOrNull(snap.orderCode) || textOrNull(job.orderCode),
      completedAt: textOrNull(snap.completedDate),
      posStationId: station,
      state,
      stateLabel: LEDGER_STATE_LABELS[state] || NOTIFY_STATE_LABELS[state] || state,
      nextwavesOrderId: textOrNull(res.nextwavesOrderId),
      attempts: started && attempt && Number.isInteger(attempt.n) ? attempt.n : null,
      replay: typeof res.replay === "boolean" ? res.replay : null,
      sentAt: started && attempt ? textOrNull(attempt.startedAt) : null,
      resultAt: started ? textOrNull(res.at) : null,
      orderId: job.orderId,
      payloadHash: started ? textOrNull((job.frozen && job.frozen.payloadHash) || job.payloadHash) : null,
      idempotencyKey: started ? textOrNull((job.frozen && job.frozen.idempotencyKey) || (attempt && attempt.idempotencyKey)) : null,
    };
    const rows = [];
    const seenEpc = new Set();
    const push = (fields) => {
      const row = Object.assign({}, common, fields);
      row.rowKey = ledgerRowKey(station, job.orderId, row.modifiedItemId, row.epc);
      rows.push(row);
    };
    const items = job.preview && Array.isArray(job.preview.items) ? job.preview.items : [];
    // v0.7.10 (PM 17/10/2026, finding 3): job luật per_uid — mỗi dòng hàng: một dòng sổ cho MỖI EPC đạt (khoá EPC; quantity 1 đơn vị bán,
    // baseQuantity = lượng của EPC đó; requestedQuantity từ chuỗi đã gửi, confirmedQuantity chỉ khi STOCKED_OUT + EPC trong settledEpcs)
    // + nhiều nhất MỘT dòng tổng hợp phần CHƯA trừ (khoá EPC trống): UID lỗi / không gắn RFID / cả dòng bị giữ, quantity + baseQuantity =
    // phần chưa trừ, lý do từng UID. Tổng quantity các dòng sổ của một dòng hàng = số lượng bán. Job của bản cũ giữ nguyên cách dựng cũ.
    // v0.7.10.1: mọi dòng của job per_uid mang lineStatus "uid_*" — dấu máy đọc được để không cộng lẫn với dòng lượng-cả-dòng của bản cũ.
    const perUid = !!(job.preview && job.preview.rule === NOTIFY_RULE);
    const manual = Array.isArray(job.manual) ? job.manual.filter((m) => m && typeof m === "object") : [];
    for (const it of items) {
      if (!it || !isUuid(it.itemId)) continue;
      const ci = skuOf.get(it.itemId);
      const base = {
        modifiedItemId: it.itemId,
        productId: it.productId === null || it.productId === undefined ? null : String(it.productId),
        productCode: textOrNull(it.productCode) || (ci ? textOrNull(ci.productCode) : null),
        productName: textOrNull(it.productName) || (ci ? textOrNull(ci.productName) : null),
        sku: ci ? textOrNull(ci.sku) : null,
        quantity: it.quantity,
        unit: it.unit,
        baseQuantity: it.baseQuantity,
        baseUnit: it.baseUnit,
        reasons: reasonsFor(it.itemId),
      };
      // v0.7.12.1 (audit PM 24/10/2026, P1 dòng observer): máy quan sát — MỘT dòng mỗi dòng hàng, lineStatus uid_observer, KHÔNG mang lượng
      // (quantity / baseQuantity / requestedQuantity / confirmedQuantity trống): phần trừ / giữ nằm ở dòng sổ của máy đã quét. Lượng bán chỉ ghi
      // trong lý do để đối chiếu — bộ cộng nào lọc sót lineStatus cũng không cộng trùng được.
      if (state === LEDGER_STATE.OBSERVER) {
        const codes = snapItems.get(it.itemId) && Array.isArray(snapItems.get(it.itemId).qrCodes) ? snapItems.get(it.itemId).qrCodes : [];
        const sold = "Số lượng bán " + (it.quantity === null || it.quantity === undefined ? "—" : it.quantity) + " " + (it.unit || "") + (typeof it.baseQuantity === "number" ? " (= " + it.baseQuantity + " " + (it.baseUnit || "") + ")" : "");
        push(Object.assign({}, base, { quantity: null, baseQuantity: null, uid: codes.join(", ") || null, epc: null, tagHeld: null, requestedQuantity: null, confirmedQuantity: null, lineStatus: "uid_observer", reasons: [sold + " — chỉ đối chiếu, không cộng vào hàng chờ thủ công / lượng cần trừ", base.reasons].filter(Boolean).join("; ").slice(0, LEDGER_REASONS_MAX) }));
        continue;
      }
      if (perUid) {
        const uids = (Array.isArray(it.uids) ? it.uids : []).filter((u) => u && typeof u === "object");
        const passes = it.status === "held" ? [] : uids.filter((u) => u.kind === "pass" && u.epc);
        // v0.7.10.4 (spec PM 23/10/2026): dòng một tem đổi đơn vị — dòng sổ EPC đại diện CẢ dòng hàng (quantity = số lượng bán, baseQuantity
        // = base_quantity = lượng yêu cầu trừ của EPC, theo đơn vị cơ sở). Nextwaves chỉ trả danh sách EPC (settledEpcs), không trả lượng
        // từng EPC → confirmedQuantity để TRỐNG, lý do ghi rõ lượng đã yêu cầu và việc đối chiếu lượng còn trên Nextwaves.
        const lineRule = it.rule === NOTIFY_LINE_RULE_UNIT_CHANGE;
        const unitPath = lineRule && textOrNull(it.unitChange) ? "đổi đơn vị " + it.unitChange : "đổi đơn vị";
        for (const u of passes) {
          seenEpc.add(u.epc);
          const req = started ? (sentQty.has(u.epc) ? sentQty.get(u.epc) : 0) : null;
          const why = started && !(req > 0) ? (base.reasons + "; ledger_preview_mismatch").replace(/^; /, "") : base.reasons;
          const note = !lineRule
            ? null
            : "Một tem cho cả dòng (" + unitPath + "): " + (started ? "đã yêu cầu trừ " + req : "sẽ yêu cầu trừ " + u.quantity) + " " + (it.baseUnit || "") +
              (confirmed && settled.has(u.epc) ? " — Nextwaves xác nhận EPC (settledEpcs) nhưng không trả lượng từng EPC; lượng thực trừ đối chiếu trên Nextwaves" : "");
          push(
            Object.assign({}, base, {
              quantity: lineRule ? it.quantity : 1,
              baseQuantity: typeof u.quantity === "number" ? u.quantity : null,
              uid: textOrNull(u.uid),
              epc: u.epc,
              tagHeld: typeof u.held === "number" ? u.held : null,
              requestedQuantity: req,
              confirmedQuantity: !lineRule && confirmed && req > 0 && settled.has(u.epc) ? req : null,
              lineStatus: !started ? "uid_planned" : req > 0 ? "uid_deduct" : "uid_review",
              reasons: note ? [note, why].filter(Boolean).join("; ").slice(0, LEDGER_REASONS_MAX) : why,
            })
          );
        }
        const rest = it.status === "held" ? uids : uids.filter((u) => u.kind !== "pass");
        const units = typeof it.quantity === "number" ? it.quantity - (lineRule ? (passes.length ? it.quantity : 0) : passes.length) : null;
        if (passes.length && !rest.length && units === 0) continue;
        const C = typeof it.convertRate === "number" && Number.isFinite(it.convertRate) ? it.convertRate : null;
        const restBase = !passes.length ? it.baseQuantity : units !== null && C !== null ? units * C : null;
        const lineStatus = it.status === "held" || it.status === "review" ? "uid_review" : rest.some((u) => u.kind === "fail") ? "uid_manual" : "uid_no_rfid";
        const mine = manual.filter((m) => m.itemId === it.itemId);
        // UID không gắn RFID (Nextwaves xác nhận) chỉ ghi sổ — dòng chỉ có phần đó giữ lý do như v0.7.7–v0.7.9; dòng có phần phải xử lý
        // thủ công ghi rõ lượng chưa trừ + lý do từng dòng / UID.
        const why =
          lineStatus === "uid_no_rfid"
            ? [base.reasons]
            : [
                "Chưa trừ " + (units === null ? "—" : units) + " " + (it.unit || "") + (restBase !== null ? " (= " + restBase + " " + (it.baseUnit || "") + ")" : ""),
                lineRule ? "Một tem, " + unitPath : null,
                ...mine.filter((m) => m.scope === "line").map(ledgerReasonText),
                ...rest.filter((u) => u.kind === "fail").map((u) => mine.filter((m) => m.scope === "uid" && m.uid === u.uid).map(ledgerReasonText).join("; ") || "UID " + u.uid),
                ...rest.filter((u) => u.kind === "no_epc").map((u) => "UID " + u.uid + ": không gắn RFID (Nextwaves) — chỉ ghi sổ"),
                base.reasons,
              ];
        const codes = snapItems.get(it.itemId) && Array.isArray(snapItems.get(it.itemId).qrCodes) ? snapItems.get(it.itemId).qrCodes : [];
        push(
          Object.assign({}, base, {
            quantity: units,
            baseQuantity: restBase,
            uid: rest.map((u) => u.uid).join(", ") || codes.join(", ") || null,
            epc: null,
            tagHeld: null,
            requestedQuantity: null,
            confirmedQuantity: null,
            lineStatus,
            reasons: why.filter(Boolean).join("; ").slice(0, LEDGER_REASONS_MAX),
          })
        );
        continue;
      }
      const tags = Array.isArray(it.tags) ? it.tags : [];
      if (!tags.length) {
        const codes = snapItems.get(it.itemId) && Array.isArray(snapItems.get(it.itemId).qrCodes) ? snapItems.get(it.itemId).qrCodes : [];
        push(Object.assign({}, base, { uid: codes.join(", ") || null, epc: null, tagHeld: null, requestedQuantity: null, confirmedQuantity: null, lineStatus: it.status === "no_rfid" ? "no_rfid" : "review" }));
        continue;
      }
      for (const t of tags) {
        if (!t || !t.epc) continue;
        seenEpc.add(t.epc);
        const req = started ? (sentQty.has(t.epc) ? sentQty.get(t.epc) : 0) : null;
        const lineStatus = started ? (req > 0 ? "deduct" : "older_epc") : it.status === "review" ? "review" : t.quantity > 0 ? "planned" : t.quantity === 0 ? "older_epc" : "review";
        push(
          Object.assign({}, base, {
            uid: textOrNull(t.uid),
            epc: t.epc,
            tagHeld: typeof t.held === "number" ? t.held : null,
            requestedQuantity: req,
            confirmedQuantity: confirmed && req > 0 && settled.has(t.epc) ? req : null,
            lineStatus,
          })
        );
      }
    }
    // Chuỗi đã gửi có EPC không thấy trong bản xem trước của job (không được xảy ra) → vẫn lên sổ, kèm lý do — dữ liệu đã POST không
    // bao giờ vắng mặt trên sổ.
    if (started) {
      for (const [epc, q] of sentQty) {
        if (seenEpc.has(epc)) continue;
        push({ modifiedItemId: null, productId: null, productCode: null, productName: null, sku: null, quantity: null, unit: null, baseQuantity: null, baseUnit: null, uid: null, epc, tagHeld: null, requestedQuantity: q, confirmedQuantity: confirmed && settled.has(epc) ? q : null, lineStatus: perUid ? "uid_deduct" : "deduct", reasons: (reasonsFor(null) + "; ledger_preview_mismatch").replace(/^; /, "") });
      }
    }
    if (!rows.length) {
      push({ modifiedItemId: null, productId: null, productCode: null, productName: null, sku: null, quantity: null, unit: null, baseQuantity: null, baseUnit: null, uid: null, epc: null, tagHeld: null, requestedQuantity: null, confirmedQuantity: null, lineStatus: perUid ? "uid_order" : "order", reasons: reasonsFor(null) });
    }
    return rows;
  }

  // v0.7.12.1 (audit PM 24/10/2026, P1 dòng observer): luật đối soát trên dòng sổ của MỌI máy (tab stock_out) — tổng nghiệp vụ theo
  // (orderId, modifiedItemId). Chỉ cộng dòng luật per_uid ("uid_*"); bỏ removed và dòng máy quan sát (lineStatus uid_observer / state observer).
  // Dòng không tiền tố (bản ≤ v0.7.9, lượng CẢ dòng hàng trên mọi dòng sổ) không cộng, chỉ đếm (legacyRows). Hai máy cùng có dòng được cộng cho
  // một dòng hàng (cả hai cùng quét đơn — R1 chưa làm) → stations > 1: đối soát tay, không tin tổng. Ô Sheet có thể là chuỗi số.
  //   → [{ orderId, itemId, soldQuantity, manualQuantity, requestedQuantity, confirmedQuantity, stations[], observerStations[], legacyRows }]
  const LEDGER_MANUAL_STATUSES = Object.freeze(["uid_review", "uid_manual"]);
  function ledgerManualTotals(rows) {
    const num = (v) => {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
      return Number.isFinite(n) ? n : 0;
    };
    const out = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || !isUuid(r.orderId) || !isUuid(r.modifiedItemId)) continue;
      const orderId = r.orderId.toLowerCase();
      const itemId = r.modifiedItemId.toLowerCase();
      const k = orderId + "|" + itemId;
      const t = out.get(k) || { orderId, itemId, soldQuantity: 0, manualQuantity: 0, requestedQuantity: 0, confirmedQuantity: 0, stations: [], observerStations: [], legacyRows: 0 };
      out.set(k, t);
      const st = cell(r.lineStatus);
      const station = cell(r.posStationId);
      if (st === "uid_observer" || cell(r.state) === LEDGER_STATE.OBSERVER) {
        if (t.observerStations.indexOf(station) < 0) t.observerStations.push(station);
        continue;
      }
      if (st === "removed") continue;
      if (!st.startsWith("uid_")) {
        t.legacyRows += 1;
        continue;
      }
      if (t.stations.indexOf(station) < 0) t.stations.push(station);
      t.soldQuantity += num(r.quantity);
      if (LEDGER_MANUAL_STATUSES.indexOf(st) >= 0) t.manualQuantity += num(r.quantity);
      t.requestedQuantity += num(r.requestedQuantity);
      t.confirmedQuantity += num(r.confirmedQuantity);
    }
    return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, t]) => Object.assign(t, { stations: t.stations.sort(), observerStations: t.observerStations.sort() }));
  }

  const LEDGER_ROW_VOLATILE = Object.freeze(["revision", "updatedAt"]);
  function ledgerRowContent(row) {
    const o = {};
    for (const h of LEDGER_HEADERS) if (LEDGER_ROW_VOLATILE.indexOf(h) < 0) o[h] = cell(row[h]);
    return o;
  }
  function isLedgerRecord(r) {
    return !!r && typeof r === "object" && isUuid(r.orderId) && Number.isInteger(r.revision) && r.revision >= 1 && Array.isArray(r.rows);
  }
  // Gộp các dòng mới vào bản ghi so:<đơn>. { write, record, changed }. Nội dung (không kể revision / updatedAt) không đổi → no-op.
  function mergeLedger(existing, rows, nowIso) {
    const prev = isLedgerRecord(existing) ? existing : null;
    const fresh = Array.isArray(rows) ? rows : [];
    if (!fresh.length) return { write: false, record: prev, changed: false };
    const orderId = fresh[0].orderId;
    const freshKeys = new Set(fresh.map((r) => r.rowKey));
    // Dòng từng có (kể cả dòng removed cũ) mà bản mới không còn → dòng removed (giữ định danh + sản phẩm, xoá lượng / trạng thái dòng).
    const tombs = new Map();
    for (const r of prev ? prev.rows.concat(Array.isArray(prev.tombstones) ? prev.tombstones : []) : []) {
      if (!r || freshKeys.has(r.rowKey) || tombs.has(r.rowKey)) continue;
      tombs.set(
        r.rowKey,
        Object.assign({}, r, { tagHeld: null, requestedQuantity: r.lineStatus === "removed" ? r.requestedQuantity : null, confirmedQuantity: null, lineStatus: "removed", state: fresh[0].state, stateLabel: fresh[0].stateLabel, reasons: "removed" })
      );
    }
    const tombstones = [...tombs.values()].sort((a, b) => a.rowKey.localeCompare(b.rowKey));
    const sorted = fresh.slice().sort((a, b) => a.rowKey.localeCompare(b.rowKey));
    const sig = canonicalJson({ rows: sorted.map(ledgerRowContent), tombstones: tombstones.map(ledgerRowContent) });
    if (prev && prev.sig === sig) return { write: false, record: prev, changed: false };
    const revision = prev ? prev.revision + 1 : 1;
    const stamp = (r) => Object.assign({}, r, { revision, updatedAt: nowIso });
    const record = {
      orderId,
      orderCode: fresh[0].orderCode || null,
      posStationId: fresh[0].posStationId,
      state: fresh[0].state,
      rows: sorted.map(stamp),
      tombstones: tombstones.map(stamp),
      sig,
      revision,
      createdAt: prev ? prev.createdAt : nowIso,
      updatedAt: nowIso,
      acked: prev && prev.acked && typeof prev.acked === "object" ? prev.acked : {},
      rowErrors: prev && prev.rowErrors && typeof prev.rowErrors === "object" ? prev.rowErrors : {},
    };
    return { write: true, record, changed: true };
  }
  function ledgerAllRows(rec) {
    return isLedgerRecord(rec) ? rec.rows.concat(Array.isArray(rec.tombstones) ? rec.tombstones : []) : [];
  }
  // Trạng thái đồng bộ của MỘT dòng: synced (Sheet giữ ≥ revision), rejected (Apps Script từ chối đúng revision này), pending.
  function ledgerRowSyncStatus(rec, row) {
    const acked = rec && rec.acked && Number.isInteger(rec.acked[row.rowKey]) ? rec.acked[row.rowKey] : 0;
    if (acked >= row.revision) return "synced";
    const err = rec && rec.rowErrors ? rec.rowErrors[row.rowKey] : null;
    if (err && err.revision === row.revision) return "rejected";
    return "pending";
  }
  function ledgerCounts(records) {
    const c = { orders: 0, rows: 0, pending: 0, synced: 0, rejected: 0, byState: {} };
    for (const rec of records || []) {
      if (!isLedgerRecord(rec)) continue;
      c.orders += 1;
      c.byState[rec.state] = (c.byState[rec.state] || 0) + 1;
      for (const r of ledgerAllRows(rec)) {
        if (r.lineStatus !== "removed") c.rows += 1;
        c[ledgerRowSyncStatus(rec, r)] += 1;
      }
    }
    return c;
  }
  function selectLedgerBatch(records, opts) {
    const o = opts || {};
    const max = Math.max(0, Math.min(Number(o.max) || SYNC_BATCH_MAX, SYNC_BATCH_MAX));
    const exclude = o.exclude || null;
    const recs = (records || []).filter(isLedgerRecord).sort((a, b) => String(a.updatedAt || "").localeCompare(String(b.updatedAt || "")) || a.orderId.localeCompare(b.orderId));
    const out = [];
    for (const rec of recs) {
      for (const r of ledgerAllRows(rec)) {
        const st = ledgerRowSyncStatus(rec, r);
        if (st !== "pending" && !(o.includeRejected && st === "rejected")) continue;
        if (exclude && exclude.has(r.rowKey + ":" + r.revision)) continue;
        out.push(r);
        if (out.length >= max) return out;
      }
    }
    return out;
  }
  function ledgerRow(r) {
    const row = {};
    for (const h of LEDGER_HEADERS) row[h] = cell(r[h]);
    return row;
  }
  function ledgerEnvelope(rows, extVersion) {
    return { v: SYNC_ENVELOPE_V4, schemaVersion: SYNC_SCHEMA_VERSION, target: LEDGER_TARGET, extVersion: String(extVersion || ""), records: (rows || []).map(ledgerRow) };
  }
  // GET /exec?target=stock_out TRƯỚC POST đầu tiên của đợt: đúng Apps Script v0.7.7 (capability) và tab có ĐÚNG tiêu đề.
  function parseLedgerPreflight(json) {
    const fail = (error) => ({ ok: false, error });
    if (!json || typeof json !== "object" || Array.isArray(json)) return fail("bad_response");
    if (json.schemaVersion !== SYNC_SCHEMA_VERSION) return fail("server_outdated");
    const caps = Array.isArray(json.capabilities) ? json.capabilities : [];
    if (caps.indexOf(SYNC_CAPABILITY_LEDGER) < 0) return fail("server_no_stock_out");
    if (json.ok !== true) return fail(typeof json.error === "string" && json.error ? json.error.slice(0, 200) : "not_ok");
    if (json.target !== LEDGER_TARGET) return fail("server_no_stock_out");
    if (!Array.isArray(json.headers) || json.headers.length !== LEDGER_HEADERS.length) return fail("server_outdated");
    if (json.headerState === "empty") return fail("stock_out_headers_empty");
    if (json.headerState !== "ok") return fail("stock_out_headers_mismatch");
    if (!LEDGER_HEADERS.every((h, i) => typeof json.headers[i] === "string" && json.headers[i].trim() === h)) return fail("stock_out_headers_mismatch");
    return { ok: true };
  }
  // ACK theo rowKey + revision đã gửi. "skipped" = Sheet đã giữ revision ≥ bản gửi → ACK. Thiếu / lặp / sai → dòng vẫn chờ.
  function parseLedgerResponse(sent, json) {
    const list = sent || [];
    const none = (error) => ({ ok: false, error, acked: [], rejected: [], missing: list.length });
    if (!json || typeof json !== "object" || Array.isArray(json)) return none("bad_response");
    if (json.schemaVersion !== SYNC_SCHEMA_VERSION) return none("server_outdated");
    if (json.ok !== true) return none(typeof json.error === "string" && json.error ? json.error.slice(0, 200) : "not_ok");
    if (json.target !== LEDGER_TARGET) return none("server_no_stock_out");
    if (!Array.isArray(json.acks)) return none("no_acks");
    const sentByKey = new Map(list.map((r) => [r.rowKey, r]));
    const count = new Map();
    for (const a of json.acks) if (a && typeof a.rowKey === "string") count.set(a.rowKey, (count.get(a.rowKey) || 0) + 1);
    const acked = [];
    for (const a of json.acks) {
      if (!a || typeof a.rowKey !== "string") continue;
      const s = sentByKey.get(a.rowKey);
      if (!s || count.get(a.rowKey) !== 1 || Number(a.revision) !== s.revision || SYNC_ACK_STATUSES.indexOf(a.status) < 0) continue;
      acked.push({ orderId: s.orderId, rowKey: s.rowKey, revision: s.revision, status: a.status });
    }
    const ackedKeys = new Set(acked.map((a) => a.rowKey));
    const rejected = [];
    for (const r of Array.isArray(json.rejected) ? json.rejected : []) {
      if (!r || typeof r.rowKey !== "string") continue;
      const s = sentByKey.get(r.rowKey);
      if (!s || ackedKeys.has(r.rowKey) || rejected.some((x) => x.rowKey === r.rowKey)) continue;
      rejected.push({ orderId: s.orderId, rowKey: s.rowKey, revision: s.revision, error: String(r.error || "rejected").slice(0, 200) });
    }
    const missing = list.length - acked.length - rejected.length;
    return { ok: true, error: missing > 0 ? "ack_missing" : null, acked, rejected, missing };
  }
  // ACK / từ chối áp vào bản ghi MỚI NHẤT: revision ACK lớn hơn revision của bản ghi (không thể) → bỏ.
  function applyLedgerAck(existing, ack, nowIso) {
    if (!isLedgerRecord(existing) || !ack || !Number.isInteger(ack.revision) || ack.revision > existing.revision) return { record: existing, changed: false };
    const cur = existing.acked && Number.isInteger(existing.acked[ack.rowKey]) ? existing.acked[ack.rowKey] : 0;
    if (ack.revision <= cur) return { record: existing, changed: false };
    const acked = Object.assign({}, existing.acked, { [ack.rowKey]: ack.revision });
    const rowErrors = Object.assign({}, existing.rowErrors || {});
    if (rowErrors[ack.rowKey] && rowErrors[ack.rowKey].revision <= ack.revision) delete rowErrors[ack.rowKey];
    return { record: Object.assign({}, existing, { acked, rowErrors, syncedAt: nowIso }), changed: true };
  }
  function applyLedgerRejection(existing, rej, nowIso) {
    if (!isLedgerRecord(existing) || !rej || rej.revision !== existing.revision) return { record: existing, changed: false };
    const cur = existing.rowErrors ? existing.rowErrors[rej.rowKey] : null;
    if (cur && cur.revision === rej.revision && cur.error === rej.error) return { record: existing, changed: false };
    return { record: Object.assign({}, existing, { rowErrors: Object.assign({}, existing.rowErrors || {}, { [rej.rowKey]: { revision: rej.revision, error: rej.error, at: nowIso } }) }), changed: true };
  }
  // Đơn thuộc sổ (quan sát) trên máy này: đơn bán OFFLINE, COMPLETED, mốc COMPLETED SAU mốc cài v0.7.7 (không backfill).
  function ledgerOrderVerdict(ord, marker) {
    const o = ord && typeof ord === "object" ? ord : null;
    if (!o || !isUuid(o.orderId) || recordTypeOf(o) !== RECORD_TYPE.SALE_ORDER) return { ok: false, reason: "not_sale_order" };
    if (String(o.orderType || "").trim().toUpperCase() !== "OFFLINE") return { ok: false, reason: "order_type" };
    if (o.status !== ORDER_COMPLETED) return { ok: false, reason: "order_not_completed" };
    if (!marker || parseTime(marker.at) === null) return { ok: false, reason: "no_marker" };
    if (!(posTimeCompare(completedStatusAt(o), marker.at) > 0)) return { ok: false, reason: "before_marker" };
    return { ok: true, reason: null };
  }

  function popupDataFromAll(all) {
    const raw = Object.assign({}, all || {});
    const orders = new Map();
    const qrs = new Map();
    const events = [];
    const actions = [];
    const stockoutJobs = new Map();
    const notifyJobs = new Map();
    const ledger = new Map(); // v0.7.7: sổ trừ tồn so:<orderId>
    const statuses = []; // v0.7.4: bản ghi trạng thái đơn (tab data, recordType sale_order_status)
    const completed = [];
    const pending = {};
    let pendCount = 0;
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith("pend:")) {
        pendCount += 1;
        const t = k.split(":")[1];
        pending[t] = (pending[t] || 0) + 1;
        continue;
      }
      if (k.startsWith(KEYS.completed) && v && v.orderId) completed.push(v);
      if (k.startsWith(KEYS.event) && v && v.eventId) (isActionEvent(v) ? actions : isStatusEvent(v) ? statuses : events).push(v);
      else if (k.startsWith(KEYS.order) && v && v.orderId) orders.set(v.orderId, v);
      else if (k.startsWith(KEYS.qr) && v && v.qrCode) qrs.set(v.qrCode, v);
      else if (k.startsWith(KEYS.stockout) && v && v.orderId) stockoutJobs.set(v.orderId, v);
      else if (k.startsWith(KEYS.notify) && v && v.orderId) notifyJobs.set(v.orderId, v);
      else if (k.startsWith(KEYS.ledger) && isLedgerRecord(v)) ledger.set(v.orderId, v);
    }
    const posStationId = normalizeStationId(raw[KEYS.posStationId]);
    const counters = {};
    for (const t of STATION_RECORD_TYPES) counters[t] = posStationId ? Number(raw[stationSeqKey(posStationId, t)]) || 0 : 0;
    const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
    return {
      _raw: raw,
      orders,
      qrs,
      events,
      actions,
      statuses,
      completed,
      evidence: buildQrEvidence([...orders.values()], [...qrs.values()]),
      diag: Array.isArray(raw[KEYS.diag]) ? raw[KEYS.diag] : [],
      posActionDiag: Array.isArray(raw[KEYS.posActionDiag]) ? raw[KEYS.posActionDiag] : [],
      completedDiag: Array.isArray(raw[KEYS.completedDiag]) ? raw[KEYS.completedDiag] : [],
      completedState: obj(raw[KEYS.completedSyncState]),
      v07InstalledAt: raw[KEYS.v07InstalledAt] || null,
      settings: normalizeSettings(raw[KEYS.settings]),
      syncState: obj(raw[KEYS.syncState]),
      sheetEndpoint: normalizeSheetEndpoint(raw[KEYS.sheetEndpoint]),
      nextwavesApiBase: nextwavesApiBase(raw[KEYS.nextwavesApiBase]), // v0.7.10.2: tenant Nextwaves đang dùng (không phải bí mật)
      posStationId,
      stockoutJobs,
      // v0.7.3: job trừ tồn Phase 1 + cấu hình pilot
      notifyJobs,
      notifyPilot: normalizeNotifyPilot(raw[KEYS.notifyPilot]),
      // v0.7.7: công tắc auto + sổ trừ tồn (tab stock_out) + trạng thái đồng bộ + mốc cài
      notifyAuto: normalizeNotifyAuto(raw[KEYS.notifyAuto]),
      ledger,
      ledgerState: obj(raw[KEYS.ledgerSyncState]),
      ledgerInstalledAt: raw[KEYS.ledgerInstalledAt] || null,
      // v0.7.9.1: mốc cài; v0.7.10.1: {at, version, legacy: [orderId]} — job chưa gửi có lúc nâng cấp (không tự gửi, xét gửi tay)
      notifyFixInstalledAt: raw[KEYS.notifyFixInstalledAt] || null,
      // v0.7.10.5: mốc cài luật một tem đổi đơn vị (đơn tạo và hoàn tất sau mốc)
      unitChangeInstalledAt: raw[KEYS.unitChangeInstalledAt] || null,
      // v0.8.0: mốc ngừng ghi tab data + số bản ghi còn chưa lên tab data lúc nâng cấp
      dataStoppedAt: obj(raw[KEYS.dataStoppedAt]).at ? raw[KEYS.dataStoppedAt] : null,
      // v0.7.1: hàng chờ còn trên máy (worker dọn), trạng thái bộ cấp số, sàn + bộ đếm của trạm đang chọn
      pendCount,
      pending,
      stationState: obj(raw[KEYS.stationState]),
      stationFloor: posStationId && raw[stationFloorKey(posStationId)] ? raw[stationFloorKey(posStationId)] : null,
      counters,
    };
  }
  // v0.8.0.4 (Batch 1b): sổ tem RFID theo đơn (rfidAttn:<orderId>, cấu trúc ở rfid-core.js) cho "Xuất JSON" — mọi đơn, hoặc đúng một đơn. Mỗi tem kèm
  // trạng thái + lượt (eventId, seq) để đối soát; attempt chỉ còn { eventId, seq } (trường của lượt đã có trong ev:). Khoá này không chứa token.
  function rfidTagsForExport(raw, orderId) {
    const want = orderId ? String(orderId).toLowerCase() : null;
    const out = [];
    for (const [k, v] of Object.entries(raw || {})) {
      if (!k.startsWith("rfidAttn:") || !v || typeof v !== "object" || !v.tags || typeof v.tags !== "object" || Array.isArray(v.tags)) continue;
      const id = k.slice("rfidAttn:".length);
      if (want && id !== want) continue;
      const tags = Object.entries(v.tags).map(([epc, e]) => {
        const a = e && e.attempt && typeof e.attempt === "object" ? e.attempt : null;
        return Object.assign({ epc }, e, { attempt: a ? { eventId: a.eventId || null, seq: Number.isInteger(a.seq) ? a.seq : null } : null });
      });
      out.push({ orderId: v.orderId || id, v: v.v || 1, updatedAt: v.updatedAt || null, tags });
    }
    return out.sort((a, b) => String(a.orderId).localeCompare(String(b.orderId)));
  }
  // Áp thay đổi của storage.onChanged ({key: {newValue, oldValue}}; thiếu newValue = đã xoá). newValue là giá trị TUYỆT ĐỐI
  // nên áp lại cùng thay đổi là no-op (popup phát lại các thay đổi tới trong lúc đang đọc toàn bộ).
  function applyStorageChanges(data, changes) {
    const raw = Object.assign({}, (data && data._raw) || {});
    for (const [k, c] of Object.entries(changes || {})) {
      if (c && Object.prototype.hasOwnProperty.call(c, "newValue") && c.newValue !== undefined) raw[k] = c.newValue;
      else delete raw[k];
    }
    return popupDataFromAll(raw);
  }

  return {
    DEFAULT_SETTINGS,
    SETTING_LIMITS,
    EXPORT_COLUMNS,
    KEYS,
    MSG,
    VERDICT,
    INPUT_MODE,
    REASON_LABELS,
    normalizeSettings,
    isUuid,
    RECORD_TYPE,
    RECORD_TYPE_LABELS,
    parseWorkContext,
    parseOrderIdFromPath,
    isTransferRoute,
    recordTypeOf,
    stableUuid,
    transferEventId,
    dedupeTransferEvent,
    newTransferRecord,
    extractTransferInfo,
    qrCodeFromTransferQrPath,
    extractTransferQrInfo,
    parseOrderCodeText,
    shortId,
    isPrintableKey,
    isImeKey,
    classifySegment,
    ScanBurstDetector,
    altCodeToChar,
    decodeLegacyAltDigits,
    buildQrEvidence,
    resolveScan,
    displayStatus,
    distinctPosCodes,
    extractQrCode,
    looksLikeOrder,
    extractOrderInfo,
    isStaleOrderInfo,
    mergeOrderInfo,
    qrCodeFromRequestBody,
    extractQrProductInfo,
    mergeQrInfo,
    stripVolatile,
    isChanged,
    validateEvent,
    SOURCE,
    ACTION,
    MAPPING,
    RESULT,
    SHEET_HEADERS,
    CONTENT_UPDATE_FIELDS,
    RFID_TIMING_KEYS,
    RFID_TIMING_MAX_MS,
    isRfidTiming,
    LOOKUP_FIELDS,
    ORDER_FIELDS,
    ORDER_SNAPSHOT_FIELDS,
    TRANSFER_SNAPSHOT_FIELDS,
    LOOKUP_MAX_ATTEMPTS,
    isLogEvent,
    isTransferEvent,
    isSheetEvent,
    looksLikeUid,
    orderSnapshot,
    orderItemQuantityFor,
    GENERATION_FIELDS,
    ITEM_FIELDS,
    ITEM_INFO_FIELDS,
    ITEM_SHEET_FIELDS,
    ITEM_CLAIM_TTL_MS,
    ITEM_BINDING_TTL_MS,
    ItemBindings,
    ORDER_ITEM_HOST,
    orderItemRequest,
    orderItemStart,
    orderItemInfoFor,
    extractOrderItemInfo,
    // v0.7 Batch D — thao tác dòng hàng POS
    POS_ACTION,
    POS_ACTION_VALUES,
    POS_ACTION_LABELS,
    POS_ACTION_DIAG_MAX,
    POS_ACTION_DIAG_LABELS,
    ACTION_SNAPSHOT_FIELDS,
    orderItemCall,
    orderItemRequestFields,
    posQrSet,
    posItemSnapshot,
    posOrderSnapshot,
    mergePosOrderSnapshot,
    PosItemTracker,
    ScanRequestRegistry,
    sharedScanRegistry,
    classifyPosItemCall,
    posActionEventId,
    // v0.7.4 — dấu vết vòng đời đơn
    ORDER_STATUS_ACTION,
    isStatusEvent,
    orderStatusEventId,
    orderStatusRecord,
    orderStatusFill,
    ORDER_STATUS_FILL_FIELDS,
    validateStatusEvent,
    SYNC_CAPABILITY_STATUSES,
    syncAllowsStatuses,
    STATION_RECORD_TYPES_REQUIRED,
    posActionInfo,
    posActionDiagEntry,
    normalizePosActionDiag,
    isActionEvent,
    actionOrderSnapshot,
    actionSnapshotPatch,
    newActionRecord,
    stationRecordType,
    // v0.7 Batch C — completed_items
    saleItemsOf,
    mergeProductNames,
    fillSaleItemNames,
    COMPLETED_TARGET,
    COMPLETED_HEADERS,
    COMPLETED_BUSINESS_FIELDS,
    COMPLETED_STATUSES,
    SYNC_CAPABILITY_COMPLETED,
    COMPLETED_DIAG_MAX,
    COMPLETED_DIAG_LABELS,
    posTimeCompare,
    completedStatusAt,
    completedVerdict,
    completedCandidate,
    completedItemsOf,
    completedKey,
    isCompletedRecord,
    completedRow,
    mergeCompletedItem,
    completedDiagEntry,
    completedIncompleteOrders,
    completedSyncStatusOf,
    completedCounts,
    selectCompletedBatch,
    completedEnvelope,
    parseCompletedPreflight,
    // v0.7.2
    COMPLETED_EXTRA_FIELDS,
    COMPLETED_HEADERS_V2,
    SYNC_CAPABILITY_COMPLETED_V2,
    COMPLETED_LM_ENVELOPE_VERSION,
    completedSheetLBlankCount,
    markCompletedLmSuspect,
    completedLmReviewCount,
    parseCompletedPreflightV2,
    completedExtrasFill,
    parseCompletedResponse,
    applyCompletedAck,
    applyCompletedRejection,
    SYNC_ENVELOPE_V4,
    SYNC_TARGET_DATA,
    SYNC_CAPABILITY_ACTIONS,
    SYNC_ACTION_RECHECK_MS,
    syncAllowsActions,
    itemInfoVerdict,
    itemInfoPatch,
    infraBackoffMs,
    eventOrderSnapshot,
    sheetContent,
    sheetRow,
    newEventRecord,
    mergeContentUpdate,
    mergeWorkerUpdate,
    lookupBackoffMs,
    lookupWanted,
    lookupPatch,
    SYNC_FIELDS,
    SYNC_BATCH_MAX,
    SYNC_TIMEOUT_MS,
    SYNC_ACK_STATUSES,
    SHEET_ENDPOINT_RE,
    normalizeSheetEndpoint,
    NEXTWAVES_DEFAULT_API_BASE,
    normalizeNextwavesTenant,
    parseNextwavesInstallCode,
    nextwavesApiBase,
    withNextwavesBase,
    notifyApiBaseOf,
    isSyncable,
    SYNC_SCHEMA_VERSION,
    SYNC_ENVELOPE_VERSION,
    POS_STATION_IDS,
    PRODUCT_FIELDS,
    STATION_FIELDS,
    normalizeStationId,
    hasStation,
    productKeyOf,
    hasProductSnapshot,
    productSnapshotOf,
    productPatch,
    stationQueue,
    stationPatch,
    stationSeqKey,
    legacyStationSeqKey,
    STATION_SEQ_MIGRATION,
    syncedRevisionOf,
    syncStatusOf,
    selectSyncBatch,
    syncEnvelope,
    parseSyncResponse,
    PREFLIGHT_HEADER_STATES,
    parseSchemaPreflight,
    applySyncAck,
    ackStationPair,
    applySyncRejection,
    syncBackoffMs,
    syncCounts,
    dataUnsyncedSummary,
    pendingAtStopSummary,
    dataStopPendingStatus,
    dataStopNotice,
    DATA_STOP_PEND_LIST_MAX,
    memorySpill,
    storageSpill,
    chromeStorageSpill,
    ORPHAN_SPILL_PREFIX,
    durableSpill,
    migrateLegacyOutbox,
    SaveQueue,
    // 0.6 — pilot trừ tồn Nextwaves
    NEXTWAVES_MEDLY_WAREHOUSE_ID,
    STOCKOUT_ORDER_TYPE,
    STOCKOUT_ALLOWLIST_MAX,
    STOCKOUT_MAX_ATTEMPTS,
    STOCKOUT_WAIT_MAX_MS,
    STOCKOUT_STATE,
    STOCKOUT_TERMINAL,
    STOCKOUT_STATE_LABELS,
    STOCKOUT_SKIP_REASONS,
    STOCKOUT_SKIP_LABELS,
    ORDERS_SYNC_ID_FIELDS,
    normalizeUnit,
    unitsAgree,
    normalizeEpcStrict,
    normalizeStockoutPilot,
    normalizeStockoutApproval,
    stockoutApproved,
    stockoutApprovalFor,
    stockoutGate,
    parseNextwavesTag,
    stockoutMayResolveEpc,
    stockoutCandidates,
    orderItemFor,
    stockoutItemVerdict,
    stockoutPayload,
    stockoutEvidence,
    stockoutPlanFor,
    ordersSyncCreatedFlag,
    nextwavesSyncVerdict,
    stockoutBackoffMs,
    stockoutDue,
    newStockoutJob,
    stockoutWaitExpired,
    stockoutFreeze,
    applyStockoutVerdict,
    stockoutRecover,
    stockoutAfterToken,
    stockoutEnableVerdict,
    STOCKOUT_ENABLE_LABELS,
    stockoutReopen,
    stockoutCounts,
    csvEscape,
    toCsv,
    crc32,
    buildXlsx,
    formatLocal,
    exportOrderItemQuantity,
    buildExportRows,
    reconcile,
    // v0.7.1
    canonicalJson,
    sameContent,
    FANOUT_RULES_VERSION,
    orderReconcileSignature,
    STATION_RECORD_TYPES,
    parseStationFloors,
    stationFloorKey,
    stationFloorOf,
    pendEventKey,
    PEND_OPS,
    pendOpOf,
    pendDrainOrder,
    popupDataFromAll,
    rfidTagsForExport,
    applyStorageChanges,
    // v0.7.3 — Phase 1 /orders/notify
    NOTIFY_MAX_TAGS,
    NOTIFY_PILOT_MAX_ORDERS,
    NOTIFY_STATE,
    NOTIFY_STARTED_STATES,
    NOTIFY_STATE_LABELS,
    NOTIFY_REASON_LABELS,
    stockItemsOf,
    notifyOrderVerdict,
    notifyScanRole,
    notifyScanTag,
    tagHoldingProblem,
    tagBaseUnitProblem,
    buildNotifyPreview,
    parseNotifyEpcHolding,
    notifyVerdict,
    normalizeNotifyPilot,
    notifyPilotAllows,
    notifyStarted,
    notifyIdempotencyKey,
    NOTIFY_ORDER_CODE_RE,
    notifyOrderSnapshot,
    notifyJobAfterPreview,
    notifySendVerdict,
    notifyRecoverJob,
    notifyResendable,
    notifyResendVerdict,
    notifyFrozenProblem,
    // v0.7.7 — tự động trừ tồn + sổ stock_out
    NOTIFY_AUTO_MAX_ATTEMPTS,
    NOTIFY_AUTO_RETRY_DELAYS_MS,
    NOTIFY_AUTO_WINDOW_MS,
    NOTIFY_AUTO_LABELS,
    NOTIFY_TRANSIENT_REASONS,
    normalizeNotifyAuto,
    notifyAutoActive,
    notifyAutoOrderVerdict,
    notifyAutoRetryPlan,
    notifyAutoStamp,
    notifyAutoSendVerdict,
    notifyPosChange,
    notifyRefreshWanted,
    LEDGER_TARGET,
    LEDGER_HEADERS,
    SYNC_CAPABILITY_LEDGER,
    LEDGER_STATE,
    LEDGER_STATE_LABELS,
    LEDGER_LINE_STATUS_LABELS,
    ledgerRowKey,
    ledgerOrderState,
    ledgerRows,
    mergeLedger,
    isLedgerRecord,
    ledgerAllRows,
    ledgerRowSyncStatus,
    ledgerCounts,
    selectLedgerBatch,
    ledgerRow,
    ledgerEnvelope,
    parseLedgerPreflight,
    parseLedgerResponse,
    applyLedgerAck,
    applyLedgerRejection,
    ledgerOrderVerdict,
    // v0.7.9.1 — mảnh QR lỗi không chặn (đủ bằng chứng) + giữ job bị chặn trước bản sửa
    NOTIFY_DISMISS_MAPPING_ERROR,
    notifyUnplacedDismissal,
    NOTIFY_PRE_UPGRADE,
    notifyPreUpgrade,
    notifyLegacySendVerdict,
    notifyUnitChangeLines,
    notifyUnitChangeSendVerdict,
    // v0.7.10 — trừ theo từng UID, toàn vẹn response COMPLETED, kết quả một phần
    NOTIFY_RULE,
    NOTIFY_HOLDING_DEFINITIVE,
    NOTIFY_PARTIAL_LABELS,
    stockItemsIntegrityProblem,
    notifyScanCodes,
    notifyLineHistory,
    notifyUnitTagProblem,
    notifyOutcome,
    // v0.7.10.4 — một tem, đổi đơn vị bán
    NOTIFY_LINE_RULE_UNIT_CHANGE,
    notifyUnitChangeMarkerOk,
    isUnitChangeAction,
    notifyUnitChangeLine,
    // v0.7.12.1 — nhật ký qr_codes (lời gọi ghi máy khác) + dòng sổ observer
    qrLogCount,
    notifyLineWriteProblem,
    ledgerManualTotals,
  };
});
