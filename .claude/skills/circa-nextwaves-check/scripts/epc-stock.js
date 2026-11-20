// Reference implementation (Node 18+, read-only).
// Usage: NW_KEY=... node nw-epc-stock.js <circaProductId> <warehouseId> [--epcs] [--verify]
const NW_BASE = "https://api-circa.nextwaves.app/api/v1/public";

async function nwGet(path) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(NW_BASE + path, {
      headers: { Accept: "application/json", Authorization: "Bearer " + process.env.NW_KEY },
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); continue; }
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }
  throw new Error("NW_RATE_LIMITED");
}

async function getNwEpcStock(circaProductId, warehouseId, { includeEpcs = false, verify = false } = {}) {
  const wh = String(warehouseId).toLowerCase();

  // 1) Circa product_id -> Nextwaves product (pass "1467", not "CIRCA-1467")
  const p = await nwGet(`/products/by-external/${encodeURIComponent(circaProductId)}`);
  if (p.status === 404) return { circaProductId: String(circaProductId), warehouseId: wh, found: false, epcCount: 0, epcQuantity: 0 };
  if (p.status !== 200) throw new Error(`NW product lookup failed: ${p.status}`);
  const product = p.body;

  // 2) Quantity totals (base unit) - one call
  const s = await nwGet(`/stock/summary?productId=${product.id}&warehouseId=${wh}`);
  if (s.status !== 200) throw new Error(`NW stock summary failed: ${s.status}`);
  const summary = s.body;

  // 3) Count EPC tags from the ledger (cursor paging; split each row's quantity evenly over its EPCs)
  const bal = new Map();
  for (let after = 0; ;) {
    const r = await nwGet(`/stock/ledger?productId=${product.id}&warehouseId=${wh}&limit=1000&afterLedgerNumber=${after}`);
    if (r.status !== 200) throw new Error(`NW ledger failed: ${r.status}`);
    const rows = (r.body && r.body.data) || [];
    if (!rows.length) break;
    for (const row of rows) {
      if (String(row.warehouseId).toLowerCase() !== wh) continue;
      const epcs = row.epcs || [];
      for (const e of epcs) bal.set(e, (bal.get(e) || 0) + Number(row.quantity) / epcs.length);
    }
    if (!(r.body.nextAfter > after)) break;
    after = r.body.nextAfter;
  }
  let tags = [...bal].map(([epc, q]) => ({ epc, quantity: Math.round(q * 1000) / 1000 })).filter((t) => t.quantity > 0);
  let epcQuantity = tags.reduce((t, x) => t + x.quantity, 0);
  let method = "ledger";

  // 4) Fallback / verify: confirm each EPC (1 call per EPC) when totals disagree or when asked
  if (verify || Math.abs(epcQuantity - (summary.rfidStock || 0)) > 0.001) {
    const candidates = [...bal.keys()];
    const active = [];
    for (let i = 0; i < candidates.length; i += 4) {
      await Promise.all(candidates.slice(i, i + 4).map(async (epc) => {
        const t = (await nwGet(`/integrations/circa/epcs/${epc}`)).body || {};
        if (t.status === "active" && String(t.warehouseId).toLowerCase() === wh) active.push({ epc, quantity: t.baseQuantity, unit: t.unit });
      }));
    }
    tags = active;
    epcQuantity = active.reduce((t, x) => t + (x.quantity || 0), 0);
    method = "verified";
  }

  const result = {
    circaProductId: String(circaProductId),
    nwProductId: product.id,
    productIdentifier: product.productIdentifier,
    title: product.title,
    baseUnit: product.baseUnitOfMeasure,
    warehouseId: wh,
    found: true,
    epcCount: tags.length,
    epcQuantity,
    rfidStock: summary.rfidStock,
    systemStock: summary.systemStock,
    untaggedStock: summary.untaggedStock,
    consistent: Math.abs(epcQuantity - (summary.rfidStock || 0)) <= 0.001,
    method,
  };
  if (includeEpcs) result.epcs = tags;
  return result;
}

module.exports = { getNwEpcStock };

if (require.main === module) {
  const [id, wh, ...flags] = process.argv.slice(2);
  getNwEpcStock(id, wh, { includeEpcs: flags.includes("--epcs"), verify: flags.includes("--verify") })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
