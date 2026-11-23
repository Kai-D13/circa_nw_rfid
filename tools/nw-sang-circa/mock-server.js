// MÁY CHỦ GIẢ Circa trên localhost, để kiểm thử trang build/nw-sang-circa.html. Không gọi mạng ngoài, không dùng token thật,
// không đọc / ghi gì của NW / Circa. Đọc file lookup + lượt quét đã kéo sẵn (chỉ đọc).
// Mô phỏng ghi lượt quét bằng sim.js (giả định ghi trong sim.js; KHÔNG phải số Circa thật).
//
// Dùng tay:
//   node tools/nw-sang-circa/mock-server.js [port] [qr-lookup.json]
//   → mở build/nw-sang-circa.html?api=http://127.0.0.1:<port>  (token gõ gì cũng được, miễn không rỗng)
//   Điều khiển (chỉ từ máy này, trang không gọi): POST /__mock/cfg {…cấu hình lỗi…}, POST /__mock/session {id, code, scans},
//   GET /__mock/log, GET /__mock/state.
// Dùng trong Node (test-ui.js):
//   const M = require("./mock-server.js"); const srv = await M.start({ port: 0, lookupFile });
//   srv.url · srv.cfg = {…} · srv.addSession({…}) · srv.addScan(id, scan) · srv.addScanBatch(id, [scan]) · srv.log · srv.sessions · srv.reset() · await srv.close()
//   srv.addScan: lượt quét "đếm tay" đi qua cùng chống trùng theo mã của sim (mã đã có → bỏ qua, trả false; gửi lại mã đó → duplicates)
//   srv.addScanBatch: như addScan cho cả mảng, mọi lượt MỚI chung MỘT scanned_at (như một lô 100 thẻ trên Circa thật) → trả số lượt thêm được
//
// Hợp đồng giả (theo đặc tả PM 21/11/2026 + response thật trong capture):
//   GET  /v1/inventory/count/qr-lookup?pos_id=&qr_code=   200 {success,data} | 404 {success:false, errors:[NotFoundError]}
//   POST /v1/inventory/count/sessions                      200 {data:{session:{id,code,status:"LOADING_BASELINE",…}, invalid_selectors:[]}}
//   GET  /v1/inventory/count/sessions/<id>                 200 {data:{session}} ; LOADING_BASELINE → OPEN sau cfg.loadingMs
//   GET  /v1/inventory/count/session/current?pos_id=       200 {data: session} (dạng thật: data là phiên) | 404 khi không có
//   POST /v1/inventory/count/submit-rfid-batch             200 {data:{inserted,duplicates,unknown_tags,resolved_tags,rejected_tags}}
//   GET  /v1/inventory/count/sessions/<id>/scans?limit=[&offset=]   200 {data:{scans: lượt [offset, offset+limit), has_more: còn lượt sau}}
//        Như Circa thật (records/pos-writes/20261121-lumina-day-du-1.scans-sau.json): mỗi lượt có id (uuid) + scanned_at, trả MỚI NHẤT TRƯỚC
//        (giảm dần scanned_at), mọi lượt của MỘT lần gửi lô chung một scanned_at.
//        KHÔNG có offset: cùng scanned_at → lượt thêm sau trước (thứ tự ổn định giữa các lần đọc); limit ≥ số lượt → trả hết, has_more=false.
//        CÓ offset (kể cả offset=0): như số đo trên Circa thật 23/11 (ICS00242: lật trang limit=100 → 604 dòng, 594 id; Circa sắp scanned_at
//        giảm dần, không khoá phụ), thứ tự TRONG NHÓM CÙNG scanned_at xáo lại ở MỖI request → mã lỡ lật trang bằng offset sẽ trùng / sót lượt.
//        Lượt có sẵn (addSession scans / addScan) giữ id / scanned_at truyền vào nếu có, không thì cấp mới (thời điểm tăng dần).
//        entry.scansOut = số lượt trả, entry.bytes = byte thân response (để test đo kích thước).
//   GET  /v1/inventory/count/sessions/<id>/summary     200 {data:{session_id, total_scans: số lượt, …}} (dạng theo ICS00237 thật)
//   GET  /v1/admin/inventory/location?query=pos_ids=<pos>,… 200 {data:{locations:[{id,name,code,pos_id}]}}
//   Header: thiếu Authorization → 401; thiếu X-Store-Id → 400 AuthzStoreRequired. Preflight chỉ cho đúng bộ header như máy thật
//   (Authorization, Content-Type, Grpc-Timeout, X-Circa-App, X-Client-Id, X-Store-Id); header khác → không trả ACAO (trình duyệt chặn).
//
// cfg (lỗi cố ý, mặc định không có lỗi):
//   loadingMs          ms từ lúc tạo tới OPEN (mặc định 1200)       stuck: true → kẹt LOADING_BASELINE mãi
//   createFail         mã HTTP trả cho POST /sessions (vd 500, 400)  createHang: true → không trả lời (client tự timeout)
//   createAnyway       true: phiên vẫn được tạo dù trả lỗi / treo (giống máy chủ ghi xong mà mất response)
//   lookup401After     sau N lượt tra thành công, mọi lượt tra trả 401
//   submitFaults       {<thứ tự lô>: [{status:500, record:true}, {status:500}]}: các lần gửi đầu của lô đó trả lỗi theo thứ tự;
//                      record:true = máy chủ đã ghi lô rồi mới trả lỗi (mất response); hang:true = không trả lời (client timeout)
//   submit400At        thứ tự lô trả 400 FAILED_PRECONDITION
//   wrongCode          mã trong items bị ghi như gửi thô (bỏ qua unit_name/quantity) → Circa ghi theo đơn vị tem
//   noCurrent          true → session/current trả 404
//   token              nếu đặt: Authorization phải đúng "Bearer <token>", sai → 401
// Thêm cho extension (tools/nw-sang-circa/ext, dùng qua mock-ext-server.js / test-ext-ui.js); mặc định KHÔNG đổi hành vi cũ:
//   GET  /v1/authz/me                 200 cfg.authz (mặc định {success, data:{permissions:["inventory_count.view","inventory_count.manage"]}})
//   cfg.adminNoStore   true: GET /sessions (danh sách) nhận request KHÔNG có X-Store-Id (như trang admin thật); mọi lệnh khác vẫn cần X-Store-Id
//   srv.stores         {pos_id: tên} (bản sao của STORES, thêm cửa hàng giả được) · addSession nhận thêm created_at, created_by_name
//   GET  /v1/inventory/count/sessions?page=&limit=   200 {success, data:{list:[phiên], total, status_counts}} (mới tạo trước; dạng theo
//        đặc tả PM 22/11: id, code, pos_id, pos_name, status, counting_mode, created_at, created_by_name, total_lines, completed_lines)
//   cfg.listFail       mã HTTP trả cho danh sách phiên · cfg.listNoTotal true: bỏ data.total
// Lượt quét / summary (dựng ca đọc lượt quét của extension v0.2.1 — một request, không lật trang; mặc định không có):
//   cfg.serverCap      k: TRẦN PHÍA MÁY CHỦ: một request trả tối đa k lượt (dù limit lớn hơn), has_more = còn lượt sau (true khi tổng > k)
//   cfg.insertBetween  {n, product_id?, every?, at?}: thêm n lượt QR MỚI NHẤT (lượt chen vào trong một lần đọc của client):
//                      at "scans" (mặc định): ngay SAU khi trả request lượt quét không offset / offset=0 (chen giữa lượt quét và summary sau);
//                      at "summary": ngay SAU khi trả một request summary (chen giữa summary trước và lượt quét).
//                      every: true → mỗi lần đều chen (đang có người quét), không thì chỉ 1 lần
//   cfg.scansDup       true: response lượt quét có lượt CUỐI lặp lại thêm một lần (cùng id) → lần đọc nào cũng trùng id
//   cfg.scansDupAfterSubmit  n: như scansDup, chỉ từ khi phiên đã nhận n lần gửi lô có ghi
//   cfg.noHasMore      true: response lượt quét bỏ trường has_more · cfg.hasMoreAs: has_more = giá trị này (vd "false", 0, null)
//   cfg.padScans       n: thêm vào MỖI lượt trả về trường pad = n ký tự "ả" (3 byte UTF-8) → phóng to response (đo kích thước)
//   cfg.dropId         [mã]: lượt của các mã này trả KHÔNG có id
//   cfg.summaryOff     n: summary.total_scans = số lượt + n (summary lệch) · cfg.summaryFail: mã HTTP · cfg.summaryNoTotal: bỏ total_scans
"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const NWC = require("./core.js");
const sim = require("./sim.js");

const ALLOW_HEADERS = ["authorization", "content-type", "grpc-timeout", "x-circa-app", "x-client-id", "x-store-id"];
const STORES = { "31493e74-3404-4c0e-a906-93691a6ee319": "CIRCA LUMINA", "c476efb2-415c-429a-978e-d389b4b06607": "CIRCA FLORITA" };
const LOCS = {
  "31493e74-3404-4c0e-a906-93691a6ee319": [
    { id: "0357db7a-f9be-4a9a-a70d-d70df7936503", name: "General", code: "General" },
    { id: "11111111-aaaa-4aaa-8aaa-000000000001", name: "Kho cắt liều", code: "WH-MAIN-UNPACK" },
    { id: "11111111-aaaa-4aaa-8aaa-000000000002", name: "Tu1", code: "Tu1" }],
  "c476efb2-415c-429a-978e-d389b4b06607": [
    { id: "22222222-bbbb-4bbb-8bbb-000000000001", name: "General", code: "General" },
    { id: "22222222-bbbb-4bbb-8bbb-000000000002", name: "Kệ 1A", code: "1A" }]
};

function loadLookups(file) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const m = new Map();
  for (const x of j.res || []) {
    const k = NWC._codeKey(x.code);
    if (x.status === 200 && x.d) m.set(k, x.d);
    else if (x.status === 404 && !m.has(k)) m.set(k, null);
  }
  return m;
}

// thời điểm lượt quét giả: tăng NGHIÊM NGẶT, dạng như Circa thật "2026-11-21T11:36:13.325787Z" (6 chữ số lẻ giây, so chuỗi = so thời gian)
let lastUs = 0;
function tick() {
  lastUs = Math.max(Date.now() * 1000, lastUs + 1);
  return new Date(Math.floor(lastUs / 1000)).toISOString().slice(0, 23) + String(lastUs % 1000).padStart(3, "0") + "Z";
}

function start(opts) {
  opts = opts || {};
  const lookups = opts.lookupFile ? loadLookups(opts.lookupFile) : new Map();
  const srv = { cfg: {}, log: [], sessions: new Map(), lookups, url: "", stores: Object.assign({}, STORES) };
  let seq = 9000, lookOk = 0;
  srv.reset = () => { srv.cfg = {}; srv.log.length = 0; srv.sessions.clear(); seq = 9000; lookOk = 0; };
  const simLookups = () => { const m = new Map(); for (const [k, v] of lookups) if (v) m.set(k, v); return m; };
  let SL = simLookups();
  srv.setLookup = (code, d) => { lookups.set(NWC._codeKey(code), d); SL = simLookups(); };

  // id + scanned_at của từng lượt (sim.js không giữ 2 trường này): mã (viết hoa) → {id, at, n (thứ tự thêm)}
  function stamp(s, key, id, at) {
    if (s.meta.has(key)) return;
    s.meta.set(key, { id: typeof id === "string" && id.trim() ? id : crypto.randomUUID(), at: typeof at === "string" && at ? at : tick(), n: ++s.metaN });
  }
  function mkSession(o) {
    const s = {
      id: o.id || crypto.randomUUID(), code: o.code || ("ICS" + (++seq)), pos_id: o.pos_id, pos_name: srv.stores[o.pos_id] || "",
      scheduled_date: o.scheduled_date || new Date().toISOString().slice(0, 10), status: o.status || "LOADING_BASELINE",
      counting_mode: o.counting_mode || "QR", created_at: o.created_at || new Date().toISOString(), designated_main_location_id: o.designated_main_location_id || "",
      created_by_name: o.created_by_name == null ? "Người thử" : o.created_by_name,
      openAt: Date.now() + (srv.cfg.loadingMs != null ? srv.cfg.loadingMs : 1200), sim: sim.session(o.scans || []), ord: new Map(), tries: new Map(),
      meta: new Map(), metaN: 0, written: 0, inserted: 0
    };
    (o.scans || []).forEach(x => stamp(s, NWC._codeKey(x.qr_code), x.id, x.scanned_at));
    srv.sessions.set(s.id, s);
    return s;
  }
  srv.addSession = o => mkSession(Object.assign({ status: "OPEN", pos_id: "31493e74-3404-4c0e-a906-93691a6ee319" }, o));
  srv.addScan = (id, scan) => {
    const s = srv.sessions.get(id), ok = s.sim.add(scan);
    if (ok) stamp(s, NWC._codeKey(scan.qr_code), scan.id, scan.scanned_at);
    return ok;
  };
  // nhiều lượt "đếm tay" như MỘT lô: mọi lượt mới chung một scanned_at (lượt có scanned_at riêng thì giữ) → số lượt thêm được
  srv.addScanBatch = (id, scans) => {
    const s = srv.sessions.get(id), at = tick();
    let n = 0;
    for (const scan of scans || []) if (s.sim.add(scan)) { stamp(s, NWC._codeKey(scan.qr_code), scan.id, scan.scanned_at || at); n++; }
    return n;
  };
  // gửi lô vào sim: mọi lượt MỚI của lô chung một scanned_at (như Circa thật)
  function simSubmit(s, body) {
    const before = new Set(s.sim.scans().map(x => NWC._codeKey(x.qr_code)));
    const data = s.sim.submit(body, SL);
    const at = tick();
    s.sim.scans().forEach(x => { const k = NWC._codeKey(x.qr_code); if (!before.has(k)) stamp(s, k, null, at); });
    s.written++;
    return data;
  }
  function view(s) {
    if (s.status === "LOADING_BASELINE" && !srv.cfg.stuck && Date.now() >= s.openAt) s.status = "OPEN";
    return {
      id: s.id, code: s.code, pos_id: s.pos_id, pos_name: s.pos_name, scheduled_date: s.scheduled_date, status: s.status, counting_mode: s.counting_mode,
      created_at: s.created_at, closed_at: null, designated_main_location_id: s.designated_main_location_id, designated_main_location_code: "General",
      total_lines: 0, completed_lines: 0, source: "", created_by_name: s.created_by_name
    };
  }
  // lượt quét đã lưu, MỚI NHẤT TRƯỚC (giảm dần scanned_at). Cùng scanned_at: lượt thêm sau trước (ổn định), hoặc xáo ngẫu nhiên khi
  // shuffleTies (request có offset: như Circa thật, không có khoá phụ nên thứ tự trong nhóm đổi giữa các trang)
  function scansOf(s, shuffleTies) {
    const drop = new Set((srv.cfg.dropId || []).map(NWC._codeKey));
    const list = s.sim.scans().map(x => {
      const k = NWC._codeKey(x.qr_code);
      stamp(s, k, null, null); // lượt ghi thẳng vào sim (không qua máy chủ) → cấp id / thời điểm lúc đọc
      const m = s.meta.get(k);
      x.id = m.id; x.scanned_at = m.at; x._n = m.n; x._r = shuffleTies ? Math.random() : 0;
      if (drop.has(k)) delete x.id;
      if (!x.product_name) { const d = lookups.get(k); if (d) x.product_name = d.product_name; }
      if (!x.session_id) x.session_id = s.id;
      return x;
    });
    list.sort((a, b) => (a.scanned_at < b.scanned_at ? 1 : a.scanned_at > b.scanned_at ? -1 : 0) || (shuffleTies ? a._r - b._r : b._n - a._n));
    list.forEach(x => { delete x._n; delete x._r; });
    return list;
  }
  // lượt QR "nhân viên vừa quét" (dựng ca lượt chen giữa hai trang)
  function insertNew(s, n, pid) {
    for (let i = 0; i < n; i++) {
      s.inserted++;
      srv.addScan(s.id, { qr_code: "1799" + String(Date.now()).slice(-9) + "CHEN" + s.inserted, product_id: pid || 990001, scanned_qty: 1, unit_code: "cái", conversion_factor: 1, base_qty: 1, device_id: "PDA-QR" });
    }
  }

  function cors(req, extra) {
    const h = Object.assign({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": "true", "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, extra || {});
    return h;
  }
  function send(req, res, status, obj, entry) {
    if (entry) entry.status = status;
    const body = JSON.stringify(obj);
    if (entry && /\/scans$/.test(entry.path)) entry.bytes = Buffer.byteLength(body);
    res.writeHead(status, cors(req));
    res.end(body);
  }
  const err = (code, message, status) => ({ success: false, errors: [{ code, message, status: status || code, trace_id: "mock-" + crypto.randomBytes(6).toString("hex") }] });

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    // ---- điều khiển (không CORS, trang không gọi) ----
    if (p.startsWith("/__mock/")) {
      let b = "";
      req.on("data", c => { b += c; });
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        if (p === "/__mock/cfg" && req.method === "POST") { srv.cfg = JSON.parse(b || "{}"); return res.end(JSON.stringify({ ok: true, cfg: srv.cfg })); }
        if (p === "/__mock/session" && req.method === "POST") { const s = srv.addSession(JSON.parse(b || "{}")); return res.end(JSON.stringify(view(s))); }
        if (p === "/__mock/log") return res.end(JSON.stringify(srv.log));
        if (p === "/__mock/state") return res.end(JSON.stringify([...srv.sessions.values()].map(s => Object.assign(view(s), { scans: scansOf(s).length }))));
        res.statusCode = 404; res.end("{}");
      });
      return;
    }
    // ---- preflight: chỉ cho đúng bộ header của máy thật ----
    if (req.method === "OPTIONS") {
      const want = String(req.headers["access-control-request-headers"] || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
      const bad = want.filter(x => ALLOW_HEADERS.indexOf(x) < 0);
      srv.log.push({ t: Date.now(), method: "OPTIONS", url: req.url, path: p, want, bad, origin: req.headers.origin || null });
      const h = { "Vary": "Origin, Access-Control-Request-Method, Access-Control-Request-Headers" };
      if (!bad.length) Object.assign(h, {
        "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": String(req.headers["access-control-request-method"] || "GET"),
        "Access-Control-Allow-Headers": want.join(", ")
      });
      if (req.headers["access-control-request-private-network"]) h["Access-Control-Allow-Private-Network"] = "true";
      res.writeHead(200, h); return res.end();
    }
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      const auth = String(req.headers.authorization || "");
      const entry = {
        t: Date.now(), method: req.method, url: req.url, path: p, query: Object.fromEntries(u.searchParams),
        h: { store: req.headers["x-store-id"] || null, app: req.headers["x-circa-app"] || null, client: req.headers["x-client-id"] || null, ct: req.headers["content-type"] || null, grpc: req.headers["grpc-timeout"] || null, bearer: /^Bearer \S+/.test(auth), authOk: srv.cfg.token ? auth === "Bearer " + srv.cfg.token : /^Bearer \S+/.test(auth) },
        origin: req.headers.origin || null
      };
      if (body) { try { entry.body = JSON.parse(body); } catch (e) { entry.bodyRaw = body.slice(0, 500); } }
      srv.log.push(entry);
      if (!entry.h.authOk) return send(req, res, 401, err("Unauthenticated", "token không hợp lệ (giả)"), entry);
      const B = "/v1/inventory/count";
      const adminOk = srv.cfg.adminNoStore && req.method === "GET" && p === B + "/sessions";
      if (!entry.h.store && !adminOk) return send(req, res, 400, err("AuthzStoreRequired", "thiếu X-Store-Id (giả)"), entry);
      let m;
      // danh sách phiên (trang admin "Kiểm kê tồn kho"): mới tạo trước, phân trang page/limit
      if (req.method === "GET" && p === B + "/sessions") {
        if (srv.cfg.listFail) return send(req, res, srv.cfg.listFail, err(srv.cfg.listFail >= 500 ? "Internal" : "Error", "lỗi danh sách phiên (giả)"), entry);
        const page = Math.max(1, +u.searchParams.get("page") || 1), limit = Math.max(1, +u.searchParams.get("limit") || 20);
        const all = [...srv.sessions.values()].map(view).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        const sc = {};
        all.forEach(s => { sc[s.status] = (sc[s.status] || 0) + 1; });
        const data = { list: all.slice((page - 1) * limit, page * limit), total: all.length, status_counts: sc };
        if (srv.cfg.listNoTotal) delete data.total;
        return send(req, res, 200, { success: true, data }, entry);
      }
      // qr-lookup
      if (req.method === "GET" && p === B + "/qr-lookup") {
        if (srv.cfg.lookup401After != null && lookOk >= srv.cfg.lookup401After) return send(req, res, 401, err("Unauthenticated", "token hết hạn (giả)"), entry);
        const d = lookups.get(NWC._codeKey(u.searchParams.get("qr_code") || ""));
        if (!d) return send(req, res, 404, err("NotFoundError", "NotFoundError", "NOT_FOUND"), entry);
        lookOk++;
        return send(req, res, 200, { success: true, data: d }, entry);
      }
      // tạo phiên
      if (req.method === "POST" && p === B + "/sessions") {
        const b = entry.body || {};
        if (srv.cfg.createHang) { if (srv.cfg.createAnyway) mkSession(b); entry.status = "treo"; req.socket.setTimeout(0); return; }
        if (srv.cfg.createFail) { if (srv.cfg.createAnyway) mkSession(b); return send(req, res, srv.cfg.createFail, err(srv.cfg.createFail >= 500 ? "Internal" : "InvalidArgument", "lỗi tạo phiên (giả)"), entry); }
        if (!b.pos_id || !srv.stores[b.pos_id]) return send(req, res, 400, err("InvalidArgument", "pos_id không hợp lệ (giả)"), entry);
        const s = mkSession(b);
        return send(req, res, 200, { success: true, data: { session: view(s), invalid_selectors: [] } }, entry);
      }
      // phiên đang mở
      if (req.method === "GET" && p === B + "/session/current") {
        if (srv.cfg.noCurrent) return send(req, res, 404, err("NotFoundError", "không có phiên mở (giả)", "NOT_FOUND"), entry);
        const pos = u.searchParams.get("pos_id");
        const open = [...srv.sessions.values()].map(s => view(s) && s).filter(s => s.pos_id === pos && s.status === "OPEN").pop();
        if (!open) return send(req, res, 404, err("NotFoundError", "không có phiên mở (giả)", "NOT_FOUND"), entry);
        return send(req, res, 200, { success: true, data: view(open) }, entry);
      }
      // lượt quét
      if (req.method === "GET" && (m = /^\/v1\/inventory\/count\/sessions\/([^/]+)\/scans$/.exec(p))) {
        const s = srv.sessions.get(decodeURIComponent(m[1]));
        if (!s) return send(req, res, 404, err("NotFoundError", "không có phiên (giả)", "NOT_FOUND"), entry);
        const hasOff = u.searchParams.has("offset");
        const list = scansOf(s, hasOff), lim = Math.max(1, +u.searchParams.get("limit") || 1000), off = hasOff ? Math.max(0, +u.searchParams.get("offset") || 0) : 0;
        const c = srv.cfg;
        let out = list.slice(off, off + lim);
        if (c.serverCap != null) out = out.slice(0, Math.max(0, +c.serverCap));
        const more = off + out.length < list.length;
        // trùng id trong response: lượt cuối lặp lại (bản sao, cùng id)
        if ((c.scansDup || (c.scansDupAfterSubmit != null && s.written >= c.scansDupAfterSubmit)) && out.length) out.push(Object.assign({}, out[out.length - 1]));
        if (c.padScans) { const pad = "ả".repeat(+c.padScans); out = out.map(x => Object.assign({}, x, { pad })); }
        const data = { scans: out, has_more: more };
        if (c.noHasMore) delete data.has_more;
        else if (Object.prototype.hasOwnProperty.call(c, "hasMoreAs")) data.has_more = c.hasMoreAs;
        entry.scansOut = out.length;
        send(req, res, 200, { success: true, data }, entry);
        // lượt mới chen vào SAU khi đã trả lượt quét (request không offset / offset=0) của một lần đọc
        const ib = c.insertBetween;
        if (ib && (ib.at || "scans") === "scans" && off === 0 && (ib.every || !ib.fired)) { ib.fired = true; insertNew(s, ib.n || 1, ib.product_id); }
        return;
      }
      // tổng số lượt (dạng theo summary thật của ICS00237)
      if (req.method === "GET" && (m = /^\/v1\/inventory\/count\/sessions\/([^/]+)\/summary$/.exec(p))) {
        const s = srv.sessions.get(decodeURIComponent(m[1]));
        if (!s) return send(req, res, 404, err("NotFoundError", "không có phiên (giả)", "NOT_FOUND"), entry);
        if (srv.cfg.summaryFail) return send(req, res, srv.cfg.summaryFail, err(srv.cfg.summaryFail >= 500 ? "Internal" : "Error", "lỗi summary (giả)"), entry);
        const n = s.sim.scans().length + (srv.cfg.summaryOff || 0);
        const data = { session_id: s.id, total_lines: 0, started_lines: 0, completed_lines: 0, total_scans: n, match_lines: 0, surplus_lines: 0, shortage_lines: 0,
          expected_total_qty: 0, counted_total_qty: s.sim.scans().reduce((a, x) => a + (+x.base_qty || 0), 0) };
        if (srv.cfg.summaryNoTotal) delete data.total_scans;
        entry.total = n;
        send(req, res, 200, { success: true, data }, entry);
        // lượt mới chen vào SAU khi đã trả summary (giữa summary trước và lượt quét của một lần đọc)
        const ib = srv.cfg.insertBetween;
        if (ib && ib.at === "summary" && (ib.every || !ib.fired)) { ib.fired = true; insertNew(s, ib.n || 1, ib.product_id); }
        return;
      }
      // chi tiết phiên
      if (req.method === "GET" && (m = /^\/v1\/inventory\/count\/sessions\/([^/]+)$/.exec(p))) {
        const s = srv.sessions.get(decodeURIComponent(m[1]));
        if (!s) return send(req, res, 404, err("NotFoundError", "không có phiên (giả)", "NOT_FOUND"), entry);
        return send(req, res, 200, { success: true, data: { session: view(s) } }, entry);
      }
      // gửi lô
      if (req.method === "POST" && p === B + "/submit-rfid-batch") {
        const b = entry.body || {};
        const s = srv.sessions.get(b.session_id);
        if (!s || view(s).status !== "OPEN") return send(req, res, 400, err("FAILED_PRECONDITION", "session is not open (giả)", "FAILED_PRECONDITION"), entry);
        const codes = NWC.bodyCodes(b);
        if (!codes.length || codes.length > 100) return send(req, res, 400, err("InvalidArgument", "1..100 mã / lô (giả)"), entry);
        const k = NWC._codeKey(codes[0]);
        if (!s.ord.has(k)) s.ord.set(k, s.ord.size + 1);
        const ord = s.ord.get(k), tri = (s.tries.get(ord) || 0) + 1;
        s.tries.set(ord, tri);
        entry.lo = ord; entry.lan = tri;
        if (srv.cfg.submit400At === ord) return send(req, res, 400, err("FAILED_PRECONDITION", "session is not open (giả)", "FAILED_PRECONDITION"), entry);
        const f = srv.cfg.submitFaults && srv.cfg.submitFaults[ord] && srv.cfg.submitFaults[ord][tri - 1];
        let body2 = b;
        if (srv.cfg.wrongCode && (b.items || []).some(x => NWC._codeKey(x.tag) === NWC._codeKey(srv.cfg.wrongCode))) {
          // ghi sai cố ý: mã này bị coi như gửi thô (bỏ qua unit_name / quantity)
          body2 = Object.assign({}, b, {
            tags: (b.tags || []).concat(b.items.filter(x => NWC._codeKey(x.tag) === NWC._codeKey(srv.cfg.wrongCode)).map(x => x.tag)),
            items: b.items.filter(x => NWC._codeKey(x.tag) !== NWC._codeKey(srv.cfg.wrongCode))
          });
        }
        if (f) {
          if (f.record) simSubmit(s, body2);
          if (f.hang) { entry.status = "treo"; req.socket.setTimeout(0); return; }
          return send(req, res, f.status, err(f.status >= 500 ? "Internal" : "Error", "lỗi lô (giả)"), entry);
        }
        const data = simSubmit(s, body2);
        entry.result = { inserted: data.inserted, duplicates: data.duplicates };
        return send(req, res, 200, { success: true, data }, entry);
      }
      // vị trí
      if (req.method === "GET" && p === "/v1/admin/inventory/location") {
        const q = String(u.searchParams.get("query") || ""), pm = /pos_ids=([0-9a-f-]+)/.exec(q);
        const list = (pm && LOCS[pm[1]] || []).map(x => Object.assign({ pos_id: pm[1], location_type: "SALES", sale_allowed: true, is_last_location: true }, x));
        return send(req, res, 200, { success: true, data: { locations: list, total: list.length } }, entry);
      }
      // quyền (extension kiểm inventory_count.manage)
      if (req.method === "GET" && p === "/v1/authz/me") {
        return send(req, res, 200, srv.cfg.authz || { success: true, data: { permissions: ["inventory_count.view", "inventory_count.manage"] } }, entry);
      }
      return send(req, res, 404, err("NotFoundError", "không có đường dẫn (giả): " + p, "NOT_FOUND"), entry);
    });
  });
  return new Promise(resolve => {
    server.listen(opts.port || 0, "127.0.0.1", () => {
      srv.port = server.address().port;
      srv.url = "http://127.0.0.1:" + srv.port;
      srv.close = () => new Promise(r => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); });
      resolve(srv);
    });
  });
}

module.exports = { start, loadLookups };

if (require.main === module) {
  const ROOT = path.resolve(__dirname, "..", "..");
  const port = +process.argv[2] || 8787;
  const lf = path.resolve(process.argv[3] || path.join(ROOT, "work/20261121-nw-sang-circa-kiem-ke/phien/qr-lookup.json"));
  start({ port, lookupFile: lf }).then(srv => {
    console.log("máy chủ giả Circa:", srv.url, "· lookup", lf, "(" + srv.lookups.size + " mã)");
    console.log("mở: build/nw-sang-circa.html?api=" + srv.url);
  });
}
