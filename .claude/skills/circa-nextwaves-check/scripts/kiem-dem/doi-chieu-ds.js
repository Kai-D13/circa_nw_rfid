// READ-ONLY (chỉ POST tra cứu /integrations/circa/epcs/resolve). Đối chiếu MỘT DANH SÁCH product_id với phiên KIỂM KÊ NW
// (file xuất + kết quả phan-tich-kiem-ke.js) và tồn POS → mỗi mã 1 dòng: cần kiểm lại / đủ / sai ở đâu + việc cần làm.
// Nhóm (ưu tiên từ trên xuống; cột "Vấn đề khác" ghi thêm vấn đề phụ):
//   1 CẦN KIỂM LẠI: còn thẻ "cần tìm" (POS còn hàng mà chưa quét thấy) hoặc thẻ nhập NW sau giờ quét chưa quét lại
//   2 Quy đổi lệch: SL/thẻ phổ biến trên NW ≠ quy đổi master (Google Sheet, đọc trong bộ nhớ; NO_MASTER=1 để bỏ)
//   3 POS cao hơn SL các thẻ còn (đã quét + cần tìm) → đếm tay: hàng chưa gắn tem, hoặc POS cao
//   4 Quét nhiều thẻ hơn POS cần, quá mức hộp mở dở (> 1 + số đơn bán lẻ từ khi gắn thẻ) → POS có thể thấp
//   5 NW dư thẻ so với POS, không thấy đơn · 6 Đủ hàng, NW chưa trừ thẻ đã bán → xuất kho NW
//   7 Đủ, chỉ dư hộp mở dở (bình thường) · 8 Đủ, khớp POS · 9 Không có thẻ NW ở Lumina (đếm tay / gắn tem)
// env NW_KEY, WH (mặc định Lumina). Cột id trong file danh sách: "product_id" (hoặc cột đầu tiên).
// usage: node doi-chieu-ds.js <list.xlsx> <kiem-ke.xlsx> <phan-tich.xlsx của phan-tich-kiem-ke.js> <PHIEN_DIR> <out.xlsx>
const fs = require("fs"), path = require("path");
const { XLSX, KiemDem } = require("./load-tool.js");
const [LIST, SESS, ANA, PD, OUTF] = process.argv.slice(2);
const NW = "https://api-circa.nextwaves.app/api/v1/public";
const ld = (f) => JSON.parse(fs.readFileSync(path.join(PD, f), "utf8"));
const fold0 = KiemDem.fold, UA = { tube: "tuyp" }, fold = (s) => { const f = fold0(s); return UA[f] || f; };
const num = (x) => (typeof x === "number" ? x : Number(String(x).replace(/\./g, "").replace(",", ".")) || 0);
const vnDate = (s) => { const m = String(s).match(/(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+)/); return m ? Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+07:00`) : NaN; };
const fmt = (t) => (isFinite(t) && t > 0 ? new Date(t + 7 * 3600e3).toISOString().slice(0, 16).replace("T", " ") : "");
const r2 = (x) => Math.round(x * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p, body) {
  for (let t = 0; t < 8; t++) {
    const r = await fetch(NW + p, { method: "POST", headers: { authorization: "Bearer " + process.env.NW_KEY, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 429 || r.status >= 500) { await sleep(2000 * (t + 1)); continue; }
    if (!r.ok) throw new Error(r.status + " " + p);
    return r.json();
  }
  throw new Error("429/5xx mãi " + p);
}
const rd = (f) => { const wb = XLSX.read(fs.readFileSync(f), { type: "buffer" }); return (n) => (wb.Sheets[n] ? XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: "" }) : []); };
(async () => {
  if (!process.env.NW_KEY) throw new Error("thiếu NW_KEY");
  // danh sách
  const lw = XLSX.read(fs.readFileSync(LIST), { type: "buffer" }), LR = XLSX.utils.sheet_to_json(lw.Sheets[lw.SheetNames[0]], { defval: "" });
  const idK = Object.keys(LR[0]).find((k) => /product_?id/i.test(k)) || Object.keys(LR[0])[0], nmK = Object.keys(LR[0]).find((k) => /name|tên/i.test(k));
  const ids = [...new Map(LR.map((r) => [String(r[idK]).trim().replace(/^CIRCA-/i, ""), r])).entries()].filter(([c]) => c);
  // phiên
  const S = rd(SESS), DS = S("Danh sách kiểm kê"), D = S("Chi tiết quét");
  const ov = Object.fromEntries(S("Tổng quan").map((r) => [r["Chỉ tiêu"], r["Giá trị"]]));
  const sessStart = vnDate(ov["Tạo lúc"]);
  const code = (x) => String(x).replace(/^CIRCA-/i, "");
  const SP = new Map();
  for (const r of DS) { const c = code(r["Mã SP"]); const p = SP.get(c) || { name: r["Tên sản phẩm"], unit: r["ĐVT"], status: r["Trạng thái"], sys: 0, scanned: [], missing: [], lastScan: 0 }; p.sys += num(r["Tồn hệ thống"]); for (const e of String(r["EPC chưa quét (có thể thiếu)"] || "").split(/[,;\s]+/).filter(Boolean)) p.missing.push(e); SP.set(c, p); }
  for (const r of D) { if (r["Trạng thái"] !== "Đã quét") continue; const p = SP.get(code(r["Mã SP"])); if (!p) continue; p.scanned.push(String(r.EPC)); const t = vnDate(r["Lần quét cuối"]); if (t > p.lastScan) p.lastScan = t; }
  // phân tích
  const A = rd(ANA), AP = new Map(A("SP thiếu").map((r) => [String(r["Mã SP"]), r]));
  const AE = new Map(); for (const r of A("EPC thiếu")) { const c = String(r["Mã SP"]); if (!AE.has(c)) AE.set(c, []); AE.get(c).push(r); }
  // POS + đơn + sổ kho
  const NOW = ld("pos-stock-now.json"), SNAP = Date.parse(NOW.at);
  const POS = new Map();
  for (const r of NOW.rows) { const o = POS.get(r.pid) || { q: 0, lost: 0, locs: {}, base: r.base, units: r.units || [], name: r.name }; for (const l of r.locs && r.locs.length ? r.locs : [{ loc: "", q: r.q }]) { const q = Number(l.q) || 0; if (fold(l.loc || "") === "kho that lac") o.lost += q; else { o.q += q; if (q) o.locs[l.loc || "(trống)"] = (o.locs[l.loc || "(trống)"] || 0) + q; } } POS.set(r.pid, o); }
  const LG = ld("nw-ledger.json"), firstIn = new Map(), inOut = new Map();
  for (const r of LG) { const t = Date.parse(r.at), io = inOut.get(r.c) || { inn: 0, out: 0, lastOut: "" }; if (r.q > 0 && /stock_in|pack_in|transfer/.test(r.t)) { io.inn += (r.epcs || []).length; if (!firstIn.has(r.c) || t < firstIn.get(r.c)) firstIn.set(r.c, t); } if (r.q < 0) { io.out += (r.epcs || []).length; io.lastOut = String(r.ref || "").split("-/").pop() + " " + fmt(t); } inOut.set(r.c, io); }
  const mv = [];
  for (const o of ld("pos-orders.json")) { if (o.err) continue; const t = Date.parse(o.completed_date); for (const it of o.items) mv.push({ pid: it.product_id, t, base: Number(it.base_quantity) || 0, ch: o.type === "ONLINE" ? "ONLINE" : "OFFLINE", ref: o.code }); }
  for (const tr of ld("pos-trf.json")) { if (tr.status !== "COMPLETED") continue; const t = Date.parse(tr.completed_at); for (const it of tr.items) mv.push({ pid: it.product_id, t, base: Number(it.base_quantity) || it.detailQty || 0, ch: "TRF", ref: tr.code }); }
  const mvBy = new Map(); for (const m of mv) { if (!mvBy.has(m.pid)) mvBy.set(m.pid, []); mvBy.get(m.pid).push(m); }
  // SL từng thẻ
  const allE = []; for (const [c] of ids) { const p = SP.get(c); if (p) allE.push(...p.scanned, ...p.missing); }
  const R = new Map(); for (let i = 0; i < allE.length; i += 200) { const j = await post("/integrations/circa/epcs/resolve", { epcs: allE.slice(i, i + 200) }); for (const x of Array.isArray(j) ? j : j.data || j.results || []) R.set(x.epc, x); }
  // master quy đổi (Google Sheet, đọc trong bộ nhớ như r2.js; NO_MASTER=1 để bỏ)
  let M = null;
  if (!process.env.NO_MASTER) {
    const gv = "https://docs.google.com/spreadsheets/d/18nLllIlORaki3por1diKzNo2tWvdVyUnB1xbZXDv8Xc/gviz/tq?tqx=out:csv&headers=1&sheet=";
    const v4 = await (await fetch(gv + encodeURIComponent("final data v4") + "&tq=" + encodeURIComponent("select A,B,C,D,E"))).text();
    const ad = await (await fetch(gv + "Adhoc")).text();
    if (!/^"product_id","product_name","convert_unit"/.test(v4)) throw new Error("master: sai tab (header " + v4.slice(0, 80) + ")");
    const mw = XLSX.utils.book_new(); for (const [n, c] of [["final data v4", v4], ["Adhoc", ad]]) { const w = XLSX.read(c, { type: "string", raw: true, dense: true }); XLSX.utils.book_append_sheet(mw, w.Sheets[w.SheetNames[0]], n); }
    M = KiemDem.loadMaster(mw);
  }
  const GN = { 1: "1. CẦN KIỂM LẠI (còn thẻ chưa thấy)", 2: "2. Quy đổi lệch: SL/thẻ NW ≠ master", 3: "3. POS cao hơn hàng có thẻ (đếm: hàng chưa gắn tem / POS cao)", 4: "4. Quét nhiều thẻ hơn POS cần, quá mức hộp mở dở (POS có thể thấp)", 5: "5. NW dư thẻ so với POS, không thấy đơn", 6: "6. Đủ hàng, NW chưa trừ thẻ đã bán", 7: "7. Đủ, chỉ dư hộp mở dở (bình thường)", 8: "8. Đủ, khớp POS", 9: "9. Không có thẻ NW ở Lumina" };
  const rows = [], G = {};
  for (const [c, lr] of ids) {
    const p = SP.get(c), pos = POS.get(c), a = AP.get(c), es = AE.get(c) || [];
    const nm = (nmK && lr[nmK]) || (p && p.name) || (pos && pos.name) || "";
    const locs = pos ? Object.entries(pos.locs).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([l, q]) => l + ":" + q).join(", ") : "";
    if (!p || !(p.scanned.length + p.missing.length)) {
      const io = inOut.get(c), q = pos ? pos.q : 0;
      const his = io && io.inn ? `NW từng nhập ${io.inn} thẻ, đã xuất ${io.out} (lần cuối ${io.lastOut})` : "chưa từng nhập thẻ NW ở Lumina";
      const g = 9; G[g] = (G[g] || 0) + 1;
      rows.push([c, nm, GN[g], "", "", "", "", "", "", r2(q), pos ? pos.base : "", "", "", "", his, q > 0 ? "Không kiểm RFID được: đếm tay theo POS, hoặc gắn tem + nhập NW" : "Không có hàng trên POS → bỏ khỏi danh sách kiểm", q > 0 ? `POS còn ${r2(q)} ${pos.base} mà không có thẻ` : "POS 0", locs]);
      continue;
    }
    let k = 1, unitNote = "";
    if (pos && fold(pos.base || "") !== fold(p.unit || "")) { const u = pos.units.find((x) => fold(x.unit || "") === fold(p.unit || "")); if (u && u.rate) { k = Number(u.rate); unitNote = `ĐV NW ${p.unit} = ${k} ${pos.base} POS`; } else unitNote = `ĐV NW "${p.unit}" ≠ ĐV POS "${pos.base}"`; }
    const T = p.scanned.length + p.missing.length;
    const tq = (e) => { const x = R.get(e); return x && x.found && x.baseQuantity != null ? Number(x.baseQuantity) * k : (p.sys / T) * k; };
    const cnt = { sold: 0, f: 0, late: 0, find: 0 };
    for (const r of es) { const cat = String(r["Phân loại"]); if (/^[a-e]\./.test(cat)) cnt.sold++; else if (/^f\./.test(cat)) cnt.f++; else if (/^g\./.test(cat)) cnt.late++; else if (/^h\./.test(cat)) cnt.find++; }
    const lateSet = new Set(es.filter((r) => /^g\./.test(r["Phân loại"])).map((r) => r.EPC));
    const tags = [...p.scanned, ...p.missing.filter((e) => !lateSet.has(e))], Teff = tags.length;
    const tScan = p.lastScan || SNAP, ms = mvBy.get(c) || [];
    const soldAfter = ms.filter((m) => m.t > tScan && m.t <= SNAP).reduce((s, m) => s + m.base, 0);
    const S_scan = Math.max(0, (pos ? pos.q : 0) + soldAfter);
    const qs = tags.map(tq).sort((x, y) => y - x); let E = 0, acc = 0; while (E < Teff && acc < S_scan - 1e-9) { acc += qs[E]; E++; }
    const Qall = qs.reduce((s, x) => s + x, 0), Qscan = p.scanned.reduce((s, e) => s + tq(e), 0);
    const size = Qall / (Teff || 1);
    const findQ = es.filter((r) => /^h\./.test(r["Phân loại"])).reduce((s0, r) => s0 + tq(r.EPC), 0);
    const Qexist = Qscan + findQ; // SL các thẻ còn thật (đã quét + cần tìm), không tính thẻ đã bán/dư
    const uncovered = r2(Math.max(0, S_scan - Qexist));
    const fi = firstIn.get(c) || 0;
    const loose = [...new Set(ms.filter((m) => m.t >= fi && m.t <= tScan && m.ch !== "TRF" && size > 0 && Math.abs(m.base / size - Math.round(m.base / size)) > 1e-6).map((m) => m.ref))];
    const over = p.scanned.length - E; // quét nhiều hơn số thẻ POS cần
    // master: SL/thẻ phổ biến trên NW so với quy đổi master (đơn vị gốc POS / 1 đơn vị in tem)
    const me = M && M.get(c), mr = me && pos ? KiemDem.masterRatio(me, pos.base) : null;
    const modeQ = (() => { const h = {}; for (const e of tags) { const q = r2(tq(e)); h[q] = (h[q] || 0) + 1; } const top = Object.entries(h).sort((x, y) => y[1] - x[1])[0]; return top ? +top[0] : (p.sys / T) * k; })();
    const mism = mr && Math.abs(mr[1] - modeQ) > 1e-6;
    const Em = mr ? Math.ceil(S_scan / mr[1] - 1e-9) : null;
    const issues = [];
    if (cnt.find || cnt.late) issues.push(1); if (mism) issues.push(2); if (uncovered > 0) issues.push(3); const unitTag = modeQ <= 1 + 1e-9; // mỗi thẻ = 1 đơn vị gốc POS → không thể có hộp mở dở
    const okOver = over > 0 && !unitTag && over <= 1 + loose.length; // 1 hộp mở sẵn + 1 hộp mỗi đơn bán lẻ
    if (over > 0 && !okOver) issues.push(4); if (cnt.f) issues.push(5); if (cnt.sold) issues.push(6); if (okOver) issues.push(7);
    const g = issues.length ? issues[0] : 8; G[g] = (G[g] || 0) + 1;
    const seenTxt = a ? String(a["Thẻ cần tìm từng quét thấy ở phiên trước"] || "") : "";
    const txt = {
      1: (cnt.find ? `Còn ${cnt.find} thẻ chưa thấy mà POS còn hàng` + (/^[1-9]/.test(seenTxt) ? ` (phiên trước từng quét thấy ${seenTxt})` : " (chưa từng quét thấy ở phiên trước)") : "") + (cnt.late ? (cnt.find ? " · " : "") + `${cnt.late} thẻ nhập NW sau giờ quét SP, chưa quét lại` : "") + (p.scanned.length ? "" : " · chưa quét được thẻ nào của SP này"),
      2: mr ? `Master: 1 ${mr[0]} = ${r2(mr[1])} ${pos.base}; thẻ NW ghi ${modeQ} ${pos.base}/thẻ. Theo master, POS ${r2(S_scan)} ${pos.base} ≈ ${Em} thẻ; quét được ${p.scanned.length}` + (p.scanned.length === Em ? " → khớp nếu tem dán theo master" : "") : "",
      3: `POS lúc quét ${r2(S_scan)} ${pos ? pos.base : ""} > SL các thẻ còn (${p.scanned.length + cnt.find} thẻ = ${r2(Qexist)}) → dư ${uncovered} ${pos ? pos.base : ""} (≈ ${r2(uncovered / (size || 1))} thẻ): hàng chưa gắn tem, hoặc POS cao`,
      4: `Quét ${p.scanned.length} thẻ, tồn POS ${r2(S_scan)} chỉ cần ${E} thẻ → dư ${over} thẻ` + (unitTag ? ` · mỗi thẻ = 1 ${pos ? pos.base : ""}, không thể là hộp mở dở → thực tế nhiều hơn POS ${over} ${pos ? pos.base : ""} (POS thấp), hoặc 1 SP dán 2 tem` : "") + (unitTag ? "" : loose.length ? ` · có ${loose.length} đơn bán lẻ từ khi gắn thẻ → nhiều khả năng hộp mở dở` : " · không có đơn bán lẻ sau khi gắn thẻ → tem dán trên hộp đã mở từ trước (NW ghi cả hộp), hoặc POS thấp"),
      7: "",
      5: `${cnt.f} thẻ NW dư so với POS, không thấy đơn/TRF`,
      6: `${cnt.sold} thẻ đã bán/chuyển, NW chưa trừ`,
    };
    const todo = { 1: "Kiểm lại SP này (tìm thẻ / đếm)", 2: "Xem tem dán theo đơn vị nào: đúng master thì sửa SL thẻ NW, đúng NW thì sửa master", 3: "Đếm tay: có hàng không tem thì gắn tem + nhập NW; không có thì điều chỉnh giảm tồn POS", 3: "Đếm số lẻ trong các hộp: tổng = POS thì POS đúng (chỉ SL trên thẻ NW ghi cả hộp); tổng > POS thì điều chỉnh tăng POS", 5: "Kiểm lịch sử nhập NW / điều chỉnh tồn POS", 6: "Xuất kho NW các thẻ đã bán (không cần kiểm lại)", 7: "Không cần kiểm (muốn chính xác: đếm số lẻ trong hộp mở)", 8: "Không cần kiểm" }[g];
    rows.push([c, nm, GN[g], issues.slice(1).map((i) => (i === 7 ? txt[4] : txt[i])).filter(Boolean).join(" · "), T, p.scanned.length, p.missing.length, cnt.find, cnt.sold + (cnt.f ? " + dư " + cnt.f : "") + (cnt.late ? " + nhập sau " + cnt.late : ""), r2(pos ? pos.q : 0), pos ? pos.base : "", r2(S_scan), E, r2(Qscan), [unitNote, !mr ? (M ? "chưa có quy đổi master" : "") : ""].filter(Boolean).join(" · "), todo, g === 8 ? `Quét ${p.scanned.length}/${T} thẻ, tồn POS ${r2(S_scan)} ${pos ? pos.base : ""} ≈ ${E} thẻ` : g === 7 ? txt[4] : txt[g], locs]);
  }
  rows.sort((x, y) => x[2].localeCompare(y[2]) || (+y[7] || 0) - (+x[7] || 0) || String(x[1]).localeCompare(String(y[1])));
  const H = ["Mã SP", "Tên sản phẩm", "Kết luận", "Vấn đề khác", "Thẻ NW", "Đã quét", "Thiếu", "Cần tìm", "Đã bán NW chưa trừ / dư / nhập sau", "Tồn POS hiện tại", "ĐV POS", "Tồn POS lúc quét", "Thẻ đáng lẽ còn (theo POS)", "SL các thẻ đã quét (ĐV POS)", "Ghi chú", "Việc cần làm", "Chi tiết", "Vị trí POS"];
  const out = XLSX.utils.book_new();
  const add = (n, a, w) => { const ws = XLSX.utils.aoa_to_sheet(a); ws["!cols"] = w.map((x) => ({ wch: x })); if (a.length > 1) ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: a.length - 1, c: a[0].length - 1 } }) }; XLSX.utils.book_append_sheet(out, ws, n); };
  add("Đối chiếu " + rows.length + " mã", [H, ...rows], [9, 44, 34, 40, 6, 6, 6, 6, 12, 9, 7, 9, 9, 10, 16, 34, 60, 24]);
  const WHY = { 5: "Hàng còn đủ theo POS. NW có thêm thẻ mà không có hàng tương ứng (không thấy đơn) → chỉ sửa dữ liệu NW", 6: "Hàng còn đủ theo POS. Thẻ thiếu là hàng đã bán/chuyển mà NW chưa trừ → chỉ xuất kho NW", 7: "Quét thấy mọi thẻ cần có. Dư thẻ vì hộp đã mở dở: thẻ NW ghi cả hộp nhưng hộp chỉ còn ít → số lẻ trên POS vẫn hợp lý", 8: "Quét đủ, khớp tồn POS" };
  const ok = rows.filter((r) => /^[5-8]./.test(r[2])).map((r) => [r[0], r[1], r[2], WHY[r[2][0]], r[5] + "/" + r[4], r[11] + " " + r[10], r[12], r[16] + (r[3] ? " · " + r[3] : ""), r[15]]);
  add("Không cần kiểm (" + ok.length + ")", [["Mã SP", "Tên sản phẩm", "Nhóm", "Vì sao không cần kiểm", "Quét / thẻ NW", "Tồn POS lúc quét", "Thẻ cần có theo POS", "Chi tiết", "Việc cần làm"], ...ok], [9, 44, 30, 60, 9, 12, 9, 70, 34]);
  const sm = [["Kết luận", "Số mã"], ...Object.keys(GN).map((g) => [GN[g], G[g] || 0]), ["Tổng", rows.length], [], ["Phiên", path.basename(SESS) + " · tồn POS lúc " + fmt(SNAP)]];
  add("Tổng hợp", sm, [48, 10]);
  fs.writeFileSync(OUTF, Buffer.from(XLSX.write(out, { type: "array", bookType: "xlsx" })));
  console.log(JSON.stringify(G), "resolve", R.size, "/", allE.length);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
