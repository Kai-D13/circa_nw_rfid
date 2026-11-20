// Offline: compare a POS QR count session (scans.json + lines.json + qr-epc.json) with a NW Kiểm đếm export (xlsx), UID by UID and EPC by EPC.
// usage: [LEDGER=<nw-ledger.json>] node pos-qr-vs-rfid.js <dir> <kiem-dem.xlsx> <out.xlsx>
// LEDGER (compact ledger from fetch-ledger.js, pulled AFTER the POS session) gives each EPC's stock-in time, so tags made after the
// RFID session are "not comparable" instead of "RFID missed", and RFID-only tags show whether NW deducted them later.
const fs = require("fs"), path = require("path");
const [dir, kdF, out] = process.argv.slice(2);
const { XLSX } = require("./load-tool.js");
const rd = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const sess = rd("session.json"), sc = rd("scans.json"), lines = rd("lines.json"), { res, facts } = rd("qr-epc.json");
const WH = "3f7bd541-7370-4ce0-9048-231cf061e91a";
const vn = (iso) => (iso ? new Date(Date.parse(iso) + 7 * 3600e3).toISOString().replace("T", " ").slice(0, 16) : "");
const parseVN = (s) => { const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/.exec(String(s)); return m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4] - 7, +m[5])).toISOString() : null; };

// ---- RFID export
const wb0 = XLSX.read(fs.readFileSync(kdF), { type: "buffer" });
const sheet = (n, range) => XLSX.utils.sheet_to_json(wb0.Sheets[n], { range, defval: "" });
const pidOf = (r) => String(r["Mã sản phẩm"] || r["Mã vạch"] || "").replace(/^CIRCA-/, "");
const head = XLSX.utils.sheet_to_json(wb0.Sheets["Tổng hợp"], { header: 1, defval: "" });
const hdr = head.findIndex((r) => r.includes("Trạng thái") && r.includes("Dự kiến"));
const meta = head.slice(0, hdr).filter((r) => r[0]).map((r) => r.filter((x) => x !== ""));
const exportAt = parseVN(meta[0][0]), listAt = parseVN((meta.find((m) => /Tồn hệ thống/.test(m[0])) || [])[1]);
const TH = new Map(sheet("Tổng hợp", hdr).filter((r) => pidOf(r)).map((r) => [pidOf(r), r]));
// optional second RFID export (RFID2): per EPC, did that later session read it?
const R2 = (() => {
  if (!process.env.RFID2) return null;
  const w = XLSX.read(fs.readFileSync(process.env.RFID2), { type: "buffer" }), sh = (n) => XLSX.utils.sheet_to_json(w.Sheets[n], { defval: "" });
  const m = new Map();
  for (const r of sh("Thẻ chưa quét")) m.set(String(r.EPC).toUpperCase(), "không đọc");
  for (const r of sh("Ngoại lệ")) m.set(String(r.EPC).toUpperCase(), "đọc được (Ngoại lệ)");
  for (const r of sh("Chi tiết thẻ")) m.set(String(r.EPC).toUpperCase(), "đọc được");
  return { name: path.basename(process.env.RFID2), get: (e) => (e ? m.get(e) || "không có trong phiên" : "") };
})();
const r2col = (e) => (R2 ? [R2.get(e)] : []);
const scanned = new Map(), unscanned = new Map(), exc = new Map(), excUid = new Map();
for (const r of sheet("Chi tiết thẻ", 0)) scanned.set(String(r.EPC).toUpperCase(), r);
for (const r of sheet("Thẻ chưa quét", 0)) unscanned.set(String(r.EPC).toUpperCase(), r);
for (const r of sheet("Ngoại lệ", 0)) { const e = String(r.EPC).toUpperCase(); exc.set(e, r); if (/^\d{13}[A-Z]/.test(e)) excUid.set(e.replace(/F+$/, ""), r); }

// ---- NW ledger (optional)
const LG = process.env.LEDGER ? JSON.parse(fs.readFileSync(process.env.LEDGER, "utf8")) : [];
const epcIn = new Map(), epcOut = new Map(), epcProd = new Map();
for (const r of LG.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)))) for (const e0 of r.epcs || []) {
  const e = e0.toUpperCase();
  if (r.q > 0 && /in/i.test(r.t)) { if (!epcIn.has(e)) epcIn.set(e, { at: r.at, ref: r.ref }); epcProd.set(e, r.c); }
  else if (r.q < 0 || /out|order/i.test(r.t)) epcOut.set(e, { at: r.at, ref: r.ref, t: r.t });
}

// ---- POS sales in the gap (optional, from pos-sold-window.js): QR = UID evidence per EPC, and volume per product
const SOLD = process.env.SOLD ? JSON.parse(fs.readFileSync(process.env.SOLD, "utf8")) : [];
const epcSold = new Map(), volSold = new Map();
for (const l of SOLD) {
  for (const e of l.epcs) if (!epcSold.has(e)) epcSold.set(e, l);
  if (exportAt && l.at > exportAt && !l.epcs.length) volSold.set(l.pid, (volSold.get(l.pid) || []).concat([l]));
}
const soldTxt = (l) => `${l.code} (${l.channel}) lúc ${vn(l.at)}`;

// ---- classify one EPC that POS saw (POS QR proves the unit was on the shelf at POS scan time)
const READ = "read", MISS = "miss", LATE = "late", NONE = "none";
function cls(e, qr) {
  const tin = epcIn.get(e), uidHit = excUid.get(String(qr || "").toUpperCase()) || (facts[e] && facts[e].uid && excUid.get(String(facts[e].uid).toUpperCase()));
  if (scanned.has(e)) return [READ, "RFID đọc được"];
  if (exc.has(e)) return [READ, "RFID đọc được, nằm ở Ngoại lệ: " + exc.get(e)["Loại"] + (tin && listAt && tin.at > listAt ? " (thẻ nhập NW lúc " + vn(tin.at) + ", sau khi app tải danh sách)" : "")];
  if (uidHit) return [READ, "RFID đọc được tem ghi theo UID (" + uidHit.EPC + "), nằm ở Ngoại lệ"];
  if (tin && exportAt && tin.at > exportAt) return [LATE, "Thẻ nhập NW lúc " + vn(tin.at) + ", sau phiên RFID → không so được"];
  if (unscanned.has(e)) return [MISS, "RFID KHÔNG đọc được (thẻ có trong danh sách)"];
  if (tin && listAt && tin.at > listAt) return [MISS, "RFID KHÔNG đọc được (thẻ nhập NW lúc " + vn(tin.at) + ", trong lúc kiểm)"];
  const f = facts[e] || {};
  return [NONE, "Không có trong phiên RFID (thẻ NW: " + (f.status || "?") + (f.wh && f.wh !== WH ? ", kho khác" : "") + ")"];
}

// ---- per POS QR and per EPC
const P = new Map();
const get = (pid, name) => { let p = P.get(pid); if (!p) { p = { pid, name, qr: 0, base: 0, noEpc: 0, A: new Set(), n: { read: 0, miss: 0, late: 0, none: 0 }, wrongP: 0, cover: 0 }; P.set(pid, p); } return p; };
// base quantity a tag holds: what RFID saw (Số lượng thật), else NW now, else the stock-in line split over its EPCs
const inQ = new Map(); for (const r of LG) if (r.q > 0 && /in/i.test(r.t) && (r.epcs || []).length) for (const e of r.epcs) if (!inQ.has(e.toUpperCase())) inQ.set(e.toUpperCase(), r.q / r.epcs.length);
const qOf = (e, row) => { const v = row && row["Số lượng thật"]; if (v !== "" && v !== undefined && isFinite(Number(v))) return Number(v); const f = facts[e]; if (f && isFinite(Number(f.q))) return Number(f.q); return inQ.get(e) || 0; };
sc.sort((a, b) => a.product_id - b.product_id || a.scanned_at.localeCompare(b.scanned_at));
const rowsQ = [], rowsE = [];
for (const s of sc) {
  const pid = String(s.product_id), r = res[s.qr_code] || { via: "?", epcs: [] }, E = [...new Set(r.epcs.map((e) => e.toUpperCase()))];
  const p = get(pid, s.product_name); p.qr++; p.base += s.base_qty;
  const c = { read: 0, miss: 0, late: 0, none: 0 };
  let kq;
  if (!E.length) {
    p.noEpc++;
    const u = excUid.get(String(s.qr_code).toUpperCase());
    kq = u ? "QR chưa map thẻ NW, nhưng RFID đọc được tem ghi theo UID (" + u.EPC + ")" : "QR chưa có thẻ NW (RFID không thể thấy)";
    rowsE.push([rowsE.length + 1, s.product_id, s.product_name, s.qr_code, r.via, "", "", "", "", kq, "", "", "", "", s.device_id, vn(s.scanned_at), ...r2col("")]);
  }
  // units this QR counted on POS beyond the tags linked to it (outer pack QR whose inner tags hang on other parents, or a QR with no tag)
  p.cover += Math.max(0, s.base_qty - E.reduce((t, e) => t + (facts[e] && isFinite(Number(facts[e].q)) ? Number(facts[e].q) : 0), 0));
  for (const e of E) {
    const [k, txt] = cls(e, s.qr_code), dup = p.A.has(e); c[k]++; if (!dup) { p.n[k]++; p.A.add(e); }
    const f = facts[e] || {}, tin = epcIn.get(e), rr = scanned.get(e) || {};
    if (f.pid && f.pid !== pid && !dup) p.wrongP++;
    rowsE.push([rowsE.length + 1, s.product_id, s.product_name, s.qr_code, r.via, e, f.uid || "", tin ? vn(tin.at) : "", tin ? tin.ref || "" : "", txt + (dup ? " · EPC trùng với một QR POS khác" : ""),
      rr["Tình trạng"] || "", rr["Số lượng thật"] === undefined ? "" : rr["Số lượng thật"], f.q === undefined ? "" : f.q, (f.status || "?") + (f.pid && f.pid !== pid ? " · thẻ của SP " + f.pid : ""), s.device_id, vn(s.scanned_at), ...r2col(e)]);
  }
  if (E.length) {
    const cmp = E.length - c.late;
    if (!cmp) kq = "Thẻ gắn sau phiên RFID → không so được";
    else if (c.read === cmp) kq = cmp > 1 ? `Khớp: RFID đọc đủ ${cmp}/${cmp} thẻ` : "Khớp: RFID đọc được";
    else if (c.read > 0) kq = `RFID đọc ${c.read}/${cmp} thẻ`;
    else kq = c.miss ? "RFID KHÔNG đọc được" : "Thẻ không có trong phiên RFID";
    if (c.late && cmp) kq += ` (+${c.late} thẻ gắn sau phiên RFID)`;
  }
  rowsQ.push([rowsQ.length + 1, s.product_id, s.product_name, s.qr_code, s.unit_code, s.conversion_factor, s.base_qty, r.via, E.length, kq, c.read, c.miss, c.late, c.none, s.device_id, vn(s.scanned_at), E.join(" ")]);
}

// ---- per product, and RFID-only tags (RFID read them, POS did not scan their QR)
const Bof = new Map();
const addB = (k, e, src) => { if (!Bof.has(k)) Bof.set(k, new Map()); Bof.get(k).set(e, src); };
for (const [e, r] of scanned) addB(pidOf(r), e, r);
for (const [e, r] of exc) if (epcProd.has(e)) addB(epcProd.get(e), e, r);
const linesBy = new Map();
for (const l of lines) { const k = String(l.product_id); const a = linesBy.get(k) || []; a.push(l); linesBy.set(k, a); }
const rowsB = [], rowsP = [];
for (const p of [...P.values()].sort((a, b) => Number(a.pid) - Number(b.pid))) {
  const B = Bof.get(p.pid) || new Map(), onlyR = [...B.keys()].filter((e) => !p.A.has(e)), t = TH.get(p.pid) || {}, ls = linesBy.get(p.pid) || [];
  const exp = ls.reduce((s, l) => s + l.expected_qty, 0);
  let soldAfter = 0, inPack = 0, left = p.cover, vleft = (volSold.get(p.pid) || []).reduce((t, l) => t + l.base, 0);
  const vcodes = (volSold.get(p.pid) || []).map(soldTxt).join(", ");
  const rfBase = [...B.entries()].reduce((t, [e, r]) => t + qOf(e, r), 0);
  // RFID-only tags, smallest first, are matched against units POS counted through outer-pack / unlinked QRs
  for (const e of onlyR.sort((a, b) => qOf(a, B.get(a)) - qOf(b, B.get(b)))) {
    const r = B.get(e), o = epcOut.get(e), tin = epcIn.get(e), after = o && exportAt && o.at > exportAt, q = qOf(e, r);
    let ev; const sl = epcSold.get(e);
    if (sl && listAt && sl.at > listAt) { soldAfter++; ev = "Đã bán (QR trên đơn = thẻ này): " + soldTxt(sl) + (sl.at < exportAt ? " — bán trong lúc kiểm RFID" : " — sau phiên RFID, trước/trong lúc POS quét"); }
    else if (after) { soldAfter++; ev = "NW đã trừ sau phiên RFID → hàng đã ra khỏi kệ trước khi POS quét"; }
    else if (q > 0 && left >= q - 1e-9) { left -= q; inPack++; ev = "Khớp số lượng: POS đã đếm món này qua QR lốc/hộp ngoài (hoặc QR chưa map) — QR đó không liên kết thẻ này"; }
    else if (q > 0 && vleft >= q - 1e-9) { vleft -= q; soldAfter++; ev = "Có thể đã bán sau phiên RFID (đơn không quét QR thẻ): " + vcodes; }
    else ev = "POS chưa quét QR món này (không thấy đơn bán sau phiên RFID)";
    rowsB.push([p.pid, p.name, e, r.UID || (facts[e] || {}).uid || "", tin ? vn(tin.at) : "", r["Loại"] ? "Ngoại lệ: " + r["Loại"] : "Chi tiết thẻ", r["Tình trạng"] || "", q, o ? `${o.t} ${o.ref || ""} lúc ${vn(o.at)}` : "", ev, ...r2col(e)]);
  }
  const cmp = p.A.size - p.n.late, miss = p.n.miss + p.n.none, unexpl = onlyR.length - soldAfter - inPack, notes = [];
  if (miss) notes.push(`${miss} thẻ POS thấy mà RFID không đọc được`);
  if (unexpl) notes.push(`${unexpl} thẻ RFID đọc mà POS chưa quét QR`);
  if (inPack) notes.push(`${inPack} thẻ RFID đọc nằm trong lốc/hộp POS quét QR ngoài`);
  if (soldAfter) notes.push(`${soldAfter} thẻ đã bán sau khi RFID đọc`);
  if (p.noEpc) notes.push(`${p.noEpc} QR POS chưa liên kết thẻ NW`);
  if (p.n.late) notes.push(`${p.n.late} thẻ gắn sau phiên RFID (không so)`);
  if (p.wrongP) notes.push(`${p.wrongP} thẻ thuộc SP khác`);
  const verdict = miss || unexpl || p.wrongP ? "Lệch" : !onlyR.length && !p.noEpc ? "Khớp từng thẻ" : "Khớp số lượng";
  rowsP.push([p.pid, p.name, exp, p.qr, p.base, p.noEpc, p.A.size, p.n.late, cmp, p.n.read, miss, B.size, onlyR.length, inPack, soldAfter, unexpl, rfBase, p.base - rfBase,
    t["Trạng thái"] || "(không có trong phiên RFID)", t["Dự kiến"], t["Đã đếm"], verdict + (notes.length ? ": " + notes.join("; ") : ": POS và RFID thấy đúng các thẻ như nhau")]);
}

// ---- summary
const allE = new Set(rowsE.filter((r) => r[5]).map((r) => r[5]));
const n = { read: 0, miss: 0, late: 0, none: 0 }; for (const p of P.values()) for (const k in n) n[k] += p.n[k];
const kq = {}; for (const r of rowsQ) { const k = r[9].replace(/\d+\/\d+/, "x/y").replace(/\(\+\d+ /, "(+n "); kq[k] = (kq[k] || 0) + 1; }
const ts = sc.map((s) => s.scanned_at).sort();
const V = rowsP.reduce((o, r) => { const k = r[21].split(":")[0]; o[k] = (o[k] || 0) + 1; return o; }, {});
const sumP = (i) => rowsP.reduce((t, r) => t + (Number(r[i]) || 0), 0);
const tom = [
  ["Phiên POS", `${sess.code} · ${sess.pos_name} · đếm ${sess.counting_mode} · ${sess.status}`],
  ["POS quét QR", vn(ts[0]) + " → " + vn(ts[ts.length - 1])],
  ["Phiên RFID (file)", path.basename(kdF) + ` · app tải danh sách thẻ lúc ${vn(listAt)} · xuất lúc ${vn(exportAt)}`],
  ["Sổ kho NW dùng để xét giờ gắn thẻ", LG.length ? `${LG.length} dòng, đến ${vn(LG.map((r) => r.at).sort().pop())}` : "(không dùng)"],
  ["Mã QR (UID) POS đã quét", sc.length],
  ["→ ra thẻ NW", `${rowsQ.filter((r) => r[8]).length} QR → ${allE.size} EPC`],
  ["→ chưa có thẻ NW", rowsQ.filter((r) => !r[8]).length],
  ["EPC: RFID đọc được", n.read], ["EPC: RFID KHÔNG đọc được", n.miss], ["EPC: không có trong phiên RFID", n.none], ["EPC: gắn/nhập NW sau phiên RFID (không so)", n.late],
  ["Tỉ lệ RFID đọc được thẻ POS đã thấy (trừ thẻ gắn sau)", `${n.read}/${n.read + n.miss + n.none} (${Math.round((100 * n.read) / Math.max(1, n.read + n.miss + n.none))}%)`],
  ...Object.entries(kq).sort((a, b) => b[1] - a[1]).map(([k, v]) => ["Từng QR: " + k, v]),
  ["SP POS đã quét", P.size], ...Object.entries(V).map(([k, v]) => ["SP " + k, v]),
  ["Thẻ RFID đọc mà không thuộc QR POS nào (trong các SP POS đã quét)", `${rowsB.length}: ${sumP(13)} nằm trong lốc/hộp POS quét QR ngoài · ${sumP(14)} đã bán sau khi RFID đọc · ${sumP(15)} POS chưa quét QR`],
  ["Lưu ý", "POS QR chứng minh món hàng có trên kệ lúc POS quét. Một QR POS thường là tem gốc của hộp/thùng nên có thể ra nhiều thẻ NW. Thẻ gắn sau phiên RFID không tính là RFID bỏ sót. Phiên POS chưa đóng (mới quét một phần SP)."],
];
const wb = XLSX.utils.book_new();
const add = (name, aoa, w) => {
  const ws = XLSX.utils.aoa_to_sheet(aoa); ws["!cols"] = w.map((x) => ({ wch: x }));
  if (aoa.length > 1) ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: aoa[0].length - 1 } }) };
  XLSX.utils.book_append_sheet(wb, ws, name);
};
add("Tóm tắt", [["Mục", "Giá trị"], ...tom], [58, 100]);
add("Theo sản phẩm", [["Mã SP", "Tên sản phẩm", "POS dự kiến (gốc)", "POS: số QR đã quét", "POS: SL gốc đã đếm", "QR chưa liên kết thẻ NW", "Thẻ NW của các QR POS", "Trong đó gắn sau phiên RFID", "Thẻ so được", "RFID đọc được", "RFID KHÔNG đọc được", "RFID: thẻ đọc được của SP", "RFID đọc mà không thuộc QR POS nào", "…nằm trong lốc/hộp POS quét QR ngoài", "…đã bán sau khi RFID đọc", "…POS chưa quét QR", "RFID: SL gốc đọc được", "Chênh SL gốc (POS − RFID)", "Trạng thái app RFID", "Dự kiến app RFID", "Đã đếm app RFID", "Kết luận"], ...rowsP], [9, 44, 9, 8, 9, 8, 9, 9, 8, 8, 9, 9, 9, 9, 9, 9, 9, 9, 15, 9, 9, 90]);
add("Từng UID POS", [["STT", "Mã SP", "Tên sản phẩm", "Mã QR POS (UID)", "Đơn vị quét", "Quy đổi", "SL gốc POS", "Cách ra EPC", "Số thẻ NW", "Kết quả so RFID", "Thẻ RFID đọc", "Thẻ RFID không đọc", "Thẻ gắn sau RFID", "Không có trong phiên", "Máy POS", "Giờ quét POS", "EPC"], ...rowsQ], [5, 9, 40, 22, 9, 7, 8, 16, 7, 40, 7, 7, 7, 7, 8, 16, 60]);
add("Từng EPC", [["STT", "Mã SP", "Tên sản phẩm", "Mã QR POS (UID)", "Cách ra EPC", "EPC", "UID trên NW", "Nhập NW lúc", "Phiếu nhập", "Kết quả so RFID", "RFID: tình trạng", "RFID: SL thật", "SL trên thẻ NW", "Trạng thái thẻ NW (hiện tại)", "Máy POS", "Giờ quét POS", ...(R2 ? ["Phiên RFID sau (" + R2.name + ")"] : [])], ...rowsE], [5, 9, 40, 22, 16, 26, 22, 16, 22, 52, 10, 8, 8, 18, 8, 16, 18]);
add("RFID đọc, POS chưa quét", [["Mã SP", "Tên sản phẩm", "EPC", "UID", "Nhập NW lúc", "RFID thấy ở", "RFID: tình trạng", "RFID: SL thật", "NW trừ (loại, phiếu, lúc)", "Đánh giá", ...(R2 ? ["Phiên RFID sau (" + R2.name + ")"] : [])], ...rowsB], [9, 44, 26, 22, 16, 22, 10, 8, 40, 70, 18]);
fs.writeFileSync(out, Buffer.from(XLSX.write(wb, { type: "array", bookType: "xlsx" })));
console.log(tom.map((r) => r.join(": ")).join("\n"));
console.log("\nSP lệch:");
for (const r of rowsP.filter((r) => !r[21].startsWith("Khớp"))) console.log(r[0], String(r[1]).slice(0, 30), "| POS", r[4], "RFID", r[16], "| thẻ", r[6], "đọc", r[9], "✗", r[10], "| chỉ RFID", r[12], "|", r[21].slice(0, 170));
