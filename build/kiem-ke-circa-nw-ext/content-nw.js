/* Extension "Kiểm kê Circa ↔ NW" v0.2.1: CONTENT SCRIPT trang web NW (content-nw.js). World ISOLATED, document_idle, khung chính.
 * - Chỉ trên trang danh sách đối chiếu <NW_APP>/<locale>/stock/reconciliation (SPA: theo dõi đường dẫn, rời trang thì gỡ nút).
 * - Vẽ MỘT nút nổi "Gửi sang Circa" (shadow DOM đóng, chỉ textContent). Bấm (chỉ nhận click isTrusted) → nhắn background mở panel.html
 *   thành tab mới. Không đọc, không sửa DOM của trang NW (chỉ gắn phần tử chủ của nút), không đọc token, không gọi mạng.
 */
/* global chrome, KKCFG */
(function () {
  "use strict";
  var CFG = self.KKCFG;
  if (!CFG || location.origin !== CFG.NW_APP || window.top !== window) return;
  var PATH_RE = new RegExp(CFG.NW_REC_LIST_PATH);
  var host = null, root = null, msg = "", busy = false;

  function send(m) {
    return new Promise(function (res) {
      try {
        chrome.runtime.sendMessage(m, function (r) {
          if (chrome.runtime.lastError) return res({ ok: false, msg: "extension không phản hồi (" + chrome.runtime.lastError.message + ")" });
          res(r || { ok: false, msg: "không có phản hồi" });
        });
      } catch (e) { res({ ok: false, msg: "extension đã tải lại: tải lại trang" }); }
    });
  }
  function h(tag, props, text) {
    var e = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) { e.setAttribute(k, String(props[k])); });
    if (text != null) e.textContent = String(text);
    return e;
  }
  var CSS = [
    ":host{all:initial}",
    ".w{display:flex;flex-direction:column;align-items:flex-end;gap:6px;font:13px/1.4 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif}",
    "button{font:inherit;font-weight:600;padding:9px 14px;border-radius:999px;border:1px solid #1f6feb;background:#1f6feb;color:#fff;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.2)}",
    "button:disabled{opacity:.6;cursor:default}",
    ".m{max-width:320px;background:#fff;color:#cf222e;border:1px solid #d0d7de;border-radius:8px;padding:6px 10px;box-shadow:0 4px 14px rgba(0,0,0,.15)}",
    ".test{background:#cf222e;color:#fff;font-weight:700;font-size:11px;padding:1px 6px;border-radius:4px}"
  ].join("");
  // style của phần tử chủ: inline !important (CSS của trang không thắng), đặt lại mỗi lần vẽ
  var HOST_STYLE = { position: "fixed", right: "18px", bottom: "18px", left: "auto", top: "auto", "z-index": "2147483647", margin: "0", padding: "0", display: "block",
    opacity: "1", visibility: "visible", "pointer-events": "auto", transform: "none", filter: "none", border: "0", background: "transparent" };
  function pin() { try { Object.keys(HOST_STYLE).forEach(function (k) { host.style.setProperty(k, HOST_STYLE[k], "important"); }); } catch (e) { /* bỏ qua */ } }

  function render() {
    if (!host || !host.isConnected) {
      if (!document.documentElement) return;
      host = document.createElement("kk-circa-nw-btn");
      // bản thật: shadow root ĐÓNG (script của trang không với tới nút); bản thử: mở để Playwright bấm được
      var mode = "closed";
      root = host.attachShadow({ mode: mode });
      (document.body || document.documentElement).appendChild(host);
    }
    pin();
    while (root.firstChild) root.removeChild(root.firstChild);
    var w = h("div", { "class": "w" });
    w.appendChild(h("style", null, CSS));
    if (msg) w.appendChild(h("div", { "class": "m", "data-role": "msg" }, msg));
    var b = h("button", { type: "button", "data-act": "open-panel", title: "Mở trang gửi kết quả phiên NW vào phiên kiểm kê Circa (tab mới)" }, busy ? "Đang mở…" : "Gửi sang Circa");
    if (busy) b.disabled = true;
    b.addEventListener("click", function (e) {
      if (!e || e.isTrusted !== true || busy) return;
      busy = true; msg = ""; render();
      send({ op: "openPanel" }).then(function (r) { busy = false; msg = r && r.ok ? "" : (r && r.msg) || "không mở được"; if (host) render(); });
    });
    w.appendChild(b);
    root.appendChild(w);
  }
  function remove() { if (host) { host.remove(); host = null; root = null; } msg = ""; busy = false; }

  var last = null;
  function route() {
    var on = PATH_RE.test(location.pathname);
    if (on === last && (!on || (host && host.isConnected))) return;
    last = on;
    if (on) render(); else remove();
  }
  route();
  setInterval(route, 700);
  window.addEventListener("popstate", route);
})();
