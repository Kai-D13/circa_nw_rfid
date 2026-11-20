// Read-only: pull the whole NW stock ledger of one warehouse (cursor afterLedgerNumber) in the compact form used by kiem-dem scripts.
// usage: NW_KEY=… node fetch-ledger.js <out.json> [warehouseId, default Lumina]
const fs = require("fs");
const NW = "https://api-circa.nextwaves.app/api/v1/public";
const [out, whArg] = process.argv.slice(2);
const WH = (whArg || "3f7bd541-7370-4ce0-9048-231cf061e91a").toLowerCase();
async function get(p) { for (let a = 0; a < 5; a++) { const r = await fetch(NW + p, { headers: { accept: "application/json", authorization: "Bearer " + process.env.NW_KEY } }).catch(() => null); if (r && r.ok) return r.json(); await new Promise((s) => setTimeout(s, 1500 * (a + 1))); } throw new Error("ledger fetch failed " + p); }
(async () => {
  const L = [];
  for (let after = 0; ;) {
    const j = await get(`/stock/ledger?warehouseId=${WH}&limit=1000&afterLedgerNumber=${after}`);
    const a = j.data || []; if (!a.length) break;
    for (const x of a) { if (String(x.warehouseId).toLowerCase() !== WH) continue; const pr = x.product || {}; L.push({ c: String(pr.externalProductId || x.productId), q: Number(x.quantity), t: x.actionType, at: x.occurredAt || x.createdAt, ref: x.actionReference, epcs: x.epcs || [], fup: pr.customAttributes && pr.customAttributes["final-unit-print"], base: pr.baseUnitOfMeasure, title: pr.title }); }
    if (!(j.nextAfter > after)) break; after = j.nextAfter;
  }
  fs.writeFileSync(out, JSON.stringify(L));
  console.log("ledger rows", L.length, "last at", L.map((r) => r.at).sort().pop());
})().catch((e) => { console.error(e.message); process.exit(1); });
