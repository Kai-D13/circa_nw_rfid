// READ-ONLY. Kéo phiếu nhận hàng chuyển kho vào cửa hàng (POS transfer-request type=TRANSFER_IN, mã RCV…) từ <fromISO> → <PHIEN_DIR>/pos-rcv.json (không lưu token).
// env POS_TOKEN. usage: PHIEN_DIR=<dir> node fetch-rcv.js <fromISO> [storeId]
const fs = require("fs"), path = require("path");
const S = process.argv[3] || "31493e74-3404-4c0e-a906-93691a6ee319", FROM = process.argv[2] || "2026-11-05T17:00:00.000Z";
const OUT = process.env.PHIEN_DIR || "."; const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pos(p) { for (let t = 0; t < 6; t++) { try { const r = await fetch("https://api.v2.circa.vn" + p, { headers: { accept: "application/json", authorization: "Bearer " + process.env.POS_TOKEN, "x-circa-app": "pos", "x-client-id": "1", "x-store-id": S, "user-agent": UA, origin: "https://pos.v2.circa.vn", referer: "https://pos.v2.circa.vn/" }, signal: AbortSignal.timeout(60000) }); if (r.status === 429 || r.status >= 500) { await sleep(1500 * (t + 1)); continue; } return { s: r.status, j: await r.json().catch(() => null) }; } catch (e) { await sleep(1500 * (t + 1)); } } return { s: 0, j: null }; }
async function pmap(arr, n, fn) { const out = new Array(arr.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < arr.length) { const k = i++; out[k] = await fn(arr[k], k); } })); return out; }
(async () => {
  if (!process.env.POS_TOKEN) throw new Error("missing POS_TOKEN");
  const L = [];
  for (let page = 1; page < 400; page++) {
    const r = await pos(`/v1/inventory/transfer-request?page=${page}&limit=50&query=pos_id=${S},type=TRANSFER_IN`);
    const a = (r.j && r.j.data && r.j.data.list) || [];
    for (const x of a) if (x.dest_pos_id === S && ((x.created_at || "") >= FROM.slice(0, 10) || (x.completed_at || "") >= FROM.slice(0, 10))) L.push({ id: x.id, code: x.code, status: x.status, created_at: x.created_at, completed_at: x.completed_at, src: x.src_pos_id, rel: x.related_transfer_request_id });
    if (a.length < 50) break;
  }
  const D = await pmap(L, 4, async (t) => { const r = await pos(`/v1/inventory/transfer-request/${t.id}`); const d = r.j && r.j.data; return { ...t, status: (d && d.status) || t.status, completed_at: (d && d.completed_at) || t.completed_at, src: (d && d.src_pos && (d.src_pos.name || d.src_pos.pos_name)) || t.src, items: ((d && d.transfer_items) || []).map((it) => ({ product_id: String(it.product_id), unit: it.unit, quantity: it.quantity, base_quantity: it.base_quantity, actual: it.actual_quantity ?? it.actual_base_quantity ?? null, detailQty: (it.details || []).reduce((s, x) => s + (Number(x.base_quantity || x.quantity) || 0), 0) })), err: d ? undefined : r.s }; });
  fs.writeFileSync(path.join(OUT, "pos-rcv.json"), JSON.stringify(D));
  console.log("RCV since", FROM, D.length, JSON.stringify(D.reduce((m, o) => ((m[o.status] = (m[o.status] || 0) + 1), m), {})), "items", D.reduce((s, o) => s + o.items.length, 0), "err", D.filter((o) => o.err).length);
})().catch((e) => { console.error(e.message); process.exit(1); });
