// KIỂM THỬ TRÌNH DUYỆT extension "Kiểm kê Circa ↔ NW" v0.2.1 (BẢN THỬ) với MÁY CHỦ GIẢ (mock-ext-server.js, 4 cổng trên 127.0.0.1).
// Không gọi Circa / NW thật, không dùng token thật (token giả sinh mỗi lần chạy), dữ liệu GIẢ (X.scenario). Ghi ảnh + file tải về vào outDir.
//
// Dùng (cwd bất kỳ):
//   node tools/nw-sang-circa/test-ext-ui.js [outDir]
//   outDir mặc định work/20261122-kiem-ke-circa-nw-ext/out (ảnh → <outDir>/shots, file tải về → <outDir>/test-ext-ui, bản thử → <outDir>/ext-test)
//   Env: KB=U1,U2,… chỉ chạy các kịch bản đó; PW_CHROME=<chrome.exe> nếu không tìm được Chromium.
// Cần Playwright (require("playwright") hoặc bản trong %LOCALAPPDATA%/npm-cache/_npx) và Chromium ĐẦY ĐỦ (không phải headless shell:
// headless shell không nạp extension) trong %LOCALAPPDATA%/ms-playwright/chromium-*. Không tự tải gì từ mạng.
//
// Kịch bản:
//   U1 nút "Gửi sang Circa" trên web NW: chỉ ở /<locale>/stock/reconciliation (kể cả đổi đường dẫn kiểu SPA), click giả bị bỏ qua, bấm thật mở panel
//   U2 luồng chính: 1 phiên Circa + 2 phiên NW → gửi đúng tập thẻ vào đúng 1 phiên Circa; danh sách chỉ phiên OPEN / in_progress đúng kho;
//      bấm gửi 2 lần, mở lại panel → không gửi thêm
//   U3 phiên Circa đóng giữa chừng (400 FAILED_PRECONDITION) → dừng; phiên đóng trước khi gửi → không gửi
//   U4 5xx → gửi lại nguyên lô; 4 lần 5xx → dừng     U5 401 (NW khi tải file / danh sách, Circa khi gửi)
//   U6 2 panel cùng phiên Circa → khoá gửi           U7 mất cổng background giữa lô → KHÔNG RÕ, không gửi lại
//   U8 thiếu quyền inventory_count.manage → khoá gửi  U9 không ghép được kho / 2 kho / thiếu totalPages / thiếu data.total / không có tab admin
//   U10 phiên Circa > 1.000 lượt quét (1.502 có sẵn + 159 gửi): đọc bằng MỘT request limit=60000 (không offset), đối chiếu ĐẠT, mở lại
//       không gửi; máy chủ có trần (has_more=true) → không lập kế hoạch / đối chiếu không ĐẠT, không gửi, thông báo đúng
//   U11 ngoại lệ bất ngờ giữa lô (móc thử) → KHÔNG RÕ, nhả khoá, vẫn đối chiếu
//   U12 tính lại sau khi giữ khoá: 2 panel chọn 2 phiên NW khác nhau cho cùng SP → panel sau không gửi SP đó
//   U13 lượt mới chen vào giữa summary và lượt quét → lần đọc đầu lệch tổng, đọc lại ĐẠT; gửi; đối chiếu ĐẠT (không "lặp" sai)
//   U14 lượt QR khác mã của SP 900001 nằm sâu trong danh sách (vị trí > 1.000) → đọc đủ bằng 1 request, 900001 để riêng, không gửi
//   U15 đọc không ổn định (luôn trùng id): ở xem trước / sau khi giữ khoá / sau gửi → không gửi mã nào, đối chiếu không báo ĐẠT
//   U16 lỗi đọc khác: summary lệch, lượt thiếu id, summary thiếu total_scans, has_more thiếu / không phải boolean, product_id null → không gửi, báo rõ
//   U17 ngoại lệ bất ngờ trong kiểm lại trước khi giữ khoá / trong đối chiếu (móc thử) → trang không đứng, hiện lỗi, bấm lại được
//   U18 phiên lớn: 59.702 lượt, response ≈ 55 MB qua background ↔ panel → xem trước, gửi, đối chiếu ĐẠT; response > 60 MiB → dừng (trần
//       kích thước), không gửi; phiên > 60.000 lượt → has_more=true → dừng
//   T9 token không lọt, không hộp thoại / lỗi JS / CSP, bảng API trong service worker; máy chủ giả KHÔNG nhận request lượt quét nào có
//      offset (cả mọi kịch bản), mọi request lượt quét đúng limit=60000
//   T10 CSP extension_pages (connect-src chỉ 2 API) + không quyền tabs: service worker / panel không gọi được host khác
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), http = require("http");
const X = require("./mock-ext-server.js");
const B = require("./build-ext.js");
const NWC = require("./core.js");
const ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "work/20261122-kiem-ke-circa-nw-ext/out"));
const SHOTS = path.join(OUT, "shots"), TMPD = path.join(OUT, "test-ext-ui"), EXTD = path.join(OUT, "ext-test");
const ONLY = process.env.KB ? process.env.KB.split(",").map(s => s.trim()) : null;
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
const iso = t => new Date(t).toISOString();
const sameSet = (a, b) => a.length === b.length && new Set(a.map(NWC._codeKey)).size === a.length && b.every(x => new Set(a.map(NWC._codeKey)).has(NWC._codeKey(x)));

let m, ctx, sw, extId, SC;
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

const submits = () => m.circa.log.filter(e => e.method === "POST" && e.path === "/v1/inventory/count/submit-rfid-batch");
const circaReq = () => m.circa.log.filter(e => e.method !== "OPTIONS");
const nwReq = () => m.nw.log.filter(e => e.method !== "OPTIONS");
async function storageDump() { return sw.evaluate(() => Promise.all([chrome.storage.local.get(null), chrome.storage.session.get(null)])); }
async function sendLocks() { return sw.evaluate(() => self.__KK_TEST__.sendLocks()); }
// mọi request lượt quét máy chủ giả đã nhận, gom qua MỌI kịch bản (log bị xoá ở resetAll): v0.2.1 không bao giờ gửi offset
const SCANLOG = { n: 0, withOffset: [], badQuery: [], maxBytes: 0, maxRows: 0 };
function harvestScans() {
  for (const e of m.circa.log) {
    if (e.method !== "GET" || !/\/scans$/.test(e.path)) continue;
    SCANLOG.n++;
    if (Object.prototype.hasOwnProperty.call(e.query, "offset")) SCANLOG.withOffset.push(e.url);
    if (JSON.stringify(e.query) !== JSON.stringify({ limit: "60000" })) SCANLOG.badQuery.push(e.url);
    if (e.bytes > SCANLOG.maxBytes) SCANLOG.maxBytes = e.bytes;
    if (e.scansOut > SCANLOG.maxRows) SCANLOG.maxRows = e.scansOut;
  }
}
async function resetAll() {
  harvestScans();
  m.circa.reset(); m.circa.cfg = { token: m.tokens.circa, adminNoStore: true };
  m.nw.reset();
  await sw.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]).then(() => { self.__KK_TEST__.dropSubmit = 0; }));
  await closeAll(/^http:\/\/127\.0\.0\.1|chrome-extension:/);
}
// dữ liệu một kịch bản: phiên Circa S1 (Lumina, OPEN, đã có 2 lượt), S2 (Florita, OPEN), S3 (Lumina, CLOSED) + 25 phiên CLOSED cũ (2 trang);
// phiên NW R1 (Lumina, cũ), R2 (Lumina, mới) in_progress + R3 completed, R4 Florita, R5 cancelled, R6 kho lệch dấu + 25 phiên completed cũ (2 trang)
function setup() {
  for (const [c, d] of SC.lookups) m.circa.setLookup(c, d);
  const now = Date.now();
  const S1 = m.circa.addSession({ code: "ICS90001", pos_id: X.LUMINA, created_at: iso(now - 60000), created_by_name: "Thu Lumina" });
  const S2 = m.circa.addSession({ code: "ICS90002", pos_id: X.FLORITA, created_at: iso(now - 120000) });
  const S3 = m.circa.addSession({ code: "ICS90003", pos_id: X.LUMINA, status: "CLOSED", created_at: iso(now - 30000) });
  for (let i = 0; i < 25; i++) m.circa.addSession({ code: "ICS8" + String(i).padStart(4, "0"), pos_id: X.LUMINA, status: "CLOSED", created_at: iso(now - 86400000 - i * 60000) });
  m.circa.addScan(S1.id, SC.existing.foreign); m.circa.addScan(S1.id, SC.existing.mine);
  const W = X.WH;
  const R1 = m.nw.addRec({ warehouseId: W.lumina, createdAt: iso(now - 7200000), notes: "R1 (giả)", xlsx: SC.r1 });
  const R2 = m.nw.addRec({ warehouseId: W.lumina, createdAt: iso(now - 3600000), notes: "R2 (giả)", xlsx: SC.r2 });
  const R3 = m.nw.addRec({ warehouseId: W.lumina, status: "completed", createdAt: iso(now - 600000), xlsx: SC.r2 });
  const R4 = m.nw.addRec({ warehouseId: W.florita, createdAt: iso(now - 1200000), xlsx: SC.r2 });
  const R5 = m.nw.addRec({ warehouseId: W.lumina, status: "cancelled", createdAt: iso(now - 1800000), xlsx: SC.r2 });
  const R6 = m.nw.addRec({ warehouseId: W.accent, createdAt: iso(now - 2400000), xlsx: SC.r2 });
  for (let i = 0; i < 25; i++) m.nw.addRec({ warehouseId: W.lumina, status: "completed", createdAt: iso(now - 86400000 - i * 60000) });
  return { S1, S2, S3, R1, R2, R3, R4, R5, R6 };
}
// trang đăng nhập giả: admin (cookie Circa) + web NW (token NW, trang danh sách đối chiếu)
async function loginPages() {
  const admin = await newPage(m.urls.admin + "/", "admin");
  const nw = await newPage(m.urls.nwApp + "/vi/stock/reconciliation", "nw");
  return { admin, nw };
}
const psum = p => p.evaluate(() => window.__KK_PANEL__ && window.__KK_PANEL__.summary());
async function pwait(p, pred, ms) {
  await p.waitForFunction(new Function("var s = window.__KK_PANEL__ && window.__KK_PANEL__.summary(); return !!s && !s.busy && (" + pred + ");"), null, { timeout: ms || 60000, polling: 100 });
  return psum(p);
}
async function openPanelUrl(tag) {
  const p = await newPage("chrome-extension://" + extId + "/panel.html", tag || "panel");
  await pwait(p, "!!s.circa", 30000);
  return p;
}
// nút trên web NW (bản thử: shadow root mở)
async function btnState(p) {
  return p.evaluate(() => {
    const hs = document.querySelectorAll("kk-circa-nw-btn"), h = hs[0], b = h && h.shadowRoot && h.shadowRoot.querySelector("[data-act=\"open-panel\"]");
    return { hosts: hs.length, btn: !!b, text: b ? b.textContent : null, msg: h && h.shadowRoot && h.shadowRoot.querySelector("[data-role=msg]") ? h.shadowRoot.querySelector("[data-role=msg]").textContent : null };
  });
}
async function waitBtn(p, on, ms) {
  const t0 = Date.now();
  let s = null;
  while (Date.now() - t0 < (ms || 5000)) { s = await btnState(p).catch(() => null); if (s && s.btn === on) return s; await sleep(100); }
  return s;
}
async function openPanelBtn(nw) {
  const [p] = await Promise.all([ctx.waitForEvent("page", { timeout: 15000 }), nw.locator("[data-act=\"open-panel\"]").click()]);
  watchPage(p, "panel");
  await p.waitForLoadState("domcontentloaded");
  await pwait(p, "!!s.circa", 30000);
  return p;
}
async function pick(p, sid) {
  await p.click("input[name=circa][value=\"" + sid + "\"]");
  return pwait(p, "s.sel && s.sel.id === " + JSON.stringify(sid) + " && s.chk && (s.nw || s.chk.problems.some(function (x) { return !/inventory_count/.test(x); }))", 30000);
}
async function preview(p, ids) {
  for (const id of ids) {
    await p.click("input[data-nw=\"" + id + "\"]");
    await pwait(p, "s.nwSel.indexOf(" + JSON.stringify(id) + ") >= 0", 10000);
  }
  await p.click("#btn-preview");
  return pwait(p, "s.pv && (s.pv.err || s.rows || s.beforeErr || (s.lookup && s.lookup.abort) || (s.fin && (s.fin.pending || s.fin.blockers.length)))", 120000);
}
async function sendConfirm(p, dbl) {
  if (dbl) await p.dblclick("#btn-send"); else await p.click("#btn-send");
  await p.waitForSelector("#modal:not([hidden])", { timeout: 15000 });
  const t = await p.textContent("#modal");
  await p.click("#modal-ok");
  return t;
}
async function send(p, dbl) {
  const modal = await sendConfirm(p, dbl);
  const s = await pwait(p, "s.sendDone && s.rc", 120000);
  return { s, modal };
}
async function dl(p, sel) {
  const [d] = await Promise.all([p.waitForEvent("download", { timeout: 15000 }), p.click(sel)]);
  const f = path.join(TMPD, d.suggestedFilename());
  await d.saveAs(f);
  const text = fs.readFileSync(f, "utf8");
  ALL.downloads.push({ f, text });
  return { f, text };
}
const sentCodes = () => submits().flatMap(e => NWC.bodyCodes(e.body));

// ================= KỊCH BẢN =================
async function U1() {
  scen("U1", "Nút “Gửi sang Circa” chỉ trên /<locale>/stock/reconciliation (cả khi đổi đường dẫn kiểu SPA); click giả bị bỏ qua; bấm thật mở panel");
  await resetAll();
  setup();
  const { nw } = await loginPages();
  let b = await waitBtn(nw, true);
  check("trang /vi/stock/reconciliation: có đúng 1 nút “Gửi sang Circa”", b && b.hosts === 1 && b.btn && /Gửi sang Circa/.test(b.text), b);
  const p2 = await newPage(m.urls.nwApp + "/vi/dashboard", "nw-2");
  for (const u of ["/vi/dashboard", "/vi/stock/reconciliation/" + "0f0f0f0f-0000-4000-8000-000000000000", "/stock/reconciliation", "/vi/stock/reconciliations"]) {
    await p2.goto(m.urls.nwApp + u);
    await sleep(900);
    b = await btnState(p2);
    check("trang " + u + ": không có nút", b && b.hosts === 0, b);
  }
  await p2.goto(m.urls.nwApp + "/en/stock/reconciliation");
  b = await waitBtn(p2, true);
  check("trang /en/stock/reconciliation: có nút", b && b.btn, b);
  await p2.goto(m.urls.nwApp + "/vi/dashboard");
  await p2.click("#go-list");
  b = await waitBtn(p2, true, 4000);
  check("SPA: đổi đường dẫn sang danh sách đối chiếu (pushState) → nút hiện", b && b.btn && b.hosts === 1, b);
  await p2.click("#go-detail");
  b = await waitBtn(p2, false, 4000);
  check("SPA: vào trang chi tiết phiên → nút gỡ", b && !b.btn && b.hosts === 0, b);
  await p2.click("#go-list"); await waitBtn(p2, true, 4000);
  await p2.click("#go-home");
  b = await waitBtn(p2, false, 4000);
  check("SPA: về trang chủ → nút gỡ", b && b.hosts === 0, b);
  await p2.close();
  const n0 = ctx.pages().length;
  await nw.evaluate(() => document.querySelector("kk-circa-nw-btn").shadowRoot.querySelector("[data-act=\"open-panel\"]").click());
  await nw.evaluate(() => document.querySelector("kk-circa-nw-btn").shadowRoot.querySelector("[data-act=\"open-panel\"]").dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await sleep(1500);
  check("click giả từ script trang (không isTrusted) → không mở tab", ctx.pages().length === n0, { truoc: n0, sau: ctx.pages().length });
  const panel = await openPanelBtn(nw);
  check("bấm thật → mở tab panel.html (không tham số)", panel.url() === "chrome-extension://" + extId + "/panel.html", panel.url());
  const s = await psum(panel);
  check("panel tự tải danh sách phiên Circa", s.circa && !s.circa.err && s.circa.ids.length === 2, s.circa);
  check("mở panel không gọi API NW nào, không POST lên Circa", nwReq().length === 0 && circaReq().every(e => e.method === "GET"), { nw: nwReq().length, circa: [...new Set(circaReq().map(e => e.method + " " + e.path))] });
  b = await btnState(nw);
  check("nút vẫn ở trạng thái thường sau khi mở panel (không báo lỗi)", b && b.btn && !b.msg, b);
  await shot(nw, "U1-nw-nut-gui-sang-circa.png");
  // chỉ phần extension vẽ (phần tử chủ + shadow root). KHÔNG lấy HTML cả trang: trang NW giả tự nhúng token giả trong script của nó.
  ALL.texts.push("nw U1: " + await nw.evaluate(() => { const h = document.querySelector("kk-circa-nw-btn"); return h ? h.outerHTML + "\n" + h.shadowRoot.innerHTML : ""; }));
  const pageHtml = await nw.evaluate(() => document.documentElement.outerHTML);
  check("mẫu kiểm token hợp lệ: trang NW giả có nhúng token giả (để chắc phép kiểm T9 bắt được nếu extension làm lộ)", pageHtml.indexOf(m.tokens.nw) >= 0);
  await panel.close();
}

async function U2() {
  scen("U2", "Luồng chính: chọn 1 phiên Circa + 2 phiên NW → gửi đúng tập thẻ vào đúng 1 phiên Circa; bấm gửi 2 lần / mở lại → không gửi thêm");
  await resetAll();
  const D = setup();
  const { nw } = await loginPages();
  const panel = await openPanelBtn(nw);
  let s = await psum(panel);
  check("danh sách phiên Circa: chỉ phiên OPEN (S1 Lumina, S2 Florita), mới tạo trước; đọc 2 trang (28 phiên)", JSON.stringify(s.circa.ids) === JSON.stringify([D.S1.id, D.S2.id]) && s.circa.pages === 2 && s.circa.read === 28 && !s.circa.more, s.circa);
  const lst = circaReq().filter(e => e.path === "/v1/inventory/count/sessions");
  check("danh sách phiên Circa: GET page=1,2 limit=20, KHÔNG có X-Store-Id", lst.length === 2 && lst.every(e => e.method === "GET" && e.h.store === null && e.query.limit === "20") && lst.map(e => e.query.page).join() === "1,2", lst.map(e => ({ q: e.query, store: e.h.store })));
  await shot(panel, "U2-panel-buoc-1.png");
  s = await pick(panel, D.S1.id);
  check("chọn S1: phiên OPEN, có quyền manage, không lỗi", s.chk && s.chk.problems.length === 0 && s.chk.authz.manage === true && s.chk.storeName === "CIRCA LUMINA", s.chk);
  check("kho NW ghép theo tên cửa hàng = CIRCA LUMINA", s.nw && s.nw.wh && s.nw.wh.id === X.WH.lumina && !s.nw.err, s.nw && s.nw.wh);
  check("danh sách phiên NW: chỉ in_progress của kho Lumina (R2, R1), đọc 2/2 trang; bỏ completed / cancelled / Florita / kho lệch dấu", s.nw && JSON.stringify(s.nw.ids) === JSON.stringify([D.R2.id, D.R1.id]) && s.nw.pages === 2 && !s.nw.more, s.nw);
  const recl = nwReq().filter(e => e.path === "/api/v1/stock/reconciliations");
  check("danh sách phiên NW: GET page=1,2 limit=25", recl.length === 2 && recl.every(e => e.query.limit === "25") && recl.map(e => e.query.page).join() === "1,2", recl.map(e => e.query));
  check("chưa chọn phiên NW thì nút Xem trước khoá", s.previewDisabled === true);
  s = await preview(panel, [D.R1.id, D.R2.id]);
  check("xem trước: không lỗi", !s.pv.err && !s.beforeErr && s.lookup && !s.lookup.abort && s.fin && !s.fin.pending && s.fin.blockers.length === 0, { pv: s.pv.err, before: s.beforeErr, lookup: s.lookup, blockers: s.fin && s.fin.blockers });
  const pids = s.fin.products.map(p => p.pid).sort();
  check("SP gửi = " + SC.sendSp.join(", "), JSON.stringify(pids) === JSON.stringify(SC.sendSp.slice().sort()), pids);
  const src = Object.fromEntries(s.fin.products.map(p => [p.pid, p.nwId]));
  check("SP khớp ở 2 phiên (900002 thẻ khác nhau, 900003 cùng thẻ) lấy từ R2 (quét muộn hơn); SP chỉ ở R1 lấy từ R1", src[900002] === D.R2.id && src[900003] === D.R2.id && src[900001] === D.R1.id && src[900007] === D.R1.id && src[900006] === D.R2.id && src[900011] === D.R2.id, src);
  const asideGot = Object.fromEntries(s.fin.aside.map(a => [a.pid, a.reason]));
  check("để riêng đúng lý do: 900004 thủ công, 900008 thẻ không gửi, 900009 không nhất quán, 900010 phiên Circa đã có lượt khác", JSON.stringify(asideGot) === JSON.stringify(SC.aside) || Object.keys(SC.aside).every(k => asideGot[k] === SC.aside[k]) && Object.keys(asideGot).length === 4, asideGot);
  check("SP Thiếu (900005) không có trong bảng (không gửi, chỉ đếm theo trạng thái)", !s.rows.some(r => r.pid === 900005) && s.pv.files.some(f => f.counts && f.counts["Thiếu"] === 1), s.pv.files.map(f => f.counts));
  const rK = s.rows.find(r => r.pid === 900011);
  check("900011: phiên Circa đã có 1/3 thẻ của ta → gửi phần thiếu 2 thẻ", rK && rK.status === "gui-thieu" && rK.have === 1 && rK.send === 2, rK);
  check("chia " + 2 + " lô, bỏ qua 1 mã đã có; tổng gửi " + SC.send.length + " thẻ", s.bodies && s.bodies.n === 2 && s.bodies.excluded === 1 && s.total.send === SC.send.length, { bodies: s.bodies, send: s.total && s.total.send });
  const looked = circaReq().filter(e => e.path === "/v1/inventory/count/qr-lookup").map(e => e.query.qr_code);
  check("không tra thẻ của 900002 ở R1 (phiên không được chọn cho SP này)", SC.skipR1B.every(c => looked.indexOf(c) < 0), SC.skipR1B);
  check("tra mã dùng pos_id + X-Store-Id của phiên S1 (Lumina)", circaReq().filter(e => e.path === "/v1/inventory/count/qr-lookup").every(e => e.query.pos_id === X.LUMINA && e.h.store === X.LUMINA));
  await shot(panel, "U2-panel-xem-truoc.png");
  check("chưa xác nhận thì chưa gửi gì", submits().length === 0, submits().length);
  // bấm đúp nút gửi: chỉ 1 hộp xác nhận
  const modal = await sendConfirm(panel, true);
  await panel.click("#btn-send", { force: true, timeout: 1500 }).catch(() => {});
  await panel.click("#modal-ok", { force: true, timeout: 1500 }).catch(() => {});
  s = await pwait(panel, "s.sendDone && s.rc", 120000);
  check("hộp xác nhận trong trang nêu phiên Circa, 2 phiên NW, số thẻ", /ICS90001/.test(modal) && modal.indexOf(D.R1.id.slice(0, 8)) >= 0 && modal.indexOf(D.R2.id.slice(0, 8)) >= 0 && modal.indexOf("Gửi " + SC.send.length + " thẻ") >= 0, modal.slice(0, 200));
  const sub = submits();
  check("bấm gửi 2 lần → đúng 2 POST submit (2 lô, mỗi lô 1 lần)", sub.length === 2 && s.batches.length === 2 && s.batches.every(b => b.ok && b.tries === 1) && !s.sendStop, { posts: sub.length, batches: s.batches });
  check("mọi POST vào ĐÚNG phiên S1, X-Store-Id Lumina, device NW-RFID, ≤ 100 mã/lô", sub.every(e => e.body.session_id === D.S1.id && e.h.store === X.LUMINA && e.body.device_id === "NW-RFID" && NWC.bodyCodes(e.body).length <= 100), sub.map(e => [e.body.session_id.slice(0, 8), e.h.store && e.h.store.slice(0, 8), NWC.bodyCodes(e.body).length]));
  check("tập mã gửi = đúng tập mong đợi (" + SC.send.length + " mã, không trùng, không mã thừa)", sameSet(sentCodes(), SC.send), { gui: sentCodes().length, mongDoi: SC.send.length });
  check("không gửi thẻ để riêng / thẻ R1 của 900002 / thẻ đã có", SC.notSent.concat(SC.skipR1B).every(c => sentCodes().map(NWC._codeKey).indexOf(NWC._codeKey(c)) < 0));
  const kem = sub.flatMap(e => e.body.items || []);
  check("thẻ lệch quy đổi (900007) gửi kèm đơn vị gốc {gói, 8}", kem.length === 1 && kem[0].unit_name === "gói" && kem[0].quantity === 8, kem);
  check("đối chiếu ĐẠT: gốc Circa các SP đã gửi = gốc NW = " + (SC.sendBase + 1), s.rc && s.rc.ok && s.rc.circaBase === SC.sendBase + 1 && s.rc.nwBase === SC.sendBase + 1 && s.rc.ours === 0 && s.rc.others === 1, s.rc);
  check("phiên S2 (Florita) và S3 không nhận lượt nào", m.circa.sessions.get(D.S2.id).sim.scans().length === 0 && m.circa.sessions.get(D.S3.id).sim.scans().length === 0 && sub.every(e => e.body.session_id === D.S1.id));
  check("API NW: chỉ GET (không tạo / đóng / sửa phiên NW)", nwReq().every(e => e.method === "GET"), [...new Set(nwReq().map(e => e.method))]);
  check("API Circa: POST duy nhất là submit-rfid-batch", circaReq().filter(e => e.method !== "GET").every(e => e.method === "POST" && e.path === "/v1/inventory/count/submit-rfid-batch"), [...new Set(circaReq().filter(e => e.method !== "GET").map(e => e.method + " " + e.path))]);
  check("lệnh gắn phiên (GET phiên, scans, authz, lookup, submit) có X-Store-Id = pos của S1", circaReq().filter(e => e.path !== "/v1/inventory/count/sessions").every(e => e.h.store === X.LUMINA), [...new Set(circaReq().filter(e => e.h.store !== X.LUMINA).map(e => e.path))]);
  check("phiên Circa vẫn OPEN, phiên NW vẫn in_progress", m.circa.sessions.get(D.S1.id).status === "OPEN" && D.R1.status === "in_progress" && D.R2.status === "in_progress");
  await shot(panel, "U2-panel-doi-chieu-dat.png");
  const log = await dl(panel, "#btn-log");
  const j = JSON.parse(log.text);
  const src2 = Object.fromEntries((j.phienNguon || []).map(x => [x.pid, x.nwId]));
  check("sổ ghi: phiên Circa, 2 phiên NW đã chọn, phiên nguồn từng SP, danh sách để riêng kèm lý do, 2 lô, đối chiếu ok",
    j.phienCirca && j.phienCirca.id === D.S1.id && JSON.stringify(j.phienNWDaChon.slice().sort()) === JSON.stringify([D.R1.id, D.R2.id].sort()) && src2[900002] === D.R2.id &&
    j.deRieng.length === 4 && j.deRieng.every(x => x.lyDo && x.nhan) && j.lo.length === 2 && j.doiChieu && j.doiChieu.ok === true, { phienNW: j.phienNWDaChon, deRieng: (j.deRieng || []).map(x => x.pid + ":" + x.lyDo), lo: (j.lo || []).length });
  const csvf = await dl(panel, "#btn-rc-csv");
  check("CSV đối chiếu theo SP có cột phiên NW nguồn", /Phiên NW nguồn/.test(csvf.text) && csvf.text.indexOf(D.R2.id) >= 0);
  ALL.texts.push("panel U2: " + await panel.evaluate(() => document.documentElement.outerHTML + "\n" + document.body.innerText + "\n" + JSON.stringify(window.__KK_PANEL__.summary())));
  await panel.click("#btn-send", { force: true, timeout: 1500 }).catch(() => {});
  await sleep(500);
  check("bấm lại nút gửi trên panel đã gửi → không gửi thêm", submits().length === 2, submits().length);
  await panel.close();
  // mở lại panel: mọi thẻ đã có → không còn gì để gửi
  const p2 = await openPanelUrl("panel-2");
  await pick(p2, D.S1.id);
  s = await preview(p2, [D.R2.id, D.R1.id]);
  const st = Object.fromEntries((s.rows || []).filter(r => r.status !== "de-rieng").map(r => [r.pid, r.status]));
  check("mở lại panel: mọi SP gửi đều “đã có”, 0 lô, nút gửi khoá", s.bodies && s.bodies.n === 0 && s.bodies.excluded === SC.send.length + 1 && SC.sendSp.every(p => st[p] === "da-co") && s.sendDisabled === true, { bodies: s.bodies, st, sendDisabled: s.sendDisabled });
  await p2.click("#btn-send", { force: true, timeout: 1500 }).catch(() => {});
  await sleep(500);
  check("không có POST submit nào thêm", submits().length === 2, submits().length);
  await shot(p2, "U2-panel-mo-lai-da-co.png");
  await p2.close();
}

async function U3() {
  scen("U3", "Phiên Circa đóng giữa chừng (lô 2 trả 400 FAILED_PRECONDITION) → dừng; phiên đóng trước khi bấm gửi → không gửi gì");
  await resetAll();
  let D = setup();
  let L = await loginPages();
  let p = await openPanelUrl();
  await pick(p, D.S1.id);
  await preview(p, [D.R1.id, D.R2.id]);
  m.circa.cfg.submit400At = 2;
  const r = await send(p);
  check("lô 1 ĐẠT, lô 2 400 FAILED_PRECONDITION → dừng, không gửi lại", r.s.batches.length === 2 && r.s.batches[0].ok && r.s.batches[1].tries === 1 && r.s.batches[1].stop === "phiên không mở" && /FAILED_PRECONDITION/.test(r.s.sendStop) && submits().length === 2, { batches: r.s.batches, stop: r.s.sendStop });
  check("đối chiếu vẫn chạy và báo CHƯA ĐẠT", r.s.rc && r.s.rc.ok === false && !r.s.rc.err, r.s.rc);
  check("khoá gửi đã nhả", Object.keys(await sendLocks()).length === 0);
  await shot(p, "U3-panel-phien-dong-giua-chung.png");
  await p.close(); await L.admin.close(); await L.nw.close();
  await resetAll();
  D = setup(); L = await loginPages();
  p = await openPanelUrl();
  await pick(p, D.S1.id);
  const s0 = await preview(p, [D.R1.id, D.R2.id]);
  check("xem trước đạt khi phiên còn OPEN", s0.bodies && s0.bodies.n === 2, s0.bodies);
  m.circa.sessions.get(D.S1.id).status = "CLOSED";
  await p.click("#btn-send");
  const s = await pwait(p, "/không còn sẵn sàng/.test(s.sendMsgText)", 20000);
  const modalOpen = await p.isVisible("#modal");
  check("phiên đóng trước khi gửi → báo “không còn sẵn sàng”, không mở hộp xác nhận, 0 POST", !modalOpen && submits().length === 0 && !s.sendStarted, { msg: s.sendMsgText.slice(0, 120), modalOpen, posts: submits().length });
  await p.close();
}

async function U4() {
  scen("U4", "Lô 1 trả 500, 502 rồi 200 → gửi lại NGUYÊN lô, ĐẠT; lô 1 lỗi 4 lần → DỪNG, không gửi lô 2");
  await resetAll();
  let D = setup(); await loginPages();
  let p = await openPanelUrl();
  await pick(p, D.S1.id); await preview(p, [D.R1.id, D.R2.id]);
  m.circa.cfg.submitFaults = { 1: [{ status: 500 }, { status: 502 }] };
  let r = await send(p);
  const sub = submits();
  check("lô 1 gửi 3 lần rồi ĐẠT, lô 2 gửi 1 lần", r.s.batches.length === 2 && r.s.batches[0].tries === 3 && r.s.batches[0].ok && r.s.batches[1].tries === 1, r.s.batches);
  check("3 lần gửi lô 1 cùng NGUYÊN body", sub.length === 4 && JSON.stringify(sub[0].body) === JSON.stringify(sub[1].body) && JSON.stringify(sub[1].body) === JSON.stringify(sub[2].body), sub.length);
  check("đối chiếu ĐẠT, không đếm dư", r.s.rc && r.s.rc.ok && r.s.rc.circaBase === r.s.rc.nwBase, r.s.rc);
  await p.close();
  await resetAll();
  D = setup(); await loginPages();
  p = await openPanelUrl();
  await pick(p, D.S1.id); await preview(p, [D.R1.id, D.R2.id]);
  m.circa.cfg.submitFaults = { 1: [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }] };
  r = await send(p);
  check("lô 1 lỗi 4 lần (1 + 3 gửi lại) → DỪNG, không gửi lô 2", submits().length === 4 && r.s.batches.length === 1 && /không gửi được sau 4 lần/.test(r.s.sendStop), { gui: submits().length, stop: r.s.sendStop });
  check("đối chiếu vẫn chạy và báo CHƯA ĐẠT", r.s.rc && r.s.rc.ok === false, r.s.rc);
  await shot(p, "U4-panel-dung-5xx.png");
  await p.close();
}

async function U5() {
  scen("U5", "401: NW 401 khi tải file xuất / khi đọc kho → báo mở lại tab NW; Circa 401 khi gửi lô → dừng, không gửi lại");
  await resetAll();
  const D = setup(); await loginPages();
  let p = await openPanelUrl();
  await pick(p, D.S1.id);
  m.nw.cfg.exportFail = 401;
  let s = await preview(p, [D.R1.id]);
  check("NW 401 khi tải file xuất → lỗi, nhắc mở / tải lại tab circa.nextwaves.app; không tra mã", s.pv.err && /Token NW/.test(s.pv.err) && /circa\.nextwaves\.app/.test(s.pv.err) && !s.lookup, s.pv.err);
  m.nw.cfg.exportFail = 0;
  await p.click("#btn-preview");
  s = await pwait(p, "s.pv && (s.pv.err || s.rows || s.beforeErr || (s.fin && s.fin.blockers.length))", 120000);
  check("hết 401 → bấm Xem trước lại được", !s.pv.err && s.rows && s.bodies && s.bodies.n >= 1, { err: s.pv.err, bodies: s.bodies });
  m.circa.cfg.submitFaults = { 1: [{ status: 401 }] };
  const r = await send(p);
  check("Circa 401 ở lô 1 → dừng ngay sau 1 lần gửi, không gửi lô 2", r.s.batches.length === 1 && r.s.batches[0].tries === 1 && r.s.batches[0].stop === "token" && submits().length === 1, r.s.batches);
  check("thông báo nhắc mở / tải lại trang admin Circa", /admin\.v2\.circa\.vn|401/.test(r.s.sendStop), r.s.sendStop);
  await p.close();
  m.circa.cfg.submitFaults = {};
  m.nw.cfg.nw401 = true;
  p = await openPanelUrl();
  s = await pick(p, D.S1.id);
  check("NW 401 khi đọc kho → bước 2 báo lỗi Token NW, không có danh sách phiên NW", s.nw && /Token NW/.test(s.nw.err) && s.nw.ids.length === 0 && s.previewDisabled, s.nw);
  m.nw.cfg.nw401 = false;
  await p.close();
}

async function U6() {
  scen("U6", "2 panel cùng phiên Circa: panel 2 bị từ chối khi panel 1 đang gửi (khoá theo phiên)");
  await resetAll();
  const D = setup(); await loginPages();
  const A = await openPanelUrl("panel-A"), P2 = await openPanelUrl("panel-B");
  await pick(A, D.S1.id); await pick(P2, D.S1.id);
  await preview(A, [D.R1.id, D.R2.id]); await preview(P2, [D.R1.id, D.R2.id]);
  m.circa.cfg.submitFaults = { 1: [{ hang: true, record: true }] };
  await sendConfirm(A);
  await A.waitForFunction(() => window.__KK_PANEL__.summary().sending === true, null, { timeout: 15000, polling: 100 });
  for (let i = 0; i < 50 && submits().length < 1; i++) await sleep(100);
  const lk = await sendLocks();
  check("panel 1 đang gửi giữ khoá gửi của phiên", Object.keys(lk).length === 1 && !!lk["send:" + D.S1.id], lk);
  await sendConfirm(P2);
  const s2 = await pwait(P2, "/khoá gửi/.test(s.sendMsgText)", 20000);
  check("panel 2 bị từ chối (“Đang có panel khác gửi…”), không gửi gì", !s2.sendStarted && /panel khác/.test(s2.sendMsgText) && s2.batches.length === 0, s2.sendMsgText);
  const s1 = await pwait(A, "s.sendDone && s.rc", 90000);
  check("panel 1 gửi xong (lô 1 treo → gửi lại nguyên lô), đối chiếu ĐẠT", s1.rc && s1.rc.ok === true && s1.batches[0].tries === 2, { batches: s1.batches, rc: s1.rc });
  check("Circa nhận 3 POST submit (lô 1 × 2, lô 2 × 1), không có lô nào từ panel 2", submits().length === 3, submits().length);
  check("gửi xong → khoá được nhả", Object.keys(await sendLocks()).length === 0, await sendLocks());
  await shot(P2, "U6-panel-2-bi-tu-choi.png");
  await A.close(); await P2.close();
}

async function U7() {
  scen("U7", "Mất liên lạc với service worker giữa lô (cổng tin đóng) → “KHÔNG RÕ”, không gửi lại, vẫn đối chiếu");
  await resetAll();
  const D = setup(); await loginPages();
  const p = await openPanelUrl();
  await pick(p, D.S1.id); await preview(p, [D.R1.id, D.R2.id]);
  await sw.evaluate(() => { self.__KK_TEST__.dropSubmit = 1; });
  const r = await send(p);
  await sleep(500);
  check("lô 1 dừng với KHÔNG RÕ sau 1 lần, không gửi lại, không gửi lô 2", r.s.batches.length === 1 && r.s.batches[0].tries === 1 && r.s.batches[0].stop === "không rõ" && /KHÔNG RÕ/.test(r.s.sendStop), { batches: r.s.batches, stop: r.s.sendStop });
  check("thực tế Circa đã nhận 1 POST (lô 1 vẫn đi), không có lần gửi lại", submits().length === 1, submits().length);
  check("đối chiếu (bước 5) vẫn chạy", r.s.rc && !r.s.rc.err && typeof r.s.rc.ok === "boolean", r.s.rc);
  check("khoá gửi đã nhả", Object.keys(await sendLocks()).length === 0);
  const log = await dl(p, "#btn-log");
  check("sổ ghi ghi lô 1 dừng “không rõ”", JSON.parse(log.text).lo[0].dung === "không rõ", JSON.parse(log.text).lo.map(x => x.dung));
  await shot(p, "U7-panel-khong-ro.png");
  await p.close();
}

async function U8() {
  scen("U8", "Thiếu quyền Circa inventory_count.manage → vẫn xem trước, nút gửi khoá; không đọc được quyền → chỉ ghi chú");
  await resetAll();
  const D = setup(); await loginPages();
  m.circa.cfg.authz = { success: true, data: { roles: [{ code: "VIEWER", permissions: [{ code: "inventory_count.view" }] }] } };
  let p = await openPanelUrl();
  let s = await pick(p, D.S1.id);
  check("quyền manage = false → bước 1 báo thiếu quyền, vẫn tải danh sách phiên NW", s.chk.authz.manage === false && s.chk.problems.some(x => /inventory_count\.manage/.test(x)) && s.nw && s.nw.ids.length === 2, s.chk);
  s = await preview(p, [D.R1.id, D.R2.id]);
  check("xem trước được nhưng nút Gửi bị khoá", s.rows && s.bodies && s.bodies.n === 2 && s.sendDisabled === true, { bodies: s.bodies, sendDisabled: s.sendDisabled });
  await p.click("#btn-send", { force: true, timeout: 1500 }).catch(() => {});
  await sleep(500);
  check("bấm cố cũng không gửi", submits().length === 0, submits().length);
  await shot(p, "U8-panel-thieu-quyen.png");
  await p.close();
  m.circa.cfg.authz = { success: true, data: { principal: { type: "PERSON" } } };
  p = await openPanelUrl();
  s = await pick(p, D.S1.id);
  check("không đọc được danh sách quyền → không chặn, ghi chú “Không kiểm được quyền”", s.chk.authz.manage === null && s.chk.problems.length === 0 && s.chk.notes.some(n => /Không kiểm được quyền/.test(n)), s.chk);
  await p.close();
}

async function U9() {
  scen("U9", "Không ghép được kho (0 kho / 2 kho), danh sách NW thiếu totalPages, danh sách Circa thiếu data.total, không có tab admin → báo lỗi, không đoán");
  await resetAll();
  const D = setup(); const L = await loginPages();
  m.nw.cfg.warehouses = X.defaultWarehouses().filter(w => w.id !== X.WH.lumina);
  let p = await openPanelUrl();
  let s = await pick(p, D.S1.id);
  check("không có kho NW trùng tên (chỉ có kho lệch dấu, kho đã đóng) → lỗi, không danh sách phiên NW", s.nw && /Không có kho NW/.test(s.nw.err) && s.nw.ids.length === 0 && s.previewDisabled, s.nw);
  m.nw.cfg.warehouses = X.defaultWarehouses().concat([Object.assign({}, X.defaultWarehouses()[0], { id: "a1a1a1a1-0000-4000-8000-00000000000d", name: "Circa Lumina" })]);
  await p.click("#btn-nw");
  s = await pwait(p, "s.nw && s.nw.err", 20000);
  check("2 kho cùng tên (khác hoa thường) → lỗi “Có 2 kho”", /Có 2 kho/.test(s.nw.err), s.nw.err);
  m.nw.cfg.warehouses = null; m.nw.cfg.noTotalPages = true;
  await p.click("#btn-nw");
  s = await pwait(p, "s.nw && s.nw.err", 20000);
  check("danh sách phiên NW không có totalPages → lỗi, không hiện danh sách", /totalPages/.test(s.nw.err) && s.nw.ids.length === 0, s.nw.err);
  m.nw.cfg.noTotalPages = false;
  await p.close();
  m.circa.cfg.listNoTotal = true;
  p = await openPanelUrl();
  s = await psum(p);
  check("danh sách phiên Circa không có data.total → lỗi, không hiện danh sách", s.circa.err && /data\.total/.test(s.circa.err) && s.circa.ids.length === 0, s.circa.err);
  m.circa.cfg.listNoTotal = false;
  await p.close();
  await L.admin.close();
  p = await openPanelUrl();
  s = await psum(p);
  check("không có tab admin Circa → lỗi nhắc mở trang admin.v2.circa.vn", s.circa.err && /admin\.v2\.circa\.vn/.test(s.circa.err), s.circa.err);
  await shot(p, "U9-panel-khong-co-tab-admin.png");
  await p.close();
  check("không có lệnh ghi nào", submits().length === 0 && nwReq().every(e => e.method === "GET"));
}

async function T9() {
  scen("T9", "Token không lọt: storage extension, sổ ghi, DOM, console, URL; không hộp thoại trình duyệt, không lỗi JS / CSP; bảng API trong service worker");
  const st = JSON.stringify(await storageDump());
  const toks = [m.tokens.circa, m.tokens.nw];
  check("chrome.storage (local + session) không chứa token", toks.every(t => st.indexOf(t) < 0), st.length + " ký tự");
  check("file tải về không chứa token", ALL.downloads.every(d => toks.every(t => d.text.indexOf(t) < 0)), ALL.downloads.length + " file");
  check("DOM panel + nút trên web NW không chứa token", ALL.texts.every(x => toks.every(t => x.indexOf(t) < 0)), ALL.texts.length + " mẫu, " + ALL.texts.reduce((a, x) => a + x.length, 0) + " ký tự");
  const cons = ALL.console.join("\n");
  check("console các trang không chứa token", toks.every(t => cons.indexOf(t) < 0), ALL.console.length + " dòng");
  const urls = m.nw.log.map(e => e.path + JSON.stringify(e.query)).concat(m.circa.log.map(e => e.url || "")).join("\n");
  check("không token nào trong URL gửi tới máy chủ giả", toks.every(t => urls.indexOf(t) < 0));
  check("không bật alert / confirm / beforeunload", ALL.dialogs.length === 0, ALL.dialogs.slice(0, 3));
  check("không có lỗi JS trên các trang", ALL.errors.length === 0, ALL.errors.slice(0, 3));
  const csp = ALL.console.filter(x => /Content Security Policy|Refused to/i.test(x));
  check("không vi phạm CSP", csp.length === 0, csp.slice(0, 2));
  const bad = await sw.evaluate(() => [
    self.__KK_TEST__.check("POST", self.KKCFG.CIRCA_API + "/v1/inventory/count/sessions", { pos_id: "x" }).ok,
    self.__KK_TEST__.check("POST", self.KKCFG.NW_API + "/api/v1/stock/reconciliations", { warehouseId: "x" }).ok,
    self.__KK_TEST__.check("POST", self.KKCFG.NW_API + "/api/v1/auth/refresh", {}).ok,
    self.__KK_TEST__.check("POST", self.KKCFG.CIRCA_API + "/v1/inventory/count/sessions/3b3039be-5194-4cfa-958e-0248930a0be6/close", {}).ok,
    self.__KK_TEST__.check("POST", self.KKCFG.NW_API + "/api/v1/stock/reconciliations/3b3039be-5194-4cfa-958e-0248930a0be6/finalize", {}).ok,
    self.__KK_TEST__.check("GET", self.KKCFG.CIRCA_API + "/v1/entity/stores/31493e74-3404-4c0e-a906-93691a6ee319").ok,
    self.__KK_TEST__.check("GET", "https://api.v2.circa.vn/v1/authz/me").ok
  ]);
  check("bảng API trong service worker bản thử chặn tạo phiên (Circa, NW), /auth/refresh, đóng / hoàn tất, entity/stores, host thật", bad.every(x => x === false), bad);
  const okList = await sw.evaluate(() => self.__KK_TEST__.check("GET", self.KKCFG.CIRCA_API + "/v1/inventory/count/sessions?page=1&limit=20").ok);
  check("bảng API cho phép danh sách phiên Circa (page, limit=20)", okList === true);
  const sc = await sw.evaluate(() => {
    const u = self.KKCFG.CIRCA_API + "/v1/inventory/count/sessions/3b3039be-5194-4cfa-958e-0248930a0be6/scans";
    return [self.__KK_TEST__.check("GET", u + "?limit=60000").ok, self.__KK_TEST__.check("GET", u + "?limit=60000&offset=0").ok, self.__KK_TEST__.check("GET", u + "?limit=1000&offset=0").ok, self.__KK_TEST__.check("GET", u + "?limit=1000").ok];
  });
  check("bảng API trong service worker: lượt quét chỉ nhận limit=60000; từ chối offset (kể cả 0) và limit khác", JSON.stringify(sc) === JSON.stringify([true, false, false, false]), sc);
  // mọi request lượt quét máy chủ giả nhận trong MỌI kịch bản (log gom qua resetAll): không request nào có offset
  harvestScans();
  check("máy chủ giả nhận " + SCANLOG.n + " request lượt quét qua mọi kịch bản: KHÔNG request nào có offset, mọi request đúng limit=60000 (lớn nhất " + (SCANLOG.maxBytes / 1048576).toFixed(1) + " MiB, " + SCANLOG.maxRows + " lượt)",
    (SCANLOG.n > 0 || !!ONLY) && SCANLOG.withOffset.length === 0 && SCANLOG.badQuery.length === 0, { n: SCANLOG.n, offset: SCANLOG.withOffset.slice(0, 3), bad: SCANLOG.badQuery.slice(0, 3) });
}

const MORE_RE = (n, got) => new RegExp("^Phiên Circa có nhiều lượt quét hơn một lần đọc trả về \\(đã nhận " + F(got || 1000) + " lượt, summary ghi " + F(n) + " lượt, Circa báo has_more = true\\): extension không đọc đủ được lượt quét của phiên này nên không dùng — DỪNG, không đọc tiếp\\. Đọc lại cũng không đủ: báo người phụ trách extension\\.");
const F = n => n.toLocaleString("vi-VN").replace(/\./g, "\\.");
async function U10() {
  scen("U10", "Phiên Circa > 1.000 lượt quét (1.502 có sẵn + 159 gửi): đọc bằng MỘT request limit=60000 (không offset); gửi, đối chiếu ĐẠT; mở lại không gửi thêm; máy chủ có trần (has_more=true) → không kế hoạch, không gửi, đối chiếu không ĐẠT");
  await resetAll();
  const D = setup(); await loginPages();
  // 1.500 lượt quét QR của SP khác (không thuộc SP nào trong 2 phiên NW), theo lô 100 lượt chung scanned_at như Circa thật
  addForeign(D.S1.id, 1500);
  const n0 = nScans(D.S1.id);
  let p = await openPanelUrl();
  await pick(p, D.S1.id);
  const k0 = circaReq().length;
  let s = await preview(p, [D.R1.id, D.R2.id]);
  const sg = circaReq().slice(k0).filter(e => /\/scans$/.test(e.path));
  check("xem trước đọc đủ " + n0 + " lượt bằng MỘT request: summary → scans?limit=60000 (không offset) → summary, X-Store-Id Lumina", s.scanRead && s.scanRead.n === n0 && s.scanRead.reads === 1 &&
    JSON.stringify(scanSeq(k0)) === JSON.stringify(["S", "L", "S"]) && sg.length === 1 && JSON.stringify(sg[0].query) === JSON.stringify({ limit: "60000" }) && sg[0].h.store === X.LUMINA,
    { scanRead: s.scanRead, seq: scanSeq(k0), q: sg.map(e => e.query) });
  check("kế hoạch như U2 (lượt của SP khác không ảnh hưởng): 2 lô, " + SC.send.length + " thẻ, bỏ qua 1 mã đã có", s.bodies && s.bodies.n === 2 && s.bodies.excluded === 1 && s.total.send === SC.send.length, { bodies: s.bodies, send: s.total && s.total.send });
  const r = await send(p);
  const total = n0 + SC.send.length;
  check("gửi xong 2 lô; đối chiếu ĐẠT trên toàn bộ " + total + " lượt (1 request)", r.s.rc && r.s.rc.ok === true && r.s.rc.scans === total && r.s.rc.others === 1501 && r.s.scanRead.n === total && r.s.scanRead.reads === 1 && submits().length === 2,
    { rc: r.s.rc, scanRead: r.s.scanRead, posts: submits().length });
  await p.close();
  p = await openPanelUrl("panel-2");
  await pick(p, D.S1.id);
  s = await preview(p, [D.R2.id, D.R1.id]);
  check("mở lại panel: mọi thẻ đã có (đọc đủ " + total + " lượt) → 0 lô, nút gửi khoá", s.bodies && s.bodies.n === 0 && s.bodies.excluded === SC.send.length + 1 && s.sendDisabled === true && s.scanRead.n === total, { bodies: s.bodies, scanRead: s.scanRead });
  await p.click("#btn-send", { force: true, timeout: 1500 }).catch(() => {});
  await sleep(500);
  check("không có POST submit nào thêm", submits().length === 2, submits().length);
  // máy chủ có trần 1.000 lượt / request (has_more=true) → đối chiếu lại: CHƯA ĐỐI CHIẾU ĐƯỢC, không nhắc bấm lại; bỏ trần → ĐẠT
  setCirca({ serverCap: 1000 });
  let k1 = circaReq().length;
  await p.click("#btn-recheck");
  s = await pwait(p, "s.rc && !!s.rc.err", 30000);
  check("đối chiếu khi máy chủ có trần: “CHƯA ĐỐI CHIẾU ĐƯỢC” + thông báo has_more (đã nhận 1.000, summary " + total + "), 1 lần đọc (summary → scans), không nhắc “Đối chiếu lại”",
    MORE_RE(total).test(s.rc.err) && !/Bấm “Đối chiếu lại”/.test(s.rc.err) && /^CHƯA ĐỐI CHIẾU ĐƯỢC/.test(s.rcText) && JSON.stringify(scanSeq(k1)) === JSON.stringify(["S", "L"]) && s.lastRead.kind === "more" && s.lastRead.reads === 1,
    { err: s.rc.err, seq: scanSeq(k1), rcText: s.rcText.slice(0, 80) });
  setCirca({});
  await p.click("#btn-recheck");
  s = await pwait(p, "s.rc && !s.rc.err", 30000);
  check("bỏ trần → Đối chiếu lại ĐẠT", s.rc.ok === true, s.rc);
  await p.close();
  // xem trước khi máy chủ có trần → không lập kế hoạch, không gửi
  setCirca({ serverCap: 1000 });
  k1 = circaReq().length;
  p = await openPanelUrl("panel-3");
  await pick(p, D.S1.id);
  const k2 = circaReq().length;
  s = await preview(p, [D.R1.id, D.R2.id]);
  const sg2 = circaReq().slice(k2).filter(e => /\/scans$/.test(e.path));
  check("máy chủ có trần: xem trước dừng sau MỘT request (không đọc tiếp, không đọc lại), báo has_more đúng số, không kế hoạch, nút gửi khoá",
    sg2.length === 1 && JSON.stringify(sg2[0].query) === JSON.stringify({ limit: "60000" }) && JSON.stringify(scanSeq(k2)) === JSON.stringify(["S", "L"]) &&
    MORE_RE(total).test(s.beforeErr || "") && /Không lập kế hoạch, không gửi\.$/.test(s.beforeErr || "") && !s.bodies && s.sendDisabled === true,
    { trang: sg2.length, err: (s.beforeErr || "").slice(0, 300), bodies: s.bodies });
  await p.click("#btn-send", { force: true, timeout: 1500 }).catch(() => {});
  await sleep(400);
  check("không gửi mã nào khi máy chủ có trần", submits().length === 2, submits().length);
  await shot(p, "U10-panel-may-chu-co-tran.png");
  setCirca({});
  await p.close();
}

async function U11() {
  scen("U11", "Ngoại lệ bất ngờ ngay sau khi gửi lô 1 (móc thử) → KHÔNG RÕ, nhả khoá, không gửi lô 2, vẫn đối chiếu");
  await resetAll();
  const D = setup(); await loginPages();
  const p = await openPanelUrl();
  await pick(p, D.S1.id); await preview(p, [D.R1.id, D.R2.id]);
  await p.evaluate(() => window.__KK_PANEL__.throwAfterSubmit(1));
  const r = await send(p);
  check("lô 1 dừng “không rõ” sau 1 lần gửi (ngoại lệ giữa lô), không gửi lô 2", r.s.batches.length === 1 && r.s.batches[0].stop === "không rõ" && r.s.batches[0].tries === 1 && submits().length === 1, { batches: r.s.batches, posts: submits().length });
  check("thông báo rõ: “KHÔNG RÕ … lỗi bất ngờ của trang … Không gửi lại”", /KHÔNG RÕ/.test(r.s.sendStop || "") && /lỗi bất ngờ/.test(r.s.sendStop || "") && /Không gửi lại/.test(r.s.sendStop || ""), r.s.sendStop);
  check("trang về trạng thái dừng: hết “đang gửi”, khung ĐÃ DỪNG GỬI, nút gửi khoá", !r.s.sending && r.s.sendDone && /ĐÃ DỪNG GỬI/.test(r.s.sendMsgText) && r.s.sendDisabled === true, { sending: r.s.sending, msg: r.s.sendMsgText.slice(0, 80) });
  check("khoá gửi đã nhả", Object.keys(await sendLocks()).length === 0, await sendLocks());
  check("đối chiếu vẫn chạy, báo CHƯA ĐẠT (lô 2 chưa gửi)", r.s.rc && !r.s.rc.err && r.s.rc.ok === false, r.s.rc);
  check("sự kiện: loi-bat-ngo → khoa-gui-tra → gui-dung → doi-chieu", ["loi-bat-ngo", "khoa-gui-tra", "gui-dung", "doi-chieu"].every((x, i, a) => r.s.events.indexOf(x) >= 0 && (i === 0 || r.s.events.lastIndexOf(x) > r.s.events.indexOf(a[i - 1]))), r.s.events.slice(-6));
  const log = await dl(p, "#btn-log");
  const j = JSON.parse(log.text);
  check("sổ ghi: lô 1 dừng “không rõ”, có sự kiện loi-bat-ngo", j.lo.length === 1 && j.lo[0].dung === "không rõ" && j.suKien.some(e => e.what === "loi-bat-ngo"), j.lo.map(x => x.dung));
  await shot(p, "U11-panel-ngoai-le-giua-lo.png");
  await p.close();
}

async function U12() {
  scen("U12", "Tính lại sau khi giữ khoá: panel B lập kế hoạch (R2) trong lúc panel A gửi (R1) cùng SP 900002; A xong; B xác nhận → B không gửi, báo “Phiên Circa vừa thay đổi”; gửi lần nữa → không mã nào của 900002");
  await resetAll();
  const D = setup(); await loginPages();
  const A = await openPanelUrl("panel-A"), P2 = await openPanelUrl("panel-B");
  await pick(A, D.S1.id); await pick(P2, D.S1.id);
  const sa = await preview(A, [D.R1.id]), sb = await preview(P2, [D.R2.id]);
  const srcA = (sa.fin.products.find(x => x.pid === 900002) || {}).nwId, srcB = (sb.fin.products.find(x => x.pid === 900002) || {}).nwId;
  check("A lấy 900002 từ R1, B lấy 900002 từ R2 (mỗi panel chọn 1 phiên NW khác nhau)", srcA === D.R1.id && srcB === D.R2.id, { A: srcA, B: srcB });
  // lô 1 của A: lần 1 treo, CHƯA ghi (client hết giờ 5 s) → gửi lại → ghi. B bấm gửi trong khoảng đó.
  m.circa.cfg.submitFaults = { 1: [{ hang: true }] };
  await sendConfirm(A);
  await A.waitForFunction(() => window.__KK_PANEL__.summary().sending === true, null, { timeout: 15000, polling: 100 });
  await P2.click("#btn-send");
  await P2.waitForSelector("#modal:not([hidden])", { timeout: 15000 });
  const modalB = await P2.textContent("#modal");
  const scansAtModal = m.circa.sessions.get(D.S1.id).sim.scans().length;
  check("B mở hộp xác nhận khi A đang gửi và Circa chưa ghi gì của A (kế hoạch B chưa đổi: " + sb.total.send + " thẻ)", scansAtModal === 2 && modalB.indexOf("Gửi " + sb.total.send + " thẻ") >= 0, { scansAtModal, modal: modalB.slice(0, 120) });
  const s1 = await pwait(A, "s.sendDone && s.rc", 90000);
  check("A gửi xong (lô 1 treo → gửi lại), đối chiếu ĐẠT, khoá đã nhả", s1.rc && s1.rc.ok === true && s1.batches.length === 1 && s1.batches[0].tries === 2 && Object.keys(await sendLocks()).length === 0, { batches: s1.batches, rc: s1.rc });
  const nA = submits().length;
  const codesA = submits().flatMap(e => NWC.bodyCodes(e.body));
  check("A đã gửi thẻ R1 của 900002", SC.skipR1B.every(c => codesA.map(NWC._codeKey).indexOf(NWC._codeKey(c)) >= 0), SC.skipR1B);
  await P2.click("#modal-ok");
  const s2 = await pwait(P2, "/vừa thay đổi/.test(s.sendMsgText)", 30000);
  check("B: “Phiên Circa vừa thay đổi, xem lại rồi bấm gửi lần nữa”, KHÔNG gửi lô nào", /Phiên Circa vừa thay đổi, xem lại rồi bấm gửi lần nữa/.test(s2.sendMsgText) && !s2.sendStarted && s2.batches.length === 0 && submits().length === nA,
    { msg: s2.sendMsgText.slice(0, 160), posts: submits().length - nA });
  check("B đã lấy rồi nhả khoá (beginSend → tính lại → endSend)", s2.events.indexOf("khoa-gui-tra") >= 0 && Object.keys(await sendLocks()).length === 0, s2.events.slice(-5));
  const r900002 = (s2.rows || []).find(x => x.pid === 900002);
  check("bảng xem trước của B vẽ lại: 900002 để riêng “phiên Circa đã có lượt khác” (thẻ R1 do A gửi); 900003 đã có", r900002 && r900002.status === "de-rieng" && r900002.reason === "luot-khac" &&
    ((s2.rows || []).find(x => x.pid === 900003) || {}).status === "da-co", { r900002, r900003: (s2.rows || []).find(x => x.pid === 900003) });
  check("nút gửi của B mở lại theo kế hoạch mới", s2.sendDisabled === false && s2.bodies && s2.bodies.n >= 1, { sendDisabled: s2.sendDisabled, bodies: s2.bodies });
  await shot(P2, "U12-panel-B-phien-vua-thay-doi.png");
  const rb = await send(P2);
  const codesB = submits().slice(nA).flatMap(e => NWC.bodyCodes(e.body)).map(NWC._codeKey);
  check("B gửi lần 2: không mã nào của 900002 (thẻ R1 lẫn R2)", SC.b2.concat(SC.skipR1B).every(c => codesB.indexOf(NWC._codeKey(c)) < 0) && codesB.length > 0, { guiB: codesB.length });
  check("B đối chiếu ĐẠT", rb.s.rc && rb.s.rc.ok === true, rb.s.rc);
  const sc900002 = m.circa.sessions.get(D.S1.id).sim.scans().filter(x => x.product_id === 900002).map(x => x.qr_code);
  check("phiên Circa: 900002 chỉ có 2 lượt (thẻ R1 do A gửi), không đếm đôi", sc900002.length === 2 && sameSet(sc900002, SC.skipR1B), sc900002);
  await A.close(); await P2.close();
}

// ---------- đọc lượt quét Circa (KKCHON.readScans) ----------
// n lượt QR của SP khác (không thuộc SP nào trong 2 phiên NW); lượt thêm sau = mới hơn (Circa trả mới nhất trước).
// Thêm theo lô 100 lượt chung một scanned_at như Circa thật (mã lỡ lật trang bằng offset sẽ gặp nhóm cùng scanned_at bị xáo).
function addForeign(sid, n, prefix) {
  for (let i0 = 0; i0 < n; i0 += 100) {
    const lo = [];
    for (let i = i0; i < Math.min(n, i0 + 100); i++) lo.push({ qr_code: (prefix || "QRNGOAI") + String(i).padStart(5, "0"), product_id: 990000 + (i % 7), scanned_qty: 1, unit_code: "cái", conversion_factor: 1, base_qty: 1, device_id: "PDA-QR" });
    m.circa.addScanBatch(sid, lo);
  }
}
const nScans = sid => m.circa.sessions.get(sid).sim.scans().length;
// chuỗi request đọc lượt quét từ mốc k0: "S" = summary, "L" = lượt quét (kèm "@offset" nếu có offset — v0.2.1 không bao giờ có)
const scanSeq = k0 => circaReq().slice(k0).filter(e => /\/(scans|summary)$/.test(e.path)).map(e => /summary$/.test(e.path) ? "S" : "L" + ("offset" in e.query ? "@" + e.query.offset : ""));
const setCirca = o => { m.circa.cfg = Object.assign({ token: m.tokens.circa, adminNoStore: true }, o || {}); };
async function repreview(p) {
  await p.click("#btn-preview");
  return pwait(p, "s.pv && (s.pv.err || s.rows || s.beforeErr || (s.lookup && s.lookup.abort) || (s.fin && (s.fin.pending || s.fin.blockers.length)))", 120000);
}

async function U13() {
  scen("U13", "Lượt mới chen vào giữa summary và lượt quét (> 1.000 lượt): lần đọc đầu lệch tổng → đọc lại ĐẠT; gửi đúng; đối chiếu ĐẠT, không báo “lặp” sai");
  await resetAll();
  const D = setup(); await loginPages();
  addForeign(D.S1.id, 1500);
  const n0 = nScans(D.S1.id);
  const p = await openPanelUrl();
  await pick(p, D.S1.id);
  setCirca({ insertBetween: { n: 3, product_id: 990001, at: "summary" } });
  const k0 = circaReq().length;
  let s = await preview(p, [D.R1.id, D.R2.id]);
  const sq = scanSeq(k0);
  check("lần 1: summary (" + n0 + ") → [3 lượt chen vào] → lượt quét (" + (n0 + 3) + ") → summary: lệch tổng; lần 2 đọc lại từ đầu: summary → lượt quét → summary", JSON.stringify(sq) === JSON.stringify(["S", "L", "S", "S", "L", "S"]), sq);
  const a0 = s.lastRead && s.lastRead.attempts[0];
  check("xem trước ĐẠT sau 2 lần đọc, đủ " + (n0 + 3) + " lượt; lần 1 ghi lệch tổng (T1 " + n0 + ", nhận " + (n0 + 3) + ", T2 " + (n0 + 3) + ")", s.scanRead && s.scanRead.reads === 2 && s.scanRead.n === n0 + 3 && s.scanRead.total === n0 + 3 && !s.beforeErr &&
    a0 && a0.why === "lệch tổng" && a0.t1 === n0 && a0.rows === n0 + 3 && a0.ids === n0 + 3 && a0.t2 === n0 + 3 && a0.dup === 0, { scanRead: s.scanRead, att: s.lastRead && s.lastRead.attempts });
  check("kế hoạch như U2: 2 lô, " + SC.send.length + " thẻ, bỏ qua 1 mã đã có", s.bodies && s.bodies.n === 2 && s.bodies.excluded === 1 && s.total.send === SC.send.length, { bodies: s.bodies, send: s.total && s.total.send });
  const r = await send(p);
  check("gửi 2 lô; đối chiếu ĐẠT, 0 thẻ “lặp”, đọc đủ " + (n0 + 3 + SC.send.length) + " lượt", r.s.rc && r.s.rc.ok === true && r.s.rc.counts.lap === 0 && r.s.rc.scans === n0 + 3 + SC.send.length && submits().length === 2 && sameSet(sentCodes(), SC.send),
    { rc: r.s.rc, posts: submits().length });
  const log = await dl(p, "#btn-log");
  const j = JSON.parse(log.text);
  check("sổ ghi có lanDocLuotQuet: lần xem trước 2 lần đọc (lần 1 lệch tổng, có số lượt nhận + byte), các lần sau 1 lần đọc; cachDocLuotQuet limit 60000",
    Array.isArray(j.lanDocLuotQuet) && j.lanDocLuotQuet[0].where === "xem-truoc" && j.lanDocLuotQuet[0].reads === 2 && j.lanDocLuotQuet[0].attempts[0].why === "lệch tổng" &&
    j.lanDocLuotQuet[0].attempts[0].rows === n0 + 3 && j.lanDocLuotQuet[0].attempts[0].bytes > 0 &&
    j.lanDocLuotQuet.slice(1).every(x => x.ok && x.reads === 1) && j.lanDocLuotQuet.map(x => x.where).join() === "xem-truoc,truoc-gui,sau-khoa,doi-chieu" &&
    j.cachDocLuotQuet && j.cachDocLuotQuet.gioiHan === 60000 && j.cachDocLuotQuet.thoiHanMs === 120000,
    { lan: (j.lanDocLuotQuet || []).map(x => x.where + ":" + x.reads), cach: j.cachDocLuotQuet });
  await p.close();
}

async function U14() {
  scen("U14", "Lượt QR khác mã của SP 900001 nằm sâu trong danh sách (vị trí > 1.000) → đọc đủ bằng MỘT request; 900001 để riêng, không gửi");
  await resetAll();
  const D = setup(); await loginPages();
  // mới nhất trước: 1.200 lượt mới (12 lô), rồi lượt QR của 900001 (vị trí 1.200), rồi 800 lượt cũ, rồi 2 lượt có sẵn
  addForeign(D.S1.id, 800, "QRCU");
  m.circa.addScan(D.S1.id, { qr_code: "1799000000000P1", product_id: 900001, scanned_qty: 1, unit_code: "vỉ", conversion_factor: 10, base_qty: 10, device_id: "PDA-QR" });
  addForeign(D.S1.id, 1200, "QRMOI");
  const n0 = nScans(D.S1.id);
  // vị trí lượt QR trong danh sách máy chủ trả (đọc thẳng máy chủ giả, cùng request như extension)
  const direct = await fetch(m.urls.circaApi + "/v1/inventory/count/sessions/" + D.S1.id + "/scans?limit=60000", { headers: { Authorization: "Bearer " + m.tokens.circa, "X-Store-Id": X.LUMINA } }).then(r => r.json());
  const posP = direct.data.scans.findIndex(x => x.qr_code === "1799000000000P1");
  const p = await openPanelUrl();
  await pick(p, D.S1.id);
  const k0 = circaReq().length;
  const s = await preview(p, [D.R1.id, D.R2.id]);
  const sq = scanSeq(k0);
  check("lượt QR của 900001 ở vị trí " + posP + " (> 1.000) trong " + n0 + " lượt; xem trước đọc đủ bằng MỘT request (summary → lượt quét → summary)", posP === 1200 && direct.data.scans.length === n0 && direct.data.has_more === false &&
    JSON.stringify(sq) === JSON.stringify(["S", "L", "S"]) && s.scanRead && s.scanRead.n === n0 && s.scanRead.reads === 1, { posP, sq, scanRead: s.scanRead });
  const a1 = s.fin && s.fin.aside.find(a => a.pid === 900001);
  check("900001 để riêng “phiên Circa đã có lượt khác” (lượt QR 1799000000000P1), không nằm trong SP gửi", a1 && a1.reason === "luot-khac" && /1799000000000P1/.test(a1.detail) && !s.fin.products.some(x => x.pid === 900001), a1);
  const codesA = SC.lookups.filter(([c, d]) => d && d.product_id === 900001).map(([c]) => c);
  const r = await send(p);
  const sent = sentCodes().map(NWC._codeKey);
  check("không gửi thẻ nào của 900001 (" + codesA.length + " thẻ); gửi " + (SC.send.length - codesA.length) + " thẻ còn lại", codesA.length === 3 && codesA.every(c => sent.indexOf(NWC._codeKey(c)) < 0) && sent.length === SC.send.length - codesA.length, { sent: sent.length });
  check("đối chiếu ĐẠT trên các SP đã gửi", r.s.rc && r.s.rc.ok === true, r.s.rc);
  const sc1 = m.circa.sessions.get(D.S1.id).sim.scans().filter(x => x.product_id === 900001);
  check("phiên Circa: 900001 chỉ có lượt QR của nhân viên (không đếm đôi)", sc1.length === 1 && sc1[0].qr_code === "1799000000000P1", sc1.map(x => x.qr_code));
  await shot(p, "U14-panel-luot-sau-de-rieng.png");
  await p.close();
}

async function U15() {
  scen("U15", "Đọc lượt quét không ổn định (luôn trùng id) → không gửi mã nào, đối chiếu không báo ĐẠT: ở xem trước; khi hộp xác nhận đang mở (sau khi giữ khoá); ngay sau khi gửi");
  await resetAll();
  const D = setup(); await loginPages();
  addForeign(D.S1.id, 1500);
  const n0 = nScans(D.S1.id);
  setCirca({ scansDup: true });
  const p = await openPanelUrl();
  await pick(p, D.S1.id);
  let k0 = circaReq().length;
  let s = await preview(p, [D.R1.id, D.R2.id]);
  const sq = scanSeq(k0);
  check("(a) xem trước: đọc 3 lần (mỗi lần summary → lượt quét có id trùng → summary) rồi dừng", JSON.stringify(sq) === JSON.stringify(["S", "L", "S", "S", "L", "S", "S", "L", "S"]), sq);
  check("(a) báo “Không đọc được ổn định lượt quét của phiên Circa (đang có người quét?)” kèm T1, T2, số lượt nhận, số id, số trùng của 3 lần; không kế hoạch; nút gửi khoá",
    /^Không đọc được ổn định lượt quét của phiên Circa \(đang có người quét\?\)\. Đã đọc 3 lần/.test(s.beforeErr || "") && new RegExp("lần 3: tổng theo summary trước " + F(n0) + " / sau " + F(n0) + ", nhận " + F(n0 + 1) + " lượt, đọc được " + F(n0) + " id khác nhau, 1 id trùng").test(s.beforeErr) &&
    /Không lập kế hoạch, không gửi\. Bấm “Xem trước” lại\.$/.test(s.beforeErr) && !s.bodies && s.sendDisabled === true && s.lastRead && s.lastRead.kind === "unstable", { err: (s.beforeErr || "").slice(0, 400), bodies: s.bodies });
  await p.click("#btn-send", { force: true, timeout: 1500 }).catch(() => {});
  await sleep(400);
  check("(a) 0 POST submit", submits().length === 0, submits().length);
  await shot(p, "U15-panel-doc-khong-on-dinh.png");
  // (b) hết trùng → xem trước ĐẠT → bấm gửi, hộp xác nhận mở → bật trùng → Đồng ý → đọc lại sau khi giữ khoá hỏng → không gửi
  setCirca({});
  s = await repreview(p);
  check("(b) hết trùng → xem trước lại ĐẠT, 2 lô", s.bodies && s.bodies.n === 2 && !s.beforeErr, { bodies: s.bodies, err: s.beforeErr });
  await p.click("#btn-send");
  await p.waitForSelector("#modal:not([hidden])", { timeout: 15000 });
  setCirca({ scansDup: true });
  await p.click("#modal-ok");
  s = await pwait(p, "/Không gửi/.test(s.sendMsgText)", 30000);
  check("(b) sau khi giữ khoá đọc lại không ổn định → “Không gửi: không đọc được đủ lượt quét…”, chưa bắt đầu gửi, 0 POST", /Không gửi: không đọc được đủ lượt quét của phiên Circa/.test(s.sendMsgText) && /ổn định/.test(s.sendMsgText) &&
    !s.sendStarted && s.batches.length === 0 && submits().length === 0, { msg: s.sendMsgText.slice(0, 200), posts: submits().length });
  check("(b) khoá gửi đã nhả; kế hoạch cũ bỏ, nút gửi khoá tới khi xem trước lại", Object.keys(await sendLocks()).length === 0 && !s.bodies && s.sendDisabled === true && s.events.indexOf("khoa-gui-tra") >= 0, { bodies: s.bodies, sendDisabled: s.sendDisabled });
  // (c) xem trước lại ĐẠT → gửi; máy chủ bắt đầu trùng ngay sau lô 2 → đối chiếu tự chạy: CHƯA ĐỐI CHIẾU ĐƯỢC; hết trùng → Đối chiếu lại → ĐẠT
  setCirca({ scansDupAfterSubmit: 2 });
  s = await repreview(p);
  check("(c) xem trước lại ĐẠT", s.bodies && s.bodies.n === 2 && !s.beforeErr, s.bodies);
  const r = await send(p);
  check("(c) 2 lô gửi đạt theo response; đối chiếu sau gửi: lỗi đọc không ổn định, KHÔNG báo ĐẠT", r.s.batches.length === 2 && r.s.batches.every(b => b.ok) && r.s.rc && r.s.rc.err && /Không đọc được ổn định/.test(r.s.rc.err) && r.s.rc.ok !== true && submits().length === 2,
    { batches: r.s.batches, rc: r.s.rc });
  check("(c) khung bước 5 “CHƯA ĐỐI CHIẾU ĐƯỢC”, nút “Đối chiếu lại” bấm được", /^CHƯA ĐỐI CHIẾU ĐƯỢC/.test(r.s.rcText) && /Bấm “Đối chiếu lại”/.test(r.s.rcText) && r.s.recheckDisabled === false, { rcText: r.s.rcText.slice(0, 160), recheckDisabled: r.s.recheckDisabled });
  await shot(p, "U15-panel-chua-doi-chieu-duoc.png");
  setCirca({});
  await p.click("#btn-recheck");
  s = await pwait(p, "s.rc && !s.rc.err", 30000);
  check("(c) hết trùng → Đối chiếu lại → ĐẠT (gốc Circa = gốc NW)", s.rc.ok === true && s.rc.circaBase === s.rc.nwBase && s.rc.scans === n0 + SC.send.length, s.rc);
  await p.close();
}

async function U16() {
  scen("U16", "Lỗi đọc lượt quét khác → không lập kế hoạch, không gửi, báo rõ: summary lệch số lượt; lượt thiếu id; summary thiếu total_scans; has_more thiếu / không phải boolean; lượt product_id null");
  await resetAll();
  const D = setup(); await loginPages();
  addForeign(D.S1.id, 1500);
  const n0 = nScans(D.S1.id);
  const p = await openPanelUrl();
  await pick(p, D.S1.id);
  const cases = [
    ["summary lệch số lượt (+1)", { summaryOff: 1 }, new RegExp("^Không đọc được ổn định.*trước " + F(n0 + 1) + " / sau " + F(n0 + 1) + ", nhận " + F(n0) + " lượt, đọc được " + F(n0) + " id khác nhau"), 3, ["S", "L", "S", "S", "L", "S", "S", "L", "S"]],
    ["lượt thiếu id", { dropId: [SC.existing.foreign.qr_code] }, /^Phiên Circa trả 1 lượt quét không có id \(lượt thứ 1502\): không khử trùng được — DỪNG\./, 1, ["S", "L"]],
    ["summary không có total_scans", { summaryNoTotal: true }, /summary không có data\.total_scans/, 1, ["S"]],
    ["has_more thiếu", { noHasMore: true }, new RegExp("^Phản hồi lượt quét của phiên Circa không có has_more dạng true / false \\(thiếu trường, nhận " + F(n0) + " lượt, summary ghi " + F(n0) + "\\): không biết đã nhận đủ lượt quét chưa — DỪNG\\."), 1, ["S", "L"]],
    ["has_more = “false” (chuỗi)", { hasMoreAs: "false" }, /^Phản hồi lượt quét của phiên Circa không có has_more dạng true \/ false \(đang là "false", /, 1, ["S", "L"]],
    ["has_more = null", { hasMoreAs: null }, /^Phản hồi lượt quét của phiên Circa không có has_more dạng true \/ false \(đang là null, /, 1, ["S", "L"]]
  ];
  let first = true;
  for (const [name, cfg, re, reads, seq] of cases) {
    setCirca(cfg);
    const k0 = circaReq().length;
    const s = first ? await preview(p, [D.R1.id, D.R2.id]) : await repreview(p);
    first = false;
    check(name + ": báo lỗi đúng, " + reads + " lần đọc (" + seq.join(" → ") + "), không kế hoạch, nút gửi khoá", re.test(s.beforeErr || "") && s.lastRead && s.lastRead.reads === reads && !s.lastRead.ok && !s.bodies && s.sendDisabled === true &&
      JSON.stringify(scanSeq(k0)) === JSON.stringify(seq), { err: (s.beforeErr || "").slice(0, 260), reads: s.lastRead && s.lastRead.reads, seq: scanSeq(k0) });
  }
  // product_id null: lượt QR của nhân viên mà Circa không trả product_id
  setCirca({});
  m.circa.addScan(D.S1.id, { qr_code: "1799000000000N1", product_id: null, scanned_qty: 1, unit_code: "cái", conversion_factor: 1, base_qty: 1, device_id: "PDA-QR" });
  const idN = m.circa.sessions.get(D.S1.id).meta.get("1799000000000N1").id;
  const s = await repreview(p);
  check("product_id null: “… lượt quét không đọc được product_id …, ví dụ id <id> …”, không kế hoạch, nút gửi khoá", /^Phiên Circa có 1\/[\d.]+ lượt quét không đọc được product_id/.test(s.beforeErr || "") && (s.beforeErr || "").indexOf(idN) >= 0 &&
    !s.bodies && s.sendDisabled === true && s.lastRead.kind === "product", { err: (s.beforeErr || "").slice(0, 260) });
  await p.click("#btn-send", { force: true, timeout: 1500 }).catch(() => {});
  await sleep(400);
  check("không có POST submit nào ở mọi ca", submits().length === 0, submits().length);
  await shot(p, "U16-panel-product-id-null.png");
  await p.close();
}

async function U17() {
  scen("U17", "Ngoại lệ bất ngờ (móc thử) khi kiểm lại trước khi giữ khoá và khi đối chiếu → trang không đứng: hết bận, hiện lỗi, không gửi, bấm lại được");
  await resetAll();
  const D = setup(); await loginPages();
  const p = await openPanelUrl();
  await pick(p, D.S1.id);
  let s = await preview(p, [D.R1.id, D.R2.id]);
  await p.evaluate(() => window.__KK_PANEL__.throwInStep("refresh"));
  await p.click("#btn-send");
  s = await pwait(p, "/lỗi bất ngờ/.test(s.sendMsgText)", 20000);
  const modalOpen = await p.isVisible("#modal");
  check("kiểm lại trước khi gửi ném lỗi → hết bận, “Không gửi: lỗi bất ngờ của trang trước khi gửi … Chưa gửi gì”, không mở hộp xác nhận, 0 POST, không giữ khoá",
    !s.busy && /Không gửi: lỗi bất ngờ của trang trước khi gửi/.test(s.sendMsgText) && /Chưa gửi gì/.test(s.sendMsgText) && !modalOpen && submits().length === 0 && Object.keys(await sendLocks()).length === 0 && !s.sendStarted,
    { msg: s.sendMsgText.slice(0, 160), modalOpen });
  check("kế hoạch bị bỏ (nút gửi khoá), nút Xem trước bấm được", s.sendDisabled === true && !s.bodies && s.previewDisabled === false, { sendDisabled: s.sendDisabled, previewDisabled: s.previewDisabled });
  s = await repreview(p);
  const r = await send(p);
  check("xem trước lại → gửi bình thường, đối chiếu ĐẠT", r.s.rc && r.s.rc.ok === true && submits().length === 2, r.s.rc);
  await p.evaluate(() => window.__KK_PANEL__.throwInStep("reconcile"));
  await p.click("#btn-recheck");
  s = await pwait(p, "s.rc && !!s.rc.err", 20000);
  check("đối chiếu ném lỗi → hết bận, “CHƯA ĐỐI CHIẾU ĐƯỢC … Lỗi bất ngờ khi đối chiếu”, nút Đối chiếu lại bấm được", !s.busy && /Lỗi bất ngờ khi đối chiếu/.test(s.rc.err) && /^CHƯA ĐỐI CHIẾU ĐƯỢC/.test(s.rcText) && s.recheckDisabled === false,
    { rc: s.rc, rcText: s.rcText.slice(0, 120) });
  await p.click("#btn-recheck");
  s = await pwait(p, "s.rc && !s.rc.err", 20000);
  check("bấm Đối chiếu lại → ĐẠT", s.rc.ok === true, s.rc);
  await p.close();
}

async function U18() {
  scen("U18", "Phiên lớn: 59.702 lượt, response ≈ 55 MB qua background ↔ panel bằng MỘT request → xem trước, gửi, đối chiếu ĐẠT; response > 60 MiB → dừng (trần kích thước), không gửi; phiên > 60.000 lượt → has_more → dừng");
  await resetAll();
  const D = setup(); await loginPages();
  addForeign(D.S1.id, 59700);
  const n0 = nScans(D.S1.id);
  const MiB = 1048576, url = m.urls.circaApi + "/v1/inventory/count/sessions/" + D.S1.id + "/scans?limit=60000";
  const H = { headers: { Authorization: "Bearer " + m.tokens.circa, "X-Store-Id": X.LUMINA } };
  // padScans n → mỗi lượt thêm ,"pad":"<n × ả>" = 9 + 3n byte. Chọn n để response ≈ đích (đo thẳng máy chủ giả với cùng request)
  const padFor = async (target, rows) => { setCirca({}); const b0 = Buffer.byteLength(await fetch(url, H).then(r => r.text())); return Math.max(0, Math.floor(((target - b0) / rows - 9) / 3)); };
  const pad1 = await padFor(55e6, n0);
  setCirca({ padScans: pad1 });
  let p = await openPanelUrl();
  await pick(p, D.S1.id);
  let t0 = Date.now();
  let s = await preview(p, [D.R1.id, D.R2.id]);
  const tPv = Date.now() - t0;
  const b1 = s.scanRead && s.scanRead.bytes;
  note("response lượt quét lúc xem trước: " + (b1 / MiB).toFixed(1) + " MiB (" + b1 + " byte, " + n0 + " lượt, pad " + pad1 + " ký tự/lượt), xem trước " + tPv + " ms");
  check("xem trước: đọc đủ " + n0 + " lượt (≈ " + (b1 / MiB).toFixed(1) + " MiB, > 50 MB, dưới trần 60 MiB) bằng MỘT request qua background ↔ panel; kế hoạch như U2", s.scanRead && s.scanRead.n === n0 && s.scanRead.reads === 1 &&
    b1 > 50e6 && b1 < 60 * MiB && !s.beforeErr && s.bodies && s.bodies.n === 2 && s.total.send === SC.send.length, { scanRead: s.scanRead, err: s.beforeErr, bodies: s.bodies });
  t0 = Date.now();
  const r = await send(p);
  const total = n0 + SC.send.length;
  check("gửi 2 lô; đối chiếu ĐẠT trên " + total + " lượt (response ≈ " + ((r.s.scanRead && r.s.scanRead.bytes) / MiB).toFixed(1) + " MiB), " + (Date.now() - t0) + " ms cho cả kiểm lại + gửi + đối chiếu",
    r.s.rc && r.s.rc.ok === true && r.s.rc.scans === total && submits().length === 2 && sameSet(sentCodes(), SC.send) && r.s.scanRead.n === total, { rc: r.s.rc, scanRead: r.s.scanRead });
  // response vượt trần 60 MiB (nhưng dưới 64 MiB của Chrome) → api.js chặn: đối chiếu lại "CHƯA ĐỐI CHIẾU ĐƯỢC"; xem trước ở panel mới: không kế hoạch
  const pad2 = await padFor(63 * MiB, total);
  setCirca({ padScans: pad2 });
  await p.click("#btn-recheck");
  s = await pwait(p, "s.rc && !!s.rc.err", 120000);
  const big = circaReq().filter(e => /\/scans$/.test(e.path)).pop();
  note("response vượt trần: máy chủ giả gửi " + (big.bytes / MiB).toFixed(1) + " MiB (" + big.bytes + " byte)");
  const TB = /^Không đọc được lượt quét của phiên Circa: too-big: thân response lượt quét (hơn )?6\d,\d MB, vượt trần 60,0 MB của đường truyền nội bộ extension \(tin nhắn Chrome tối đa 64 MiB\): không dùng lượt quét này\. /;
  check("đối chiếu lại khi response " + (big.bytes / MiB).toFixed(1) + " MiB > 60 MiB: “CHƯA ĐỐI CHIẾU ĐƯỢC … too-big … vượt trần 60,0 MB”, 1 lần đọc, không báo ĐẠT", big.bytes > 60 * MiB && big.bytes < 64 * MiB &&
    TB.test(s.rc.err) && /^CHƯA ĐỐI CHIẾU ĐƯỢC/.test(s.rcText) && s.lastRead.reads === 1 && s.lastRead.kind === "http", { err: s.rc.err.slice(0, 260), lastRead: s.lastRead && { kind: s.lastRead.kind, reads: s.lastRead.reads } });
  await p.close();
  p = await openPanelUrl("panel-2");
  await pick(p, D.S1.id);
  s = await preview(p, [D.R1.id, D.R2.id]);
  check("xem trước khi response > 60 MiB: báo too-big, không kế hoạch, nút gửi khoá", TB.test(s.beforeErr || "") && !s.bodies && s.sendDisabled === true, { err: (s.beforeErr || "").slice(0, 260) });
  // phiên > 60.000 lượt: máy chủ trả 60.000 + has_more=true → dừng (không pad, response nhỏ hơn trần)
  setCirca({});
  addForeign(D.S1.id, 300, "QRTHEM");
  const n2 = nScans(D.S1.id);
  s = await repreview(p);
  check("phiên " + n2 + " lượt (> 60.000): đã nhận 60.000 + has_more=true → dừng, không kế hoạch, không gửi", n2 > 60000 && MORE_RE(n2, 60000).test(s.beforeErr || "") && !s.bodies && s.sendDisabled === true && s.lastRead.kind === "more",
    { n2, err: (s.beforeErr || "").slice(0, 260) });
  check("không có POST submit nào ngoài 2 lô ban đầu", submits().length === 2, submits().length);
  await shot(p, "U18-panel-phien-qua-60000.png");
  await p.close();
  setCirca({});
}

async function T10() {
  scen("T10", "CSP extension_pages (default-src 'self', connect-src chỉ 2 API) + không có quyền tabs: service worker / panel không gọi được host khác");
  const hits = [];
  const srv = http.createServer((q, r) => { hits.push(q.url); r.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" }); r.end("ok"); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const la0 = "http://127.0.0.1:" + srv.address().port;
  try {
    const man = await sw.evaluate(() => chrome.runtime.getManifest());
    check("manifest bản thử đang chạy: quyền storage, scripting (không tabs)", JSON.stringify(man.permissions) === JSON.stringify(["storage", "scripting"]), man.permissions);
    const wantCsp = "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src " + m.urls.circaApi + " " + m.urls.nwApi;
    check("CSP extension_pages = default-src 'self' + connect-src 2 API giả", man.content_security_policy && man.content_security_policy.extension_pages === wantCsp, man.content_security_policy);
    const f = u => sw.evaluate(x => fetch(x, { mode: "no-cors", cache: "no-store" }).then(() => "đi được", e => "bị chặn: " + e.message), u);
    const rLa = await f(la0 + "/tu-service-worker"), rAdmin = await f(m.urls.admin + "/csp-thu"), rApp = await f(m.urls.nwApp + "/csp-thu"), rApi = await f(m.urls.circaApi + "/v1/authz/me");
    check("service worker: fetch tới host lạ / admin / web NW bị CSP chặn; tới API Circa giả thì đi được", /bị chặn/.test(rLa) && /bị chặn/.test(rAdmin) && /bị chặn/.test(rApp) && rApi === "đi được", { rLa, rAdmin, rApp, rApi });
    const pg = await ctx.newPage(); // không gắn watchPage: lỗi CSP cố ý ở đây không tính vào T9
    await pg.goto("chrome-extension://" + extId + "/panel.html");
    const rP = await pg.evaluate(u => fetch(u, { mode: "no-cors" }).then(() => "đi được", e => "bị chặn: " + e.message), m.urls.circaApi + "/v1/authz/me?tu=panel");
    const rP2 = await pg.evaluate(u => fetch(u, { mode: "no-cors" }).then(() => "đi được", e => "bị chặn: " + e.message), la0 + "/tu-panel");
    check("panel: fetch tới cả API giả lẫn host lạ đều bị chặn (meta connect-src 'none')", /bị chặn/.test(rP) && /bị chặn/.test(rP2), { rP, rP2 });
    await pg.close();
    await sleep(300);
    check("máy chủ lạ không nhận request nào", hits.length === 0, hits);
    check("API Circa giả không nhận request nào từ panel", !m.circa.log.some(e => /tu=panel/.test(e.url || "")));
  } finally { srv.close(); }
}

(async () => {
  const pw = loadPlaywright(), exe = chromiumExe();
  if (!pw || !exe) {
    console.log("KHÔNG CHẠY ĐƯỢC: " + (!pw ? "không tìm thấy Playwright" : "không tìm thấy Chromium đầy đủ trong %LOCALAPPDATA%/ms-playwright/chromium-*") + ". Không tự tải từ mạng.");
    process.exitCode = 2; return;
  }
  SC = X.scenario(XLSX);
  m = await X.start({});
  console.log("máy chủ giả:", JSON.stringify(m.urls));
  B.build({ outDir: EXTD, test: { admin: m.urls.admin, circaApi: m.urls.circaApi, nwApp: m.urls.nwApp, nwApi: m.urls.nwApi, timeoutMs: 5000, retryBaseMs: 50, scanGapMs: 50 } });
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "kk-ext-ud-"));
  try {
    ctx = await pw.chromium.launchPersistentContext(ud, { headless: true, executablePath: exe, acceptDownloads: true, viewport: { width: 1280, height: 900 },
      args: ["--disable-extensions-except=" + EXTD, "--load-extension=" + EXTD] });
    sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 15000 });
    extId = new URL(sw.url()).host;
    console.log("Chromium:", exe, "· extension", extId);
    for (const [id, fn] of [["U1", U1], ["U2", U2], ["U3", U3], ["U4", U4], ["U5", U5], ["U6", U6], ["U7", U7], ["U8", U8], ["U9", U9], ["U10", U10], ["U11", U11], ["U12", U12], ["U13", U13], ["U14", U14], ["U15", U15], ["U16", U16], ["U17", U17], ["U18", U18]]) {
      if (!want(id)) continue;
      try { await fn(); } catch (e) { if (!cur || cur.id !== id) scen(id, "(lỗi trước khi bắt đầu)"); check("kịch bản chạy hết không ném lỗi", false, String(e && e.stack || e).split("\n").slice(0, 4).join(" | ")); }
    }
    if (want("T9")) await T9();
    if (want("T10")) { try { await T10(); } catch (e) { check("kịch bản chạy hết không ném lỗi", false, String(e && e.stack || e).split("\n").slice(0, 4).join(" | ")); } }
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
