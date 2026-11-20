// Read-only. Re-resolve every QR sold at a store with the current Nextwaves API (by-uid, then generations — incl. source=tags
// added 12/11/2026), and say which sales now reach an EPC that is still active and whose order is not on Nextwaves.
// usage: node store-retest.js <fromISO> [toISO] [seed-lines.json]   env NW_KEY, POS_TOKEN, POS_STORE, WH, OUT
//   seed-lines.json (optional): rows {code, sold, product, circa, qty, base, uids} already collected, so POS is only read after the last one.
const fs = require("fs");
const NW = "https://api-circa.nextwaves.app/api/v1/public";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const S = process.env.POS_STORE || "31493e74-3404-4c0e-a906-93691a6ee319";
const WH = (process.env.WH || "3f7bd541-7370-4ce0-9048-231cf061e91a").toLowerCase();
const [from, to = new Date().toISOString(), seed] = process.argv.slice(2);
const vn = (t) => (t ? new Date(Date.parse(t) + 7 * 3600e3).toISOString().slice(5, 16).replace("T", " ") : "");
async function req(url, opt = {}) { for (let a = 0; a < 4; a++) { try { const r = await fetch(url, Object.assign({ signal: AbortSignal.timeout(30000) }, opt)); if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1000 * (a + 1))); continue; } return { s: r.status, j: await r.json().catch(() => null) }; } catch (_) { await new Promise((s) => setTimeout(s, 800)); } } return { s: 0, j: null }; }
const nwH = () => ({ accept: "application/json", "content-type": "application/json", authorization: "Bearer " + process.env.NW_KEY });
const nw = (p) => req(NW + p, { headers: nwH() });
const pos = (p) => req("https://api.v2.circa.vn" + p, { headers: { accept: "application/json", authorization: "Bearer " + process.env.POS_TOKEN, "x-circa-app": "pos", "x-client-id": "1", "x-store-id": S, "user-agent": UA, origin: "https://pos.v2.circa.vn", referer: "https://pos.v2.circa.vn/" } });
(async () => {
  const rows = seed ? ((j) => j.rows || j)(JSON.parse(fs.readFileSync(seed, "utf8"))).map((r) => ({ code: r.code, sold: r.sold, product: r.product, circa: String(r.circa), qty: r.qty, base: Number(r.base), uids: String(r.uids || "").split(/[ ,]+/).filter(Boolean) })) : [];
  const have = new Set(rows.map((r) => r.code));
  const list = await require("./pos-orders").listCompleted(pos, S, from, to); // windowed: POS list sort is unstable
  for (const o of list) {
    if (have.has(o.code)) continue;
    const od = ((((await pos("/v1/order/" + o.id + "?get_rating=true")).j || {}).data) || {}).order; if (!od) continue;
    for (const it of od.items || []) rows.push({ code: od.code, sold: vn(od.completed_date), product: it.product_name, circa: String(it.product_id), qty: it.quantity + " " + it.unit, base: Number(it.base_quantity), uids: [...new Set([it.qr_code].concat(it.qr_codes || []).filter(Boolean).map((x) => String(x).replace(/^.*\//, "")))] });
  }
  console.log("POS: " + list.length + " đơn hoàn tất trong khoảng");
  const uids = [...new Set(rows.flatMap((r) => r.uids))];
  console.log(`dòng bán ${rows.length} · đơn ${new Set(rows.map((r) => r.code)).size} · mã QR khác nhau ${uids.length}`);
  const res = {};
  for (let i = 0; i < uids.length; i += 25) {
    const b = (await req(NW + "/tags/by-uid/batch", { method: "POST", headers: nwH(), body: JSON.stringify({ uids: uids.slice(i, i + 25) }) })).j;
    const arr = (b && (b.results || b.data || b.items)) || b || [];
    (Array.isArray(arr) ? arr : Object.values(arr)).forEach((x) => { if (x && x.uid) res[x.uid] = x.mapped ? { via: "direct", epc: x.epc, status: x.status } : { via: "none" }; });
  }
  const todo = uids.filter((u) => !res[u] || res[u].via === "none");
  for (let i = 0; i < todo.length; i += 6) {
    await Promise.all(todo.slice(i, i + 6).map(async (u) => {
      let g = await nw("/printing/labels/generations/" + encodeURIComponent(u));
      if (g.s === 404) g = await nw("/printing/labels/generations/" + encodeURIComponent("thuocsi.vn/qr/" + u));
      if (g.s !== 200) { res[u] = { via: "none", gen: g.s }; return; }
      const j = g.j || {}; const isParent = (j.children || []).every((c) => c.unitUid !== u);
      const kids = (j.children || []).filter((c) => c.mapped && c.epc);
      res[u] = { via: "gen:" + j.source + (isParent ? ":parent" : ":child"), parentQr: j.parentQr, kids: kids.map((c) => ({ uid: c.unitUid, epc: c.epc, status: c.tagStatus, wh: c.warehouseId })) };
    }));
  }
  const epcInfo = {};
  const allEpc = new Set(); Object.values(res).forEach((r) => { if (r.epc) allEpc.add(r.epc); (r.kids || []).forEach((k) => allEpc.add(k.epc)); });
  for (const e of allEpc) { const h = (await nw("/integrations/circa/epcs/" + e)).j || {}; epcInfo[e] = { status: String(h.status).toLowerCase(), wh: String(h.warehouseId).toLowerCase(), hold: Number(h.baseQuantity), unit: h.baseUnit, circa: String(h.circaProductId), uid: h.unitUid }; }
  const orderNw = {};
  for (const c of new Set(rows.map((r) => r.code))) { const n = await nw("/orders/" + c); orderNw[c] = n.s === 200 ? n.j.status : n.s; }
  const out = [];
  for (const r of rows) {
    const per = r.uids.map((u) => { const x = res[u] || { via: "?" }; const epcs = x.epc ? [x.epc] : (x.kids || []).map((k) => k.epc); return { uid: u, via: x.via, epcs }; });
    const epcs = [...new Set(per.flatMap((p) => p.epcs))];
    out.push(Object.assign({}, r, { per, epcs, nwOrder: orderNw[r.code], tags: epcs.map((e) => Object.assign({ epc: e }, epcInfo[e])) }));
  }
  fs.writeFileSync(process.env.OUT || "store-retest.json", JSON.stringify({ rows: out, res }, null, 1));
  const cnt = {}; Object.values(res).forEach((x) => (cnt[x.via] = (cnt[x.via] || 0) + 1));
  console.log("Kết quả theo mã QR:", JSON.stringify(cnt));
  const hit = out.filter((r) => r.epcs.length);
  console.log(`\nDòng bán ra EPC: ${hit.length}/${out.length}`);
  for (const r of hit) {
    const t = r.tags.map((x) => `${x.epc.slice(-8)}(${x.status}${x.wh === WH ? "" : ",KHÁC KHO"} giữ ${x.hold}${x.circa !== r.circa ? ",SP " + x.circa : ""})`).join(" ");
    console.log(`  ${r.code} ${r.sold} · ${r.product} · ${r.qty} (base ${r.base}) · NW đơn ${r.nwOrder} · ${r.per.map((p) => p.uid + "[" + p.via + "]").join(",")} → ${t}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
