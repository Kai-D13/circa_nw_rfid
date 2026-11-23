/* Extension "Kiểm kê Circa ↔ NW" v0.2.1: SERVICE WORKER (background.js). Nơi DUY NHẤT gọi mạng (qua api.js).
 * - Nhận tin từ content-nw.js (nút "Gửi sang Circa" trên trang danh sách đối chiếu của web NW) và từ panel.html; kiểm người gửi
 *   (sender.id, origin, url) trước khi làm gì.
 * - content-nw.js chỉ được một lệnh: openPanel → mở panel.html thành tab mới. Không đọc gì của trang NW.
 * - panel chỉ gọi các lệnh trong bảng API của api.js; tham số (id phiên, pos_id, id phiên NW, trang) được kiểm lại ở đây.
 * - Khoá gửi theo phiên Circa (chrome.storage.session "send:<id>" = {tabId}): mỗi lúc chỉ 1 panel được submit cho 1 phiên Circa.
 * - Token đọc bằng bridge.js ngay trước mỗi lần gọi; không bao giờ gửi token ra content script / panel, không log, không lưu.
 * Lệnh ghi DUY NHẤT lên hệ thống ngoài: POST submit-rfid-batch (panel, sau khi người dùng xác nhận trong trang và giữ khoá gửi).
 * Lượt quét (v0.2.1): MỘT request scans?limit=SCAN_LIMIT, không offset (lệnh scans không nhận offset / page). Trả lời panel quá lớn
 * (Chrome: tin nhắn tối đa 64 MiB) → sendResponse ném lỗi, trang nhận lastError ("bg-lost") = không đạt; api.js chặn trước ở SCAN_MAX_BYTES.
 */
/* global importScripts, chrome, KKCFG, KKAPI, KKCHON, KKBRIDGE */
"use strict";
importScripts("config.js", "api.js", "chon.js", "bridge.js");

var CFG = self.KKCFG;
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var bridge = KKBRIDGE.createBridge({ tabs: chrome.tabs, scripting: chrome.scripting, cfg: CFG });
var API = KKAPI.create({ cfg: CFG, fetch: function (u, o) { return fetch(u, o); }, getToken: bridge.readToken });
var LIST_RE = new RegExp(CFG.NW_REC_LIST_PATH);

function originOf(u) { try { return new URL(u).origin; } catch (e) { return ""; } }
function pathOf(u) { try { return new URL(u).pathname; } catch (e) { return ""; } }
function cleanId(v) { return typeof v === "string" && UUID.test(v.toLowerCase()) ? v.toLowerCase() : ""; }
var PANEL_URL = chrome.runtime.getURL("panel.html");

// người gửi: "nw" (content script khung chính trang web NW) | "panel" (trang panel của extension) | null
function who(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return null;
  if (sender.tab && sender.frameId === 0 && originOf(sender.tab.url) === CFG.NW_APP && originOf(sender.url) === CFG.NW_APP &&
    (sender.origin === undefined || sender.origin === CFG.NW_APP)) return "nw";
  if (typeof sender.url === "string" && sender.url.split(/[?#]/)[0] === PANEL_URL) return "panel";
  return null;
}

// kết quả API gửi ra ngoài: chỉ các trường an toàn
function out(r) {
  if (!r) return { status: 0, err: "none" };
  var o = { status: r.status, ms: r.ms };
  if (r.err) { o.err = r.err; o.msg = r.msg; }
  if (typeof r.timeoutMs === "number") o.timeoutMs = r.timeoutMs;
  if (typeof r.size === "number") o.size = r.size;
  if (r.j !== undefined) o.j = r.j;
  if (r.badJson) { o.badJson = true; o.raw = r.raw; }
  return o;
}
function b64(bytes) {
  var s = "", CH = 0x8000;
  for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
function pageOf(v, max) { var n = typeof v === "number" ? v : NaN; return Number.isSafeInteger(n) && n >= 1 && n <= max ? n : 0; }

async function tabAlive(tabId) {
  try { var t = await chrome.tabs.get(tabId); return !!t; } catch (e) { return false; }
}

// ---------- khoá gửi theo phiên Circa (storage.session: chỉ SW + trang extension đọc được; mất khi đóng trình duyệt) ----------
var sendChain = Promise.resolve();
function serial(fn) { var p = sendChain.then(fn, fn); sendChain = p.then(function () {}, function () {}); return p; }
function sendKey(id) { return "send:" + id; }
function beginSend(id, tabId) {
  return serial(async function () {
    var k = sendKey(id), cur = (await chrome.storage.session.get(k))[k];
    if (cur && cur.tabId !== tabId && await tabAlive(cur.tabId)) return { ok: false, refused: true, msg: "Đang có panel khác gửi kết quả cho phiên Circa này (tab khác). Chờ panel đó xong hoặc đóng tab đó." };
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

// ---------- trang NW: chỉ mở panel ----------
async function handleNw(msg, sender) {
  if (msg.op !== "openPanel") return { ok: false, msg: "lệnh không hỗ trợ" };
  if (!LIST_RE.test(pathOf(sender.url))) return { ok: false, msg: "Chỉ mở từ trang danh sách đối chiếu của web NW." };
  var o = { url: PANEL_URL, openerTabId: sender.tab.id };
  if (typeof sender.tab.index === "number") o.index = sender.tab.index + 1;
  await chrome.tabs.create(o);
  return { ok: true };
}

// ---------- panel ----------
async function handlePanel(msg, sender) {
  var tabId = sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : -1;
  var id = cleanId(msg.id), pos = cleanId(msg.pos), nwId = cleanId(msg.nwId);
  switch (msg.op) {
    case "init": return { ok: true, cfg: { test: CFG.TEST, version: CFG.VERSION, device: CFG.DEVICE_ID, scanLimit: CFG.SCAN_LIMIT, scanTimeout: CFG.SCAN_TIMEOUT_MS,
      scanMaxBytes: CFG.SCAN_MAX_BYTES, scanTries: CFG.SCAN_READ_TRIES, scanGap: CFG.SCAN_READ_GAP_MS, retries: CFG.SUBMIT_RETRIES, retryBase: CFG.RETRY_BASE_MS, timeout: CFG.TIMEOUT_MS,
      circaPages: CFG.CIRCA_LIST_PAGES, circaLimit: CFG.CIRCA_LIST_LIMIT, recPages: CFG.REC_LIST_PAGES, recLimit: CFG.REC_PAGE_LIMIT } };
    case "circaList": {
      var pg = pageOf(msg.page, CFG.CIRCA_LIST_PAGES);
      if (!pg) return { ok: false, refused: true, msg: "trang không hợp lệ" };
      return { ok: true, r: out(await API.call("circa.sessions", { q: { page: pg, limit: CFG.CIRCA_LIST_LIMIT } })) };
    }
    case "nwWarehouses": return { ok: true, r: out(await API.call("nw.warehouses")) };
    case "nwRecList": {
      var pn = pageOf(msg.page, CFG.REC_LIST_PAGES);
      if (!pn) return { ok: false, refused: true, msg: "trang không hợp lệ" };
      return { ok: true, r: out(await API.call("nw.recList", { q: { page: pn, limit: CFG.REC_PAGE_LIMIT } })) };
    }
    case "nwRec":
      if (!nwId) return { ok: false, refused: true, msg: "id phiên NW không hợp lệ" };
      return { ok: true, r: out(await API.call("nw.rec", { id: nwId, q: { omitScannedEpcs: "true" } })) };
    case "nwExport": {
      if (!nwId) return { ok: false, refused: true, msg: "id phiên NW không hợp lệ" };
      var e = await API.call("nw.export", { id: nwId, q: { format: "xlsx", scope: "all", includeEpcs: "true", locale: "vi" } });
      if (e.status === 200 && e.bytes) return { ok: true, r: { status: 200, size: e.size, type: e.type, ms: e.ms, b64: b64(e.bytes) } };
      return { ok: true, r: out(e) };
    }
  }
  // các lệnh dưới đây gắn với MỘT phiên Circa: id + pos_id của phiên đó (X-Store-Id)
  if (!id) return { ok: false, refused: true, msg: "id phiên Circa không hợp lệ" };
  if (msg.op === "endSend") return tabId >= 0 ? endSend(id, tabId) : { ok: false, refused: true, msg: "panel phải chạy trong một tab" };
  if (msg.op === "beginSend") return tabId >= 0 ? beginSend(id, tabId) : { ok: false, refused: true, msg: "panel phải chạy trong một tab" };
  if (!pos) return { ok: false, refused: true, msg: "pos_id không hợp lệ" };
  switch (msg.op) {
    case "circaSession": return { ok: true, r: out(await API.call("circa.session", { id: id, posId: pos })) };
    case "circaAuthz": {
      var a = await API.call("circa.authz", { posId: pos });
      var o = { status: a.status, err: a.err, msg: a.msg };
      if (a.status === 200) { o.manage = KKCHON.hasCapability(a.j, "inventory_count.manage"); o.view = KKCHON.hasCapability(a.j, "inventory_count.view"); }
      else if (a.j) o.j = a.j && a.j.errors ? { errors: a.j.errors } : null;
      return { ok: true, r: o };
    }
    case "lookup": {
      var code = typeof msg.code === "string" ? msg.code : "";
      return { ok: true, r: out(await API.call("circa.qrLookup", { posId: pos, q: { pos_id: pos, qr_code: code } })) };
    }
    case "scans":
      // TOÀN BỘ lượt quét bằng MỘT request: limit = SCAN_LIMIT, không offset (v0.2.1 không lật trang: offset trên Circa thật trả trùng / sót).
      // Tin có offset / page (panel cũ hoặc gọi nhầm) → từ chối, không gọi mạng.
      if (msg.offset !== undefined || msg.page !== undefined) return { ok: false, refused: true, msg: "lượt quét chỉ đọc bằng một request (không nhận offset / page)" };
      return { ok: true, r: out(await API.call("circa.scans", { id: id, posId: pos, q: { limit: CFG.SCAN_LIMIT } })) };
    case "scanSummary":
      // tổng số lượt quét của phiên (data.total_scans), đọc trước và sau request lượt quét
      return { ok: true, r: out(await API.call("circa.summary", { id: id, posId: pos })) };
    case "submit": {
      var body = msg.body;
      if (!body || typeof body !== "object" || body.session_id !== id) return { ok: false, refused: true, msg: "body.session_id phải là phiên Circa đã chọn" };
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
  var p = w === "nw" ? handleNw(msg, sender) : handlePanel(msg, sender);
  // sendResponse ném lỗi khi tin quá lớn (Chrome: "Message exceeded maximum allowed size of 64MiB."): trang nhận lastError → "bg-lost",
  // không nhận phần nào của kết quả (đã thử trên Chromium 151). Bắt lỗi để không thành lỗi Promise trôi; thử báo một tin nhỏ.
  function reply(r) {
    try { sendResponse(r); }
    catch (e) { try { sendResponse({ ok: false, msg: "background không gửi được kết quả về trang: " + String(e && e.message || e).slice(0, 200) }); } catch (e2) { /* trang nhận lastError */ } }
  }
  p.then(reply, function (e) { reply({ ok: false, msg: "lỗi: " + String(e && e.message || e).slice(0, 200) }); });
  return true;
});

/*TEST-BEGIN*/
if (CFG.TEST) {
  // CHỈ BẢN THỬ (build-ext.js cắt khỏi bản thật): cho test-ext-ui.js xem khoá gửi, kiểm bảng API, giả SW chết giữa lô
  self.__KK_TEST__ = {
    sendLocks: function () { return chrome.storage.session.get(null); },
    check: function (m, u, b) { var c = API.check(m, u, b); return { ok: c.ok, why: c.why || "" }; },
    dropSubmit: 0
  };
}
/*TEST-END*/
