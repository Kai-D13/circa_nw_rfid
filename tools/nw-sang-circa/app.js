/* NW kiểm kê → Circa kiểm kê: TRANG VẬN HÀNH (app.js). Được build.js ghép vào build/nw-sang-circa.html cùng SheetJS + core.js.
 *
 * GHI LÊN CIRCA ở đúng 2 chỗ, mỗi chỗ có hộp xác nhận trong trang (không dùng confirm/alert của trình duyệt):
 *   - tạo phiên: POST /v1/inventory/count/sessions          1 lần. KHÔNG BAO GIỜ tự gửi lại (gửi lại = 2 phiên).
 *   - gửi thẻ:   POST /v1/inventory/count/submit-rfid-batch  tuần tự, ≤ 100 mã/lô. 5xx/timeout/lỗi mạng: gửi lại NGUYÊN lô
 *                sau 1s, 2s, 4s (tối đa 3 lần) và kiểm bằng checkResponse(…, {resend:true}). 4xx hoặc lô sai: DỪNG.
 * Còn lại CHỈ ĐỌC: qr-lookup, sessions/<id>, session/current, sessions/<id>/scans, admin/inventory/location.
 * Luồng giống tools/nw-sang-circa/gui.js (đã chạy thật 21/11/2026). Mọi phép tính nằm trong core.js (NWC); file này chỉ gọi API
 * và hiển thị. Không đổi quy tắc nghiệp vụ ở đây.
 *
 * Token: chỉ đọc từ ô nhập lúc gọi API. Không lưu localStorage/sessionStorage, không đưa vào URL, sổ ghi, console.
 * Dữ liệu từ file và API là không tin cậy: chèn DOM bằng textContent, không dùng innerHTML.
 * Chế độ thử: ?api=http://127.0.0.1:<port> hoặc http://localhost:<port> (giá trị khác bị từ chối, trang khoá).
 *   Chỉ trong chế độ thử mới nhận thêm &timeout=<ms> (timeout fetch), &poll=<ms> (thời hạn chờ OPEN), &every=<ms> (nhịp hỏi).
 */
(function () {
  "use strict";
  var VERSION = "nw-sang-circa trang 1.0 (21/11/2026)";
  var REAL_API = "https://api.v2.circa.vn";
  var ADMIN = "https://admin.v2.circa.vn/kiem-ke-ton-kho/";
  var DEVICE = "NW-RFID";
  var SCAN_LIMIT = 5000;
  var STORES = {
    lumina: { key: "lumina", name: "Lumina", pos: "31493e74-3404-4c0e-a906-93691a6ee319", loc: "0357db7a-f9be-4a9a-a70d-d70df7936503", locName: "General" },
    florita: { key: "florita", name: "Florita", pos: "c476efb2-415c-429a-978e-d389b4b06607", loc: null, locName: "" }
  };
  var CREATE_KEYS = ["pos_id", "scheduled_date", "counting_mode", "sync_baseline", "designated_main_location_id", "cleanup_missing",
    "auto_approve_tolerance_pct", "auto_approve_tolerance_value", "force_manual_review", "allow_ad_hoc_sku", "auto_writeoff_orphan_ghosts"];
  var NEED_COLS = ["Mã SP", "EPC", "UID", "Số lượng thẻ", "ĐVT", "Trạng thái"];
  var UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  var UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var NWC = window.NWC, XLSX = window.XLSX;

  // ---------- cấu hình từ URL ----------
  var CFG = (function () {
    var q = new URLSearchParams(location.search);
    var c = { api: REAL_API, test: false, timeout: 30000, pollMax: 180000, pollEvery: 3000, bad: null };
    if (!q.has("api")) return c;
    var a = String(q.get("api") || "").replace(/\/+$/, "");
    var m = /^http:\/\/(localhost|127\.0\.0\.1):(\d{1,5})$/.exec(a);
    if (!m || +m[2] < 1 || +m[2] > 65535) { c.bad = a || "(rỗng)"; return c; }
    c.api = a; c.test = true;
    var t = +q.get("timeout"), p = +q.get("poll"), e = +q.get("every");
    if (t >= 200 && t <= 30000) c.timeout = t;
    if (p >= 1000 && p <= 180000) c.pollMax = p;
    if (e >= 50 && e <= 3000) c.pollEvery = e;
    return c;
  })();

  // ---------- tiện ích DOM (chỉ textContent) ----------
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
  // cols: [{t, num, code}] ; rows: [{cells:[…], cls}] hoặc mảng ô
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
  // CSV UTF-8 có BOM; ô chữ bắt đầu bằng = + - @ (công thức Excel) được chèn dấu ' phía trước
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
    store: null, file: null, fileErr: "", overview: null, parsed: null, laReason: {}, codes: [],
    res: {}, lookup: null, P: null, pvFilter: "chu-y", pvQ: "",
    locs: null, locId: "", locErr: "", create: null, createLocked: false, createMsg: null, polls: [],
    target: null, targetErr: null, before: null, beforeCheck: null, bodies: null, beforeErr: "", beforeAt: null,
    sendStarted: false, sending: false, sendDone: false, sendStop: "", sendAt: null, batches: [],
    rc: null, rcAll: false, rcHistory: [], events: [], busy: "", dirty: false, logAt: null
  };
  function ev(what, info) { S.events.push({ at: iso(), what: what, info: info == null ? undefined : info }); }
  function token() { return String($("token").value || "").trim().replace(/^bearer\s+/i, "").trim(); }

  // ---------- gọi API ----------
  function headers(post) {
    var hd = { "Authorization": "Bearer " + token(), "X-Circa-App": "admin", "X-Client-Id": "1", "X-Store-Id": S.store.pos, "Grpc-Timeout": "30S" };
    if (post) hd["Content-Type"] = "application/json; charset=UTF-8";
    return hd;
  }
  // → {status, j, badJson, raw, ms} ; status 0 = lỗi mạng / timeout (err: "timeout" | "network")
  async function call(method, path, body) {
    var ctl = new AbortController(), t0 = Date.now();
    var timer = setTimeout(function () { ctl.abort(); }, CFG.timeout);
    try {
      var r = await fetch(CFG.api + path, {
        method: method, headers: headers(body !== undefined), body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctl.signal, cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer"
      });
      var text = await r.text();
      var j = null;
      try { j = text ? JSON.parse(text) : null; } catch (e) { j = null; }
      return { status: r.status, j: j, badJson: j === null, raw: j === null ? text.slice(0, 300) : undefined, ms: Date.now() - t0 };
    } catch (e) {
      return { status: 0, err: ctl.signal.aborted ? "timeout" : "network", msg: String(e && e.message || e), ms: Date.now() - t0 };
    } finally { clearTimeout(timer); }
  }
  function firstErr(r) { return r && r.j && Array.isArray(r.j.errors) && r.j.errors[0] && typeof r.j.errors[0] === "object" ? r.j.errors[0] : null; }
  function errCode(r) { var e = firstErr(r); return e && e.code != null ? String(e.code) : ""; }
  function errInfo(r) {
    if (!r) return "không có phản hồi";
    if (r.status === 0) return r.err === "timeout" ? "quá " + Math.round(CFG.timeout / 1000) + " giây không có phản hồi (timeout)" : "lỗi mạng hoặc bị chặn (" + r.msg + ")";
    var e = firstErr(r), s = "HTTP " + r.status;
    if (e) {
      s += " — " + (e.code != null ? e.code : "") + (e.message ? ": " + e.message : "");
      if (e.trace_id) s += " (trace_id " + e.trace_id + ")";
    } else if (r.badJson) s += " — phản hồi không phải JSON" + (r.raw ? ": " + r.raw.slice(0, 120) : "");
    return s;
  }
  function authHint(r) {
    if (r && r.status === 401) return "Token hết hạn hoặc sai (HTTP 401). Dán token mới vào ô ở bước 1.";
    if (r && r.status === 403) return "Tài khoản không có quyền cho thao tác này (HTTP 403).";
    if (r && r.status === 400 && /AuthzStore/i.test(errCode(r))) return "Circa báo thiếu / sai cửa hàng (400 " + errCode(r) + ").";
    return "";
  }
  function sessPath(id) { return "/v1/inventory/count/sessions/" + encodeURIComponent(id); }
  function sessOf(r) { var d = r && r.status === 200 && r.j && r.j.data; return d && typeof d === "object" ? (d.session && typeof d.session === "object" ? d.session : d) : null; }
  async function fetchScans(id) {
    var r = await call("GET", sessPath(id) + "/scans?limit=" + SCAN_LIMIT);
    var d = r.status === 200 && r.j && r.j.data;
    if (!d || !Array.isArray(d.scans)) return { err: "Không đọc được lượt quét của phiên: " + errInfo(r) + (r.status === 200 ? " (thiếu data.scans)" : ""), r: r };
    if (d.has_more === true) return { err: "Phiên có nhiều hơn " + fmt(SCAN_LIMIT) + " lượt quét (has_more): công cụ chưa biết cách lấy trang sau — DỪNG, chưa coi là đã đối chiếu.", hasMore: true, r: r };
    if (d.has_more !== false && d.scans.length >= SCAN_LIMIT) return { err: "Phiên trả " + fmt(d.scans.length) + " lượt (bằng giới hạn) mà không có has_more: có thể còn trang sau — DỪNG.", hasMore: true, r: r };
    return { scans: d.scans };
  }

  // ---------- 1. thiết lập ----------
  function onStore() {
    var v = $("store").value;
    S.store = STORES[v] || null;
    resetFrom(3);
    S.locId = S.store && S.store.loc ? S.store.loc : "";
    ev("chon-cua-hang", S.store ? S.store.name : null);
    renderAll();
  }
  function resetFrom(n) {
    if (n <= 3) { S.res = {}; S.lookup = null; S.P = null; }
    if (n <= 5) {
      S.locs = null; S.locErr = ""; S.locId = S.store && S.store.loc ? S.store.loc : "";
      S.target = null; S.targetErr = null; S.before = null; S.beforeCheck = null; S.bodies = null; S.beforeErr = ""; S.beforeAt = null;
    }
  }

  // ---------- 2. nạp file ----------
  function headerRow(ws) {
    var a = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false, blankrows: false });
    return a.length ? a[0].map(function (x) { return String(x); }) : null;
  }
  async function loadFile(f) {
    if (!f) return;
    resetFrom(3);
    S.file = { name: f.name, size: f.size, lastModified: f.lastModified ? new Date(f.lastModified).toISOString() : null, sha256: null, loadedAt: iso() };
    S.fileErr = ""; S.parsed = null; S.overview = null; S.codes = []; S.laReason = {};
    renderAll();
    var buf;
    try { buf = await f.arrayBuffer(); } catch (e) { S.fileErr = "Không đọc được file: " + (e && e.message || e); renderAll(); return; }
    try {
      var dg = await crypto.subtle.digest("SHA-256", buf);
      S.file.sha256 = Array.prototype.map.call(new Uint8Array(dg), function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    } catch (e) { S.file.sha256 = null; }
    var wb;
    try { wb = XLSX.read(new Uint8Array(buf), { type: "array" }); }
    catch (e) { S.fileErr = "Không đọc được file .xlsx (" + (e && e.message || e) + "). Cần file xuất phiên kiểm kê NW (.xlsx)."; renderAll(); return; }
    var miss = ["Chi tiết quét", "Thẻ lạ"].filter(function (n) { return !wb.Sheets[n]; });
    if (miss.length) {
      S.fileErr = "File thiếu sheet " + miss.map(function (n) { return "“" + n + "”"; }).join(", ") + ". Sheet có trong file: " +
        (wb.SheetNames.length ? wb.SheetNames.map(function (n) { return "“" + n + "”"; }).join(", ") : "(không có)") +
        ". Cần đúng file xuất phiên KIỂM KÊ của NW (file Kiểm đếm có dạng khác).";
      renderAll(); return;
    }
    var hd = headerRow(wb.Sheets["Chi tiết quét"]) || [];
    var have = {}; hd.forEach(function (c) { have[NWC._norm(c)] = 1; });
    var missCol = NEED_COLS.filter(function (c) { return !have[NWC._norm(c)]; });
    if (missCol.length) {
      S.fileErr = "Sheet “Chi tiết quét” thiếu cột " + missCol.map(function (c) { return "“" + c + "”"; }).join(", ") + ". Cột đang có: " + (hd.join(", ") || "(không có dòng tiêu đề)") + ".";
      renderAll(); return;
    }
    var hl = headerRow(wb.Sheets["Thẻ lạ"]);
    if (hl && !hl.some(function (c) { return NWC._norm(c) === NWC._norm("EPC"); })) {
      S.fileErr = "Sheet “Thẻ lạ” không có cột “EPC”. Cột đang có: " + hl.join(", ") + ".";
      renderAll(); return;
    }
    var rows = XLSX.utils.sheet_to_json(wb.Sheets["Chi tiết quét"], { defval: "" });
    var la = XLSX.utils.sheet_to_json(wb.Sheets["Thẻ lạ"], { defval: "" });
    var parsed;
    try { parsed = NWC.parseSession(rows, la); } catch (e) { S.fileErr = "Lỗi khi đọc phiên: " + (e && e.message || e); renderAll(); return; }
    la.forEach(function (r) {
      var e = "", why = "";
      Object.keys(r).forEach(function (k) { if (NWC._norm(k) === "epc") e = String(r[k]).trim(); if (NWC._norm(k) === NWC._norm("Lý do")) why = String(r[k]); });
      if (e && !S.laReason[key(e)]) S.laReason[key(e)] = why;
    });
    if (wb.Sheets["Tổng quan"]) {
      var ov = {};
      XLSX.utils.sheet_to_json(wb.Sheets["Tổng quan"], { header: 1, defval: "", raw: false }).forEach(function (r, i) {
        if (i === 0 || !r || !String(r[0]).trim()) return;
        ov[String(r[0]).trim()] = String(r[1] == null ? "" : r[1]).trim();
      });
      S.overview = ov;
    }
    S.parsed = parsed;
    var seen = {};
    parsed.tags.forEach(function (t) { NWC.lookupCodes(t).forEach(function (c) { var k = key(c); if (!seen[k]) { seen[k] = 1; S.codes.push(c); } }); });
    if (!parsed.tags.length) S.fileErr = rows.length ? "Không có thẻ hợp lệ nào trong sheet “Chi tiết quét” (xem lỗi bên dưới)." : "Sheet “Chi tiết quét” không có dòng nào.";
    ev("nap-file", { name: f.name, tags: parsed.tags.length, errors: parsed.errors.length });
    renderAll();
  }
  function khoMatch() {
    if (!S.overview || !S.store) return null;
    var k = S.overview["Kho"];
    if (!k) return null;
    return fold(k).indexOf(fold(S.store.name)) >= 0;
  }
  function renderS2() {
    var out = clear($("s2-out")), st = $("file-status"), drop = $("drop");
    drop.classList.remove("done", "err");
    if (!S.file) { st.textContent = "Bấm để chọn hoặc kéo file vào đây"; return; }
    st.textContent = S.file.name + " (" + fmt(Math.max(1, Math.round(S.file.size / 1024))) + " KB)" + (S.parsed || S.fileErr ? "" : " — đang đọc…");
    if (S.fileErr) { drop.classList.add("err"); out.appendChild(box("bad", "Không dùng được file này", [S.fileErr])); }
    else if (S.parsed) drop.classList.add("done");
    var p = S.parsed;
    if (!p) return;
    var base = sumOf(p.tags, function (t) { return t.nwQty; }), sp = {};
    p.tags.forEach(function (t) { sp[t.pid] = 1; });
    out.appendChild(h("div", { cls: "metrics", style: null },
      metric("Thẻ đã quét", p.tags.length), metric("Sản phẩm", Object.keys(sp).length), metric("Tổng gốc NW", base),
      metric("Thẻ lạ", p.strange.length, p.strange.length ? "warn" : "", "không gửi")));
    var counts = "Lỗi " + p.errors.length + " · bỏ qua " + p.skipped.length + " · cảnh báo " + p.warnings.length;
    out.appendChild(h("p", { cls: "note", text: counts }));
    if (S.overview) {
      var ks = ["Kho", "Trạng thái", "Phạm vi", "Tạo lúc", "Quét lần cuối", "Xuất lúc", "Đếm bằng RFID", "Thẻ lạ"];
      out.appendChild(h("dl", { cls: "kv" }, ks.filter(function (k) { return S.overview[k] != null; }).map(function (k) {
        return [h("dt", { text: k }), h("dd", { text: S.overview[k] })];
      })));
      var m = khoMatch();
      if (m === false) out.appendChild(box("warn", "Kho trong file là “" + S.overview["Kho"] + "”, khác cửa hàng đã chọn (" + S.store.name + ").", ["Kiểm lại cửa hàng ở bước 1 hoặc chọn đúng file."]));
      if (m === null && S.store) out.appendChild(box("warn", "File không ghi Kho ở sheet “Tổng quan”: không kiểm được file thuộc cửa hàng nào.", null));
      var rf = S.overview["Đếm bằng RFID"];
      if (rf && /\d/.test(rf) && +rf.replace(/\D/g, "") !== base) out.appendChild(box("warn", "“Đếm bằng RFID” ở Tổng quan (" + rf + ") khác tổng gốc các thẻ đọc được (" + fmt(base) + ").", ["Có thể do dòng lỗi / bỏ qua bên dưới, hoặc file xuất chưa đủ."]));
    } else out.appendChild(box("warn", "File không có sheet “Tổng quan”: không kiểm được kho, trạng thái phiên NW.", null));
    if (p.errors.length) out.appendChild(box("bad", p.errors.length + " dòng lỗi (bị bỏ, sẽ chặn gửi)", more(p.errors, 50, function (e) { return e.msg; })));
    if (p.skipped.length) out.appendChild(box("bad", p.skipped.length + " dòng bị bỏ qua (sẽ chặn gửi)", more(p.skipped, 50, function (e) {
      return "Dòng " + e.row + " (" + (e.epc || "không EPC") + "): " + (e.reason === "trang-thai" ? "Trạng thái “" + e.value + "” ≠ “Đã quét”" : e.reason === "trung-epc-giong" ? "trùng y hệt dòng " + e.keptRow : e.reason);
    })));
    if (p.warnings.length) out.appendChild(box("warn", p.warnings.length + " cảnh báo", more(p.warnings, 50, function (e) { return e.msg; })));
  }

  // ---------- 3. tra thẻ ----------
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
    if (r.status === 401) return "token";
    if (r.status === 403) return "quyen";
    if (r.status === 400 && /AuthzStore/i.test(errCode(r))) return "store";
    return "";
  }
  async function lookupOne(code) {
    var path = "/v1/inventory/count/qr-lookup?pos_id=" + encodeURIComponent(S.store.pos) + "&qr_code=" + encodeURIComponent(code);
    var r, tries = 0;
    for (;;) {
      r = await call("GET", path); tries++;
      if (r.status === 200 || r.status === 404 || fatalOf(r)) break;
      var retry = r.status === 0 || r.status >= 500 || r.status === 429;
      if (!retry || tries > 3 || (S.lookup && S.lookup.abort)) break;
      await sleep(1000 * Math.pow(2, tries - 1));
    }
    var e = { code: code, status: r.status, tries: tries, at: iso() };
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
    if (!retryOnly) S.res = {};
    var list = S.codes.filter(function (c) { var o = outcome(S.res[key(c)]); return !retryOnly || o === "err" || o === "todo"; });
    S.lookup = { start: iso(), abort: "", abortMsg: "", running: true, runs: (S.lookup ? S.lookup.runs : 0) + 1, retryOnly: !!retryOnly, n: list.length };
    S.P = null; S.busy = "lookup";
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
    S.busy = "";
    if (!S.lookup.abort) {
      S.P = NWC.plan(S.parsed, NWC.lookupMap(resList()));
      ev("ke-hoach", { okToSend: S.P.sum.okToSend, modes: S.P.sum.modes });
    } else ev("tra-dung", S.lookup.abort);
    renderAll();
  }
  function lkText() {
    if (!S.lookup) { $("lk-text").textContent = S.codes.length ? fmt(S.codes.length) + " mã cần tra (UID và EPC của " + fmt(S.parsed ? S.parsed.tags.length : 0) + " thẻ)" : ""; return; }
    var c = lkStats();
    $("lk-text").textContent = (S.lookup.running ? "Đang tra… " : "") + "Đã tra " + fmt(c.ok + c.unk + c.err) + "/" + fmt(c.total) + " mã · Circa nhận " + fmt(c.ok) + " · không nhận " + fmt(c.unk) + " · lỗi " + fmt(c.err) + (c.todo ? " · chưa tra " + fmt(c.todo) : "");
  }
  function renderS3() {
    lkText();
    var out = clear($("s3-out"));
    var c = lkStats();
    $("btn-lookup").textContent = S.lookup ? "Tra lại tất cả" : "Tra thẻ trên Circa";
    $("btn-lookup-retry").hidden = !(S.lookup && !S.lookup.running && (c.err || c.todo));
    if (!S.lookup) { $("lk-prog").hidden = true; return; }
    if (S.lookup.abort) {
      var msg = S.lookup.abort === "token" ? "Token hết hạn hoặc sai (HTTP 401). Dán token mới ở bước 1 rồi bấm “Tra lại phần chưa tra”."
        : S.lookup.abort === "quyen" ? "Tài khoản không có quyền tra mã (HTTP 403). Dùng token của tài khoản có quyền kiểm kê."
          : "Circa báo thiếu / sai cửa hàng (AuthzStoreRequired). Kiểm lại cửa hàng ở bước 1.";
      out.appendChild(box("bad", "Đã dừng tra thẻ — chưa sang bước sau", [msg, "Chi tiết: " + (S.lookup.abortMsg || "")]));
    } else if (!S.lookup.running && (c.err || c.todo)) {
      var bad = S.codes.filter(function (x) { return outcome(S.res[key(x)]) === "err"; });
      out.appendChild(box("warn", fmt(c.err + c.todo) + " mã chưa tra được (sẽ chặn gửi). Bấm “Tra lại phần chưa tra”.", more(bad, 30, function (x) { return x + ": " + (S.res[key(x)].err || ""); })));
    } else if (!S.lookup.running) {
      out.appendChild(box("ok", "Đã tra xong " + fmt(c.total) + " mã: Circa nhận " + fmt(c.ok) + ", không nhận " + fmt(c.unk) + " (thẻ E280… chỉ tra được bằng UID, EPC ra 404 là bình thường).", null));
    }
  }

  // ---------- 4. xem trước ----------
  function friendly(b) {
    var m;
    if ((m = /^File phiên có (\d+) dòng lỗi/.exec(b))) return "File xuất phiên NW có " + m[1] + " dòng lỗi (xem bước 2). Sửa trên NW rồi xuất lại file; không sửa tay file.";
    if ((m = /^File phiên có (\d+) dòng bị bỏ qua/.exec(b))) return "File có " + m[1] + " dòng bị bỏ qua (Trạng thái khác “Đã quét” hoặc trùng EPC) — xem bước 2. Cần xuất lại file chỉ gồm thẻ đã quét, hoặc hỏi lập trình.";
    if ((m = /^(\d+) thẻ chưa tra Circa/.exec(b))) return m[1] + " thẻ chưa tra được trên Circa (lỗi mạng / máy chủ). Bấm “Tra lại phần chưa tra” ở bước 3.";
    if (/mã gửi trùng nhau/.test(b)) return "Có mã gửi trùng nhau giữa các thẻ. Không gửi; báo lập trình.";
    if (/trùng UID\/EPC của thẻ khác/.test(b)) return "Có mã gửi trùng UID/EPC của một thẻ khác. Kiểm thẻ trên NW; báo lập trình.";
    if (/gốc dự tính theo payload/.test(b)) return "Có thẻ mà số gốc Circa sẽ ghi (tính từ payload) khác SL NW. Không gửi; báo lập trình.";
    if (/Không có thẻ nào để gửi/.test(b)) return "Không có thẻ nào gửi được (mọi thẻ đều bị giữ / Circa không nhận).";
    if (/parseSession/.test(b)) return "Thiếu kết quả đọc file. Nạp lại file ở bước 2.";
    return b;
  }
  var MODE_TXT = { "tho": "thô", "kem-don-vi": "kèm đơn vị", "giu": "giữ", "khong-nhan": "Circa không nhận", "chua-tra": "chưa tra" };
  function modesTxt(m) { return NWC.MODES.filter(function (k) { return m[k]; }).map(function (k) { return MODE_TXT[k] + " " + m[k]; }).join(" · "); }
  function sev(p) { return (p.modes["chua-tra"] || p.modes["khong-nhan"] || p.modes.giu || p.predMismatch) ? 0 : p.modes["kem-don-vi"] ? 1 : 2; }
  function attention(p) { return p.modes.tho !== p.tags || p.predMismatch || p.diff !== 0; }
  function spSorted() {
    return S.P.bySp.slice().sort(function (a, b) { return sev(a) - sev(b) || String(a.name).localeCompare(String(b.name), "vi") || a.pid - b.pid; });
  }
  function renderS4() {
    var out = clear($("s4-out"));
    if (!S.P) return;
    var sum = S.P.sum;
    out.appendChild(h("div", { cls: "metrics five" },
      metric("Gửi thô", sum.modes.tho, "", "mã của thẻ, Circa tự quy đổi"),
      metric("Gửi kèm đơn vị", sum.modes["kem-don-vi"], "", "lệch quy đổi: gửi SL NW theo đơn vị gốc"),
      metric("Giữ lại", sum.modes.giu, sum.modes.giu ? "warn" : ""),
      metric("Circa không nhận", sum.modes["khong-nhan"], sum.modes["khong-nhan"] ? "warn" : ""),
      metric("Chưa tra", sum.modes["chua-tra"], sum.modes["chua-tra"] ? "bad" : "")));
    out.appendChild(h("div", { cls: "metrics three" },
      metric("Gốc NW", sum.nwBase), metric("Gốc sẽ gửi", sum.predBase, "", "Circa sẽ ghi, dự tính theo payload"),
      metric("Gốc không gửi", sum.holdBase, sum.holdBase ? "warn" : "")));
    if (!sum.okToSend) {
      out.appendChild(box("bad", "Chưa gửi được — bước 5 và 6 bị khoá", sum.blockers.map(function (b) { return [friendly(b), h("br"), h("small", { text: "(" + b + ")" })]; })));
    } else {
      out.appendChild(box("ok", "Kế hoạch đạt: " + fmt(sum.codes) + " thẻ sẽ gửi trong " + sum.batches + " lô (" + fmt(sum.via.UID) + " thẻ gửi bằng UID, " + fmt(sum.via.EPC) + " bằng EPC).",
        sum.modes.giu || sum.modes["khong-nhan"] ? ["Thẻ giữ lại / Circa không nhận sẽ KHÔNG gửi: kiểm tay phần này (danh sách bên dưới)."] : null));
    }
    // bảng theo SP
    var seg = h("div", { cls: "seg" });
    [["chu-y", "Cần chú ý"], ["all", "Tất cả"]].forEach(function (x) {
      var n = x[0] === "all" ? S.P.bySp.length : S.P.bySp.filter(attention).length;
      seg.appendChild(h("button", { cls: S.pvFilter === x[0] ? "on" : null, "data-f": x[0], on: { click: function () { S.pvFilter = x[0]; renderS4(); } } }, x[1] + " (" + n + ")"));
    });
    var q = h("input", { type: "search", id: "pv-q", placeholder: "Tìm mã hoặc tên sản phẩm", value: S.pvQ });
    var holder = h("div", { id: "pv-table" });
    q.addEventListener("input", function () { S.pvQ = q.value; fillSp(holder); });
    out.appendChild(h("h3", { text: "Theo sản phẩm", style: null }));
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
    out.appendChild(details("Thẻ lạ trong file NW (" + st.length + ", không gửi)", function () {
      return table([{ t: "EPC", code: 1 }, { t: "Lý do (NW)" }], st.map(function (e) { return [e, S.laReason[key(e)] || ""]; }), { small: 1, empty: "Không có thẻ lạ." });
    }));
    out.appendChild(details("Chi tiết từng thẻ (tham chiếu, " + S.P.items.length + ")", function () {
      var lot = {};
      try { NWC.batches(S.P.items, "x", DEVICE).forEach(function (b, i) { NWC.bodyCodes(b).forEach(function (c) { lot[key(c)] = i + 1; }); }); } catch (e) { /* kế hoạch có mã trùng: đã chặn ở blockers */ }
      return table([{ t: "EPC", code: 1 }, { t: "UID", code: 1 }, { t: "Mã gửi", code: 1 }, { t: "Mã SP" }, { t: "Tên sản phẩm" }, { t: "SL NW", num: 1 }, { t: "ĐVT NW" }, { t: "Đơn vị mã Circa" }, { t: "Quy đổi", num: 1 }, { t: "Cách gửi" }, { t: "Lô", num: 1 }, { t: "Lý do" }],
        S.P.items.map(function (x) {
          return [x.epc, x.uid, x.code || "", x.pid, x.name, x.nwQty, x.nwUnit, x.circaUnit || "", x.circaRate == null ? "" : x.circaRate,
            x.mode === "kem-don-vi" ? "kèm " + x.send.quantity + " " + x.send.unit_name : MODE_TXT[x.mode] || x.mode, x.code ? lot[key(x.code)] || "" : "", x.reason];
        }), { small: 1, limit: 3000 });
    }));
  }
  function fillSp(holder) {
    clear(holder);
    var q = fold(S.pvQ);
    var rows = spSorted().filter(function (p) { return S.pvFilter === "all" || attention(p); }).filter(function (p) {
      return !q || String(p.pid).indexOf(q) >= 0 || fold(p.name).indexOf(q) >= 0;
    });
    holder.appendChild(table([{ t: "Mã SP" }, { t: "Tên sản phẩm" }, { t: "Số thẻ", num: 1 }, { t: "Gốc NW", num: 1 }, { t: "Gốc sẽ gửi", num: 1 }, { t: "Cách gửi" }, { t: "Kết luận" }, { t: "Việc cần làm" }],
      rows.map(function (p) {
        return { cls: sev(p) === 0 ? "flag" : null, cells: [p.pid, p.name, p.tags, p.nwBase, p.predBase, modesTxt(p.modes), p.ketLuan, p.viecCanLam] };
      }), { empty: S.pvFilter === "chu-y" && !q ? "Không có SP nào cần chú ý: mọi thẻ khớp quy đổi, gửi thô." : "Không có SP khớp ô tìm." }));
  }
  function dlPreviewCsv() {
    var head = ["Mã SP", "Tên sản phẩm", "ĐVT NW", "Số thẻ", "Gốc NW", "Gốc sẽ gửi (dự tính)", "Gốc không gửi", "Chênh", "Thẻ gửi thô", "Thẻ kèm đơn vị",
      "Thẻ giữ", "Thẻ Circa không nhận", "Thẻ chưa tra", "Thẻ gửi qua UID", "Đơn vị mã trên Circa", "Kết luận", "Việc cần làm"];
    var rows = spSorted().map(function (p) {
      return [p.pid, p.name, p.nwUnit, p.tags, p.nwBase, p.predBase, p.holdBase, p.diff, p.modes.tho, p.modes["kem-don-vi"], p.modes.giu,
        p.modes["khong-nhan"], p.modes["chua-tra"], p.via.UID, p.circaUnits, p.ketLuan, p.viecCanLam];
    });
    download("nw-sang-circa-xem-truoc-" + safeName(S.store && S.store.key) + "-" + stamp() + ".csv", csv(head, rows), "text/csv;charset=utf-8");
  }

  // ---------- 5. phiên đích ----------
  function vnDate() { return new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10); }
  function createBody() {
    return {
      pos_id: S.store.pos, scheduled_date: vnDate(), counting_mode: "QR", sync_baseline: true,
      designated_main_location_id: S.locId, cleanup_missing: false, auto_approve_tolerance_pct: 2, auto_approve_tolerance_value: 50000,
      force_manual_review: false, allow_ad_hoc_sku: true, auto_writeoff_orphan_ghosts: false
    };
  }
  function locLabel(id) {
    if (!id) return "(chưa chọn)";
    var l = S.locs && S.locs.filter(function (x) { return x.id === id; })[0];
    if (l) return l.name + (l.code && l.code !== l.name ? " [" + l.code + "]" : "") + " — " + id;
    if (S.store && id === S.store.loc) return S.store.locName + " — " + id + " (mặc định)";
    return id;
  }
  function renderS5() {
    var st = S.store;
    var cfg = clear($("new-cfg"));
    if (st) {
      [["Cửa hàng", st.name + " (pos_id " + st.pos + ")"], ["Ngày", vnDate()], ["Phương thức", "QR"], ["Phạm vi", "Toàn bộ tồn kho cửa hàng"],
        ["Chụp tồn sổ", "Có (sync_baseline) — tồn sổ chốt NGAY lúc tạo phiên"], ["Vị trí chính", locLabel(S.locId)],
        ["Tự duyệt", "lệch ≤ 2% và ≤ 50.000 (force_manual_review: không)"], ["Khác", "allow_ad_hoc_sku: có · cleanup_missing: không · auto_writeoff_orphan_ghosts: không"]
      ].forEach(function (kv) { cfg.appendChild(h("dt", { text: kv[0] })); cfg.appendChild(h("dd", { text: kv[1] })); });
    }
    var sel = clear($("loc"));
    if (st) {
      if (S.locs) {
        sel.appendChild(h("option", { value: "", text: "Chọn vị trí chính…" }));
        S.locs.forEach(function (l) { sel.appendChild(h("option", { value: l.id, text: l.name + (l.code && l.code !== l.name ? " [" + l.code + "]" : "") })); });
      } else if (st.loc) sel.appendChild(h("option", { value: st.loc, text: st.locName + " (mặc định " + st.name + ")" }));
      else sel.appendChild(h("option", { value: "", text: "Bấm “Tải danh sách vị trí” rồi chọn" }));
      sel.value = S.locId || "";
    }
    var lo = clear($("loc-out"));
    if (S.locErr) lo.appendChild(box("bad", S.locErr, null));
    else if (S.locs && st && st.loc && !S.locs.some(function (l) { return l.id === st.loc; })) lo.appendChild(box("warn", "Danh sách vị trí không có vị trí mặc định " + st.locName + " (" + st.loc + "). Chọn vị trí chính trong danh sách.", null));
    else if (st && !st.loc && !S.locId) lo.appendChild(h("p", { cls: "note", text: "Cửa hàng " + st.name + " không có vị trí mặc định trong công cụ: bắt buộc tải danh sách và chọn vị trí chính (thường là “General”)." }));
    var co = clear($("create-out"));
    if (S.createMsg) co.appendChild(S.createMsg);
    var eo = clear($("exist-out"));
    if (S.targetErr) eo.appendChild(S.targetErr);
    var out = clear($("s5-out"));
    if (!S.target) return;
    var t = S.target;
    var link = h("a", { target: "_blank", rel: "noopener noreferrer", text: "Mở phiên trên admin" });
    link.href = ADMIN + t.id;
    out.appendChild(box("ok", "Phiên đích: " + (t.code || "(không có mã)") + " · " + t.status + " · cửa hàng " + st.name, [
      "Id: " + t.id, "Phương thức: " + (t.counting_mode || "?") + (t.created_at ? " · tạo lúc " + when(t.created_at) : "") + (t.via === "tao" ? " · do trang này tạo" : " · phiên có sẵn"),
    ], h("div", { cls: "row" }, link, !S.sendStarted ? h("button", { id: "btn-unset", on: { click: unsetTarget } }, "Bỏ chọn phiên") : null)));
    if (t.counting_mode && t.counting_mode !== "QR") out.appendChild(box("warn", "Phiên có phương thức " + t.counting_mode + " (luồng đã kiểm thật dùng phiên QR).", null));
    if (S.beforeErr) { out.appendChild(box("bad", "Chưa gửi được vào phiên này", [S.beforeErr])); return; }
    if (!S.before) { out.appendChild(h("p", { cls: "note", text: "Đang tải lượt quét có sẵn của phiên…" })); return; }
    out.appendChild(renderExisting(S.before, S.beforeCheck, S.bodies));
  }
  function renderExisting(scans, cs, bodies) {
    if (!scans.length) return box("ok", "Phiên chưa có lượt quét nào (tải lúc " + when(S.beforeAt) + ").", null);
    var c = cs.sum.counts, bad = cs.rows.filter(function (r) { return r.result !== "dung" && r.result !== "thieu"; });
    var ex = bodies && bodies.excluded ? bodies.excluded.length : 0;
    var items = [
      "Mã của kế hoạch đã có, ghi đúng: " + fmt(c.dung),
      "Mã đã ghi SAI số: " + fmt(c["sai-so"]) + " · sai SP: " + fmt(c["sai-sp"]) + " · có nhiều lượt: " + fmt(c.lap),
      "Lượt ngoài kế hoạch (không thuộc thẻ nào trong file, hoặc mã khác của thẻ): " + fmt(cs.foreign.length) + " lượt = " + fmt(cs.sum.foreignBase) + " gốc",
      fmt(ex) + " mã đã có trong phiên sẽ KHÔNG gửi lại (gửi lại không sửa được số đã ghi; Circa chỉ đếm trùng là duplicates)."
    ];
    if (c["sai-so"] || c["sai-sp"] || c.lap) items.push("Số đã ghi sai không sửa được bằng API: sau khi gửi, cho đếm lại các SP đó trên Circa.");
    if (cs.foreign.length) items.push("Lượt ngoài kế hoạch có thể là nhân viên quét QR / lượt thử cũ: nguy cơ đếm đôi. Đối chiếu sẽ báo CHƯA ĐẠT.");
    var b = box(bad.length || cs.foreign.length ? "warn" : "info", "Phiên đã có " + fmt(scans.length) + " lượt quét (gốc " + fmt(sumOf(scans, function (s) { return Number(s.base_qty); })) + "), tải lúc " + when(S.beforeAt), items);
    if (bad.length) b.appendChild(table([{ t: "Mã", code: 1 }, { t: "EPC", code: 1 }, { t: "Mã SP" }, { t: "Kết quả" }, { t: "Chi tiết" }],
      bad.map(function (r) { return [r.code, r.epc, r.pid, r.result, r.msg]; }), { small: 1, limit: 100 }));
    if (cs.foreign.length) b.appendChild(table([{ t: "Mã quét", code: 1 }, { t: "SP Circa" }, { t: "Gốc", num: 1 }, { t: "Thiết bị" }, { t: "Lý do" }],
      cs.foreign.map(function (f) { return [f.code, f.product_id, f.base_qty, f.device_id, f.why]; }), { small: 1, limit: 100 }));
    return b;
  }
  function unsetTarget() {
    if (S.sendStarted || S.busy) return;
    ev("bo-chon-phien", S.target && S.target.code);
    S.target = null; S.before = null; S.beforeCheck = null; S.bodies = null; S.beforeErr = ""; S.targetErr = null;
    renderAll();
  }
  async function loadLocs() {
    if (!S.store) return;
    S.busy = "locs"; S.locErr = ""; refresh();
    var path = "/v1/admin/inventory/location?query=pos_ids=" + S.store.pos + ",location_type=SALES,sale_allowed=true,is_last_location=true";
    var r = await call("GET", path);
    S.busy = "";
    var d = r.status === 200 && r.j ? r.j.data : null;
    var list = Array.isArray(d) ? d : d && typeof d === "object" ? (Array.isArray(d.locations) ? d.locations : Array.isArray(d.items) ? d.items : Array.isArray(d.list) ? d.list : null) : null;
    if (!list) {
      S.locErr = "Không tải được danh sách vị trí: " + (r.status === 200 ? "phản hồi không có mảng vị trí (data / data.locations / data.items)" : errInfo(r)) + (authHint(r) ? " " + authHint(r) : "");
    } else {
      var pos = S.store.pos;
      S.locs = list.filter(function (x) { return x && typeof x === "object" && x.id != null && (x.pos_id == null || String(x.pos_id) === pos); })
        .map(function (x) { return { id: String(x.id), name: String(x.name != null && x.name !== "" ? x.name : x.code != null ? x.code : x.id), code: x.code != null ? String(x.code) : "" }; })
        .sort(function (a, b) { return (fold(b.name) === "general") - (fold(a.name) === "general") || a.name.localeCompare(b.name, "vi"); });
      if (!S.locs.length) S.locErr = "Danh sách vị trí rỗng.";
      if (!S.locs.some(function (l) { return l.id === S.locId; })) S.locId = "";
      ev("tai-vi-tri", { n: S.locs.length });
    }
    renderAll();
  }
  async function currentOpen() {
    var r = await call("GET", "/v1/inventory/count/session/current?pos_id=" + encodeURIComponent(S.store.pos));
    var s = sessOf(r);
    if (r.status === 200 && s && s.id) return { s: s };
    if (r.status === 404 || (r.status === 200 && (!s || !s.id))) return { none: true };
    return { err: errInfo(r), r: r };
  }
  async function onCreate() {
    if (S.createLocked || S.busy || S.target || !S.locId) return;
    S.busy = "precreate"; refresh();
    var cur = await currentOpen();
    var body = createBody();
    var lines = [
      "Cửa hàng: " + S.store.name + " (pos_id " + S.store.pos + ")",
      "Ngày " + body.scheduled_date + " · phương thức QR · phạm vi toàn bộ tồn kho cửa hàng · vị trí chính " + locLabel(S.locId),
      "Tồn sổ (số dự kiến) của TOÀN cửa hàng được CHỐT ngay lúc tạo phiên. Hàng bán / nhập sau lúc đó không vào số dự kiến của phiên.",
      "Phiên sẽ để MỞ. Trang không đóng, không duyệt phiên.",
      "Nếu tạo lỗi hoặc không rõ kết quả, trang KHÔNG tự tạo lại."
    ];
    if (cur.s) lines.push("Lưu ý: cửa hàng đang có phiên mở " + (cur.s.code || cur.s.id) + (cur.s.created_at ? " (tạo " + when(cur.s.created_at) + ")" : "") + ". Có thể dùng phiên đó ở mục b thay vì tạo mới.");
    else if (cur.err) lines.push("Không kiểm được phiên đang mở của cửa hàng (" + cur.err + ").");
    S.busy = "confirm"; refresh();
    var ok = await confirmBox("Tạo phiên kiểm kê MỚI trên Circa?", lines, "Tạo phiên");
    S.busy = ""; refresh();
    if (!ok || S.createLocked || S.target) return;
    S.createLocked = true; S.busy = "create"; S.dirty = true; S.createMsg = h("p", { cls: "note", text: "Đang tạo phiên…" });
    ev("tao-phien-gui", body);
    renderAll();
    var at = iso();
    var r = await call("POST", "/v1/inventory/count/sessions", body); // KHÔNG tự gửi lại: gửi lại có thể tạo 2 phiên
    S.create = { at: at, body: body, status: r.status, ms: r.ms, err: r.err, response: r.j != null ? r.j : r.raw != null ? { raw: r.raw } : null };
    var s = r.status === 200 && r.j && r.j.data && r.j.data.session;
    if (!s || !s.id || !UUID_ONLY.test(String(s.id))) {
      var definite = r.status >= 400 && r.status < 500 && r.j && !r.badJson;
      ev("tao-phien-loi", { status: r.status, definite: definite });
      if (definite) {
        S.createLocked = false;
        S.createMsg = box("bad", "Circa từ chối tạo phiên — phiên CHƯA được tạo", [errInfo(r), authHint(r) || "Sửa lỗi rồi bấm “Tạo phiên mới…” lại."].filter(Boolean));
      } else {
        S.createMsg = box("bad", "KHÔNG RÕ phiên đã được tạo hay chưa", [
          "Kết quả: " + (r.status === 200 ? "HTTP 200 nhưng không có data.session.id" : errInfo(r)),
          "Trang KHÔNG tự gửi lại và đã khoá nút tạo phiên (gửi lại có thể tạo 2 phiên).",
          "Mở admin.v2.circa.vn/kiem-ke-ton-kho, xem phiên mới nhất của cửa hàng. Nếu có phiên vừa tạo: dùng mục b (“Lấy phiên đang mở” hoặc dán id). Nếu chắc chắn chưa có: tải lại trang và làm lại từ đầu."
        ]);
      }
      S.busy = ""; renderAll(); return;
    }
    ev("tao-phien-ok", { id: s.id, code: s.code, status: s.status });
    $("sess-in").value = s.id;
    S.createMsg = h("p", { cls: "note", text: "Đã tạo phiên " + (s.code || s.id) + " (" + (s.status || "?") + "). Đang chờ Circa nạp tồn sổ…" });
    S.busy = "poll"; renderAll();
    var p = await pollOpen(s.id, s.code);
    if (!p.ok) {
      S.busy = "";
      S.createMsg = box("bad", "Phiên " + (s.code || s.id) + " chưa MỞ — dừng", [p.msg,
        "Không tạo phiên khác. Mở admin kiểm phiên này; khi phiên OPEN, bấm “Kiểm phiên” ở mục b (id đã điền sẵn)."]);
      renderAll(); return;
    }
    S.createMsg = h("p", { cls: "note", text: "Phiên " + (p.s.code || s.code) + " đã OPEN." });
    await useSession(s.id, "tao", p.s);
  }
  async function pollOpen(id, code) {
    var t0 = Date.now(), last = "", lastErr = "";
    for (;;) {
      var r = await call("GET", sessPath(id));
      var s = sessOf(r), st = s && s.status ? String(s.status) : "";
      S.polls.push({ at: iso(), http: r.status, status: st || undefined });
      if (S.polls.length > 200) S.polls.splice(0, S.polls.length - 200);
      if (st === "OPEN") return { ok: true, s: s };
      if (r.status === 401) return { msg: "Token hết hạn hoặc sai (HTTP 401) khi hỏi trạng thái phiên. Dán token mới rồi bấm “Kiểm phiên” ở mục b." };
      if (st && st !== "LOADING_BASELINE") return { msg: "Phiên chuyển sang trạng thái " + st + " (không phải OPEN)." };
      if (st) last = st; else lastErr = errInfo(r);
      var el = Date.now() - t0;
      if (el >= CFG.pollMax) return { msg: "Sau " + Math.round(el / 1000) + " giây phiên vẫn " + (last || "chưa đọc được trạng thái") + (lastErr && !last ? " (" + lastErr + ")" : "") + " — quá thời hạn " + Math.round(CFG.pollMax / 1000) + " giây." };
      S.createMsg = h("p", { cls: "note" }, h("span", { cls: "spin" }), "Phiên " + (code || id) + ": " + (st || "chưa đọc được trạng thái" + (lastErr ? " (" + lastErr + ")" : "")) + " — đã chờ " + Math.round(el / 1000) + " giây (tối đa " + Math.round(CFG.pollMax / 1000) + " giây).");
      put("create-out", S.createMsg);
      await sleep(CFG.pollEvery);
    }
  }
  function sessIdFrom(text) {
    var t = String(text || "").trim();
    var m = /kiem-ke-ton-kho\/([0-9a-f-]{36})/i.exec(t) || UUID_RE.exec(t);
    return m ? (m[1] || m[0]).toLowerCase() : "";
  }
  async function onCheckSession() {
    var id = sessIdFrom($("sess-in").value);
    if (!id) { S.targetErr = box("bad", "Không thấy id phiên (dạng xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx) trong ô.", null); renderS5(); return; }
    await useSession(id, "co-san");
  }
  async function onCurrent() {
    S.busy = "current"; S.targetErr = null; refresh(); renderS5();
    var cur = await currentOpen();
    S.busy = "";
    if (cur.s) {
      $("sess-in").value = String(cur.s.id);
      S.targetErr = h("p", { cls: "note", text: "Circa trả phiên đang mở: " + (cur.s.code || cur.s.id) + ". (Circa chỉ trả MỘT phiên dù cửa hàng có nhiều phiên mở.)" });
      renderAll();
      await useSession(String(cur.s.id), "co-san");
      return;
    }
    S.targetErr = cur.none ? box("warn", "Circa không trả phiên đang mở nào cho cửa hàng " + S.store.name + ".", null)
      : box("bad", "Không lấy được phiên đang mở: " + cur.err, authHint(cur.r) ? [authHint(cur.r)] : null);
    renderAll();
  }
  // Kiểm phiên (OPEN + đúng cửa hàng) rồi tải lượt quét có sẵn và chia lô
  async function useSession(id, via, known) {
    if (!UUID_ONLY.test(String(id))) { S.targetErr = box("bad", "Id phiên không đúng dạng: " + id, null); renderAll(); return; }
    S.busy = "session"; S.targetErr = null; refresh();
    var s = known;
    if (!s) {
      var r = await call("GET", sessPath(id));
      s = sessOf(r);
      if (!s) {
        S.busy = ""; S.targetErr = box("bad", "Không đọc được phiên " + id + ": " + errInfo(r), authHint(r) ? [authHint(r)] : null); renderAll(); return;
      }
    }
    var st = String(s.status || "");
    var problem = st !== "OPEN" ? "Phiên " + (s.code || id) + " đang ở trạng thái " + (st || "(không rõ)") + ", không phải OPEN: không gửi được."
      : s.pos_id == null ? "Phiên không có pos_id: không kiểm được cửa hàng." : String(s.pos_id) !== S.store.pos ? "Phiên " + (s.code || id) + " thuộc cửa hàng khác (pos_id " + s.pos_id + "), không phải " + S.store.name + "." : "";
    if (problem) { S.busy = ""; S.targetErr = box("bad", problem, null); ev("phien-khong-dung", { id: id, status: st, pos_id: s.pos_id }); renderAll(); return; }
    S.target = { id: id, code: s.code ? String(s.code) : "", status: st, pos_id: String(s.pos_id), counting_mode: s.counting_mode ? String(s.counting_mode) : "", created_at: s.created_at || null, via: via, checkedAt: iso() };
    ev("chon-phien", { id: id, code: S.target.code, via: via });
    renderAll();
    await loadBefore();
    S.busy = ""; renderAll();
  }
  async function loadBefore() {
    S.before = null; S.beforeCheck = null; S.bodies = null; S.beforeErr = "";
    var sc = await fetchScans(S.target.id);
    S.beforeAt = iso();
    if (sc.err) { S.beforeErr = sc.err + (authHint(sc.r) ? " " + authHint(sc.r) : ""); return false; }
    S.before = sc.scans;
    S.beforeCheck = NWC.checkScans(S.P.items, sc.scans);
    try { S.bodies = NWC.batches(S.P.items, S.target.id, DEVICE, sc.scans); }
    catch (e) { S.bodies = null; S.beforeErr = "Không chia lô được: " + (e && e.message || e); return false; }
    ev("luot-co-san", { scans: sc.scans.length, excluded: S.bodies.excluded.length, batches: S.bodies.length });
    return true;
  }

  // ---------- 6. gửi ----------
  function bodyStats(bodies) {
    var codes = 0, base = 0;
    bodies.forEach(function (b) { var its = NWC.itemsFor(b, S.P.items); codes += NWC.bodyCodes(b).length; base += sumOf(its, function (x) { return x.expectBase; }); });
    return { codes: codes, base: base };
  }
  function renderS6() {
    var out = clear($("send-sum"));
    if (S.target && S.bodies && !S.sendStarted) {
      var bs = bodyStats(S.bodies);
      out.appendChild(box(S.bodies.length ? "info" : "ok", S.bodies.length ? "Sẽ gửi " + fmt(bs.codes) + " thẻ (gốc " + fmt(bs.base) + ") trong " + S.bodies.length + " lô vào phiên " + (S.target.code || S.target.id) : "Không còn thẻ nào cần gửi: mọi mã của kế hoạch đã có trong phiên.",
        [S.bodies.excluded.length ? "Bỏ qua " + fmt(S.bodies.excluded.length) + " mã đã có trong phiên." : null,
          "Trước khi gửi, trang tải lại lượt quét của phiên một lần nữa và hỏi xác nhận với số mới nhất."].filter(Boolean)));
    }
    $("btn-send").textContent = S.target && S.bodies && S.bodies.length && !S.sendStarted ? "Gửi " + fmt(bodyStats(S.bodies).codes) + " thẻ…" : "Gửi…";
    var o = clear($("s6-out"));
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
    if (S.sendStarted || S.busy || !S.target || !S.P || !S.P.sum.okToSend) return;
    S.busy = "presend"; S.sendMsg = h("p", { cls: "note", text: "Kiểm lại phiên và lượt quét trước khi gửi…" }); renderAll();
    var r = await call("GET", sessPath(S.target.id));
    var s = sessOf(r);
    if (!s || String(s.status) !== "OPEN" || String(s.pos_id) !== S.store.pos) {
      S.busy = "";
      S.sendMsg = box("bad", "Không gửi: phiên không còn sẵn sàng", [s ? "Trạng thái " + s.status + ", pos_id " + s.pos_id : errInfo(r), authHint(r)].filter(Boolean));
      renderAll(); return;
    }
    var ok0 = await loadBefore();
    S.busy = ""; renderAll();
    if (!ok0) { S.sendMsg = box("bad", "Không gửi", [S.beforeErr]); renderAll(); return; }
    var bodies = S.bodies;
    if (!bodies.length) { S.sendMsg = box("ok", "Không còn thẻ nào cần gửi. Bấm “Đối chiếu lại” ở bước 7.", null); S.rcReady = true; renderAll(); return; }
    var bs = bodyStats(bodies);
    var lines = [
      "Phiên: " + (S.target.code || "(không mã)") + " · cửa hàng " + S.store.name + " · id " + S.target.id,
      "Gửi " + fmt(bs.codes) + " thẻ (gốc " + fmt(bs.base) + ") trong " + bodies.length + " lô (≤ 100 thẻ/lô), tuần tự.",
      bodies.excluded.length ? "Bỏ qua " + fmt(bodies.excluded.length) + " mã đã có trong phiên (không gửi lại)." : "Phiên chưa có mã nào của kế hoạch.",
      "Đây là thao tác GHI: mỗi thẻ thành một lượt quét trong phiên. Trang không xoá được lượt quét.",
      "Không đóng trang khi đang gửi. Lô nào sai, trang dừng ngay và không gửi lô sau."
    ];
    S.busy = "confirm"; refresh();
    var ok = await confirmBox("Gửi " + fmt(bs.codes) + " thẻ vào phiên " + (S.target.code || S.target.id) + "?", lines, "Gửi " + fmt(bs.codes) + " thẻ");
    S.busy = ""; refresh();
    if (!ok || S.sendStarted) { S.sendMsg = ok ? S.sendMsg : h("p", { cls: "note", text: "Đã huỷ, chưa gửi gì." }); renderS6(); return; }
    S.sendStarted = true; S.sending = true; S.busy = "send"; S.dirty = true; S.sendAt = iso();
    S.sendPlan = { at: S.sendAt, sessionId: S.target.id, code: S.target.code, scansBefore: S.before, excluded: bodies.excluded, bodies: bodies.map(function (b) { return b; }) };
    ev("gui-bat-dau", { batches: bodies.length, codes: bs.codes });
    var prog = $("send-prog"); prog.hidden = false; prog.max = bodies.length; prog.value = 0;
    S.sendMsg = null; renderAll();
    for (var i = 0; i < bodies.length; i++) {
      var body = bodies[i], bi = NWC.itemsFor(body, S.P.items);
      var entry = { lo: i + 1, codes: NWC.bodyCodes(body).length, body: body, attempts: [], running: true };
      S.batches.push(entry);
      var resp, tries = 0, resend = false;
      for (;;) {
        $("send-text").textContent = "Lô " + (i + 1) + "/" + bodies.length + ": gửi lần " + (tries + 1) + "…";
        renderS6();
        var at = iso();
        resp = await call("POST", "/v1/inventory/count/submit-rfid-batch", body);
        tries++;
        entry.attempts.push({ at: at, status: resp.status, ms: resp.ms, err: resp.err, response: resp.j != null ? resp.j : resp.raw != null ? { raw: resp.raw } : null });
        if (resp.status === 200 || (resp.status >= 400 && resp.status < 500) || tries > 3) break;
        resend = true;
        $("send-text").textContent = "Lô " + (i + 1) + ": " + errInfo(resp) + " — gửi lại nguyên lô sau " + (1 << (tries - 1)) + " giây";
        await sleep(1000 * (1 << (tries - 1)));
      }
      entry.running = false; entry.tries = tries; entry.resend = resend;
      var chk = resp.status === 200 && resp.j && resp.j.success !== false && resp.j.data && typeof resp.j.data === "object" ? NWC.checkResponse(bi, resp.j.data, { resend: resend }) : null;
      if (chk) entry.check = { ok: chk.ok, needScanCheck: chk.needScanCheck, counts: chk.counts, warnings: chk.warnings, extra: chk.extra, bad: chk.rows.filter(function (x) { return x.result !== "dung" || x.note; }) };
      prog.value = i + 1;
      if (!chk) {
        entry.stop = resp.status === 401 ? "401 token" : resp.status === 400 && /FAILED_PRECONDITION/i.test(errCode(resp)) ? "phiên không mở" : "lỗi " + (resp.status || resp.err);
        S.sendStop = "Lô " + (i + 1) + ": " + (resp.status === 401 ? "token hết hạn hoặc sai (HTTP 401) — lô này không được ghi."
          : resp.status === 400 && /FAILED_PRECONDITION/i.test(errCode(resp)) ? "phiên không còn mở (400 FAILED_PRECONDITION)."
            : resp.status >= 400 && resp.status < 500 ? "Circa từ chối (" + errInfo(resp) + ")."
              : resp.status === 200 ? "HTTP 200 nhưng không đọc được response — không biết Circa đã ghi gì."
                : "không gửi được sau " + tries + " lần (" + errInfo(resp) + ") — KHÔNG rõ Circa đã ghi lô này chưa.");
        S.sendStop += " " + (resp.status >= 400 || resp.status === 0 ? errInfo(resp) : "");
      } else if (!chk.ok) {
        entry.stop = "lô không đạt";
        S.sendStop = "Lô " + (i + 1) + " không đạt: " + chk.rows.filter(function (x) { return x.result !== "dung"; }).length + " thẻ sai / chưa xác nhận" + (chk.warnings.length ? " (" + chk.warnings.join("; ") + ")" : "") + ".";
      }
      ev("gui-lo", { lo: i + 1, tries: tries, status: resp.status, ok: !!(chk && chk.ok) });
      renderS6();
      if (!chk || !chk.ok) break;
    }
    S.sending = false; S.sendDone = true; S.busy = "";
    $("send-text").textContent = S.sendStop ? "ĐÃ DỪNG GỬI" : "Đã gửi xong " + bodies.length + " lô";
    S.sendMsg = S.sendStop ? box("bad", "ĐÃ DỪNG GỬI — không gửi các lô sau", [S.sendStop, "Đối chiếu ở bước 7 chạy ngay để biết Circa đã lưu những gì.",
      "Không gửi lại bằng trang này. Muốn gửi tiếp phần còn thiếu: xử lý nguyên nhân, tải lại trang, nạp lại file và chọn “Dùng phiên có sẵn” (mã đã có sẽ tự bỏ qua)."])
      : box("ok", "Đã gửi xong " + bodies.length + " lô, mọi lô đạt theo response. Kết quả cuối cùng là đối chiếu ở bước 7.", null);
    ev(S.sendStop ? "gui-dung" : "gui-xong", S.sendStop || null);
    renderAll();
    await reconcile();
  }

  // ---------- 7. đối chiếu ----------
  async function reconcile() {
    if (!S.target || !S.P) return;
    S.busy = "rc"; $("rc-text").textContent = "Đang tải lượt quét của phiên…"; refresh();
    var at = iso();
    var sc = await fetchScans(S.target.id);
    S.busy = "";
    if (sc.err) {
      S.rc = { at: at, err: sc.err + (authHint(sc.r) ? " " + authHint(sc.r) : ""), hasMore: !!sc.hasMore };
    } else {
      var cs = NWC.checkScans(S.P.items, sc.scans);
      var all = sumOf(sc.scans, function (s) { return Number(s.base_qty); });
      var ok = cs.ok && all === cs.sum.nwBase && cs.foreign.length === 0;
      S.rc = { at: at, scans: sc.scans, cs: cs, all: all, ok: ok };
    }
    S.rcHistory.push({ at: at, ok: S.rc.ok === true, err: S.rc.err, counts: S.rc.cs ? S.rc.cs.sum.counts : null, foreign: S.rc.cs ? S.rc.cs.foreign.length : null, all: S.rc.all });
    if (S.create || S.sendStarted) S.dirty = true;
    ev("doi-chieu", { ok: S.rc.ok === true, err: S.rc.err });
    $("rc-text").textContent = "Đối chiếu lúc " + when(at);
    renderAll();
  }
  function renderS7() {
    var out = clear($("s7-out"));
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
    var t = S.target, link = h("a", { target: "_blank", rel: "noopener noreferrer", text: "Mở phiên " + (t.code || t.id) + " trên admin" });
    link.href = ADMIN + t.id;
    out.appendChild(box(rc.ok ? "ok" : "warn", "Lưu ý", (rc.ok ? [] : reasons).concat([
      "Phiên " + (t.code || t.id) + " vẫn MỞ. Trang không đóng, không duyệt phiên.",
      "Số ghi sai KHÔNG sửa được bằng API: cho đếm lại SP đó trên Circa (admin / app quét).",
      "Tải sổ ghi ở bước 8 trước khi đóng trang."
    ]), h("div", { cls: "row" }, link)));
    // theo SP
    var spAll = cs.bySp, spBad = spAll.filter(function (p) { return p.diff !== 0 || p.problems.length || p.foreignScans || p.notSentBase; });
    var seg = h("div", { cls: "seg" });
    [[false, "SP có chênh / vấn đề (" + spBad.length + ")"], [true, "Tất cả SP (" + spAll.length + ")"]].forEach(function (x) {
      seg.appendChild(h("button", { cls: S.rcAll === x[0] ? "on" : null, on: { click: function () { S.rcAll = x[0]; renderS7(); } } }, x[1]));
    });
    out.appendChild(h("h3", { text: "Theo sản phẩm" }));
    out.appendChild(h("div", { cls: "toolbar" }, seg));
    out.appendChild(table([{ t: "Mã SP" }, { t: "Tên sản phẩm" }, { t: "Số thẻ", num: 1 }, { t: "Gốc NW", num: 1 }, { t: "Gốc Circa", num: 1 }, { t: "Lượt ngoài (gốc)", num: 1 }, { t: "Chênh", num: 1 }, { t: "Kết luận" }, { t: "Việc cần làm" }],
      (S.rcAll ? spAll : spBad).map(function (p) { return { cls: p.diff !== 0 || p.problems.length ? "flag" : null, cells: [p.pid, p.name, p.tags, p.nwBase, p.circaBase, p.foreignBase, p.diff, p.ketLuan, p.viecCanLam] }; }),
      { empty: "Không có SP nào chênh: mọi SP khớp gốc NW." }));
    var groups = [["sai-so", "Thẻ sai số"], ["sai-sp", "Thẻ sai SP"], ["thieu", "Thẻ thiếu (chưa có lượt quét)"], ["lap", "Mã có nhiều lượt"]];
    groups.forEach(function (g) {
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
    var head = ["Mã SP", "Tên sản phẩm", "Số thẻ NW", "Gốc NW", "Gốc đã gửi", "Gốc không gửi", "Gốc Circa (mã kế hoạch)", "Gốc lượt ngoài kế hoạch", "Lượt ngoài",
      "Chênh", "Đúng", "Sai số", "Sai SP", "Thiếu", "Lặp", "Kết luận", "Việc cần làm"];
    var rows = S.rc.cs.bySp.map(function (p) {
      return [p.pid, p.name, p.tags, p.nwBase, p.sentBase, p.notSentBase, p.circaBase, p.foreignBase, p.foreignScans, p.diff,
        p.status.dung, p.status["sai-so"], p.status["sai-sp"], p.status.thieu, p.status.lap, p.ketLuan, p.viecCanLam];
    });
    download("nw-sang-circa-doi-chieu-" + safeName(S.target && S.target.code) + "-" + stamp() + ".csv", csv(head, rows), "text/csv;charset=utf-8");
  }

  // ---------- 8. sổ ghi ----------
  function buildLog() {
    var p = S.parsed, P = S.P, rc = S.rc;
    return {
      congCu: VERSION, taoLuc: iso(), cheDo: CFG.test ? "THỬ — máy chủ giả " + CFG.api : "THẬT", api: CFG.api,
      ghiChu: "Sổ ghi do trang tạo. Không chứa token. Phiên Circa để MỞ.",
      cuaHang: S.store ? { key: S.store.key, name: S.store.name, pos_id: S.store.pos } : null,
      fileNW: S.file ? {
        name: S.file.name, size: S.file.size, lastModified: S.file.lastModified, sha256: S.file.sha256, napLuc: S.file.loadedAt, loi: S.fileErr || null,
        tongQuan: S.overview, khoKhop: khoMatch(),
        doc: p ? { tags: p.tags.length, nwBase: sumOf(p.tags, function (t) { return t.nwQty; }), strange: p.strange, errors: p.errors, skipped: p.skipped, warnings: p.warnings } : null
      } : null,
      traCuu: S.lookup ? { batDau: S.lookup.start, ketThuc: S.lookup.end || null, lanChay: S.lookup.runs, dung: S.lookup.abort || null, thongKe: lkStats(), res: resList() } : null,
      keHoach: P ? { sum: P.sum, bySp: P.bySp, items: P.items } : null,
      phien: {
        dich: S.target, taoPhien: S.create, hoiTrangThai: S.polls,
        viTri: { id: S.locId || null, nhan: S.locId ? locLabel(S.locId) : null, danhSach: S.locs ? S.locs.length : null }
      },
      guiLo: S.sendPlan ? { batDau: S.sendPlan.at, sessionId: S.sendPlan.sessionId, code: S.sendPlan.code, luotCoSan: S.sendPlan.scansBefore, maBoQua: S.sendPlan.excluded, dung: S.sendStop || null } : null,
      lo: S.batches.map(function (b) { return { lo: b.lo, soMa: b.codes, body: b.body, lanGui: b.attempts, resend: !!b.resend, kiem: b.check || null, dung: b.stop || null }; }),
      doiChieu: rc ? (rc.err ? { at: rc.at, loi: rc.err } : {
        at: rc.at, ok: rc.ok, gocCircaMoiLuot: rc.all, sum: rc.cs.sum, foreign: rc.cs.foreign,
        theSai: rc.cs.rows.filter(function (r) { return r.result !== "dung"; }), bySp: rc.cs.bySp
      }) : null,
      lichSuDoiChieu: S.rcHistory,
      luotQuetSauGui: rc && rc.scans ? rc.scans : null,
      suKien: S.events
    };
  }
  function scrub(text) {
    var t = token();
    if (t && t.length >= 8 && text.indexOf(t) >= 0) text = text.split(t).join("<token-đã-xoá>");
    return text;
  }
  function dlLog() {
    var name = "nw-sang-circa-" + safeName(S.target ? S.target.code || S.target.id.slice(0, 8) : "chua-co-phien") + "-" + stamp() + ".json";
    download(name, scrub(JSON.stringify(buildLog(), null, 1)), "application/json");
    S.logAt = iso();
    if (!S.sending) S.dirty = false;
    ev("tai-so-ghi", name);
    $("log-text").textContent = "Đã tải " + name + " lúc " + when(S.logAt);
    refresh();
  }

  // ---------- hộp xác nhận trong trang ----------
  var modalOpen = null;
  function confirmBox(title, lines, okText) {
    return new Promise(function (resolve) {
      var m = $("modal");
      $("modal-title").textContent = title;
      put("modal-body", h("ul", null, lines.map(function (l) { return h("li", null, l); })));
      $("modal-ok").textContent = okText || "Đồng ý";
      m.hidden = false;
      $("modal-cancel").focus();
      function done(v) {
        m.hidden = true; modalOpen = null;
        $("modal-ok").removeEventListener("click", yes); $("modal-cancel").removeEventListener("click", no);
        document.removeEventListener("keydown", esc, true);
        resolve(v);
      }
      function yes() { done(true); }
      function no() { done(false); }
      function esc(e) { if (e.key === "Escape") { e.preventDefault(); done(false); } }
      $("modal-ok").addEventListener("click", yes); $("modal-cancel").addEventListener("click", no);
      document.addEventListener("keydown", esc, true);
      modalOpen = done;
    });
  }

  // ---------- khoá / mở các bước ----------
  function gate() {
    var s1 = !!S.store && !!token() && !CFG.bad;
    var s3 = s1 && !!S.parsed && S.parsed.tags.length > 0 && !S.fileErr;
    var s4 = s3 && !!S.P;
    var s5 = s4 && S.P.sum.okToSend;
    var s6 = s5 && !!S.target && (!!S.bodies || S.sendStarted) && !S.beforeErr;
    var s7 = !!S.target && (S.sendDone || !!S.rc || !!S.rcReady || (!!S.bodies && S.bodies.length === 0));
    return { s1: s1, s2: s1, s3: s3, s4: s4, s5: s5, s6: s6, s7: s7, s8: !!S.parsed || !!S.create };
  }
  function setStep(id, open, done) {
    var c = $(id);
    c.classList.toggle("locked", !open);
    c.classList.toggle("done", !!done);
    var l = $(id + "-lock");
    if (l) l.hidden = open;
  }
  function refresh() {
    var g = gate(), busy = !!S.busy, wrote = !!S.create || S.sendStarted, fixed = wrote || !!S.target;
    setStep("s1", !CFG.bad, g.s1);
    setStep("s2", g.s2, g.s3);
    setStep("s3", g.s3, g.s4);
    setStep("s4", g.s4, g.s5);
    setStep("s5", g.s5, g.s6);
    setStep("s6", g.s6, S.sendDone && !S.sendStop);
    setStep("s7", g.s7, S.rc && S.rc.ok);
    setStep("s8", g.s8, !!S.logAt && !S.dirty);
    $("store").disabled = busy || fixed || !!CFG.bad;
    $("token").disabled = S.sending || !!CFG.bad;
    $("file").disabled = !g.s2 || busy || fixed;
    $("drop").classList.toggle("off", $("file").disabled);
    $("btn-lookup").disabled = !g.s3 || busy || fixed;
    $("btn-lookup-retry").disabled = !g.s3 || busy || fixed;
    var pick = !g.s5 || busy || !!S.target;
    $("loc").disabled = pick || S.createLocked;
    $("btn-locs").disabled = pick || S.createLocked;
    $("btn-create").disabled = pick || S.createLocked || !S.locId;
    $("sess-in").disabled = pick;
    $("btn-sess").disabled = pick;
    $("btn-current").disabled = pick;
    var un = $("btn-unset");
    if (un) un.disabled = busy || S.sendStarted;
    $("btn-send").disabled = !g.s6 || busy || S.sendStarted || !S.bodies || !S.bodies.length;
    $("btn-recheck").disabled = !g.s7 || busy;
    $("btn-log").disabled = !g.s8;
    $("btn-rc-csv").disabled = !(S.rc && S.rc.cs) || busy;
    var pv = $("btn-pv-csv");
    if (pv) pv.disabled = !S.P;
    document.querySelectorAll("#s4-out button, #s7-out .seg button").forEach(function (b) { if (b.id !== "btn-pv-csv") b.disabled = false; });
    if (S.sending) document.querySelectorAll("main button, main input, main select").forEach(function (e) { e.disabled = true; });
    if (S.dirty && !S.sending) $("log-text").textContent = "Chưa tải sổ ghi cho lần ghi gần nhất — tải trước khi đóng trang.";
  }
  function renderAll() {
    renderS2(); renderS3(); renderS4(); renderS5(); renderS6(); renderS7(); refresh();
  }

  // ---------- khởi động ----------
  function init() {
    if (!NWC || !XLSX) { put("fatal", "Thiếu thư viện (NWC / XLSX). File HTML bị hỏng: build lại."); $("fatal").hidden = false; return; }
    if (CFG.test) {
      var tb = $("testbar");
      tb.hidden = false;
      put("testbar", "CHẾ ĐỘ THỬ — máy chủ giả " + CFG.api, h("small", { text: "Không gửi gì lên Circa thật. timeout " + CFG.timeout + " ms · chờ OPEN tối đa " + CFG.pollMax + " ms · hỏi mỗi " + CFG.pollEvery + " ms" }));
      document.title = "[THỬ] " + document.title;
    }
    if (CFG.bad) {
      put("fatal", "Tham số ?api= không hợp lệ (" + CFG.bad + "). Chỉ nhận http://localhost:<cổng> hoặc http://127.0.0.1:<cổng> cho kiểm thử. Bỏ tham số này khỏi địa chỉ trang để dùng Circa thật.");
      $("fatal").hidden = false;
    }
    $("store").addEventListener("change", onStore);
    $("token").addEventListener("input", refresh);
    $("file").addEventListener("change", function () { var f = this.files && this.files[0]; this.value = ""; loadFile(f); });
    var drop = $("drop");
    drop.addEventListener("dragover", function (e) { e.preventDefault(); if (!$("file").disabled) drop.classList.add("over"); });
    drop.addEventListener("dragleave", function () { drop.classList.remove("over"); });
    drop.addEventListener("drop", function (e) {
      e.preventDefault(); drop.classList.remove("over");
      if ($("file").disabled) return;
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      loadFile(f);
    });
    // thả file ra ngoài ô: không cho trình duyệt mở file (mất trạng thái trang)
    window.addEventListener("dragover", function (e) { e.preventDefault(); });
    window.addEventListener("drop", function (e) { e.preventDefault(); });
    $("btn-lookup").addEventListener("click", function () { runLookup(false); });
    $("btn-lookup-retry").addEventListener("click", function () { runLookup(true); });
    $("loc").addEventListener("change", function () { S.locId = this.value; renderS5(); refresh(); });
    $("btn-locs").addEventListener("click", loadLocs);
    $("btn-create").addEventListener("click", onCreate);
    $("btn-sess").addEventListener("click", onCheckSession);
    $("btn-current").addEventListener("click", onCurrent);
    $("btn-send").addEventListener("click", onSend);
    $("btn-recheck").addEventListener("click", reconcile);
    $("btn-log").addEventListener("click", dlLog);
    $("btn-rc-csv").addEventListener("click", dlRcCsv);
    window.addEventListener("beforeunload", function (e) {
      if (S.sending || S.dirty) { e.preventDefault(); e.returnValue = ""; return ""; }
    });
    if (CFG.test) {
      // chỉ chế độ thử: số liệu để test-ui.js khẳng định (không có token)
      window.__NWC_TEST__ = {
        summary: function () {
          return {
            busy: S.busy, sending: S.sending, sendStarted: S.sendStarted, sendDone: S.sendDone, sendStop: S.sendStop,
            lookup: S.lookup ? { abort: S.lookup.abort, stats: lkStats() } : null,
            plan: S.P ? { okToSend: S.P.sum.okToSend, modes: S.P.sum.modes, blockers: S.P.sum.blockers, nwBase: S.P.sum.nwBase, batches: S.P.sum.batches } : null,
            parse: S.parsed ? { tags: S.parsed.tags.length, errors: S.parsed.errors.length, strange: S.parsed.strange.length } : null, fileErr: S.fileErr,
            target: S.target, createLocked: S.createLocked, create: S.create ? { status: S.create.status } : null,
            bodies: S.bodies ? { n: S.bodies.length, excluded: S.bodies.excluded.length } : null,
            batches: S.batches.map(function (b) { return { lo: b.lo, codes: b.codes, tries: b.attempts.length, ok: !!(b.check && b.check.ok), stop: b.stop || null, bad: b.check ? b.check.bad.map(function (r) { return r.code; }) : [] }; }),
            rc: S.rc ? (S.rc.err ? { err: S.rc.err } : { ok: S.rc.ok, counts: S.rc.cs.sum.counts, foreign: S.rc.cs.foreign.length, all: S.rc.all, nwBase: S.rc.cs.sum.nwBase, scans: S.rc.scans.length, bad: S.rc.cs.rows.filter(function (r) { return r.result !== "dung"; }).map(function (r) { return { code: r.code, result: r.result }; }) }) : null,
            dirty: S.dirty
          };
        }
      };
    }
    renderAll();
  }
  init();
})();
