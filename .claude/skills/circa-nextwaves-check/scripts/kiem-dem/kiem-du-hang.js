// READ-ONLY. Kiểm các mã "Dư hàng" (quét RFID nhiều hơn tồn POS quy ra EPC) trên sheet Summary của user: dư thật hay do POS bán mà NW không trừ.
// Lưu ý cơ chế: NW không trừ thẻ khi POS bán NGUYÊN hộp thì chỉ làm tồn NW cao (thẻ đi theo hàng, không quét thấy) → KHÔNG làm "quét > POS".
// "Quét > POS" chỉ xảy ra khi thẻ còn ở cửa hàng mà POS đã trừ hàng:
//   1 POS bán sau giờ quét SP (sheet lấy tồn POS ~16h, SP quét trước đó) → lúc quét không dư
//   2 Bán lẻ từ hộp có tem: POS trừ viên/vỉ, NW vẫn ghi cả hộp (NW không trừ bán lẻ) → SL quét bị tính cả hộp
//   3 QR trên đơn POS = thẻ này (bán nguyên hộp) mà thẻ vẫn quét thấy sau giờ bán → quét nhầm QR hộp khác / hàng trả lại / bóc tem
//   4 Không có giải thích từ đơn: thẻ nhiều đơn vị → có thể hộp mở dở từ trước khi gắn tem; thẻ = 1 đơn vị → dư thật (POS thấp) hoặc 1 SP dán 2 tem
//   7 SP có thẻ nhiều cỡ (lốc + lẻ): dư tính theo SL, có thể đếm trùng nếu đơn vị lẻ dán tem được lấy ra từ lốc đã có tem → mở lốc đếm
// SL thẻ = SL còn lại trên NW (nhập − phần NW đã trừ một phần, 11–13/11 NW tự trừ cả bán lẻ).
// usage: QR_EPC=<qr-epc.json> node kiem-du-hang.js <rows.txt "pid:D:E:H:flag"> <kiem-ke.xlsx> <PHIEN_DIR> <out.xlsx>
const fs = require("fs"), path = require("path");
const { XLSX, KiemDem } = require("./load-tool.js");
const [ROWS, SESS, PD, OUTF] = process.argv.slice(2);
const ld = (f) => JSON.parse(fs.readFileSync(path.join(PD, f), "utf8"));
const fold0 = KiemDem.fold, UA = { tube: "tuyp" }, fold = (s) => { const f = fold0(s); return UA[f] || f; };
const vnDate = (s) => { const m = String(s).match(/(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+)/); return m ? Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+07:00`) : NaN; };
const fmt = (t) => (isFinite(t) && t > 0 ? new Date(t + 7 * 3600e3).toISOString().slice(0, 16).replace("T", " ") : "");
const r2 = (x) => Math.round(x * 100) / 100;
const rd = (f) => { const wb = XLSX.read(fs.readFileSync(f), { type: "buffer" }); return (n) => (wb.Sheets[n] ? XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: "" }) : []); };
const IN = fs.readFileSync(ROWS, "utf8").trim().split(/\s+/).map((x) => { const [pid, D, E, H, fl] = x.split(":"); return { pid, D: D === "" ? null : +D, E: +E, H: +H, fin: fl[0] === "T" ? "Thiếu hàng" : fl[0] === "D" ? "Đủ hàng" : fl[0] === "X" ? "Dư hàng" : fl, kd: /k$/.test(fl) }; });
const S = rd(SESS), code = (x) => String(x).replace(/^CIRCA-/i, "");
const SP = new Map();
for (const r of S("Danh sách kiểm kê")) { const c = code(r["Mã SP"]); if (!SP.has(c)) SP.set(c, { name: r["Tên sản phẩm"], unit: r["ĐVT"], scan: new Map(), lastScan: 0 }); }
for (const r of S("Chi tiết quét")) { if (r["Trạng thái"] !== "Đã quét") continue; const p = SP.get(code(r["Mã SP"])); if (!p) continue; const t = vnDate(r["Lần quét cuối"]); p.scan.set(String(r.EPC), t); if (t > p.lastScan) p.lastScan = t; }
const NOW = ld("pos-stock-now.json"), SNAP = Date.parse(NOW.at);
const POS = new Map(); for (const r of NOW.rows) { const o = POS.get(r.pid) || { q: 0, base: r.base, name: r.name }; for (const l of r.locs && r.locs.length ? r.locs : [{ loc: "", q: r.q }]) if (fold(l.loc || "") !== "kho that lac") o.q += Number(l.q) || 0; POS.set(r.pid, o); }
// sổ kho NW
const LG = ld("nw-ledger.json").slice().sort((a, b) => a.n - b.n), EQ = new Map(), sizeBy = new Map(), firstIn = new Map(), refsBy = new Map(), inBy = new Map();
for (const r of LG) { const t = Date.parse(r.at); if (r.q > 0) { const per = r.q / ((r.epcs || []).length || 1); for (const e of r.epcs || []) EQ.set(e, per); if (!sizeBy.has(r.c)) sizeBy.set(r.c, {}); sizeBy.get(r.c)[per] = (sizeBy.get(r.c)[per] || 0) + (r.epcs || []).length; if (!firstIn.has(r.c) || t < firstIn.get(r.c)) firstIn.set(r.c, t); const ib = inBy.get(r.c) || { n: 0, q: 0, v: 0, days: new Set() }; ib.n += (r.epcs || []).length; ib.q += r.q; ib.v++; ib.days.add(fmt(t).slice(5, 10)); inBy.set(r.c, ib); } if (r.q < 0) { const per = -r.q / ((r.epcs || []).length || 1); for (const e of r.epcs || []) if (EQ.has(e)) EQ.set(e, Math.max(0, EQ.get(e) - per)); } if (r.q < 0 && r.ref) { if (!refsBy.has(r.c)) refsBy.set(r.c, new Set()); refsBy.get(r.c).add(String(r.ref).replace(/^CIR-/, "")); } }
const QE = process.env.QR_EPC ? JSON.parse(fs.readFileSync(process.env.QR_EPC, "utf8")).res : {};
const mvBy = new Map(), add = (pid, m) => { if (!mvBy.has(pid)) mvBy.set(pid, []); mvBy.get(pid).push(m); };
for (const o of ld("pos-orders.json")) { if (o.err) continue; const t = Date.parse(o.completed_date); for (const it of o.items) add(it.product_id, { t, base: Number(it.base_quantity) || 0, ref: o.code, nwDed: (refsBy.get(it.product_id) || new Set()).has(o.code), epcs: [...new Set((it.qr || []).flatMap((q) => (QE[q] && QE[q].epcs) || []))] }); }
for (const tr of ld("pos-trf.json")) { if (tr.status !== "COMPLETED") continue; const t = Date.parse(tr.completed_at); for (const it of tr.items) add(it.product_id, { t, base: Number(it.base_quantity) || it.detailQty || 0, ref: tr.code, nwDed: (refsBy.get(it.product_id) || new Set()).has(tr.code), epcs: [...new Set((it.qr || []).flatMap((q) => (QE[q] && QE[q].epcs) || []))] }); }
const KL = { AFTER: "1. Không dư: POS bán sau giờ quét", OK: "1. Không dư: POS bán sau giờ quét", LOOSE: "2. Không dư thật: POS đã bán lẻ từ hộp, NW vẫn ghi cả hộp", OPEN: "3. Không dư thật (nhiều khả năng): hộp mở dở từ trước khi gắn tem", QR: "4. POS đã bán đúng thẻ này mà thẻ vẫn quét thấy", WHOLE: "5. Nghi dư: hàng chỉ bán nguyên hộp mà quét nhiều hộp hơn POS", REAL: "6. Dư thật / dán trùng tem: thẻ = 1 đơn vị, quét nhiều hơn POS", NEST: "7. Thẻ lốc + thẻ lẻ: cần mở lốc đếm (có thể đếm trùng)" };
const rows = [], G = {};
for (const x of IN) {
  const c = x.pid, p = SP.get(c), pos = POS.get(c);
  const base = pos ? pos.base : (p && p.unit) || "", name = (p && p.name) || (pos && pos.name) || "";
  const sz = sizeBy.get(c) ? +Object.entries(sizeBy.get(c)).sort((u, v) => v[1] - u[1])[0][0] : 1;
  const scan = p ? [...p.scan.entries()] : [], Q = scan.length, Qq = scan.reduce((s, [e]) => s + (EQ.has(e) ? EQ.get(e) : sz), 0);
  const szMax = scan.reduce((m, [e]) => Math.max(m, EQ.has(e) ? EQ.get(e) : sz), 0) || sz;
  const tScan = (p && p.lastScan) || 0, ms = (mvBy.get(c) || []).sort((a, b) => a.t - b.t);
  const szMin = scan.reduce((m, [e]) => Math.min(m, EQ.has(e) ? EQ.get(e) : sz), Infinity);
  const nested = isFinite(szMin) && szMax > szMin + 1e-9;
  const isLoose = (m) => { const u = nested ? szMin : szMax; return u > 1 && Math.abs(m.base / u - Math.round(m.base / u)) > 1e-6; };
  const everLoose = ms.filter(isLoose).length;
  const S_now = pos ? pos.q : 0;
  const after = ms.filter((m) => m.t > tScan && m.t <= SNAP).reduce((s, m) => s + m.base, 0);
  const S_scan = Math.max(0, S_now + after);
  const S16 = Math.max(0, S_now + ms.filter((m) => m.t > Date.parse("2026-11-19T16:00:00+07:00") && m.t <= SNAP).reduce((s, m) => s + m.base, 0));
  const Epos = Math.ceil(S_scan / sz - 1e-9);
  const overQ = r2(Qq - S_scan), overT = Q - Epos;
  const fi = firstIn.get(c) || 0;
  const since = ms.filter((m) => m.t >= fi && m.t <= tScan && !m.nwDed);
  // bán lẻ: phần lẻ của từng dòng (không chia hết cỡ thẻ)
  const looseLines = since.filter(isLoose);
  const looseU = r2(looseLines.reduce((s, m) => s + (m.base % (nested ? szMin : szMax)), 0));
  const looseAllL = ms.filter((m) => m.t <= tScan && isLoose(m)), looseAll = r2(looseAllL.reduce((s, m) => s + (m.base % (nested ? szMin : szMax)), 0)); // cả trước khi gắn thẻ: NW vẫn nhập cả hộp
  // QR trên đơn = thẻ đang quét thấy, quét SAU giờ bán
  const qrHit = []; for (const m of since) for (const e of m.epcs) if (p && p.scan.has(e) && p.scan.get(e) > m.t) qrHit.push({ e, m, whole: m.base >= (EQ.get(e) || sz) - 1e-9 });
  const qrWhole = qrHit.filter((h) => h.whole), qrLoose = qrHit.filter((h) => !h.whole);
  let k, why;
  if (overQ <= 1e-9 && overT <= 0) { const dropped = r2(S_scan - S16); k = dropped > 0 ? KL.AFTER : KL.OK; why = `Lúc quét (${fmt(tScan)}) POS ${r2(S_scan)} ${base} ≥ SL quét ${r2(Qq)}` + (dropped > 0 ? ` · bán ${dropped} ${base} sau giờ quét nên sheet (POS ~16h) thấy dư` : " · POS đã thay đổi so với lúc làm sheet"); }
  else {
    const ib = inBy.get(c) || { n: 0, q: 0, v: 0, days: new Set() };
    const inTxt = ` · NW nhập ${ib.n} thẻ qua ${ib.v} lần (${[...ib.days].join(", ")})`;
    const big = scan.filter(([e]) => (EQ.has(e) ? EQ.get(e) : sz) > szMin + 1e-9), small = scan.length - big.length;
    if (szMax > 1 && looseAll > 0 && overQ <= looseAll + 1e-9) { k = KL.LOOSE; why = `Dư ${overQ} ${base} (${overT > 0 ? overT + " thẻ" : "< 1 thẻ"}) ≤ ${looseAll} ${base} POS đã bán lẻ từ 06/11 (${looseAllL.length} đơn, trong đó ${looseLines.length} đơn sau khi gắn thẻ; POS trừ từng viên, NW vẫn ghi cả hộp) → hộp đã mở, không dư thật` + (qrLoose.length ? ` · ${qrLoose.length} thẻ có QR quét lúc bán lẻ` : ""); }
    else if (nested) { k = KL.NEST; why = `Thẻ nhiều cỡ: ${big.length} thẻ lớn (${[...new Set(big.map(([e]) => r2(EQ.has(e) ? EQ.get(e) : sz)))].join("/")} ${base}) + ${small} thẻ nhỏ (${r2(szMin)} ${base}) = ${r2(Qq)} ${base}, POS lúc quét ${r2(S_scan)} → dư ${overQ} ${base} (= ${r2(overQ / szMin)} × ${r2(szMin)} ${base}). Nếu các đơn vị nhỏ dán tem riêng được lấy ra từ lốc/hộp đã có tem thì lốc ghi thừa → không dư thật (sửa SL thẻ lốc); nếu lốc còn nguyên thì dư thật (POS thấp) → mở lốc đếm` + (looseAll ? ` · POS bán lẻ ${looseAll} ${base} từ 06/11` : "") + inTxt; }
    else if (szMax > 1 && (everLoose > 0 || !ms.length) && Q <= S_scan) { k = KL.OPEN; why = `Dư ${overQ} ${base} (${overT} thẻ). ` + (everLoose ? `SP có bán lẻ (${everLoose} đơn từ 06/11)` : `Chưa có đơn bán từ 06/11 để đối chiếu`) + ` ; ${Q} hộp vẫn ≤ ${r2(S_scan)} ${base} POS → các hộp đã mở dở từ trước khi gắn tem (NW ghi cả hộp ${r2(szMax)}) → không dư thật; muốn chắc thì đếm số lẻ trong hộp mở`; }
    else if (qrWhole.length) { k = KL.QR; why = `${qrWhole.length} thẻ có QR trên đơn POS bán nguyên nhưng vẫn quét thấy sau giờ bán: ` + qrWhole.slice(0, 3).map((h) => `${h.m.ref} ${fmt(h.m.t)} → quét ${fmt(p.scan.get(h.e))}`).join("; ") + " → thu ngân quét nhầm QR hộp khác / hàng trả lại / thẻ bóc ra còn trong cửa hàng"; }
    else { k = szMax > 1 && Q <= S_scan ? KL.WHOLE : KL.REAL; why = (szMax <= 1 ? `Mỗi thẻ = 1 ${base}` : everLoose ? `Số hộp ${Q} > ${r2(S_scan)} ${base} POS (không thể mở dở hết)` : `SP chỉ bán nguyên ${r2(szMax)} ${base}, không có đơn bán lẻ → không phải hộp mở dở`) + `: quét ${Q} thẻ = ${r2(Qq)} ${base}, POS lúc quét ${r2(S_scan)} → dư ${overQ} ${base}` + inTxt + ` → kiểm có dán 2 tem / nhập trùng thẻ cho 1 hộp không; nếu đúng là thừa hàng thì POS thấp (nhập/trả hàng chưa ghi POS)`; }
  }
  G[k] = (G[k] || 0) + 1;
  const wholeSold = since.filter((m) => m.base >= sz - 1e-9).reduce((s, m) => s + Math.floor(m.base / sz + 1e-9), 0);
  rows.push([c, name, x.D ?? "", x.E, x.H, x.fin + (x.kd ? " · Đã kiểm đủ" : ""), base, r2(sz), r2(S16), r2(S_scan), Epos, Q, r2(Qq), overT, overQ, since.length, wholeSold, looseLines.length, looseU, qrWhole.length, qrLoose.length, k, why, tScan ? fmt(tScan) : "", Object.keys(sizeBy.get(c) || {}).length > 1 ? "thẻ nhiều cỡ: " + Object.entries(sizeBy.get(c)).map(([s0, n]) => n + "×" + r2(+s0)).join(" + ") : ""]);
}
rows.sort((u, v) => u[21].localeCompare(v[21]) || v[13] - u[13] || v[14] - u[14]);
const H = ["Mã SP", "Tên sản phẩm", "Sheet: POS→EPC", "Sheet: quét", "Sheet: thực dán", "Sheet: Final phân loại", "ĐV POS", "Cỡ thẻ (ĐV POS)", "Tồn POS ~16h", "Tồn POS lúc quét SP", "POS lúc quét quy ra EPC", "Quét được (EPC)", "Quét được (SL)", "Dư (EPC)", "Dư (SL)", "Dòng bán từ khi gắn thẻ (NW chưa trừ)", "Trong đó thẻ bán nguyên", "Dòng bán lẻ", "SL bán lẻ sau gắn thẻ (POS trừ, NW không trừ)", "Thẻ có QR bán nguyên mà vẫn quét thấy", "Thẻ có QR bán lẻ", "Kết luận", "Giải thích", "Quét SP lần cuối", "Ghi chú"];
const out = XLSX.utils.book_new();
const addS = (n, arr, w) => { const ws = XLSX.utils.aoa_to_sheet(arr); ws["!cols"] = w.map((v) => ({ wch: v })); if (arr.length > 1) ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: arr.length - 1, c: arr[0].length - 1 } }) }; XLSX.utils.book_append_sheet(out, ws, n); };
addS("Dư hàng " + rows.length + " mã", [H, ...rows], [9, 44, 8, 7, 7, 14, 7, 8, 8, 9, 8, 8, 8, 7, 8, 9, 8, 8, 9, 9, 8, 44, 90, 16, 30]);
addS("Tổng hợp", [["Kết luận", "Số mã"], ...Object.entries(G).sort(), ["Tổng", rows.length], [], ["Cơ chế", "NW không trừ thẻ khi POS bán NGUYÊN hộp → chỉ làm tồn NW cao, thẻ đi theo hàng nên KHÔNG quét thấy → không gây 'dư'. 'Quét > POS' chỉ do thẻ còn ở cửa hàng mà POS đã trừ: bán lẻ từ hộp, bán sau giờ quét, quét nhầm QR, hoặc POS thấp thật."]], [55, 120]);
fs.writeFileSync(OUTF, Buffer.from(XLSX.write(out, { type: "array", bookType: "xlsx" })));
console.log(JSON.stringify(G));
