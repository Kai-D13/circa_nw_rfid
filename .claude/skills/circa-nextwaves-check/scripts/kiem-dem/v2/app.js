(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var fmt = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 3 });
  var STORES = {
    lumina: { name: 'Lumina', pos: '31493e74-3404-4c0e-a906-93691a6ee319', wh: '3f7bd541-7370-4ce0-9048-231cf061e91a' },
    florita: { name: 'Florita', pos: 'c476efb2-415c-429a-978e-d389b4b06607', wh: 'eb5e2b4f-6f92-413b-90ef-6be1730b94c0' },
  };
  var POS_API = 'https://api.v2.circa.vn', NW_API = 'https://api-circa.nextwaves.app/api/v1/public';
  var DEFAULT_SHEET = 'https://docs.google.com/spreadsheets/d/18nLllIlORaki3por1diKzNo2tWvdVyUnB1xbZXDv8Xc/edit';

  // ---------- worker (SheetJS + logic) ----------
  var src = $('worker-src').textContent, worker = null, seq = 0, pending = {}, inline = null;
  // a crashed or unloadable worker must not leave calls hanging: fail them all, drop the worker (next run goes inline)
  function failWorker(msg) {
    var p = pending; pending = {};
    try { worker.terminate(); } catch (e) { /* already gone */ }
    worker = null; masterKey = null;
    Object.keys(p).forEach(function (k) { p[k]({ error: msg }); });
  }
  try {
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = function (ev) { var p = pending[ev.data.id]; delete pending[ev.data.id]; if (p) p(ev.data); };
    worker.onerror = function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); failWorker('Bộ xử lý (worker) bị lỗi' + (ev && ev.message ? ': ' + ev.message : '') + '. Bấm “Kéo dữ liệu” lại để chạy ở chế độ dự phòng.'); };
    worker.onmessageerror = function () { failWorker('Bộ xử lý (worker) không đọc được dữ liệu. Bấm “Kéo dữ liệu” lại.'); };
  } catch (e) { worker = null; }
  // While a run is failing, the other loaders stop at their next request and must not overwrite worker state.
  var STOP = '__stop__', stopRun = false;
  var RUN_STATE = { masterCsv: 1, masterXlsx: 1, posApi: 1, posXlsx: 1, tags: 1, noTags: 1, pend: 1, orders: 1 };
  function call(msg, transfer) {
    if (stopRun && RUN_STATE[msg.type]) return Promise.reject(new Error(STOP));
    msg.id = ++seq;
    return new Promise(function (resolve, reject) {
      var done = function (r) { if (r && r.error) reject(new Error(r.error)); else resolve(r); };
      if (worker) { pending[msg.id] = done; worker.postMessage(msg, transfer || []); return; }
      if (!inline) { inline = { postMessage: function (m) { inline.last = m; } }; new Function('self', src)(inline); }
      setTimeout(function () { inline.onmessage({ data: msg }); done(inline.last); }, 20);
    });
  }

  // ---------- small helpers ----------
  var store = function () {
    var k = $('store').value;
    if (k === 'custom') return { name: 'kho', pos: $('pos-id').value.trim().toLowerCase(), wh: $('wh-id').value.trim().toLowerCase() };
    return STORES[k];
  };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function showError(msg) { $('error').hidden = !msg; $('error').textContent = msg || ''; }
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function pref(k, v) { try { if (v === undefined) return localStorage.getItem('kd2.' + k); localStorage.setItem('kd2.' + k, v); } catch (e) { return null; } }

  var stepsEl = $('steps');
  function step(key, state, text) {
    var li = document.getElementById('st-' + key);
    if (!li) { li = document.createElement('li'); li.id = 'st-' + key; stepsEl.appendChild(li); }
    var ico = state === 'run' ? '<span class="spin"></span>' : state === 'ok' ? '<span class="ok">✓</span>' : state === 'bad' ? '<span class="bad">✗</span>' : '<span class="wait">–</span>';
    li.innerHTML = '<span class="ico">' + ico + '</span><span class="' + (state === 'bad' ? 'bad' : '') + '">' + text + '</span>';
  }

  function httpErr(msg, status) { var e = new Error(msg); e.status = status; return e; }
  // A 200 whose body is cut off or not JSON is retried like a 5xx, never returned as null (callers would read it as "last page").
  async function getJson(url, headers, who) {
    var last = '', name = who === 'pos' ? 'POS' : 'Nextwaves';
    for (var t = 0; t < 6; t++) {
      if (stopRun) throw new Error(STOP);
      var r;
      try { r = await fetch(url, { headers: headers, cache: 'no-store' }); } catch (e) { last = 'mạng lỗi'; await sleep(1500 * (t + 1)); continue; }
      if (r.status === 429 || r.status >= 500) { last = 'HTTP ' + r.status; await sleep(1500 * (t + 1)); continue; }
      if (r.status === 401 || r.status === 403) throw httpErr(who === 'pos' ? 'Token POS sai hoặc hết hạn (HTTP ' + r.status + ').' : 'Key Nextwaves sai hoặc không có quyền với kho này (HTTP ' + r.status + ').', r.status);
      if (!r.ok) throw httpErr(name + ' trả HTTP ' + r.status + ' cho ' + url.replace(/\?.*/, ''), r.status);
      try { return JSON.parse(await r.text()); } catch (e) { last = 'dữ liệu trả về bị cắt/hỏng'; await sleep(1500 * (t + 1)); }
    }
    throw new Error(name + ' không phản hồi (' + last + ').');
  }
  var posGet = function (path, s) { return getJson(POS_API + path, { authorization: 'Bearer ' + $('pos-token').value.trim().replace(/^bearer\s+/i, ''), 'x-store-id': s.pos }, 'pos'); };
  var nwGet = function (path) { return getJson(NW_API + path, { authorization: 'Bearer ' + $('nw-key').value.trim().replace(/^bearer\s+/i, '') }, 'nw'); };
  // n workers over arr; after the first error no worker takes a new item, then the error is rethrown
  async function pmap(arr, n, fn) {
    var i = 0, err = null, out = new Array(arr.length);
    await Promise.all(Array.from({ length: n }, async function () { while (i < arr.length && !err) { var k = i++; try { out[k] = await fn(arr[k], k); } catch (e) { if (!err) err = e; } } }));
    if (err) throw err;
    return out;
  }

  // ---------- loaders ----------
  var masterKey = null;
  async function loadMaster() {
    var f = $('file-master').files[0];
    if (f) {
      if (masterKey === 'file:' + f.name + f.size) return;
      step('master', 'run', 'Đọc master từ file ' + esc(f.name) + '…');
      var buf = await f.arrayBuffer();
      var r = await call({ type: 'masterXlsx', buf: buf }, [buf]);
      masterKey = 'file:' + f.name + f.size;
      step('master', 'ok', 'Master (file): ' + fmt.format(r.size) + ' mã, ' + fmt.format(r.adhoc) + ' từ Adhoc');
      return;
    }
    var url = $('sheet-url').value.trim(), m = url.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
    if (!m) throw new Error('Link Google Sheet master không hợp lệ.');
    var v4 = $('tab-v4').value.trim() || 'final data v4', ad = $('tab-adhoc').value.trim();
    var key = m[1] + '|' + v4 + '|' + ad;
    if (masterKey === key) { step('master', 'ok', 'Master Google Sheet: dùng lại bản đã tải'); return; }
    var base = 'https://docs.google.com/spreadsheets/d/' + m[1] + '/gviz/tq?tqx=out:csv&headers=1&sheet=';
    var head = function (t) { return (t.slice(0, t.indexOf('\n') > 0 ? t.indexOf('\n') : 400)).toLowerCase(); };
    step('master', 'run', 'Tải tab “' + esc(v4) + '” từ Google Sheet (~10 MB)…');
    // Google sometimes refuses or drops a request for a while (the browser only says "Failed to fetch": an error page has
    // no CORS header). Retry with backoff like the POS/NW calls, then fail with a message that says what to do.
    var getText = async function (u, label) {
      var last = '';
      for (var t = 0; t < 4; t++) {
        if (stopRun) throw new Error(STOP);
        if (t) { step('master', 'run', 'Google Sheet lỗi tạm thời (' + esc(last) + '), thử lại lần ' + (t + 1) + '/4: ' + esc(label) + '…'); await sleep(3000 * Math.pow(2, t - 1)); }
        var r;
        try { r = await fetch(u, { cache: 'no-store' }); } catch (e) { last = 'mạng lỗi hoặc Google từ chối tạm thời'; continue; }
        if (r.status === 429 || r.status >= 500) { last = 'HTTP ' + r.status; continue; }
        if (!r.ok) throw new Error('Google Sheet trả HTTP ' + r.status + ' (sheet đã bật “Bất kỳ ai có đường liên kết đều xem được” chưa?)');
        try { return await r.text(); } catch (e) { last = 'đang tải thì mất kết nối'; }
      }
      throw new Error('Không tải được master từ Google Sheet sau 4 lần thử (' + last + '). Bấm “Kéo dữ liệu” lại sau ít phút (đơn POS đã tải được lưu lại, lần sau không tải lại), hoặc dùng file Master (.xlsx) ở mục “Dùng file thay cho API”.');
    };
    var t4 = await getText(base + encodeURIComponent(v4) + '&tq=' + encodeURIComponent('select A,B,C,D,E'), 'tab ' + v4);
    var need = ['product_id', 'convert_unit', 'convert_rate', 'final_unit_print'];
    if (!need.every(function (c) { return head(t4).indexOf('"' + c + '"') >= 0; })) {
      t4 = await getText(base + encodeURIComponent(v4), 'tab ' + v4); // columns moved: take the whole tab
      if (!need.every(function (c) { return head(t4).indexOf('"' + c + '"') >= 0; })) throw new Error('Không thấy tab “' + v4 + '” (hoặc tab thiếu cột product_id / convert_unit / convert_rate / final_unit_print). Google trả tab đầu tiên khi sai tên.');
    }
    var tA = '';
    if (ad) {
      step('master', 'run', 'Tải tab “' + esc(ad) + '”…');
      tA = await getText(base + encodeURIComponent(ad), 'tab ' + ad);
      if (head(tA).indexOf('"combine_unit"') < 0) { tA = ''; step('adhoc', 'bad', 'Không thấy tab “' + esc(ad) + '” (cột combine_unit). Chỉ dùng ' + esc(v4) + '.'); }
    }
    step('master', 'run', 'Đọc master…');
    var r2 = await call({ type: 'masterCsv', v4: t4, adhoc: tA });
    masterKey = key;
    step('master', 'ok', 'Master Google Sheet: ' + fmt.format(r2.size) + ' mã, ' + fmt.format(r2.adhoc) + ' lấy từ Adhoc');
  }

  var posInfo = null, posAt = null;
  async function loadPos(s) {
    var f = $('file-stock').files[0];
    if (f) {
      step('pos', 'run', 'Đọc tồn POS từ file ' + esc(f.name) + '…');
      var buf = await f.arrayBuffer();
      posInfo = await call({ type: 'posXlsx', buf: buf }, [buf]);
      posAt = 'file ' + f.name;
      step('pos', 'ok', 'Tồn POS (file ' + esc(f.name) + '): ' + fmt.format(posInfo.products) + ' mã, ' + posInfo.locations.length + ' vị trí');
      return;
    }
    if (!$('pos-token').value.trim()) throw new Error('Thiếu token POS (hoặc chọn file tồn kho ở mục “Dùng file thay cho API”).');
    var rows = [], total = null;
    for (var page = 1; page < 200; page++) {
      step('pos', 'run', 'Kéo tồn POS ' + esc(s.name) + ': trang ' + page + (total ? '/' + Math.ceil(total / 500) : '') + '…');
      var j = await posGet('/v1/inventory/admin/stock/search?query=pos_id=' + s.pos + ',include_negative_qty=true,&limit=500&page=' + page + '&is_count_status=true', s);
      var d = j && j.data;
      if (!d || !Array.isArray(d.list)) throw new Error('POS trả dữ liệu tồn không đúng dạng ở trang ' + page + '.');
      var a = d.list;
      if (d.total != null) total = Number(d.total);
      a.forEach(function (x) {
        if (x.pos_id && x.pos_id !== s.pos) return;
        rows.push({ pid: String(x.product_id), name: x.product_name, base: x.base_unit, q: x.on_hand_qty, seller: x.seller_code || '', sku: x.sku || '', locs: (x.items || []).map(function (it) { return { loc: it.location_name, q: it.on_hand_qty }; }), units: (x.retail_units || []).map(function (u) { return { unit: u.unit, rate: u.convert_rate }; }) });
      });
      if (a.length < 500 || (total != null && page * 500 >= total)) break;
    }
    posInfo = await call({ type: 'posApi', rows: rows });
    posAt = new Date();
    step('pos', 'ok', 'Tồn POS ' + esc(s.name) + ' lúc ' + posAt.toLocaleTimeString('vi-VN') + ': ' + fmt.format(rows.length) + ' dòng → ' + fmt.format(posInfo.products) + ' mã, ' + posInfo.locations.length + ' vị trí');
  }

  async function loadPending(s) {
    if (!$('add-pend').checked || $('file-stock').files[0] || !$('pos-token').value.trim()) { await call({ type: 'pend', items: [] }); step('pend', 'wait', 'Không cộng đơn ONLINE chờ giao'); return; }
    step('pend', 'run', 'Đọc đơn ONLINE chờ giao…');
    var ids = new Set(); // an order can change status between the two queries, or repeat across pages
    for (var st of ['AWAITING_SHIPMENT', 'READY_TO_PICK']) {
      for (var page = 1; page < 20; page++) {
        var j = await posGet('/v1/pos/' + s.pos + '/order?page=' + page + '&limit=100&query=status=' + st, s);
        if (!j || !j.data) throw new Error('POS trả danh sách đơn chờ giao không đúng dạng.');
        var a = j.data.orders || j.data.list || [];
        a.forEach(function (o) { ids.add(o.id); });
        if (a.length < 100) break;
      }
    }
    // [product, base qty, order code]: the worker skips orders NW already deducted for that product
    var items = [], codes = [], prods = new Set();
    await pmap(Array.from(ids), 4, async function (id) {
      var j = await posGet('/v1/order/' + id + '?get_rating=true', s);
      var o = j && j.data && j.data.order;
      if (!o || o.type !== 'ONLINE') return;
      codes.push(o.code);
      (o.items || []).forEach(function (it) { var c = String(it.product_id); prods.add(c); items.push([c, Number(it.base_quantity) || 0, o.code]); });
    });
    await call({ type: 'pend', items: items });
    step('pend', 'ok', 'Đơn ONLINE chờ giao: ' + codes.length + ' đơn, ' + prods.size + ' mã' + (codes.length ? ' (' + esc(codes.slice(0, 6).join(', ')) + (codes.length > 6 ? '…' : '') + ')' : ''));
  }

  // ---------- POS orders (loose sales → opened boxes) ----------
  // The order list has no stable sort: split [A,B) into windows that fit one page (≤100 by `total`), never page (port of
  // scripts/pos-orders.js listCompleted). Details are cached per store in localStorage (only order code, time, product id,
  // base quantity — no customer data), so later runs fetch new orders only.
  var ORD_CACHE = function (s) { return 'kd2.ord.' + s.pos; };
  function readCache(s) { try { return JSON.parse(localStorage.getItem(ORD_CACHE(s)) || '{}') || {}; } catch (e) { return {}; } }
  function writeCache(s, c) { try { localStorage.setItem(ORD_CACHE(s), JSON.stringify(c)); } catch (e) { /* quota or blocked: run without cache */ } }
  async function listCompleted(s, A, B, onProgress) {
    var seen = new Map();
    async function win(a, b) {
      var j = await posGet('/v1/pos/' + s.pos + '/order?page=1&limit=100&query=status=COMPLETED,completed_time_from=' + new Date(a).toISOString() + ',completed_time_to=' + new Date(b).toISOString(), s);
      var d = j && j.data;
      if (!d) throw new Error('POS không trả danh sách đơn.');
      var rows = d.orders || d.list || [];
      if (Number(d.total) > rows.length) {
        if (b - a <= 60e3) throw new Error('Khung ' + new Date(a).toLocaleString('vi-VN') + ' có hơn 100 đơn, không chia nhỏ được.');
        var mid = a + Math.floor((b - a) / 2);
        await win(a, mid); await win(mid, b);
        return;
      }
      rows.forEach(function (o) { if (!seen.has(o.id)) seen.set(o.id, o.code); });
    }
    for (var a = A; a < B; a += 6 * 3600e3) { await win(a, Math.min(B, a + 6 * 3600e3)); onProgress((Math.min(B, a + 6 * 3600e3) - A) / (B - A), seen.size); }
    return seen;
  }
  var tagsFirst = null;
  async function loadOrders(s) {
    if (!$('loose').checked || !$('pos-token').value.trim()) { await call({ type: 'orders', rows: null }); step('ord', 'wait', 'Không xét hộp bán lẻ' + ($('loose').checked ? ' (cần token POS)' : '')); return; }
    var fromIn = $('ord-from').value, A = fromIn ? Date.parse(fromIn + 'T00:00:00+07:00') : tagsFirst;
    if (!A) { await call({ type: 'orders', rows: null }); step('ord', 'wait', 'Không xét hộp bán lẻ (chưa có ngày gắn thẻ, hãy nhập "Đọc đơn từ ngày")'); return; }
    var B = Date.now(), from = new Date(A).toLocaleDateString('vi-VN');
    var ids = await listCompleted(s, A, B, function (p, n) { step('ord', 'run', 'Đọc danh sách đơn POS từ ' + from + ': ' + Math.round(p * 100) + '%, ' + fmt.format(n) + ' đơn…'); });
    var cache = readCache(s), need = [];
    ids.forEach(function (code, id) { if (!cache[id]) need.push(id); });
    var done = 0, bad = 0;
    // save what was fetched even if the run fails half-way (and every 100 orders), so the next run resumes
    try {
      await pmap(need, 5, async function (id) {
        var j;
        try { j = await posGet('/v1/order/' + id + '?get_rating=true', s); } catch (e) { if (e.status === 404) { bad++; return; } throw e; }
        var o = j && j.data && j.data.order;
        if (!o) { bad++; return; }
        cache[id] = [o.code, Date.parse(o.completed_date), (o.items || []).map(function (it) { return [String(it.product_id), Number(it.base_quantity) || 0]; })];
        if (++done % 100 === 0) writeCache(s, cache);
        if (done % 20 === 0) step('ord', 'run', 'Đọc chi tiết đơn: ' + fmt.format(done) + '/' + fmt.format(need.length) + ' đơn mới (' + fmt.format(ids.size - need.length) + ' đơn lấy từ bộ nhớ đệm)…');
      });
    } finally { writeCache(s, cache); }
    var rows = [];
    ids.forEach(function (code, id) { var c = cache[id]; if (c) c[2].forEach(function (it) { rows.push({ c: it[0], base: it[1], t: c[1], code: c[0] }); }); });
    await call({ type: 'orders', rows: rows });
    step('ord', 'ok', 'Đơn POS từ ' + from + ': ' + fmt.format(ids.size) + ' đơn, ' + fmt.format(rows.length) + ' dòng (' + fmt.format(need.length - bad) + ' đơn tải mới' + (bad ? ', ' + bad + ' đơn không đọc được, bỏ qua' : '') + ')');
  }

  async function loadTags(s) {
    tagsFirst = null;
    if (!$('nw-key').value.trim()) { await call({ type: 'noTags' }); step('tags', 'bad', 'Không có key Nextwaves: mọi SP coi như chưa gắn thẻ (chỉ ra danh sách chưa gắn tem).'); return; }
    var rows = [], after = 0, n = 0;
    for (;;) {
      step('tags', 'run', 'Đọc sổ kho Nextwaves ' + esc(s.name) + ': ' + fmt.format(rows.length) + ' dòng…');
      var j = await nwGet('/stock/ledger?warehouseId=' + s.wh + '&limit=1000&afterLedgerNumber=' + after);
      if (!j || !Array.isArray(j.data)) throw new Error('Nextwaves trả sổ kho không đúng dạng (sau dòng ' + after + ').');
      var a = j.data;
      if (!a.length) break;
      a.forEach(function (x) {
        if (String(x.warehouseId).toLowerCase() !== s.wh) return;
        var p = x.product || {};
        var at = x.occurredAt || x.createdAt;
        rows.push({ c: String(p.externalProductId || x.productId), q: Number(x.quantity), t: x.actionType, at: at, ref: x.actionReference, epcs: x.epcs || [], fup: p.customAttributes && p.customAttributes['final-unit-print'], base: p.baseUnitOfMeasure, title: p.title });
        if (Number(x.quantity) > 0 && /stock_in|pack_in|transfer/i.test(x.actionType || '')) { var ts = Date.parse(at); if (isFinite(ts) && (!tagsFirst || ts < tagsFirst)) tagsFirst = ts; }
      });
      if (!(j.nextAfter > after) || ++n > 500) break;
      after = j.nextAfter;
    }
    var r = await call({ type: 'tags', rows: rows });
    step('tags', 'ok', 'Thẻ Nextwaves ' + esc(s.name) + ': ' + fmt.format(r.tags) + ' thẻ active / ' + fmt.format(r.products) + ' SP (từ ' + fmt.format(rows.length) + ' dòng sổ kho)');
  }

  // ---------- run ----------
  var state = { res: null, filter: 'all', keep: null, stamp: '', sess: null, sessFile: null };
  async function run() {
    showError('');
    var s = store();
    if (!s.pos || !s.wh) { showError('Thiếu POS store id / NW warehouseId.'); return; }
    stepsEl.innerHTML = '';
    $('run').disabled = true;
    // old results go away: nothing from a previous run (or another store) may mix into this one
    stopRun = false; state.res = null; state.sess = null;
    $('result').hidden = $('table-card').hidden = $('sess-card').hidden = $('loc-card').hidden = true;
    try {
      pref('store', $('store').value); pref('sheet', $('sheet-url').value.trim()); pref('tabv4', $('tab-v4').value); pref('tabad', $('tab-adhoc').value); pref('pend', $('add-pend').checked ? '1' : '0'); pref('loose', $('loose').checked ? '1' : '0');
      await call({ type: 'reset' });
      var tasks = [loadMaster(), (async function () { await loadPos(s); await loadPending(s); })(), (async function () { await loadTags(s); await loadOrders(s); })()];
      // first failure stops the other loaders; wait until they have all stopped before the button comes back
      try { await Promise.all(tasks); } catch (e) { stopRun = true; await Promise.allSettled(tasks); throw e; }
      var d = new Date();
      state.stamp = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '') + '-' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
      state.keep = new Set(posInfo.locations.map(function (l) { return l[0]; }).filter(function (n) { return fold(n) !== 'kho that lac'; }));
      renderLocations();
      await build();
    } catch (e) {
      stopRun = true;
      state.res = null;
      $('result').hidden = $('table-card').hidden = $('sess-card').hidden = $('loc-card').hidden = true;
      showError(e.message === STOP ? 'Đã dừng.' : e.message || String(e));
      Array.prototype.forEach.call(stepsEl.querySelectorAll('.spin'), function (x) { x.outerHTML = '<span class="bad">✗</span>'; });
    } finally { $('run').disabled = false; }
  }
  function openMax() { var n = Math.floor(Number($('open-max').value)); return n >= 1 ? Math.min(n, 50) : 2; }
  function fold(s) { return String(s || '').normalize('NFD').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/\p{Mn}/gu, '').toLowerCase().trim(); }

  function renderLocations() {
    var box = $('locs');
    box.innerHTML = '';
    $('loc-card').hidden = false;
    posInfo.locations.forEach(function (l) {
      var on = state.keep.has(l[0]);
      var lab = document.createElement('label');
      lab.className = 'chip' + (on ? ' on' : '');
      lab.innerHTML = '<input type="checkbox"' + (on ? ' checked' : '') + '> ' + esc(l[0] || '(trống)') + ' <small>' + fmt.format(l[1]) + ' mã</small>';
      lab.querySelector('input').addEventListener('change', function (ev) {
        if (ev.target.checked) state.keep.add(l[0]); else state.keep.delete(l[0]);
        lab.classList.toggle('on', ev.target.checked);
        build().catch(function (e) { showError(e.message); });
      });
      box.appendChild(lab);
    });
  }

  var building = 0;
  async function build() {
    var mine = ++building;
    var exclude = posInfo.locations.map(function (l) { return l[0]; }).filter(function (n) { return !state.keep.has(n); });
    var r = await call({ type: 'build', opts: { exclude: exclude, addPending: $('add-pend').checked, openMax: openMax() } });
    if (mine !== building) return;
    state.res = r;
    render();
    // the session reconciliation depends on the build: redo it for the file already loaded
    if (state.sessFile) await session(state.sessFile);
  }

  function render() {
    var r = state.res, s = r.sum;
    $('result').hidden = $('table-card').hidden = $('sess-card').hidden = false;
    $('m-rfid').textContent = fmt.format(s.imp);
    $('m-hold').textContent = s.hold ? fmt.format(s.hold) + ' SP quy đổi lệch để riêng (' + fmt.format(s.holdE) + ' thẻ theo master)' : 'không SP nào lệch quy đổi';
    $('m-T').textContent = fmt.format(s.T);
    $('m-E').textContent = fmt.format(s.E);
    $('m-Emax').textContent = '⌈tồn POS ÷ quy đổi⌉';
    $('m-over').textContent = fmt.format(s.over);
    $('m-over-sp').textContent = s.overSp ? 'ở ' + fmt.format(s.overSp) + ' SP: đã bán/chuyển mà NW chưa trừ?' : '';
    $('m-M').textContent = fmt.format(s.M);
    $('m-M-sp').textContent = fmt.format(s.Mrows) + ' SP (' + fmt.format(s.manual) + ' SP chưa có thẻ nào)';
    $('m-flag').textContent = fmt.format(s.flagged);
    $('m-non').textContent = s.nonmerch ? fmt.format(s.nonmerch) + ' mã không phải hàng bán đã bỏ' : '';
    $('dl-imp').disabled = !s.imp;
    $('dl-hold').disabled = !s.hold;
    $('dl-man').disabled = !s.Mrows;
    var cnt = { all: r.rows.length, rfid: 0, manual: 0, loose: 0, flag: 0 };
    r.rows.forEach(function (x) { if (x.cat === 'rfid') cnt.rfid++; if (x.M > 0 && x.cat !== 'nonmerch') cnt.manual++; if (x.Emax > x.E) cnt.loose++; if (x.flags.length) cnt.flag++; });
    Object.keys(cnt).forEach(function (k) { $('c-' + k).textContent = fmt.format(cnt[k]); });
    renderRows();
  }

  var LIMIT = 500;
  function renderRows() {
    var r = state.res, q = $('q').value.trim().toLowerCase();
    var list = r.rows.filter(function (x) {
      if (state.filter === 'rfid' && x.cat !== 'rfid') return false;
      if (state.filter === 'manual' && !(x.M > 0 && x.cat !== 'nonmerch')) return false;
      if (state.filter === 'loose' && !(x.Emax > x.E)) return false;
      if (state.filter === 'flag' && !x.flags.length) return false;
      return !q || x.code.toLowerCase().indexOf(q) >= 0 || String(x.name).toLowerCase().indexOf(q) >= 0;
    });
    if (state.filter === 'all' || state.filter === 'flag') list.sort(function (a, b) { return (b.T - b.E) - (a.T - a.E) || b.flags.length - a.flags.length; });
    $('rows').innerHTML = list.slice(0, LIMIT).map(function (x) {
      var conv = x.ratio == null ? '' : x.ratio === 1 && fold(x.unit) === fold(x.posBase) ? esc(x.unit) : '1 ' + esc(x.unit) + ' = ' + fmt.format(x.ratio) + ' ' + esc(x.posBase);
      var tag = x.cat === 'rfid' ? '<span class="tag rfid">có thẻ</span>' : x.cat === 'manual' ? '<span class="tag manual">chưa có thẻ</span>' : '<span class="tag">bỏ</span>';
      return '<tr' + (x.flags.length ? ' class="flag"' : '') + '><td class="code">' + esc(x.code) + '</td><td>' + esc(x.name) + tag +
        (x.flags.length ? '<div class="why">⚠ ' + x.flags.map(esc).join('<br>⚠ ') + '</div>' : '') + '</td><td class="num">' + fmt.format(x.S) + ' ' + esc(x.posBase) +
        '</td><td class="num">' + (x.T || '') + '</td><td class="num"><b>' + (x.cat === 'rfid' ? (x.Emax > x.E ? x.E + '–' + x.Emax : x.E) : '') + '</b></td><td class="num">' + (x.L ? x.L : '') + '</td><td class="conv">' + conv + '</td><td class="num">' + (x.M ? fmt.format(x.M) + ' ' + esc(x.mUnit) : '') + '</td></tr>';
    }).join('') || '<tr><td colspan="8" class="more">Không có dòng nào.</td></tr>';
    $('more').hidden = list.length <= LIMIT;
    $('more').textContent = 'Đang hiện ' + LIMIT + ' / ' + fmt.format(list.length) + ' dòng. Gõ để tìm; file tải về có đủ tất cả.';
  }

  function download(name, text) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  async function session(file) {
    if (!file) return;
    state.sessFile = file;
    var drop = $('drop-sess');
    drop.className = 'drop';
    $('status-sess').innerHTML = '<span class="spin"></span>Đang đọc ' + esc(file.name) + '…';
    try {
      var buf = await file.arrayBuffer();
      var r = await call({ type: 'session', buf: buf }, [buf]);
      state.sess = r; state.sessName = file.name.replace(/\.[^.]+$/, '');
      var A = r.sum, pct = function (a, b) { return b ? (Math.round(a / b * 1000) / 10).toString().replace('.', ',') + '%' : '–'; };
      drop.className = 'drop done';
      $('status-sess').textContent = '✓ ' + file.name + ': ' + fmt.format(A.sp) + ' SP có thẻ' + (A.notInBuild ? ' (' + A.notInBuild + ' SP không có trong lần kéo dữ liệu → dự kiến 0)' : '');
      $('sess-out').hidden = false;
      $('s-nw').textContent = pct(A.sc, A.T); $('s-nw-d').textContent = fmt.format(A.sc) + ' / ' + fmt.format(A.T) + ' thẻ, thiếu ' + fmt.format(A.miss);
      $('s-pos').textContent = pct(A.scE, A.E); $('s-pos-d').textContent = fmt.format(A.scE) + ' / ' + fmt.format(A.E) + ' thẻ dự kiến';
      $('s-sp').textContent = pct(A.okPOS, A.sp); $('s-sp-d').textContent = fmt.format(A.okPOS) + ' / ' + fmt.format(A.sp) + ' SP (theo NW: ' + fmt.format(A.okNW) + ')' + (A.okLoose ? '; ' + fmt.format(A.okLoose) + ' SP khớp nhờ hộp lẻ (' + fmt.format(A.okLooseTags) + ' thẻ)' : '');
      $('s-short').textContent = fmt.format(A.E - A.scE);
      $('s-over').textContent = fmt.format(A.over); $('s-over-d').textContent = (A.overSp ? fmt.format(A.overSp) + ' SP: nhập NW dư, POS lệch, hoặc hàng còn mà POS đã trừ' : '');
      $('s-str').textContent = fmt.format(r.strange.reduce(function (t, x) { return t + x[1]; }, 0));
      $('s-strange').innerHTML = r.strange.map(function (x) { return '<li>' + esc(x[0]) + ': <b>' + fmt.format(x[1]) + '</b></li>'; }).join('');
    } catch (e) {
      drop.className = 'drop err';
      $('status-sess').textContent = e.message || String(e);
    }
  }

  // ---------- wiring ----------
  $('run').addEventListener('click', run);
  $('forget').addEventListener('click', function () {
    $('pos-token').value = ''; $('nw-key').value = '';
    try { Object.keys(localStorage).forEach(function (k) { if (k.indexOf('kd2.ord.') === 0) localStorage.removeItem(k); }); } catch (e) { /* storage blocked */ }
    showError('Đã xoá token, key và bộ nhớ đệm đơn POS khỏi trang.');
  });
  $('dl-imp').addEventListener('click', function () { download('kiem-dem-' + state.stamp + '.csv', state.res.imp); });
  $('dl-hold').addEventListener('click', function () { download('kiem-dem-' + state.stamp + '-quy-doi-lech.csv', state.res.hold); });
  $('dl-man').addEventListener('click', function () { download('kiem-dem-' + state.stamp + '-chua-gan-tem.csv', state.res.man); });
  $('dl-chk').addEventListener('click', function () { download('kiem-dem-' + state.stamp + '-kiem-tra.csv', state.res.chk); });
  $('dl-sess').addEventListener('click', function () { download(state.sessName + '-doi-soat.csv', state.sess.csv); });
  $('q').addEventListener('input', renderRows);
  ['add-pend', 'loose', 'ord-from'].forEach(function (k) { $(k).addEventListener('change', function () { if (state.res) showError('Bấm “Kéo dữ liệu” lại để áp dụng tuỳ chọn vừa đổi.'); }); });
  // the opened-box cap needs no new data: rebuild in place
  $('open-max').addEventListener('change', function () { $('open-max').value = openMax(); pref('openmax', String(openMax())); if (state.res) build().catch(function (e) { showError(e.message); }); });
  $('seg').addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;
    state.filter = b.dataset.f;
    Array.prototype.forEach.call($('seg').children, function (x) { x.classList.toggle('on', x === b); });
    renderRows();
  });
  $('store').addEventListener('change', function () {
    var c = $('store').value === 'custom';
    Array.prototype.forEach.call(document.querySelectorAll('.custom-only'), function (x) { x.hidden = !c; });
  });
  [['stock', null], ['master', null], ['sess', session]].forEach(function (k) {
    var drop = $('drop-' + k[0]), input = $('file-' + k[0]);
    var on = function (f) {
      if (k[1]) { k[1](f); return; }
      $('status-' + k[0]).textContent = f ? '✓ ' + f.name + ' (sẽ dùng thay cho API khi bấm Kéo dữ liệu)' : 'Không bắt buộc';
      drop.className = 'drop' + (f ? ' done' : '');
    };
    // the session input is cleared after reading, so picking the same (re-exported) file again fires 'change'
    input.addEventListener('change', function () { var f = input.files[0]; on(f); if (k[1]) input.value = ''; });
    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('over'); var f = e.dataTransfer.files[0]; if (!k[1]) { var dt = new DataTransfer(); dt.items.add(f); input.files = dt.files; } on(f); });
  });
  // remembered, non-secret preferences
  if (pref('store')) $('store').value = pref('store');
  $('sheet-url').value = pref('sheet') || DEFAULT_SHEET;
  if (pref('tabv4')) $('tab-v4').value = pref('tabv4');
  if (pref('tabad') !== null) $('tab-adhoc').value = pref('tabad');
  // 19/11: lấy đúng tồn POS (không cộng đơn chờ giao) và không xét hộp bán lẻ, mỗi lần mở trang
  $('add-pend').checked = false; $('loose').checked = false;
  if (pref('openmax')) $('open-max').value = pref('openmax');
  $('store').dispatchEvent(new Event('change'));
})();
