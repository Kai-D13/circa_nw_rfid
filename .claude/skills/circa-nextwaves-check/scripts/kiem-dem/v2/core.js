// Kiểm đếm v2 core. Runs where XLSX (SheetJS) and KiemDem (v1 logic) are globals.
// Dự kiến RFID (từ 19/11, theo yêu cầu user — đơn giản, không ca adhoc):
//   Dự kiến = ⌈ tồn POS (đơn vị gốc POS, mọi vị trí trừ Kho thất lạc) ÷ Quy đổi ⌉
//   Quy đổi = số đơn vị gốc POS trong 1 đơn vị dán tem RFID, lấy từ MASTER (final_unit_print); thiếu master thì đoán từ tên + cờ.
//   VD 82278: 215 viên, tem dán theo hộp 20 viên → ⌈215/20⌉ = 11.
// Thẻ NW KHÔNG tham gia công thức (bản cũ lấy cỡ thẻ NW làm quy đổi + cộng dồn SL trên thẻ → sai khi NW ghi sai SL thẻ);
// thẻ NW chỉ dùng để cảnh báo: thiếu tem cần gắn, NW dư thẻ, cỡ thẻ NW ≠ master. Không xét hộp bán lẻ (E_max = E).
var KD2 = (function () {
  'use strict';
  var K = KiemDem, fold = K.fold, g = K.g;
  var NON_MERCH = /phi[eế]u mua h[aà]ng|t[aạ]p ch[ií]|t[oờ] r[oơ]i|l[oồ]ng [dđ][eè]n|voucher/i;
  var DEFAULT_EXCLUDE = ['kho that lac'];

  function r3(x) { return Math.round(x * 1000) / 1000; }
  // plain number for CSV: no exponent, no 6-digit rounding (v1 wrote String(stock))
  function num(x) { return x == null || x === '' ? '' : String(Number(Number(x).toPrecision(12))); }
  var NOLOC = '(không vị trí)';

  // --- POS stock -------------------------------------------------------------------------------
  // API rows (slim): {pid, name, base, q, seller, sku, locs:[{loc,q}], units:[{unit,rate}]}; one row per seller/SKU → summed
  // per product. Rows repeated across pages (unstable paging) are dropped by pid|seller|sku. Stock not attached to a listed
  // location (q > Σ locs) is kept under "(không vị trí)".
  function posFromApi(rows) {
    var m = new Map(), seen = new Set();
    rows.forEach(function (r) {
      var c = String(r.pid);
      if (r.seller != null || r.sku != null) { var key = c + '|' + (r.seller || '') + '|' + (r.sku || ''); if (seen.has(key)) return; seen.add(key); }
      var p = m.get(c);
      if (!p) { p = { code: c, name: r.name || '', base: r.base || '', locs: new Map(), units: new Map() }; m.set(c, p); }
      if (!p.name && r.name) p.name = r.name;
      if (!p.base && r.base) p.base = r.base;
      var locs = (r.locs || []).slice();
      var inLocs = locs.reduce(function (s, l) { return s + (Number(l.q) || 0); }, 0), rest = r3((Number(r.q) || 0) - inLocs);
      if (!locs.length ? rest !== 0 : rest > 0) locs.push({ loc: NOLOC, q: rest });
      locs.forEach(function (l) { var k = l.loc == null ? '' : String(l.loc); p.locs.set(k, (p.locs.get(k) || 0) + (Number(l.q) || 0)); });
      (r.units || []).forEach(function (u) { if (u.unit && Number(u.rate) > 0) p.units.set(fold(u.unit), [u.unit, Number(u.rate)]); });
    });
    return m;
  }
  // "Danh sách tồn kho" xlsx (fallback): Mã sản phẩm, Tên sản phẩm, Đơn vị lưu kho, Vị trí, Tồn tổng.
  function posFromXlsx(wb) {
    var st = K.readStock(wb), c = st.cols, m = new Map();
    for (var i = 1; i < st.table.length; i++) {
      var r = st.table[i], code = K.strip(r[c.code]);
      if (!code) continue;
      var p = m.get(code);
      if (!p) { p = { code: code, name: r[c.name] || '', base: r[c.unit] || '', locs: new Map(), units: new Map() }; m.set(code, p); }
      var l = r[c.loc] == null ? '' : String(r[c.loc]);
      p.locs.set(l, (p.locs.get(l) || 0) + K.num(r[c.qty]));
    }
    return m;
  }
  function locations(pos) {
    var t = new Map();
    pos.forEach(function (p) { p.locs.forEach(function (q, l) { var x = t.get(l) || [0, 0]; x[0]++; x[1] += q; t.set(l, x); }); });
    return Array.from(t.entries()).sort(function (a, b) { return b[1][0] - a[1][0]; }).map(function (e) { return [e[0], e[1][0], r3(e[1][1])]; });
  }

  // --- NW tags from the warehouse ledger -------------------------------------------------------
  // rows (slim): {c: circa id, q, t: actionType, epcs:[], fup, base, title}. Each row's quantity is split evenly over its EPCs;
  // an EPC with balance > 0 is an active tag. sizes = base units per tag at stock-in.
  // Also: P.first = first time tags came in (stock-in, pack-in or transfer-in), in ms; P.refs = order refs already deducted
  // on NW for THIS product (CIR- stripped) — an order can be deducted for one product and not for another.
  var TAG_IN = /stock_in|pack_in|transfer/i;
  function tagsFromLedger(rows) {
    var bal = new Map(), prod = new Map();
    rows.forEach(function (r) {
      var c = String(r.c);
      var P = prod.get(c);
      if (!P) { P = { code: c, title: r.title || '', base: r.base || '', fup: r.fup || '', sizes: new Map(), qs: [], epcs: [], first: null, refs: new Set() }; prod.set(c, P); }
      if (!P.fup && r.fup) P.fup = r.fup;
      if (r.ref) P.refs.add(String(r.ref).replace(/^CIR-/i, ''));
      if (Number(r.q) > 0 && TAG_IN.test(r.t || '') && r.at) { var ts = Date.parse(r.at); if (isFinite(ts) && (P.first == null || ts < P.first)) P.first = ts; }
      var es = r.epcs || [];
      if (!es.length) return;
      var each = Number(r.q) / es.length;
      es.forEach(function (e) { var b = bal.get(e); if (!b) { b = { c: c, q: 0 }; bal.set(e, b); } b.q += each; b.c = c; });
      if (Number(r.q) > 0 && TAG_IN.test(r.t || '')) { var sz = r3(each); P.sizes.set(sz, (P.sizes.get(sz) || 0) + es.length); }
    });
    bal.forEach(function (b, e) { var q = r3(b.q); if (q > 0) { var P = prod.get(b.c); P.qs.push(q); P.epcs.push(e); } });
    return prod;
  }

  // --- formula ---------------------------------------------------------------------------------
  // fewest tags (largest first) whose quantities cover S, never more than the tags that exist
  function cover(qs, S) {
    if (!(S > 0)) return 0;
    var a = qs.slice().sort(function (x, y) { return y - x; }), n = 0, acc = 0;
    while (n < a.length && acc < S - 1e-9) { acc += a[n]; n++; }
    return n;
  }
  // tags expected for POS stock S: the fewest existing tags (largest first) that cover S; when all of them together hold less
  // than S, the rest is still expected, in tags of the usual size (goods not tagged on NW yet). Never capped by the NW tag count.
  function need(qs, S, size) {
    if (!(S > 0)) return 0;
    var n = cover(qs, S), Q = qs.reduce(function (s, x) { return s + x; }, 0);
    if (Q < S - 1e-9) n += Math.ceil((S - Q) / (size > 0 ? size : 1) - 1e-9);
    return n;
  }
  function mode(map) {
    var best = null, bn = -1;
    map.forEach(function (n, k) { if (n > bn || (n === bn && k > best)) { best = k; bn = n; } });
    return best;
  }
  function modeArr(a) { var m = new Map(); a.forEach(function (x) { m.set(x, (m.get(x) || 0) + 1); }); return mode(m); }
  function rate(units, u) { var x = units && units.get(fold(u)); return x ? x[1] : null; }

  // Opened (loose-sold) boxes keep their tag: with k boxes partly sold, up to floor((S-k)/size) full boxes + k opened ones are
  // on the shelf. k ≤ loose-sale orders + 1 (one box may already have been open when it was tagged), k ≤ cap (boxes a store
  // keeps open at once per product; the lifetime order count only grows), k ≤ S (each opened box holds ≥ 1 base unit), k ≤ T.
  var OPEN_MAX = 2;
  function emax(T, S, size, L, Emin, cap) {
    if (!(S > 0) || !(size > 0) || !T || !(L > 0)) return Emin;
    var best = Emin, kMax = Math.min(L + 1, T, cap > 0 ? cap : Infinity, Math.floor(S + 1e-9));
    for (var k = 1; k <= kMax; k++) { var v = Math.min(T, Math.floor((S - k) / size + 1e-9) + k); if (v > best) best = v; }
    return best;
  }

  // opts: {exclude: [location names], addPending: bool, openMax: max opened boxes per product (default 2)}
  // pend: null or Map product → [[POS base qty, order code], …] (ONLINE orders awaiting shipment: POS already deducted them)
  // orders: null or [{c, t (ms), base (POS base units), code}] (completed POS sales)
  function build(pos, master, tags, pend, opts, orders) {
    opts = opts || {};
    var excl = new Set((opts.exclude || DEFAULT_EXCLUDE).map(fold));
    var cap = opts.openMax > 0 ? Math.floor(opts.openMax) : OPEN_MAX, ordBy = null;
    if (orders) { ordBy = new Map(); orders.forEach(function (o) { var c = String(o.c); if (!ordBy.has(c)) ordBy.set(c, []); ordBy.get(c).push(o); }); }
    var codes = new Set();
    pos.forEach(function (p, c) { codes.add(c); });
    tags.forEach(function (t, c) { if (t.qs.length) codes.add(c); });
    var rows = [];
    codes.forEach(function (code) {
      var p = pos.get(code), t = tags.get(code), e = master.get(code);
      var name = (p && p.name) || (t && t.title) || '';
      var S = 0, lost = 0, locs = [];
      if (p) p.locs.forEach(function (q, l) { if (excl.has(fold(l))) lost += q; else { S += q; if (q) locs.push([l, q]); } });
      // pending ONLINE orders: add back unless NW already deducted the order for this product (its tag is no longer active)
      var pendQ = 0, pendNw = [];
      if (opts.addPending && pend && pend.get(code)) pend.get(code).forEach(function (x) { if (t && t.refs && t.refs.has(String(x[1]))) pendNw.push(x[1]); else pendQ += Number(x[0]) || 0; });
      pendQ = r3(pendQ);
      S = r3(S + pendQ);
      var T = t ? t.qs.length : 0;
      if (!T && !(S > 0)) return;
      var flags = [];
      if (NON_MERCH.test(name)) { rows.push({ code: code, name: name, cat: 'nonmerch', S: S, T: T, E: 0, Emax: 0, L: null, looseCodes: [], flags: ['Không phải hàng bán (voucher/tạp chí/tờ rơi…) → bỏ khỏi file'], locs: locs }); return; }
      if (pendNw.length) flags.push('Đơn ONLINE chờ giao đã trừ trên NW, không cộng lại: ' + Array.from(new Set(pendNw)).join(', '));
      var posBase = (p && p.base) || (t && t.base) || '';
      var nwBase = (t && t.base) || posBase;
      // POS base unit → NW base unit
      var factor = 1;
      if (fold(posBase) !== fold(nwBase)) {
        var a = rate(e && e.units, posBase), b = rate(e && e.units, nwBase);
        if (a && b) factor = a / b;
        else { var pb = p && rate(p.units, nwBase); if (pb) factor = 1 / pb; }
        flags.push('Đơn vị gốc POS (' + posBase + ') ≠ NW (' + nwBase + ')' + (factor !== 1 ? ', quy 1 ' + posBase + ' = ' + g(r3(factor)) + ' ' + nwBase : ', chưa quy được → để 1'));
      }
      // Quy đổi = master (đơn vị dán tem RFID + số đơn vị gốc POS trong 1 đơn vị đó); thiếu master thì đoán từ tên, có cờ
      var mr = e ? K.masterRatio(e, posBase) : null, mSrc;
      if (mr) mSrc = e.src;
      else { var f = K.ratioFor(name, posBase); mr = [f[0], f[1], (e ? 'master thiếu đơn vị in' : 'không có trong master') + '; quy đổi đoán từ tên' + (f[2] ? ': ' + f[2] : '') + ' → kiểm tra/bổ sung master']; mSrc = 'tên sản phẩm'; }
      var ratio = Number(mr[1]) > 0 ? Number(mr[1]) : 0;
      var row = { code: code, name: name, cat: T ? 'rfid' : 'manual', posBase: posBase, S: S, lost: r3(lost), pend: pendQ, locs: locs, T: T, flags: flags,
        unit: mr[0], ratio: ratio, mUnit: mr[0], mRatio: ratio, mSrc: mSrc, L: null, looseCodes: [] };
      if (mr[2]) flags.push(mr[2]);
      if (!ratio) flags.push('Chưa có quy đổi → không tính được Dự kiến, cần bổ sung master');
      // 'Master là chuẩn, mã lệch để riêng' (user 19/11): a product whose conversion is not settled stays OUT of the import
      var hold = [];
      if (mSrc === 'tên sản phẩm') hold.push('chưa có quy đổi trong master');
      if (!ratio) hold.push('không có quy đổi');
      // THE formula
      row.E = S > 0 && ratio > 0 ? Math.ceil(r3(S / ratio) - 1e-9) : 0;
      row.Emax = row.E;
      // NW tags: checks only
      row.Q = 0; row.qs = []; row.sizes = [];
      if (T) {
        var qs = t.qs; row.qs = qs; row.Q = r3(qs.reduce(function (s, x) { return s + x; }, 0));
        row.sizes = Array.from(t.sizes.keys()).sort(function (x, y) { return y - x; });
        var sizePos = row.sizes.map(function (x) { return r3(x / factor); });
        if (!(S > 0)) flags.push('POS hết hàng nhưng NW còn ' + T + ' thẻ (bán/chuyển chưa trừ NW, hoặc POS lệch)');
        else if (T > row.E) flags.push('NW có ' + T + ' thẻ, nhiều hơn dự kiến ' + (T - row.E) + ' thẻ (đã bán/chuyển chưa trừ NW?)');
        if (t.fup && fold(t.fup) !== fold(mr[0])) { flags.push('Đơn vị in trên NW (' + t.fup + ') ≠ đơn vị dán tem master (' + mr[0] + ')'); hold.push('đơn vị in trên NW ≠ master'); }
        if (ratio && sizePos.some(function (x) { return Math.abs(x - ratio) > 1e-6; })) hold.push('cỡ thẻ NW ' + sizePos.map(function (x) { return g(x); }).join(' / ') + ' ≠ master ' + g(ratio) + ' ' + posBase + '/' + mr[0]);
        if (ratio && sizePos.some(function (x) { return Math.abs(x - ratio) > 1e-6; })) flags.push('Cỡ thẻ NW ' + sizePos.map(function (x) { return g(x); }).join(' / ') + ' ' + posBase + ' ≠ quy đổi ' + g(ratio) + ' ' + posBase + '/' + mr[0] + ' (NW ghi sai SL thẻ hoặc master sai)');
      }
      row.hold = T ? hold.join('; ') : '';
      if (row.hold) flags.unshift('QUY ĐỔI LỆCH → chưa đưa vào file import: ' + row.hold + '. Sửa master (tab Adhoc) theo cách tem đang dán, hoặc sửa SL thẻ trên NW, rồi tạo lại file');
      // tags still to attach before the count: expected minus active NW tags
      row.M = Math.max(0, row.E - T); row.Enew = T ? row.M : 0;
      row.U = r3(Math.max(0, S - T * ratio));
      if (T && row.M > 0) flags.push('NW mới có ' + T + ' thẻ, dự kiến ' + row.E + ' → cần gắn thêm ' + row.M + ' tem + nhập NW trước khi kiểm, nếu không phiên sẽ báo thiếu');
      if (/\[\s*tr[uù]ng m[aã]\s*\]/i.test(name)) flags.push('[Trùng mã]');
      if (pendQ) flags.push('Đã cộng ' + g(pendQ) + ' ' + posBase + ' của đơn ONLINE chờ giao');
      if (lost) flags.push('Kho thất lạc ' + g(r3(lost)) + ' (không tính)');
      rows.push(row);
    });
    rows.sort(function (a, b) { return (a.code < b.code ? -1 : a.code > b.code ? 1 : 0); });
    var sum = { products: rows.length, rfid: 0, manual: 0, nonmerch: 0, imp: 0, impE: 0, hold: 0, holdE: 0, T: 0, E: 0, Emax: 0, looseSp: 0, loose: false, openMax: cap, over: 0, overSp: 0, Mrows: 0, M: 0, flagged: 0 };
    rows.forEach(function (r) {
      sum[r.cat]++;
      if (r.cat === 'rfid') { if (r.hold) { sum.hold++; sum.holdE += r.E; } else { sum.imp++; sum.impE += r.E; } }
      if (r.cat === 'rfid') { sum.T += r.T; sum.E += r.E; sum.Emax += r.Emax; if (r.Emax > r.E) sum.looseSp++; if (r.T > r.Emax) { sum.over += r.T - r.Emax; sum.overSp++; } }
      if (r.cat !== 'nonmerch' && r.M > 0) { sum.Mrows++; sum.M += r.M; }
      if (r.flags.length) sum.flagged++;
    });
    return { rows: rows, sum: sum };
  }

  // --- CSV ---------------------------------------------------------------------------------------
  function csvField(v) { var s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function toCsv(rows) { return '﻿' + rows.map(function (r) { return r.map(csvField).join(','); }).join('\r\n') + '\r\n'; }
  function locText(locs) { return locs.slice().sort(function (a, b) { return b[1] - a[1]; }).map(function (l) { return (l[0] || '(trống)') + ':' + num(r3(l[1])); }).join(', '); }
  function importCsv(res) {
    return toCsv([['Mã', 'Tên sản phẩm', 'Đơn vị RFID', 'Quy đổi', 'Tồn kho', 'Dự kiến']].concat(
      res.rows.filter(function (r) { return r.cat === 'rfid' && !r.hold; }).map(function (r) { return [r.code, r.name, r.unit, num(r.ratio), num(r.S), r.E]; })));
  }
  // products held out of the import because master and the real NW tags disagree (or master is missing)
  function holdCsv(res) {
    return toCsv([['Mã', 'Tên sản phẩm', 'Tồn POS', 'Đơn vị gốc', 'Đơn vị dán tem (master)', 'Quy đổi (master)', 'Nguồn quy đổi', 'Dự kiến theo master', 'Thẻ NW active', 'Cỡ thẻ đã nhập NW', 'Vì sao lệch', 'Vị trí POS']].concat(
      res.rows.filter(function (r) { return r.cat === 'rfid' && r.hold; }).map(function (r) { return [r.code, r.name, num(r.S), r.posBase, r.unit, num(r.ratio), r.mSrc, r.E, r.T, (r.sizes || []).map(num).join(' / '), r.hold, locText(r.locs || [])]; })));
  }
  function manualCsv(res) {
    return toCsv([['Mã', 'Tên sản phẩm', 'Đơn vị đếm', 'Quy đổi', 'Đơn vị tồn POS', 'Tồn POS', 'Đã có thẻ NW (thẻ)', 'Chưa có thẻ (đơn vị tồn)', 'Cần gắn tem', 'Vị trí POS', 'Ghi chú']].concat(
      res.rows.filter(function (r) { return r.cat !== 'nonmerch' && r.M > 0; }).map(function (r) {
        return [r.code, r.name, r.mUnit, num(r.mRatio), r.posBase, num(r.S), r.T, num(r.U), r.M, locText(r.locs), r.cat === 'manual' ? (r.flags.join(' | ')) : ''];
      })));
  }
  function checkCsv(res) {
    return toCsv([['Mã', 'Tên sản phẩm', 'Nhóm', 'Đơn vị tồn POS', 'Tồn POS (đã trừ Kho thất lạc)', 'Đơn ONLINE chờ giao đã cộng', 'Thẻ NW active', 'Tổng SL trên thẻ', 'Cỡ thẻ (base)', 'Đơn vị RFID', 'Quy đổi', 'Dự kiến quét (E)', 'Trong E: thẻ chưa có trên NW', 'Dự kiến tối đa (có hộp lẻ)', 'Đơn bán lẻ từ khi gắn thẻ', 'Ví dụ đơn bán lẻ', 'Thẻ NW dư so với POS', 'Chưa có thẻ', 'Cần gắn tem', 'Đơn vị master', 'Quy đổi master', 'Nguồn quy đổi', 'Vị trí POS', 'Cần kiểm tra']].concat(
      res.rows.map(function (r) {
        var cat = r.cat === 'rfid' ? 'Có thẻ' : r.cat === 'manual' ? 'Chưa có thẻ' : 'Bỏ (không phải hàng bán)';
        var rf = r.cat === 'rfid', em = r.Emax != null ? r.Emax : r.E;
        return [r.code, r.name, cat, r.posBase || '', num(r.S), r.pend ? num(r.pend) : '', r.T, rf ? num(r.Q) : '', (r.sizes || []).map(num).join('/'), r.unit || '', r.ratio != null ? num(r.ratio) : '', r.E, rf && r.Enew ? r.Enew : '', rf ? em : '', r.L != null ? r.L : '', (r.looseCodes || []).join(' '), rf && r.T > em ? r.T - em : '', r.U ? num(r.U) : '', r.M || '', r.mUnit || '', r.mRatio != null ? num(r.mRatio) : '', r.mSrc || '', locText(r.locs || []), r.flags.join(' | ')];
      })));
  }

  // --- reconcile an exported NW session (Kiểm kê / Kiểm đếm .xlsx) against the last build -----------
  var ROLL = /^(A51A1B5156F8D|B51A1B510CC55|E28069150000[45]0|E280F302)/;
  function session(wb, res) {
    function obj(n) { var ws = wb.Sheets[n]; return ws ? XLSX.utils.sheet_to_json(ws, { defval: '' }) : null; }
    var L = obj('Danh sách kiểm kê'), D = obj('Chi tiết quét') || [], ST = obj('Thẻ lạ') || [];
    if (!L) throw new Error("File không có sheet 'Danh sách kiểm kê' (hãy xuất phiên từ Nextwaves dạng Excel).");
    var by = new Map(); res.rows.forEach(function (r) { by.set(r.code, r); });
    var sc = new Map();
    D.forEach(function (r) { if (String(r['Trạng thái']) === 'Đã quét') { var c = String(r['Mã SP']).replace(/^CIRCA-/, ''); sc.set(c, (sc.get(c) || 0) + 1); } });
    var out = [], A = { T: 0, sc: 0, miss: 0, E: 0, scE: 0, sp: 0, okNW: 0, okPOS: 0, okLoose: 0, okLooseTags: 0, over: 0, overSp: 0, notInBuild: 0, loose: !!res.sum.loose };
    L.forEach(function (r) {
      var c = String(r['Mã SP']).replace(/^CIRCA-/, '');
      var miss = String(r['EPC chưa quét (có thể thiếu)'] || '').split(/,\s*/).filter(Boolean);
      var s = sc.get(c) || 0, T = s + miss.length;
      if (!T) return;
      var b = by.get(c);
      if (!b) A.notInBuild++;
      // expected = the build's Dự kiến (⌈tồn POS ÷ quy đổi⌉), same number the import file carried
      var E = b && b.cat !== 'nonmerch' ? b.E : 0, Em = E;
      A.T += T; A.sc += s; A.miss += miss.length; A.E += E; A.scE += Math.min(s, E); A.sp++;
      if (!miss.length) A.okNW++;
      if (s >= E) A.okPOS++;
      if (s > E && s <= Em) { A.okLoose++; A.okLooseTags += s - E; }
      if (s > Em) { A.over += s - Em; A.overSp++; }
      var hint = s < E ? 'Thiếu so với POS: tìm thẻ / hàng' : s > Em ? 'Dư so với POS: kiểm tra số nhập NW hoặc tồn POS' : s > E ? 'Khớp nhờ hộp lẻ: dồn hộp lẻ rồi cập nhật số lượng thẻ trên NW' : '';
      if (miss.length || s !== E) out.push({ code: c, name: r['Tên sản phẩm'], T: T, sc: s, miss: miss.length, E: E, Emax: Em, L: b && b.L != null ? b.L : '', shortPOS: Math.max(0, E - s), overPOS: Math.max(0, s - Em), S: b ? b.S : '', posBase: b ? b.posBase : '', locs: b ? locText(b.locs || []) : '', epcs: miss.join(' '), hint: hint, looseCodes: b ? (b.looseCodes || []).join(' ') : '' });
    });
    var strange = {};
    ST.forEach(function (r) {
      var e = String(r.EPC), why = String(r['Lý do'] || ''), k;
      if (/^\d{13}[A-Z]/.test(e)) k = 'EPC mang dạng UID (ghi tem lỗi)';
      else if (e.length < 24) k = 'EPC ngắn/không chuẩn (tem lạ)';
      else if (/chưa đăng ký/i.test(why) && ROLL.test(e)) k = 'Dải tem Circa chưa nhập kho NW (tem in dư / chưa stock-in)';
      else k = why || 'khác';
      strange[k] = (strange[k] || 0) + 1;
    });
    out.sort(function (a, b) { return b.shortPOS - a.shortPOS || b.miss - a.miss; });
    return { sum: A, rows: out, strange: Object.entries(strange).sort(function (a, b) { return b[1] - a[1]; }) };
  }
  function sessionCsv(rep) {
    return toCsv([['Mã', 'Tên sản phẩm', 'Thẻ NW (phiên)', 'Đã quét', 'Thiếu theo NW', 'Dự kiến theo POS (E)', 'Dự kiến tối đa (hộp lẻ)', 'Đơn bán lẻ', 'Thiếu theo POS', 'Quét dư (vượt tối đa)', 'Gợi ý', 'Tồn POS', 'Đơn vị', 'Vị trí POS', 'Ví dụ đơn bán lẻ', 'EPC chưa quét']].concat(
      rep.rows.map(function (r) { return [r.code, r.name, r.T, r.sc, r.miss, r.E, r.Emax, r.L, r.shortPOS, r.overPOS, r.hint, num(r.S), r.posBase, r.locs, r.looseCodes, r.epcs]; })));
  }

  return { OPEN_MAX: OPEN_MAX, posFromApi: posFromApi, posFromXlsx: posFromXlsx, locations: locations, tagsFromLedger: tagsFromLedger, cover: cover, need: need, emax: emax, build: build, importCsv: importCsv, holdCsv: holdCsv, manualCsv: manualCsv, checkCsv: checkCsv, session: session, sessionCsv: sessionCsv };
})();
