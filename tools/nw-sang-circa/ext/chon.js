/* Extension "Kiểm kê Circa ↔ NW": CHỌN THẺ GỬI (chon.js). THUẦN: không gọi mạng, không đọc token, không DOM, không lưu trữ.
 * Chạy trong trình duyệt (panel.html, service worker) và Node (test-ext.js). Phần cần lõi NWC (core.js) nhận NWC qua tham số.
 *
 * Gồm:
 *   1. Ghép kho NW với tên cửa hàng Circa (chuyển nguyên từ link.js v0.1.0): matchWarehouse (NFC + trim + không phân biệt hoa thường,
 *      không bỏ dấu, không khớp gần đúng; chỉ locationType "warehouse", closedAt null; duyệt mọi cấp children; 0 hoặc > 1 kho → không ghép).
 *      warehousesOf, recListOf, recWarehouseId, hasCapability.
 *   2. Danh sách phiên Circa (circaListOf, circaRow).
 *   3. Đọc một phiên NW (analyzeSession): sheet "Danh sách kiểm kê" (1 dòng/SP) + kết quả NWC.parseSession của "Chi tiết quét".
 *      SP đủ điều kiện trong phiên: Trạng thái "Khớp", Đã đếm > 0, Thủ công = 0, Tồn hệ thống = Đã đếm, tổng "Số lượng thẻ" các thẻ
 *      của SP = Đã đếm. Thủ công > 0 → để riêng "khớp nhờ đếm thủ công"; Tồn hệ thống ≠ Đã đếm hoặc tổng thẻ ≠ Đã đếm → "file xuất
 *      không nhất quán". Thiếu cột "Tồn hệ thống" → cả phiên không dùng được. SP không "Khớp" chỉ đếm.
 *      Mọi SP có trạng thái khác "Chưa đếm" là ỨNG VIÊN của phiên (cand), kèm lần quét mới nhất của SP trong "Chi tiết quét".
 *   4. Chọn phiên nguồn (choose, quy tắc PM 23/11): với mỗi SP, ứng viên = mọi phiên NW đã chọn mà SP có trạng thái khác "Chưa đếm".
 *      Lấy ứng viên có lần quét mới nhất của SP (bằng nhau → phiên createdAt mới hơn). CHỈ gửi khi ứng viên đó đủ điều kiện, và chỉ
 *      lấy thẻ của chính phiên đó (không gộp thẻ giữa các phiên). Ứng viên mới nhất không đủ điều kiện (Thiếu / Thừa / khớp nhờ đếm
 *      thủ công / không nhất quán…) → để riêng CẢ SP, nêu phiên nào và vì sao. Có ≥ 2 ứng viên mà một ứng viên không xác định được
 *      thời điểm quét (không có dòng trong "Chi tiết quét", "Lần quét cuối" trống / không đọc được) → để riêng "không chọn được phiên".
 *      Chỉ một ứng viên → như trước. SP không "Khớp" ở mọi ứng viên → chỉ đếm, không liệt kê.
 *   5. finish(NWC, chosen, lookups, scans): tra mã → NWC.plan; SP có thẻ không gửi được (Circa không nhận / giữ) → để riêng CẢ SP;
 *      lượt quét đã lưu của phiên Circa: SP đã có lượt quét không phải thẻ của ta → để riêng CẢ SP; còn lại chỉ gửi thẻ còn thiếu
 *      (NWC.batches loại mã đã có). Không sửa core.js; mọi quy tắc trên chạy ở lớp này.
 *   6. readScans(io, o): đọc TOÀN BỘ lượt quét đã lưu của phiên Circa, fail-closed (summary trước / sau, offset = số lượt đã nhận, khử trùng
 *      theo id, đọc lại khi trùng / lệch tổng, chặn lượt không đọc được product_id). Gọi mạng qua io do panel truyền vào; ở đây không gọi mạng.
 *
 * Chỗ đặc tả chưa nói, chọn cách AN TOÀN (không gửi SP đó) — ghi ở báo cáo v0.2.0:
 *   - dòng lỗi / bị bỏ qua / có "Thực tế nhập" trong "Chi tiết quét" → để riêng SP của dòng đó ("file xuất không nhất quán");
 *     dòng không xác định được SP (Mã SP hỏng, thiếu cột) → CẢ phiên không dùng được (fatal), panel dừng xem trước.
 *   - SP có nhiều dòng trong "Danh sách kiểm kê", số không đọc được → "file xuất không nhất quán".
 *   - ứng viên bằng cả lần quét lẫn ngày tạo phiên (hoặc không đọc được ngày tạo) → để riêng "không chọn được phiên".
 *   - SP có thẻ trong "Chi tiết quét" mà không có dòng trong "Danh sách kiểm kê" cũng là ứng viên (không đủ điều kiện).
 *   - Khớp mà Đã đếm 0, không thẻ: ứng viên không đủ điều kiện, không có thời điểm quét.
 *   - mã (EPC/UID) dùng cho > 1 thẻ trong tập thẻ đã chọn → để riêng mọi SP liên quan.
 *   - lượt quét có sẵn của thẻ ta nhưng ghi sai số / sai SP / nhiều lượt / bằng MÃ KHÁC của cùng thẻ (vd phiên có EPC, ta gửi UID)
 *     → để riêng SP (NWC.checkScans coi lượt mã khác là "đếm đôi"; không gửi thêm vào SP đã ghi lệch).
 */
(function (root, factory) {
  var C = factory();
  if (typeof module === "object" && module && module.exports) module.exports = C;
  if (root) root.KKCHON = C;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  var UUID_I = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function cleanId(v) { return typeof v === "string" && UUID_I.test(v) ? v.toLowerCase() : ""; }
  function str(v) { return v == null ? "" : String(v).trim(); }
  function nfc(s) { return typeof s.normalize === "function" ? s.normalize("NFC") : s; }
  // so chữ như NWC._norm: NFC, bỏ khoảng trắng đầu/cuối, chữ thường
  function norm(v) { return nfc(str(v)).toLowerCase(); }
  // tên kho / tên cửa hàng: NFC, bỏ khoảng trắng đầu/cuối, chữ thường. KHÔNG bỏ dấu, không gộp khoảng trắng giữa, không khớp gần đúng.
  function normName(s) { return typeof s === "string" ? s.normalize("NFC").trim().toLowerCase() : ""; }
  function toNum(v) {
    if (typeof v === "number") return v;
    if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
    return null;
  }
  function short(s, n) { s = String(s == null ? "" : s); return s.length > (n || 120) ? s.slice(0, n || 120) + "…" : s; }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  // ================= 1. ghép kho NW (từ link.js v0.1.0, không đổi quy tắc) =================
  // danh sách kho: mảng ở gốc (dạng thật 22/11), hoặc {data:[…]}; dạng phân trang còn trang sau → null (không đoán)
  function warehousesOf(j) {
    if (Array.isArray(j)) return { list: j };
    if (j && typeof j === "object" && Array.isArray(j.data)) {
      var tp = +j.totalPages, pg = +j.page;
      if (tp > 1 && !(pg >= tp)) return { list: null, why: "danh sách kho có " + tp + " trang: extension chưa đọc trang sau" };
      return { list: j.data };
    }
    return { list: null, why: "phản hồi /warehouses không phải mảng" };
  }
  // Kho dạng cây: duyệt mọi cấp qua children (≤ 10 cấp), khử trùng theo id (một kho có thể vừa ở gốc vừa nằm trong children cha).
  function flattenWarehouses(list) {
    var out = [], seen = {};
    (function walk(arr, depth) {
      if (!Array.isArray(arr) || depth > 10) return;
      arr.forEach(function (w) {
        if (!w || typeof w !== "object") return;
        var id = cleanId(String(w.id || ""));
        if (id && !seen[id]) { seen[id] = 1; out.push(w); }
        else if (!id) out.push(w);
        walk(w.children, depth + 1);
      });
    })(list, 0);
    return out;
  }
  // → {ok:true, wh:{id,name,code}} | {ok:false, why:"none"|"many"|"bad-input", count, candidates:[tên]}
  function matchWarehouse(storeName, list) {
    var want = normName(storeName);
    if (!want || !Array.isArray(list)) return { ok: false, why: "bad-input", count: 0, candidates: [] };
    var usable = flattenWarehouses(list).filter(function (w) {
      return w.locationType === "warehouse" && w.closedAt == null && typeof w.name === "string" && cleanId(String(w.id || ""));
    });
    var hit = usable.filter(function (w) { return normName(w.name) === want; });
    if (hit.length === 1) return { ok: true, wh: { id: cleanId(String(hit[0].id)), name: hit[0].name, code: hit[0].code == null ? "" : String(hit[0].code) } };
    return { ok: false, why: hit.length ? "many" : "none", count: hit.length, candidates: usable.map(function (w) { return w.name; }).slice(0, 30) };
  }
  // danh sách phiên NW (dạng thật: {data,total,page,limit,totalPages} ở gốc; dự phòng meta.totalPages).
  // → {list, totalPages: số | null (không đọc được)} | null (không phải danh sách)
  function recListOf(j) {
    if (!j || typeof j !== "object" || Array.isArray(j) || !Array.isArray(j.data)) return null;
    var tp = j.totalPages != null ? j.totalPages : j.meta && typeof j.meta === "object" ? j.meta.totalPages : null;
    tp = typeof tp === "number" ? tp : typeof tp === "string" && /^\d+$/.test(tp) ? +tp : NaN;
    return { list: j.data, totalPages: Number.isSafeInteger(tp) && tp >= 0 ? tp : null };
  }
  // kho của một phiên NW: warehouseId, hoặc warehouse.id
  function recWarehouseId(x) {
    if (!x || typeof x !== "object") return "";
    return cleanId(String(x.warehouseId || "")) || (x.warehouse && typeof x.warehouse === "object" ? cleanId(String(x.warehouse.id || "")) : "");
  }
  // Quyền Circa (/authz/me): chịu được mảng chuỗi lẫn mảng object, lồng nhau.
  // → true | false (đọc được danh sách quyền mà không có) | null (không đọc được cấu trúc: KHÔNG chặn)
  function hasCapability(json, cap) {
    var found = false, sawCap = false, n = 0;
    var CAPLIKE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/;
    function walk(v, depth) {
      if (found || n > 20000 || depth > 8 || v == null) return;
      n++;
      if (typeof v === "string") { if (CAPLIKE.test(v)) { sawCap = true; if (v === cap) found = true; } return; }
      if (Array.isArray(v)) { for (var i = 0; i < v.length && !found; i++) walk(v[i], depth + 1); return; }
      if (typeof v === "object") { for (var k in v) if (has(v, k)) walk(v[k], depth + 1); }
    }
    walk(json, 0);
    return found ? true : sawCap ? false : null;
  }

  // ================= 2. danh sách phiên Circa =================
  // GET /v1/inventory/count/sessions → {success, data:{list, total, status_counts}}. → {list, total} | null
  function circaListOf(j) {
    var d = j && typeof j === "object" && j.success !== false && j.data && typeof j.data === "object" ? j.data : null;
    if (!d || !Array.isArray(d.list)) return null;
    var t = d.total;
    t = typeof t === "number" ? t : typeof t === "string" && /^\d+$/.test(t) ? +t : NaN;
    return { list: d.list, total: Number.isSafeInteger(t) && t >= 0 ? t : null };
  }
  // một dòng danh sách → bản sạch (chỉ trường cần) | null (id / pos_id không phải uuid)
  function circaRow(x) {
    if (!x || typeof x !== "object") return null;
    var id = cleanId(String(x.id || "")), pos = cleanId(String(x.pos_id || ""));
    if (!id || !pos) return null;
    function s(v) { return v == null ? "" : String(v); }
    return { id: id, code: s(x.code), pos_id: pos, pos_name: s(x.pos_name), status: s(x.status), counting_mode: s(x.counting_mode), created_at: s(x.created_at),
      created_by_name: s(x.created_by_name), total_lines: toNum(x.total_lines), completed_lines: toNum(x.completed_lines) };
  }

  // ================= 3. đọc một phiên NW =================
  // số nguyên ≥ 0 trong file xuất NW: số JS nguyên; chuỗi chữ số; chuỗi có dấu chấm ngăn nghìn ĐÚNG nhóm 3 ("1.234", "12.345.678").
  // Dấu khác (phẩy, thập phân, khoảng trắng giữa…) → null (không đoán).
  function intOf(v) {
    if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
    var t = str(v);
    if (/^\d+$/.test(t)) { var n = Number(t); return Number.isSafeInteger(n) ? n : null; }
    if (/^\d{1,3}(\.\d{3})+$/.test(t)) { var m = Number(t.replace(/\./g, "")); return Number.isSafeInteger(m) ? m : null; }
    return null;
  }
  // "CIRCA-123" | "123" | 123 → 123 (như NWC); khác → null
  function parsePid(v) {
    if (typeof v === "number") return Number.isSafeInteger(v) && v > 0 ? v : null;
    var m = /^(?:CIRCA[-_ ]?)?(\d+)$/i.exec(str(v));
    if (!m) return null;
    var n = Number(m[1]);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  // "Lần quét cuối": "dd/mm/yyyy HH:MM:SS" (giờ địa phương trong file) → số ms "giờ ghi trong file" (Date.UTC của các thành phần, chỉ để
  // SO SÁNH giữa các phiên cùng múi giờ); ô ngày Excel (số) → cùng thang. Không đúng dạng / ngày không có thật → null.
  function timeOf(v) {
    if (typeof v === "number") return isFinite(v) && v > 0 ? Math.round((v - 25569) * 86400) * 1000 : null;
    var m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(str(v));
    if (!m) return null;
    var d = +m[1], mo = +m[2], y = +m[3], h = +m[4], mi = +m[5], s = +m[6];
    if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
    var t = Date.UTC(y, mo - 1, d, h, mi, s), z = new Date(t);
    if (z.getUTCDate() !== d || z.getUTCMonth() !== mo - 1) return null;
    return t;
  }
  function fmtTime(t) {
    if (typeof t !== "number") return "";
    var z = new Date(t), p = function (x) { return String(x).padStart(2, "0"); };
    return p(z.getUTCDate()) + "/" + p(z.getUTCMonth() + 1) + "/" + z.getUTCFullYear() + " " + p(z.getUTCHours()) + ":" + p(z.getUTCMinutes()) + ":" + p(z.getUTCSeconds());
  }
  // số dòng như NWC.parseSession: __rowNum__ + 1 (sheet_to_json), không có thì i + 2
  function rowNo(r, i) { return r && typeof r.__rowNum__ === "number" ? r.__rowNum__ + 1 : i + 2; }
  function colKey(rows, name) {
    var w = norm(name), seen = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || typeof r !== "object") continue;
      var ks = Object.keys(r);
      for (var j = 0; j < ks.length; j++) {
        if (seen[ks[j]]) continue;
        seen[ks[j]] = 1;
        if (norm(ks[j]) === w) return ks[j];
      }
    }
    return null;
  }
  function arr(v) { return Array.isArray(v) ? v : []; }

  var STATUS_KHOP = "Khớp", STATUS_CHUA_DEM = "Chưa đếm";
  // lý do để riêng (mã → nhãn)
  var REASONS = {
    "thu-cong": "Khớp nhờ đếm thủ công",
    "khong-nhat-quan": "File xuất không nhất quán",
    "khong-chon-duoc-phien": "Không chọn được phiên nguồn",
    "phien-moi-khong-khop": "Phiên NW mới hơn không khớp",
    "trung-ma": "Thẻ trùng mã với thẻ khác",
    "the-khong-gui": "Có thẻ không gửi được",
    "luot-khac": "Phiên Circa đã có lượt quét khác"
  };
  var DS_NEED = { pid: "Mã SP", status: "Trạng thái", ton: "Tồn hệ thống", daDem: "Đã đếm", thuCong: "Thủ công" };
  function short8(id) { return String(id || "").slice(0, 8); }

  // meta: {id, createdAt}; dsRows / ctRows: sheet_to_json(defval "") của "Danh sách kiểm kê" / "Chi tiết quét";
  // parsed: NWC.parseSession(ctRows, rowsTheLa).
  // → {id, createdAt, createdAtMs, fatal, counts:{trạng thái: số SP}, eligible:{pid: entry}, aside:[entry + reason, detail],
  //    cand:{pid: ứng viên}, khopZero, notInDs, dsBadPid, warn:[]}
  //    entry = {pid, name, unit, nwId, daDem, thuCong, ton, tags:[tag NWC], qty, lastScan, lastScanText, timeBad}
  //    ứng viên (mọi SP có trạng thái khác "Chưa đếm", kể cả SP có thẻ mà không có trong "Danh sách kiểm kê"):
  //      {pid, name, unit, nwId, status, kind: "eligible" | "aside" (Khớp mà để riêng) | "khac" (không Khớp / Khớp mà Đã đếm 0),
  //       reason, detail, tags (số thẻ), rows (số dòng trong "Chi tiết quét"), qty, daDem, ton, lastScan, lastScanText}
  //    lastScan = lần quét mới nhất của SP trên MỌI dòng của SP trong "Chi tiết quét"; null khi không có dòng nào hoặc có dòng mà
  //    "Lần quét cuối" trống / không đọc được.
  function analyzeSession(meta, dsRows, ctRows, parsed) {
    meta = meta || {};
    var id = cleanId(String(meta.id || "")), cms = Date.parse(String(meta.createdAt || ""));
    var out = { id: id, createdAt: meta.createdAt == null ? null : String(meta.createdAt), createdAtMs: isFinite(cms) ? cms : null, fatal: "", counts: {},
      eligible: {}, aside: [], cand: {}, khopZero: 0, notInDs: 0, dsBadPid: 0, warn: [] };
    if (!id) { out.fatal = "id phiên NW không hợp lệ"; return out; }
    if (!Array.isArray(dsRows)) { out.fatal = "Không có sheet “Danh sách kiểm kê”"; return out; }
    if (!Array.isArray(ctRows) || !parsed || !Array.isArray(parsed.tags)) { out.fatal = "Không đọc được sheet “Chi tiết quét”"; return out; }
    var dc = {};
    Object.keys(DS_NEED).forEach(function (k) { dc[k] = colKey(dsRows, DS_NEED[k]); });
    dc.name = colKey(dsRows, "Tên sản phẩm"); dc.unit = colKey(dsRows, "ĐVT");
    if (dsRows.length) {
      var miss = Object.keys(DS_NEED).filter(function (k) { return !dc[k]; });
      if (miss.length) { out.fatal = "Sheet “Danh sách kiểm kê” thiếu cột " + miss.map(function (k) { return "“" + DS_NEED[k] + "”"; }).join(", "); return out; }
    }
    // ---- Chi tiết quét: gán dòng lỗi / bỏ qua / "Thực tế nhập" theo SP; lần quét mới nhất theo SP ----
    var rowMap = {}, ctPid = colKey(ctRows, "Mã SP"), ctTime = colKey(ctRows, "Lần quét cuối");
    var timeBy = {};   // pid → {n, bad, max}
    ctRows.forEach(function (r, i) {
      rowMap[rowNo(r, i)] = r;
      var p = r && ctPid ? parsePid(r[ctPid]) : null;
      if (p == null) return;
      var t = r && ctTime ? timeOf(r[ctTime]) : null, o = timeBy[p] = timeBy[p] || { n: 0, bad: 0, max: null };
      o.n++;
      if (t == null) o.bad++; else if (o.max == null || t > o.max) o.max = t;
    });
    function lastOf(pid) { var o = timeBy[pid]; return o && !o.bad ? o.max : null; }
    function pidOfRow(row) { var r = row == null ? null : rowMap[row]; return r && ctPid ? parsePid(r[ctPid]) : null; }
    var badBy = {}, unattributed = [];
    function bad(row, msg) {
      var p = pidOfRow(row);
      if (p == null) { unattributed.push(msg); return; }
      (badBy[p] = badBy[p] || []).push(msg);
    }
    arr(parsed.errors).forEach(function (e) { bad(e.row, e.msg || e.type); });
    arr(parsed.skipped).forEach(function (s) {
      bad(s.row, "Dòng " + s.row + " (" + (s.epc || "không EPC") + "): " + (s.reason === "trang-thai" ? "Trạng thái “" + s.value + "” ≠ “Đã quét”" : s.reason === "trung-epc-giong" ? "trùng y hệt dòng " + s.keptRow : s.reason));
    });
    arr(parsed.warnings).forEach(function (w) { if (w.type === "thuc-te-nhap") bad(w.row, w.msg); });
    if (unattributed.length) {
      out.fatal = "Sheet “Chi tiết quét” có " + unattributed.length + " dòng lỗi không xác định được sản phẩm (" + short(unattributed.slice(0, 3).join("; "), 300) + "): không dùng được phiên này";
      return out;
    }
    var tagsBy = {};
    parsed.tags.forEach(function (t) { (tagsBy[t.pid] = tagsBy[t.pid] || []).push(t); });
    // ---- Danh sách kiểm kê: 1 dòng / SP ----
    var seen = {}, dup = {}, order = [];
    dsRows.forEach(function (r, i) {
      var st = str(r[dc.status]);
      out.counts[st || "(trống)"] = (out.counts[st || "(trống)"] || 0) + 1;
      var pid = parsePid(r[dc.pid]);
      if (pid == null) { out.dsBadPid++; if (st === STATUS_KHOP) out.warn.push("Dòng " + rowNo(r, i) + " của “Danh sách kiểm kê” trạng thái Khớp nhưng Mã SP không đọc được (" + short(r[dc.pid], 40) + "): không gửi"); return; }
      if (seen[pid]) { dup[pid] = 1; return; }
      seen[pid] = { r: r, row: rowNo(r, i), st: st };
      order.push(pid);
    });
    function cand(e, status, kind) {
      var t = lastOf(e.pid);
      out.cand[e.pid] = { pid: e.pid, name: e.name, unit: e.unit, nwId: id, status: status, kind: kind, reason: e.reason || "", detail: e.detail || "",
        tags: e.tags.length, rows: timeBy[e.pid] ? timeBy[e.pid].n : 0, qty: e.qty, daDem: e.daDem, ton: e.ton, lastScan: t, lastScanText: t == null ? "" : fmtTime(t) };
    }
    // SP có thẻ trong "Chi tiết quét" mà không có trong "Danh sách kiểm kê": chỉ đếm, nhưng vẫn là ứng viên (không đủ điều kiện)
    Object.keys(tagsBy).forEach(function (p) {
      if (seen[p]) return;
      out.notInDs++;
      var tg = tagsBy[p];
      cand({ pid: +p, name: tg[0].name, unit: tg[0].nwUnit, tags: tg, qty: tg.reduce(function (a, t) { return a + t.nwQty; }, 0), daDem: null, ton: null }, "(không có trong “Danh sách kiểm kê”)", "khac");
    });
    order.forEach(function (pid) {
      var x = seen[pid];
      var stAll = dup[pid] ? dsRows.filter(function (r) { return parsePid(r[dc.pid]) === pid; }).map(function (r) { return str(r[dc.status]); }) : [x.st];
      // trạng thái "Chưa đếm" ở mọi dòng → không phải ứng viên, không ảnh hưởng phiên khác
      if (stAll.every(function (s) { return s === STATUS_CHUA_DEM; })) return;
      var tags = tagsBy[pid] || [];
      var e = { pid: pid, name: str(dc.name ? x.r[dc.name] : "") || (tags[0] ? tags[0].name : ""), unit: str(dc.unit ? x.r[dc.unit] : "") || (tags[0] ? tags[0].nwUnit : ""), nwId: id,
        daDem: intOf(x.r[dc.daDem]), thuCong: intOf(x.r[dc.thuCong]), ton: intOf(x.r[dc.ton]), tags: tags, qty: tags.reduce(function (a, t) { return a + t.nwQty; }, 0) };
      var anyKhop = stAll.some(function (s) { return s === STATUS_KHOP; });
      function aside(code, detail) { e.reason = code; e.detail = detail; out.aside.push(e); cand(e, stAll.join(" / "), "aside"); }
      if (dup[pid]) {
        // nhiều dòng cùng SP: để riêng khi có ít nhất một dòng Khớp, còn lại chỉ đếm
        if (anyKhop) aside("khong-nhat-quan", "SP có nhiều dòng trong “Danh sách kiểm kê”");
        else cand(e, stAll.join(" / "), "khac");
        return;
      }
      if (!anyKhop) { cand(e, x.st || "(trống)", "khac"); return; }
      if (e.daDem == null || e.thuCong == null || e.ton == null) return aside("khong-nhat-quan", "không đọc được số “Tồn hệ thống” / “Đã đếm” / “Thủ công” (" + short(x.r[dc.ton], 20) + " / " + short(x.r[dc.daDem], 20) + " / " + short(x.r[dc.thuCong], 20) + ")");
      if (e.ton !== e.daDem) return aside("khong-nhat-quan", "trạng thái “Khớp” nhưng “Tồn hệ thống” " + e.ton + " ≠ “Đã đếm” " + e.daDem);
      if (e.daDem === 0 && !tags.length) { out.khopZero++; cand(e, x.st, "khac"); return; }
      if (e.thuCong > 0) return aside("thu-cong", "Thủ công = " + e.thuCong + " (Đã đếm " + e.daDem + ")");
      if (badBy[pid]) return aside("khong-nhat-quan", "“Chi tiết quét” có dòng lỗi / bị bỏ qua / có “Thực tế nhập”: " + short(badBy[pid].join("; "), 300));
      if (e.daDem === 0) return aside("khong-nhat-quan", "Đã đếm = 0 nhưng có " + tags.length + " thẻ");
      if (e.qty !== e.daDem) return aside("khong-nhat-quan", "tổng “Số lượng thẻ” " + e.qty + " (" + tags.length + " thẻ) ≠ “Đã đếm” " + e.daDem);
      var t = lastOf(pid);
      e.timeBad = t == null;
      e.lastScan = t;
      e.lastScanText = t == null ? "" : fmtTime(t);
      out.eligible[pid] = e;
      cand(e, x.st, "eligible");
    });
    return out;
  }

  // ================= 4. chọn phiên nguồn cho từng SP =================
  // analyses: kết quả analyzeSession của các phiên NW đã chọn. Phiên có fatal → {fatal:[{id, msg}]} (panel dừng, không chọn gì).
  // → {fatal:[], products:[{pid, name, unit, nwId, tags (bản sao, row đánh số lại toàn cục; nwRow = dòng trong file), qty, daDem, lastScan,
  //      lastScanText, cands}], aside:[{pid, name, unit, nwId, tags, qty, reason, detail, cands}]}
  //   cands = mọi ứng viên của SP: [{nwId, status, kind, lastScan, lastScanText, createdAt, createdAtMs}]
  function choose(analyses) {
    var list = arr(analyses), fatal = list.filter(function (a) { return !a || a.fatal; }).map(function (a) { return { id: a ? a.id : "", msg: a ? a.fatal : "không có dữ liệu" }; });
    var res = { fatal: fatal, products: [], aside: [] };
    if (fatal.length) return res;
    var ids = {};
    list.forEach(function (a) { if (ids[a.id]) fatal.push({ id: a.id, msg: "phiên NW được chọn 2 lần" }); ids[a.id] = 1; });
    if (fatal.length) return res;
    var byPid = {}, order = [];
    list.forEach(function (a) {
      Object.keys(a.cand || {}).forEach(function (k) {
        var c = a.cand[k];
        if (!byPid[c.pid]) { byPid[c.pid] = []; order.push(c.pid); }
        byPid[c.pid].push({ a: a, c: c });
      });
    });
    function label(x) { return short8(x.a.id) + (x.c.lastScanText ? " (quét " + x.c.lastScanText + ")" : ""); }
    function why0(x) {
      var c = x.c;
      if (c.kind === "aside") return (REASONS[c.reason] || c.reason) + ": " + c.detail;
      if (c.kind === "eligible") return "Khớp";
      return "ghi “" + c.status + "”" + (c.ton != null && c.daDem != null ? " (Tồn hệ thống " + c.ton + ", Đã đếm " + c.daDem + ")" : "");
    }
    var seq = 0;
    order.forEach(function (pid) {
      var xs = byPid[pid];
      // không phiên nào "Khớp" (đủ điều kiện hoặc Khớp mà để riêng) → chỉ đếm theo trạng thái, không liệt kê
      if (!xs.some(function (x) { return x.c.kind !== "khac"; })) return;
      var cands = xs.map(function (x) { return { nwId: x.a.id, status: x.c.status, kind: x.c.kind, lastScan: x.c.lastScan, lastScanText: x.c.lastScanText, createdAt: x.a.createdAt, createdAtMs: x.a.createdAtMs }; });
      var pick = null, why = "";
      if (xs.length === 1) pick = xs[0];
      else if (xs.some(function (x) { return x.c.lastScan == null; })) {
        why = "SP có ở " + xs.length + " phiên NW (không tính phiên “Chưa đếm”) nhưng không xác định được “Lần quét cuối” ở phiên " +
          xs.filter(function (x) { return x.c.lastScan == null; }).map(function (x) { return short8(x.a.id) + " (" + (x.c.rows ? "“Lần quét cuối” trống / không đọc được" : "không có dòng nào trong “Chi tiết quét”") + ")"; }).join(", ");
      } else {
        var mx = Math.max.apply(null, xs.map(function (x) { return x.c.lastScan; }));
        var top = xs.filter(function (x) { return x.c.lastScan === mx; });
        if (top.length === 1) pick = top[0];
        else if (top.some(function (x) { return x.a.createdAtMs == null; })) why = "“Lần quét cuối” bằng nhau ở " + top.length + " phiên và không đọc được ngày tạo phiên NW";
        else {
          var mc = Math.max.apply(null, top.map(function (x) { return x.a.createdAtMs; }));
          var top2 = top.filter(function (x) { return x.a.createdAtMs === mc; });
          if (top2.length === 1) pick = top2[0];
          else why = "“Lần quét cuối” và ngày tạo phiên NW đều bằng nhau ở " + top2.map(function (x) { return short8(x.a.id); }).join(", ");
        }
      }
      var ref = pick || xs.filter(function (x) { return x.c.kind !== "khac"; })[0];
      function asideOut(code, detail, nwId) {
        res.aside.push({ pid: pid, name: ref.c.name, unit: ref.c.unit, nwId: nwId, tags: ref.c.tags, qty: ref.c.qty, reason: code, detail: detail, cands: cands });
      }
      if (!pick) return asideOut("khong-chon-duoc-phien", why, "");
      if (pick.c.kind === "eligible") {
        var e = pick.a.eligible[pid];
        res.products.push({
          pid: pid, name: e.name, unit: e.unit, nwId: pick.a.id, qty: e.qty, daDem: e.daDem, lastScan: e.lastScan, lastScanText: e.lastScanText, cands: cands,
          tags: e.tags.map(function (t) { var o = Object.assign({}, t); o.nwRow = t.row; o.row = ++seq; o.nwId = pick.a.id; return o; })
        });
        return;
      }
      // một ứng viên (Khớp mà để riêng): như trước
      if (xs.length === 1) return asideOut(pick.c.reason, pick.c.detail, pick.a.id);
      // ứng viên mới nhất không đủ điều kiện → để riêng CẢ SP, không lấy thẻ phiên cũ hơn
      var others = xs.filter(function (x) { return x !== pick; });
      asideOut(pick.c.kind === "aside" ? pick.c.reason : "phien-moi-khong-khop",
        "phiên mới nhất " + label(pick) + " " + why0(pick) + "; không lấy thẻ phiên cũ hơn: " + others.map(function (x) { return label(x) + " " + why0(x); }).join("; "),
        pick.a.id);
    });
    return res;
  }

  // ================= 5. sau khi chọn: trùng mã, tra Circa, thẻ không gửi, lượt quét có sẵn =================
  function setOf(a) { var s = {}; a.forEach(function (x) { s[x] = 1; }); return s; }
  function parsedOf(tags) { return { tags: tags, strange: [], errors: [], skipped: [], warnings: [] }; }
  function tagsOf(products) { var o = []; products.forEach(function (p) { o.push.apply(o, p.tags); }); return o; }
  function asideOf(p, code, detail) { return { pid: p.pid, name: p.name, unit: p.unit, nwId: p.nwId, tags: p.tags.length, qty: p.qty, reason: code, detail: detail }; }
  function split(products, bad, code) {
    var keep = [], aside = [];
    products.forEach(function (p) { if (bad[p.pid]) aside.push(asideOf(p, code, bad[p.pid].join("; "))); else keep.push(p); });
    return { keep: keep, aside: aside };
  }
  function addR(o, pid, msg) { if (pid == null) return; var a = o[pid] = o[pid] || []; if (a.indexOf(msg) < 0 && a.length < 5) a.push(msg); }

  // mã (UID/EPC) dùng cho > 1 thẻ trong tập đã chọn → để riêng mọi SP liên quan. → {keep, aside}
  function dupCodes(NWC, products) {
    var own = {}, bad = {};
    products.forEach(function (p) {
      p.tags.forEach(function (t) {
        NWC.lookupCodes(t).forEach(function (c) { var k = NWC._codeKey(c); (own[k] = own[k] || []).push({ pid: p.pid, epc: t.epc, row: t.row }); });
      });
    });
    Object.keys(own).forEach(function (k) {
      var o = own[k];
      if (o.length < 2) return;
      o.forEach(function (x) { addR(bad, x.pid, "mã " + k + " dùng cho " + o.length + " thẻ (" + o.map(function (y) { return "SP " + y.pid + " " + y.epc; }).join(", ") + ")"); });
    });
    return split(products, bad, "trung-ma");
  }
  // mã cần tra qr-lookup cho tập thẻ (khử trùng không phân biệt hoa thường)
  function lookupList(NWC, products) {
    var seen = {}, out = [];
    tagsOf(products).forEach(function (t) { NWC.lookupCodes(t).forEach(function (c) { var k = NWC._codeKey(c); if (!seen[k]) { seen[k] = 1; out.push(c); } }); });
    return out;
  }
  // quy tắc e: SP có thẻ không gửi được (Circa không nhận / giữ) hoặc gốc dự tính ≠ SL NW → để riêng cả SP. "chưa tra" KHÔNG xét ở đây.
  function ruleE(P) {
    var bad = {};
    P.bySp.forEach(function (p) {
      if (p.modes["khong-nhan"]) addR(bad, p.pid, "Circa không nhận " + p.modes["khong-nhan"] + "/" + p.tags + " thẻ");
      if (p.modes.giu) addR(bad, p.pid, "giữ lại " + p.modes.giu + "/" + p.tags + " thẻ: " + short(p.reasons.join("; "), 300));
      if (p.predMismatch) addR(bad, p.pid, p.predMismatch + " thẻ có gốc dự tính theo payload ≠ SL NW");
    });
    return bad;
  }
  // quy tắc d: lượt quét đã lưu của phiên Circa. items = item GỬI ĐƯỢC của các SP định gửi (NWC.plan sau quy tắc e).
  function ruleD(NWC, items, scans) {
    var bad = {}, codesOf = {}, ownerOf = {}, pidOfEpc = {};
    var send = items.filter(function (it) { return it.mode === "tho" || it.mode === "kem-don-vi"; });
    send.forEach(function (it) {
      var s = codesOf[it.pid] = codesOf[it.pid] || {};
      NWC.lookupCodes(it).forEach(function (c) { var k = NWC._codeKey(c); s[k] = 1; if (ownerOf[k] == null) ownerOf[k] = it.pid; });
      pidOfEpc[NWC._codeKey(it.epc)] = it.pid;
    });
    var list = arr(scans);
    list.forEach(function (s) {
      if (!s) return;
      var k = NWC._codeKey(s.qr_code), sp = toNum(s.product_id);
      if (sp != null && codesOf[sp] && !codesOf[sp][k]) addR(bad, sp, "phiên Circa đã có lượt quét không phải thẻ của phiên NW nguồn (mã " + short(s.qr_code, 40) + ", " + (toNum(s.base_qty) == null ? "?" : toNum(s.base_qty)) + " gốc" + (s.device_id ? ", thiết bị " + short(s.device_id, 30) : "") + ")");
      var o = ownerOf[k];
      if (o != null && sp !== o) addR(bad, o, "lượt quét có sẵn của thẻ (mã " + short(s.qr_code, 40) + ") ghi vào SP " + sp);
    });
    var cs = NWC.checkScans(send, list);
    cs.rows.forEach(function (r) {
      if (r.result === "sai-so" || r.result === "sai-sp" || r.result === "lap") addR(bad, r.pid, "lượt quét có sẵn của thẻ " + r.code + ": " + r.result + " (" + r.msg + ")");
    });
    cs.foreign.forEach(function (f) {
      if (f.tagEpc != null) addR(bad, pidOfEpc[NWC._codeKey(f.tagEpc)], "phiên Circa đã có lượt quét bằng mã khác của thẻ " + f.tagEpc + " (mã " + short(f.code, 40) + ")");
    });
    return bad;
  }

  // finish: chosen = kết quả choose; lookups = map mã → data | null (NWC.lookupMap); scans = lượt quét đã lưu của phiên Circa (mảng).
  // → {pending:true, P1, chuaTra} khi còn thẻ chưa tra (panel cho tra lại, chưa gửi gì)
  //   | {P1, P3, products (gửi / đã có), aside (mọi SP để riêng, gồm của choose), blockers (P3 có lý do chặn khác "không có thẻ")}
  function finish(NWC, chosen, lookups, scans) {
    var aside = chosen.aside.slice();
    var d = dupCodes(NWC, chosen.products);
    aside = aside.concat(d.aside);
    var P1 = NWC.plan(parsedOf(tagsOf(d.keep)), lookups);
    if (P1.sum.modes["chua-tra"]) return { pending: true, P1: P1, chuaTra: P1.sum.modes["chua-tra"], aside: aside };
    var e = split(d.keep, ruleE(P1), "the-khong-gui");
    aside = aside.concat(e.aside);
    var P2 = NWC.plan(parsedOf(tagsOf(e.keep)), lookups);
    var dd = split(e.keep, ruleD(NWC, P2.items, scans), "luot-khac");
    aside = aside.concat(dd.aside);
    var P3 = NWC.plan(parsedOf(tagsOf(dd.keep)), lookups);
    var blockers = P3.sum.blockers.filter(function (b) { return !(dd.keep.length === 0 && /Không có thẻ nào để gửi/.test(b)); });
    return { P1: P1, P3: P3, products: dd.keep, aside: aside, blockers: blockers };
  }

  // bảng xem trước theo SP. excluded = bodies.excluded (mã đã có trong phiên Circa). → {rows, total}
  //   row: {pid, name, nwId, tags, nwQty, circaBase, send, have, status: "gui" | "gui-thieu" | "da-co" | "de-rieng", reason, label, detail}
  function previewRows(fin, excluded) {
    var exBy = {};
    arr(excluded).forEach(function (x) { exBy[x.pid] = (exBy[x.pid] || 0) + 1; });
    var sp = {};
    if (fin.P3) fin.P3.bySp.forEach(function (p) { sp[p.pid] = p; });
    var rows = [];
    fin.products.forEach(function (p) {
      var q = sp[p.pid] || { nwBase: p.qty, predBase: 0 }, ex = exBy[p.pid] || 0, n = p.tags.length;
      rows.push({ pid: p.pid, name: p.name, nwId: p.nwId, tags: n, nwQty: q.nwBase, circaBase: q.predBase, send: n - ex, have: ex,
        status: ex >= n ? "da-co" : ex > 0 ? "gui-thieu" : "gui", reason: "", label: ex >= n ? "Đã có trong phiên Circa" : ex > 0 ? "Gửi phần còn thiếu (đã có " + ex + "/" + n + " thẻ)" : "Gửi", detail: "" });
    });
    fin.aside.forEach(function (a) {
      rows.push({ pid: a.pid, name: a.name, nwId: a.nwId || "", tags: a.tags, nwQty: a.qty, circaBase: null, send: 0, have: 0, status: "de-rieng", reason: a.reason,
        label: "Để riêng: " + (REASONS[a.reason] || a.reason), detail: a.detail || "" });
    });
    var RANK = { "gui": 0, "gui-thieu": 1, "da-co": 2, "de-rieng": 3 };
    rows.sort(function (a, b) { return RANK[a.status] - RANK[b.status] || String(a.name).localeCompare(String(b.name), "vi") || a.pid - b.pid; });
    var total = { sp: rows.length, gui: 0, "gui-thieu": 0, "da-co": 0, "de-rieng": 0, tags: 0, nwQty: 0, circaBase: 0, send: 0, have: 0, sendSp: 0, sendQty: 0, asideTags: 0, asideQty: 0 };
    rows.forEach(function (r) {
      total[r.status]++;
      if (r.status === "de-rieng") { total.asideTags += r.tags; total.asideQty += r.nwQty || 0; return; }
      total.tags += r.tags; total.nwQty += r.nwQty || 0; total.circaBase += r.circaBase || 0; total.send += r.send; total.have += r.have;
      if (r.send > 0) total.sendSp++;
    });
    return { rows: rows, total: total };
  }

  // ================= 6. đọc lượt quét đã lưu của phiên Circa (fail-closed) =================
  // Circa thật (records/pos-writes/20261121-lumina-day-du-1.scans-sau.json, ICS00237): lượt MỚI NHẤT TRƯỚC (giảm dần scanned_at), mỗi lượt có id,
  // một lô 100 thẻ trùng một scanned_at; summary data.total_scans = số lượt (ICS00237: 357 = 357 lượt = 357 id). Hành vi offset chưa kiểm thật.
  // Một LẦN ĐỌC: summary → T1; lật trang limit, offset = số lượt đã nhận, tới has_more=false (trang ngắn mà has_more=true → đọc tiếp;
  // trang rỗng mà has_more=true → hỏng; thiếu has_more: trang ngắn = hết, trang đủ limit = hỏng); mọi lượt phải có id (chuỗi không rỗng),
  // id trùng → hỏng; summary lần nữa → T2. ĐẠT khi T1 = T2 = số id khác nhau. Hỏng vì trùng id / lệch tổng → đọc lại từ đầu (tổng cộng ≤ tries
  // lần, cách gapMs). Lỗi HTTP / thiếu trường / thiếu id / trang rỗng / chạm trần maxPages → dừng ngay, không đọc lại.
  // Lần đọc ĐẠT mà có lượt không đọc được product_id (null, thiếu, rỗng, không phải số nguyên dương) → cũng KHÔNG dùng được (không biết lượt
  // thuộc SP nào: quy tắc d / đối chiếu sẽ bỏ sót). Đây là chỗ chung trước ruleD (finish) và reconcileOurs.
  // io: {summary: async () → r, page: async (offset) → r, sleep: async (ms)}; r = {status, j, err, msg} như kết quả api.js / background.
  // o: {limit, maxPages, tries, gapMs, errInfo(r) → chuỗi}.
  // → {ok:true, scans, pages, total, attempts} | {ok:false, kind, msg, r, attempts, samples}
  //   kind: unstable (trùng / lệch tổng cả tries lần) | http | shape | no-id | no-has-more | empty | cap | product
  //   attempts[i] = {lan, t1, t2, ids, dup, pages, offsets, why}
  var SCAN_UNSTABLE = "Không đọc được ổn định lượt quét của phiên Circa (đang có người quét?)";
  function n0(v) {
    if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
    if (typeof v === "string" && /^(?:0|[1-9]\d{0,14})$/.test(v)) return Number(v);
    return null;
  }
  // tổng số lượt của summary: data.total_scans (số nguyên ≥ 0) | null
  function scanTotalOf(r) {
    var j = r && r.status === 200 ? r.j : null;
    var d = j && typeof j === "object" && !Array.isArray(j) && j.success !== false ? j.data : null;
    return d && typeof d === "object" && !Array.isArray(d) ? n0(d.total_scans) : null;
  }
  function scanIdOf(s) { return s && typeof s === "object" && typeof s.id === "string" && s.id.trim() !== "" ? s.id : null; }
  // product_id dùng được: số nguyên dương (number, hoặc chuỗi chữ số như toNum đọc)
  function scanPidOk(v) { var n = n0(v); return n != null && n > 0; }
  function fmtN(n) { return typeof n === "number" && isFinite(n) ? n.toLocaleString("vi-VN") : n == null ? "?" : String(n); }
  function attemptText(a) {
    return "lần " + a.lan + ": tổng theo summary trước " + fmtN(a.t1) + " / sau " + fmtN(a.t2) + ", đọc được " + fmtN(a.ids) + " id khác nhau" +
      (a.dup ? ", " + fmtN(a.dup) + " id trùng (trang " + a.pages + ")" : "") + " qua " + a.pages + " trang";
  }
  async function readScansOnce(io, lim, maxPages, einfo) {
    var st = { lan: 0, t1: null, t2: null, ids: 0, dup: 0, pages: 0, offsets: [], why: "" };
    var r1 = await io.summary();
    if (!r1 || r1.status !== 200) return { kind: "http", r: r1, stat: st, msg: "Không đọc được tổng số lượt quét của phiên Circa (summary): " + einfo(r1) };
    st.t1 = scanTotalOf(r1);
    if (st.t1 == null) return { kind: "shape", r: r1, stat: st, msg: "Không đọc được tổng số lượt quét của phiên Circa: summary không có data.total_scans (số nguyên ≥ 0) — DỪNG." };
    var all = [], seen = Object.create(null), end = false;
    for (var page = 1; page <= maxPages; page++) {
      var off = all.length;
      st.offsets.push(off); st.pages = page;
      var r = await io.page(off);
      var j = r && r.status === 200 ? r.j : null;
      var d = j && typeof j === "object" && !Array.isArray(j) && j.success !== false ? j.data : null;
      if (!d || typeof d !== "object" || !Array.isArray(d.scans))
        return { kind: "http", r: r, stat: st, msg: "Không đọc được lượt quét của phiên Circa (trang " + page + ", offset " + off + "): " + einfo(r) + (r && r.status === 200 ? " (thiếu data.scans)" : "") };
      var noId = [], dup = 0;
      for (var i = 0; i < d.scans.length; i++) {
        var id = scanIdOf(d.scans[i]);
        if (id == null) { noId.push(off + i + 1); continue; }
        if (seen[id] === 1) { dup++; continue; }
        seen[id] = 1; all.push(d.scans[i]);
      }
      if (noId.length) {
        st.ids = all.length;
        return { kind: "no-id", r: r, stat: st, msg: "Phiên Circa trả " + fmtN(noId.length) + " lượt quét không có id (trang " + page + ", lượt thứ " + noId.slice(0, 5).join(", ") + (noId.length > 5 ? "…" : "") + "): không khử trùng được — DỪNG." };
      }
      if (dup) {
        // hỏng: trùng id (lượt chen vào / thứ tự đổi giữa hai trang / máy chủ bỏ qua offset). Đọc summary lần nữa chỉ để ghi số liệu.
        st.dup = dup; st.ids = all.length; st.why = "trùng id";
        st.t2 = scanTotalOf(await io.summary());
        return { kind: "unstable", retry: true, stat: st };
      }
      if (d.has_more === false) { end = true; break; }
      if (d.has_more !== true) {
        if (d.scans.length < lim) { end = true; break; }
        st.ids = all.length;
        return { kind: "no-has-more", r: r, stat: st, msg: "Lượt quét trang " + page + " trả đủ " + fmtN(lim) + " lượt mà không có has_more: không biết còn trang sau — DỪNG." };
      }
      if (!d.scans.length) { st.ids = all.length; return { kind: "empty", r: r, stat: st, msg: "Lượt quét trang " + page + " rỗng mà has_more = true — DỪNG." }; }
    }
    st.ids = all.length;
    if (!end) return { kind: "cap", stat: st, msg: "Phiên Circa còn lượt quét sau " + maxPages + " trang (đã nhận " + fmtN(all.length) + " lượt, vẫn còn has_more): chạm trần của extension, chưa đọc hết lượt quét — không lập kế hoạch / không đối chiếu được." };
    var r2 = await io.summary();
    if (!r2 || r2.status !== 200) return { kind: "http", r: r2, stat: st, msg: "Không đọc được tổng số lượt quét của phiên Circa (summary, sau khi lật trang): " + einfo(r2) };
    st.t2 = scanTotalOf(r2);
    if (st.t2 == null) return { kind: "shape", r: r2, stat: st, msg: "Không đọc được tổng số lượt quét của phiên Circa: summary không có data.total_scans (số nguyên ≥ 0) — DỪNG." };
    if (st.t1 !== st.t2 || st.t1 !== all.length) { st.why = "lệch tổng"; return { kind: "unstable", retry: true, stat: st }; }
    return { ok: true, scans: all, stat: st };
  }
  async function readScans(io, o) {
    o = o || {};
    var lim = o.limit || 1000, maxPages = o.maxPages || 60, tries = Math.max(1, o.tries || 3), gap = o.gapMs || 0;
    var einfo = typeof o.errInfo === "function" ? o.errInfo : function (r) { return r ? "HTTP " + r.status + (r.err ? " " + r.err : "") + (r.msg ? ": " + r.msg : "") : "không có phản hồi"; };
    var attempts = [];
    for (var a = 1; a <= tries; a++) {
      if (a > 1 && gap > 0 && io.sleep) await io.sleep(gap);
      var x = await readScansOnce(io, lim, maxPages, einfo);
      x.stat.lan = a;
      attempts.push(x.stat);
      if (x.ok) {
        var bad = x.scans.filter(function (s) { return !scanPidOk(s.product_id); });
        if (bad.length) {
          var samples = bad.slice(0, 5).map(function (s) { return short(s.id, 40); });
          return { ok: false, kind: "product", attempts: attempts, samples: samples, nBad: bad.length,
            msg: "Phiên Circa có " + fmtN(bad.length) + "/" + fmtN(x.scans.length) + " lượt quét không đọc được product_id (trống / không phải mã SP dạng số), ví dụ id " + samples.join(", ") +
              ": không biết các lượt này thuộc SP nào — DỪNG." };
        }
        return { ok: true, scans: x.scans, pages: x.stat.pages, total: x.stat.t1, attempts: attempts };
      }
      if (!x.retry) return { ok: false, kind: x.kind, msg: x.msg, r: x.r, attempts: attempts };
    }
    return { ok: false, kind: "unstable", attempts: attempts,
      msg: SCAN_UNSTABLE + ". Đã đọc " + tries + " lần, lần nào cũng lệch: " + attempts.map(attemptText).join("; ") + "." };
  }

  // đối chiếu cuối: chỉ xét SP đã gửi (P3). Lượt của SP khác trong phiên Circa (nhân viên quét QR…) không thuộc phần gửi → chỉ đếm.
  // → {cs (NWC.checkScans), ok, ours:[foreign của SP ta / mã của thẻ ta], others:[foreign khác], circaBase, nwBase, bySp (chỉ SP ta)}
  function reconcileOurs(NWC, P3, scans) {
    var list = arr(scans), cs = NWC.checkScans(P3.items, list);
    var mine = {};
    P3.items.forEach(function (it) { mine[it.pid] = 1; });
    var ours = [], others = [];
    cs.foreign.forEach(function (f) { if (f.tagEpc != null || (f.product_id != null && mine[f.product_id])) ours.push(f); else others.push(f); });
    var circaBase = 0;
    list.forEach(function (s) { if (s && mine[toNum(s.product_id)]) circaBase += toNum(s.base_qty) || 0; });
    var nwBase = P3.sum.nwBase, bad = cs.rows.length - cs.sum.counts.dung;
    var ok = cs.rows.length > 0 && bad === 0 && ours.length === 0 && circaBase === nwBase;
    return { cs: cs, ok: ok, ours: ours, others: others, circaBase: circaBase, nwBase: nwBase, bySp: cs.bySp.filter(function (p) { return mine[p.pid]; }),
      otherSp: Object.keys(setOf(others.map(function (f) { return String(f.product_id); }))).length };
  }

  return {
    // 1
    cleanId: cleanId, normName: normName, warehousesOf: warehousesOf, flattenWarehouses: flattenWarehouses, matchWarehouse: matchWarehouse,
    recListOf: recListOf, recWarehouseId: recWarehouseId, hasCapability: hasCapability,
    // 2
    circaListOf: circaListOf, circaRow: circaRow,
    // 3–5
    intOf: intOf, parsePid: parsePid, timeOf: timeOf, fmtTime: fmtTime, analyzeSession: analyzeSession, choose: choose,
    dupCodes: dupCodes, lookupList: lookupList, ruleE: ruleE, ruleD: ruleD, finish: finish, previewRows: previewRows, reconcileOurs: reconcileOurs,
    parsedOf: parsedOf, tagsOf: tagsOf, REASONS: REASONS, STATUS_KHOP: STATUS_KHOP, STATUS_CHUA_DEM: STATUS_CHUA_DEM,
    // 6
    readScans: readScans, scanTotalOf: scanTotalOf, scanPidOk: scanPidOk, SCAN_UNSTABLE: SCAN_UNSTABLE
  };
});
