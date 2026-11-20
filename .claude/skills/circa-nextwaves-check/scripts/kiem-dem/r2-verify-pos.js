// READ-ONLY: per-product POS stock lookup (same as the "Danh sách tồn kho" page) for every code, vs the bulk pull used by the build
// usage: POS_TOKEN=… node r2-verify-pos.js <codes.json> <r2/build-pos.json> <out.json>
const fs = require("fs");
const STORE = "31493e74-3404-4c0e-a906-93691a6ee319";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const H = { accept: "application/json", authorization: "Bearer " + process.env.POS_TOKEN, "x-circa-app": "pos", "x-client-id": "1", "x-store-id": STORE, "user-agent": UA, origin: "https://pos.v2.circa.vn", referer: "https://pos.v2.circa.vn/" };
const codes = JSON.parse(fs.readFileSync(process.argv[2], "utf8")), B = new Map(JSON.parse(fs.readFileSync(process.argv[3], "utf8")).rows.map((r) => [r.code, r]));
const get = async (u) => { for (let t = 0; t < 6; t++) { const r = await fetch(u, { headers: H }); if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1500 * (t + 1))); continue; } return r.json(); } throw new Error("POS " + u); };
(async () => {
  const out = {}; let i = 0;
  await Promise.all(Array.from({ length: 5 }, async () => { while (i < codes.length) { const c = codes[i++];
    const j = await get(`https://api.v2.circa.vn/v1/inventory/admin/stock/search?query=keyword=${c},pos_id=${STORE},include_negative_qty=true,&limit=50&page=1&is_count_status=true`);
    const L = ((j.data && j.data.list) || []).filter((x) => String(x.product_id) === c && (!x.pos_id || x.pos_id === STORE));
    let q = 0, lost = 0; const locs = {};
    for (const x of L) { q += Number(x.on_hand_qty) || 0; for (const it of x.items || []) for (const d of it.details || []) { const l = d.location_name || d.location || it.location_name || ""; const v = Number(d.on_hand_qty != null ? d.on_hand_qty : d.quantity) || 0; locs[l] = (locs[l] || 0) + v; } }
    for (const [l, v] of Object.entries(locs)) if (/th[aấ]t l[aạ]c/i.test(l)) lost += v;
    out[c] = { q, lost, lines: L.length, base: L[0] && L[0].base_unit, locs }; } }));
  fs.writeFileSync(process.argv[4], JSON.stringify(out));
  let same = 0; const diff = [];
  for (const c of codes) { const o = out[c], b = B.get(c); const want = b ? b.S : null; const got = o.q - o.lost; if (b && Math.abs(got - want) < 1e-6) same++; else diff.push(`${c} trang tồn ${o.q} (thất lạc ${o.lost}, ${o.lines} dòng) vs build ${want}`); }
  console.log(`khớp ${same}/${codes.length}`); diff.slice(0, 30).forEach((d) => console.log("  " + d));
})().catch((e) => { console.error(e); process.exit(1); });
