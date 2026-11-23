// MÁY CHỦ GIẢ cho extension "Kiểm kê Circa ↔ NW" v0.2.1 (bản thử, build/kiem-ke-circa-nw-ext-test). Chỉ chạy trên 127.0.0.1, 4 cổng liên tiếp:
//   P   trang admin Circa giả: chỉ đặt cookie session_token giả (extension đọc token Circa từ tab này, không chạy script nào khác ở đây)
//   P+1 API Circa giả          = mock-server.js (dùng lại nguyên; có danh sách phiên GET /v1/inventory/count/sessions, data.list; lượt quét có id,
//       mới nhất trước, mỗi lô chung một scanned_at, có offset thì thứ tự trong nhóm cùng scanned_at xáo mỗi request như Circa thật;
//       GET …/summary; cấu hình dựng ca đọc lượt quét: serverCap, insertBetween, scansDup, noHasMore / hasMoreAs, padScans, summaryOff,
//       dropId … — xem đầu mock-server.js)
//   P+2 web NW giả             (mọi đường dẫn): ghi localStorage["auth-storage"] = {state:{accessToken:<JWT giả>}}; ?logout=1 → xoá.
//       Có nút #go-list / #go-detail / #go-home đổi đường dẫn kiểu SPA (history.pushState) để thử nút "Gửi sang Circa".
//   P+3 API NW giả             (/api/v1/…): warehouses, stock/reconciliations (danh sách, chi tiết, export xlsx theo từng phiên).
//       Dạng response theo dữ liệu NW thật PM đọc 22/11: warehouses = mảng phẳng ở gốc (parentId, children, locationType, closedAt);
//       danh sách phiên {data,total,page,limit,totalPages}; phiên {id, warehouseId, warehouse, status, scopeType, notes, createdAt}.
//       nw.cfg: warehouses, whShape, nw401, exportFail, noTotalPages, metaTotalPages. Không có lệnh ghi nào (POST → 404, được ghi log).
//       CORS chỉ cho origin web NW giả (như NW thật); request từ service worker extension không bị CORS chặn.
// Không gọi mạng ngoài, không dùng token thật (token sinh ngẫu nhiên mỗi lần chạy). Dữ liệu thử là GIẢ, không có dữ liệu thật.
//
// Dùng tay:  node tools/nw-sang-circa/mock-ext-server.js [cổngP]   → build bản thử cùng cổng: node tools/nw-sang-circa/build-ext.js --port <P> --only test
// Trong Node (test-ext-ui.js):
//   const X = require("./mock-ext-server.js"); const m = await X.start({ basePort });
//   m.urls {admin, circaApi, nwApp, nwApi} · m.circa (srv của mock-server.js) · m.nw {cfg, log, recs, addRec(o), setExport(id, buf), reset()} · m.tokens · await m.close()
//   X.exportXlsx(XLSX, spec) → Buffer file xuất phiên kiểm kê NW giả · X.scenario(XLSX) → bộ dữ liệu thử 2 phiên NW
"use strict";
const http = require("http"), crypto = require("crypto"), path = require("path"), net = require("net");
const M = require("./mock-server.js");

const LUMINA = "31493e74-3404-4c0e-a906-93691a6ee319";
const FLORITA = "c476efb2-415c-429a-978e-d389b4b06607";
const WH = {
  lumina: "a1a1a1a1-0000-4000-8000-000000000001", florita: "a1a1a1a1-0000-4000-8000-000000000002",
  transit: "a1a1a1a1-0000-4000-8000-000000000003", closed: "a1a1a1a1-0000-4000-8000-000000000004", accent: "a1a1a1a1-0000-4000-8000-000000000005",
  tamviet: "a1a1a1a1-0000-4000-8000-000000000006", child: "a1a1a1a1-0000-4000-8000-000000000007"
};
function wh(id, name, code, type, closedAt, parentId, children) {
  return { id, name, code, locationType: type, parentId: parentId || null, children: children || [], closedAt: closedAt || null, createdAt: "2026-01-01T00:00:00.000Z" };
}
// tên kho thật hiện tại: "CIRCA LUMINA", "CIRCA FLORITA", "CIRCA TAM VIET", "In transit". Thêm 2 kho thử (đã đóng, tên lệch dấu). id GIẢ.
function defaultWarehouses() {
  return [
    wh(WH.lumina, "CIRCA LUMINA", "WH-LUM", "warehouse"),
    wh(WH.florita, "CIRCA FLORITA", "WH-FLO", "warehouse"),
    wh(WH.tamviet, "CIRCA TAM VIET", "WH-TV", "warehouse"),
    wh(WH.transit, "In transit", "TRANSIT", "transit"),
    wh(WH.closed, "circa lumina", "OLD", "warehouse", "2026-01-01T00:00:00.000Z"),
    wh(WH.accent, "CIRCA LUMÍNA", "ACC", "warehouse")
  ];
}
function nestedWarehouses(childName, alsoAtRoot) {
  const list = defaultWarehouses();
  const child = wh(WH.child, childName, "WH-CHILD", "warehouse", null, WH.tamviet);
  list.find(x => x.id === WH.tamviet).children = [child];
  if (alsoAtRoot) list.push(Object.assign({}, child, { children: [] }));
  return list;
}
const b64u = s => Buffer.from(s).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
function fakeJwt(expSec) { return b64u(JSON.stringify({ alg: "HS256", typ: "JWT" })) + "." + b64u(JSON.stringify({ sub: "nguoi-thu", exp: expSec })) + "." + crypto.randomBytes(16).toString("hex"); }

// ---------- file xuất phiên kiểm kê NW GIẢ ----------
// spec: {products:[{pid, name, unit, status?="Khớp", ton?, daDem? (mặc định tổng SL thẻ), thuCong?=0, tags:[{epc, uid, qty, time}]}], strange:[epc], kho}
// Số trong file là CHUỖI như file thật; "Tồn hệ thống" ≥ 1000 viết có dấu chấm ngăn nghìn như file thật.
function exportXlsx(XLSX, spec) {
  const ds = [], ct = [];
  const th = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  for (const p of spec.products) {
    const sum = (p.tags || []).reduce((a, t) => a + t.qty, 0);
    const daDem = p.daDem == null ? sum : p.daDem, thuCong = p.thuCong || 0, ton = p.ton == null ? daDem : p.ton;
    ds.push({ "Mã SP": "CIRCA-" + p.pid, "Tên sản phẩm": p.name, "Biến thể": "", "SKU": "", "ĐVT": p.unit, "Tồn hệ thống": th(ton), "Đã đếm": String(daDem), "RFID": String(daDem - thuCong),
      "Thủ công": String(thuCong), "Còn thiếu": String(Math.max(0, ton - daDem)), "Thừa": String(Math.max(0, daDem - ton)), "Trạng thái": p.status || "Khớp", "Vị trí": "", "EPC chưa quét (có thể thiếu)": "", "EPC thừa": "" });
    for (const t of p.tags || []) {
      ct.push({ "Mã SP": "CIRCA-" + p.pid, "Tên sản phẩm": p.name, "Biến thể": "", "SKU": "", "EPC": t.epc, "UID": t.uid || "", "Số lượng thẻ": String(t.qty), "Thực tế nhập": t.thucTe || "", "ĐVT": t.unit || p.unit,
        "Lô": "", "Hạn dùng": "", "Vị trí": "", "Lần quét cuối": t.time || "22/11/2026 10:00:00", "Trạng thái": t.status || "Đã quét" });
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ds, { header: ["Mã SP", "Tên sản phẩm", "Biến thể", "SKU", "ĐVT", "Tồn hệ thống", "Đã đếm", "RFID", "Thủ công", "Còn thiếu", "Thừa", "Trạng thái", "Vị trí", "EPC chưa quét (có thể thiếu)", "EPC thừa"] }), "Danh sách kiểm kê");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ct, { header: ["Mã SP", "Tên sản phẩm", "Biến thể", "SKU", "EPC", "UID", "Số lượng thẻ", "Thực tế nhập", "ĐVT", "Lô", "Hạn dùng", "Vị trí", "Lần quét cuối", "Trạng thái"] }), "Chi tiết quét");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["EPC", "Lý do"]].concat((spec.strange || []).map(e => [e, "Chưa đăng ký"]))), "Thẻ lạ");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Chỉ tiêu", "Giá trị"], ["Kho", spec.kho || "Lumina"], ["Trạng thái", "Đang kiểm"]]), "Tổng quan");
  return Buffer.from(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

// ---------- bộ dữ liệu thử: 2 phiên NW Lumina (R1 cũ hơn, R2 mới hơn) ----------
// SP (id GIẢ 9000xx):
//   01 A vỉ 10 viên: Khớp R1, 3 thẻ × 10 viên, gửi thô                    02 B chai: Khớp ở CẢ 2 phiên, thẻ KHÁC nhau → chỉ thẻ R2 (quét muộn hơn)
//   03 C chai: Khớp ở 2 phiên, CÙNG 1 thẻ → gửi 1 lần (lấy R2)            04 D: Khớp nhờ đếm thủ công (R1) → để riêng
//   05 E: Thiếu (R2) → không gửi                                          06 F cái: Khớp R2, bulk thẻ (mặc định 150 → 2 lô)
//   07 G gói lệch quy đổi (hộp 10 gói, thẻ 8 gói): Khớp R1 → gửi kèm đơn vị    08 H: Khớp R2, 1 thẻ Circa không nhận → để riêng CẢ SP
//   09 I: Khớp R1 nhưng tổng thẻ ≠ Đã đếm → để riêng                      10 J: Khớp R2; phiên Circa đã có lượt quét QR khác của SP → để riêng
//   11 K: Khớp R2 (3 thẻ); phiên Circa đã có lượt của 1 thẻ ta → chỉ gửi 2 thẻ còn thiếu
// → {r1, r2 (Buffer), lookups:[[code, data|null]], send:[mã sẽ gửi], sendBase, skipR1B:[mã thẻ B ở R1], b2:[mã thẻ B ở R2], existing:{foreign, mine}}
function scenario(XLSX, opt) {
  opt = opt || {};
  const nBulk = opt.bulk == null ? 150 : opt.bulk;
  const U = (unit, rate, base) => ({ unit, convert_rate: rate, base_unit: !!base });
  const D = (pid, name, unitName, units) => ({ product_id: pid, product_name: name, sku_code: "SKU-GIA-" + pid, seller_code: "CIRCA", unit_name: unitName, retail_units: units, lot: "LOT-GIA", lot_date: "LOT-GIA-010127", po_code: "PO-GIA" });
  const lookups = [];
  let seq = 0;
  // thẻ: Circa nhận EPC (UID 404), hoặc viaUid (thẻ E280: UID nhận, EPC 404), hoặc unknown (cả 2 404)
  function tag(d, qty, time, o) {
    o = o || {};
    seq++;
    const epc = o.epc || (o.viaUid ? "E280" + String(seq).padStart(20, "0") : "AB" + String(seq).padStart(22, "0"));
    const uid = o.uid != null ? o.uid : "17000000" + String(seq).padStart(5, "0") + "T" + seq;
    if (!o.noLookup) {
      if (o.viaUid) { lookups.push([uid, d]); lookups.push([epc, null]); }
      else if (o.unknown) { lookups.push([uid, null]); lookups.push([epc, null]); }
      else { lookups.push([uid, null]); lookups.push([epc, d]); }
    }
    return { epc, uid, qty, time: time || "22/11/2026 10:00:00", code: o.unknown ? null : o.viaUid ? uid : epc };
  }
  const T1 = "22/11/2026 09:10:00", T2 = "22/11/2026 10:20:00";
  const dA = D(900001, "SP thử A (vỉ 10 viên)", "vỉ", [U("viên", 1, true), U("vỉ", 10), U("hộp", 100)]);
  const dB = D(900002, "SP thử B (chai)", "chai", [U("chai", 1, true)]);
  const dC = D(900003, "SP thử C (chai)", "chai", [U("chai", 1, true)]);
  const dD = D(900004, "SP thử D (đếm tay)", "cái", [U("cái", 1, true)]);
  const dE = D(900005, "SP thử E (thiếu)", "cái", [U("cái", 1, true)]);
  const dF = D(900006, "SP thử F (cái)", "cái", [U("cái", 1, true)]);
  const dG = D(900007, "SP thử G (gói lệch quy đổi)", "hộp", [U("gói", 1, true), U("hộp", 10)]);
  const dH = D(900008, "SP thử H (1 thẻ Circa không nhận)", "cái", [U("cái", 1, true)]);
  const dI = D(900009, "SP thử I (tổng thẻ ≠ Đã đếm)", "cái", [U("cái", 1, true)]);
  const dJ = D(900010, "SP thử J (phiên Circa đã có QR khác)", "cái", [U("cái", 1, true)]);
  const dK = D(900011, "SP thử K (đã có 1 thẻ trong phiên Circa)", "cái", [U("cái", 1, true)]);
  const P = (d, unit, tags, x) => Object.assign({ pid: d.product_id, name: d.product_name, unit, tags }, x || {});
  const a = [tag(dA, 10, T1), tag(dA, 10, T1), tag(dA, 10, T1)];
  const b1 = [tag(dB, 1, T1), tag(dB, 1, T1, { viaUid: true })], b2 = [tag(dB, 1, T2), tag(dB, 1, T2)];
  const c = tag(dC, 1, T1);
  const d = [tag(dD, 1, T1)];
  const e = [tag(dE, 1, T2)];
  const f = []; for (let i = 0; i < nBulk; i++) f.push(tag(dF, 1, T2));
  const g = [tag(dG, 8, T1)];
  const hh = [tag(dH, 1, T2), tag(dH, 1, T2, { unknown: true })];
  const ii = [tag(dI, 1, T1)];
  const j = [tag(dJ, 1, T2)];
  const k = [tag(dK, 1, T2), tag(dK, 1, T2), tag(dK, 1, T2)];
  const r1 = exportXlsx(XLSX, { products: [P(dA, "viên", a), P(dB, "chai", b1), P(dC, "chai", [c]), P(dD, "cái", d, { daDem: 3, thuCong: 2 }), P(dG, "gói", g), P(dI, "cái", ii, { daDem: 2 })], strange: ["CD" + "0".repeat(21) + "1"] });
  const r2 = exportXlsx(XLSX, { products: [P(dB, "chai", b2), P(dC, "chai", [Object.assign({}, c, { time: "22/11/2026 09:30:00" })]), P(dE, "cái", e, { status: "Thiếu", ton: 3 }), P(dF, "cái", f),
    P(dH, "cái", hh), P(dJ, "cái", j), P(dK, "cái", k)] });
  const send = [].concat(a, b2, [c], f, g, k.slice(1)).map(t => t.code);
  return {
    r1, r2, lookups, send, sendBase: 30 + 2 + 1 + nBulk + 8 + 2, skipR1B: b1.map(t => t.code), b2: b2.map(t => t.code), notSent: [].concat(d, hh, ii, j, e, [k[0]]).map(t => t.code).filter(Boolean),
    sendSp: [900001, 900002, 900003, 900006, 900007, 900011], aside: { 900004: "thu-cong", 900008: "the-khong-gui", 900009: "khong-nhat-quan", 900010: "luot-khac" },
    existing: {
      foreign: { qr_code: "1799999999999Q1", product_id: 900010, scanned_qty: 1, unit_code: "cái", conversion_factor: 1, base_qty: 1, device_id: "PDA-QR" },
      mine: { qr_code: k[0].code, product_id: 900011, scanned_qty: 1, unit_code: "cái", conversion_factor: 1, base_qty: 1, device_id: "NW-RFID" }
    }
  };
}

// ---------- tiện ích ----------
function freePort(p) {
  return new Promise(res => { const s = net.createServer(); s.once("error", () => res(false)); s.listen(p, "127.0.0.1", () => s.close(() => res(true))); });
}
async function findBase(want) {
  if (want) { for (let i = 0; i < 4; i++) if (!(await freePort(want + i))) throw new Error("cổng " + (want + i) + " đang bận"); return want; }
  for (let k = 0; k < 40; k++) {
    const b = 41000 + Math.floor(Math.random() * 18000);
    let ok = true;
    for (let i = 0; i < 4 && ok; i++) ok = await freePort(b + i);
    if (ok) return b;
  }
  throw new Error("không tìm được 4 cổng trống liên tiếp");
}
function listen(handler, port) {
  return new Promise((res, rej) => { const s = http.createServer(handler); s.once("error", rej); s.listen(port, "127.0.0.1", () => res(s)); });
}
function closeSrv(s) { return new Promise(r => { s.closeAllConnections && s.closeAllConnections(); s.close(() => r()); }); }

// ---------- trang admin giả: chỉ đặt cookie ----------
function adminHtml(ctoken) {
  return "<!doctype html><html lang=\"vi\"><head><meta charset=\"utf-8\"><title>Admin Circa (giả)</title></head><body>" +
    "<h1>Admin Circa (GIẢ — kiểm thử extension)</h1><p>Đã đăng nhập (cookie giả).</p><script>document.cookie='session_token=" + ctoken + "; path=/';</script></body></html>";
}
function nwHtml(ntoken) {
  return "<!doctype html><html lang=\"vi\"><head><meta charset=\"utf-8\"><title>NW (giả)</title></head><body><h1>Nextwaves (GIẢ — kiểm thử extension)</h1><p id=\"st\"></p>" +
    "<p><button id=\"go-list\">Đối chiếu</button> <button id=\"go-detail\">Chi tiết phiên</button> <button id=\"go-home\">Trang chủ</button></p><script>(function(){\n" +
    "var q=new URLSearchParams(location.search);\n" +
    "if(q.get('logout')){localStorage.removeItem('auth-storage');document.getElementById('st').textContent='đã đăng xuất';}\n" +
    "else{localStorage.setItem('auth-storage',JSON.stringify({state:{accessToken:" + JSON.stringify(ntoken) + ",user:{name:'Người thử'}},version:0}));document.getElementById('st').textContent='đã đăng nhập (giả)';}\n" +
    "function go(p){history.pushState({},'',p);}\n" +
    "document.getElementById('go-list').addEventListener('click',function(){go('/vi/stock/reconciliation');});\n" +
    "document.getElementById('go-detail').addEventListener('click',function(){go('/vi/stock/reconciliation/0f0f0f0f-0000-4000-8000-000000000000');});\n" +
    "document.getElementById('go-home').addEventListener('click',function(){go('/vi/dashboard');});\n" +
    "})();</script></body></html>";
}

// ---------- API NW giả ----------
function nwApi(origins, ntoken) {
  const nw = { cfg: {}, log: [], recs: [], exports: {} };
  nw.reset = () => { nw.cfg = {}; nw.log.length = 0; nw.recs.length = 0; nw.exports = {}; };
  nw.setExport = (id, buf) => { nw.exports[id] = buf; };
  nw.addRec = o => {
    o = o || {};
    const whs = nw.cfg.warehouses || defaultWarehouses();
    const w = whs.find(x => x.id === o.warehouseId) || { id: o.warehouseId, name: "?" };
    const r = { id: o.id || crypto.randomUUID(), status: o.status || "in_progress", scopeType: o.scopeType || "warehouse", notes: o.notes == null ? null : o.notes,
      warehouseId: w.id, warehouse: { id: w.id, name: w.name, code: w.code || null, locationType: w.locationType || "warehouse" }, totalEpcsScanned: 0, createdAt: o.createdAt || new Date().toISOString() };
    nw.recs.push(r);
    if (o.xlsx) nw.exports[r.id] = o.xlsx;
    return r;
  };
  const json = (res, st, obj, origin) => {
    const h = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
    if (origin === origins.nwApp) Object.assign(h, { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", "Vary": "Origin" });
    res.writeHead(st, h); res.end(JSON.stringify(obj));
  };
  const handler = (req, res) => {
    const u = new URL(req.url, "http://x"), p = u.pathname, origin = req.headers.origin || null;
    if (req.method === "OPTIONS") {
      nw.log.push({ t: Date.now(), method: "OPTIONS", path: p, origin });
      const h = {};
      if (origin === origins.nwApp) Object.assign(h, { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "authorization,content-type,accept", "Access-Control-Allow-Credentials": "true" });
      res.writeHead(204, h); return res.end();
    }
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      const auth = String(req.headers.authorization || "");
      const e = { t: Date.now(), method: req.method, path: p, query: Object.fromEntries(u.searchParams), origin, authOk: auth === "Bearer " + ntoken, accept: req.headers.accept || null, cookie: !!req.headers.cookie };
      if (body) { try { e.body = JSON.parse(body); } catch (x) { e.bodyRaw = body.slice(0, 300); } }
      nw.log.push(e);
      const send = (st, obj) => { e.status = st; json(res, st, obj, origin); };
      if (!e.authOk || nw.cfg.nw401) return send(401, { statusCode: 401, message: "Unauthorized (giả)" });
      const B = "/api/v1";
      let m;
      if (req.method === "GET" && p === B + "/warehouses") {
        const list = nw.cfg.warehouses || defaultWarehouses();
        return send(200, nw.cfg.whShape === "data" ? { data: list } : list);
      }
      if (req.method === "GET" && p === B + "/stock/reconciliations") {
        const page = Math.max(1, +u.searchParams.get("page") || 1), limit = Math.max(1, +u.searchParams.get("limit") || 25);
        const all = nw.recs.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        const tp = Math.max(1, Math.ceil(all.length / limit)), o = { data: all.slice((page - 1) * limit, page * limit), total: all.length, page, limit, totalPages: tp };
        if (nw.cfg.noTotalPages || nw.cfg.metaTotalPages) delete o.totalPages;
        if (nw.cfg.metaTotalPages) o.meta = { totalPages: tp, total: all.length };
        return send(200, o);
      }
      if (req.method === "GET" && (m = /^\/api\/v1\/stock\/reconciliations\/([0-9a-f-]{36})$/.exec(p))) {
        const r = nw.recs.find(x => x.id === m[1]);
        return r ? send(200, r) : send(404, { statusCode: 404, message: "Not Found (giả)" });
      }
      if (req.method === "GET" && (m = /^\/api\/v1\/stock\/reconciliations\/([0-9a-f-]{36})\/export$/.exec(p))) {
        const r = nw.recs.find(x => x.id === m[1]);
        if (!r) return send(404, { statusCode: 404, message: "Not Found (giả)" });
        if (nw.cfg.exportFail) return send(nw.cfg.exportFail, { statusCode: nw.cfg.exportFail, message: "lỗi xuất (giả)" });
        const q = e.query;
        if (q.format !== "xlsx" || q.scope !== "all" || q.includeEpcs !== "true" || q.locale !== "vi") return send(400, { statusCode: 400, message: "query export sai (giả)" });
        const buf = nw.exports[r.id];
        if (!buf) return send(404, { statusCode: 404, message: "chưa có dữ liệu xuất (giả)" });
        e.status = 200;
        const h = { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": "attachment; filename=\"kiem-ke-gia.xlsx\"" };
        if (origin === origins.nwApp) h["Access-Control-Allow-Origin"] = origin;
        res.writeHead(200, h); return res.end(buf);
      }
      return send(404, { statusCode: 404, message: "không có đường dẫn (giả): " + req.method + " " + p });
    });
  };
  return { nw, handler };
}

async function start(opts) {
  opts = opts || {};
  const base = await findBase(opts.basePort || 0);
  const urls = { admin: "http://127.0.0.1:" + base, circaApi: "http://127.0.0.1:" + (base + 1), nwApp: "http://127.0.0.1:" + (base + 2), nwApi: "http://127.0.0.1:" + (base + 3) };
  const tokens = { circa: "gia-circa-" + crypto.randomBytes(16).toString("hex"), nw: fakeJwt(Math.floor(Date.now() / 1000) + 3600) };
  const circa = await M.start({ port: base + 1 });
  circa.cfg = { token: tokens.circa, adminNoStore: true };
  const A = nwApi(urls, tokens.nw);
  const admin = await listen((req, res) => {
    const u = new URL(req.url, "http://x");
    if (req.method !== "GET" || u.pathname === "/favicon.ico") { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(adminHtml(tokens.circa));
  }, base);
  const nwApp = await listen((req, res) => {
    const u = new URL(req.url, "http://x");
    if (req.method !== "GET" || u.pathname === "/favicon.ico") { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(nwHtml(tokens.nw));
  }, base + 2);
  const nwSrv = await listen(A.handler, base + 3);
  return {
    base, urls, tokens, circa, nw: A.nw, WH,
    close: async () => { await Promise.all([circa.close(), closeSrv(admin), closeSrv(nwApp), closeSrv(nwSrv)]); }
  };
}

module.exports = { start, exportXlsx, scenario, defaultWarehouses, nestedWarehouses, WH, LUMINA, FLORITA, fakeJwt };

if (require.main === module) {
  const ROOT = path.resolve(__dirname, "..", "..");
  const { XLSX } = require(path.join(ROOT, ".claude/skills/circa-nextwaves-check/scripts/kiem-dem/load-tool.js"));
  start({ basePort: +process.argv[2] || 47900 }).then(m => {
    const sc = scenario(XLSX);
    for (const [c, d] of sc.lookups) m.circa.setLookup(c, d);
    const s = m.circa.addSession({ code: "ICS90001", pos_id: LUMINA });
    m.circa.addScan(s.id, sc.existing.foreign); m.circa.addScan(s.id, sc.existing.mine);
    m.nw.addRec({ warehouseId: WH.lumina, createdAt: new Date(Date.now() - 3600000).toISOString(), notes: "R1 (giả)", xlsx: sc.r1 });
    m.nw.addRec({ warehouseId: WH.lumina, createdAt: new Date().toISOString(), notes: "R2 (giả)", xlsx: sc.r2 });
    console.log("máy chủ giả (dữ liệu GIẢ):", JSON.stringify(m.urls));
    console.log("build bản thử cùng cổng: node tools/nw-sang-circa/build-ext.js --port " + m.base + " --only test");
    console.log("mở web NW giả:", m.urls.nwApp + "/vi/stock/reconciliation", "· trang admin giả (cookie):", m.urls.admin + "/");
  });
}
