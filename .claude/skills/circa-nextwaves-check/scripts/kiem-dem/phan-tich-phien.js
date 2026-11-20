// Phân tích phiên kiểm kê NW (READ-ONLY). env NW_KEY (LUMINA).
// usage: node kd/phan-tich-phien.js <kiem-ke.xlsx> <ton-kho-pos.xlsx (snapshot)> <snapshotISO> <out.xlsx>
// needs kd/phien/{nw-ledger,pos-orders,pos-pending,pos-trf,pos-stock-now}.json from fetch-phien.js
const fs = require("fs"), path = require("path");
const { XLSX, KiemDem } = require("./load-tool.js");
const [SESS, STOCK, SNAP_ISO, OUTF] = process.argv.slice(2);
const NW = "https://api-circa.nextwaves.app/api/v1/public", WH = "3f7bd541-7370-4ce0-9048-231cf061e91a";
const PH = path.join(__dirname, "phien");
const ld = (f) => JSON.parse(fs.readFileSync(path.join(PH, f), "utf8"));
const fold = KiemDem.fold;
const num = (x) => (typeof x === "number" ? x : Number(String(x).replace(/\./g, "").replace(",", ".")) || 0);
const vnDate = (s) => { const m = String(s).match(/(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+)/); return m ? Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+07:00`) : NaN; };
const fmt = (t) => (isFinite(t) ? new Date(t + 7 * 3600e3).toISOString().slice(0, 16).replace("T", " ") : "");
const SNAP = Date.parse(SNAP_ISO);

async function post(p, body) {
  for (let t = 0; t < 6; t++) {
    const r = await fetch(NW + p, { method: "POST", headers: { authorization: "Bearer " + process.env.NW_KEY, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1500 * (t + 1))); continue; }
    return r.json();
  }
}
async function batch(p, key, list) { const out = []; for (let i = 0; i < list.length; i += 500) { const j = await post(p, { [key]: list.slice(i, i + 500) }); out.push(...(Array.isArray(j) ? j : j.data || [])); } return out; }

const LIQ = /n[uư][oớ]c|chai|\bml\b|\d\s*ml|siro|dung d[iị]ch|s[uữ]a|d[aầ]u |x[iị]t|\bgel\b|l[oọ] |lotion|serum|kem /i, MET = /\blon\b|nh[oô]m|b[iì]nh gi[uữ] nhi[eệ]t|thi[eế]c/i, SMALL = /\bque\b|g[oó]i|[oố]ng |v[iỉ] |mi[eế]ng|b[aă]ng c[aá] nh[aâ]n/i;
const kind = (n) => (MET.test(n) ? "Kim loại" : LIQ.test(n) ? "Chất lỏng/chai/tuýp" : SMALL.test(n) ? "Que/gói/miếng nhỏ" : "");

(async () => {
  const wb = XLSX.read(fs.readFileSync(SESS), { type: "buffer" });
  const J = (n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: "" });
  const L = J("Danh sách kiểm kê"), D = J("Chi tiết quét"), STR = J("Thẻ lạ"), OV = J("Tổng quan");
  const ovMap = Object.fromEntries(OV.map((r) => [r["Chỉ tiêu"], r["Giá trị"]]));
  const sessStart = vnDate(ovMap["Tạo lúc"] + ""), sessEnd = D.reduce((m, r) => Math.max(m, vnDate(r["Lần quét cuối"]) || 0), 0);

  // --- session per product
  const P = new Map();
  for (const r of L) {
    const code = String(r["Mã SP"]).replace(/^CIRCA-/, "");
    P.set(code, { code, name: r["Tên sản phẩm"], unit: r["ĐVT"], sys: num(r["Tồn hệ thống"]), status: r["Trạng thái"], missing: String(r["EPC chưa quét (có thể thiếu)"]).split(/,\s*/).filter(Boolean), extra: String(r["EPC thừa"]).split(/,\s*/).filter(Boolean), scanned: [], lastScan: 0 });
  }
  for (const r of D) {
    const code = String(r["Mã SP"]).replace(/^CIRCA-/, ""); const p = P.get(code); if (!p) continue;
    if (r["Trạng thái"] === "Đã quét") { p.scanned.push(r.EPC); const t = vnDate(r["Lần quét cuối"]); if (t > p.lastScan) p.lastScan = t; }
  }

  // --- resolve every session EPC (exact per-tag base quantity) + strange tags
  const allE = []; for (const p of P.values()) allE.push(...p.scanned, ...p.missing);
  const res = await batch("/integrations/circa/epcs/resolve", "epcs", allE);
  const R = new Map(res.map((x) => [x.epc, x]));
  const strangeRes = await batch("/integrations/circa/epcs/resolve", "epcs", STR.map((r) => String(r.EPC)));
  // EPCs that look like a label UID were probably encoded wrongly → try UID lookup
  const uidLike = STR.map((r) => String(r.EPC)).filter((e) => /^\d{13}[A-Z]/.test(e));
  const uidRes = uidLike.length ? await batch("/tags/by-uid/batch", "uids", uidLike.map((e) => e.replace(/F+$/, ""))) : [];

  // --- NW ledger: per product first stock-in, per EPC stock-in time, NW-deducted order refs
  const LG = ld("nw-ledger.json");
  const epcRef = new Map(), epcIn = new Map(), firstIn = new Map(), nwRefs = new Set();
  for (const r of LG) {
    if (r.q > 0 && /stock_in|pack_in|transfer/.test(r.t)) { for (const e of r.epcs) if (!epcIn.has(e)) { epcIn.set(e, Date.parse(r.at)); epcRef.set(e, String(r.ref || "").split("-/").pop()); } const t = Date.parse(r.at); if (!firstIn.has(r.c) || t < firstIn.get(r.c)) firstIn.set(r.c, t); }
    if (r.ref) nwRefs.add(String(r.ref).replace(/^CIR-/, ""));
  }

  // --- POS movements (base units) per product: completed orders (not deducted on NW), TRF out, pending online
  const ORD = ld("pos-orders.json"), PEND = ld("pos-pending.json"), TRF = ld("pos-trf.json");
  const mv = []; // {pid, t, base, ch, ref, qr[]}
  for (const o of ORD) { if (o.err || nwRefs.has(o.code)) continue; const t = Date.parse(o.completed_date); for (const it of o.items) mv.push({ pid: it.product_id, t, base: Number(it.base_quantity) || 0, ch: o.type === "ONLINE" ? "ONLINE" : "OFFLINE", ref: o.code, qr: it.qr }); }
  for (const tr of TRF) { if (tr.status !== "COMPLETED") continue; const t = Date.parse(tr.completed_at); for (const it of tr.items) mv.push({ pid: it.product_id, t, base: Number(it.base_quantity) || it.detailQty || 0, ch: "TRF", ref: tr.code + " → " + tr.dest, qr: it.qr }); }
  for (const o of PEND) { if (o.err || !/AWAITING_SHIPMENT|SHIPPING|READY_TO_PICK/.test(o.status)) continue; const t = Date.parse(o.created_date); for (const it of o.items) mv.push({ pid: it.product_id, t, base: Number(it.base_quantity) || 0, ch: "ONLINE chờ giao", ref: o.code + " (" + o.status + ")", qr: it.qr }); }
  const mvBy = new Map(); for (const m of mv) { if (!mvBy.has(m.pid)) mvBy.set(m.pid, []); mvBy.get(m.pid).push(m); }
  // direct evidence: sold QR = unit UID of a tag
  const qrs = [...new Set(mv.flatMap((m) => m.qr))];
  const qrMap = await batch("/tags/by-uid/batch", "uids", qrs);
  const epcByQr = new Map(qrMap.filter((x) => x.mapped && x.epc).map((x) => [x.uid, x.epc]));
  const soldEpc = new Map(); // epc -> movement
  for (const m of mv) for (const q of m.qr) { const e = epcByQr.get(q); if (e && !soldEpc.has(e)) soldEpc.set(e, m); }

  // --- POS snapshot stock (file) by product, excluding Kho thất lạc; keep locations
  const sw = XLSX.read(fs.readFileSync(STOCK), { type: "buffer" });
  const st = XLSX.utils.sheet_to_json(sw.Sheets[sw.SheetNames[0]], { defval: "" });
  const POS = new Map();
  for (const r of st) {
    const c = String(r["Mã sản phẩm"]).trim(); const loc = String(r["Vị trí"]).trim(); const q = Number(r["Tồn tổng"]) || 0;
    const o = POS.get(c) || { q: 0, lost: 0, unit: r["Đơn vị lưu kho"], locs: {} };
    if (fold(loc) === "kho that lac") o.lost += q; else { o.q += q; if (q) o.locs[loc] = (o.locs[loc] || 0) + q; }
    POS.set(c, o);
  }
  const NOW = ld("pos-stock-now.json"); const posNow = new Map();
  for (const r of NOW.rows) { const o = posNow.get(r.pid) || { q: 0 }; for (const l of r.locs) if (fold(l.loc) !== "kho that lac") o.q += Number(l.q) || 0; posNow.set(r.pid, o); }

  // --- per product evaluation
  const rowsP = [], rowsE = [], rowsX = [];
  const A = { T: 0, sc: 0, miss: 0, E: 0, scE: 0, cat: {}, spTot: 0, spOkNW: 0, spOkPOS: 0, overPOS: 0, overPOSsp: 0 };
  const CAT = { OFFLINE: "a. Đã bán OFFLINE (NW chưa trừ)", ONLINE: "b. Đã bán ONLINE (NW chưa trừ)", TRF: "c. Đã chuyển TRF (NW chưa trừ)", "ONLINE chờ giao": "d. Đơn ONLINE chờ giao/đang giao", OTHER: "e1. NW nhiều thẻ hơn tồn POS, không thấy đơn (nhập NW dư / POS lệch)", FIND: "e2. POS vẫn còn hàng → cần tìm" };
  for (const p of P.values()) {
    const tags = [...p.scanned, ...p.missing];
    const T = tags.length; if (!T) continue;
    const q = tags.map((e) => { const x = R.get(e); return x && x.found && x.baseQuantity != null ? Number(x.baseQuantity) : p.sys / T; });
    const size = q.reduce((s, x) => s + x, 0) / T;
    const pos = POS.get(p.code); const S6 = pos ? pos.q : 0;
    const tScan = p.lastScan || sessEnd;
    const ms = (mvBy.get(p.code) || []);
    const fi = firstIn.get(p.code) || 0;
    const after = (a, b) => ms.filter((m) => m.t >= a && m.t <= b && m.ch !== "ONLINE chờ giao");
    const soldWin = after(SNAP, tScan).reduce((s, m) => s + m.base, 0); // sold between snapshot and this product's scan
    const Sscan = Math.max(0, S6 - soldWin);
    // E = fewest tags (largest first) covering Sscan, capped at T
    const qs = [...q].sort((a, b) => b - a); let E = 0, acc = 0; while (E < T && acc < Sscan - 1e-9) { acc += qs[E]; E++; }
    const sc = p.scanned.length, miss = p.missing.length;
    A.T += T; A.sc += sc; A.miss += miss; A.E += E; A.scE += Math.min(sc, E); A.spTot++;
    if (miss === 0) A.spOkNW++; if (sc >= E) A.spOkPOS++;
    if (sc > E) { A.overPOS += sc - E; A.overPOSsp++; rowsX.push({ code: p.code, name: p.name, T, sc, E, S6, Sscan, pend: ms.filter((m) => m.ch === "ONLINE chờ giao").map((m) => m.ref + " " + m.base).join("; ") }); }
    // channels since tags existed (by base qty) → tags equivalent
    const since = ms.filter((m) => m.t >= fi && m.t <= tScan);
    const byCh = {}; for (const m of since) byCh[m.ch] = (byCh[m.ch] || 0) + m.base;
    const explained = Math.min(miss, Math.max(0, T - E));
    // allocate: direct evidence first, then by channel volume
    const assign = new Map();
    for (const e of p.missing) { const m = soldEpc.get(e); if (m && m.t <= tScan) assign.set(e, { cat: CAT[m.ch], ev: m.ref + " (QR " + m.qr.join(",").slice(0, 40) + " = thẻ này)" }); }
    let left = Math.max(0, explained - assign.size);
    const pool = [];
    for (const ch of ["OFFLINE", "ONLINE", "TRF", "ONLINE chờ giao"]) { const base = byCh[ch] || 0; let n = Math.min(left, Math.ceil(base / (size || 1) - 1e-9)); const refs = since.filter((m) => m.ch === ch).map((m) => m.ref); for (let i = 0; i < n; i++) pool.push({ cat: CAT[ch], ev: [...new Set(refs)].slice(0, 6).join(", ") }); left -= n; }
    for (let i = 0; i < left; i++) pool.push({ cat: CAT.OTHER, ev: `POS 15:57 = ${S6}, lúc quét ≈ ${Sscan}; không thấy đơn/TRF sau khi gắn thẻ` });
    for (const e of p.missing) { if (assign.has(e)) continue; assign.set(e, pool.shift() || { cat: CAT.FIND, ev: "" }); }
    const locs = pos ? Object.entries(pos.locs).sort((a, b) => b[1] - a[1]).map(([l, v]) => l + ":" + v).join(", ") : "";
    const cnt = {}; for (const v of assign.values()) cnt[v.cat] = (cnt[v.cat] || 0) + 1;
    for (const [k, v] of Object.entries(cnt)) A.cat[k] = (A.cat[k] || 0) + v;
    for (const e of p.missing) { const x = R.get(e) || {}; const a = assign.get(e); rowsE.push([p.code, p.name, e, x.unitUid || "", x.unit || "", x.baseQuantity, fmt(epcIn.get(e)), epcRef.get(e) || "", a.cat, a.ev, locs, kind(p.name)]); }
    if (miss) rowsP.push([p.code, p.name, p.unit, p.status, T, sc, miss, Math.round(size * 100) / 100, S6, Math.round(soldWin * 100) / 100, Sscan, E, Math.min(sc, E), Math.max(0, E - sc), fmt(fi), byCh.OFFLINE || 0, byCh.ONLINE || 0, byCh.TRF || 0, byCh["ONLINE chờ giao"] || 0, cnt[CAT.FIND] || 0, locs, kind(p.name), pos ? pos.lost : 0, posNow.get(p.code) ? posNow.get(p.code).q : "", new Set(q.map((x) => Math.round(x * 1000))).size > 1 ? "nhiều cỡ thẻ: " + [...new Set(q)].join("/") : ""]);
  }

  // --- strange tags
  const SR = new Map(strangeRes.map((x) => [x.epc, x])); const UR = new Map(uidRes.map((x) => [x.uid, x]));
  const rowsS = STR.map((r) => { const e = String(r.EPC); const x = SR.get(e) || {}; const u = UR.get(e.replace(/F+$/, "")); let g = "";
    if (/^\d{13}[A-Z]/.test(e)) g = "EPC mang dạng UID → ghi tem lỗi" + (u && u.mapped ? ` (UID này đang map EPC ${u.epc}, ${u.status})` : "");
    else if (/^0{4}/.test(e) || e.length < 24) g = "EPC ngắn/không chuẩn (tem lạ, không phải tem Circa)";
    else if (!x.found) g = /^(A51A1B5156F8D|B51A1B510CC55|E28069150000[45]0|E280F302)/.test(e) ? "Cùng dải tem Circa nhưng CHƯA nhập kho NW (tem in dư / chưa stock-in / cuộn tem trong khu quét)" : "Không có trên NW";
    else g = `${x.status} @${x.warehouseId === WH ? "Lumina" : "kho khác"} · SP ${x.circaProductId || "?"}`;
    return [e, r["Lý do"], x.found ? x.status : "không có", x.circaProductId || "", g]; });

  // --- summary
  const abcd = () => ["OFFLINE", "ONLINE", "TRF", "ONLINE chờ giao"].reduce((s, k) => s + (A.cat[CAT[k]] || 0), 0);
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 + "%" : "");
  const sum = [
    ["Chỉ tiêu", "Giá trị", "Ghi chú"],
    ["Phiên", ovMap["Kho"] + " · " + ovMap["Phạm vi"] + " · tạo " + ovMap["Tạo lúc"], "file " + path.basename(SESS)],
    ["Giờ quét cuối (theo file)", fmt(sessEnd), ""],
    ["Tồn POS dùng để so", "Snapshot " + fmt(SNAP) + " − bán/TRF từ snapshot đến giờ quét SP", path.basename(STOCK)],
    [],
    ["THEO KIỂM KÊ (tồn NW)", "", ""],
    ["Thẻ dự kiến (NW active)", A.T, ""], ["Thẻ đã quét", A.sc, ""], ["EPC thiếu", A.miss, ""], ["% theo EPC", pct(A.sc, A.T), ""], ["SP đủ thẻ / tổng SP có thẻ", A.spOkNW + " / " + A.spTot, pct(A.spOkNW, A.spTot)],
    [],
    ["THEO KIỂM ĐẾM (tồn POS quy ra EPC, tối đa = số thẻ)", "", ""],
    ["Thẻ dự kiến theo POS", A.E, "E = số thẻ ít nhất (cỡ lớn trước) phủ được tồn POS lúc quét, ≤ số thẻ NW"], ["Thẻ quét được (tính tối đa E mỗi SP)", A.scE, ""], ["Thiếu so với POS", A.E - A.scE, ""], ["% theo EPC", pct(A.scE, A.E), ""], ["SP đạt / tổng SP", A.spOkPOS + " / " + A.spTot, pct(A.spOkPOS, A.spTot)],
    ["Quét được NHIỀU hơn POS", A.overPOS + " thẻ / " + A.overPOSsp + " SP", "hàng còn trên kệ nhưng POS đã trừ (đơn chờ lấy, POS sai…) — sheet 'Quét dư so với POS'"],
    [],
    ["PHÂN LOẠI " + A.miss + " EPC THIẾU", "Số EPC", ""],
    ...Object.values(CAT).map((c) => [c, A.cat[c] || 0, pct(A.cat[c] || 0, A.miss)]),
    ["% nếu bỏ khỏi dự kiến các thẻ a–d (đã bán/chuyển, có đơn)", pct(A.sc, A.T - abcd()), `dự kiến ${A.T - abcd()} thẻ`],
    ["% nếu bỏ thêm e1 (thẻ dư so với POS)", pct(A.sc, A.T - abcd() - (A.cat[CAT.OTHER] || 0)), `dự kiến ${A.T - abcd() - (A.cat[CAT.OTHER] || 0)} thẻ`],
    ["Thẻ e2 theo ngày nhập NW", Object.entries(rowsE.filter((r) => r[8] === CAT.FIND).reduce((m, r) => ((m[r[6].slice(0, 10)] = (m[r[6].slice(0, 10)] || 0) + 1), m), {})).sort().map(([d, n]) => d.slice(5) + ": " + n).join(" · "), "thẻ mới gắn 16–17/11 chiếm phần lớn → hàng vừa dán tem chưa lên kệ / khu chưa quét"],
    ["Thẻ e2 theo cuộn tem", Object.entries(rowsE.filter((r) => r[8] === CAT.FIND).reduce((m, r) => ((m[r[2].slice(0, 13)] = (m[r[2].slice(0, 13)] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).map(([d, n]) => d + "…: " + n).join(" · "), ""],
    [],
    ["Đơn POS hoàn tất từ 06/11 (không tính đơn đã trừ NW)", ORD.filter((o) => !nwRefs.has(o.code)).length + " / " + ORD.length, "OFFLINE " + ORD.filter((o) => o.type !== "ONLINE").length + " · ONLINE " + ORD.filter((o) => o.type === "ONLINE").length],
    ["TRF xuất từ Lumina từ 06/11 (hoàn tất)", TRF.filter((t) => t.status === "COMPLETED").length, ""],
    ["Đơn ONLINE chờ giao/đang giao", PEND.filter((o) => /AWAITING_SHIPMENT|SHIPPING|READY_TO_PICK/.test(o.status)).length, ""],
    ["QR trên đơn/TRF map trúng thẻ NW", epcByQr.size + " / " + qrs.length + " QR", "bằng chứng trực tiếp thẻ đã bán"],
    [],
    ["THẺ LẠ", STR.length, ""],
    ...Object.entries(rowsS.reduce((m, r) => ((m[r[4].replace(/ \(UID.*$/, "").replace(/ · SP .*$/, "")] = (m[r[4].replace(/ \(UID.*$/, "").replace(/ · SP .*$/, "")] || 0) + 1), m), {})).map(([k, v]) => [k, v, ""]),
  ];
  const out = XLSX.utils.book_new();
  const add = (name, aoa, w) => { const ws = XLSX.utils.aoa_to_sheet(aoa); if (w) ws["!cols"] = w.map((x) => ({ wch: x })); XLSX.utils.book_append_sheet(out, ws, name); };
  add("Tổng quan", sum, [52, 40, 70]);
  rowsE.sort((a, b) => a[8].localeCompare(b[8]) || a[1].localeCompare(b[1]));
  add("EPC thiếu", [["Mã SP", "Tên sản phẩm", "EPC", "UID", "Đơn vị thẻ", "SL base trên thẻ", "Nhập NW lúc", "Phiếu nhập NW", "Phân loại", "Bằng chứng (đơn/TRF)", "Vị trí POS (15:57)", "Nhóm hàng (dễ lỗi đọc)"], ...rowsE], [10, 44, 26, 18, 8, 8, 16, 12, 44, 50, 30, 18]);
  rowsP.sort((a, b) => b[19] - a[19] || b[6] - a[6]);
  add("SP thiếu", [["Mã SP", "Tên sản phẩm", "ĐVT", "Trạng thái phiên", "Thẻ NW", "Đã quét", "Thiếu (NW)", "Base/thẻ", "POS 15:57", "Bán/TRF từ 15:57 đến lúc quét", "POS lúc quét", "Dự kiến theo POS (E)", "Quét tính theo E", "Thiếu theo POS", "Nhập NW lần đầu", "Bán OFFLINE từ khi gắn thẻ (base)", "Bán ONLINE (base)", "TRF (base)", "ONLINE chờ giao (base)", "Cần tìm (thẻ)", "Vị trí POS", "Nhóm hàng", "Kho thất lạc", "POS hiện tại", "Ghi chú"], ...rowsP], [10, 44, 8, 10, 7, 7, 7, 7, 8, 10, 8, 8, 8, 8, 16, 9, 9, 9, 9, 8, 30, 16, 8, 8]);
  add("Quét dư so với POS", [["Mã SP", "Tên sản phẩm", "Thẻ NW", "Đã quét", "Dự kiến theo POS", "POS 15:57", "POS lúc quét", "Đơn ONLINE chờ giao"], ...rowsX.map((x) => [x.code, x.name, x.T, x.sc, x.E, x.S6, x.Sscan, x.pend])], [10, 44, 7, 7, 8, 8, 8, 40]);
  add("Thẻ lạ", [["EPC", "Lý do (NW)", "Trạng thái NW hiện tại", "Mã SP", "Nhận định"], ...rowsS], [28, 16, 14, 10, 80]);
  fs.writeFileSync(OUTF, Buffer.from(XLSX.write(out, { type: "array", bookType: "xlsx" })));
  console.log(JSON.stringify({ T: A.T, sc: A.sc, miss: A.miss, pctNW: pct(A.sc, A.T), E: A.E, scE: A.scE, pctPOS: pct(A.scE, A.E), sp: A.spTot, spOkNW: A.spOkNW, spOkPOS: A.spOkPOS, overPOS: A.overPOS, overPOSsp: A.overPOSsp, cat: A.cat, qrMapped: epcByQr.size, qrs: qrs.length, directSoldMissing: rowsE.filter((r) => /= thẻ này/.test(r[9])).length }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
