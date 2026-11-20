// SL thẻ = SL còn lại trên NW (nhập − phần NW đã trừ: 11–13/11 NW tự trừ cả bán lẻ, VD 10772 thẻ 6 miếng trừ 4 còn 2).
// READ-ONLY (chỉ đọc file + master Google Sheet trong bộ nhớ, không gọi API NW/POS). Kiểm lại từng mã "Thiếu hàng" (sheet Summary) theo SỐ LƯỢNG từng thẻ:
//   S  = tồn POS lúc quét SP = POS lúc kéo + bán/TRF/đơn chờ giao tạo SAU giờ quét SP (bỏ Kho thất lạc)
//   Qq = Σ SL ghi trên từng thẻ đã quét (kể cả thẻ nằm ở "Thẻ lạ" vì nhập NW sau lúc tải danh sách)
//   thiếu d = S − Qq. d ≤ 0 → không thiếu lúc quét.
//   Thẻ NW chưa quét (danh sách phiên) tách: nhập NW sau giờ quét SP / QR trên đơn POS = thẻ này (bán đủ SL thẻ, NW chưa trừ) / còn lại R.
//   Cần tìm = số thẻ R ít nhất phủ d (ưu tiên thẻ quét thấy gần nhất); thẻ R còn lại = đã bán/chuyển NW chưa trừ (POS đã trừ nên không cần tìm).
//   Phần d không thẻ nào phủ được = POS cao hơn hàng có thẻ (hàng chưa gắn tem / POS sai).
//   Không phụ thuộc quy đổi master (master chỉ để đối chiếu cột sheet D = ⌈POS ÷ quy đổi⌉).
// usage: node kiem-thieu-hang.js <rows.txt "pid:D:E:H:flag"> <kiem-ke.xlsx> <phan-tich.xlsx (lấy "quét thấy lần cuối")> <PHIEN_DIR> <out.xlsx> [kết quả bản trước.xlsx]
// env NO_MASTER=1 bỏ đọc master; SHEET_AT="2026-11-19T16:00:00+07:00" giờ làm sheet.
const fs = require("fs"), path = require("path");
const { XLSX, KiemDem } = require("./load-tool.js");
const [ROWS, SESS, ANA, PD, OUTF, PREVF] = process.argv.slice(2);
const ld = (f) => JSON.parse(fs.readFileSync(path.join(PD, f), "utf8"));
const fold0 = KiemDem.fold, UA = { tube: "tuyp" }, fold = (s) => { const f = fold0(s); return UA[f] || f; };
const vnDate = (s) => { const m = String(s).match(/(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+)/); return m ? Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+07:00`) : NaN; };
const fmt = (t) => (isFinite(t) && t > 0 ? new Date(t + 7 * 3600e3).toISOString().slice(0, 16).replace("T", " ") : "");
const r2 = (x) => Math.round(x * 100) / 100;
const rd = (f) => { const wb = XLSX.read(fs.readFileSync(f), { type: "buffer" }); return (n) => (wb.Sheets[n] ? XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: "" }) : []); };
const SHEET_AT = Date.parse(process.env.SHEET_AT || "2026-11-19T16:00:00+07:00");
(async () => {
  const IN = fs.readFileSync(ROWS, "utf8").trim().split(/\s+/).map((x) => { const [pid, D, E, H, fl] = x.split(":"); return { pid, D: D === "" ? null : +D, E: +E, H: +H, fin: fl[0] === "T" ? "Thiếu hàng" : fl[0] === "D" ? "Đủ hàng" : fl[0] === "X" ? "Dư hàng" : fl, kd: /k$/.test(fl) }; });
  // ---- phiên
  const S = rd(SESS), ov = Object.fromEntries(S("Tổng quan").map((r) => [r["Chỉ tiêu"], r["Giá trị"]]));
  const sessStart = vnDate(ov["Tạo lúc"]);
  const code = (x) => String(x).replace(/^CIRCA-/i, "");
  const SP = new Map();
  for (const r of S("Danh sách kiểm kê")) { const c = code(r["Mã SP"]); const p = SP.get(c) || { name: r["Tên sản phẩm"], unit: r["ĐVT"], scan: new Map(), miss: [], lastScan: 0, strange: [], soldScanned: 0 }; p.miss.push(...String(r["EPC chưa quét (có thể thiếu)"] || "").split(/[,;\s]+/).filter(Boolean)); SP.set(c, p); }
  let sessEnd = 0;
  for (const r of S("Chi tiết quét")) { const p = SP.get(code(r["Mã SP"])); const t = vnDate(r["Lần quét cuối"]); if (t > sessEnd) sessEnd = t; if (!p) continue; if (r["Trạng thái"] !== "Đã quét") { p.soldScanned++; continue; } p.scan.set(String(r.EPC), t); if (t > p.lastScan) p.lastScan = t; }
  // ---- quét thấy ở phiên trước (từ phan-tich)
  const lastSeen = new Map(); for (const r of rd(ANA)("EPC thiếu")) if (r["Quét thấy lần cuối (phiên trước)"]) lastSeen.set(String(r.EPC), String(r["Quét thấy lần cuối (phiên trước)"]));
  const seenT = (lbl) => { const m = String(lbl || "").match(/(\d+)\/(\d+) (\d+):(\d+)/); return m ? Date.parse(`2026-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T${m[3].padStart(2, "0")}:${m[4]}:00+07:00`) : 0; };
  // ---- sổ kho NW
  const LG = ld("nw-ledger.json").slice().sort((a, b) => a.n - b.n);
  const PART = new Map(), ORIG = new Map(); // NW trừ một phần SL trên thẻ (tự trừ 11–13/11), thẻ vẫn active với SL còn lại
  const EQ = new Map(), EIN = new Map(), EC = new Map(), EOUT = new Map(), sizeBy = new Map(), firstIn = new Map(), nwBase = new Map(), refsBy = new Map();
  for (const r of LG) {
    const t = Date.parse(r.at);
    if (r.q > 0) { const per = r.q / ((r.epcs || []).length || 1); for (const e of r.epcs || []) { EQ.set(e, per); ORIG.set(e, per); EIN.set(e, t); EC.set(e, r.c); EOUT.delete(e); } if (!sizeBy.has(r.c)) sizeBy.set(r.c, {}); sizeBy.get(r.c)[per] = (sizeBy.get(r.c)[per] || 0) + (r.epcs || []).length; if (!firstIn.has(r.c) || t < firstIn.get(r.c)) firstIn.set(r.c, t); if (r.base) nwBase.set(r.c, r.base); }
    else if (r.q < 0) { const per = -r.q / ((r.epcs || []).length || 1); for (const e of r.epcs || []) { const v = (EQ.get(e) || 0) - per; EQ.set(e, Math.max(0, v)); if (v <= 1e-9) EOUT.set(e, String(r.ref || "")); else PART.set(e, String(r.ref || "").replace(/^CIR-/, "")); } if (r.ref) { if (!refsBy.has(r.c)) refsBy.set(r.c, new Set()); refsBy.get(r.c).add(String(r.ref).replace(/^CIR-/, "")); } }
  }
  const NWP = new Map(); for (const [e, c] of EC) { const p = NWP.get(c) || { inn: 0, outOrd: 0, outOut: 0, outOther: 0, active: 0, activeQ: 0 }; p.inn++; const o = EOUT.get(e); if (o === undefined) { p.active++; p.activeQ += EQ.get(e); } else if (/CIR-/.test(o)) p.outOrd++; else if (/\/OUT\//.test(o)) p.outOut++; else p.outOther++; NWP.set(c, p); }
  // thẻ lạ đã đăng ký NW (nhập sau lúc phiên tải danh sách) = có đọc được
  for (const r of S("Thẻ lạ")) { const e = String(r.EPC); const c = EC.get(e); if (c && SP.has(c)) SP.get(c).strange.push(e); }
  // ---- POS
  const NOW = ld("pos-stock-now.json"), SNAP = Date.parse(NOW.at);
  const POS = new Map();
  for (const r of NOW.rows) { const o = POS.get(r.pid) || { q: 0, base: r.base, name: r.name, locs: {} }; for (const l of r.locs && r.locs.length ? r.locs : [{ loc: "", q: r.q }]) { if (fold(l.loc || "") === "kho that lac") continue; o.q += Number(l.q) || 0; if (Number(l.q)) o.locs[l.loc || "?"] = (o.locs[l.loc || "?"] || 0) + Number(l.q); } POS.set(r.pid, o); }
  const QE = process.env.QR_EPC ? JSON.parse(fs.readFileSync(process.env.QR_EPC, "utf8")).res : {};
  const mvBy = new Map(), addMv = (pid, m) => { if (!mvBy.has(pid)) mvBy.set(pid, []); mvBy.get(pid).push(m); };
  const mk = (it, t, ref, ch, td) => ({ t, td: td || t, base: Number(it.base_quantity) || it.detailQty || 0, ref, ch, nwDed: (refsBy.get(it.product_id) || new Set()).has(ref), epcs: [...new Set((it.qr || []).flatMap((q) => (QE[q] && QE[q].epcs) || []))] });
  for (const o of ld("pos-orders.json")) { if (o.err) continue; const t = Date.parse(o.completed_date); for (const it of o.items) addMv(it.product_id, mk(it, t, o.code, o.type === "ONLINE" ? "ONLINE" : "OFFLINE", Math.min(t, Date.parse(o.created_date) || t))); }
  for (const tr of ld("pos-trf.json")) { if (tr.status !== "COMPLETED") continue; const t = Date.parse(tr.completed_at); for (const it of tr.items) addMv(it.product_id, mk(it, t, tr.code, "TRF")); }
  for (const o of ld("pos-pending.json")) { if (o.err || !/AWAITING_SHIPMENT|SHIPPING|READY_TO_PICK/.test(o.status)) continue; const t = Date.parse(o.created_date); for (const it of o.items) addMv(it.product_id, mk(it, t, o.code + " (" + o.status + ")", "CHỜ GIAO")); }
  // ---- master (chỉ để đối chiếu cột sheet)
  let M = null;
  if (!process.env.NO_MASTER) {
    const gv = "https://docs.google.com/spreadsheets/d/18nLllIlORaki3por1diKzNo2tWvdVyUnB1xbZXDv8Xc/gviz/tq?tqx=out:csv&headers=1&sheet=";
    const v4 = await (await fetch(gv + encodeURIComponent("final data v4") + "&tq=" + encodeURIComponent("select A,B,C,D,E"))).text();
    const ad = await (await fetch(gv + "Adhoc")).text();
    if (!/^"product_id","product_name","convert_unit"/.test(v4)) throw new Error("master: sai tab");
    const mw = XLSX.utils.book_new(); for (const [n, c] of [["final data v4", v4], ["Adhoc", ad]]) { const w = XLSX.read(c, { type: "string", raw: true, dense: true }); XLSX.utils.book_append_sheet(mw, w.Sheets[w.SheetNames[0]], n); }
    M = KiemDem.loadMaster(mw);
  }
  const KL = {
    OK: "A. Không thiếu lúc quét (SL quét ≥ POS)",
    NEST: "A2. Có thể đủ: cần xem tận nơi (thẻ lốc + lẻ, hoặc đọc được thẻ NW đã xuất)",
    SCAN: "B. Quét sót: thẻ chưa quét đủ bù phần thiếu",
    SCANPOS: "C. Quét sót + POS vẫn cao hơn hàng có thẻ",
    LATE: "D. Hàng gắn tem sau giờ quét (không phải quét sót)",
    POS: "E. Không còn thẻ chưa quét: POS cao hơn hàng có thẻ",
    NOTAG: "F. Chưa có thẻ NW",
  };
  const rows = [], G = {};
  for (const x of IN) {
    const c = x.pid, p = SP.get(c) || { name: "", unit: "", scan: new Map(), miss: [], lastScan: 0, strange: [], soldScanned: 0 }, pos = POS.get(c);
    const name = p.name || (pos && pos.name) || "";
    const base = pos ? pos.base : p.unit || "";
    const nw = NWP.get(c) || { inn: 0, outOrd: 0, outOut: 0, outOther: 0, active: 0, activeQ: 0 };
    const sz = sizeBy.get(c) ? +Object.entries(sizeBy.get(c)).sort((u, v) => v[1] - u[1])[0][0] : null;
    const q = (e) => (EQ.has(e) ? EQ.get(e) : sz || 0);
    const sum = (l) => r2(l.reduce((s, e) => s + q(e), 0));
    const tScan = p.lastScan || sessEnd, lateCut = p.lastScan || sessStart;
    const ms = (mvBy.get(c) || []).sort((a, b) => a.t - b.t);
    const S_now = pos ? pos.q : 0;
    const after = ms.filter((m) => m.td > tScan && m.td <= SNAP).reduce((s, m) => s + m.base, 0);
    const S_ = r2(Math.max(0, S_now + after));
    const S16 = r2(Math.max(0, S_now + ms.filter((m) => m.td > SHEET_AT && m.td <= SNAP).reduce((s, m) => s + m.base, 0)));
    const me = M && M.get(c), mr = me && base ? KiemDem.masterRatio(me, base) : null;
    const conv = mr ? mr[1] : sz; // quy đổi sheet dùng (master)
    const D16 = conv ? Math.ceil(S16 / conv - 1e-9) : null, Dscan = conv ? Math.ceil(S_ / conv - 1e-9) : null;
    const scanned = [...p.scan.keys(), ...p.strange];
    const Q = scanned.length, Qq = sum(scanned);
    const d = r2(S_ - Qq);
    const late = p.miss.filter((e) => (EIN.get(e) || 0) > lateCut), lateSet = new Set(late);
    const missEff = p.miss.filter((e) => !lateSet.has(e));
    // QR trên đơn POS = thẻ chưa quét, cộng dồn SL bán qua QR ≥ SL thẻ → thẻ đã đi (NW chưa trừ)
    const fi = firstIn.get(c) || 0, missSet = new Set(missEff), acc = new Map(), qrSold = new Map();
    for (const m of ms) { if (m.t < fi - 864e5 || m.t > tScan || m.nwDed) continue; let rem = m.base; for (const e of m.epcs) { if (rem <= 1e-9) break; if (!missSet.has(e) || qrSold.has(e) || seenT(lastSeen.get(e)) > m.t) continue; const g = Math.min(rem, Math.max(0, q(e) - (acc.get(e) || 0))); acc.set(e, (acc.get(e) || 0) + g); rem -= g; if (acc.get(e) >= q(e) - 1e-9) qrSold.set(e, m); } }
    const R = missEff.filter((e) => !qrSold.has(e)), Rq = sum(R), lateQ = sum(late);
    const need = Math.max(0, d);
    // chọn thẻ cần tìm: thẻ quét thấy gần nhất trước, rồi thẻ lớn trước (ít thẻ nhất)
    const cand = R.slice().sort((a, b) => seenT(lastSeen.get(b)) - seenT(lastSeen.get(a)) || q(b) - q(a));
    const find = []; let fq = 0; for (const e of cand) { if (fq >= need - 1e-9) break; find.push(e); fq += q(e); }
    const restR = R.filter((e) => !find.includes(e));
    const goneQ = r2(sum(restR) + sum([...qrSold.keys()]));
    const t0 = [...restR, ...qrSold.keys()].reduce((m, e) => Math.min(m, EIN.get(e) || fi), Infinity);
    const evQ = isFinite(t0) ? r2(ms.filter((m) => m.t >= t0 - 864e5 && m.t <= tScan && !m.nwDed).reduce((s0, m) => s0 + m.base, 0)) : 0;
    const noEv = r2(Math.max(0, goneQ - evQ));
    const findAfter = find.map((e) => { const o = EOUT.get(e); const m = ms.find((m0) => m0.t > tScan && m0.epcs.includes(e)); return m ? e.slice(-4) + " bán " + m.ref + " " + fmt(m.t) : o !== undefined ? e.slice(-4) + " NW xuất " + o.split("-/").pop() : ""; }).filter(Boolean);
    const lateUse = r2(Math.min(Math.max(0, need - Rq), lateQ));
    const u = r2(Math.max(0, need - Rq - lateQ)); // POS cao hơn mọi hàng có thẻ
    // bán từ khi gắn thẻ đến lúc quét, NW chưa trừ
    const since = ms.filter((m) => m.t >= fi && m.t <= tScan && !m.nwDed), sinceQ = r2(since.reduce((s, m) => s + m.base, 0));
    const sizes = Object.keys(sizeBy.get(c) || {}).map(Number).sort((a, b) => a - b);
    const nested = sizes.length > 1 && sizes.some((b) => sizes.some((a) => a < b && Math.abs(b / a - Math.round(b / a)) < 1e-6));
    const uMin = sizes[0] || sz || 1;
    const looseQ = r2(since.reduce((s, m) => s + (uMin > 1 ? m.base % uMin : 0), 0));
    const eq = (v) => (sz ? r2(v / sz) : "");
    const baseMism = nwBase.has(c) && base && fold(nwBase.get(c)) !== fold(base) ? `ĐV NW "${nwBase.get(c)}" ≠ ĐV POS "${base}"` : "";
    const seenTxt = (l) => { const o = {}; for (const e of l) { const s0 = lastSeen.get(e) || "chưa từng thấy"; o[s0] = (o[s0] || 0) + 1; } return Object.entries(o).map(([k, v]) => v + " thẻ " + (k === "chưa từng thấy" ? k : "thấy lần cuối " + k)).join(", "); };
    let k, why;
    const sizes0 = Object.keys(sizeBy.get(c) || {}).map(Number).sort((a, b) => a - b), uMin0 = sizes0[0] || sz || 1;
    const bigQ = r2(scanned.filter((e) => q(e) > uMin0 + 1e-9).reduce((s0, e) => s0 + q(e), 0));
    const nested0 = sizes0.length > 1 && sizes0.some((b) => sizes0.some((a) => a < b && Math.abs(b / a - Math.round(b / a)) < 1e-6));
    const outRead = scanned.filter((e) => EOUT.has(e)), outQ = r2(outRead.reduce((s0, e) => s0 + (ORIG.get(e) || 0), 0));
    if (d > 1e-9 && outQ >= d - 1e-9) { k = KL.NEST; why = `Thiếu ${d} ${base} theo thẻ còn active, nhưng đọc được ${outRead.length} thẻ NW đã xuất (${outRead.map((e) => e.slice(-4) + " " + r2(ORIG.get(e)) + " " + base + " " + EOUT.get(e).split("-/").pop()).join("; ")}) đủ bù. Xem tận nơi: thẻ cũ còn dán trên hộp đã dán tem mới (dán lại tem) thì thiếu thật ${d}; nếu là hộp khác thì hàng có thật, phiếu xuất NW sai → đủ`; }
    else if (d <= 1e-9 && nested0 && Qq - bigQ < S_ - 1e-9) { k = KL.NEST; why = `Quét ${Q} thẻ = ${Qq} ${base} ≥ POS lúc quét ${S_}, trong đó thẻ lốc/hộp lớn = ${bigQ} ${base}. Nếu các đơn vị lẻ có tem riêng được lấy ra từ chính các lốc đó thì hàng thực chỉ ${r2(Qq - bigQ)}–${Qq} ${base} → có thể thiếu tới ${r2(S_ - (Qq - bigQ))} ${base}. Mở lốc đếm: lốc còn nguyên thì đủ (dư ${r2(-d)}), lốc rỗng/thiếu thì sửa SL thẻ lốc trên NW`; }
    else if (d <= 1e-9) { k = KL.OK; why = `Lúc quét (${fmt(tScan)}) POS ${S_} ${base} ≤ quét ${Q} thẻ = ${Qq} ${base}` + (S16 !== S_ ? ` · POS ~16h ${S16} (bán ${r2(S16 - S_)} trước giờ quét / sau 16h)` : "") + (x.D !== Dscan ? ` · sheet ghi POS ${x.D} EPC, lúc quét ${Dscan}` : ""); }
    else if (!nw.inn && !Q) { k = KL.NOTAG; why = `NW chưa từng nhập thẻ cho mã này; POS lúc quét ${S_} ${base}` + (conv ? ` ≈ ${Dscan} EPC (quy đổi ${r2(conv)})` : "") + " → gắn tem hoặc đếm tay"; }
    else if (Rq > 0 && Rq >= need - 1e-9) { k = KL.SCAN; why = `Thiếu ${d} ${base} (≈ ${eq(d)} thẻ). Còn ${R.length} thẻ NW chưa quét = ${Rq} ${base} → cần tìm tối thiểu ${find.length} thẻ (${r2(fq)} ${base}; ${seenTxt(find)})` + (restR.length ? `; ${restR.length} thẻ còn lại vượt phần POS cần → POS đã bán/chuyển, NW chưa trừ (không cần tìm)` : "") + (findAfter.length ? ` · thẻ cần tìm đã đi SAU giờ quét (xác nhận có hàng lúc quét, nay khỏi tìm): ${findAfter.join("; ")}` : ""); }
    else if (Rq > 0) { k = KL.SCANPOS; why = `Thiếu ${d} ${base}. Mọi ${R.length} thẻ chưa quét chỉ có ${Rq} ${base} (${seenTxt(R)}) → tìm hết vẫn thiếu ${r2(need - Rq)} ${base}` + (lateQ ? `; ${late.length} thẻ nhập NW sau giờ quét = ${lateQ} ${base} bù được ${lateUse}` : "") + (u > 0 ? ` → POS cao hơn mọi hàng có thẻ ${u} ${base} (≈ ${eq(u)} thẻ): hàng chưa gắn tem / POS sai` : ""); }
    else if (lateQ > 0 && lateQ >= need - 1e-9) { k = KL.LATE; why = `Thiếu ${d} ${base} lúc quét, nhưng ${late.length} thẻ nhập NW sau giờ quét SP (${[...new Set(late.map((e) => fmt(EIN.get(e))))].slice(0, 3).join(", ")}) = ${lateQ} ${base} đủ bù → hàng có thật, gắn tem sau khi quét; quét lại các thẻ này`; }
    else { k = KL.POS; why = `Mọi thẻ còn đã quét (${Q} thẻ = ${Qq} ${base})` + (qrSold.size ? `, ${qrSold.size} thẻ chưa quét có QR trên đơn bán (NW chưa trừ)` : "") + (lateQ ? `, ${late.length} thẻ nhập sau giờ quét = ${lateQ}` : "") + `; POS lúc quét ${S_} ${base} → POS cao hơn hàng có thẻ ${u} ${base} (≈ ${eq(u)} thẻ ${r2(sz || 0)} ${base})` + (Object.keys(pos ? pos.locs : {}).length > 1 ? ` · POS chia vị trí: ${Object.entries(pos.locs).map(([l, v]) => l + " " + v).join(", ")}` : "") + " → hàng chưa gắn tem / POS sai"; }
    const notes = [
      nested ? `thẻ lốc + thẻ lẻ (${Object.entries(sizeBy.get(c)).map(([s0, n]) => n + "×" + r2(+s0)).join(" + ")}): nếu đơn vị lẻ lấy từ lốc đã có tem thì SL quét bị tính trùng → thiếu thực còn lớn hơn` : sizes.length > 1 ? "thẻ nhiều cỡ: " + Object.entries(sizeBy.get(c)).map(([s0, n]) => n + "×" + r2(+s0)).join(" + ") : "",
      looseQ > 0 ? `bán lẻ ${looseQ} ${base} từ khi gắn thẻ (POS trừ, NW vẫn ghi cả hộp) → nếu hộp mở dở còn trên kệ thì SL thực ít hơn SL quét` : "",
      mr && sz && Math.abs(mr[1] - sz) > 1e-6 ? `master 1 ${mr[0]} = ${r2(mr[1])} ${base}, thẻ NW ghi ${r2(sz)} ${base}` : !mr ? "chưa có master" : "",
      baseMism, p.strange.length ? `${p.strange.length} thẻ đọc được ở "Thẻ lạ" (nhập NW sau lúc tải danh sách) đã tính vào quét` : "",
      noEv > 0 ? `thẻ chưa quét coi là đã đi = ${goneQ} ${base} nhưng đơn bán/TRF từ khi nhập các thẻ đó chỉ ${evQ} → ${noEv} ${base} không thấy đơn (nhập NW dư / POS đã chỉnh giảm / hàng mất đã điều chỉnh POS)` : "",
      [...scanned, ...p.miss].some((e) => PART.has(e)) ? `NW đã trừ một phần SL trên thẻ (${[...scanned, ...p.miss].filter((e) => PART.has(e)).map((e) => e.slice(-4) + " còn " + r2(EQ.get(e)) + " sau " + PART.get(e)).join("; ")}) → tính theo SL còn lại` : "",
      p.soldScanned ? `${p.soldScanned} thẻ NW đã trừ (bán) mà vẫn quét thấy, không tính` : "",
      x.D !== null && D16 !== null && x.D !== D16 && !(sz && x.D === Math.ceil(S16 / sz - 1e-9)) ? `POS ~16h tái dựng ${S16} ${base} → ${D16} EPC ≠ sheet ${x.D}: POS đổi không qua đơn bán (nhập/điều chỉnh) hoặc sheet quy đổi khác` : "",
    ].filter(Boolean).join(" · ");
    G[k] = (G[k] || 0) + 1;
    rows.push({ k, d, row: [c, name, x.D ?? "", x.E, x.H, x.fin + (x.kd ? " · Đã kiểm đủ" : ""), base, conv ? r2(conv) : "", sz ? r2(sz) : "", S16, D16 ?? "", S_, Dscan ?? "", nw.inn, nw.outOrd, nw.outOut, nw.outOther, nw.active, r2(nw.activeQ), Q, Qq, conv ? r2(Qq / conv) : "", -d > 0 ? r2(-d) : r2(-d), p.miss.length, late.length, qrSold.size, R.length, Rq, find.length, r2(fq), restR.length, goneQ, evQ, noEv, u, conv && u ? r2(u / conv) : 0, since.length, sinceQ, looseQ, k, why, notes, pos ? Object.entries(pos.locs).map(([l, v]) => l + " " + v).join(", ") : "không có dòng POS", p.lastScan ? fmt(p.lastScan) : SP.has(c) ? "chưa quét" : "không có trong phiên", find.join(", "), late.join(", ")] });
  }
  const ord = Object.values(KL);
  rows.sort((a, b) => ord.indexOf(a.k) - ord.indexOf(b.k) || b.d - a.d);
  const H = ["Mã SP", "Tên sản phẩm", "Sheet: POS→EPC", "Sheet: quét", "Sheet: thực dán", "Sheet: Final", "ĐV POS", "Quy đổi master", "Cỡ thẻ NW", "Tồn POS ~16h (tái dựng)", "→ EPC", "Tồn POS lúc quét", "(1) POS lúc quét → EPC", "(2) NW đã nhập (EPC)", "Xuất NW: đơn POS (CIR-)", "Xuất NW: phiếu OUT", "Xuất NW: khác", "NW còn active (EPC)", "NW còn active (SL)", "(3) Quét được (EPC)", "(3) Quét được (SL)", "(3) Quét quy ra EPC", "Lệch SL: quét − POS", "Thẻ chưa quét (phiên)", "→ nhập NW sau giờ quét", "→ QR trên đơn bán (NW chưa trừ)", "→ còn lại", "SL thẻ còn lại", "(4) Cần tìm (thẻ)", "Cần tìm (SL)", "(4) Thẻ đã bán, NW chưa trừ (không cần tìm)", "SL thẻ coi là đã đi", "SL bán/TRF từ khi nhập các thẻ đó", "SL không thấy đơn", "POS cao hơn hàng có thẻ (SL)", "≈ EPC (quy đổi master như sheet)", "Dòng bán từ khi gắn thẻ (NW chưa trừ)", "SL bán từ khi gắn thẻ", "SL bán lẻ", "Kết luận", "Giải thích", "Ghi chú", "Vị trí POS", "Quét SP lần cuối", "EPC cần tìm", "EPC nhập sau giờ quét"];
  const out = XLSX.utils.book_new();
  const add = (n, arr, w) => { const ws = XLSX.utils.aoa_to_sheet(arr); ws["!cols"] = w.map((v) => ({ wch: v })); if (arr.length > 1) ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: arr.length - 1, c: arr[0].length - 1 } }) }; XLSX.utils.book_append_sheet(out, ws, n); };
  add("Thiếu hàng " + rows.length + " mã", [H, ...rows.map((r) => r.row)], [9, 40, 7, 7, 7, 12, 7, 7, 7, 9, 6, 9, 8, 7, 7, 7, 6, 7, 8, 7, 8, 7, 8, 7, 7, 7, 7, 8, 7, 8, 8, 8, 8, 8, 8, 6, 8, 8, 7, 40, 90, 60, 22, 16, 40, 30]);
  const sumRows = [["Kết luận", "Số mã", "Thẻ cần tìm", "SL POS cao hơn hàng có thẻ (EPC quy đổi)"], ...ord.filter((k0) => G[k0]).map((k0) => { const x = rows.filter((r) => r.k === k0); return [k0, x.length, x.reduce((s, r) => s + r.row[28], 0), r2(x.reduce((s, r) => s + (+r.row[35] || 0), 0))]; }), ["Tổng", rows.length], [],
    ["Cách tính", "So theo SỐ LƯỢNG từng thẻ (SL ghi trên thẻ NW), không theo số thẻ: SP có thẻ nhiều cỡ (lốc + lẻ) không bị lệch. Thẻ chưa quét chỉ 'cần tìm' tới mức đủ bù phần thiếu so với POS; thẻ chưa quét vượt mức đó là hàng POS đã bán/chuyển mà NW chưa trừ. Thẻ nhập NW sau giờ quét SP không tính là quét sót."],
    ["Nguồn", `Sheet Summary (Thiếu hàng, ~16h) · phiên ${path.basename(SESS)} · tồn POS + đơn + sổ NW lúc ${fmt(SNAP)} · master Google Sheet`]];
  add("Tổng hợp", sumRows, [55, 10, 12, 30]);
  if (PREVF) {
    const P0 = rd(PREVF)(XLSX.read(fs.readFileSync(PREVF), { type: "buffer" }).SheetNames[0]); const pm = new Map(P0.map((r) => [String(r["Mã SP"]), r]));
    const ch = rows.filter((r) => { const o = pm.get(String(r.row[0])); return !o || String(o["Kết luận"]).slice(0, 1) !== { A: "A", B: "B", C: "-", D: "-", E: "C", F: "D" }[r.k[0]]; }).map((r) => { const o = pm.get(String(r.row[0])) || {}; return [r.row[0], r.row[1], o["Kết luận"] || "", o["Thẻ NW chưa quét (cần tìm)"] ?? "", r.k, r.row[28], r.row[40]]; });
    add("Đổi kết luận (" + ch.length + ")", [["Mã SP", "Tên sản phẩm", "Bản trước", "Bản trước: thẻ chưa quét", "Bản này", "Cần tìm (thẻ)", "Giải thích"], ...ch], [9, 40, 40, 10, 40, 8, 90]);
    console.log("changed", ch.length);
  }
  fs.writeFileSync(OUTF, Buffer.from(XLSX.write(out, { type: "array", bookType: "xlsx" })));
  console.log(JSON.stringify(G), "find", rows.reduce((s, r) => s + r.row[28], 0));
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
