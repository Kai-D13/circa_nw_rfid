// Phiên KIỂM KÊ NW (so số quét với tồn NW = thẻ đã nhập, không có tồn POS) → phân loại EPC thiếu, báo cáo THEO SẢN PHẨM. READ-ONLY.
// Bối cảnh Lumina: NW chỉ tự trừ theo đơn POS trong 11–13/11/2026, sau đó tắt → thẻ đã bán vẫn active trên NW và hiện "thiếu" trong phiên.
// Cách tính mỗi SP: E = số thẻ ít nhất (thẻ lớn trước) đủ phủ tồn POS lúc quét (≤ số thẻ). Thiếu vượt (thẻ − E) = đã bán/chuyển mà NW chưa trừ;
//   phần còn lại (E − đã quét) = POS vẫn còn hàng mà không quét thấy → CẦN TÌM. Thẻ nhập NW sau khi quét SP đó không tính là thiếu.
// env NW_KEY (kho của phiên; chỉ POST tra cứu /integrations/circa/epcs/resolve), WH (mặc định Lumina),
//     QR_EPC = qr-epc.json (QR trên đơn/TRF → EPC, tạo bằng pos-qr-resolve.js) — bằng chứng trực tiếp thẻ đã bán,
//     SEEN = "nhãn|file;nhãn|file…" theo thứ tự thời gian: file xuất phiên RFID trước (kiểm kê hoặc kiểm đếm .xlsx) hoặc qr-epc.json của phiên POS QR.
// usage: node phan-tich-kiem-ke.js <kiem-ke.xlsx> <thư mục fetch-phien.js (nw-ledger, pos-orders, pos-pending, pos-trf, pos-stock-now)> <out.xlsx>
const fs = require("fs"), path = require("path");
const { XLSX, KiemDem } = require("./load-tool.js");
const [SESS, PD, OUTF] = process.argv.slice(2);
const NW = "https://api-circa.nextwaves.app/api/v1/public", WH = (process.env.WH || "3f7bd541-7370-4ce0-9048-231cf061e91a").toLowerCase();
const ld = (f) => JSON.parse(fs.readFileSync(path.join(PD, f), "utf8"));
const fold0 = KiemDem.fold, UA = { tube: "tuyp" };
const fold = (s) => { const f = fold0(s); return UA[f] || f; };
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
async function resolve(list) { const out = []; for (let i = 0; i < list.length; i += 200) { const j = await post("/integrations/circa/epcs/resolve", { epcs: list.slice(i, i + 200) }); out.push(...(Array.isArray(j) ? j : j.data || j.results || [])); } return new Map(out.map((x) => [x.epc, x])); }

const nFindTmp = (assign, list) => list.filter((e) => assign.get(e).cat === "h. POS vẫn còn hàng mà không quét thấy → CẦN TÌM").length;
(async () => {
  if (!process.env.NW_KEY) throw new Error("thiếu NW_KEY");
  // ---------- phiên
  const wb = XLSX.read(fs.readFileSync(SESS), { type: "buffer" });
  const J = (n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: "" });
  const L = J("Danh sách kiểm kê"), D = J("Chi tiết quét"), STR = J("Thẻ lạ"), OV = J("Tổng quan");
  const ov = Object.fromEntries(OV.map((r) => [r["Chỉ tiêu"], r["Giá trị"]]));
  const sessStart = vnDate(ov["Tạo lúc"]), sessExport = vnDate(ov["Xuất lúc"]);
  const P = new Map();
  for (const r of L) {
    const code = String(r["Mã SP"]).replace(/^CIRCA-/, "");
    P.set(code, { code, name: r["Tên sản phẩm"], unit: r["ĐVT"], sys: num(r["Tồn hệ thống"]), status: r["Trạng thái"], missing: String(r["EPC chưa quét (có thể thiếu)"]).split(/,\s*/).filter(Boolean), extra: String(r["EPC thừa"]).split(/,\s*/).filter(Boolean), scanned: [], lastScan: 0, soldScanned: [] });
  }
  let sessEnd = 0;
  for (const r of D) {
    const p = P.get(String(r["Mã SP"]).replace(/^CIRCA-/, "")); if (!p) continue;
    const t = vnDate(r["Lần quét cuối"]);
    if (r["Trạng thái"] === "Đã quét") { p.scanned.push(r.EPC); if (t >= sessStart && t > p.lastScan) p.lastScan = t; if (t >= sessStart && t > sessEnd) sessEnd = t; }
    else if (t >= sessStart) p.soldScanned.push(r.EPC + " (" + r["Trạng thái"] + ")"); // thẻ NW đã trừ mà phiên này vẫn đọc được
  }
  const strangeSet = new Set(STR.map((r) => String(r.EPC)));

  // ---------- NW: thẻ (SL chính xác từng thẻ), sổ kho
  const allE = []; for (const p of P.values()) allE.push(...p.scanned, ...p.missing);
  const R = await resolve(allE);
  const LG = ld("nw-ledger.json");
  const epcIn = new Map(), epcRef = new Map(), firstIn = new Map(), refsBy = new Map();
  for (const r of LG) {
    const t = Date.parse(r.at);
    if (r.q > 0 && /stock_in|pack_in|transfer/.test(r.t)) { for (const e of r.epcs) if (!epcIn.has(e)) { epcIn.set(e, t); epcRef.set(e, String(r.ref || "").split("-/").pop()); } if (!firstIn.has(r.c) || t < firstIn.get(r.c)) firstIn.set(r.c, t); }
    if (r.q < 0 && r.ref) { if (!refsBy.has(r.c)) refsBy.set(r.c, new Set()); refsBy.get(r.c).add(String(r.ref).replace(/^CIR-/, "")); }
  }
  const nwDeducted = (pid, code) => (refsBy.get(pid) || new Set()).has(code);
  const nwOrderDays = [...new Set(LG.filter((r) => r.q < 0 && /ORDER/.test(r.t)).map((r) => fmt(Date.parse(r.at)).slice(0, 10)))].sort();

  // ---------- POS: biến động (đơn hoàn tất, TRF, đơn chờ giao) chưa trừ trên NW cho chính SP đó
  const ORD = ld("pos-orders.json"), PEND = ld("pos-pending.json"), TRF = ld("pos-trf.json"), NOW = ld("pos-stock-now.json");
  const SNAP = Date.parse(NOW.at);
  const mv = [];
  for (const o of ORD) { if (o.err) continue; const t = Date.parse(o.completed_date); for (const it of o.items) { if (nwDeducted(it.product_id, o.code)) continue; mv.push({ pid: it.product_id, t, base: Number(it.base_quantity) || 0, ch: o.type === "ONLINE" ? "ONLINE" : "OFFLINE", ref: o.code, qr: it.qr || [] }); } }
  for (const tr of TRF) { if (tr.status !== "COMPLETED") continue; const t = Date.parse(tr.completed_at); for (const it of tr.items) { if (nwDeducted(it.product_id, tr.code)) continue; mv.push({ pid: it.product_id, t, base: Number(it.base_quantity) || it.detailQty || 0, ch: "TRF", ref: tr.code + " → " + tr.dest, qr: it.qr || [] }); } }
  for (const o of PEND) { if (o.err || !/AWAITING_SHIPMENT|SHIPPING|READY_TO_PICK/.test(o.status)) continue; const t = Date.parse(o.created_date); for (const it of o.items) mv.push({ pid: it.product_id, t, base: Number(it.base_quantity) || 0, ch: "CHỜ GIAO", ref: o.code + " (" + o.status + ")", qr: it.qr || [] }); }
  const mvBy = new Map(); for (const m of mv) { if (!mvBy.has(m.pid)) mvBy.set(m.pid, []); mvBy.get(m.pid).push(m); }
  // QR trên đơn → EPC (bằng chứng trực tiếp)
  const QE = process.env.QR_EPC ? JSON.parse(fs.readFileSync(process.env.QR_EPC, "utf8")).res : {};
  for (const m of mv) m.epcs = [...new Set(m.qr.flatMap((q) => (QE[q] && QE[q].epcs) || []))]; // QR tem gốc có thể ra nhiều EPC → giới hạn theo SL bán ở dưới
  // tồn POS hiện tại (bỏ Kho thất lạc), vị trí, đơn vị
  const POS = new Map();
  for (const r of NOW.rows) {
    const o = POS.get(r.pid) || { q: 0, lost: 0, locs: {}, base: r.base, units: r.units || [] };
    const locs = r.locs && r.locs.length ? r.locs : [{ loc: "", q: r.q }];
    for (const l of locs) { const q = Number(l.q) || 0; if (fold(l.loc || "") === "kho that lac") o.lost += q; else { o.q += q; if (q) o.locs[l.loc || "(trống)"] = (o.locs[l.loc || "(trống)"] || 0) + q; } }
    POS.set(r.pid, o);
  }

  // ---------- các phiên trước: thẻ thiếu đã từng quét thấy?
  const SEEN = (process.env.SEEN || "").split(";").filter(Boolean).map((s) => { const [label, f] = s.split("|"); const set = new Set();
    if (/\.json$/i.test(f)) { const j = JSON.parse(fs.readFileSync(f, "utf8")); for (const v of Object.values(j.res || {})) for (const e of v.epcs || []) set.add(e); }
    else { const w = XLSX.read(fs.readFileSync(f), { type: "buffer" }); const S = (n) => (w.Sheets[n] ? XLSX.utils.sheet_to_json(w.Sheets[n], { defval: "" }) : []);
      for (const r of S("Chi tiết quét")) if (r["Trạng thái"] === "Đã quét") set.add(String(r.EPC));
      for (const r of S("Thẻ lạ")) set.add(String(r.EPC));
      for (const r of S("Chi tiết thẻ")) set.add(String(r.EPC));
      for (const r of S("Ngoại lệ")) set.add(String(r.EPC)); }
    const m = label.match(/(\d+)\/(\d+) (\d+):(\d+)/); const yr = new Date(sessStart).getUTCFullYear();
    return { label, set, t: m ? Date.parse(`${yr}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T${m[3].padStart(2, "0")}:${m[4]}:00+07:00`) : 0 }; });
  const seenAfter = (e, t) => SEEN.some((s) => s.t > t && s.set.has(e));
  const lastSeen = (e) => { let l = ""; for (const s of SEEN) if (s.set.has(e)) l = s.label; return l; };

  // ---------- từng SP
  const CAT = { DIRECT: "a. Đã bán/chuyển, QR trên đơn = thẻ này (NW chưa trừ)", OFFLINE: "b. Đã bán OFFLINE (NW chưa trừ)", ONLINE: "c. Đã bán ONLINE (NW chưa trừ)", TRF: "d. Đã chuyển TRF (NW chưa trừ)", "CHỜ GIAO": "e. Đơn ONLINE chờ giao/đang giao", OTHER: "f. NW nhiều thẻ hơn tồn POS, không thấy đơn (nhập NW dư / tồn POS đã chỉnh)", LATE: "g. Nhập NW sau khi quét SP này (không phải thiếu)", FIND: "h. POS vẫn còn hàng mà không quét thấy → CẦN TÌM" };
  const SOLD = [CAT.DIRECT, CAT.OFFLINE, CAT.ONLINE, CAT.TRF, CAT["CHỜ GIAO"]];
  const LIQ = /n[uư][oớ]c|chai|\bml\b|\d\s*ml|siro|dung d[iị]ch|s[uữ]a|d[aầ]u |x[iị]t|\bgel\b|l[oọ] |lotion|serum|kem /i, MET = /\blon\b|nh[oô]m|b[iì]nh gi[uữ] nhi[eệ]t|thi[eế]c/i;
  const kind = (n) => (MET.test(n) ? "Kim loại (lon/nhôm)" : LIQ.test(n) ? "Chất lỏng/chai/tuýp/kem" : "Khác (hộp/vỉ/gói…)");
  const RO = {}, KI = {}, bump = (o, k, sc) => { o[k] = o[k] || { T: 0, sc: 0, find: 0 }; o[k].T++; if (sc) o[k].sc++; };
  const rowsP = [], rowsE = [], A = { sp: 0, T: 0, sc: 0, miss: 0, cat: {}, spCat: {}, unitWarn: 0, locFind: {} };
  for (const p of P.values()) {
    const T = p.scanned.length + p.missing.length; if (!T) continue;
    A.sp++; A.T += T; A.sc += p.scanned.length; A.miss += p.missing.length;
    for (const e of p.scanned) { bump(RO, e.slice(0, 13), 1); bump(KI, kind(p.name), 1); }
    for (const e of p.missing) { bump(RO, e.slice(0, 13), 0); bump(KI, kind(p.name), 0); }
    if (!p.scanned.length) { A.sp0 = (A.sp0 || 0) + 1; A.t0 = (A.t0 || 0) + T; }
    if (!p.missing.length) continue;
    const pos = POS.get(p.code);
    // hệ số: 1 đơn vị gốc NW = k đơn vị gốc POS
    let k = 1, unitNote = "";
    if (pos && fold(pos.base || "") !== fold(p.unit || "")) { const u = pos.units.find((x) => fold(x.unit || "") === fold(p.unit || "")); if (u && u.rate) { k = Number(u.rate); unitNote = `ĐV NW ${p.unit} = ${k} ${pos.base} POS`; } else { unitNote = `ĐV NW "${p.unit}" ≠ ĐV POS "${pos.base}" (không quy đổi được, coi = 1)`; A.unitWarn++; } }
    const tq = (e) => { const x = R.get(e); return x && x.found && x.baseQuantity != null ? Number(x.baseQuantity) * k : (p.sys / T) * k; };
    const tScan = p.lastScan || sessEnd;
    const lateCut = p.lastScan || sessStart;
    const late = p.missing.filter((e) => (epcIn.get(e) || 0) > lateCut);
    const lateSet = new Set(late);
    const missEff = p.missing.filter((e) => !lateSet.has(e));
    const tags = [...p.scanned, ...missEff];
    const Teff = tags.length;
    const ms = mvBy.get(p.code) || [];
    const soldAfter = ms.filter((m) => m.t > tScan && m.t <= SNAP && m.ch !== "CHỜ GIAO").reduce((s, m) => s + m.base, 0);
    const S_now = pos ? pos.q : 0, S_scan = Math.max(0, S_now + soldAfter);
    const qs = tags.map(tq).sort((a, b) => b - a); let E = 0, acc = 0; while (E < Teff && acc < S_scan - 1e-9) { acc += qs[E]; E++; }
    const size = qs.reduce((s, x) => s + x, 0) / (Teff || 1);
    const sc = p.scanned.length;
    // bằng chứng trực tiếp
    // Thẻ chỉ "đã bán" khi tổng SL bán qua QR của thẻ ≥ SL trên thẻ (bán nguyên hộp, hoặc bán lẻ dần hết hộp).
    // Bán lẻ vài viên từ hộp (base < SL thẻ) KHÔNG phải bằng chứng hộp đã đi: hộp mở dở có thể vẫn trên kệ (19/11 19:02: 3 thẻ như vậy quét thấy lại).
    const soldEpc = new Map(), missSet = new Set(missEff), accQ = new Map(), looseEv = new Map();
    for (const m of ms.slice().sort((a, b) => a.t - b.t)) {
      if (m.t < (firstIn.get(p.code) || 0) - 864e5) continue;
      let rem = m.base;
      for (const e of m.epcs) {
        if (rem <= 1e-9) break;
        if (!missSet.has(e) || soldEpc.has(e) || seenAfter(e, m.t)) continue;
        const q = tq(e), give = Math.min(rem, Math.max(0, q - (accQ.get(e) || 0)));
        accQ.set(e, (accQ.get(e) || 0) + give); rem -= give;
        if (accQ.get(e) >= q - 1e-9) soldEpc.set(e, m); else looseEv.set(e, { m, q: accQ.get(e), of: q });
      }
    }
    for (const e of soldEpc.keys()) looseEv.delete(e);
    A.loose = (A.loose || 0) + looseEv.size; if (looseEv.size) A.looseSp = (A.looseSp || 0) + 1;
    const direct = missEff.filter((e) => soldEpc.has(e));
    const directSet = new Set(direct);
    const explained = Math.min(missEff.length, Math.max(Math.max(0, Teff - E), direct.length));
    const find = missEff.length - explained;
    // khối lượng bán từ khi gắn thẻ đến lúc quét, theo kênh (trừ phần đã có QR = thẻ)
    const fi = firstIn.get(p.code) || 0;
    const since = ms.filter((m) => m.t >= fi && m.t <= tScan);
    const byCh = {}; for (const m of since) byCh[m.ch] = (byCh[m.ch] || 0) + m.base;
    const directQ = {}; for (const e of direct) { const m = soldEpc.get(e); directQ[m.ch] = (directQ[m.ch] || 0) + tq(e); }
    const assign = new Map();
    for (const e of direct) { const m = soldEpc.get(e); assign.set(e, { cat: CAT.DIRECT, ev: m.ref + " · " + fmt(m.t) }); }
    let left = explained - direct.length; const pool = [];
    for (const ch of ["OFFLINE", "ONLINE", "TRF", "CHỜ GIAO"]) { const base = Math.max(0, (byCh[ch] || 0) - (directQ[ch] || 0)); const n = Math.min(left, Math.ceil(base / (size || 1) - 1e-9)); const refs = [...new Set(since.filter((m) => m.ch === ch).map((m) => m.ref))]; for (let i = 0; i < n; i++) pool.push({ cat: CAT[ch], ev: refs.slice(0, 8).join(", ") + (refs.length > 8 ? ` …(+${refs.length - 8})` : "") }); left -= n; }
    for (let i = 0; i < left; i++) pool.push({ cat: CAT.OTHER, ev: `POS lúc quét ${r2(S_scan)} ${pos ? pos.base : ""} ≈ ${E} thẻ; NW ${Teff} thẻ; không thấy đơn/TRF chưa trừ sau ${fmt(fi).slice(0, 10)}` });
    // thẻ nào là "cần tìm": ưu tiên thẻ từng quét thấy gần đây nhất (khả năng còn hàng cao hơn); thẻ chưa từng thấy → gán đã bán trước
    //   (QR thẻ được quét khi bán lẻ = thẻ còn trong tay lúc đó → coi như "thấy" vào giờ bán)
    const seenT = (e) => Math.max((SEEN.find((x) => x.label === lastSeen(e)) || { t: 0 }).t, looseEv.has(e) ? looseEv.get(e).m.t : 0);
    const rest = missEff.filter((e) => !directSet.has(e)).map((e) => ({ e, s: seenT(e) })).sort((a, b) => a.s - b.s || (epcIn.get(a.e) || 0) - (epcIn.get(b.e) || 0));
    const looseTxt = (e) => { const x = looseEv.get(e); return x ? `bán lẻ ${r2(x.q)}/${r2(x.of)} ${pos ? pos.base : ""} qua QR thẻ này (${x.m.ref} · ${fmt(x.m.t)}) → hộp đã mở, có thể còn trên kệ` : ""; };
    for (const { e } of rest) { const a = pool.shift() || { cat: CAT.FIND, ev: "" }; const lt = looseTxt(e); assign.set(e, lt ? { cat: a.cat, ev: [a.ev, lt].filter(Boolean).join(" · ") } : a); }
    for (const e of late) assign.set(e, { cat: CAT.LATE, ev: "nhập NW " + fmt(epcIn.get(e)) + (p.lastScan ? ", SP quét lần cuối " + fmt(p.lastScan) : ", SP chưa quét lần nào trong phiên") + (strangeSet.has(e) ? " · có đọc được lúc quét (nằm ở Thẻ lạ)" : "") });
    const cnt = {}; for (const v of assign.values()) cnt[v.cat] = (cnt[v.cat] || 0) + 1;
    for (const [c, v] of Object.entries(cnt)) { A.cat[c] = (A.cat[c] || 0) + v; A.spCat[c] = (A.spCat[c] || 0) + 1; }
    const nSold = SOLD.reduce((s, c) => s + (cnt[c] || 0), 0), nOther = cnt[CAT.OTHER] || 0, nLate = cnt[CAT.LATE] || 0, nFind = cnt[CAT.FIND] || 0;
    const locs = pos ? Object.entries(pos.locs).sort((a, b) => b[1] - a[1]).map(([l, v]) => l + ":" + v).join(", ") : "";
    if (nFind) { const top = pos && Object.keys(pos.locs).length ? Object.entries(pos.locs).sort((a, b) => b[1] - a[1])[0][0] : "(không có vị trí POS)"; A.locFind[top] = A.locFind[top] || { sp: 0, tags: 0 }; A.locFind[top].sp++; A.locFind[top].tags += nFind; }
    const findSeen = missEff.filter((e) => assign.get(e).cat === CAT.FIND).map(lastSeen).filter(Boolean);
    for (const e of missEff) if (assign.get(e).cat === CAT.FIND) { const ls = lastSeen(e) || "chưa từng quét thấy ở phiên nào trước"; A.findSeen = A.findSeen || {}; A.findSeen[ls] = (A.findSeen[ls] || 0) + 1; RO[e.slice(0, 13)].find++; KI[kind(p.name)].find++; }
    if (nFindTmp(assign, missEff) && !p.scanned.length) { A.find0 = (A.find0 || 0) + 1; }
    const evid = [...new Set([...direct.map((e) => soldEpc.get(e).ref), ...since.map((m) => m.ref)])];
    const verdict = nFind ? (nFind === missEff.length && !sc ? "Không quét thấy thẻ nào của SP, POS còn hàng" : "Thiếu thật so với tồn POS") : nSold ? "Đã bán/chuyển, NW chưa trừ" + (nOther ? " + NW dư thẻ so với POS" : "") : nOther ? "NW dư thẻ so với tồn POS, không thấy đơn" : "Chỉ là thẻ nhập NW sau khi quét";
    const todo = [nFind ? `Tìm ${nFind} ${p.unit === "viên" ? "thẻ" : "thẻ"} ở ${locs || "kệ"} rồi quét lại` : "", nSold ? `Xuất kho NW ${nSold} thẻ đã bán/chuyển (cần bạn duyệt)` : "", nOther ? `Xem lại ${nOther} thẻ: tồn POS thấp hơn NW mà không có đơn → kiểm phiếu nhập NW / điều chỉnh POS` : "", nLate && !nFind && !nSold && !nOther ? "Không cần làm gì (quét lại sẽ thấy)" : ""].filter(Boolean).join(" · ");
    const sizes = [...new Set(qs.map((x) => r2(x)))];
    rowsP.push([p.code, p.name, p.unit, p.status, T, sc, p.missing.length, nSold, nOther, nLate, nFind, sizes.length > 1 ? sizes.join("/") : sizes[0], r2(p.sys), pos ? pos.base : "", r2(S_scan), E, byCh.OFFLINE || 0, byCh.ONLINE || 0, byCh.TRF || 0, byCh["CHỜ GIAO"] || 0, direct.length, evid.slice(0, 10).join(", ") + (evid.length > 10 ? ` …(+${evid.length - 10})` : ""), locs, findSeen.length ? findSeen.length + "/" + nFind + " thẻ (lần cuối " + findSeen.sort((a, b) => SEEN.findIndex((x) => x.label === b) - SEEN.findIndex((x) => x.label === a))[0] + ")" : nFind ? "0/" + nFind : "", fmt(fi), verdict, todo, [unitNote, pos && pos.lost ? "Kho thất lạc " + pos.lost : "", p.soldScanned.length ? "quét thấy thẻ NW đã trừ: " + p.soldScanned.join("; ") : "", !pos ? "không có dòng tồn POS" : S_now < 0 ? "tồn POS âm " + S_now : ""].filter(Boolean).join(" · ")]);
    for (const e of p.missing) { const x = R.get(e) || {}; const a = assign.get(e); rowsE.push([p.code, p.name, e, x.unitUid || "", x.unit || p.unit, x.baseQuantity, fmt(epcIn.get(e)), epcRef.get(e) || "", a.cat, a.cat === CAT.DIRECT || a.cat === CAT.LATE ? "trực tiếp" : a.cat === CAT.FIND ? "" : "theo SL bán", a.ev, lastSeen(e), x.status || "", locs]); }
  }

  // ---------- thẻ lạ: nay đã nhập NW chưa?
  const RS = await resolve(STR.map((r) => String(r.EPC)));
  const rowsS = STR.map((r) => { const e = String(r.EPC), x = RS.get(e) || {}; let g;
    if (x.found) g = `Đã nhập NW (${x.status} @${String(x.warehouseId || "").toLowerCase() === WH ? "kho này" : "kho khác"}) · SP ${x.circaProductId || "?"}` + (epcIn.has(e) ? " · nhập " + fmt(epcIn.get(e)) : "");
    else if (/^\d{13}[A-Z]/.test(e)) g = "EPC mang dạng UID → ghi tem lỗi";
    else if (/^0{4}/.test(e) || e.length < 24) g = "EPC ngắn/không chuẩn (tem lạ, không phải tem Circa)";
    else g = /^(A51A1B5156F8D|B51A1B510CC55|E28069150000[45]0|E280F302)/.test(e) ? "Dải tem Circa nhưng CHƯA nhập kho NW (tem in dư / dán mà chưa stock-in)" : "Không có trên NW";
    return [e, r["Lý do"], x.found ? x.status : "không có", x.circaProductId || "", g]; });

  // ---------- xuất
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 + "%" : "");
  const sold = SOLD.reduce((s, c) => s + (A.cat[c] || 0), 0);
  const sum = [
    ["Chỉ tiêu", "Giá trị", "Ghi chú"],
    ["Phiên", `${ov["Kho"]} · ${ov["Phạm vi"]} · tạo ${ov["Tạo lúc"]} · xuất ${ov["Xuất lúc"]}`, path.basename(SESS)],
    ["Giờ quét (theo file)", fmt(sessStart) + " → " + fmt(sessEnd), "Danh sách 'thiếu' do NW tính lúc XUẤT file: thẻ nhập NW sau giờ quét cũng bị tính thiếu (nhóm g)"],
    ["NW tự trừ theo đơn POS", nwOrderDays.join(", "), "Ngoài các ngày này NW không trừ → thẻ đã bán vẫn active, hiện 'thiếu' trong phiên"],
    ["Tồn POS dùng để so", "Tồn hiện tại " + fmt(SNAP) + " + bán/TRF từ giờ quét SP đến lúc đó", "mọi vị trí trừ Kho thất lạc; chỉ dùng để biết bao nhiêu thẻ ĐÁNG LẼ còn"],
    [],
    ["Thẻ NW trong phiên", A.T, A.sp + " SP có thẻ"], ["Đã quét", A.sc, pct(A.sc, A.T)], ["EPC thiếu", A.miss, rowsP.length + " SP"],
    [],
    ["PHÂN LOẠI " + A.miss + " EPC THIẾU", "Số EPC", "Số SP"],
    ...Object.values(CAT).map((c) => [c, A.cat[c] || 0, A.spCat[c] || 0]),
    [],
    ["→ Đã bán/chuyển, NW chưa trừ (a–e)", sold, pct(sold, A.miss) + " số thiếu"],
    ["→ Cần tìm (h)", A.cat[CAT.FIND] || 0, pct(A.cat[CAT.FIND] || 0, A.miss) + " số thiếu"],
    ["% quét nếu bỏ các thẻ a–e và g khỏi tồn NW", pct(A.sc, A.T - sold - (A.cat[CAT.LATE] || 0)), "nếu bỏ thêm f: " + pct(A.sc, A.T - sold - (A.cat[CAT.LATE] || 0) - (A.cat[CAT.OTHER] || 0))],
    [],
    ["Đơn POS hoàn tất từ " + fmt(Date.parse(ORD.reduce((m, o) => (o.completed_date < m ? o.completed_date : m), "9")) ).slice(0, 10), ORD.length, "OFFLINE " + ORD.filter((o) => o.type !== "ONLINE").length + " · ONLINE " + ORD.filter((o) => o.type === "ONLINE").length],
    ["QR trên đơn/TRF ra được EPC đang thiếu", A.cat[CAT.DIRECT] || 0, "bằng chứng trực tiếp (nhóm a)"],
    ["QR thẻ thiếu chỉ quét khi BÁN LẺ (chưa đủ SL thẻ)", A.loose || 0, (A.looseSp || 0) + " SP · KHÔNG tính là đã bán: hộp mở dở có thể còn trên kệ (xem cột Bằng chứng)"],
    ["SP có đơn vị NW ≠ POS không quy đổi được", A.unitWarn, "xem cột Ghi chú"],
    ["Các phiên trước dùng để xem 'từng quét thấy'", SEEN.map((s) => s.label).join(" · ") || "(không có)", ""],
    [],
    ["THẺ CẦN TÌM: lần cuối quét thấy ở phiên trước", "Số thẻ", ""],
    ...Object.entries(A.findSeen || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v, /18\/11/.test(k) ? "đã có mặt tối 18/11 → nhiều khả năng hàng vẫn còn, phiên này quét sót" : ""]),
    ["SP không quét được thẻ nào (Chưa đếm)", (A.sp0 || 0) + " SP / " + (A.t0 || 0) + " thẻ", (A.find0 || 0) + " SP trong đó POS còn hàng → khu/kệ có thể chưa quét"],
    [],
    ["TỶ LỆ QUÉT THEO CUỘN TEM (EPC 13 ký tự đầu)", "Đã quét / Thẻ", "Cần tìm"],
    ...Object.entries(RO).filter(([, v]) => v.T >= 20).sort((a, b) => b[1].T - a[1].T).map(([k, v]) => [k, v.sc + " / " + v.T + " = " + pct(v.sc, v.T), v.find]),
    [],
    ["TỶ LỆ QUÉT THEO NHÓM HÀNG", "Đã quét / Thẻ", "Cần tìm"],
    ...Object.entries(KI).map(([k, v]) => [k, v.sc + " / " + v.T + " = " + pct(v.sc, v.T), v.find]),
    [],
    ["CẦN TÌM theo vị trí POS chính", "Số thẻ", "Số SP"],
    ...Object.entries(A.locFind).sort((a, b) => b[1].tags - a[1].tags).slice(0, 12).map(([l, v]) => [l, v.tags, v.sp]),
    ...(Object.keys(A.locFind).length > 12 ? [["(các vị trí khác)", Object.entries(A.locFind).sort((a, b) => b[1].tags - a[1].tags).slice(12).reduce((s, [, v]) => s + v.tags, 0), Object.keys(A.locFind).length - 12 + " vị trí"]] : []),
    [],
    ["THẺ LẠ", STR.length, ""],
    ...Object.entries(rowsS.reduce((m, r) => { const k = r[4].replace(/ · .*$/, "").replace(/\(.*\)/, "").trim(); m[k] = (m[k] || 0) + 1; return m; }, {})).map(([k, v]) => [k, v, ""]),
  ];
  const out = XLSX.utils.book_new();
  const add = (name, aoa, w) => { const ws = XLSX.utils.aoa_to_sheet(aoa); if (w) ws["!cols"] = w.map((x) => ({ wch: x })); if (aoa.length > 1) ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: aoa[0].length - 1 } }) }; XLSX.utils.book_append_sheet(out, ws, name); };
  rowsP.sort((a, b) => b[10] - a[10] || b[6] - a[6]);
  add("SP thiếu", [["Mã SP", "Tên sản phẩm", "ĐVT NW", "Trạng thái phiên", "Thẻ NW", "Đã quét", "Thiếu", "→ Đã bán/chuyển, NW chưa trừ", "→ NW dư so với POS, không thấy đơn", "→ Nhập NW sau khi quét", "→ CẦN TÌM", "SL/thẻ (ĐV POS)", "Tồn NW (gốc)", "ĐV POS", "Tồn POS lúc quét", "Thẻ đáng lẽ còn (theo POS)", "Bán OFFLINE từ khi gắn thẻ", "Bán ONLINE", "TRF", "Chờ giao", "Thẻ có QR trên đơn", "Đơn/TRF bằng chứng", "Vị trí POS", "Thẻ cần tìm từng quét thấy ở phiên trước", "Nhập NW lần đầu", "Kết luận", "Việc cần làm", "Ghi chú"], ...rowsP], [9, 42, 7, 9, 6, 6, 6, 9, 9, 8, 8, 8, 8, 6, 8, 8, 8, 7, 6, 6, 7, 40, 28, 22, 16, 30, 50, 40]);
  add("Tổng quan", sum, [56, 44, 70]);
  rowsE.sort((a, b) => a[8].localeCompare(b[8]) || a[1].localeCompare(b[1]));
  add("EPC thiếu", [["Mã SP", "Tên sản phẩm", "EPC", "UID", "Đơn vị thẻ", "SL gốc trên thẻ", "Nhập NW lúc", "Phiếu nhập NW", "Phân loại", "Căn cứ", "Bằng chứng", "Quét thấy lần cuối (phiên trước)", "Trạng thái NW hiện tại", "Vị trí POS"], ...rowsE], [9, 42, 26, 18, 7, 7, 16, 12, 46, 10, 50, 18, 10, 28]);
  add("Thẻ lạ", [["EPC", "Lý do (NW)", "Trạng thái NW hiện tại", "Mã SP", "Nhận định"], ...rowsS], [28, 16, 14, 10, 80]);
  fs.writeFileSync(OUTF, Buffer.from(XLSX.write(out, { type: "array", bookType: "xlsx" })));
  console.log(JSON.stringify({ findSeen: A.findSeen, sp0: A.sp0, t0: A.t0, find0: A.find0, RO: Object.fromEntries(Object.entries(RO).filter(([, v]) => v.T >= 20)), KI, sp: A.sp, T: A.T, sc: A.sc, miss: A.miss, spMiss: rowsP.length, cat: A.cat, spCat: A.spCat, unitWarn: A.unitWarn, nwOrderDays, sessEnd: fmt(sessEnd) }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
