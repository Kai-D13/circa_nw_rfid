// Read-only. node open-orders.js [productId] — every non-completed POS order (SHIPPING, AWAITING_SHIPMENT, READY_TO_PICK, WAITING_STOCK, PENDING) at a store; prints lines (optionally only one product) with QR + NW status. env NW_KEY, POS_TOKEN, POS_STORE
const NW = "https://api-circa.nextwaves.app/api/v1/public";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const S = process.env.POS_STORE || "c476efb2-415c-429a-978e-d389b4b06607";
const want = process.argv[2];
const vn = (t) => (t ? new Date(Date.parse(t) + 7 * 3600e3).toISOString().slice(5, 16).replace("T", " ") : "");
const nw = async (p) => { const r = await fetch(NW + p, { headers: { accept: "application/json", authorization: "Bearer " + process.env.NW_KEY } }); return { s: r.status, j: await r.json().catch(() => null) }; };
const pos = async (p) => { const r = await fetch("https://api.v2.circa.vn" + p, { headers: { accept: "application/json", authorization: "Bearer " + process.env.POS_TOKEN, "x-circa-app": "pos", "x-client-id": "1", "x-store-id": S, "user-agent": UA, origin: "https://pos.v2.circa.vn", referer: "https://pos.v2.circa.vn/" } }); return { s: r.status, j: await r.json().catch(() => null) }; };
(async () => {
  for (const st of ["SHIPPING", "AWAITING_SHIPMENT", "READY_TO_PICK", "WAITING_STOCK", "PENDING"]) {
    const a = ((await pos(`/v1/pos/${S}/order?page=1&limit=100&query=status=${st}`)).j || {}).data;
    for (const o of (a && a.orders) || []) {
      const od = (((await pos("/v1/order/" + o.id + "?get_rating=true")).j || {}).data || {}).order; if (!od) continue;
      const items = (od.items || []).filter((it) => !want || String(it.product_id) === want);
      if (!items.length) continue;
      const n = await nw("/orders/" + od.code);
      console.log(`${od.code} ${st} ${od.type} · tạo ${vn(od.created_date)} · cập nhật ${vn(od.status_updated_at || od.updated_date)} · NW ${n.s === 200 ? n.j.orderNumber + " " + n.j.status : n.s}`);
      for (const it of items) {
        const q = [...new Set([it.qr_code].concat(it.qr_codes || []).filter(Boolean).map((x) => String(x).replace(/^.*\//, "")))];
        console.log(`   [${it.product_id}] ${it.product_name || ""} · ${it.quantity} ${it.unit} (base ${it.base_quantity}) · lô ${it.lot_date} · QR ${q.join(",") || "-"}`);
      }
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
