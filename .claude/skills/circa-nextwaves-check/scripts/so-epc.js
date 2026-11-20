// WRITE (user-requested): stock_out a given base quantity from ONE EPC (partial or full), Florita.
// Re-check → durable record → create DRAFT (Idempotency-Key) → submit/approve/complete → reconcile.
// Key from env NW_KEY (never written). usage: node so-epc.js <EPC> <QTY> "<reasonNote>" [--dry] [--wh=<warehouseId>]
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const BASE = "https://api-circa.nextwaves.app/api/v1/public";
const WHARG = process.argv.find((a) => a.startsWith("--wh="));
const WH = WHARG ? WHARG.slice(5).toLowerCase() : "eb5e2b4f-6f92-413b-90ef-6be1730b94c0"; // default Florita
const SOURCE = "circa-tru-ton-bu";
const NEXT = { DRAFT: "submit", SUBMITTED: "approve", APPROVED: "complete" };
const [EPC, QTYS, NOTE] = process.argv.slice(2);
const QTY = Number(QTYS);
const DRY = process.argv.includes("--dry");
const REC = path.join(process.cwd(), `so-epc-${EPC}-${QTY}.record.json`);
const die = (m) => { console.log("DỪNG: " + m); process.exit(1); };
if (!process.env.NW_KEY) die("thiếu NW_KEY");
if (!/^[0-9A-F]{24}$/.test(EPC || "") || !(QTY > 0)) die("EPC/QTY không hợp lệ");

async function call(method, p, body, key) {
  const headers = { accept: "application/json", authorization: "Bearer " + process.env.NW_KEY };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (key) headers["idempotency-key"] = key;
  if (method === "POST") headers["x-nwc-source"] = SOURCE;
  try {
    const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(30000) });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch (_) {}
    return { status: r.status, json: j, text: t.slice(0, 600) };
  } catch (e) {
    return { transport: e && e.name === "TimeoutError" ? "timeout" : "network" };
  }
}
const list = (j) => (Array.isArray(j) ? j : j && (j.data || j.items)) || [];
const rec = fs.existsSync(REC) ? JSON.parse(fs.readFileSync(REC, "utf8")) : { attempts: [] };
const save = () => fs.writeFileSync(REC, JSON.stringify(rec, null, 1));

(async () => {
  const open = rec.attempts.find((a) => a.state !== "rejected");
  if (open) die("đã có lần gửi trước (" + open.state + " " + (open.requestNumber || "") + ") — không tạo phiếu mới");
  const h = await call("GET", "/integrations/circa/epcs/" + EPC);
  if (h.status !== 200 || !h.json) die("tra EPC lỗi " + (h.transport || h.status));
  const e = h.json;
  const bad = [];
  if (!e.found) bad.push("not_found");
  if (String(e.status).toLowerCase() !== "active") bad.push("status " + e.status);
  if (String(e.warehouseId).toLowerCase() !== WH) bad.push("warehouse " + e.warehouseId);
  if (!(Number(e.baseQuantity) >= QTY)) bad.push("thẻ chỉ giữ " + e.baseQuantity);
  if (bad.length) die(bad.join(", "));
  const S = await call("GET", `/stock-requests?epc=${EPC}&type=stock_out&limit=50`);
  if (S.status !== 200) die("tra phiếu xuất lỗi " + (S.transport || S.status));
  const pend = list(S.json).filter((x) => !["COMPLETED", "CANCELLED", "REJECTED"].includes(String(x.status).toUpperCase()));
  if (pend.length) die("EPC đang nằm trong phiếu chưa xong: " + pend.map((x) => x.requestNumber + " " + x.status).join(", "));
  const before = Number(e.baseQuantity);
  console.log(`kiểm lại OK: ${EPC} active, giữ ${before} ${e.baseUnit}, CIRCA-${e.circaProductId}; xuất ${QTY} → còn ${before - QTY}`);

  const attemptId = crypto.randomUUID();
  const body = {
    type: "stock_out",
    warehouseId: WH,
    syncToChannel: false,
    notes: `${SOURCE} · trừ tồn theo yêu cầu Dean · CIRCA-${e.circaProductId} · ${EPC} · ${QTY} ${e.baseUnit} · lần ${attemptId}`,
    items: [{
      productId: e.productId,
      quantity: 1,
      epcs: [EPC],
      packBags: [{ key: crypto.randomUUID(), epc: EPC, quantity: String(QTY) }],
      unitUids: e.unitUid ? [{ epc: EPC, uid: e.unitUid }] : [],
      reason: "adjustment",
      reasonNote: (NOTE || `Trừ tồn ${QTY} ${e.baseUnit} theo yêu cầu`).slice(0, 500),
    }],
  };
  if (DRY) { console.log("DRY body:", JSON.stringify(body, null, 1)); return; }

  const a = { attemptId, state: "creating", startedAt: new Date().toISOString(), before, body, requestId: null, requestNumber: null, nwStatus: null, steps: [] };
  rec.attempts.push(a);
  save();
  const c = await call("POST", "/stock-requests", body, "so-" + attemptId + "-create");
  a.steps.push({ step: "create", at: new Date().toISOString(), status: c.status || c.transport });
  if (c.transport || c.status >= 500 || !c.json) { a.state = "ambiguous"; save(); die("tạo phiếu không rõ kết quả: " + (c.transport || c.status) + " — KHÔNG gửi lại, tra theo notes 'lần " + attemptId + "'"); }
  if (c.status < 200 || c.status > 299) { a.state = "rejected"; a.reason = c.text; save(); die("tạo phiếu bị từ chối: " + c.status + " " + c.text); }
  a.requestId = c.json.id; a.requestNumber = c.json.requestNumber; a.nwStatus = String(c.json.status || "DRAFT").toUpperCase(); a.state = "draft"; save();
  const got = (c.json.items || []).flatMap((it) => (it.packBags || []).map((b) => String(b.epc).toUpperCase() + ":" + Number(b.quantity)));
  if (c.json.type !== "stock_out" || String(c.json.warehouseId).toLowerCase() !== WH || (got.length && got.join(",") !== EPC + ":" + QTY)) {
    a.state = "pending"; a.reason = "draft_mismatch " + got.join(","); save(); die("phiếu nháp không khớp (" + a.requestNumber + ") — dừng ở DRAFT");
  }
  console.log("đã tạo " + a.requestNumber + " (" + a.nwStatus + ")");
  for (let g = 0; g < 4 && a.nwStatus !== "COMPLETED"; g++) {
    const step = NEXT[a.nwStatus];
    if (!step) { a.state = "pending"; a.reason = "status " + a.nwStatus; save(); die("trạng thái lạ " + a.nwStatus); }
    a.state = "submitting"; save();
    const r = await call("POST", "/stock-requests/" + a.requestId + "/" + step, {}, "so-" + attemptId + "-" + step);
    a.steps.push({ step, at: new Date().toISOString(), status: r.status || r.transport });
    let st = r.json && r.json.status ? String(r.json.status).toUpperCase() : null;
    if (!st || r.transport || r.status >= 300) {
      const q = await call("GET", "/stock-requests/" + a.requestId);
      st = q.json && q.json.status ? String(q.json.status).toUpperCase() : null;
      if (!st) { a.state = "ambiguous"; save(); die(step + " không rõ kết quả"); }
      if (st === a.nwStatus) { a.state = "pending"; a.reason = step + " " + (r.status || r.transport) + " " + (r.text || ""); save(); die(step + " không qua: " + a.reason); }
    }
    a.nwStatus = st; save();
    console.log(step + " → " + st);
  }
  const q = await call("GET", "/stock-requests/" + a.requestId);
  const t = await call("GET", "/integrations/circa/epcs/" + EPC);
  a.state = q.json && String(q.json.status).toUpperCase() === "COMPLETED" ? "confirmed" : "pending";
  a.reconcile = { request: q.json && q.json.status, epcStatus: t.json && t.json.status, epcBaseQuantity: t.json && t.json.baseQuantity };
  a.finishedAt = new Date().toISOString();
  save();
  console.log("đối soát:", JSON.stringify(a.reconcile));
})();
