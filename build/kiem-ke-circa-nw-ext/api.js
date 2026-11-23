/* Extension "Kiểm kê Circa ↔ NW": BẢNG API ĐƯỢC PHÉP + NƠI DUY NHẤT GỌI MẠNG (api.js). Chạy trong service worker; Node nạp để test.
 *
 * Mọi lệnh gọi đi qua check(method, url, body): khớp regex NEO ĐẦU–CUỐI theo method + origin + pathname, query chỉ nhận
 * tham số đã liệt kê (giá trị theo regex, không trùng khoá), body POST đúng khuôn. Lệnh không khớp bị từ chối TRƯỚC khi gửi.
 *   Circa (CIRCA_API):  GET  /v1/inventory/count/sessions?page=1..10&limit=20  (danh sách phiên; KHÔNG gửi X-Store-Id, như trang admin)
 *                       GET  /v1/inventory/count/sessions/<uuid>
 *                       GET  /v1/inventory/count/sessions/<uuid>/scans?limit=60000   (MỘT request, KHÔNG offset: v0.2.1 không lật trang;
 *                            thời hạn riêng SCAN_TIMEOUT_MS + Grpc-Timeout tương ứng; thân response > SCAN_MAX_BYTES → lỗi too-big, không trả lượt)
 *                       GET  /v1/inventory/count/sessions/<uuid>/summary   (data.total_scans: tổng số lượt, để kiểm lần đọc lượt quét)
 *                       GET  /v1/inventory/count/qr-lookup?pos_id=&qr_code=
 *                       POST /v1/inventory/count/submit-rfid-batch       (lệnh GHI DUY NHẤT; panel gọi sau khi người dùng xác nhận)
 *                       GET  /v1/authz/me
 *   NW (NW_API):        GET  /api/v1/warehouses
 *                       GET  /api/v1/stock/reconciliations?page=1..8&limit=25
 *                       GET  /api/v1/stock/reconciliations/<uuid>?omitScannedEpcs=true
 *                       GET  /api/v1/stock/reconciliations/<uuid>/export?format=xlsx&scope=all&includeEpcs=true&locale=vi
 * KHÔNG có: tạo phiên ở bên nào (POST …/count/sessions, POST /stock/reconciliations), /auth/refresh, mọi đường dẫn
 * đóng/duyệt/huỷ/hoàn tất/đặt lại/đổi phạm vi/append (thêm một lớp chặn theo từ khoá phòng khi bảng bị sửa nhầm).
 * Lệnh Circa gắn với một phiên gửi X-Store-Id = pos_id của phiên đó (panel truyền posId); lệnh danh sách phiên không gắn cửa hàng.
 *
 * Token: lấy bằng getToken(side) NGAY TRƯỚC mỗi lần gọi (bridge.js), chỉ đặt vào header Authorization; không trả về, không log,
 * không vào URL. Kết quả trả về: {status, j, badJson, raw, ms, size (chỉ lệnh scans: byte UTF-8 của thân)} | {status:0, err, msg, timeoutMs?}
 *   | export: {status, bytes(Uint8Array), size}.
 */
(function (root, factory) {
  var A = factory();
  if (typeof module === "object" && module && module.exports) module.exports = A;
  if (root) root.KKAPI = A;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  var UUID_S = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  var UUID = new RegExp("^" + UUID_S + "$");
  // bản thật: đúng 4 origin này (viết dạng regex để build-ext.js không thay nhầm khi dựng bản thử)
  var REAL = {
    CIRCA_ADMIN: /^https:\/\/admin\.v2\.circa\.vn$/,
    CIRCA_API: /^https:\/\/api\.v2\.circa\.vn$/,
    NW_APP: /^https:\/\/circa\.nextwaves\.app$/,
    NW_API: /^https:\/\/api-circa\.nextwaves\.app$/
  };
  // origin bản thử: chỉ có trong khối TEST (build-ext.js CẮT khối này khỏi bản thật → bản thật luôn từ chối TEST = true)
  var testOk = null;
  // lớp chặn thứ hai: từ khoá cấm trong pathname (không đường dẫn hợp lệ nào chứa các từ này; uuid chỉ có chữ hex)
  var DENY = /(finalize|approve|cancel|revert|reset|close|scope|manual-count|append|refresh|sync|submit-for-review|recount|resolve|delete|complete|logout|login)/i;
  var TOKEN_RE = /^[A-Za-z0-9\-_.~+\/=]{16,8192}$/;

  function validateCfg(cfg) {
    if (!cfg || typeof cfg !== "object") throw new Error("thiếu cấu hình");
    Object.keys(REAL).forEach(function (k) {
      var v = cfg[k];
      if (typeof v !== "string") throw new Error("cấu hình thiếu " + k);
      if (cfg.TEST === true) { if (!testOk || !testOk(v)) throw new Error("bản thử chỉ nhận origin máy cục bộ (http, IP vòng lặp, có cổng) cho " + k + ", có " + v); }
      else if (cfg.TEST === false) { if (!REAL[k].test(v)) throw new Error("bản thật chỉ nhận host thật cho " + k + ", có " + v); }
      else throw new Error("cấu hình TEST phải là true/false");
    });
    return true;
  }

  // ---- khuôn body POST ----
  function plainObj(o) { return !!o && typeof o === "object" && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype; }
  function keysExactly(o, allowed, required) {
    var ks = Object.keys(o);
    return ks.every(function (k) { return allowed.indexOf(k) >= 0; }) && required.every(function (k) { return Object.prototype.hasOwnProperty.call(o, k); });
  }
  // mã thẻ (EPC / UID) gửi đi hoặc tra: chỉ chữ số, chữ cái, _ và - (mã khác → bị chặn, thẻ thành "chưa tra" và chặn gửi)
  var CODE_RE = /^[A-Za-z0-9_-]{1,200}$/;
  function bodySubmit(b) {
    if (!plainObj(b) || !keysExactly(b, ["session_id", "device_id", "tags", "items"], ["session_id", "device_id"])) return "body submit sai khoá";
    if (!UUID.test(String(b.session_id))) return "session_id không phải uuid";
    if (typeof b.device_id !== "string" || !/^[A-Za-z0-9 ._-]{1,64}$/.test(b.device_id)) return "device_id sai";
    var n = 0;
    if (b.tags !== undefined) {
      if (!Array.isArray(b.tags) || !b.tags.every(function (t) { return typeof t === "string" && CODE_RE.test(t); })) return "tags sai";
      n += b.tags.length;
    }
    if (b.items !== undefined) {
      if (!Array.isArray(b.items) || !b.items.every(function (x) {
        return plainObj(x) && keysExactly(x, ["tag", "unit_name", "quantity"], ["tag", "unit_name", "quantity"]) && typeof x.tag === "string" && CODE_RE.test(x.tag) &&
          typeof x.unit_name === "string" && x.unit_name.length > 0 && x.unit_name.length <= 64 && Number.isSafeInteger(x.quantity) && x.quantity > 0 && x.quantity <= 100000;
      })) return "items sai";
      n += b.items.length;
    }
    if (n < 1 || n > 100) return "lô phải có 1..100 mã, có " + n;
    return "";
  }
  // ---- bảng API ----
  // query: {khoá: regex giá trị}; need: khoá bắt buộc; noStore: lệnh Circa không gắn cửa hàng (không gửi X-Store-Id)
  // scans: lệnh đọc lượt quét (thời hạn riêng SCAN_TIMEOUT_MS, trần kích thước thân response SCAN_MAX_BYTES)
  var EP = [
    { id: "circa.sessions", side: "circa", method: "GET", base: "CIRCA_API", path: "/v1/inventory/count/sessions", noStore: true,
      query: { page: /^(?:[1-9]|10)$/, limit: /^20$/ }, need: ["page", "limit"] },
    { id: "circa.session", side: "circa", method: "GET", base: "CIRCA_API", path: "/v1/inventory/count/sessions/(" + UUID_S + ")" },
    // ĐÚNG limit=60000, không offset (v0.2.1: một request, không lật trang; offset trên Circa thật trả trùng / sót lượt)
    { id: "circa.scans", side: "circa", method: "GET", base: "CIRCA_API", path: "/v1/inventory/count/sessions/(" + UUID_S + ")/scans",
      query: { limit: /^60000$/ }, need: ["limit"], scans: true },
    { id: "circa.summary", side: "circa", method: "GET", base: "CIRCA_API", path: "/v1/inventory/count/sessions/(" + UUID_S + ")/summary" },
    { id: "circa.qrLookup", side: "circa", method: "GET", base: "CIRCA_API", path: "/v1/inventory/count/qr-lookup", query: { pos_id: UUID, qr_code: CODE_RE }, need: ["pos_id", "qr_code"] },
    { id: "circa.submit", side: "circa", method: "POST", base: "CIRCA_API", path: "/v1/inventory/count/submit-rfid-batch", body: bodySubmit },
    { id: "circa.authz", side: "circa", method: "GET", base: "CIRCA_API", path: "/v1/authz/me" },
    { id: "nw.warehouses", side: "nw", method: "GET", base: "NW_API", path: "/api/v1/warehouses" },
    { id: "nw.recList", side: "nw", method: "GET", base: "NW_API", path: "/api/v1/stock/reconciliations", query: { page: /^[1-8]$/, limit: /^25$/ }, need: ["page", "limit"] },
    { id: "nw.rec", side: "nw", method: "GET", base: "NW_API", path: "/api/v1/stock/reconciliations/(" + UUID_S + ")", query: { omitScannedEpcs: /^true$/ }, need: ["omitScannedEpcs"] },
    { id: "nw.export", side: "nw", method: "GET", base: "NW_API", path: "/api/v1/stock/reconciliations/(" + UUID_S + ")/export", binary: true,
      query: { format: /^xlsx$/, scope: /^all$/, includeEpcs: /^true$/, locale: /^vi$/ }, need: ["format", "scope", "includeEpcs", "locale"] }
  ];

  function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&"); }
  // số byte UTF-8 của chuỗi (cặp surrogate = 4 byte, surrogate lẻ = 3 byte như khi mã hoá thay thế)
  function utf8Len(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xFC00) === 0xDC00) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }
  function mb(n) { return (n / 1048576).toFixed(1).replace(".", ",") + " MB"; }

  function create(opts) {
    var cfg = opts.cfg;
    validateCfg(cfg);
    var doFetch = opts.fetch, getToken = opts.getToken, now = opts.now || function () { return Date.now(); };
    var timeoutMs = opts.timeoutMs || cfg.TIMEOUT_MS || 30000;
    // lệnh đọc lượt quét: thời hạn riêng (mặc định 120 s) + trần kích thước thân response (mặc định 60 MiB)
    var scanTimeoutMs = opts.scanTimeoutMs || cfg.SCAN_TIMEOUT_MS || 120000;
    var scanMaxBytes = opts.scanMaxBytes || cfg.SCAN_MAX_BYTES || 62914560;
    var table = EP.map(function (e) {
      return Object.freeze({ id: e.id, side: e.side, method: e.method, origin: cfg[e.base], path: e.path, query: e.query || {}, need: e.need || [], body: e.body || null, binary: !!e.binary,
        noStore: !!e.noStore, scans: !!e.scans, timeoutMs: e.scans ? scanTimeoutMs : timeoutMs, re: new RegExp("^" + e.path + "$") });
    });
    var byId = {};
    table.forEach(function (e) { byId[e.id] = e; });

    // → {ok:true, ep, m} | {ok:false, why}
    function check(method, url, body) {
      var raw = String(url == null ? "" : url);
      if (/[\s\\]|\.\.|%2e|%2f|%5c|%00|#/i.test(raw)) return { ok: false, why: "URL có ký tự / chuỗi bị cấm (khoảng trắng, \\, .., %2e, %2f, %5c, %00, #)" };
      var u;
      try { u = new URL(raw); } catch (e) { return { ok: false, why: "URL không hợp lệ" }; }
      if (u.username || u.password) return { ok: false, why: "URL có thông tin đăng nhập" };
      if (u.hash) return { ok: false, why: "URL có #" };
      if (/\/\/|%/.test(u.pathname)) return { ok: false, why: "đường dẫn có // hoặc %" };
      if (DENY.test(u.pathname)) return { ok: false, why: "đường dẫn chứa từ khoá cấm" };
      var M = String(method || "").toUpperCase();
      var cands = table.filter(function (e) { return e.origin === u.origin && e.re.test(u.pathname); });
      if (!cands.length) return { ok: false, why: "không có trong bảng API được phép: " + M + " " + u.origin + u.pathname };
      var ep = cands.filter(function (e) { return e.method === M; })[0];
      if (!ep) return { ok: false, why: "method " + M + " không được phép cho " + u.pathname };
      if (method !== ep.method) return { ok: false, why: "method phải viết hoa: " + ep.method };
      var seen = {}, bad = "";
      u.searchParams.forEach(function (v, k) {
        if (bad) return;
        if (!Object.prototype.hasOwnProperty.call(ep.query, k)) { bad = "tham số không được phép: " + k; return; }
        if (seen[k]) { bad = "tham số lặp: " + k; return; }
        seen[k] = 1;
        if (!ep.query[k].test(v)) bad = "giá trị tham số sai: " + k;
      });
      if (bad) return { ok: false, why: bad };
      var miss = ep.need.filter(function (k) { return !seen[k]; });
      if (miss.length) return { ok: false, why: "thiếu tham số: " + miss.join(", ") };
      if (!ep.query || !Object.keys(ep.query).length) { if (u.search) return { ok: false, why: "đường dẫn này không nhận query" }; }
      if (ep.method === "GET" && body !== undefined) return { ok: false, why: "GET không có body" };
      if (ep.method === "POST") {
        var why = ep.body ? ep.body(body) : "thiếu khuôn body";
        if (why) return { ok: false, why: why };
      }
      return { ok: true, ep: ep, m: ep.re.exec(u.pathname) };
    }

    // dựng URL từ id + tham số (id phải là uuid), rồi vẫn qua check()
    function urlFor(id, p) {
      var ep = byId[id];
      if (!ep) throw new Error("không có lệnh " + id);
      p = p || {};
      var path = ep.path.replace("(" + UUID_S + ")", function () {
        var v = String(p.id || "");
        if (!UUID.test(v)) throw new Error("id không phải uuid (chữ thường)");
        return v;
      });
      var q = Object.keys(ep.query).filter(function (k) { return p.q && p.q[k] !== undefined; }).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(String(p.q[k])); });
      return ep.origin + path + (q.length ? "?" + q.join("&") : "");
    }

    function headers(ep, token, posId, hasBody) {
      var h = { "Authorization": "Bearer " + token };
      if (ep.side === "circa") {
        // Grpc-Timeout như trang admin (30S); lệnh đọc lượt quét: bằng thời hạn riêng của lệnh (120S) để máy chủ không cắt sớm hơn trang chờ
        h["X-Circa-App"] = "admin"; h["X-Client-Id"] = "1"; h["Grpc-Timeout"] = ep.scans ? Math.ceil(ep.timeoutMs / 1000) + "S" : "30S";
        if (!ep.noStore) h["X-Store-Id"] = posId;
      } else h["Accept"] = ep.binary ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/octet-stream, */*" : "application/json";
      if (hasBody) h["Content-Type"] = "application/json; charset=UTF-8";
      return h;
    }

    // call(id, {id, q, posId, body}) → kết quả (không bao giờ chứa token)
    async function call(id, p) {
      p = p || {};
      var url, t0 = now();
      try { url = urlFor(id, p); } catch (e) { return { status: 0, err: "blocked", msg: String(e && e.message || e) }; }
      var ep = byId[id], c = check(ep.method, url, p.body);
      if (!c.ok) return { status: 0, err: "blocked", msg: c.why };
      if (ep.side === "circa" && !ep.noStore && !UUID.test(String(p.posId || ""))) return { status: 0, err: "no-store", msg: "chưa xác định được cửa hàng (X-Store-Id)" };
      var tk;
      try { tk = await getToken(ep.side); } catch (e) { tk = { err: "no-token" }; }
      if (!tk || typeof tk.token !== "string" || !TOKEN_RE.test(tk.token)) return { status: 0, err: (tk && tk.err) || "no-token", side: ep.side, msg: "không lấy được token " + (ep.side === "nw" ? "NW" : "Circa") };
      var ctl = typeof AbortController === "function" ? new AbortController() : null;
      // thời hạn bao cả lúc tải thân response (abort cắt cả r.text())
      var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ep.timeoutMs);
      try {
        var r = await doFetch(url, {
          method: ep.method, headers: headers(ep, tk.token, p.posId, p.body !== undefined), body: p.body !== undefined ? JSON.stringify(p.body) : undefined,
          signal: ctl ? ctl.signal : undefined, cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer"
        });
        tk = null;
        if (ep.binary && r.status === 200) {
          var buf = new Uint8Array(await r.arrayBuffer());
          if (buf.length > 50 * 1024 * 1024) return { status: 0, err: "too-big", msg: "file xuất lớn hơn 50 MB", ms: now() - t0 };
          return { status: 200, bytes: buf, size: buf.length, type: r.headers && r.headers.get ? String(r.headers.get("content-type") || "") : "", ms: now() - t0 };
        }
        var text = await r.text();
        // lệnh đọc lượt quét: số byte UTF-8 của thân (số ký tự ≤ số byte: số ký tự đã hơn trần thì chắc chắn hơn trần, khỏi đếm)
        var size;
        if (ep.scans) {
          size = text.length > scanMaxBytes ? text.length : utf8Len(text);
          if (size > scanMaxBytes)
            return { status: 0, err: "too-big", msg: "thân response lượt quét " + (text.length > scanMaxBytes ? "hơn " : "") + mb(size) + ", vượt trần " + mb(scanMaxBytes) +
              " của đường truyền nội bộ extension (tin nhắn Chrome tối đa 64 MiB): không dùng lượt quét này.", ms: now() - t0, size: size };
        }
        var j = null;
        try { j = text ? JSON.parse(text) : null; } catch (e) { j = null; }
        return { status: r.status, j: j, badJson: j === null, raw: j === null ? text.slice(0, 300) : undefined, ms: now() - t0, size: size };
      } catch (e) {
        var to = !!(ctl && ctl.signal.aborted);
        return { status: 0, err: to ? "timeout" : "network", msg: String(e && e.message || e).slice(0, 200), ms: now() - t0, timeoutMs: to ? ep.timeoutMs : undefined };
      } finally { clearTimeout(timer); tk = null; }
    }

    return { check: check, call: call, urlFor: urlFor, table: table, cfg: cfg };
  }

  return { create: create, validateCfg: validateCfg, UUID: UUID, TOKEN_RE: TOKEN_RE, DENY: DENY, CODE_RE: CODE_RE, _bodySubmit: bodySubmit, _utf8Len: utf8Len };
});
