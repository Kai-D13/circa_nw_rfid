// R2 recount file: same pulls as live.js (POS stock, pending ONLINE, NW ledger), then builds ONLY the codes in R2_CODES. READ-ONLY.
// env POS_TOKEN, NW_KEY, R2_CODES (json array of product ids), R2_OUT (dir for pos-rows/pend/nw-ledger-raw + build-pos.json, import-pos.csv, check-pos.csv).
// usage: node <scratch>/kd/v2/r2.js  (needs v2/worker-bundle.js from build.js); then r2-verify-pos.js and r2-out.js
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
  // 19/11: Dự kiến = ⌈tồn POS ÷ quy đổi master⌉ — POS orders (loose boxes) are no longer used
  send({ type: "orders", rows: null });
  // ---- R2: build for a given product list, keep the raw pulls for the later session analysis (READ-ONLY) ----
  const OUTD = process.env.R2_OUT, CODES = new Set(JSON.parse(fs.readFileSync(process.env.R2_CODES, "utf8")));
  fs.mkdirSync(OUTD, { recursive: true });
  fs.writeFileSync(path.join(OUTD, "pos-rows.json"), JSON.stringify({ at: new Date().toISOString(), rows }));
  fs.writeFileSync(path.join(OUTD, "pend.json"), JSON.stringify({ codes, pend }));
  fs.writeFileSync(path.join(OUTD, "nw-ledger-raw.json"), JSON.stringify(L));
  for (const addPending of [false]) { // đúng tồn POS: không cộng đơn ONLINE chờ giao
    const b = send({ type: "build", opts: { exclude: ["Kho thất lạc"], addPending } });
    const sel = b.rows.filter((r) => CODES.has(r.code));
    fs.writeFileSync(path.join(OUTD, `build-${addPending ? "pend" : "pos"}.json`), JSON.stringify({ sum: b.sum, rows: sel }));
    // keep only the listed products in the CSVs (header + matching lines)
    const pick = (csv) => { const ls = csv.split("\r\n"); return [ls[0], ...ls.slice(1).filter((l) => CODES.has(l.split(",")[0]))].join("\r\n") + "\r\n"; };
    fs.writeFileSync(path.join(OUTD, `import-${addPending ? "pend" : "pos"}.csv`), pick(b.imp));
    fs.writeFileSync(path.join(OUTD, `check-${addPending ? "pend" : "pos"}.csv`), pick(b.chk));
    console.log(`build addPending=${addPending}: listed ${sel.length}/${CODES.size} | rfid ${sel.filter((r) => r.cat === "rfid").length} | manual ${sel.filter((r) => r.cat === "manual").length} | ΣE ${sel.reduce((s, r) => s + (r.E || 0), 0)}`);
  }
  console.log("missing from POS+NW:", [...CODES].filter((c) => !rows.some((x) => x.pid === c) && !L.some((x) => x.c === c)).join(",") || "none");
})().catch((e) => { console.error(e); process.exit(1); });
