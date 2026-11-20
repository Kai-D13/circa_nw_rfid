// READ-ONLY (chỉ đọc/ghi file, không gọi API). Từ file xuất của phan-tich-kiem-ke.js → file "list thiếu" gọn để đi tìm hàng:
//   sheet "SP thiếu (N)": 1 dòng/SP còn thẻ CẦN TÌM; sheet "EPC cần tìm (M)": từng EPC (kèm bằng chứng bán lẻ nếu có).
// PREV (tuỳ chọn) = file phan-tich của lần xuất trước cùng phiên → thêm cột số cần tìm lần trước + sheet SP đã tìm thấy.
// usage: [PREV=<phan-tich lần trước.xlsx>] node list-thieu.js <phan-tich.xlsx> <out.xlsx>
const fs = require("fs");
const { XLSX } = require("./load-tool.js");
const [IN, OUT] = process.argv.slice(2);
const rd = (f) => { const wb = XLSX.read(fs.readFileSync(f), { type: "buffer" }); return (n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: "" }); };
const W = rd(IN), P = W("SP thiếu"), E = W("EPC thiếu");
const PV = process.env.PREV ? rd(process.env.PREV)("SP thiếu") : null;
const prev = new Map((PV || []).map((r) => [String(r["Mã SP"]), r]));
const F = E.filter((r) => /CẦN TÌM/.test(r["Phân loại"]));
const by = new Map(); for (const r of F) { const c = String(r["Mã SP"]); if (!by.has(c)) by.set(c, []); by.get(c).push(r); }
const rows = P.filter((r) => r["→ CẦN TÌM"] > 0).map((r) => {
  const es = by.get(String(r["Mã SP"])) || [];
  const nev = es.filter((e) => !e["Quét thấy lần cuối (phiên trước)"]).length;
  const lc = {}; es.map((e) => e["Quét thấy lần cuối (phiên trước)"]).filter(Boolean).forEach((l) => (lc[l] = (lc[l] || 0) + 1));
  const loose = es.filter((e) => /bán lẻ/.test(e["Bằng chứng"])).length;
  const pr = prev.get(String(r["Mã SP"]));
  const row = [r["Mã SP"], r["Tên sản phẩm"], r["ĐVT NW"], r["Thẻ NW"], r["Đã quét"], r["→ CẦN TÌM"], nev, Object.entries(lc).map(([k, v]) => v + " thẻ @ " + k).join("; "), loose ? loose + " thẻ là hộp đã mở (có bán lẻ)" : "", r["SL/thẻ (ĐV POS)"], r["Tồn POS lúc quét"], r["ĐV POS"], r["Vị trí POS"], r["Trạng thái phiên"] === "Chưa đếm" ? "Không đọc được thẻ nào" : "Đọc được một phần", r["→ Đã bán/chuyển, NW chưa trừ"] || "", es.map((e) => e.EPC).join(", ")];
  if (PV) row.splice(6, 0, pr ? pr["→ CẦN TÌM"] || 0 : "mới");
  return row;
});
rows.sort((a, b) => b[5] - a[5] || String(a[1]).localeCompare(String(b[1])));
const H = ["Mã SP", "Tên sản phẩm", "ĐVT", "Thẻ NW", "Đã quét", "Thiếu (cần tìm)", "Trong đó chưa từng quét thấy", "Đã quét thấy ở phiên trước", "Hộp đã mở", "SL/thẻ", "Tồn POS", "ĐV POS", "Vị trí POS", "Tình trạng trong phiên", "Thẻ khác đã bán, NW chưa trừ (không cần tìm)", "EPC cần tìm"];
if (PV) H.splice(6, 0, "Cần tìm lần xuất trước");
const out = XLSX.utils.book_new();
const add = (n, a, w) => { const ws = XLSX.utils.aoa_to_sheet(a); ws["!cols"] = w.map((x) => ({ wch: x })); if (a.length > 1) ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: a.length - 1, c: a[0].length - 1 } }) }; XLSX.utils.book_append_sheet(out, ws, n); };
const wd = [9, 46, 7, 7, 7, 9, 10, 40, 18, 7, 8, 7, 26, 20, 12, 60]; if (PV) wd.splice(6, 0, 10);
add("SP thiếu (" + rows.length + ")", [H, ...rows], wd);
const er = F.map((r) => [r["Mã SP"], r["Tên sản phẩm"], r.EPC, r.UID, r["SL gốc trên thẻ"], r["Nhập NW lúc"], r["Quét thấy lần cuối (phiên trước)"] || "chưa từng", r["Bằng chứng"] || "", r["Vị trí POS"]]).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
add("EPC cần tìm (" + er.length + ")", [["Mã SP", "Tên sản phẩm", "EPC", "UID", "SL gốc trên thẻ", "Nhập NW lúc", "Quét thấy lần cuối", "Ghi chú", "Vị trí POS"], ...er], [9, 46, 26, 18, 8, 16, 22, 40, 26]);
if (PV) {
  const now = new Map(P.map((r) => [String(r["Mã SP"]), r]));
  const found = PV.filter((r) => r["→ CẦN TÌM"] > 0 && !((now.get(String(r["Mã SP"])) || {})["→ CẦN TÌM"] > 0)).map((r) => { const n = now.get(String(r["Mã SP"])); return [r["Mã SP"], r["Tên sản phẩm"], r["→ CẦN TÌM"], n ? n["Đã quét"] + "/" + n["Thẻ NW"] : "đủ", n ? n["Kết luận"] : "Khớp"]; });
  add("Đã tìm thấy (" + found.length + ")", [["Mã SP", "Tên sản phẩm", "Cần tìm lần trước", "Nay quét / thẻ", "Kết luận nay"], ...found], [9, 46, 10, 12, 40]);
}
fs.writeFileSync(OUT, Buffer.from(XLSX.write(out, { type: "array", bookType: "xlsx" })));
console.log("SP cần tìm", rows.length, "EPC", er.length, "Σ", rows.reduce((s, r) => s + r[5], 0));
console.log(rows.slice(0, 25).map((r) => [r[0], String(r[1]).slice(0, 44), r[3], r[4], r[5], PV ? r[6] : "", r[PV ? 11 : 10] + " " + r[PV ? 12 : 11]].join(" | ")).join("\n"));
