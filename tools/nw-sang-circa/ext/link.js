/* Extension "Kiểm kê Circa ↔ NW": LOGIC LIÊN KẾT phiên Circa ↔ phiên NW (link.js). Thuần: không gọi mạng trực tiếp, không đọc token;
 * mọi lệnh gọi qua deps.api.call (api.js) và lưu trữ qua deps.store. Chạy trong service worker; Node nạp để test (test-ext.js).
 *
 * Luồng A (tự tạo), theo kế hoạch 22/11 + sửa sau soát độc lập 22/11:
 *   0. Background chỉ gọi onCreated khi CHÍNH extension thấy lệnh tạo (webRequest.onCompleted POST …/count/sessions 200 từ tab đó,
 *      createGate bên dưới: ≤ 30 s, mỗi sự kiện dùng cho MỘT sessionId). Không có sự kiện → hạ xuống probe (chỉ hỏi).
 *   1. onCreated(id, posHint, seenAt). 2. Tự GET phiên Circa (X-Store-Id = posHint) và kiểm: id trùng, pos_id = posHint,
 *      counting_mode = AUTO_COUNTING_MODE, created_at trong AUTO_WINDOW_MS trước lúc thấy, trạng thái LOADING_BASELINE/OPEN.
 *   3. Ghi {sessionId, code, posId, state:"pending"} TRƯỚC khi gọi NW.
 *   4. GET entity/stores/<pos_id> → tên cửa hàng. NW: /auth/me (quyền stock.reconcile trong permissionNames / permissions[].name),
 *      /warehouses (mảng, duyệt cả children) → đúng 1 kho trùng tên (matchWarehouse).
 *   5. Chống trùng: tìm phiên NW có notes chứa sessionId (≤ REC_SEARCH_PAGES trang; đọc totalPages ở gốc hoặc meta.totalPages,
 *      không đọc được → DỪNG, không POST). Thấy 1 → xét kho (đúng kho đã ghép) + trạng thái (in_progress → linked;
 *      cancelled/completed/approved → "nw-closed", KHÔNG tạo phiên khác). Không thấy → POST {warehouseId, notes, clientOperationId};
 *      response phải có scopeType "warehouse" và đúng kho, notes chứa sessionId.
 *   6. Lưu nwId, state "linked".
 *   Lỗi: không có tab / token NW, 401 NW → pending "nw-tab" (tự chạy lại khi có tab NW tải xong / khi thanh trạng thái hỏi,
 *   ≤ 1 lần / AUTO_RETRY_MS). 5xx / timeout → pending "loi-mang" (chỉ chạy lại khi người dùng bấm “Thử lại”).
 * probe(): phiên mở từ URL chưa có bản ghi → tra notes trên NW (chỉ đọc) → "unlinked" để HỎI; ask() chạy bước 2–6 bỏ điều kiện 10 phút.
 * Mỗi phiên một hàng đợi (mutex) trong bộ nhớ. Bản ghi KHÔNG chứa token.
 */
(function (root, factory) {
  var L = factory();
  if (typeof module === "object" && module && module.exports) module.exports = L;
  if (root) root.KKLINK = L;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  var UUID_I = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var CODE_RE = /^[A-Za-z0-9_-]{1,40}$/;
  var OPEN_STATES = { LOADING_BASELINE: 1, OPEN: 1 };
  var NW_CLOSED = { cancelled: "đã huỷ", completed: "đã hoàn tất", approved: "đã duyệt" };
  var KEY = "link:";
  var MAX_RECORDS = 300;

  function cleanId(v) { return typeof v === "string" && UUID_I.test(v) ? v.toLowerCase() : ""; }
  // tên kho / tên cửa hàng: NFC, bỏ khoảng trắng đầu/cuối, chữ thường. KHÔNG bỏ dấu, không gộp khoảng trắng giữa, không khớp gần đúng.
  function normName(s) { return typeof s === "string" ? s.normalize("NFC").trim().toLowerCase() : ""; }
  function notesFor(code, sessionId) { return "CIRCA " + code + " " + sessionId; }
  function clientOpId(sessionId) { return "circa-" + sessionId; }
  function notesHas(notes, sessionId) { return typeof notes === "string" && notes.toLowerCase().indexOf(String(sessionId).toLowerCase()) >= 0; }
  function short(s, n) { s = String(s == null ? "" : s); return s.length > (n || 120) ? s.slice(0, n || 120) + "…" : s; }

  function sessOf(r) {
    var d = r && r.status === 200 && r.j && r.j.data;
    return d && typeof d === "object" ? (d.session && typeof d.session === "object" ? d.session : d) : null;
  }
  function dataOf(r) { var j = r && r.j; return j && typeof j === "object" && j.data && typeof j.data === "object" && !Array.isArray(j.data) ? j.data : j; }
  // danh sách kho: mảng ở gốc (dạng thật 22/11), hoặc {data:[…]}; dạng phân trang còn trang sau → null (không đoán)
  function warehousesOf(j) {
    if (Array.isArray(j)) return { list: j };
    if (j && typeof j === "object" && Array.isArray(j.data)) {
      var tp = +j.totalPages, pg = +j.page;
      if (tp > 1 && !(pg >= tp)) return { list: null, why: "danh sách kho có " + tp + " trang: extension chưa đọc trang sau" };
      return { list: j.data };
    }
    return { list: null, why: "phản hồi /warehouses không phải mảng" };
  }
  // Kho dạng cây: duyệt mọi cấp qua children (≤ 10 cấp), khử trùng theo id (một kho có thể vừa ở gốc vừa nằm trong children cha).
  function flattenWarehouses(list) {
    var out = [], seen = {};
    (function walk(arr, depth) {
      if (!Array.isArray(arr) || depth > 10) return;
      arr.forEach(function (w) {
        if (!w || typeof w !== "object") return;
        var id = cleanId(String(w.id || ""));
        if (id && !seen[id]) { seen[id] = 1; out.push(w); }
        else if (!id) out.push(w);
        walk(w.children, depth + 1);
      });
    })(list, 0);
    return out;
  }

  // Ghép kho NW với tên cửa hàng Circa, MỌI CẤP của cây kho.
  // → {ok:true, wh:{id,name,code}} | {ok:false, why:"none"|"many"|"bad-input", count, candidates:[tên]}
  function matchWarehouse(storeName, list) {
    var want = normName(storeName);
    if (!want || !Array.isArray(list)) return { ok: false, why: "bad-input", count: 0, candidates: [] };
    var usable = flattenWarehouses(list).filter(function (w) {
      return w.locationType === "warehouse" && w.closedAt == null && typeof w.name === "string" && cleanId(String(w.id || ""));
    });
    var hit = usable.filter(function (w) { return normName(w.name) === want; });
    if (hit.length === 1) return { ok: true, wh: { id: cleanId(String(hit[0].id)), name: hit[0].name, code: hit[0].code == null ? "" : String(hit[0].code) } };
    return { ok: false, why: hit.length ? "many" : "none", count: hit.length, candidates: usable.map(function (w) { return w.name; }).slice(0, 30) };
  }

  // Quyền Circa (/authz/me): chịu được mảng chuỗi lẫn mảng object, lồng nhau.
  // → true | false (đọc được danh sách quyền mà không có) | null (không đọc được cấu trúc: KHÔNG chặn)
  function hasCapability(json, cap) {
    var found = false, sawCap = false, n = 0;
    var CAPLIKE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/;
    function walk(v, depth) {
      if (found || n > 20000 || depth > 8 || v == null) return;
      n++;
      if (typeof v === "string") { if (CAPLIKE.test(v)) { sawCap = true; if (v === cap) found = true; } return; }
      if (Array.isArray(v)) { for (var i = 0; i < v.length && !found; i++) walk(v[i], depth + 1); return; }
      if (typeof v === "object") { for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) walk(v[k], depth + 1); }
    }
    walk(json, 0);
    return found ? true : sawCap ? false : null;
  }
  // Quyền NW (/auth/me, dạng thật 22/11): permissionNames = mảng chuỗi (ưu tiên); permissions = mảng object {id,name,description}
  // (lấy .name) hoặc mảng chuỗi. Xét ở gốc, data, user, data.user. → mảng chuỗi | null (không đọc được)
  function nwPermissions(j) {
    var cands = [j, j && j.data, j && j.user, j && j.data && j.data.user];
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (c && typeof c === "object" && Array.isArray(c.permissionNames)) return c.permissionNames.filter(function (x) { return typeof x === "string"; });
    }
    for (i = 0; i < cands.length; i++) {
      c = cands[i];
      if (c && typeof c === "object" && Array.isArray(c.permissions)) {
        return c.permissions.map(function (x) { return typeof x === "string" ? x : x && typeof x === "object" && typeof x.name === "string" ? x.name : null; })
          .filter(function (x) { return typeof x === "string"; });
      }
    }
    return null;
  }

  function verifySession(raw, id, posId) {
    if (!raw || typeof raw !== "object") return { ok: false, why: "không đọc được phiên Circa" };
    var sid = cleanId(String(raw.id || "")), pos = cleanId(String(raw.pos_id || ""));
    if (sid !== id) return { ok: false, why: "phiên Circa trả về id khác" };
    if (!pos) return { ok: false, why: "phiên Circa không có pos_id" };
    if (posId && pos !== posId) return { ok: false, why: "phiên thuộc cửa hàng khác với cửa hàng trang báo" };
    var code = String(raw.code == null ? "" : raw.code);
    if (!CODE_RE.test(code)) return { ok: false, why: "mã phiên Circa không đúng dạng: " + short(code, 40) };
    var t = Date.parse(String(raw.created_at || ""));
    return { ok: true, s: { id: sid, code: code, posId: pos, mode: String(raw.counting_mode == null ? "" : raw.counting_mode), createdAt: isFinite(t) ? new Date(t).toISOString() : null, createdMs: isFinite(t) ? t : null, status: String(raw.status || "") } };
  }
  function inWindow(createdMs, seenAt, cfg) {
    return typeof createdMs === "number" && createdMs >= seenAt - cfg.AUTO_WINDOW_MS && createdMs <= seenAt + cfg.CLOCK_SKEW_MS;
  }
  function recOf(r) {
    var j = r && r.j;
    if (!j || typeof j !== "object") return null;
    var o = j.id != null ? j : j.data && typeof j.data === "object" && j.data.id != null ? j.data : null;
    return o && cleanId(String(o.id)) ? o : null;
  }
  // kho của một phiên NW: warehouseId, hoặc warehouse.id
  function recWarehouseId(x) {
    if (!x || typeof x !== "object") return "";
    return cleanId(String(x.warehouseId || "")) || (x.warehouse && typeof x.warehouse === "object" ? cleanId(String(x.warehouse.id || "")) : "");
  }
  // danh sách phiên NW (dạng thật: {data,total,page,limit,totalPages} ở gốc; dự phòng meta.totalPages).
  // → {list, totalPages: số | null (không đọc được → coi như CHƯA tìm hết)} | null (không phải danh sách)
  function recListOf(r) {
    var j = r && r.j;
    if (Array.isArray(j)) return { list: j, totalPages: 1 }; // mảng trần: không phân trang, là toàn bộ
    if (!j || typeof j !== "object" || !Array.isArray(j.data)) return null;
    var tp = j.totalPages != null ? j.totalPages : j.meta && typeof j.meta === "object" ? j.meta.totalPages : null;
    tp = typeof tp === "number" ? tp : typeof tp === "string" && /^\d+$/.test(tp) ? +tp : NaN;
    return { list: j.data, totalPages: Number.isSafeInteger(tp) && tp >= 0 ? tp : null };
  }
  function errKind(r) {
    if (!r) return "loi-mang";
    if (r.err === "no-tab" || r.err === "no-token" || r.err === "token-expired") return "no-token";
    if (r.err === "blocked" || r.err === "no-store") return "blocked";
    if (r.status === 401) return "401";
    if (r.status === 403) return "403";
    if (r.status === 0 || r.status >= 500 || r.status === 429) return "loi-mang";
    return "4xx";
  }
  function errText(r) {
    if (!r) return "không có phản hồi";
    if (r.status === 0) return (r.err || "lỗi") + (r.msg ? ": " + short(r.msg, 160) : "");
    var j = r.j, e = j && Array.isArray(j.errors) && j.errors[0], m = j && (j.message || (j.error && (j.error.message || j.error)));
    return "HTTP " + r.status + (e && typeof e === "object" ? " — " + short((e.code || "") + (e.message ? ": " + e.message : ""), 160) : m ? " — " + short(typeof m === "string" ? m : JSON.stringify(m), 160) : "");
  }
  // Xét phiên NW tìm thấy theo notes với kho đã ghép (cùng điều kiện như khi tạo mới).
  // → {state:"linked"|"nw-closed"|"conflict", msg, nwId, nwStatus}
  function judgeFound(f, whId) {
    var id = cleanId(String(f && f.id || "")), w = recWarehouseId(f), st = String(f && f.status || "");
    if (!id) return { state: "conflict", msg: "Phiên NW tìm thấy không có id hợp lệ." };
    if (!w) return { state: "conflict", msg: "Phiên NW " + id + " ghi phiên Circa này nhưng không có kho (warehouseId / warehouse): không liên kết; báo PM.", nwId: id };
    if (w !== whId) return { state: "conflict", msg: "Phiên NW " + id + " ghi phiên Circa này nhưng thuộc kho khác (" + short(f.warehouse && f.warehouse.name || w, 60) + "): không liên kết; báo PM.", nwId: id };
    if (f.scopeType != null && f.scopeType !== "warehouse") return { state: "conflict", msg: "Phiên NW " + id + " có phạm vi “" + short(f.scopeType, 30) + "”, không phải cả kho: không liên kết; báo PM.", nwId: id };
    if (st === "in_progress") return { state: "linked", nwId: id, nwStatus: st };
    if (NW_CLOSED[st]) return { state: "nw-closed", nwId: id, nwStatus: st, msg: "Phiên NW liên kết " + id + " " + NW_CLOSED[st] + " (status " + st + "). Extension KHÔNG tạo phiên NW khác và không gửi kết quả; báo PM nếu cần phiên mới." };
    return { state: "conflict", nwId: id, nwStatus: st, msg: "Phiên NW " + id + " có trạng thái lạ “" + short(st, 30) + "”: không liên kết; báo PM." };
  }

  // ---------- cổng "chính extension thấy lệnh tạo" ----------
  // record(tabId, t): webRequest.onCompleted thấy POST …/count/sessions 200 từ tab đó lúc t.
  // claim(tabId, sessionId): lấy 1 sự kiện của tab trong windowMs (chờ tối đa waitMs vì tin của trang có thể tới trước webRequest);
  //   mỗi sự kiện chỉ dùng cho MỘT sessionId (tin lặp cùng sessionId dùng lại được sự kiện đó). → {t} | null
  function createGate(o) {
    o = o || {};
    var now = o.now || function () { return Date.now(); }, windowMs = o.windowMs || 30000, waitMs = o.waitMs == null ? 3000 : o.waitMs;
    var sleep = o.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var ev = [];
    function prune() { var n = now(); ev = ev.filter(function (x) { return n - x.t <= windowMs; }).slice(-100); }
    function record(tabId, t) { if (typeof tabId !== "number" || tabId < 0) return; prune(); ev.push({ tabId: tabId, t: typeof t === "number" && isFinite(t) ? t : now(), used: null }); }
    function take(tabId, id) {
      prune();
      var n = now(), mine = ev.filter(function (x) { return x.tabId === tabId && n - x.t <= windowMs && x.t <= n + 5000; });
      var same = mine.filter(function (x) { return x.used === id; })[0];
      if (same) return { t: same.t };
      var free = mine.filter(function (x) { return !x.used; }).sort(function (a, b) { return a.t - b.t; })[0];
      if (!free) return null;
      free.used = id;
      return { t: free.t };
    }
    async function claim(tabId, id) {
      var t0 = now();
      for (;;) {
        var e = take(tabId, id);
        if (e) return e;
        if (now() - t0 >= waitMs) return null;
        await sleep(100);
      }
    }
    return { record: record, claim: claim, _events: function () { return ev.slice(); } };
  }
  // giới hạn tần suất theo khoá (vd tab): tối đa max lần trong windowMs
  function createRateLimiter(o) {
    var now = o.now || function () { return Date.now(); }, max = o.max, win = o.windowMs, hits = {};
    return {
      hit: function (k) {
        var n = now(), a = (hits[k] || []).filter(function (t) { return n - t < win; });
        if (a.length >= max) { hits[k] = a; return false; }
        a.push(n); hits[k] = a;
        return true;
      }
    };
  }

  // ---------- Linker ----------
  // deps: {api:{call(id, p)}, store:{get(k), set(k,v), remove(k), all()}, cfg, now(), onChange(id), rate?:{hit(k)}}
  function createLinker(deps) {
    var cfg = deps.cfg, api = deps.api, store = deps.store, now = deps.now || function () { return Date.now(); };
    var locks = {}, busy = {}, probeCache = {}, lastAuto = {};
    function changed(id) { try { if (deps.onChange) deps.onChange(id); } catch (e) { /* bỏ qua */ } }
    function lock(id, fn) {
      var prev = locks[id] || Promise.resolve();
      busy[id] = (busy[id] || 0) + 1;
      function go() { return fn(); }
      var p = prev.then(go, go);
      locks[id] = p.then(function () { busy[id]--; }, function () { busy[id]--; });
      return p;
    }
    async function get(id) { var r = await store.get(KEY + id); return r && typeof r === "object" ? r : null; }
    async function save(rec, state, reason, msg, extra) {
      rec = Object.assign({}, rec, extra || {});
      rec.state = state; rec.reason = reason || ""; rec.msg = msg || ""; rec.updatedAt = new Date(now()).toISOString();
      rec.history = (rec.history || []).concat([{ at: rec.updatedAt, state: state, reason: rec.reason }]).slice(-20);
      await store.set(KEY + rec.sessionId, rec);
      delete probeCache[rec.sessionId];
      changed(rec.sessionId);
      return rec;
    }
    async function prune() {
      if (!store.all) return;
      var all = await store.all(), recs = Object.keys(all).filter(function (k) { return k.indexOf(KEY) === 0; }).map(function (k) { return all[k]; });
      if (recs.length <= MAX_RECORDS) return;
      recs.filter(function (r) { return r.state !== "linked"; }).sort(function (a, b) { return String(a.updatedAt).localeCompare(String(b.updatedAt)); })
        .slice(0, recs.length - MAX_RECORDS).forEach(function (r) { store.remove(KEY + r.sessionId); });
    }
    // tìm phiên NW có notes chứa id: → {found:[…], complete:bool, pages, why, r(lỗi HTTP)}
    async function searchNotes(id) {
      var found = [], pages = 0;
      for (var page = 1; page <= cfg.REC_SEARCH_PAGES; page++) {
        var lr = await api.call("nw.recList", { q: { page: page, limit: cfg.REC_PAGE_LIMIT } });
        if (lr.status !== 200) return { found: found, complete: false, pages: pages, err: lr };
        var L = recListOf(lr);
        if (!L) return { found: found, complete: false, pages: pages, why: "không đọc được danh sách phiên NW (trang " + page + ")" };
        pages = page;
        L.list.forEach(function (x) { if (x && typeof x === "object" && notesHas(x.notes, id)) found.push(x); });
        if (L.totalPages === null) return { found: found, complete: false, pages: pages, why: "danh sách phiên NW không cho biết tổng số trang (totalPages): chưa chắc đã tìm hết" };
        if (page >= L.totalPages) return { found: found, complete: true, pages: pages };
      }
      return { found: found, complete: false, pages: pages, more: true };
    }

    async function nwPhase(rec) {
      rec = await save(rec, "linking", "dang-chay", "Đang tạo / tìm phiên NW…");
      function fail(r, where) {
        var k = errKind(r), t = where + ": " + errText(r);
        if (k === "no-token") return save(rec, "pending", "nw-tab", "Chưa có tab NW đăng nhập (" + t + "). Mở circa.nextwaves.app và đăng nhập; extension sẽ tự tạo bù.");
        if (k === "401") return save(rec, "pending", "nw-tab", "Token NW hết hạn hoặc sai (" + t + "). Mở lại / tải lại tab circa.nextwaves.app; extension sẽ tự tạo bù.");
        if (k === "403") return save(rec, "no-permission", "nw-403", "Tài khoản NW không có quyền (" + t + "). Cần quyền stock.reconcile.");
        if (k === "loi-mang") return save(rec, "pending", "loi-mang", "Lỗi mạng / máy chủ NW (" + t + "). Bấm “Thử lại”.");
        if (k === "blocked") return save(rec, "error", "blocked", "Lệnh bị chặn (" + t + ").");
        return save(rec, "error", "nw-4xx", "NW từ chối (" + t + "). Bấm “Thử lại” sau khi xử lý.");
      }
      var me = await api.call("nw.me");
      if (me.status !== 200) return fail(me, "kiểm tài khoản NW");
      var perms = nwPermissions(me.j);
      if (perms && perms.indexOf("stock.reconcile") < 0) return save(rec, "no-permission", "nw-perm", "Tài khoản NW thiếu quyền stock.reconcile: không tạo phiên NW.");
      var permNote = perms ? "" : "Không đọc được danh sách quyền NW (không chặn). ";
      var wr = await api.call("nw.warehouses");
      if (wr.status !== 200) return fail(wr, "đọc danh sách kho NW");
      var wl = warehousesOf(wr.j);
      if (!wl.list) return save(rec, "error", "nw-warehouses", "Không đọc được danh sách kho NW: " + wl.why + ".");
      var m = matchWarehouse(rec.storeName, wl.list);
      if (!m.ok) {
        return save(rec, "no-warehouse", m.why, m.why === "many"
          ? "Có " + m.count + " kho NW (tính cả kho con) cùng tên “" + rec.storeName + "”: không biết chọn kho nào, không tạo phiên NW. Đổi tên cho còn đúng 1 kho rồi bấm “Thử lại”."
          : "Không có kho NW (loại warehouse, đang mở, mọi cấp) trùng tên cửa hàng “" + rec.storeName + "”: không tạo phiên NW. Đặt tên kho NW đúng tên cửa hàng rồi bấm “Thử lại”.",
          { candidates: m.candidates });
      }
      rec.warehouseId = m.wh.id; rec.warehouseName = m.wh.name;
      var sr = await searchNotes(rec.sessionId);
      if (sr.err) return fail(sr.err, "tìm phiên NW trang " + (sr.pages + 1));
      if (sr.found.length > 1) return save(rec, "conflict", "nw-many", "Có " + sr.found.length + " phiên NW ghi phiên Circa này trong ghi chú: " + sr.found.map(function (x) { return x.id; }).join(", ") + ". Không tự chọn; báo PM.", { nwCandidates: sr.found.map(function (x) { return String(x.id); }) });
      if (sr.found.length === 1) {
        var j = judgeFound(sr.found[0], m.wh.id);
        if (j.state === "linked") return save(rec, "linked", "tim-thay", permNote + "Đã có phiên NW ghi phiên Circa này: liên kết, không tạo mới.", { nwId: j.nwId, nwStatus: j.nwStatus, linkedAt: new Date(now()).toISOString(), created: false });
        return save(rec, j.state, j.state === "nw-closed" ? "nw-" + j.nwStatus : "nw-found", j.msg, { nwId: j.nwId || null, nwStatus: j.nwStatus || null });
      }
      if (sr.why) return save(rec, "error", "nw-list", "Chưa tìm hết phiên NW theo ghi chú: " + sr.why + ". Không tạo phiên NW (tránh tạo trùng); báo PM.");
      // không thấy → tạo
      var body = { warehouseId: m.wh.id, notes: notesFor(rec.code, rec.sessionId), clientOperationId: clientOpId(rec.sessionId) };
      rec = await save(rec, "linking", "dang-tao", "Đang tạo phiên NW…", { postAt: new Date(now()).toISOString(), searchedPages: sr.pages, searchMore: !!sr.more });
      var cr = await api.call("nw.recCreate", { body: body });
      if (cr.status !== 200 && cr.status !== 201) return fail(cr, "tạo phiên NW");
      var nr = recOf(cr);
      if (!nr) return save(rec, "pending", "loi-mang", "NW trả " + cr.status + " nhưng không đọc được id phiên. Bấm “Thử lại” (tìm theo ghi chú trước).");
      var bad = [];
      if (!notesHas(nr.notes, rec.sessionId)) bad.push("ghi chú khác (" + short(nr.notes, 80) + ")");
      if (nr.scopeType !== "warehouse") bad.push("phạm vi “" + short(nr.scopeType, 30) + "” không phải warehouse");
      if (recWarehouseId(nr) !== m.wh.id) bad.push("kho " + (recWarehouseId(nr) || "(không có)") + " khác kho đã ghép");
      if (bad.length) return save(rec, "conflict", "nw-post", "NW trả phiên " + nr.id + " nhưng " + bad.join("; ") + ". Không liên kết; báo PM.", { nwId: cleanId(String(nr.id)) });
      return save(rec, "linked", "da-tao", permNote + "Đã tạo phiên NW liên kết" + (sr.more ? " (đã tìm " + sr.pages + " trang phiên NW, còn trang sau chưa tìm; NW chống trùng theo clientOperationId)" : "") + ".",
        { nwId: cleanId(String(nr.id)), nwStatus: String(nr.status || ""), linkedAt: new Date(now()).toISOString(), created: true });
    }

    async function circaPhase(id, posHint, mode, seenAt, rec) {
      var pos = (rec && rec.posId) || posHint;
      if (!pos) return { transient: { sessionId: id, state: "unknown-store", msg: "Không xác định được cửa hàng của phiên này. Tải lại trang admin rồi thử lại." } };
      var r = await api.call("circa.session", { id: id, posId: pos });
      if (r.status !== 200) {
        var k = errKind(r), t = "đọc phiên Circa: " + errText(r);
        if (rec || mode === "auto") {
          var base = rec || { v: 1, sessionId: id, posId: pos, mode: mode, approved: false, seenAt: new Date(seenAt).toISOString() };
          if (k === "no-token" || k === "401") return { rec: await save(base, "pending", "circa-tab", "Chưa đọc được phiên Circa (" + t + "). Mở / tải lại trang admin Circa đã đăng nhập.") };
          if (k === "loi-mang") return { rec: await save(base, "pending", "loi-mang", "Lỗi mạng / máy chủ Circa (" + t + "). Bấm “Thử lại”.") };
          if (rec) return { rec: await save(base, "error", "circa", "Không dùng được phiên Circa (" + t + ").") };
        }
        return { transient: { sessionId: id, state: "error", msg: "Không đọc được phiên Circa (" + t + ")." } };
      }
      var v = verifySession(sessOf(r), id, pos);
      if (!v.ok) return { transient: { sessionId: id, state: "error", msg: v.why } };
      var s = v.s;
      var approved = !!(rec && rec.approved) || mode === "ask";
      if (!approved) {
        var seen = rec && rec.seenAt ? Date.parse(rec.seenAt) : seenAt;
        if (!inWindow(s.createdMs, seen, cfg)) return { transient: { sessionId: id, state: "ignored", reason: "too-old", msg: "Phiên tạo ngoài " + Math.round(cfg.AUTO_WINDOW_MS / 60000) + " phút trước lúc extension thấy: không tự tạo." } };
      }
      if (s.mode !== cfg.AUTO_COUNTING_MODE) {
        var sk = Object.assign({}, rec || { v: 1, sessionId: id, mode: mode }, { code: s.code, posId: s.posId, countingMode: s.mode, createdAtCirca: s.createdAt });
        return { rec: await save(sk, "skipped", "not-" + cfg.AUTO_COUNTING_MODE.toLowerCase(), "Phiên phương thức " + (s.mode || "(trống)") + ", không phải phiên " + cfg.AUTO_COUNTING_MODE + ": bỏ qua, không tạo phiên NW.") };
      }
      if (!OPEN_STATES[s.status]) {
        if (rec) return { rec: await save(Object.assign({}, rec, { code: s.code, posId: s.posId }), "error", "circa-status", "Phiên Circa đang " + s.status + " (không mở): không tạo phiên NW.") };
        return { transient: { sessionId: id, state: "closed", code: s.code, msg: "Phiên Circa đang " + s.status + ": không tạo phiên NW." } };
      }
      var nrec = Object.assign({ v: 1, history: [] }, rec || {}, {
        sessionId: id, code: s.code, posId: s.posId, countingMode: s.mode, createdAtCirca: s.createdAt, circaStatus: s.status,
        mode: rec && rec.mode ? rec.mode : mode, approved: true, seenAt: rec && rec.seenAt ? rec.seenAt : new Date(seenAt).toISOString()
      });
      nrec = await save(nrec, "pending", "dang-chay", "Đã kiểm phiên Circa; đang đọc tên cửa hàng…");
      var st = await storeName(s.posId);
      if (st.name) { nrec.storeName = st.name; nrec.storeCode = st.code; return { rec: nrec }; }
      var k2 = errKind(st.r);
      if (st.r && st.r.status === 200) return { rec: await save(nrec, "error", "circa-store", "Không đọc được tên cửa hàng " + s.posId + " (thiếu pos_name / pos_id khác).") };
      if (k2 === "no-token" || k2 === "401") return { rec: await save(nrec, "pending", "circa-tab", "Chưa đọc được tên cửa hàng (" + errText(st.r) + "). Mở / tải lại trang admin Circa.") };
      if (k2 === "loi-mang") return { rec: await save(nrec, "pending", "loi-mang", "Lỗi mạng khi đọc cửa hàng (" + errText(st.r) + "). Bấm “Thử lại”.") };
      return { rec: await save(nrec, "error", "circa-store", "Không đọc được cửa hàng (" + errText(st.r) + ").") };
    }
    async function storeName(posId) {
      var sr = await api.call("circa.store", { id: posId, posId: posId });
      var sd = sr.status === 200 ? dataOf(sr) : null;
      var name = sd && typeof sd.pos_name === "string" ? sd.pos_name : "";
      if (!name || (sd.pos_id != null && cleanId(String(sd.pos_id)) !== posId)) return { name: "", r: sr };
      return { name: name, code: sd.pos_code == null ? "" : String(sd.pos_code), r: sr };
    }

    async function run(id, posHint, mode, seenAt) {
      var rec = await get(id);
      if (rec && (rec.state === "linked" || rec.state === "nw-closed")) return rec;
      if (rec && rec.state === "skipped" && mode !== "ask" && mode !== "retry") return rec;
      if (!rec || !rec.storeName || !rec.approved) {
        var ph = await circaPhase(id, posHint, mode, seenAt, rec);
        if (ph.transient) return ph.transient;
        rec = ph.rec;
        if (!rec.storeName || rec.state !== "pending" || rec.reason !== "dang-chay") return rec;
      }
      var out = await nwPhase(rec);
      prune().catch(function () {});
      return out;
    }

    function onCreated(idRaw, posRaw, seenAt) {
      var id = cleanId(idRaw), pos = cleanId(posRaw || "");
      if (!id) return Promise.resolve({ state: "rejected", msg: "id phiên không hợp lệ" });
      seenAt = typeof seenAt === "number" ? seenAt : now();
      return lock(id, function () { return run(id, pos, "auto", seenAt); });
    }
    function ask(idRaw, posRaw) {
      var id = cleanId(idRaw), pos = cleanId(posRaw || "");
      if (!id) return Promise.resolve({ state: "rejected", msg: "id phiên không hợp lệ" });
      return lock(id, async function () {
        var rec = await get(id);
        if (rec && (rec.state === "linked" || rec.state === "nw-closed")) return rec;
        return run(id, pos || (rec && rec.posId) || "", "ask", now());
      });
    }
    function retry(idRaw) {
      var id = cleanId(idRaw);
      if (!id) return Promise.resolve({ state: "rejected", msg: "id phiên không hợp lệ" });
      return lock(id, async function () {
        var rec = await get(id);
        if (!rec) return { sessionId: id, state: "none", msg: "Chưa có bản ghi liên kết cho phiên này." };
        if (rec.state === "linked" || rec.state === "skipped" || rec.state === "nw-closed") return rec;
        return run(id, rec.posId || "", "retry", now());
      });
    }
    // probe: trạng thái cho thanh trên trang. Chỉ ĐỌC; chỉ ghi storage khi tìm thấy phiên NW theo notes (liên kết / nw-closed,
    // không tạo) hoặc khi tiếp tục bản ghi đã duyệt đang chờ tab. opts.rateKey: khoá giới hạn tần suất cho lần tra mới.
    function probe(idRaw, posRaw, opts) {
      var id = cleanId(idRaw), pos = cleanId(posRaw || "");
      if (!id) return Promise.resolve({ state: "rejected", msg: "id phiên không hợp lệ" });
      if (busy[id]) return get(id).then(function (r) { return r || { sessionId: id, state: "linking", msg: "Đang kiểm / tạo phiên NW…" }; });
      return lock(id, async function () {
        var rec = await get(id);
        if (rec) {
          if (rec.state === "linking" && now() - Date.parse(rec.updatedAt) > cfg.LINKING_STALE_MS) rec = await save(rec, "pending", "gian-doan", "Lần tạo trước bị gián đoạn (không rõ đã tạo chưa). Bấm “Thử lại” (tìm theo ghi chú trước, không tạo trùng).");
          if (rec.state === "pending" && (rec.reason === "nw-tab" || rec.reason === "circa-tab") && !(now() - (lastAuto[id] || 0) < cfg.AUTO_RETRY_MS)) {
            lastAuto[id] = now();
            if (rec.approved || rec.reason === "circa-tab") return run(id, rec.posId || pos, "retry", now());
          }
          return rec;
        }
        var pc = probeCache[id];
        if (pc && now() - pc.at < 60000 && pc.pos === pos) return pc.v;
        if (deps.rate && opts && opts.rateKey != null && !deps.rate.hit(opts.rateKey)) return { sessionId: id, state: "rate-limited", msg: "Quá nhiều yêu cầu kiểm phiên từ tab này; thử lại sau 1 phút." };
        var v = await probeFresh(id, pos);
        probeCache[id] = { at: now(), pos: pos, v: v };
        return v;
      });
    }
    async function probeFresh(id, pos) {
      if (!pos) return { sessionId: id, state: "unknown-store", msg: "Không xác định được cửa hàng của phiên này. Tải lại trang admin rồi thử lại." };
      var r = await api.call("circa.session", { id: id, posId: pos });
      if (r.status !== 200) return { sessionId: id, state: "error", msg: "Không đọc được phiên Circa (" + errText(r) + ")." };
      var v = verifySession(sessOf(r), id, pos);
      if (!v.ok) return { sessionId: id, state: "error", msg: v.why };
      var s = v.s, base = { sessionId: id, code: s.code, posId: s.posId, countingMode: s.mode, circaStatus: s.status };
      if (s.mode !== cfg.AUTO_COUNTING_MODE) return Object.assign(base, { state: "skipped", msg: "Phiên phương thức " + (s.mode || "(trống)") + ", không phải phiên " + cfg.AUTO_COUNTING_MODE + ": extension bỏ qua." });
      var sr = await searchNotes(id);
      if (sr.found.length > 1) return Object.assign(base, { state: "conflict", msg: "Có " + sr.found.length + " phiên NW ghi phiên Circa này. Không tự chọn; báo PM." });
      if (sr.found.length === 1) {
        // cùng điều kiện như khi tạo: kho NW trùng tên cửa hàng (đúng 1 kho) và phiên tìm thấy thuộc đúng kho đó
        var st = await storeName(s.posId);
        if (!st.name) return Object.assign(base, { state: "error", msg: "Thấy phiên NW ghi phiên này nhưng không đọc được tên cửa hàng Circa (" + errText(st.r) + ")." });
        var wr = await api.call("nw.warehouses"), wl = wr.status === 200 ? warehousesOf(wr.j) : { list: null, why: errText(wr) };
        if (!wl.list) return Object.assign(base, { state: "error", storeName: st.name, msg: "Thấy phiên NW ghi phiên này nhưng không đọc được danh sách kho NW (" + wl.why + ")." });
        var m = matchWarehouse(st.name, wl.list);
        if (!m.ok) return Object.assign(base, { state: "conflict", storeName: st.name, msg: "Thấy phiên NW ghi phiên này nhưng " + (m.why === "many" ? "có " + m.count + " kho NW" : "không có kho NW") + " trùng tên cửa hàng “" + st.name + "”: không liên kết; báo PM." });
        var j = judgeFound(sr.found[0], m.wh.id);
        if (j.state === "conflict") return Object.assign(base, { state: "conflict", storeName: st.name, msg: j.msg });
        var rec = Object.assign({ v: 1, history: [] }, base, { storeName: st.name, storeCode: st.code, mode: "found", approved: false, warehouseId: m.wh.id, warehouseName: m.wh.name, createdAtCirca: s.createdAt });
        if (j.state === "nw-closed") return save(rec, "nw-closed", "nw-" + j.nwStatus, j.msg, { nwId: j.nwId, nwStatus: j.nwStatus });
        return save(rec, "linked", "tim-thay", "Đã có phiên NW ghi phiên Circa này: liên kết, không tạo mới.", { nwId: j.nwId, nwStatus: j.nwStatus, linkedAt: new Date(now()).toISOString(), created: false });
      }
      if (!OPEN_STATES[s.status]) return Object.assign(base, { state: "closed", msg: "Phiên Circa đang " + s.status + " và chưa có phiên NW liên kết." });
      var checked = !sr.err && !sr.why;
      return Object.assign(base, { state: "unlinked", nwChecked: checked, msg: checked ? "Phiên này chưa có phiên NW liên kết." : "Phiên này chưa có phiên NW liên kết trong extension; chưa tra hết được NW (" + (sr.err ? errText(sr.err) : sr.why || "") + ")." });
    }
    async function onTab(side) {
      if (!store.all) return [];
      var all = await store.all(), ids = Object.keys(all).filter(function (k) {
        var r = all[k];
        return k.indexOf(KEY) === 0 && r && r.state === "pending" && (side === "nw" ? r.reason === "nw-tab" && r.approved : r.reason === "circa-tab");
      }).map(function (k) { return all[k].sessionId; });
      var out = [];
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        lastAuto[id] = now();
        out.push(await lock(id, (function (x) { return function () { return run(x, "", "retry", now()); }; })(id)));
      }
      return out;
    }

    return { onCreated: onCreated, ask: ask, retry: retry, probe: probe, onNwTab: function () { return onTab("nw"); }, onAdminTab: function () { return onTab("circa"); }, get: function (id) { id = cleanId(id); return id ? get(id) : Promise.resolve(null); } };
  }

  function view(rec) {
    if (!rec || typeof rec !== "object") return null;
    var o = {};
    ["sessionId", "code", "posId", "storeName", "storeCode", "state", "reason", "msg", "nwId", "nwStatus", "warehouseId", "warehouseName", "countingMode", "circaStatus",
      "createdAtCirca", "mode", "created", "linkedAt", "updatedAt", "candidates", "nwCandidates", "nwChecked"].forEach(function (k) { if (rec[k] !== undefined) o[k] = rec[k]; });
    if (o.code && o.sessionId) o.notes = notesFor(o.code, o.sessionId);
    return o;
  }

  return {
    createLinker: createLinker, createGate: createGate, createRateLimiter: createRateLimiter, matchWarehouse: matchWarehouse, flattenWarehouses: flattenWarehouses,
    normName: normName, notesFor: notesFor, clientOpId: clientOpId, notesHas: notesHas, hasCapability: hasCapability, nwPermissions: nwPermissions,
    verifySession: verifySession, inWindow: inWindow, sessOf: sessOf, warehousesOf: warehousesOf, recOf: recOf, recListOf: recListOf, recWarehouseId: recWarehouseId,
    judgeFound: judgeFound, cleanId: cleanId, view: view, errText: errText, KEY: KEY
  };
});
