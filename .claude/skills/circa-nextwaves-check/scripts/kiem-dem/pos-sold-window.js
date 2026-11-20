// Read-only: POS COMPLETED order lines of a store in [from, to), with every scanned QR resolved to Nextwaves EPCs.
// usage: POS_TOKEN=… NW_KEY=… node pos-sold-window.js <fromISO> <toISO> <out.json> [storeId, default Lumina]
// out: [{code, at, channel, pid, name, base, qr:[…], epcs:[…]}]  (no customer data kept)
const fs = require("fs"), path = require("path");
const NW = "https://api-circa.nextwaves.app/api/v1/public";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const [from, to, out, storeArg] = process.argv.slice(2);
const S = storeArg || "31493e74-3404-4c0e-a906-93691a6ee319";
async function req(url, opt = {}) { for (let a = 0; a < 5; a++) { try { const r = await fetch(url, Object.assign({ signal: AbortSignal.timeout(30000) }, opt)); if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1200 * (a + 1))); continue; } return { s: r.status, j: await r.json().catch(() => null) }; } catch (_) { await new Promise((s) => setTimeout(s, 1000)); } } return { s: 0, j: null }; }
const pos = (p) => req("https://api.v2.circa.vn" + p, { headers: { accept: "application/json", authorization: "Bearer " + process.env.POS_TOKEN, "x-circa-app": "pos", "x-client-id": "1", "x-store-id": S, "user-agent": UA, origin: "https://pos.v2.circa.vn", referer: "https://pos.v2.circa.vn/" } });
const nwH = () => ({ accept: "application/json", "content-type": "application/json", authorization: "Bearer " + process.env.NW_KEY });
const nw = (p) => req(NW + p, { headers: nwH() });
const arr = (j) => (Array.isArray(j) ? j : (j && (j.results || j.data || j.items)) || []);
async function pmap(a, n, fn) { const o = new Array(a.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < a.length) { const k = i++; o[k] = await fn(a[k]); } })); return o; }
(async () => {
  if (!process.env.POS_TOKEN || !process.env.NW_KEY) throw new Error("thiếu POS_TOKEN / NW_KEY");
  const list = await require(require("fs").existsSync(path.join(__dirname, "pos-orders.js")) ? path.join(__dirname, "pos-orders.js") : path.join(__dirname, "..", "pos-orders.js")).listCompleted(pos, S, from, to);
  const orders = (await pmap(list, 5, async (o) => { const d = (await pos("/v1/order/" + o.id + "?get_rating=true")).j; return d && d.data && d.data.order; })).filter(Boolean);
  console.log("đơn COMPLETED", list.length, "đọc chi tiết", orders.length);
  const L = [];
  for (const o of orders) for (const it of o.items || []) {
    const qr = [it.qr_code].concat(it.qr_codes || []).filter((x) => typeof x === "string" && x.trim()).map((x) => x.replace(/^.*\//, "").trim());
    L.push({ code: o.code, at: o.completed_date, channel: o.channel || o.order_type || o.source || "", pid: String(it.product_id), name: it.product_name || it.name || "", base: Number(it.base_quantity) || 0, qr: [...new Set(qr)], epcs: [] });
  }
  const U = [...new Set(L.flatMap((l) => l.qr))], res = {};
  for (const q of U) if (/^[0-9A-F]{24}$/i.test(q)) res[q] = [q.toUpperCase()];
  const todo = U.filter((q) => !res[q]);
  for (let i = 0; i < todo.length; i += 25) { const b = await req(NW + "/tags/by-uid/batch", { method: "POST", headers: nwH(), body: JSON.stringify({ uids: todo.slice(i, i + 25) }) }); for (const x of arr(b.j)) if (x && x.uid && x.mapped && x.epc) res[x.uid] = [x.epc.toUpperCase()]; }
  await pmap(U.filter((q) => !res[q]), 4, async (u) => {
    for (const f of [u, "thuocsi.vn/qr/" + u, "qr.v2.circa.vn/item/" + u]) {
      const g = await nw("/printing/labels/generations/" + encodeURIComponent(f));
      if (g.s !== 200 || !g.j) continue;
      const isParent = (g.j.children || []).every((c) => c.unitUid !== u), kids = (g.j.children || []).filter((c) => c.mapped && c.epc);
      res[u] = (isParent ? kids : kids.filter((c) => c.unitUid === u)).map((c) => c.epc.toUpperCase()); return;
    }
    res[u] = [];
  });
  for (const l of L) l.epcs = [...new Set(l.qr.flatMap((q) => res[q] || []))];
  fs.writeFileSync(out, JSON.stringify(L, null, 1));
  console.log("dòng bán", L.length, "· QR", U.length, "· QR ra EPC", U.filter((q) => (res[q] || []).length).length);
})().catch((e) => { console.error(e.message); process.exit(1); });
