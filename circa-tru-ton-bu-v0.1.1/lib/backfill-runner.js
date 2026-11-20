// backfill-runner.js — điều phối kiểm tra + gửi trừ tồn bù. Không có luật trừ riêng: payload là của CORE.buildNotifyPreview
// (qua backfill-engine), kết quả gửi là của CORE.notifyVerdict. Mạng và lưu trữ được truyền vào (deps) để test được trong Node.
//
// deps = {
//   CORE, RFID, E,                          // core.js, rfid-core.js, backfill-engine.js
//   posFetchOrder(orderId) → { status, json, log, logStatus, error? }   // chạy trong tab POS đã đăng nhập
//   nwFetch(method, path, { bodyText, idempotencyKey, timeoutMs }) → { status, json, replay? } | { transport }
//   nwBase,                                 // https://api-circa.nextwaves.app/api/v1/public
//   storeGet(key) / storeSet(key, value),   // chrome.storage.local (bản ghi gửi: "bf:<DHC>")
//   sha256(text) → hex, now() → ISO, blocklist[], storeId, onProgress(info)
// }
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.__CIRCA_BACKFILL_RUNNER__ = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const DHC_G = /DHC\d{5,}/gi;
  const NOTIFY_PATH = "/integrations/circa/orders/notify";
  const NOTIFY_TIMEOUT_MS = 30000; // như Agent (NOTIFY_POST_TIMEOUT_MS)
  const REC = "bf:"; // khoá bản ghi gửi theo DHC
  const STARTED = ["submitting", "confirmed", "ambiguous", "rejected"];

  // Mỗi dòng: order_id (UUID) và có thể kèm DHC. Dòng chỉ có DHC → báo thiếu order_id (POS chưa có API tìm theo DHC).
  function parseInput(textIn) {
    const orders = [];
    const errors = [];
    const seen = new Set();
    let dups = 0;
    for (const raw of String(textIn || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const ids = line.match(UUID_G) || [];
      const codes = (line.match(DHC_G) || []).map((c) => c.toUpperCase());
      if (!ids.length) {
        if (codes.length) errors.push({ line, reason: "missing_order_id" });
        else if (!/^(pos_name|order_code|order_id)/i.test(line)) errors.push({ line, reason: "no_order_id" });
        continue;
      }
      for (const id0 of ids) {
        const id = id0.toLowerCase();
        if (seen.has(id)) {
          dups++;
          continue;
        }
        seen.add(id);
        orders.push({ orderId: id, code: ids.length === 1 && codes.length === 1 ? codes[0] : null });
      }
    }
    return { orders, errors, dups };
  }

  async function pool(items, n, fn) {
    const q = items.slice();
    await Promise.all(Array.from({ length: Math.max(1, n) }, async () => {
      while (q.length) await fn(q.shift());
    }));
  }

  function lineSummary(pv) {
    const items = (pv && pv.items) || [];
    return {
      lines: items.length,
      ok: items.filter((x) => x.status === "ok").length,
      held: items.filter((x) => x.status === "held").length,
      noRfid: items.filter((x) => x.status === "no_rfid").length,
      failed: items.filter((x) => x.status === "failed" || x.status === "partial").length,
    };
  }

  function createRunner(deps) {
    const { CORE, RFID, E } = deps;
    const progress = (info) => {
      if (typeof deps.onProgress === "function") deps.onProgress(info);
    };
    const lookupCache = new Map(); // mã UID → outcome (trong một lượt chạy)

    async function nwOrder(code) {
      const r = await deps.nwFetch("GET", "/orders/" + encodeURIComponent(code), {});
      if (r.transport) return { status: 0, transport: r.transport };
      return { status: r.status, json: r.json };
    }

    // ---- Kiểm tra: không ghi gì ra ngoài ----
    async function check(orders) {
      const now = deps.now();
      const results = orders.map((o) => ({ orderId: o.orderId, inputCode: o.code || null, code: o.code || null, verdict: "checking", reason: null }));
      let done = 0;
      // 1. POS (tối đa 4 song song, như spec)
      await pool(results, 4, async (r) => {
        try {
          const p = await deps.posFetchOrder(r.orderId);
          r.posHttp = p.status;
          if (p.status !== 200 || !p.json || !p.json.data || !p.json.data.order) {
            r.verdict = "check_error";
            r.reason = p.error || "pos_http_" + p.status;
          } else if (p.logStatus !== 200) {
            r.verdict = "check_error";
            r.reason = "pos_log_http_" + p.logStatus;
          } else {
            const o = p.json.data.order;
            r.code = o.code;
            r.posStatus = o.status;
            r.posType = o.type;
            r.completedDate = o.completed_date || null;
            r.posId = o.pos_id || null;
            r.json = p.json;
            r.log = p.log;
            if (r.inputCode && r.inputCode !== o.code) {
              r.verdict = "check_error";
              r.reason = "code_mismatch:" + r.inputCode + "≠" + o.code;
            } else if (deps.storeId && o.pos_id && String(o.pos_id).toLowerCase() !== String(deps.storeId).toLowerCase()) {
              r.verdict = "check_error";
              r.reason = "wrong_store";
            } else {
              r.ord = E.buildOrd(CORE, p.json, now);
              r.syn = E.synthesize(CORE, p.json, p.log, r.ord);
            }
          }
        } catch (e) {
          r.verdict = "check_error";
          r.reason = "pos_exception:" + String((e && e.message) || e);
        }
        progress({ phase: "pos", done: ++done, total: results.length });
      });
      const live = results.filter((r) => r.ord);
      // 2. Bản ghi gửi cục bộ + Nextwaves đã có đơn chưa
      done = 0;
      await pool(live, 3, async (r) => {
        r.record = (await deps.storeGet(REC + r.code)) || null;
        const n = await nwOrder(r.code);
        r.nwStatus = n.status;
        if (n.status === 200 && n.json) {
          r.nwOrder = { orderNumber: n.json.orderNumber || null, status: n.json.status || null, items: (n.json.items || []).map((i) => ({ epc: i.tagEpc || null, baseQuantity: i.baseQuantity, productId: i.product ? i.product.externalProductId : null })) };
        }
        progress({ phase: "nextwaves_orders", done: ++done, total: live.length });
      });
      // 3. Tra UID (dùng chung bộ nhớ đệm)
      const codes = new Set();
      for (const r of live) for (const e of r.syn.events) if (e.source === "qr" && e.qrCode && !lookupCache.has(e.qrCode)) codes.add(e.qrCode);
      done = 0;
      await pool([...codes], 3, async (c) => {
        lookupCache.set(c, await E.lookupCode(RFID, (url) => deps.nwFetch("GET", url.slice(deps.nwBase.length), {}), deps.nwBase, c, CORE.looksLikeUid));
        progress({ phase: "uids", done: ++done, total: codes.size });
      });
      // 4. Lượt 1 → danh sách EPC → lượng tem
      const epcs = new Set();
      for (const r of live) {
        r.events = E.applyLookups(CORE, r.syn.events, lookupCache, now);
        const pre = E.previewOrder(CORE, { ord: r.ord, events: r.events, evidence: {}, posActionDiag: r.syn.posActionDiag });
        r.epcs = pre.epcs;
        pre.epcs.forEach((x) => epcs.add(x));
      }
      const evidence = {};
      done = 0;
      await pool([...epcs], 3, async (epc) => {
        const res = await deps.nwFetch("GET", "/integrations/circa/epcs/" + encodeURIComponent(epc), {});
        evidence[epc] = Object.assign({}, res.transport ? { ok: false, reason: res.transport } : CORE.parseNotifyEpcHolding(res.status, res.json, epc), { checkedAt: deps.now() });
        progress({ phase: "holdings", done: ++done, total: epcs.size });
      });
      // 5. Lượt 2 theo giờ hoàn tất, cộng dồn EPC giữa các đơn của lượt
      const allocated = new Map();
      const ordered = live.slice().sort((a, b) => String(a.completedDate || "").localeCompare(String(b.completedDate || "")) || String(a.code).localeCompare(String(b.code)));
      for (const r of ordered) {
        const ev = {};
        for (const e of r.epcs) ev[e] = evidence[e];
        const sendable = !E.isBlocked(r.code, deps.blocklist) && r.nwStatus === 404 && !(r.record && STARTED.indexOf(r.record.state) >= 0);
        r.preview = E.previewOrder(CORE, { ord: r.ord, events: r.events, evidence: ev, posActionDiag: r.syn.posActionDiag, allocated: sendable ? allocated : null });
        const v = E.orderVerdict(r.code, deps.blocklist, r.nwStatus, r.preview);
        r.verdict = v.verdict;
        r.reason = v.reason;
        if (r.record && STARTED.indexOf(r.record.state) >= 0) {
          r.verdict = r.record.state === "confirmed" ? "sent" : "sent_" + r.record.state;
          r.reason = "local_record";
        }
        r.summary = lineSummary(r.preview);
        if (r.verdict === "ready") {
          r.payload = r.preview.payload;
          r.payloadJson = r.preview.payloadJson;
          r.hash = await deps.sha256(r.payloadJson);
          r.units = r.payload.tags.reduce((a, t) => a + t.quantity, 0);
          for (const t of r.payload.tags) allocated.set(t.epc, (allocated.get(t.epc) || 0) + t.quantity);
        }
      }
      return results;
    }

    // ---- Gửi MỘT đơn ready (gọi tuần tự). Ghi bền "submitting" TRƯỚC POST; không bao giờ gửi body khác cho cùng DHC. ----
    async function send(r) {
      if (!r || r.verdict !== "ready" || !r.payloadJson) return { state: "skipped", reason: "not_ready" };
      if (E.isBlocked(r.code, deps.blocklist)) return { state: "skipped", reason: "blocklist" };
      const prev = await deps.storeGet(REC + r.code);
      if (prev && STARTED.indexOf(prev.state) >= 0) return { state: "skipped", reason: "already_" + prev.state };
      // a. Nextwaves vẫn chưa có đơn (Agent có thể vừa gửi)
      const n = await nwOrder(r.code);
      if (n.status === 200) return { state: "on_nextwaves", reason: "order_exists_before_post" };
      if (n.status !== 404) return { state: "stopped", reason: n.transport ? "transport:" + n.transport : "nextwaves_order_http_" + n.status };
      // b. Tra lại lượng MỌI EPC của đơn và dựng lại: payload phải trùng từng byte với bản đã kiểm tra
      const ev = {};
      for (const epc of r.epcs || []) {
        const res = await deps.nwFetch("GET", "/integrations/circa/epcs/" + encodeURIComponent(epc), {});
        if (res.transport) return { state: "stopped", reason: "transport:" + res.transport };
        ev[epc] = CORE.parseNotifyEpcHolding(res.status, res.json, epc);
      }
      const pv = E.previewOrder(CORE, { ord: r.ord, events: r.events, evidence: ev, posActionDiag: r.syn.posActionDiag });
      if (pv.state !== "prepared" || pv.payloadJson !== r.payloadJson) return { state: "changed", reason: pv.state !== "prepared" ? (pv.reasons[0] || {}).code || "not_prepared" : "payload_changed" };
      const hash = await deps.sha256(pv.payloadJson);
      if (hash !== r.hash) return { state: "changed", reason: "hash_changed" };
      const idempotencyKey = CORE.notifyIdempotencyKey({ payload: pv.payload, orderCode: pv.orderCode });
      if (!idempotencyKey) return { state: "skipped", reason: "no_idempotency_key" };
      // c. Ghi bền trước khi POST
      const startedAt = deps.now();
      const rec = { code: r.code, orderId: r.orderId, state: "submitting", payloadJson: pv.payloadJson, payloadHash: hash, idempotencyKey, apiBase: deps.nwBase, startedAt, tool: "circa-backfill" };
      await deps.storeSet(REC + r.code, rec);
      // d. POST nguyên văn chuỗi đã băm
      let res;
      try {
        res = await deps.nwFetch("POST", NOTIFY_PATH, { bodyText: pv.payloadJson, idempotencyKey, timeoutMs: NOTIFY_TIMEOUT_MS });
      } catch (e) {
        res = { transport: "exception" };
      }
      const verdict = CORE.notifyVerdict(res, pv.payload);
      const doneRec = Object.assign({}, rec, { state: verdict.state, reason: verdict.reason, result: verdict.result, finishedAt: deps.now() });
      // e. Đối soát: đơn trên Nextwaves phải có đúng các EPC + lượng đã gửi
      if (verdict.state === "confirmed") {
        const chk = await nwOrder(r.code);
        if (chk.status === 200 && chk.json) {
          const want = pv.payload.tags.map((t) => t.epc + ":" + t.quantity).sort().join(",");
          const got = (chk.json.items || []).filter((i) => i.tagEpc).map((i) => String(i.tagEpc).toUpperCase() + ":" + i.baseQuantity).sort().join(",");
          doneRec.reconcile = want === got ? "match" : "mismatch";
          if (want !== got) doneRec.reconcileDetail = { want, got };
        } else doneRec.reconcile = "order_not_found_after_post:" + chk.status;
      }
      await deps.storeSet(REC + r.code, doneRec);
      const stop = verdict.state !== "confirmed";
      return { state: verdict.state, reason: verdict.reason, record: doneRec, stop };
    }

    // Lần mở công cụ: bản ghi còn "submitting" (trang đóng giữa lúc POST) → ambiguous, không tự gửi lại.
    async function recover(keys) {
      const fixed = [];
      for (const k of keys || []) {
        if (k.indexOf(REC) !== 0) continue;
        const v = await deps.storeGet(k);
        if (v && v.state === "submitting") {
          await deps.storeSet(k, Object.assign({}, v, { state: "ambiguous", reason: "page_closed_during_post", finishedAt: deps.now() }));
          fixed.push(v.code);
        }
      }
      return fixed;
    }

    // Đơn "không rõ": hỏi Nextwaves. 200 → đã trừ (đánh dấu); 404 → cho phép gửi lại ĐÚNG chuỗi + key cũ (người bấm).
    async function resolveAmbiguous(code, allowResend) {
      const rec = await deps.storeGet(REC + code);
      if (!rec || rec.state !== "ambiguous") return { state: "skipped", reason: "not_ambiguous" };
      const n = await nwOrder(code);
      if (n.status === 200) {
        const next = Object.assign({}, rec, { state: "confirmed", reason: "resolved_by_get", finishedAt: deps.now() });
        await deps.storeSet(REC + code, next);
        return { state: "confirmed", reason: "resolved_by_get" };
      }
      if (n.status !== 404) return { state: "stopped", reason: "nextwaves_order_http_" + n.status };
      if (!allowResend) return { state: "resendable", reason: "order_not_found" };
      if ((await deps.sha256(rec.payloadJson)) !== rec.payloadHash) return { state: "stopped", reason: "frozen_hash_mismatch" };
      if (rec.apiBase !== deps.nwBase) return { state: "stopped", reason: "tenant_changed" };
      await deps.storeSet(REC + code, Object.assign({}, rec, { state: "submitting", resendAt: deps.now() }));
      let res;
      try {
        res = await deps.nwFetch("POST", NOTIFY_PATH, { bodyText: rec.payloadJson, idempotencyKey: rec.idempotencyKey, timeoutMs: NOTIFY_TIMEOUT_MS });
      } catch (e) {
        res = { transport: "exception" };
      }
      const verdict = CORE.notifyVerdict(res, JSON.parse(rec.payloadJson));
      const next = Object.assign({}, rec, { state: verdict.state, reason: verdict.reason, result: verdict.result, finishedAt: deps.now(), resent: (rec.resent || 0) + 1 });
      await deps.storeSet(REC + code, next);
      return { state: verdict.state, reason: verdict.reason };
    }

    return { check, send, recover, resolveAmbiguous };
  }

  return { parseInput, createRunner, REC_PREFIX: REC, NOTIFY_PATH };
});
