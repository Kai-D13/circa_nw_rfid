// Worker message handler (after SheetJS + KiemDem + KD2).
var W = { master: null, pos: null, tags: null, pend: null, orders: null, res: null };
function masterInfo() { var adhoc = 0; W.master.forEach(function (e) { if (e.src === 'Adhoc') adhoc++; }); return { size: W.master.size, adhoc: adhoc }; }
function posInfo() { return { products: W.pos.size, locations: KD2.locations(W.pos) }; }
self.onmessage = function (ev) {
  var d = ev.data, out;
  try {
    if (d.type === 'masterCsv') {
      var wb = XLSX.utils.book_new();
      [['final data v4', d.v4], ['Adhoc', d.adhoc]].forEach(function (x) {
        if (!x[1]) return;
        var w = XLSX.read(x[1], { type: 'string', raw: true, dense: true });
        XLSX.utils.book_append_sheet(wb, w.Sheets[w.SheetNames[0]], x[0]);
      });
      W.master = KiemDem.loadMaster(wb); out = masterInfo();
    } else if (d.type === 'masterXlsx') {
      W.master = KiemDem.loadMaster(XLSX.read(d.buf, { type: 'array', sheets: ['final data v4', 'Adhoc'], dense: true })); out = masterInfo();
    } else if (d.type === 'posApi') {
      W.pos = KD2.posFromApi(d.rows); out = posInfo();
    } else if (d.type === 'posXlsx') {
      var sw = XLSX.read(d.buf, { type: 'array', dense: true });
      if (sw.SheetNames.indexOf('final data v4') >= 0) throw new Error('Đây là file master data, hãy chọn ở ô Master.');
      W.pos = KD2.posFromXlsx(sw); out = posInfo();
    } else if (d.type === 'tags') {
      W.tags = KD2.tagsFromLedger(d.rows);
      var sp = 0, n = 0; W.tags.forEach(function (t) { if (t.qs.length) { sp++; n += t.qs.length; } });
      out = { products: sp, tags: n };
    } else if (d.type === 'noTags') {
      W.tags = new Map(); out = { products: 0, tags: 0 };
    } else if (d.type === 'reset') {
      // new run: drop everything but the master (the page caches it by key)
      W.pos = W.tags = W.pend = W.orders = W.res = null; out = {};
    } else if (d.type === 'pend') {
      // items: [[product id, POS base qty, order code], …]
      W.pend = new Map();
      (d.items || []).forEach(function (x) { var c = String(x[0]); if (!W.pend.has(c)) W.pend.set(c, []); W.pend.get(c).push([Number(x[1]) || 0, String(x[2] || '')]); });
      out = { products: W.pend.size };
    } else if (d.type === 'orders') {
      W.orders = d.rows; out = { lines: d.rows ? d.rows.length : 0 };
    } else if (d.type === 'build') {
      if (!W.pos || !W.master) throw new Error('Chưa có đủ tồn POS và master.');
      W.res = KD2.build(W.pos, W.master, W.tags || new Map(), W.pend, d.opts, W.orders);
      out = {
        sum: W.res.sum,
        rows: W.res.rows.map(function (r) { return { code: r.code, name: r.name, cat: r.cat, S: r.S, posBase: r.posBase || '', T: r.T, E: r.E, Emax: r.Emax != null ? r.Emax : r.E, L: r.L, unit: r.unit || '', ratio: r.ratio, M: r.M || 0, mUnit: r.mUnit || '', mSrc: r.mSrc || '', hold: r.hold || '', sizes: r.sizes || [], U: r.U || 0, flags: r.flags }; }),
        imp: KD2.importCsv(W.res), hold: KD2.holdCsv(W.res), man: KD2.manualCsv(W.res), chk: KD2.checkCsv(W.res),
      };
    } else if (d.type === 'session') {
      if (!W.res) throw new Error('Hãy tạo file kiểm đếm trước (bước Kéo dữ liệu), rồi mới đối soát phiên.');
      var rep = KD2.session(XLSX.read(d.buf, { type: 'array', dense: true }), W.res);
      out = { sum: rep.sum, rows: rep.rows, strange: rep.strange, csv: KD2.sessionCsv(rep) };
    }
    out.id = d.id;
    self.postMessage(out);
  } catch (e) {
    self.postMessage({ id: d.id, error: (e && e.message) || String(e) });
  }
};
