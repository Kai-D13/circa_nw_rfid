// Shared, read-only. The POS order list has NO stable sort (verified 12/11/2026: page 20 started at 10/11, page 24 at 26/10),
// so paging through a long window skips and repeats orders. listCompleted() splits [from,to) into windows small enough for
// ONE page (≤ limit orders, judged by the response `total`) and never pages. Returns unique list rows ({id, code, ...}).
// usage: const { listCompleted } = require("./pos-orders"); await listCompleted(pos, store, fromISO, toISO)
//   pos(path) → {s, j} with POS headers already set (x-store-id = store).
async function listCompleted(pos, store, fromISO, toISO, opts = {}) {
  const limit = opts.limit || 100, minMs = opts.minMs || 60e3, status = opts.status || "COMPLETED";
  const seen = new Map();
  async function win(a, b) {
    const q = `/v1/pos/${store}/order?page=1&limit=${limit}&query=status=${status},completed_time_from=${new Date(a).toISOString()},completed_time_to=${new Date(b).toISOString()}`;
    let r;
    for (let t = 0; t < 4; t++) { r = await pos(q); if (r && r.s === 200 && r.j && r.j.data) break; await new Promise((s) => setTimeout(s, 800 * (t + 1))); }
    const d = r && r.j && r.j.data;
    if (!d) throw new Error("POS list failed " + (r && r.s) + " " + q);
    const total = Number(d.total), rows = d.orders || [];
    if (total > rows.length) {
      if (b - a <= minMs) throw new Error(`window ${new Date(a).toISOString()} has ${total} orders > ${limit}; cannot split further`);
      const mid = a + Math.floor((b - a) / 2);
      await win(a, mid); await win(mid, b);
      return;
    }
    for (const o of rows) if (!seen.has(o.id)) seen.set(o.id, o);
  }
  const A = Date.parse(fromISO), B = Date.parse(toISO);
  for (let a = A; a < B; a += 6 * 3600e3) await win(a, Math.min(B, a + 6 * 3600e3));
  return [...seen.values()];
}
module.exports = { listCompleted };
