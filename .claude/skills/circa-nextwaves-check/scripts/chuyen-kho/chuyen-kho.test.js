#!/usr/bin/env node
/*
 * chuyen-kho.test.js: test offline cho chuyen-kho.js. KHÔNG gọi NW thật, KHÔNG ghi vào records/nw-writes thật.
 * Dựng máy chủ giả http trên 127.0.0.1 (thẻ, sổ kho, phiếu chuyển), chạy chuyen-kho.js như tiến trình con với
 * NW_BASE=http://127.0.0.1:<port>, CK_DIR / CK_SO / CK_LIST / CK_LEDGER trỏ vào thư mục tạm.
 * Cách dùng: node chuyen-kho.test.js        (mã thoát 0 = mọi ca đạt)
 * Máy chủ giả chia đều quantity của một dòng cho các EPC của dòng như NW thật (ca I tái hiện phiếu INT/00007 của lo-02,
 * rồi `tach` và chạy trọn các lô con cùng cỡ); ca J kiểm điều kiện state của `tach`.
 */
"use strict";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const SCRIPT = path.join(__dirname, "chuyen-kho.js");
const SO_THAT = path.resolve(__dirname, "..", "..", "records", "nw-writes");
const LUM = "3f7bd541-7370-4ce0-9048-231cf061e91a";
const TV = "7b9fde8f-a55a-4c48-ac58-0e3b4cdbd2b7";
const KEY = "test-key-SECRET-0123456789";
const PREFIX = "20261123-chuyen-kho-lumina-tamviet";

const mk = (p, n) => (p + "0".repeat(24)).slice(0, 22) + n;
const P = {
  A: { id: "aaaaaaaa-0000-4000-8000-00000000000a", circa: "101", ten: "SP A 1 thẻ SL1 có thẻ ngoài DS", the: [[mk("AAAA", "01"), 1]], ngoai: [[mk("AAAA", "F1"), 1], [mk("AAAA", "F2"), 1]] },
  B: { id: "bbbbbbbb-0000-4000-8000-00000000000b", circa: "102", ten: "SP B 1 thẻ SL1", the: [[mk("BBBB", "01"), 1]], ngoai: [] },
  C: { id: "cccccccc-0000-4000-8000-00000000000c", circa: "103", ten: "SP C 1 thẻ SL5", the: [[mk("CCCC", "01"), 5]], ngoai: [[mk("CCCC", "F1"), 5]] },
  D: { id: "dddddddd-0000-4000-8000-00000000000d", circa: "104", ten: "SP D 1 thẻ SL10", the: [[mk("DDDD", "01"), 10]], ngoai: [] },
  E: { id: "eeeeeeee-0000-4000-8000-00000000000e", circa: "105", ten: "SP E 3 thẻ SL1", the: [[mk("EEEE", "01"), 1], [mk("EEEE", "02"), 1], [mk("EEEE", "03"), 1]], ngoai: [[mk("EEEE", "F1"), 1]] },
  F: { id: "ffffffff-0000-4000-8000-00000000000f", circa: "106", ten: "SP F 2 thẻ SL10", the: [[mk("FFFF", "01"), 10], [mk("FFFF", "02"), 10]], ngoai: [] },
};

// Bộ SP mô phỏng lo-02 thật (23/11): 19 SP một cỡ (55 EPC, tổng 1.132) + 2007233 lẫn cỡ 5 thẻ SL 1/10/1/1/10 (quantity 23),
// thêm 2 SP cho lô thu và 1 SP (SL 10) rơi sang lô khác. CK_MAX_EPC=60 → thu: Q01+Q02, lo-01: 20 SP mô phỏng lo-02, lo-02: Q03.
const pidQ = (i) => `${(0x10000000 + i).toString(16)}-0000-4000-8000-${String(i).padStart(12, "0")}`;
const epcQ = (i, n) => mk("9" + i.toString(16).padStart(3, "0"), String(n).padStart(2, "0")).toUpperCase();
const HINH_LO02 = [ // [mã Circa, SL từng thẻ…], thứ tự thẻ theo EPC tăng dần
  ["2544", 1, 1], ["3078", 1, 1], ["3383", 1, 1], ["5725", 1, 1, 1, 1], ["6508", 1, 1, 1, 1], ["6534", 1, 1, 1], ["8742", 1, 1], ["8849", 1, 1],
  ["9926", 1, 1, 1], ["10753", 1, 1], ["10754", 1, 1], ["10908", 1, 1], ["13150", 1, 1], ["83821", 1, 1, 1, 1], ["136660", 1, 1, 1],
  ["373767", 50, 50, 50, 50], ["596025", 160, 160, 160, 160], ["2007233", 1, 10, 1, 1, 10], ["2008574", 50, 50, 50, 50, 50], ["2020492", 1, 1, 1],
];
const Q = {
  Q01: { id: pidQ(1), circa: "11", ten: "Q01 1 thẻ SL1 có thẻ ngoài DS", the: [[epcQ(1, 1), 1]], ngoai: [[epcQ(1, 91), 1], [epcQ(1, 92), 1]] },
  Q02: { id: pidQ(2), circa: "12", ten: "Q02 1 thẻ SL5", the: [[epcQ(2, 1), 5]], ngoai: [] },
  Q03: { id: pidQ(3), circa: "13", ten: "Q03 1 thẻ SL10 (lô khác)", the: [[epcQ(3, 1), 10]], ngoai: [] },
};
HINH_LO02.forEach(([circa, ...sl], k) => {
  const i = 10 + k;
  Q["S" + circa] = { id: pidQ(i), circa, ten: `SP ${circa} (${sl.join("/")})`, the: sl.map((s, j) => [epcQ(i, j + 1), s]), ngoai: circa === "373767" || circa === "3078" ? [[epcQ(i, 91), sl[0]]] : [] };
});
const PID_LAN = Q.S2007233.id;
const EPC_LAN = Q.S2007233.the; // [[epc, sl]] 1/10/1/1/10

// ---------- thế giới giả ----------
// NW giả CHIA ĐỀU quantity của một dòng sổ kho cho các EPC của dòng (soDu = Σ quantity / số EPC), như NW thật đã làm
// với phiếu INT/00007: dòng phiếu nhiều EPC khác cỡ → số dư từng thẻ sai; dòng cùng cỡ → đúng.
let W;
let SP = P;
function moiTheGioi(bo) {
  SP = bo || P;
  W = { tags: {}, ledger: [], ln: 1000, transfers: {}, order: [], idem: {}, seq: 0, sc: {}, reqs: [], hangs: [] };
  for (const p of Object.values(SP)) {
    for (const [epc, sl] of p.the.concat(p.ngoai)) {
      W.tags[epc] = { epc, productId: p.id, status: "active", homeWarehouseId: LUM };
      W.ledger.push({ ledgerNumber: ++W.ln, productId: p.id, warehouseId: LUM, quantity: sl, actionType: "stock_in", actionReference: "LUM/IN/" + W.ln, epcs: [epc] });
    }
  }
}
const soDu = (epc, wh) => W.ledger.filter((r) => r.warehouseId === wh && r.epcs.includes(epc)).reduce((t, r) => t + r.quantity / r.epcs.length, 0);
const ton = (pid, wh) => W.ledger.filter((r) => r.warehouseId === wh && r.productId === pid).reduce((t, r) => t + r.quantity, 0);
const demReq = (m, re) => W.reqs.filter((r) => r.method === m && re.test(r.path)).length;

function server() {
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const u = new URL(req.url, "http://x");
      const p = u.pathname.replace(/^\/api\/v1\/public/, "");
      const body = raw ? JSON.parse(raw) : undefined;
      W.reqs.push({ method: req.method, path: p, idem: req.headers["idempotency-key"], auth: req.headers.authorization, body });
      const send = (st, obj, h) => { res.writeHead(st, Object.assign({ "content-type": "application/json" }, h || {})); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== "Bearer " + KEY) return send(401, { message: "unauthorized" });
      let m;
      if (req.method === "POST" && p === "/tags/search") return send(201, { data: (body.epcs || []).map((e) => W.tags[e]).filter(Boolean), meta: {} });
      if (req.method === "GET" && (m = p.match(/^\/tags\/([^/]+)\/check$/))) {
        const t = W.tags[m[1]];
        if (!t) return send(404, { message: "TAG_NOT_FOUND" });
        const wh = u.searchParams.get("warehouseId");
        return send(200, { epc: t.epc, tagStatus: t.status, warehouse: { id: wh, name: null }, epcLedgerBalance: soDu(t.epc, wh) });
      }
      if (req.method === "GET" && p === "/stock/summary") {
        const s = ton(u.searchParams.get("productId"), u.searchParams.get("warehouseId"));
        return send(200, { systemStock: s, rfidStock: s, untaggedStock: 0, discrepancy: 0 });
      }
      if (req.method === "GET" && p === "/stock/ledger") {
        const pid = u.searchParams.get("productId"), wh = u.searchParams.get("warehouseId");
        const after = Number(u.searchParams.get("afterLedgerNumber") || 0), lim = Number(u.searchParams.get("limit") || 200);
        const rows = W.ledger.filter((r) => r.productId === pid && r.warehouseId === wh && r.ledgerNumber > after).sort((a, b) => a.ledgerNumber - b.ledgerNumber).slice(0, lim);
        return send(200, { data: rows, nextAfter: rows.length ? rows[rows.length - 1].ledgerNumber : after });
      }
      if (req.method === "GET" && p === "/stock-transfers") return send(200, { data: W.order.map((id) => W.transfers[id]), nextCursor: null, serverTime: new Date().toISOString() });
      if (req.method === "GET" && (m = p.match(/^\/stock-transfers\/([^/]+)$/))) {
        const t = W.transfers[m[1]];
        return t ? send(200, t) : send(404, { message: "STOCK_TRANSFER_NOT_FOUND" });
      }
      if (req.method === "POST" && p === "/stock-transfers") {
        const key = req.headers["idempotency-key"];
        if (W.sc.create400) return send(400, { message: ["items.0.quantity must not be less than 0.0001"], error: "Bad Request", statusCode: 400 });
        if (key && W.idem[key]) return send(201, W.idem[key], { "idempotent-replay": "true" });
        const tao = () => {
          const id = crypto.randomUUID();
          const t = {
            id, transferNumber: "LUM/INT/" + String(++W.seq).padStart(5, "0"), status: "DRAFT", sourceWarehouseId: body.sourceWarehouseId, destinationWarehouseId: body.destinationWarehouseId,
            notes: body.notes, cancelReason: null, actionReference: null,
            items: body.items.map((it) => ({ id: crypto.randomUUID(), productId: it.productId, quantity: it.quantity, receivedQuantity: null, epcs: it.epcs.slice(), receivedEpcs: null, epcAmounts: Object.fromEntries(it.epcs.map((e) => [e, soDu(e, body.sourceWarehouseId)])) })),
          };
          if (W.sc.lech) { const it = t.items[t.items.length - 1]; const e = it.epcs.pop(); delete it.epcAmounts[e]; }
          W.transfers[id] = t;
          W.order.push(id);
          if (key) W.idem[key] = JSON.parse(JSON.stringify(t));
          return t;
        };
        if (W.sc.timeout) {
          if (W.sc.timeout === "tao-roi-im") tao();
          W.hangs.push(setTimeout(() => req.socket.destroy(), 1500));
          return;
        }
        return send(201, tao());
      }
      if (req.method === "POST" && (m = p.match(/^\/stock-transfers\/([^/]+)\/(submit|complete|cancel)$/))) {
        const t = W.transfers[m[1]];
        if (!t) return send(404, { message: "STOCK_TRANSFER_NOT_FOUND" });
        const buoc = m[2];
        if (buoc === "submit") {
          if (t.status !== "DRAFT") return send(400, { message: "STOCK_TRANSFER_INVALID_STATUS", statusCode: 400 });
          for (const it of t.items) {
            let epcs = it.epcs;
            if (W.sc.truNham === it.productId) { // NW giả trừ theo số lượng: lấy thẻ ngoài DS thay cho 1 thẻ trong DS
              const pp = Object.values(SP).find((x) => x.id === it.productId);
              epcs = it.epcs.slice(1).concat([pp.ngoai[0][0]]);
            }
            W.ledger.push({ ledgerNumber: ++W.ln, productId: it.productId, warehouseId: t.sourceWarehouseId, quantity: -it.quantity, actionType: "transfer", actionReference: t.transferNumber, epcs });
            for (const e of epcs) W.tags[e].status = "transferred";
            it.epcsThat = epcs;
          }
          t.status = "SUBMITTED";
          t.actionReference = t.transferNumber;
          return send(201, t);
        }
        if (buoc === "complete") {
          if (!["SUBMITTED", "IN_TRANSIT"].includes(t.status)) return send(400, { message: "STOCK_TRANSFER_INVALID_STATUS", statusCode: 400 });
          for (const ci of body.items) {
            const it = t.items.find((x) => x.id === ci.itemId);
            if (!it) return send(400, { message: "ITEM_NOT_FOUND" });
            W.ledger.push({ ledgerNumber: ++W.ln, productId: it.productId, warehouseId: t.destinationWarehouseId, quantity: ci.receivedQuantity, actionType: "transfer", actionReference: t.transferNumber, epcs: ci.receivedEpcs });
            for (const e of ci.receivedEpcs) Object.assign(W.tags[e], { status: "active", homeWarehouseId: t.destinationWarehouseId });
            it.receivedQuantity = ci.receivedQuantity;
            it.receivedEpcs = ci.receivedEpcs.slice();
          }
          t.status = "COMPLETED";
          return send(201, t);
        }
        if (!["DRAFT", "SUBMITTED", "IN_TRANSIT"].includes(t.status)) return send(400, { message: "STOCK_TRANSFER_INVALID_STATUS", statusCode: 400 });
        if (t.status !== "DRAFT") {
          for (const it of t.items) {
            const epcs = it.epcsThat || it.epcs;
            W.ledger.push({ ledgerNumber: ++W.ln, productId: it.productId, warehouseId: t.sourceWarehouseId, quantity: it.quantity, actionType: "transfer", actionReference: t.transferNumber, epcs });
            for (const e of epcs) Object.assign(W.tags[e], { status: "active", homeWarehouseId: t.sourceWarehouseId });
          }
        }
        t.status = "CANCELLED";
        t.cancelReason = body && body.reason;
        return send(201, t);
      }
      send(404, { message: "NO_ROUTE " + req.method + " " + p });
    });
  });
}

// ---------- chạy script ----------
let PORT;
const TAM = [];
function moiThuMuc() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ck-test-"));
  TAM.push(d);
  const list = [];
  for (const p of Object.values(SP)) for (const [epc, sl] of p.the) list.push({ epc, productId: p.id, circaProductId: p.circa, tenSP: p.ten, slLedger: sl, epcLedgerBalance: sl });
  fs.writeFileSync(path.join(d, "list.json"), JSON.stringify(list));
  fs.writeFileSync(path.join(d, "ledger.json"), JSON.stringify({ pulledAt: new Date().toISOString(), rows: W.ledger }));
  fs.mkdirSync(path.join(d, "so"));
  return d;
}
function envCho(d, them) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (k !== "NW_KEY" && !k.startsWith("CK_") && k !== "NW_BASE") e[k] = v;
  return Object.assign(e, {
    NW_BASE: "http://127.0.0.1:" + PORT, NW_KEY: KEY, CK_DIR: path.join(d, "out"), CK_SO: path.join(d, "so"), CK_LIST: path.join(d, "list.json"),
    CK_LEDGER: path.join(d, "ledger.json"), CK_EXPECT: "9:40", CK_MAX_EPC: "3", CK_PACE_MS: "0", CK_BACKOFF_MS: "5", CK_TIMEOUT_MS: "4000",
  }, them || {});
}
function chay(d, args, them) {
  return new Promise((res) => {
    const c = spawn(process.execPath, [SCRIPT, ...args], { env: envCho(d, them), cwd: d });
    let out = "";
    c.stdout.on("data", (x) => (out += x));
    c.stderr.on("data", (x) => (out += x));
    c.on("close", (code) => res({ code, out }));
  });
}

// ---------- kiểm ----------
let DAT = 0, LOI = 0;
function ok(cond, ten, chiTiet) {
  if (cond) { DAT++; console.log("  đạt  " + ten); }
  else { LOI++; console.log("  LỖI  " + ten + (chiTiet ? "\n        " + String(chiTiet).split("\n").slice(-12).join("\n        ") : "")); }
}
const files = (d) => fs.readdirSync(path.join(d, "so")).sort();
const plan = (d) => JSON.parse(fs.readFileSync(path.join(d, "out", "plan.json"), "utf8"));
const state = (d, lo) => JSON.parse(fs.readFileSync(path.join(d, "out", lo + ".state.json"), "utf8"));
const posts = (re) => demReq("POST", re);
const RE_TAO = /^\/stock-transfers$/;

async function caA() {
  console.log("Ca A: plan → kiem → chạy khô → tạo → gửi → nhận → soát đạt; từ chối chạy lại bước đã xong");
  moiTheGioi();
  const d = moiThuMuc();
  let r = await chay(d, ["plan"]);
  ok(r.code === 0, "plan exit 0", r.out);
  const p = plan(d);
  ok(p.lots[0].lo === "thu" && p.lots[0].lines.map((x) => x.circaProductId).join(",") === "101,103", "lô thu = SP 101 (1 thẻ SL1, có thẻ ngoài DS) + SP 103 (1 thẻ SL5)", p.lots[0].lines.map((x) => x.circaProductId));
  ok(p.lots.map((l) => l.lo + ":" + l.lines.map((x) => x.circaProductId).join("+")).join(" ") === "thu:101+103 lo-01:105 lo-02:102+106 lo-03:104", "chia lô tất định, mỗi lô ≤ 3 EPC", p.lots.map((l) => l.lo + ":" + l.lines.map((x) => x.circaProductId).join("+")).join(" "));
  const raw1 = fs.readFileSync(path.join(d, "out", "plan.json"), "utf8");
  r = await chay(d, ["plan"]);
  ok(r.code === 0 && /khớp kế hoạch lập lại/.test(r.out) && fs.readFileSync(path.join(d, "out", "plan.json"), "utf8") === raw1, "plan lần 2 không ghi đè, báo khớp", r.out);
  ok(W.reqs.length === 0, "plan không gọi mạng");
  r = await chay(d, ["kiem", "thu"]);
  ok(r.code === 0 && /KIỂM ĐẠT/.test(r.out), "kiem thu đạt", r.out);
  const n0 = W.reqs.length;
  for (const c of ["tao", "gui", "nhan", "huy"]) {
    r = await chay(d, [c, "thu"]);
    ok(r.code === 0 && /CHẠY KHÔ/.test(r.out) && /POST ghi 0/.test(r.out), `${c} thu không --ghi: chạy khô`, r.out);
  }
  ok(W.reqs.length === n0, "chạy khô: máy chủ không nhận request nào", W.reqs.length - n0);
  ok(files(d).length === 0, "chạy khô: không ghi sổ");
  r = await chay(d, ["tao", "thu", "--ghi"]);
  ok(r.code === 0 && /ĐẠT: phiếu .* DRAFT khớp/.test(r.out), "tao thu --ghi đạt", r.out);
  ok(posts(RE_TAO) === 1, "tao: đúng 1 POST");
  const ptao = W.reqs.find((x) => x.method === "POST" && RE_TAO.test(x.path));
  ok(ptao.body.clientOperationId === p.lots[0].op.tao && ptao.idem === p.lots[0].op.tao, "tao: clientOperationId + Idempotency-Key = op.tao của plan");
  ok(Object.keys(ptao.body).sort().join(",") === "clientOperationId,destinationWarehouseId,items,notes,sourceWarehouseId" && ptao.body.items.every((i) => Object.keys(i).sort().join(",") === "epcs,productId,quantity"), "tao: body không có trường lạ");
  const s1 = state(d, "thu");
  ok(s1.soKhop === true && s1.items.every((x) => x.itemId), "state: soKhop + itemId từng dòng");
  r = await chay(d, ["gui", "thu", "--ghi"]);
  ok(r.code === 0 && /ĐẠT: phiếu .* SUBMITTED/.test(r.out), "gui thu --ghi đạt (thẻ ngoài DS không đổi)", r.out);
  r = await chay(d, ["nhan", "thu", "--ghi"]);
  ok(r.code === 0 && /COMPLETED, số nhận = số gửi/.test(r.out), "nhan thu --ghi đạt", r.out);
  r = await chay(d, ["soat", "thu"]);
  ok(r.code === 0 && /→ ĐẠT/.test(r.out), "soat thu đạt", r.out);
  const so = JSON.parse(fs.readFileSync(path.join(d, "out", "thu.soat.json"), "utf8"));
  ok(so.dat === true && so.the.length === 2, "thu.soat.json dat=true, 2 thẻ");
  const truoc = W.reqs.filter((x) => x.method === "POST" && x.path !== "/tags/search").length;
  for (const c of ["tao", "gui", "nhan"]) {
    r = await chay(d, [c, "thu", "--ghi"]);
    ok(r.code === 1 && /không chạy lại/.test(r.out), `${c} thu --ghi lần 2: từ chối`, r.out);
  }
  ok(W.reqs.filter((x) => x.method === "POST" && x.path !== "/tags/search").length === truoc, "từ chối chạy lại: không POST thêm");
  const f = files(d);
  ok(f.join(",") === ["gui", "nhan", "tao"].flatMap((b) => [`${PREFIX}-thu-${b}.payload.json`, `${PREFIX}-thu-${b}.record.json`]).join(","), "sổ: payload + record cho 3 bước", f);
  const all = f.map((x) => fs.readFileSync(path.join(d, "so", x), "utf8")).join("\n") + fs.readdirSync(path.join(d, "out")).map((x) => fs.readFileSync(path.join(d, "out", x), "utf8")).join("\n");
  ok(!all.includes(KEY) && /Bearer \*\*\*/.test(all), "không file nào chứa khoá; header authorization đã che");
  r = await chay(d, ["trang-thai"]);
  ok(r.code === 0 && /COMPLETED/.test(r.out), "trang-thai đọc được", r.out);
}

async function caB() {
  console.log("Ca B: phiếu tạo ra lệch dòng → dừng, không gửi");
  moiTheGioi();
  const d = moiThuMuc();
  await chay(d, ["plan"]);
  W.sc.lech = true;
  let r = await chay(d, ["tao", "thu", "--ghi"]);
  ok(r.code === 1 && /LỆCH: .*phiếu thiếu 1 EPC/.test(r.out) && /PHIẾU TẠO RA LỆCH/.test(r.out), "tao: phát hiện phiếu thiếu EPC, exit 1", r.out);
  ok(state(d, "thu").soKhop === false, "state.soKhop = false");
  W.sc.lech = false;
  r = await chay(d, ["gui", "thu", "--ghi"]);
  ok(r.code === 1 && posts(/submit$/) === 0, "gui sau phiếu lệch: từ chối, không submit", r.out);
}

async function caC() {
  console.log("Ca C: timeout ở bước tạo (NW chưa tạo) → không gửi lại; lần sau dùng lại clientOperationId");
  moiTheGioi();
  const d = moiThuMuc();
  await chay(d, ["plan"]);
  const op = plan(d).lots[0].op.tao;
  W.sc.timeout = "im";
  let r = await chay(d, ["tao", "thu", "--ghi"], { CK_TIMEOUT_MS: "400" });
  ok(r.code === 3 && /KHÔNG RÕ/.test(r.out), "timeout → exit 3, báo không rõ", r.out);
  ok(posts(RE_TAO) === 1, "chỉ 1 POST, không tự gửi lại");
  const rec = JSON.parse(fs.readFileSync(path.join(d, "so", `${PREFIX}-thu-tao.record.json`), "utf8"));
  ok(rec.ketQua === "khong-ro" && rec.transport === "timeout", "record ghi kết quả không rõ (timeout)");
  ok(state(d, "thu").buoc.tao.trangThai === "khong-ro", "state bước tạo = khong-ro");
  W.sc.timeout = null;
  r = await chay(d, ["tao", "thu", "--ghi"]);
  ok(r.code === 0, "chạy lại: tạo được", r.out);
  const ps = W.reqs.filter((x) => x.method === "POST" && RE_TAO.test(x.path));
  ok(ps.length === 2 && ps.every((x) => x.body.clientOperationId === op && x.idem === op), "lần 2 dùng lại đúng clientOperationId + Idempotency-Key của plan");
  ok(fs.existsSync(path.join(d, "so", `${PREFIX}-thu-tao-lan2.payload.json`)) && fs.existsSync(path.join(d, "so", `${PREFIX}-thu-tao-lan2.record.json`)), "lần 2 ghi sổ tên mới -lan2, không đè lần 1");
  ok(Object.keys(W.transfers).length === 1, "NW giả chỉ có 1 phiếu");
}

async function caD() {
  console.log("Ca D: timeout ở bước tạo (NW đã tạo) → lần sau nhận lại phiếu, không POST");
  moiTheGioi();
  const d = moiThuMuc();
  await chay(d, ["plan"]);
  W.sc.timeout = "tao-roi-im";
  let r = await chay(d, ["tao", "thu", "--ghi"], { CK_TIMEOUT_MS: "400" });
  ok(r.code === 3, "timeout → exit 3", r.out);
  W.sc.timeout = null;
  r = await chay(d, ["trang-thai"]);
  ok(/TÌM THẤY phiếu mang dấu op: LUM\/INT\/00001 DRAFT/.test(r.out), "trang-thai tìm thấy phiếu theo dấu op trong notes", r.out);
  r = await chay(d, ["tao", "thu", "--ghi"]);
  ok(r.code === 0 && /KHÔNG gửi lại; nhận phiếu này/.test(r.out), "chạy lại: nhận phiếu đã tạo, exit 0", r.out);
  ok(posts(RE_TAO) === 1 && Object.keys(W.transfers).length === 1, "tổng cộng 1 POST, 1 phiếu");
  ok(state(d, "thu").transferId === W.order[0], "state.transferId = phiếu đã tạo");
}

async function caE() {
  console.log("Ca E: 400 ở bước tạo → dừng, không cho chạy lại");
  moiTheGioi();
  const d = moiThuMuc();
  await chay(d, ["plan"]);
  W.sc.create400 = true;
  let r = await chay(d, ["tao", "thu", "--ghi"]);
  ok(r.code === 4 && /NW TỪ CHỐI: HTTP 400/.test(r.out) && /must not be less/.test(r.out), "400 → exit 4, in status + body", r.out);
  const rec = JSON.parse(fs.readFileSync(path.join(d, "so", `${PREFIX}-thu-tao.record.json`), "utf8"));
  ok(rec.ketQua === "tu-choi" && rec.response.status === 400, "record ghi 400");
  W.sc.create400 = false;
  r = await chay(d, ["tao", "thu", "--ghi"]);
  ok(r.code === 1 && /không chạy lại/.test(r.out) && posts(RE_TAO) === 1, "chạy lại sau 400: từ chối, không POST", r.out);
}

async function caF() {
  console.log("Ca F: không ghi đè file sổ");
  moiTheGioi();
  const d = moiThuMuc();
  await chay(d, ["plan"]);
  const f = path.join(d, "so", `${PREFIX}-thu-tao.payload.json`);
  fs.writeFileSync(f, "X");
  const r = await chay(d, ["tao", "thu", "--ghi"]);
  ok(r.code === 1 && /File sổ đã tồn tại/.test(r.out), "file sổ đã có → dừng", r.out);
  ok(fs.readFileSync(f, "utf8") === "X" && posts(RE_TAO) === 0, "file giữ nguyên, không POST");
}

async function caG() {
  console.log("Ca G: NW giả trừ nhầm thẻ ngoài DS sau submit → gui báo lỗi, nhan từ chối, huy được");
  moiTheGioi();
  const d = moiThuMuc();
  await chay(d, ["plan"]);
  let r = await chay(d, ["tao", "lo-01", "--ghi"]);
  ok(r.code === 0, "tao lo-01 (SP 105, có 1 thẻ ngoài DS) đạt", r.out);
  W.sc.truNham = P.E.id;
  r = await chay(d, ["gui", "lo-01", "--ghi"]);
  ok(r.code === 1 && /phiếu trừ thẻ NGOÀI danh sách tại Lumina: EEEE0+F1/.test(r.out) && /thẻ ngoài DS EEEE0+F1/.test(r.out) && /huy lo-01 --ghi/.test(r.out), "gui: phát hiện trừ nhầm thẻ ngoài DS, gợi ý huy, exit 1", r.out);
  ok(/số dư tại Lumina còn 1/.test(r.out), "gui: thẻ trong DS chưa rời Lumina bị báo");
  r = await chay(d, ["nhan", "lo-01", "--ghi"]);
  ok(r.code === 1 && /CHƯA ĐẠT/.test(r.out) && posts(/complete$/) === 0, "nhan: từ chối khi kiểm sau gửi chưa đạt", r.out);
  r = await chay(d, ["huy", "lo-01", "--ghi"]);
  ok(r.code === 1 && /--ly-do/.test(r.out) && posts(/cancel$/) === 0, "huy thiếu --ly-do: từ chối", r.out);
  r = await chay(d, ["huy", "lo-01", "--ghi", "--ly-do", "NW tru nham the ngoai DS"]);
  ok(r.code === 0 && /CANCELLED/.test(r.out) && W.transfers[W.order[0]].status === "CANCELLED", "huy --ghi: phiếu CANCELLED", r.out);
}

async function caH() {
  console.log("Ca H: chặn cấu hình nguy hiểm");
  moiTheGioi();
  const d = moiThuMuc();
  let r = await chay(d, ["plan"], { NW_BASE: "http://example.com" });
  ok(r.code === 1 && /NW_BASE chỉ được/.test(r.out), "NW_BASE lạ → từ chối", r.out);
  r = await chay(d, ["plan"], { CK_SO: SO_THAT });
  ok(r.code === 1 && /không được trỏ vào sổ thật/.test(r.out), "máy chủ giả + CK_SO = sổ thật → từ chối", r.out);
  r = await chay(d, ["plan"], { CK_LEDGER: path.join(d, "khong-co.json") });
  ok(r.code === 0 && /giữ tiêu chí cũ/.test(r.out), "không có sổ kho offline → lô thu giữ tiêu chí cũ, có ghi chú", r.out);
  ok(W.reqs.length === 0, "không request nào");
}

// ---------- tách lô lẫn cỡ thẻ ----------
const ENV_Q = { CK_EXPECT: "63:1171", CK_MAX_EPC: "60" };
const chayQ = (d, args, them) => chay(d, args, Object.assign({}, ENV_Q, them || {}));
const rawPlan = (d) => fs.readFileSync(path.join(d, "out", "plan.json"), "utf8");
const lotOf = (p, lo) => p.lots.find((l) => l.lo === lo);
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const ghiState = (d, lo, st) => fs.writeFileSync(path.join(d, "out", lo + ".state.json"), JSON.stringify(st, null, 1));
async function postGia(p, body, idem) { // harness gọi thẳng máy chủ giả (không qua script)
  const r = await fetch("http://127.0.0.1:" + PORT + p, { method: "POST", headers: { authorization: "Bearer " + KEY, "content-type": "application/json", "idempotency-key": idem }, body: JSON.stringify(body) });
  return r.json();
}

async function caI() {
  console.log("Ca I: lô mô phỏng lo-02 (2007233 lẫn cỡ 1/10/1/1/10): plan/tao từ chối; phiếu cũ submit → NW giả chia đều → gui bắt lỗi; huỷ → tach → 3 lô; lô cùng cỡ chạy trọn đạt");
  moiTheGioi(Q);
  const d = moiThuMuc();
  let r = await chayQ(d, ["plan"]);
  ok(r.code === 1 && /KHÔNG ĐẠT: lô lo-01 có dòng lẫn cỡ thẻ: CIRCA 2007233 \(5 EPC, SL\/thẻ 1\/10\/1\/1\/10, quantity 23\)/.test(r.out) && /tach lo-01/.test(r.out), "plan mới: ghi plan.json nhưng báo KHÔNG ĐẠT lô lẫn cỡ, chỉ cách tach (exit 1)", r.out);
  const p0 = plan(d);
  const l01 = lotOf(p0, "lo-01");
  ok(p0.lots.map((l) => `${l.lo}:${l.soDong}/${l.soEpc}/${l.tongSL}`).join(" ") === "thu:2/2/6 lo-01:20/60/1155 lo-02:1/1/10", "plan giả: thu 2 SP · lo-01 = 20 SP / 60 EPC / 1.155 (như lo-02 thật) · lo-02 = SP khác", p0.lots.map((l) => `${l.lo}:${l.soDong}/${l.soEpc}/${l.tongSL}`).join(" "));
  const raw0 = rawPlan(d);
  r = await chayQ(d, ["plan"]);
  ok(r.code === 1 && /khớp kế hoạch lập lại/.test(r.out) && /tach lo-01/.test(r.out) && rawPlan(d) === raw0, "plan lần 2: khớp, không ghi đè, vẫn báo lẫn cỡ", r.out);
  const n0 = W.reqs.length;
  r = await chayQ(d, ["tao", "lo-01"]);
  ok(r.code === 1 && /dòng lẫn cỡ thẻ/.test(r.out) && /tach lo-01/.test(r.out) && !/CHẠY KHÔ/.test(r.out), "tao lo-01 chạy khô: từ chối dòng lẫn cỡ, báo dùng tach", r.out);
  r = await chayQ(d, ["tao", "lo-01", "--ghi"]);
  ok(r.code === 1 && /dòng lẫn cỡ thẻ/.test(r.out) && W.reqs.length === n0 && files(d).length === 0, "tao lo-01 --ghi: từ chối, không request, không sổ", r.out);
  r = await chayQ(d, ["tach", "lo-02"]);
  ok(r.code === 1 && /không có dòng lẫn cỡ/.test(r.out), "tach lo-02 (không lẫn cỡ): từ chối", r.out);
  r = await chayQ(d, ["tach", "thu"]);
  ok(r.code === 1 && /chỉ nhận lô gốc/.test(r.out) && rawPlan(d) === raw0, "tach thu: từ chối", r.out);

  // Tái hiện INT/00007: phiếu lẫn cỡ có từ trước khi có phép kiểm (harness tạo thẳng trên máy chủ giả + state tương ứng).
  const t = await postGia("/stock-transfers", { sourceWarehouseId: LUM, destinationWarehouseId: TV, notes: "op:" + l01.op.tao, items: l01.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, epcs: l.epcs })), clientOperationId: l01.op.tao }, l01.op.tao);
  ghiState(d, "lo-01", { lo: "lo-01", taoLuc: new Date().toISOString(), transferId: t.id, transferNumber: t.transferNumber, buoc: { tao: { trangThai: "thanh-cong", lan: [] } }, snap: {}, soKhop: true, items: l01.lines.map((l) => ({ productId: l.productId, circa: l.circaProductId, itemId: t.items.find((i) => i.productId === l.productId).id, quantity: l.quantity, soEpc: l.epcs.length })) });
  r = await chayQ(d, ["tach", "lo-01"]);
  ok(r.code === 1 && /chưa huỷ/.test(r.out) && rawPlan(d) === raw0, "tach khi phiếu còn DRAFT: từ chối", r.out);
  r = await chayQ(d, ["gui", "lo-01", "--ghi"]);
  ok(r.code === 1 && /SAU SUBMIT KHÔNG ĐẠT/.test(r.out) && /Thẻ trong DS: đạt 55\/60/.test(r.out), "gui phiếu lẫn cỡ: NW giả chia đều → kiểm sau submit KHÔNG ĐẠT, 55/60 thẻ đạt", r.out);
  const sd = EPC_LAN.map(([e]) => r6(soDu(e, LUM)));
  ok(sd.join("/") === "-3.6/5.4/-3.6/-3.6/5.4", "NW giả: số dư Lumina 5 thẻ 2007233 = −3,6 / 5,4 (như INT/00007 thật)", sd.join("/"));
  ok((r.out.match(/KHÔNG ĐẠT \S+ CIRCA 2007233 SL 1: số dư tại Lumina còn -3\.6/g) || []).length === 3 && (r.out.match(/CIRCA 2007233 SL 10: số dư tại Lumina còn 5\.4/g) || []).length === 2, "gui liệt kê đúng 3 thẻ −3,6 và 2 thẻ 5,4");
  r = await chayQ(d, ["tach", "lo-01"]);
  ok(r.code === 1 && /chưa huỷ/.test(r.out) && rawPlan(d) === raw0, "tach khi phiếu SUBMITTED: từ chối", r.out);
  r = await chayQ(d, ["huy", "lo-01", "--ghi", "--ly-do", "NW chia deu quantity"]);
  ok(r.code === 0 && /Thẻ về lại Lumina \(active, số dư = slLedger\): 60\/60/.test(r.out), "huy: phiếu CANCELLED, 60/60 thẻ về Lumina đúng số dư", r.out);
  ok(state(d, "lo-01").sauHuy && state(d, "lo-01").sauHuy.status === "CANCELLED", "huy ghi state.sauHuy = CANCELLED");

  const nTach = W.reqs.length;
  const soTruoc = files(d).join(",");
  r = await chayQ(d, ["tach", "lo-01"]);
  ok(r.code === 0 && /Đã tách lo-01 → lo-01a \(19 SP, 55 EPC, SL 1132\), lo-01b \(1 SP, 2 EPC, SL 20\), lo-01c \(1 SP, 3 EPC, SL 3\)/.test(r.out), "tach lo-01: exit 0, ra lo-01a 19 SP/55 EPC/1.132 · lo-01b 2 EPC/20 · lo-01c 3 EPC/3", r.out);
  ok(W.reqs.length === nTach && files(d).join(",") === soTruoc, "tach: không request mạng, không đụng sổ");
  const p1 = plan(d);
  const raw1 = rawPlan(d);
  const [a, b, c] = ["lo-01a", "lo-01b", "lo-01c"].map((x) => lotOf(p1, x));
  ok(a && b && c && p1.lots.map((l) => l.lo).join(",") === "thu,lo-01,lo-02,lo-01a,lo-01b,lo-01c", "plan: thêm 3 lô vào cuối, giữ thứ tự lô cũ", p1.lots.map((l) => l.lo).join(","));
  ok(b.lines.length === 1 && b.lines[0].circaProductId === "2007233" && b.lines[0].quantity === 20 && b.lines[0].epcs.join() === [EPC_LAN[1][0], EPC_LAN[4][0]].join() && Object.values(b.lines[0].slTheoEpc).every((v) => v === 10), "lo-01b = 2007233 cỡ 10: 2 EPC, quantity 20");
  ok(c.lines.length === 1 && c.lines[0].quantity === 3 && c.lines[0].epcs.join() === [EPC_LAN[0][0], EPC_LAN[2][0], EPC_LAN[3][0]].join() && Object.values(c.lines[0].slTheoEpc).every((v) => v === 1), "lo-01c = 2007233 cỡ 1: 3 EPC, quantity 3");
  ok(JSON.stringify(a.lines) === JSON.stringify(l01.lines.filter((x) => x.productId !== PID_LAN)) && !a.lines.some((x) => x.productId === PID_LAN), "lo-01a = 19 dòng một cỡ của lô gốc, nguyên nội dung, không có 2007233");
  const lg = lotOf(p1, "lo-01");
  ok(lg.daTach && lg.daTach.thanh.join(",") === "lo-01a,lo-01b,lo-01c" && lg.daTach.phieu.trangThai === "CANCELLED" && lg.daTach.phieu.transferId === t.id, "lô gốc đánh dấu daTach (lô con, phiếu CANCELLED)");
  const { daTach: _bo, ...lgBo } = lg;
  ok(JSON.stringify(lgBo) === JSON.stringify(l01), "lô gốc: ngoài daTach không đổi trường nào");
  ok([a, b, c].every((x) => x.tachTu === "lo-01") && new Set([a, b, c, l01].flatMap((x) => Object.values(x.op))).size === 16, "lô con: tachTu = lo-01, 12 UUID bước mới, khác UUID lô gốc");
  for (const lo of ["thu", "lo-02"]) ok(JSON.stringify(lotOf(p1, lo), null, 1) === JSON.stringify(lotOf(p0, lo), null, 1), `lô ${lo} không đổi (so byte)`);
  ok(Object.keys(p0).filter((k) => k !== "lots").every((k) => JSON.stringify(p0[k]) === JSON.stringify(p1[k])), "các trường khác của plan không đổi");
  const conLai = p1.lots.filter((l) => !l.daTach);
  const ep = conLai.flatMap((l) => l.lines.flatMap((x) => x.epcs));
  ok(ep.length === 63 && new Set(ep).size === 63 && r6(conLai.reduce((s, l) => s + l.tongSL, 0)) === 1171, "kiểm tổng: các lô chưa tách = 63 EPC, không trùng, tổng 1.171");
  ok(fs.readFileSync(path.join(d, "out", "plan.truoc-tach-lo-01.json"), "utf8") === raw0, "plan.truoc-tach-lo-01.json = plan trước khi tách");
  r = await chayQ(d, ["tach", "lo-01"]);
  ok(r.code === 1 && /đã tách/.test(r.out) && rawPlan(d) === raw1 && fs.readFileSync(path.join(d, "out", "plan.truoc-tach-lo-01.json"), "utf8") === raw0, "tach lần 2: từ chối, plan và bản cũ giữ nguyên", r.out);
  r = await chayQ(d, ["plan"]);
  ok(r.code === 0 && /khớp kế hoạch lập lại và cách tách lo-01 → lo-01a\/lo-01b\/lo-01c/.test(r.out) && /ĐÃ TÁCH → lo-01a, lo-01b, lo-01c/.test(r.out) && rawPlan(d) === raw1, "plan sau tách: khớp (cả cách tách), không ghi đè, exit 0", r.out);
  const n1 = W.reqs.length;
  for (const cmd of ["tao", "gui", "nhan"]) for (const g of [[], ["--ghi"]]) {
    r = await chayQ(d, [cmd, "lo-01", ...g]);
    ok(r.code === 1 && /ĐÃ TÁCH/.test(r.out), `${cmd} lo-01 ${g.join(" ") || "(chạy khô)"}: từ chối lô đã tách`, r.out);
  }
  ok(W.reqs.length === n1, "lô đã tách: không request nào");
  r = await chayQ(d, ["trang-thai"]);
  ok(r.code === 0 && /lo-01 .*CANCELLED.*ĐÃ TÁCH → lo-01a, lo-01b, lo-01c/.test(r.out) && /lo-01b .*tách từ lo-01 · CIRCA 2007233 cỡ 10/.test(r.out) && /Các lô chưa tách: 5 lô, 63 EPC, tổng SL 1171/.test(r.out), "trang-thai hiện rõ lô đã tách và lô con", r.out);

  // Dòng cùng cỡ với NW chia đều: đạt. Lô con cùng SP chạy tuần tự.
  r = await chayQ(d, ["kiem", "lo-01b"]);
  ok(r.code === 0 && /KIỂM ĐẠT/.test(r.out) && /đã huỷ .*INT\/00001/.test(r.out), "kiem lo-01b đạt (phiếu cũ hiện 'đã huỷ', không vướng)", r.out);
  r = await chayQ(d, ["tao", "lo-01b"]);
  ok(r.code === 0 && /CHẠY KHÔ/.test(r.out) && /"quantity": 20/.test(r.out), "tao lo-01b chạy khô: in payload quantity 20", r.out);
  for (const lo of ["lo-01b", "lo-01c"]) {
    r = await chayQ(d, ["tao", lo, "--ghi"]);
    ok(r.code === 0 && /DRAFT khớp/.test(r.out), `tao ${lo} --ghi đạt`, r.out);
  }
  r = await chayQ(d, ["gui", "lo-01b", "--ghi"]);
  ok(r.code === 0 && /ĐẠT: phiếu .* SUBMITTED/.test(r.out), "gui lo-01b (2 thẻ cỡ 10, NW giả chia đều 20/2) đạt", r.out);
  const nSub = posts(/submit$/);
  r = await chayQ(d, ["gui", "lo-01c", "--ghi"]);
  ok(r.code === 1 && /Lô khác cùng SP đã gửi mà chưa soát đạt: lo-01b/.test(r.out) && posts(/submit$/) === nSub, "gui lo-01c khi lo-01b chưa soát: từ chối, không submit", r.out);
  for (const [cmd, lo, re] of [["nhan", "lo-01b", /COMPLETED/], ["soat", "lo-01b", /→ ĐẠT/], ["gui", "lo-01c", /SUBMITTED/], ["nhan", "lo-01c", /COMPLETED/], ["soat", "lo-01c", /→ ĐẠT/],
    ["tao", "lo-01a", /DRAFT khớp/], ["gui", "lo-01a", /SUBMITTED/], ["nhan", "lo-01a", /COMPLETED/], ["soat", "lo-01a", /→ ĐẠT/]]) {
    r = await chayQ(d, [cmd, lo, ...(cmd === "soat" ? [] : ["--ghi"])]);
    ok(r.code === 0 && re.test(r.out), `${cmd} ${lo} đạt`, r.out);
  }
  const tv = EPC_LAN.map(([e]) => r6(soDu(e, TV))).join("/");
  const lum = EPC_LAN.map(([e]) => r6(soDu(e, LUM))).join("/");
  ok(tv === "1/10/1/1/10" && lum === "0/0/0/0/0", "2007233 sau 2 phiếu cùng cỡ: Tam Việt 1/10/1/1/10, Lumina 0", `TV ${tv} · LUM ${lum}`);
  const ngoai = [Q.S373767, Q.S3078, Q.Q01].flatMap((p) => p.ngoai.map(([e, s]) => [e, s]));
  ok(ngoai.every(([e, s]) => r6(soDu(e, LUM)) === s && W.tags[e].homeWarehouseId === LUM && W.tags[e].status === "active"), "thẻ ngoài DS: còn nguyên ở Lumina");
  ok(W.order.map((id) => W.transfers[id].status).join(",") === "CANCELLED,COMPLETED,COMPLETED,COMPLETED", "NW giả: 1 phiếu huỷ (lô gốc) + 3 phiếu COMPLETED (lô con)");
  ok(rawPlan(d) === raw1, "chạy các lô con không đổi plan.json");
}

async function caJ() {
  console.log("Ca J: tach chỉ chạy khi state cho thấy phiếu CANCELLED hoặc chưa từng tạo; bản cũ / danh sách đổi");
  moiTheGioi(Q);
  const mo = async () => { const d = moiThuMuc(); await chayQ(d, ["plan"]); return d; };
  const id = "11111111-2222-4333-8444-555555555555";
  let d = await mo();
  let raw = rawPlan(d);
  ghiState(d, "lo-01", { lo: "lo-01", transferId: null, buoc: { tao: { trangThai: "khong-ro", lan: [{ n: 1, ketQua: "khong-ro", http: "timeout" }] } }, snap: {} });
  let r = await chayQ(d, ["tach", "lo-01"]);
  ok(r.code === 1 && /không chắc phiếu chưa được tạo/.test(r.out) && rawPlan(d) === raw && !fs.existsSync(path.join(d, "out", "plan.truoc-tach-lo-01.json")), "tạo 'khong-ro', chưa có id: từ chối, không ghi gì", r.out);
  ghiState(d, "lo-01", { lo: "lo-01", transferId: id, transferNumber: "LUM/INT/X", buoc: { tao: { trangThai: "thanh-cong" }, gui: { trangThai: "thanh-cong" }, huy: { trangThai: "thanh-cong", lan: [{ n: 1, record: "rec-huy.json" }] } }, snap: {} });
  fs.writeFileSync(path.join(d, "so", "rec-huy.json"), JSON.stringify({ response: { status: 201, body: { id, status: "SUBMITTED" } } }));
  r = await chayQ(d, ["tach", "lo-01"]);
  ok(r.code === 1 && /không phải CANCELLED/.test(r.out) && rawPlan(d) === raw, "huỷ 'thanh-cong' nhưng record ghi SUBMITTED: từ chối", r.out);
  fs.unlinkSync(path.join(d, "so", "rec-huy.json"));
  r = await chayQ(d, ["tach", "lo-01"]);
  ok(r.code === 1 && /không có bằng chứng offline/.test(r.out) && rawPlan(d) === raw, "huỷ 'thanh-cong' mà không có record / sauHuy: từ chối", r.out);
  fs.writeFileSync(path.join(d, "so", "rec-huy.json"), JSON.stringify({ response: { status: 201, body: { id: "99999999-2222-4333-8444-555555555555", status: "CANCELLED" } } }));
  r = await chayQ(d, ["tach", "lo-01"]);
  ok(r.code === 1 && /là của phiếu/.test(r.out) && rawPlan(d) === raw, "record huỷ của phiếu khác: từ chối", r.out);
  fs.writeFileSync(path.join(d, "so", "rec-huy.json"), JSON.stringify({ response: { status: 201, body: { id, status: "CANCELLED" } } }));
  r = await chayQ(d, ["tach", "lo-01"]);
  ok(r.code === 0 && /đã CANCELLED \(record rec-huy\.json: HTTP 201, status CANCELLED\)/.test(r.out), "record huỷ CANCELLED đúng phiếu: tách được", r.out);

  d = await mo();
  raw = rawPlan(d);
  const bk = path.join(d, "out", "plan.truoc-tach-lo-01.json");
  fs.writeFileSync(bk, "X");
  r = await chayQ(d, ["tach", "lo-01"]);
  ok(r.code === 1 && /đã có và khác/.test(r.out) && rawPlan(d) === raw && fs.readFileSync(bk, "utf8") === "X", "bản plan.truoc-tach đã có và khác: không ghi đè, không tách", r.out);
  fs.writeFileSync(bk, raw);
  r = await chayQ(d, ["tach", "lo-01"]);
  ok(r.code === 0 && /đã có, trùng plan\.json hiện tại: giữ nguyên/.test(r.out) && /chưa từng tạo phiếu \(không có state\)/.test(r.out) && plan(d).lots.find((l) => l.lo === "lo-01").daTach.phieu.trangThai === "chua-tao", "không có state (chưa từng tạo phiếu) + bản cũ trùng: tách được", r.out);

  d = await mo();
  raw = rawPlan(d);
  ghiState(d, "lo-01", { lo: "lo-01", transferId: null, buoc: { tao: { trangThai: "tu-choi", lan: [{ n: 1, ketQua: "tu-choi", http: 400 }] } }, snap: {} });
  const list = JSON.parse(fs.readFileSync(path.join(d, "list.json"), "utf8"));
  list[0].tenSP += " (sửa)";
  fs.writeFileSync(path.join(d, "list.json"), JSON.stringify(list));
  r = await chayQ(d, ["tach", "lo-01"]);
  ok(r.code === 1 && /sha256 danh sách/.test(r.out) && rawPlan(d) === raw, "danh sách đổi sau khi lập plan: không tách, không ghi gì", r.out);
  list[0].tenSP = list[0].tenSP.replace(" (sửa)", "");
  fs.writeFileSync(path.join(d, "list.json"), JSON.stringify(list)); // cùng cách ghi với moiThuMuc → trùng byte, sha khớp lại
  r = await chayQ(d, ["tach", "lo-01"]);
  ok(r.code === 0 && /NW từ chối mọi lần tạo \(HTTP 400\)/.test(r.out), "NW từ chối mọi lần tạo (400), không có phiếu: tách được", r.out);
}

(async () => {
  const srv = server();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  PORT = srv.address().port;
  console.log("Máy chủ giả: http://127.0.0.1:" + PORT);
  try {
    for (const c of [caA, caB, caC, caD, caE, caF, caG, caH, caI, caJ]) await c();
  } finally {
    for (const h of W.hangs) clearTimeout(h);
    srv.closeAllConnections();
    srv.close();
  }
  console.log(`\nKẾT QUẢ: đạt ${DAT}, lỗi ${LOI}`);
  if (!LOI) for (const d of TAM) fs.rmSync(d, { recursive: true, force: true });
  else console.log("Giữ thư mục tạm để soát: " + TAM.join(" "));
  process.exitCode = LOI ? 1 : 0;
})();
