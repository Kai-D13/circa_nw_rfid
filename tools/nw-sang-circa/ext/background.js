/* Extension "Kiểm kê Circa ↔ NW": SERVICE WORKER (background.js). Nơi DUY NHẤT gọi mạng (qua api.js).
 * - Nhận tin từ content-circa.js (trang admin Circa) và panel.html; kiểm người gửi (sender.id, origin, url) trước khi làm gì.
 * - Luồng A (tự tạo phiên NW) nằm ở link.js; luồng B (panel) chỉ gọi các lệnh trong bảng API của api.js.
 * - Tin "created" của trang KHÔNG đủ để tự tạo: phải có sự kiện webRequest.onCompleted do CHÍNH extension thấy
 *   (POST CIRCA_API/v1/inventory/count/sessions, 200, từ khung chính tab đó, initiator = admin) trong CREATE_GATE_MS,
 *   mỗi sự kiện dùng cho 1 sessionId (KKLINK.createGate). Không có sự kiện → chỉ HỎI (probe). Tin từ mỗi tab bị giới hạn tần suất.
 * - Khoá gửi theo phiên (chrome.storage.session "send:<id>" = {tabId}): mỗi lúc chỉ 1 panel được submit cho 1 phiên.
 *   Bấm "Gửi kết quả" lần nữa → chuyển tới tab panel đang mở của phiên đó, không mở tab mới.
 * - Hàng đợi liên kết trong chrome.storage.local (khoá "link:<sessionId>"), không có token.
 * - Token đọc bằng bridge.js ngay trước mỗi lần gọi; không bao giờ gửi token ra content script / panel, không log.
 * Ghi lên hệ thống ngoài chỉ ở 2 lệnh: POST tạo phiên NW (link.js, sau khi tìm theo notes không thấy) và POST submit-rfid-batch
 * (panel, sau khi người dùng xác nhận trong trang và giữ khoá gửi của phiên).
 */
/* global importScripts, chrome, KKCFG, KKAPI, KKLINK, KKBRIDGE */
"use strict";
importScripts("config.js", "api.js", "link.js", "bridge.js");

var CFG = self.KKCFG;
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var bridge = KKBRIDGE.createBridge({ tabs: chrome.tabs, scripting: chrome.scripting, cfg: CFG });
var API = KKAPI.create({ cfg: CFG, fetch: function (u, o) { return fetch(u, o); }, getToken: bridge.readToken });
var store = {
  get: function (k) { return chrome.storage.local.get(k).then(function (o) { return o[k]; }); },
  set: function (k, v) { var o = {}; o[k] = v; return chrome.storage.local.set(o); },
  remove: function (k) { return chrome.storage.local.remove(k); },
  all: function () { return chrome.storage.local.get(null); }
};
var rate = KKLINK.createRateLimiter({ max: CFG.RATE_PROBE, windowMs: CFG.RATE_WINDOW_MS });
var rateCreated = KKLINK.createRateLimiter({ max: CFG.RATE_CREATED, windowMs: CFG.RATE_WINDOW_MS });
var gate = KKLINK.createGate({ windowMs: CFG.CREATE_GATE_MS, waitMs: CFG.CREATE_GATE_WAIT_MS });
var linker = KKLINK.createLinker({ api: API, store: store, cfg: CFG, onChange: broadcast, rate: rate });

function originOf(u) { try { return new URL(u).origin; } catch (e) { return ""; } }
function cleanId(v) { return typeof v === "string" && UUID.test(v.toLowerCase()) ? v.toLowerCase() : ""; }
var PANEL_URL = chrome.runtime.getURL("panel.html");
var CREATE_URL = CFG.CIRCA_API + "/v1/inventory/count/sessions";

// CHÍNH extension thấy lệnh tạo phiên Circa thành công từ một tab admin (không đọc body, chỉ ghi "tab X tạo phiên lúc T")
chrome.webRequest.onCompleted.addListener(function (d) {
  try {
    if (!d || d.method !== "POST" || d.statusCode !== 200 || typeof d.tabId !== "number" || d.tabId < 0 || d.frameId !== 0) return;
    if (d.url !== CREATE_URL || d.initiator !== CFG.CIRCA_ADMIN) return;
    gate.record(d.tabId, Date.now());
  } catch (e) { /* bỏ qua */ }
}, { urls: [CREATE_URL], types: ["xmlhttprequest"] });

// báo các tab admin: trạng thái phiên đổi (chỉ id, content script tự hỏi lại)
function broadcast(id) {
  chrome.tabs.query({ url: CFG.CIRCA_ADMIN + "/*" }).then(function (tabs) {
    tabs.forEach(function (t) { chrome.tabs.sendMessage(t.id, { op: "linkChanged", id: id }).catch(function () {}); });
  }).catch(function () {});
}

// người gửi: "admin" (content script khung chính trang admin) | "panel" (trang panel của extension) | null
function who(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return null;
  if (sender.tab && sender.frameId === 0 && originOf(sender.tab.url) === CFG.CIRCA_ADMIN && originOf(sender.url) === CFG.CIRCA_ADMIN &&
    (sender.origin === undefined || sender.origin === CFG.CIRCA_ADMIN)) return "admin";
  if (typeof sender.url === "string" && sender.url.split(/[?#]/)[0] === PANEL_URL) return "panel";
  return null;
}

// kết quả API gửi ra ngoài: chỉ các trường an toàn
function out(r) {
  if (!r) return { status: 0, err: "none" };
  var o = { status: r.status, ms: r.ms };
  if (r.err) { o.err = r.err; o.msg = r.msg; }
  if (r.j !== undefined) o.j = r.j;
  if (r.badJson) { o.badJson = true; o.raw = r.raw; }
  return o;
}
function b64(bytes) {
  var s = "", CH = 0x8000;
  for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

async function linkedRec(id) {
  var rec = await linker.get(id);
  if (!rec || rec.state !== "linked" || !UUID.test(String(rec.nwId || "")) || !UUID.test(String(rec.posId || ""))) return null;
  return rec;
}

// ---------- tab panel của một phiên ----------
function panelIdOf(url) {
  var s = String(url || ""), i = s.search(/[?#]/);
  if (i < 0 || s.charAt(i) !== "?" || s.slice(0, i) !== PANEL_URL) return "";
  return cleanId(new URLSearchParams(s.slice(i + 1).split("#")[0]).get("circa") || "");
}
async function findPanelTab(id) {
  var tabs = await chrome.tabs.query({});
  return tabs.filter(function (t) { return t && t.url && panelIdOf(t.url) === id; })[0] || null;
}
async function tabAlive(tabId) {
  try { var t = await chrome.tabs.get(tabId); return !!t; } catch (e) { return false; }
}

// ---------- khoá gửi theo phiên (storage.session: chỉ SW + trang extension đọc được; mất khi đóng trình duyệt) ----------
var sendChain = Promise.resolve();
function serial(fn) { var p = sendChain.then(fn, fn); sendChain = p.then(function () {}, function () {}); return p; }
function sendKey(id) { return "send:" + id; }
function beginSend(id, tabId) {
  return serial(async function () {
    var k = sendKey(id), cur = (await chrome.storage.session.get(k))[k];
    if (cur && cur.tabId !== tabId && await tabAlive(cur.tabId)) return { ok: false, refused: true, msg: "Đang có panel khác gửi kết quả cho phiên này (tab khác). Chờ panel đó xong hoặc đóng tab đó." };
    var o = {}; o[k] = { tabId: tabId, at: Date.now() };
    await chrome.storage.session.set(o);
    return { ok: true };
  });
}
function endSend(id, tabId) {
  return serial(async function () {
    var k = sendKey(id), cur = (await chrome.storage.session.get(k))[k];
    if (cur && cur.tabId === tabId) await chrome.storage.session.remove(k);
    return { ok: true };
  });
}
async function holdsSend(id, tabId) {
  var k = sendKey(id), cur = (await chrome.storage.session.get(k))[k];
  return !!cur && cur.tabId === tabId;
}
chrome.tabs.onRemoved.addListener(function (tabId) {
  serial(async function () {
    var all = await chrome.storage.session.get(null), rm = Object.keys(all).filter(function (k) { return k.indexOf("send:") === 0 && all[k] && all[k].tabId === tabId; });
    if (rm.length) await chrome.storage.session.remove(rm);
  }).catch(function () {});
});

async function handleAdmin(msg, sender) {
  var id = cleanId(msg.id), pos = cleanId(msg.pos || ""), tabId = sender.tab.id;
  if (!id) return { ok: false, msg: "id phiên không hợp lệ" };
  switch (msg.op) {
    case "created": {
      if (!rateCreated.hit(tabId)) return { ok: true, v: { sessionId: id, state: "rate-limited", msg: "Quá nhiều tin tạo phiên từ tab này; thử lại sau 1 phút." } };
      var ev = await gate.claim(tabId, id);
      // không có sự kiện tạo do extension tự thấy → không tự tạo, chỉ kiểm trạng thái (thanh hỏi người dùng)
      if (!ev) return { ok: true, gated: false, v: KKLINK.view(await linker.probe(id, pos, { rateKey: tabId })) };
      return { ok: true, gated: true, v: KKLINK.view(await linker.onCreated(id, pos, ev.t)) };
    }
    case "status": return { ok: true, v: KKLINK.view(await linker.probe(id, pos, { rateKey: tabId })) };
    case "ask": return { ok: true, v: KKLINK.view(await linker.ask(id, pos)) };
    case "retry": return { ok: true, v: KKLINK.view(await linker.retry(id)) };
    case "openPanel": {
      var rec = await linkedRec(id);
      if (!rec) return { ok: false, msg: "Phiên chưa liên kết phiên NW (hoặc phiên NW đã đóng)." };
      var t = await findPanelTab(id);
      if (t) {
        await chrome.tabs.update(t.id, { active: true });
        if (typeof t.windowId === "number") await chrome.windows.update(t.windowId, { focused: true }).catch(function () {});
        return { ok: true, focused: true };
      }
      await chrome.tabs.create({ url: PANEL_URL + "?circa=" + id, index: sender.tab.index + 1, openerTabId: tabId });
      return { ok: true };
    }
  }
  return { ok: false, msg: "lệnh không hỗ trợ" };
}

async function handlePanel(msg, sender) {
  var id = cleanId(msg.id);
  if (!id) return { ok: false, msg: "id phiên không hợp lệ" };
  var tabId = sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : -1;
  var rec = await linker.get(id);
  if (msg.op === "init") return { ok: true, v: KKLINK.view(rec), cfg: { test: CFG.TEST, version: CFG.VERSION, admin: CFG.CIRCA_ADMIN, nwApp: CFG.NW_APP, device: CFG.DEVICE_ID, scanLimit: CFG.SCAN_LIMIT, retries: CFG.SUBMIT_RETRIES, retryBase: CFG.RETRY_BASE_MS, timeout: CFG.TIMEOUT_MS } };
  if (msg.op === "endSend") return tabId >= 0 ? endSend(id, tabId) : { ok: false, refused: true, msg: "panel phải chạy trong một tab" };
  rec = await linkedRec(id);
  if (!rec) return { ok: false, refused: true, msg: "Phiên Circa chưa liên kết phiên NW đang mở (hoặc bản ghi hỏng)." };
  var pos = rec.posId;
  switch (msg.op) {
    case "beginSend": return tabId >= 0 ? beginSend(id, tabId) : { ok: false, refused: true, msg: "panel phải chạy trong một tab" };
    case "circaSession": return { ok: true, r: out(await API.call("circa.session", { id: id, posId: pos })) };
    case "circaAuthz": {
      var a = await API.call("circa.authz", { posId: pos });
      var o = { status: a.status, err: a.err, msg: a.msg };
      if (a.status === 200) { o.manage = KKLINK.hasCapability(a.j, "inventory_count.manage"); o.view = KKLINK.hasCapability(a.j, "inventory_count.view"); }
      else if (a.j) o.j = a.j && a.j.errors ? { errors: a.j.errors } : null;
      return { ok: true, r: o };
    }
    case "nwRec": return { ok: true, r: out(await API.call("nw.rec", { id: rec.nwId, q: { omitScannedEpcs: "true" } })) };
    case "nwExport": {
      var e = await API.call("nw.export", { id: rec.nwId, q: { format: "xlsx", scope: "all", includeEpcs: "true", locale: "vi" } });
      if (e.status === 200 && e.bytes) return { ok: true, r: { status: 200, size: e.size, type: e.type, ms: e.ms, b64: b64(e.bytes) } };
      return { ok: true, r: out(e) };
    }
    case "lookup": {
      var code = typeof msg.code === "string" ? msg.code : "";
      return { ok: true, r: out(await API.call("circa.qrLookup", { posId: pos, q: { pos_id: pos, qr_code: code } })) };
    }
    case "scans": return { ok: true, r: out(await API.call("circa.scans", { id: id, posId: pos, q: { limit: CFG.SCAN_LIMIT } })) };
    case "submit": {
      var body = msg.body;
      if (!body || typeof body !== "object" || body.session_id !== id) return { ok: false, refused: true, msg: "body.session_id phải là phiên của panel" };
      if (!(tabId >= 0 && await holdsSend(id, tabId))) return { ok: false, refused: true, msg: "Panel này không giữ khoá gửi của phiên (có panel khác đang gửi, hoặc chưa bắt đầu gửi)." };
      return { ok: true, r: out(await API.call("circa.submit", { posId: pos, body: body })) };
    }
  }
  return { ok: false, refused: true, msg: "lệnh không hỗ trợ" };
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  var w = who(sender);
  if (!w || !msg || typeof msg !== "object" || typeof msg.op !== "string") return false;
  /*TEST-BEGIN*/
  // CHỈ BẢN THỬ: giả SW chết giữa lô (lô vẫn gửi đi, nhưng cổng tin đóng không trả lời) → panel phải ghi "KHÔNG RÕ"
  if (CFG.TEST && w === "panel" && msg.op === "submit" && self.__KK_TEST__ && self.__KK_TEST__.dropSubmit > 0) {
    self.__KK_TEST__.dropSubmit--;
    handlePanel(msg, sender).catch(function () {});
    return false;
  }
  /*TEST-END*/
  var p = w === "admin" ? handleAdmin(msg, sender) : handlePanel(msg, sender);
  p.then(function (r) { sendResponse(r); }, function (e) { sendResponse({ ok: false, msg: "lỗi: " + String(e && e.message || e).slice(0, 200) }); });
  return true;
});

// có tab NW / admin tải xong → chạy lại bản ghi đang chờ tab (an toàn: tìm theo notes trước khi POST, clientOperationId chống trùng)
chrome.tabs.onUpdated.addListener(function (tabId, info, tab) {
  if (!info || info.status !== "complete" || !tab || !tab.url) return;
  var o = originOf(tab.url);
  if (o === CFG.NW_APP) linker.onNwTab().catch(function () {});
  else if (o === CFG.CIRCA_ADMIN) linker.onAdminTab().catch(function () {});
});

/*TEST-BEGIN*/
if (CFG.TEST) {
  // CHỈ BẢN THỬ (build-ext.js cắt khỏi bản thật): cho test-ext-ui.js đọc bản ghi (không có token), kiểm bảng API, giả SW chết giữa lô
  self.__KK_TEST__ = {
    dump: function () { return chrome.storage.local.get(null); },
    sendLocks: function () { return chrome.storage.session.get(null); },
    gateEvents: function () { return gate._events(); },
    check: function (m, u, b) { var c = API.check(m, u, b); return { ok: c.ok, why: c.why || "" }; },
    dropSubmit: 0
  };
}
/*TEST-END*/
