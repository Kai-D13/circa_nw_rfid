// MÁY CHỦ GIẢ cho extension "Kiểm kê Circa ↔ NW" (bản thử, build/kiem-ke-circa-nw-ext-test). Chỉ chạy trên 127.0.0.1, 4 cổng liên tiếp:
//   P   trang admin Circa giả  (/kiem-ke-ton-kho, /kiem-ke-ton-kho/<id>): đặt cookie session_token giả, tạo phiên bằng XHR như axios
//       (không gửi X-Store-Id, như trang thật), tự GET phiên sau khi tạo / khi mở trang phiên. ?via=fetch → dùng fetch thay XHR.
//   P+1 API Circa giả          = mock-server.js (dùng lại nguyên, thêm entity/stores + authz/me + cfg.adminNoStore)
//   P+2 web NW giả             (/): ghi localStorage["auth-storage"] = {state:{accessToken:<JWT giả>}}; ?logout=1 → xoá
//   P+3 API NW giả             (/api/v1/…): auth/me, warehouses, stock/reconciliations (list, get, POST có clientOperationId, export xlsx).
//       Dạng response theo dữ liệu NW thật PM đọc 22/11: auth/me {permissions:[{id,name,description}], permissionNames:[…]};
//       warehouses = mảng phẳng ở gốc (parentId, children, locationType, closedAt); list phiên {data,total,page,limit,totalPages};
//       POST → 201 {id, warehouseId, warehouse, scopeType:"warehouse", status:"in_progress", notes, …}, cùng clientOperationId → cùng id.
//       nw.cfg: perms, meShape ("data"|"objectsOnly"|"strings"), warehouses, whShape, nw401, createFail, createAnyway, exportFail,
//               noTotalPages, metaTotalPages, noDedupe, postScope, postWarehouseId.
//       CORS chỉ cho origin web NW giả (như NW thật); request từ service worker extension không bị CORS chặn.
// Không gọi mạng ngoài, không dùng token thật (token sinh ngẫu nhiên mỗi lần chạy). Dữ liệu thử là GIẢ (demoFixture), không có dữ liệu thật.
//
// Dùng tay:  node tools/nw-sang-circa/mock-ext-server.js [cổngP]   → build bản thử cùng cổng: node tools/nw-sang-circa/build-ext.js --port <P> --only test
// Trong Node (test-ext-ui.js):
//   const X = require("./mock-ext-server.js"); const m = await X.start({ basePort, fixture: X.demoFixture(XLSX) });
//   m.urls {admin, circaApi, nwApp, nwApi} · m.circa (srv của mock-server.js) · m.nw {cfg, log, recs, setExport(id, buf), reset()} · m.tokens · await m.close()
"use strict";
const http = require("http"), crypto = require("crypto"), path = require("path"), net = require("net");
const M = require("./mock-server.js");

const LUMINA = "31493e74-3404-4c0e-a906-93691a6ee319";
const WH = {
  lumina: "a1a1a1a1-0000-4000-8000-000000000001", florita: "a1a1a1a1-0000-4000-8000-000000000002",
  transit: "a1a1a1a1-0000-4000-8000-000000000003", closed: "a1a1a1a1-0000-4000-8000-000000000004", accent: "a1a1a1a1-0000-4000-8000-000000000005",
  tamviet: "a1a1a1a1-0000-4000-8000-000000000006", child: "a1a1a1a1-0000-4000-8000-000000000007"
};
// Dạng /warehouses thật (PM đọc 22/11): MẢNG PHẲNG ở gốc; mỗi kho có parentId, children:[], locationType, closedAt.
// Tên kho hiện tại: "CIRCA LUMINA", "CIRCA FLORITA", "CIRCA TAM VIET", "In transit" (transit). Thêm 2 kho thử (đã đóng, tên có dấu khác) để
// kiểm điều kiện loại trừ. id là GIẢ.
function wh(id, name, code, type, closedAt, parentId, children) {
  return { id, name, code, locationType: type, parentId: parentId || null, children: children || [], closedAt: closedAt || null, createdAt: "2026-01-01T00:00:00.000Z" };
}
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
// kho dạng cây để thử: kho con trùng tên nằm trong children của kho cha (và/hoặc ở gốc)
function nestedWarehouses(childName, alsoAtRoot) {
  const list = defaultWarehouses();
  const child = wh(WH.child, childName, "WH-CHILD", "warehouse", null, WH.tamviet);
  list.find(x => x.id === WH.tamviet).children = [child];
  if (alsoAtRoot) list.push(Object.assign({}, child, { children: [] }));
  return list;
}
const b64u = s => Buffer.from(s).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
function fakeJwt(expSec) { return b64u(JSON.stringify({ alg: "HS256", typ: "JWT" })) + "." + b64u(JSON.stringify({ sub: "nguoi-thu", exp: expSec })) + "." + crypto.randomBytes(16).toString("hex"); }

// ---------- dữ liệu thử GIẢ ----------
// → {lookups: [[code, data|null]], xlsx: Buffer, tags, sent, nwBase} ; XLSX = SheetJS (load-tool.js)
// opt: {bulk: số thẻ SP D (mặc định 150 → 2 lô), unknownTag: thêm 1 thẻ Circa không nhận, kho: tên kho ở sheet Tổng quan}
function demoFixture(XLSX, opt) {
  opt = opt || {};
  const nBulk = opt.bulk == null ? 150 : opt.bulk;
  const U = (unit, rate, base) => ({ unit, convert_rate: rate, base_unit: !!base });
  const D = (pid, name, unitName, units) => ({ product_id: pid, product_name: name, sku_code: "SKU-GIA-" + pid, seller_code: "CIRCA", unit_name: unitName, retail_units: units, lot: "LOT-GIA", lot_date: "LOT-GIA-010127", po_code: "PO-GIA" });
  const rows = [], lookups = [];
  let seq = 0;
  const epc = () => "AB" + String(++seq).padStart(22, "0");
  function tag(pid, name, qty, unit, d, opts) {
    opts = opts || {};
    const e = opts.epc || epc(), u = opts.uid != null ? opts.uid : "17000000" + String(seq).padStart(5, "0") + "T" + seq;
    rows.push({ "Mã SP": "CIRCA-" + pid, "Tên sản phẩm": name, "Biến thể": "", "SKU": "SKU-GIA-" + pid, "EPC": e, "UID": u, "Số lượng thẻ": String(qty), "Thực tế nhập": "", "ĐVT": unit,
      "Lô": "LOT-GIA", "Hạn dùng": "", "Vị trí": "", "Lần quét cuối": "22/11/2026 10:00:00", "Trạng thái": "Đã quét" });
    if (opts.viaUid) { lookups.push([u, d]); lookups.push([e, null]); }
    else if (opts.unknown) { if (u) lookups.push([u, null]); lookups.push([e, null]); }
    else { if (u) lookups.push([u, null]); lookups.push([e, d]); }
  }
  const dA = D(900001, "SP thử A (vỉ 10 viên)", "vỉ", [U("viên", 1, true), U("vỉ", 10), U("hộp", 100)]);
  for (let i = 0; i < 3; i++) tag(900001, "SP thử A (vỉ 10 viên)", 10, "viên", dA);
  const dB = D(900002, "SP thử B (chai)", "chai", [U("chai", 1, true)]);
  tag(900002, "SP thử B (chai)", 1, "chai", dB); tag(900002, "SP thử B (chai)", 1, "chai", dB, { viaUid: true, epc: "E280" + String(++seq).padStart(20, "0") });
  const dC = D(900003, "SP thử C (gói lệch quy đổi)", "hộp", [U("gói", 1, true), U("hộp", 10)]);
  tag(900003, "SP thử C (gói lệch quy đổi)", 8, "gói", dC);
  if (opt.unknownTag) tag(900005, "SP thử E (Circa không nhận)", 1, "cái", null, { unknown: true });
  const dD = D(900004, "SP thử D (cái)", "cái", [U("cái", 1, true)]);
  for (let i = 0; i < nBulk; i++) tag(900004, "SP thử D (cái)", 1, "cái", dD);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Mã SP", "Tên sản phẩm", "Tồn hệ thống", "Đã đếm"]]), "Danh sách kiểm kê");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows, { header: ["Mã SP", "Tên sản phẩm", "Biến thể", "SKU", "EPC", "UID", "Số lượng thẻ", "Thực tế nhập", "ĐVT", "Lô", "Hạn dùng", "Vị trí", "Lần quét cuối", "Trạng thái"] }), "Chi tiết quét");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["EPC", "Lý do"], ["CD" + "0".repeat(21) + "1", "Không có trong hệ thống (giả)"]]), "Thẻ lạ");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Chỉ tiêu", "Giá trị"], ["Kho", opt.kho || "CIRCA LUMINA"], ["Trạng thái", "Đang kiểm"], ["Phạm vi", "Cả kho"], ["Tạo lúc", "22/11/2026 09:00:00"]]), "Tổng quan");
  const xlsx = Buffer.from(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
  return { lookups, xlsx, tags: rows.length, sent: rows.length - (opt.unknownTag ? 1 : 0), nwBase: 3 * 10 + 2 + 8 + (opt.unknownTag ? 1 : 0) + nBulk };
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

// ---------- trang admin giả ----------
function adminHtml(urls, ctoken, stores) {
  const opts = Object.keys(stores).map(id => "<option value=\"" + id + "\">" + stores[id].replace(/[<>&"]/g, "") + "</option>").join("");
  return "<!doctype html><html lang=\"vi\"><head><meta charset=\"utf-8\"><title>Admin Circa (giả)</title></head><body>" +
    "<h1>Admin Circa (GIẢ — kiểm thử extension)</h1><p id=\"route\"></p>" +
    "<div><select id=\"pos\">" + opts + "</select> <select id=\"mode\"><option>QR</option><option>RFID</option></select> " +
    "<button id=\"create\">Tạo phiên kiểm kê</button> <a id=\"list\" href=\"/kiem-ke-ton-kho\">Danh sách</a></div>" +
    "<pre id=\"log\"></pre><script>(function(){\n" +
    "var API=" + JSON.stringify(urls.circaApi) + ";\n" +
    "document.cookie='session_token=" + ctoken + "; path=/';\n" +
    "var via=new URLSearchParams(location.search).get('via')||'xhr';\n" +
    "function tok(){return (document.cookie.match(/(?:^|; )session_token=([^;]+)/)||[])[1];}\n" +
    "function H(b){var h={'Authorization':'Bearer '+tok(),'X-Circa-App':'admin','X-Client-Id':'1','Grpc-Timeout':'30S','Accept':'application/json, text/plain, */*'};if(b)h['Content-Type']='application/json';return h;}\n" +
    "function call(m,u,b){if(via==='fetch'){return fetch(API+u,{method:m,headers:H(b),body:b?JSON.stringify(b):undefined}).then(function(r){return r.text().then(function(t){return {status:r.status,j:t?JSON.parse(t):null};});},function(){return {status:0};});}\n" +
    " return new Promise(function(res){var x=new XMLHttpRequest();x.open(m,API+u);var h=H(b);Object.keys(h).forEach(function(k){x.setRequestHeader(k,h[k]);});x.onload=function(){var j=null;try{j=JSON.parse(x.responseText);}catch(e){}res({status:x.status,j:j});};x.onerror=function(){res({status:0});};x.send(b?JSON.stringify(b):null);});}\n" +
    "window.__adm={creates:[],gets:[]};\n" +
    "function show(){var m=/\\/kiem-ke-ton-kho\\/([0-9a-f-]{36})/.exec(location.pathname);document.getElementById('route').textContent=m?'Phiên '+m[1]:'Danh sách phiên';if(m){call('GET','/v1/inventory/count/sessions/'+m[1]).then(function(r){window.__adm.gets.push(r.status);});}}\n" +
    "document.getElementById('create').addEventListener('click',function(){var body={pos_id:document.getElementById('pos').value,scheduled_date:'2026-11-22',counting_mode:document.getElementById('mode').value,sync_baseline:true,designated_main_location_id:'0357db7a-f9be-4a9a-a70d-d70df7936503',cleanup_missing:false,auto_approve_tolerance_pct:2,auto_approve_tolerance_value:50000,force_manual_review:false,allow_ad_hoc_sku:true,auto_writeoff_orphan_ghosts:false};\n" +
    " call('POST','/v1/inventory/count/sessions',body).then(function(r){window.__adm.creates.push(r.status);if(r.status===200&&r.j&&r.j.data&&r.j.data.session){history.pushState({},'','/kiem-ke-ton-kho/'+r.j.data.session.id);show();}});});\n" +
    "window.addEventListener('popstate',show);show();\n" +
    "})();</script></body></html>";
}
function nwHtml(ntoken) {
  return "<!doctype html><html lang=\"vi\"><head><meta charset=\"utf-8\"><title>NW (giả)</title></head><body><h1>Nextwaves (GIẢ — kiểm thử extension)</h1><p id=\"st\"></p><script>(function(){\n" +
    "var q=new URLSearchParams(location.search);\n" +
    "if(q.get('logout')){localStorage.removeItem('auth-storage');document.getElementById('st').textContent='đã đăng xuất';}\n" +
    "else{localStorage.setItem('auth-storage',JSON.stringify({state:{accessToken:" + JSON.stringify(ntoken) + ",user:{name:'Người thử'}},version:0}));document.getElementById('st').textContent='đã đăng nhập (giả)';}\n" +
    "})();</script></body></html>";
}

// ---------- API NW giả ----------
function nwApi(origins, ntoken) {
  const nw = { cfg: {}, log: [], recs: [], exports: {}, defaultExport: null };
  nw.reset = () => { nw.cfg = {}; nw.log.length = 0; nw.recs.length = 0; nw.exports = {}; };
  nw.setExport = (id, buf) => { nw.exports[id] = buf; };
  nw.addRec = o => {
    const whs = nw.cfg.warehouses || defaultWarehouses();
    const w = whs.find(x => x.id === o.warehouseId) || { id: o.warehouseId, name: "?" };
    const r = { id: o.id || crypto.randomUUID(), status: o.status || "in_progress", scopeType: o.scopeType || "warehouse", notes: o.notes == null ? null : o.notes, clientOperationId: o.clientOperationId || null,
      warehouseId: w.id, warehouse: { id: w.id, name: w.name, code: w.code || null, locationType: w.locationType || "warehouse" }, totalEpcsScanned: 0, createdAt: o.createdAt || new Date().toISOString() };
    if (o.noWarehouse) { delete r.warehouseId; delete r.warehouse; }
    nw.recs.push(r);
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
      const e = { t: Date.now(), method: req.method, path: p, query: Object.fromEntries(u.searchParams), origin, authOk: auth === "Bearer " + ntoken, accept: req.headers.accept || null, ct: req.headers["content-type"] || null, cookie: !!req.headers.cookie };
      if (body) { try { e.body = JSON.parse(body); } catch (x) { e.bodyRaw = body.slice(0, 300); } }
      nw.log.push(e);
      const send = (st, obj) => { e.status = st; json(res, st, obj, origin); };
      if (!e.authOk || nw.cfg.nw401) return send(401, { statusCode: 401, message: "Unauthorized (giả)" });
      const B = "/api/v1";
      let m;
      if (req.method === "GET" && p === B + "/auth/me") {
        // dạng thật 22/11: permissions = mảng OBJECT {id,name,description}; permissionNames = mảng chuỗi (thật có 261 quyền)
        const names = nw.cfg.perms || ["stock.view", "stock.reconcile", "warehouse.view"];
        const me = { id: "u-gia", name: "Người thử", permissions: names.map((n, i) => ({ id: "p-" + (i + 1), name: n, description: "quyền giả " + n })), permissionNames: names.slice() };
        if (nw.cfg.meShape === "objectsOnly") delete me.permissionNames;
        if (nw.cfg.meShape === "strings") { me.permissions = names.slice(); delete me.permissionNames; }
        return send(200, nw.cfg.meShape === "data" ? { data: me } : me);
      }
      if (req.method === "GET" && p === B + "/warehouses") {
        const list = nw.cfg.warehouses || defaultWarehouses();
        return send(200, nw.cfg.whShape === "data" ? { data: list } : list);
      }
      if (req.method === "GET" && p === B + "/stock/reconciliations") {
        // dạng thật: {data,total,page,limit,totalPages} ở gốc. cfg.noTotalPages: bỏ totalPages; cfg.metaTotalPages: để trong meta
        const page = Math.max(1, +u.searchParams.get("page") || 1), limit = Math.max(1, +u.searchParams.get("limit") || 25);
        const all = nw.recs.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        const tp = Math.max(1, Math.ceil(all.length / limit)), o = { data: all.slice((page - 1) * limit, page * limit), total: all.length, page, limit, totalPages: tp };
        if (nw.cfg.noTotalPages || nw.cfg.metaTotalPages) delete o.totalPages;
        if (nw.cfg.metaTotalPages) o.meta = { totalPages: tp, total: all.length };
        return send(200, o);
      }
      if (req.method === "POST" && p === B + "/stock/reconciliations") {
        const b = e.body || {};
        if (nw.cfg.createFail) {
          if (nw.cfg.createAnyway && !nw.recs.some(r => r.clientOperationId === b.clientOperationId)) nw.addRec(b);
          return send(nw.cfg.createFail, { statusCode: nw.cfg.createFail, message: "lỗi tạo phiên (giả)" });
        }
        if (!b.warehouseId || typeof b.notes !== "string" || !b.clientOperationId) return send(400, { statusCode: 400, message: "thiếu trường (giả)" });
        // NW thật (2 lần thử 22/11) trả cùng id cho cùng clientOperationId; cfg.noDedupe: giả NW KHÔNG chống trùng
        const old = nw.cfg.noDedupe ? null : nw.recs.find(r => r.clientOperationId === b.clientOperationId);
        if (old) { e.replay = true; return send(201, old); }
        const r = nw.addRec(Object.assign({}, b, nw.cfg.postScope ? { scopeType: nw.cfg.postScope } : {}));
        const outR = JSON.parse(JSON.stringify(r));
        if (nw.cfg.postWarehouseId) { outR.warehouseId = nw.cfg.postWarehouseId; outR.warehouse = { id: nw.cfg.postWarehouseId, name: "kho khác (giả)" }; }
        return send(201, outR);
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
        const buf = nw.exports[r.id] || nw.defaultExport;
        if (!buf) return send(404, { statusCode: 404, message: "chưa có dữ liệu xuất (giả)" });
        e.status = 200;
        const h = { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": "attachment; filename=\"kiem-ke-gia.xlsx\"" };
        if (origin === origins.nwApp) h["Access-Control-Allow-Origin"] = origin;
        res.writeHead(200, h); return res.end(buf);
      }
      return send(404, { statusCode: 404, message: "không có đường dẫn (giả): " + p });
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
  const fx = opts.fixture || null;
  if (fx) for (const [c, d] of fx.lookups) circa.setLookup(c, d);
  const A = nwApi(urls, tokens.nw);
  if (fx) A.nw.defaultExport = fx.xlsx;
  const admin = await listen((req, res) => {
    const u = new URL(req.url, "http://x");
    if (req.method !== "GET" || u.pathname === "/favicon.ico") { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(adminHtml(urls, tokens.circa, circa.stores));
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

module.exports = { start, demoFixture, defaultWarehouses, nestedWarehouses, WH, LUMINA, fakeJwt };

if (require.main === module) {
  const ROOT = path.resolve(__dirname, "..", "..");
  const { XLSX } = require(path.join(ROOT, ".claude/skills/circa-nextwaves-check/scripts/kiem-dem/load-tool.js"));
  start({ basePort: +process.argv[2] || 47900, fixture: demoFixture(XLSX) }).then(m => {
    console.log("máy chủ giả (dữ liệu GIẢ):", JSON.stringify(m.urls));
    console.log("build bản thử cùng cổng: node tools/nw-sang-circa/build-ext.js --port " + m.base + " --only test");
    console.log("mở trang admin giả:", m.urls.admin + "/kiem-ke-ton-kho", "· web NW giả:", m.urls.nwApp + "/");
  });
}
