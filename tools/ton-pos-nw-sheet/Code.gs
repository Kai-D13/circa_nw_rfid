/**
 * Tồn POS ↔ NW (Google Apps Script). Gắn vào một Google Sheet. CẦN runtime V8 (Cài đặt dự án → bật Chrome V8).
 *
 * CHỈ ĐỌC: chỉ gọi GET tới Circa POS và Nextwaves. Không ghi gì lên hai hệ thống.
 * Chỉ ghi vào chính Google Sheet này (tab Chon_kho, Ton_POS_NW) và Script Properties (khoá).
 *
 * Cách dùng (chi tiết: HUONG-DAN.md):
 *   1. Tiện ích mở rộng → Apps Script → dán toàn bộ file này vào Code.gs → Lưu → tải lại Sheet.
 *   2. Menu "Tồn POS ↔ NW" → "1. Nhập khoá API" (POS_TOKEN, NW_KEY; lưu ở Script Properties, không nằm trong code).
 *   3. "2. Cập nhật danh sách cửa hàng" → tab Chon_kho, chọn cửa hàng ở ô B1.
 *   4. "3. Kéo tồn cửa hàng đang chọn" → tab Ton_POS_NW (xoá và ghi lại toàn bộ).
 *
 * Đầu vào: tồn POS (/v1/inventory/admin/stock/search), master quy đổi (Google Sheet, tab "final data v4" + "Adhoc"),
 *          kho NW (/warehouses), tồn NW (/stock/overview?warehouseId=).
 * Đầu ra:  1 dòng / product_id × seller_code POS; total_rfid_need_print = ⌈tồn POS (trừ Kho thất lạc) ÷ quy_doi⌉
 *          (giống "Dự kiến E" của tool Kiểm đếm v2): quy_doi lấy từ master; master không có mã / thiếu đơn vị in thì
 *          đoán từ tên SP như v2 (ghi chú "quy đổi đoán từ tên"). Tồn NW ghép vào dòng seller CIRCA.
 *
 * Bố cục: phần 1 là hàm THUẦN (không đụng SpreadsheetApp / UrlFetchApp / PropertiesService), test bằng Node
 * (tools/ton-pos-nw-sheet/test.js). Phần 2 là lớp mỏng Apps Script: menu, gọi mạng, đọc/ghi sheet.
 */

var CFG = {
  POS_API: 'https://api.v2.circa.vn',
  NW_API: 'https://api-circa.nextwaves.app/api/v1/public',
  MASTER_ID: '18nLllIlORaki3por1diKzNo2tWvdVyUnB1xbZXDv8Xc',
  MASTER_TAB: 'final data v4',
  ADHOC_TAB: 'Adhoc',
  TAB_CHON: 'Chon_kho',
  TAB_KQ: 'Ton_POS_NW',
  LIST_ROW: 4,              // danh sách cửa hàng ở tab Chon_kho bắt đầu từ dòng này
  PAGE_SIZE: 500,
  MAX_PAGES: 200,
  WAIT_MS: [2000, 4000, 8000], // thử lại tối đa 3 lần
  TZ: 'Asia/Ho_Chi_Minh'
};

var HEADER = ['POS_code', 'POS_name', 'product_id', 'product_name', 'owner_name', 'total_on_hand_qty', 'total_available_qty',
  'total_rfid_need_print', 'quy_doi', 'nw_ten_san_pham', 'nw_kho', 'nw_don_vi', 'nw_so_luong', 'nw_tong_the_epc', 'ghi_chu'];

// =====================================================================================================
// PHẦN 1. HÀM THUẦN
// =====================================================================================================

// --- port nguyên từ KiemDem (scripts/kiem-dem/tool-worker-raw.js) ---
function fold(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/\p{Mn}/gu, '').toLowerCase().trim();
}
function strip(s) { return String(s == null ? '' : s).trim(); }
function num(s) {
  var t = String(s == null ? '' : s).replace(/,/g, '').trim();
  if (t === '') return 0;
  var v = Number(t);
  return isNaN(v) ? 0 : v;
}
// format(x, 'g') của Python (dùng trong câu ghi chú)
function g(x) {
  if (x === 0) return '0';
  if (!isFinite(x)) return String(x);
  var p = Number(x.toPrecision(6));
  var e = Math.floor(Math.log10(Math.abs(p)));
  if (e < -4 || e >= 6) {
    var s = p.toExponential(5).replace(/\.?0+e/, 'e');
    return s.replace(/e([+-])(\d)$/, 'e$10$2');
  }
  return String(p);
}
// ô sheet → chữ như loader v2 đọc (số nguyên không có .0)
function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return String(v);
}
function r3(x) { return Math.round(x * 1000) / 1000; }

var SAME_UNIT = { tube: ['tuyp'], tuyp: ['tube'], lo: ['hu'], hu: ['lo'] };

// --- đoán quy đổi từ tên SP khi master không có (port nguyên KiemDem.ratioFor và các hàm phụ) ---
var UNIT_ALIASES = {
  v: ['vien'], vien: ['vien'], 'vien nang': ['vien'], 'vien sui': ['vien'],
  h: ['hop'], hop: ['hop'],
  c: ['chai', 'cai', 'cuon', 'ong', 'que', 'cay'], chai: ['chai'], cai: ['cai'], chiec: ['cai'],
  t: ['tuyp', 'tube'], tuyp: ['tuyp', 'tube'], tube: ['tuyp', 'tube'],
  g: ['goi'], goi: ['goi'],
  m: ['mieng', 'cai', 'to'], mieng: ['mieng', 'cai', 'to'],
  o: ['ong'], ong: ['ong'],
  l: ['lo'], lo: ['lo', 'hu'], hu: ['hu', 'lo'],
  b: ['bich', 'bo'], bich: ['bich', 'tui'], bo: ['bo'], tui: ['tui', 'bich'],
  q: ['que', 'cai'], que: ['que', 'cai'], cay: ['que', 'cay', 'cai'], thoi: ['thoi'],
  to: ['to', 'mieng'], cuon: ['cuon', 'cai'], lon: ['lon'], vi: ['vi'], loc: ['loc'], thung: ['thung'],
};
var ALIAS_KEYS_BY_LEN = Object.keys(UNIT_ALIASES).sort(function (a, b) { return b.length - a.length; });
var MEASURES = new Set(['ml', 'l', 'lit', 'gr', 'gram', 'g', 'mg', 'kg', 'mcg', 'lieu', 'iu', 'cm', 'mm', 'm']);
var MEASURE_ONLY = new Set(['ml', 'l', 'lit', 'gr', 'gram', 'mg', 'kg', 'mcg', 'lieu', 'iu', 'cm', 'mm']);
var OUTER_LABELS = {
  h: 'hộp', hop: 'hộp', c: 'chai', l: 'lọ', lo: 'lọ', g: 'gói', goi: 'gói',
  t: 'tuýp', tuyp: 'tuýp', b: 'bịch', bich: 'bịch', loc: 'lốc', thung: 'thùng',
  tui: 'túi', hu: 'hũ', vi: 'vỉ', tube: 'tube', chai: 'chai', day: 'dây',
};
function has_(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function parseToken(tok) {
  tok = fold(tok);
  var m = tok.match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);
  if (m) return [parseFloat(m[1].replace(',', '.')), m[2].trim()];
  m = tok.match(/^([^\d]+?)\s*(\d+(?:[.,]\d+)?)\s*(.*)$/);
  if (m) return [null, m[1].trim(), parseFloat(m[2].replace(',', '.')), m[3].trim()];
  return [null, tok];
}
function unitSet(u) {
  u = u.trim() ? u.trim().split(' ')[0] : '';
  if (has_(UNIT_ALIASES, u)) return new Set(UNIT_ALIASES[u]);
  for (var i = 0; i < ALIAS_KEYS_BY_LEN.length; i++) {
    var k = ALIAS_KEYS_BY_LEN[i];
    if (k.length > 1 && u.startsWith(k)) return new Set(UNIT_ALIASES[k]);
  }
  return new Set();
}
function outerLabel(outer) { return has_(OUTER_LABELS, outer) ? OUTER_LABELS[outer] : (outer || 'hộp'); }
// → [đơn vị in, quy đổi, cảnh báo]; có cảnh báo nghĩa là cần người xem lại
function ratioFor(name, stockUnit) {
  var stock = fold(stockUnit);
  var specs = [], re = /\(([^()]*)\)/g, mm;
  while ((mm = re.exec(name || '')) !== null) specs.push(mm[1]);
  var spec = null;
  for (var i = specs.length - 1; i >= 0; i--) {
    if (specs[i].indexOf('/') >= 0 || /\d/.test(specs[i])) { spec = specs[i]; break; }
  }
  if (spec === null) return [stockUnit, 1, ''];
  var parts = spec.split(/\/|\s+x\s+/).filter(function (p) { return p.trim(); });
  var first = parseToken(parts[0]);
  if (first.length === 4) {
    parts = [first[1], g(first[2]) + first[3]].concat(parts.slice(1));
    first = [null, first[1]];
  }
  var outer = first[0] === null ? first[1] : '';
  if (unitSet(outer).has(stock) || !outer) return [stockUnit, 1, ''];
  var counts = [], ratio = 1, rest = parts.slice(1);
  for (var j = 0; j < rest.length; j++) {
    var tok = parseToken(rest[j]);
    if (tok.length === 4 || tok[0] === null) continue;
    var n = tok[0], u = tok[1];
    if (u === 'g' && Number.isInteger(n) && (j + 1 < rest.length || stock === 'goi')) u = 'goi';
    if (MEASURE_ONLY.has(u) || (MEASURES.has(u) && !unitSet(u).has(stock))) break;
    ratio *= n;
    counts.push([n, u]);
    if (unitSet(u).has(stock)) {
      if (counts.length > 1 && ['loc', 'thung', 'bich', 'tui', 'day'].indexOf(outer) >= 0) {
        return [outerLabel(outer), ratio, 'tem trên ' + outerLabel(outer) + ' hay đơn vị bên trong? (' + spec + ')'];
      }
      return [outerLabel(outer), ratio, ''];
    }
  }
  if (!counts.length) return [stockUnit, 1, ''];
  if (counts.length === 1 && counts[0][1] === '') return [outerLabel(outer), ratio, ''];
  if (counts.every(function (c) { return !unitSet(c[1]).has(stock); })) {
    return [stockUnit, 1, 'không tìm thấy số ' + stockUnit + ' trong (' + spec + '), để 1'];
  }
  return [outerLabel(outer), ratio, 'đoán ' + g(ratio) + ' ' + stockUnit + '/' + outerLabel(outer) + ' từ (' + spec + ')'];
}

// v2 (core.js): hàng không phải hàng bán → Dự kiến 0
var NON_MERCH = /phi[eế]u mua h[aà]ng|t[aạ]p ch[ií]|t[oờ] r[oơ]i|l[oồ]ng [dđ][eè]n|voucher/i;

// Master: v4Rows = các dòng tab "final data v4" (dòng đầu là header, có product_id / convert_unit / convert_rate /
// final_unit_print); adRows = tab "Adhoc" (header có combine_unit). Trả Map product_id → {print, units, src}.
// Logic giống KiemDem.loadMaster: Adhoc ghi đè cả mã; đơn vị in của Adhoc = ô đầu tiên ở cột 5..(combine_unit−1)
// trùng một UNIT trong combine_unit.
function loadMaster(v4Rows, adRows) {
  var master = new Map();
  if (!v4Rows || !v4Rows.length) throw new Error('Tab "' + CFG.MASTER_TAB + '" của master trống.');
  var rows = v4Rows.map(function (r) { return r.map(cellText); });
  var h = rows[0].map(fold);
  var idx = ['product_id', 'convert_unit', 'convert_rate', 'final_unit_print'].map(function (n) { return h.indexOf(n); });
  if (idx.indexOf(-1) >= 0) throw new Error('Tab "' + CFG.MASTER_TAB + '" của master thiếu cột product_id / convert_unit / convert_rate / final_unit_print (dòng 1).');
  var ci = idx[0], cu = idx[1], cr = idx[2], cp = idx[3];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var pid = strip(r[ci]), unit = strip(r[cu]), rate = num(r[cr]);
    if (!pid || !unit || rate <= 0) continue;
    var e = master.get(pid);
    if (!e) { e = { print: strip(r[cp]), units: new Map(), src: CFG.MASTER_TAB }; master.set(pid, e); }
    e.units.set(fold(unit), [unit, rate]);
    if (!e.print) e.print = strip(r[cp]);
  }
  if (!adRows || !adRows.length) throw new Error('Tab "' + CFG.ADHOC_TAB + '" của master trống.');
  var ad = adRows.map(function (r) { return r.map(cellText); });
  var cc = ad[0].map(fold).indexOf('combine_unit');
  if (cc < 0) throw new Error('Tab "' + CFG.ADHOC_TAB + '" của master thiếu cột combine_unit (dòng 1).');
  for (var k = 1; k < ad.length; k++) {
    var row = ad[k];
    if (row.length <= cc || !strip(row[0])) continue;
    var units = new Map();
    String(row[cc]).split('---').forEach(function (block) {
      var m = block.match(/UNIT:\s*(.+)/);
      var kk = block.match(/CONVERT RATE:\s*([\d.]+)/);
      if (m && kk && num(kk[1]) > 0) units.set(fold(m[1]), [m[1].trim(), num(kk[1])]);
    });
    var pu = '';
    for (var c = 4; c < cc; c++) {
      if (units.has(fold(row[c]))) { pu = strip(row[c]); break; }
    }
    if (units.size && pu) master.set(strip(row[0]), { print: pu, units: units, src: CFG.ADHOC_TAB });
  }
  return master;
}

// [đơn vị in, quy đổi (số đơn vị gốc POS trong 1 đơn vị in), ghi chú] hoặc null nếu master không quy được (port nguyên)
function masterRatio(e, stockUnit) {
  var pu = e.units.get(fold(e.print));
  if (pu === undefined) return null;
  var su = e.units.get(fold(stockUnit));
  (SAME_UNIT[fold(stockUnit)] || []).forEach(function (alt) { su = su || e.units.get(alt); });
  if (su === undefined) {
    var vals = Array.from(e.units.values());
    var base = vals.filter(function (v) { return v[1] === 1; });
    var list = vals.map(function (v) { return v[0] + '=' + g(v[1]); }).join(', ');
    if (base.length !== 1) return null;
    return [pu[0], pu[1], 'master không có ' + stockUnit + ', tính theo ' + base[0][0] + ' (' + list + ')'];
  }
  var ratio = pu[1] / su[1];
  return [pu[0], ratio, ratio >= 1 ? '' : 'đơn vị in ' + pu[0] + ' nhỏ hơn ' + stockUnit];
}

// Dự kiến E của v2: ⌈S ÷ quy đổi⌉; S ≤ 0 → 0
function soTem(S, ratio) { return S > 0 && ratio > 0 ? Math.ceil(r3(S / ratio) - 1e-9) : 0; }

// --- POS ---------------------------------------------------------------------------------------------
function khoaPos(x) { return x.product_id + '|' + (x.seller_code || '') + '|' + (x.sku || ''); }

// Lật trang tồn POS. getPage(page) → data {list, total} của trang đó. Dừng khi đủ total dòng khác nhau hoặc trang rỗng.
// Bỏ dòng lặp giữa các trang (khoá product_id|seller_code|sku). Số dòng khác nhau ≠ total → lỗi (không ghi gì).
function keoHetTrang(getPage, pageSize, maxPages) {
  var rows = [], seen = new Set(), total = null, dup = 0, pages = 0;
  for (var page = 1; page <= maxPages; page++) {
    var d = getPage(page);
    if (!d || !Array.isArray(d.list) || d.total == null || !isFinite(Number(d.total))) throw new Error('POS trả dữ liệu tồn không đúng dạng ở trang ' + page + '.');
    pages = page;
    total = Number(d.total);
    d.list.forEach(function (x) { var k = khoaPos(x); if (seen.has(k)) { dup++; return; } seen.add(k); rows.push(x); });
    if (!d.list.length || rows.length >= total) break;
  }
  if (rows.length !== total) throw new Error('Tồn POS: kéo được ' + rows.length + ' dòng khác nhau sau ' + pages + ' trang, nhưng POS báo tổng ' + total + ' dòng. Dữ liệu chưa đủ, chưa ghi kết quả. Chạy lại sau ít phút.');
  return { rows: rows, total: total, dup: dup, pages: pages };
}

function laKhoThatLac(loc) { return fold(loc) === 'kho that lac'; }

// Gom các dòng POS theo product_id|seller_code. Tồn = Σ items[] trừ vị trí "Kho thất lạc"; phần on_hand/available cấp
// dòng vượt Σ items (nếu có) tính là "không vị trí" (như v2: dòng không có items thì lấy nguyên số cấp dòng).
function gomPos(rows) {
  var m = new Map();
  rows.forEach(function (x) {
    var pid = strip(x.product_id), seller = strip(x.seller_code);
    var key = pid + '|' + seller;
    var p = m.get(key);
    if (!p) { p = { pid: pid, seller: seller, name: '', base: '', oh: 0, av: 0, lost: 0 }; m.set(key, p); }
    if (!p.name && x.product_name) p.name = String(x.product_name);
    if (!p.base && x.base_unit) p.base = String(x.base_unit);
    var items = x.items || [], inOh = 0, inAv = 0;
    items.forEach(function (it) {
      var oh = Number(it.on_hand_qty) || 0, av = Number(it.available_qty) || 0;
      inOh += oh; inAv += av;
      if (laKhoThatLac(it.location_name)) p.lost += oh; else { p.oh += oh; p.av += av; }
    });
    var restOh = r3((Number(x.on_hand_qty) || 0) - inOh), restAv = r3((Number(x.available_qty) || 0) - inAv);
    if (!items.length ? restOh !== 0 : restOh > 0) p.oh += restOh;
    if (!items.length ? restAv !== 0 : restAv > 0) p.av += restAv;
  });
  m.forEach(function (p) { p.oh = r3(p.oh); p.av = r3(p.av); p.lost = r3(p.lost); });
  return m;
}

// --- NW ------------------------------------------------------------------------------------------------
// /warehouses: mảng (có thể lồng children). Trả danh sách phẳng, bỏ kho loại transit.
function khoNwPhang(resp) {
  var a = Array.isArray(resp) ? resp : resp && Array.isArray(resp.data) ? resp.data : null;
  if (!a) throw new Error('Nextwaves trả danh sách kho không đúng dạng.');
  var out = [];
  (function walk(list) {
    list.forEach(function (w) {
      if (!w) return;
      if (String(w.locationType || '').toLowerCase() !== 'transit') out.push({ id: w.id, name: String(w.name || ''), code: w.code });
      if (Array.isArray(w.children) && w.children.length) walk(w.children);
    });
  })(a);
  return out;
}
// Tên để so kho/cửa hàng: chuẩn Unicode NFC, trim, không phân biệt hoa thường, KHÔNG bỏ dấu.
function tenSo(s) { return strip(s).normalize('NFC').toLowerCase(); }
// Kho NW cùng tên cửa hàng POS. Trả kho (0 kho → null). Nhiều hơn 1 kho → lỗi.
function timKhoNw(tenCuaHang, khoList) {
  var key = tenSo(tenCuaHang);
  var hit = khoList.filter(function (w) { return tenSo(w.name) === key; });
  if (hit.length > 1) throw new Error('Có ' + hit.length + ' kho Nextwaves cùng tên "' + strip(tenCuaHang) + '" (' + hit.map(function (w) { return w.id; }).join(', ') + '). Không biết lấy kho nào, nên dừng. Báo người quản lý NW gộp/đổi tên kho.');
  return hit.length ? hit[0] : null;
}
// /stock/overview → mảng items (response hiện không bọc data; chấp nhận cả {data:{items}} / {data:[…]})
function itemsOverview(resp) {
  var a = resp && Array.isArray(resp.items) ? resp.items
    : resp && resp.data && Array.isArray(resp.data.items) ? resp.data.items
    : resp && Array.isArray(resp.data) ? resp.data : null;
  if (!a) throw new Error('Nextwaves trả tồn kho (stock/overview) không đúng dạng.');
  return a;
}
// Dữ liệu trả về phải đúng nguồn đã chọn: mọi dòng có field = id (pos_id của cửa hàng / warehouseId của kho). Lệch → lỗi.
function kiemDungNguon(list, field, id, ten) {
  var sai = list.filter(function (x) { return !x || String(x[field]) !== String(id); });
  if (!sai.length) return;
  var mau = Array.from(new Set(sai.map(function (x) { return x && x[field] != null ? String(x[field]) : '(trống)'; }))).slice(0, 3).join(', ');
  throw new Error(ten + ': ' + sai.length + '/' + list.length + ' dòng không thuộc ' + (field === 'pos_id' ? 'cửa hàng' : 'kho') + ' đã chọn (' + field + ' = ' + mau + '). Dữ liệu trả về sai nguồn nên dừng, chưa ghi gì. Báo PM.');
}

// Gom tồn NW theo product_id (phần số sau "CIRCA-"); cộng quantity/epcCount khi một mã có nhiều dòng.
// Chỉ lấy dòng có tồn: quantity > 0 hoặc epcCount > 0; dòng 0/0 bỏ hẳn (đếm ở zero).
// Dòng productIdentifier không đúng dạng CIRCA-<số> → để riêng (bad).
function gomNw(items) {
  var by = new Map(), bad = [], zero = 0;
  items.forEach(function (it) {
    var idf = strip(it.productIdentifier), m = idf.match(/^CIRCA-(\d+)$/i);
    var q = Number(it.quantity) || 0, e = Number(it.epcCount) || 0;
    if (!(q > 0 || e > 0)) { zero++; return; }
    if (!m) { bad.push({ idf: idf, title: it.productTitle || '', kho: it.warehouseName || '', unit: it.baseUnitOfMeasure || '', q: q, epc: e, n: 1 }); return; }
    var pid = String(Number(m[1]));
    var x = by.get(pid);
    if (!x) { x = { title: it.productTitle || '', kho: it.warehouseName || '', unit: it.baseUnitOfMeasure || '', q: 0, epc: 0, n: 0 }; by.set(pid, x); }
    x.q = r3(x.q + q); x.epc += e; x.n++;
  });
  return { by: by, bad: bad, zero: zero };
}

// --- bảng kết quả ---------------------------------------------------------------------------------------
// store {code, name}; posRows = dòng thô POS (đã khử trùng); master = loadMaster(); nwItems = items overview hoặc null
// (null = không có kho NW trùng tên). Trả {rows: [object theo HEADER], stats}.
function dungBang(store, posRows, master, nwItems) {
  var pos = gomPos(posRows);
  var nw = gomNw(nwItems || []);
  var out = [], used = new Set();
  var stats = { posLines: posRows.length, master: master.size, rows: 0, pids: 0, sumOh: 0, sumAv: 0, sumRfid: 0, thieuMaster: 0, doanTen: 0, lechCoThe: 0,
    ghepNw: 0, chiNw: 0, giuTon0: 0, boTon0: 0, nwSai: nw.bad.length, nw0: nw.zero, nwQ: 0, nwEpc: 0 };
  // tồn của các seller khác CIRCA theo product_id (đã bỏ Kho thất lạc)
  var khac = new Map();
  pos.forEach(function (p) { if (p.seller.toUpperCase() !== 'CIRCA') khac.set(p.pid, r3((khac.get(p.pid) || 0) + p.oh)); });
  pos.forEach(function (p) {
    var circa = p.seller.toUpperCase() === 'CIRCA';
    var n = circa ? nw.by.get(p.pid) : null; // NW chỉ ghép vào dòng seller CIRCA
    // bỏ dòng tồn 0 (cả on_hand và available, sau khi trừ Kho thất lạc), trừ dòng CIRCA của SP có tồn NW
    if (p.oh === 0 && p.av === 0 && !n) { stats.boTon0++; return; }
    var notes = [], rfid, qd = '';
    if (p.oh === 0 && p.av === 0) { notes.push('POS tồn 0, NW còn hàng'); stats.giuTon0++; }
    if (NON_MERCH.test(p.name)) { rfid = 0; notes.push('không phải hàng bán (voucher/tạp chí/tờ rơi…): không in tem'); }
    else {
      // quy đổi = master; master không có mã / thiếu đơn vị in → đoán từ tên SP (như v2 core.js)
      var e = master.get(p.pid), mr = e ? masterRatio(e, p.base) : null, doan = false;
      if (!mr) {
        var f = ratioFor(p.name, p.base);
        mr = [f[0], f[1], (e ? 'master thiếu đơn vị in' : 'không có trong master') + '; quy đổi đoán từ tên' + (f[2] ? ': ' + f[2] : '') + ' → kiểm tra/bổ sung master'];
        doan = true;
      }
      var ratio = Number(mr[1]) > 0 ? Number(mr[1]) : 0;
      if (!(p.oh > 0)) rfid = 0;
      else if (!ratio) { rfid = ''; notes.push('chưa có quy đổi → không tính được số tem, cần bổ sung master'); }
      else { rfid = soTem(p.oh, ratio); qd = Number(ratio.toPrecision(12)); if (doan) stats.doanTen++; }
      if (mr[2] && p.oh > 0) notes.push(mr[2]);
    }
    if (p.lost) notes.push('Kho thất lạc ' + g(p.lost) + ' (không tính)');
    if (!circa) notes.push('seller ' + (p.seller || '(trống)') + ': không ghép NW');
    if (circa && khac.get(p.pid) > 0) notes.push('owner khác còn tồn ' + g(khac.get(p.pid)));
    if (n) {
      used.add(p.pid);
      if (n.n > 1) notes.push('NW có ' + n.n + ' dòng cùng mã, đã cộng');
      // chỉ ghi chú, không đổi số tem: cỡ thẻ trung bình trên NW khác quy đổi đang dùng
      if (n.epc > 0 && qd !== '' && Math.abs(n.q / n.epc - qd) > 1e-6) { notes.push('quy đổi ' + g(qd) + ' khác cỡ thẻ NW ~' + g(Math.round(n.q / n.epc * 100) / 100)); stats.lechCoThe++; }
    }
    out.push({ kind: 0, pid: p.pid, seller: p.seller, r: [store.code, store.name, p.pid, p.name, circa ? 'CIRCA' : '', p.oh, p.av, rfid, qd,
      n ? n.title : '', n ? n.kho : '', n ? n.unit : '', n ? n.q : '', n ? n.epc : '', notes.join('; ')] });
  });
  // SP có tồn NW mà POS không có dòng seller CIRCA nào → dòng "chỉ có ở NW" (cuối bảng)
  nw.by.forEach(function (n, pid) {
    if (used.has(pid)) return;
    var note = 'chỉ có ở NW' + (khac.get(pid) > 0 ? ' (POS có owner khác: ' + g(khac.get(pid)) + ')' : '') + (n.n > 1 ? '; NW có ' + n.n + ' dòng cùng mã, đã cộng' : '');
    out.push({ kind: 1, pid: pid, seller: '', r: [store.code, store.name, pid, '', '', '', '', '', '', n.title, n.kho, n.unit, n.q, n.epc, note] });
  });
  nw.bad.forEach(function (b) {
    out.push({ kind: 2, pid: '', seller: '', r: [store.code, store.name, '', '', '', '', '', '', '', b.title, b.kho, b.unit, b.q, b.epc, 'chỉ có ở NW; mã NW không đúng dạng CIRCA-<số>: "' + b.idf + '", không ghép được'] });
  });
  var pidNum = function (x) { var v = Number(x); return x !== '' && isFinite(v) ? v : Infinity; };
  out.sort(function (a, b) {
    return a.kind - b.kind || pidNum(a.pid) - pidNum(b.pid) || (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0) || (a.seller < b.seller ? -1 : a.seller > b.seller ? 1 : 0);
  });
  var pids = new Set();
  out.forEach(function (o) {
    var r = o.r;
    stats.rows++;
    if (o.kind === 0) {
      pids.add(o.pid);
      stats.sumOh += r[5]; stats.sumAv += r[6];
      if (r[7] === '') stats.thieuMaster++; else stats.sumRfid += r[7];
      if (r[12] !== '') stats.ghepNw++;
    } else stats.chiNw++;
    if (r[12] !== '') { stats.nwQ += r[12]; stats.nwEpc += r[13]; }
  });
  stats.pids = pids.size; stats.sumOh = r3(stats.sumOh); stats.sumAv = r3(stats.sumAv); stats.nwQ = r3(stats.nwQ);
  return { rows: out.map(function (o) { return o.r; }), stats: stats };
}

// Chữ đưa vào ô sheet: chặn Sheets hiểu nhầm thành công thức / số / ngày (thêm dấu ' ở đầu).
function oChu(v) {
  if (typeof v !== 'string' || v === '') return v;
  return /^[=+\-@]/.test(v) || /^[\d\s.,:\/%-]+$/.test(v) ? "'" + v : v;
}
var COT_SO = { 2: 1, 5: 1, 6: 1, 7: 1, 8: 1, 12: 1, 13: 1 };
// Bảng 2 chiều để ghi bằng MỘT setValues: header + các dòng; product_id ghi dạng số, cột chữ qua oChu.
function bangGhi(rows) {
  return [HEADER.slice()].concat(rows.map(function (r) {
    return r.map(function (v, i) {
      if (i === 2) return v === '' ? '' : (/^\d+$/.test(String(v)) ? Number(v) : oChu(String(v)));
      return COT_SO[i] ? v : oChu(v == null ? '' : String(v));
    });
  }));
}

// --- danh sách cửa hàng ----------------------------------------------------------------------------------
// /v1/authz/me → [{code, name, id}] (gộp stores của mọi client, bỏ trùng id, xếp theo code)
function cuaHangTuMe(me) {
  var d = me && me.data;
  if (!d || !Array.isArray(d.clients)) throw new Error('POS trả thông tin tài khoản (authz/me) không đúng dạng.');
  var seen = new Set(), out = [];
  d.clients.forEach(function (c) {
    (c && c.stores || []).forEach(function (s) {
      if (!s || !s.id || seen.has(s.id)) return;
      seen.add(s.id); out.push({ code: strip(s.code), name: strip(s.name), id: String(s.id) });
    });
  });
  if (!out.length) throw new Error('Tài khoản POS không có cửa hàng nào.');
  out.sort(function (a, b) { return a.code < b.code ? -1 : a.code > b.code ? 1 : 0; });
  return out;
}
function nhanCuaHang(s) { return s.code + ' - ' + s.name; }
// Dòng ghi vào tab Chon_kho (A code, B tên, C id POS, D tên kho NW khớp, E id kho NW)
function dongDanhSach(stores, khoList) {
  return stores.map(function (s) {
    var key = tenSo(s.name), hit = khoList.filter(function (w) { return tenSo(w.name) === key; });
    if (hit.length === 1) return [s.code, s.name, s.id, hit[0].name, hit[0].id];
    return [s.code, s.name, s.id, hit.length ? 'nhiều kho NW trùng tên (' + hit.length + ')' : 'chưa có kho NW trùng tên', ''];
  });
}
// B1 → dòng cửa hàng trong danh sách (so cả chuỗi "code - name", rồi so phần code)
function timCuaHang(label, list) {
  var t = tenSo(label);
  if (!t) return null;
  var hit = list.filter(function (r) { return tenSo(nhanCuaHang({ code: strip(r[0]), name: strip(r[1]) })) === t; });
  if (!hit.length) { var code = t.split(' - ')[0].trim(); hit = list.filter(function (r) { return tenSo(r[0]) === code; }); }
  return hit.length === 1 ? { code: strip(hit[0][0]), name: strip(hit[0][1]), id: strip(hit[0][2]) } : null;
}
function ghiChuLanKeo(gio, store, kho, stats) {
  return 'Kéo lúc ' + gio + ' · ' + nhanCuaHang(store) + ' · ' + stats.rows + ' dòng, ' + stats.pids + ' mã POS, cần in ' + stats.sumRfid + ' tem' +
    (stats.doanTen ? ', ' + stats.doanTen + ' dòng quy đổi đoán từ tên (kiểm trước khi in)' : '') +
    (stats.thieuMaster ? ', ' + stats.thieuMaster + ' dòng chưa tính được số tem' : '') +
    ' · master ' + stats.master + ' mã' +
    (kho ? ' · kho NW: ' + kho.name + ' (' + stats.ghepNw + ' dòng ghép NW, ' + stats.chiNw + ' dòng chỉ có ở NW)' : ' · chưa có kho NW trùng tên, các cột NW để trống');
}

// =====================================================================================================
// PHẦN 2. LỚP APPS SCRIPT (menu, mạng, sheet)
// =====================================================================================================

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Tồn POS ↔ NW')
    .addItem('1. Nhập khoá API', 'menuNhapKhoa')
    .addItem('2. Cập nhật danh sách cửa hàng', 'menuCapNhatCuaHang')
    .addItem('3. Kéo tồn cửa hàng đang chọn', 'menuKeoTon')
    .addToUi();
}

function menuNhapKhoa() {
  var ui = SpreadsheetApp.getUi(), props = PropertiesService.getScriptProperties();
  var ds = [['POS_TOKEN', 'Khoá Circa POS (dạng ck_u_… hoặc token phiên)'], ['NW_KEY', 'Khoá Nextwaves (dạng nwc_pk_…:nwc_sk_…)']];
  for (var i = 0; i < ds.length; i++) {
    var ten = ds[i][0], co = !!props.getProperty(ten);
    var r = ui.prompt('Nhập khoá ' + ten, ds[i][1] + '.\nHiện tại: ' + (co ? 'ĐÃ CÓ khoá.' : 'CHƯA CÓ khoá.') + '\nDán khoá mới rồi bấm OK. Để trống rồi bấm OK = giữ nguyên. Bấm Huỷ = dừng.', ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) { ui.alert('Đã dừng. Khoá ' + ten + ' giữ nguyên.'); return; }
    var v = strip(r.getResponseText()).replace(/^bearer\s+/i, '');
    if (v) props.setProperty(ten, v);
  }
  ui.alert('Khoá: POS_TOKEN ' + (props.getProperty('POS_TOKEN') ? 'đã có' : 'CHƯA CÓ') + ', NW_KEY ' + (props.getProperty('NW_KEY') ? 'đã có' : 'CHƯA CÓ') + '.');
}

function menuCapNhatCuaHang() { chay_(capNhatCuaHang_); }
// menu 3 giữ khoá tài liệu: hai người không chạy cùng lúc trên một Sheet
function menuKeoTon() {
  chay_(function (ui) {
    var lock = LockService.getDocumentLock();
    if (!lock || !lock.tryLock(5000)) throw new Error('Đang có người chạy "Kéo tồn" trên Sheet này, thử lại sau.');
    try { keoTon_(ui); } finally { lock.releaseLock(); }
  });
}

// chạy một việc; lỗi → hộp thoại tiếng Việt
function chay_(fn) {
  var ui = SpreadsheetApp.getUi();
  try { fn(ui); } catch (e) { ui.alert('Lỗi', (e && e.message) || String(e), ui.ButtonSet.OK); }
}

function khoa_() {
  var props = PropertiesService.getScriptProperties();
  var pos = props.getProperty('POS_TOKEN'), nw = props.getProperty('NW_KEY');
  if (!pos || !nw) throw new Error('Chưa có khoá ' + (!pos ? 'POS_TOKEN' : '') + (!pos && !nw ? ' và ' : '') + (!nw ? 'NW_KEY' : '') + '. Vào menu "1. Nhập khoá API".');
  return { pos: pos, nw: nw };
}

// GET JSON. Thử lại tối đa 3 lần (chờ 2/4/8 s) khi lỗi mạng, 429, 5xx, hoặc 200 mà body không phải JSON.
// 401/403 → dừng ngay. Mã khác → dừng.
function getJson_(url, headers, ten) {
  var last = '';
  for (var t = 0; t <= CFG.WAIT_MS.length; t++) {
    if (t) Utilities.sleep(CFG.WAIT_MS[t - 1]);
    var res;
    try { res = UrlFetchApp.fetch(url, { method: 'get', headers: headers, muteHttpExceptions: true }); }
    catch (e) { last = 'lỗi mạng: ' + ((e && e.message) || e); continue; }
    var code = res.getResponseCode();
    if (code === 401 || code === 403) throw new Error(ten + ': ' + (code === 401 ? 'khoá sai hoặc hết hạn' : 'khoá không có quyền với cửa hàng/kho này hoặc đã hết hạn') + ' (HTTP ' + code + '). Vào menu "1. Nhập khoá API" để nhập lại khoá ' + (ten === 'POS' ? 'POS_TOKEN' : 'NW_KEY') + '.');
    if (code === 429 || code >= 500) { last = 'HTTP ' + code; continue; }
    if (code !== 200) throw new Error(ten + ' trả lỗi HTTP ' + code + ' cho ' + url.replace(/\?.*/, '') + ': ' + String(res.getContentText()).slice(0, 200));
    try { return JSON.parse(res.getContentText('UTF-8')); } catch (e) { last = 'dữ liệu trả về bị cắt hoặc không phải JSON'; }
  }
  throw new Error(ten + ' không phản hồi được sau 3 lần thử lại (' + last + '). Chưa ghi gì. Chạy lại sau ít phút.');
}
function posGet_(path, token, storeId) {
  var h = { authorization: 'Bearer ' + token };
  if (storeId) h['x-store-id'] = storeId;
  return getJson_(CFG.POS_API + path, h, 'POS');
}
function nwGet_(path, key) { return getJson_(CFG.NW_API + path, { authorization: 'Bearer ' + key }, 'Nextwaves'); }

function tabChon_(ss) {
  var sh = ss.getSheetByName(CFG.TAB_CHON);
  if (!sh) {
    sh = ss.insertSheet(CFG.TAB_CHON);
    sh.getRange(1, 1, 2, 1).setValues([['Cửa hàng:'], ['Lần kéo:']]);
  }
  return sh;
}

function capNhatCuaHang_(ui) {
  var k = khoa_(), ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Đang đọc danh sách cửa hàng POS và kho NW…', 'Tồn POS ↔ NW', 30);
  var stores = cuaHangTuMe(posGet_('/v1/authz/me', k.pos));
  var kho = khoNwPhang(nwGet_('/warehouses', k.nw));
  var rows = dongDanhSach(stores, kho);
  var sh = tabChon_(ss);
  var last = sh.getLastRow();
  if (last >= CFG.LIST_ROW) sh.getRange(CFG.LIST_ROW, 1, last - CFG.LIST_ROW + 1, 5).clearContent();
  sh.getRange(CFG.LIST_ROW - 1, 1, 1, 5).setValues([['Mã CH (POS)', 'Tên cửa hàng', 'ID cửa hàng POS', 'Kho NW trùng tên', 'ID kho NW']]);
  sh.getRange(CFG.LIST_ROW, 1, rows.length, 5).setValues(rows.map(function (r) { return r.map(oChu); }));
  var labels = stores.map(nhanCuaHang), b1 = sh.getRange('B1');
  b1.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(labels, true).setAllowInvalid(false).build());
  if (labels.indexOf(strip(b1.getValue())) < 0) b1.clearContent();
  var khop = rows.filter(function (r) { return r[4]; }).length;
  ui.alert('Đã cập nhật ' + stores.length + ' cửa hàng (' + khop + ' cửa hàng có kho NW trùng tên). Chọn cửa hàng ở ô B1 tab ' + CFG.TAB_CHON + ', rồi chạy "3. Kéo tồn cửa hàng đang chọn".');
}

// Đọc master: chỉ đọc các cột cần ở tab "final data v4" + cả tab Adhoc
function docMaster_() {
  var ss;
  try { ss = SpreadsheetApp.openById(CFG.MASTER_ID); }
  catch (e) { throw new Error('Không mở được Google Sheet master (' + ((e && e.message) || e) + '). Tài khoản đang chạy cần quyền xem file master.'); }
  var v4 = ss.getSheetByName(CFG.MASTER_TAB);
  if (!v4) throw new Error('Master không có tab "' + CFG.MASTER_TAB + '".');
  var ad = ss.getSheetByName(CFG.ADHOC_TAB);
  if (!ad) throw new Error('Master không có tab "' + CFG.ADHOC_TAB + '".');
  var nr = v4.getLastRow(), nc = v4.getLastColumn();
  if (nr < 2 || nc < 1) throw new Error('Tab "' + CFG.MASTER_TAB + '" của master trống.');
  var head = v4.getRange(1, 1, 1, nc).getValues()[0].map(fold);
  var cols = ['product_id', 'convert_unit', 'convert_rate', 'final_unit_print'].map(function (n) { return head.indexOf(n); });
  if (cols.indexOf(-1) >= 0) throw new Error('Tab "' + CFG.MASTER_TAB + '" của master thiếu cột product_id / convert_unit / convert_rate / final_unit_print (dòng 1).');
  var c0 = Math.min.apply(null, cols), c1 = Math.max.apply(null, cols);
  var v4Rows = v4.getRange(1, c0 + 1, nr, c1 - c0 + 1).getValues();
  var adRows = ad.getLastRow() ? ad.getDataRange().getValues() : [];
  return loadMaster(v4Rows, adRows);
}

function keoTon_(ui) {
  var k = khoa_(), ss = SpreadsheetApp.getActiveSpreadsheet();
  var chon = ss.getSheetByName(CFG.TAB_CHON);
  if (!chon || chon.getLastRow() < CFG.LIST_ROW) throw new Error('Chưa có danh sách cửa hàng. Chạy menu "2. Cập nhật danh sách cửa hàng" trước.');
  var list = chon.getRange(CFG.LIST_ROW, 1, chon.getLastRow() - CFG.LIST_ROW + 1, 5).getValues();
  var store = timCuaHang(chon.getRange('B1').getValue(), list);
  if (!store) throw new Error('Chưa chọn cửa hàng (hoặc cửa hàng không có trong danh sách). Chọn ở ô B1 tab ' + CFG.TAB_CHON + '.');
  var gio = Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy HH:mm');

  // 1. tồn POS (mọi trang)
  var pos = keoHetTrang(function (page) {
    ss.toast('Tồn POS ' + store.name + ': trang ' + page + '…', 'Tồn POS ↔ NW', 30);
    var j = posGet_('/v1/inventory/admin/stock/search?query=pos_id=' + store.id + ',include_negative_qty=true,&limit=' + CFG.PAGE_SIZE + '&page=' + page, k.pos, store.id);
    return j && j.data;
  }, CFG.PAGE_SIZE, CFG.MAX_PAGES);
  kiemDungNguon(pos.rows, 'pos_id', store.id, 'Tồn POS');
  // 2. kho NW cùng tên + tồn NW
  ss.toast('Đọc tồn Nextwaves…', 'Tồn POS ↔ NW', 30);
  var kho = timKhoNw(store.name, khoNwPhang(nwGet_('/warehouses', k.nw)));
  var nwItems = kho ? itemsOverview(nwGet_('/stock/overview?warehouseId=' + encodeURIComponent(kho.id), k.nw)) : null;
  if (kho) kiemDungNguon(nwItems, 'warehouseId', kho.id, 'Tồn NW');
  // 3. master
  ss.toast('Đọc master quy đổi…', 'Tồn POS ↔ NW', 60);
  var master = docMaster_();
  // 4. tính + ghi (chỉ ghi khi mọi nguồn đã đọc xong)
  var res = dungBang(store, pos.rows, master, nwItems);
  var data = bangGhi(res.rows), nR = data.length, nC = HEADER.length;
  var sh = ss.getSheetByName(CFG.TAB_KQ) || ss.insertSheet(CFG.TAB_KQ);
  var oldR = sh.getLastRow(), oldC = sh.getLastColumn();
  if (sh.getMaxRows() < nR) sh.insertRowsAfter(sh.getMaxRows(), nR - sh.getMaxRows());
  if (sh.getMaxColumns() < nC) sh.insertColumnsAfter(sh.getMaxColumns(), nC - sh.getMaxColumns());
  // ghi đè bằng MỘT setValues trước; lỗi ở đây thì dữ liệu cũ còn nguyên. Sau đó mới xoá phần thừa của lần chạy trước.
  sh.getRange(1, 1, nR, nC).setValues(data);
  if (oldR > nR) sh.getRange(nR + 1, 1, oldR - nR, Math.max(oldC, nC)).clearContent();
  if (oldC > nC) sh.getRange(1, nC + 1, nR, oldC - nC).clearContent();
  sh.setFrozenRows(1);
  var note = ghiChuLanKeo(gio, store, kho, res.stats);
  chon.getRange('B2').setValue(note);
  ss.toast('Xong.', 'Tồn POS ↔ NW', 5);
  ui.alert('Xong. ' + note);
}
