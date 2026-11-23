/* Extension "Kiểm kê Circa ↔ NW" v0.2.1: TRANG GỬI SANG CIRCA (panel.js). Mở từ nút "Gửi sang Circa" trên trang danh sách đối chiếu NW.
 * Mọi lệnh gọi mạng đi qua background (bg()); trang không fetch (CSP connect-src 'none'). Quy tắc gửi thẻ nằm trong core.js (NWC, dùng
 * nguyên) và chon.js (KKCHON: chọn SP / thẻ / phiên nguồn). DOM chỉ dùng textContent. Không alert/confirm của trình duyệt.
 *
 * Luồng:
 *   1. Danh sách phiên Circa (GET …/count/sessions?page&limit=20, ≤ 10 trang), lọc status OPEN → chọn ĐÚNG MỘT (radio).
 *      Kiểm: GET phiên (OPEN, đúng id / pos_id), quyền inventory_count.manage (không đọc được → ghi chú, không chặn).
 *   2. Ghép kho NW theo tên cửa hàng (pos_name) của phiên Circa (KKCHON.matchWarehouse). Danh sách phiên NW (≤ 8 trang; không đọc được
 *      totalPages → lỗi), chỉ phiên in_progress của đúng kho → chọn nhiều (checkbox).
 *   3. Xem trước: mỗi phiên NW: GET phiên (vẫn in_progress, đúng kho) + file xuất → "Danh sách kiểm kê" + NWC.parseSession("Chi tiết quét")
 *      → KKCHON.analyzeSession → KKCHON.choose (1 phiên nguồn / SP) → tra qr-lookup (pos_id phiên Circa) → lượt quét đã lưu →
 *      KKCHON.finish (để riêng SP có thẻ không gửi được / phiên Circa đã có lượt quét khác) → NWC.batches (bỏ mã đã có).
 *      Lượt quét đã lưu (KKCHON.readScans, fail-closed, v0.2.1): summary.total_scans → MỘT request scans?limit=60000 (không offset, không
 *      lật trang) → summary lần nữa; chỉ dùng khi has_more = false, tổng trước = tổng sau = số id khác nhau, mọi lượt có id và product_id
 *      đọc được. has_more = true → dừng (phiên nhiều lượt hơn một lần đọc). Trùng id / lệch tổng → đọc lại (≤ SCAN_READ_TRIES lần); vẫn
 *      hỏng / lỗi khác → không lập kế hoạch, không gửi, đối chiếu "chưa đối chiếu được".
 *   4. Gửi: GET lại phiên Circa (phải OPEN) + tải lại lượt quét, tính lại → xác nhận trong trang → khoá gửi theo phiên Circa (background)
 *      → GET lại phiên + lượt quét, tính lại LẦN NỮA: tập lô khác kế hoạch vừa xác nhận → nhả khoá, vẽ lại xem trước, không gửi.
 *      ≤ 100 mã/lô, tuần tự, gửi lại NGUYÊN lô chỉ khi 5xx / timeout / lỗi mạng (≤ SUBMIT_RETRIES lần); 4xx → dừng; mất cổng background
 *      hoặc ngoại lệ bất ngờ giữa lô → "KHÔNG RÕ", không gửi lại. Mọi đường ra nhả khoá (finally); đã gửi lô nào thì vẫn đối chiếu.
 *   5. Đối chiếu bằng sessions/<id>/scans (chỉ SP đã gửi). 6. Sổ ghi JSON (không có token).
 */
(function () {
  "use strict";
  var CFG0 = window.KKCFG, NWC = window.NWC, XLSX = window.XLSX, CH = window.KKCHON;
  var NEED_COLS = ["Mã SP", "EPC", "UID", "Số lượng thẻ", "ĐVT", "Trạng thái"];
  var SHEETS = ["Danh sách kiểm kê", "Chi tiết quét", "Thẻ lạ"];
  var CODE_RE = /^[A-Za-z0-9_-]{1,200}$/;
  var VERSION = "kiem-ke-circa-nw-ext panel " + (CFG0 ? CFG0.VERSION : "?");

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
  function when(s) { if (!s) return ""; var t = Date.parse(s); return isFinite(t) ? new Date(t).toLocaleString("vi-VN") : String(s); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function key(c) { return NWC._codeKey(c); }
  function fold(s) { return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().trim(); }
  function sumOf(a, f) { return a.reduce(function (t, x) { var v = f(x); return t + (typeof v === "number" && isFinite(v) ? v : 0); }, 0); }
  function short8(id) { return String(id || "").slice(0, 8); }
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
    rows.slice(0, lim).concat(opts.foot || []).forEach(function (r) {
      var cells = Array.isArray(r) ? r : r.cells;
      var tr = h("tr", { cls: Array.isArray(r) ? null : r.cls, "data-pid": Array.isArray(r) ? null : r.pid }, cells.map(function (v, i) {
        var c = cols[i] || {};
        return h("td", { cls: c.num ? "num" : c.code ? "code" : null }, c.num && typeof v === "number" ? fmt(v) : typeof v === "number" ? String(v) : v);
      }));
      tb.appendChild(tr);
    });
    var wrap = h("div", { cls: "tablewrap" }, h("table", { cls: opts.small ? "small" : null },
      h("thead", null, h("tr", null, cols.map(function (c) { return h("th", { cls: c.num ? "num" : null, text: c.t }); }))), tb));
    if (!rows.length) wrap.appendChild(h("div", { cls: "more", text: opts.empty || "Không có dòng nào." }));
    if (rows.length > lim) wrap.appendChild(h("div", { cls: "more", text: "Hiện " + fmt(lim) + " / " + fmt(rows.length) + " dòng. Dùng ô tìm hoặc tải CSV / sổ ghi để xem hết." }));
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
    cfg: null,
    cl: null, sel: null, chk: null,                       // 1. danh sách phiên Circa, phiên đã chọn, kết quả kiểm
    nwl: null, nwSel: {},                                  // 2. danh sách phiên NW đúng kho, phiên NW đã chọn
    pv: null, pick: null, codes: [], res: {}, lookup: null, fin: null, pvRows: null, pvFilter: "all", pvQ: "",
    before: null, beforeAt: null, beforeErr: "", bodies: null,
    sendStarted: false, sending: false, sendDone: false, sendStop: "", sendAt: null, sendMsg: null, sendPlan: null, batches: [], rcReady: false,
    rc: null, rcAll: false, rcHistory: [], events: [], busy: "", dirty: false, logAt: null,
    scanRead: null, scanReads: []                           // lần đọc lượt quét ĐẠT gần nhất; mọi lần đọc (sổ ghi)
  };
  function ev(what, info) { S.events.push({ at: iso(), what: what, info: info == null ? undefined : info }); }

  // ---------- nhắn background ----------
  // → {status, j, badJson, raw, ms, err, msg} (status 0 = không gửi được / lỗi mạng / timeout). Lỗi phía extension:
  //   bg-dead    sendMessage ném lỗi ngay (extension đã tải lại): tin CHƯA rời trang → chắc chắn chưa gửi
  //   bg-refused background trả lời ok:false (từ chối rõ ràng, chưa gọi mạng) → chắc chắn chưa gửi
  //   bg-lost    cổng tin đóng / không có trả lời (service worker chết giữa chừng): KHÔNG RÕ lệnh đã đi chưa
  function bgRaw(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          if (chrome.runtime.lastError) return resolve({ lost: true, msg: chrome.runtime.lastError.message });
          resolve(resp || { lost: true, msg: "background không trả lời" });
        });
      } catch (e) { resolve({ dead: true, msg: String(e && e.message || e) }); }
    });
  }
  async function bg(op, extra) {
    var resp = await bgRaw(Object.assign({ op: op }, extra || {}));
    if (resp.dead) return { status: 0, err: "bg-dead", msg: resp.msg };
    if (resp.lost) return { status: 0, err: "bg-lost", msg: resp.msg };
    if (!resp.ok) return { status: 0, err: "bg-refused", msg: resp.msg || "background từ chối" };
    return resp.r || resp;
  }
  // lệnh gắn với phiên Circa đã chọn: id + pos_id của phiên đó
  function sesArgs(extra) { return Object.assign({ id: S.sel.id, pos: S.sel.pos_id }, extra || {}); }
  function firstErr(r) { return r && r.j && Array.isArray(r.j.errors) && r.j.errors[0] && typeof r.j.errors[0] === "object" ? r.j.errors[0] : null; }
  function errCode(r) { var e = firstErr(r); return e && e.code != null ? String(e.code) : ""; }
  // lệnh CHẮC CHẮN chưa rời máy → không gửi lại, ghi "chưa gửi". bg-lost KHÔNG có ở đây: không rõ đã gửi chưa (cũng không gửi lại).
  var NOSEND = { "no-tab": 1, "no-token": 1, "token-expired": 1, "blocked": 1, "no-store": 1, "bg-refused": 1, "bg-dead": 1 };
  var BG_ERR = { "bg-lost": 1, "bg-refused": 1, "bg-dead": 1 };
  function errInfo(r) {
    if (!r) return "không có phản hồi";
    if (r.status === 0) {
      if (r.err === "timeout") return "quá " + Math.round((typeof r.timeoutMs === "number" ? r.timeoutMs : S.cfg ? S.cfg.timeout : 30000) / 1000) + " giây không có phản hồi (timeout)";
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
  function withHint(r, side) { var x = authHint(r, side); return errInfo(r) + (x ? " " + x : ""); }
  function sessOf(r) { var d = r && r.status === 200 && r.j && r.j.data; return d && typeof d === "object" ? (d.session && typeof d.session === "object" ? d.session : d) : null; }
  function recOf(r) { var j = r && r.status === 200 && r.j; if (!j || typeof j !== "object") return null; return j.id != null ? j : j.data && typeof j.data === "object" && j.data.id != null ? j.data : null; }
  // TOÀN BỘ lượt quét đã lưu của phiên Circa, fail-closed (KKCHON.readScans, chon.js): summary (total_scans) → MỘT request lượt quét
  // (background: limit=SCAN_LIMIT, không offset) → summary lần nữa; chỉ ĐẠT khi has_more = false, tổng trước = tổng sau = số id khác nhau,
  // mọi lượt có id và product_id đọc được. Trùng id / lệch tổng → đọc lại (≤ SCAN_READ_TRIES lần). has_more = true → dừng, không đọc lại.
  // Không ĐẠT → lỗi: KHÔNG lập kế hoạch, không gửi, không đối chiếu. Dùng ở 3 chỗ: xem trước, đọc lại sau khi giữ khoá gửi, đối chiếu sau gửi.
  // Không bao giờ ném lỗi (ngoại lệ bất ngờ → {err}).
  // → {scans} | {err, r, hasMore, kind}
  async function fetchScans(where) {
    var at = iso(), res;
    try {
      res = await CH.readScans({
        summary: function () { return bg("scanSummary", sesArgs()); },
        scans: function () { return bg("scans", sesArgs()); },
        sleep: sleep
      }, { tries: S.cfg.scanTries, gapMs: S.cfg.scanGap, errInfo: errInfo });
    } catch (e) {
      res = { ok: false, kind: "loi", attempts: [], msg: "Lỗi bất ngờ khi đọc lượt quét của phiên Circa: " + String((e && e.message) || e).slice(0, 200) };
    }
    var att = (res.attempts || []).map(function (a) { return { lan: a.lan, t1: a.t1, t2: a.t2, rows: a.rows, ids: a.ids, dup: a.dup, bytes: a.bytes == null ? undefined : a.bytes, why: a.why || undefined }; });
    var rec = { at: at, where: where || "", ok: !!res.ok, kind: res.ok ? undefined : res.kind, reads: att.length, n: res.ok ? res.scans.length : undefined, total: res.ok ? res.total : undefined,
      attempts: att, msg: res.ok ? undefined : res.msg, samples: res.samples };
    S.scanReads.push(rec);
    if (S.scanReads.length > 100) S.scanReads.shift();
    ev(res.ok ? "doc-luot-quet" : "doc-luot-quet-loi", { where: where, reads: att.length, n: rec.n, kind: rec.kind });
    if (res.ok) {
      var last = att[att.length - 1] || {};
      S.scanRead = { at: at, n: res.scans.length, total: res.total, reads: att.length, bytes: last.bytes };
      return { scans: res.scans };
    }
    return { err: res.msg, r: res.r, kind: res.kind, hasMore: res.kind === "more" };
  }
  // gợi ý bấm lại sau lỗi đọc lượt quét; has_more = true (phiên nhiều lượt hơn một lần đọc trả về) thì bấm lại cũng không đủ → không nhắc
  function scanAgain(sc, text) { return sc && sc.kind === "more" ? "" : " " + text; }

  // ---------- đặt lại phần sau ----------
  function resetPreview() {
    S.pv = null; S.pick = null; S.codes = []; S.res = {}; S.lookup = null; S.fin = null; S.pvRows = null;
    S.before = null; S.beforeAt = null; S.beforeErr = ""; S.bodies = null; S.sendMsg = null;
  }
  function resetNw() { S.nwl = null; S.nwSel = {}; resetPreview(); }
  function resetPick() { S.chk = null; resetNw(); }

  // ---------- 1. danh sách phiên Circa ----------
  async function loadCircaList() {
    if (S.busy || S.sendStarted) return;
    S.busy = "circa"; S.sel = null; resetPick();
    $("circa-text").textContent = "Đang tải danh sách phiên Circa…"; renderAll();
    var all = [], seen = {}, dup = 0, skipped = 0, total = null, read = 0, err = "", lim = S.cfg.circaLimit;
    for (var page = 1; page <= S.cfg.circaPages; page++) {
      var r = await bg("circaList", { page: page });
      if (r.status !== 200) { err = "Không đọc được danh sách phiên Circa (trang " + page + "): " + withHint(r, "circa"); break; }
      var L = CH.circaListOf(r.j);
      if (!L) { err = "Danh sách phiên Circa (trang " + page + ") không đúng dạng (thiếu data.list)."; break; }
      if (L.total == null) { err = "Danh sách phiên Circa không cho biết tổng số phiên (data.total): không đoán số trang."; break; }
      total = L.total; read = page;
      L.list.forEach(function (x) {
        var c = CH.circaRow(x);
        if (!c) { skipped++; return; }
        if (seen[c.id]) { dup++; return; }
        seen[c.id] = 1; all.push(c);
      });
      if (page * lim >= total || !L.list.length) break;
    }
    var rows = err ? [] : all.filter(function (x) { return x.status === "OPEN"; }).sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
    S.cl = { at: iso(), rows: rows, read: all.length, pages: read, total: total, more: !err && total != null && read * lim < total, dup: dup, skipped: skipped, err: err };
    ev("ds-phien-circa", { open: rows.length, read: all.length, pages: read, total: total, err: err || undefined });
    S.busy = "";
    renderAll();
  }
  async function onPick(id) {
    if (S.busy || S.sendStarted) { renderS1(); return; }
    var row = S.cl && S.cl.rows.filter(function (x) { return x.id === id; })[0];
    if (!row) return;
    S.sel = row; resetPick();
    ev("chon-phien-circa", { id: row.id, code: row.code });
    await runCheck();
    if (S.chk && !blockNw()) await loadNw();
  }
  async function runCheck() {
    S.busy = "check"; renderAll();
    var sel = S.sel, c = { at: iso(), problems: [], notes: [], session: null, authz: null, storeName: "" };
    var rs = await bg("circaSession", sesArgs());
    var s = sessOf(rs);
    if (!s) c.problems.push("Không đọc được phiên Circa: " + withHint(rs, "circa"));
    else {
      c.session = { id: String(s.id || ""), code: String(s.code || ""), status: String(s.status || ""), pos_id: String(s.pos_id || ""), pos_name: String(s.pos_name || ""), counting_mode: String(s.counting_mode || ""), created_at: s.created_at || null };
      if (c.session.id.toLowerCase() !== sel.id) c.problems.push("Circa trả phiên khác id.");
      if (c.session.status !== "OPEN") c.problems.push("Phiên Circa " + (c.session.code || sel.code) + " đang " + (c.session.status || "(không rõ)") + ", không phải OPEN: không gửi được.");
      if (c.session.pos_id.toLowerCase() !== sel.pos_id) c.problems.push("Phiên Circa thuộc cửa hàng khác với danh sách.");
      if (c.session.pos_name && sel.pos_name && CH.normName(c.session.pos_name) !== CH.normName(sel.pos_name)) c.problems.push("Tên cửa hàng của phiên (“" + c.session.pos_name + "”) khác tên trong danh sách (“" + sel.pos_name + "”).");
    }
    c.storeName = sel.pos_name || (c.session && c.session.pos_name) || "";
    if (!c.storeName) c.problems.push("Phiên Circa không có tên cửa hàng (pos_name): không ghép được kho NW.");
    var ra = await bg("circaAuthz", sesArgs());
    c.authz = { status: ra.status, manage: ra.manage === undefined ? null : ra.manage, view: ra.view === undefined ? null : ra.view };
    if (ra.status !== 200) c.notes.push("Không kiểm được quyền Circa (" + errInfo(ra) + "): không chặn, Circa sẽ tự từ chối nếu thiếu quyền.");
    else if (ra.manage === false) c.problems.push("Tài khoản Circa không có quyền inventory_count.manage: không gửi được (vẫn xem trước được).");
    else if (ra.manage !== true) c.notes.push("Không kiểm được quyền (không đọc được danh sách quyền Circa): không chặn.");
    S.busy = "";
    if (sel !== S.sel) return;
    S.chk = c;
    ev("kiem-phien-circa", { problems: c.problems.length, authz: c.authz });
    renderAll();
  }
  function blockNw() { return !S.chk || S.chk.problems.some(function (p) { return !/inventory_count\.manage/.test(p); }); }
  function blockSend() { return !S.chk || S.chk.problems.length > 0; }
  function renderS1() {
    var cl = S.cl, out = clear($("s1-out"));
    if (cl) {
      $("circa-text").textContent = S.busy === "circa" ? "Đang tải…" : cl.err ? "" : "Đọc " + fmt(cl.read) + " phiên (" + cl.pages + " trang, tổng " + fmt(cl.total) + ") lúc " + when(cl.at) + " · đang mở: " + fmt(cl.rows.length);
      if (cl.err) out.appendChild(box("bad", "Không tải được danh sách phiên Circa", [cl.err]));
      var warn = [];
      if (cl.more) warn.push("Còn phiên chưa đọc: chỉ đọc " + cl.pages + " trang đầu (tối đa " + S.cfg.circaPages + " trang × " + S.cfg.circaLimit + "). Phiên Circa mở cũ hơn có thể không có trong danh sách.");
      if (cl.dup) warn.push(fmt(cl.dup) + " dòng trùng id giữa các trang (đã bỏ trùng).");
      if (cl.skipped) warn.push(fmt(cl.skipped) + " dòng có id / pos_id không hợp lệ (bỏ qua).");
      if (warn.length) out.appendChild(box("warn", "Lưu ý", warn));
      if (!cl.err) {
        var dis = !!S.busy || S.sendStarted;
        out.appendChild(table([{ t: "" }, { t: "Mã phiên" }, { t: "Cửa hàng" }, { t: "Ngày tạo" }, { t: "Người tạo" }, { t: "Phương thức" }],
          cl.rows.map(function (x) {
            var r = h("input", { type: "radio", name: "circa", value: x.id, "aria-label": "Chọn phiên " + x.code, disabled: dis });
            r.checked = !!S.sel && S.sel.id === x.id;
            r.addEventListener("change", function () { if (r.checked) onPick(x.id); });
            return { pid: x.id, cls: S.sel && S.sel.id === x.id ? "sel" : null, cells: [r, x.code, x.pos_name, when(x.created_at), x.created_by_name, x.counting_mode] };
          }), { small: 1, empty: "Không có phiên kiểm kê Circa nào đang mở (OPEN)." }));
      }
    }
    var co = clear($("s1-chk")), c = S.chk;
    if (S.busy === "check") { co.appendChild(h("p", { cls: "note", text: "Đang kiểm phiên " + (S.sel ? S.sel.code : "") + "…" })); return; }
    if (!c || !S.sel) return;
    var ok = [];
    if (c.session) ok.push("Phiên Circa " + (c.session.code || S.sel.code) + ": " + c.session.status + " · phương thức " + c.session.counting_mode + " · cửa hàng " + c.storeName);
    ok.push("Quyền Circa inventory_count.manage: " + (c.authz && c.authz.manage === true ? "có" : c.authz && c.authz.manage === false ? "KHÔNG" : "không kiểm được"));
    if (c.problems.length) co.appendChild(box("bad", "Phiên Circa chưa dùng được", c.problems));
    co.appendChild(box(c.problems.length ? "info" : "ok", c.problems.length ? "Kết quả kiểm" : "Phiên Circa đạt", ok.concat(c.notes)));
  }

  // ---------- 2. phiên NW ----------
  async function loadNw() {
    if (S.busy || S.sendStarted || !S.sel || blockNw()) return;
    S.busy = "nw"; resetNw();
    $("nw-text").textContent = "Đang tải danh sách kho và phiên NW…"; renderAll();
    var sel = S.sel, o = { at: iso(), wh: null, rows: [], read: 0, pages: 0, totalPages: null, more: false, other: 0, skipped: 0, dup: 0, err: "", candidates: [] };
    var wr = await bg("nwWarehouses");
    if (wr.status !== 200) o.err = "Không đọc được danh sách kho NW: " + withHint(wr, "nw");
    else {
      var wl = CH.warehousesOf(wr.j);
      if (!wl.list) o.err = "Không đọc được danh sách kho NW: " + wl.why + ".";
      else {
        var m = CH.matchWarehouse(S.chk.storeName, wl.list);
        if (!m.ok) {
          o.candidates = m.candidates || [];
          o.err = m.why === "many" ? "Có " + m.count + " kho NW (tính cả kho con) cùng tên “" + S.chk.storeName + "”: không biết chọn kho nào. Đổi tên trên NW cho còn đúng 1 kho rồi bấm “Tải lại danh sách”."
            : "Không có kho NW (loại warehouse, đang mở, mọi cấp) trùng tên cửa hàng “" + S.chk.storeName + "”. Đặt tên kho NW đúng tên cửa hàng rồi bấm “Tải lại danh sách”.";
        } else o.wh = m.wh;
      }
    }
    if (o.wh) {
      var seen = {};
      for (var page = 1; page <= S.cfg.recPages; page++) {
        var r = await bg("nwRecList", { page: page });
        if (r.status !== 200) { o.err = "Không đọc được danh sách phiên NW (trang " + page + "): " + withHint(r, "nw"); break; }
        var L = CH.recListOf(r.j);
        if (!L) { o.err = "Danh sách phiên NW (trang " + page + ") không đúng dạng (thiếu data)."; break; }
        if (L.totalPages == null) { o.err = "Danh sách phiên NW không cho biết tổng số trang (totalPages): không đoán, không hiện danh sách."; break; }
        o.totalPages = L.totalPages; o.pages = page;
        L.list.forEach(function (x) {
          var id = x && typeof x === "object" ? CH.cleanId(String(x.id || "")) : "";
          if (!id) { o.skipped++; return; }
          if (seen[id]) { o.dup++; return; }
          seen[id] = 1; o.read++;
          if (x.status === "in_progress" && CH.recWarehouseId(x) === o.wh.id) {
            var w = x.warehouse && typeof x.warehouse === "object" ? x.warehouse : {};
            o.rows.push({ id: id, status: String(x.status), createdAt: x.createdAt == null ? "" : String(x.createdAt), warehouseName: w.name == null ? o.wh.name : String(w.name),
              scopeType: x.scopeType == null ? "" : String(x.scopeType), notes: x.notes == null ? "" : String(x.notes) });
          } else o.other++;
        });
        if (page >= L.totalPages) break;
      }
      if (o.err) o.rows = [];
      o.more = !o.err && o.totalPages != null && o.pages < o.totalPages;
      o.rows.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
    }
    S.busy = "";
    if (sel !== S.sel) return;
    S.nwl = o;
    ev("ds-phien-nw", { wh: o.wh, rows: o.rows.length, pages: o.pages, totalPages: o.totalPages, err: o.err || undefined });
    renderAll();
  }
  function nwIds() { return S.nwl ? S.nwl.rows.filter(function (x) { return S.nwSel[x.id]; }).map(function (x) { return x.id; }) : []; }
  function renderS2() {
    var out = clear($("s2-out")), o = S.nwl;
    if (!o) { $("nw-text").textContent = S.busy === "nw" ? "Đang tải danh sách kho và phiên NW…" : ""; return; }
    $("nw-text").textContent = o.wh ? "Kho NW “" + o.wh.name + "” (" + short8(o.wh.id) + ") · " + fmt(o.rows.length) + " phiên đang kiểm · đọc " + o.pages + "/" + (o.totalPages == null ? "?" : o.totalPages) + " trang" : "";
    if (o.err) out.appendChild(box("bad", "Không lấy được danh sách phiên NW", [o.err].concat(o.candidates.length ? ["Kho NW đang có: " + o.candidates.join(", ")] : [])));
    var warn = [];
    if (o.more) warn.push("Còn phiên NW chưa đọc: chỉ đọc " + o.pages + "/" + o.totalPages + " trang đầu (tối đa " + S.cfg.recPages + " trang × " + S.cfg.recLimit + ").");
    if (o.dup) warn.push(fmt(o.dup) + " dòng trùng id giữa các trang (đã bỏ trùng).");
    if (o.skipped) warn.push(fmt(o.skipped) + " phiên có id không hợp lệ (bỏ qua).");
    if (warn.length) out.appendChild(box("warn", "Lưu ý", warn));
    if (o.err) return;
    var dis = !!S.busy || S.sendStarted;
    out.appendChild(table([{ t: "" }, { t: "Ngày tạo" }, { t: "Mã phiên" }, { t: "Kho" }, { t: "Phạm vi" }, { t: "Ghi chú" }],
      o.rows.map(function (x) {
        var c = h("input", { type: "checkbox", "data-nw": x.id, "aria-label": "Chọn phiên NW " + short8(x.id), disabled: dis });
        c.checked = !!S.nwSel[x.id];
        c.addEventListener("change", function () { if (S.busy || S.sendStarted) { c.checked = !!S.nwSel[x.id]; return; } S.nwSel[x.id] = c.checked; resetPreview(); renderAll(); });
        return { pid: x.id, cells: [c, when(x.createdAt), short8(x.id), x.warehouseName, x.scopeType, x.notes] };
      }), { small: 1, empty: "Không có phiên NW nào đang kiểm (in_progress) của kho này." }));
    $("pv-text").textContent = nwIds().length ? "Đã chọn " + nwIds().length + " phiên NW" : "Chọn ít nhất một phiên NW";
  }

  // ---------- 3. xem trước ----------
  function headerRow(ws) {
    var a = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false, blankrows: false });
    return a.length ? a[0].map(function (x) { return String(x); }) : null;
  }
  function b64ToBytes(b) { var s = atob(b), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  // đọc 1 phiên NW đã chọn → {file, a (analyzeSession)} | {err}
  async function readNw(row) {
    var f = { id: row.id, createdAt: row.createdAt, at: iso(), size: null, sha256: null, ms: null };
    var rr = await bg("nwRec", { nwId: row.id }), n = recOf(rr);
    if (!n) return { file: f, err: "Không đọc được phiên NW " + short8(row.id) + ": " + withHint(rr, "nw") };
    if (CH.cleanId(String(n.id || "")) !== row.id) return { file: f, err: "NW trả phiên khác id cho " + short8(row.id) + "." };
    if (n.status !== "in_progress") return { file: f, err: "Phiên NW " + short8(row.id) + " đang “" + (n.status || "(không rõ)") + "”, không còn in_progress: bỏ chọn phiên này rồi bấm “Xem trước” lại." };
    if (CH.recWarehouseId(n) !== S.nwl.wh.id) return { file: f, err: "Phiên NW " + short8(row.id) + " không thuộc kho “" + S.nwl.wh.name + "”." };
    var r = await bg("nwExport", { nwId: row.id });
    f.size = r.size || null; f.ms = r.ms || null;
    if (r.status !== 200 || typeof r.b64 !== "string") return { file: f, err: "Không tải được file xuất phiên NW " + short8(row.id) + ": " + withHint(r, "nw") };
    var bytes = b64ToBytes(r.b64);
    try {
      var dg = await crypto.subtle.digest("SHA-256", bytes);
      f.sha256 = Array.prototype.map.call(new Uint8Array(dg), function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    } catch (e) { f.sha256 = null; }
    var wb;
    try { wb = XLSX.read(bytes, { type: "array" }); } catch (e) { return { file: f, err: "File xuất phiên NW " + short8(row.id) + " không đọc được (" + (e && e.message || e) + ")." }; }
    var miss = SHEETS.filter(function (s) { return !wb.Sheets[s]; });
    if (miss.length) return { file: f, err: "File xuất phiên NW " + short8(row.id) + " thiếu sheet " + miss.map(function (s) { return "“" + s + "”"; }).join(", ") + ". Sheet có: " + (wb.SheetNames.join(", ") || "(không có)") + "." };
    var ct = XLSX.utils.sheet_to_json(wb.Sheets["Chi tiết quét"], { defval: "" });
    var hd = headerRow(wb.Sheets["Chi tiết quét"]) || [], have = {};
    hd.forEach(function (c) { have[NWC._norm(c)] = 1; });
    var missCol = NEED_COLS.filter(function (c) { return !have[NWC._norm(c)]; });
    if (missCol.length && ct.length) return { file: f, err: "Sheet “Chi tiết quét” của phiên " + short8(row.id) + " thiếu cột " + missCol.map(function (c) { return "“" + c + "”"; }).join(", ") + "." };
    var hl = headerRow(wb.Sheets["Thẻ lạ"]);
    if (hl && !hl.some(function (c) { return NWC._norm(c) === NWC._norm("EPC"); })) return { file: f, err: "Sheet “Thẻ lạ” của phiên " + short8(row.id) + " không có cột “EPC”." };
    var la = XLSX.utils.sheet_to_json(wb.Sheets["Thẻ lạ"], { defval: "" });
    var ds = XLSX.utils.sheet_to_json(wb.Sheets["Danh sách kiểm kê"], { defval: "" });
    var parsed;
    try { parsed = NWC.parseSession(ct, la); } catch (e) { return { file: f, err: "Lỗi khi đọc phiên " + short8(row.id) + ": " + (e && e.message || e) }; }
    var a = CH.analyzeSession({ id: row.id, createdAt: row.createdAt }, ds, ct, parsed);
    f.tags = parsed.tags.length; f.strange = parsed.strange.length; f.parse = { errors: parsed.errors.length, skipped: parsed.skipped.length, warnings: parsed.warnings.length };
    f.counts = a.counts; f.eligible = Object.keys(a.eligible).length; f.aside = a.aside.length; f.khopZero = a.khopZero; f.notInDs = a.notInDs; f.warn = a.warn; f.fatal = a.fatal || "";
    return { file: f, a: a };
  }
  async function onPreview() {
    var ids = nwIds();
    if (S.busy || S.sendStarted || !ids.length || !S.nwl || !S.nwl.wh || blockNw()) return;
    resetPreview();
    S.busy = "preview"; S.pv = { at: iso(), ids: ids, files: [], err: "" };
    ev("xem-truoc", { nw: ids });
    renderAll();
    var analyses = [];
    for (var i = 0; i < ids.length; i++) {
      var row = S.nwl.rows.filter(function (x) { return x.id === ids[i]; })[0];
      $("pv-text").textContent = "Đang tải phiên NW " + (i + 1) + "/" + ids.length + " (" + short8(row.id) + ")…";
      var x = await readNw(row);
      S.pv.files.push(x.file);
      if (x.err) { S.pv.err = x.err; break; }
      if (x.a.fatal) { S.pv.err = "Phiên NW " + short8(row.id) + ": " + x.a.fatal + ". Bỏ chọn phiên này rồi bấm “Xem trước” lại."; break; }
      analyses.push(x.a);
    }
    $("pv-text").textContent = "";
    if (S.pv.err) { S.busy = ""; ev("xem-truoc-loi", S.pv.err); renderAll(); return; }
    var pick = CH.choose(analyses);
    if (pick.fatal.length) { S.pv.err = pick.fatal.map(function (x) { return short8(x.id) + ": " + x.msg; }).join("; "); S.busy = ""; renderAll(); return; }
    S.pick = pick;
    S.codes = CH.lookupList(NWC, CH.dupCodes(NWC, pick.products).keep);
    ev("chon-the", { sp: pick.products.length, deRieng: pick.aside.length, ma: S.codes.length });
    S.busy = "";
    await runLookup(false);
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
      r = await bg("lookup", sesArgs({ code: code })); tries++;
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
    if (S.busy || S.sendStarted || !S.pick) return;
    if (!retryOnly) S.res = {};
    var list = S.codes.filter(function (c) { var o = outcome(S.res[key(c)]); return !retryOnly || o === "err" || o === "todo"; });
    S.lookup = { start: iso(), abort: "", abortMsg: "", running: true, runs: (S.lookup ? S.lookup.runs : 0) + 1, retryOnly: !!retryOnly, n: list.length };
    S.fin = null; S.pvRows = null; S.bodies = null; S.before = null; S.beforeErr = ""; S.busy = "lookup";
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
      S.busy = "before"; renderAll();
      try { await compute(); }
      catch (e) {
        S.fin = null; S.pvRows = null; S.bodies = null;
        S.beforeErr = "Lỗi bất ngờ của trang khi lập kế hoạch: " + String((e && e.message) || e).slice(0, 200) + ". Bấm “Xem trước” lại.";
        ev("loi-bat-ngo", { buoc: "ke-hoach", msg: S.beforeErr });
      }
    }
    else ev("tra-dung", S.lookup.abort);
    S.busy = "";
    renderAll();
  }
  // lượt quét đã lưu + KKCHON.finish + chia lô. → true khi có kế hoạch dùng được
  async function compute() {
    S.fin = null; S.pvRows = null; S.bodies = null; S.before = null; S.beforeErr = "";
    var sc = await fetchScans("xem-truoc");
    S.beforeAt = iso();
    if (sc.err) { S.beforeErr = sc.err + (authHint(sc.r, "circa") ? " " + authHint(sc.r, "circa") : "") + " Không lập kế hoạch, không gửi." + scanAgain(sc, "Bấm “Xem trước” lại."); return false; }
    return applyScans(sc.scans);
  }
  function applyScans(scans) {
    S.before = scans; S.bodies = null; S.pvRows = null;
    var fin = CH.finish(NWC, S.pick, NWC.lookupMap(resList()), scans);
    S.fin = fin;
    if (fin.pending) { ev("chua-tra-du", { chuaTra: fin.chuaTra }); return false; }
    if (fin.blockers.length) { ev("ke-hoach-chan", fin.blockers); return false; }
    try { S.bodies = NWC.batches(fin.P3.items, S.sel.id, S.cfg.device, scans); }
    catch (e) { S.bodies = null; S.beforeErr = "Không chia lô được: " + (e && e.message || e); return false; }
    S.pvRows = CH.previewRows(fin, S.bodies.excluded);
    ev("ke-hoach", { sp: fin.products.length, deRieng: fin.aside.length, lo: S.bodies.length, boQua: S.bodies.excluded.length });
    return true;
  }
  function lkText() {
    if (!S.lookup) { $("lk-text").textContent = S.codes.length ? fmt(S.codes.length) + " mã cần tra" : ""; return; }
    var c = lkStats();
    $("lk-text").textContent = (S.lookup.running ? "Đang tra… " : "") + "Đã tra " + fmt(c.ok + c.unk + c.err) + "/" + fmt(c.total) + " mã · Circa nhận " + fmt(c.ok) + " · không nhận " + fmt(c.unk) + " · lỗi " + fmt(c.err) + (c.todo ? " · chưa tra " + fmt(c.todo) : "");
  }
  var ST_TXT = { "gui": "gửi", "gui-thieu": "gửi phần thiếu", "da-co": "đã có", "de-rieng": "để riêng" };
  var MODE_TXT = { "tho": "thô", "kem-don-vi": "kèm đơn vị", "giu": "giữ", "khong-nhan": "Circa không nhận", "chua-tra": "chưa tra" };
  function nwLabel(id) {
    if (!id) return "";
    var r = S.nwl && S.nwl.rows.filter(function (x) { return x.id === id; })[0];
    return short8(id) + (r && r.createdAt ? " (" + when(r.createdAt) + ")" : "");
  }
  function renderS3() {
    var out = clear($("s3-out"));
    lkText();
    var c = lkStats();
    $("btn-lookup-retry").hidden = !(S.lookup && !S.lookup.running && (c.err || c.todo || (S.fin && S.fin.pending)));
    if (!S.lookup) $("lk-prog").hidden = true;
    var pv = S.pv;
    if (!pv) return;
    if (pv.files.length) {
      out.appendChild(h("h3", { text: "Phiên NW đã đọc" }));
      out.appendChild(table([{ t: "Phiên NW" }, { t: "File (KB)", num: 1 }, { t: "Thẻ đã quét", num: 1 }, { t: "SP Khớp đủ điều kiện", num: 1 }, { t: "SP Khớp để riêng", num: 1 }, { t: "SP theo trạng thái (không gửi nếu không Khớp)" }, { t: "Ghi chú" }],
        pv.files.map(function (f) {
          var cnt = f.counts ? Object.keys(f.counts).map(function (k) { return k + " " + fmt(f.counts[k]); }).join(" · ") : "";
          var notes = [];
          if (f.khopZero) notes.push(f.khopZero + " SP Khớp mà Đã đếm 0");
          if (f.notInDs) notes.push(f.notInDs + " SP có thẻ mà không có trong “Danh sách kiểm kê”");
          if (f.strange) notes.push(f.strange + " thẻ lạ (không gửi)");
          (f.warn || []).forEach(function (w) { notes.push(w); });
          if (f.fatal) notes.push("KHÔNG DÙNG ĐƯỢC: " + f.fatal);
          return { pid: f.id, cls: f.fatal ? "flag" : null, cells: [nwLabel(f.id), f.size ? Math.max(1, Math.round(f.size / 1024)) : "", f.tags == null ? "" : f.tags, f.eligible == null ? "" : f.eligible, f.aside == null ? "" : f.aside, cnt, notes.join("; ")] };
        }), { small: 1 }));
    }
    if (pv.err) { out.appendChild(box("bad", "Chưa xem trước được", [pv.err])); return; }
    if (S.lookup && S.lookup.abort) {
      var msg = S.lookup.abort === "token" ? "Token Circa hết hạn / chưa đăng nhập: mở hoặc tải lại trang admin.v2.circa.vn (đã đăng nhập) rồi bấm “Tra lại phần chưa tra”."
        : S.lookup.abort === "quyen" ? "Tài khoản Circa không có quyền tra mã (HTTP 403)."
          : S.lookup.abort === "bg" ? "Background của extension không trả lời (extension vừa tải lại?). Tải lại trang này."
            : "Circa báo thiếu / sai cửa hàng (AuthzStoreRequired).";
      out.appendChild(box("bad", "Đã dừng tra thẻ — chưa sang bước sau", [msg, "Chi tiết: " + (S.lookup.abortMsg || "")]));
      return;
    }
    if (S.lookup && !S.lookup.running && (c.err || c.todo)) {
      var bad = S.codes.filter(function (x) { return outcome(S.res[key(x)]) === "err"; });
      out.appendChild(box("warn", fmt(c.err + c.todo) + " mã chưa tra được (sẽ chặn gửi). Bấm “Tra lại phần chưa tra”.", more(bad, 30, function (x) { return x + ": " + (S.res[key(x)].err || ""); })));
    }
    if (S.beforeErr) { out.appendChild(box("bad", "Chưa gửi được vào phiên này", [S.beforeErr])); return; }
    var fin = S.fin;
    if (!fin) return;
    if (fin.pending) { out.appendChild(box("warn", fmt(fin.chuaTra) + " thẻ chưa tra được trên Circa: chưa lập kế hoạch. Bấm “Tra lại phần chưa tra”.", null)); return; }
    if (fin.blockers.length) out.appendChild(box("bad", "Chưa gửi được — bước 4 bị khoá", fin.blockers));
    var T = S.pvRows ? S.pvRows.total : null;
    if (T) {
      out.appendChild(h("div", { cls: "metrics five" },
        metric("SP sẽ gửi", T.sendSp, "", fmt(T.send) + " thẻ"), metric("Gốc Circa dự kiến", T.circaBase, "", "SP gửi + đã có"),
        metric("SP đã có trong phiên", T["da-co"], ""), metric("SP để riêng", T["de-rieng"], T["de-rieng"] ? "warn" : "", fmt(T.asideTags) + " thẻ"),
        metric("Mã đã có (bỏ qua)", S.bodies ? S.bodies.excluded.length : 0, "")));
      out.appendChild(box(T["de-rieng"] ? "warn" : "ok", "Sẽ gửi " + fmt(T.send) + " thẻ của " + fmt(T.sendSp) + " SP vào phiên " + S.sel.code + (T["de-rieng"] ? "; " + fmt(T["de-rieng"]) + " SP để riêng (không gửi, kiểm tay theo lý do)." : "."), null));
    }
    if (S.before) {
      var mineB = sumOf(S.before, function (s) { return Number(s.base_qty); });
      out.appendChild(h("p", { cls: "note", text: "Phiên Circa đã có " + fmt(S.before.length) + " lượt quét (gốc " + fmt(mineB) + "), tải lúc " + when(S.beforeAt) + ". Mã đã có của thẻ định gửi sẽ không gửi lại (gửi lại không sửa được số đã ghi)." }));
    }
    if (!S.pvRows) return;
    var seg = h("div", { cls: "seg" });
    [["all", "Tất cả"], ["gui", "Gửi"], ["da-co", "Đã có"], ["de-rieng", "Để riêng"]].forEach(function (x) {
      var n = S.pvRows.rows.filter(function (r) { return x[0] === "all" || r.status === x[0] || (x[0] === "gui" && r.status === "gui-thieu"); }).length;
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
    var items = fin.P3 ? fin.P3.items : [];
    out.appendChild(details("Chi tiết từng thẻ sẽ gửi / đã có (tham chiếu, " + items.length + ")", function () {
      var ex = {};
      (S.bodies ? S.bodies.excluded : []).forEach(function (x) { ex[key(x.code)] = x.why; });
      return table([{ t: "EPC", code: 1 }, { t: "UID", code: 1 }, { t: "Mã gửi", code: 1 }, { t: "Mã SP" }, { t: "SL NW", num: 1 }, { t: "ĐVT NW" }, { t: "Đơn vị mã Circa" }, { t: "Cách gửi" }, { t: "Phiên NW" }, { t: "Trong phiên Circa" }],
        items.map(function (x) {
          return [x.epc, x.uid, x.code || "", x.pid, x.nwQty, x.nwUnit, x.circaUnit ? x.circaUnit + " = " + x.circaRate : "", x.mode === "kem-don-vi" ? "kèm " + x.send.quantity + " " + x.send.unit_name : MODE_TXT[x.mode] || x.mode,
            short8(tagNw(x)), ex[key(x.code)] ? "đã có" : "gửi"];
        }), { small: 1, limit: 3000 });
    }));
  }
  // phiên NW nguồn của một item (theo SP đã chọn)
  function tagNw(it) {
    var p = S.fin && S.fin.products.filter(function (x) { return x.pid === it.pid; })[0];
    return p ? p.nwId : "";
  }
  function fillSp(holder) {
    clear(holder);
    var q = fold(S.pvQ), f = S.pvFilter;
    var rows = S.pvRows.rows.filter(function (r) { return f === "all" || r.status === f || (f === "gui" && r.status === "gui-thieu"); })
      .filter(function (r) { return !q || String(r.pid).indexOf(q) >= 0 || fold(r.name).indexOf(q) >= 0; });
    var T = S.pvRows.total;
    var foot = [
      { cls: "total", cells: ["Tổng phần gửi", fmt(T.gui + T["gui-thieu"] + T["da-co"]) + " SP", "", T.tags, T.nwQty, T.circaBase, "gửi " + T.gui + " · gửi phần thiếu " + T["gui-thieu"] + " · đã có " + T["da-co"], fmt(T.send) + " thẻ sẽ gửi, " + fmt(T.have) + " thẻ đã có"] },
      { cls: "total", cells: ["Tổng để riêng", fmt(T["de-rieng"]) + " SP", "", T.asideTags, T.asideQty, "", "để riêng " + T["de-rieng"], ""] }
    ];
    holder.appendChild(table([{ t: "Mã SP" }, { t: "Tên sản phẩm" }, { t: "Phiên NW nguồn" }, { t: "Số thẻ", num: 1 }, { t: "SL NW (gốc)", num: 1 }, { t: "Gốc Circa dự kiến", num: 1 }, { t: "Trạng thái" }, { t: "Chi tiết" }],
      rows.map(function (r) { return { pid: String(r.pid), cls: r.status === "de-rieng" ? "flag" : null, cells: [r.pid, r.name, nwLabel(r.nwId), r.tags, r.nwQty, r.circaBase == null ? "" : r.circaBase, r.label, r.detail] }; }),
      { foot: foot, empty: "Không có SP nào khớp bộ lọc." }));
  }
  function dlPreviewCsv() {
    if (!S.pvRows) return;
    var head = ["Mã SP", "Tên sản phẩm", "Phiên NW nguồn", "Số thẻ", "SL NW (gốc)", "Gốc Circa dự kiến", "Thẻ sẽ gửi", "Thẻ đã có", "Trạng thái", "Lý do", "Chi tiết"];
    var rows = S.pvRows.rows.map(function (r) { return [r.pid, r.name, r.nwId, r.tags, r.nwQty, r.circaBase == null ? "" : r.circaBase, r.send, r.have, ST_TXT[r.status], r.reason ? CH.REASONS[r.reason] || r.reason : "", r.detail]; });
    download("kiem-ke-circa-nw-xem-truoc-" + safeName(S.sel && S.sel.code) + "-" + stamp() + ".csv", csv(head, rows), "text/csv;charset=utf-8");
  }

  // ---------- 4. gửi ----------
  function bodyStats(bodies) {
    var codes = 0, base = 0;
    bodies.forEach(function (b) { var its = NWC.itemsFor(b, S.fin.P3.items); codes += NWC.bodyCodes(b).length; base += sumOf(its, function (x) { return x.expectBase; }); });
    return { codes: codes, base: base };
  }
  function canSend() { return !!S.fin && !S.fin.pending && !S.fin.blockers.length && !!S.bodies && !S.beforeErr && !blockSend() && S.fin.P3.sum.okToSend; }
  function renderS4() {
    var out = clear($("send-sum"));
    if (S.fin && S.fin.P3 && !S.fin.products.length && !S.sendStarted) out.appendChild(box("warn", "Không có SP nào gửi được: không có SP “Khớp” đủ điều kiện, hoặc mọi SP đều để riêng (xem bước 3).", null));
    else if (S.bodies && !S.sendStarted && S.fin && S.fin.P3) {
      var bs = bodyStats(S.bodies);
      out.appendChild(box(S.bodies.length ? "info" : "ok", S.bodies.length ? "Sẽ gửi " + fmt(bs.codes) + " thẻ (gốc " + fmt(bs.base) + ") trong " + S.bodies.length + " lô vào phiên " + S.sel.code : "Không còn thẻ nào cần gửi: mọi thẻ của SP định gửi đã có trong phiên.",
        [S.bodies.excluded.length ? "Bỏ qua " + fmt(S.bodies.excluded.length) + " mã đã có trong phiên." : null,
          "Trước khi gửi, trang kiểm lại phiên Circa, tải lại lượt quét, tính lại và hỏi xác nhận với số mới nhất."].filter(Boolean)));
    }
    if (S.chk && S.chk.authz && S.chk.authz.manage === false) out.appendChild(box("bad", "Tài khoản Circa không có quyền inventory_count.manage: nút gửi bị khoá.", null));
    $("btn-send").textContent = S.bodies && S.bodies.length && !S.sendStarted && S.fin && S.fin.P3 ? "Gửi " + fmt(bodyStats(S.bodies).codes) + " thẻ…" : "Gửi…";
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
  // phiên Circa đã chọn còn dùng được để gửi: OPEN, đúng id, đúng pos_id
  function sessReady(s) { return !!s && String(s.status) === "OPEN" && String(s.pos_id).toLowerCase() === S.sel.pos_id && String(s.id).toLowerCase() === S.sel.id; }
  // khoá của tập thẻ sẽ gửi: lô tất định theo kế hoạch (cùng kế hoạch → cùng chuỗi); khác mã / đơn vị / SL → khác chuỗi
  function planKey(bodies) { return bodies ? JSON.stringify(bodies) : ""; }
  // GET lại phiên Circa (phải OPEN) + TOÀN BỘ lượt quét → tính lại kế hoạch (applyScans). → { ok: true } | { ok: false, msg: <khung báo> }
  // where: "truoc-gui" (trước hộp xác nhận) | "sau-khoa" (sau khi giữ khoá gửi). Đọc lượt quét không đạt → bỏ kế hoạch cũ, khoá nút gửi.
  async function refreshPlan(where) {
    var r = await bg("circaSession", sesArgs());
    var s = sessOf(r);
    if (!sessReady(s)) {
      ev("gui-tu-choi", "phiên Circa không OPEN");
      return { ok: false, msg: box("bad", "Không gửi: phiên Circa không còn sẵn sàng", [s ? "Trạng thái " + s.status + ", pos_id " + s.pos_id : errInfo(r), authHint(r, "circa")].filter(Boolean)) };
    }
    var sc = await fetchScans(where);
    if (sc.err) {
      var hint = authHint(sc.r, "circa");
      S.beforeErr = sc.err + (hint ? " " + hint : "") + " Không lập kế hoạch, không gửi." + scanAgain(sc, "Bấm “Xem trước” lại.");
      S.bodies = null; S.pvRows = null; S.beforeAt = iso();
      ev("gui-tu-choi", { lyDo: "doc-luot-quet", where: where, kind: sc.kind });
      return { ok: false, msg: box("bad", "Không gửi: không đọc được đủ lượt quét của phiên Circa", [sc.err, hint, "Chưa gửi gì." + scanAgain(sc, "Bấm “Xem trước” lại để lập kế hoạch theo lượt quét mới nhất.")].filter(Boolean)) };
    }
    S.beforeAt = iso();
    var okPlan = applyScans(sc.scans);
    if (!okPlan || !canSend()) return { ok: false, msg: box("bad", "Không gửi: kế hoạch tính lại theo lượt quét mới nhất không dùng được", [S.beforeErr || (S.fin && S.fin.blockers && S.fin.blockers.join("; ")) || "xem bước 3"]) };
    return { ok: true };
  }
  // phần TRƯỚC khi lấy khoá gửi: kiểm lại phiên Circa + lượt quét, tính lại, hộp xác nhận. → {bodies, bs} khi người dùng đồng ý | null
  async function preSend() {
    S.busy = "presend"; S.sendMsg = h("p", { cls: "note", text: "Kiểm lại phiên Circa và lượt quét trước khi gửi…" }); renderAll();
    var nBefore = S.pvRows ? S.pvRows.total["de-rieng"] : 0;
    var pre = await refreshPlan("truoc-gui");
    S.busy = "";
    if (!pre.ok) { S.sendMsg = pre.msg; renderAll(); return null; }
    renderAll();
    var bodies = S.bodies;
    if (!bodies.length) { S.sendMsg = box("ok", "Không còn thẻ nào cần gửi. Bấm “Đối chiếu lại” ở bước 5.", null); S.rcReady = true; renderAll(); return null; }
    var bs = bodyStats(bodies), T = S.pvRows.total;
    var lines = [
      "Phiên Circa: " + S.sel.code + " · cửa hàng " + S.chk.storeName + " · id " + S.sel.id,
      "Phiên NW đã chọn (" + nwIds().length + "): " + nwIds().map(short8).join(", ") + " · kho " + S.nwl.wh.name,
      "Gửi " + fmt(bs.codes) + " thẻ (gốc " + fmt(bs.base) + ") của " + fmt(T.sendSp) + " SP trong " + bodies.length + " lô (≤ 100 thẻ/lô), tuần tự.",
      bodies.excluded.length ? "Bỏ qua " + fmt(bodies.excluded.length) + " mã đã có trong phiên (không gửi lại)." : "Phiên chưa có mã nào của các SP này.",
      fmt(T["de-rieng"]) + " SP để riêng, không gửi" + (T["de-rieng"] !== nBefore ? " (đã tính lại theo lượt quét mới nhất: trước " + fmt(nBefore) + ")" : "") + ".",
      "Đây là thao tác GHI: mỗi thẻ thành một lượt quét trong phiên. Extension không xoá được lượt quét.",
      "Không đóng trang khi đang gửi. Lô nào sai, trang dừng ngay và không gửi lô sau."
    ];
    S.busy = "confirm"; refresh();
    var ok = await confirmBox("Gửi " + fmt(bs.codes) + " thẻ vào phiên " + S.sel.code + "?", lines, "Gửi " + fmt(bs.codes) + " thẻ");
    S.busy = ""; refresh();
    if (!ok || S.sendStarted) { S.sendMsg = ok ? S.sendMsg : h("p", { cls: "note", text: "Đã huỷ, chưa gửi gì." }); renderS4(); return null; }
    return { bodies: bodies, bs: bs };
  }
  async function onSend() {
    if (S.sendStarted || S.busy || !canSend()) return;
    var go = null;
    // ngoại lệ bất ngờ TRƯỚC khi lấy khoá: chưa gửi gì → trả S.busy về, bỏ kế hoạch (phải xem trước lại), hiện lỗi
    try { go = await preSend(); }
    catch (e0) {
      var em0 = String((e0 && e0.message) || e0).slice(0, 200);
      S.busy = ""; S.bodies = null; S.pvRows = null;
      S.beforeErr = "Lỗi bất ngờ của trang khi kiểm lại trước khi gửi (" + em0 + "). Bấm “Xem trước” lại.";
      S.sendMsg = box("bad", "Không gửi: lỗi bất ngờ của trang trước khi gửi", [em0, "Chưa gửi gì. Bấm “Xem trước” lại."]);
      ev("loi-bat-ngo", { buoc: "truoc-khi-giu-khoa", msg: em0 });
      try { renderAll(); } catch (e1) { ev("loi-ve-trang", String((e1 && e1.message) || e1)); }
      return;
    }
    if (!go) return;
    var bodies = go.bodies, bs = go.bs;
    // kế hoạch người dùng vừa xác nhận
    var key0 = planKey(bodies), n0 = bs.codes;
    // khoá gửi của phiên Circa (background): mỗi lúc chỉ 1 panel gửi cho 1 phiên
    S.busy = "lock"; refresh();
    var lk = await bg("beginSend", { id: S.sel.id });
    S.busy = "";
    if (!lk || lk.ok !== true) {
      ev("khoa-gui-tu-choi", lk && lk.msg);
      S.sendMsg = box("bad", "Không gửi: chưa lấy được khoá gửi của phiên", [(lk && lk.msg) || "background không trả lời", "Chưa gửi gì từ trang này."]);
      renderAll(); return;
    }
    // ĐANG GIỮ KHOÁ: mọi đường ra (kể cả ngoại lệ bất ngờ) đều nhả khoá ở finally; đã gửi lô nào thì vẫn đối chiếu.
    var started = false, inBatch = null;
    try {
      // tính lại SAU khi giữ khoá: panel khác có thể vừa gửi xong vào phiên này trong lúc hộp xác nhận đang mở
      S.busy = "recheck"; S.sendMsg = h("p", { cls: "note", text: "Đã giữ khoá gửi. Kiểm lại phiên Circa và lượt quét lần cuối…" }); renderAll();
      var post = await refreshPlan("sau-khoa");
      S.busy = "";
      if (!post.ok) { S.sendMsg = post.msg; ev("gui-tu-choi", "kiem-lai-sau-khoa"); return; }
      if (planKey(S.bodies) !== key0) {
        var n1 = S.bodies.length ? bodyStats(S.bodies).codes : 0;
        S.sendMsg = box("bad", "Phiên Circa vừa thay đổi, xem lại rồi bấm gửi lần nữa", [
          "Sau khi bạn xác nhận, trang tải lại lượt quét của phiên: tập thẻ sẽ gửi đã khác kế hoạch vừa xác nhận (đã xác nhận " + fmt(n0) + " thẻ, tính lại còn " + fmt(n1) + " thẻ).",
          "Bảng xem trước ở bước 3 đã vẽ lại theo lượt quét mới nhất.", "Chưa gửi gì."]);
        ev("gui-tu-choi", { lyDo: "phien-circa-doi-sau-khoa", daXacNhan: n0, tinhLai: n1 });
        return;
      }
      bodies = S.bodies;
      started = true;
      S.sendStarted = true; S.sending = true; S.busy = "send"; S.dirty = true; S.sendAt = iso();
      S.sendPlan = { at: S.sendAt, sessionId: S.sel.id, code: S.sel.code, posId: S.sel.pos_id, nw: nwIds(), scansBefore: S.before, excluded: bodies.excluded, bodies: bodies.slice() };
      ev("gui-bat-dau", { batches: bodies.length, codes: bs.codes });
      var prog = $("send-prog"); prog.hidden = false; prog.max = bodies.length; prog.value = 0;
      S.sendMsg = null; renderAll();
      var maxTries = 1 + S.cfg.retries;
      for (var i = 0; i < bodies.length; i++) {
        var body = bodies[i], bi = NWC.itemsFor(body, S.fin.P3.items);
        var entry = { lo: i + 1, codes: NWC.bodyCodes(body).length, body: body, attempts: [], running: true };
        S.batches.push(entry);
        inBatch = entry;
        var resp, tries = 0, resend = false;
        for (;;) {
          $("send-text").textContent = "Lô " + (i + 1) + "/" + bodies.length + ": gửi lần " + (tries + 1) + "…";
          renderS4();
          var at = iso();
          resp = await bg("submit", sesArgs({ body: body }));
          tries++;
          entry.attempts.push({ at: at, status: resp.status, ms: resp.ms, err: resp.err, msg: resp.msg, response: resp.j != null ? resp.j : resp.raw != null ? { raw: resp.raw } : null });
          // KHÔNG gửi lại: 200, 4xx, lệnh chắc chắn chưa rời máy, hoặc mất liên lạc với background giữa lúc gửi (bg-lost)
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
                : resp.status === 400 && /FAILED_PRECONDITION/i.test(errCode(resp)) ? "phiên Circa không còn mở (400 FAILED_PRECONDITION)."
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
        inBatch = null;
        renderS4();
        if (!chk || !chk.ok) break;
      }
    } catch (e) {
      // ngoại lệ bất ngờ của trang: không gửi tiếp, không gửi lại
      var em = String((e && e.message) || e);
      ev("loi-bat-ngo", { started: started, lo: inBatch ? inBatch.lo : null, msg: em });
      if (!started) S.sendMsg = box("bad", "Không gửi: lỗi bất ngờ của trang trước khi gửi", [em, "Chưa gửi gì."]);
      else if (inBatch) {
        inBatch.running = false; inBatch.stop = "không rõ";
        S.sendStop = "Lô " + inBatch.lo + ": KHÔNG RÕ Circa đã ghi lô này chưa: lỗi bất ngờ của trang giữa lúc gửi (" + em + "). Không gửi lại; xem đối chiếu ở bước 5.";
      } else S.sendStop = "Lỗi bất ngờ của trang sau lô " + S.batches.length + " (" + em + "): đã dừng, không gửi lô sau. Xem đối chiếu ở bước 5.";
    } finally {
      var ul = null;
      try { ul = await bg("endSend", { id: S.sel.id }); } catch (e2) { ul = { ok: false, err: String((e2 && e2.message) || e2) }; }
      ev("khoa-gui-tra", { ok: !!(ul && ul.ok === true), err: ul && ul.err });
      S.busy = "";
      if (started) {
        S.sending = false; S.sendDone = true;
        var nLo = S.sendPlan ? S.sendPlan.bodies.length : 0;
        $("send-text").textContent = S.sendStop ? "ĐÃ DỪNG GỬI" : "Đã gửi xong " + nLo + " lô";
        S.sendMsg = S.sendStop ? box("bad", "ĐÃ DỪNG GỬI — không gửi các lô sau", [S.sendStop, "Đối chiếu ở bước 5 chạy ngay để biết Circa đã lưu những gì.",
          "Không tự gửi lại. Muốn gửi tiếp phần còn thiếu: xử lý nguyên nhân, mở lại trang này từ nút trên web NW (mã đã có tự bỏ qua)."])
          : box("ok", "Đã gửi xong " + nLo + " lô, mọi lô đạt theo response. Kết quả cuối cùng là đối chiếu ở bước 5.", null);
        ev(S.sendStop ? "gui-dung" : "gui-xong", S.sendStop || null);
      }
      try { renderAll(); } catch (e3) { ev("loi-ve-trang", String((e3 && e3.message) || e3)); }
      if (started) {
        try { await reconcile(); } catch (e4) {
          S.busy = ""; S.rc = { at: iso(), err: "Lỗi bất ngờ khi đối chiếu: " + String((e4 && e4.message) || e4) + ". Bấm “Đối chiếu lại”." };
          ev("loi-doi-chieu", S.rc.err);
          try { renderAll(); } catch (e5) { ev("loi-ve-trang", String((e5 && e5.message) || e5)); }
        }
      }
    }
  }

  // ---------- 5. đối chiếu (chỉ SP đã gửi) ----------
  // lượt quét đọc không đạt (KKCHON.readScans) → "CHƯA ĐỐI CHIẾU ĐƯỢC", không bao giờ ĐẠT; nút “Đối chiếu lại” vẫn bấm được.
  async function reconcile() {
    if (!S.fin || !S.fin.P3 || !S.sel) return;
    S.busy = "rc"; $("rc-text").textContent = "Đang tải lượt quét của phiên…"; refresh();
    var at = iso();
    var sc = await fetchScans("doi-chieu");
    S.busy = "";
    if (sc.err) S.rc = { at: at, err: sc.err + (authHint(sc.r, "circa") ? " " + authHint(sc.r, "circa") : "") + scanAgain(sc, "Bấm “Đối chiếu lại”."), hasMore: !!sc.hasMore };
    else {
      var R = CH.reconcileOurs(NWC, S.fin.P3, sc.scans);
      S.rc = { at: at, scans: sc.scans, R: R, ok: R.ok };
    }
    S.rcHistory.push({ at: at, ok: S.rc.ok === true, err: S.rc.err, counts: S.rc.R ? S.rc.R.cs.sum.counts : null, ours: S.rc.R ? S.rc.R.ours.length : null, circaBase: S.rc.R ? S.rc.R.circaBase : null });
    if (S.sendStarted) S.dirty = true;
    ev("doi-chieu", { ok: S.rc.ok === true, err: S.rc.err });
    $("rc-text").textContent = "Đối chiếu lúc " + when(at);
    renderAll();
  }
  // nút “Đối chiếu lại”: ngoại lệ bất ngờ → trả S.busy về, báo "chưa đối chiếu được", nút vẫn bấm lại được
  async function onRecheck() {
    if (S.busy || S.sending) return;
    try { await reconcile(); }
    catch (e) {
      var at = iso();
      S.busy = "";
      S.rc = { at: at, err: "Lỗi bất ngờ khi đối chiếu: " + String((e && e.message) || e).slice(0, 200) + ". Bấm “Đối chiếu lại”." };
      S.rcHistory.push({ at: at, ok: false, err: S.rc.err, counts: null, ours: null, circaBase: null });
      ev("loi-doi-chieu", S.rc.err);
      try { $("rc-text").textContent = "Đối chiếu lúc " + when(at); renderAll(); } catch (e2) { ev("loi-ve-trang", String((e2 && e2.message) || e2)); }
    }
  }
  function renderS5() {
    var out = clear($("s5-out"));
    var rc = S.rc;
    if (!rc) return;
    if (rc.err) { out.appendChild(h("div", { cls: "big bad", id: "rc-big" }, "CHƯA ĐỐI CHIẾU ĐƯỢC", h("small", { text: rc.err }))); return; }
    var R = rc.R, cs = R.cs, c = cs.sum.counts, sent = cs.rows.length;
    var line = fmt(c.dung) + "/" + fmt(sent) + " thẻ đúng · gốc NW " + fmt(R.nwBase) + (R.circaBase === R.nwBase ? " = " : " ≠ ") + "gốc Circa của các SP này " + fmt(R.circaBase) + " · " + fmt(R.ours.length) + " lượt lạ trên các SP này";
    out.appendChild(h("div", { cls: "big " + (rc.ok ? "ok" : "bad"), id: "rc-big" }, rc.ok ? "ĐẠT" : "CHƯA ĐẠT", h("small", { text: line })));
    out.appendChild(h("div", { cls: "metrics five" },
      metric("Đúng", c.dung, "ok"), metric("Sai số", c["sai-so"], c["sai-so"] ? "bad" : ""), metric("Sai SP", c["sai-sp"], c["sai-sp"] ? "bad" : ""),
      metric("Thiếu (chưa có lượt)", c.thieu, c.thieu ? "bad" : ""), metric("Lặp", c.lap, c.lap ? "bad" : "")));
    out.appendChild(h("div", { cls: "metrics three" },
      metric("Lượt lạ trên SP đã gửi", R.ours.length, R.ours.length ? "bad" : "", fmt(sumOf(R.ours, function (f) { return f.base_qty; })) + " gốc"),
      metric("Gốc Circa (SP đã gửi)", R.circaBase, R.circaBase === R.nwBase ? "ok" : "bad", fmt(rc.scans.length) + " lượt quét cả phiên"),
      metric("Gốc NW (SP đã gửi)", R.nwBase, "")));
    var notes = [];
    if (!rc.ok) notes = cs.sum.reasons.filter(function (x) { return !/lượt ngoài kế hoạch/.test(x); });
    if (!rc.ok && R.ours.length) notes.push(R.ours.length + " lượt quét không thuộc thẻ đã gửi nằm trên các SP đã gửi: nguy cơ đếm đôi.");
    if (!rc.ok && R.circaBase !== R.nwBase) notes.push("Gốc Circa của các SP đã gửi (" + fmt(R.circaBase) + ") khác gốc NW (" + fmt(R.nwBase) + "), chênh " + fmt(R.nwBase - R.circaBase) + ".");
    if (R.others.length) notes.push("Phiên Circa còn " + fmt(R.others.length) + " lượt quét của " + fmt(R.otherSp) + " SP khác (không thuộc phần extension gửi; không xét).");
    out.appendChild(box(rc.ok ? "ok" : "warn", "Lưu ý", notes.concat([
      "SP để riêng ở bước 3 không gửi: kiểm tay theo lý do.",
      "Phiên Circa và các phiên NW vẫn MỞ. Extension không đóng, không duyệt, không huỷ phiên.",
      "Số ghi sai KHÔNG sửa được bằng API: cho đếm lại SP đó trên Circa.", "Tải sổ ghi ở bước 6 trước khi đóng trang."])));
    var spAll = R.bySp, spBad = spAll.filter(function (p) { return p.diff !== 0 || p.problems.length || p.foreignScans; });
    var seg = h("div", { cls: "seg" });
    [[false, "SP có chênh / vấn đề (" + spBad.length + ")"], [true, "Tất cả SP đã gửi (" + spAll.length + ")"]].forEach(function (x) {
      seg.appendChild(h("button", { cls: S.rcAll === x[0] ? "on" : null, on: { click: function () { S.rcAll = x[0]; renderS5(); } } }, x[1]));
    });
    out.appendChild(h("h3", { text: "Theo sản phẩm (chỉ SP đã gửi)" }));
    out.appendChild(h("div", { cls: "toolbar" }, seg));
    out.appendChild(table([{ t: "Mã SP" }, { t: "Tên sản phẩm" }, { t: "Số thẻ", num: 1 }, { t: "Gốc NW", num: 1 }, { t: "Gốc Circa", num: 1 }, { t: "Lượt lạ (gốc)", num: 1 }, { t: "Chênh", num: 1 }, { t: "Kết luận" }, { t: "Việc cần làm" }],
      (S.rcAll ? spAll : spBad).map(function (p) { return { pid: String(p.pid), cls: p.diff !== 0 || p.problems.length ? "flag" : null, cells: [p.pid, p.name, p.tags, p.nwBase, p.circaBase, p.foreignBase, p.diff, p.ketLuan, p.viecCanLam] }; }),
      { empty: "Không có SP nào chênh: mọi SP đã gửi khớp gốc NW." }));
    [["sai-so", "Thẻ sai số"], ["sai-sp", "Thẻ sai SP"], ["thieu", "Thẻ thiếu (chưa có lượt)"], ["lap", "Mã có nhiều lượt"]].forEach(function (g) {
      var rows = cs.rows.filter(function (r) { return r.result === g[0]; });
      if (!rows.length) return;
      out.appendChild(details(g[1] + " (" + rows.length + ")", function () {
        return table([{ t: "Mã gửi", code: 1 }, { t: "EPC", code: 1 }, { t: "Mã SP" }, { t: "Cách" }, { t: "Gốc NW", num: 1 }, { t: "Gốc Circa", num: 1 }, { t: "Lượt", num: 1 }, { t: "Chi tiết" }],
          rows.map(function (r) { return [r.code, r.epc, r.pid, MODE_TXT[r.mode] || r.mode, r.expectBase, r.gotBase == null ? "" : r.gotBase, r.scans, r.msg]; }), { small: 1, limit: 2000 });
      }, g[0] !== "thieu" || rows.length <= 50));
    });
    if (R.ours.length) out.appendChild(details("Lượt lạ trên SP đã gửi (" + R.ours.length + ")", function () {
      return table([{ t: "Mã quét", code: 1 }, { t: "SP Circa" }, { t: "Gốc", num: 1 }, { t: "SL × đơn vị" }, { t: "Thiết bị" }, { t: "Lúc" }, { t: "Lý do" }],
        R.ours.map(function (f) { return [f.code, f.product_id, f.base_qty, f.scanned_qty + " " + (f.unit_code || ""), f.device_id, f.scanned_at ? when(f.scanned_at) : "", f.why]; }), { small: 1, limit: 2000 });
    }, true));
  }
  function dlRcCsv() {
    if (!S.rc || !S.rc.R) return;
    var head = ["Mã SP", "Tên sản phẩm", "Phiên NW nguồn", "Số thẻ NW", "Gốc NW", "Gốc đã gửi", "Gốc Circa (mã kế hoạch)", "Gốc lượt lạ", "Lượt lạ", "Chênh", "Đúng", "Sai số", "Sai SP", "Thiếu", "Lặp", "Kết luận", "Việc cần làm"];
    var src = {};
    (S.fin ? S.fin.products : []).forEach(function (p) { src[p.pid] = p.nwId; });
    var rows = S.rc.R.bySp.map(function (p) {
      return [p.pid, p.name, src[p.pid] || "", p.tags, p.nwBase, p.sentBase, p.circaBase, p.foreignBase, p.foreignScans, p.diff, p.status.dung, p.status["sai-so"], p.status["sai-sp"], p.status.thieu, p.status.lap, p.ketLuan, p.viecCanLam];
    });
    download("kiem-ke-circa-nw-doi-chieu-" + safeName(S.sel && S.sel.code) + "-" + stamp() + ".csv", csv(head, rows), "text/csv;charset=utf-8");
  }

  // ---------- 6. sổ ghi (không có token: trang không bao giờ có token) ----------
  function buildLog() {
    var fin = S.fin, rc = S.rc;
    return {
      congCu: VERSION, taoLuc: iso(), cheDo: S.cfg && S.cfg.test ? "THỬ — máy chủ giả" : "THẬT",
      ghiChu: "Sổ ghi do extension tạo. Không chứa token. Phiên Circa và các phiên NW để MỞ.",
      phienCirca: S.sel, kiemPhienCirca: S.chk,
      danhSachPhienCirca: S.cl ? { at: S.cl.at, docDuoc: S.cl.read, trang: S.cl.pages, tong: S.cl.total, conTrangSau: S.cl.more, loi: S.cl.err || null } : null,
      khoNW: S.nwl ? S.nwl.wh : null,
      phienNWDaChon: nwIds(),
      danhSachPhienNW: S.nwl ? { at: S.nwl.at, trang: S.nwl.pages, tongTrang: S.nwl.totalPages, conTrangSau: S.nwl.more, loi: S.nwl.err || null,
        phien: S.nwl.rows.map(function (x) { return { id: x.id, createdAt: x.createdAt, scopeType: x.scopeType, notes: x.notes, chon: !!S.nwSel[x.id] }; }) } : null,
      fileNW: S.pv ? { at: S.pv.at, loi: S.pv.err || null, phien: S.pv.files } : null,
      phienNguon: fin && fin.products ? fin.products.map(function (p) { return { pid: p.pid, ten: p.name, nwId: p.nwId, soThe: p.tags.length, slNW: p.qty, lanQuetCuoi: p.lastScanText, ungVien: p.cands }; }) : null,
      deRieng: fin ? fin.aside.map(function (a) { return { pid: a.pid, ten: a.name, nwId: a.nwId || null, soThe: a.tags, slNW: a.qty, lyDo: a.reason, nhan: CH.REASONS[a.reason] || a.reason, chiTiet: a.detail, ungVien: a.cands }; }) : null,
      traCuu: S.lookup ? { batDau: S.lookup.start, ketThuc: S.lookup.end || null, lanChay: S.lookup.runs, dung: S.lookup.abort || null, thongKe: lkStats(), res: resList() } : null,
      keHoach: fin && fin.P3 ? { sum: fin.P3.sum, bySp: fin.P3.bySp, items: fin.P3.items } : fin && fin.pending ? { chuaTra: fin.chuaTra } : null,
      xemTruoc: S.pvRows,
      luotCoSanLucXemTruoc: S.before,
      guiLo: S.sendPlan ? { batDau: S.sendPlan.at, sessionId: S.sendPlan.sessionId, code: S.sendPlan.code, posId: S.sendPlan.posId, phienNW: S.sendPlan.nw, luotCoSan: S.sendPlan.scansBefore, maBoQua: S.sendPlan.excluded, dung: S.sendStop || null } : null,
      lo: S.batches.map(function (b) { return { lo: b.lo, soMa: b.codes, body: b.body, lanGui: b.attempts, resend: !!b.resend, kiem: b.check || null, dung: b.stop || null }; }),
      doiChieu: rc ? (rc.err ? { at: rc.at, loi: rc.err } : { at: rc.at, ok: rc.ok, gocCircaSPDaGui: rc.R.circaBase, gocNW: rc.R.nwBase, sum: rc.R.cs.sum, luotLaSPDaGui: rc.R.ours, luotSPKhac: rc.R.others.length,
        theSai: rc.R.cs.rows.filter(function (r) { return r.result !== "dung"; }), bySp: rc.R.bySp }) : null,
      lichSuDoiChieu: S.rcHistory, luotQuetSauGui: rc && rc.scans ? rc.scans : null,
      // mỗi lần đọc lượt quét phiên Circa (xem trước / trước gửi / sau khoá / đối chiếu): số lần đọc, tổng summary trước / sau, số lượt nhận,
      // số id, số trùng, byte thân response. Cách đọc: một request limit = gioiHan, không offset
      cachDocLuotQuet: S.cfg ? { gioiHan: S.cfg.scanLimit, thoiHanMs: S.cfg.scanTimeout, tranByte: S.cfg.scanMaxBytes, soLanDoc: S.cfg.scanTries } : null,
      lanDocLuotQuet: S.scanReads, suKien: S.events
    };
  }
  function dlLog() {
    var name = "kiem-ke-circa-nw-" + safeName(S.sel ? S.sel.code || short8(S.sel.id) : "x") + "-" + stamp() + ".json";
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
    var busy = !!S.busy;
    var hasItems = !!S.fin && !!S.fin.P3 && S.fin.P3.items.length > 0;
    var s2 = !!S.sel && !!S.chk && !blockNw(), s3 = !!S.pv, s4 = canSend(), s5 = hasItems && (S.sendDone || !!S.rc || S.rcReady || (!!S.bodies && S.bodies.length === 0));
    setStep("s1", true, !!S.sel && !!S.chk && !S.chk.problems.length);
    setStep("s2", s2 || S.busy === "nw", nwIds().length > 0 && !!S.fin);
    setStep("s3", s3, s4);
    setStep("s4", s4 || S.sendStarted, S.sendDone && !S.sendStop);
    setStep("s5", s5, S.rc && S.rc.ok);
    setStep("s6", true, !!S.logAt && !S.dirty);
    $("btn-circa").disabled = busy || S.sendStarted;
    $("btn-nw").disabled = !s2 || busy || S.sendStarted;
    $("btn-preview").disabled = !s2 || busy || S.sendStarted || !nwIds().length || !S.nwl || !!S.nwl.err;
    $("btn-lookup-retry").disabled = busy || S.sendStarted;
    $("btn-send").disabled = !s4 || busy || S.sendStarted || !S.bodies || !S.bodies.length;
    $("btn-recheck").disabled = !s5 || busy;
    $("btn-log").disabled = !S.cfg;
    $("btn-rc-csv").disabled = !(S.rc && S.rc.R) || busy;
    var pv = $("btn-pv-csv");
    if (pv) pv.disabled = !S.pvRows;
    document.querySelectorAll("input[name=circa], input[data-nw]").forEach(function (e) { e.disabled = busy || S.sendStarted; });
    if (S.sending) document.querySelectorAll("main button, main input").forEach(function (e) { e.disabled = true; });
    if (S.dirty && !S.sending) $("log-text").textContent = "Chưa tải sổ ghi cho lần ghi gần nhất — tải trước khi đóng trang.";
  }
  function renderAll() { renderS1(); renderS2(); renderS3(); renderS4(); renderS5(); refresh(); }

  // ---------- khởi động ----------
  async function init() {
    if (!NWC || !XLSX || !CFG0 || !CH || !window.chrome || !chrome.runtime) { put("fatal", "Thiếu thư viện (NWC / XLSX / KKCHON / cấu hình). Bản extension bị hỏng: build lại."); $("fatal").hidden = false; return; }
    $("btn-circa").addEventListener("click", loadCircaList);
    $("btn-nw").addEventListener("click", loadNw);
    $("btn-preview").addEventListener("click", onPreview);
    $("btn-lookup-retry").addEventListener("click", function () { runLookup(true); });
    $("btn-send").addEventListener("click", onSend);
    $("btn-recheck").addEventListener("click", onRecheck);
    $("btn-log").addEventListener("click", dlLog);
    $("btn-rc-csv").addEventListener("click", dlRcCsv);
    window.addEventListener("beforeunload", function (e) { if (S.sending || S.dirty) { e.preventDefault(); e.returnValue = ""; return ""; } });
    var r = await bgRaw({ op: "init" });
    if (!r || !r.ok || !r.cfg) { put("fatal", "Không khởi động được: " + ((r && r.msg) || "background không trả lời")); $("fatal").hidden = false; return; }
    S.cfg = r.cfg;
    document.title = (S.cfg.test ? "[THỬ] " : "") + "Gửi sang Circa";
    ev("mo-panel", { version: S.cfg.version });
    renderAll();
    await loadCircaList();
  }
  init();
})();
