// Build Kiểm đếm files with the improved logic (v2), reusing the tool's own KiemDem code.
// node kd/build-kd.js <stock.xlsx> <master.xlsx> <nw-tags.json> <outPrefix>
const fs = require("fs");
const { XLSX, KiemDem } = require("./load-tool.js");
const [stockF, masterF, nwF, outPrefix] = process.argv.slice(2);
const fold = KiemDem.fold, g = KiemDem.g;
const SAME = { tube: "tuyp", tuyp: "tube", lo: "hu", hu: "lo" };
const sameUnit = (a, b) => fold(a) === fold(b) || SAME[fold(a)] === fold(b);
const NON_MERCH = /phi[eế]u mua h[aà]ng|t[aạ]p ch[ií]|t[oờ] r[oơ]i|l[oồ]ng [dđ][eè]n|voucher/i;
const EXCLUDE_LOC = new Set(["kho that lac"]);

// 1) master + stock (tool code)
const mw = XLSX.read(fs.readFileSync(masterF), { type: "buffer", sheets: ["final data v4", "Adhoc"], dense: true });
if (!mw.Sheets["Adhoc"]) console.warn("CẢNH BÁO: master không có sheet Adhoc");
const master = KiemDem.loadMaster(mw);
const stock = KiemDem.readStock(XLSX.read(fs.readFileSync(stockF), { type: "buffer", dense: true }));
const locNames = stock.locations.map((l) => l[0]);
const keep = new Set(locNames.filter((n) => !EXCLUDE_LOC.has(fold(n))));
const res = KiemDem.build(stock, master, keep);
const baseline = KiemDem.build(stock, master, new Set(locNames.filter((n) => fold(n) === "general")));

// per-code stock by special locations
const c = stock.cols, special = {};
for (let i = 1; i < stock.table.length; i++) {
  const r = stock.table[i], code = String(r[c.code]).trim(); if (!code) continue;
  const l = fold(r[c.loc]); const q = Number(String(r[c.qty]).replace(/,/g, "")) || 0;
  const s = (special[code] ||= { catLieu: 0, thatLac: 0, shelf: 0 });
  if (l === "kho cat lieu") s.catLieu += q; else if (l === "kho that lac") s.thatLac += q; else if (l !== "general") s.shelf += q;
}

// 2) NW tags
const nwData = JSON.parse(fs.readFileSync(nwF, "utf8"));
const nw = Object.fromEntries(nwData.products.filter((p) => p.tags > 0).map((p) => [p.circa, p]));
const modeSize = (sizes) => Number(Object.entries(sizes).sort((a, b) => b[1] - a[1] || Number(b[0]) - Number(a[0]))[0][0]);

// label for a tag size, from the master's unit list (rates are relative to a common base)
function labelFor(code, stockUnit, size) {
  const e = master.get(code); if (!e) return null;
  let su = e.units.get(fold(stockUnit)); if (!su && SAME[fold(stockUnit)]) su = e.units.get(SAME[fold(stockUnit)]);
  if (!su) return null;
  for (const [, [u, rate]] of e.units) if (Math.abs(rate / su[1] - size) < 1e-6) return u;
  return null;
}

const tagged = [], untagged = [], excluded = [], check = [];
const seen = new Set();
for (const r of res.rows) {
  seen.add(r.code);
  const p = nw[r.code], sp = special[r.code] || {};
  const notes = []; if (r.note) notes.push(r.note);
  if (/\[tr[uù]ng m[aã]\]/i.test(r.name)) notes.push("mã có chữ [Trùng mã]");
  let unit = r.unit, ratio = r.ratio, src = r.src, trueExp = null;
  const untaggedQty = p ? Math.max(0, Math.round((r.stock - p.qty) * 1000) / 1000) : r.stock;
  if (p) {
    if (!sameUnit(p.baseUnit, r.stockUnit)) notes.push(`đơn vị cơ sở NW (${p.baseUnit}) ≠ đơn vị lưu kho POS (${r.stockUnit}), giữ quy đổi master`);
    else {
      const size = modeSize(p.sizes), multi = Object.keys(p.sizes).length > 1;
      if (multi) notes.push("thẻ nhiều cỡ trên NW: " + Object.entries(p.sizes).map(([s, n]) => `${n} thẻ × ${g(Number(s))} ${r.stockUnit}`).join(", "));
      // expected tags = active tags + untagged remainder in the unit the store actually tags (when NW covers ≥50% of POS), else master unit
      const qRem = r.stock > 0 && p.qty / r.stock >= 0.5 ? size : r.ratio;
      trueExp = p.tags + (qRem > 0 ? Math.ceil(untaggedQty / qRem) : 0);
      // pick the Quy đổi whose app result max(ceil(stock/q), tags) is closest to trueExp; tie → master
      const cands = [r.ratio, ...Object.keys(p.sizes).map(Number).sort((a, b) => (p.sizes[b] || 0) - (p.sizes[a] || 0))];
      let best = r.ratio, bestD = Infinity;
      for (const q of cands) { if (!(q > 0)) continue; const d = Math.abs(Math.max(Math.ceil(r.stock / q), p.tags) - trueExp); if (d < bestD - 1e-9) { best = q; bestD = d; } }
      if (Math.abs(best - r.ratio) > 1e-6) {
        const lab = labelFor(r.code, r.stockUnit, best) || (best === 1 ? r.stockUnit : `thẻ ${g(best)} ${r.stockUnit}`);
        notes.push(`quy đổi theo thẻ NW: 1 ${lab} = ${g(best)} ${r.stockUnit} (master: 1 ${r.unit} = ${g(r.ratio)} ${r.stockUnit})`);
        unit = lab; ratio = best; src = "thẻ NW";
      } else if (src === "tên sản phẩm") src = "tên sản phẩm (khớp thẻ NW)";
    }
  }
  const units = ratio > 0 ? Math.ceil(r.stock / ratio) : 0;
  const tags = p ? p.tags : 0, appExp = Math.max(units, tags);
  if (p && tags > units) notes.push(`NW có ${tags} thẻ nhưng tồn POS ${g(r.stock)} ${r.stockUnit} chỉ đủ ${units} ${unit}: thẻ dư, có thể đã bán chưa trừ trên NW hoặc hộp đã mở`);
  if (trueExp !== null && appExp !== trueExp) notes.push(`app sẽ tính dự kiến ${appExp}; theo thẻ đang có + phần chưa gắn thẻ nên là ${trueExp}`);
  const row = { code: r.code, name: r.name, unit, ratio, stockUnit: r.stockUnit, stock: r.stock, units, tags, nwQty: p ? p.qty : 0, appExp, trueExp: trueExp ?? "", untaggedQty, src, masterUnit: r.unit, masterRatio: r.ratio, catLieu: sp.catLieu || 0, shelf: sp.shelf || 0, thatLac: sp.thatLac || 0 };
  if (tags) { row.group = "Đã gắn thẻ"; tagged.push(row); }
  else if (NON_MERCH.test(r.name)) { row.group = "Loại bỏ (không phải hàng hoá)"; excluded.push(row); }
  else { row.group = "Chưa gắn thẻ"; untagged.push(row); }
  row.notes = notes.join("; ");
  check.push(row);
}
// NW-only products (active tags, no POS stock outside Kho thất lạc)
for (const p of Object.values(nw)) {
  if (seen.has(p.circa)) continue;
  const sp = special[p.circa] || {};
  const size = modeSize(p.sizes);
  const numeric = /^\d+$/.test(p.circa);
  const lab = (numeric && labelFor(p.circa, p.baseUnit, size)) || (size === 1 ? p.baseUnit : `thẻ ${g(size)} ${p.baseUnit}`);
  const row = { code: p.circa, name: p.title, unit: lab, ratio: size, stockUnit: p.baseUnit, stock: 0, units: 0, tags: p.tags, nwQty: p.qty, appExp: p.tags, trueExp: p.tags, untaggedQty: 0, src: "thẻ NW", masterUnit: "", masterRatio: "", catLieu: 0, shelf: 0, thatLac: sp.thatLac || 0,
    group: numeric ? "Chỉ có trên NW (POS tồn 0)" : "Chỉ có trên NW, không có mã Circa",
    notes: (sp.thatLac ? `POS chỉ còn ${sp.thatLac} ${p.baseUnit} ở Kho thất lạc; ` : "") + `NW còn ${p.tags} thẻ / ${p.qty} ${p.baseUnit} nhưng POS tồn 0: kiểm xem đã bán chưa trừ hay hàng còn trên kệ` + (numeric ? "" : "; sản phẩm NW không có mã Circa nên không đưa vào file import") };
  if (numeric) tagged.push(row);
  check.push(row);
}

// 3) write files
const q = (v) => { const s = String(v ?? ""); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csv = (rows) => "﻿" + rows.map((r) => r.map(q).join(",")).join("\r\n") + "\r\n";
const importRows = (list) => [["Mã", "Tên sản phẩm", "Đơn vị RFID", "Quy đổi", "Tồn kho", "Dự kiến"]].concat(list.map((r) => [r.code, r.name, r.unit, g(r.ratio), String(r.stock), ""]));
fs.writeFileSync(outPrefix + "-da-gan-the.csv", csv(importRows(tagged)));
fs.writeFileSync(outPrefix + "-chua-gan-the.csv", csv(importRows(untagged)));
const order = { "Đã gắn thẻ": 0, "Chỉ có trên NW (POS tồn 0)": 1, "Chỉ có trên NW, không có mã Circa": 2, "Chưa gắn thẻ": 3, "Loại bỏ (không phải hàng hoá)": 4 };
check.sort((a, b) => order[a.group] - order[b.group] || (b.notes ? 1 : 0) - (a.notes ? 1 : 0) || (b.appExp - b.tags) - (a.appExp - a.tags));
fs.writeFileSync(outPrefix + "-kiem-tra.csv", csv([["Mã", "Tên sản phẩm", "Nhóm", "Đơn vị RFID", "Quy đổi", "Nguồn quy đổi", "Đơn vị master", "Quy đổi master", "Đơn vị lưu kho", "Tồn kho (trừ Kho thất lạc)", "Trong đó Kho cắt liều", "Trong đó ở vị trí kệ", "Kho thất lạc (không tính)", "Dự kiến theo tồn", "Thẻ NW active", "Tồn NW (đv cơ sở)", "Tồn POS chưa có thẻ (đv cơ sở)", "Dự kiến app = max", "Dự kiến đúng (thẻ + chưa gắn)", "Chênh dự kiến app − thẻ", "Cần kiểm tra"]]
  .concat(check.map((r) => [r.code, r.name, r.group, r.unit, g(r.ratio), r.src, r.masterUnit, r.masterRatio === "" ? "" : g(r.masterRatio), r.stockUnit, r.stock, r.catLieu, r.shelf, r.thatLac, r.units, r.tags, r.nwQty, r.untaggedQty ?? "", r.appExp, r.trueExp ?? "", r.appExp - r.tags, r.notes]))));

// 4) summary
const S = (l) => ({ sp: l.length, duKien: l.reduce((s, r) => s + r.appExp, 0), the: l.reduce((s, r) => s + r.tags, 0) });
const tg = tagged.filter((r) => r.group === "Đã gắn thẻ");
const conv = tg.filter((r) => r.src === "thẻ NW").length, multi = tg.filter((r) => /nhiều cỡ/.test(r.notes)).length;
console.log(JSON.stringify({
  nwLatest: nwData.latest, locations: locNames.length, excludedLoc: locNames.filter((n) => !keep.has(n)),
  baselineTool: { sp: baseline.rows.length, units: baseline.totalUnits, flagged: baseline.flagged.length },
  v2AllLocations: { sp: res.rows.length, units: res.totalUnits },
  tagged: S(tg), nwOnly: S(tagged.filter((r) => r.group !== "Đã gắn thẻ")), untagged: S(untagged), excluded: excluded.map((r) => r.code + " " + r.name),
  convFromNW: conv, multiSize: multi,
  taggedMatch: tg.filter((r) => r.units === r.tags).length, taggedFewer: tg.filter((r) => r.units > r.tags).length, taggedFewerUnits: tg.reduce((s, r) => s + Math.max(0, r.units - r.tags), 0), taggedMore: tg.filter((r) => r.units < r.tags).length, taggedMoreUnits: tg.reduce((s, r) => s + Math.max(0, r.tags - r.units), 0),
  flaggedRows: check.filter((r) => r.notes).length,
  appVsTrue: tg.filter((r) => r.trueExp !== "" && r.appExp !== r.trueExp).length,
  nwAbovePos: tg.filter((r) => r.nwQty > r.stock + 1e-6).length,
  sumTrueExp: tg.reduce((s, r) => s + (r.trueExp === "" ? r.appExp : r.trueExp), 0),
}, null, 1));
