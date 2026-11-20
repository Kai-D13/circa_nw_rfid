// Read-only: per-product active tag stats (+ one active EPC sample) for a NW warehouse
const fs = require("fs");
const NW = "https://api-circa.nextwaves.app/api/v1/public", WH = (process.argv[2] || "3f7bd541-7370-4ce0-9048-231cf061e91a").toLowerCase(), OUT = process.argv[3] || "kd/nw-tags2.json";
const get = async (p) => { for (let k = 0; k < 6; k++) { const r = await fetch(NW + p, { headers: { authorization: "Bearer " + process.env.NW_KEY } }); if (r.status === 429) { await new Promise((s) => setTimeout(s, 1500 * (k + 1))); continue; } return r.json(); } };
(async () => {
  const L = []; for (let after = 0; ;) { const r = await get(`/stock/ledger?warehouseId=${WH}&limit=1000&afterLedgerNumber=${after}`); const a = (r && r.data) || []; if (!a.length) break; L.push(...a.filter((x) => String(x.warehouseId).toLowerCase() === WH)); if (!(r.nextAfter > after)) break; after = r.nextAfter; }
  const bal = {}, prod = {};
  for (const r of L) {
    const c = String((r.product && r.product.externalProductId) || r.productId);
    const P = (prod[c] ||= { circa: c, nwId: r.productId, title: r.product && r.product.title, baseUnit: r.product && r.product.baseUnitOfMeasure, fup: r.product && r.product.customAttributes && r.product.customAttributes["final-unit-print"], sizes: {} });
    const es = r.epcs || [];
    es.forEach((e) => { (bal[e] ||= { c, q: 0 }).q += Number(r.quantity) / es.length; });
    if (+r.quantity > 0 && /stock_in|pack_in|transfer/.test(r.actionType) && es.length) { const sz = Math.round((r.quantity / es.length) * 1000) / 1000; P.sizes[sz] = (P.sizes[sz] || 0) + es.length; }
  }
  for (const [e, b] of Object.entries(bal)) { const q = Math.round(b.q * 1000) / 1000; if (q > 0) { const P = prod[b.c]; P.tags = (P.tags || 0) + 1; P.qty = (P.qty || 0) + q; P.sample ||= e; (P.activeSizes ||= {})[q] = (P.activeSizes[q] || 0) + 1; } }
  const latest = L.reduce((m, r) => (r.occurredAt > m ? r.occurredAt : m), "");
  const out = { wh: WH, latest, rows: L.length, products: Object.values(prod).map((P) => ({ ...P, tags: P.tags || 0, qty: Math.round((P.qty || 0) * 1000) / 1000 })) };
  fs.writeFileSync(OUT, JSON.stringify(out));
  const ps = out.products.filter((p) => p.tags > 0);
  console.log("ledger", L.length, "· latest", latest, "· products with active tags", ps.length, "· tags", ps.reduce((s, p) => s + p.tags, 0), "· qty", ps.reduce((s, p) => s + p.qty, 0));
})();
