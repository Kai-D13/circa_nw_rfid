// READ-ONLY data pull for the 17/11 Lumina session analysis. env NW_KEY (LUMINA), POS_TOKEN.
// Writes kd/phien/*.json (no secrets, no customer fields).
// usage: node kd/fetch-phien.js <fromISO> <toISO>
const fs = require("fs"), path = require("path");
const { listCompleted } = require("../pos-orders.js");
const NW = "https://api-circa.nextwaves.app/api/v1/public";
const WH = "3f7bd541-7370-4ce0-9048-231cf061e91a", S = "31493e74-3404-4c0e-a906-93691a6ee319";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const FROM = process.argv[2] || "2026-11-10T17:00:00.000Z", TO = process.argv[3] || new Date().toISOString();
const OUT = process.env.PHIEN_DIR || path.join(__dirname, "phien"); // PHIEN_DIR: keep test fixtures in phien/ untouched
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function req(url, headers, opt = {}) {
  for (let t = 0; t < 6; t++) {
    try {
      const r = await fetch(url, { method: opt.method || "GET", headers, body: opt.body, signal: AbortSignal.timeout(60000) });
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * (t + 1)); continue; }
      return { s: r.status, j: await r.json().catch(() => null) };
    } catch (e) { await sleep(1500 * (t + 1)); }
  }
  return { s: 0, j: null };
}
const pos = (p) => req("https://api.v2.circa.vn" + p, { accept: "application/json", authorization: "Bearer " + process.env.POS_TOKEN, "x-circa-app": "pos", "x-client-id": "1", "x-store-id": S, "grpc-timeout": "30S", "user-agent": UA, origin: "https://pos.v2.circa.vn", referer: "https://pos.v2.circa.vn/" });
const nw = (p, opt) => req(NW + p, { accept: "application/json", authorization: "Bearer " + process.env.NW_KEY, "content-type": "application/json" }, opt);
async function pmap(arr, n, fn) { const out = new Array(arr.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < arr.length) { const k = i++; out[k] = await fn(arr[k], k); } })); return out; }
const save = (f, o) => fs.writeFileSync(path.join(OUT, f), JSON.stringify(o));
const slimItem = (it) => ({ product_id: String(it.product_id), name: it.product && it.product.name || it.product_name, unit: it.unit, quantity: it.quantity, base_quantity: it.base_quantity, qr: (it.qr_codes || []).map((q) => (typeof q === "string" ? q : q && (q.qr_code || q.code || q.uid))).filter(Boolean) });

(async () => {
  if (!process.env.NW_KEY || !process.env.POS_TOKEN) throw new Error("missing NW_KEY / POS_TOKEN");
  // 1) NW ledger (whole warehouse, cursor paging)
  const L = [];
  for (let after = 0; ;) {
    const r = await nw(`/stock/ledger?warehouseId=${WH}&limit=1000&afterLedgerNumber=${after}`);
    const a = (r.j && r.j.data) || [];
    if (!a.length) break;
    for (const x of a) if (String(x.warehouseId).toLowerCase() === WH) L.push({ n: x.ledgerNumber, c: String((x.product && x.product.externalProductId) || x.productId), q: Number(x.quantity), t: x.actionType, reason: x.reason, ref: x.actionReference, at: x.occurredAt || x.createdAt, epcs: x.epcs || [], fup: x.product && x.product.customAttributes && x.product.customAttributes["final-unit-print"], base: x.product && x.product.baseUnitOfMeasure, title: x.product && x.product.title });
    if (!(r.j.nextAfter > after)) break;
    after = r.j.nextAfter;
  }
  save("nw-ledger.json", L);
  console.log("NW ledger rows", L.length, "latest", L.reduce((m, r) => (r.at > m ? r.at : m), ""));

  // 2) POS completed orders in window + details
  const rows = await listCompleted(pos, S, FROM, TO);
  console.log("POS completed orders", rows.length);
  const orders = (await pmap(rows, 5, async (o) => {
    const r = await pos(`/v1/order/${o.id}?get_rating=true`);
    const d = r.j && r.j.data && r.j.data.order;
    if (!d) return { id: o.id, code: o.code, err: r.s };
    return { id: d.id, code: d.code, status: d.status, type: d.type, source_type: d.source_type, completed_date: d.completed_date, created_date: d.created_date, items: (d.items || []).map(slimItem) };
  }));
  save("pos-orders.json", orders);
  console.log("details ok", orders.filter((o) => !o.err).length, "err", orders.filter((o) => o.err).length);

  // 3) Open / pending orders (POS already deducted on_hand for online orders not yet delivered)
  const pend = [];
  for (const st of ["PENDING", "AWAITING_CONFIRM", "WAITING_PAYMENT", "AWAITING_SHIPMENT", "READY_TO_PICK", "WAITING_STOCK", "SHIPPING", "OUT_OF_STOCK"]) {
    for (let page = 1; page < 20; page++) {
      const r = await pos(`/v1/pos/${S}/order?page=${page}&limit=100&query=status=${st}`);
      const d = r.j && r.j.data; const a = (d && (d.orders || d.list)) || [];
      for (const o of a) pend.push({ id: o.id, code: o.code, st });
      if (!d || a.length < 100) break;
    }
  }
  const pendD = await pmap(pend, 5, async (o) => { const r = await pos(`/v1/order/${o.id}?get_rating=true`); const d = r.j && r.j.data && r.j.data.order; return d ? { id: d.id, code: d.code, status: d.status, type: d.type, source_type: d.source_type, created_date: d.created_date, items: (d.items || []).map(slimItem) } : { ...o, err: r.s }; });
  save("pos-pending.json", pendD);
  console.log("pending orders", pendD.length, JSON.stringify(pend.reduce((m, o) => ((m[o.st] = (m[o.st] || 0) + 1), m), {})));

  // 4) TRF out of Lumina (list is ascending by created_at; filter client-side)
  const trf = [];
  for (let page = 1; page < 200; page++) {
    const r = await pos(`/v1/inventory/transfer-request?page=${page}&limit=50&query=pos_id=${S},type=TRANSFER_OUT`);
    const a = (r.j && r.j.data && r.j.data.list) || [];
    for (const x of a) if (x.src_pos_id === S && (x.created_at || "") >= FROM.slice(0, 10)) trf.push({ id: x.id, code: x.code, status: x.status, type: x.type, created_at: x.created_at, completed_at: x.completed_at, dest: x.dest_pos_name || x.dest_pos_id });
    if (a.length < 50) break;
  }
  const trfD = await pmap(trf, 4, async (t) => {
    const r = await pos(`/v1/inventory/transfer-request/${t.id}`);
    const d = r.j && r.j.data;
    return { ...t, status: (d && d.status) || t.status, completed_at: (d && d.completed_at) || t.completed_at, dest: (d && d.dest_pos && (d.dest_pos.name || d.dest_pos.pos_name)) || t.dest, items: ((d && d.transfer_items) || []).map((it) => ({ product_id: String(it.product_id), name: it.product_name || (it.product && it.product.name), unit: it.unit, quantity: it.quantity, base_quantity: it.base_quantity, qr: (it.details || []).map((x) => x.qr_code).filter(Boolean), detailQty: (it.details || []).reduce((s, x) => s + (Number(x.base_quantity || x.quantity) || 0), 0) })) };
  });
  save("pos-trf.json", trfD);
  console.log("TRF out since", FROM, trfD.length);

  // 5) Live POS stock (by location) now
  const stock = [];
  for (let page = 1; page < 100; page++) {
    const r = await pos(`/v1/inventory/admin/stock/search?query=pos_id=${S},include_negative_qty=true,&limit=500&page=${page}&is_count_status=true`);
    const a = (r.j && r.j.data && r.j.data.list) || [];
    for (const x of a) stock.push({ pid: String(x.product_id), name: x.product_name, base: x.base_unit, q: x.on_hand_qty, seller: x.seller_code, sku: x.sku, locs: (x.items || []).map((it) => ({ loc: it.location_name, q: it.on_hand_qty })), units: (x.retail_units || []).map((u) => ({ unit: u.unit, rate: u.convert_rate })) });
    if (a.length < 500) break;
  }
  save("pos-stock-now.json", { at: new Date().toISOString(), rows: stock });
  console.log("POS stock rows", stock.length);
})().catch((e) => { console.error(e); process.exit(1); });
