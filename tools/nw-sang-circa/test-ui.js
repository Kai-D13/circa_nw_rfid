// KIỂM THỬ TRÌNH DUYỆT trang build/nw-sang-circa.html với MÁY CHỦ GIẢ (mock-server.js trên 127.0.0.1).
// Không gọi Circa thật, không dùng token thật (token giả sinh ngẫu nhiên). Chỉ đọc file dữ liệu; ghi file thử + ảnh vào outDir.
//
// Dùng (cwd bất kỳ):
//   node tools/nw-sang-circa/build.js && node tools/nw-sang-circa/test-ui.js [outDir]
//   outDir mặc định work/20261121-nw-sang-circa-kiem-ke/out  (ảnh → <outDir>/shots, file thử / tải về → <outDir>/test-ui)
//   Env: KB=1,2,… chỉ chạy các kịch bản đó; PW_CHROME=<đường dẫn chrome> nếu Playwright không tìm được trình duyệt.
// Đầu vào: work/20261121-nw-sang-circa-kiem-ke/in/kiem-ke-lumina-2026-11-21-15-42.xlsx, phien/qr-lookup.json, phien/ics00240-scans.json
// Playwright: require("playwright"); không có thì tìm trong %LOCALAPPDATA%/npm-cache/_npx. Trình duyệt: mặc định của Playwright,
// thiếu thì lấy chromium_headless_shell / chromium mới nhất trong %LOCALAPPDATA%/ms-playwright.
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), url = require("url");
const NWC = require("./core.js");
const M = require("./mock-server.js");
const ROOT = path.resolve(__dirname, "..", "..");
const W = path.join(ROOT, "work/20261121-nw-sang-circa-kiem-ke");
const OUT = path.resolve(process.argv[2] || path.join(W, "out"));
const SHOTS = path.join(OUT, "shots"), TMPD = path.join(OUT, "test-ui");
const XLS = path.join(W, "in/kiem-ke-lumina-2026-11-21-15-42.xlsx");
const QR = path.join(W, "phien/qr-lookup.json");
const SCANS240 = path.join(W, "phien/ics00240-scans.json");
const HTML = path.join(ROOT, "build/nw-sang-circa.html");
const LUMINA = "31493e74-3404-4c0e-a906-93691a6ee319";
const GENERAL = "0357db7a-f9be-4a9a-a70d-d70df7936503";
const TOKEN = "gia-" + crypto.randomBytes(18).toString("hex");
const ONLY = process.env.KB ? process.env.KB.split(",").map(s => s.trim()) : null;
const XSS = "<img src=x onerror=\"window.__xss=1\">";
fs.mkdirSync(SHOTS, { recursive: true }); fs.mkdirSync(TMPD, { recursive: true });

// ---------- Playwright ----------
function loadPlaywright() {
  try { return require("playwright"); } catch (e) { /* tìm tiếp */ }
  const base = path.join(process.env.LOCALAPPDATA || "", "npm-cache", "_npx");
  if (fs.existsSync(base)) for (const d of fs.readdirSync(base)) {
    const p = path.join(base, d, "node_modules", "playwright");
    if (fs.existsSync(p)) { try { return require(p); } catch (e) { /* thử thư mục khác */ } }
  }
  throw new Error("Không tìm thấy Playwright (npm i -D playwright hoặc npx playwright)");
}
async function launch(pw) {
  const cands = [];
  if (process.env.PW_CHROME) cands.push(process.env.PW_CHROME);
  cands.push(null);
  const msp = path.join(process.env.LOCALAPPDATA || "", "ms-playwright");
  if (fs.existsSync(msp)) {
    const dirs = fs.readdirSync(msp).sort((a, b) => (+(b.split("-")[1]) || 0) - (+(a.split("-")[1]) || 0));
    for (const d of dirs) {
      if (/^chromium_headless_shell-\d+$/.test(d)) cands.push(path.join(msp, d, "chrome-headless-shell-win64", "chrome-headless-shell.exe"));
      if (/^chromium-\d+$/.test(d)) cands.push(path.join(msp, d, "chrome-win64", "chrome.exe"));
    }
  }
  let last;
  for (const c of cands) {
    if (c && !fs.existsSync(c)) continue;
    try { const b = await pw.chromium.launch(c ? { headless: true, executablePath: c } : { headless: true }); return { b, exe: c || "(mặc định Playwright)" }; }
    catch (e) { last = e; }
  }
  throw last || new Error("Không mở được Chromium");
}

// ---------- dữ liệu mong đợi (tính bằng core.js, offline) ----------
const { XLSX } = require(path.join(ROOT, ".claude/skills/circa-nextwaves-check/scripts/kiem-dem/load-tool.js"));
function planOf(file) {
  const wb = XLSX.read(fs.readFileSync(file), { type: "buffer" });
  const ses = NWC.parseSession(XLSX.utils.sheet_to_json(wb.Sheets["Chi tiết quét"], { defval: "" }), XLSX.utils.sheet_to_json(wb.Sheets["Thẻ lạ"], { defval: "" }));
  return NWC.plan(ses, NWC.lookupMap(JSON.parse(fs.readFileSync(QR, "utf8")).res));
}
const P0 = planOf(XLS);
const B0 = NWC.batches(P0.items, "S", "NW-RFID");
const scans240 = JSON.parse(fs.readFileSync(SCANS240, "utf8"));

// file hỏng / file XSS (ghi vào TMPD, không đụng file gốc)
function writeWb(wb, name) { const f = path.join(TMPD, name); fs.writeFileSync(f, Buffer.from(XLSX.write(wb, { type: "array", bookType: "xlsx" }))); return f; }
function readWb() { return XLSX.read(fs.readFileSync(XLS), { type: "buffer" }); }
function colIdx(ws, name) { const hd = XLSX.utils.sheet_to_json(ws, { header: 1 })[0]; return hd.indexOf(name); }
const F_NO_SHEET = (() => { const wb = readWb(); delete wb.Sheets["Thẻ lạ"]; wb.SheetNames = wb.SheetNames.filter(n => n !== "Thẻ lạ"); return writeWb(wb, "thieu-sheet-the-la.xlsx"); })();
const F_QTY = (() => {
  const wb = readWb(), ws = wb.Sheets["Chi tiết quét"], c = colIdx(ws, "Số lượng thẻ");
  ws[XLSX.utils.encode_cell({ r: 1, c })] = { t: "s", v: "1.000" };
  return writeWb(wb, "so-luong-1.000.xlsx");
})();
// XSS: đổi tên mọi dòng của SP có thẻ gửi kèm đơn vị (để SP nằm trong "cần chú ý")
const XSS_PID = P0.items.find(x => x.mode === "kem-don-vi").pid;
const F_XSS = (() => {
  const wb = readWb(), ws = wb.Sheets["Chi tiết quét"], cp = colIdx(ws, "Mã SP"), cn = colIdx(ws, "Tên sản phẩm");
  const rng = XLSX.utils.decode_range(ws["!ref"]);
  for (let r = 1; r <= rng.e.r; r++) {
    const v = ws[XLSX.utils.encode_cell({ r, c: cp })];
    if (v && String(v.v).replace(/^CIRCA-/i, "") === String(XSS_PID)) ws[XLSX.utils.encode_cell({ r, c: cn })] = { t: "s", v: XSS + "SP thử XSS" };
  }
  return writeWb(wb, "ten-sp-xss.xlsx");
})();

// ---------- khung kiểm ----------
const RESULTS = [];
let cur = null;
function scen(id, title) { cur = { id, title, checks: [], notes: [] }; RESULTS.push(cur); console.log("\n=== KB" + id + ": " + title); }
function check(desc, ok, got) {
  cur.checks.push({ desc, ok: !!ok, got });
  console.log("  " + (ok ? "ĐẠT " : "LỖI ") + desc + (got !== undefined ? " → " + (typeof got === "string" ? got : JSON.stringify(got)) : ""));
}
function note(s) { cur.notes.push(s); console.log("  · " + s); }
const want = id => !ONLY || ONLY.includes(String(id));

let srv, browser, ALL = { console: [], urls: [], storage: [], downloads: [], dom: [] };
const fileUrl = url.pathToFileURL(HTML).href;

async function open(q) {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const P = { ctx, page, console: [], errors: [], dialogs: [], urls: [] };
  page.on("console", m => { P.console.push(m.type() + ": " + m.text()); });
  page.on("pageerror", e => P.errors.push(e.message));
  page.on("dialog", d => { P.dialogs.push(d.type() + ": " + d.message()); d.dismiss().catch(() => {}); });
  page.on("request", r => P.urls.push(r.url()));
  await page.goto(fileUrl + (q === undefined ? "?api=" + encodeURIComponent(srv.url) : q));
  return P;
}
async function close(P) {
  // gom dữ liệu cho KB9 (token không lọt)
  const st = await P.page.evaluate(() => JSON.stringify({ l: Object.assign({}, localStorage), s: Object.assign({}, sessionStorage), c: document.cookie }));
  const dom = await P.page.evaluate(() => document.documentElement.outerHTML + "\n" + document.body.innerText);
  ALL.console.push(...P.console); ALL.urls.push(...P.urls, P.page.url()); ALL.storage.push(st); ALL.dom.push(dom);
  check("không có lỗi JS trên trang", P.errors.length === 0, P.errors.slice(0, 3));
  check("không bật hộp thoại trình duyệt (alert/confirm/beforeunload)", P.dialogs.length === 0, P.dialogs.slice(0, 3));
  const csp = P.console.filter(x => /Content Security Policy|Refused to/i.test(x));
  check("không có vi phạm CSP", csp.length === 0, csp.slice(0, 2));
  await P.ctx.close();
}
const sum = P => P.page.evaluate(() => window.__NWC_TEST__.summary());
async function idle(P, pred, ms) {
  await P.page.waitForFunction(new Function("return (function(s){ return !s.busy && (" + (pred || "true") + "); })(window.__NWC_TEST__.summary())"), null, { timeout: ms || 60000, polling: 100 });
  return sum(P);
}
async function shot(P, name, full) { const f = path.join(SHOTS, name); if (full) await P.page.evaluate(() => window.scrollTo(0, 0)); await P.page.screenshot({ path: f, fullPage: !!full }); note("ảnh " + path.relative(ROOT, f)); }
async function setup(P, file, store) {
  await P.page.selectOption("#store", store || "lumina");
  await P.page.fill("#token", TOKEN);
  await P.page.setInputFiles("#file", file || XLS);
  return idle(P, "s.parse || s.fileErr");
}
async function lookup(P) { await P.page.click("#btn-lookup"); return idle(P, "s.lookup", 120000); }
async function confirm(P, shotName) {
  await P.page.waitForSelector("#modal:not([hidden])", { timeout: 15000 });
  const t = await P.page.textContent("#modal");
  if (shotName) await shot(P, shotName);
  await P.page.click("#modal-ok");
  return t;
}
async function createSession(P, shotName) {
  await P.page.click("#btn-create");
  const t = await confirm(P, shotName);
  const s = await idle(P, "s.target || s.createLocked || s.create", 240000);
  return { s, modal: t };
}
async function useExisting(P, text) {
  await P.page.fill("#sess-in", text);
  await P.page.click("#btn-sess");
  return idle(P, "s.target || true", 30000);
}
async function send(P, shotName) {
  await P.page.click("#btn-send");
  const t = await confirm(P, shotName);
  const s = await idle(P, "s.sendDone && s.rc", 240000);
  return { s, modal: t };
}
async function dl(P, sel, name) {
  const [d] = await Promise.all([P.page.waitForEvent("download", { timeout: 15000 }), P.page.click(sel)]);
  const f = path.join(TMPD, name || d.suggestedFilename());
  await d.saveAs(f);
  const text = fs.readFileSync(f, "utf8");
  ALL.downloads.push({ f, text });
  return { f, text, name: d.suggestedFilename() };
}
const logFrom = t0 => srv.log.filter(e => e.t >= t0);
const posts = (L, suffix) => L.filter(e => e.method === "POST" && e.path.endsWith(suffix));
const sentCodes = L => posts(L, "/submit-rfid-batch").flatMap(e => NWC.bodyCodes(e.body));
function headerChecks(L) {
  const reqs = L.filter(e => e.method !== "OPTIONS");
  const badH = reqs.filter(e => !(e.h.authOk && e.h.app === "admin" && e.h.client === "1" && e.h.store === LUMINA));
  check("mọi request có Bearer đúng token, X-Circa-App admin, X-Client-Id 1, X-Store-Id Lumina", reqs.length > 0 && badH.length === 0, { requests: reqs.length, sai: badH.length });
  const pp = reqs.filter(e => e.method === "POST");
  check("mọi POST có Content-Type application/json; charset=UTF-8", pp.every(e => e.h.ct === "application/json; charset=UTF-8"), pp.length + " POST");
  const pre = L.filter(e => e.method === "OPTIONS");
  check("preflight chỉ xin header trong danh sách Circa cho phép", pre.every(e => !e.bad.length), { preflight: pre.length, xinThem: [...new Set(pre.flatMap(e => e.bad))] });
}

// ================= KỊCH BẢN =================
async function kb1() {
  scen(1, "Đường thẳng: tạo phiên → gửi → đối chiếu ĐẠT");
  srv.reset(); srv.cfg = { token: TOKEN };
  const t0 = Date.now(), P = await open();
  let s = await setup(P);
  check("đọc file: 604 thẻ, 14 thẻ lạ, 0 lỗi", s.parse.tags === 604 && s.parse.strange === 14 && s.parse.errors === 0, s.parse);
  await shot(P, "01-thiet-lap-nap-file.png", true);
  s = await lookup(P);
  check("tra 727 mã: 604 nhận, 123 không nhận, 0 lỗi", s.lookup.stats.ok === 604 && s.lookup.stats.unk === 123 && s.lookup.stats.err === 0, s.lookup.stats);
  check("kế hoạch okToSend, 565 thô + 39 kèm đơn vị, gốc NW 11.630, 7 lô", s.plan.okToSend && s.plan.modes.tho === 565 && s.plan.modes["kem-don-vi"] === 39 && s.plan.nwBase === 11630 && s.plan.batches === 7, s.plan);
  const spRows = await P.page.$$eval("#pv-table tbody tr", r => r.length);
  check("bảng xem trước lọc 'cần chú ý' mặc định (SP có thẻ kèm đơn vị)", spRows === P0.bySp.filter(p => p.modes.tho !== p.tags || p.diff).length, spRows);
  await shot(P, "02-xem-truoc.png", true);
  const csvPv = await dl(P, "#btn-pv-csv");
  check("CSV xem trước: BOM UTF-8, 1 dòng tiêu đề + 279 SP", csvPv.text.charCodeAt(0) === 0xFEFF && csvPv.text.trim().split("\r\n").length === 280, csvPv.name);
  await P.page.click("#btn-locs");
  s = await idle(P);
  const locOpts = await P.page.$$eval("#loc option", o => o.map(x => x.value));
  const locVal = await P.page.inputValue("#loc");
  check("tải danh sách vị trí: General của Lumina được chọn", locVal === GENERAL && locOpts.includes(GENERAL), { chon: locVal, so: locOpts.length });
  const cr = await createSession(P, "03-xac-nhan-tao-phien.png");
  s = cr.s;
  check("hộp xác nhận tạo phiên nêu cửa hàng và việc chốt tồn sổ", /Lumina/.test(cr.modal) && /CHỐT/.test(cr.modal), cr.modal.slice(0, 120));
  check("phiên mới OPEN, đúng cửa hàng, 7 lô, 0 mã bỏ qua", s.target && s.target.status === "OPEN" && s.target.pos_id === LUMINA && s.bodies.n === 7 && s.bodies.excluded === 0, { target: s.target && s.target.code, bodies: s.bodies });
  await shot(P, "04-phien-dich.png", true);
  const sd = await send(P, "05-xac-nhan-gui.png");
  s = sd.s;
  check("hộp xác nhận gửi nêu mã phiên, 604 thẻ, 7 lô", sd.modal.includes(s.target.code) && /604 thẻ/.test(sd.modal) && /7 lô/.test(sd.modal), sd.modal.slice(0, 140));
  check("7 lô đều đạt, mỗi lô gửi 1 lần", s.batches.length === 7 && s.batches.every(b => b.ok && b.tries === 1), s.batches.map(b => b.codes + "/" + b.tries));
  check("đối chiếu ĐẠT 604/604, gốc Circa 11.630, 0 lượt ngoài", s.rc.ok && s.rc.counts.dung === 604 && s.rc.all === 11630 && s.rc.foreign === 0 && s.rc.scans === 604, s.rc.counts);
  const big = await P.page.textContent("#rc-big");
  check("hiện chữ ĐẠT lớn", /^ĐẠT/.test(big.trim()), big.trim().slice(0, 60));
  const L = logFrom(t0);
  const cp = posts(L, "/sessions");
  check("đúng 1 request tạo phiên", cp.length === 1, cp.length);
  const keys = ["pos_id", "scheduled_date", "counting_mode", "sync_baseline", "designated_main_location_id", "cleanup_missing", "auto_approve_tolerance_pct", "auto_approve_tolerance_value", "force_manual_review", "allow_ad_hoc_sku", "auto_writeoff_orphan_ghosts"];
  const b = cp[0].body;
  check("body tạo phiên đúng 11 trường như gui.js", JSON.stringify(Object.keys(b)) === JSON.stringify(keys) && b.pos_id === LUMINA && b.counting_mode === "QR" && b.sync_baseline === true && b.designated_main_location_id === GENERAL &&
    b.cleanup_missing === false && b.auto_approve_tolerance_pct === 2 && b.auto_approve_tolerance_value === 50000 && b.force_manual_review === false && b.allow_ad_hoc_sku === true && b.auto_writeoff_orphan_ghosts === false && /^\d{4}-\d{2}-\d{2}$/.test(b.scheduled_date), b);
  const sp = posts(L, "/submit-rfid-batch"), codes = sentCodes(L);
  check("đúng 7 request gửi lô", sp.length === 7, sp.length);
  check("604 mã gửi, không mã nào gửi 2 lần", codes.length === 604 && new Set(codes.map(NWC._codeKey)).size === 604, { gui: codes.length, khac: new Set(codes).size });
  check("body lô giống hệt NWC.batches (offline)", JSON.stringify(sp.map(e => NWC.bodyCodes(e.body))) === JSON.stringify(B0.map(x => NWC.bodyCodes(x))) && sp.every(e => e.body.device_id === "NW-RFID" && e.body.session_id === s.target.id), "");
  const kem = sp.flatMap(e => e.body.items || []);
  check("39 mã gửi kèm đơn vị (items), 565 thô (tags)", kem.length === 39 && sp.flatMap(e => e.body.tags || []).length === 565, kem.length);
  headerChecks(L);
  await shot(P, "06-gui-xong-doi-chieu-dat.png", true);
  const lg = await dl(P, "#btn-log");
  const J = JSON.parse(lg.text);
  check("sổ ghi: tên có mã phiên, đủ phần (file NW, kế hoạch, 7 lô body+response, đối chiếu, lượt quét sau)", lg.name.includes(s.target.code) && J.fileNW && J.fileNW.sha256 && J.keHoach && J.lo.length === 7 && J.lo.every(x => x.body && x.lanGui[0].response && x.lanGui[0].at) && J.doiChieu.ok === true && J.luotQuetSauGui.length === 604 && J.phien.taoPhien.body, lg.name);
  const rcCsv = await dl(P, "#btn-rc-csv");
  check("CSV đối chiếu theo SP: BOM, 279 SP", rcCsv.text.charCodeAt(0) === 0xFEFF && rcCsv.text.trim().split("\r\n").length === 280, rcCsv.name);
  s = await sum(P);
  check("sau khi tải sổ ghi: hết cảnh báo đóng trang", s.dirty === false, s.dirty);
  await close(P);
}

async function kb2() {
  scen(2, "Phiên có sẵn chứa 12 lượt (ICS00240): loại 12, gửi 592, CHƯA ĐẠT 2 sai-số");
  srv.reset(); srv.cfg = { token: TOKEN };
  const ses = srv.addSession({ id: "aaaaaaaa-0240-4000-8000-000000000240", code: "ICS90240", scans: scans240 });
  const t0 = Date.now(), P = await open();
  await setup(P); await lookup(P);
  let s = await useExisting(P, "https://admin.v2.circa.vn/kiem-ke-ton-kho/" + ses.id);
  check("dán link admin → nhận đúng phiên OPEN", s.target && s.target.id === ses.id && s.target.status === "OPEN", s.target && s.target.code);
  check("12 mã đã có bị loại, còn 6 lô", s.bodies.excluded === 12 && s.bodies.n === 6, s.bodies);
  const t = await P.page.textContent("#s5-out");
  check("bước 5 báo 12 lượt có sẵn, 2 mã đã ghi sai số, mã đã có không gửi lại", /12 lượt quét/.test(t) && /SAI số: 2/.test(t) && /KHÔNG gửi lại/.test(t), t.slice(0, 200));
  await shot(P, "07-kb2-phien-co-san.png", true);
  s = (await send(P)).s;
  const L = logFrom(t0), codes = sentCodes(L);
  check("gửi đúng 592 mã, không mã nào trong 12 mã có sẵn", codes.length === 592 && !codes.some(c => scans240.some(x => NWC._codeKey(x.qr_code) === NWC._codeKey(c))), codes.length);
  check("đối chiếu CHƯA ĐẠT: 602 đúng, đúng 2 sai-số, 0 thiếu/lặp/lượt ngoài", s.rc.ok === false && s.rc.counts.dung === 602 && s.rc.counts["sai-so"] === 2 && s.rc.counts.thieu === 0 && s.rc.counts.lap === 0 && s.rc.foreign === 0, s.rc.counts);
  const bad = s.rc.bad.map(x => x.code).sort();
  check("2 thẻ sai-số là 1794037081630Y21 và 1794655791190B91", JSON.stringify(bad) === JSON.stringify(["1794037081630Y21", "1794655791190B91"]), bad);
  check("gốc Circa 11.679 (NW 11.630, chênh −49)", s.rc.all === 11679 && s.rc.nwBase === 11630, s.rc.all);
  const big = await P.page.textContent("#rc-big");
  check("hiện CHƯA ĐẠT", /CHƯA ĐẠT/.test(big), big.slice(0, 40));
  const s7 = await P.page.textContent("#s7-out");
  check("nhắc phiên vẫn MỞ và số ghi sai phải đếm lại trên Circa", /vẫn MỞ/.test(s7) && /KHÔNG sửa được bằng API/.test(s7), "");
  await shot(P, "08-kb2-chua-dat.png", true);
  headerChecks(L);
  await close(P);
}

async function kb3() {
  scen(3, "Lô 3 trả 500 hai lần rồi 200 → gửi lại nguyên lô, ĐẠT, không đếm dư");
  srv.reset(); srv.cfg = { token: TOKEN, submitFaults: { 3: [{ status: 500, record: true }, { status: 500 }] } };
  const ses = srv.addSession({ id: "bbbbbbbb-0003-4000-8000-000000000003", code: "ICS90003" });
  const t0 = Date.now(), P = await open();
  await setup(P); await lookup(P);
  let s = await useExisting(P, ses.id);
  s = (await send(P)).s;
  const L = logFrom(t0), sp = posts(L, "/submit-rfid-batch");
  const b3 = sp.filter(e => e.lo === 3);
  check("9 request gửi (7 lô + 2 lần gửi lại), lô 3 gửi 3 lần", sp.length === 9 && b3.length === 3, { gui: sp.length, lo3: b3.map(e => e.status) });
  check("3 lần gửi lô 3 cùng một body (gửi lại NGUYÊN lô)", b3.length === 3 && b3.every(e => JSON.stringify(e.body) === JSON.stringify(b3[0].body)), "");
  const gaps = b3.slice(1).map((e, i) => e.t - b3[i].t);
  check("chờ ~1 s rồi ~2 s giữa các lần gửi lại", gaps.length === 2 && gaps[0] >= 950 && gaps[1] >= 1950, gaps);
  const lo3 = s.batches.find(b => b.lo === 3);
  check("lô 3 đạt khi kiểm với resend (response duplicates 100, inserted 0)", lo3.ok && lo3.tries === 3 && b3[2].result && b3[2].result.duplicates === 100 && b3[2].result.inserted === 0, b3[2].result);
  check("đối chiếu ĐẠT: 604 lượt, gốc 11.630 (không đếm dư)", s.rc.ok && s.rc.scans === 604 && s.rc.all === 11630, { scans: s.rc.scans, goc: s.rc.all });
  await shot(P, "09-kb3-gui-lai-dat.png");
  await close(P);
}

async function kb4() {
  scen(4, "Lô 2 trả 400 FAILED_PRECONDITION → dừng, không gửi lô 3+, đối chiếu vẫn chạy");
  srv.reset(); srv.cfg = { token: TOKEN, submit400At: 2 };
  srv.addSession({ id: "cccccccc-0004-4000-8000-000000000004", code: "ICS90004" });
  const t0 = Date.now(), P = await open();
  await setup(P); await lookup(P);
  await P.page.click("#btn-current");
  let s = await idle(P, "s.target");
  check("“Lấy phiên đang mở” → ICS90004", s.target && s.target.code === "ICS90004", s.target && s.target.code);
  s = (await send(P)).s;
  const L = logFrom(t0), sp = posts(L, "/submit-rfid-batch");
  check("chỉ 2 request gửi (lô 1, lô 2), không gửi lô 3+", sp.length === 2 && sp.map(e => e.lo).join() === "1,2", sp.map(e => e.lo + ":" + e.status));
  check("lô 2 dừng vì phiên không mở, không gửi lại (4xx)", s.batches.length === 2 && s.batches[1].stop === "phiên không mở" && s.batches[1].tries === 1, s.batches[1]);
  check("đối chiếu vẫn chạy: 100 đúng, 504 thiếu", s.rc && s.rc.ok === false && s.rc.counts.dung === 100 && s.rc.counts.thieu === 504, s.rc.counts);
  const t = await P.page.textContent("#s6-out");
  check("trang báo ĐÃ DỪNG GỬI kèm FAILED_PRECONDITION", /ĐÃ DỪNG GỬI/.test(t) && /FAILED_PRECONDITION/.test(t), "");
  const t7 = await P.page.textContent("#s7-out");
  check("bước 7 báo 504 thẻ chưa có lượt", /504/.test(t7) && /CHƯA ĐẠT/.test(t7), "");
  await shot(P, "10-kb4-dung-400.png", true);
  await close(P);
}

async function kb5() {
  scen(5, "401 ở bước tra thẻ → báo token, không sang bước sau");
  srv.reset(); srv.cfg = { token: TOKEN, lookup401After: 50 };
  const t0 = Date.now(), P = await open();
  await setup(P);
  let s = await lookup(P);
  check("tra thẻ dừng với lý do token", s.lookup.abort === "token", s.lookup);
  check("chưa có kế hoạch, bước 4 khoá", s.plan === null && await P.page.$eval("#s4", e => e.classList.contains("locked")), s.plan);
  const t = await P.page.textContent("#s3-out");
  check("trang báo token hết hạn (401)", /Token hết hạn/.test(t) && /401/.test(t), t.slice(0, 120));
  const L = logFrom(t0), lk = L.filter(e => e.path.endsWith("/qr-lookup"));
  check("dừng ngay sau 401 (≤ 4 lượt tra đang chạy dở), không POST nào", lk.filter(e => e.status === 401).length <= 4 && posts(L, "").length === 0, { tra: lk.length, l401: lk.filter(e => e.status === 401).length });
  check("nút gửi và tạo phiên bị khoá", await P.page.$eval("#btn-send", e => e.disabled) && await P.page.$eval("#btn-create", e => e.disabled), "");
  await shot(P, "11-kb5-401-tra-the.png", true);
  // phục hồi: token mới rồi tra lại phần chưa tra
  srv.cfg = { token: TOKEN };
  await P.page.fill("#token", TOKEN);
  await P.page.click("#btn-lookup-retry");
  s = await idle(P, "s.lookup && !s.lookup.abort", 120000);
  check("sau khi dán lại token, “Tra lại phần chưa tra” hoàn tất → kế hoạch đạt", s.plan && s.plan.okToSend && s.lookup.stats.err === 0 && s.lookup.stats.todo === 0, s.lookup.stats);
  await close(P);
}

async function kb6() {
  scen(6, "Máy chủ ghi sai một thẻ (bỏ qua items) → trang dừng và chỉ đúng thẻ đó");
  const bi = B0.findIndex(b => b.items && b.items.length), wrong = B0[bi].items[0].tag;
  const it = P0.items.find(x => x.code === wrong);
  note("thẻ bị ghi sai: " + wrong + " (SP " + it.pid + ", NW " + it.nwQty + " " + it.nwUnit + ", Circa 1 " + it.circaUnit + " = " + it.circaRate + ") ở lô " + (bi + 1));
  srv.reset(); srv.cfg = { token: TOKEN, wrongCode: wrong };
  const t0 = Date.now(), P = await open();
  await setup(P); await lookup(P);
  await createSession(P);
  let s = (await send(P)).s;
  const L = logFrom(t0), sp = posts(L, "/submit-rfid-batch");
  check("dừng ở lô " + (bi + 1) + ", không gửi lô sau", sp.length === bi + 1 && s.batches.length === bi + 1 && s.batches[bi].stop === "lô không đạt", sp.length);
  check("lô sai chỉ đúng 1 thẻ: " + wrong, JSON.stringify(s.batches[bi].bad) === JSON.stringify([wrong]), s.batches[bi].bad);
  const t = await P.page.textContent("#s6-out");
  check("bảng lô sai hiện mã + EPC của thẻ đó", t.includes(wrong) && t.includes(it.epc), "");
  const nSent = B0.slice(0, bi + 1).reduce((a, b) => a + NWC.bodyCodes(b).length, 0);
  check("đối chiếu: 1 sai-số (đúng thẻ đó), thiếu " + (604 - nSent), s.rc.counts["sai-so"] === 1 && s.rc.bad.filter(x => x.result === "sai-so").map(x => x.code)[0] === wrong && s.rc.counts.thieu === 604 - nSent, s.rc.counts);
  await shot(P, "12-kb6-the-ghi-sai.png", true);
  await close(P);
}

async function kb7() {
  scen(7, "File hỏng: thiếu sheet; Số lượng thẻ = 1.000 → khoá gửi");
  srv.reset(); srv.cfg = { token: TOKEN };
  let P = await open();
  let s = await setup(P, F_NO_SHEET);
  check("thiếu sheet “Thẻ lạ” → báo lỗi rõ", /thiếu sheet/.test(s.fileErr) && /Thẻ lạ/.test(s.fileErr), s.fileErr);
  check("bước 3 khoá, nút tra bị tắt", await P.page.$eval("#s3", e => e.classList.contains("locked")) && await P.page.$eval("#btn-lookup", e => e.disabled), "");
  await shot(P, "13-kb7-thieu-sheet.png");
  await close(P);
  const t0 = Date.now();
  P = await open();
  s = await setup(P, F_QTY);
  check("dòng “1.000” → 1 lỗi dấu phân cách, còn 603 thẻ", s.parse.errors === 1 && s.parse.tags === 603, s.parse);
  const t2 = await P.page.textContent("#s2-out");
  check("bước 2 liệt kê lỗi “1.000”", /1\.000/.test(t2) && /dấu chấm\/phẩy/.test(t2), "");
  s = await lookup(P);
  check("kế hoạch bị chặn (okToSend false, lý do dòng lỗi)", s.plan && !s.plan.okToSend && s.plan.blockers.some(b => /dòng lỗi/.test(b)), s.plan && s.plan.blockers);
  const locked = await P.page.evaluate(() => ["#s5", "#s6"].every(q => document.querySelector(q).classList.contains("locked")) &&
    ["#btn-create", "#btn-sess", "#btn-current", "#btn-send"].every(q => document.querySelector(q).disabled));
  check("bước 5–6 khoá, mọi nút tạo / chọn phiên / gửi bị tắt", locked, "");
  check("không có request ghi nào", posts(logFrom(t0), "").length === 0, "");
  await shot(P, "14-kb7-khoa-gui.png", true);
  await close(P);
}

async function kb8() {
  scen(8, "Tạo phiên lỗi / timeout → không tự gửi lại; phiên kẹt LOADING_BASELINE → dừng sau thời hạn");
  // a. 500 (máy chủ vẫn tạo phiên)
  srv.reset(); srv.cfg = { token: TOKEN, createFail: 500, createAnyway: true };
  let t0 = Date.now(), P = await open();
  await setup(P); await lookup(P);
  let s = (await createSession(P)).s;
  await P.page.waitForTimeout(3000);
  s = await sum(P);
  let L = logFrom(t0);
  check("a. 500: đúng 1 POST tạo phiên sau 3 s chờ, nút tạo bị khoá, không chọn phiên", posts(L, "/sessions").length === 1 && s.createLocked && !s.target && await P.page.$eval("#btn-create", e => e.disabled), posts(L, "/sessions").length);
  let t = await P.page.textContent("#create-out");
  check("a. báo KHÔNG RÕ đã tạo hay chưa + hướng dẫn kiểm admin", /KHÔNG RÕ/.test(t) && /admin/.test(t), t.slice(0, 100));
  await shot(P, "15-kb8-tao-phien-500.png");
  await close(P);
  // b. treo → timeout (rút ngắn 2 s trong chế độ thử)
  srv.reset(); srv.cfg = { token: TOKEN, createHang: true, createAnyway: true };
  t0 = Date.now(); P = await open("?api=" + encodeURIComponent(srv.url) + "&timeout=2000");
  await setup(P); await lookup(P);
  s = (await createSession(P)).s;
  await P.page.waitForTimeout(2500);
  s = await sum(P); L = logFrom(t0);
  t = await P.page.textContent("#create-out");
  check("b. timeout: đúng 1 POST tạo phiên, báo timeout + KHÔNG RÕ, nút khoá", posts(L, "/sessions").length === 1 && /timeout/.test(t) && /KHÔNG RÕ/.test(t) && s.createLocked && !s.target, posts(L, "/sessions").length);
  await close(P);
  // c. kẹt LOADING_BASELINE (thời hạn rút ngắn 4 s, hỏi mỗi 300 ms)
  srv.reset(); srv.cfg = { token: TOKEN, stuck: true };
  t0 = Date.now(); P = await open("?api=" + encodeURIComponent(srv.url) + "&poll=4000&every=300");
  await setup(P); await lookup(P);
  const tc = Date.now();
  s = (await createSession(P)).s;
  const el = Date.now() - tc;
  L = logFrom(t0);
  const polls = L.filter(e => e.method === "GET" && /\/sessions\/[^/]+$/.test(e.path));
  t = await P.page.textContent("#create-out");
  check("c. kẹt LOADING_BASELINE: dừng sau thời hạn, báo chưa MỞ, không chọn phiên, không gửi", !s.target && /chưa MỞ/.test(t) && /quá thời hạn/.test(t) && posts(L, "/submit-rfid-batch").length === 0 && el >= 4000 && el < 15000, { ms: el, hoi: polls.length });
  check("c. đúng 1 POST tạo phiên; id phiên được điền sẵn ở mục b", posts(L, "/sessions").length === 1 && UUIDok(await P.page.inputValue("#sess-in")), "");
  await shot(P, "16-kb8-ket-loading-baseline.png");
  await close(P);
  // d. 400 (chắc chắn chưa tạo) → cho tạo lại bằng tay, vẫn không tự gửi lại
  srv.reset(); srv.cfg = { token: TOKEN, createFail: 400 };
  t0 = Date.now(); P = await open();
  await setup(P); await lookup(P);
  s = (await createSession(P)).s;
  await P.page.waitForTimeout(1500);
  s = await sum(P); L = logFrom(t0);
  t = await P.page.textContent("#create-out");
  check("d. 400: đúng 1 POST, báo phiên CHƯA được tạo, nút tạo mở lại cho người dùng", posts(L, "/sessions").length === 1 && /CHƯA được tạo/.test(t) && !s.createLocked && !(await P.page.$eval("#btn-create", e => e.disabled)), t.slice(0, 80));
  await close(P);
}
function UUIDok(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s); }

async function kb10() {
  scen(10, "Tên SP chứa <img src=x onerror=…> không thực thi");
  srv.reset(); srv.cfg = { token: TOKEN };
  const ses = srv.addSession({ id: "dddddddd-0010-4000-8000-000000000010", code: "ICS90010" });
  srv.addScan(ses.id, { qr_code: "XSS-NGOAI", product_id: 999999, scanned_qty: 1, unit_code: XSS, conversion_factor: 1, base_qty: 1, device_id: XSS, product_name: XSS + "SP ngoài" });
  const P = await open();
  await setup(P, F_XSS); await lookup(P);
  let t = await P.page.textContent("#pv-table");
  check("tên SP độc hại hiện đúng nguyên chữ ở bảng xem trước", t.includes(XSS + "SP thử XSS"), "");
  await useExisting(P, ses.id);
  await send(P);
  const t7 = await P.page.textContent("#s7-out");
  check("tên SP / thiết bị độc hại từ API hiện nguyên chữ ở đối chiếu", t7.includes(XSS + "SP ngoài"), "");
  const r = await P.page.evaluate(() => ({ xss: window.__xss, img: document.querySelectorAll("img").length }));
  check("window.__xss không được đặt, không có thẻ <img> nào trong DOM", r.xss === undefined && r.img === 0, r);
  await shot(P, "17-kb10-xss.png", true);
  await close(P);
}

async function kbPhu() {
  scen("P1", "Phụ: Florita bắt buộc tải + chọn vị trí; file kho Lumina → cảnh báo");
  srv.reset(); srv.cfg = { token: TOKEN };
  let P = await open();
  await setup(P, XLS, "florita");
  const t2 = await P.page.textContent("#s2-out");
  check("cảnh báo Kho “Lumina” khác cửa hàng Florita", /khác cửa hàng đã chọn \(Florita\)/.test(t2), "");
  await lookup(P);
  check("chưa chọn vị trí → nút tạo phiên tắt", await P.page.$eval("#btn-create", e => e.disabled), "");
  await P.page.click("#btn-locs"); await idle(P);
  const opts = await P.page.$$eval("#loc option", o => o.map(x => x.textContent));
  check("danh sách vị trí Florita tải được, chưa tự chọn", opts.length === 3 && (await P.page.inputValue("#loc")) === "", opts);
  await P.page.selectOption("#loc", "22222222-bbbb-4bbb-8bbb-000000000001");
  check("chọn General → nút tạo phiên bật", !(await P.page.$eval("#btn-create", e => e.disabled)), "");
  check("mọi request mang X-Store-Id Florita", srv.log.filter(e => e.method !== "OPTIONS").every(e => e.h.store === "c476efb2-415c-429a-978e-d389b4b06607"), "");
  await close(P);
  scen("P2", "Phụ: ?api= không phải localhost → trang khoá, không gọi mạng");
  P = await open("?api=" + encodeURIComponent("https://evil.example.com"));
  const fat = await P.page.textContent("#fatal");
  check("báo ?api= không hợp lệ, ô cửa hàng bị khoá", /không hợp lệ/.test(fat) && await P.page.$eval("#store", e => e.disabled), fat.slice(0, 60));
  check("không có request mạng nào ngoài file://", P.urls.every(u => u.startsWith("file:")), P.urls.filter(u => !u.startsWith("file:")));
  await shot(P, "18-api-khong-hop-le.png");
  await close(P);
  scen("P4", "Phụ: lô 2 treo (máy chủ đã ghi, mất response) → timeout → gửi lại nguyên lô, ĐẠT");
  srv.reset(); srv.cfg = { token: TOKEN, submitFaults: { 2: [{ hang: true, record: true }] } };
  const s4 = srv.addSession({ id: "eeeeeeee-0004-4000-8000-000000000044", code: "ICS90044" });
  const t4 = Date.now();
  P = await open("?api=" + encodeURIComponent(srv.url) + "&timeout=2000");
  await setup(P); await lookup(P); await useExisting(P, s4.id);
  let r4 = (await send(P)).s;
  const sp4 = posts(logFrom(t4), "/submit-rfid-batch"), b2 = sp4.filter(e => e.lo === 2);
  check("lô 2: lần 1 treo → timeout, gửi lại nguyên lô 1 lần (8 request gửi)", sp4.length === 8 && b2.length === 2 && JSON.stringify(b2[0].body) === JSON.stringify(b2[1].body), sp4.map(e => e.lo + ":" + e.status));
  check("lô 2 đạt với resend (duplicates 100); đối chiếu ĐẠT 604 lượt, gốc 11.630", r4.batches[1].ok && r4.batches[1].tries === 2 && b2[1].result.duplicates === 100 && r4.rc.ok && r4.rc.scans === 604 && r4.rc.all === 11630, r4.rc.counts);
  await close(P);
  scen("P3", "Phụ: không có ?api= → băng CHẾ ĐỘ THỬ ẩn, base Circa thật (không gửi request nào)");
  P = await open("");
  check("không có băng chế độ thử", await P.page.$eval("#testbar", e => e.hidden), "");
  check("không gọi mạng khi chưa bấm gì", P.urls.every(u => u.startsWith("file:")), "");
  await close(P);
}

function kb9() {
  scen(9, "Token không lọt ra: file tải về, storage, URL, console, DOM");
  const tk = TOKEN;
  check("file tải về (" + ALL.downloads.length + " file: sổ ghi, CSV) không chứa token", ALL.downloads.length > 0 && ALL.downloads.every(d => !d.text.includes(tk)), ALL.downloads.map(d => path.basename(d.f)));
  check("localStorage / sessionStorage / cookie rỗng, không chứa token", ALL.storage.every(s => !s.includes(tk) && s === "{\"l\":{},\"s\":{},\"c\":\"\"}"), ALL.storage[0]);
  check("URL trang và mọi URL request (" + ALL.urls.length + ") không chứa token", ALL.urls.every(u => !u.includes(tk)), "");
  check("URL trong log máy chủ giả không chứa token", srv.log.every(e => !String(e.url).includes(tk)), srv.log.length + " dòng log");
  check("console (" + ALL.console.length + " dòng) không chứa token", ALL.console.every(c => !c.includes(tk)), ALL.console.slice(0, 3));
  check("DOM (outerHTML + chữ hiển thị) không chứa token", ALL.dom.every(d => !d.includes(tk)), "");
}

(async () => {
  if (!fs.existsSync(HTML)) throw new Error("Chưa build: chạy node tools/nw-sang-circa/build.js");
  const pw = loadPlaywright();
  const L = await launch(pw);
  browser = L.b;
  console.log("Chromium:", L.exe, browser.version(), "· trang:", HTML);
  srv = await M.start({ port: 0, lookupFile: QR });
  console.log("máy chủ giả:", srv.url, "· token giả:", TOKEN.slice(0, 6) + "…");
  console.log("kế hoạch offline:", P0.sum.modes, "gốc", P0.sum.nwBase, "lô", B0.length);
  const runs = [["1", kb1], ["2", kb2], ["3", kb3], ["4", kb4], ["5", kb5], ["6", kb6], ["7", kb7], ["8", kb8], ["10", kb10], ["P", kbPhu]];
  for (const [id, fn] of runs) {
    if (!want(id)) continue;
    try { await fn(); } catch (e) { if (!cur || cur.id !== (+id || id)) scen(id, "(lỗi trước khi bắt đầu)"); check("chạy hết kịch bản không lỗi", false, String(e && e.stack || e).slice(0, 600)); }
  }
  if (want("9")) kb9();
  await browser.close();
  await srv.close();
  console.log("\n================ TỔNG KẾT ================");
  let fail = 0;
  for (const r of RESULTS) {
    const bad = r.checks.filter(c => !c.ok);
    fail += bad.length;
    console.log((bad.length ? "KHÔNG ĐẠT " : "ĐẠT       ") + "KB" + r.id + " " + r.title + " (" + (r.checks.length - bad.length) + "/" + r.checks.length + ")");
    bad.forEach(c => console.log("     LỖI: " + c.desc + " → " + JSON.stringify(c.got)));
  }
  fs.writeFileSync(path.join(TMPD, "ket-qua-test-ui.json"), JSON.stringify({ at: new Date().toISOString(), chromium: L.exe, results: RESULTS }, null, 1));
  console.log("kết quả chi tiết:", path.join(TMPD, "ket-qua-test-ui.json"));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("LỖI:", e && e.stack || e); process.exit(2); });
