// MÔ PHỎNG Circa cho test / dry-run: response của POST /v1/inventory/count/submit-rfid-batch và lượt quét đã lưu
// (GET /v1/inventory/count/sessions/<id>/scans). OFFLINE: không gọi mạng, không đọc/ghi file.
// KHÔNG dùng kết quả mô phỏng thay cho response / lượt quét thật. Test dùng sim chỉ để kiểm ĐƯỜNG ỐNG (chia lô → kiểm
// response → đối soát), không phải để kiểm số Circa sẽ ghi.
//
// ĐÃ THỬ THẬT (phiên thử ICS00240, 21/11/2026, records/pos-writes/20261121-ICS00240-thu-*):
//   - mã trong `tags` (gửi thô) → resolved {product_id của mã, unit_name = đơn vị của mã, quantity 1, base_quantity = quy đổi}
//   - `items` {tag, unit_name: đơn vị gốc, quantity: n} → base n (1794655730924B91 "miếng" 8 → 8)
//   - `items` với đơn vị KHÁC gốc {unit_name:"gói", quantity:1} → base = 1 × quy đổi gói = 8 (đúng 1 lần thử)
//   - mã Circa không nhận (qr-lookup 404, thẻ lạ) → unknown_tags
//   - gửi lại nguyên lô đã ghi → inserted 0, duplicates = số mã, resolved_tags vẫn liệt kê các mã đó
//   - body chỉ có `tags` (không có khoá `items`) và body có cả hai: chấp nhận
// GIẢ ĐỊNH CHƯA THỬ THẬT (sim cứ làm vậy; số thật có thể khác):
//   - mã trùng (đã ghi trước) → resolved_tags trả SỐ ĐÃ LƯU của lần ghi đầu, không tính lại từ request mới
//     (lần thử thật chỉ gửi lại đúng payload cũ nên không phân biệt được hai cách)
//   - `items` có unit_name không có trong retail_units → rejected_tags {code:"SIM_UNIT_NOT_FOUND"}
//   - body chỉ có `items` (không có khoá `tags`), lô đủ 100 mã: chấp nhận như lô nhỏ
//   - lượt quét đã lưu: 1 lượt / mã đã ghi, trường {qr_code, product_id, scanned_qty, unit_code (tên đơn vị),
//     conversion_factor, base_qty, device_id} lấy từ lần ghi đầu
//
// Dùng: const sim = require("./sim.js");
//   const S = sim.session([scans có sẵn]);        // một phiên Circa giả (nhớ mã đã ghi)
//   S.submit(body, lookups, {raw})              → data giống response.data
//       raw = true: coi mọi phần tử (cả items) là gửi thô — để chứng minh checkResponse/checkScans bắt được sai-so
//   S.scans()                                   → mảng lượt quét đã lưu (giống …/scans)
//   S.add(scan)                                 → thêm 1 lượt quét "đếm tay" (cùng chống trùng theo mã như submit):
//       mã đã có → bỏ qua, trả false (gửi lại mã đó sau này → duplicates, không thêm lượt thứ hai)
//   sim.respond(body, lookups, opts)            → submit trên một phiên mới (tiện cho 1 lô)
"use strict";
const NWC = require("./core.js");

function lk(lookups, code) {
  const k = NWC._codeKey(code);
  if (lookups instanceof Map) { for (const [c, v] of lookups) if (NWC._codeKey(c) === k && v) return v; return null; }
  for (const c of Object.keys(lookups || {})) if (NWC._codeKey(c) === k && lookups[c]) return lookups[c];
  return null;
}
function rateOf(d, unit) {
  const u = (d.retail_units || []).find(r => NWC._norm(r.unit) === NWC._norm(unit));
  return u ? u.convert_rate : null;
}

// init (tuỳ chọn): lượt quét đã có sẵn trong phiên (vd 12 lượt thật của ICS00240) → coi như đã ghi.
function session(init) {
  const stored = new Map(); // CODE viết hoa → {resolved, scan}
  (init || []).forEach(s => {
    stored.set(NWC._codeKey(s.qr_code), {
      resolved: { tag: s.qr_code, product_id: s.product_id, unit_name: s.unit_code, quantity: s.scanned_qty, base_quantity: s.base_qty },
      scan: Object.assign({}, s)
    });
  });
  function submit(body, lookups, opts) {
    opts = opts || {};
    const out = { inserted: 0, duplicates: 0, unknown_tags: [], resolved_tags: [], rejected_tags: [] };
    const entries = (body.tags || []).map(t => ({ tag: t, raw: true }))
      .concat((body.items || []).map(x => ({ tag: x.tag, unit_name: x.unit_name, quantity: x.quantity, raw: !!opts.raw })));
    for (const e of entries) {
      const k = NWC._codeKey(e.tag);
      if (stored.has(k)) { out.resolved_tags.push(Object.assign({}, stored.get(k).resolved, { tag: e.tag })); out.duplicates++; continue; }
      const d = lk(lookups, e.tag);
      if (!d) { out.unknown_tags.push(e.tag); continue; }
      let unit, qty, rate;
      if (e.raw) { unit = d.unit_name; qty = 1; rate = rateOf(d, d.unit_name); }
      else {
        rate = rateOf(d, e.unit_name);
        if (rate == null) { out.rejected_tags.push({ tag: e.tag, code: "SIM_UNIT_NOT_FOUND", message: "unit " + e.unit_name }); continue; }
        unit = e.unit_name; qty = e.quantity;
      }
      const resolved = { tag: e.tag, product_id: d.product_id, sku_code: d.sku_code, lot_id: d.lot, lot_date: d.lot_date, unit_name: unit, quantity: qty, base_quantity: qty * rate };
      const scan = { qr_code: e.tag, product_id: d.product_id, scanned_qty: qty, unit_code: unit, conversion_factor: rate, base_qty: qty * rate, device_id: body.device_id };
      stored.set(k, { resolved, scan });
      out.resolved_tags.push(resolved);
      out.inserted++;
    }
    return out;
  }
  function add(s) {
    const k = NWC._codeKey(s && s.qr_code);
    if (!k || stored.has(k)) return false;
    stored.set(k, {
      resolved: { tag: s.qr_code, product_id: s.product_id, unit_name: s.unit_code, quantity: s.scanned_qty, base_quantity: s.base_qty },
      scan: Object.assign({}, s)
    });
    return true;
  }
  return { submit, add, scans: () => [...stored.values()].map(x => Object.assign({}, x.scan)) };
}

function respond(body, lookups, opts) { return session().submit(body, lookups, opts); }

module.exports = { session, respond };
