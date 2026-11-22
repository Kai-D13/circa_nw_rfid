/* Extension "Kiểm kê Circa ↔ NW": ĐỌC TOKEN từ tab đã đăng nhập (bridge.js). Chạy trong service worker.
 * Theo mẫu circa-tru-ton-bu-v0.1.1/lib/pos-bridge.js, nhưng chỉ ĐỌC token (không gọi mạng trong trang) và chạy ở world ISOLATED
 * (mặc định của executeScript) để script của trang không can thiệp được hàm đọc.
 *   Circa: cookie session_token của tab CIRCA_ADMIN (không httpOnly).
 *   NW:    JSON.parse(localStorage["auth-storage"]).state.accessToken của tab NW_APP (hạn 60 phút, trang NW tự làm mới).
 * Đọc NGAY TRƯỚC mỗi lần gọi (api.js gọi getToken). Token chỉ nằm trong bộ nhớ của lần gọi đó: không lưu storage, không log,
 * không trả về content script / panel. Extension KHÔNG gọi /auth/refresh: token hết hạn → báo người dùng mở lại tab NW.
 * Token JWT đã hết hạn (exp) thì bỏ qua, thử tab khác; không còn tab nào → {err:"token-expired"}.
 */
(function (root) {
  "use strict";

  // ---- 2 hàm này chạy TRONG TRANG (tự chứa, không dùng biến bên ngoài) ----
  function kkReadCircaToken() {
    try {
      var m = String(document.cookie || "").match(/(?:^|;\s*)session_token=([^;]+)/);
      if (!m) return null;
      return decodeURIComponent(m[1]);
    } catch (e) { return null; }
  }
  function kkReadNwToken() {
    try {
      var raw = window.localStorage.getItem("auth-storage");
      if (!raw) return null;
      var j = JSON.parse(raw);
      var t = j && j.state && j.state.accessToken;
      return typeof t === "string" ? t : null;
    } catch (e) { return null; }
  }

  // exp của JWT (giây) → ms; không phải JWT / không có exp → null (không kiểm)
  function jwtExpMs(t) {
    try {
      var p = String(t).split(".");
      if (p.length !== 3) return null;
      var b = p[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b.length % 4) b += "=";
      var j = JSON.parse(typeof atob === "function" ? atob(b) : Buffer.from(b, "base64").toString("binary"));
      return j && typeof j.exp === "number" ? j.exp * 1000 : null;
    } catch (e) { return null; }
  }

  // deps (để test): {tabs:{query}, scripting:{executeScript}, cfg, now}
  function createBridge(deps) {
    var cfg = deps.cfg, now = deps.now || function () { return Date.now(); };
    async function readToken(side) {
      var pattern = side === "circa" ? cfg.CIRCA_ADMIN + "/*" : side === "nw" ? cfg.NW_APP + "/*" : null;
      if (!pattern) return { err: "no-token" };
      var tabs;
      try { tabs = await deps.tabs.query({ url: pattern }); } catch (e) { tabs = []; }
      tabs = (tabs || []).filter(function (t) { return t && typeof t.id === "number" && !t.discarded; });
      if (!tabs.length) return { err: "no-tab" };
      tabs.sort(function (a, b) { return (b.active ? 1 : 0) - (a.active ? 1 : 0) || (b.lastAccessed || 0) - (a.lastAccessed || 0); });
      var expired = false;
      for (var i = 0; i < tabs.length && i < 5; i++) {
        var res;
        try {
          res = await deps.scripting.executeScript({ target: { tabId: tabs[i].id }, func: side === "circa" ? kkReadCircaToken : kkReadNwToken });
        } catch (e) { continue; }
        var t = res && res[0] && typeof res[0].result === "string" ? res[0].result : null;
        res = null;
        if (!t) continue;
        var exp = jwtExpMs(t);
        if (exp != null && exp <= now() + 15000) { expired = true; t = null; continue; }
        return { token: t };
      }
      return { err: expired ? "token-expired" : "no-token" };
    }
    return { readToken: readToken };
  }

  var B = { createBridge: createBridge, kkReadCircaToken: kkReadCircaToken, kkReadNwToken: kkReadNwToken, jwtExpMs: jwtExpMs };
  if (typeof module === "object" && module && module.exports) module.exports = B;
  if (root) root.KKBRIDGE = B;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this));
