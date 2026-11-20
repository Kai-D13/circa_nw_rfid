// Kiểm đếm file for a product list: import CSV + check workbook. Offline (uses the pulls saved by v2/r2.js). READ-ONLY.
// Rule (19/11): Dự kiến = ⌈tồn POS ÷ quy đổi master⌉. Master là chuẩn; SP có cỡ thẻ NW ≠ master (hoặc thiếu master) để riêng, không vào import.
// usage: node r2-out.js <r2 dir (build-pos.json, pos-rows.json)> <codes.json> <out dir> [old import.csv to compare]
const fs = require("fs"), path = require("path");
const { XLSX } = require("./load-tool.js");
const [R2, codesF, DL, oldF] = process.argv.slice(2);
const codes = JSON.parse(fs.readFileSync(codesF, "utf8")).map(String);
const B = JSON.parse(fs.readFileSync(path.join(R2, "build-pos.json"), "utf8")), by = new Map(B.rows.map((r) => [String(r.code), r]));
const P = JSON.parse(fs.readFileSync(path.join(R2, "pos-rows.json"), "utf8"));
const at = new Date(Date.parse(P.at) + 7 * 3600e3), stamp = at.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-"), atTxt = at.toISOString().slice(0, 16).replace("T", " ");
const parseCsv = (t) => t.replace(/^﻿/, "").split(/\r?\n/).filter(Boolean).map((l) => { const o = []; let cur = "", q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ",") { o.push(cur); cur = ""; } else cur += ch; } o.push(cur); return o; });
const old = new Map(); if (oldF) for (const r of parseCsv(fs.readFileSync(oldF, "utf8")).slice(1)) old.set(r[0], { unit: r[2], ratio: Number(r[3]), S: Number(r[4]), E: Number(r[5]) });
const LG = fs.existsSync(path.join(R2, "nw-ledger-raw.json")) ? JSON.parse(fs.readFileSync(path.join(R2, "nw-ledger-raw.json"), "utf8")) : [];
const szBy = new Map(); for (const r of LG) if (r.q > 0 && /stock_in|pack_in|transfer/.test(r.t) && (r.epcs || []).length) { const m = szBy.get(r.c) || new Map(), z = Math.round((r.q / r.epcs.length) * 1000) / 1000; m.set(z, (m.get(z) || 0) + r.epcs.length); szBy.set(r.c, m); }
const sizeTxt = (c) => [...(szBy.get(c) || new Map()).entries()].sort((a, b) => b[1] - a[1]).map(([z, n]) => `${n} thẻ × ${z}`).join(" + ");
const locTxt = (r) => (r.locs || []).slice().sort((a, b) => b[1] - a[1]).map((l) => `${l[0] || "(trống)"}:${l[1]}`).join(", ");
const CONV = /Cỡ thẻ NW|đoán từ tên|Chưa có quy đổi|Đơn vị in trên NW|master không có/;
const rows = [], tag = [], conv = [], diff = [], none = [];
for (const c of codes) {
  const r = by.get(c);
  if (!r) { none.push([c, "Không có tồn POS và không có thẻ NW"]); continue; }
  const imp = r.cat === "rfid" && !r.hold, sizes = sizeTxt(c), fl = r.flags || [];
  rows.push([c, r.name, r.S, r.posBase, r.unit, r.ratio, r.mSrc, r.E, imp ? "Có" : r.hold ? "Không (quy đổi lệch)" : "Không (chưa có thẻ NW)", r.T, r.M || "", r.T > r.E ? r.T - r.E : "", sizes, locTxt(r), fl.join(" | ")]);
  if (r.M > 0) tag.push([c, r.name, r.S, r.posBase, r.unit, r.ratio, r.E, r.T, r.M, locTxt(r)]);
  if (r.hold) conv.push([c, r.name, r.S, r.posBase, r.unit, r.ratio, r.mSrc, sizes, r.E, r.T, r.hold, locTxt(r)]);
  const o = old.get(c);
  if (o && (o.E !== r.E || o.ratio !== r.ratio || o.S !== r.S)) diff.push([c, r.name, o.S, r.S, o.unit + " = " + o.ratio, r.unit + " = " + r.ratio, o.E, r.E, r.E - o.E,
    o.ratio !== r.ratio ? "Quy đổi cũ lấy theo cỡ thẻ NW, nay theo master" : o.S !== r.S && Math.ceil(o.S / r.ratio - 1e-9) === o.E ? "Tồn POS thay đổi" : "Cách tính cũ cộng dồn SL ghi trên từng thẻ NW"]);
}
const impRows = rows.filter((r) => r[8] === "Có");
const csv = "﻿" + [["Mã", "Tên sản phẩm", "Đơn vị RFID", "Quy đổi", "Tồn kho", "Dự kiến"], ...impRows.map((r) => [r[0], r[1], r[4], r[5], r[2], r[7]])].map((r) => r.map((v) => { const s = String(v == null ? "" : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(",")).join("\r\n") + "\r\n";
const PFX = process.env.PREFIX || "kiem-dem-lumina-R2", impName = `${PFX}-${stamp}.csv`, chkName = `${PFX}-${stamp}-kiem-tra.xlsx`;
fs.writeFileSync(path.join(DL, impName), csv);
const wb = XLSX.utils.book_new();
const add = (n, aoa, w) => { const ws = XLSX.utils.aoa_to_sheet(aoa); ws["!cols"] = w.map((x) => ({ wch: x })); if (aoa.length > 1) ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: aoa[0].length - 1 } }) }; XLSX.utils.book_append_sheet(wb, ws, n); };
const sumE = impRows.reduce((s, r) => s + r[7], 0);
add("Tóm tắt", [["Mục", "Giá trị", "Ghi chú"],
  ["Công thức", "Dự kiến = ⌈Tồn POS ÷ Quy đổi⌉", "Quy đổi = số đơn vị gốc POS trong 1 đơn vị dán tem RFID, theo master (final_unit_print). VD 82278: 215 viên ÷ 20 viên/hộp → 11"],
  ["Tồn POS lấy lúc", atTxt, "Cộng mọi dòng seller + mọi vị trí, bỏ Kho thất lạc; KHÔNG cộng đơn online chờ giao"],
  ["Mã trong danh sách", codes.length, ""], ["Vào file import (đã có thẻ NW)", impRows.length, `Σ Dự kiến ${sumE} thẻ`],
  ["Quy đổi lệch → để riêng, KHÔNG vào import", conv.length + " SP", "Cỡ thẻ đã nhập NW ≠ master, hoặc thiếu master. Sửa master (tab Adhoc) theo cách tem đang dán, hoặc sửa SL thẻ NW, rồi tạo lại file"],
  ["Chưa có thẻ NW (không vào import)", rows.filter((r) => r[8] === "Không (chưa có thẻ NW)").length, "RFID không quét được → gắn tem trước, hoặc đếm tay"], ["Không có tồn POS lẫn thẻ NW", none.length, none.map((r) => r[0]).join(", ")],
  ["Cần gắn thêm tem trước khi kiểm", tag.length + " SP", tag.reduce((s, r) => s + r[8], 0) + " tem (Dự kiến − thẻ NW active)"],
  ...(oldF ? [["Khác file cũ " + path.basename(oldF), diff.length + " SP", ""]] : [])], [34, 22, 90]);
add("Dự kiến", [["Mã", "Tên sản phẩm", "Tồn POS", "Đơn vị gốc", "Đơn vị dán tem", "Quy đổi", "Nguồn quy đổi", "Dự kiến = ⌈Tồn÷Quy đổi⌉", "Vào file import", "Thẻ NW active", "Cần gắn thêm tem", "NW dư thẻ", "Thẻ đã nhập NW (số thẻ × SL/thẻ)", "Vị trí POS", "Cảnh báo"], ...rows], [9, 44, 9, 8, 9, 7, 12, 10, 10, 8, 9, 8, 10, 30, 80]);
add("Gắn tem trước khi kiểm", [["Mã", "Tên sản phẩm", "Tồn POS", "Đơn vị gốc", "Đơn vị dán tem", "Quy đổi", "Dự kiến", "Thẻ NW active", "Cần gắn thêm", "Vị trí POS"], ...tag], [9, 44, 9, 8, 9, 7, 8, 8, 9, 30]);
add("Quy đổi lệch (để riêng)", [["Mã", "Tên sản phẩm", "Tồn POS", "Đơn vị gốc", "Đơn vị dán tem (master)", "Quy đổi (master)", "Nguồn", "Thẻ đã nhập NW (số thẻ × SL/thẻ)", "Dự kiến theo master", "Thẻ NW active", "Vì sao lệch", "Vị trí POS"], ...conv], [9, 44, 9, 8, 10, 8, 12, 22, 9, 8, 60, 30]);
if (oldF) add("Khác file cũ", [["Mã", "Tên sản phẩm", "Tồn POS cũ", "Tồn POS mới", "Quy đổi cũ", "Quy đổi mới", "Dự kiến cũ", "Dự kiến mới", "Chênh", "Vì sao"], ...diff], [9, 44, 9, 9, 14, 14, 9, 9, 7, 50]);
fs.writeFileSync(path.join(DL, chkName), Buffer.from(XLSX.write(wb, { type: "array", bookType: "xlsx" })));
console.log(JSON.stringify({ impName, chkName, listed: codes.length, imp: impRows.length, sumE, noTag: rows.length - impRows.length, none: none.length, tagSp: tag.length, tags: tag.reduce((s, r) => s + r[8], 0), conv: conv.length, diff: diff.length }));
