// Read-only: full history of one EPC + POS sales of its product at a store. env NW_KEY, POS_TOKEN
// node tag-hist.js <EPC> <posStore> <wh> <circaId> <fromISO> [otherQR...]
const NW = "https://api-circa.nextwaves.app/api/v1/public";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const [epc, store, wh, circa, from, ...qrs] = process.argv.slice(2);
const vn = (t) => (t ? new Date(Date.parse(t) + 7 * 3600e3).toISOString().slice(5, 16).replace("T", " ") : "");
const j = (r) => r.json().catch(() => null);
const nw = (p) => fetch(NW + p, { headers: { accept: "application/json", authorization: "Bearer " + process.env.NW_KEY } }).then(async (r) => ({ s: r.status, j: await j(r) }));
const pos = (p) => fetch("https://api.v2.circa.vn" + p, { headers: { accept: "application/json, text/plain, */*", authorization: "Bearer " + process.env.POS_TOKEN, "x-circa-app": "pos", "x-client-id": "1", "x-store-id": store, "user-agent": UA, origin: "https://pos.v2.circa.vn", referer: "https://pos.v2.circa.vn/" } }).then(async (r) => ({ s: r.status, j: await j(r) }));
(async () => {
  const h = (await nw("/integrations/circa/epcs/" + epc)).j || {};
  console.log("CIRCA VIEW:", h.status, "giữ", h.baseQuantity, h.baseUnit, "· unit", h.unit, "x" + h.unitRatio, "packed", h.packed, "· wh", h.warehouseId, "· uid", h.unitUid);
  const chk = (await nw(`/tags/${epc}/check?warehouseId=${wh}`)).j;
  console.log("CHECK:", JSON.stringify(chk).slice(0, 600));
  const p = (await nw(`/tags/${epc}/passport`)).j || {};
  console.log("PASSPORT keys:", Object.keys(p).join(","));
  for (const k of Object.keys(p)) if (Array.isArray(p[k])) { console.log(" " + k + ":"); p[k].forEach((m) => console.log("   ", JSON.stringify(m).slice(0, 400))); }
  // ledger rows with this EPC
  const hits = [];
  // /stock/ledger ignores offset/page (always the newest 200 rows) — page with afterLedgerNumber
  for (let after = 0, i = 0; i < 1000; i++) {
    const a = (await nw(`/stock/ledger?warehouseId=${wh}&limit=200&afterLedgerNumber=${after}`)).j;
    const l = Array.isArray(a) ? a : (a && (a.data || a.items)) || [];
    l.forEach((r) => (r.epcs || []).includes(epc) && hits.push(r));
    if (!l.length) break; const mx = Math.max(...l.map((r) => Number(r.ledgerNumber) || 0)); if (mx <= after || l.length < 200) break; after = mx;
  }
  console.log("LEDGER rows with EPC:", hits.length);
  hits.forEach((r) => console.log("   ", vn(r.occurredAt), r.reason || r.actionType, r.quantity, r.actionReference, r.reasonNote || ""));
  // POS sales of the product since `from`
  console.log("\nPOS orders since", from, "with product", circa);
  const to = new Date().toISOString();
  const arr = await require("./pos-orders").listCompleted(pos, store, from, to); // windowed: POS list sort is unstable
  console.log("  (" + arr.length + " đơn hoàn tất trong khoảng)");
  {
    for (const o of arr) {
      const d = (await pos("/v1/order/" + o.id + "?get_rating=true")).j;
      const od = d && d.data && d.data.order; if (!od) continue;
      for (const it of od.items || []) {
        const q = [it.qr_code].concat(it.qr_codes || []).filter(Boolean).map((x) => String(x).replace(/^.*\//, ""));
        if (String(it.product_id) === circa || q.some((x) => qrs.includes(x))) {
          const n = await nw("/orders/" + od.code);
          console.log("   ", od.code, vn(od.completed_date), it.quantity, it.unit, "base", it.base_quantity, "lô", it.lot_date, "QR", q.join(",") || "-", "| NW order", n.s === 200 ? n.j.status : n.s, (od.order_return_codes || []).length ? "RETURN " + od.order_return_codes : "");
        }
      }
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
