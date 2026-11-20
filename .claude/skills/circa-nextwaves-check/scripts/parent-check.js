// Read-only. node parent-check.js <code|qr-url ...> [--epc=<EPC>,<EPC>...] — for each scanned code: by-uid, generations in every
// form (bare, thuocsi.vn/qr/, qr.v2.circa.vn/item/), label resolve; for every EPC found or given: /tags/{epc}/check parentUid.
// env NW_KEY, optional WH (default Florita). Shows Generation.source + CheckResult.parentUid (fields added to the docs 12/11/2026).
const NW = "https://api-circa.nextwaves.app/api/v1/public";
const WH = process.env.WH || "eb5e2b4f-6f92-413b-90ef-6be1730b94c0";
const nw = async (p) => { const r = await fetch(NW + p, { headers: { accept: "application/json", authorization: "Bearer " + process.env.NW_KEY } }); return { s: r.status, j: await r.json().catch(() => null) }; };
const args = process.argv.slice(2);
const epcArg = (args.find((a) => a.startsWith("--epc=")) || "").slice(6).split(",").filter(Boolean);
const codes = args.filter((a) => !a.startsWith("--"));
const vn = (ms) => new Date(ms + 7 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
(async () => {
  const epcs = new Set(epcArg);
  for (const raw of codes) {
    const uid = String(raw).replace(/^.*\//, "");
    const b = (await nw("/tags/by-uid/" + uid)).j || {};
    if (b.mapped) epcs.add(b.epc);
    console.log(`\n### ${uid}  (tạo ${/^\d{13}/.test(uid) ? vn(Number(uid.slice(0, 13))) : "?"}) · by-uid: ${b.mapped ? b.epc + " " + b.status : "unmapped"}`);
    const seen = {};
    for (const c of [uid, "thuocsi.vn/qr/" + uid, "qr.v2.circa.vn/item/" + uid]) {
      const g = await nw("/printing/labels/generations/" + encodeURIComponent(c));
      const j = g.j || {};
      const key = g.s + "|" + (j.generationId || j.message);
      if (seen[key]) { console.log(`   gen ${c} → same as ${seen[key]}`); continue; }
      seen[key] = c;
      if (g.s !== 200) { console.log(`   gen ${c} → ${g.s} ${j.message || ""}`); continue; }
      console.log(`   gen ${c} → 200 source=${j.source} gid=${j.generationId} parentQr=${j.parentQr} state=${j.state} superseded=${j.superseded} expected=${j.expectedCount} minted=${j.mintedCount}`);
      for (const ch of j.children || []) { console.log(`      child ${ch.unitUid} mapped=${ch.mapped} epc=${ch.epc}`); if (ch.epc) epcs.add(ch.epc); }
    }
    const r = (await nw("/printing/labels/resolve?code=" + encodeURIComponent("thuocsi.vn/qr/" + uid))).j || {};
    console.log(`   resolve(thuocsi form): source=${r.source} epc=${r.epc || "-"} unitUid=${r.unitUid} product=${r.sku}`);
  }
  if (epcs.size) console.log("\n### EPC check (parentUid)");
  for (const e of epcs) {
    const c = (await nw(`/tags/${e}/check?warehouseId=${WH}`)).j || {};
    console.log(`   ${e} · unitUid ${c.unitUid} · parentUid ${c.parentUid === undefined ? "(field missing)" : c.parentUid} · ${c.tagStatus} · ${c.product && c.product.productIdentifier} · wh ${c.warehouse && c.warehouse.name}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
