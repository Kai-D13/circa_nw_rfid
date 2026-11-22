/* Extension "Kiểm kê Circa ↔ NW": TRANG GỬI KẾT QUẢ (panel.js). Bản rút gọn của tools/nw-sang-circa/app.js:
 * bỏ ô token, bỏ nạp file tay, bỏ tạo phiên Circa; mọi lệnh gọi mạng đổi thành nhắn background (call → bg()). Không fetch ở đây
 * (CSP của trang: connect-src 'none'). Mọi phép tính nghiệp vụ nằm trong core.js (NWC), dùng nguyên, không đổi quy tắc.
 *
 * Luồng (kế hoạch 22/11, luồng B):
 *   1. ?circa=<sessionId> → bản ghi liên kết (background). Kiểm: phiên Circa OPEN + đúng cửa hàng, phiên NW in_progress + đúng kho đã
 *      liên kết + notes chứa sessionId, quyền Circa inventory_count.manage (không đọc được quyền → chỉ ghi chú, không chặn).
 *   2. Tải file xuất NW (export xlsx) → SheetJS → NWC.parseSession; tra qr-lookup từng mã (4 luồng); NWC.plan.
 *   3. Xem trước theo SP. Đọc lượt quét có sẵn của phiên Circa (NWC.checkScans), loại mã đã có (NWC.batches(…, existing)).
 *   4. Xác nhận trong trang → lấy khoá gửi của phiên (background; panel khác đang gửi → từ chối) → gửi tuần tự ≤ 100 mã/lô,
 *      NWC.checkResponse; gửi lại NGUYÊN lô chỉ khi 5xx / timeout / lỗi mạng (tối đa SUBMIT_RETRIES lần); 4xx hoặc lô sai → DỪNG.
 *      Mất liên lạc với background giữa lô (cổng tin đóng, SW chết) → ghi "KHÔNG RÕ đã gửi hay chưa", không gửi lại, vẫn đối chiếu.
 *   5. Đối chiếu bằng sessions/<id>/scans. 6. Tải sổ ghi JSON (không có token: trang không bao giờ thấy token).
 * DOM chỉ dùng textContent. Không alert/confirm của trình duyệt.
 */
(function () {
  "use strict";
  var CFG0 = window.KKCFG, NWC = window.NWC, XLSX = window.XLSX;
  var UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var NEED_COLS = ["Mã SP", "EPC", "UID", "Số lượng thẻ", "ĐVT", "Trạng thái"];
  var CODE_RE = /^[A-Za-z0-9_-]{1,200}$/;
  var VERSION = "kiem-ke-circa-nw-ext panel " + (CFG0 ? CFG0.VERSION : "?");

  // ---------- tiện ích DOM (chỉ textContent) — như app.js ----------
  function $(id) { return document.getElementById(id); }
  function add(e, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(e, x); }); return; }
    if (c instanceof Node) e.appendChild(c); else e.appendChild(document.createTextNode(String(c)));
  }
  function h(tag, props) {
    var e = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === "cls") e.className = v;
      else if (k === "text") e.textContent = String(v);
      else if (k === "on") Object.keys(v).forEach(function (ev) { e.addEventListener(ev, v[ev]); });
      else if (/^on/i.test(k)) throw new Error("không gán thuộc tính sự kiện");
      else e.setAttribute(k, String(v));
    });
    for (var i = 2; i < arguments.length; i++) add(e, arguments[i]);
    return e;
  }
  function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); return e; }
  function put(id) { var e = clear($(id)); for (var i = 1; i < arguments.length; i++) add(e, arguments[i]); return e; }
  function fmt(n) { return typeof n === "number" && isFinite(n) ? n.toLocaleString("vi-VN") : String(n == null ? "" : n); }
  function iso() { return new Date().toISOString(); }
  function when(s) { try { return new Date(s).toLocaleString("vi-VN"); } catch (e) { return String(s); } }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function key(c) { return NWC._codeKey(c); }
  function fold(s) { return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().trim(); }
  function normName(s) { return typeof s === "string" ? s.normalize("NFC").trim().toLowerCase() : ""; }
  function sumOf(a, f) { return a.reduce(function (t, x) { var v = f(x); return t + (typeof v === "number" && isFinite(v) ? v : 0); }, 0); }
  function box(kind, title, items, extra) {
    var b = h("div", { cls: "box " + kind });
    if (title) b.appendChild(h("b", { text: title }));
    if (items && items.length) b.appendChild(h("ul", null, items.map(function (x) { return h("li", null, x); })));
    add(b, extra);
    return b;
  }
  function more(list, max, fn) {
    var out = list.slice(0, max).map(fn);
    if (list.length > max) out.push("… và " + fmt(list.length - max) + " dòng nữa (xem sổ ghi / CSV)");
    return out;
  }
  function metric(label, value, cls, small) {
    return h("div", { cls: "metric" + (cls ? " " + cls : "") }, h("span", { text: label }), h("strong", { text: fmt(value) }), small ? h("small", { text: small }) : null);
  }
  function table(cols, rows, opts) {
    opts = opts || {};
    var lim = opts.limit || 500;
    var tb = h("tbody");
    rows.slice(0, lim).forEach(function (r) {
      var cells = Array.isArray(r) ? r : r.cells;
      tb.appendChild(h("tr", { cls: Array.isArray(r) ? null : r.cls }, cells.map(function (v, i) {
        var c = cols[i] || {};
        return h("td", { cls: c.num ? "num" : c.code ? "code" : null }, c.num && typeof v === "number" ? fmt(v) : typeof v === "number" ? String(v) : v);
      })));
    });
    var wrap = h("div", { cls: "tablewrap" }, h("table", { cls: opts.small ? "small" : null },
      h("thead", null, h("tr", null, cols.map(function (c) { return h("th", { cls: c.num ? "num" : null, text: c.t }); }))), tb));
    if (!rows.length) wrap.appendChild(h("div", { cls: "more", text: opts.empty || "Không có dòng nào." }));
    if (rows.length > lim) wrap.appendChild(h("div", { cls: "more", text: "Hiện " + fmt(lim) + " / " + fmt(rows.length) + " dòng. Dùng ô tìm hoặc tải CSV để xem hết." }));
    return wrap;
  }
  function details(title, build, open) {
    var d = h("details", { cls: "ref" }, h("summary", { text: title }));
    var done = false;
    function fill() { if (!done && d.open) { done = true; add(d, build()); } }
    d.addEventListener("toggle", fill);
    if (open) { d.open = true; fill(); }
    return d;
  }
  function download(name, text, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type }));
    var a = h("a", { download: name });
    a.href = url;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }
  function stamp() {
    var d = new Date(), p = function (v) { return String(v).padStart(2, "0"); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  function safeName(s) { return String(s || "").replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 40) || "x"; }
  function csv(head, rows) {
    function cell(v) {
      if (v == null) return "";
      var s = String(v);
      if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\r\n;]/.test(s) ? "\"" + s.replace(/"/g, "\"\"") + "\"" : s;
    }
    return "﻿" + [head].concat(rows).map(function (r) { return r.map(cell).join(","); }).join("\r\n") + "\r\n";
  }

  // ---------- trạng thái ----------
  var S = {
    id: "", rec: null, cfg: null, chk: null, target: null,
    file: null, fileErr: "", fileWarn: [], overview: null, parsed: null, laReason: {}, codes: [],
    res: {}, lookup: null, P: null, pvFilter: "chu-y", pvQ: "",
    before: null, beforeCheck: null, bodies: null, beforeErr: "", beforeAt: null,
    sendStarted: false, sending: false, sendDone: false, sendStop: "", sendAt: null, sendMsg: null, sendPlan: null, batches: [], rcReady: false,
    rc: null, rcAll: false, rcHistory: [], events: [], busy: "", dirty: false, logAt: null
  };
  function ev(what, info) { S.events.push({ at: iso(), what: what, info: info == null ? undefined : info }); }

  // ---------- nhắn background (thay cho fetch của app.js) ----------
  // → {status, j, badJson, raw, ms, err, msg} (giống call() của app.js; status 0 = không gửi được / lỗi mạng / timeout). Lỗi phía extension:
  //   bg-dead    sendMessage ném lỗi ngay (extension đã tải lại): tin CHƯA rời trang → chắc chắn chưa gửi
  //   bg-refused background trả lời ok:false (từ chối rõ ràng, chưa gọi mạng) → chắc chắn chưa gửi
  //   bg-lost    cổng tin đóng / không có trả lời (service worker chết giữa chừng): KHÔNG RÕ lệnh đã đi chưa
  function bg(op, extra) {
    return new Promise(function (resolve) {
      var msg = Object.assign({ op: op, id: S.id }, extra || {});
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          if (chrome.runtime.lastError) return resolve({ status: 0, err: "bg-lost", msg: chrome.runtime.lastError.message });
          if (!resp) return resolve({ status: 0, err: "bg-lost", msg: "background không trả lời" });
          if (!resp.ok) return resolve({ status: 0, err: "bg-refused", msg: resp.msg || "background từ chối" });
          resolve(resp.r || resp);
        });
      } catch (e) { resolve({ status: 0, err: "bg-dead", msg: String(e && e.message || e) }); }
    });
  }
  function firstErr(r) { return r && r.j && Array.isArray(r.j.errors) && r.j.errors[0] && typeof r.j.errors[0] === "object" ? r.j.errors[0] : null; }
  function errCode(r) { var e = firstErr(r); return e && e.code != null ? String(e.code) : ""; }
  // lệnh CHẮC CHẮN chưa rời máy → không gửi lại, ghi "chưa gửi". bg-lost KHÔNG có ở đây: không rõ đã gửi chưa (cũng không gửi lại).
  var NOSEND = { "no-tab": 1, "no-token": 1, "token-expired": 1, "blocked": 1, "no-store": 1, "bg-refused": 1, "bg-dead": 1 };
  var BG_ERR = { "bg-lost": 1, "bg-refused": 1, "bg-dead": 1 };
  function errInfo(r) {
    if (!r) return "không có phản hồi";
    if (r.status === 0) {
      if (r.err === "timeout") return "quá " + Math.round((S.cfg ? S.cfg.timeout : 30000) / 1000) + " giây không có phản hồi (timeout)";
      if (r.err === "network") return "lỗi mạng hoặc bị chặn (" + (r.msg || "") + ")";
      if (r.err === "no-tab") return "không có tab đã đăng nhập (" + (r.msg || "") + ")";
      if (r.err === "token-expired") return "token đã hết hạn (" + (r.msg || "") + ")";
      return (r.err || "lỗi") + (r.msg ? ": " + r.msg : "");
    }
    var e = firstErr(r), s = "HTTP " + r.status;
    if (e) {
      s += " — " + (e.code != null ? e.code : "") + (e.message ? ": " + e.message : "");
      if (e.trace_id) s += " (trace_id " + e.trace_id + ")";
    } else if (r.j && typeof r.j === "object" && typeof r.j.message === "string") s += " — " + r.j.message.slice(0, 160);
    else if (r.badJson) s += " — phản hồi không phải JSON" + (r.raw ? ": " + String(r.raw).slice(0, 120) : "");
    return s;
  }
  // side: "circa" | "nw"
  function authHint(r, side) {
    if (!r) return "";
    var tok = r.status === 401 || r.err === "no-tab" || r.err === "no-token" || r.err === "token-expired";
    if (tok && side === "nw") return "Token NW hết hạn / chưa đăng nhập: mở hoặc tải lại tab circa.nextwaves.app (đã đăng nhập) rồi bấm lại.";
    if (tok) return "Token Circa hết hạn / chưa đăng nhập: mở hoặc tải lại trang admin.v2.circa.vn (đã đăng nhập) rồi bấm lại.";
    if (r.status === 403) return "Tài khoản " + (side === "nw" ? "NW" : "Circa") + " không có quyền cho thao tác này (HTTP 403).";
    if (r.status === 400 && /AuthzStore/i.test(errCode(r))) return "Circa báo thiếu / sai cửa hàng (400 " + errCode(r) + ").";
    return "";
  }
  function sessOf(r) { var d = r && r.status === 200 && r.j && r.j.data; return d && typeof d === "object" ? (d.session && typeof d.session === "object" ? d.session : d) : null; }
  function recOf(r) { var j = r && r.status === 200 && r.j; if (!j || typeof j !== "object") return null; return j.id != null ? j : j.data && typeof j.data === "object" && j.data.id != null ? j.data : null; }
  async function fetchScans() {
    var lim = S.cfg.scanLimit;
    var r = await bg("scans");
    var d = r.status === 200 && r.j && r.j.data;
    if (!d || !Array.isArray(d.scans)) return { err: "Không đọc được lượt quét của phiên: " + errInfo(r) + (r.status === 200 ? " (thiếu data.scans)" : ""), r: r };
    if (d.has_more === true) return { err: "Phiên có nhiều hơn " + fmt(lim) + " lượt quét (has_more): extension chưa biết cách lấy trang sau — DỪNG, chưa coi là đã đối chiếu.", hasMore: true, r: r };
    if (d.has_more !== false && d.scans.length >= lim) return { err: "Phiên trả " + fmt(d.scans.length) + " lượt (bằng giới hạn) mà không có has_more: có thể còn trang sau — DỪNG.", hasMore: true, r: r };
    return { scans: d.scans };
  }

  // ---------- 1. phiên liên kết ----------
  async function runChecks() {
    S.busy = "check"; $("check-text").textContent = "Đang kiểm…"; refresh();
    var c = { at: iso(), circa: null, nw: null, authz: null, problems: [], notes: [] };
    var rec = S.rec;
    var rs = await bg("circaSession");
    var s = sessOf(rs);
    if (!s) c.problems.push("Không đọc được phiên Circa: " + errInfo(rs) + (authHint(rs, "circa") ? " " + authHint(rs, "circa") : ""));
    else {
      c.circa = { id: String(s.id || ""), code: String(s.code || ""), status: String(s.status || ""), pos_id: String(s.pos_id || ""), counting_mode: String(s.counting_mode || ""), created_at: s.created_at || null };
      if (c.circa.id.toLowerCase() !== S.id) c.problems.push("Circa trả phiên khác id.");
      if (c.circa.status !== "OPEN") c.problems.push("Phiên Circa " + (c.circa.code || S.id) + " đang " + (c.circa.status || "(không rõ)") + ", không phải OPEN: không gửi được.");
      if (c.circa.pos_id.toLowerCase() !== rec.posId) c.problems.push("Phiên Circa thuộc cửa hàng khác với bản ghi liên kết.");
    }
    var rn = await bg("nwRec");
    var n = recOf(rn);
    if (!n) c.problems.push("Không đọc được phiên NW " + rec.nwId + ": " + errInfo(rn) + (authHint(rn, "nw") ? " " + authHint(rn, "nw") : ""));
    else {
      var wh = n.warehouse && typeof n.warehouse === "object" ? n.warehouse : {};
      var whId = n.warehouseId != null ? n.warehouseId : wh.id;
      c.nw = { id: String(n.id), status: String(n.status || ""), notes: n.notes == null ? "" : String(n.notes), warehouseId: whId == null ? "" : String(whId), warehouseName: wh.name == null ? "" : String(wh.name), createdAt: n.createdAt || null, totalEpcsScanned: n.totalEpcsScanned };
      if (n.warehouseId != null && wh.id != null && String(n.warehouseId).toLowerCase() !== String(wh.id).toLowerCase()) c.problems.push("Phiên NW có warehouseId khác warehouse.id: dừng.");
      if (c.nw.id.toLowerCase() !== rec.nwId) c.problems.push("NW trả phiên khác id.");
      if (c.nw.status !== "in_progress") c.problems.push("Phiên NW đang “" + (c.nw.status || "(không rõ)") + "”, không phải in_progress: dừng.");
      if (!c.nw.warehouseId || c.nw.warehouseId.toLowerCase() !== String(rec.warehouseId || "").toLowerCase()) c.problems.push("Phiên NW thuộc kho “" + c.nw.warehouseName + "”, khác kho đã liên kết “" + (rec.warehouseName || "") + "”.");
      if (c.nw.notes.toLowerCase().indexOf(S.id) < 0) c.problems.push("Ghi chú phiên NW không chứa id phiên Circa này.");
      if (normName(c.nw.warehouseName) !== normName(rec.storeName)) c.notes.push("Tên kho NW “" + c.nw.warehouseName + "” khác tên cửa hàng Circa “" + rec.storeName + "”.");
    }
    var ra = await bg("circaAuthz");
    c.authz = { status: ra.status, manage: ra.manage === undefined ? null : ra.manage, view: ra.view === undefined ? null : ra.view };
    if (ra.status !== 200) c.notes.push("Không kiểm được quyền Circa (" + errInfo(ra) + "): không chặn, Circa sẽ tự từ chối nếu thiếu quyền.");
    else if (ra.manage === false) c.problems.push("Tài khoản Circa không có quyền inventory_count.manage: không gửi được.");
    else if (ra.manage !== true) c.notes.push("Không kiểm được quyền (không đọc được danh sách quyền Circa): không chặn.");
    S.chk = c;
    S.target = c.circa;
    S.busy = "";
    $("check-text").textContent = "Kiểm lúc " + when(c.at);
    ev("kiem-lien-ket", { problems: c.problems.length, authz: c.authz });
    renderAll();
  }
  function blockLoad() { return !S.chk || S.chk.problems.some(function (p) { return !/inventory_count\.manage/.test(p); }); }
  function blockSend() { return !S.chk || S.chk.problems.length > 0; }
  function renderS1() {
    var out = clear($("s1-out")), r = S.rec;
    if (!r) return;
    var link = h("a", { target: "_blank", rel: "noopener noreferrer", text: "Mở phiên trên admin" });
    link.href = S.cfg.admin + "/kiem-ke-ton-kho/" + S.id;
    // chỉ link trang chủ NW (đường dẫn trang chi tiết phiên NW chưa kiểm): tìm phiên theo id / ghi chú bên dưới
    var nwl = h("a", { target: "_blank", rel: "noopener noreferrer", id: "nw-link", text: "Mở web NW" });
    nwl.href = S.cfg.nwApp + "/";
    out.appendChild(h("dl", { cls: "kv" }, [
      ["Phiên Circa", (r.code || "") + " · id " + S.id], ["Cửa hàng", (r.storeName || "") + " (pos_id " + r.posId + ")"],
      ["Phiên NW", r.nwId + (r.created ? " (extension tạo)" : " (tìm thấy theo ghi chú)")], ["Ghi chú phiên NW", r.notes || ""], ["Kho NW", (r.warehouseName || "") + " (" + (r.warehouseId || "") + ")"]
    ].map(function (kv) { return [h("dt", { text: kv[0] }), h("dd", { text: kv[1] })]; })));
    out.appendChild(h("div", { cls: "row" }, link, nwl));
    var c = S.chk;
    if (!c) return;
    var okItems = [];
    if (c.circa) okItems.push("Phiên Circa " + c.circa.code + ": " + c.circa.status + " · phương thức " + c.circa.counting_mode);
    if (c.nw) okItems.push("Phiên NW: " + c.nw.status + " · kho " + c.nw.warehouseName + (c.nw.totalEpcsScanned != null ? " · đã quét " + fmt(c.nw.totalEpcsScanned) + " EPC" : ""));
    okItems.push("Quyền Circa inventory_count.manage: " + (c.authz.manage === true ? "có" : c.authz.manage === false ? "KHÔNG" : "không kiểm được"));
    if (c.problems.length) out.appendChild(box("bad", "Chưa dùng được phiên liên kết", c.problems, null));
    out.appendChild(box(c.problems.length ? "info" : "ok", c.problems.length ? "Kết quả kiểm" : "Phiên liên kết đạt", okItems.concat(c.notes)));
  }

  // ---------- 2. lấy file xuất NW + tra mã ----------
  function headerRow(ws) {
    var a = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false, blankrows: false });
    return a.length ? a[0].map(function (x) { return String(x); }) : null;
  }
  function b64ToBytes(b) { var s = atob(b), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  function resetAfterLoad() {
    S.fileErr = ""; S.fileWarn = []; S.parsed = null; S.overview = null; S.codes = []; S.laReason = {}; S.res = {}; S.lookup = null; S.P = null;
    S.before = null; S.beforeCheck = null; S.bodies = null; S.beforeErr = ""; S.beforeAt = null;
  }
  async function onLoad() {
    if (S.busy || S.sendStarted || blockLoad()) return;
    resetAfterLoad();
    S.busy = "export"; $("lk-text").textContent = "Đang tải file xuất phiên NW…"; renderAll();
    var r = await bg("nwExport");
    S.file = { at: iso(), status: r.status, size: r.size || null, type: r.type || null, ms: r.ms || null, sha256: null, nwId: S.rec.nwId };
    if (r.status !== 200 || typeof r.b64 !== "string") {
      S.busy = ""; S.fileErr = "Không tải được file xuất phiên NW: " + errInfo(r) + (authHint(r, "nw") ? " " + authHint(r, "nw") : "");
      ev("tai-file-loi", { status: r.status, err: r.err }); renderAll(); return;
    }
    var bytes = b64ToBytes(r.b64);
    try {
      var dg = await crypto.subtle.digest("SHA-256", bytes);
      S.file.sha256 = Array.prototype.map.call(new Uint8Array(dg), function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    } catch (e) { S.file.sha256 = null; }
    var wb;
    try { wb = XLSX.read(bytes, { type: "array" }); }
    catch (e) { S.busy = ""; S.fileErr = "Không đọc được file .xlsx NW trả về (" + (e && e.message || e) + ")."; renderAll(); return; }
    var miss = ["Chi tiết quét", "Thẻ lạ"].filter(function (n) { return !wb.Sheets[n]; });
    if (miss.length) {
      S.busy = ""; S.fileErr = "File xuất NW thiếu sheet " + miss.map(function (n) { return "“" + n + "”"; }).join(", ") + ". Sheet có trong file: " + (wb.SheetNames.join(", ") || "(không có)") + ".";
      renderAll(); return;
    }
    var hd = headerRow(wb.Sheets["Chi tiết quét"]) || [];
    var have = {}; hd.forEach(function (c) { have[NWC._norm(c)] = 1; });
    var missCol = NEED_COLS.filter(function (c) { return !have[NWC._norm(c)]; });
    var rows = XLSX.utils.sheet_to_json(wb.Sheets["Chi tiết quét"], { defval: "" });
    if (missCol.length && rows.length) {
      S.busy = ""; S.fileErr = "Sheet “Chi tiết quét” thiếu cột " + missCol.map(function (c) { return "“" + c + "”"; }).join(", ") + ". Cột đang có: " + (hd.join(", ") || "(không có dòng tiêu đề)") + ".";
      renderAll(); return;
    }
    var hl = headerRow(wb.Sheets["Thẻ lạ"]);
    if (hl && !hl.some(function (c) { return NWC._norm(c) === NWC._norm("EPC"); })) {
      S.busy = ""; S.fileErr = "Sheet “Thẻ lạ” không có cột “EPC”. Cột đang có: " + hl.join(", ") + ".";
      renderAll(); return;
    }
    var la = XLSX.utils.sheet_to_json(wb.Sheets["Thẻ lạ"], { defval: "" });
    var parsed;
    try { parsed = NWC.parseSession(rows, la); } catch (e) { S.busy = ""; S.fileErr = "Lỗi khi đọc phiên: " + (e && e.message || e); renderAll(); return; }
    la.forEach(function (x) {
      var e = "", why = "";
      Object.keys(x).forEach(function (k) { if (NWC._norm(k) === "epc") e = String(x[k]).trim(); if (NWC._norm(k) === NWC._norm("Lý do")) why = String(x[k]); });
      if (e && !S.laReason[key(e)]) S.laReason[key(e)] = why;
    });
    if (wb.Sheets["Tổng quan"]) {
      var ov = {};
      XLSX.utils.sheet_to_json(wb.Sheets["Tổng quan"], { header: 1, defval: "", raw: false }).forEach(function (x, i) {
        if (i === 0 || !x || !String(x[0]).trim()) return;
        ov[String(x[0]).trim()] = String(x[1] == null ? "" : x[1]).trim();
      });
      S.overview = ov;
      if (ov["Kho"] && normName(ov["Kho"]) !== normName(S.rec.warehouseName)) S.fileWarn.push("Kho trong file là “" + ov["Kho"] + "”, khác kho đã liên kết “" + S.rec.warehouseName + "” (file lấy theo id phiên NW đã kiểm, nên chỉ cảnh báo).");
    } else S.fileWarn.push("File không có sheet “Tổng quan”: không đọc được kho / trạng thái trong file.");
    S.parsed = parsed;
    var seen = {};
    parsed.tags.forEach(function (t) { NWC.lookupCodes(t).forEach(function (c) { var k = key(c); if (!seen[k]) { seen[k] = 1; S.codes.push(c); } }); });
    if (!parsed.tags.length) S.fileErr = rows.length ? "Không có thẻ hợp lệ nào trong sheet “Chi tiết quét” (xem lỗi bên dưới)." : "Phiên NW chưa có thẻ nào đã quét (sheet “Chi tiết quét” trống).";
    ev("tai-file", { size: S.file.size, tags: parsed.tags.length, errors: parsed.errors.length, strange: parsed.strange.length });
    S.busy = "";
    renderAll();
    if (!S.fileErr) await runLookup(false);
  }
  function outcome(e) {
    if (!e) return "todo";
    if (e.status === 200 && e.d) return "ok";
    if (e.status === 404 && e.d === null) return "unk";
    return "err";
  }
  function lkStats() {
    var c = { total: S.codes.length, ok: 0, unk: 0, err: 0, todo: 0 };
    S.codes.forEach(function (code) { c[outcome(S.res[key(code)])]++; });
    return c;
  }
  function resList() { return S.codes.map(function (c) { return S.res[key(c)]; }).filter(Boolean); }
  function fatalOf(r) {
    if (r.status === 401 || r.err === "no-tab" || r.err === "no-token" || r.err === "token-expired") return "token";
    if (r.status === 403) return "quyen";
    if (r.status === 400 && /AuthzStore/i.test(errCode(r))) return "store";
    if (BG_ERR[r.err]) return "bg";
    return "";
  }
  async function lookupOne(code) {
    var e0 = { code: code, at: iso() };
    if (!CODE_RE.test(String(code))) return Object.assign(e0, { status: 0, tries: 0, err: "mã có ký tự không được phép tra (chỉ chữ số, chữ cái, _ và -)" });
    var r, tries = 0;
    for (;;) {
      r = await bg("lookup", { code: code }); tries++;
      if (r.status === 200 || r.status === 404 || fatalOf(r) || r.err === "blocked") break;
      var retry = (r.status === 0 && (r.err === "timeout" || r.err === "network")) || r.status >= 500 || r.status === 429;
      if (!retry || tries > 3 || (S.lookup && S.lookup.abort)) break;
      await sleep(S.cfg.retryBase * Math.pow(2, tries - 1));
    }
    var e = Object.assign(e0, { status: r.status, tries: tries });
    if (r.status === 200) {
      var d = r.j && r.j.success !== false ? r.j.data : null;
      if (d && typeof d === "object" && d.product_id != null) e.d = d;
      else e.err = "HTTP 200 nhưng không có data.product_id";
    } else if (r.status === 404 && r.j && (r.j.success === false || Array.isArray(r.j.errors))) {
      e.d = null;
    } else {
      e.err = errInfo(r); e.fatal = fatalOf(r) || undefined;
      if (r.status === 404) e.err += " (404 không đúng dạng Circa, coi là chưa tra)";
    }
    return e;
  }
  async function runLookup(retryOnly) {
    if (S.busy || S.sendStarted) return;
    if (!retryOnly) S.res = {};
    var list = S.codes.filter(function (c) { var o = outcome(S.res[key(c)]); return !retryOnly || o === "err" || o === "todo"; });
    S.lookup = { start: iso(), abort: "", abortMsg: "", running: true, runs: (S.lookup ? S.lookup.runs : 0) + 1, retryOnly: !!retryOnly, n: list.length };
    S.P = null; S.bodies = null; S.before = null; S.beforeCheck = null; S.beforeErr = ""; S.busy = "lookup";
    ev(retryOnly ? "tra-lai" : "tra-the", { codes: list.length });
    renderAll();
    var prog = $("lk-prog");
    prog.hidden = false; prog.max = list.length || 1; prog.value = 0;
    var i = 0, done = 0;
    async function worker() {
      while (i < list.length && !S.lookup.abort) {
        var c = list[i++];
        var e = await lookupOne(c);
        S.res[key(c)] = e;
        if (e.fatal && !S.lookup.abort) { S.lookup.abort = e.fatal; S.lookup.abortMsg = e.err; }
        done++; prog.value = done; lkText();
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
    S.lookup.running = false; S.lookup.end = iso();
    if (!S.lookup.abort) {
      S.P = NWC.plan(S.parsed, NWC.lookupMap(resList()));
      ev("ke-hoach", { okToSend: S.P.sum.okToSend, modes: S.P.sum.modes });
      if (S.P.sum.okToSend) { S.busy = "before"; renderAll(); await loadBefore(); }
    } else ev("tra-dung", S.lookup.abort);
    S.busy = "";
    renderAll();
  }
  function lkText() {
    if (!S.lookup) { $("lk-text").textContent = S.codes.length ? fmt(S.codes.length) + " mã cần tra" : ""; return; }
    var c = lkStats();
    $("lk-text").textContent = (S.lookup.running ? "Đang tra… " : "") + "Đã tra " + fmt(c.ok + c.unk + c.err) + "/" + fmt(c.total) + " mã · Circa nhận " + fmt(c.ok) + " · không nhận " + fmt(c.unk) + " · lỗi " + fmt(c.err) + (c.todo ? " · chưa tra " + fmt(c.todo) : "");
  }
  function renderS2() {
    var out = clear($("s2-out"));
    $("btn-load").textContent = S.parsed || S.fileErr ? "Lấy lại kết quả từ NW" : "Lấy kết quả từ NW";
    if (S.busy === "export") return;
    if (S.fileErr) out.appendChild(box("bad", "Không dùng được kết quả NW", [S.fileErr]));
    S.fileWarn.forEach(function (w) { out.appendChild(box("warn", w, null)); });
    var p = S.parsed;
    if (p) {
      var base = sumOf(p.tags, function (t) { return t.nwQty; }), sp = {};
      p.tags.forEach(function (t) { sp[t.pid] = 1; });
      out.appendChild(h("div", { cls: "metrics" },
        metric("Thẻ đã quét", p.tags.length), metric("Sản phẩm", Object.keys(sp).length), metric("Tổng gốc NW", base),
        metric("Thẻ lạ", p.strange.length, p.strange.length ? "warn" : "", "không gửi")));
      out.appendChild(h("p", { cls: "note", text: "File " + fmt(Math.max(1, Math.round((S.file.size || 0) / 1024))) + " KB lúc " + when(S.file.at) + " · lỗi " + p.errors.length + " · bỏ qua " + p.skipped.length + " · cảnh báo " + p.warnings.length }));
      if (S.overview) {
        var ks = ["Kho", "Trạng thái", "Phạm vi", "Tạo lúc", "Quét lần cuối", "Xuất lúc", "Đếm bằng RFID", "Thẻ lạ"];
        out.appendChild(h("dl", { cls: "kv" }, ks.filter(function (k) { return S.overview[k] != null; }).map(function (k) { return [h("dt", { text: k }), h("dd", { text: S.overview[k] })]; })));
      }
      if (p.errors.length) out.appendChild(box("bad", p.errors.length + " dòng lỗi (bị bỏ, sẽ chặn gửi)", more(p.errors, 50, function (e) { return e.msg; })));
      if (p.skipped.length) out.appendChild(box("bad", p.skipped.length + " dòng bị bỏ qua (sẽ chặn gửi)", more(p.skipped, 50, function (e) {
        return "Dòng " + e.row + " (" + (e.epc || "không EPC") + "): " + (e.reason === "trang-thai" ? "Trạng thái “" + e.value + "” ≠ “Đã quét”" : e.reason === "trung-epc-giong" ? "trùng y hệt dòng " + e.keptRow : e.reason);
      })));
      if (p.warnings.length) out.appendChild(box("warn", p.warnings.length + " cảnh báo", more(p.warnings, 50, function (e) { return e.msg; })));
    }
    lkText();
    var c = lkStats();
    $("btn-lookup-retry").hidden = !(S.lookup && !S.lookup.running && (c.err || c.todo));
    if (!S.lookup) { $("lk-prog").hidden = true; return; }
    if (S.lookup.abort) {
      var msg = S.lookup.abort === "token" ? "Token Circa hết hạn / chưa đăng nhập: mở hoặc tải lại trang admin.v2.circa.vn (đã đăng nhập) rồi bấm “Tra lại phần chưa tra”."
        : S.lookup.abort === "quyen" ? "Tài khoản Circa không có quyền tra mã (HTTP 403)."
          : S.lookup.abort === "bg" ? "Background của extension không trả lời (extension vừa tải lại?). Tải lại trang này."
            : "Circa báo thiếu / sai cửa hàng (AuthzStoreRequired).";
      out.appendChild(box("bad", "Đã dừng tra thẻ — chưa sang bước sau", [msg, "Chi tiết: " + (S.lookup.abortMsg || "")]));
    } else if (!S.lookup.running && (c.err || c.todo)) {
      var bad = S.codes.filter(function (x) { return outcome(S.res[key(x)]) === "err"; });
      out.appendChild(box("warn", fmt(c.err + c.todo) + " mã chưa tra được (sẽ chặn gửi). Bấm “Tra lại phần chưa tra”.", more(bad, 30, function (x) { return x + ": " + (S.res[key(x)].err || ""); })));
    } else if (!S.lookup.running) {
      out.appendChild(box("ok", "Đã tra xong " + fmt(c.total) + " mã: Circa nhận " + fmt(c.ok) + ", không nhận " + fmt(c.unk) + " (thẻ E280… chỉ tra được bằng UID, EPC ra 404 là bình thường).", null));
    }
  }

  // ---------- 3. xem trước (như renderS4 của app.js) ----------
  function friendly(b) {
    var m;
    if ((m = /^File phiên có (\d+) dòng lỗi/.exec(b))) return "File xuất phiên NW có " + m[1] + " dòng lỗi (xem bước 2). Sửa trên NW rồi bấm “Lấy lại kết quả từ NW”.";
    if ((m = /^File phiên có (\d+) dòng bị bỏ qua/.exec(b))) return "File có " + m[1] + " dòng bị bỏ qua (Trạng thái khác “Đã quét” hoặc trùng EPC) — xem bước 2. Báo lập trình.";
    if ((m = /^(\d+) thẻ chưa tra Circa/.exec(b))) return m[1] + " thẻ chưa tra được trên Circa (lỗi mạng / máy chủ). Bấm “Tra lại phần chưa tra” ở bước 2.";
    if (/mã gửi trùng nhau/.test(b)) return "Có mã gửi trùng nhau giữa các thẻ. Không gửi; báo lập trình.";
    if (/trùng UID\/EPC của thẻ khác/.test(b)) return "Có mã gửi trùng UID/EPC của một thẻ khác. Kiểm thẻ trên NW; báo lập trình.";
    if (/gốc dự tính theo payload/.test(b)) return "Có thẻ mà số gốc Circa sẽ ghi (tính từ payload) khác SL NW. Không gửi; báo lập trình.";
    if (/Không có thẻ nào để gửi/.test(b)) return "Không có thẻ nào gửi được (mọi thẻ đều bị giữ / Circa không nhận).";
    return b;
  }
  var MODE_TXT = { "tho": "thô", "kem-don-vi": "kèm đơn vị", "giu": "giữ", "khong-nhan": "Circa không nhận", "chua-tra": "chưa tra" };
  function modesTxt(m) { return NWC.MODES.filter(function (k) { return m[k]; }).map(function (k) { return MODE_TXT[k] + " " + m[k]; }).join(" · "); }
  function sev(p) { return (p.modes["chua-tra"] || p.modes["khong-nhan"] || p.modes.giu || p.predMismatch) ? 0 : p.modes["kem-don-vi"] ? 1 : 2; }
  function attention(p) { return p.modes.tho !== p.tags || p.predMismatch || p.diff !== 0; }
  function spSorted() { return S.P.bySp.slice().sort(function (a, b) { return sev(a) - sev(b) || String(a.name).localeCompare(String(b.name), "vi") || a.pid - b.pid; }); }
  function renderS3() {
    var out = clear($("s3-out"));
    if (!S.P) return;
    var sum = S.P.sum;
    out.appendChild(h("div", { cls: "metrics five" },
      metric("Gửi thô", sum.modes.tho, "", "mã của thẻ, Circa tự quy đổi"), metric("Gửi kèm đơn vị", sum.modes["kem-don-vi"], "", "lệch quy đổi: gửi SL NW theo đơn vị gốc"),
      metric("Giữ lại", sum.modes.giu, sum.modes.giu ? "warn" : ""), metric("Circa không nhận", sum.modes["khong-nhan"], sum.modes["khong-nhan"] ? "warn" : ""),
      metric("Chưa tra", sum.modes["chua-tra"], sum.modes["chua-tra"] ? "bad" : "")));
    out.appendChild(h("div", { cls: "metrics three" },
      metric("Gốc NW", sum.nwBase), metric("Gốc sẽ gửi", sum.predBase, "", "Circa sẽ ghi, dự tính theo payload"), metric("Gốc không gửi", sum.holdBase, sum.holdBase ? "warn" : "")));
    if (!sum.okToSend) out.appendChild(box("bad", "Chưa gửi được — bước 4 bị khoá", sum.blockers.map(function (b) { return [friendly(b), h("br"), h("small", { text: "(" + b + ")" })]; })));
    else out.appendChild(box("ok", "Kế hoạch đạt: " + fmt(sum.codes) + " thẻ có thể gửi (" + fmt(sum.via.UID) + " thẻ bằng UID, " + fmt(sum.via.EPC) + " bằng EPC).",
      sum.modes.giu || sum.modes["khong-nhan"] ? ["Thẻ giữ lại / Circa không nhận sẽ KHÔNG gửi: kiểm tay phần này (danh sách bên dưới)."] : null));
    var seg = h("div", { cls: "seg" });
    [["chu-y", "Cần chú ý"], ["all", "Tất cả"]].forEach(function (x) {
      var n = x[0] === "all" ? S.P.bySp.length : S.P.bySp.filter(attention).length;
      seg.appendChild(h("button", { cls: S.pvFilter === x[0] ? "on" : null, "data-f": x[0], on: { click: function () { S.pvFilter = x[0]; renderS3(); } } }, x[1] + " (" + n + ")"));
    });
    var q = h("input", { type: "search", id: "pv-q", placeholder: "Tìm mã hoặc tên sản phẩm", value: S.pvQ });
    var holder = h("div", { id: "pv-table" });
    q.addEventListener("input", function () { S.pvQ = q.value; fillSp(holder); });
    out.appendChild(h("h3", { text: "Theo sản phẩm" }));
    out.appendChild(h("div", { cls: "toolbar" }, seg, q));
    out.appendChild(holder);
    fillSp(holder);
    out.appendChild(h("div", { cls: "actions" }, h("button", { id: "btn-pv-csv", on: { click: dlPreviewCsv } }, "Tải CSV xem trước theo SP")));
    var notSent = S.P.items.filter(function (x) { return x.mode !== "tho" && x.mode !== "kem-don-vi"; });
    out.appendChild(details("Thẻ không gửi (" + notSent.length + ")", function () {
      return table([{ t: "EPC", code: 1 }, { t: "UID", code: 1 }, { t: "Mã SP" }, { t: "Tên sản phẩm" }, { t: "SL NW", num: 1 }, { t: "ĐVT" }, { t: "Cách" }, { t: "Lý do" }],
        notSent.map(function (x) { return [x.epc, x.uid, x.pid, x.name, x.nwQty, x.nwUnit, MODE_TXT[x.mode] || x.mode, x.reason]; }), { small: 1, empty: "Không có thẻ nào bị giữ lại." });
    }, notSent.length > 0));
    var st = S.parsed.strange;
    out.appendChild(details("Thẻ lạ trong phiên NW (" + st.length + ", không gửi)", function () {
      return table([{ t: "EPC", code: 1 }, { t: "Lý do (NW)" }], st.map(function (e) { return [e, S.laReason[key(e)] || ""]; }), { small: 1, empty: "Không có thẻ lạ." });
    }));
    out.appendChild(details("Chi tiết từng thẻ (tham chiếu, " + S.P.items.length + ")", function () {
      return table([{ t: "EPC", code: 1 }, { t: "UID", code: 1 }, { t: "Mã gửi", code: 1 }, { t: "Mã SP" }, { t: "Tên sản phẩm" }, { t: "SL NW", num: 1 }, { t: "ĐVT NW" }, { t: "Đơn vị mã Circa" }, { t: "Quy đổi", num: 1 }, { t: "Cách gửi" }, { t: "Lý do" }],
        S.P.items.map(function (x) {
          return [x.epc, x.uid, x.code || "", x.pid, x.name, x.nwQty, x.nwUnit, x.circaUnit || "", x.circaRate == null ? "" : x.circaRate,
            x.mode === "kem-don-vi" ? "kèm " + x.send.quantity + " " + x.send.unit_name : MODE_TXT[x.mode] || x.mode, x.reason];
        }), { small: 1, limit: 3000 });
    }));
    if (S.beforeErr) out.appendChild(box("bad", "Chưa gửi được vào phiên này", [S.beforeErr]));
    else if (S.before) out.appendChild(renderExisting(S.before, S.beforeCheck, S.bodies));
  }
  function fillSp(holder) {
    clear(holder);
    var q = fold(S.pvQ);
    var rows = spSorted().filter(function (p) { return S.pvFilter === "all" || attention(p); }).filter(function (p) { return !q || String(p.pid).indexOf(q) >= 0 || fold(p.name).indexOf(q) >= 0; });
    holder.appendChild(table([{ t: "Mã SP" }, { t: "Tên sản phẩm" }, { t: "Số thẻ", num: 1 }, { t: "Gốc NW", num: 1 }, { t: "Gốc sẽ gửi", num: 1 }, { t: "Cách gửi" }, { t: "Kết luận" }, { t: "Việc cần làm" }],
      rows.map(function (p) { return { cls: sev(p) === 0 ? "flag" : null, cells: [p.pid, p.name, p.tags, p.nwBase, p.predBase, modesTxt(p.modes), p.ketLuan, p.viecCanLam] }; }),
      { empty: S.pvFilter === "chu-y" && !q ? "Không có SP nào cần chú ý: mọi thẻ khớp quy đổi, gửi thô." : "Không có SP khớp ô tìm." }));
  }
  function dlPreviewCsv() {
    var head = ["Mã SP", "Tên sản phẩm", "ĐVT NW", "Số thẻ", "Gốc NW", "Gốc sẽ gửi (dự tính)", "Gốc không gửi", "Chênh", "Thẻ gửi thô", "Thẻ kèm đơn vị",
      "Thẻ giữ", "Thẻ Circa không nhận", "Thẻ chưa tra", "Thẻ gửi qua UID", "Đơn vị mã trên Circa", "Kết luận", "Việc cần làm"];
    var rows = spSorted().map(function (p) {
      return [p.pid, p.name, p.nwUnit, p.tags, p.nwBase, p.predBase, p.holdBase, p.diff, p.modes.tho, p.modes["kem-don-vi"], p.modes.giu, p.modes["khong-nhan"], p.modes["chua-tra"], p.via.UID, p.circaUnits, p.ketLuan, p.viecCanLam];
    });
    download("kiem-ke-circa-nw-xem-truoc-" + safeName(S.rec && S.rec.code) + "-" + stamp() + ".csv", csv(head, rows), "text/csv;charset=utf-8");
  }
  function renderExisting(scans, cs, bodies) {
    if (!scans.length) return box("ok", "Phiên Circa chưa có lượt quét nào (tải lúc " + when(S.beforeAt) + ").", null);
    var c = cs.sum.counts, bad = cs.rows.filter(function (r) { return r.result !== "dung" && r.result !== "thieu"; });
    var ex = bodies && bodies.excluded ? bodies.excluded.length : 0;
    var items = [
      "Mã của kế hoạch đã có, ghi đúng: " + fmt(c.dung),
      "Mã đã ghi SAI số: " + fmt(c["sai-so"]) + " · sai SP: " + fmt(c["sai-sp"]) + " · có nhiều lượt: " + fmt(c.lap),
      "Lượt ngoài kế hoạch (không thuộc thẻ nào trong phiên NW, hoặc mã khác của thẻ): " + fmt(cs.foreign.length) + " lượt = " + fmt(cs.sum.foreignBase) + " gốc",
      fmt(ex) + " mã đã có trong phiên sẽ KHÔNG gửi lại (gửi lại không sửa được số đã ghi)."
    ];
    if (c["sai-so"] || c["sai-sp"] || c.lap) items.push("Số đã ghi sai không sửa được bằng API: sau khi gửi, cho đếm lại các SP đó trên Circa.");
    if (cs.foreign.length) items.push("Lượt ngoài kế hoạch có thể là nhân viên quét QR / lượt thử cũ: nguy cơ đếm đôi. Đối chiếu sẽ báo CHƯA ĐẠT.");
    var b = box(bad.length || cs.foreign.length ? "warn" : "info", "Phiên Circa đã có " + fmt(scans.length) + " lượt quét (gốc " + fmt(sumOf(scans, function (s) { return Number(s.base_qty); })) + "), tải lúc " + when(S.beforeAt), items);
    if (bad.length) b.appendChild(table([{ t: "Mã", code: 1 }, { t: "EPC", code: 1 }, { t: "Mã SP" }, { t: "Kết quả" }, { t: "Chi tiết" }], bad.map(function (r) { return [r.code, r.epc, r.pid, r.result, r.msg]; }), { small: 1, limit: 100 }));
    if (cs.foreign.length) b.appendChild(table([{ t: "Mã quét", code: 1 }, { t: "SP Circa" }, { t: "Gốc", num: 1 }, { t: "Thiết bị" }, { t: "Lý do" }], cs.foreign.map(function (f) { return [f.code, f.product_id, f.base_qty, f.device_id, f.why]; }), { small: 1, limit: 100 }));
    return b;
  }
  async function loadBefore() {
    S.before = null; S.beforeCheck = null; S.bodies = null; S.beforeErr = "";
    var sc = await fetchScans();
    S.beforeAt = iso();
    if (sc.err) { S.beforeErr = sc.err + (authHint(sc.r, "circa") ? " " + authHint(sc.r, "circa") : ""); return false; }
    S.before = sc.scans;
    S.beforeCheck = NWC.checkScans(S.P.items, sc.scans);
    try { S.bodies = NWC.batches(S.P.items, S.id, S.cfg.device, sc.scans); }
    catch (e) { S.bodies = null; S.beforeErr = "Không chia lô được: " + (e && e.message || e); return false; }
    ev("luot-co-san", { scans: sc.scans.length, excluded: S.bodies.excluded.length, batches: S.bodies.length });
    return true;
  }

  // ---------- 4. gửi (như onSend của app.js) ----------
  function bodyStats(bodies) {
    var codes = 0, base = 0;
    bodies.forEach(function (b) { var its = NWC.itemsFor(b, S.P.items); codes += NWC.bodyCodes(b).length; base += sumOf(its, function (x) { return x.expectBase; }); });
    return { codes: codes, base: base };
  }
  function renderS4() {
    var out = clear($("send-sum"));
    if (S.bodies && !S.sendStarted) {
      var bs = bodyStats(S.bodies);
      out.appendChild(box(S.bodies.length ? "info" : "ok", S.bodies.length ? "Sẽ gửi " + fmt(bs.codes) + " thẻ (gốc " + fmt(bs.base) + ") trong " + S.bodies.length + " lô vào phiên " + ((S.target && S.target.code) || S.id) : "Không còn thẻ nào cần gửi: mọi mã của kế hoạch đã có trong phiên.",
        [S.bodies.excluded.length ? "Bỏ qua " + fmt(S.bodies.excluded.length) + " mã đã có trong phiên." : null,
          "Trước khi gửi, trang kiểm lại phiên, tải lại lượt quét và hỏi xác nhận với số mới nhất."].filter(Boolean)));
    }
    if (S.chk && S.chk.authz && S.chk.authz.manage === false) out.appendChild(box("bad", "Tài khoản Circa không có quyền inventory_count.manage: nút gửi bị khoá.", null));
    $("btn-send").textContent = S.bodies && S.bodies.length && !S.sendStarted ? "Gửi " + fmt(bodyStats(S.bodies).codes) + " thẻ…" : "Gửi…";
    var o = clear($("s4-out"));
    if (S.sendMsg) o.appendChild(S.sendMsg);
    if (S.batches.length) {
      o.appendChild(table([{ t: "Lô", num: 1 }, { t: "Số mã", num: 1 }, { t: "Lần gửi", num: 1 }, { t: "HTTP", num: 1 }, { t: "inserted", num: 1 }, { t: "duplicates", num: 1 }, { t: "resolved", num: 1 }, { t: "unknown", num: 1 }, { t: "rejected", num: 1 }, { t: "Kết quả" }],
        S.batches.map(function (b) {
          var c = b.check && b.check.counts;
          var res = b.running ? "đang gửi…" : b.check ? (b.check.ok ? "ĐẠT" : "KHÔNG ĐẠT") : (b.stop || "");
          return { cls: !b.running && (!b.check || !b.check.ok) ? "flag" : null, cells: [b.lo, b.codes, b.attempts.length, b.attempts.length ? b.attempts[b.attempts.length - 1].status : "", c ? c.inserted : "", c ? c.duplicates : "", c ? c.resolved : "", c ? c.unknown : "", c ? c.rejected : "", res] };
        }), { small: 1 }));
      S.batches.forEach(function (b) {
        if (!b.check || b.check.ok) return;
        o.appendChild(box("bad", "Lô " + b.lo + " không đạt — thẻ sai", b.check.warnings, b.check.bad.length ? table([{ t: "Mã gửi", code: 1 }, { t: "EPC", code: 1 }, { t: "Mã SP" }, { t: "Cách" }, { t: "Gốc NW", num: 1 }, { t: "Circa ghi (gốc)", num: 1 }, { t: "Kết quả" }, { t: "Chi tiết" }],
          b.check.bad.map(function (r) { return [r.code, r.epc, r.pid, MODE_TXT[r.mode] || r.mode, r.expectBase, r.gotBase == null ? "" : r.gotBase, r.result, [r.msg, r.note].filter(Boolean).join("; ")]; }), { small: 1 }) : null));
      });
    }
  }
  async function onSend() {
    if (S.sendStarted || S.busy || !S.P || !S.P.sum.okToSend || blockSend()) return;
    S.busy = "presend"; S.sendMsg = h("p", { cls: "note", text: "Kiểm lại phiên và lượt quét trước khi gửi…" }); renderAll();
    var r = await bg("circaSession");
    var s = sessOf(r);
    if (!s || String(s.status) !== "OPEN" || String(s.pos_id).toLowerCase() !== S.rec.posId || String(s.id).toLowerCase() !== S.id) {
      S.busy = "";
      S.sendMsg = box("bad", "Không gửi: phiên Circa không còn sẵn sàng", [s ? "Trạng thái " + s.status + ", pos_id " + s.pos_id : errInfo(r), authHint(r, "circa")].filter(Boolean));
      renderAll(); return;
    }
    var ok0 = await loadBefore();
    S.busy = ""; renderAll();
    if (!ok0) { S.sendMsg = box("bad", "Không gửi", [S.beforeErr]); renderAll(); return; }
    var bodies = S.bodies;
    if (!bodies.length) { S.sendMsg = box("ok", "Không còn thẻ nào cần gửi. Bấm “Đối chiếu lại” ở bước 5.", null); S.rcReady = true; renderAll(); return; }
    var bs = bodyStats(bodies);
    var lines = [
      "Phiên Circa: " + ((S.target && S.target.code) || "(không mã)") + " · cửa hàng " + S.rec.storeName + " · id " + S.id,
      "Nguồn: phiên NW " + S.rec.nwId + " (kho " + S.rec.warehouseName + ")",
      "Gửi " + fmt(bs.codes) + " thẻ (gốc " + fmt(bs.base) + ") trong " + bodies.length + " lô (≤ 100 thẻ/lô), tuần tự.",
      bodies.excluded.length ? "Bỏ qua " + fmt(bodies.excluded.length) + " mã đã có trong phiên (không gửi lại)." : "Phiên chưa có mã nào của kế hoạch.",
      "Đây là thao tác GHI: mỗi thẻ thành một lượt quét trong phiên. Extension không xoá được lượt quét.",
      "Không đóng trang khi đang gửi. Lô nào sai, trang dừng ngay và không gửi lô sau."
    ];
    S.busy = "confirm"; refresh();
    var ok = await confirmBox("Gửi " + fmt(bs.codes) + " thẻ vào phiên " + ((S.target && S.target.code) || S.id) + "?", lines, "Gửi " + fmt(bs.codes) + " thẻ");
    S.busy = ""; refresh();
    if (!ok || S.sendStarted) { S.sendMsg = ok ? S.sendMsg : h("p", { cls: "note", text: "Đã huỷ, chưa gửi gì." }); renderS4(); return; }
    // khoá gửi của phiên (background): mỗi lúc chỉ 1 panel gửi cho 1 phiên
    S.busy = "lock"; refresh();
    var lk = await bg("beginSend");
    S.busy = "";
    if (!lk || lk.ok !== true) {
      ev("khoa-gui-tu-choi", lk && lk.msg);
      S.sendMsg = box("bad", "Không gửi: chưa lấy được khoá gửi của phiên", [(lk && lk.msg) || "background không trả lời", "Chưa gửi gì từ trang này."]);
      renderAll(); return;
    }
    S.sendStarted = true; S.sending = true; S.busy = "send"; S.dirty = true; S.sendAt = iso();
    S.sendPlan = { at: S.sendAt, sessionId: S.id, code: S.target && S.target.code, scansBefore: S.before, excluded: bodies.excluded, bodies: bodies.slice() };
    ev("gui-bat-dau", { batches: bodies.length, codes: bs.codes });
    var prog = $("send-prog"); prog.hidden = false; prog.max = bodies.length; prog.value = 0;
    S.sendMsg = null; renderAll();
    var maxTries = 1 + S.cfg.retries;
    for (var i = 0; i < bodies.length; i++) {
      var body = bodies[i], bi = NWC.itemsFor(body, S.P.items);
      var entry = { lo: i + 1, codes: NWC.bodyCodes(body).length, body: body, attempts: [], running: true };
      S.batches.push(entry);
      var resp, tries = 0, resend = false;
      for (;;) {
        $("send-text").textContent = "Lô " + (i + 1) + "/" + bodies.length + ": gửi lần " + (tries + 1) + "…";
        renderS4();
        var at = iso();
        resp = await bg("submit", { body: body });
        tries++;
        entry.attempts.push({ at: at, status: resp.status, ms: resp.ms, err: resp.err, msg: resp.msg, response: resp.j != null ? resp.j : resp.raw != null ? { raw: resp.raw } : null });
        // KHÔNG gửi lại: 200, 4xx, lệnh chắc chắn chưa rời máy (không token / bị chặn / background từ chối),
        // hoặc mất liên lạc với background giữa lúc gửi (bg-lost: không rõ đã gửi chưa)
        if (resp.status === 200 || (resp.status >= 400 && resp.status < 500) || (resp.status === 0 && (NOSEND[resp.err] || resp.err === "bg-lost")) || tries >= maxTries) break;
        resend = true;
        var wait = S.cfg.retryBase * (1 << (tries - 1));
        $("send-text").textContent = "Lô " + (i + 1) + ": " + errInfo(resp) + " — gửi lại nguyên lô sau " + wait + " ms";
        await sleep(wait);
      }
      entry.running = false; entry.tries = tries; entry.resend = resend;
      var chk = resp.status === 200 && resp.j && resp.j.success !== false && resp.j.data && typeof resp.j.data === "object" ? NWC.checkResponse(bi, resp.j.data, { resend: resend }) : null;
      if (chk) entry.check = { ok: chk.ok, needScanCheck: chk.needScanCheck, counts: chk.counts, warnings: chk.warnings, extra: chk.extra, bad: chk.rows.filter(function (x) { return x.result !== "dung" || x.note; }) };
      prog.value = i + 1;
      if (!chk) {
        var notSent = resp.status === 0 && NOSEND[resp.err], lost = resp.status === 0 && resp.err === "bg-lost";
        var tokErr = resp.err === "no-tab" || resp.err === "no-token" || resp.err === "token-expired";
        entry.stop = resp.status === 401 || tokErr ? "token" : lost ? "không rõ" : resp.status === 400 && /FAILED_PRECONDITION/i.test(errCode(resp)) ? "phiên không mở" : "lỗi " + (resp.status || resp.err);
        S.sendStop = "Lô " + (i + 1) + ": " + (resp.status === 401 ? "token Circa hết hạn hoặc sai (HTTP 401) — lô này không được ghi."
          : lost ? "KHÔNG RÕ Circa đã ghi lô này chưa: mất liên lạc với background của extension giữa lúc gửi (" + (resp.msg || "bg-lost") + "). Không gửi lại; xem đối chiếu ở bước 5."
          : notSent ? "chưa gửi (" + errInfo(resp) + ")."
            : resp.status === 400 && /FAILED_PRECONDITION/i.test(errCode(resp)) ? "phiên không còn mở (400 FAILED_PRECONDITION)."
              : resp.status >= 400 && resp.status < 500 ? "Circa từ chối (" + errInfo(resp) + ")."
                : resp.status === 200 ? "HTTP 200 nhưng không đọc được response — không biết Circa đã ghi gì."
                  : "không gửi được sau " + tries + " lần (" + errInfo(resp) + ") — KHÔNG rõ Circa đã ghi lô này chưa.");
        var hint = authHint(resp, "circa");
        if (hint) S.sendStop += " " + hint;
      } else if (!chk.ok) {
        entry.stop = "lô không đạt";
        S.sendStop = "Lô " + (i + 1) + " không đạt: " + chk.rows.filter(function (x) { return x.result !== "dung"; }).length + " thẻ sai / chưa xác nhận" + (chk.warnings.length ? " (" + chk.warnings.join("; ") + ")" : "") + ".";
      }
      ev("gui-lo", { lo: i + 1, tries: tries, status: resp.status, ok: !!(chk && chk.ok) });
      renderS4();
      if (!chk || !chk.ok) break;
    }
    var ul = await bg("endSend");
    ev("khoa-gui-tra", { ok: !!(ul && ul.ok === true), err: ul && ul.err });
    S.sending = false; S.sendDone = true; S.busy = "";
    $("send-text").textContent = S.sendStop ? "ĐÃ DỪNG GỬI" : "Đã gửi xong " + bodies.length + " lô";
    S.sendMsg = S.sendStop ? box("bad", "ĐÃ DỪNG GỬI — không gửi các lô sau", [S.sendStop, "Đối chiếu ở bước 5 chạy ngay để biết Circa đã lưu những gì.",
      "Không tự gửi lại. Muốn gửi tiếp phần còn thiếu: xử lý nguyên nhân, tải lại trang này và bấm “Lấy kết quả từ NW” (mã đã có tự bỏ qua)."])
      : box("ok", "Đã gửi xong " + bodies.length + " lô, mọi lô đạt theo response. Kết quả cuối cùng là đối chiếu ở bước 5.", null);
    ev(S.sendStop ? "gui-dung" : "gui-xong", S.sendStop || null);
    renderAll();
    await reconcile();
  }

  // ---------- 5. đối chiếu (như app.js) ----------
  async function reconcile() {
    if (!S.P) return;
    S.busy = "rc"; $("rc-text").textContent = "Đang tải lượt quét của phiên…"; refresh();
    var at = iso();
    var sc = await fetchScans();
    S.busy = "";
    if (sc.err) S.rc = { at: at, err: sc.err + (authHint(sc.r, "circa") ? " " + authHint(sc.r, "circa") : ""), hasMore: !!sc.hasMore };
    else {
      var cs = NWC.checkScans(S.P.items, sc.scans);
      var all = sumOf(sc.scans, function (s) { return Number(s.base_qty); });
      S.rc = { at: at, scans: sc.scans, cs: cs, all: all, ok: cs.ok && all === cs.sum.nwBase && cs.foreign.length === 0 };
    }
    S.rcHistory.push({ at: at, ok: S.rc.ok === true, err: S.rc.err, counts: S.rc.cs ? S.rc.cs.sum.counts : null, foreign: S.rc.cs ? S.rc.cs.foreign.length : null, all: S.rc.all });
    if (S.sendStarted) S.dirty = true;
    ev("doi-chieu", { ok: S.rc.ok === true, err: S.rc.err });
    $("rc-text").textContent = "Đối chiếu lúc " + when(at);
    renderAll();
  }
  function renderS5() {
    var out = clear($("s5-out"));
    var rc = S.rc;
    if (!rc) return;
    if (rc.err) { out.appendChild(h("div", { cls: "big bad", id: "rc-big" }, "CHƯA ĐỐI CHIẾU ĐƯỢC", h("small", { text: rc.err }))); return; }
    var cs = rc.cs, c = cs.sum.counts, sent = cs.rows.length;
    var line = fmt(c.dung) + "/" + fmt(sent) + " thẻ đúng · gốc NW " + fmt(cs.sum.nwBase) + (rc.all === cs.sum.nwBase ? " = " : " ≠ ") + "gốc Circa " + fmt(rc.all) + " · " + fmt(cs.foreign.length) + " lượt ngoài kế hoạch";
    out.appendChild(h("div", { cls: "big " + (rc.ok ? "ok" : "bad"), id: "rc-big" }, rc.ok ? "ĐẠT" : "CHƯA ĐẠT", h("small", { text: line })));
    out.appendChild(h("div", { cls: "metrics five" },
      metric("Đúng", c.dung, "ok"), metric("Sai số", c["sai-so"], c["sai-so"] ? "bad" : ""), metric("Sai SP", c["sai-sp"], c["sai-sp"] ? "bad" : ""),
      metric("Thiếu (chưa có lượt)", c.thieu, c.thieu ? "bad" : ""), metric("Lặp", c.lap, c.lap ? "bad" : "")));
    out.appendChild(h("div", { cls: "metrics three" },
      metric("Lượt ngoài kế hoạch", cs.foreign.length, cs.foreign.length ? "bad" : "", fmt(cs.sum.foreignBase) + " gốc"),
      metric("Gốc Circa đã lưu", rc.all, rc.all === cs.sum.nwBase ? "ok" : "bad", fmt(rc.scans.length) + " lượt quét"),
      metric("Gốc NW", cs.sum.nwBase, "", cs.sum.notSentBase ? fmt(cs.sum.notSentBase) + " gốc không gửi" : "mọi thẻ đều gửi")));
    var reasons = cs.sum.reasons.slice();
    if (cs.sum.notSentBase) reasons.push(fmt(cs.sum.notSentBase) + " gốc của thẻ không gửi (giữ / Circa không nhận): phiên Circa thiếu phần này, kiểm tay.");
    if (!rc.ok && rc.all !== cs.sum.nwBase) reasons.push("Gốc Circa đã lưu (" + fmt(rc.all) + ") khác gốc NW (" + fmt(cs.sum.nwBase) + "), chênh " + fmt(cs.sum.nwBase - rc.all) + ".");
    out.appendChild(box(rc.ok ? "ok" : "warn", "Lưu ý", (rc.ok ? [] : reasons).concat([
      "Phiên Circa và phiên NW vẫn MỞ. Extension không đóng, không duyệt, không huỷ phiên.",
      "Số ghi sai KHÔNG sửa được bằng API: cho đếm lại SP đó trên Circa.", "Tải sổ ghi ở bước 6 trước khi đóng trang."])));
    var spAll = cs.bySp, spBad = spAll.filter(function (p) { return p.diff !== 0 || p.problems.length || p.foreignScans || p.notSentBase; });
    var seg = h("div", { cls: "seg" });
    [[false, "SP có chênh / vấn đề (" + spBad.length + ")"], [true, "Tất cả SP (" + spAll.length + ")"]].forEach(function (x) {
      seg.appendChild(h("button", { cls: S.rcAll === x[0] ? "on" : null, on: { click: function () { S.rcAll = x[0]; renderS5(); } } }, x[1]));
    });
    out.appendChild(h("h3", { text: "Theo sản phẩm" }));
    out.appendChild(h("div", { cls: "toolbar" }, seg));
    out.appendChild(table([{ t: "Mã SP" }, { t: "Tên sản phẩm" }, { t: "Số thẻ", num: 1 }, { t: "Gốc NW", num: 1 }, { t: "Gốc Circa", num: 1 }, { t: "Lượt ngoài (gốc)", num: 1 }, { t: "Chênh", num: 1 }, { t: "Kết luận" }, { t: "Việc cần làm" }],
      (S.rcAll ? spAll : spBad).map(function (p) { return { cls: p.diff !== 0 || p.problems.length ? "flag" : null, cells: [p.pid, p.name, p.tags, p.nwBase, p.circaBase, p.foreignBase, p.diff, p.ketLuan, p.viecCanLam] }; }),
      { empty: "Không có SP nào chênh: mọi SP khớp gốc NW." }));
    [["sai-so", "Thẻ sai số"], ["sai-sp", "Thẻ sai SP"], ["thieu", "Thẻ thiếu (chưa có lượt quét)"], ["lap", "Mã có nhiều lượt"]].forEach(function (g) {
      var rows = cs.rows.filter(function (r) { return r.result === g[0]; });
      if (!rows.length) return;
      out.appendChild(details(g[1] + " (" + rows.length + ")", function () {
        return table([{ t: "Mã gửi", code: 1 }, { t: "EPC", code: 1 }, { t: "Mã SP" }, { t: "Cách" }, { t: "Gốc NW", num: 1 }, { t: "Gốc Circa", num: 1 }, { t: "Lượt", num: 1 }, { t: "Chi tiết" }],
          rows.map(function (r) { return [r.code, r.epc, r.pid, MODE_TXT[r.mode] || r.mode, r.expectBase, r.gotBase == null ? "" : r.gotBase, r.scans, r.msg]; }), { small: 1, limit: 2000 });
      }, g[0] !== "thieu" || rows.length <= 50));
    });
    if (cs.foreign.length) out.appendChild(details("Lượt ngoài kế hoạch (" + cs.foreign.length + ")", function () {
      return table([{ t: "Mã quét", code: 1 }, { t: "SP Circa" }, { t: "Gốc", num: 1 }, { t: "SL × đơn vị" }, { t: "Thiết bị" }, { t: "Lúc" }, { t: "Lý do" }],
        cs.foreign.map(function (f) { return [f.code, f.product_id, f.base_qty, f.scanned_qty + " " + (f.unit_code || ""), f.device_id, f.scanned_at ? when(f.scanned_at) : "", f.why]; }), { small: 1, limit: 2000 });
    }, true));
  }
  function dlRcCsv() {
    if (!S.rc || !S.rc.cs) return;
    var head = ["Mã SP", "Tên sản phẩm", "Số thẻ NW", "Gốc NW", "Gốc đã gửi", "Gốc không gửi", "Gốc Circa (mã kế hoạch)", "Gốc lượt ngoài kế hoạch", "Lượt ngoài", "Chênh", "Đúng", "Sai số", "Sai SP", "Thiếu", "Lặp", "Kết luận", "Việc cần làm"];
    var rows = S.rc.cs.bySp.map(function (p) {
      return [p.pid, p.name, p.tags, p.nwBase, p.sentBase, p.notSentBase, p.circaBase, p.foreignBase, p.foreignScans, p.diff, p.status.dung, p.status["sai-so"], p.status["sai-sp"], p.status.thieu, p.status.lap, p.ketLuan, p.viecCanLam];
    });
    download("kiem-ke-circa-nw-doi-chieu-" + safeName(S.rec && S.rec.code) + "-" + stamp() + ".csv", csv(head, rows), "text/csv;charset=utf-8");
  }

  // ---------- 6. sổ ghi (không có token: trang không bao giờ có token) ----------
  function buildLog() {
    var p = S.parsed, P = S.P, rc = S.rc;
    return {
      congCu: VERSION, taoLuc: iso(), cheDo: S.cfg && S.cfg.test ? "THỬ — máy chủ giả" : "THẬT",
      ghiChu: "Sổ ghi do extension tạo. Không chứa token. Phiên Circa và phiên NW để MỞ.",
      lienKet: S.rec, kiemLienKet: S.chk,
      fileNW: S.file ? { at: S.file.at, size: S.file.size, type: S.file.type, sha256: S.file.sha256, nwId: S.file.nwId, loi: S.fileErr || null, canhBao: S.fileWarn, tongQuan: S.overview,
        doc: p ? { tags: p.tags.length, nwBase: sumOf(p.tags, function (t) { return t.nwQty; }), strange: p.strange, errors: p.errors, skipped: p.skipped, warnings: p.warnings } : null } : null,
      traCuu: S.lookup ? { batDau: S.lookup.start, ketThuc: S.lookup.end || null, lanChay: S.lookup.runs, dung: S.lookup.abort || null, thongKe: lkStats(), res: resList() } : null,
      keHoach: P ? { sum: P.sum, bySp: P.bySp, items: P.items } : null,
      phien: S.target,
      guiLo: S.sendPlan ? { batDau: S.sendPlan.at, sessionId: S.sendPlan.sessionId, code: S.sendPlan.code, luotCoSan: S.sendPlan.scansBefore, maBoQua: S.sendPlan.excluded, dung: S.sendStop || null } : null,
      lo: S.batches.map(function (b) { return { lo: b.lo, soMa: b.codes, body: b.body, lanGui: b.attempts, resend: !!b.resend, kiem: b.check || null, dung: b.stop || null }; }),
      doiChieu: rc ? (rc.err ? { at: rc.at, loi: rc.err } : { at: rc.at, ok: rc.ok, gocCircaMoiLuot: rc.all, sum: rc.cs.sum, foreign: rc.cs.foreign, theSai: rc.cs.rows.filter(function (r) { return r.result !== "dung"; }), bySp: rc.cs.bySp }) : null,
      lichSuDoiChieu: S.rcHistory, luotQuetSauGui: rc && rc.scans ? rc.scans : null, suKien: S.events
    };
  }
  function dlLog() {
    var name = "kiem-ke-circa-nw-" + safeName(S.rec ? S.rec.code || S.id.slice(0, 8) : "x") + "-" + stamp() + ".json";
    download(name, JSON.stringify(buildLog(), null, 1), "application/json");
    S.logAt = iso();
    if (!S.sending) S.dirty = false;
    ev("tai-so-ghi", name);
    $("log-text").textContent = "Đã tải " + name + " lúc " + when(S.logAt);
    refresh();
  }

  // ---------- hộp xác nhận trong trang ----------
  function confirmBox(title, lines, okText) {
    return new Promise(function (resolve) {
      var m = $("modal");
      $("modal-title").textContent = title;
      put("modal-body", h("ul", null, lines.map(function (l) { return h("li", null, l); })));
      $("modal-ok").textContent = okText || "Đồng ý";
      m.hidden = false;
      $("modal-cancel").focus();
      function done(v) {
        m.hidden = true;
        $("modal-ok").removeEventListener("click", yes); $("modal-cancel").removeEventListener("click", no);
        document.removeEventListener("keydown", esc, true);
        resolve(v);
      }
      function yes(e) { if (e && e.isTrusted === false) return; done(true); }
      function no() { done(false); }
      function esc(e) { if (e.key === "Escape") { e.preventDefault(); done(false); } }
      $("modal-ok").addEventListener("click", yes); $("modal-cancel").addEventListener("click", no);
      document.addEventListener("keydown", esc, true);
    });
  }

  // ---------- khoá / mở ----------
  function setStep(id, open, done) {
    var c = $(id);
    c.classList.toggle("locked", !open);
    c.classList.toggle("done", !!done);
    var l = $(id + "-lock");
    if (l) l.hidden = open;
  }
  function refresh() {
    var busy = !!S.busy, linked = !!S.rec && S.rec.state === "linked";
    var s2 = linked && !blockLoad(), s3 = !!S.P, s4 = s3 && S.P.sum.okToSend && !!S.bodies && !S.beforeErr && !blockSend(), s5 = S.sendDone || !!S.rc || S.rcReady || (!!S.bodies && S.bodies.length === 0);
    setStep("s1", linked, linked && S.chk && !S.chk.problems.length);
    setStep("s2", s2, !!S.P);
    setStep("s3", s3, s4);
    setStep("s4", s4 || S.sendStarted, S.sendDone && !S.sendStop);
    setStep("s5", s5 && !!S.P, S.rc && S.rc.ok);
    setStep("s6", true, !!S.logAt && !S.dirty);
    $("btn-check").disabled = busy || S.sending || !linked;
    $("btn-load").disabled = !s2 || busy || S.sendStarted;
    $("btn-lookup-retry").disabled = !s2 || busy || S.sendStarted;
    $("btn-send").disabled = !s4 || busy || S.sendStarted || !S.bodies || !S.bodies.length;
    $("btn-recheck").disabled = !(s5 && S.P) || busy;
    $("btn-log").disabled = !S.rec;
    $("btn-rc-csv").disabled = !(S.rc && S.rc.cs) || busy;
    var pv = $("btn-pv-csv");
    if (pv) pv.disabled = !S.P;
    if (S.sending) document.querySelectorAll("main button, main input").forEach(function (e) { e.disabled = true; });
    if (S.dirty && !S.sending) $("log-text").textContent = "Chưa tải sổ ghi cho lần ghi gần nhất — tải trước khi đóng trang.";
  }
  function renderAll() { renderS1(); renderS2(); renderS3(); renderS4(); renderS5(); refresh(); }

  // ---------- khởi động ----------
  async function init() {
    if (!NWC || !XLSX || !CFG0 || !window.chrome || !chrome.runtime) { put("fatal", "Thiếu thư viện (NWC / XLSX / cấu hình). Bản extension bị hỏng: build lại."); $("fatal").hidden = false; return; }
    var q = new URLSearchParams(location.search), id = String(q.get("circa") || "").toLowerCase();
    if (!UUID_ONLY.test(id)) { put("fatal", "Thiếu hoặc sai id phiên Circa trong địa chỉ trang (?circa=<id>). Mở trang này từ nút trên trang admin Circa."); $("fatal").hidden = false; return; }
    S.id = id;
    $("btn-check").addEventListener("click", runChecks);
    $("btn-load").addEventListener("click", onLoad);
    $("btn-lookup-retry").addEventListener("click", function () { runLookup(true); });
    $("btn-send").addEventListener("click", onSend);
    $("btn-recheck").addEventListener("click", reconcile);
    $("btn-log").addEventListener("click", dlLog);
    $("btn-rc-csv").addEventListener("click", dlRcCsv);
    window.addEventListener("beforeunload", function (e) { if (S.sending || S.dirty) { e.preventDefault(); e.returnValue = ""; return ""; } });
    var r = await new Promise(function (res) {
      chrome.runtime.sendMessage({ op: "init", id: id }, function (x) { res(chrome.runtime.lastError ? { ok: false, msg: chrome.runtime.lastError.message } : x); });
    });
    if (!r || !r.ok) { put("fatal", "Không đọc được bản ghi liên kết: " + ((r && r.msg) || "background không trả lời")); $("fatal").hidden = false; return; }
    S.cfg = r.cfg; S.rec = r.v;
    /*TEST-BEGIN*/
    if (S.cfg.test) {
      $("testbar").hidden = false;
      put("testbar", "CHẾ ĐỘ THỬ — máy chủ giả trên máy cục bộ", h("small", { text: "Bản thử của extension: không gửi gì lên Circa / NW thật." }));
      document.title = "[THỬ] " + document.title;
      window.__KK_PANEL__ = {
        summary: function () {
          return {
            busy: S.busy, sending: S.sending, sendStarted: S.sendStarted, sendDone: S.sendDone, sendStop: S.sendStop, fileErr: S.fileErr,
            sendMsgText: S.sendMsg ? S.sendMsg.textContent : "", events: S.events.map(function (e) { return e.what; }),
            chk: S.chk ? { problems: S.chk.problems, notes: S.chk.notes, authz: S.chk.authz } : null,
            lookup: S.lookup ? { abort: S.lookup.abort, stats: lkStats() } : null,
            plan: S.P ? { okToSend: S.P.sum.okToSend, modes: S.P.sum.modes, blockers: S.P.sum.blockers, nwBase: S.P.sum.nwBase, batches: S.P.sum.batches } : null,
            parse: S.parsed ? { tags: S.parsed.tags.length, errors: S.parsed.errors.length, strange: S.parsed.strange.length } : null,
            bodies: S.bodies ? { n: S.bodies.length, excluded: S.bodies.excluded.length } : null, beforeErr: S.beforeErr,
            batches: S.batches.map(function (b) { return { lo: b.lo, codes: b.codes, tries: b.attempts.length, ok: !!(b.check && b.check.ok), stop: b.stop || null }; }),
            rc: S.rc ? (S.rc.err ? { err: S.rc.err } : { ok: S.rc.ok, counts: S.rc.cs.sum.counts, foreign: S.rc.cs.foreign.length, all: S.rc.all, nwBase: S.rc.cs.sum.nwBase, scans: S.rc.scans.length }) : null,
            dirty: S.dirty, sendDisabled: $("btn-send").disabled, loadDisabled: $("btn-load").disabled
          };
        }
      };
    }
    /*TEST-END*/
    if (S.rec && S.rec.state === "nw-closed") {
      put("fatal", "Phiên NW liên kết " + (S.rec.nwId || "") + " " + ({ cancelled: "đã huỷ", completed: "đã hoàn tất", approved: "đã duyệt" }[S.rec.nwStatus] || "đã đóng") +
        " (status " + (S.rec.nwStatus || "?") + "): không gửi kết quả vào phiên Circa. Extension không tạo phiên NW khác; báo PM nếu cần.");
      $("fatal").hidden = false; renderAll(); return;
    }
    if (!S.rec || S.rec.state !== "linked") {
      put("fatal", "Phiên Circa " + id + " chưa liên kết phiên NW (trạng thái: " + (S.rec ? S.rec.state : "chưa có bản ghi") + "). Quay lại trang admin Circa để tạo / liên kết phiên NW.");
      $("fatal").hidden = false; renderAll(); return;
    }
    document.title = (S.cfg.test ? "[THỬ] " : "") + "Gửi kết quả NW → " + (S.rec.code || id);
    ev("mo-panel", { id: id, nwId: S.rec.nwId });
    renderAll();
    await runChecks();
  }
  init();
})();
