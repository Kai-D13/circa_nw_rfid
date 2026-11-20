// WRITE (user-requested): re-send ONE rejected POS order to Nextwaves via POST /integrations/circa/orders/notify
// (same body shape the Agent sends: {orderId: DHC, tags:[{epc, quantity}]}). Pre-checks: order not on NW, every EPC
// active / Florita / holds enough. Durable record before POST; new Idempotency-Key per attempt. A 400 changes nothing.
// Key from env NW_KEY (never written). usage: node notify-resend.js <payload.json> [--dry]
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const BASE = "https://api-circa.nextwaves.app/api/v1/public";
const WH = (process.env.WH || "eb5e2b4f-6f92-413b-90ef-6be1730b94c0").toLowerCase(); // env WH for Lumina (3f7bd541-…)
const DRY = process.argv.includes("--dry");
const payload = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const DHC = payload.orderId;
if (!payload.warehouseId) payload.warehouseId = WH; // notify requires warehouseId since 09/11/2026 ~22:35 VN
const REC = path.join(process.cwd(), `notify-resend-${DHC}.record.json`);
const die = (m) => { console.log("DỪNG: " + m); process.exit(1); };
if (!process.env.NW_KEY) die("thiếu NW_KEY");
async function call(method, p, body, key) {
  const headers = { accept: "application/json", authorization: "Bearer " + process.env.NW_KEY };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (key) headers["idempotency-key"] = key;
  if (method === "POST") headers["x-nwc-source"] = "circa-tru-ton-bu";
  try {
    const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(45000) });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch (_) {}
    return { status: r.status, json: j, text: t.slice(0, 3000), replay: r.headers.get("idempotent-replay") };
  } catch (e) { return { transport: e && e.name === "TimeoutError" ? "timeout" : "network" }; }
}
const rec = fs.existsSync(REC) ? JSON.parse(fs.readFileSync(REC, "utf8")) : { attempts: [] };
const save = () => fs.writeFileSync(REC, JSON.stringify(rec, null, 1));

(async () => {
  const open = rec.attempts.find((a) => !["rejected"].includes(a.state));
  if (open) die("đã có lần gửi trước chưa bị từ chối (" + open.state + ") — không gửi thêm");
  const o = await call("GET", "/orders/" + encodeURIComponent(DHC));
  if (process.env.ADD_TO_EXISTING === "1") {
    // Add only EPCs missing from an existing NW order (NW adds the line, does not re-deduct existing lines — verified 09/11 on DHC01342297).
    if (o.status !== 200) die("ADD_TO_EXISTING nhưng GET /orders/" + DHC + " → " + (o.status || o.transport));
    const lines = o.json.items || o.json.lines || o.json.orderItems || [];
    const onOrder = new Set(lines.map((l) => l.tagEpc || l.epc).filter(Boolean));
    const dup = payload.tags.filter((t) => onOrder.has(t.epc)).map((t) => t.epc);
    if (dup.length) die("EPC đã có trên đơn: " + dup.join(", "));
    console.log("  đơn " + o.json.orderNumber + " " + o.json.status + " có " + onOrder.size + " EPC; thêm " + payload.tags.length);
  } else if (o.status !== 404) die("GET /orders/" + DHC + " → " + (o.status || o.transport) + " (đơn đã có hoặc tra lỗi)");
  const bad = [];
  for (const t of payload.tags) {
    const h = await call("GET", "/integrations/circa/epcs/" + t.epc);
    const e = h.json || {};
    const ok = h.status === 200 && e.found && String(e.status).toLowerCase() === "active" && String(e.warehouseId).toLowerCase() === WH && Number(e.baseQuantity) >= t.quantity;
    console.log(`  ${t.epc} cần ${t.quantity} · ${e.status} · giữ ${e.baseQuantity} ${e.baseUnit} · CIRCA-${e.circaProductId} · unit ${e.unit} ratio ${e.unitRatio} packed ${e.packed} ${ok ? "OK" : "KHÔNG ĐỦ"}`);
    if (!ok) bad.push(t.epc);
  }
  if (bad.length) die("EPC không đạt: " + bad.join(", "));
  if (DRY) { console.log("DRY body:", JSON.stringify(payload)); return; }
  const attemptId = crypto.randomUUID();
  const key = DHC + "-" + (process.env.KEY_TAG || "resend") + "-" + attemptId;
  const a = { attemptId, key, body: payload, state: "submitting", startedAt: new Date().toISOString() };
  rec.attempts.push(a);
  save();
  const r = await call("POST", "/integrations/circa/orders/notify", payload, key);
  a.status = r.status || r.transport; a.response = r.json || r.text; a.replay = r.replay; a.finishedAt = new Date().toISOString();
  if (r.transport || r.status >= 500 || r.status === 408 || r.status === 429) a.state = "ambiguous";
  else if (r.status >= 200 && r.status < 300) a.state = "accepted";
  else a.state = "rejected";
  save();
  console.log("POST notify →", a.status, a.state, "replay", r.replay);
  console.log(JSON.stringify(r.json || r.text, null, 1).slice(0, 3000));
  const o2 = await call("GET", "/orders/" + encodeURIComponent(DHC));
  console.log("GET order sau gửi →", o2.status, o2.json && (o2.json.orderNumber + " " + o2.json.status));
  for (const t of payload.tags) {
    const h = (await call("GET", "/integrations/circa/epcs/" + t.epc)).json || {};
    console.log(`  sau: ${t.epc} ${h.status} giữ ${h.baseQuantity}`);
  }
})();
