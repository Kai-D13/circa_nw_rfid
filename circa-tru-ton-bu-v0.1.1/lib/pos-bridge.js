// pos-bridge.js — đọc đơn POS v2 bằng phiên đăng nhập của tab pos.v2.circa.vn. Hàm bfPosFetch được chrome.scripting.executeScript
// chạy trong trang (world MAIN): trang tự gắn cookie; extension không đọc, không lưu token. Chỉ trả trường cần cho core.js (không có
// thông tin khách hàng). Chỉ có lệnh GET.
(function (root) {
  "use strict";

  // CHẠY TRONG TRANG POS — tự chứa, không dùng biến bên ngoài.
  async function bfPosFetch(orderId, storeId) {
    const tok = (document.cookie.match(/(?:^|; )session_token=([^;]+)/) || [])[1];
    if (!tok) return { status: 401, error: "no_pos_session" };
    const H = { authorization: "Bearer " + decodeURIComponent(tok), "x-store-id": storeId, "x-client-id": "1", "grpc-timeout": "30S", "accept-language": "vi-VN" };
    const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
    const get = async (url) => {
      for (let t = 0; t < 3; t++) {
        try {
          const r = await fetch(url, { headers: H, cache: "no-store" });
          if (r.status === 429 || r.status >= 500) {
            await sleep(1500 * (t + 1));
            continue;
          }
          return { status: r.status, json: await r.json().catch(() => null) };
        } catch (e) {
          await sleep(1500 * (t + 1));
        }
      }
      return { status: 0, json: null };
    };
    const API = "https://api.v2.circa.vn/v1";
    const o = await get(API + "/order/" + encodeURIComponent(orderId) + "?get_rating=true");
    if (o.status !== 200 || !o.json || !o.json.data || !o.json.data.order) return { status: o.status || 0, error: "pos_order_http_" + o.status };
    const src = o.json.data.order;
    const order = {};
    for (const k of ["id", "code", "status", "type", "pos_id", "payment_status", "payment_method", "is_payment_success", "completed_date", "created_date", "updated_date", "status_updated_at"]) order[k] = src[k];
    const flat = (v) => v === null || typeof v !== "object" || (Array.isArray(v) && v.every((x) => x === null || typeof x !== "object"));
    order.items = (Array.isArray(src.items) ? src.items : []).map((it) => {
      const x = {};
      for (const [k, v] of Object.entries(it || {})) if (flat(v)) x[k] = v;
      const p = (it && it.product) || {};
      x.product = {
        name: p.name,
        code: p.code,
        sku_code: p.sku_code,
        retail_units: (Array.isArray(p.retail_units) ? p.retail_units : []).map((u) => ({ id: u && u.id, unit: u && u.unit, convert_rate: u && u.convert_rate, base_unit: u && u.base_unit })),
      };
      return x;
    });
    const log = [];
    let page = 1;
    let total = 0;
    let logStatus = 200;
    do {
      const l = await get(API + "/activity-log/SALE_ORDER/" + encodeURIComponent(orderId) + "?limit=100&page=" + page);
      if (l.status !== 200 || !l.json || !l.json.data) {
        logStatus = l.status || 0;
        break;
      }
      for (const a of l.json.data.list || []) log.push({ id: a.id, action: a.action, status: a.status, created_at: a.created_at, detail: a.detail ? { args: a.detail.args } : null, metadata: a.metadata || {} });
      total = l.json.data.total || 0;
      page++;
    } while (log.length < total && page < 50);
    return { status: 200, json: { success: true, data: { order } }, log, logStatus };
  }

  const POS_URL = "https://pos.v2.circa.vn/*";

  async function findPosTab() {
    const tabs = await chrome.tabs.query({ url: POS_URL });
    return tabs.find((t) => t.active) || tabs[0] || null;
  }

  async function posFetchOrder(tabId, orderId, storeId) {
    const [inj] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: bfPosFetch, args: [orderId, storeId] });
    return inj && inj.result ? inj.result : { status: 0, error: "inject_failed" };
  }

  root.__CIRCA_BACKFILL_POS__ = { bfPosFetch, findPosTab, posFetchOrder, POS_URL };
})(typeof self !== "undefined" ? self : this);
