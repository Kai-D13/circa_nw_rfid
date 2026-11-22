/* Extension "Kiểm kê Circa ↔ NW": QUAN SÁT request của trang admin Circa (watch-circa.js). World MAIN, document_start.
 * CHỈ QUAN SÁT: bọc window.fetch và XMLHttpRequest, gọi hàm gốc với đúng tham số; chỉ đọc bản clone() của response (fetch) hoặc
 * responseText sau loadend (XHR). Mọi lỗi của phần quan sát bị nuốt, không làm hỏng trang.
 * fetch: request KHÔNG cần quan sát → trả ĐÚNG Promise gốc. Request cần quan sát (tạo phiên / đọc phiên) → trả Promise "gương"
 * (dựng bằng Promise gốc của trang, chụp lúc document_start): resolve cùng Response, reject cùng lý do. Phần quan sát gắn vào
 * Promise gốc, nên lỗi mà trang KHÔNG bắt vẫn tới trang qua unhandledrejection của Promise trang nhận (như khi không có extension).
 * Báo ra content-circa.js bằng window.postMessage (cùng origin, đánh dấu kk):
 *   created {id, pos}  POST <CIRCA_API>/v1/inventory/count/sessions trả 200/201 có data.session.id (pos: pos_id của response / body)
 *   seen    {id, pos}  GET  <CIRCA_API>/v1/inventory/count/sessions/<id> trả 200 có pos_id (gợi ý cửa hàng cho phiên mở từ URL)
 *   store   {pos}      request tới CIRCA_API có header X-Store-Id (giá trị gần nhất)
 * Tin này KHÔNG tin cậy (script khác của trang cũng postMessage được): background tự GET lại phiên để kiểm.
 * build-ext.js thay origin dưới đây cho bản thử.
 */
(function () {
  "use strict";
  var API = "https://api.v2.circa.vn";
  var MARK = "kk-circa-nw-1";
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var RE_CREATE = /^\/v1\/inventory\/count\/sessions\/?$/;
  var RE_SESS = /^\/v1\/inventory\/count\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
  var W = window;
  var pm = W.postMessage, loc = W.location, URL_ = W.URL, JSONp = JSON.parse, JSONs = JSON.stringify, P = W.Promise;

  function emit(o) {
    try { o.kk = MARK; pm.call(W, o, loc.origin); } catch (e) { /* bỏ qua */ }
  }
  function urlOf(u) { try { return new URL_(String(u), loc.href); } catch (e) { return null; } }
  function classify(method, url) {
    var u = urlOf(url);
    if (!u || u.origin !== API) return null;
    var m = String(method || "GET").toUpperCase(), x;
    if (m === "POST" && RE_CREATE.test(u.pathname)) return { k: "create" };
    if (m === "GET" && (x = RE_SESS.exec(u.pathname))) return { k: "sess", id: x[1].toLowerCase() };
    return null;
  }
  function isApi(url) { var u = urlOf(url); return !!u && u.origin === API; }
  function bodyPos(b) {
    try {
      if (typeof b !== "string" || b.length > 200000) return null;
      var j = JSONp(b);
      return j && typeof j.pos_id === "string" && UUID.test(j.pos_id) ? j.pos_id.toLowerCase() : null;
    } catch (e) { return null; }
  }
  function onText(c, text, posBody) {
    try {
      if (typeof text !== "string" || text.length > 5000000) return;
      var j = JSONp(text), d = j && j.data;
      var s = d && typeof d === "object" ? (d.session && typeof d.session === "object" ? d.session : d) : null;
      if (!s || typeof s.id !== "string" || !UUID.test(s.id)) return;
      var pos = typeof s.pos_id === "string" && UUID.test(s.pos_id) ? s.pos_id.toLowerCase() : null;
      if (c.k === "create") emit({ kind: "created", id: s.id.toLowerCase(), pos: pos || posBody || null });
      else if (c.k === "sess" && s.id.toLowerCase() === c.id && pos) emit({ kind: "seen", id: c.id, pos: pos });
    } catch (e) { /* bỏ qua */ }
  }
  function storeFrom(h) {
    try {
      if (!h) return;
      var v = null;
      if (typeof h.get === "function" && typeof h.forEach === "function") v = h.get("x-store-id");
      else if (Array.isArray(h)) h.forEach(function (p) { if (p && /^x-store-id$/i.test(String(p[0]))) v = p[1]; });
      else if (typeof h === "object") Object.keys(h).forEach(function (k) { if (/^x-store-id$/i.test(k)) v = h[k]; });
      if (typeof v === "string" && UUID.test(v)) emit({ kind: "store", pos: v.toLowerCase() });
    } catch (e) { /* bỏ qua */ }
  }

  // ---- fetch ----
  var oFetch = W.fetch;
  if (typeof oFetch === "function") {
    var wFetch = function fetch(input, init) {
      var p = oFetch.apply(this, arguments), mirror = null;
      try {
        var isReq = input && typeof input === "object" && typeof input.url === "string";
        var url = isReq ? input.url : input;
        var method = (init && init.method) || (isReq ? input.method : "GET");
        if (isApi(url)) storeFrom((init && init.headers) || (isReq ? input.headers : null));
        var c = classify(method, url);
        if (c && p && typeof p.then === "function" && typeof P === "function") {
          var pos = c.k === "create" ? bodyPos(init && init.body) : null;
          mirror = new P(function (res, rej) {
            p.then(function (r) {
              var cl = null;
              try { if (r && (r.status === 200 || r.status === 201) && typeof r.clone === "function") cl = r.clone(); } catch (e) { cl = null; }
              res(r); // clone TRƯỚC khi trả Response cho trang (trang có thể đọc body ngay)
              if (cl) { try { cl.text().then(function (t) { onText(c, t, pos); }, function () {}); } catch (e) { /* bỏ qua */ } }
            }, rej); // lỗi: chuyển nguyên lý do sang Promise trang nhận; trang không bắt → unhandledrejection như cũ
          });
        }
      } catch (e) { mirror = null; }
      return mirror || p;
    };
    try { W.fetch = wFetch; } catch (e) { /* bỏ qua */ }
  }

  // ---- XMLHttpRequest (axios dùng XHR) ----
  var XHR = W.XMLHttpRequest, XP = XHR && XHR.prototype;
  if (XP && typeof XP.open === "function" && typeof XP.send === "function") {
    var oOpen = XP.open, oSend = XP.send, oSet = XP.setRequestHeader, meta = new WeakMap();
    XP.open = function open(method, url) {
      try { meta.set(this, { m: method, u: url, store: null }); } catch (e) { /* bỏ qua */ }
      return oOpen.apply(this, arguments);
    };
    if (typeof oSet === "function") {
      XP.setRequestHeader = function setRequestHeader(name, value) {
        try { if (/^x-store-id$/i.test(String(name))) { var x = meta.get(this); if (x) x.store = value; } } catch (e) { /* bỏ qua */ }
        return oSet.apply(this, arguments);
      };
    }
    XP.send = function send(body) {
      try {
        var x = meta.get(this);
        if (x) {
          if (x.store && isApi(x.u)) storeFrom({ "x-store-id": x.store });
          var c = classify(x.m, x.u);
          if (c) {
            var pos = c.k === "create" ? bodyPos(body) : null, xhr = this;
            xhr.addEventListener("loadend", function () {
              try {
                if (xhr.status !== 200 && xhr.status !== 201) return;
                var rt = xhr.responseType, t = null;
                if (rt === "" || rt === "text") t = xhr.responseText;
                else if (rt === "json") t = JSONs(xhr.response);
                if (t != null) onText(c, t, pos);
              } catch (e) { /* bỏ qua */ }
            });
          }
        }
      } catch (e) { /* bỏ qua */ }
      return oSend.apply(this, arguments);
    };
  }
})();
