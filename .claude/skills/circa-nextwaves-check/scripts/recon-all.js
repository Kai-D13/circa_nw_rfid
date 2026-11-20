// Read-only. For every order in today-recon.json: rebuild RFID lines from POS items[].qr_codes (UID->EPC on Nextwaves),
// then: if the order is on Nextwaves -> compare EPC sets with the NW order lines (missing / extra);
// if not -> greedy allocation on current holding and write recon-<code>.payload.json. env POS_TOKEN, NW_KEY.
// usage: node recon-all.js today-recon.json [CODE1,CODE2,...]   (env QUIET=1 prints only flagged orders)
const fs = require("fs");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const STORE = process.env.POS_STORE || "c476efb2-415c-429a-978e-d389b4b06607", WH = process.env.WH || "eb5e2b4f-6f92-413b-90ef-6be1730b94c0";
const WHN = { "eb5e2b4f-6f92-413b-90ef-6be1730b94c0": "Florita", "3f7bd541-7370-4ce0-9048-231cf061e91a": "Lumina" };
const vn = (t) => (t ? new Date(Date.parse(t) + 7 * 3600e3).toISOString().slice(5, 16).replace("T", " ") : "");
async function req(url, headers) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1000 * (a + 1))); continue; }
      return { status: r.status, json: await r.json().catch(() => null) };
    } catch (_) { await new Promise((s) => setTimeout(s, 800)); }
  }
  return { status: 0, json: null };
}
const pos = (p) => req("https://api.v2.circa.vn" + p, { accept: "application/json, text/plain, */*", authorization: "Bearer " + process.env.POS_TOKEN, "x-circa-app": "pos", "x-client-id": "1", "x-store-id": STORE, "user-agent": UA, origin: "https://pos.v2.circa.vn", referer: "https://pos.v2.circa.vn/" });
const nw = (p) => req("https://api-circa.nextwaves.app/api/v1/public" + p, { accept: "application/json", authorization: "Bearer " + process.env.NW_KEY });
const cache = {};
async function uidToEpc(uid) {
  if (cache[uid]) return cache[uid];
  let epc = null, via = null;
  const b = (await nw("/tags/by-uid/" + encodeURIComponent(uid))).json;
  if (b && b.mapped && b.epc) { epc = b.epc; via = "uid"; }
  else {
    const g = await nw("/printing/labels/generations/" + encodeURIComponent(uid));
    if (g.status === 200 && g.json && g.json.parentQr) {
      const pid = String(g.json.parentQr).replace(/^.*\//, "");
      const pb = (await nw("/tags/by-uid/" + encodeURIComponent(pid))).json;
      if (pb && pb.mapped && pb.epc) { epc = pb.epc; via = "parent " + pid; }
    }
  }
  const h = epc ? (await nw("/integrations/circa/epcs/" + epc)).json || {} : null;
  return (cache[uid] = { epc, via, h });
}
const arr = (j) => (Array.isArray(j) ? j : (j && (j.data || j.items)) || []);
(async () => {
  const list = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const only = process.argv[3] ? new Set(process.argv[3].split(",")) : null;
  const out = [];
  for (const row of list) {
    if (only && !only.has(row.code)) continue;
    const r = await pos("/v1/order/" + row.id + "?get_rating=true");
    const o = r.json && r.json.data && r.json.data.order;
    const O = { code: row.code, id: row.id, completed: row.completed, agent: row.agent, ret: row.ret, lines: [], tags: {} };
    if (!o) { O.err = "POS " + r.status; out.push(O); console.log("\n## " + row.code + " POS " + r.status); continue; }
    O.status = o.status;
    const g = await nw("/orders/" + encodeURIComponent(row.code));
    O.onNw = g.status === 200;
    const nwLines = O.onNw ? arr(g.json.items || g.json.lines || g.json.orderItems) : [];
    O.nwCreated = O.onNw ? vn(g.json.createdAt) : null;
    const nwEpc = {};
    nwLines.forEach((l) => { const e = l.tagEpc || l.epc; if (e) nwEpc[e] = (nwEpc[e] || 0) + Number(l.baseQuantity || l.quantity || 0); });
    O.nwEpc = nwEpc;
    for (const it of o.items || []) {
      const name = (it.product && it.product.name) || it.product_name || it.sku_code;
      const uids = [...new Set([it.qr_code].concat(it.qr_codes || []).filter((q) => typeof q === "string" && q.trim()).map((q) => q.replace(/^.*\//, "")))];
      const L = { product: name, circaId: it.product_id, qty: it.quantity, unit: it.unit, base: Number(it.base_quantity), uids, takes: [], notes: [] };
      if (!uids.length) { L.notes.push("no QR"); O.lines.push(L); continue; }
      let need = L.base;
      for (const u of uids) {
        const m = await uidToEpc(u);
        if (!m.epc) { L.takes.push({ uid: u, problem: "UID unmapped" }); continue; }
        const h = m.h || {};
        const T = { uid: u, epc: m.epc, via: m.via, hold: Number(h.baseQuantity), status: h.status, wh: WHN[String(h.warehouseId).toLowerCase()] || h.warehouseId, circa: h.circaProductId, unit: h.unit + "x" + h.unitRatio };
        if (String(h.circaProductId) !== String(it.product_id)) T.problem = "EPC is CIRCA-" + h.circaProductId;
        if (O.onNw) { T.onOrder = nwEpc[m.epc] || 0; L.takes.push(T); continue; }
        if (!T.problem && String(h.status).toLowerCase() !== "active") T.problem = "tag " + h.status;
        if (!T.problem && T.wh !== WHN[WH]) T.problem = "tag in " + T.wh;
        if (T.problem) { L.takes.push(T); continue; }
        const q = Math.max(0, Math.min(need, T.hold - (O.tags[m.epc] || 0)));
        T.quantity = q; L.takes.push(T);
        if (q > 0) { O.tags[m.epc] = (O.tags[m.epc] || 0) + q; need -= q; }
      }
      L.short = O.onNw ? null : need;
      if (!O.onNw && need > 0) L.notes.push("SHORT " + need + "/" + L.base);
      L.takes.filter((t) => t.problem).forEach((t) => L.notes.push(t.uid + (t.epc ? "->" + t.epc : "") + ": " + t.problem + (t.epc ? " (hold " + t.hold + ", " + t.status + ", " + t.wh + ")" : "")));
      if (O.onNw) {
        const ok = L.takes.filter((t) => t.epc && !t.problem);
        const miss = ok.filter((t) => !t.onOrder);
        if (miss.length) L.notes.push("NOT ON NW ORDER: " + miss.map((t) => t.epc + " (" + t.status + ", hold " + t.hold + ")").join(", "));
      }
      O.lines.push(L);
    }
    if (O.onNw) {
      const mine = new Set(O.lines.flatMap((l) => l.takes.filter((t) => t.epc).map((t) => t.epc)));
      O.extra = Object.keys(nwEpc).filter((e) => !mine.has(e));
    } else {
      O.payload = { orderId: O.code, warehouseId: WH, tags: Object.entries(O.tags).map(([epc, quantity]) => ({ epc, quantity })) };
      if (O.payload.tags.length) fs.writeFileSync((process.env.PFX || "recon-") + O.code + ".payload.json", JSON.stringify(O.payload));
    }
    out.push(O);
    const flagged = !O.onNw || (O.extra && O.extra.length) || O.lines.some((l) => l.notes.some((n) => n !== "no QR"));
    if (!flagged && process.env.QUIET) continue;
    console.log("\n## " + O.code + " " + O.status + " done " + O.completed + " | " + (O.onNw ? "NW yes (created " + O.nwCreated + ")" : "NW MISSING") + (O.ret ? " | RETURN " + O.ret : "") + " | Agent: " + O.agent);
    for (const l of O.lines) console.log("   - " + l.product + " | " + l.qty + " " + l.unit + " (base " + l.base + ")" + (l.uids.length ? " | QR " + l.uids.join(",") + " -> " + l.takes.map((t) => (t.epc || "-") + (t.quantity != null ? " x" + t.quantity + "/" + t.hold : t.onOrder != null ? " onOrder " + t.onOrder : "")).join(", ") : "") + (l.notes.length ? "  !! " + l.notes.join("; ") : ""));
    if (O.onNw) { if (O.extra.length) console.log("   NW has extra EPC not in POS QR: " + O.extra.join(", ")); }
    else console.log("   => payload " + JSON.stringify(O.payload.tags));
  }
  fs.writeFileSync(process.env.OUT || "recon-all.json", JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
