// Build the per-UID / per-product list of a POS QR count session (offline, from pos-count-scans.js output).
// usage: node ics-scans-xlsx.js <dir> <nw-ledger-raw.json> <r2 codes.json> <out.xlsx>
const fs = require("fs"), path = require("path");
const [dir, ledgerF, codesF, out] = process.argv.slice(2);
const { XLSX } = require("./load-tool.js");
const rd = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const sess = rd("session.json"), sum = rd("summary.json"), sc = rd("scans.json"), lines = rd("lines.json");
const L = JSON.parse(fs.readFileSync(ledgerF, "utf8"));
const epcPid = new Map(); for (const r of L) for (const e of r.epcs || []) if (!epcPid.has(e)) epcPid.set(e, r.c);
const vn = (iso) => iso ? new Date(Date.parse(iso) + 7 * 3600e3).toISOString().replace("T", " ").slice(0, 19) : "";
const kind = (q) => /^[0-9A-F]{24}$/i.test(q) ? "Mã dạng EPC (24 ký tự)" : /^\d{13}[A-Z]\d*$/.test(q) ? "UID" : "Khác";
sc.sort((a, b) => a.product_id - b.product_id || a.scanned_at.localeCompare(b.scanned_at));
const rows = sc.map((s, i) => {
  const k = kind(s.qr_code), nw = k.startsWith("Mã dạng EPC") ? epcPid.get(s.qr_code.toUpperCase()) : undefined;
  return [i + 1, s.product_id, s.product_name, s.qr_code, k, s.unit_code, s.conversion_factor, s.scanned_qty, s.base_qty, s.lot, s.expired_date ? s.expired_date.slice(0, 10) : "", s.po_code, s.device_id, vn(s.scanned_at),
    k.startsWith("Mã dạng EPC") ? (nw === undefined ? "Không có trong sổ kho NW" : String(nw) === String(s.product_id) ? "Có, đúng SP" : "Có, nhưng thuộc SP " + nw) : ""];
});
const byLine = new Map(); for (const l of lines) byLine.set(l.id, l);
const byP = new Map();
for (const s of sc) { const p = byP.get(s.product_id) || { pid: s.product_id, name: s.product_name, qr: [], base: 0, kinds: {} }; p.qr.push(s.qr_code); p.base += s.base_qty; const k = kind(s.qr_code); p.kinds[k] = (p.kinds[k] || 0) + 1; byP.set(s.product_id, p); }
const linesByP = new Map(); for (const l of lines) { const a = linesByP.get(l.product_id) || []; a.push(l); linesByP.set(l.product_id, a); }
const prow = [...byP.values()].sort((a, b) => a.pid - b.pid).map((p, i) => {
  const ls = linesByP.get(p.pid) || [], exp = ls.reduce((s, l) => s + l.expected_qty, 0), cnt = ls.reduce((s, l) => s + l.counted_qty, 0);
  return [i + 1, p.pid, p.name, ls[0] ? ls[0].base_unit : "", exp, cnt, p.base, cnt - exp, p.qr.length, p.kinds["UID"] || 0, p.kinds["Mã dạng EPC (24 ký tự)"] || 0, p.qr.join(", ")];
});
const codes = new Set(JSON.parse(fs.readFileSync(codesF, "utf8")).map(String)), inSess = new Set(lines.map((l) => String(l.product_id)));
const kc = {}; for (const r of rows) kc[r[4]] = (kc[r[4]] || 0) + 1;
const epcRows = rows.filter((r) => r[14]); const ek = {}; for (const r of epcRows) ek[r[14].startsWith("Có, nhưng") ? "Có, nhưng thuộc SP khác" : r[14]] = (ek[r[14].startsWith("Có, nhưng") ? "Có, nhưng thuộc SP khác" : r[14]] || 0) + 1;
const t = sc.map((s) => s.scanned_at).sort();
const tom = [["Phiên kiểm kê POS", sess.code + " (" + sess.id + ")"], ["Cửa hàng", sess.pos_name], ["Chế độ đếm", sess.counting_mode], ["Trạng thái lúc lấy", sess.status], ["Người tạo", (sess.created_by_name || "").trim() + " — " + vn(sess.created_at)],
  ["Lấy dữ liệu lúc", vn(new Date().toISOString())], ["Lượt quét", sc.length + " (mỗi mã QR quét 1 lần, không trùng)"], ["Số SP đã quét", byP.size + " / " + inSess.size + " SP trong phiên"],
  ["Thời gian quét", vn(t[0]) + " → " + vn(t[t.length - 1])], ["Thiết bị", [...new Set(sc.map((s) => s.device_id))].join(", ")],
  ...Object.entries(kc).map(([k, v]) => ["Dạng mã: " + k, v]), ...Object.entries(ek).map(([k, v]) => ["Mã dạng EPC — trong sổ kho NW: " + k, v]),
  ["Tổng SL gốc đã đếm (summary POS)", sum.counted_total_qty], ["Tổng SL gốc theo các lượt quét", sc.reduce((s, x) => s + x.base_qty, 0)],
  ["SP trong phiên nhưng không có trong 548 mã R2", [...inSess].filter((c) => !codes.has(c)).join(", ") || "—"], ["Mã R2 không có trong phiên", [...codes].filter((c) => !inSess.has(c)).join(", ") || "—"]];
const wb = XLSX.utils.book_new();
const add = (name, aoa, w) => { const ws = XLSX.utils.aoa_to_sheet(aoa); ws["!cols"] = w.map((x) => ({ wch: x })); if (aoa.length > 1) ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: aoa[0].length - 1 } }) }; XLSX.utils.book_append_sheet(wb, ws, name); };
add("UID đã quét", [["STT", "Mã SP", "Tên sản phẩm", "Mã QR đã quét (UID)", "Dạng mã", "Đơn vị quét", "Quy đổi (SL gốc/đơn vị)", "SL quét", "SL gốc", "Lô", "HSD", "PO", "Thiết bị", "Thời gian quét (giờ VN)", "Mã dạng EPC có trong sổ kho NW?"], ...rows], [5, 9, 50, 28, 20, 10, 10, 7, 8, 10, 11, 13, 9, 20, 26]);
add("Theo sản phẩm", [["STT", "Mã SP", "Tên sản phẩm", "Đơn vị gốc", "Dự kiến POS (SL gốc)", "Đã đếm trên POS (SL gốc)", "SL gốc theo lượt quét", "Chênh (đếm − dự kiến)", "Số mã QR đã quét", "Trong đó UID", "Trong đó mã dạng EPC", "Danh sách mã QR đã quét"], ...prow], [5, 9, 50, 9, 10, 10, 10, 10, 8, 8, 8, 120]);
add("Tóm tắt", [["Mục", "Giá trị"], ...tom], [44, 80]);
wb.SheetNames = ["Tóm tắt", "UID đã quét", "Theo sản phẩm"];
fs.writeFileSync(out, Buffer.from(XLSX.write(wb, { type: "array", bookType: "xlsx" })));
console.log(JSON.stringify(tom.map((r) => r.join(": ")), null, 1));
const bad = rows.filter((r) => r[14] && r[14] !== "Có, đúng SP"); console.log("EPC-format not matching:", bad.length, bad.slice(0, 10).map((r) => r[1] + " " + r[3] + " → " + r[14]).join(" | "));
const mism = prow.filter((r) => r[5] !== r[6]); console.log("counted≠scan base:", mism.length, mism.slice(0, 5).map((r) => r[1] + " " + r[5] + "/" + r[6]).join("; "));
