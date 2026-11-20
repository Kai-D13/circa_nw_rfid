// backfill-engine.js — trừ tồn bù cho đơn POS cũ, dùng NGUYÊN core.js của circa-qr-scan-log (CORE.buildNotifyPreview).
// Extension gốc lập payload từ bằng chứng quét ghi trên máy POS (ev:*, ord:*). Đơn cũ không có bằng chứng đó trên máy này, nên
// engine dựng lại đúng shape ấy từ API: ord ← GET /v1/order/{id} (CORE.extractOrderInfo + CORE.mergeOrderInfo), lượt quét / thao
// tác ← activity-log POS, tra UID ← Nextwaves by-uid / generation (RFID.byUidVerdict / generationVerdict + CORE.lookupPatch),
// lượng tem ← /integrations/circa/epcs (CORE.parseNotifyEpcHolding). Engine không có luật trừ riêng: kết luận là của core.js.
// Thuần (không chrome.*, không fetch): mạng được truyền vào. Chạy được trong Node (test) và trong trang / extension.
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.__CIRCA_BACKFILL_ENGINE__ = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ENGINE_VERSION = "0.1.0";
  const DEFAULT_BLOCKLIST = Object.freeze(["DHC01294054", "DHC01299037", "DHC01208344", "DHC01254831"]);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SCAN_ACTIONS = new Set(["ITEM_ADDED", "ITEM_QUANTITY_CHANGED"]);

  const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  function isBlocked(code, blocklist) {
    const c = String(code || "").toUpperCase();
    if (/APITEST/.test(c)) return true;
    return (blocklist || DEFAULT_BLOCKLIST).some((b) => String(b).toUpperCase() === c);
  }

  // ---- 1. Đơn POS → ord (đúng hàm extension dùng cho response POS) ----
  function buildOrd(CORE, orderJson, nowIso) {
    const info = CORE.extractOrderInfo(orderJson);
    if (!info) return null;
    return CORE.mergeOrderInfo(null, info, nowIso || new Date().toISOString());
  }

  // ---- 2. activity-log → lượt quét QR + thao tác dòng hàng (shape ev: của extension) ----
  // Log POS không ghi ID dòng. Gắn dòng theo mã QR: mã nằm trong qr_codes của đúng MỘT dòng cuối → dòng đó; mã không còn ở dòng
  // nào (dòng đã xoá) → ID dòng giả (core xếp vào excluded, như lượt của dòng đã xoá); mã ở nhiều dòng → không gắn (unplaced, core
  // giữ cả đơn). Thao tác tay (+ / − / đổi đơn vị / đổi lô) gắn theo SKU khi SKU chỉ có một dòng cuối; nhiều dòng → chẩn đoán
  // "không phân loại được" cho mọi dòng của SKU (core giữ dòng). Mọi chỗ không chắc đều nghiêng về GIỮ, không bao giờ về TRỪ.
  function synthesize(CORE, orderJson, logList, ord) {
    const order = orderJson && orderJson.data && orderJson.data.order ? orderJson.data.order : null;
    const orderId = ord.orderId;
    const finals = [];
    for (const it of Array.isArray(order && order.items) ? order.items : []) {
      if (!it || !UUID_RE.test(String(it.id || ""))) continue;
      const codes = new Set([it.qr_code].concat(Array.isArray(it.qr_codes) ? it.qr_codes : []).filter((q) => typeof q === "string" && q));
      finals.push({ itemId: it.id.toLowerCase(), sku: text(it.sku_code), productId: it.product_id === null || it.product_id === undefined ? null : String(it.product_id), unit: text(it.unit), codes, qty: 0, unitNow: null });
    }
    const byCode = new Map();
    for (const f of finals) for (const c of f.codes) byCode.set(c, (byCode.get(c) || []).concat([f]));
    const bySku = new Map();
    for (const f of finals) if (f.sku) bySku.set(f.sku, (bySku.get(f.sku) || []).concat([f]));
    const removedSkus = new Set();
    const logs = (Array.isArray(logList) ? logList : [])
      .filter((a) => a && a.status === "SUCCESS" && typeof a.created_at === "string")
      .slice()
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || String(a.id).localeCompare(String(b.id)));
    for (const a of logs) if (a.action === "ITEM_REMOVED" && a.metadata && a.metadata.sku_code) removedSkus.add(a.metadata.sku_code);

    const events = [];
    const posActionDiag = [];
    const notes = [];
    const ghost = new Map(); // mã → ID dòng giả (dòng đã xoá)
    const ghostId = (key) => {
      if (!ghost.has(key)) ghost.set(key, CORE.stableUuid("backfill-removed-line:" + orderId + ":" + key));
      return ghost.get(key);
    };
    const productOf = (md, f) => {
      if (f && (!md.sku_code || md.sku_code === f.sku)) return f.productId;
      const n = num(md.product_id);
      return n === null ? null : String(Math.round(n));
    };
    const seen = new Map(); // itemId → mã đã quét vào dòng
    const seenOn = (id) => {
      if (!seen.has(id)) seen.set(id, new Set());
      return seen.get(id);
    };
    const eventIdOf = (a) => (UUID_RE.test(String(a.id || "")) ? a.id.toLowerCase() : CORE.stableUuid("backfill-log:" + orderId + ":" + a.created_at + ":" + a.action));

    for (const a of logs) {
      const md = a.metadata && typeof a.metadata === "object" ? a.metadata : {};
      const args = a.detail && Array.isArray(a.detail.args) ? a.detail.args : [];
      if (md.gift_code) continue; // dòng quà tặng / combo tự áp dụng: không có lượt quét — core giữ dòng (item_no_scan)
      const code = text(md.qr_code);
      const viaQr = md.via === "qr" && !!code;
      // POS ghi cả bấm + / − / sửa lượng của dòng đã quét là ITEM_QUANTITY_CHANGED via "qr" kèm MÃ CŨ của dòng (đã thấy trên log
      // thật: 1→4 cùng mã). Mã đã có trên dòng → thao tác sửa lượng (như extension ghi item_quantity_set), không phải lượt quét mới.
      const owners0 = viaQr ? byCode.get(code) || [] : [];
      if (a.action === "ITEM_QUANTITY_CHANGED" && viaQr && owners0.length === 1 && seenOn(owners0[0].itemId).has(code)) {
        const f = owners0[0];
        const prevQ = num(args[0]);
        const nextQ = num(args[1]);
        f.qty = nextQ;
        events.push({
          eventId: eventIdOf(a),
          orderId,
          recordType: "sale_order_action",
          source: "pos",
          action: "item_quantity_set",
          scannedAt: a.created_at,
          modifiedItemId: f.itemId,
          previousQuantity: prevQ,
          modifiedQuantity: nextQ,
          previousUnit: f.unitNow || text(md.unit),
          modifiedUnit: text(md.unit) || f.unitNow,
          backfill: { logAction: a.action, via: "qr_same_code", code },
        });
        continue;
      }
      if (SCAN_ACTIONS.has(a.action) && viaQr) {
        const owners = owners0;
        let itemId = null;
        let f = null;
        if (owners.length === 1) {
          f = owners[0];
          itemId = f.itemId;
        } else if (owners.length === 0) {
          itemId = ghostId("code:" + code);
          notes.push({ code: removedSkus.has(md.sku_code) ? "scan_on_removed_line" : "scan_code_not_on_final_lines", detail: code });
        } else {
          notes.push({ code: "scan_code_on_many_lines", detail: code });
        }
        const qty = a.action === "ITEM_ADDED" ? num(args[0]) : num(args[1]);
        if (f) {
          f.qty = qty === null ? f.qty : qty;
          f.unitNow = text(md.unit) || f.unitNow;
          seenOn(f.itemId).add(code);
        }
        events.push({
          eventId: eventIdOf(a),
          orderId,
          recordType: "sale_order",
          source: "qr",
          action: "scan",
          status: "accepted",
          qrRaw: code,
          qrCode: code,
          uid: CORE.looksLikeUid(code) ? code : null,
          scannedAt: a.created_at,
          modifiedItemId: itemId,
          modifiedQuantity: qty,
          modifiedUnit: text(md.unit),
          productId: productOf(md, f),
          backfill: { logAction: a.action, sku: text(md.sku_code) },
        });
        continue;
      }
      const skuLines = md.sku_code ? bySku.get(md.sku_code) || [] : [];
      if (a.action === "ITEM_ADDED") {
        // Thêm tay (không quét): không có lượt; dòng cuối thiếu lượt cho mã của nó → core giữ dòng.
        if (skuLines.length === 1) {
          skuLines[0].qty = num(args[0]);
          skuLines[0].unitNow = text(md.unit);
        }
        continue;
      }
      if (a.action === "ITEM_QUANTITY_CHANGED" || a.action === "ITEM_UNIT_CHANGED") {
        if (!skuLines.length) continue; // dòng đã xoá
        if (skuLines.length > 1) {
          for (const f of skuLines) posActionDiag.push({ orderId, itemId: f.itemId, reason: "backfill_ambiguous_line:" + a.action, at: a.created_at });
          continue;
        }
        const f = skuLines[0];
        const isUnit = a.action === "ITEM_UNIT_CHANGED";
        const prevQ = isUnit ? f.qty : num(args[0]);
        const nextQ = isUnit ? f.qty : num(args[1]);
        const prevU = isUnit ? text(args[0]) : f.unitNow || text(md.unit);
        const nextU = isUnit ? text(args[1]) : text(md.unit) || f.unitNow;
        f.qty = nextQ;
        f.unitNow = nextU;
        events.push({
          eventId: eventIdOf(a),
          orderId,
          recordType: "sale_order_action",
          source: "pos",
          action: "item_quantity_set",
          scannedAt: a.created_at,
          modifiedItemId: f.itemId,
          previousQuantity: prevQ,
          modifiedQuantity: nextQ,
          previousUnit: prevU,
          modifiedUnit: nextU,
          backfill: { logAction: a.action, via: md.via || null },
        });
        continue;
      }
      if (a.action === "ITEM_LOT_CHANGED") {
        // Đổi lô qua /item: extension không phân loại được lời gọi này → chẩn đoán → core giữ dòng.
        for (const f of skuLines) posActionDiag.push({ orderId, itemId: f.itemId, reason: "backfill_lot_changed", at: a.created_at });
      }
    }
    return { events, posActionDiag, notes };
  }

  // ---- 3. Tra UID → kết quả tra (outcome) đúng như lookupForEvent của worker ----
  // fetchJson(url) → { status, json } | { transport }. Lượt backfill không có nguyên văn chuỗi quét, chỉ có mã POS lưu (đã tách).
  async function lookupCode(RFID, fetchJson, nwBase, code, looksLikeUid) {
    if (!looksLikeUid(code)) return { kind: "invalid", error: "uid_invalid" };
    const r = await fetchJson(nwBase + "/tags/by-uid/" + encodeURIComponent(code));
    if (r.transport) return { kind: "error", error: r.transport, auth: !!r.auth, network: !r.auth, infra: !r.auth };
    const verdict = RFID.byUidVerdict(r.status, r.json, code);
    if (!verdict.ok) return { kind: "error", error: verdict.reason, auth: verdict.reason === "auth" };
    if (verdict.mapped) return { kind: "mapped", epc: verdict.epc };
    const g = await fetchJson(nwBase + "/printing/labels/generations/" + encodeURIComponent(code));
    if (g.transport) return { kind: "error", error: g.transport, auth: !!g.auth, network: !g.auth, infra: !g.auth };
    const v = RFID.generationVerdict(g.status, g.json, code);
    if (!v.ok) {
      if (v.auth) return { kind: "error", error: "auth", auth: true };
      if (v.contract) return { kind: "contract", error: String(v.reason || "").replace(/^contract:/, "") };
      return { kind: "error", error: v.reason, infra: !!v.infra, network: !!v.infra };
    }
    const generation = { generationId: v.generationId || null, mappedChildCount: Number.isInteger(v.mappedChildCount) ? v.mappedChildCount : null, resolvedChildren: v.resolvedChildren || null };
    if (v.kind === "mapped") return { kind: "mapped", epc: v.epc, resolvedUid: v.resolvedUid, generation };
    if (v.kind === "mapped_multiple") return { kind: "mapped_multiple", generation };
    return { kind: "unmapped", generation };
  }

  function applyLookups(CORE, events, outcomes, nowIso) {
    const nowMs = Date.parse(nowIso) || Date.now();
    return events.map((e) => {
      if (e.source !== "qr") return e;
      const o = outcomes.get(e.qrCode);
      if (!o) return Object.assign({}, e, { mappingStatus: "pending" });
      return Object.assign({}, e, CORE.lookupPatch(e, o, nowIso, nowMs));
    });
  }

  // ---- 4. Một đơn: dựng preview bằng core.js (2 lượt như buildNotifyJobLocked: lượt 1 lấy danh sách EPC, tra lượng, lượt 2) ----
  //   allocated: Map(EPC → lượng đã xếp trừ cho đơn TRƯỚC trong cùng lượt) — lượng còn đưa vào core = còn − đã xếp.
  function previewOrder(CORE, ctx) {
    const opts = { pendingLocal: 0, fixMarker: null, unitChangeMarker: null, posActionDiag: ctx.posActionDiag || [] };
    const evidence = {};
    for (const [epc, ev] of Object.entries(ctx.evidence || {})) {
      const used = (ctx.allocated && ctx.allocated.get(epc)) || 0;
      evidence[epc] = ev && ev.ok === true && used > 0 ? Object.assign({}, ev, { held: ev.held - used, allocatedBefore: used }) : ev;
    }
    return CORE.buildNotifyPreview(ctx.ord, ctx.events, evidence, opts);
  }

  // ---- 5. Kết luận cấp đơn cho công cụ ----
  function orderVerdict(code, blocklist, nwStatus, preview) {
    if (isBlocked(code, blocklist)) return { verdict: "blocked", reason: "blocklist" };
    if (nwStatus === 200) return { verdict: "on_nextwaves", reason: "order_exists" };
    if (nwStatus !== 404) return { verdict: "check_error", reason: "nextwaves_order_http_" + nwStatus };
    if (!preview) return { verdict: "check_error", reason: "no_preview" };
    if (preview.state === "prepared") return { verdict: "ready", reason: null };
    const r = preview.reasons && preview.reasons[0];
    return { verdict: "needs_review", reason: r ? r.code : "unknown" };
  }

  return { ENGINE_VERSION, DEFAULT_BLOCKLIST, isBlocked, buildOrd, synthesize, lookupCode, applyLookups, previewOrder, orderVerdict };
});
