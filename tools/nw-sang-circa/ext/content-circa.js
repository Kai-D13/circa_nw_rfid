/* Extension "Kiểm kê Circa ↔ NW": CONTENT SCRIPT trang admin Circa (content-circa.js). World ISOLATED, document_start.
 * - Nhận tin của watch-circa.js (postMessage cùng origin, có dấu kk) → báo background. Tin này không tin cậy: background tự kiểm.
 * - Trên trang <ADMIN>/kiem-ke-ton-kho/<uuid>: vẽ thanh trạng thái nhỏ (shadow DOM đóng, chỉ textContent) gồm trạng thái liên kết,
 *   nút "Lấy kết quả từ NW và gửi vào Circa" (mở panel), câu hỏi "Tạo phiên NW cho phiên này?" với phiên chưa liên kết, nút "Thử lại".
 * - Không đọc token, không gọi mạng, không dùng alert/confirm.
 * - Chống clickjacking cơ bản: style quan trọng của phần tử chủ đặt inline !important mỗi lần vẽ; trước khi nhận cú bấm có tác dụng
 *   (mở câu hỏi / tạo phiên NW, thử lại, mở panel) kiểm getComputedStyle (hiện rõ, không biến đổi, không mờ, kể cả phần tử cha),
 *   vị trí góc phải-dưới, và elementFromPoint tại điểm bấm là chính thanh. Sai → bỏ qua cú bấm.
 */
/* global chrome, KKCFG */
(function () {
  "use strict";
  var CFG = self.KKCFG;
  if (!CFG || location.origin !== CFG.CIRCA_ADMIN || window.top !== window) return;
  var MARK = "kk-circa-nw-1";
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var PATH_RE = new RegExp("^" + CFG.ADMIN_SESSION_PATH.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&") + "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/?$", "i");
  var hints = {}, lastStore = null, curId = "", cur = null, busy = "", askOpen = false, pollT = null, err = "";

  function send(msg) {
    return new Promise(function (res) {
      try {
        chrome.runtime.sendMessage(msg, function (r) {
          if (chrome.runtime.lastError) return res({ ok: false, msg: "extension không phản hồi (" + chrome.runtime.lastError.message + ")" });
          res(r || { ok: false, msg: "không có phản hồi" });
        });
      } catch (e) { res({ ok: false, msg: "extension đã tải lại: tải lại trang" }); }
    });
  }
  function posFor(id) { return hints[id] || lastStore || null; }

  // ---- tin từ watch-circa.js ----
  window.addEventListener("message", function (e) {
    try {
      if (e.source !== window || e.origin !== location.origin) return;
      var d = e.data;
      if (!d || typeof d !== "object" || d.kk !== MARK || typeof d.kind !== "string") return;
      var id = typeof d.id === "string" && UUID.test(d.id) ? d.id.toLowerCase() : "";
      var pos = typeof d.pos === "string" && UUID.test(d.pos) ? d.pos.toLowerCase() : "";
      if (d.kind === "created" && id) {
        if (pos) hints[id] = pos;
        send({ op: "created", id: id, pos: pos || null }).then(function (r) { if (id === curId) take(r); });
      } else if (d.kind === "seen" && id && pos) {
        var had = hints[id];
        hints[id] = pos;
        if (id === curId && had !== pos && (!cur || cur.state === "unknown-store" || cur.state === "error")) status();
      } else if (d.kind === "store" && pos) lastStore = pos;
    } catch (x) { /* bỏ qua */ }
  });
  try {
    chrome.runtime.onMessage.addListener(function (m) {
      if (m && m.op === "linkChanged" && m.id === curId) status();
    });
  } catch (x) { /* bỏ qua */ }

  // ---- thanh trạng thái ----
  var host = null, root = null;
  function h(tag, props) {
    var e = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === "text") e.textContent = String(v);
      else if (k === "cls") e.className = v;
      else if (k === "on") Object.keys(v).forEach(function (ev) { e.addEventListener(ev, v[ev]); });
      else if (/^on/i.test(k)) throw new Error("không gán thuộc tính sự kiện");
      else e.setAttribute(k, String(v));
    });
    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c == null || c === false) continue; e.appendChild(c instanceof Node ? c : document.createTextNode(String(c))); }
    return e;
  }
  var CSS = [
    ":host{all:initial}",
    ".bar{position:static;box-sizing:border-box;width:100%;font:13px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;",
    "background:#fff;color:#1f2328;border:1px solid #d0d7de;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18);padding:10px 12px}",
    ".bar.min .body{display:none}",
    ".hd{display:flex;align-items:center;gap:8px;font-weight:700}",
    ".hd .t{flex:1}",
    ".dot{width:10px;height:10px;border-radius:50%;background:#8c959f;flex:none}",
    ".ok .dot{background:#1a7f37}.warn .dot{background:#bf8700}.bad .dot{background:#cf222e}.run .dot{background:#0969da}",
    ".msg{margin:6px 0 0;word-break:break-word}",
    ".sub{color:#57606a;font-size:12px;margin-top:4px;word-break:break-all}",
    ".row{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}",
    "button{font:inherit;padding:5px 10px;border-radius:6px;border:1px solid #d0d7de;background:#f6f8fa;color:#1f2328;cursor:pointer}",
    "button.pri{background:#1f6feb;border-color:#1f6feb;color:#fff;font-weight:600}",
    "button:disabled{opacity:.55;cursor:default}",
    "button.x{padding:0 6px;border:0;background:transparent;font-size:15px;line-height:1}",
    "a{color:#0969da}",
    ".test{background:#cf222e;color:#fff;font-weight:700;font-size:11px;padding:1px 6px;border-radius:4px}"
  ].join("");
  // style của phần tử chủ: đặt inline !important (thắng mọi CSS !important của trang), đặt lại mỗi lần vẽ
  var GAP = 16, WIDTH = 360;
  var HOST_STYLE = {
    position: "fixed", right: GAP + "px", bottom: GAP + "px", left: "auto", top: "auto", "z-index": "2147483647", margin: "0", padding: "0",
    width: WIDTH + "px", "max-width": "calc(100vw - " + (2 * GAP) + "px)", height: "auto", display: "block", opacity: "1", visibility: "visible",
    "pointer-events": "auto", transform: "none", translate: "none", rotate: "none", scale: "none", filter: "none", "clip-path": "none",
    zoom: "1", "mix-blend-mode": "normal", "content-visibility": "visible", border: "0", background: "transparent"
  };
  function pin() {
    if (!host) return;
    try { Object.keys(HOST_STYLE).forEach(function (k) { host.style.setProperty(k, HOST_STYLE[k], "important"); }); } catch (e) { /* bỏ qua */ }
  }
  function ensureBar() {
    if (host && host.isConnected) { pin(); return; }
    if (!document.documentElement) return;
    host = document.createElement("kk-circa-nw");
    host.setAttribute("data-kk", "1");
    // bản thật: shadow root ĐÓNG (script của trang không với tới nút); bản thử: mở để Playwright bấm được
    var mode = "closed";
    /*TEST-BEGIN*/
    if (CFG.TEST) mode = "open";
    /*TEST-END*/
    root = host.attachShadow({ mode: mode });
    pin();
    (document.body || document.documentElement).appendChild(host);
  }
  // thanh có đang hiện rõ, đúng chỗ, và đúng là thứ nằm dưới điểm bấm? (chống trang làm mờ / dịch / phủ thanh để lừa bấm)
  function near(a, b) { return Math.abs(a - b) <= 4; }
  function hostOk(e) {
    try {
      if (!host || !host.isConnected) return false;
      var cs = getComputedStyle(host);
      if (cs.position !== "fixed" || cs.visibility !== "visible" || cs.display === "none" || cs.transform !== "none" || cs.filter !== "none" ||
        (cs.translate && cs.translate !== "none") || (cs.rotate && cs.rotate !== "none") || (cs.scale && cs.scale !== "none") ||
        (cs.clipPath && cs.clipPath !== "none") || (cs.zoom && +cs.zoom !== 1) || !(+cs.opacity >= 0.9)) return false;
      var op = 1;
      for (var p = host.parentElement; p; p = p.parentElement) {
        var ps = getComputedStyle(p);
        op *= +ps.opacity;
        if (ps.visibility === "hidden" || ps.filter !== "none" || ps.transform !== "none" || (ps.zoom && +ps.zoom !== 1)) return false;
      }
      if (!(op >= 0.9)) return false;
      var r = host.getBoundingClientRect(), de = document.documentElement;
      var W = [de.clientWidth, window.innerWidth], H = [de.clientHeight, window.innerHeight];
      if (!(near(r.right, W[0] - GAP) || near(r.right, W[1] - GAP))) return false;
      if (!(near(r.bottom, H[0] - GAP) || near(r.bottom, H[1] - GAP))) return false;
      if (!(near(r.width, Math.min(WIDTH, W[0] - 2 * GAP)) || near(r.width, Math.min(WIDTH, W[1] - 2 * GAP))) || r.height < 20) return false;
      if (e && typeof e.clientX === "number" && document.elementFromPoint(e.clientX, e.clientY) !== host) return false;
      return true;
    } catch (x) { return false; }
  }
  // chỉ nhận cú bấm thật của người dùng (isTrusted), không nhận click do script của trang giả lập
  function trusted(fn) { return function (e) { if (e && e.isTrusted === true) fn(e); }; }
  // cú bấm có tác dụng: thêm điều kiện thanh hiện rõ và đúng chỗ
  function guarded(fn) {
    return function (e) {
      if (!e || e.isTrusted !== true) return;
      if (!hostOk(e)) { err = "Bỏ qua cú bấm: thanh trạng thái đang bị trang làm mờ / dịch chuyển / che. Tải lại trang rồi bấm lại."; render(); return; }
      err = "";
      fn(e);
    };
  }
  function removeBar() { if (host) { host.remove(); host = null; root = null; } }
  var minimized = false;

  var LABEL = {
    linked: ["ok", "Đã liên kết phiên NW"], pending: ["warn", "Chưa tạo được phiên NW"], linking: ["run", "Đang tạo / tìm phiên NW…"],
    "no-warehouse": ["bad", "Không có kho NW trùng tên"], "no-permission": ["bad", "Thiếu quyền NW"], conflict: ["bad", "Liên kết không rõ ràng"],
    error: ["bad", "Lỗi"], skipped: ["warn", "Không phải phiên QR"], unlinked: ["warn", "Chưa có phiên NW liên kết"], closed: ["warn", "Phiên không mở"],
    "unknown-store": ["warn", "Không xác định được cửa hàng"], ignored: ["warn", "Không tự tạo"], loading: ["run", "Đang kiểm…"], none: ["warn", "Chưa có bản ghi"],
    "nw-closed": ["bad", "Phiên NW liên kết đã đóng"], "rate-limited": ["warn", "Tạm dừng kiểm (quá nhiều yêu cầu)"]
  };
  var NW_CLOSED = { cancelled: "Phiên NW liên kết đã huỷ", completed: "Phiên NW liên kết đã hoàn tất", approved: "Phiên NW liên kết đã duyệt" };
  // dòng phiên NW: id + ghi chú để tìm trên web NW; link chỉ tới trang chủ NW (đường dẫn trang chi tiết phiên chưa kiểm)
  function nwLine() {
    var a = h("a", { target: "_blank", rel: "noopener noreferrer", "data-role": "nw-link", text: "mở web NW" });
    a.href = CFG.NW_APP + "/";
    return h("div", { cls: "sub", "data-role": "nw" }, "Phiên NW " + cur.nwId + (cur.nwStatus ? " (" + cur.nwStatus + ")" : "") + (cur.warehouseName ? " · kho " + cur.warehouseName : "") +
      (cur.notes ? " · ghi chú “" + cur.notes + "”" : "") + " · ", a);
  }
  function render() {
    if (!curId) { removeBar(); return; }
    ensureBar();
    if (!root) return;
    while (root.firstChild) root.removeChild(root.firstChild);
    var st = cur ? cur.state : "loading", lb = LABEL[st] || ["warn", st];
    var title = st === "nw-closed" && cur && NW_CLOSED[cur.nwStatus] ? NW_CLOSED[cur.nwStatus] : lb[1];
    var bar = h("div", { cls: "bar " + lb[0] + (minimized ? " min" : ""), "data-state": st });
    bar.appendChild(h("style", { text: CSS }));
    var badge = null;
    /*TEST-BEGIN*/
    if (CFG.TEST) badge = h("span", { cls: "test", text: "THỬ" });
    /*TEST-END*/
    bar.appendChild(h("div", { cls: "hd" }, h("span", { cls: "dot" }), h("span", { cls: "t", "data-role": "title", text: "Kiểm kê Circa ↔ NW: " + title }), badge,
      h("button", { cls: "x", title: minimized ? "Mở rộng" : "Thu gọn", text: minimized ? "▢" : "–", on: { click: trusted(function () { minimized = !minimized; render(); }) } })));
    var body = h("div", { cls: "body" });
    if (cur && cur.msg) body.appendChild(h("div", { cls: "msg", "data-role": "msg", text: cur.msg }));
    if (err) body.appendChild(h("div", { cls: "msg", "data-role": "err", text: err }));
    var info = [];
    if (cur && cur.code) info.push("Phiên Circa " + cur.code);
    if (cur && cur.storeName) info.push("cửa hàng " + cur.storeName);
    if (info.length) body.appendChild(h("div", { cls: "sub", text: info.join(" · ") }));
    var row = h("div", { cls: "row" });
    if (st === "linked") {
      body.appendChild(nwLine());
      row.appendChild(h("button", { cls: "pri", "data-act": "send", disabled: !!busy, text: "Lấy kết quả từ NW và gửi vào Circa", on: { click: guarded(openPanel) } }));
    } else if (st === "nw-closed") {
      if (cur.nwId) body.appendChild(nwLine());
      // KHOÁ gửi: phiên NW không còn in_progress; extension không tự tạo phiên NW khác
      row.appendChild(h("button", { cls: "pri", "data-act": "send", disabled: true, title: "Phiên NW liên kết không còn đang kiểm", text: "Lấy kết quả từ NW và gửi vào Circa (đã khoá)" }));
    } else if (st === "unlinked") {
      if (!askOpen) row.appendChild(h("button", { "data-act": "ask-open", disabled: !!busy, text: "Tạo phiên NW cho phiên này?", on: { click: guarded(function () { askOpen = true; render(); }) } }));
      else {
        body.appendChild(h("div", { cls: "msg", "data-role": "ask", text: "Tạo phiên kiểm kê NW (cả kho) liên kết với phiên " + (cur.code || curId) + "? Extension tìm theo ghi chú trước, không tạo trùng." }));
        row.appendChild(h("button", { cls: "pri", "data-act": "ask-yes", disabled: !!busy, text: "Tạo phiên NW", on: { click: guarded(doAsk) } }));
        row.appendChild(h("button", { "data-act": "ask-no", disabled: !!busy, text: "Không", on: { click: trusted(function () { askOpen = false; render(); }) } }));
      }
    } else if (st === "pending" || st === "error" || st === "no-warehouse" || st === "no-permission" || st === "conflict" || st === "none") {
      row.appendChild(h("button", { "data-act": "retry", disabled: !!busy, text: "Thử lại", on: { click: guarded(doRetry) } }));
    } else if (st === "unknown-store" || st === "loading" || st === "rate-limited") {
      row.appendChild(h("button", { "data-act": "reload", disabled: !!busy, text: "Kiểm lại", on: { click: trusted(status) } }));
    }
    if (busy) row.appendChild(h("span", { cls: "sub", text: busy }));
    if (row.firstChild) body.appendChild(row);
    bar.appendChild(body);
    root.appendChild(bar);
  }
  function take(r) {
    if (r && r.ok && r.v) { cur = r.v; err = ""; }
    else if (r && !r.ok) err = r.msg || "lỗi";
    schedulePoll();
    render();
  }
  function status() {
    if (!curId) return Promise.resolve();
    var id = curId;
    return send({ op: "status", id: id, pos: posFor(id) }).then(function (r) { if (id === curId) take(r); });
  }
  function doAsk() {
    var id = curId;
    busy = "Đang tạo…"; render();
    send({ op: "ask", id: id, pos: posFor(id) }).then(function (r) { busy = ""; askOpen = false; if (id === curId) take(r); });
  }
  function doRetry() {
    var id = curId;
    busy = "Đang thử lại…"; render();
    send({ op: "retry", id: id }).then(function (r) { busy = ""; if (id === curId) take(r); });
  }
  function openPanel() {
    send({ op: "openPanel", id: curId }).then(function (r) { if (!r || !r.ok) { err = (r && r.msg) || "không mở được"; render(); } });
  }
  // trạng thái đang chờ: hỏi lại mỗi 10 s (background tự thử lại bản ghi chờ tab ≤ 1 lần / 30 s)
  function schedulePoll() {
    if (pollT) { clearTimeout(pollT); pollT = null; }
    if (cur && (cur.state === "pending" || cur.state === "linking")) pollT = setTimeout(function () { pollT = null; status(); }, CFG.TEST ? 1500 : 10000);
  }

  // ---- theo dõi đường dẫn (trang admin là SPA) ----
  var lastHref = "";
  function route() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    var m = PATH_RE.exec(location.pathname), id = m ? m[1].toLowerCase() : "";
    if (id === curId) return;
    curId = id; cur = null; err = ""; askOpen = false; busy = "";
    if (!id) { removeBar(); return; }
    render();
    status();
  }
  function start() { route(); setInterval(route, 700); window.addEventListener("popstate", route); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
