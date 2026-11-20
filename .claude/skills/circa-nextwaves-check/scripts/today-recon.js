// Read-only: Florita POS orders completed in a window vs Nextwaves (GET /orders/{code}) vs the Agent export (watch/notifyJobs).
// env POS_TOKEN, NW_KEY (never written). usage: node today-recon.js <fromISO> <toISO> <agent-export.json> [more exports...]
const fs = require("fs");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const STORE = process.env.POS_STORE || "c476efb2-415c-429a-978e-d389b4b06607";
const vn = (t) => (t ? new Date(Date.parse(t) + 7 * 3600e3).toISOString().slice(5, 16).replace("T", " ") : "");
async function req(url, headers) {
  for (let a = 0; a < 4; a++) {
    try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1000 * (a + 1))); continue; }
      return { status: r.status, json: await r.json().catch(() => null) };
    } catch (_) { await new Promise((s) => setTimeout(s, 800)); }
  }
  return { status: 0, json: null };
}
const pos = (p) => req("https://api.v2.circa.vn" + p, { accept: "application/json, text/plain, */*", authorization: "Bearer " + process.env.POS_TOKEN, "x-circa-app": "pos", "x-client-id": "1", "x-store-id": STORE, "user-agent": UA, origin: "https://pos.v2.circa.vn", referer: "https://pos.v2.circa.vn/" });
const nw = (p) => req("https://api-circa.nextwaves.app/api/v1/public" + p, { accept: "application/json", authorization: "Bearer " + process.env.NW_KEY });
(async () => {
  const [from, to, ...exps] = process.argv.slice(2);
  const agent = {};
  for (const f of exps) {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    const st = j.posStationId;
    for (const w of Object.values(j.watch || {})) (agent[w.code] = agent[w.code] || []).push(`${st} watch ${w.outcome || w.status}`);
    for (const n of j.notifyJobs || []) (agent[n.orderCode] = agent[n.orderCode] || []).push(`${st} job ${n.state}${n.result && n.result.httpStatus ? " " + n.result.httpStatus + " " + String(n.result.message || n.result.code || "").slice(0, 40) : ""}`);
    const scans = {}; for (const e of j.events || []) if (e.orderId) scans[e.orderId] = (scans[e.orderId] || 0) + 1;
    agent.__scans = Object.assign(agent.__scans || {}, scans);
  }
  // windowed listing: the POS list sort is unstable, deep paging skips/repeats orders (12/11/2026)
  const orders = await require("./pos-orders").listCompleted(async (p) => { const r = await pos(p); return { s: r.status, j: r.json }; }, STORE, from, to);
  orders.sort((a, b) => Date.parse(a.completed_date) - Date.parse(b.completed_date));
  const rows = [];
  for (const o of orders) {
    const g = await nw("/orders/" + encodeURIComponent(o.code));
    const nwS = g.status === 200 ? (g.json.orderNumber + " " + g.json.status) : g.status === 404 ? "CHƯA CÓ" : "http " + g.status;
    const items = (o.items || []).length;
    const ag = (agent[o.code] || []).join(" | ") || "-";
    const sc = agent.__scans[o.id] || 0;
    const ret = (o.order_return_codes || []).filter(Boolean).join(" "); rows.push({ ret, code: o.code, id: o.id, type: o.type, created: vn(o.created_date), completed: vn(o.completed_date), by: o.created_by_name, items, nw: nwS, agent: ag, scans: sc });
    console.log(`${o.code} ${o.type} xong ${vn(o.completed_date)} · ${o.created_by_name || ""} · ${items} dòng · NW ${nwS}${ret ? " · TRẢ HÀNG " + ret : ""} · quét ${sc} · Agent: ${ag}`);
  }
  fs.writeFileSync(process.env.OUT || "today-recon.json", JSON.stringify(rows, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
