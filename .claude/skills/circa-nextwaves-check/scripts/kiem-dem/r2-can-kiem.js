// Offline: for every R2 product decide whether it really needs a recount, using the 18:07 RFID session analysis + later evidence.
// usage: node r2-can-kiem.js <so-sanh-548.xlsx> <v5 report.xlsx> <rfid 18:07.xlsx> <rfid 22:48.xlsx> <ics dir (qr-epc.json, sold-*.json, nw-ledger-now.json)> <out.xlsx>
const fs = require("fs"), path = require("path");
const [cmpF, v5F, r18F, r22F, icsDir, out] = process.argv.slice(2);
const { XLSX } = require("./load-tool.js");
const wbOf = (f) => XLSX.read(fs.readFileSync(f), { type: "buffer" });
const rows = (wb, n, o = {}) => XLSX.utils.sheet_to_json(wb.Sheets[n], Object.assign({ defval: "" }, o));
const vn = (iso) => (iso ? new Date(Date.parse(iso) + 7 * 3600e3).toISOString().replace("T", " ").slice(0, 16) : "");
const END18 = "2026-11-18T11:07:00.000Z"; // 18:07 VN

const C = rows(wbOf(cmpF), "So sánh 548 mã");
const v5 = wbOf(v5F), U = rows(v5, "Thẻ chưa quét"), SPP = new Map(rows(v5, "SP theo POS").map((r) => [String(r["Mã"]), r]));
const w18 = wbOf(r18F), h18 = XLSX.utils.sheet_to_json(w18.Sheets["Tổng hợp"], { header: 1, defval: "" });
const TH = new Map(rows(w18, "Tổng hợp", { range: h18.findIndex((r) => r.includes("Trạng thái") && r.includes("Dự kiến")) }).map((r) => [String(r["Mã sản phẩm"] || r["Mã vạch"]).replace(/^CIRCA-/, ""), r]));
const w22 = wbOf(r22F), read22 = new Set([...rows(w22, "Chi tiết thẻ"), ...rows(w22, "Ngoại lệ")].map((r) => String(r.EPC).toUpperCase()));
const { res } = JSON.parse(fs.readFileSync(path.join(icsDir, "qr-epc.json"), "utf8"));
const posQR = new Map(); for (const [qr, r] of Object.entries(res)) for (const e of r.epcs) posQR.set(e.toUpperCase(), qr);
const soldF = fs.readdirSync(icsDir).filter((f) => /^sold-.*\.json$/.test(f)).map((f) => path.join(icsDir, f));
const sold = new Map(); for (const f of soldF) for (const l of JSON.parse(fs.readFileSync(f, "utf8"))) if (l.at > END18) for (const e of l.epcs) if (!sold.has(e)) sold.set(e, l);
const LG = JSON.parse(fs.readFileSync(path.join(icsDir, "nw-ledger-now.json"), "utf8"));
const nwOut = new Map(); for (const r of LG) if (r.at > END18 && (r.q < 0 || /out|order/i.test(r.t))) for (const e of r.epcs || []) nwOut.set(e.toUpperCase(), r);

// e2 = unscanned tags while POS still had stock (the only ones that mean "goods may be missing")
const e2By = new Map();
for (const r of U) if (/^e2/.test(r["Nguyên nhân"])) { const k = String(r["Mã"]); if (!e2By.has(k)) e2By.set(k, []); e2By.get(k).push(r); }
const foundOf = (e) => posQR.has(e) ? "POS quét QR " + posQR.get(e) : read22.has(e) ? "RFID 22:48 đọc được" : sold.has(e) ? `đã bán ${sold.get(e).code} lúc ${vn(sold.get(e).at)}` : nwOut.has(e) ? `NW đã trừ ${nwOut.get(e).ref || ""} lúc ${vn(nwOut.get(e).at)}` : "";

const out1 = [], outE = [], tally = {};
for (const r of C) {
  const pid = String(r["Mã"]), t = TH.get(pid), kq = String(r["Kết quả theo POS (phân tích 18/11)"]), why = String(r["Nguyên nhân lệch (phân tích 18/11)"]);
  const grp = (/^(A3|A|B|C|D|E)\./.exec(why) || [])[1] || "";
  const e2 = e2By.get(pid) || [], f = e2.map((x) => [x, foundOf(String(x.EPC).toUpperCase())]);
  const nf = f.filter(([, s]) => !s), fd = f.filter(([, s]) => s);
  const by = (re) => fd.filter(([, s]) => re.test(s)).length;
  let need, reason, todo;
  if (!t) { need = "CÓ"; reason = "Không có trong phiên 18:07"; todo = "Kiểm R2"; }
  else if (!grp) { need = "KHÔNG"; reason = "Đã khớp tồn POS ở phiên 18:07"; todo = String(r["Phiên trước: trạng thái app"]) !== "Khớp" ? "App báo " + r["Phiên trước: trạng thái app"] + " nhưng theo POS là khớp (thẻ đã bán NW chưa trừ / lẫn cỡ thẻ / hộp lẻ / thẻ nhập trong lúc kiểm)" : ""; }
  else if (grp === "A" || grp === "A3") { need = "KHÔNG"; reason = grp === "A3" ? "Lẫn cỡ thẻ, số quét nằm trong khoảng hợp lý" : "Thẻ NW ghi sai số lượng/đơn vị: quét lại vẫn ra như cũ"; todo = grp === "A" ? "Sửa SL/đơn vị thẻ trên NW" : ""; }
  else if (grp === "B") { need = "KHÔNG"; reason = "Quét được NHIỀU hơn tồn POS: quét lại RFID vẫn ra như cũ"; todo = "Kiểm tra & điều chỉnh tồn POS (POS đang thấp hơn thực tế)"; }
  else if (grp === "C") { need = "KHÔNG (RFID)"; reason = "Đã quét đủ mọi thẻ NW; phần POS còn dư là hàng CHƯA gắn thẻ, RFID không thể thấy"; todo = "Gắn tem phần chưa có thẻ, hoặc đếm bằng QR trên POS"; }
  else if (!nf.length) { need = grp === "D" ? "KHÔNG (RFID)" : "KHÔNG"; reason = e2.length ? `Thẻ thiếu lúc 18:07 đã được thấy lại / đã bán (${fd.length}/${e2.length})` : "Không còn thẻ cần tìm (thẻ chưa quét đều là hàng đã bán NW chưa trừ)"; todo = (grp === "D" ? "Gắn tem phần POS chưa có thẻ; " : "") + (fd.length ? "RFID 18:07 bỏ sót, hàng vẫn còn" : "Trừ trên NW các thẻ đã bán"); }
  else { need = "CÓ"; reason = `Còn ${nf.length}/${e2.length} thẻ NW chưa thấy ở bất kỳ lần quét nào (POS còn hàng)`; todo = "Kiểm lại R2 / tìm đúng các EPC trong sheet 'Thẻ cần tìm'" + (grp === "D" ? "; gắn tem phần chưa có thẻ" : ""); }
  const k = need + " · " + reason.replace(/\d+\/\d+/g, "x/y").replace(/\(.*\)/, "").trim(); tally[k] = (tally[k] || 0) + 1;
  out1.push([pid, r["Tên sản phẩm"], t ? t["Trạng thái"] : "(không có)", r["Phiên trước: Dự kiến (file 15:14)"], r["Đã quét (gồm thẻ nhập trong lúc kiểm)"], kq || "Khớp", grp || "—", e2.length, by(/^POS quét QR/), by(/^RFID 22:48/), by(/đã bán|NW đã trừ/), nf.length,
    r["R2: Tồn POS 20:03"], r["Đơn vị"], r["R2: Dự kiến"], need, reason, todo, why]);
  for (const [x, s] of f) outE.push([pid, r["Tên sản phẩm"], x.EPC, x.UID, x["SL trên thẻ"], x["Nhập NW lúc"], x["Phiếu nhập"], x["Vị trí POS"], s || "CHƯA THẤY", need]);
}
out1.sort((a, b) => (a[15] === "CÓ" ? 0 : 1) - (b[15] === "CÓ" ? 0 : 1) || b[11] - a[11] || Number(a[0]) - Number(b[0]));
outE.sort((a, b) => (a[8] === "CHƯA THẤY" ? 0 : 1) - (b[8] === "CHƯA THẤY" ? 0 : 1) || Number(a[0]) - Number(b[0]));
const needN = out1.filter((r) => r[15] === "CÓ").length;
const tom = [["548 mã R2 có trong phiên RFID 18:07?", `${out1.filter((r) => r[2] !== "(không có)").length}/548 có trong danh sách phiên 18:07`],
  ["CẦN kiểm lại ở R2", `${needN} mã (${out1.filter((r) => r[15] === "CÓ").reduce((s, r) => s + r[11], 0)} thẻ chưa thấy)`], ["KHÔNG cần kiểm lại", 548 - needN + " mã"],
  ...Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v]),
  ["Bằng chứng 'đã thấy lại'", "EPC được POS quét QR (phiên ICS00237 20:52–21:57), hoặc RFID 22:48 đọc được, hoặc đã bán sau 18:07 (QR trên đơn = thẻ), hoặc NW đã trừ sau 18:07"],
  ["Lưu ý", "Phiên POS ICS00237 mới quét 97 SP và phiên RFID 22:48 chưa quét hết, nên một số thẻ 'chưa thấy' có thể vẫn còn — chính là những mã cần kiểm lại."]];
const wb = XLSX.utils.book_new();
const add = (name, aoa, w) => { const ws = XLSX.utils.aoa_to_sheet(aoa); ws["!cols"] = w.map((x) => ({ wch: x })); if (aoa.length > 1) ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: aoa[0].length - 1 } }) }; XLSX.utils.book_append_sheet(wb, ws, name); };
add("Tóm tắt", [["Mục", "Giá trị"], ...tom], [70, 30]);
add("Kết luận 548 mã", [["Mã", "Tên sản phẩm", "Phiên 18:07: trạng thái app", "Phiên 18:07: Dự kiến", "Phiên 18:07: đã quét (thẻ)", "Kết quả theo POS", "Nhóm nguyên nhân", "Thẻ cần tìm lúc 18:07", "…POS quét QR thấy", "…RFID 22:48 đọc lại", "…đã bán / NW trừ", "Thẻ CHƯA THẤY", "R2: Tồn POS 20:03", "Đơn vị", "R2: Dự kiến", "Cần kiểm lại R2?", "Vì sao", "Việc cần làm", "Nguyên nhân lệch (phân tích 18:07)"], ...out1], [9, 44, 12, 9, 9, 12, 8, 9, 9, 9, 9, 9, 9, 8, 9, 10, 60, 60, 60]);
add("Thẻ cần tìm", [["Mã", "Tên sản phẩm", "EPC", "UID", "SL trên thẻ", "Nhập NW lúc", "Phiếu nhập", "Vị trí POS", "Thấy lại ở đâu", "Mã cần kiểm lại?"], ...outE], [9, 44, 26, 22, 8, 16, 22, 14, 44, 10]);
fs.writeFileSync(out, Buffer.from(XLSX.write(wb, { type: "array", bookType: "xlsx" })));
console.log(tom.map((r) => r.join(": ")).join("\n"));
console.log("\nCần kiểm lại (top):"); for (const r of out1.filter((r) => r[15] === "CÓ").slice(0, 25)) console.log(r[0], String(r[1]).slice(0, 34), "| app", r[2], "| nhóm", r[6], "| cần tìm", r[7], "thấy lại", r[8] + r[9] + r[10], "chưa thấy", r[11]);
fs.writeFileSync(path.join(path.dirname(out), "r2-can-kiem-codes.json"), JSON.stringify(out1.filter((r) => r[15] === "CÓ").map((r) => r[0])));
