// Phân tích phiên KIỂM ĐẾM NW (app điện thoại, file kiem-dem-YYYYMMDD-HHMM.xlsx). READ-ONLY. env NW_KEY (kho của phiên).
// usage: node kd/phan-tich-kiem-dem.js <kiem-dem.xlsx> <import.csv đã nạp vào phiên> <importISO> <out.xlsx>
// data: $PHIEN_DIR (default ./phien next to this script) from fetch-phien.js: nw-ledger, pos-orders, pos-pending, pos-trf, pos-stock-now
//
// Two views:
//  - NW (like the app's "Trạng thái"): Lumina tags in the 15:45 list vs scanned; every unscanned tag gets a likely cause.
//  - POS (what Kiểm đếm is for): scanned tags vs E = fewest tags covering POS stock. POS stock moves during the session, so
//    E is a range: E_lo (all sales 15:14→end happened before the scan) … E_hi (none did), plus E_max for opened boxes.
const fs = require("fs"), path = require("path");
const { XLSX, KiemDem } = require("./load-tool.js");
const [SESS, IMP, IMP_ISO, OUTF] = process.argv.slice(2);
const NW = "https://api-circa.nextwaves.app/api/v1/public", WH = "3f7bd541-7370-4ce0-9048-231cf061e91a";
const PH = process.env.PHIEN_DIR || path.join(__dirname, "phien");
const OPEN_MAX = 2; // max opened boxes per product (same default as the v2 tool)
const ld = (f) => JSON.parse(fs.readFileSync(path.join(PH, f), "utf8"));
const fold = KiemDem.fold;
const r3 = (x) => Math.round(x * 1000) / 1000;
const vn = (s) => { const m = String(s).match(/(\d+)\/(\d+)\/(\d+) (\d+):(\d+)/); return m ? Date.parse(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T${m[4].padStart(2, "0")}:${m[5]}:00+07:00`) : NaN; };
const fmt = (t) => (isFinite(t) && t ? new Date(t + 7 * 3600e3).toISOString().slice(0, 16).replace("T", " ") : "");
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 + "%" : "");
const IMP_AT = Date.parse(IMP_ISO);

async function post(p, body) {
  for (let t = 0; t < 6; t++) {
    const r = await fetch(NW + p, { method: "POST", headers: { authorization: "Bearer " + process.env.NW_KEY, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1500 * (t + 1))); continue; }
    return r.json();
  }
  throw new Error("NW " + p + " failed");
}
async function batch(p, key, list) { const out = []; for (let i = 0; i < list.length; i += 500) { const j = await post(p, { [key]: list.slice(i, i + 500) }); out.push(...(Array.isArray(j) ? j : j.data || [])); } return out; }
// same formulas as kiem-dem/v2/core.js (cover, emax)
function cover(qs, S) { if (!(S > 0)) return 0; const a = qs.slice().sort((x, y) => y - x); let n = 0, acc = 0; while (n < a.length && acc < S - 1e-9) { acc += a[n]; n++; } return n; }
// tags expected for POS stock S: fewest existing tags that cover S, plus the rest in tags of the usual size (never capped by T)
function need(qs, S, size) { if (!(S > 0)) return 0; let n = cover(qs, S); const Q = qs.reduce((s, x) => s + x, 0); if (Q < S - 1e-9) n += Math.ceil((S - Q) / (size > 0 ? size : 1) - 1e-9); return n; }
// most tags that can hold S when the smallest are on the shelf (upper bound when a product has mixed tag sizes)
function needAsc(qs, S, size) { if (!(S > 0)) return 0; const a = qs.slice().sort((x, y) => x - y); let n = 0, acc = 0; while (n < a.length && acc < S - 1e-9) { acc += a[n]; n++; } if (acc < S - 1e-9) n += Math.ceil((S - acc) / (size > 0 ? size : 1) - 1e-9); return n; }
function emax(T, S, size, L, Emin, cap) { if (!(S > 0) || !(size > 0) || !T || !(L > 0)) return Emin; let best = Emin; const kMax = Math.min(L + 1, T, cap > 0 ? cap : Infinity, Math.floor(S + 1e-9)); for (let k = 1; k <= kMax; k++) { const v = Math.min(T, Math.floor((S - k) / size + 1e-9) + k); if (v > best) best = v; } return best; }
function mode(m) { let b = null, n = -1; m.forEach((v, k) => { if (v > n || (v === n && k > b)) { b = k; n = v; } }); return b; }

(async () => {
  // ---------- session export ----------
  const wb = XLSX.read(fs.readFileSync(SESS), { type: "buffer" });
  const head = XLSX.utils.sheet_to_json(wb.Sheets["Tổng hợp"], { header: 1, defval: "" }).slice(0, 5);
  const hv = (k) => { const r = head.find((x) => x[0] === k); return r ? String(r[1]) : ""; };
  const END = vn(String(head[0][0]).replace(/^Kiểm đếm\s*/, "")), TAGS_AT = vn(hv("Tồn hệ thống lúc")), KHO = hv("Kho");
  if (KHO !== "Lumina") console.warn("Phiên không chọn kho Lumina:", KHO);
  const TH = XLSX.utils.sheet_to_json(wb.Sheets["Tổng hợp"], { range: 6, defval: "" }).filter((r) => r["Mã sản phẩm"]);
  const J = (n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: "" });
  const D = J("Chi tiết thẻ"), U = J("Thẻ chưa quét"), X = J("Ngoại lệ");
  const code = (r) => String(r["Mã sản phẩm"]).replace(/^CIRCA-/, "");

  // ---------- import file (Dự kiến E and POS stock at import time) ----------
  const imp = new Map();
  fs.readFileSync(IMP, "utf8").replace(/^﻿/, "").split(/\r?\n/).slice(1).filter(Boolean).forEach((l) => { const m = l.match(/^([^,]+),("(?:[^"]|"")*"|[^,]*),([^,]*),([^,]*),([^,]*),([^,]*)$/); if (m) imp.set(m[1], { name: m[2].replace(/^"|"$/g, "").replace(/""/g, '"'), unit: m[3], ratio: +m[4], S: +m[5], E: +m[6] }); });

  // ---------- NW ledger ----------
  const LG = ld("nw-ledger.json");
  const epcIn = new Map(), epcRef = new Map(), epcProd = new Map(), nwDed = new Map(), first = new Map(), refs = new Map(), sizes = new Map(), balEnd = new Map(), balNow = new Map(), outAfter = new Map();
  for (const r of LG) {
    const t = Date.parse(r.at), es = r.epcs || [];
    if (r.ref) { if (!refs.has(r.c)) refs.set(r.c, new Set()); refs.get(r.c).add(String(r.ref).replace(/^CIR-/i, "")); }
    if (r.ref && r.q < 0) { const k = r.c + "|" + String(r.ref).replace(/^CIR-/i, ""); nwDed.set(k, (nwDed.get(k) || 0) - r.q); } // NW base qty deducted per product + order
    if (r.q > 0 && /stock_in|pack_in|transfer/i.test(r.t)) {
      if (!first.has(r.c) || t < first.get(r.c)) first.set(r.c, t);
      for (const e of es) if (!epcIn.has(e)) { epcIn.set(e, t); epcRef.set(e, String(r.ref || "").split("-/").pop()); epcProd.set(e, r.c); }
      if (es.length) { if (!sizes.has(r.c)) sizes.set(r.c, new Map()); const sz = r3(r.q / es.length); sizes.get(r.c).set(sz, (sizes.get(r.c).get(sz) || 0) + es.length); }
    }
    for (const e of es) {
      const each = r.q / es.length;
      balNow.set(e, (balNow.get(e) || 0) + each);
      if (t <= END) balEnd.set(e, (balEnd.get(e) || 0) + each);
      if (r.q < 0 && t > TAGS_AT && !outAfter.has(e)) outAfter.set(e, { t, ref: r.ref, type: r.t });
    }
  }

  // ---------- POS: orders, TRF, pending, stock now ----------
  const ORD = ld("pos-orders.json").filter((o) => !o.err), TRF = ld("pos-trf.json"), PEND = ld("pos-pending.json").filter((o) => !o.err), NOWS = ld("pos-stock-now.json");
  const NOW_AT = Date.parse(NOWS.at);
  const mv = []; // {pid, t, base, ch, ref, qr, nwDone}
  for (const o of ORD) { const t = Date.parse(o.completed_date); for (const it of o.items) mv.push({ pid: it.product_id, t, base: Number(it.base_quantity) || 0, ch: o.type === "ONLINE" ? "ONLINE" : "OFFLINE", ref: o.code, qr: it.qr || [], nwDone: !!(refs.get(it.product_id) && refs.get(it.product_id).has(o.code)), nwDed: nwDed.get(it.product_id + "|" + o.code) || 0 }); }
  for (const tr of TRF) { if (tr.status !== "COMPLETED") continue; const t = Date.parse(tr.completed_at); for (const it of tr.items || []) mv.push({ pid: it.product_id, t, base: Number(it.base_quantity) || it.detailQty || 0, ch: "TRF", ref: tr.code + " → " + tr.dest, qr: it.qr || [], nwDone: !!(refs.get(it.product_id) && refs.get(it.product_id).has(tr.code)), nwDed: nwDed.get(it.product_id + "|" + tr.code) || 0 }); }
  const pendNow = new Map();
  for (const o of PEND) { if (!/AWAITING_SHIPMENT|READY_TO_PICK|SHIPPING/.test(o.status) || o.type !== "ONLINE") continue; for (const it of o.items) { pendNow.set(it.product_id, (pendNow.get(it.product_id) || 0) + (Number(it.base_quantity) || 0)); mv.push({ pid: it.product_id, t: Date.parse(o.created_date), base: Number(it.base_quantity) || 0, ch: "ONLINE chờ giao", ref: o.code + " (" + o.status + ")", qr: it.qr || [], nwDone: !!(refs.get(it.product_id) && refs.get(it.product_id).has(o.code)) }); } }
  const mvBy = new Map(); for (const m of mv) { if (!mvBy.has(m.pid)) mvBy.set(m.pid, []); mvBy.get(m.pid).push(m); }
  const posNow = new Map();
  for (const r of NOWS.rows) { const o = posNow.get(r.pid) || { q: 0, locs: {} }; const locs = r.locs && r.locs.length ? r.locs : [{ loc: "(không vị trí)", q: r.q }]; for (const l of locs) { if (fold(l.loc) === "kho that lac") continue; o.q += Number(l.q) || 0; if (Number(l.q)) o.locs[l.loc] = (o.locs[l.loc] || 0) + Number(l.q); } posNow.set(r.pid, o); }
  const baseNw = new Map(), basePos = new Map();
  for (const r of LG) if (r.base && !baseNw.has(r.c)) baseNw.set(r.c, r.base);
  const fupNw = new Map(); for (const r of LG) if (r.fup && !fupNw.has(r.c)) fupNw.set(r.c, r.fup); // NW print unit (đơn vị in trên tem)
  for (const r of NOWS.rows) if (r.base && !basePos.has(r.pid)) basePos.set(r.pid, r.base);
  const locText = (c) => { const p = posNow.get(c); return p ? Object.entries(p.locs).sort((a, b) => b[1] - a[1]).map(([l, v]) => l + ":" + v).join(", ") : ""; };

  // direct evidence: QR on an order/TRF line = unit UID of a tag
  const qrs = [...new Set(mv.flatMap((m) => m.qr))];
  const qrMap = qrs.length ? await batch("/tags/by-uid/batch", "uids", qrs) : [];
  const epcByQr = new Map(qrMap.filter((x) => x.mapped && x.epc).map((x) => [x.uid, x.epc]));
  const soldEpc = new Map(); for (const m of mv) for (const q of m.qr) { const e = epcByQr.get(q); if (e && !soldEpc.has(e)) soldEpc.set(e, m); }

  // tags stocked in on NW after the app loaded its list (TAGS_AT) and never read: the app cannot list them as unscanned
  const seenAll = new Set([...D.map((r) => r.EPC), ...U.map((r) => r.EPC), ...X.map((r) => String(r.EPC))]);
  let lateN = 0;
  for (const [e, t] of epcIn) if (t > TAGS_AT && t <= END && (balEnd.get(e) || 0) > 1e-9 && !seenAll.has(e)) { U.push({ "Mã sản phẩm": epcProd.get(e), "Tên hàng": "", EPC: e, UID: "", "Số lượng thật": "", "Tình trạng": "", Kho: "Lumina", _late: true }); lateN++; }
  // resolve the tags that need a look on NW
  const exc = X.map((r) => String(r.EPC));
  const toResolve = [...new Set([...U.map((r) => r.EPC), ...D.filter((r) => !r["Kho"]).map((r) => r.EPC), ...exc.filter((e) => /^[0-9A-F]{24}$/i.test(e))])];
  const RES = new Map((await batch("/integrations/circa/epcs/resolve", "epcs", toResolve)).map((x) => [x.epc, x]));
  const uidLike = exc.filter((e) => /^\d{13}[A-Z0-9]/.test(e) && !/^0{4}/.test(e));
  const UIDR = new Map((uidLike.length ? await batch("/tags/by-uid/batch", "uids", uidLike.map((e) => e.replace(/F+$/, ""))) : []).map((x) => [x.uid, x]));
  // "Không nhận ra mã" that NW knows in this warehouse = tags stocked in after the app loaded its list: they were scanned,
  // so count them for their product (otherwise that product looks short)
  const excLum = new Set();
  for (const r of X) { const e = String(r.EPC), z = RES.get(e); if (r["Loại"] === "Kho khác" || !z || !z.found || String(z.warehouseId).toLowerCase() !== WH || !z.circaProductId) continue; excLum.add(e); D.push({ "Mã sản phẩm": String(z.circaProductId), "Tên hàng": "", EPC: e, UID: z.unitUid || "", Kho: "", "Tình trạng": "", _exc: true }); }
  // mis-encoded labels: the code read looks like a UID; if that UID belongs to a tag in "Thẻ chưa quét", the item was on the shelf
  const misEnc = new Map(); for (const e of uidLike) { const u = UIDR.get(e.replace(/F+$/, "")); if (u && u.mapped && u.epc) misEnc.set(u.epc, e); }
  const noKho = D.filter((r) => !r["Kho"]);
  const names = new Map(TH.map((r) => [code(r), r["Tên hàng"]]));
  for (const r of D) if (!r["Tên hàng"]) r["Tên hàng"] = names.get(code(r)) || (imp.get(code(r)) || {}).name || "";
  for (const c of new Set(D.filter((r) => r._exc).map(code))) if (!names.has(c)) TH.push({ "Mã sản phẩm": c, "Tên hàng": (imp.get(c) || {}).name || "", "Quy đổi": "" });

  // ---------- per product ----------
  const scBy = new Map(), unBy = new Map();
  for (const r of D) { const c = code(r); if (!scBy.has(c)) scBy.set(c, []); scBy.get(c).push(r); }
  for (const r of U) { const c = code(r); if (!unBy.has(c)) unBy.set(c, []); unBy.get(c).push(r); }
  const CAT = { G: "g. Có trên kệ nhưng tem ghi sai EPC (app đọc ra mã dạng UID)", F: "f. NW đã trừ sau 15:45 (bán/xuất trong hoặc sau phiên)", OFFLINE: "a. Đã bán OFFLINE, NW chưa trừ", ONLINE: "b. Đã bán ONLINE, NW chưa trừ", TRF: "c. Đã chuyển TRF, NW chưa trừ", PEND: "d. Đơn ONLINE chờ giao", E1: "e1. NW nhiều thẻ hơn tồn POS, không thấy đơn", E2: "e2. POS còn hàng → cần tìm" };
  const chCat = { OFFLINE: CAT.OFFLINE, ONLINE: CAT.ONLINE, TRF: CAT.TRF, "ONLINE chờ giao": CAT.PEND };
  const A = { sp: 0, T: 0, sc: 0, scSnap: 0, un: U.length, newSc: noKho.length, Eimp: 0, scEimp: 0, Elo: 0, Ehi: 0, scE: 0, short: 0, over: 0, st: {}, cat: {}, inSess: 0, recv: 0 };
  const rowsP = [], rowsU = [];
  for (const r of TH) {
    const c = code(r), i = imp.get(c), scR = scBy.get(c) || [], unR = unBy.get(c) || [];
    const name = (i && i.name) || r["Tên hàng"];
    // tags present in the session for this product: 15:45 list (scanned + unscanned) + scanned tags outside the list that NW has in this warehouse
    const extra = scR.filter((x) => !x["Kho"]).map((x) => x.EPC).filter((e) => { const z = RES.get(e); return z && z.found && String(z.warehouseId).toLowerCase() === WH; });
    const tags = [...scR.filter((x) => x["Kho"]).map((x) => x.EPC), ...unR.map((x) => x.EPC), ...extra];
    const mis = unR.filter((u) => misEnc.has(u.EPC)).length;
    const T = tags.length, sc = scR.length + mis; // a mis-encoded label was physically read
    const sz = sizes.get(c) ? mode(sizes.get(c)) : null;
    const ratio = i && i.ratio > 0 ? i.ratio : (Number(r["Quy đổi"]) || sz || 1);
    // NW base → POS base: 1 when both systems use the same base unit (mixed tag sizes must not distort it), else ratio / usual tag size
    const conv = !baseNw.get(c) || !basePos.get(c) || fold(baseNw.get(c)) === fold(basePos.get(c)) ? 1 : sz > 0 ? ratio / sz : 1;
    const qPOS = tags.map((e) => { const b = balEnd.get(e); return (b > 1e-9 ? b : sz || ratio / conv) * conv; });
    // POS stock: import snapshot (incl. pending ONLINE added back), sales/TRF during the session, receipts since then
    const ms = mvBy.get(c) || [];
    const done = (a, b) => ms.filter((m) => m.ch !== "ONLINE chờ giao" && m.t > a && m.t <= b).reduce((s, m) => s + m.base, 0);
    const soldSess = done(IMP_AT, END), soldToNow = done(IMP_AT, NOW_AT);
    const S0 = i ? i.S : null;
    const nowAdd = (posNow.get(c) ? posNow.get(c).q : 0) + (pendNow.get(c) || 0);
    const recv = S0 == null ? 0 : Math.max(0, r3(nowAdd + soldToNow - S0)); // stock that came in after the import (POS receipt, adjustment, return)
    const Shi = S0 == null ? r3(nowAdd + soldToNow) : r3(S0 + recv), Slo = Math.max(0, r3(Shi - soldSess));
    // POS stock is the standard: expected tags are never capped by the NW tag count; POS stock beyond all tags = goods without a tag
    const szPos = (sz || ratio / conv) * conv;
    const Ehi = need(qPOS, Shi, szPos), Elo = need(qPOS, Slo, szPos), untag = Elo - cover(qPOS, Slo);
    A.untag = (A.untag || 0) + untag; if (untag) A.untagSp = (A.untagSp || 0) + 1;
    // loose sales since the product was first tagged, not deducted on NW for it
    const fi = first.get(c);
    const loose = new Set(); for (const m of ms) { if ((m.ch !== "OFFLINE" && m.ch !== "ONLINE") || m.nwDone || (fi && m.t < fi) || m.t > END) continue; const rem = m.base % ratio; if (rem > 1e-6 && ratio - rem > 1e-6) loose.add(m.ref); }
    const Em = emax(T, Shi, ratio, loose.size, Ehi, OPEN_MAX);
    const status = !i ? "Ngoài file import (thẻ mới)" : sc < Elo ? "Thiếu" : sc <= Ehi ? (sc < Ehi ? "Khớp (có bán trong lúc kiểm)" : "Khớp") : sc <= Em ? "Khớp nhờ hộp lẻ" : "Dư";
    A.sp++; A.T += T; A.sc += sc; A.scSnap += scR.filter((x) => x["Kho"]).length; A.st[status] = (A.st[status] || 0) + 1;
    if (i) { A.Eimp += i.E; A.scEimp += Math.min(sc, i.E); A.Elo += Elo; A.Ehi += Ehi; A.scE += Math.min(sc, Ehi); }
    if (sc < Elo) A.short += Elo - sc; if (sc > Em) A.over += sc - Em; if (soldSess > 0) A.inSess++; if (recv > 0) A.recv++;
    // unscanned tags → cause (NW view). Capacity for "explained" = tags beyond what POS stock needs at the low end.
    const assign = new Map();
    for (const u of unR) { const e = u.EPC, o = outAfter.get(e); if (misEnc.has(e)) { assign.set(e, { cat: CAT.G, ev: "app đọc ra " + misEnc.get(e) }); continue; } if (o) { assign.set(e, { cat: CAT.F, ev: `${o.type} ${fmt(o.t)} ${o.ref || ""}` }); continue; } const m = soldEpc.get(e); if (m && !m.nwDone && m.t <= END) assign.set(e, { cat: chCat[m.ch], ev: `${m.ref} ${fmt(m.t)} (QR = UID thẻ này)` + (m.t > IMP_AT ? " · trong lúc kiểm" : "") }); }
    // capacity = tags beyond what POS stock needs (T − E_lo). A pending ONLINE box is INSIDE S (added back), so its unscanned
    // tag does not use that capacity: it stays short vs POS, labelled d.
    const nPend = [...assign.values()].filter((a) => a.cat === CAT.PEND).length;
    let left = Math.max(0, Math.min(unR.length - mis - nPend, T - Elo) - [...assign.values()].filter((a) => a.cat !== CAT.G && a.cat !== CAT.PEND).length);
    const pool = [];
    // POS qty still not deducted on NW: whole line, or the rest of a line NW only partly deducted (e.g. 3 of 5 boxes)
    const remOf = (m) => (!m.nwDone ? m.base : m.nwDed > 0 ? Math.max(0, r3(m.base - m.nwDed * conv)) : 0);
    const since = ms.filter((m) => remOf(m) > 1e-6 && (!fi || m.t >= fi || m.nwDed > 0) && m.t <= END);
    for (const ch of ["OFFLINE", "ONLINE", "TRF"]) {
      const sm = since.filter((m) => m.ch === ch), base = sm.reduce((s, m) => s + remOf(m), 0);
      const direct = [...assign.values()].filter((a) => a.cat === chCat[ch]).length; // units already proven by QR = UID
      let n = Math.min(left, Math.max(0, Math.ceil(base / ratio - 1e-9) - direct));
      const rf = [...new Set(sm.map((m) => m.ref + (m.nwDone ? ` (NW mới trừ ${r3(m.nwDed * conv)}/${m.base})` : "")))];
      for (let k = 0; k < n; k++) pool.push({ cat: chCat[ch], ev: "theo số lượng bán: " + rf.slice(0, 5).join(", ") + (rf.length > 5 ? "…" : "") }); left -= n;
    }
    for (let k = 0; k < left; k++) pool.push({ cat: CAT.E1, ev: `POS ${S0 != null ? S0 : "?"} lúc import, thẻ ${T}; không thấy đơn/TRF từ khi gắn thẻ` });
    for (const u of unR) if (!assign.has(u.EPC)) assign.set(u.EPC, pool.shift() || { cat: CAT.E2, ev: "" });
    for (const u of unR) { const a = assign.get(u.EPC), z = RES.get(u.EPC) || {}; A.cat[a.cat] = (A.cat[a.cat] || 0) + 1; rowsU.push([c, name, u.EPC, u.UID || z.unitUid || "", u["Số lượng thật"] || z.baseQuantity || "", u["Tình trạng"], fmt(epcIn.get(u.EPC)), epcRef.get(u.EPC) || "", z.found ? z.status : "không có", a.cat, a.ev, locText(c), u._late ? "nhập NW sau khi app tải danh sách, app không liệt kê" : ""]); }
    const nE2 = unR.filter((u) => assign.get(u.EPC).cat === CAT.E2).length;
    // why does it differ from POS? A: NW tag quantity/unit wrong · A3: mixed tag sizes, scan plausible · B: counted more than POS
    // C: every NW tag read but POS higher (untagged goods or POS too high) · D: C + tags not found · E: tags not found
    const bN = baseNw.get(c) || "", fp = fupNw.get(c) || "", bP = basePos.get(c) || bN;
    const qNw = tags.map((e) => { const b = balEnd.get(e); return b > 1e-9 ? r3(b) : sz; }).filter((x) => x > 0);
    const szs = [...new Set(qNw)].sort((x, y) => y - x);
    const gs = (KiemDem.ratioFor && KiemDem.ratioFor(name, bN)) || [];
    const pack = gs[1] > 1 && fp && fold(gs[0]) === fold(fp) ? gs[1] : 0; // pack size from the name, e.g. (h/100v) → hộp = 100 viên
    const n1 = pack ? qNw.filter((x) => x === 1).length : 0, nBig = fp && bN && fold(fp) === fold(bN) ? qNw.filter((x) => x > 1).length : 0;
    const scSet = new Set(scR.map((x) => x.EPC));
    const scQ = r3(tags.filter((e) => scSet.has(e)).reduce((s, e) => { const b = balEnd.get(e); return s + (b > 1e-9 ? b : sz || ratio / conv) * conv; }, 0));
    let issue = n1 ? `thẻ in theo ${fp} (= ${pack} ${bN} theo tên SP) nhưng NW ghi 1 ${bN}/thẻ ở ${n1} thẻ` : nBig ? `thẻ in theo ${fp} nhưng NW ghi ${szs.filter((x) => x > 1).join("/")} ${bN}/thẻ ở ${nBig} thẻ` : "";
    if (!issue && status === "Dư" && scQ <= Slo + 1e-6) issue = `quét ${sc} thẻ > dự kiến ${Em} nhưng tổng số lượng trên các thẻ đã quét chỉ ${scQ} ${bP} ≤ tồn POS ${Slo} → số lượng ghi trên thẻ NW lớn hơn thực tế`;
    const mixHi = szs.length > 1 ? needAsc(qPOS, Shi, szPos) : 0;
    let cause = "";
    if (status === "Thiếu" || status === "Dư") {
      if (issue) cause = "A. Thẻ NW ghi sai số lượng/đơn vị → quy ra dự kiến sai: " + issue;
      else if (szs.length > 1 && sc >= Elo && sc <= mixHi) cause = `A3. Lẫn cỡ thẻ ${szs.join("/")} ${bN}: quét ${sc} nằm trong khoảng hợp lý ${Elo}–${mixHi} (tuỳ thẻ nào còn trên kệ)`;
      else if (status === "Dư") cause = `B. Quét ${sc} thẻ, vượt tối đa ${Em} thẻ theo tồn POS ${Slo} ${bP} (số lượng ghi trên các thẻ đã quét: ${scQ} ${bP}) → tồn POS thấp hơn thực tế (hoặc NW nhập dư)`;
      else if (untag && !nE2) cause = `C. Đã quét đủ thẻ NW (${scQ} ${bP}) mà tồn POS ${Slo} → hàng chưa gắn tem, hoặc tồn POS cao hơn thực tế ${r3(Slo - scQ)} ${bP}`;
      else if (untag) cause = `D. ${nE2} thẻ NW không thấy và POS còn ${untag} ${(i && i.unit) || ""} chưa có thẻ`;
      else cause = "E. Thẻ NW không quét thấy → tìm hàng (cột Cần tìm / Đơn online chờ giao)";
    }
    if (cause) { A.cause = A.cause || {}; const k = cause.slice(0, cause.indexOf(".")); A.cause[k] = (A.cause[k] || 0) + 1; }
    if (status !== "Khớp" || unR.length) rowsP.push([c, name, (i && i.unit) || r["Đơn vị RFID"], ratio, status, T, sc, unR.length, extra.length, i ? i.E : "", Elo, Ehi, Em, loose.size, Math.max(0, Elo - sc), Math.max(0, sc - Em), nE2, S0 != null ? S0 : "", r3(soldSess), recv || "", Shi, Slo, posNow.get(c) ? r3(posNow.get(c).q) : 0, pendNow.get(c) || "", fmt(fi), locText(c),
      status === "Thiếu" ? (untag ? `POS còn ${untag} ${(i && i.unit) || ""} chưa có thẻ NW (gắn tem / đếm tay); ` : "") + "Tìm thẻ chưa quét (sheet Thẻ chưa quét, nhóm e2) / kiểm tồn POS" : status === "Dư" ? "Quét nhiều hơn tồn POS: hàng còn mà POS đã trừ, hoặc NW nhập dư" : status === "Khớp nhờ hộp lẻ" ? "Dồn hộp lẻ rồi cập nhật số lượng thẻ trên NW" : "", untag, cause, scQ, bP]);
  }

  // ---------- scanned tags outside the 15:45 list ----------
  const rowsN = noKho.map((r) => { const z = RES.get(r.EPC) || {}; const tIn = epcIn.get(r.EPC); let g;
    if (!z.found) g = "Chưa có trên NW (tem chưa nhập kho)";
    else if (String(z.warehouseId).toLowerCase() !== WH) g = "Thẻ của kho khác";
    else if (tIn && tIn > TAGS_AT) g = "Nhập NW sau " + fmt(TAGS_AT).slice(11) + " (lúc " + fmt(tIn).slice(11) + ")";
    else if (z.status === "active") g = "Có trên NW Lumina trước " + fmt(TAGS_AT).slice(11) + " nhưng không trong danh sách của app";
    else g = "NW đã trừ (" + z.status + ") nhưng hàng vẫn còn trên kệ" + (outAfter.get(r.EPC) ? "" : "");
    return [code(r), r["Tên hàng"], r.EPC, r.UID, z.found ? z.status : "không có", fmt(tIn), epcRef.get(r.EPC) || "", g, r._exc ? "app báo Không nhận ra mã" : "app hiện trong Chi tiết thẻ"]; });
  // ---------- exceptions ----------
  const ROLL = /^(A51A1B5156F8D|B51A1B510CC55|E28069150000[45]0|E280F302)/;
  const unSet = new Set(U.map((x) => x.EPC));
  const rowsX = X.map((r) => { const e = String(r.EPC), z = RES.get(e) || {}, u = UIDR.get(e.replace(/F+$/, "")); let g, d = "";
    if (r["Loại"] === "Kho khác") { g = "Thẻ kho khác nằm ở Lumina"; d = z.found ? `${z.status}, SP ${z.circaProductId}` : ""; }
    else if (/^\d{13}[A-Z0-9]/.test(e) && !/^0{4}/.test(e)) { g = "Tem ghi sai EPC (đọc ra mã dạng UID)"; d = u && u.mapped ? `UID này là thẻ ${u.epc} (${u.status})` + (unSet.has(u.epc) ? " → thẻ đó nằm trong 'Thẻ chưa quét', đã tính là có trên kệ" : "") : "UID không map thẻ nào"; }
    else if (!/^[0-9A-F]{24}$/i.test(e)) g = /^\d+$/.test(e) ? "Mã số ngắn (không phải tem Circa)" : "Mã không chuẩn (không phải EPC 24 ký tự)";
    else if (!z.found) g = ROLL.test(e) ? "Dải tem Circa nhưng chưa nhập NW" : "EPC lạ, không có trên NW";
    else if (excLum.has(e)) { const ti = epcIn.get(e); g = ti > TAGS_AT ? "Thẻ Lumina nhập NW sau khi app tải danh sách (đã tính là quét)" : "Thẻ Lumina có trên NW nhưng app không nhận ra (đã tính là quét)"; d = `nhập ${fmt(ti)} · SP ${z.circaProductId}`; }
    else { g = "Có trên NW nhưng không thuộc Lumina hoặc không gắn SP"; d = `${z.status} · SP ${z.circaProductId || "?"} · nhập ${fmt(epcIn.get(e))}`; }
    return [r["Loại"], e, r["Tên hàng"], r["Mã"], z.found ? z.status : "", g, d]; });

  // ---------- workbook ----------
  const grp = (rows, k) => Object.entries(rows.reduce((m, r) => { const x = typeof k === "function" ? k(r) : r[k]; m[x] = (m[x] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
  // ---------- per product: products with tags not scanned (the list the store works from) ----------
  // env PREV = an earlier session export (Kiểm kê or Kiểm đếm): was each tag to find also missing / seen there?
  let prevSeen = null, prevMiss = null;
  const prevName = process.env.PREV ? path.basename(process.env.PREV) : "";
  if (process.env.PREV) {
    const pw = XLSX.read(fs.readFileSync(process.env.PREV), { type: "buffer" });
    const pj = (n) => (pw.Sheets[n] ? XLSX.utils.sheet_to_json(pw.Sheets[n], { defval: "" }) : []);
    prevSeen = new Set([...pj("Chi tiết quét").filter((r) => r["Trạng thái"] === "Đã quét").map((r) => r.EPC), ...pj("Chi tiết thẻ").map((r) => r.EPC)]);
    prevMiss = new Set([...pj("Danh sách kiểm kê").flatMap((r) => String(r["EPC chưa quét (có thể thiếu)"] || "").split(/,\s*/).filter(Boolean)), ...pj("Thẻ chưa quét").map((r) => r.EPC)]);
  }
  const pRow = new Map(rowsP.map((r) => [r[0], r])), byP = new Map();
  for (const u of rowsU) { if (!byP.has(u[0])) byP.set(u[0], []); byP.get(u[0]).push(u); }
  const key = { [CAT.E2]: "e2", [CAT.OFFLINE]: "a", [CAT.ONLINE]: "b", [CAT.TRF]: "c", [CAT.PEND]: "d", [CAT.E1]: "e1", [CAT.F]: "f", [CAT.G]: "g" };
  const rowsSP = [], AP = { sp: 0, find: 0, findTags: 0, none: 0, soldOnly: 0, e1Only: 0, prevBoth: 0, short: 0, shortN: 0, untag: 0, untagN: 0 };
  // every product short vs POS (even when all its NW tags were read) or with unscanned tags
  const spKeys = new Set([...rowsP.filter((r) => r[14] > 0).map((r) => r[0]), ...byP.keys()]);
  for (const c of spKeys) {
    const us = byP.get(c) || [], p = pRow.get(c) || [], n = {};
    const untag = p[27] || 0;
    us.forEach((u) => { const k = key[u[9]] || "?"; n[k] = (n[k] || 0) + 1; });
    const unit = p[2] || "", T = p[5] || us.length, sc = p[6] || 0, sold = (n.a || 0) + (n.b || 0) + (n.c || 0);
    const days = [...new Set(us.map((u) => String(u[6]).slice(0, 10)).filter(Boolean))].sort().map((d) => d.slice(8, 10) + "/" + d.slice(5, 7)).join(", ");
    const vch = [...new Set(us.map((u) => u[7]).filter(Boolean))], rolls = [...new Set(us.map((u) => String(u[2]).slice(0, 13)))];
    const evid = [...new Set(us.filter((u) => /^[abcd]\./.test(u[9])).flatMap((u) => String(u[10]).match(/(DHC|TRF)\w+/g) || []))];
    const toFind = us.filter((u) => key[u[9]] === "e2");
    const prevBoth = prevMiss ? toFind.filter((u) => prevMiss.has(u[2])).length : "", prevSeenN = prevSeen ? toFind.filter((u) => prevSeen.has(u[2])).length : "";
    const todo = [];
    if (/^A\./.test(p[28] || "")) todo.push("Kiểm cỡ thẻ thực tế, sửa số lượng/đơn vị thẻ trên NW (ghi lên NW, cần duyệt) rồi tính lại");
    if (untag) todo.push(`POS còn ${untag} ${unit} chưa có thẻ trên NW: tìm hàng, gắn tem + nhập NW; không có hàng → chỉnh giảm tồn POS`);
    if (n.e2) todo.push(`Tìm ${n.e2} ${unit}${sc === 0 ? " (không quét được thẻ nào của SP)" : ""}${p[25] ? " ở " + p[25] : ""}`);
    if (sold) todo.push(`Trừ NW ${sold} thẻ đã bán/chuyển`);
    if (n.d) todo.push(`${n.d} thẻ thuộc đơn ONLINE chờ giao`);
    if (n.e1) todo.push(`NW dư ${n.e1} thẻ so với POS: kiểm lại số nhập NW / tồn POS`);
    if (n.f) todo.push(`${n.f} thẻ NW đã trừ trong lúc kiểm`);
    AP.sp++; if (n.e2) { AP.find++; AP.findTags += n.e2; } if (sc === 0) AP.none++;
    if (!n.e2 && !n.e1) AP.soldOnly++; else if (!n.e2 && n.e1 && !sold && !n.d) AP.e1Only++;
    if (prevBoth) AP.prevBoth++;
    if (p[14] > 0) { AP.short++; AP.shortN += p[14]; } if (untag) { AP.untag++; AP.untagN += untag; }
    rowsSP.push([c, p[1] || (us[0] && us[0][1]) || "", unit, p[3] || "", T, sc, us.length, n.e2 || 0, n.a || 0, n.b || 0, n.d || 0, n.e1 || 0, p[10] === undefined ? "" : p[10] === p[11] ? p[11] : `${p[10]}–${p[11]}`, p[14] || 0, untag || 0, p[9] === undefined ? "" : p[9], p[17] === undefined ? "" : p[17], p[19] || "", p[18] || "", p[22] === undefined ? "" : p[22], p[23] || "", p[25] || (us[0] && us[0][11]) || "", days, vch.slice(0, 6).join(" ") + (vch.length > 6 ? " …" : ""), rolls.join(" "), prevBoth, prevSeenN, evid.slice(0, 6).join(" ") + (evid.length > 6 ? " …" : ""), p[28] || "", p[29] === undefined ? "" : p[29], todo.join("; ")]);
  }
  // products whose gap vs POS comes from data (POS stock or NW tag quantities), not from goods missing
  const GRP = { A: "A. Thẻ NW ghi sai số lượng/đơn vị", A3: "A3. Lẫn cỡ thẻ, số quét hợp lý", B: "B. Tồn POS thấp hơn số đếm", C: "C. Quét đủ thẻ, tồn POS cao hơn", D: "D. Thiếu thẻ + tồn POS chưa gắn tem", E: "E. Thẻ NW không quét thấy (thiếu hàng)" };
  const rowsD = rowsP.filter((r) => /^(A|A3|B|C|D)\./.test(r[28] || "")).map((r) => {
    const k = r[28].slice(0, r[28].indexOf(".")), diff = k === "A" || k === "A3" ? "" : r3(r[29] - r[21]), dT = r[4] === "Dư" ? r[6] - r[12] : r[6] - r[10];
    const act = k === "A" ? "Kiểm cỡ thẻ thực tế, sửa số lượng/đơn vị thẻ trên NW (ghi lên NW, cần duyệt), rồi tính lại; chưa chỉnh POS" : k === "A3" ? "Không chỉnh POS (khớp nếu tính đúng cỡ thẻ còn trên kệ)" : k === "B" ? `Đếm lại số lượng thực tế; nếu đúng thì chỉnh TĂNG tồn POS (theo số lượng trên thẻ tối đa +${diff} ${r[30]}, ít hơn nếu có hộp đã mở), hoặc xuất NW phần nhập dư` : k === "C" ? `Tìm hàng chưa gắn tem; không có thì chỉnh GIẢM tồn POS ${-diff} ${r[30]}` : "Tìm thẻ không thấy và hàng chưa gắn tem trước khi chỉnh POS";
    return [r[0], r[1], GRP[k], r[28].slice(r[28].indexOf(".") + 2), r[4], r[5], r[6], r[10] === r[11] ? r[11] : `${r[10]}–${r[11]}`, r[9], r[29], r[21], r[30], dT, diff, r[25], act];
  });
  const gOrd = { A: 0, A3: 1, B: 2, C: 3, D: 4 };
  rowsD.sort((a, b) => gOrd[a[2].split(".")[0]] - gOrd[b[2].split(".")[0]] || Math.abs(b[12]) - Math.abs(a[12]) || Math.abs(+b[13] || 0) - Math.abs(+a[13] || 0));
  rowsSP.sort((a, b) => b[13] - a[13] || b[7] - a[7] || b[6] - a[6] || String(a[1]).localeCompare(String(b[1])));
  const abcd = [CAT.F, CAT.OFFLINE, CAT.ONLINE, CAT.TRF, CAT.PEND].reduce((s, k) => s + (A.cat[k] || 0), 0);
  const snapT = A.scSnap + A.un - lateN;
  const sum = [
    ["Chỉ tiêu", "Giá trị", "Ghi chú"],
    ["Phiên", `Kiểm đếm ${KHO} · danh sách thẻ lúc ${fmt(TAGS_AT)} · xuất ${fmt(END)}`, path.basename(SESS)],
    ["File Dự kiến đã nạp", path.basename(IMP), "tồn POS lúc " + fmt(IMP_AT)],
    ["Dữ liệu đối chiếu kéo lúc", fmt(NOW_AT), "sổ kho NW, đơn POS từ 08/11, TRF, đơn chờ giao, tồn POS"],
    [],
    ["THEO NW (giống cột Trạng thái của app)", "", ""],
    ["Thẻ Lumina trong danh sách 15:45", snapT, ""], ["Đã quét", A.scSnap, pct(A.scSnap, snapT)], ["Chưa quét", A.un - lateN, pct(A.un - lateN, snapT)], ["Thẻ nhập NW sau " + fmt(TAGS_AT).slice(11) + " không quét thấy (app không liệt kê)", lateN, "đã thêm vào danh sách chưa quét"],
    ["Thẻ quét được ngoài danh sách 15:45", A.newSc, `sheet 'Quét ngoài danh sách' (gồm ${excLum.size} thẻ app báo "Không nhận ra mã" nhưng là thẻ Lumina nhập sau 15:45)`],
    ...Object.values(CAT).map((k) => ["  " + k, A.cat[k] || 0, pct(A.cat[k] || 0, A.un)]),
    ["% nếu bỏ các thẻ đã bán/xuất có đơn (a–d, f)", pct(A.scSnap, snapT - abcd), `còn ${snapT - abcd} thẻ`],
    ["% nếu bỏ thêm e1", pct(A.scSnap, snapT - abcd - (A.cat[CAT.E1] || 0)), `còn ${snapT - abcd - (A.cat[CAT.E1] || 0)} thẻ`],
    [],
    ["SẢN PHẨM THIẾU SO VỚI POS HOẶC CÓ THẺ CHƯA QUÉT", AP.sp, "sheet 'SP thiếu & chưa quét' (mỗi dòng 1 SP)"],
    ["  thiếu so với tồn POS", AP.short, `${AP.shortN} thẻ`],
    ["  trong đó POS còn hàng chưa có thẻ trên NW", AP.untag, `${AP.untagN} thẻ (Dự kiến của app đã bỏ sót phần này)`],
    ["  có hàng cần tìm (POS còn hàng)", AP.find, `${AP.findTags} thẻ`],
    ["  không quét được thẻ nào của SP", AP.none, ""],
    ["  chỉ do đã bán / chuyển / chờ giao mà NW chưa trừ", AP.soldOnly, "không cần tìm, cần trừ NW"],
    ["  chỉ do NW nhiều thẻ hơn tồn POS", AP.e1Only, "kiểm lại số nhập NW / tồn POS"],
    ...(prevMiss ? [["  có thẻ cần tìm cũng thiếu ở phiên trước", AP.prevBoth, prevName]] : []),
    [],
    ["NGUYÊN NHÂN LỆCH (SP thiếu hoặc dư so với POS)", Object.values(A.cause || {}).reduce((s, v) => s + v, 0), "cột 'Nguyên nhân lệch'; nhóm A–D ở sheet 'Lệch do dữ liệu'"],
    ...Object.keys(GRP).map((k) => ["  " + GRP[k], (A.cause || {})[k] || 0, k === "E" ? "thiếu hàng thật (theo dữ liệu hiện có)" : "lệch do dữ liệu POS/NW, không phải mất hàng"]),
    [],
    ["THEO POS (mục đích của Kiểm đếm)", "", ""],
    ["Dự kiến trong phiên (E lúc import)", A.Eimp, "= cột Dự kiến của app"], ["Quét được, tính tối đa E mỗi SP", A.scEimp, pct(A.scEimp, A.Eimp)],
    ["Dự kiến chỉnh lại (E_hi: thẻ lúc kiểm + hàng nhập sau 15:14)", A.Ehi, ""], ["Dự kiến thấp nhất (E_lo: trừ hết hàng bán 15:14→" + fmt(END).slice(11) + ")", A.Elo, `${A.inSess} SP có bán/xuất trong lúc kiểm`],
    ["Quét được, tính tối đa E_hi", A.scE, pct(A.scE, A.Ehi)],
    ["Thẻ thiếu so với POS (dưới E_lo)", A.short, "cần tìm / kiểm lại tồn POS"], ["Thẻ dư so với POS (trên E_max)", A.over, "hàng còn mà POS đã trừ, hoặc NW nhập dư"],
    ...Object.entries(A.st).sort((a, b) => b[1] - a[1]).map(([k, v]) => ["  SP " + k, v, ""]),
    [],
    ["NGOẠI LỆ trong phiên", X.length, ""], ...grp(rowsX, 5).map(([k, v]) => ["  " + k, v, ""]),
    [],
    ["Đơn POS hoàn tất từ 08/11 / TRF hoàn tất / QR map trúng thẻ", `${ORD.length} / ${TRF.filter((t) => t.status === "COMPLETED").length} / ${epcByQr.size} QR`, "QR trên đơn = UID thẻ là bằng chứng thẻ đã bán"],
  ];
  const out = XLSX.utils.book_new();
  const add = (n, aoa, w) => { const ws = XLSX.utils.aoa_to_sheet(aoa); if (w) ws["!cols"] = w.map((x) => ({ wch: x })); XLSX.utils.book_append_sheet(out, ws, n); };
  add("SP thiếu & chưa quét", [["Mã SP", "Tên sản phẩm", "Đơn vị RFID", "Quy đổi", "Thẻ NW", "Đã quét", "Chưa quét", "Cần tìm (POS còn hàng)", "Đã bán tại quầy, NW chưa trừ", "Đã bán online, NW chưa trừ", "Đơn online chờ giao", "NW dư so với POS", "Dự kiến theo POS (tính lại lúc kiểm)", "Thiếu so với POS", "Trong đó: POS còn hàng chưa có thẻ NW", "Dự kiến trên app (file import)", "Tồn POS lúc tạo file (gồm đơn chờ giao)", "POS nhập thêm sau khi tạo file", "Bán/xuất trong lúc kiểm", "Tồn POS hiện tại", "Đơn online chờ giao (POS đã trừ)", "Vị trí POS", "Ngày nhập NW (thẻ chưa quét)", "Phiếu nhập", "Cuộn tem", "Cần tìm, cũng thiếu ở phiên trước" + (prevName ? "" : " (không có)"), "Cần tìm, phiên trước có quét thấy" + (prevName ? "" : " (không có)"), "Đơn bán (bằng chứng)", "Nguyên nhân lệch", "SL đếm được theo thẻ (đơn vị tồn POS)", "Việc cần làm"], ...rowsSP], [9, 42, 8, 7, 7, 7, 8, 9, 9, 9, 8, 8, 10, 8, 10, 9, 10, 9, 9, 9, 9, 30, 18, 24, 16, 9, 9, 30, 60, 10, 60]);
  add("Lệch do dữ liệu", [["Mã SP", "Tên sản phẩm", "Nhóm", "Chi tiết", "Kết quả theo POS", "Thẻ NW", "Đã quét", "Dự kiến theo POS", "Dự kiến trên app", "SL đếm được theo thẻ", "Tồn POS cuối phiên (gồm đơn chờ giao)", "Đơn vị tồn POS", "Chênh (thẻ quét − dự kiến)", "Chênh số lượng (theo thẻ − POS)", "Vị trí POS", "Việc cần làm"], ...rowsD], [9, 42, 30, 70, 10, 7, 7, 9, 9, 10, 10, 8, 9, 10, 24, 60]);
  add("Tổng quan", sum, [58, 40, 60]);
  const ord = { "Thiếu": 0, "Dư": 1, "Khớp nhờ hộp lẻ": 2, "Ngoài file import (thẻ mới)": 3, "Khớp (có bán trong lúc kiểm)": 4, "Khớp": 5 };
  rowsP.sort((a, b) => ord[a[4]] - ord[b[4]] || b[14] - a[14] || b[15] - a[15] || b[7] - a[7]);
  add("SP theo POS", [["Mã", "Tên sản phẩm", "Đơn vị RFID", "Quy đổi", "Kết quả theo POS", "Thẻ NW (lúc kiểm)", "Đã quét", "Chưa quét", "Thẻ mới ngoài DS", "Dự kiến app (E 15:14)", "E thấp nhất", "E cao nhất", "E tối đa (hộp lẻ)", "Đơn bán lẻ", "Thiếu so POS", "Dư so POS", "Thẻ cần tìm (e2)", "Tồn POS 15:14", "Bán/xuất trong lúc kiểm", "Nhập thêm sau 15:14", "Tồn cao nhất", "Tồn thấp nhất", "Tồn POS hiện tại", "ONLINE chờ giao", "Gắn thẻ lần đầu", "Vị trí POS", "Gợi ý"], ...rowsP], [9, 42, 8, 7, 22, 8, 7, 7, 7, 8, 7, 7, 7, 7, 7, 7, 7, 8, 8, 8, 8, 8, 8, 8, 16, 28, 40]);
  rowsU.sort((a, b) => a[9].localeCompare(b[9]) || a[1].localeCompare(b[1]));
  add("Thẻ chưa quét", [["Mã", "Tên sản phẩm", "EPC", "UID", "SL trên thẻ", "Tình trạng", "Nhập NW lúc", "Phiếu nhập", "Trạng thái NW hiện tại", "Nguyên nhân", "Bằng chứng", "Vị trí POS", "Ghi chú"], ...rowsU], [9, 42, 26, 18, 7, 8, 16, 11, 12, 44, 50, 28]);
  add("Quét ngoài danh sách", [["Mã", "Tên sản phẩm", "EPC", "UID", "Trạng thái NW", "Nhập NW lúc", "Phiếu nhập", "Nhận định", "Trên app"], ...rowsN], [9, 42, 26, 18, 12, 16, 11, 50, 24]);
  // miss rate per tag roll (15:45 list only)
  const roll = (e) => (/^E2806915000/.test(e) ? e.slice(0, 13) : e.slice(0, 13));
  const rr = new Map(); for (const r of D) if (r["Kho"]) { const k = roll(r.EPC); const x = rr.get(k) || [0, 0]; x[0]++; rr.set(k, x); } for (const r of U) { const k = roll(r.EPC); const x = rr.get(k) || [0, 0]; x[1]++; rr.set(k, x); }
  add("Theo cuộn tem", [["Đầu EPC (cuộn)", "Đã quét", "Chưa quét", "% chưa quét", "Chưa quét nhóm e2"], ...[...rr].sort((a, b) => b[1][1] - a[1][1]).map(([k, x]) => [k, x[0], x[1], pct(x[1], x[0] + x[1]), rowsU.filter((u) => roll(u[2]) === k && u[9] === CAT.E2).length])], [18, 10, 10, 12, 16]);
  add("Ngoại lệ", [["Loại (app)", "EPC / mã", "Tên hàng", "Mã", "Trạng thái NW", "Nhận định", "Chi tiết"], ...rowsX], [16, 28, 36, 14, 12, 56, 50]);
  fs.writeFileSync(OUTF, Buffer.from(XLSX.write(out, { type: "array", bookType: "xlsx" })));
  console.log(JSON.stringify({ END: fmt(END), TAGS_AT: fmt(TAGS_AT), NOW: fmt(NOW_AT), A, newTags: grp(rowsN, 7).slice(0, 6), exc: grp(rowsX, 5), misEnc: misEnc.size, misEncInUnscanned: [...misEnc.keys()].filter((e) => unSet.has(e)).length, qr: [epcByQr.size, qrs.length] }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
