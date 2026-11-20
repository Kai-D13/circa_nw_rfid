// Read-only. node prod-tags.js <circaProductId> [uid]  — NW stock + every EPC ever stocked for the product (both wh) with its UID/holding/POS lot. env NW_KEY, POS_TOKEN
const NW = "https://api-circa.nextwaves.app/api/v1/public";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const WH = { Florita: ["eb5e2b4f-6f92-413b-90ef-6be1730b94c0", "c476efb2-415c-429a-978e-d389b4b06607"], Lumina: ["3f7bd541-7370-4ce0-9048-231cf061e91a", "31493e74-3404-4c0e-a906-93691a6ee319"] };
const vn = (t) => (t ? new Date(Date.parse(t) + 7 * 3600e3).toISOString().slice(0, 16).replace("T", " ") : "");
const g = async (p) => { const r = await fetch(NW + p, { headers: { accept: "application/json", authorization: "Bearer " + process.env.NW_KEY } }); return { s: r.status, j: await r.json().catch(() => null) }; };
const pos = async (store, p) => { const r = await fetch("https://api.v2.circa.vn" + p, { headers: { accept: "application/json", authorization: "Bearer " + process.env.POS_TOKEN, "x-circa-app": "pos", "x-client-id": "1", "x-store-id": store, "user-agent": UA, origin: "https://pos.v2.circa.vn", referer: "https://pos.v2.circa.vn/" } }); return { s: r.status, j: await r.json().catch(() => null) }; };
(async () => {
  const CID = process.argv[2], UID = process.argv[3];
  const p = (await g("/products/by-external/" + CID)).j || {};
  const pid = p.id || (p.product && p.product.id);
  console.log("NW product", pid, p.title || p.name || (p.product && p.product.title));
  const epcs = {};
  for (const [n, [w, store]] of Object.entries(WH)) {
    const ip = (await g(`/stock/inventory-position?productId=${pid}&warehouseId=${w}`)).j;
    const d = (ip && ip.data && ip.data[0]) || ip || {};
    let rows = [];
    for (let after = 0, i = 0; i < 100; i++) { const a = (await g(`/stock/ledger?productId=${pid}&warehouseId=${w}&limit=200&afterLedgerNumber=${after}`)).j; const l = Array.isArray(a) ? a : (a && (a.data || a.items)) || []; rows.push(...l); if (!l.length) break; const mx = Math.max(...l.map((r) => Number(r.ledgerNumber) || 0)); if (mx <= after || l.length < 200) break; after = mx; } // offset is ignored by /stock/ledger
    console.log(`\n== ${n}: NW totalStock ${d.totalStock} · ledger ${rows.length} rows`);
    rows.forEach((e) => { console.log("  ", vn(e.occurredAt), e.actionType || e.type, e.quantity, e.actionReference || "", (e.epcs || []).join(",")); (e.epcs || []).forEach((x) => (epcs[x] = 1)); });
    // POS lot stock (location level) for the UID's lot
    if (UID) {
      const q = (await pos(store, `/v1/pos/${store}/qr/${UID}`)).j; const ld = q && q.data && q.data.lot_detail;
      console.log(`   POS ${n} lô ${q && q.data && q.data.lot}: lot on_hand ${ld ? ld.on_hand_qty : "—"} · location ${ld ? JSON.stringify((ld.simplify_location_details || []).map((x) => (x.location_name || x.name || "") + ":" + x.on_hand_qty)) : "—"} · lot tạo ${ld ? vn(ld.created_at) : "—"}`);
    }
  }
  console.log("\n== EPCs of product:", Object.keys(epcs).length);
  for (const e of Object.keys(epcs)) {
    const h = (await g("/integrations/circa/epcs/" + e)).j || {};
    let lot = "";
    if (h.unitUid) { const st = String(h.warehouseId).toLowerCase() === WH.Lumina[0] ? WH.Lumina[1] : WH.Florita[1]; const q = (await pos(st, `/v1/pos/${st}/qr/${h.unitUid}`)).j; lot = q && q.data ? q.data.lot : "?"; }
    const whn = String(h.warehouseId).toLowerCase() === WH.Lumina[0] ? "Lumina" : String(h.warehouseId).toLowerCase() === WH.Florita[0] ? "Florita" : h.warehouseId;
    console.log("  ", e, h.status, whn, "giữ", h.baseQuantity, h.baseUnit, "· unit", h.unit, "×" + h.unitRatio, "· UID", h.unitUid, "· lô POS", lot);
  }
})().catch((e) => { console.error(e); process.exit(1); });
