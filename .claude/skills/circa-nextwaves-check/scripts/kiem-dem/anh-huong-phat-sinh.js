// READ-ONLY (chỉ đọc file đã kéo, không gọi API). Với một danh sách mã: phát sinh nào (đơn bán, TRF, RCV, đơn chờ giao, nhập/xuất NW, bán lẻ…)
// làm phiên kiểm kê NW báo THIẾU hoặc THỪA, và còn lại bao nhiêu là lệch thật.
// Hai góc nhìn:
//   (1) Phiên so với tồn NW (thẻ chưa quét): thẻ chưa quét được giải thích bằng — NW nhập sau giờ quét SP / đơn bán NW chưa trừ / TRF NW chưa trừ /
//       đơn online chờ giao — theo SỐ LƯỢNG (thẻ vượt phần POS cần mới là "đã đi"; thẻ cần để đủ POS = quét sót, không phải phát sinh).
//   (2) So với tồn POS lúc quét (S = POS lúc kéo + bán/TRF sau giờ quét − RCV nhận sau giờ quét):
//       thiếu (POS > quét) do — thẻ lạ chưa tính / hàng gắn tem sau giờ quét / RCV nhận mà chưa gắn tem / còn lại = quét sót hoặc POS cao;
//       thừa (quét > POS) do — đơn chờ giao (POS đã trừ, hàng còn) / bán lẻ (NW giữ cả hộp) / QR bán mà thẻ còn / còn lại = dư không phiếu.
//   Thêm: bán / RCV giữa giờ quét SP và giờ làm sheet (SHEET_AT) làm sheet lệch; thẻ NW đã trừ/xuất vẫn đọc được (phiên báo "Thừa").
// SL thẻ = SL còn lại trên NW (trừ phần NW đã trừ một phần). Đơn POS trừ tồn lúc TẠO đơn.
// usage: QR_EPC=<qr-epc.json> [SHEET_AT=ISO] node anh-huong-phat-sinh.js <list.xlsx (cột product_id)> <kiem-ke.xlsx> <phan-tich.xlsx> <PHIEN_DIR (+ pos-rcv.json từ fetch-rcv.js)> <out.xlsx>
const fs = require("fs"), path = require("path");
const { XLSX, KiemDem } = require("./load-tool.js");
const [LIST, SESS, ANA, PD, OUTF] = process.argv.slice(2);
const ld = (f) => (fs.existsSync(path.join(PD, f)) ? JSON.parse(fs.readFileSync(path.join(PD, f), "utf8")) : []);
const fold0 = KiemDem.fold, UA = { tube: "tuyp" }, fold = (s) => { const f = fold0(s); return UA[f] || f; };
const vnDate = (s) => { const m = String(s).match(/(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+)/); return m ? Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+07:00`) : NaN; };
const fmt = (t) => (isFinite(t) && t > 0 ? new Date(t + 7 * 3600e3).toISOString().slice(0, 16).replace("T", " ") : "");
const r2 = (x) => Math.round(x * 100) / 100;
const rd = (f) => { const wb = XLSX.read(fs.readFileSync(f), { type: "buffer" }); return (n) => (wb.Sheets[n || wb.SheetNames[0]] ? XLSX.utils.sheet_to_json(wb.Sheets[n || wb.SheetNames[0]], { defval: "" }) : []); };
const SHEET_AT = Date.parse(process.env.SHEET_AT || "2026-11-19T16:00:00+07:00");
const L0 = rd(LIST)(); const pk = Object.keys(L0[0]).find((k) => /product_id|mã sp/i.test(k)) || Object.keys(L0[0])[0];
const CODES = [...new Set(L0.map((r) => String(r[pk]).replace(/^CIRCA-/i, "").trim()).filter(Boolean))];
// ---- phiên
const S = rd(SESS), ov = Object.fromEntries(S("Tổng quan").map((r) => [r["Chỉ tiêu"], r["Giá trị"]]));
const sessStart = vnDate(ov["Tạo lúc"]), code = (x) => String(x).replace(/^CIRCA-/i, "");
const num = (x) => Number(String(x).replace(/\./g, "").replace(",", ".")) || 0;
const SP = new Map();
for (const r of S("Danh sách kiểm kê")) { const c = code(r["Mã SP"]); const p = SP.get(c) || { name: r["Tên sản phẩm"], unit: r["ĐVT"], scan: new Map(), miss: [], lastScan: 0, strange: [], readDed: [], sys: 0, thieu: 0, thua: 0 }; p.miss.push(...String(r["EPC chưa quét (có thể thiếu)"] || "").split(/[,;\s]+/).filter(Boolean)); p.sys += num(r["Tồn hệ thống"]); p.thieu += num(r["Còn thiếu"]); p.thua += num(r["Thừa"]); SP.set(c, p); }
let sessEnd = 0;
for (const r of S("Chi tiết quét")) { const p = SP.get(code(r["Mã SP"])); const t = vnDate(r["Lần quét cuối"]); if (t > sessEnd) sessEnd = t; if (!p) continue; if (r["Trạng thái"] !== "Đã quét") { p.readDed.push(String(r.EPC) + " (" + r["Trạng thái"] + ")"); continue; } p.scan.set(String(r.EPC), t); if (t > p.lastScan) p.lastScan = t; }
const lastSeen = new Map(); for (const r of rd(ANA)("EPC thiếu")) if (r["Quét thấy lần cuối (phiên trước)"]) lastSeen.set(String(r.EPC), String(r["Quét thấy lần cuối (phiên trước)"]));
const seenT = (lbl) => { const m = String(lbl || "").match(/(\d+)\/(\d+) (\d+):(\d+)/); return m ? Date.parse(`2026-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T${m[3].padStart(2, "0")}:${m[4]}:00+07:00`) : 0; };
// ---- sổ kho NW
const LG = ld("nw-ledger.json").slice().sort((a, b) => a.n - b.n);
const EQ = new Map(), ORIG = new Map(), EIN = new Map(), EC = new Map(), EOUT = new Map(), PART = new Map(), sizeBy = new Map(), firstIn = new Map(), refsBy = new Map(), insBy = new Map();
for (const r of LG) {
  const t = Date.parse(r.at), n = (r.epcs || []).length || 1;
  if (r.q > 0) { const per = r.q / n; for (const e of r.epcs || []) { EQ.set(e, per); ORIG.set(e, per); EIN.set(e, t); EC.set(e, r.c); EOUT.delete(e); } if (!sizeBy.has(r.c)) sizeBy.set(r.c, {}); sizeBy.get(r.c)[per] = (sizeBy.get(r.c)[per] || 0) + n; if (!firstIn.has(r.c) || t < firstIn.get(r.c)) firstIn.set(r.c, t); if (!insBy.has(r.c)) insBy.set(r.c, []); insBy.get(r.c).push({ t, q: r.q, ref: String(r.ref || "").split("-/").pop() }); }
  else if (r.q < 0) { const per = -r.q / n; for (const e of r.epcs || []) { const v = (EQ.get(e) || 0) - per; EQ.set(e, Math.max(0, v)); if (v <= 1e-9) EOUT.set(e, String(r.ref || "")); else PART.set(e, String(r.ref || "").replace(/^CIR-/, "")); } if (r.ref) { if (!refsBy.has(r.c)) refsBy.set(r.c, new Set()); refsBy.get(r.c).add(String(r.ref).replace(/^CIR-/, "")); } }
}
for (const r of S("Thẻ lạ")) { const e = String(r.EPC), c = EC.get(e); if (!c || !SP.has(c)) continue; if (EOUT.has(e)) SP.get(c).readDed.push(e + " (NW đã xuất " + EOUT.get(e).split("-/").pop() + ")"); else SP.get(c).strange.push(e); }
// ---- POS
const NOW = ld("pos-stock-now.json"), SNAP = Date.parse(NOW.at);
const POS = new Map();
for (const r of NOW.rows) { const o = POS.get(r.pid) || { q: 0, base: r.base, name: r.name }; for (const l of r.locs && r.locs.length ? r.locs : [{ loc: "", q: r.q }]) { if (fold(l.loc || "") === "kho that lac") continue; o.q += Number(l.q) || 0; } POS.set(r.pid, o); }
const QE = process.env.QR_EPC ? JSON.parse(fs.readFileSync(process.env.QR_EPC, "utf8")).res : {};
const mvBy = new Map(), addMv = (pid, m) => { if (!mvBy.has(pid)) mvBy.set(pid, []); mvBy.get(pid).push(m); };
const mk = (it, t, ref, ch, td) => ({ t, td: td || t, base: Number(it.base_quantity) || it.detailQty || 0, ref, ch, nwDed: (refsBy.get(it.product_id) || new Set()).has(ref.replace(/ \(.*/, "")), epcs: [...new Set((it.qr || []).flatMap((q) => (QE[q] && QE[q].epcs) || []))] });
for (const o of ld("pos-orders.json")) { if (o.err) continue; const t = Date.parse(o.completed_date); for (const it of o.items) addMv(it.product_id, mk(it, t, o.code, "ĐƠN", Math.min(t, Date.parse(o.created_date) || t))); }
for (const tr of ld("pos-trf.json")) { if (tr.status !== "COMPLETED") continue; const t = Date.parse(tr.completed_at); for (const it of tr.items) addMv(it.product_id, mk(it, t, tr.code, "TRF")); }
for (const o of ld("pos-pending.json")) { if (o.err || !/AWAITING_SHIPMENT|SHIPPING|READY_TO_PICK/.test(o.status)) continue; const t = Date.parse(o.created_date); for (const it of o.items) addMv(it.product_id, mk(it, t, o.code + " (" + o.status + ")", "CHỜ GIAO")); }
const rcvBy = new Map(); for (const o of ld("pos-rcv.json")) { if (o.status !== "COMPLETED") continue; const t = Date.parse(o.completed_at); for (const it of o.items) { if (!rcvBy.has(it.product_id)) rcvBy.set(it.product_id, []); rcvBy.get(it.product_id).push({ t, q: Number(it.base_quantity) || it.detailQty || 0, ref: o.code }); } }
// ---- từng mã
const T = { ORD: "Đơn bán (NW chưa trừ)", TRF: "TRF xuất (NW chưa trừ)", PEND: "Đơn online chờ giao", LATE: "NW nhập thẻ sau giờ quét SP", STR: "Thẻ lạ (nhập NW sau lúc tải danh sách) không tính", RCV: "RCV nhận hàng chưa gắn tem", LOOSE: "Bán lẻ (NW giữ SL cả hộp)", QRK: "QR bán mà thẻ vẫn còn", DED: "Thẻ NW đã trừ/xuất vẫn đọc được", AFT: "Bán/TRF giữa giờ lấy POS cho sheet (16h) và giờ quét SP", RCVA: "RCV nhận giữa 16h và giờ quét SP", PART: "(thông tin) NW đã trừ một phần SL trên thẻ — đã tính SL còn lại" };
const EFF = {}; for (const k of Object.keys(T)) EFF[k] = { has: new Set(), thieu: new Set(), thua: new Set(), tags: 0, q: 0 };
const rows = [], G = {};
for (const c of CODES) {
  const p = SP.get(c), pos = POS.get(c), name = (p && p.name) || (pos && pos.name) || (L0.find((r) => String(r[pk]) === c) || {}).product_name || "";
  const base = pos ? pos.base : (p && p.unit) || "";
  const sz = sizeBy.get(c) ? +Object.entries(sizeBy.get(c)).sort((u, v) => v[1] - u[1])[0][0] : 1;
  const q = (e) => (EQ.has(e) ? EQ.get(e) : sz), sum = (l) => r2(l.reduce((s, e) => s + q(e), 0));
  const tScan = (p && p.lastScan) || sessEnd, lateCut = (p && p.lastScan) || sessStart, fi = firstIn.get(c) || 0;
  const ms = (mvBy.get(c) || []).sort((a, b) => a.t - b.t), rcv = (rcvBy.get(c) || []).sort((a, b) => a.t - b.t);
  const S_now = pos ? pos.q : 0;
  const outAfter = ms.filter((m) => m.td > tScan && m.td <= SNAP).reduce((s, m) => s + m.base, 0), rcvAfter = rcv.filter((x) => x.t > tScan && x.t <= SNAP).reduce((s, x) => s + x.q, 0);
  const S_ = r2(Math.max(0, S_now + outAfter - rcvAfter));
  const scanned = p ? [...p.scan.keys()] : [], Qs = sum(scanned), strQ = p ? sum(p.strange) : 0;
  const miss = p ? p.miss : [], late = miss.filter((e) => (EIN.get(e) || 0) > lateCut), lateSet = new Set(late), missEff = miss.filter((e) => !lateSet.has(e));
  const ef = {}; const bump = (k, dir, tags, qq) => { ef[k] = ef[k] || { tags: 0, q: 0, dir: new Set() }; ef[k].tags += tags; ef[k].q = r2(ef[k].q + qq); ef[k].dir.add(dir); };
  // QR trên đơn = thẻ chưa quét (cộng dồn ≥ SL thẻ, không còn thấy ở phiên sau giờ bán)
  const missSet = new Set(missEff), acc = new Map(), qrSold = new Map();
  for (const m of ms) { if (m.t < fi - 864e5 || m.t > tScan || m.nwDed) continue; let rem = m.base; for (const e of m.epcs) { if (rem <= 1e-9) break; if (!missSet.has(e) || qrSold.has(e) || seenT(lastSeen.get(e)) > m.t) continue; const g = Math.min(rem, Math.max(0, q(e) - (acc.get(e) || 0))); acc.set(e, (acc.get(e) || 0) + g); rem -= g; if (acc.get(e) >= q(e) - 1e-9) qrSold.set(e, m); } }
  const R = missEff.filter((e) => !qrSold.has(e));
  const dTrue = r2(S_ - Qs - strQ), need = Math.max(0, dTrue);
  const cand = R.slice().sort((a, b) => seenT(lastSeen.get(b)) - seenT(lastSeen.get(a)) || q(b) - q(a));
  const find = []; let fq = 0; for (const e of cand) { if (fq >= need - 1e-9) break; find.push(e); fq += q(e); }
  const gone = R.filter((e) => !find.includes(e));
  // (1) thẻ chưa quét: phân bổ theo phát sinh
  if (late.length) bump("LATE", "thiếu", late.length, sum(late));
  const chK = (ch) => (ch === "ĐƠN" ? "ORD" : ch === "TRF" ? "TRF" : "PEND");
  for (const [e, m] of qrSold) bump(chK(m.ch), "thiếu", 1, q(e));
  const since = ms.filter((m) => m.t >= fi - 864e5 && m.t <= tScan && !m.nwDed && (m.ch !== "CHỜ GIAO" || m.t >= fi));
  const qrQ = {}; for (const [e, m] of qrSold) qrQ[m.ch] = (qrQ[m.ch] || 0) + q(e);
  const evs = since.map((m) => ({ t: m.t, ch: m.ch, left: m.base })); for (const [, m] of qrSold) { const x = evs.find((v) => v.t === m.t && v.ch === m.ch && v.left > 0); if (x) x.left = Math.max(0, x.left - m.base); }
  let noEvT = 0, noEvQ = 0;
  for (const e of gone.slice().sort((a, b) => (EIN.get(a) || 0) - (EIN.get(b) || 0))) { let need0 = q(e); const used = {}; for (const v of evs) { if (need0 <= 1e-9) break; if (v.left <= 1e-9 || v.t < (EIN.get(e) || fi) - 864e5) continue; const g = Math.min(need0, v.left); v.left -= g; need0 -= g; used[v.ch] = (used[v.ch] || 0) + g; } const top = Object.entries(used).sort((a, b) => b[1] - a[1])[0]; if (top && need0 <= q(e) / 2 + 1e-9) bump(chK(top[0]), "thiếu", 1, q(e)); else { noEvT++; noEvQ += q(e); } }
  // (2) so với POS lúc quét (góc phiên/sheet: chỉ "Đã quét")
  const dS = r2(S_ - Qs);
  let restT = 0, restX = 0, rcvUn = 0;
  // RCV nhận sau lần gắn thẻ đầu, đến giờ quét: phần NW chưa nhập thẻ sau đó
  { let pend = 0; const ev = [...rcv.filter((x) => x.t >= fi && x.t <= tScan).map((x) => ({ t: x.t, d: x.q })), ...(insBy.get(c) || []).filter((x) => x.t <= tScan).map((x) => ({ t: x.t, d: -x.q }))].sort((a, b) => a.t - b.t); for (const x of ev) { if (x.d > 0) pend += x.d; else pend = Math.max(0, pend + x.d); } rcvUn = r2(pend); }
  const rcvSince = rcv.filter((x) => x.t >= fi && x.t <= tScan);
  if (dS > 1e-9) {
    let rem = dS; const take = (k, avail, tags) => { const g = r2(Math.min(rem, avail)); if (g > 1e-9) { bump(k, "thiếu", tags, g); rem = r2(rem - g); } };
    take("STR", strQ, p ? p.strange.length : 0);
    take("LATE", sum(late), 0);
    const scanMiss = r2(Math.min(rem, sum(R))); rem = r2(rem - scanMiss);
    take("RCV", rcvUn, 0);
    restT = rem; restX = scanMiss;
  } else if (dS < -1e-9) {
    let rem = -dS; const take = (k, avail) => { const g = r2(Math.min(rem, avail)); if (g > 1e-9) { bump(k, "thừa", 0, g); rem = r2(rem - g); } };
    take("PEND", ms.filter((m) => m.ch === "CHỜ GIAO" && m.t <= tScan).reduce((s, m) => s + m.base, 0));
    const sizes = Object.keys(sizeBy.get(c) || {}).map(Number).sort((a, b) => a - b), uMin = sizes[0] || sz;
    take("LOOSE", r2(ms.filter((m) => m.t <= tScan && m.ch !== "CHỜ GIAO").reduce((s, m) => s + (uMin > 1 ? m.base % uMin : 0), 0)));
    const qrKeep = []; for (const m of since) for (const e of m.epcs) if (p && p.scan.has(e) && p.scan.get(e) > m.t && m.base >= q(e) - 1e-9) qrKeep.push(e);
    take("QRK", sum([...new Set(qrKeep)]));
    restX = -rem;
  }
  if (p && p.readDed.length) bump("DED", "thừa", p.readDed.length, 0);
  if (p && [...scanned, ...miss].some((e) => PART.has(e))) bump("PART", "info", [...scanned, ...miss].filter((e) => PART.has(e)).length, 0);
  // sheet: bán / RCV giữa giờ quét và 16h
  { const a0 = Math.min(tScan, SHEET_AT), a1 = Math.max(tScan, SHEET_AT), late16 = tScan > SHEET_AT; // sheet lấy POS lúc 16h, quét lúc tScan
    const sa = ms.filter((m) => m.td > a0 && m.td <= a1 && m.ch !== "CHỜ GIAO").reduce((s0, m) => s0 + m.base, 0), ra = rcv.filter((x) => x.t > a0 && x.t <= a1).reduce((s0, x) => s0 + x.q, 0);
    if (sa > 0) bump("AFT", late16 ? "thiếu" : "thừa", 0, sa); if (ra > 0) bump("RCVA", late16 ? "thừa" : "thiếu", 0, ra); }
  // phát sinh có trong khung (kể cả không làm lệch)
  const has = { ORD: since.some((m) => m.ch === "ĐƠN"), TRF: since.some((m) => m.ch === "TRF"), PEND: ms.some((m) => m.ch === "CHỜ GIAO"), LATE: late.length > 0, STR: p && p.strange.length > 0, RCV: rcv.length > 0, LOOSE: false, QRK: false, DED: p && p.readDed.length > 0, AFT: !!ef.AFT, RCVA: !!ef.RCVA, PART: !!ef.PART };
  for (const k of Object.keys(T)) { if (p && (has[k] || ef[k])) EFF[k].has.add(c); if (ef[k] && k !== "PART") { if (ef[k].dir.has("thiếu")) EFF[k].thieu.add(c); if (ef[k].dir.has("thừa")) EFF[k].thua.add(c); EFF[k].tags += ef[k].tags; EFF[k].q = r2(EFF[k].q + ef[k].q); } }
  // kết luận
  const missT = miss.length, explT = Object.entries(ef).filter(([k, v]) => ["LATE", "ORD", "TRF", "PEND"].includes(k)).reduce((s, [, v]) => s + v.tags, 0);
  let kl;
  if (!p) kl = !fi ? "Không có thẻ NW (phiên không có mã này)" : "Có thẻ NW nhưng không có trong phiên";
  else if (!missT && Math.abs(dS) < 1e-9 && !p.readDed.length) kl = "Khớp, không bị phát sinh làm lệch";
  else {
    const bits = [];
    if (missT) bits.push(`phiên thiếu ${missT} thẻ: ${explT} do phát sinh` + (find.length ? `, ${find.length} quét sót (cần tìm)` : "") + (noEvT ? `, ${noEvT} NW dư không thấy phiếu` : ""));
    if (dS > 1e-9) bits.push(`so POS thiếu ${dS} ${base}` + (restT > 1e-9 ? ` (còn ${restT} không phiếu nào giải thích: hàng chưa gắn tem / POS cao)` : restX > 1e-9 ? "" : " (giải thích hết bằng phát sinh)"));
    if (dS < -1e-9) bits.push(`so POS thừa ${-dS} ${base}` + (restX < -1e-9 ? ` (còn ${-restX} không phiếu: hộp mở dở trước gắn tem / POS thấp / dán trùng)` : " (giải thích hết bằng phát sinh)"));
    if (p.readDed.length) bits.push(`đọc được ${p.readDed.length} thẻ NW đã trừ/xuất`);
    kl = bits.join(" · ");
  }
  const ok = p && (missT || Math.abs(dS) > 1e-9 || p.readDed.length);
  const real = p && (find.length || noEvT || restT > 1e-9 || restX < -1e-9);
  const affected = Object.keys(ef).filter((k) => k !== "PART" && (ef[k].tags > 0 || ef[k].q > 0));
  const grp = !p ? "D. Không có trong phiên (không có thẻ NW)" : !ok ? "C. Khớp" : affected.length && !real ? "A. Lệch hoàn toàn do phát sinh" : affected.length ? "B. Lệch một phần do phát sinh, còn lệch thật" : "B2. Lệch không do phát sinh (quét sót / POS cao / dư không phiếu)";
  G[grp] = (G[grp] || 0) + 1;
  const cell = (k) => (ef[k] ? [ef[k].tags ? ef[k].tags + " thẻ" : "", ef[k].q ? ef[k].q + " " + base : "", [...ef[k].dir].join("/")].filter(Boolean).join(" · ") : "");
  const refs = (ch) => [...new Set(since.filter((m) => m.ch === ch).map((m) => m.ref))];
  rows.push({ grp, row: [c, name, grp, affected.map((k) => T[k]).join("; "), p ? scanned.length + missT : 0, p ? scanned.length : 0, missT, p ? p.thua : 0, S_, Qs, r2(-dS), ...Object.keys(T).map(cell), find.length, noEvT, r2(Math.max(0, restT)), r2(Math.max(0, -restX)), kl, [refs("ĐƠN").slice(0, 6).join(", ") + (refs("ĐƠN").length > 6 ? ` …(+${refs("ĐƠN").length - 6})` : ""), refs("TRF").join(", "), ms.filter((m) => m.ch === "CHỜ GIAO").map((m) => m.ref).join(", "), rcv.map((x) => x.ref + " " + fmt(x.t).slice(5) + " +" + x.q).join(", ")].map((s0, i) => (s0 ? ["Đơn: ", "TRF: ", "Chờ giao: ", "RCV: "][i] + s0 : "")).filter(Boolean).join(" | "), rcvSince.length ? `RCV sau gắn thẻ ${r2(rcvSince.reduce((s0, x) => s0 + x.q, 0))}, chưa thấy NW nhập thẻ tương ứng ~${rcvUn}` : "", p && p.readDed.length ? p.readDed.join("; ") : "", p && p.lastScan ? fmt(p.lastScan) : p ? "chưa quét" : ""] });
}
const ordG = ["A. Lệch hoàn toàn do phát sinh", "B. Lệch một phần do phát sinh, còn lệch thật", "B2. Lệch không do phát sinh (quét sót / POS cao / dư không phiếu)", "C. Khớp", "D. Không có trong phiên (không có thẻ NW)"];
rows.sort((a, b) => ordG.indexOf(a.grp) - ordG.indexOf(b.grp) || String(a.row[0]).localeCompare(String(b.row[0])));
const H = ["Mã SP", "Tên sản phẩm", "Nhóm", "Phát sinh làm lệch", "Thẻ NW trong phiên", "Đã quét", "Phiên: thẻ chưa quét", "Phiên: Thừa (SL)", "Tồn POS lúc quét", "SL quét (Đã quét)", "Quét − POS (SL)", ...Object.values(T), "Quét sót (thẻ cần tìm)", "NW dư không thấy phiếu (thẻ)", "POS cao, không phiếu (SL)", "Dư không phiếu (SL)", "Kết luận", "Phiếu liên quan", "RCV", "Thẻ đã trừ/xuất vẫn đọc", "Quét SP lần cuối"];
const out = XLSX.utils.book_new();
const add = (n, arr, w) => { const ws = XLSX.utils.aoa_to_sheet(arr); ws["!cols"] = w.map((v) => ({ wch: v })); if (arr.length > 1) ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: arr.length - 1, c: arr[0].length - 1 } }) }; XLSX.utils.book_append_sheet(out, ws, n); };
add(CODES.length + " mã", [H, ...rows.map((r) => r.row)], [9, 40, 30, 40, 7, 7, 7, 7, 8, 8, 8, ...Object.keys(T).map(() => 14), 8, 8, 8, 8, 70, 60, 30, 30, 16]);
const sumT = [["Phát sinh", "Số mã (trong phiên) có phát sinh", "Số mã bị làm THIẾU", "Số mã bị làm THỪA", "Thẻ", "SL (ĐV POS)", "Mã bị ảnh hưởng"], ...Object.entries(T).map(([k, v]) => [v, EFF[k].has.size, EFF[k].thieu.size, EFF[k].thua.size, EFF[k].tags, EFF[k].q, [...new Set([...EFF[k].thieu, ...EFF[k].thua])].join(" ")]), [],
  ["Nhóm", "Số mã"], ...ordG.filter((g) => G[g]).map((g) => [g, G[g]]), ["Tổng", CODES.length], [],
  ["Mã bị ảnh hưởng ít nhất 1 phát sinh", new Set(Object.keys(T).filter((k) => k !== "PART").flatMap((k) => [...EFF[k].thieu, ...EFF[k].thua])).size],
  ["Cách tính", "Thẻ chưa quét: trước hết là thẻ nhập NW sau giờ quét SP; rồi thẻ có QR trên đơn/TRF (NW chưa trừ); trong số còn lại, thẻ cần để đủ tồn POS = quét sót (không phải phát sinh), thẻ vượt mức POS = đã đi, gán cho đơn bán / TRF / chờ giao theo SL phiếu từ khi gắn thẻ, thiếu phiếu = NW dư. So với POS lúc quét (đã trừ RCV nhận sau giờ quét): thiếu → thẻ lạ chưa tính, hàng gắn tem sau, quét sót, RCV chưa gắn tem, còn lại POS cao; thừa → đơn chờ giao, bán lẻ, QR bán mà thẻ còn, còn lại dư không phiếu."],
  ["Nguồn", `${path.basename(LIST)} · phiên ${path.basename(SESS)} · đơn/TRF/RCV/chờ giao + tồn POS + sổ NW lúc ${fmt(SNAP)} · giờ sheet ${fmt(SHEET_AT)}`]];
add("Tổng hợp", sumT, [48, 12, 12, 12, 8, 12, 120]);
fs.writeFileSync(OUTF, Buffer.from(XLSX.write(out, { type: "array", bookType: "xlsx" })));
console.log(JSON.stringify(G));
for (const [k, v] of Object.entries(T)) console.log(v.padEnd(52), "có", EFF[k].has.size, "thiếu", EFF[k].thieu.size, "thừa", EFF[k].thua.size, "thẻ", EFF[k].tags, "SL", EFF[k].q);
console.log("affected", new Set(Object.keys(T).filter((k) => k !== "PART").flatMap((k) => [...EFF[k].thieu, ...EFF[k].thua])).size);
