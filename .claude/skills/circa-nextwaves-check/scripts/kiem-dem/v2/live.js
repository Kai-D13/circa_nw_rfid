// Live check: same requests as app.js (minimal CORS-safe headers), fed to the worker bundle. READ-ONLY.
// env POS_TOKEN, NW_KEY. usage: node kd/v2/live.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const D = __dirname;
const self = {}; const posted = []; self.postMessage = (m) => posted.push(m);
const ctx = { self, console, Uint8Array, ArrayBuffer, DataView, TextDecoder, TextEncoder, Date, Math, JSON, Set, Map, Promise, setTimeout, Intl };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(D, "worker-bundle.js"), "utf8"), ctx);
let id = 0;
const send = (msg) => { msg.id = ++id; self.onmessage({ data: msg }); const r = posted.pop(); if (r.error) throw new Error(r.error); return r; };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const S = { name: "Lumina", pos: "31493e74-3404-4c0e-a906-93691a6ee319", wh: "3f7bd541-7370-4ce0-9048-231cf061e91a" };
const get = async (url, h) => { for (let t = 0; t < 6; t++) { const r = await fetch(url, { headers: { ...h, "user-agent": UA, origin: "null" } }); if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1500 * (t + 1))); continue; } if (!r.ok) throw new Error(r.status + " " + url); return r.json(); } };
const posGet = (p) => get("https://api.v2.circa.vn" + p, { authorization: "Bearer " + process.env.POS_TOKEN, "x-store-id": S.pos });
const nwGet = (p) => get("https://api-circa.nextwaves.app/api/v1/public" + p, { authorization: "Bearer " + process.env.NW_KEY });
(async () => {
  let t0 = Date.now();
  const base = "https://docs.google.com/spreadsheets/d/18nLllIlORaki3por1diKzNo2tWvdVyUnB1xbZXDv8Xc/gviz/tq?tqx=out:csv&headers=1&sheet=";
  const v4 = await (await fetch(base + encodeURIComponent("final data v4") + "&tq=" + encodeURIComponent("select A,B,C,D,E"))).text();
  const ad = await (await fetch(base + "Adhoc")).text();
  const m = send({ type: "masterCsv", v4, adhoc: ad });
  console.log("master (Google)", m.size, "adhoc", m.adhoc, (Date.now() - t0) + "ms");
  t0 = Date.now();
  const rows = [];
  for (let page = 1; page < 200; page++) {
    const j = await posGet(`/v1/inventory/admin/stock/search?query=pos_id=${S.pos},include_negative_qty=true,&limit=500&page=${page}&is_count_status=true`);
    const a = j.data.list || [];
    a.forEach((x) => { if (x.pos_id && x.pos_id !== S.pos) return; rows.push({ pid: String(x.product_id), name: x.product_name, base: x.base_unit, q: x.on_hand_qty, seller: x.seller_code || "", sku: x.sku || "", locs: (x.items || []).map((it) => ({ loc: it.location_name, q: it.on_hand_qty })), units: (x.retail_units || []).map((u) => ({ unit: u.unit, rate: u.convert_rate })) }); });
    if (a.length < 500 || page * 500 >= j.data.total) break;
  }
  const p = send({ type: "posApi", rows });
  console.log("POS", rows.length, "rows →", p.products, "products,", p.locations.length, "locations", (Date.now() - t0) + "ms");
  t0 = Date.now();
  const ids = new Set();
  for (const st of ["AWAITING_SHIPMENT", "READY_TO_PICK"]) { const j = await posGet(`/v1/pos/${S.pos}/order?page=1&limit=100&query=status=${st}`); (j.data.orders || []).forEach((o) => ids.add(o.id)); }
  const pend = []; const codes = [];
  for (const oid of ids) { const j = await posGet(`/v1/order/${oid}?get_rating=true`); const o = j.data.order; if (o.type !== "ONLINE") continue; codes.push(o.code); for (const it of o.items) pend.push([String(it.product_id), Number(it.base_quantity) || 0, o.code]); }
  send({ type: "pend", items: pend });
  console.log("pending ONLINE", codes.length, codes.join(","), pend.map((x) => x.join(":")).join(" "), (Date.now() - t0) + "ms");
  t0 = Date.now();
  const L = []; let after = 0;
  for (;;) { const j = await nwGet(`/stock/ledger?warehouseId=${S.wh}&limit=1000&afterLedgerNumber=${after}`); const a = j.data || []; if (!a.length) break; a.forEach((x) => { if (String(x.warehouseId).toLowerCase() !== S.wh) return; const pr = x.product || {}; L.push({ c: String(pr.externalProductId || x.productId), q: Number(x.quantity), t: x.actionType, at: x.occurredAt || x.createdAt, ref: x.actionReference, epcs: x.epcs || [], fup: pr.customAttributes && pr.customAttributes["final-unit-print"], base: pr.baseUnitOfMeasure, title: pr.title }); }); if (!(j.nextAfter > after)) break; after = j.nextAfter; }
  const tg = send({ type: "tags", rows: L });
  console.log("NW", L.length, "ledger rows →", tg.tags, "tags /", tg.products, "products", (Date.now() - t0) + "ms");
  // orders since first stock-in (same windowing as app.js listCompleted)
  t0 = Date.now();
  const A = Math.min(...L.filter((r) => r.q > 0 && /stock_in|pack_in|transfer/.test(r.t)).map((r) => Date.parse(r.at))), B = Date.now();
  const seen = new Map();
  async function win(a, b) { const j = await posGet(`/v1/pos/${S.pos}/order?page=1&limit=100&query=status=COMPLETED,completed_time_from=${new Date(a).toISOString()},completed_time_to=${new Date(b).toISOString()}`); const d = j.data; const rows = d.orders || []; if (Number(d.total) > rows.length) { const mid = a + Math.floor((b - a) / 2); await win(a, mid); await win(mid, b); return; } rows.forEach((o) => seen.set(o.id, o.code)); }
  for (let a = A; a < B; a += 6 * 3600e3) await win(a, Math.min(B, a + 6 * 3600e3));
  const tList = Date.now() - t0;
  const oids = [...seen.keys()], det = {}; let i = 0;
  await Promise.all(Array.from({ length: 5 }, async () => { while (i < oids.length) { const id = oids[i++]; const j = await posGet(`/v1/order/${id}?get_rating=true`); const o = j.data.order; det[id] = [o.code, Date.parse(o.completed_date), o.items.map((it) => [String(it.product_id), Number(it.base_quantity) || 0])]; } }));
  const orows = []; for (const id of oids) { const c = det[id]; c[2].forEach((it) => orows.push({ c: it[0], base: it[1], t: c[1], code: c[0] })); }
  send({ type: "orders", rows: orows });
  console.log("orders from", new Date(A).toISOString(), ":", oids.length, "orders,", orows.length, "lines | list", tList + "ms, details", (Date.now() - t0 - tList) + "ms | cache size ≈", (JSON.stringify(det).length / 1024).toFixed(0) + " KB");
  const b = send({ type: "build", opts: { exclude: ["Kho thất lạc"], addPending: true } });
  console.log("build", JSON.stringify(b.sum));
  // cross-check tag counts with /stock/summary rfidStock for a few products
  for (const c of ["93933", "1066747", "1176", "116227", "1127079"]) {
    const r = b.rows.find((x) => x.code === c);
    const pr = await nwGet(`/products/by-external/${c}`).catch(() => null);
    const sm = pr ? await nwGet(`/stock/summary?productId=${pr.id}&warehouseId=${S.wh}`) : null;
    console.log(c, r ? `S=${r.S} ${r.posBase} T=${r.T} E=${r.E}–${r.Emax} L=${r.L} ratio=${r.ratio} M=${r.M}` : "—", "| NW rfidStock", sm && sm.rfidStock);
  }
  fs.writeFileSync(path.join(D, "live-import.csv"), b.imp);
  console.log("import rows", b.imp.split("\r\n").length - 2, "| sample:", b.imp.split("\r\n").slice(0, 3).join(" || "));
})().catch((e) => { console.error(e); process.exit(1); });
