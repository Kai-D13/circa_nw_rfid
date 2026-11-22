// NW kiểm kê → Circa kiểm kê: LÕI TÍNH TOÁN (NWC).
// OFFLINE / THUẦN: không gọi mạng, không đọc/ghi file, không dùng token, không nạp module nào.
// Chạy được trong trình duyệt (kể cả worker) và Node.
//
// Dùng:
//   Node:        nạp file này bằng require của Node (module.exports = NWC)
//   Trình duyệt: nạp file bằng thẻ script (hoặc chép vào worker) → globalThis.NWC
//
// Luồng:
//   1. parsed = parseSession(rowsChiTiet, rowsTheLa)   (mảng dòng sheet_to_json của "Chi tiết quét" / "Thẻ lạ")
//   2. lookupCodes(tag) → mã cần tra qr-lookup Circa; lookupMap(res) dựng map từ kết quả tra
//   3. P = plan(parsed, lookups) → item từng thẻ + bảng theo SP + tổng. CỜ DUY NHẤT để cho gửi: P.sum.okToSend
//      (lý do chặn ở P.sum.blockers). Truyền mảng tags trần thay cho parsed thì okToSend luôn false.
//   4. bodies = batches(P.items, sessionId, deviceId, existing?) → body POST /v1/inventory/count/submit-rfid-batch
//      (≤ 100 mã/lô; bỏ khoá tags/items rỗng; existing = mã đã có trong phiên → loại, báo ở bodies.excluded)
//   5. checkResponse(itemsFor(body, P.items), response.data, {resend}) cho từng lô
//   6. reconcile(P.items, allChecks) → bảng theo SP theo response
//   7. checkScans(P.items, scans) → đối chiếu với lượt quét ĐÃ LƯU của phiên (GET …/sessions/<id>/scans): nguồn cuối cùng
//
// Quy tắc nghiệp vụ theo đặc tả PM 21/11/2026 (bản sửa sau soát độc lập). Không tự đổi quy tắc ở đây.

(function (root, factory) {
  var NWC = factory();
  if (typeof module === "object" && module && module.exports) module.exports = NWC;
  if (root) root.NWC = NWC;
})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : this), function () {
  "use strict";

  var BATCH = 100;
  var MAX_QTY = 100000;
  var SEND_MODES = { "tho": 1, "kem-don-vi": 1 };
  var MODES = ["tho", "kem-don-vi", "giu", "khong-nhan", "chua-tra"];
  var RESULTS = ["dung", "sai-so", "sai-sp", "khong-nhan", "tu-choi", "mat"];
  var SCAN_RESULTS = ["dung", "sai-so", "sai-sp", "thieu", "lap"];
  var COLS = {
    pid: "Mã SP", name: "Tên sản phẩm", epc: "EPC", uid: "UID",
    qty: "Số lượng thẻ", unit: "ĐVT", status: "Trạng thái", actual: "Thực tế nhập"
  };
  var STATUS_OK = "Đã quét";

  // ---------- tiện ích ----------
  function str(v) { return v == null ? "" : String(v).trim(); }
  function nfc(s) { return typeof s.normalize === "function" ? s.normalize("NFC") : s; }
  // so chữ: không phân biệt hoa thường, bỏ khoảng trắng đầu/cuối, chuẩn hoá Unicode NFC
  function norm(v) { return nfc(str(v)).toLowerCase(); }
  // khoá so mã thẻ (EPC/UID/QR): không phân biệt hoa thường
  function codeKey(v) { return nfc(str(v)).toUpperCase(); }
  function isPosInt(n) { return typeof n === "number" && Number.isSafeInteger(n) && n > 0; }
  function toNum(v) {
    if (typeof v === "number") return v;
    if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
    return null;
  }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function inc(o, k, n) { o[k] = (o[k] || 0) + (n == null ? 1 : n); }
  function zeroCounts(keys) { var o = {}; keys.forEach(function (k) { o[k] = 0; }); return o; }
  function uniq(a) { var s = {}, o = []; a.forEach(function (x) { if (!s[x]) { s[x] = 1; o.push(x); } }); return o; }
  function isSent(it) { return !!(it && SEND_MODES[it.mode]); }

  // → {n} hoặc {err:{type, msg}}; KHÔNG đoán dấu ngăn nghìn / thập phân
  function parseQty(v) {
    if (typeof v === "number") {
      if (isPosInt(v)) return { n: v };
      return { err: { type: "sl-sai", msg: "Số lượng thẻ " + JSON.stringify(v) + " không phải số nguyên dương" } };
    }
    var t = str(v);
    if (/^\d+$/.test(t)) {
      var n = Number(t);
      if (isPosInt(n)) return { n: n };
    }
    if (/^\d+([.,]\d+)+$/.test(t)) {
      return { err: { type: "sl-dau-phan-cach", msg: "Số lượng thẻ \"" + t + "\" có dấu chấm/phẩy (ngăn nghìn hay thập phân?): không đoán, sửa file/NW rồi xuất lại" } };
    }
    return { err: { type: "sl-sai", msg: "Số lượng thẻ " + JSON.stringify(v == null ? null : v) + " không phải số nguyên dương" } };
  }
  function parsePid(v) {
    if (typeof v === "number") return isPosInt(v) ? v : null;
    var m = /^(?:CIRCA[-_ ]?)?(\d+)$/i.exec(str(v));
    if (!m) return null;
    var n = Number(m[1]);
    return isPosInt(n) ? n : null;
  }
  function rowNo(r, i) { return r && typeof r.__rowNum__ === "number" ? r.__rowNum__ + 1 : i + 2; }
  function colMap(rows, wanted) {
    var keys = [], seen = {};
    rows.forEach(function (r) {
      if (!r || typeof r !== "object") return;
      Object.keys(r).forEach(function (k) { if (!seen[k]) { seen[k] = 1; keys.push(k); } });
    });
    var m = {};
    Object.keys(wanted).forEach(function (id) {
      var w = norm(wanted[id]);
      for (var i = 0; i < keys.length; i++) if (norm(keys[i]) === w) { m[id] = keys[i]; break; }
    });
    return m;
  }

  // ---------- 1. đọc phiên NW ----------
  // → {tags:[{epc, uid, pid, name, nwQty, nwUnit, row, hold?}], strange:[epc], errors:[], skipped:[], warnings:[]}
  // errors   = dòng bị BỎ: thiếu cột, thiếu EPC, SL không phải số nguyên dương (kể cả có dấu chấm/phẩy), Mã SP hỏng.
  // skipped  = dòng bỏ không phải lỗi: Trạng thái ≠ "Đã quét", trùng EPC giống hệt dòng trước.
  // warnings = giữ dòng nhưng cần xem: trùng EPC khác số liệu (CẢ HAI dòng giữ lại với tag.hold → plan cho "giu"),
  //            trùng mã giữa 2 thẻ, thẻ lạ trùng EPC/UID thẻ đã quét, cột "Thực tế nhập" có giá trị.
  // plan() chặn gửi (okToSend false) khi errors hoặc skipped khác rỗng.
  function parseSession(rowsChiTiet, rowsTheLa) {
    var rows = arr(rowsChiTiet), la = arr(rowsTheLa);
    var out = { tags: [], strange: [], errors: [], skipped: [], warnings: [] };
    var cm = colMap(rows, COLS);
    if (rows.length) {
      ["epc", "qty", "pid"].forEach(function (id) {
        if (!cm[id]) out.errors.push({ row: null, epc: "", type: "thieu-cot", msg: "Không có cột \"" + COLS[id] + "\"" });
      });
    }
    var hasStatus = !!cm.status, okStatus = norm(STATUS_OK);
    var groups = {}; // codeKey(epc) → [tag]
    rows.forEach(function (r, i) {
      var row = rowNo(r, i);
      var epc = str(cm.epc ? r[cm.epc] : "");
      if (hasStatus) {
        var st = str(r[cm.status]);
        if (norm(st) !== okStatus) { out.skipped.push({ row: row, epc: epc, reason: "trang-thai", value: st }); return; }
      }
      if (!epc) { out.errors.push({ row: row, epc: "", type: "thieu-epc", msg: "Dòng " + row + ": thiếu EPC" }); return; }
      var q = parseQty(cm.qty ? r[cm.qty] : undefined);
      if (q.err) { out.errors.push({ row: row, epc: epc, type: q.err.type, msg: "Dòng " + row + " (" + epc + "): " + q.err.msg }); return; }
      var rawP = cm.pid ? r[cm.pid] : undefined, pid = parsePid(rawP);
      if (pid == null) {
        out.errors.push({ row: row, epc: epc, type: "ma-sp-sai", msg: "Dòng " + row + " (" + epc + "): Mã SP không đọc được: " + JSON.stringify(rawP === undefined ? null : rawP) });
        return;
      }
      if (cm.actual && str(r[cm.actual]) !== "") {
        out.warnings.push({ row: row, epc: epc, type: "thuc-te-nhap", msg: "Dòng " + row + " (" + epc + "): cột \"Thực tế nhập\" = " + JSON.stringify(r[cm.actual]) + " (công cụ dùng \"Số lượng thẻ\" = " + q.n + ")" });
      }
      var tag = {
        epc: epc, uid: str(cm.uid ? r[cm.uid] : ""), pid: pid, name: str(cm.name ? r[cm.name] : ""),
        nwQty: q.n, nwUnit: str(cm.unit ? r[cm.unit] : ""), row: row
      };
      var k = codeKey(epc), g = groups[k] || (groups[k] = []);
      var same = g.filter(function (a) {
        return codeKey(a.uid) === codeKey(tag.uid) && a.pid === tag.pid && a.nwQty === tag.nwQty && norm(a.nwUnit) === norm(tag.nwUnit);
      })[0];
      if (same) { out.skipped.push({ row: row, epc: epc, reason: "trung-epc-giong", keptRow: same.row }); return; }
      g.push(tag);
      out.tags.push(tag);
    });
    // trùng EPC khác số liệu → giữ cả các dòng, đánh dấu hold
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      if (g.length < 2) return;
      var desc = g.map(function (t) { return "dòng " + t.row + ": SP " + t.pid + ", " + t.nwQty + " " + t.nwUnit + ", UID " + (t.uid || "-"); }).join("; ");
      g.forEach(function (t) { t.hold = "Trùng EPC khác số liệu (" + desc + ")"; });
      out.warnings.push({ row: g[0].row, epc: g[0].epc, type: "trung-epc-khac", rows: g.map(function (t) { return t.row; }), msg: "EPC " + g[0].epc + " trùng " + g.length + " dòng khác số liệu, giữ lại không gửi: " + desc });
    });
    // mã tra / mã gửi trùng giữa 2 EPC khác nhau (UID thẻ này = UID/EPC thẻ kia)
    var codeOwner = {};
    out.tags.forEach(function (t) {
      lookupCodes(t).forEach(function (c) {
        var k = codeKey(c), o = codeOwner[k];
        if (o && codeKey(o.epc) !== codeKey(t.epc)) out.warnings.push({ row: t.row, epc: t.epc, type: "trung-ma", msg: "Mã " + c + " của thẻ " + t.epc + " (dòng " + t.row + ") trùng mã của thẻ " + o.epc + " (dòng " + o.row + ")" });
        else if (!o) codeOwner[k] = t;
      });
    });
    // thẻ lạ: lọc trùng, so với cả EPC lẫn UID của thẻ đã quét
    var cl = colMap(la, { epc: "EPC" }), seenLa = {};
    la.forEach(function (r, i) {
      var e = str(cl.epc ? r[cl.epc] : "");
      if (!e) return;
      var k = codeKey(e);
      if (seenLa[k]) return;
      seenLa[k] = 1;
      out.strange.push(e);
      var o = codeOwner[k];
      if (o) out.warnings.push({ row: rowNo(r, i), epc: e, type: "the-la-trung-the-da-quet", msg: "Thẻ lạ " + e + " trùng " + (codeKey(o.epc) === k ? "EPC" : "UID") + " của thẻ đã quét " + o.epc + " (dòng " + o.row + ")" });
    });
    return out;
  }

  // ---------- 2. mã cần tra ----------
  // UID có và ≠ EPC → [uid, epc]; ngược lại [epc]
  function lookupCodes(tag) {
    var e = str(tag && tag.epc), u = str(tag && tag.uid), out = [];
    if (u && codeKey(u) !== codeKey(e)) out.push(u);
    if (e) out.push(e);
    return out;
  }

  // Dựng map code → data | null từ bản ghi tra qr-lookup [{code, status, d}].
  // 200 có d → d; 404 → null (Circa không nhận); trạng thái khác (lỗi mạng, 5xx…) → bỏ (= chưa tra).
  // Một mã có cả 200 và 404 → lấy 200. Nhiều bản 200 → lấy bản đầu.
  function lookupMap(res) {
    var m = {};
    arr(res).forEach(function (x) {
      if (!x || !str(x.code)) return;
      var c = str(x.code), cur = Object.prototype.hasOwnProperty.call(m, c) ? m[c] : undefined;
      if (x.status === 200 && x.d && typeof x.d === "object") { if (!cur) m[c] = x.d; }
      else if (x.status === 404) { if (cur === undefined) m[c] = null; }
    });
    return m;
  }

  // lookups: Map hoặc object; khoá so không phân biệt hoa thường. Có cả bản null và bản data → lấy data.
  function normLookups(lookups) {
    var M = new Map();
    function put(k, v) {
      if (v === undefined) return;
      var kk = codeKey(k);
      if (!M.has(kk) || (M.get(kk) === null && v !== null)) M.set(kk, v);
    }
    if (lookups && typeof lookups.forEach === "function" && typeof lookups.get === "function") lookups.forEach(function (v, k) { put(k, v); });
    else if (lookups && typeof lookups === "object") Object.keys(lookups).forEach(function (k) { put(k, lookups[k]); });
    return M;
  }

  // ---------- 3. kế hoạch gửi ----------
  function planOne(t, L) {
    var it = {
      epc: t.epc, uid: t.uid || "", pid: t.pid, name: t.name || "", nwQty: t.nwQty, nwUnit: t.nwUnit || "",
      code: null, via: null, circaPid: null, circaUnit: null, circaRate: null, baseUnit: null,
      mode: null, send: null, expectBase: 0, reason: ""
    };
    if (t.row != null) it.row = t.row;
    function stop(mode, reason) { it.mode = mode; it.reason = reason; it.send = null; it.expectBase = 0; return it; }

    // 0. parseSession đã đánh dấu giữ (trùng EPC khác số liệu)
    if (t.hold) return stop("giu", String(t.hold));
    var codes = lookupCodes(t);
    // 1. chưa tra đủ: mọi mã theo lookupCodes phải có trong map
    var missing = codes.filter(function (c) { return !L.has(codeKey(c)); });
    if (missing.length) return stop("chua-tra", "Chưa tra Circa: " + missing.join(", "));
    // 2. không mã nào Circa nhận
    var acc = codes.map(function (c) { return { c: c, d: L.get(codeKey(c)) }; }).filter(function (x) { return !!x.d; });
    if (!acc.length) return stop("khong-nhan", "Circa không nhận mã: " + (codes.join(", ") || "(không có mã)"));
    // 3. chọn mã gửi: mã đầu tiên Circa nhận; UID và EPC cùng nhận mà khác product_id → giữ
    var pids = {};
    acc.forEach(function (x) { pids[String(toNum(x.d.product_id))] = x.c; });
    if (Object.keys(pids).length > 1) {
      return stop("giu", "UID và EPC trỏ 2 SP khác nhau trên Circa: " + acc.map(function (x) { return x.c + " → " + x.d.product_id; }).join("; "));
    }
    var ch = acc[0], d = ch.d;
    it.code = ch.c;
    it.via = codeKey(ch.c) === codeKey(t.epc) ? "EPC" : "UID";
    it.circaPid = toNum(d.product_id);
    it.circaUnit = d.unit_name == null ? null : String(d.unit_name);
    // 4. khác sản phẩm
    if (it.circaPid == null || it.circaPid !== toNum(t.pid)) return stop("giu", "Khác SP: Circa " + d.product_id + " ≠ NW " + t.pid);
    // 5. đơn vị gốc + đơn vị của mã phải có trong retail_units, không mơ hồ
    var ru = arr(d.retail_units).filter(function (r) { return r && typeof r === "object"; });
    var bases = ru.filter(function (r) { return r.base_unit === true; });
    if (bases.length !== 1 || toNum(bases[0].convert_rate) !== 1) {
      return stop("giu", bases.length > 1 ? "Circa có " + bases.length + " đơn vị gốc" : "Không thấy đơn vị gốc Circa (base_unit, quy đổi 1)");
    }
    var base = bases[0];
    it.baseUnit = String(base.unit);
    var baseDup = ru.filter(function (r) { return r !== base && norm(r.unit) === norm(base.unit); });
    if (baseDup.length) {
      return stop("giu", "Tên đơn vị gốc \"" + base.unit + "\" trùng dòng khác trong retail_units (" + baseDup.map(function (r) { return r.unit + " = " + r.convert_rate; }).join(", ") + ")");
    }
    var um = ru.filter(function (r) { return norm(r.unit) === norm(d.unit_name); });
    if (um.length !== 1) {
      return stop("giu", um.length ? "Đơn vị mã \"" + d.unit_name + "\" lặp " + um.length + " lần trong retail_units" : "Không thấy đơn vị mã \"" + str(d.unit_name) + "\" trong retail_units");
    }
    var rate = toNum(um[0].convert_rate);
    if (!(typeof rate === "number" && isFinite(rate) && rate > 0)) return stop("giu", "Quy đổi Circa không hợp lệ: " + JSON.stringify(um[0].convert_rate));
    it.circaRate = rate;
    // 6. đơn vị gốc Circa phải trùng ĐVT NW
    if (norm(base.unit) !== norm(t.nwUnit)) return stop("giu", "Khác đơn vị gốc: Circa \"" + base.unit + "\" ≠ NW \"" + t.nwUnit + "\"");
    if (!isPosInt(t.nwQty)) return stop("giu", "SL NW không phải số nguyên dương: " + JSON.stringify(t.nwQty));
    // 7. quy đổi Circa = SL NW → gửi thô
    if (rate === t.nwQty) {
      it.mode = "tho"; it.send = it.code; it.expectBase = t.nwQty;
      it.reason = "Khớp quy đổi: 1 " + it.circaUnit + " = " + rate + " " + it.baseUnit;
      return it;
    }
    // 8. lệch → gửi kèm đơn vị gốc
    if (t.nwQty > MAX_QTY) return stop("giu", "SL NW " + t.nwQty + " > " + MAX_QTY);
    it.mode = "kem-don-vi";
    it.send = { tag: it.code, unit_name: String(base.unit), quantity: t.nwQty };
    it.expectBase = t.nwQty;
    it.reason = "Lệch quy đổi: Circa 1 " + it.circaUnit + " = " + rate + " " + it.baseUnit + ", NW " + t.nwQty + " " + t.nwUnit;
    return it;
  }

  // Gốc Circa sẽ ghi, dự tính lại từ CHÍNH payload và quy đổi Circa (quy tắc đã thử thật 21/11):
  //   thô → 1 × quy đổi đơn vị của mã; kèm đơn vị → quantity × 1 (chỉ khi unit_name là đơn vị gốc). Không suy ra được → null.
  function predictBase(it) {
    if (!isSent(it)) return null;
    if (it.mode === "tho") return typeof it.send === "string" && codeKey(it.send) === codeKey(it.code) && typeof it.circaRate === "number" ? it.circaRate : null;
    var s = it.send;
    if (!s || typeof s !== "object" || codeKey(s.tag) !== codeKey(it.code) || !it.baseUnit || norm(s.unit_name) !== norm(it.baseUnit)) return null;
    return isPosInt(s.quantity) ? s.quantity : null;
  }

  function spConclusion(p, kemUnits, kemNw) {
    var m = p.modes, kl = [], vc = [];
    if (m["chua-tra"]) { kl.push(m["chua-tra"] + " thẻ chưa tra Circa"); vc.push("Tra lại Circa trước khi gửi"); }
    if (m["khong-nhan"]) { kl.push("Circa không nhận " + m["khong-nhan"] + " thẻ"); vc.push("Kiểm mã trên Circa, đếm tay phần này"); }
    if (m.giu) { kl.push("Giữ " + m.giu + " thẻ: " + p.reasons.join("; ")); vc.push("Kiểm tay, không gửi tự động"); }
    if (m["kem-don-vi"]) {
      kl.push(m["kem-don-vi"] + " thẻ lệch quy đổi (mã trên Circa: " + kemUnits.join(", ") + "; NW: " + kemNw.join(", ") + " " + p.nwUnit + "/thẻ): gửi kèm đơn vị gốc");
      if (!vc.length) vc.push("Không cần làm gì khi gửi (công cụ gửi kèm đơn vị gốc)");
    }
    if (p.predMismatch) { kl.push(p.predMismatch + " thẻ: gốc dự tính theo payload ≠ SL NW"); vc.push("Không gửi; báo lập trình"); }
    if (!kl.length) kl.push("Khớp quy đổi, gửi thô");
    if (!vc.length) vc.push("Không cần làm gì");
    return { ketLuan: kl.join(". "), viecCanLam: vc.join(". ") };
  }

  // Tính bảng theo SP + tổng + cờ okToSend cho một danh sách item (plan gọi; gọi lại được sau khi sửa item).
  // parsed = kết quả parseSession (bắt buộc để okToSend có thể true).
  function summarize(items, parsed) {
    items = arr(items);
    var sp = {}, order = [];
    items.forEach(function (it) {
      var k = String(it.pid), p = sp[k];
      if (!p) {
        p = sp[k] = { pid: it.pid, name: it.name, nwUnit: it.nwUnit, tags: 0, nwBase: 0, sendBase: 0, predBase: 0, holdBase: 0, diff: 0, predMismatch: 0, modes: zeroCounts(MODES), via: { EPC: 0, UID: 0 }, _units: {}, _reasons: [], _kemU: [], _kemN: [] };
        order.push(k);
      }
      p.tags++; p.nwBase += it.nwQty; inc(p.modes, it.mode);
      if (isSent(it)) {
        var pb = predictBase(it);
        p.sendBase += it.expectBase; inc(p.via, it.via);
        if (pb == null || pb !== it.nwQty || it.expectBase !== it.nwQty) p.predMismatch++;
        p.predBase += pb == null ? 0 : pb;
      } else { p.holdBase += it.nwQty; p._reasons.push(it.reason); }
      var ul = it.circaUnit != null && it.circaRate != null ? (it.circaUnit + " = " + it.circaRate + " " + (it.baseUnit || "")).trim() : null;
      if (ul) inc(p._units, ul);
      if (it.mode === "kem-don-vi") { p._kemU.push(ul); p._kemN.push(String(it.nwQty)); }
    });
    var bySp = order.map(function (k) {
      var p = sp[k];
      // chênh = gốc NW − gốc Circa dự tính theo payload (thẻ gửi) − gốc NW thẻ không gửi
      p.diff = p.nwBase - p.predBase - p.holdBase;
      p.circaUnits = Object.keys(p._units).map(function (u) { return u + " (" + p._units[u] + " thẻ)"; }).join("; ");
      p.reasons = uniq(p._reasons);
      var c = spConclusion(p, uniq(p._kemU), uniq(p._kemN));
      p.ketLuan = c.ketLuan; p.viecCanLam = c.viecCanLam;
      delete p._units; delete p._reasons; delete p._kemU; delete p._kemN;
      return p;
    });
    // mã gửi trùng nhau / mã gửi trùng mã (UID hoặc EPC) của một thẻ khác
    var cnt = {}, dup = [], owners = {}, clash = [];
    items.forEach(function (it) {
      lookupCodes(it).forEach(function (c) { var k = codeKey(c); (owners[k] = owners[k] || {})[codeKey(it.epc) + "#" + it.row] = 1; });
    });
    items.forEach(function (it) {
      if (!isSent(it)) return;
      var k = codeKey(it.code);
      cnt[k] = (cnt[k] || 0) + 1;
      if (cnt[k] === 2) dup.push(it.code);
      if (cnt[k] === 1 && owners[k] && Object.keys(owners[k]).length > 1) clash.push(it.code);
    });
    var sum = {
      tags: items.length, sp: bySp.length, nwBase: 0, sendBase: 0, predBase: 0, holdBase: 0, diff: 0,
      modes: zeroCounts(MODES), via: { EPC: 0, UID: 0 }, codes: 0, batches: 0, spDiff: 0, predMismatch: 0,
      dupCodes: dup, codeClash: clash, parse: null, blockers: [], okToSend: false
    };
    bySp.forEach(function (p) {
      sum.nwBase += p.nwBase; sum.sendBase += p.sendBase; sum.predBase += p.predBase; sum.holdBase += p.holdBase; sum.diff += p.diff;
      sum.predMismatch += p.predMismatch;
      if (p.diff !== 0) sum.spDiff++;
      MODES.forEach(function (m) { sum.modes[m] += p.modes[m]; });
      sum.via.EPC += p.via.EPC; sum.via.UID += p.via.UID;
    });
    sum.codes = sum.modes.tho + sum.modes["kem-don-vi"];
    sum.batches = Math.ceil(sum.codes / BATCH);
    var B = sum.blockers;
    if (!parsed || !Array.isArray(parsed.tags) || !Array.isArray(parsed.errors) || !Array.isArray(parsed.skipped)) B.push("Thiếu kết quả parseSession (gọi plan(parsed, lookups))");
    else {
      sum.parse = { errors: arr(parsed.errors).length, skipped: arr(parsed.skipped).length, warnings: arr(parsed.warnings).length, strange: arr(parsed.strange).length };
      if (sum.parse.errors) B.push("File phiên có " + sum.parse.errors + " dòng lỗi (parse errors)");
      if (sum.parse.skipped) B.push("File phiên có " + sum.parse.skipped + " dòng bị bỏ qua (Trạng thái ≠ \"" + STATUS_OK + "\" hoặc trùng EPC)");
    }
    if (sum.modes["chua-tra"]) B.push(sum.modes["chua-tra"] + " thẻ chưa tra Circa");
    if (dup.length) B.push(dup.length + " mã gửi trùng nhau: " + dup.slice(0, 5).join(", "));
    if (clash.length) B.push(clash.length + " mã gửi trùng UID/EPC của thẻ khác: " + clash.slice(0, 5).join(", "));
    if (sum.predMismatch) B.push(sum.predMismatch + " thẻ có gốc dự tính theo payload ≠ SL NW");
    if (!sum.codes) B.push("Không có thẻ nào để gửi");
    sum.okToSend = B.length === 0;
    return { bySp: bySp, sum: sum };
  }

  // plan(parsed, lookups): parsed = kết quả parseSession (hoặc mảng tags trần → okToSend luôn false).
  // → {items, bySp, sum}; sum.okToSend là cờ duy nhất cho phép gửi, sum.blockers là lý do chặn.
  function plan(input, lookups) {
    var parsed = input && !Array.isArray(input) && Array.isArray(input.tags) ? input : null;
    var tags = parsed ? parsed.tags : arr(input);
    var L = normLookups(lookups);
    var items = tags.map(function (t) { return planOne(t, L); });
    var s = summarize(items, parsed);
    return { items: items, bySp: s.bySp, sum: s.sum };
  }

  // ---------- 4. chia lô ----------
  function sendCode(it) {
    if (it.mode === "tho") {
      if (typeof it.send !== "string" || codeKey(it.send) !== codeKey(it.code)) throw new Error("Item thô có send không khớp code: " + it.epc);
      return it.send;
    }
    if (!it.send || typeof it.send !== "object" || codeKey(it.send.tag) !== codeKey(it.code)) throw new Error("Item kèm đơn vị có send không khớp code: " + it.epc);
    if (!isPosInt(it.send.quantity) || !str(it.send.unit_name)) throw new Error("Item kèm đơn vị thiếu unit_name/quantity: " + it.epc);
    return it.send.tag;
  }
  function codeSet(list) {
    var s = {};
    function add(x) {
      var c = typeof x === "string" ? x : x && (x.qr_code != null ? x.qr_code : x.code != null ? x.code : x.tag);
      if (str(c)) s[codeKey(c)] = 1;
    }
    if (list && typeof list.forEach === "function") list.forEach(add);
    return s;
  }

  // → [{session_id, device_id, tags?:[mã], items?:[{tag, unit_name, quantity}]}], mỗi body ≤ BATCH mã (tags + items).
  // Khoá tags / items rỗng thì bỏ hẳn khoá. Chỉ lấy item mode tho / kem-don-vi, giữ thứ tự.
  // Mã trùng (không phân biệt hoa thường) → ném lỗi, không chia.
  // existing (tuỳ chọn): mã đã có trong phiên (mảng/Set chuỗi, hoặc lượt quét {qr_code}) → loại khỏi lô, báo ở
  //   bodies.excluded = [{code, epc, pid, matched, why: "da-co" | "ma-khac-da-co"}] ("ma-khac-da-co": phiên đã có mã kia của cùng thẻ).
  function batches(items, sessionId, deviceId, existing) {
    if (!str(sessionId)) throw new Error("Thiếu session_id");
    if (!str(deviceId)) throw new Error("Thiếu device_id");
    var ex = codeSet(existing);
    var out = [], excluded = [], cur = null, n = 0, seen = {};
    arr(items).forEach(function (it) {
      if (!isSent(it)) return;
      var c = sendCode(it), k = codeKey(c);
      if (seen[k]) throw new Error("Mã gửi trùng: " + c + " (thẻ " + seen[k] + " và " + it.epc + ")");
      seen[k] = it.epc;
      if (ex[k]) { excluded.push({ code: c, epc: it.epc, pid: it.pid, matched: c, why: "da-co" }); return; }
      var alt = lookupCodes(it).filter(function (x) { return codeKey(x) !== k && ex[codeKey(x)]; });
      if (alt.length) { excluded.push({ code: c, epc: it.epc, pid: it.pid, matched: alt[0], why: "ma-khac-da-co" }); return; }
      if (!cur || n >= BATCH) {
        cur = { session_id: str(sessionId), device_id: str(deviceId) };
        out.push(cur); n = 0;
      }
      if (it.mode === "tho") (cur.tags = cur.tags || []).push(c);
      else (cur.items = cur.items || []).push({ tag: c, unit_name: it.send.unit_name, quantity: it.send.quantity });
      n++;
    });
    // giữ thứ tự khoá ổn định: session_id, device_id, tags, items
    out = out.map(function (b) {
      var o = { session_id: b.session_id, device_id: b.device_id };
      if (b.tags && b.tags.length) o.tags = b.tags;
      if (b.items && b.items.length) o.items = b.items;
      return o;
    });
    out.excluded = excluded;
    return out;
  }

  // mã của một body (theo thứ tự tags rồi items)
  function bodyCodes(body) {
    return arr(body && body.tags).map(str).concat(arr(body && body.items).map(function (x) { return str(x && x.tag); }));
  }
  // item của plan nằm trong một body, theo thứ tự trong body
  function itemsFor(body, items) {
    var m = {};
    arr(items).forEach(function (it) { if (isSent(it)) m[codeKey(it.code)] = it; });
    return bodyCodes(body).map(function (c) { return m[codeKey(c)]; }).filter(Boolean);
  }

  // ---------- 5. kiểm response một lô ----------
  // data = response.data của submit-rfid-batch; opts.resend = true khi gửi lại NGUYÊN lô sau timeout/5xx.
  // Response không cho biết mã nào thuộc phần duplicates, nên duplicates > 0 → không mã nào được coi là đã xác nhận
  // (row.confirmed false): ok = false, trừ khi resend (ok có thể true). Cả hai trường hợp needScanCheck = true.
  // → {ok, needScanCheck, rows:[{code, epc, pid, mode, expectBase, gotPid, gotBase, gotUnit, gotQty, result, confirmed, rejectCode, msg, note}],
  //    counts:{dung,…, inserted, duplicates, resolved, unknown, rejected, sent, countOk}, extra, warnings}
  function checkResponse(batchItems, data, opts) {
    opts = opts || {};
    data = data && typeof data === "object" ? data : {};
    var res = arr(data.resolved_tags), unk = arr(data.unknown_tags), rej = arr(data.rejected_tags);
    var R = {}, U = {}, J = {}, inBatch = {};
    res.forEach(function (r) { var k = codeKey(r && r.tag); (R[k] = R[k] || []).push(r); });
    unk.forEach(function (x) { var k = codeKey(typeof x === "string" ? x : x && x.tag); U[k] = (U[k] || 0) + 1; });
    rej.forEach(function (r) { var k = codeKey(r && r.tag); (J[k] = J[k] || []).push(r); });
    var inserted = toNum(data.inserted), duplicates = toNum(data.duplicates);
    var dupAny = !(duplicates === 0);
    var counts = zeroCounts(RESULTS), warnings = [], anomalies = 0;
    var rows = arr(batchItems).map(function (it) {
      var k = codeKey(it.code);
      inBatch[k] = (inBatch[k] || 0) + 1;
      var rr = R[k] || [], jj = J[k] || [], uu = U[k] || 0;
      var row = {
        code: it.code, epc: it.epc, pid: it.pid, mode: it.mode, expectBase: it.expectBase,
        gotPid: null, gotBase: null, gotUnit: null, gotQty: null, result: null, confirmed: false, rejectCode: null, msg: "", note: ""
      };
      var notes = [];
      if (rr.length) {
        var g = rr[0];
        row.gotPid = toNum(g.product_id); row.gotBase = toNum(g.base_quantity);
        row.gotUnit = g.unit_name == null ? null : String(g.unit_name); row.gotQty = toNum(g.quantity);
        var anySp = false, anySo = false;
        rr.forEach(function (x) {
          if (toNum(x.product_id) !== toNum(it.pid)) anySp = true;
          else if (toNum(x.base_quantity) !== it.expectBase) anySo = true;
        });
        row.result = anySp ? "sai-sp" : anySo ? "sai-so" : "dung";
        if (rr.length > 1) notes.push("có " + rr.length + " lần trong resolved_tags");
        if (row.result === "sai-so") row.msg = "Circa ghi " + row.gotQty + " " + row.gotUnit + " = " + row.gotBase + " gốc, NW " + it.expectBase;
        if (row.result === "sai-sp") row.msg = "Circa ghi vào SP " + row.gotPid + ", NW SP " + it.pid;
      } else if (jj.length) {
        row.result = "tu-choi"; row.rejectCode = jj[0].code == null ? null : String(jj[0].code); row.msg = str(jj[0].message);
      } else if (uu) {
        row.result = "khong-nhan"; row.msg = "Circa trả unknown_tags";
      } else {
        row.result = "mat"; row.msg = "Không có trong response";
      }
      row.confirmed = row.result === "dung" && !dupAny;
      if (row.result === "dung" && dupAny) row.msg = "Response có duplicates: chưa xác nhận, kiểm bằng lượt quét đã lưu (checkScans)";
      var lists = (rr.length ? 1 : 0) + (jj.length ? 1 : 0) + (uu ? 1 : 0);
      if (lists > 1) notes.push("có mặt ở " + lists + " danh sách (resolved " + rr.length + ", rejected " + jj.length + ", unknown " + uu + ")");
      if (jj.length > 1 || uu > 1) notes.push("lặp trong rejected/unknown");
      if (notes.length) { row.note = notes.join("; "); anomalies++; }
      counts[row.result]++;
      return row;
    });
    rows.forEach(function (r) { if (inBatch[codeKey(r.code)] > 1) { r.note = (r.note ? r.note + "; " : "") + "mã lặp trong lô gửi"; r.confirmed = false; anomalies++; } });
    // mã có trong response mà không thuộc lô
    var extra = [];
    function chkExtra(list, name) { Object.keys(list).forEach(function (k) { if (!inBatch[k]) extra.push({ code: k, list: name }); }); }
    chkExtra(R, "resolved_tags"); chkExtra(U, "unknown_tags"); chkExtra(J, "rejected_tags");
    counts.inserted = inserted; counts.duplicates = duplicates; counts.resolved = res.length;
    counts.unknown = unk.length; counts.rejected = rej.length; counts.sent = rows.length;
    counts.countOk = typeof inserted === "number" && typeof duplicates === "number" && inserted + duplicates === res.length;
    if (!counts.countOk) warnings.push("inserted (" + data.inserted + ") + duplicates (" + data.duplicates + ") ≠ số resolved_tags (" + res.length + ")");
    if (dupAny) warnings.push((duplicates == null ? "Không đọc được" : duplicates) + " duplicates: response không cho biết mã nào đã ghi từ trước, số ở resolved_tags có thể không phải số đã lưu → kiểm bằng lượt quét đã lưu" + (opts.resend ? " (gửi lại lô)" : "; không phải gửi lại lô → coi là chưa đạt"));
    if (extra.length) warnings.push(extra.length + " mã trong response không thuộc lô gửi: " + extra.slice(0, 5).map(function (x) { return x.code; }).join(", "));
    if (anomalies) warnings.push(anomalies + " dòng bất thường (xem cột note)");
    if (!rows.length) warnings.push("Lô không có item nào");
    var ok = rows.length > 0 && rows.every(function (r) { return r.result === "dung"; }) && counts.countOk && !extra.length && !anomalies &&
      (!dupAny || !!opts.resend);
    return { ok: ok, needScanCheck: dupAny || !counts.countOk, rows: rows, counts: counts, extra: extra, warnings: warnings };
  }

  // ---------- 6. đối soát theo response ----------
  // allChecks: mảng kết quả checkResponse (hoặc mảng dòng). Cùng mã có nhiều kết quả (gửi lại lô) → giữ theo ưu tiên
  // sai-sp > sai-so > dung (đã xác nhận) > chua-xac-nhan (dung nhưng response có duplicates) > tu-choi > khong-nhan > mat.
  // Gốc "chua-xac-nhan" KHÔNG cộng vào circaBase (để riêng unconfirmedBase) → cần checkScans.
  var RANK = { "sai-sp": 0, "sai-so": 1, "dung": 2, "chua-xac-nhan": 3, "tu-choi": 4, "khong-nhan": 5, "mat": 6 };
  function rStatus(r) { return r.result === "dung" && r.confirmed === false ? "chua-xac-nhan" : r.result; }
  function reconcile(items, allChecks) {
    var best = {}, known = {};
    arr(allChecks).forEach(function (c) {
      var rows = c && Array.isArray(c.rows) ? c.rows : (c && c.code != null ? [c] : []);
      rows.forEach(function (r) {
        var k = codeKey(r.code), b = best[k];
        if (!b || RANK[rStatus(r)] <= RANK[rStatus(b)]) best[k] = r;
      });
    });
    var sp = {}, order = [];
    var sum = { tags: 0, nwBase: 0, sentBase: 0, notSentTags: 0, notSentBase: 0, circaBase: 0, unconfirmedBase: 0, wrongSpBase: 0, diff: 0, diffSent: 0, spDiff: 0, status: {}, problems: 0, extra: [], needScanCheck: false, ok: false };
    arr(items).forEach(function (it) {
      var k = String(it.pid), p = sp[k];
      if (!p) { p = sp[k] = { pid: it.pid, name: it.name, nwUnit: it.nwUnit, tags: 0, nwBase: 0, sentBase: 0, notSentTags: 0, notSentBase: 0, circaBase: 0, unconfirmedBase: 0, diff: 0, diffSent: 0, status: {}, problems: [] }; order.push(k); }
      var sent = isSent(it);
      var r = sent ? best[codeKey(it.code)] : null;
      if (sent) known[codeKey(it.code)] = 1;
      // status: kết quả gửi, "chua-gui" (gửi được mà chưa có kết quả), "khong-gui" (plan giu/khong-nhan/chua-tra)
      var st = !sent ? "khong-gui" : r ? rStatus(r) : "chua-gui";
      var got = r && typeof r.gotBase === "number" ? r.gotBase : 0;
      if (st === "dung" || st === "sai-so") p.circaBase += got;
      if (st === "chua-xac-nhan") { p.unconfirmedBase += got; sum.needScanCheck = true; }
      if (st === "sai-sp") sum.wrongSpBase += got;
      p.tags++; p.nwBase += it.nwQty;
      if (sent) p.sentBase += it.expectBase; else { p.notSentTags++; p.notSentBase += it.nwQty; }
      inc(p.status, st); inc(sum.status, st);
      if (st !== "dung") {
        p.problems.push({
          epc: it.epc, uid: it.uid, code: it.code, mode: it.mode, status: st, nwQty: it.nwQty, expectBase: it.expectBase,
          gotBase: r ? r.gotBase : null, gotUnit: r ? r.gotUnit : null, gotPid: r ? r.gotPid : null,
          reason: !sent ? it.reason : r ? (r.msg || "") + (r.rejectCode ? " [" + r.rejectCode + "]" : "") : "Chưa có kết quả gửi"
        });
      }
    });
    Object.keys(best).forEach(function (k) { if (!known[k]) sum.extra.push(k); });
    var bySp = order.map(function (k) {
      var p = sp[k];
      p.diff = p.nwBase - p.circaBase;
      p.diffSent = p.sentBase - p.circaBase;
      var s = p.status, kl = [], vc = [];
      if (s["sai-so"]) { kl.push("Circa ghi sai số " + s["sai-so"] + " thẻ"); vc.push("Sửa tay trên phiên Circa (API không sửa được)"); }
      if (s["sai-sp"]) { kl.push("Circa ghi " + s["sai-sp"] + " thẻ vào SP khác"); vc.push("Sửa tay trên phiên Circa"); }
      if (s["chua-xac-nhan"]) { kl.push(s["chua-xac-nhan"] + " thẻ chưa xác nhận (response có duplicates)"); vc.push("Đối chiếu lượt quét đã lưu (checkScans)"); }
      if (s["tu-choi"]) { kl.push("Circa từ chối " + s["tu-choi"] + " thẻ"); vc.push("Xem lý do từ chối, xử lý rồi gửi lại"); }
      if (s["khong-nhan"]) { kl.push("Circa không nhận " + s["khong-nhan"] + " thẻ"); vc.push("Kiểm mã trên Circa, đếm tay phần này"); }
      if (s.mat || s["chua-gui"]) { kl.push(((s.mat || 0) + (s["chua-gui"] || 0)) + " thẻ chưa có kết quả"); vc.push("Đối chiếu lượt quét đã lưu rồi mới gửi lại"); }
      if (p.notSentTags) { kl.push("Không gửi " + p.notSentTags + " thẻ = " + p.notSentBase + " gốc (giữ / Circa không nhận / chưa tra)"); vc.push("Kiểm tay phần không gửi"); }
      if (!kl.length) kl.push(p.diff === 0 ? "Khớp: Circa ghi đúng gốc NW" : "Chênh " + p.diff);
      if (!vc.length) vc.push("Không cần làm gì");
      p.ketLuan = kl.join(". "); p.viecCanLam = uniq(vc).join(". ");
      sum.tags += p.tags; sum.nwBase += p.nwBase; sum.sentBase += p.sentBase; sum.notSentTags += p.notSentTags; sum.notSentBase += p.notSentBase;
      sum.circaBase += p.circaBase; sum.unconfirmedBase += p.unconfirmedBase;
      sum.problems += p.problems.length;
      if (p.diff !== 0) sum.spDiff++;
      return p;
    });
    sum.diff = sum.nwBase - sum.circaBase;
    sum.diffSent = sum.sentBase - sum.circaBase;
    sum.ok = sum.diffSent === 0 && sum.extra.length === 0 && !sum.needScanCheck &&
      arr(items).every(function (it) { var r = isSent(it) ? best[codeKey(it.code)] : null; return !isSent(it) || (r && rStatus(r) === "dung"); });
    return { bySp: bySp, sum: sum };
  }

  // ---------- 7. đối chiếu lượt quét đã lưu của phiên (nguồn cuối cùng) ----------
  // scans = mảng lượt quét của GET /v1/inventory/count/sessions/<id>/scans (hoặc {scans:[…]} / {data:{scans:[…]}}),
  //   mỗi lượt {qr_code, product_id, scanned_qty, unit_code (tên đơn vị), conversion_factor, base_qty, device_id, …}.
  // Mỗi item GỬI ĐI (tho / kem-don-vi), khớp theo mã không phân biệt hoa thường:
  //   dung (đúng 1 lượt, product_id đúng, base_qty = expectBase) | sai-so | sai-sp | thieu (không có lượt) | lap (> 1 lượt cùng mã)
  // foreign = lượt không thuộc mã gửi của kế hoạch (nhân viên quét QR, lượt thử cũ, mã khác của cùng thẻ…).
  // bySp: gốc NW, gốc Circa của mã kế hoạch (theo product_id của lượt), gốc lượt ngoài, chênh = NW − Circa(kế hoạch) − lượt ngoài.
  // ok = mọi item gửi đi "dung" VÀ foreign rỗng (foreign → ok false, lý do riêng: nguy cơ đếm đôi EPC/UID/QR).
  function checkScans(items, scans) {
    var list = Array.isArray(scans) ? scans : scans && Array.isArray(scans.scans) ? scans.scans : scans && scans.data && Array.isArray(scans.data.scans) ? scans.data.scans : [];
    items = arr(items);
    var byCode = {};
    list.forEach(function (s) { if (!s) return; var k = codeKey(s.qr_code); (byCode[k] = byCode[k] || []).push(s); });
    var planCode = {}, owner = {};
    items.forEach(function (it) {
      if (isSent(it)) planCode[codeKey(it.code)] = it;
      lookupCodes(it).forEach(function (c) { var k = codeKey(c); if (!owner[k]) owner[k] = it; });
    });
    var sp = {}, order = [];
    function spRow(pid, name) {
      var k = String(pid), p = sp[k];
      if (!p) { p = sp[k] = { pid: pid, name: name || "", tags: 0, nwBase: 0, sentBase: 0, notSentBase: 0, circaBase: 0, foreignBase: 0, foreignScans: 0, diff: 0, status: zeroCounts(SCAN_RESULTS), problems: [] }; order.push(k); }
      else if (!p.name && name) p.name = name;
      return p;
    }
    var counts = zeroCounts(SCAN_RESULTS);
    var rows = [];
    items.forEach(function (it) {
      var p = spRow(it.pid, it.name);
      p.tags++; p.nwBase += it.nwQty;
      if (!isSent(it)) { p.notSentBase += it.nwQty; return; }
      p.sentBase += it.expectBase;
      var ss = byCode[codeKey(it.code)] || [];
      var row = { code: it.code, epc: it.epc, pid: it.pid, mode: it.mode, expectBase: it.expectBase, scans: ss.length, gotPid: null, gotBase: null, gotUnit: null, gotQty: null, gotRate: null, devices: [], result: null, msg: "" };
      if (ss.length) {
        row.gotPid = toNum(ss[0].product_id); row.gotUnit = ss[0].unit_code == null ? null : String(ss[0].unit_code);
        row.gotQty = toNum(ss[0].scanned_qty); row.gotRate = toNum(ss[0].conversion_factor);
        row.gotBase = ss.reduce(function (a, s) { return a + (toNum(s.base_qty) || 0); }, 0);
        row.devices = uniq(ss.map(function (s) { return str(s.device_id); }));
        ss.forEach(function (s) { var q = spRow(toNum(s.product_id), str(s.product_name)); q.circaBase += toNum(s.base_qty) || 0; });
      }
      if (!ss.length) { row.result = "thieu"; row.msg = "Không có lượt quét đã lưu"; }
      else if (ss.length > 1) { row.result = "lap"; row.msg = ss.length + " lượt cùng mã, tổng gốc " + row.gotBase; }
      else if (row.gotPid !== toNum(it.pid)) { row.result = "sai-sp"; row.msg = "Lượt lưu vào SP " + row.gotPid + ", NW SP " + it.pid; }
      else if (row.gotBase !== it.expectBase) { row.result = "sai-so"; row.msg = "Lưu " + row.gotQty + " " + row.gotUnit + " × " + row.gotRate + " = " + row.gotBase + " gốc, NW " + it.expectBase; }
      else row.result = "dung";
      counts[row.result]++; p.status[row.result]++;
      if (row.result !== "dung") p.problems.push(row);
      rows.push(row);
    });
    var foreign = [];
    list.forEach(function (s) {
      if (!s) return;
      var k = codeKey(s.qr_code);
      if (planCode[k]) return;
      var o = owner[k];
      var f = {
        code: str(s.qr_code), product_id: toNum(s.product_id), base_qty: toNum(s.base_qty), scanned_qty: toNum(s.scanned_qty),
        unit_code: s.unit_code == null ? null : String(s.unit_code), conversion_factor: toNum(s.conversion_factor), device_id: str(s.device_id),
        scanned_at: s.scanned_at == null ? null : s.scanned_at, tagEpc: o ? o.epc : null,
        why: o ? (isSent(o) ? "Mã khác của thẻ đã gửi (" + o.code + "): đếm đôi" : "Thẻ không gửi (" + o.mode + ") mà phiên có lượt") : "Ngoài kế hoạch"
      };
      foreign.push(f);
      var q = spRow(f.product_id, str(s.product_name));
      q.foreignBase += f.base_qty || 0; q.foreignScans++;
    });
    var sum = { items: rows.length, counts: counts, foreignScans: foreign.length, foreignBase: 0, nwBase: 0, sentBase: 0, notSentBase: 0, circaBase: 0, diff: 0, spDiff: 0, reasons: [], ok: false };
    var bySp = order.map(function (k) {
      var p = sp[k];
      p.diff = p.nwBase - p.circaBase - p.foreignBase;
      var kl = [], vc = [];
      if (p.status["sai-so"]) { kl.push("Lưu sai số " + p.status["sai-so"] + " thẻ"); vc.push("Sửa tay trên phiên Circa (API không sửa được)"); }
      if (p.status["sai-sp"]) { kl.push("Lưu " + p.status["sai-sp"] + " thẻ vào SP khác"); vc.push("Sửa tay trên phiên Circa"); }
      if (p.status.lap) { kl.push(p.status.lap + " mã có nhiều lượt"); vc.push("Xoá lượt thừa trên phiên Circa"); }
      if (p.foreignScans) { kl.push(p.foreignScans + " lượt ngoài kế hoạch = " + p.foreignBase + " gốc"); vc.push("Kiểm lượt ngoài (nguy cơ đếm đôi EPC/UID/QR)"); }
      if (p.status.thieu) { kl.push(p.status.thieu + " thẻ chưa có lượt"); vc.push("Gửi các thẻ còn thiếu"); }
      if (p.notSentBase) { kl.push("Không gửi " + p.notSentBase + " gốc (giữ / không nhận / chưa tra)"); vc.push("Kiểm tay phần không gửi"); }
      if (!p.tags) kl.push("SP không có trong phiên NW");
      if (!kl.length) kl.push(p.diff === 0 ? "Khớp: phiên Circa = gốc NW" : "Chênh " + p.diff);
      if (!vc.length) vc.push("Không cần làm gì");
      p.ketLuan = kl.join(". "); p.viecCanLam = uniq(vc).join(". ");
      sum.nwBase += p.nwBase; sum.sentBase += p.sentBase; sum.notSentBase += p.notSentBase; sum.circaBase += p.circaBase; sum.foreignBase += p.foreignBase;
      if (p.diff !== 0) sum.spDiff++;
      return p;
    });
    sum.diff = sum.nwBase - sum.circaBase - sum.foreignBase;
    var bad = rows.length - counts.dung;
    if (!rows.length) sum.reasons.push("Kế hoạch không có thẻ gửi");
    if (bad) sum.reasons.push(bad + " thẻ chưa đúng: " + SCAN_RESULTS.filter(function (r) { return r !== "dung" && counts[r]; }).map(function (r) { return r + " " + counts[r]; }).join(", "));
    if (foreign.length) sum.reasons.push("Phiên có " + foreign.length + " lượt ngoài kế hoạch (" + sum.foreignBase + " gốc): nguy cơ đếm đôi EPC/UID/QR");
    sum.ok = rows.length > 0 && bad === 0 && foreign.length === 0;
    return { ok: sum.ok, rows: rows, foreign: foreign, bySp: bySp, sum: sum };
  }

  return {
    BATCH: BATCH, MAX_QTY: MAX_QTY, MODES: MODES, RESULTS: RESULTS, SCAN_RESULTS: SCAN_RESULTS,
    parseSession: parseSession, lookupCodes: lookupCodes, lookupMap: lookupMap, plan: plan, summarize: summarize, predictBase: predictBase,
    batches: batches, bodyCodes: bodyCodes, itemsFor: itemsFor, checkResponse: checkResponse, reconcile: reconcile, checkScans: checkScans,
    _norm: norm, _codeKey: codeKey
  };
});
