// KIỂM THỬ TRÌNH DUYỆT extension "Kiểm kê Circa ↔ NW" (BẢN THỬ) với MÁY CHỦ GIẢ (mock-ext-server.js, 4 cổng trên 127.0.0.1).
// Không gọi Circa / NW thật, không dùng token thật (token giả sinh mỗi lần chạy), dữ liệu GIẢ (demoFixture). Ghi ảnh + file tải về vào outDir.
//
// Dùng (cwd bất kỳ):
//   node tools/nw-sang-circa/test-ext-ui.js [outDir]
//   outDir mặc định work/20261122-kiem-ke-circa-nw-ext/out (ảnh → <outDir>/shots, file tải về → <outDir>/test-ext-ui, bản thử → <outDir>/ext-test)
//   Env: KB=A1,B1,… chỉ chạy các kịch bản đó; PW_CHROME=<chrome.exe> nếu không tìm được Chromium.
// Cần Playwright (require("playwright") hoặc bản trong %LOCALAPPDATA%/npm-cache/_npx) và Chromium ĐẦY ĐỦ (không phải headless shell:
// headless shell không nạp extension) trong %LOCALAPPDATA%/ms-playwright/chromium-*. Không tự tải gì từ mạng.
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const X = require("./mock-ext-server.js");
const B = require("./build-ext.js");
const NWC = require("./core.js");
const ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "work/20261122-kiem-ke-circa-nw-ext/out"));
const SHOTS = path.join(OUT, "shots"), TMPD = path.join(OUT, "test-ext-ui"), EXTD = path.join(OUT, "ext-test");
const ONLY = process.env.KB ? process.env.KB.split(",").map(s => s.trim()) : null;
const POS_X = "99999999-0000-4000-8000-000000000009";
fs.mkdirSync(SHOTS, { recursive: true }); fs.mkdirSync(TMPD, { recursive: true });
const { XLSX } = require(path.join(ROOT, ".claude/skills/circa-nextwaves-check/scripts/kiem-dem/load-tool.js"));

function loadPlaywright() {
  try { return require("playwright"); } catch (e) { /* tìm tiếp */ }
  const base = path.join(process.env.LOCALAPPDATA || "", "npm-cache", "_npx");
  if (fs.existsSync(base)) for (const d of fs.readdirSync(base)) {
    const p = path.join(base, d, "node_modules", "playwright");
    if (fs.existsSync(p)) { try { return require(p); } catch (e) { /* thử tiếp */ } }
  }
  return null;
}
function chromiumExe() {
  if (process.env.PW_CHROME) return process.env.PW_CHROME;
  const msp = path.join(process.env.LOCALAPPDATA || "", "ms-playwright");
  if (!fs.existsSync(msp)) return null;
  const dirs = fs.readdirSync(msp).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split("-")[1] - +a.split("-")[1]);
  for (const d of dirs) { const p = path.join(msp, d, "chrome-win64", "chrome.exe"); if (fs.existsSync(p)) return p; }
  return null;
}

// ---------- khung kiểm ----------
const RESULTS = [];
let cur = null;
function scen(id, title) { cur = { id, title, checks: [], notes: [] }; RESULTS.push(cur); console.log("\n=== " + id + ": " + title); }
function check(desc, ok, got) {
  cur.checks.push({ desc, ok: !!ok, got });
  console.log("  " + (ok ? "ĐẠT " : "LỖI ") + desc + (got !== undefined ? " → " + (typeof got === "string" ? got : JSON.stringify(got)) : ""));
}
function note(s) { cur.notes.push(s); console.log("  · " + s); }
const want = id => !ONLY || ONLY.includes(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let m, ctx, sw, extId, fx, fx2;
const ALL = { console: [], dialogs: [], errors: [], downloads: [], texts: [] };
function watchPage(p, tag) {
  p.on("console", x => ALL.console.push(tag + " " + x.type() + ": " + x.text()));
  p.on("pageerror", e => ALL.errors.push(tag + ": " + e.message));
  p.on("dialog", d => { ALL.dialogs.push(tag + ": " + d.type() + " " + d.message()); d.dismiss().catch(() => {}); });
  return p;
}
async function newPage(url, tag) { const p = watchPage(await ctx.newPage(), tag || "trang"); if (url) await p.goto(url); return p; }
async function closeAll(re) { for (const p of ctx.pages()) if (re.test(p.url())) await p.close(); }
async function shot(p, name) { const f = path.join(SHOTS, name); await p.screenshot({ path: f, fullPage: true }); note("ảnh " + path.relative(ROOT, f)); }

// trạng thái thanh trên trang admin (bản thử: shadow root mở)
async function bar(p) {
  return p.evaluate(() => {
    const h = document.querySelector("kk-circa-nw"), r = h && h.shadowRoot, b = r && r.querySelector(".bar");
    return b ? { state: b.getAttribute("data-state"), text: b.textContent } : null;
  });
}
async function waitBar(p, states, ms) {
  const t0 = Date.now(), want = [].concat(states);
  let last = null;
  while (Date.now() - t0 < (ms || 20000)) {
    last = await bar(p).catch(() => null);
    if (last && want.includes(last.state)) return last;
    await sleep(150);
  }
  return last;
}
async function clickBar(p, act) { await p.locator("[data-act=\"" + act + "\"]").click(); }
async function adminCreate(p, opt) {
  opt = opt || {};
  if (opt.pos) await p.selectOption("#pos", opt.pos);
  await p.selectOption("#mode", opt.mode || "QR");
  const n0 = m.circa.sessions.size;
  await p.click("#create");
  for (let i = 0; i < 100 && m.circa.sessions.size === n0; i++) await sleep(50);
  const ids = [...m.circa.sessions.keys()];
  return ids[ids.length - 1];
}
const nwPosts = () => m.nw.log.filter(e => e.method === "POST" && e.path === "/api/v1/stock/reconciliations");
const nwReq = () => m.nw.log.filter(e => e.method !== "OPTIONS");
const submits = () => m.circa.log.filter(e => e.method === "POST" && e.path === "/v1/inventory/count/submit-rfid-batch");
async function storageDump() { return sw.evaluate(() => chrome.storage.local.get(null)); }
async function sendLocks() { return sw.evaluate(() => self.__KK_TEST__.sendLocks()); }
async function resetAll() {
  m.circa.reset(); m.circa.cfg = { token: m.tokens.circa, adminNoStore: true };
  m.nw.reset();
  await sw.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]).then(() => { self.__KK_TEST__.dropSubmit = 0; }));
  await closeAll(/^http:\/\/127\.0\.0\.1|chrome-extension:/);
}
// thanh trạng thái: phần tử theo data-act / data-role trong shadow root (bản thử: mở)
async function barEl(p, sel, fn) {
  return p.evaluate(([s, f]) => { const h = document.querySelector("kk-circa-nw"), e = h && h.shadowRoot && h.shadowRoot.querySelector(s); return e ? (f === "disabled" ? e.disabled : f === "href" ? e.href : e.textContent) : null; }, [sel, fn || "text"]);
}
const oldIso = () => new Date(Date.now() - 86400000).toISOString();
const psum = p => p.evaluate(() => window.__KK_PANEL__ && window.__KK_PANEL__.summary());
async function pwait(p, pred, ms) {
  await p.waitForFunction(new Function("var s = window.__KK_PANEL__ && window.__KK_PANEL__.summary(); return !!s && !s.busy && (" + pred + ");"), null, { timeout: ms || 60000, polling: 100 });
  return psum(p);
}
async function openPanel(admin) {
  const [p] = await Promise.all([ctx.waitForEvent("page", { timeout: 15000 }), clickBar(admin, "send")]);
  watchPage(p, "panel");
  await p.waitForLoadState("domcontentloaded");
  await pwait(p, "s.chk", 30000);
  return p;
}
async function panelLoad(p) { await p.click("#btn-load"); return pwait(p, "s.fileErr || (s.lookup && (s.lookup.abort || !s.plan || !s.plan.okToSend || s.bodies || s.beforeErr))", 120000); }
async function panelSend(p) {
  await p.click("#btn-send");
  await p.waitForSelector("#modal:not([hidden])", { timeout: 15000 });
  const t = await p.textContent("#modal");
  await p.click("#modal-ok");
  const s = await pwait(p, "s.sendDone && s.rc", 120000);
  return { s, modal: t };
}
async function dl(p, sel) {
  const [d] = await Promise.all([p.waitForEvent("download", { timeout: 15000 }), p.click(sel)]);
  const f = path.join(TMPD, d.suggestedFilename());
  await d.saveAs(f);
  const text = fs.readFileSync(f, "utf8");
  ALL.downloads.push({ f, text });
  return { f, text };
}
// phiên Circa đã liên kết sẵn (tạo qua trang admin giả + extension) → trang admin đang mở phiên đó
async function linkedSession(tag) {
  m.circa.cfg.loadingMs = 0; // phiên OPEN ngay (A1 giữ mặc định 1,2 s để thử tự tạo khi phiên còn LOADING_BASELINE)
  const nw = await newPage(m.urls.nwApp + "/", "nw");
  const admin = await newPage(m.urls.admin + "/kiem-ke-ton-kho", "admin");
  const id = await adminCreate(admin);
  const b = await waitBar(admin, "linked", 20000);
  if (!b || b.state !== "linked") throw new Error(tag + ": không liên kết được phiên (" + JSON.stringify(b) + ")");
  const rec = m.nw.recs.find(r => r.notes && r.notes.indexOf(id) >= 0);
  return { id, admin, nw, rec, ses: m.circa.sessions.get(id) };
}

// ================= KỊCH BẢN =================
async function A1() {
  scen("A1", "Trang admin giả tạo phiên (XHR như axios, không X-Store-Id) → đúng 1 phiên NW, notes đúng");
  await resetAll();
  const nw = await newPage(m.urls.nwApp + "/", "nw");
  const admin = await newPage(m.urls.admin + "/kiem-ke-ton-kho", "admin");
  const b0 = await bar(admin);
  check("trang danh sách: không vẽ thanh trạng thái", b0 === null, b0);
  const id = await adminCreate(admin);
  const s = m.circa.sessions.get(id);
  const b = await waitBar(admin, "linked", 20000);
  check("thanh trạng thái: Đã liên kết phiên NW", b && b.state === "linked", b && b.state);
  const P = nwPosts();
  check("NW nhận đúng 1 POST tạo phiên", P.length === 1, P.length);
  const want1 = { warehouseId: X.WH.lumina, notes: "CIRCA " + s.code + " " + id, clientOperationId: "circa-" + id };
  check("body POST = {kho CIRCA LUMINA, notes CIRCA <mã> <id>, clientOperationId circa-<id>}", P[0] && JSON.stringify(P[0].body) === JSON.stringify(want1), P[0] && P[0].body);
  check("POST NW có Bearer đúng token NW giả, không gửi cookie", P[0] && P[0].authOk && !P[0].cookie, P[0] && { authOk: P[0].authOk, cookie: P[0].cookie });
  // API NW giả chỉ cho CORS origin web NW giả: request vẫn thành công vì đi từ service worker (GET không có Origin, POST có Origin chrome-extension)
  check("mọi request tới API NW thành công dù CORS chỉ cho web NW (gọi từ service worker, không từ trang)", nwReq().length > 0 && nwReq().every(e => e.status === 200 || e.status === 201) && nwReq().every(e => e.origin === null || /^chrome-extension:\/\//.test(e.origin)),
    { origin: [...new Set(nwReq().map(e => e.origin))], status: [...new Set(nwReq().map(e => e.status))] });
  const cr = m.circa.log.find(e => e.method === "POST" && e.path === "/v1/inventory/count/sessions");
  check("trang admin tạo phiên không gửi X-Store-Id (như trang thật)", cr && cr.h.store === null, cr && cr.h.store);
  // trang admin giả không bao giờ gửi X-Store-Id → request có X-Store-Id là của extension
  const ext = m.circa.log.filter(e => e.method !== "OPTIONS" && e.h && e.h.store);
  check("extension tự GET lại phiên với X-Store-Id = pos_id của phiên, X-Circa-App admin, X-Client-Id 1", ext.some(e => e.method === "GET" && e.path === "/v1/inventory/count/sessions/" + id && e.h.store === X.LUMINA && e.h.app === "admin" && e.h.client === "1" && e.h.authOk), ext.map(e => e.method + " " + e.path));
  check("extension đọc tên cửa hàng qua GET /v1/entity/stores/<pos_id>", ext.some(e => e.method === "GET" && e.path === "/v1/entity/stores/" + X.LUMINA), ext.map(e => e.path));
  check("lên Circa chỉ có 1 POST (của trang admin tạo phiên); extension không POST", m.circa.log.filter(e => e.method === "POST").length === 1 && ext.every(e => e.method === "GET"), m.circa.log.filter(e => e.method === "POST").map(e => e.path));
  check("trang admin vẫn chạy bình thường (tạo phiên 200, GET phiên 200)", await admin.evaluate(() => window.__adm.creates.length === 1 && window.__adm.creates.concat(window.__adm.gets).every(x => x === 200)), await admin.evaluate(() => window.__adm));
  const st = await storageDump(), rec = st["link:" + id];
  check("bản ghi liên kết: linked, nwId = phiên NW mới, kho, mã ICS", rec && rec.state === "linked" && rec.nwId === m.nw.recs[0].id && rec.warehouseId === X.WH.lumina && rec.code === s.code, rec && { state: rec.state, nwId: rec.nwId });
  const gev = await sw.evaluate(() => self.__KK_TEST__.gateEvents());
  check("extension TỰ thấy lệnh tạo qua webRequest (POST 200 từ tab admin) và dùng sự kiện đó cho đúng phiên này", gev.length === 1 && gev[0].used === id, gev);
  const me = m.nw.log.find(e => e.path === "/api/v1/auth/me");
  check("/auth/me giả trả dạng thật (permissions = object, permissionNames = chuỗi) và extension đọc đúng quyền", me && me.status === 200 && rec && !/Không đọc được danh sách quyền/.test(rec.msg), rec && rec.msg);
  ALL.texts.push("thanh A1: " + JSON.stringify(await bar(admin)));
  await shot(admin, "A1-admin-da-lien-ket.png");
  await admin.reload();
  const b2 = await waitBar(admin, "linked", 15000);
  check("tải lại trang phiên: vẫn liên kết, không POST thêm", b2 && b2.state === "linked" && nwPosts().length === 1, { state: b2 && b2.state, posts: nwPosts().length });
  const href = await barEl(admin, "[data-role=nw-link]", "href"), nwl = await barEl(admin, "[data-role=nw]");
  check("link NW chỉ tới trang chủ web NW; thanh hiện id phiên NW + ghi chú để tìm", href === m.urls.nwApp + "/" && nwl.indexOf(m.nw.recs[0].id) >= 0 && nwl.indexOf("CIRCA " + s.code + " " + id) >= 0, { href, nwl });
  // biến thể fetch
  const admin2 = await newPage(m.urls.admin + "/kiem-ke-ton-kho?via=fetch", "admin-fetch");
  const id2 = await adminCreate(admin2);
  const b3 = await waitBar(admin2, "linked", 20000);
  check("trang tạo phiên bằng fetch (không phải XHR) → cũng liên kết, tổng 2 POST cho 2 phiên", b3 && b3.state === "linked" && nwPosts().length === 2 && nwPosts()[1].body.clientOperationId === "circa-" + id2, { state: b3 && b3.state, posts: nwPosts().length });
  check("trang dùng fetch vẫn nhận đúng response (tạo 200, GET 200)", await admin2.evaluate(() => window.__adm.creates.length === 1 && window.__adm.creates.concat(window.__adm.gets).every(x => x === 200)), await admin2.evaluate(() => window.__adm));
  await nw.close();
}

async function A2() {
  scen("A2", "Mở phiên cũ chưa liên kết → chỉ HỎI; bấm mới tạo");
  await resetAll();
  await newPage(m.urls.nwApp + "/", "nw");
  const old = m.circa.addSession({ code: "ICS90002", created_at: new Date(Date.now() - 2 * 86400000).toISOString() });
  const admin = await newPage(m.urls.admin + "/kiem-ke-ton-kho/" + old.id, "admin");
  const b = await waitBar(admin, "unlinked", 15000);
  check("thanh trạng thái: Chưa có phiên NW liên kết + nút hỏi", b && b.state === "unlinked" && /Tạo phiên NW cho phiên này\?/.test(b.text), b && b.state);
  await sleep(2500);
  check("không tự tạo: 0 POST NW sau 2,5 giây", nwPosts().length === 0, nwPosts().length);
  check("đã tra notes trên NW (chỉ đọc) trước khi hỏi", nwReq().some(e => e.method === "GET" && e.path === "/api/v1/stock/reconciliations"), nwReq().map(e => e.method + " " + e.path));
  await shot(admin, "A2-admin-hoi-tao.png");
  await clickBar(admin, "ask-open");
  const b1 = await bar(admin);
  check("bấm câu hỏi → hiện xác nhận trong thanh (không dùng confirm của trình duyệt)", b1 && /Tạo phiên kiểm kê NW/.test(b1.text), b1 && b1.text.slice(0, 80));
  await clickBar(admin, "ask-no");
  check("bấm Không → không tạo", nwPosts().length === 0, nwPosts().length);
  await clickBar(admin, "ask-open"); await clickBar(admin, "ask-yes");
  const b2 = await waitBar(admin, "linked", 20000);
  check("bấm Tạo phiên NW → liên kết, đúng 1 POST, notes đúng", b2 && b2.state === "linked" && nwPosts().length === 1 && nwPosts()[0].body.notes === "CIRCA ICS90002 " + old.id, { state: b2 && b2.state, posts: nwPosts().length });
  // phiên cũ đã có phiên NW theo notes (tạo từ máy khác) → liên kết, không hỏi, không tạo
  const old2 = m.circa.addSession({ code: "ICS90003", created_at: new Date(Date.now() - 86400000).toISOString() });
  m.nw.addRec({ warehouseId: X.WH.lumina, notes: "CIRCA ICS90003 " + old2.id, clientOperationId: "circa-" + old2.id });
  const admin2 = await newPage(m.urls.admin + "/kiem-ke-ton-kho/" + old2.id, "admin2");
  const b3 = await waitBar(admin2, "linked", 15000);
  check("phiên cũ đã có phiên NW theo notes → liên kết luôn, 0 POST thêm", b3 && b3.state === "linked" && nwPosts().length === 1, { state: b3 && b3.state, posts: nwPosts().length });
  // tin giả từ script của trang: id không có phiên + click giả lập (isTrusted false) không tạo gì
  await admin.evaluate(id => { window.postMessage({ kk: "kk-circa-nw-1", kind: "created", id: "0f0f0f0f-0000-4000-8000-000000000000", pos: id }, location.origin); }, X.LUMINA);
  const old3 = m.circa.addSession({ code: "ICS90004", created_at: new Date(Date.now() - 86400000).toISOString() });
  await admin.evaluate(id => { window.postMessage({ kk: "kk-circa-nw-1", kind: "created", id: id, pos: "31493e74-3404-4c0e-a906-93691a6ee319" }, location.origin); }, old3.id);
  await sleep(2000);
  check("tin 'created' giả (phiên không tồn tại / phiên cũ > 10 phút) → 0 POST thêm", nwPosts().length === 1, nwPosts().length);
  const st = await storageDump();
  check("tin giả không để lại bản ghi", !st["link:0f0f0f0f-0000-4000-8000-000000000000"] && !st["link:" + old3.id], Object.keys(st));
}

async function A3() {
  scen("A3", "Không có tab NW lúc tạo → pending, báo trên trang → mở tab NW → tạo bù");
  await resetAll();
  const admin = await newPage(m.urls.admin + "/kiem-ke-ton-kho", "admin");
  const id = await adminCreate(admin);
  const b = await waitBar(admin, "pending", 15000);
  check("thanh trạng thái: Chưa tạo được phiên NW, nhắc mở circa.nextwaves.app", b && b.state === "pending" && /circa\.nextwaves\.app/.test(b.text), b && b.text.slice(0, 160));
  check("không gọi API NW nào khi chưa có tab NW", nwReq().length === 0, nwReq().length);
  await shot(admin, "A3-admin-cho-tab-nw.png");
  await newPage(m.urls.nwApp + "/", "nw");
  const b2 = await waitBar(admin, "linked", 20000);
  check("mở tab NW đã đăng nhập → tự tạo bù, liên kết", b2 && b2.state === "linked", b2 && b2.state);
  check("đúng 1 POST, notes chứa id phiên", nwPosts().length === 1 && nwPosts()[0].body.notes.indexOf(id) > 0, nwPosts().length);
}

async function A4() {
  scen("A4", "Phiên RFID → bỏ qua; thiếu quyền NW → dừng; không có kho trùng tên → dừng; NW 401 → chờ, tạo bù");
  await resetAll();
  const nw = await newPage(m.urls.nwApp + "/", "nw");
  let admin = await newPage(m.urls.admin + "/kiem-ke-ton-kho", "admin");
  await adminCreate(admin, { mode: "RFID" });
  let b = await waitBar(admin, "skipped", 15000);
  check("phiên RFID → “không phải phiên QR, bỏ qua”, 0 POST", b && b.state === "skipped" && /không phải phiên QR/.test(b.text) && nwPosts().length === 0, b && b.state);
  m.nw.cfg.perms = ["stock.view"];
  admin = await newPage(m.urls.admin + "/kiem-ke-ton-kho", "admin");
  await adminCreate(admin);
  b = await waitBar(admin, "no-permission", 15000);
  check("thiếu quyền stock.reconcile → Thiếu quyền NW, 0 POST", b && b.state === "no-permission" && nwPosts().length === 0, b && b.text.slice(0, 120));
  await shot(admin, "A4-thieu-quyen-nw.png");
  m.nw.cfg = {};
  m.circa.stores[POS_X] = "CIRCA THỬ KHÔNG KHO";
  admin = await newPage(m.urls.admin + "/kiem-ke-ton-kho", "admin");
  await adminCreate(admin, { pos: POS_X });
  b = await waitBar(admin, "no-warehouse", 15000);
  check("cửa hàng không có kho NW trùng tên → Không có kho NW trùng tên, 0 POST", b && b.state === "no-warehouse" && /CIRCA THỬ KHÔNG KHO/.test(b.text) && nwPosts().length === 0, b && b.text.slice(0, 160));
  m.nw.cfg.nw401 = true;
  admin = await newPage(m.urls.admin + "/kiem-ke-ton-kho", "admin");
  await adminCreate(admin, { pos: X.LUMINA });
  b = await waitBar(admin, "pending", 15000);
  check("NW 401 → pending, nhắc mở lại tab NW, 0 POST", b && b.state === "pending" && /hết hạn|đăng nhập/.test(b.text) && nwPosts().length === 0, b && b.text.slice(0, 160));
  m.nw.cfg.nw401 = false;
  await nw.reload();
  b = await waitBar(admin, "linked", 20000);
  check("tải lại tab NW → tạo bù, liên kết, 1 POST", b && b.state === "linked" && nwPosts().length === 1, { state: b && b.state, posts: nwPosts().length });
}

async function A5() {
  scen("A5", "Tin 'created' GIẢ cho phiên QR THẬT (vừa tạo 1 phút, đúng cửa hàng) mà extension không thấy lệnh tạo → 0 POST, chỉ hỏi; 40 tin rác → không ghi, bị giới hạn");
  await resetAll();
  m.circa.cfg.loadingMs = 0;
  await newPage(m.urls.nwApp + "/", "nw");
  const real = m.circa.addSession({ code: "ICS90005", counting_mode: "QR", created_at: new Date(Date.now() - 60000).toISOString() });
  const admin = await newPage(m.urls.admin + "/kiem-ke-ton-kho", "admin");
  const tPost = Date.now();
  await admin.evaluate(o => { window.postMessage({ kk: "kk-circa-nw-1", kind: "created", id: o.id, pos: o.pos }, location.origin); }, { id: real.id, pos: X.LUMINA });
  await sleep(4500); // > CREATE_GATE_WAIT_MS (3 s)
  check("0 POST tạo phiên NW", nwPosts().length === 0, nwPosts().length);
  const st = await storageDump();
  check("không ghi bản ghi liên kết cho phiên đó", !st["link:" + real.id], Object.keys(st));
  // sự kiện của các kịch bản trước còn trong bộ nhớ SW (đã dùng, tab khác): chỉ xét sự kiện mới / sự kiện gắn với phiên này
  const gev = await sw.evaluate(() => self.__KK_TEST__.gateEvents());
  check("extension không thấy lệnh tạo nào qua webRequest từ lúc gửi tin giả; không sự kiện nào gắn với phiên này", !gev.some(e => e.t >= tPost - 50 || e.used === real.id), gev.filter(e => e.t >= tPost - 50 || e.used === real.id));
  await admin.goto(m.urls.admin + "/kiem-ke-ton-kho/" + real.id);
  const b = await waitBar(admin, "unlinked", 15000);
  check("mở trang phiên đó → thanh chỉ HỎI (unlinked), vẫn 0 POST", b && b.state === "unlinked" && nwPosts().length === 0, b && b.state);
  await shot(admin, "A5-tin-gia-chi-hoi.png");
  // 40 tin rác (uuid ngẫu nhiên) từ một tab admin khác
  const junk = await newPage(m.urls.admin + "/kiem-ke-ton-kho", "admin-rac");
  const n0 = m.circa.log.length;
  const ids = await junk.evaluate(() => { const a = []; for (let i = 0; i < 40; i++) { const id = crypto.randomUUID(); a.push(id); window.postMessage({ kk: "kk-circa-nw-1", kind: "created", id: id, pos: "31493e74-3404-4c0e-a906-93691a6ee319" }, location.origin); } return a; });
  await sleep(6500);
  const got = m.circa.log.slice(n0).filter(e => ids.some(id => String(e.path).indexOf(id) >= 0));
  check("40 tin rác → ≤ 10 lệnh GET Circa (giới hạn 10 tin 'created' / phút / tab)", got.length <= 10, got.length);
  const st2 = await storageDump();
  check("tin rác không để lại bản ghi, 0 POST NW", ids.every(id => !st2["link:" + id]) && nwPosts().length === 0, Object.keys(st2).length);
}

async function A6() {
  scen("A6", "Phiên NW liên kết (theo ghi chú) đã huỷ / hoàn tất → thanh báo rõ, khoá nút gửi, KHÔNG tạo phiên NW khác");
  await resetAll();
  await newPage(m.urls.nwApp + "/", "nw");
  const s1 = m.circa.addSession({ code: "ICS90006", created_at: oldIso() });
  const r1 = m.nw.addRec({ warehouseId: X.WH.lumina, notes: "CIRCA ICS90006 " + s1.id, clientOperationId: "circa-" + s1.id, status: "cancelled" });
  const admin = await newPage(m.urls.admin + "/kiem-ke-ton-kho/" + s1.id, "admin");
  const b = await waitBar(admin, "nw-closed", 15000);
  check("thanh: “Phiên NW liên kết đã huỷ”, 0 POST", b && b.state === "nw-closed" && /Phiên NW liên kết đã huỷ/.test(b.text) && nwPosts().length === 0, b && b.text.slice(0, 200));
  check("nút gửi bị khoá; không có nút Tạo phiên NW / Thử lại", await barEl(admin, "[data-act=send]", "disabled") === true && await barEl(admin, "[data-act=ask-open]") === null && await barEl(admin, "[data-act=retry]") === null);
  const nwl = await barEl(admin, "[data-role=nw]");
  check("thanh hiện id phiên NW đã huỷ + ghi chú", nwl && nwl.indexOf(r1.id) >= 0 && nwl.indexOf("CIRCA ICS90006 " + s1.id) >= 0, nwl);
  await shot(admin, "A6-phien-nw-da-huy.png");
  const P = await newPage("chrome-extension://" + extId + "/panel.html?circa=" + s1.id, "panel-dong");
  await P.waitForSelector("#fatal:not([hidden])", { timeout: 15000 });
  const ft = await P.textContent("#fatal");
  check("mở panel bằng URL → báo phiên NW đã huỷ, không gửi được", /đã huỷ/.test(ft) && /không gửi/.test(ft), ft.slice(0, 160));
  ALL.texts.push("panel A6: " + ft);
  await P.close();
  // phiên đã liên kết rồi bị hoàn tất trên NW; mất bản ghi (cài lại extension) → tìm theo ghi chú → nw-closed
  const L = await linkedSession("A6b");
  L.rec.status = "completed";
  await sw.evaluate(() => chrome.storage.local.clear());
  await L.admin.reload();
  const b2 = await waitBar(L.admin, "nw-closed", 15000);
  check("phiên đã liên kết rồi bị hoàn tất trên NW → “đã hoàn tất”, không tạo thêm (tổng 1 POST)", b2 && b2.state === "nw-closed" && /đã hoàn tất/.test(b2.text) && nwPosts().length === 1, { state: b2 && b2.state, posts: nwPosts().length });
}

async function A7() {
  scen("A7", "Dạng NW thật: kho CON trùng tên → không tạo; danh sách phiên không có totalPages → không tạo; NW không chống trùng clientOperationId → vẫn 1 phiên");
  await resetAll();
  await newPage(m.urls.nwApp + "/", "nw");
  m.nw.cfg = { warehouses: X.nestedWarehouses("CIRCA LUMINA") };
  let admin = await newPage(m.urls.admin + "/kiem-ke-ton-kho", "admin");
  await adminCreate(admin);
  let b = await waitBar(admin, "no-warehouse", 15000);
  check("kho con (trong children) trùng tên cửa hàng với kho gốc → “có 2 kho NW (tính cả kho con)”, 0 POST", b && b.state === "no-warehouse" && /2 kho NW/.test(b.text) && nwPosts().length === 0, b && b.text.slice(0, 200));
  m.nw.cfg = { noTotalPages: true };
  admin = await newPage(m.urls.admin + "/kiem-ke-ton-kho", "admin");
  await adminCreate(admin);
  b = await waitBar(admin, "error", 15000);
  check("danh sách phiên NW không có totalPages → dừng, báo lỗi, 0 POST", b && b.state === "error" && /totalPages/.test(b.text) && nwPosts().length === 0, b && b.text.slice(0, 200));
  m.nw.cfg = { noDedupe: true };
  for (let i = 0; i < 30; i++) m.nw.addRec({ warehouseId: X.WH.florita, notes: "CIRCA ICS8" + i + " " + "00000000-0000-4000-8000-" + String(i).padStart(12, "0") });
  admin = await newPage(m.urls.admin + "/kiem-ke-ton-kho", "admin");
  const id = await adminCreate(admin);
  b = await waitBar(admin, "linked", 20000);
  check("NW không chống trùng: tạo lần đầu → 1 POST", b && b.state === "linked" && nwPosts().length === 1, nwPosts().length);
  await sw.evaluate(() => chrome.storage.local.clear());
  await admin.reload();
  b = await waitBar(admin, "linked", 15000);
  check("mất bản ghi, tải lại trang → tìm thấy theo ghi chú (31 phiên, 2 trang), không POST thêm; NW có đúng 1 phiên ghi phiên này", b && b.state === "linked" && nwPosts().length === 1 && m.nw.recs.filter(r => r.notes && r.notes.indexOf(id) >= 0).length === 1,
    { posts: nwPosts().length, recs: m.nw.recs.filter(r => r.notes && r.notes.indexOf(id) >= 0).length });
  m.nw.cfg = {};
}

async function C1() {
  scen("C1", "Chống clickjacking: thanh bị trang làm mờ / dịch / phần tử cha mờ → bỏ qua cú bấm; CSS !important của trang không thắng style inline của thanh");
  await resetAll();
  await newPage(m.urls.nwApp + "/", "nw");
  const s1 = m.circa.addSession({ code: "ICS90007", created_at: oldIso() });
  const admin = await newPage(m.urls.admin + "/kiem-ke-ton-kho/" + s1.id, "admin");
  await waitBar(admin, "unlinked", 15000);
  const host = js => admin.evaluate(js);
  await host(() => document.querySelector("kk-circa-nw").style.setProperty("opacity", "0.2", "important"));
  await clickBar(admin, "ask-open");
  let b = await bar(admin);
  check("phần tử chủ bị đặt opacity 0.2 → bỏ qua cú bấm “Tạo phiên NW cho phiên này?”", /Bỏ qua cú bấm/.test(b.text) && !/Tạo phiên kiểm kê NW \(cả kho\)/.test(b.text), b.text.slice(0, 200));
  check("vẽ lại đặt lại style của thanh (opacity 1)", await host(() => getComputedStyle(document.querySelector("kk-circa-nw")).opacity) === "1");
  await host(() => document.querySelector("kk-circa-nw").style.setProperty("transform", "translate(-300px, -200px)", "important"));
  await clickBar(admin, "ask-open");
  b = await bar(admin);
  check("phần tử chủ bị dịch (transform) → bỏ qua cú bấm", /Bỏ qua cú bấm/.test(b.text) && !/Tạo phiên kiểm kê NW \(cả kho\)/.test(b.text), b.text.slice(0, 120));
  await host(() => { const s = document.createElement("style"); s.id = "atk"; s.textContent = "kk-circa-nw{opacity:.05 !important;transform:translateY(-400px) !important;left:0 !important}"; document.head.appendChild(s); });
  const cs = await host(() => { const c = getComputedStyle(document.querySelector("kk-circa-nw")); return { o: c.opacity, t: c.transform }; });
  check("CSS !important của trang không thắng style inline !important của thanh", cs.o === "1" && cs.t === "none", cs);
  await clickBar(admin, "ask-open");
  b = await bar(admin);
  check("thanh hiện rõ, đúng chỗ → nhận cú bấm (mở câu hỏi)", /Tạo phiên kiểm kê NW \(cả kho\)/.test(b.text), b.text.slice(0, 120));
  await host(() => { document.body.style.opacity = "0.3"; });
  await clickBar(admin, "ask-yes");
  await sleep(1500);
  b = await bar(admin);
  check("phần tử cha (body) mờ 0.3 → bỏ qua “Tạo phiên NW”, 0 POST", /Bỏ qua cú bấm/.test(b.text) && b.state === "unlinked" && nwPosts().length === 0, { state: b.state, posts: nwPosts().length });
  await shot(admin, "C1-bo-qua-cu-bam.png");
  await host(() => { document.body.style.opacity = ""; document.getElementById("atk").remove(); });
  await clickBar(admin, "ask-yes");
  b = await waitBar(admin, "linked", 20000);
  check("gỡ tấn công → bấm “Tạo phiên NW” → liên kết, 1 POST", b && b.state === "linked" && nwPosts().length === 1, { state: b && b.state, posts: nwPosts().length });
}

async function W1() {
  scen("W1", "watch-circa: lỗi fetch mà trang KHÔNG bắt vẫn thành unhandledrejection (1 lần, đúng Promise trang nhận); trang bắt → 0; giống trang không có extension");
  const code = async API => {
    const ev = [];
    addEventListener("unhandledrejection", e => { ev.push({ reason: String(e.reason && e.reason.name), same: e.promise === window.__p1 }); e.preventDefault(); });
    window.__p1 = fetch(API + "/v1/inventory/count/sessions", { method: "POST", headers: { "x y": "1" }, body: "{}" });
    await new Promise(r => setTimeout(r, 500));
    const n1 = ev.length;
    await fetch(API + "/v1/inventory/count/sessions", { method: "POST", headers: { "x y": "1" }, body: "{}" }).catch(() => {});
    await new Promise(r => setTimeout(r, 500));
    return { n1, n2: ev.length - n1, ev, wrapped: !/\[native code\]/.test(Function.prototype.toString.call(window.fetch)) };
  };
  // trang riêng, không gắn watchPage (unhandledrejection ở đây là cố ý)
  const p = await ctx.newPage(); await p.goto(m.urls.admin + "/kiem-ke-ton-kho");
  const a = await p.evaluate(code, m.urls.circaApi);
  check("trang admin: fetch đã được watch-circa bọc", a.wrapped === true, a.wrapped);
  check("trang không bắt lỗi → đúng 1 unhandledrejection, trên đúng Promise trang nhận, lý do TypeError", a.n1 === 1 && a.ev[0].same === true && a.ev[0].reason === "TypeError", a.ev);
  check("trang bắt lỗi → 0 unhandledrejection", a.n2 === 0, a.n2);
  const q = await ctx.newPage(); await q.goto(m.urls.nwApp + "/");
  const c = await q.evaluate(code, m.urls.circaApi);
  check("đối chứng trang không có extension: cùng hành vi (1 rồi 0)", c.wrapped === false && c.n1 === 1 && c.n2 === 0 && c.ev[0].same === true, c);
  await p.close(); await q.close();
}

async function B1() {
  scen("B1", "Luồng B đủ: tải file xuất NW giả → xem trước → xác nhận → gửi 2 lô → đối chiếu ĐẠT; bấm lại chỉ gửi thẻ mới");
  await resetAll();
  const L = await linkedSession("B1");
  const panel = await openPanel(L.admin);
  let s = await psum(panel);
  check("panel: phiên liên kết đạt (Circa OPEN, NW in_progress, đúng kho, có quyền manage)", s.chk && s.chk.problems.length === 0 && s.chk.authz.manage === true, s.chk);
  check("panel không có ô token", (await panel.$$("input[type=password]")).length === 0);
  s = await panelLoad(panel);
  check("đọc file xuất NW giả: " + fx.tags + " thẻ, 1 thẻ lạ, 0 lỗi", s.parse && s.parse.tags === fx.tags && s.parse.strange === 1 && s.parse.errors === 0, s.parse);
  check("tra mã: không lỗi, kế hoạch okToSend, " + (fx.sent - 1) + " thô + 1 kèm đơn vị, gốc NW " + fx.nwBase, s.lookup && s.lookup.stats.err === 0 && s.plan.okToSend && s.plan.modes.tho === fx.sent - 1 && s.plan.modes["kem-don-vi"] === 1 && s.plan.nwBase === fx.nwBase, { lookup: s.lookup, plan: s.plan });
  check("chia 2 lô, chưa có lượt nào trong phiên", s.bodies && s.bodies.n === 2 && s.bodies.excluded === 0, s.bodies);
  const exp = m.nw.log.find(e => /\/export$/.test(e.path));
  check("lấy file xuất qua API NW đúng query format=xlsx&scope=all&includeEpcs=true&locale=vi", exp && JSON.stringify(exp.query) === JSON.stringify({ format: "xlsx", scope: "all", includeEpcs: "true", locale: "vi" }), exp && exp.query);
  await shot(panel, "B1-panel-xem-truoc.png");
  check("chưa xác nhận thì chưa gửi gì", submits().length === 0, submits().length);
  const r = await panelSend(panel);
  check("hộp xác nhận trong trang nêu mã phiên, số thẻ, phiên NW nguồn", /Gửi \d+ thẻ vào phiên ICS/.test(r.modal) && r.modal.indexOf(L.rec.id) >= 0, r.modal.slice(0, 160));
  s = r.s;
  check("gửi 2 lô, mỗi lô 1 lần, đều ĐẠT", s.batches.length === 2 && s.batches.every(b => b.ok && b.tries === 1) && !s.sendStop, s.batches);
  check("đối chiếu ĐẠT: " + fx.sent + " thẻ đúng, gốc Circa = gốc NW", s.rc && s.rc.ok && s.rc.counts.dung === fx.sent && s.rc.all === fx.nwBase, s.rc);
  const sub = submits();
  check("Circa nhận đúng 2 POST submit-rfid-batch, X-Store-Id Lumina, device NW-RFID, ≤ 100 mã/lô", sub.length === 2 && sub.every(e => e.h.store === X.LUMINA && e.body.device_id === "NW-RFID" && NWC.bodyCodes(e.body).length <= 100 && e.body.session_id === L.id), sub.map(e => NWC.bodyCodes(e.body).length));
  const kem = sub.flatMap(e => e.body.items || []);
  check("thẻ lệch quy đổi gửi kèm đơn vị gốc {unit_name: gói, quantity: 8}", kem.length === 1 && kem[0].unit_name === "gói" && kem[0].quantity === 8, kem);
  await shot(panel, "B1-panel-doi-chieu-dat.png");
  const log = await dl(panel, "#btn-log");
  const j = JSON.parse(log.text);
  check("sổ ghi JSON có liên kết, 2 lô, đối chiếu ok", j.lienKet && j.lienKet.nwId === L.rec.id && j.lo.length === 2 && j.doiChieu && j.doiChieu.ok === true, { lo: j.lo.length });
  // phiên NW/Circa vẫn mở: extension không gọi đóng/duyệt
  check("phiên Circa vẫn OPEN, phiên NW vẫn in_progress", m.circa.sessions.get(L.id).status === "OPEN" && L.rec.status === "in_progress");
  // bấm lại lần sau: NW có thêm 5 thẻ mới quét
  m.nw.setExport(L.rec.id, fx2.xlsx);
  for (const [c, d] of fx2.lookups) m.circa.setLookup(c, d);
  await panel.reload();
  await pwait(panel, "s.chk", 30000);
  s = await panelLoad(panel);
  check("lần sau: chỉ gửi 5 thẻ mới, bỏ qua " + fx.sent + " mã đã có", s.bodies && s.bodies.n === 1 && s.bodies.excluded === fx.sent, s.bodies);
  const r2 = await panelSend(panel);
  check("gửi 1 lô 5 thẻ, đối chiếu ĐẠT với " + fx2.sent + " thẻ", r2.s.batches.length === 1 && r2.s.batches[0].codes === 5 && r2.s.rc.ok && r2.s.rc.counts.dung === fx2.sent, { batches: r2.s.batches, rc: r2.s.rc });
  check("tổng POST submit = 3", submits().length === 3, submits().length);
  ALL.texts.push("panel B1: " + await panel.evaluate(() => document.documentElement.outerHTML + "\n" + document.body.innerText + "\n" + JSON.stringify(window.__KK_PANEL__.summary())));
  await panel.close();
}

async function B2() {
  scen("B2", "Lô 1 trả 500, 502 rồi 200 → gửi lại NGUYÊN lô, ĐẠT; lô 1 lỗi 4 lần → DỪNG, không gửi lô 2");
  await resetAll();
  let L = await linkedSession("B2a");
  m.circa.cfg.submitFaults = { 1: [{ status: 500 }, { status: 502 }] };
  let panel = await openPanel(L.admin);
  await panelLoad(panel);
  let r = await panelSend(panel);
  check("lô 1 gửi 3 lần rồi ĐẠT, lô 2 gửi 1 lần", r.s.batches.length === 2 && r.s.batches[0].tries === 3 && r.s.batches[0].ok && r.s.batches[1].tries === 1, r.s.batches);
  const sub = submits();
  check("3 lần gửi lô 1 cùng NGUYÊN body", sub.length === 4 && JSON.stringify(sub[0].body) === JSON.stringify(sub[1].body) && JSON.stringify(sub[1].body) === JSON.stringify(sub[2].body), sub.length);
  check("đối chiếu ĐẠT, không đếm dư", r.s.rc && r.s.rc.ok && r.s.rc.all === fx.nwBase, r.s.rc);
  await panel.close();
  // 4 lần 500 → dừng
  m.circa.cfg.submitFaults = {};
  L = await linkedSession("B2b");
  m.circa.cfg.submitFaults = { 1: [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }] };
  const n0 = submits().length;
  panel = await openPanel(L.admin);
  await panelLoad(panel);
  r = await panelSend(panel);
  check("lô 1 lỗi 4 lần (1 + 3 gửi lại) → DỪNG, không gửi lô 2", submits().length - n0 === 4 && r.s.batches.length === 1 && /không gửi được sau 4 lần/.test(r.s.sendStop), { gui: submits().length - n0, stop: r.s.sendStop });
  check("đối chiếu vẫn chạy và báo CHƯA ĐẠT", r.s.rc && r.s.rc.ok === false, r.s.rc);
  await shot(panel, "B2-panel-dung-5xx.png");
  await panel.close();
}

async function B3() {
  scen("B3", "401: NW 401 khi lấy file → báo mở lại tab NW; Circa 401 khi gửi lô → dừng, không gửi lại");
  await resetAll();
  let L = await linkedSession("B3a");
  let panel = await openPanel(L.admin);
  m.nw.cfg.nw401 = true;
  let s = await panelLoad(panel);
  check("NW 401 khi tải file → lỗi, nhắc mở / tải lại tab circa.nextwaves.app", /Token NW/.test(s.fileErr) && /circa\.nextwaves\.app/.test(s.fileErr), s.fileErr);
  check("không tra mã, không gửi gì", !s.lookup && submits().length === 0);
  await shot(panel, "B3-panel-nw-401.png");
  m.nw.cfg.nw401 = false;
  s = await panelLoad(panel);
  check("mở lại được tab NW (hết 401) → bấm lại tải được file", s.plan && s.plan.okToSend, s.plan && s.plan.okToSend);
  m.circa.cfg.submitFaults = { 1: [{ status: 401 }] };
  const r = await panelSend(panel);
  check("Circa 401 ở lô 1 → dừng ngay sau 1 lần gửi, không gửi lô 2", r.s.batches.length === 1 && r.s.batches[0].tries === 1 && r.s.batches[0].stop === "token" && submits().length === 1, r.s.batches);
  check("thông báo nhắc mở / tải lại trang admin Circa", /admin\.v2\.circa\.vn/.test(r.s.sendStop) || /401/.test(r.s.sendStop), r.s.sendStop);
  await panel.close();
  // NW 401 khi kiểm phiên NW lúc mở panel
  m.circa.cfg.submitFaults = {};
  m.nw.cfg.nw401 = true;
  panel = await openPanel(L.admin);
  s = await psum(panel);
  check("mở panel khi NW 401 → bước 1 báo không đọc được phiên NW, nút Lấy kết quả khoá", s.chk.problems.some(p => /phiên NW/.test(p) && /circa\.nextwaves\.app/.test(p)) && s.loadDisabled, s.chk.problems);
  m.nw.cfg.nw401 = false;
  await panel.close();
}

async function B4() {
  scen("B4", "Thiếu quyền Circa inventory_count.manage → khoá gửi; không đọc được quyền → chỉ ghi chú");
  await resetAll();
  const L = await linkedSession("B4");
  m.circa.cfg.authz = { success: true, data: { roles: [{ code: "VIEWER", permissions: [{ code: "inventory_count.view" }] }] } };
  let panel = await openPanel(L.admin);
  let s = await psum(panel);
  check("quyền manage = false → bước 1 báo thiếu quyền", s.chk.authz.manage === false && s.chk.problems.some(p => /inventory_count\.manage/.test(p)), s.chk);
  s = await panelLoad(panel);
  check("vẫn xem trước được (chỉ đọc) nhưng nút Gửi bị khoá", s.plan && s.plan.okToSend && s.sendDisabled === true, { ok: s.plan && s.plan.okToSend, sendDisabled: s.sendDisabled });
  await panel.click("#btn-send", { force: true }).catch(() => {});
  await sleep(500);
  check("bấm cố cũng không gửi", submits().length === 0, submits().length);
  await shot(panel, "B4-panel-thieu-quyen.png");
  await panel.close();
  m.circa.cfg.authz = { success: true, data: { principal: { type: "PERSON" } } };
  panel = await openPanel(L.admin);
  s = await psum(panel);
  check("không đọc được danh sách quyền → không chặn, ghi chú “không kiểm được quyền”", s.chk.authz.manage === null && s.chk.problems.length === 0 && s.chk.notes.some(n => /Không kiểm được quyền/.test(n)), s.chk);
  await panel.close();
}

async function B5() {
  scen("B5", "2 panel cùng phiên: bấm lại nút gửi → chuyển tới panel đang mở (không mở tab mới); panel thứ 2 bị từ chối khi panel 1 đang gửi");
  await resetAll();
  const L = await linkedSession("B5");
  const A = await openPanel(L.admin);
  const nPages = ctx.pages().length;
  await clickBar(L.admin, "send");
  await sleep(1500);
  const panels = ctx.pages().filter(p => /panel\.html\?circa=/.test(p.url()));
  check("bấm lại “Lấy kết quả từ NW…” → không mở tab mới (chuyển tới panel đang mở)", ctx.pages().length === nPages && panels.length === 1, { pages: ctx.pages().length, before: nPages, panels: panels.length });
  const P2 = await newPage("chrome-extension://" + extId + "/panel.html?circa=" + L.id, "panel-2");
  await pwait(P2, "s.chk", 30000);
  await panelLoad(A); await panelLoad(P2);
  m.circa.cfg.submitFaults = { 1: [{ hang: true, record: true }] };
  await A.click("#btn-send"); await A.waitForSelector("#modal:not([hidden])", { timeout: 15000 }); await A.click("#modal-ok");
  await A.waitForFunction(() => window.__KK_PANEL__.summary().sending === true, null, { timeout: 15000, polling: 100 });
  const lk = await sendLocks();
  check("panel 1 đang gửi giữ khoá gửi của phiên", Object.keys(lk).length === 1 && !!lk["send:" + L.id], lk);
  await P2.click("#btn-send"); await P2.waitForSelector("#modal:not([hidden])", { timeout: 15000 }); await P2.click("#modal-ok");
  const s2 = await pwait(P2, "/khoá gửi/.test(s.sendMsgText)", 20000);
  check("panel 2 bị từ chối (“Đang có panel khác gửi…”), không gửi gì", !s2.sendStarted && /panel khác/.test(s2.sendMsgText) && s2.batches.length === 0, s2.sendMsgText);
  const s1 = await pwait(A, "s.sendDone && s.rc", 90000);
  check("panel 1 gửi xong (lô 1 treo → gửi lại nguyên lô), đối chiếu ĐẠT", s1.rc && s1.rc.ok === true && s1.batches[0].tries === 2, { batches: s1.batches, rc: s1.rc });
  const sub = submits();
  check("Circa nhận 3 POST submit (lô 1 × 2, lô 2 × 1), không có lô nào từ panel 2", sub.length === 3, sub.length);
  check("gửi xong → khoá được nhả", Object.keys(await sendLocks()).length === 0, await sendLocks());
  await shot(P2, "B5-panel-2-bi-tu-choi.png");
  await A.close(); await P2.close();
}

async function B6() {
  scen("B6", "Mất liên lạc với service worker giữa lô (cổng tin đóng) → ghi “KHÔNG RÕ đã gửi hay chưa”, không gửi lại, vẫn đối chiếu");
  await resetAll();
  const L = await linkedSession("B6");
  const p = await openPanel(L.admin);
  await panelLoad(p);
  await sw.evaluate(() => { self.__KK_TEST__.dropSubmit = 1; });
  const r = await panelSend(p);
  await sleep(500);
  check("lô 1 dừng với KHÔNG RÕ sau 1 lần, không gửi lại, không gửi lô 2", r.s.batches.length === 1 && r.s.batches[0].tries === 1 && r.s.batches[0].stop === "không rõ" && /KHÔNG RÕ/.test(r.s.sendStop), { batches: r.s.batches, stop: r.s.sendStop });
  check("thực tế Circa đã nhận 1 POST (lô 1 vẫn đi), không có lần gửi lại", submits().length === 1, submits().length);
  check("đối chiếu (bước 5) vẫn chạy", r.s.rc && !r.s.rc.err && typeof r.s.rc.ok === "boolean", r.s.rc);
  check("khoá gửi đã nhả", Object.keys(await sendLocks()).length === 0);
  const log = await dl(p, "#btn-log");
  check("sổ ghi ghi lô 1 dừng “không rõ”", JSON.parse(log.text).lo[0].dung === "không rõ", JSON.parse(log.text).lo.map(x => x.dung));
  await shot(p, "B6-panel-khong-ro.png");
  await p.close();
}

async function T9() {
  scen("T9", "Token không lọt: storage extension, sổ ghi, DOM, console, URL; không hộp thoại trình duyệt, không lỗi JS");
  const st = JSON.stringify(await storageDump());
  const toks = [m.tokens.circa, m.tokens.nw];
  check("chrome.storage.local không chứa token", toks.every(t => st.indexOf(t) < 0), st.length + " ký tự");
  check("file tải về không chứa token", ALL.downloads.every(d => toks.every(t => d.text.indexOf(t) < 0)), ALL.downloads.length + " file");
  check("DOM panel + thanh trạng thái không chứa token", ALL.texts.length >= 2 && ALL.texts.every(x => toks.every(t => x.indexOf(t) < 0)), ALL.texts.length + " mẫu, " + ALL.texts.reduce((a, x) => a + x.length, 0) + " ký tự");
  const cons = ALL.console.join("\n");
  check("console các trang không chứa token", toks.every(t => cons.indexOf(t) < 0), ALL.console.length + " dòng");
  const urls = m.nw.log.map(e => e.path + JSON.stringify(e.query)).concat(m.circa.log.map(e => e.url || "")).join("\n");
  check("không token nào trong URL gửi tới máy chủ giả", toks.every(t => urls.indexOf(t) < 0));
  check("không bật alert / confirm / beforeunload", ALL.dialogs.length === 0, ALL.dialogs.slice(0, 3));
  check("không có lỗi JS trên các trang", ALL.errors.length === 0, ALL.errors.slice(0, 3));
  const csp = ALL.console.filter(x => /Content Security Policy|Refused to/i.test(x));
  check("không vi phạm CSP", csp.length === 0, csp.slice(0, 2));
  const bad = await sw.evaluate(() => [
    self.__KK_TEST__.check("POST", "http://" + location.host + "/x", {}).ok,
    self.__KK_TEST__.check("POST", self.KKCFG.CIRCA_API + "/v1/inventory/count/sessions", { pos_id: "x" }).ok,
    self.__KK_TEST__.check("POST", self.KKCFG.NW_API + "/api/v1/auth/refresh", {}).ok,
    self.__KK_TEST__.check("GET", "https://api.v2.circa.vn/v1/authz/me").ok
  ]);
  check("bảng API trong service worker của bản thử chặn tạo phiên Circa, /auth/refresh, host thật", bad.every(x => x === false), bad);
}

(async () => {
  const pw = loadPlaywright(), exe = chromiumExe();
  if (!pw || !exe) {
    console.log("KHÔNG CHẠY ĐƯỢC: " + (!pw ? "không tìm thấy Playwright" : "không tìm thấy Chromium đầy đủ trong %LOCALAPPDATA%/ms-playwright/chromium-*") + ". Không tự tải từ mạng.");
    process.exitCode = 2; return;
  }
  fx = X.demoFixture(XLSX);
  fx2 = X.demoFixture(XLSX, { bulk: 155 });
  m = await X.start({ fixture: fx });
  console.log("máy chủ giả:", JSON.stringify(m.urls));
  B.build({ outDir: EXTD, test: { admin: m.urls.admin, circaApi: m.urls.circaApi, nwApp: m.urls.nwApp, nwApi: m.urls.nwApi, timeoutMs: 5000, retryBaseMs: 50 } });
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "kk-ext-ud-"));
  try {
    ctx = await pw.chromium.launchPersistentContext(ud, { headless: true, executablePath: exe, acceptDownloads: true, viewport: { width: 1280, height: 900 },
      args: ["--disable-extensions-except=" + EXTD, "--load-extension=" + EXTD] });
    sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 15000 });
    extId = new URL(sw.url()).host;
    console.log("Chromium:", exe, "· extension", extId);
    for (const [id, fn] of [["A1", A1], ["A2", A2], ["A3", A3], ["A4", A4], ["A5", A5], ["A6", A6], ["A7", A7], ["C1", C1], ["W1", W1], ["B1", B1], ["B2", B2], ["B3", B3], ["B4", B4], ["B5", B5], ["B6", B6]]) {
      if (!want(id)) continue;
      try { await fn(); } catch (e) { if (!cur || cur.id !== id) scen(id, "(lỗi trước khi bắt đầu)"); check("kịch bản chạy hết không ném lỗi", false, String(e && e.stack || e).split("\n").slice(0, 4).join(" | ")); }
    }
    if (want("T9")) await T9();
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    await m.close();
    fs.rmSync(ud, { recursive: true, force: true });
  }
  console.log("\n================ TÓM TẮT ================");
  let nOk = 0, nBad = 0;
  for (const r of RESULTS) {
    const bad = r.checks.filter(c => !c.ok).length;
    nOk += r.checks.length - bad; nBad += bad;
    console.log((bad ? "LỖI " : "ĐẠT ") + "      " + r.id + " " + r.title + " (" + (r.checks.length - bad) + "/" + r.checks.length + ")");
  }
  console.log(nOk + " kiểm tra đạt, " + nBad + " lỗi");
  fs.writeFileSync(path.join(TMPD, "ket-qua-test-ext-ui.json"), JSON.stringify(RESULTS, null, 1));
  console.log("kết quả chi tiết:", path.join(TMPD, "ket-qua-test-ext-ui.json"));
  if (nBad) process.exitCode = 1;
})();
