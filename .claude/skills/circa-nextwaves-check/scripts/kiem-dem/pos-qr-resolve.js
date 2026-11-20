// Read-only: resolve every QR of a POS count session (scans.json) to a Nextwaves EPC, then resolve EPC facts.
// usage: NW_KEY=… node pos-qr-resolve.js <dir with scans.json>   → writes <dir>/qr-epc.json
const fs = require("fs"), path = require("path");
const NW = "https://api-circa.nextwaves.app/api/v1/public";
const dir = process.argv[2];
async function req(url, opt = {}) { for (let a = 0; a < 5; a++) { try { const r = await fetch(url, Object.assign({ signal: AbortSignal.timeout(30000) }, opt)); if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1200 * (a + 1))); continue; } return { s: r.status, j: await r.json().catch(() => null) }; } catch (_) { await new Promise((s) => setTimeout(s, 1000)); } } return { s: 0, j: null }; }
const H = () => ({ accept: "application/json", "content-type": "application/json", authorization: "Bearer " + process.env.NW_KEY });
const nw = (p) => req(NW + p, { headers: H() });
const post = (p, b) => req(NW + p, { method: "POST", headers: H(), body: JSON.stringify(b) });
const arr = (j) => (Array.isArray(j) ? j : (j && (j.results || j.data || j.items)) || []);
async function pmap(a, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < a.length) { const k = i++; await fn(a[k]); } })); }
(async () => {
  if (!process.env.NW_KEY) throw new Error("thiếu NW_KEY");
  const sc = JSON.parse(fs.readFileSync(path.join(dir, "scans.json"), "utf8"));
  const prev = fs.existsSync(path.join(dir, "qr-epc.json")) && !process.env.FRESH ? JSON.parse(fs.readFileSync(path.join(dir, "qr-epc.json"), "utf8")).res : null;
  const res = prev || {};
  if (!prev) {
  const epcLike = sc.map((s) => s.qr_code).filter((q) => /^[0-9A-F]{24}$/i.test(q));
  for (const q of epcLike) res[q] = { via: "mã QR chính là EPC", epcs: [q.toUpperCase()] };
  const U = sc.map((s) => s.qr_code).filter((q) => !res[q]);
  for (let i = 0; i < U.length; i += 25) {
    const b = await post("/tags/by-uid/batch", { uids: U.slice(i, i + 25) });
    if (b.s !== 200) console.log("by-uid batch", b.s);
    for (const x of arr(b.j)) if (x && x.uid && x.mapped && x.epc) res[x.uid] = { via: "UID map trực tiếp", epcs: [x.epc], status: x.status };
  }
  const genOne = async (u) => {
    for (const f of [u, "thuocsi.vn/qr/" + u, "qr.v2.circa.vn/item/" + u]) {
      const g = await nw("/printing/labels/generations/" + encodeURIComponent(f));
      if (g.s === 0 || g.s === 429) { res[u] = { via: "lỗi tra", epcs: [] }; return; }
      if (g.s !== 200 || !g.j) continue;
      const isParent = (g.j.children || []).every((c) => c.unitUid !== u);
      const kids = (g.j.children || []).filter((c) => c.mapped && c.epc);
      res[u] = { via: (isParent ? "tem gốc" : "tem con") + " (" + g.j.source + ")", epcs: isParent ? kids.map((c) => c.epc) : kids.filter((c) => c.unitUid === u).map((c) => c.epc), parentQr: g.j.parentQr || "" };
      return;
    }
    res[u] = { via: "không ra EPC", epcs: [] };
  };
  const todo = U.filter((u) => !res[u]);
  console.log("QR", sc.length, "· EPC-format", epcLike.length, "· UID map trực tiếp", U.length - todo.length, "· tra generation", todo.length);
  await pmap(todo, 4, genOne);
  for (let r = 0; r < 5; r++) { const bad = U.filter((u) => res[u].via === "lỗi tra"); if (!bad.length) break; await new Promise((s) => setTimeout(s, 3000 * (r + 1))); for (const u of bad) await genOne(u); }
  } else console.log("dùng lại kết quả tra UID trong qr-epc.json (FRESH=1 để tra lại)");
  const allE = [...new Set(Object.values(res).flatMap((r) => r.epcs))];
  const R = { s: 200, j: [] }; for (let i = 0; i < allE.length; i += 200) { const r = await post("/integrations/circa/epcs/resolve", { epcs: allE.slice(i, i + 200) }); if (r.s !== 200) R.s = r.s; R.j.push(...arr(r.j)); }
  const facts = {}; for (const x of R.j) facts[x.epc] = { found: x.found, status: x.status, wh: String(x.warehouseId || "").toLowerCase(), pid: String(x.circaProductId || ""), uid: x.unitUid || "", q: x.baseQuantity, unit: x.unit, baseUnit: x.baseUnit };
  console.log("EPC", allE.length, "resolve", R.s, Object.keys(facts).length, "sample", JSON.stringify(R.j[0] || {}).slice(0, 300));
  const v = {}; for (const r of Object.values(res)) v[r.via] = (v[r.via] || 0) + 1; console.log(v);
  fs.writeFileSync(path.join(dir, "qr-epc.json"), JSON.stringify({ res, facts }, null, 1));
})().catch((e) => { console.error(e.message); process.exit(1); });
