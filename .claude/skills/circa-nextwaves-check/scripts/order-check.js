// Read-only. node order-check.js <DHC> [posStore]  — POS order (all lines, QR, lot) + NW order + every EPC state. env NW_KEY, POS_TOKEN
const NW = "https://api-circa.nextwaves.app/api/v1/public";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const code = process.argv[2], store = process.argv[3] || "c476efb2-415c-429a-978e-d389b4b06607";
const vn = (t) => (t ? new Date(Date.parse(t) + 7 * 3600e3).toISOString().slice(0, 19).replace("T", " ") : "");
const nw = async (p) => { const r = await fetch(NW + p, { headers: { accept: "application/json", authorization: "Bearer " + process.env.NW_KEY } }); return { s: r.status, j: await r.json().catch(() => null) }; };
const pos = async (p) => { const r = await fetch("https://api.v2.circa.vn" + p, { headers: { accept: "application/json", authorization: "Bearer " + process.env.POS_TOKEN, "x-circa-app": "pos", "x-client-id": "1", "x-store-id": store, "user-agent": UA, origin: "https://pos.v2.circa.vn", referer: "https://pos.v2.circa.vn/" } }); return { s: r.status, j: await r.json().catch(() => null) }; };
(async () => {
  const l = await pos(`/v1/pos/${store}/order?page=1&limit=5&query=code=${code}`);
  const arr = (l.j && l.j.data && (l.j.data.orders || l.j.data.items || l.j.data)) || [];
  const o = (Array.isArray(arr) ? arr : []).find((x) => x.code === code);
  console.log("POS list", l.s, o ? `${o.id} status ${o.status}` : "không thấy");
  const uids = new Set();
  if (o) {
    const od = (await pos("/v1/order/" + o.id + "?get_rating=true")).j.data.order;
    console.log(`POS ${od.code} status ${od.status} · type ${od.type || od.order_type || ""} · source ${od.source || od.channel || ""} · tạo ${vn(od.created_time || od.created_at)} · hoàn tất ${vn(od.completed_date)} · return ${JSON.stringify(od.order_return_codes || [])}`);
    for (const it of od.items || []) {
      const q = [...new Set([it.qr_code].concat(it.qr_codes || []).filter(Boolean).map((x) => String(x).replace(/^.*\//, "")))];
      q.forEach((x) => uids.add(x));
      console.log(`  - [${it.product_id}] ${it.product_name} · ${it.quantity} ${it.unit} (base ${it.base_quantity}) · lô ${it.lot_date} · QR ${q.join(",") || "-"}`);
    }
  }
  for (const c of [code, "CIR-" + code]) {
    const n = await nw("/orders/" + c);
    if (n.s !== 200) { console.log("NW /orders/" + c, n.s, n.j && n.j.message); continue; }
    const j = n.j; console.log(`NW ${j.orderNumber} status ${j.status} id ${j.id} wh ${String(j.warehouseId).slice(0, 8)} created ${vn(j.createdAt)} updated ${vn(j.updatedAt)}`);
    console.log("  keys:", Object.keys(j).join(","));
    for (const li of j.items || j.lines || j.orderItems || []) console.log("   line", JSON.stringify(li).slice(0, 400));
    break;
  }
  if (uids.size) {
    const b = await fetch(NW + "/tags/by-uid/batch", { method: "POST", headers: { accept: "application/json", "content-type": "application/json", authorization: "Bearer " + process.env.NW_KEY }, body: JSON.stringify({ uids: [...uids] }) }).then((r) => r.json()).catch(() => null);
    const rows = (b && (b.results || b.data || b.items)) || b || [];
    console.log("by-uid batch:"); (Array.isArray(rows) ? rows : Object.values(rows)).forEach((r) => console.log("  ", r.uid, r.mapped ? "→ " + r.epc + " " + r.status : "unmapped"));
  }
  for (const e of process.argv.slice(4)) {
    const h = (await nw("/integrations/circa/epcs/" + e)).j || {};
    console.log(`EPC ${e}: ${h.status} wh ${String(h.warehouseId).slice(0, 8)} giữ ${h.baseQuantity} ${h.baseUnit} · ${h.productName} CIRCA-${h.circaProductId} · uid ${h.unitUid}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
