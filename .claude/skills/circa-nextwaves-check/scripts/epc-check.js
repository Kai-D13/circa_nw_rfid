// Read-only. node epc-check.js <EPC>  env NW_KEY, POS_TOKEN, POS_STORE
const NW = "https://api-circa.nextwaves.app/api/v1/public";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const epc = process.argv[2];
async function g(url, headers) {
  try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {} return { s: r.status, j, t: t.slice(0, 1500) }; } catch (e) { return { s: 0, t: String(e) }; }
}
const nw = (p) => g(NW + p, { accept: "application/json", authorization: "Bearer " + process.env.NW_KEY });
(async () => {
  for (const p of ["/integrations/circa/epcs/" + epc, "/tags/" + epc, "/tags/" + epc + "/passport"]) {
    const r = await nw(p);
    console.log("\n### GET " + p + " → " + r.s);
    console.log(JSON.stringify(r.j || r.t, null, 1).slice(0, 6000));
  }
})();
