// READ-ONLY: is the bulk POS stock pull (stock/search, 500/page) complete and stable?
// Pulls twice, compares, and checks a sample against the per-product lookup. usage: POS_TOKEN=… node pos-pull-check.js [storeId]
const S = process.argv[2] || "31493e74-3404-4c0e-a906-93691a6ee319";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
async function get(p) { for (let a = 0; a < 4; a++) { const r = await fetch("https://api.v2.circa.vn" + p, { headers: { accept: "application/json", authorization: "Bearer " + process.env.POS_TOKEN, "user-agent": UA, "x-store-id": S } }).catch(() => null); if (r && r.ok) return r.json(); await new Promise((s) => setTimeout(s, 1000 * (a + 1))); } throw new Error("POS " + p); }
const EXCL = /th[aấ]t l[aạ]c/i;
async function pull() {
  const rows = []; let total = null;
  for (let page = 1; page < 200; page++) {
    const j = await get(`/v1/inventory/admin/stock/search?query=pos_id=${S},include_negative_qty=true,&limit=500&page=${page}&is_count_status=true`);
    const a = j.data.list || []; total = j.data.total;
    for (const x of a) rows.push({ k: x.product_id + "|" + (x.seller_code || "") + "|" + (x.sku || ""), pid: String(x.product_id), q: x.on_hand_qty, items: x.items || [] });
    if (a.length < 500 || page * 500 >= total) break;
  }
  return { rows, total };
}
const perPid = (rows) => { const m = new Map(); const seen = new Set(); for (const r of rows) { if (seen.has(r.k)) continue; seen.add(r.k); let q = 0; if (r.items.length) for (const it of r.items) { const loc = it.location_code || it.location_name || it.location || ""; if (!EXCL.test(loc)) q += Number(it.on_hand_qty) || 0; } else q = Number(r.q) || 0; m.set(r.pid, (m.get(r.pid) || 0) + q); } return m; };
(async () => {
  const A = await pull(), B = await pull();
  const ka = new Set(A.rows.map((r) => r.k)), kb = new Set(B.rows.map((r) => r.k));
  console.log("pull1 rows", A.rows.length, "unique", ka.size, "total", A.total, "| pull2 rows", B.rows.length, "unique", kb.size, "total", B.total);
  console.log("in1 not 2:", [...ka].filter((k) => !kb.has(k)).length, "in2 not 1:", [...kb].filter((k) => !ka.has(k)).length);
  const pa = perPid(A.rows), pb = perPid(B.rows);
  const diffs = [...new Set([...pa.keys(), ...pb.keys()])].filter((p) => pa.get(p) !== pb.get(p));
  console.log("products", pa.size, pb.size, "stock differs between pulls:", diffs.length, diffs.slice(0, 10).map((p) => p + ":" + pa.get(p) + "/" + pb.get(p)).join(" "));
  console.log("item keys sample:", JSON.stringify(Object.keys((A.rows.find((r) => r.items.length) || { items: [{}] }).items[0])));
  // sample vs per-product lookup
  const sample = [...pa.keys()].filter((p, i) => i % Math.ceil(pa.size / 40) === 0).concat(["82278", "1257", "5977"]);
  let bad = 0;
  for (const pid of sample) {
    const j = await get(`/v1/inventory/admin/stock/search?query=keyword=${pid},pos_id=${S},include_negative_qty=true,&limit=20&page=1&is_count_status=true`);
    const one = perPid((j.data.list || []).filter((x) => String(x.product_id) === pid).map((x) => ({ k: x.product_id + "|" + (x.seller_code || "") + "|" + (x.sku || ""), pid, q: x.on_hand_qty, items: x.items || [] }))).get(pid) || 0;
    if (one !== (pa.get(pid) || 0)) { bad++; console.log("MISMATCH", pid, "bulk", pa.get(pid), "single", one); }
  }
  console.log("sample", sample.length, "mismatch", bad, "| 82278:", pa.get("82278"));
})().catch((e) => { console.error(e.message); process.exit(1); });
