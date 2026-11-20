// Read-only. Every line a store sold in a window that Nextwaves has NOT deducted, and what (if anything) to deduct.
// usage: node store-pending.js <fromISO> [toISO]
// env NW_KEY, POS_TOKEN (never written), POS_STORE (default Lumina), WH (default Lumina), OUT (file prefix, default "store-pending"),
//     OVERRIDES (optional json {"DHC…": {"uids": ["<QR the user confirmed>"]}} — only these QRs are used for that order's lines)
// Per POS line: need = base_quantity − what the NW order (if any) already deducted for that product. Then:
//   KHONG_QUAN_LY  product never stocked into WH on Nextwaves → nothing to deduct
//   TRU_DUOC       a scanned QR resolves (by-uid, generations source tags/label_print) to an active WH tag of the product
//   CAN_KIEM       not resolved, but WH still has active tags of the product whose label was minted BEFORE the sale → physical check
//   IT_KHA_NANG    CAN_KIEM, but for the product NW active stock − proposed deductions ≤ POS on_hand → no sign a tagged unit was left
//   KHONG_CO_THE   no active WH tag minted before the sale → the sold unit carried no Nextwaves tag → nothing to deduct
//   Also writes <OUT>-gap.csv: per product NW stock vs POS stock after the proposed deductions.
// Outputs <OUT>.json, <OUT>.csv (UTF-8 BOM, one row per line with need>0), <OUT>-<DHC>.payload.json for orders with TRU_DUOC lines.
const fs = require("fs");
const NW = "https://api-circa.nextwaves.app/api/v1/public";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const S = process.env.POS_STORE || "31493e74-3404-4c0e-a906-93691a6ee319";
const WH = (process.env.WH || "3f7bd541-7370-4ce0-9048-231cf061e91a").toLowerCase();
const WHN = { "eb5e2b4f-6f92-413b-90ef-6be1730b94c0": "Florita", "3f7bd541-7370-4ce0-9048-231cf061e91a": "Lumina" };
const OUT = process.env.OUT || "store-pending";
const OVR = process.env.OVERRIDES ? JSON.parse(fs.readFileSync(process.env.OVERRIDES, "utf8")) : {};
const BLOCK = ["DHC01294054", "DHC01299037", "DHC01208344", "DHC01254831"];
const [from, to = new Date().toISOString()] = process.argv.slice(2);
const vn = (t) => { const ms = typeof t === "number" ? t : Date.parse(t); return isFinite(ms) ? new Date(ms + 7 * 3600e3).toISOString().slice(5, 16).replace("T", " ") : ""; };
const mint = (uid) => { const m = /^(\d{13})/.exec(String(uid || "")); const t = m ? Number(m[1]) : NaN; return t > 1.6e12 && t < 2.0e12 ? t : null; };
const lotKey = (s) => String(s || "").split("-")[0].trim().toUpperCase();
async function req(url, opt = {}) { for (let a = 0; a < 5; a++) { try { const r = await fetch(url, Object.assign({ signal: AbortSignal.timeout(30000) }, opt)); if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1200 * (a + 1))); continue; } return { s: r.status, j: await r.json().catch(() => null) }; } catch (_) { await new Promise((s) => setTimeout(s, 1000)); } } return { s: 0, j: null }; }
const nwH = () => ({ accept: "application/json", "content-type": "application/json", authorization: "Bearer " + process.env.NW_KEY });
const nw = (p) => req(NW + p, { headers: nwH() });
const pos = (p) => req("https://api.v2.circa.vn" + p, { headers: { accept: "application/json", authorization: "Bearer " + process.env.POS_TOKEN, "x-circa-app": "pos", "x-client-id": "1", "x-store-id": S, "user-agent": UA, origin: "https://pos.v2.circa.vn", referer: "https://pos.v2.circa.vn/" } });
async function pmap(arr, n, fn) { const out = new Array(arr.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < arr.length) { const k = i++; out[k] = await fn(arr[k], k); } })); return out; }
const list = (j) => (Array.isArray(j) ? j : (j && (j.data || j.items || j.results)) || []);
const csvq = (v) => { const s = v == null ? "" : String(v); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

(async () => {
  if (!process.env.NW_KEY || !process.env.POS_TOKEN) throw new Error("thiếu NW_KEY / POS_TOKEN");
  // 1. POS orders (windowed listing) + details
  const rowsList = await require("./pos-orders").listCompleted(pos, S, from, to);
  console.log("POS: " + rowsList.length + " đơn COMPLETED " + from + " → " + to);
  const orders = (await pmap(rowsList, 5, async (o) => { const d = (await pos("/v1/order/" + o.id + "?get_rating=true")).j; return d && d.data && d.data.order; })).filter(Boolean);
  if (orders.length !== rowsList.length) console.log("CẢNH BÁO: đọc chi tiết được " + orders.length + "/" + rowsList.length + " đơn");
  orders.sort((a, b) => Date.parse(a.completed_date) - Date.parse(b.completed_date));
  // 2. NW order per code
  const nwOrd = {};
  const ordOne = async (o) => { const g = await nw("/orders/" + encodeURIComponent(o.code)); nwOrd[o.code] = g.s === 200 ? g.j : g.s; };
  await pmap(orders, 4, ordOne);
  for (let round = 0; round < 6; round++) { const bad = orders.filter((o) => ![404].includes(nwOrd[o.code]) && typeof nwOrd[o.code] !== "object"); if (!bad.length) break; await new Promise((r) => setTimeout(r, 3000 * (round + 1))); for (const o of bad) await ordOne(o); }
  // 3. WH ledger → products + EPCs ever stocked in WH
  const ledger = [];
  // /stock/ledger ignores offset/page (always the newest 200 rows) — page with afterLedgerNumber (ascending cursor)
  for (let after = 0, i = 0; i < 1000; i++) { const a = list((await nw(`/stock/ledger?warehouseId=${WH}&limit=200&afterLedgerNumber=${after}`)).j).filter((r) => String(r.warehouseId).toLowerCase() === WH); if (!a.length) break; ledger.push(...a); const mx = Math.max(...a.map((r) => Number(r.ledgerNumber) || 0)); if (mx <= after) break; after = mx; if (a.length < 200) break; }
  const prod = {}; // circaId → {title, baseUnit, epcs:Set, ledgerSum}
  for (const r of ledger) { const c = String((r.product && r.product.externalProductId) || ""); if (!c) continue; const P = (prod[c] = prod[c] || { title: r.product.title, baseUnit: r.product.baseUnitOfMeasure, epcs: new Set(), ledgerSum: 0, nwPid: r.productId }); P.ledgerSum += Number(r.quantity) || 0; (r.epcs || []).forEach((e) => P.epcs.add(e)); }
  console.log(`NW ledger kho: ${ledger.length} dòng · ${Object.keys(prod).length} sản phẩm`);
  // 4. resolve every sold QR
  const uids = new Set();
  for (const o of orders) for (const it of o.items || []) [it.qr_code].concat(it.qr_codes || []).filter((x) => typeof x === "string" && x.trim()).forEach((x) => uids.add(x.replace(/^.*\//, "").trim()));
  const res = {}; const U = [...uids];
  for (let i = 0; i < U.length; i += 25) {
    const b = (await req(NW + "/tags/by-uid/batch", { method: "POST", headers: nwH(), body: JSON.stringify({ uids: U.slice(i, i + 25) }) })).j;
    const arr = (b && (b.results || b.data || b.items)) || b || [];
    (Array.isArray(arr) ? arr : Object.values(arr)).forEach((x) => { if (x && x.uid && x.mapped && x.epc) res[x.uid] = { via: "trực tiếp", epcs: [x.epc] }; });
  }
  const genOne = async (u) => {
    for (const f of [u, "thuocsi.vn/qr/" + u, "qr.v2.circa.vn/item/" + u]) {
      const g = await nw("/printing/labels/generations/" + encodeURIComponent(f));
      if (g.s === 0 || g.s === 429) { res[u] = { via: "lỗi tra", epcs: [] }; return; }
      if (g.s !== 200 || !g.j) continue;
      const isParent = (g.j.children || []).every((c) => c.unitUid !== u);
      const kids = (g.j.children || []).filter((c) => c.mapped && c.epc);
      res[u] = { via: (isParent ? "tem gốc" : "tem con") + " (" + g.j.source + ")", epcs: isParent ? kids.map((c) => c.epc) : kids.filter((c) => c.unitUid === u).map((c) => c.epc), gen: g.j.source };
      return;
    }
    res[u] = { via: "không ra", epcs: [] };
  };
  await pmap(U.filter((u) => !res[u]), 4, genOne);
  for (let round = 0; round < 6; round++) { const bad = U.filter((u) => res[u] && res[u].via === "lỗi tra"); if (!bad.length) break; await new Promise((r) => setTimeout(r, 3000 * (round + 1))); for (const u of bad) await genOne(u); }
  if (U.some((u) => res[u].via === "lỗi tra")) console.log("CẢNH BÁO: còn QR tra lỗi (429) — kết quả có thể thiếu");
  // 5. EPC facts: every WH EPC + every resolved EPC
  const allE = new Set(); Object.values(prod).forEach((P) => P.epcs.forEach((e) => allE.add(e))); Object.values(res).forEach((r) => r.epcs.forEach((e) => allE.add(e)));
  const E = {};
  const getE = async (e) => { const h = (await nw("/integrations/circa/epcs/" + e)).j || {}; E[e] = { epc: e, status: String(h.status || "?").toLowerCase(), wh: String(h.warehouseId || "").toLowerCase(), hold: Number(h.baseQuantity) || 0, baseUnit: h.baseUnit, unit: h.unit, ratio: h.unitRatio, uid: h.unitUid, circa: String(h.circaProductId || ""), mint: mint(h.unitUid) }; };
  await pmap([...allE], 4, getE);
  // 429s leave status "?" → retry sequentially with a pause; never silently undercount (bug seen 12/11: 24–48 of ~920 failed)
  for (let round = 0; round < 6; round++) { const bad = Object.values(E).filter((t) => t.status === "?").map((t) => t.epc); if (!bad.length) break; await new Promise((r) => setTimeout(r, 3000 * (round + 1))); for (const e of bad) await getE(e); }
  const stillBad = Object.values(E).filter((t) => t.status === "?").map((t) => t.epc);
  if (stillBad.length) console.log("CẢNH BÁO: " + stillBad.length + " EPC tra không được (429?) — kết quả có thể thiếu: " + stillBad.slice(0, 10).join(","));
  for (const P of Object.values(prod)) { P.active = [...P.epcs].map((e) => E[e]).filter((t) => t && t.status === "active" && t.wh === WH); P.nwStock = P.active.reduce((s, t) => s + t.hold, 0); }
  // 6. evaluate lines, chronologically, allocating EPC holdings globally
  const left = {}; Object.values(E).forEach((t) => (left[t.epc] = t.hold));
  const pid2c = {}; Object.entries(prod).forEach(([c, P]) => (pid2c[P.nwPid] = c));
  const out = [];
  for (const o of orders) {
    const n = nwOrd[o.code]; const onNw = n && typeof n === "object";
    const nwWh = onNw ? String(n.warehouseId || "").toLowerCase() : null;
    const nwItems = onNw ? list(n.items) : [];
    const covered = {}; // productSku is often null on NW order lines → fall back to the line's EPC / NW productId (bug fixed 12/11)
    nwItems.forEach((l) => { const c = String(l.productSku || "").replace(/^CIRCA-/, "") || (E[l.tagEpc] && E[l.tagEpc].circa) || pid2c[l.productId] || "?"; covered[c] = (covered[c] || 0) + Number(l.baseQuantity || 0); });
    const nwEpcs = new Set(nwItems.map((l) => l.tagEpc).filter(Boolean));
    const O = { code: o.code, id: o.id, type: o.type, sold: vn(o.completed_date), soldMs: Date.parse(o.completed_date), by: o.created_by_name || "", ret: (o.order_return_codes || []).filter(Boolean).join(" "), nw: onNw ? `${n.orderNumber} ${n.status}${nwWh !== WH ? " (kho " + (WHN[nwWh] || nwWh) + ")" : ""}` : "chưa có (" + n + ")", nwWh, lines: [], tags: {} };
    for (const it of o.items || []) {
      const c = String(it.product_id), base = Number(it.base_quantity) || 0;
      const name = (it.product && it.product.name) || it.product_name || c;
      let qrs = [...new Set([it.qr_code].concat(it.qr_codes || []).filter((x) => typeof x === "string" && x.trim()).map((x) => x.replace(/^.*\//, "").trim()))];
      if (OVR[o.code] && OVR[o.code].uids) qrs = qrs.filter((q) => OVR[o.code].uids.includes(q));
      const cov = Math.min(base, covered[c] || 0); if (covered[c]) covered[c] -= cov;
      const L = { product: name, circa: c, qty: it.quantity + " " + it.unit, base, lot: it.lot_date || "", qrs, qrInfo: qrs.map((q) => q + " → " + (res[q] ? res[q].via + (res[q].epcs.length ? " " + res[q].epcs.map((e) => e.slice(-8)).join("/") : "") : "?")).join("; "), covered: cov, need: base - cov, take: [], notes: [] };
      O.lines.push(L);
      if (L.need <= 0) { L.cls = "DA_TRU"; continue; }
      if (onNw && nwWh !== WH) L.notes.push("đơn NW nằm ở kho " + (WHN[nwWh] || nwWh));
      const P = prod[c];
      if (!P) { L.cls = "KHONG_QUAN_LY"; continue; }
      // a) scanned QRs → EPCs
      for (const q of qrs) for (const e of (res[q] || { epcs: [] }).epcs) {
        const t = E[e]; if (!t) continue;
        if (L.need <= 0) { if (t.status === "active" && t.circa === c) L.notes.push("thừa tem " + q + "→" + e.slice(-8)); continue; }
        if (nwEpcs.has(e)) { L.notes.push(e.slice(-8) + " đã nằm trên đơn NW"); continue; }
        if (t.circa !== c) { L.notes.push(q + "→" + e.slice(-8) + " là SP CIRCA-" + t.circa); continue; }
        if (t.status !== "active") { L.notes.push(q + "→" + e.slice(-8) + " đã " + t.status); continue; }
        if (t.wh !== WH) { L.notes.push(q + "→" + e.slice(-8) + " đang ở kho " + (WHN[t.wh] || t.wh)); continue; }
        if (t.mint && t.mint > O.soldMs) L.notes.push(e.slice(-8) + " tem in SAU lúc bán (" + vn(t.mint) + ")");
        const take = Math.min(L.need, left[e] || 0); if (take <= 0) { L.notes.push(e.slice(-8) + " hết lượng (đã phân cho đơn trước)"); continue; }
        left[e] -= take; L.need -= take; L.take.push({ epc: e, quantity: take, via: q }); O.tags[e] = (O.tags[e] || 0) + take;
      }
      if (L.take.length) L.cls = L.need > 0 ? "TRU_DUOC_MOT_PHAN" : "TRU_DUOC";
      if (L.need <= 0) continue;
      // b) candidates: active WH tags of the product, label minted before the sale, holding left
      const cand = P.active.filter((t) => (left[t.epc] || 0) > 0 && (!t.mint || t.mint < O.soldMs));
      L.cand = cand.map((t) => t.epc);
      if (!L.take.length) L.cls = cand.length ? "CAN_KIEM" : "KHONG_CO_THE";
      else if (cand.length) L.cls = "TRU_DUOC_MOT_PHAN";
      if (!cand.length && P.active.length) L.notes.push(`${P.active.length} thẻ active nhưng tem in sau lúc bán (sớm nhất ${vn(Math.min(...P.active.map((t) => t.mint || 9e12)))})`);
    }
    out.push(O);
  }
  // 7. candidate details (POS lot of tag UID, parentUid) + POS product stock, only where needed
  const needP = new Set(); const needE = new Set();
  out.forEach((O) => O.lines.forEach((L) => { if (["CAN_KIEM", "TRU_DUOC_MOT_PHAN", "TRU_DUOC", "KHONG_CO_THE"].includes(L.cls)) { needP.add(L.circa); (L.cand || []).forEach((e) => needE.add(e)); L.take.forEach((x) => needE.add(x.epc)); } }));
  await pmap([...needE], 6, async (e) => {
    const t = E[e]; const ck = (await nw(`/tags/${e}/check?warehouseId=${WH}`)).j || {}; t.parent = ck.parentUid || (ck.data && ck.data.parentUid) || null;
    if (t.uid) { const q = (await pos(`/v1/pos/${S}/qr/${t.uid}`)).j; const d = q && q.data; t.lot = d ? (d.lot_date || (d.lot_detail && d.lot_detail.lot_date) || (typeof d.lot === "string" ? d.lot : d.lot && d.lot.lot_date) || "") : ""; }
  });
  const posStock = {};
  Object.entries(prod).forEach(([c, P]) => { if (P.nwStock > 0) needP.add(c); });
  await pmap([...needP], 5, async (c) => { const r = (await pos(`/v1/inventory/admin/stock/search?query=keyword=${c},pos_id=${S},include_negative_qty=true,&limit=20&page=1&is_count_status=true`)).j; // one row PER SKU/seller (e.g. CIRCA_MKP marketplace row = 0 + CIRCA row = real stock) → SUM the rows of this product (bug fixed 12/11)
    const rows = ((r && r.data && r.data.list) || []).filter((x) => String(x.product_id) === c && (!x.pos_id || x.pos_id === S)); posStock[c] = r && r.data && Array.isArray(r.data.list) ? rows.reduce((t, x) => t + (Number(x.on_hand_qty) || 0), 0) : "?"; });
  // 7b. product gap: NW active stock − deductions proposed here − POS on_hand. > 0 ⇒ NW still holds more than POS ⇒ some tagged unit left without deduction.
  const autoTake = {}; out.forEach((O) => O.lines.forEach((L) => L.take.forEach((x) => (autoTake[L.circa] = (autoTake[L.circa] || 0) + x.quantity))));
  const gap = {};
  for (const c of needP) { const P = prod[c]; if (!P) continue; const ps = typeof posStock[c] === "number" ? posStock[c] : null; gap[c] = { circa: c, title: P.title, unit: P.baseUnit, nw: P.nwStock, tags: P.active.length, auto: autoTake[c] || 0, pos: ps, residual: ps == null ? null : P.nwStock - (autoTake[c] || 0) - ps, lines: 0 }; }
  out.forEach((O) => O.lines.forEach((L) => { if (L.cls === "CAN_KIEM" || L.cls === "TRU_DUOC_MOT_PHAN") { const G = gap[L.circa]; if (G) G.lines++; if (L.cls === "CAN_KIEM" && G && G.residual != null && G.residual <= 0) { L.cls = "IT_KHA_NANG"; L.notes.push(`NW ${G.nw} − sắp trừ ${G.auto} ≤ POS ${G.pos}`); } } }));
  fs.writeFileSync(OUT + "-gap.csv", "﻿" + [["CIRCA", "Sản phẩm", "Đơn vị", "Tồn NW (thẻ active)", "Số thẻ", "Sắp trừ (đề xuất)", "Tồn POS", "NW − sắp trừ − POS", "Dòng cần kiểm"]].concat(Object.values(gap).sort((a, b) => (b.residual ?? -1e9) - (a.residual ?? -1e9)).map((G) => [G.circa, G.title, G.unit, G.nw, G.tags, G.auto, G.pos ?? "?", G.residual ?? "?", G.lines])).map((r) => r.map(csvq).join(",")).join("\r\n"));
  // 8. write
  const csv = [["Nhóm", "Đơn", "Bán lúc", "Loại", "Thu ngân", "Trả hàng", "Đơn trên NW", "Sản phẩm", "CIRCA", "SL bán", "Base", "Còn phải trừ", "Lô bán", "QR đã quét → kết quả", "Đề xuất trừ (EPC × lượng)", "Thẻ ứng viên (EPC · tem · tem gốc · lô · giữ)", "Tồn NW kho", "Tồn POS", "NW − sắp trừ − POS", "Ghi chú"]];
  const order = { TRU_DUOC: 1, TRU_DUOC_MOT_PHAN: 2, CAN_KIEM: 3, IT_KHA_NANG: 4, KHONG_CO_THE: 5, KHONG_QUAN_LY: 6 };
  const flat = [];
  out.forEach((O) => O.lines.forEach((L) => { if (L.cls !== "DA_TRU") flat.push([O, L]); }));
  flat.sort((a, b) => order[a[1].cls] - order[b[1].cls] || a[0].soldMs - b[0].soldMs);
  for (const [O, L] of flat) {
    const P = prod[L.circa];
    const candTxt = (L.cand || []).map((e) => { const t = E[e]; const lm = L.lot && t.lot && lotKey(t.lot) === lotKey(L.lot) ? "✓lô" : ""; return `${e.slice(-8)} · ${t.uid || "-"} · gốc ${t.parent || "-"} · lô ${t.lot || "?"}${lm} · giữ ${left[e]}`; }).join(" | ");
    csv.push([L.cls, O.code, O.sold, O.type, O.by, O.ret, O.nw, L.product, L.circa, L.qty, L.base, L.need, L.lot, L.qrInfo, L.take.map((x) => `${x.epc} × ${x.quantity}`).join(" + "), candTxt, P ? P.nwStock + " " + (P.baseUnit || "") : "", posStock[L.circa] ?? "", gap[L.circa] ? gap[L.circa].residual ?? "?" : "", L.notes.join("; ")]);
  }
  fs.writeFileSync(OUT + ".csv", "﻿" + csv.map((r) => r.map(csvq).join(",")).join("\r\n"));
  const payloads = [];
  for (const O of out) {
    const tags = Object.entries(O.tags).map(([epc, quantity]) => ({ epc, quantity }));
    if (!tags.length || BLOCK.includes(O.code) || /APITEST/i.test(O.code)) continue;
    const f = `${OUT}-${O.code}.payload.json`; fs.writeFileSync(f, JSON.stringify({ orderId: O.code, warehouseId: WH, tags }, null, 1)); payloads.push({ code: O.code, file: f, addToExisting: !!O.nwWh, tags });
  }
  fs.writeFileSync(OUT + ".json", JSON.stringify({ from, to, orders: out, res, epcs: E, prod: Object.fromEntries(Object.entries(prod).map(([k, P]) => [k, Object.assign({}, P, { epcs: [...P.epcs], active: P.active.map((t) => t.epc) })])), posStock, gap, payloads }, null, 1));
  // 9. summary
  const cnt = {}; flat.forEach(([, L]) => (cnt[L.cls] = (cnt[L.cls] || 0) + 1));
  const ordCls = (O) => { const c = O.lines.map((L) => L.cls); if (c.every((x) => x === "DA_TRU")) return "DA_TRU_DU"; for (const k of ["TRU_DUOC", "TRU_DUOC_MOT_PHAN", "CAN_KIEM", "IT_KHA_NANG"]) if (c.includes(k)) return k; return "KHONG_CAN_TRU"; };
  const oc = {}; out.forEach((O) => (oc[ordCls(O)] = (oc[ordCls(O)] || 0) + 1));
  console.log("Dòng chưa trừ theo nhóm:", JSON.stringify(cnt));
  console.log("Đơn theo nhóm:", JSON.stringify(oc), "· đơn có trên NW:", out.filter((O) => O.nwWh).length);
  console.log("QR:", JSON.stringify(Object.values(res).reduce((m, r) => ((m[r.via.replace(/ \(.*/, "")] = (m[r.via.replace(/ \(.*/, "")] || 0) + 1), m), {})));
  console.log("payload:", payloads.map((p) => p.code + (p.addToExisting ? "(ADD)" : "")).join(" "));
})().catch((e) => { console.error(e); process.exit(1); });
