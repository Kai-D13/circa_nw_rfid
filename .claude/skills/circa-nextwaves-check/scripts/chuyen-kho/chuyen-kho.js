#!/usr/bin/env node
/*
 * chuyen-kho.js: lập phiếu chuyển kho NW cho thẻ RFID nhập nhầm, CIRCA LUMINA → CIRCA TAM VIET (23/11/2026).
 *
 * *** CÓ GHI lên NW *** (POST /stock-transfers, …/submit, …/complete, …/cancel), chỉ ở lệnh có --ghi.
 * Chỉ PM chạy --ghi, sau khi user xác nhận. Không có --ghi thì lệnh ghi chỉ in payload (chạy khô, không gọi mạng).
 *
 * Cách dùng (cwd tuỳ ý; đường dẫn tính theo thư mục chứa script):
 *   node chuyen-kho.js plan [--thu-sp=<mã Circa>,<mã Circa>]   offline: chia lô → out/chuyen-kho/plan.json (đã có thì chỉ kiểm, không ghi đè)
 *   node chuyen-kho.js kiem <lô>                     chỉ đọc: thẻ active @Lumina, số dư = slLedger, phiếu chuyển đã có, số dư SP trước khi chuyển
 *   node chuyen-kho.js tao  <lô> [--ghi]             kiểm trước → tạo phiếu DRAFT → đọc lại, so khớp kế hoạch
 *   node chuyen-kho.js gui  <lô> [--ghi]             submit (hàng rời Lumina) → kiểm thẻ trong DS về 0, thẻ ngoài DS còn nguyên
 *   node chuyen-kho.js nhan <lô> [--ghi] [--chap-nhan-lech-gui]   complete (hàng vào Tam Việt)
 *   node chuyen-kho.js soat <lô>                     chỉ đọc: soát sau khi nhận → out/chuyen-kho/<lô>.soat.json
 *   node chuyen-kho.js huy  <lô> [--ghi] --ly-do "<lý do>"         huỷ phiếu DRAFT / SUBMITTED / IN_TRANSIT
 *   node chuyen-kho.js trang-thai                    chỉ đọc: bảng mọi lô (state + GET phiếu)
 *   node chuyen-kho.js tach <lô>                     offline, không mạng: tách lô có dòng lẫn cỡ thẻ thành các lô mới (xem dưới)
 *
 * Dòng lẫn cỡ thẻ (thêm 23/11 sau phiếu INT/00007 của lo-02): với dòng phiếu có nhiều EPC, NW CHIA ĐỀU `quantity` cho các EPC
 * (2007233: 5 thẻ SL 1/10/1/1/10, quantity 23 → trừ 4,6 mỗi thẻ, số dư thẻ thành −3,6 và 5,4). Nên mỗi dòng phiếu chỉ được chứa
 * EPC CÙNG slLedger. `plan` báo KHÔNG ĐẠT và `tao` từ chối lô có dòng lẫn cỡ; dùng `tach <lô>`:
 *   - chỉ chạy khi state của lô cho thấy phiếu đã CANCELLED (huỷ thành công, record huỷ / state ghi CANCELLED) hoặc chưa từng tạo phiếu;
 *   - THÊM vào plan.json các lô <lô>a, <lô>b, …: lô a = mọi dòng một cỡ (giữ nguyên), mỗi cỡ của SP lẫn cỡ là một lô riêng
 *     (cỡ lớn trước), UUID mới cho từng bước; lô gốc được đánh dấu `daTach` (tao/gui/nhan từ chối lô gốc), các lô khác giữ nguyên byte;
 *   - kiểm tổng các lô chưa tách (đúng tập EPC của danh sách, không trùng, tổng SL) trước khi ghi; chép plan cũ thành
 *     plan.truoc-tach-<lô>.json (không ghi đè).
 *   Các lô con cùng SP (vd <lô>b, <lô>c) phải chạy tuần tự: `gui --ghi` từ chối khi một lô khác cùng SP đã gửi mà chưa soát đạt.
 *
 * Khoá: env NW_KEY. Không in, không ghi ra file; record/payload che header authorization.
 * Đầu vào:
 *   out/the-map-nham-lumina.json      269 thẻ {epc, productId, circaProductId, tenSP, slLedger, epcLedgerBalance…}
 *   phien/ledger-lumina-raw.json      sổ kho Lumina kéo sẵn (chỉ dùng ở `plan` để biết SP nào còn thẻ ngoài DS khi chọn lô thử)
 * Đầu ra:
 *   out/chuyen-kho/plan.json, <lô>.state.json, <lô>.soat.json, plan.truoc-tach-<lô>.json (bản plan trước khi tách)
 *   records/nw-writes/20261123-chuyen-kho-lumina-tamviet-<lô>-<bước>[-lanN].payload.json (ghi TRƯỚC POST) / .record.json (ghi ngay SAU)
 * Mã thoát: 0 đạt · 1 không đạt / lệch / từ chối chạy · 2 khoá bị 401/403 · 3 kết quả ghi không rõ · 4 NW từ chối (4xx)
 *
 * Chống trùng (tự test NW 12/11, dự án circa-qr-scan-log TEST-NW-1112.md): `clientOperationId` KHÔNG chống trùng phiếu chuyển,
 * `Idempotency-Key` thì có (replay 24 giờ). Mỗi POST gửi cả hai, cùng UUID của lô + bước lấy từ plan.json; notes mang dấu
 * `op:<uuid bước tạo>` để tìm lại phiếu khi kết quả tạo không rõ.
 *
 * Env phụ: CK_DIR (thư mục plan/state), CK_SO (thư mục sổ; NW thật + --ghi thì bắt buộc là records/nw-writes), CK_LIST, CK_LEDGER,
 *   CK_EXPECT "<số EPC>:<tổng SL>" (chỉ nhận khi đặt CK_LIST), CK_MAX_EPC (mặc định 60), CK_SINCE (mốc updatedSince khi dò phiếu).
 *   Chỉ cho test (chỉ nhận khi NW_BASE = http://127.0.0.1:<port>): CK_TIMEOUT_MS, CK_PACE_MS, CK_BACKOFF_MS.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BASE_THAT = "https://api-circa.nextwaves.app/api/v1/public";
const LUM = "3f7bd541-7370-4ce0-9048-231cf061e91a";
const TV = "7b9fde8f-a55a-4c48-ac58-0e3b4cdbd2b7";
const TEN = { [LUM]: "CIRCA LUMINA", [TV]: "CIRCA TAM VIET" };
const PREFIX = "20261123-chuyen-kho-lumina-tamviet";
const WORK = __dirname;
const SO_THAT = path.resolve(WORK, "..", "..", "records", "nw-writes");
const ENV = process.env;

const BASE = String(ENV.NW_BASE || BASE_THAT).replace(/\/+$/, "");
const GIA = BASE !== BASE_THAT;
const DIR = path.resolve(ENV.CK_DIR || path.join(WORK, "out", "chuyen-kho"));
const SO = path.resolve(ENV.CK_SO || SO_THAT);
const LIST = path.resolve(ENV.CK_LIST || path.join(WORK, "out", "the-map-nham-lumina.json"));
const LEDGER = path.resolve(ENV.CK_LEDGER || path.join(WORK, "phien", "ledger-lumina-raw.json"));
const EXPECT = ENV.CK_LIST && ENV.CK_EXPECT ? ENV.CK_EXPECT : "269:1707";
const MAX_EPC = ENV.CK_MAX_EPC ? Number(ENV.CK_MAX_EPC) : 60;
const SINCE = ENV.CK_SINCE || "2026-11-22T17:00:00.000Z"; // 00:00 23/11 giờ VN: thẻ trong DS tạo từ 10:28 23/11
const TIMEOUT = GIA && ENV.CK_TIMEOUT_MS ? Number(ENV.CK_TIMEOUT_MS) : 60000;
const PACE = GIA && ENV.CK_PACE_MS != null ? Number(ENV.CK_PACE_MS) : 150;
const BACKOFF = GIA && ENV.CK_BACKOFF_MS != null ? Number(ENV.CK_BACKOFF_MS) : 1500;
const MO = ["chua", "khong-ro", "dang-gui"]; // trạng thái bước còn được phép chạy (lại)

class Dung extends Error {
  constructor(msg, code) { super(msg); this.code = code == null ? 1 : code; }
}
const NET = { get: 0, docPost: 0, ghiPost: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = () => new Date().toISOString();
const vn = (s) => (s ? new Date(new Date(s).getTime() + 7 * 3600e3).toISOString().replace("T", " ").slice(0, 19) : "");
const U = (s) => String(s == null ? "" : s).toUpperCase();
const L = (s) => String(s == null ? "" : s).toLowerCase();
const sum = (a) => a.reduce((t, x) => t + x, 0);
const r6 = (x) => Math.round(Number(x) * 1e6) / 1e6;
const numCirca = (c) => (/^\d+$/.test(String(c)) ? Number(c) : Number.MAX_SAFE_INTEGER);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const tenKho = (id) => TEN[L(id)] || (id ? String(id) : "(trống)");
const cat = (a, n) => (a.length > n ? a.slice(0, n).join(", ") + ` … (+${a.length - n})` : a.join(", "));
const pad = (s, n) => { s = String(s == null ? "" : s); return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length); };

// ---------- tham số dòng lệnh ----------
const RAW = process.argv.slice(2);
const OPT = {};
const POS = [];
for (let i = 0; i < RAW.length; i++) {
  const a = RAW[i];
  if (!a.startsWith("--")) { POS.push(a); continue; }
  const eq = a.indexOf("=");
  if (eq > 0) OPT[a.slice(2, eq)] = a.slice(eq + 1);
  else if (["ly-do", "thu-sp"].includes(a.slice(2))) OPT[a.slice(2)] = RAW[++i];
  else OPT[a.slice(2)] = true;
}
const GHI = OPT.ghi === true;

// ---------- môi trường ----------
function kiemMoiTruong(canMang, ghi) {
  if (GIA && !/^http:\/\/127\.0\.0\.1:\d{1,5}(\/[A-Za-z0-9_\-\/]*)?$/.test(BASE)) throw new Dung("NW_BASE chỉ được là base thật hoặc http://127.0.0.1:<port> (đang là " + BASE + ")");
  if (GIA) {
    if (!ENV.CK_SO) throw new Dung("Máy chủ giả: phải đặt CK_SO (thư mục sổ riêng cho test)");
    if (samePath(SO, SO_THAT)) throw new Dung("Máy chủ giả: CK_SO không được trỏ vào sổ thật " + SO_THAT);
  } else if (ghi && !samePath(SO, SO_THAT)) {
    throw new Dung("Ghi lên NW thật thì sổ phải là " + SO_THAT + " (đang là " + SO + ")");
  }
  if (canMang && !ENV.NW_KEY) throw new Dung("Thiếu env NW_KEY");
}

function scrub(s) {
  const k = ENV.NW_KEY;
  if (k && k.length >= 8) s = s.split(k).join("***");
  return s.replace(/Bearer\s+(?!\*\*\*)[^\s"'\\]+/g, "Bearer ***");
}
const docJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
function ghiMoi(f, obj) { // không bao giờ ghi đè (flag wx)
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, scrub(JSON.stringify(obj, null, 1)) + "\n", { flag: "wx" });
}
function ghiDe(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const t = f + ".tmp-" + process.pid;
  fs.writeFileSync(t, scrub(JSON.stringify(obj, null, 1)) + "\n");
  fs.renameSync(t, f);
}

// ---------- HTTP ----------
async function goi(method, p, body, idem) {
  const headers = { accept: "application/json", authorization: "Bearer " + (ENV.NW_KEY || "") };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (idem) headers["idempotency-key"] = idem;
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT) });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { status: r.status, json, text, hdr: { replay: r.headers.get("idempotent-replay"), requestId: r.headers.get("x-request-id") }, ms: Date.now() - t0 };
  } catch (e) {
    const n = e && e.name;
    return { transport: n === "TimeoutError" || n === "AbortError" ? "timeout" : "network", loi: String((e && e.message) || e), ms: Date.now() - t0 };
  }
}

// Đọc (GET, hoặc POST chỉ-đọc /tags/search): thử lại có giãn cách khi 429 / 408 / 5xx / mạng / body hỏng.
async function doc(p, body) {
  let last = null;
  for (let a = 0; a < 6; a++) {
    if (PACE) await sleep(PACE);
    if (body === undefined) NET.get++; else NET.docPost++;
    const r = await goi(body === undefined ? "GET" : "POST", p, body);
    last = r;
    if (r.status === 401 || r.status === 403) throw new Dung(`Khoá bị ${r.status} ở ${p.split("?")[0]}: dừng`, 2);
    const thuLai = r.transport || r.status >= 500 || r.status === 429 || r.status === 408 || (r.status >= 200 && r.status < 300 && r.json === null);
    if (!thuLai) return r;
    await sleep(BACKOFF * (a + 1));
  }
  throw new Dung(`Không đọc được ${p.split("?")[0]} sau 6 lần (${last && (last.transport || last.status)})`, 1);
}

// Ghi: ĐÚNG MỘT POST, payload vào sổ trước, record ngay sau. Không tự gửi lại.
function phanLoai(r) {
  if (r.transport) return "khong-ro";
  if (r.status >= 500) return "khong-ro";
  if ([408, 409, 425, 429].includes(r.status)) return "khong-ro";
  if (r.status >= 400) return "tu-choi";
  if (r.status >= 200 && r.status < 300 && r.json && typeof r.json === "object" && r.json.id) return "thanh-cong";
  return "khong-ro";
}
async function ghi(st, lot, buoc, p, body, idem, ghiChu) {
  const truoc = (st.buoc[buoc] && st.buoc[buoc].lan) || [];
  const n = truoc.length + 1;
  const ten = `${PREFIX}-${lot.lo}-${buoc}${n > 1 ? "-lan" + n : ""}`;
  const fP = path.join(SO, ten + ".payload.json");
  const fR = path.join(SO, ten + ".record.json");
  for (const f of [fP, fR]) if (fs.existsSync(f)) throw new Dung(`File sổ đã tồn tại: ${f}. Không ghi đè, KHÔNG gửi.`, 1);
  const req = { method: "POST", url: BASE + p, headers: { authorization: "Bearer ***", "idempotency-key": idem }, body: body === undefined ? null : body };
  if (body !== undefined) req.headers["content-type"] = "application/json";
  const keHoach = { lo: lot.lo, soDong: lot.soDong, soEpc: lot.soEpc, tongSL: lot.tongSL };
  ghiMoi(fP, { loai: "payload: nội dung định gửi, ghi TRƯỚC khi POST", at: iso(), lo: lot.lo, buoc, lan: n, ghiChu, keHoach, transferId: st.transferId || null, request: req });
  st.buoc[buoc] = Object.assign({}, st.buoc[buoc] || {}, { trangThai: "dang-gui", lan: truoc.concat([{ n, at: iso(), payload: path.basename(fP) }]) });
  luuState(st);
  console.log(`>>> POST ${p} (lô ${lot.lo}, bước ${buoc}, lần ${n}); sổ: ${path.basename(fP)}`);
  NET.ghiPost++;
  const r = await goi("POST", p, body, idem);
  const ketQua = phanLoai(r);
  ghiMoi(fR, {
    loai: "record: kết quả POST, ghi ngay SAU khi nhận", at: iso(), lo: lot.lo, buoc, lan: n, ketQua, request: req,
    response: r.transport ? null : { status: r.status, idempotentReplay: r.hdr.replay, requestId: r.hdr.requestId, body: r.json !== null ? r.json : (r.text || "").slice(0, 4000) },
    transport: r.transport || null, loiMang: r.loi || null, ms: r.ms,
  });
  const lan = st.buoc[buoc].lan[n - 1];
  Object.assign(lan, { record: path.basename(fR), http: r.status || r.transport, ketQua, replay: r.hdr ? r.hdr.replay : null });
  st.buoc[buoc].trangThai = ketQua;
  luuState(st);
  console.log(`<<< ${r.transport ? r.transport.toUpperCase() : "HTTP " + r.status}${r.hdr && r.hdr.replay ? " (Idempotent-Replay: " + r.hdr.replay + ")" : ""} → ${ketQua}; record: ${path.basename(fR)}`);
  return { r, ketQua };
}
function xuLyKetQuaXau(r, ketQua, lot, buoc) {
  if (ketQua === "khong-ro") {
    console.log(`KẾT QUẢ KHÔNG RÕ (${r.transport || "HTTP " + r.status}). KHÔNG gửi lại.`);
    console.log(`  Việc tiếp: node chuyen-kho.js trang-thai (đọc phiếu theo id / dấu "op:${lot.op.tao}" trong notes), hoặc GET /stock-transfers?search=${lot.op.tao}`);
    console.log(`  Chạy lại đúng lệnh này sẽ đọc trạng thái phiếu trước; chỉ POST lại nếu bước chưa qua, dùng lại clientOperationId + Idempotency-Key ${lot.op[buoc]}.`);
    throw new Dung(`Bước ${buoc} lô ${lot.lo}: kết quả không rõ`, 3);
  }
  if (ketQua === "tu-choi") {
    console.log(`NW TỪ CHỐI: HTTP ${r.status}`);
    console.log(scrub(r.text || ""));
    if (/INVALID_STATUS/.test(r.text || "")) console.log("  (STOCK_TRANSFER_INVALID_STATUS: phiếu không ở trạng thái mong đợi; chạy trang-thai)");
    throw new Dung(`Bước ${buoc} lô ${lot.lo}: NW từ chối ${r.status}`, 4);
  }
}

// ---------- kế hoạch ----------
function docDanhSach() {
  if (!fs.existsSync(LIST)) throw new Dung("Không thấy danh sách " + LIST);
  const raw = fs.readFileSync(LIST);
  const a = JSON.parse(raw.toString("utf8"));
  if (!Array.isArray(a)) throw new Dung("Danh sách không phải mảng");
  const loi = [];
  const seen = new Set();
  const the = a.map((x, i) => {
    const epc = U(x.epc);
    const sl = Number(x.slLedger);
    if (!/^[0-9A-F]{8,64}$/.test(epc)) loi.push(`#${i} EPC lạ "${x.epc}"`);
    if (seen.has(epc)) loi.push(`#${i} EPC trùng ${epc}`);
    seen.add(epc);
    if (!/^[0-9a-f-]{36}$/i.test(String(x.productId || ""))) loi.push(`#${i} productId lạ`);
    if (!Number.isFinite(sl) || !(sl > 0)) loi.push(`#${i} slLedger lạ ${x.slLedger}`);
    if (x.epcLedgerBalance != null && Number(x.epcLedgerBalance) !== sl) loi.push(`#${i} ${epc} epcLedgerBalance ${x.epcLedgerBalance} ≠ slLedger ${sl}`);
    return { epc, productId: L(x.productId), circaProductId: String(x.circaProductId == null ? "" : x.circaProductId), tenSP: x.tenSP || "", sl };
  });
  if (loi.length) throw new Dung("Danh sách lỗi:\n  " + loi.slice(0, 20).join("\n  "));
  return { the, sha256: crypto.createHash("sha256").update(raw).digest("hex") };
}

function soDuEpc(rows) {
  const m = {};
  for (const x of rows) {
    const e = x.epcs || [];
    for (const k of e) { const K = U(k); m[K] = (m[K] || 0) + Number(x.quantity) / e.length; }
  }
  for (const k of Object.keys(m)) m[k] = r6(m[k]);
  return m;
}

function ngoaiDSOffline(the) {
  if (!fs.existsSync(LEDGER)) return { coDuLieu: false, file: LEDGER, dem: {} };
  const j = docJson(LEDGER);
  const rows = Array.isArray(j) ? j : j.rows || [];
  const prods = new Set(the.map((t) => t.productId));
  const ds = new Set(the.map((t) => t.epc));
  const theo = {};
  for (const x of rows) {
    const p = L(x.productId);
    if (!prods.has(p) || L(x.warehouseId) !== LUM) continue;
    (theo[p] = theo[p] || []).push(x);
  }
  const dem = {};
  for (const p of prods) dem[p] = Object.entries(soDuEpc(theo[p] || [])).filter(([e, q]) => q > 1e-9 && !ds.has(e)).length;
  return { coDuLieu: true, file: LEDGER, pulledAt: j.pulledAt || null, soDong: rows.length, dem };
}

const cmpSP = (a, b) => numCirca(a.circaProductId) - numCirca(b.circaProductId) || (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0);
function nhomSP(the) {
  const m = new Map();
  for (const t of the) {
    if (!m.has(t.productId)) m.set(t.productId, { productId: t.productId, circaProductId: t.circaProductId, tenSP: t.tenSP, the: [] });
    const g = m.get(t.productId);
    if (g.circaProductId !== t.circaProductId) throw new Dung(`productId ${t.productId} có 2 mã Circa (${g.circaProductId}, ${t.circaProductId})`);
    g.the.push(t);
  }
  for (const g of m.values()) g.the.sort((a, b) => (a.epc < b.epc ? -1 : a.epc > b.epc ? 1 : 0));
  return m;
}
function dongCua(g) {
  return { productId: g.productId, circaProductId: g.circaProductId, tenSP: g.tenSP, quantity: r6(sum(g.the.map((t) => t.sl))), epcs: g.the.map((t) => t.epc), slTheoEpc: Object.fromEntries(g.the.map((t) => [t.epc, t.sl])) };
}
function taoLo(ten, groups, giuThuTu) {
  const gs = giuThuTu ? groups.slice() : groups.slice().sort(cmpSP);
  const lines = gs.map(dongCua);
  return { lo: ten, soDong: lines.length, soEpc: sum(lines.map((l) => l.epcs.length)), tongSL: r6(sum(lines.map((l) => l.quantity))), lines };
}

function chonThu(sp, ngoai, thuSp) {
  const ds = [...sp.values()];
  const n = (g) => ngoai.dem[g.productId] || 0;
  const ghiChu = [];
  if (thuSp) {
    const tok = String(thuSp).split(",").map((s) => s.trim()).filter(Boolean);
    const pick = tok.map((t) => ds.find((g) => g.circaProductId === t || g.productId === L(t)));
    if (tok.length !== 2 || pick.some((x) => !x) || pick[0] === pick[1]) throw new Dung("--thu-sp cần đúng 2 SP khác nhau có trong danh sách (mã Circa hoặc productId NW), nhận: " + thuSp);
    const all = pick.flatMap((g) => g.the);
    if (!all.some((t) => t.sl === 1) || !all.some((t) => t.sl > 1)) throw new Dung("--thu-sp: lô thử phải có ít nhất 1 thẻ SL 1 và 1 thẻ SL > 1");
    for (const g of pick) ghiChu.push(`${g.circaProductId}: ${g.the.length} thẻ trong DS (SL ${g.the.map((t) => t.sl).join("/")}), Lumina còn ${n(g)} thẻ ngoài DS (sổ kho offline)`);
    if (!(pick[0].the.length === 1 && pick[0].the[0].sl === 1)) ghiChu.push(`KHÁC ĐẶC TẢ: dòng 1 (${pick[0].circaProductId}) không phải SP đúng 1 thẻ SL 1`);
    if (!(pick[1].the.length === 1 && pick[1].the[0].sl > 1)) ghiChu.push(`KHÁC ĐẶC TẢ: dòng 2 (${pick[1].circaProductId}) có ${pick[1].the.length} thẻ, đặc tả cần SP đúng 1 thẻ SL > 1`);
    return { cach: "chi-dinh", sp: pick.map((g) => g.productId), dong1: pick[0].productId, batBuocNgoai: n(pick[0]) > 0, ghiChu };
  }
  let c1 = ds.filter((g) => g.the.length === 1 && g.the[0].sl === 1 && n(g) > 0).sort((a, b) => n(b) - n(a) || cmpSP(a, b));
  let tieuChi1 = "SP đúng 1 thẻ SL 1 trong DS và Lumina còn thẻ active khác ngoài DS (chọn SP nhiều thẻ ngoài DS nhất, hoà thì mã Circa nhỏ)";
  let batBuocNgoai = true;
  if (!c1.length) {
    ghiChu.push("Không SP nào thoả tiêu chí dòng 1 mới (" + (ngoai.coDuLieu ? "không SP 1 thẻ SL 1 nào còn thẻ ngoài DS" : "không có sổ kho offline " + ngoai.file) + "): giữ tiêu chí cũ");
    c1 = ds.filter((g) => g.the.length === 1 && g.the[0].sl === 1).sort(cmpSP);
    tieuChi1 = "SP đúng 1 thẻ SL 1 (tiêu chí cũ, mã Circa nhỏ nhất)";
    batBuocNgoai = false;
  }
  const c2 = ds.filter((g) => g.the.length === 1 && g.the[0].sl > 1).sort((a, b) => a.the[0].sl - b.the[0].sl || n(b) - n(a) || cmpSP(a, b));
  if (!c1.length || !c2.length) {
    const nhieu = ds.filter((g) => g.the.some((t) => t.sl > 1)).sort((a, b) => a.the.length - b.the.length || Math.min(...a.the.map((t) => t.sl)) - Math.min(...b.the.map((t) => t.sl)) || cmpSP(a, b));
    const dong = [];
    if (!c1.length) dong.push("Dòng 1: không có SP nào đúng 1 thẻ SL 1.");
    if (!c2.length) {
      dong.push("Dòng 2: không có SP nào chỉ có ĐÚNG 1 thẻ với SL > 1 trong danh sách. Các SP có thẻ SL > 1:");
      for (const g of nhieu) dong.push(`   ${pad(g.circaProductId, 8)} ${g.the.length} thẻ, SL/thẻ ${g.the.map((t) => t.sl).join("/")}, tổng ${sum(g.the.map((t) => t.sl))}, Lumina còn ${n(g)} thẻ ngoài DS · ${g.tenSP}`);
    }
    if (c1.length) dong.push(`Ứng viên dòng 1 (${tieuChi1}): ` + c1.slice(0, 8).map((g) => `${g.circaProductId}(${n(g)} ngoài DS)`).join(", "));
    dong.push("Đặc tả không thoả được trên dữ liệu này: không tự đổi tiêu chí. PM chọn 2 SP rồi chạy: node chuyen-kho.js plan --thu-sp=<mã Circa dòng 1>,<mã Circa dòng 2>");
    throw new Dung(dong.join("\n"), 1);
  }
  return {
    cach: "mac-dinh", sp: [c1[0].productId, c2[0].productId], dong1: c1[0].productId, batBuocNgoai,
    tieuChi: [tieuChi1, "SP đúng 1 thẻ SL > 1 trong DS, SL/thẻ nhỏ nhất"], ghiChu,
  };
}

function lapKeHoach(the, ngoai, thuSp, maxEpc) {
  const sp = nhomSP(the);
  const thu = chonThu(sp, ngoai, thuSp);
  const lots = [taoLo("thu", thu.sp.map((p) => sp.get(p)), true)];
  const con = [...sp.values()].filter((g) => !thu.sp.includes(g.productId)).sort((a, b) => b.the.length - a.the.length || cmpSP(a, b));
  const bins = [];
  const rieng = [];
  for (const g of con) {
    if (g.the.length > maxEpc) { rieng.push([g]); continue; }
    let b = bins.find((x) => sum(x.map((y) => y.the.length)) + g.the.length <= maxEpc);
    if (!b) { b = []; bins.push(b); }
    b.push(g);
  }
  bins.concat(rieng).forEach((b, i) => lots.push(taoLo("lo-" + String(i + 1).padStart(2, "0"), b, false)));
  kiemTong(lots, the, maxEpc);
  return { thu, lots };
}

// Các cỡ thẻ (slLedger) của một dòng, lớn trước. Dòng có > 1 cỡ = dòng lẫn cỡ (NW chia đều quantity → sai số dư từng thẻ).
const coCuaDong = (x) => [...new Set(x.epcs.map((e) => x.slTheoEpc[e]))].sort((a, b) => b - a);
const dongLanCo = (lot) => lot.lines.filter((x) => coCuaDong(x).length > 1);
const moTaLanCo = (a) => a.map((x) => `CIRCA ${x.circaProductId} (${x.epcs.length} EPC, SL/thẻ ${x.epcs.map((e) => x.slTheoEpc[e]).join("/")}, quantity ${x.quantity})`).join("; ");
const loConLai = (lots) => lots.filter((l) => !l.daTach); // lô chưa bị tách = lô sẽ (đã) lập phiếu

function kiemTong(lotsAll, the, maxEpc) {
  const [eN, eQ] = EXPECT.split(":").map(Number);
  const lots = loConLai(lotsAll);
  const all = lots.flatMap((l) => l.lines.flatMap((x) => x.epcs));
  const set = new Set(all);
  const loi = [];
  if (all.length !== set.size) loi.push(`EPC trùng giữa các dòng/lô (${all.length} vs ${set.size} khác nhau)`);
  if (set.size !== eN) loi.push(`hợp các lô = ${set.size} EPC, cần ${eN}`);
  if (the.some((t) => !set.has(t.epc)) || set.size !== the.length) loi.push("hợp các lô ≠ đúng tập EPC của danh sách");
  const q = r6(sum(lots.map((l) => l.tongSL)));
  if (q !== eQ) loi.push(`tổng số lượng ${q}, cần ${eQ}`);
  const slEpc = Object.fromEntries(the.map((t) => [t.epc, t.sl]));
  const spLo = {};
  for (const l of lots) {
    if (l.soEpc !== sum(l.lines.map((x) => x.epcs.length))) loi.push(`lô ${l.lo} đếm EPC sai`);
    if (l.soDong !== l.lines.length) loi.push(`lô ${l.lo} đếm dòng sai`);
    if (l.tongSL !== r6(sum(l.lines.map((x) => x.quantity)))) loi.push(`lô ${l.lo} tổng SL sai`);
    const trongLo = new Set();
    for (const x of l.lines) {
      if (trongLo.has(x.productId)) loi.push(`lô ${l.lo} có 2 dòng cùng SP ${x.circaProductId}`);
      trongLo.add(x.productId);
      (spLo[x.productId] = spLo[x.productId] || []).push({ l, x });
      if (r6(sum(x.epcs.map((e) => slEpc[e]))) !== x.quantity) loi.push(`lô ${l.lo} SP ${x.circaProductId}: quantity ≠ tổng slLedger`);
      for (const e of x.epcs) if (x.slTheoEpc[e] !== slEpc[e]) loi.push(`lô ${l.lo} SP ${x.circaProductId}: slTheoEpc[${e}] = ${x.slTheoEpc[e]} ≠ slLedger ${slEpc[e]}`);
    }
    if (l.lo !== "thu" && l.soEpc > maxEpc && l.lines.length > 1) loi.push(`lô ${l.lo} có ${l.soEpc} EPC > ${maxEpc}`);
  }
  // Một SP chỉ ở một lô; ngoại lệ duy nhất: các lô con tách từ cùng một lô, mỗi lô một cỡ thẻ khác nhau.
  for (const a of Object.values(spLo)) {
    if (a.length < 2) continue;
    const goc = new Set(a.map((o) => o.l.tachTu || ""));
    const co = a.map((o) => coCuaDong(o.x));
    const hopLe = goc.size === 1 && !goc.has("") && co.every((c) => c.length === 1) && new Set(co.map((c) => c[0])).size === a.length;
    if (!hopLe) loi.push(`SP ${a[0].x.circaProductId} nằm ở ${a.length} lô ${a.map((o) => o.l.lo).join(", ")}`);
  }
  for (const t of the) if (!spLo[t.productId]) loi.push(`SP ${t.circaProductId} không có lô`);
  if (!lotsAll[0] || lotsAll[0].lo !== "thu" || lotsAll[0].daTach || lotsAll[0].lines.length !== 2) loi.push("lô thu phải có đúng 2 dòng");
  // Quan hệ lô gốc (daTach) ↔ lô con (tachTu)
  const ten = new Set();
  for (const l of lotsAll) { if (ten.has(l.lo)) loi.push(`tên lô trùng ${l.lo}`); ten.add(l.lo); }
  for (const l of lotsAll) {
    if (l.daTach) {
      const con = lotsAll.filter((x) => x.tachTu === l.lo);
      const ds = Array.isArray(l.daTach.thanh) ? l.daTach.thanh : [];
      if (!con.length || con.map((x) => x.lo).join(",") !== ds.join(",")) loi.push(`lô ${l.lo} đã tách thành [${ds.join(", ")}] nhưng các lô ghi tachTu=${l.lo} là [${con.map((x) => x.lo).join(", ")}]`);
      const eG = l.lines.flatMap((x) => x.epcs).sort().join(",");
      const eC = con.flatMap((c) => c.lines.flatMap((x) => x.epcs)).sort().join(",");
      if (eG !== eC) loi.push(`các lô con của ${l.lo} không đúng tập EPC của lô gốc`);
      if (r6(sum(con.map((c) => c.tongSL))) !== l.tongSL) loi.push(`các lô con của ${l.lo} tổng SL ≠ ${l.tongSL}`);
    }
    if (l.tachTu) {
      const g = lotsAll.find((x) => x.lo === l.tachTu);
      if (!g || !g.daTach) loi.push(`lô ${l.lo} ghi tách từ ${l.tachTu} nhưng lô đó không đánh dấu đã tách`);
    }
  }
  if (loi.length) throw new Dung("KIỂM TỔNG KẾ HOẠCH SAI:\n  " + loi.join("\n  "), 1);
}

const planFile = () => path.join(DIR, "plan.json");
function docPlan() {
  if (!fs.existsSync(planFile())) throw new Dung("Chưa có " + planFile() + ": chạy `node chuyen-kho.js plan` trước");
  const p = docJson(planFile());
  kiemTong(p.lots, loConLai(p.lots).flatMap((l) => l.lines.flatMap((x) => x.epcs.map((e) => ({ epc: e, sl: x.slTheoEpc[e], productId: x.productId, circaProductId: x.circaProductId })))), p.maxEpc || MAX_EPC);
  return p;
}
function chanLoDaTach(lot, lenh) {
  if (lot.daTach) throw new Dung(`Lô ${lot.lo} ĐÃ TÁCH (${vn(lot.daTach.at)}) thành ${lot.daTach.thanh.join(", ")}: không chạy ${lenh} trên lô gốc. Chạy trên lô con.`, 1);
}
// Thứ tự hiển thị: lô con in ngay sau lô gốc.
function thuTuHienThi(lots) {
  const out = [];
  const them = (l) => { out.push(l); for (const c of lots.filter((x) => x.tachTu === l.lo)) them(c); };
  for (const l of lots) if (!l.tachTu) them(l);
  for (const l of lots) if (!out.includes(l)) out.push(l);
  return out;
}
function layLo(plan, ten) {
  if (!ten) throw new Dung("Thiếu tên lô (thu, lo-01, …)");
  const lot = plan.lots.find((l) => l.lo === ten);
  if (!lot) throw new Dung(`Không có lô "${ten}". Các lô: ${plan.lots.map((l) => l.lo).join(", ")}`);
  return lot;
}
const thanhPhan = (lots) => JSON.stringify(lots.map((l) => ({ lo: l.lo, lines: l.lines.map((x) => [x.productId, x.quantity, x.epcs]) })));

function inBang(plan, ngoai) {
  console.log("\nLô       Số SP  Số EPC  Tổng SL  Ghi chú");
  for (const l of thuTuHienThi(plan.lots)) {
    const g = [];
    if (l.lo === "thu") g.push("lô thử");
    if (l.daTach) g.push(`ĐÃ TÁCH → ${l.daTach.thanh.join(", ")} (không tính vào tổng)`);
    if (l.tachTu) g.push(`tách từ ${l.tachTu}` + (l.lines.length === 1 ? `, CIRCA ${l.lines[0].circaProductId} cỡ ${coCuaDong(l.lines[0]).join("/")}` : ""));
    if (!l.daTach && dongLanCo(l).length) g.push("DÒNG LẪN CỠ: " + moTaLanCo(dongLanCo(l)));
    if (l.lines.length === 1 && l.soEpc > (plan.maxEpc || MAX_EPC)) g.push(`SP ${l.lines[0].circaProductId} có ${l.soEpc} thẻ > ${plan.maxEpc || MAX_EPC}: lô riêng`);
    console.log(`${pad((l.tachTu ? "  " : "") + l.lo, 8)} ${pad(l.soDong, 6)} ${pad(l.soEpc, 7)} ${pad(l.tongSL, 8)} ${g.join("; ")}`);
  }
  const con = loConLai(plan.lots);
  console.log(`Tổng     ${pad(sum(con.map((l) => l.soDong)), 6)} ${pad(sum(con.map((l) => l.soEpc)), 7)} ${pad(r6(sum(con.map((l) => l.tongSL))), 8)}${con.length !== plan.lots.length ? " (các lô chưa tách)" : ""}`);
  const t = plan.lots[0];
  console.log(`\nLô thu (${plan.thuChon.cach === "chi-dinh" ? "PM chỉ định --thu-sp" : "chọn tự động"}):`);
  t.lines.forEach((x, i) => {
    console.log(`  Dòng ${i + 1}: CIRCA ${x.circaProductId} · ${x.tenSP} · quantity ${x.quantity} · ${x.epcs.length} EPC` + (ngoai && ngoai.coDuLieu ? ` · Lumina còn ${ngoai.dem[x.productId] || 0} thẻ ngoài DS (sổ kho offline)` : ""));
    for (const e of x.epcs) console.log(`          ${e}  SL ${x.slTheoEpc[e]}`);
  });
  for (const s of plan.thuChon.tieuChi || []) console.log("  Tiêu chí: " + s);
  for (const s of plan.thuChon.ghiChu || []) console.log("  Ghi chú: " + s);
}

async function cmdPlan() {
  const { the, sha256 } = docDanhSach();
  const ngoai = ngoaiDSOffline(the);
  console.log(`Danh sách: ${LIST}\n  ${the.length} thẻ, ${new Set(the.map((t) => t.productId)).size} SP, tổng SL ${r6(sum(the.map((t) => t.sl)))}, sha256 ${sha256.slice(0, 16)}…`);
  console.log(`Sổ kho offline (thẻ ngoài DS): ${ngoai.coDuLieu ? `${ngoai.file} (kéo ${vn(ngoai.pulledAt)}, ${ngoai.soDong} dòng)` : "KHÔNG CÓ " + ngoai.file}`);
  if (fs.existsSync(planFile())) {
    const cu = docJson(planFile());
    const thuSp = cu.thuChon && cu.thuChon.cach === "chi-dinh" ? cu.thuChon.sp.join(",") : null;
    if (OPT["thu-sp"]) console.log("plan.json đã có: bỏ qua --thu-sp, dùng lựa chọn trong plan.json");
    const moi = lapKeHoach(the, ngoai, thuSp, cu.maxEpc || MAX_EPC);
    inBang(cu, ngoai);
    const khac = [];
    if (cu.nguon && cu.nguon.sha256 !== sha256) khac.push("sha256 danh sách khác lúc lập");
    // So phần lập ban đầu (bỏ lô con), rồi so từng lần tách với cách tách tính lại.
    if (thanhPhan(cu.lots.filter((l) => !l.tachTu)) !== thanhPhan(moi.lots)) khac.push("thành phần lô khác kế hoạch lập lại từ dữ liệu hiện tại");
    const daTach = cu.lots.filter((l) => l.daTach);
    for (const l of daTach) if (thanhPhan(cu.lots.filter((x) => x.tachTu === l.lo)) !== thanhPhan(chiaLo(l))) khac.push(`các lô tách từ ${l.lo} khác cách tách tính lại`);
    docPlan();
    if (khac.length) throw new Dung(`plan.json ĐÃ CÓ nhưng ${khac.join("; ")}. Không ghi đè. Muốn lập lại phải xoá tay ${planFile()}`, 1);
    console.log(`\nplan.json đã có (${planFile()}, lập ${vn(cu.taoLuc)}): kiểm tổng đạt, khớp kế hoạch lập lại` + (daTach.length ? ` và cách tách ${daTach.map((l) => l.lo + " → " + l.daTach.thanh.join("/")).join(", ")}` : "") + ". Không ghi đè.");
    baoLanCo(cu);
    return;
  }
  const kh = lapKeHoach(the, ngoai, OPT["thu-sp"] || null, MAX_EPC);
  const plan = {
    loai: "ke-hoach-chuyen-kho Lumina → Tam Việt", taoLuc: iso(),
    nguon: { list: LIST, sha256, soThe: the.length, tongSL: r6(sum(the.map((t) => t.sl))), soKhoOffline: ngoai.coDuLieu ? { file: ngoai.file, pulledAt: ngoai.pulledAt } : null },
    kho: { nguon: LUM, dich: TV }, maxEpc: MAX_EPC, thuChon: kh.thu,
    lots: kh.lots.map((l) => Object.assign({}, l, { op: { tao: crypto.randomUUID(), gui: crypto.randomUUID(), nhan: crypto.randomUUID(), huy: crypto.randomUUID() } })),
  };
  ghiMoi(planFile(), plan);
  inBang(plan, ngoai);
  console.log(`\nĐã ghi ${planFile()} (kiểm tổng đạt: ${plan.lots.reduce((t, l) => t + l.soEpc, 0)} EPC, không trùng, tổng SL ${r6(sum(plan.lots.map((l) => l.tongSL)))}).`);
  baoLanCo(plan);
}
// ---------- tách lô lẫn cỡ thẻ ----------
const CHU = "abcdefghijklmnopqrstuvwxyz";
// Lô a = mọi dòng một cỡ (giữ nguyên thứ tự, nguyên nội dung); mỗi cỡ của SP lẫn cỡ = một lô riêng (SP theo thứ tự dòng, cỡ lớn trước).
function chiaLo(lot) {
  const don = [];
  const rieng = [];
  for (const x of lot.lines) {
    const co = coCuaDong(x);
    if (co.length === 1) { don.push(x); continue; }
    for (const s of co) {
      const epcs = x.epcs.filter((e) => x.slTheoEpc[e] === s);
      rieng.push([{ productId: x.productId, circaProductId: x.circaProductId, tenSP: x.tenSP, quantity: r6(sum(epcs.map((e) => x.slTheoEpc[e]))), epcs, slTheoEpc: Object.fromEntries(epcs.map((e) => [e, s])) }]);
    }
  }
  const phan = (don.length ? [don] : []).concat(rieng);
  if (phan.length > CHU.length) throw new Dung(`Lô ${lot.lo} tách ra ${phan.length} lô > ${CHU.length}`, 1);
  return phan.map((lines, i) => {
    const ls = lines.map((x) => JSON.parse(JSON.stringify(x)));
    return { lo: lot.lo + CHU[i], soDong: ls.length, soEpc: sum(ls.map((x) => x.epcs.length)), tongSL: r6(sum(ls.map((x) => x.quantity))), lines: ls };
  });
}

// Offline: phiếu của lô đã CANCELLED (có bằng chứng) hoặc chắc chắn chưa từng tạo. Không thì Dung.
function phieuChoTach(lot) {
  const f = stateFile(lot.lo);
  if (!fs.existsSync(f)) return { trangThai: "chua-tao", transferId: null, transferNumber: null, moTa: "chưa từng tạo phiếu (không có state)" };
  const st = docJson(f);
  const b = (k) => ttBuoc(st, k);
  const tom = `state: tạo ${b("tao")}, gửi ${b("gui")}, nhận ${b("nhan")}, huỷ ${b("huy")}`;
  const lanTao = (st.buoc && st.buoc.tao && st.buoc.tao.lan) || [];
  if (!st.transferId) {
    if (b("tao") === "chua" && !lanTao.length) return { trangThai: "chua-tao", transferId: null, transferNumber: null, moTa: `chưa từng tạo phiếu (${tom})` };
    if (b("tao") === "tu-choi" && lanTao.length && lanTao.every((x) => x.ketQua === "tu-choi")) {
      return { trangThai: "chua-tao", transferId: null, transferNumber: null, moTa: `NW từ chối mọi lần tạo (HTTP ${lanTao.map((x) => x.http).join(", ")}), không có phiếu (${tom})` };
    }
    throw new Dung(`Lô ${lot.lo}: bước tạo "${b("tao")}" mà state chưa có id phiếu: không chắc phiếu chưa được tạo (${tom}). Chạy trang-thai; không tách.`, 1);
  }
  const so = `${st.transferNumber || ""} (${st.transferId})`;
  if (b("nhan") === "thanh-cong") throw new Dung(`Lô ${lot.lo}: phiếu ${so} đã nhận (complete): không tách`, 1);
  if (b("huy") !== "thanh-cong") throw new Dung(`Lô ${lot.lo}: phiếu ${so} chưa huỷ (${tom}). Chỉ tách khi phiếu đã CANCELLED: huỷ trước bằng huy ${lot.lo} --ghi --ly-do "…"`, 1);
  const bang = [];
  if (st.sauHuy && st.sauHuy.status) {
    if (U(st.sauHuy.status) !== "CANCELLED") throw new Dung(`Lô ${lot.lo}: state.sauHuy ghi phiếu ${st.sauHuy.status}, không phải CANCELLED: không tách`, 1);
    bang.push(`state.sauHuy CANCELLED lúc ${vn(st.sauHuy.at)}`);
  }
  const lanHuy = ((st.buoc.huy && st.buoc.huy.lan) || []).filter((x) => x.record);
  const cuoi = lanHuy[lanHuy.length - 1];
  if (cuoi && fs.existsSync(path.join(SO, cuoi.record))) {
    const rec = docJson(path.join(SO, cuoi.record));
    const body = rec.response && rec.response.body && typeof rec.response.body === "object" ? rec.response.body : null;
    if (body && body.id && L(body.id) !== L(st.transferId)) throw new Dung(`Record huỷ ${cuoi.record} là của phiếu ${body.id}, state ghi ${st.transferId}: không tách`, 1);
    if (body && body.status) {
      if (U(body.status) !== "CANCELLED") throw new Dung(`Record huỷ ${cuoi.record} ghi status ${body.status}, không phải CANCELLED: không tách`, 1);
      bang.push(`record ${cuoi.record}: HTTP ${rec.response.status}, status ${body.status}`);
    }
  }
  if (!bang.length) throw new Dung(`Lô ${lot.lo}: state ghi huỷ thành công nhưng không có bằng chứng offline phiếu ${so} đã CANCELLED (không có state.sauHuy, record huỷ không có status trong ${SO}). Chạy trang-thai để xác nhận; không tách.`, 1);
  return { trangThai: "CANCELLED", transferId: st.transferId, transferNumber: st.transferNumber || null, moTa: `phiếu ${so} đã CANCELLED (${bang.join("; ")})` };
}

async function cmdTach(ten) {
  if (!/^lo-\d{2}$/.test(String(ten || ""))) throw new Dung(`tach chỉ nhận lô gốc dạng lo-NN (nhận "${ten || ""}"); lô thử và lô con không tách`, 1);
  const f = planFile();
  if (!fs.existsSync(f)) throw new Dung("Chưa có " + f, 1);
  const raw = fs.readFileSync(f, "utf8");
  const plan = docPlan();
  if (JSON.stringify(plan, null, 1) + "\n" !== raw) throw new Dung("plan.json không ở dạng JSON.stringify(…, null, 1) + \\n: không bảo đảm giữ nguyên byte các lô khác, không tách", 1);
  const lot = layLo(plan, ten);
  inLo(lot, "TÁCH LÔ (offline, không gọi mạng)");
  if (lot.daTach) throw new Dung(`Lô ${lot.lo} đã tách (${vn(lot.daTach.at)}) thành ${lot.daTach.thanh.join(", ")}: không tách lại`, 1);
  const lan = dongLanCo(lot);
  if (!lan.length) throw new Dung(`Lô ${lot.lo} không có dòng lẫn cỡ thẻ: không cần tách`, 1);
  console.log("Dòng lẫn cỡ: " + moTaLanCo(lan));
  const phieu = phieuChoTach(lot);
  console.log("Phiếu của lô: " + phieu.moTa);
  const { the, sha256 } = docDanhSach();
  if (plan.nguon && plan.nguon.sha256 && plan.nguon.sha256 !== sha256) throw new Dung(`sha256 danh sách ${LIST} khác lúc lập plan: không tách`, 1);
  const con = chiaLo(lot).map((c) => Object.assign(c, { op: { tao: crypto.randomUUID(), gui: crypto.randomUUID(), nhan: crypto.randomUUID(), huy: crypto.randomUUID() }, tachTu: lot.lo }));
  for (const c of con) if (plan.lots.some((l) => l.lo === c.lo)) throw new Dung(`Tên lô ${c.lo} đã có trong plan: không tách`, 1);
  const daTach = {
    at: iso(), thanh: con.map((c) => c.lo), lyDo: "dòng lẫn cỡ thẻ: NW chia đều quantity cho các EPC của dòng → mỗi dòng phiếu chỉ chứa EPC cùng slLedger",
    dongLanCo: lan.map((x) => ({ productId: x.productId, circaProductId: x.circaProductId, co: coCuaDong(x), slTheoEpc: x.epcs.map((e) => x.slTheoEpc[e]) })), phieu,
  };
  const moi = Object.assign({}, plan, { lots: plan.lots.map((l) => (l === lot ? Object.assign({}, l, { daTach }) : l)).concat(con) });

  // Kiểm trước khi ghi: sai thì không ghi gì.
  kiemTong(moi.lots, the, moi.maxEpc || MAX_EPC);
  const loi = [];
  for (const c of con) {
    if (!/^lo-\d{2}[a-z]$/.test(c.lo)) loi.push(`tên lô con lạ ${c.lo}`);
    if (dongLanCo(c).length) loi.push(`lô ${c.lo} vẫn có dòng lẫn cỡ`);
    if (c.lines.length > 1 && c.lines.some((x) => lan.some((y) => y.productId === x.productId))) loi.push(`lô ${c.lo} lẫn SP tách cỡ với SP khác`);
  }
  const ops = moi.lots.flatMap((l) => Object.values(l.op || {}));
  if (new Set(ops).size !== ops.length) loi.push("UUID bước trùng trong plan");
  for (const l of plan.lots) {
    if (l === lot) continue;
    const s = moi.lots.find((x) => x.lo === l.lo);
    if (!s || JSON.stringify(s, null, 1) !== JSON.stringify(l, null, 1)) loi.push(`lô ${l.lo} bị đổi`);
  }
  for (const k of Object.keys(plan)) if (k !== "lots" && JSON.stringify(plan[k]) !== JSON.stringify(moi[k])) loi.push(`trường ${k} của plan bị đổi`);
  // So byte: bỏ daTach của lô gốc và các lô con khỏi plan mới → phải ra đúng plan.json cũ.
  const boTach = Object.assign({}, moi, { lots: moi.lots.filter((l) => !con.includes(l)).map((l) => { if (l.lo !== lot.lo) return l; const r = Object.assign({}, l); delete r.daTach; return r; }) });
  if (JSON.stringify(boTach, null, 1) + "\n" !== raw) loi.push("plan mới bỏ phần tách không trùng byte plan cũ");
  if (loi.length) throw new Dung("KIỂM SAU TÁCH SAI (không ghi gì):\n  " + loi.join("\n  "), 1);

  const bk = path.join(DIR, `plan.truoc-tach-${lot.lo}.json`);
  if (fs.existsSync(bk)) {
    if (fs.readFileSync(bk, "utf8") !== raw) throw new Dung(`${bk} đã có và khác plan.json hiện tại: không ghi đè, không tách. PM kiểm tay.`, 1);
    console.log(`Bản cũ ${bk} đã có, trùng plan.json hiện tại: giữ nguyên`);
  } else {
    fs.writeFileSync(bk, raw, { flag: "wx" });
    console.log(`Đã chép plan cũ → ${bk}`);
  }
  const text = JSON.stringify(moi, null, 1) + "\n";
  const tmp = f + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, f);
  if (fs.readFileSync(f, "utf8") !== text) throw new Dung("Đọc lại plan.json không trùng nội dung vừa ghi: khôi phục tay từ " + bk, 1);
  const p2 = docPlan();
  inBang(p2, null);
  console.log(`\nĐã tách ${lot.lo} → ${con.map((c) => `${c.lo} (${c.soDong} SP, ${c.soEpc} EPC, SL ${c.tongSL})`).join(", ")}.`);
  const cl = loConLai(p2.lots);
  console.log(`Kiểm tổng các lô chưa tách: ${sum(cl.map((l) => l.soEpc))} EPC, không trùng, tổng SL ${r6(sum(cl.map((l) => l.tongSL)))}. Các lô khác giữ nguyên byte. Lô ${lot.lo} đánh dấu đã tách.`);
  console.log(`Bước tiếp: node chuyen-kho.js kiem ${con[0].lo}. Lô con cùng SP chạy tuần tự (tao → gui → nhan → soat xong lô này rồi mới gui lô kia).`);
}

// Lô chưa tách mà có dòng lẫn cỡ: `tao` sẽ từ chối → báo KHÔNG ĐẠT, chỉ cách tách.
function baoLanCo(plan) {
  const hong = loConLai(plan.lots).map((l) => [l, dongLanCo(l)]).filter(([, a]) => a.length);
  if (!hong.length) return;
  for (const [l, a] of hong) console.log(`KHÔNG ĐẠT: lô ${l.lo} có dòng lẫn cỡ thẻ: ${moTaLanCo(a)}. NW chia đều quantity cho các EPC của dòng → số dư từng thẻ sai; tao sẽ từ chối. Chạy: node chuyen-kho.js tach ${l.lo}`);
  throw new Dung(`Kế hoạch có ${hong.length} lô lẫn cỡ thẻ (${hong.map(([l]) => l.lo).join(", ")}): dùng tach trước khi tao`, 1);
}

// ---------- state ----------
const stateFile = (lo) => path.join(DIR, lo + ".state.json");
function docState(lo) {
  const f = stateFile(lo);
  if (fs.existsSync(f)) return docJson(f);
  return { lo, taoLuc: iso(), transferId: null, transferNumber: null, buoc: {}, snap: {} };
}
function luuState(st) { st.capNhat = iso(); ghiDe(stateFile(st.lo), st); }
const ttBuoc = (st, b) => (st.buoc && st.buoc[b] && st.buoc[b].trangThai) || "chua";
function inLo(lot, viec) {
  console.log(`== ${viec} · lô ${lot.lo} · ${lot.soDong} dòng · ${lot.soEpc} EPC · tổng SL ${lot.tongSL} · ${TEN[LUM]} → ${TEN[TV]}`);
}
function inKho(lenh, body, idem) {
  console.log("CHẠY KHÔ (không có --ghi): KHÔNG gửi gì lên NW.");
  console.log("Sẽ gửi: " + lenh);
  console.log(`Header: authorization: Bearer *** · idempotency-key: ${idem}` + (body !== undefined ? " · content-type: application/json" : ""));
  console.log("Body: " + (body === undefined ? "(không body)" : JSON.stringify(body, null, 1)));
}

// ---------- đọc NW ----------
async function timThe(epcs) {
  const m = {};
  for (let i = 0; i < epcs.length; i += 500) {
    const r = await doc("/tags/search", { epcs: epcs.slice(i, i + 500), pageSize: 1000 });
    if (!(r.status >= 200 && r.status < 300) || !r.json) throw new Dung(`tags/search lỗi ${r.status}: ${(r.text || "").slice(0, 200)}`);
    for (const t of Array.isArray(r.json) ? r.json : r.json.data || []) m[U(t.epc)] = t;
  }
  return m;
}
async function checkThe(epc, wh) {
  const r = await doc(`/tags/${encodeURIComponent(epc)}/check?warehouseId=${wh}`);
  if (r.status === 404) return { coThe: false, soDu: null };
  if (r.status !== 200 || !r.json) throw new Dung(`check ${epc} lỗi ${r.status}`);
  const j = r.json;
  if (j.warehouse && j.warehouse.id && L(j.warehouse.id) !== wh) throw new Dung(`check ${epc}: NW trả kho ${j.warehouse.id} khác kho hỏi ${wh} (bỏ qua warehouseId?)`);
  return { coThe: true, soDu: j.epcLedgerBalance == null ? null : r6(j.epcLedgerBalance), tagStatus: j.tagStatus };
}
async function tonSP(pid, wh) {
  const r = await doc(`/stock/summary?productId=${pid}&warehouseId=${wh}`);
  if (r.status === 404) return { systemStock: 0, rfidStock: 0, untaggedStock: 0, khongCo: true };
  if (r.status !== 200 || !r.json) throw new Dung(`stock/summary ${pid} @${tenKho(wh)} lỗi ${r.status}`);
  return { systemStock: r6(r.json.systemStock || 0), rfidStock: r6(r.json.rfidStock || 0), untaggedStock: r6(r.json.untaggedStock || 0) };
}
async function soKho(pid, wh, after0) {
  const rows = [];
  let after = after0 || 0;
  for (let g = 0; g < 500; g++) {
    const r = await doc(`/stock/ledger?productId=${pid}&warehouseId=${wh}&limit=1000&afterLedgerNumber=${after}`);
    if (r.status !== 200 || !r.json) throw new Dung(`stock/ledger ${pid} @${tenKho(wh)} lỗi ${r.status}`);
    const a = Array.isArray(r.json) ? r.json : r.json.data || [];
    if (!a.length) break;
    for (const x of a) if (L(x.productId) === pid && L(x.warehouseId) === wh) rows.push(x);
    const nxt = Math.max(Number(r.json.nextAfter) || 0, ...a.map((x) => Number(x.ledgerNumber) || 0));
    if (!(nxt > after)) break;
    after = nxt;
  }
  return { rows, conTro: after };
}
async function dsPhieu() {
  const out = [];
  const seen = new Set();
  let cursor = null;
  for (let g = 0; g < 50; g++) {
    const r = await doc(`/stock-transfers?updatedSince=${encodeURIComponent(SINCE)}&limit=500` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""));
    if (r.status !== 200 || !r.json) throw new Dung("Đọc danh sách phiếu chuyển lỗi " + r.status);
    const data = Array.isArray(r.json) ? r.json : r.json.data || r.json.items || [];
    let moi = 0;
    for (const t of data) if (!seen.has(t.id)) { seen.add(t.id); out.push(t); moi++; }
    cursor = Array.isArray(r.json) ? null : r.json.nextCursor;
    if (!cursor || !moi) break;
  }
  for (let i = 0; i < out.length; i++) {
    if (!Array.isArray(out[i].items) || out[i].items.some((it) => !Array.isArray(it.epcs))) {
      const d = await doc(`/stock-transfers/${out[i].id}`);
      if (d.status === 200 && d.json) out[i] = d.json;
    }
  }
  return out;
}
async function docPhieu(id) {
  const d = await doc(`/stock-transfers/${id}`);
  if (d.status !== 200 || !d.json) throw new Dung(`GET /stock-transfers/${id} lỗi ${d.status}: ${(d.text || "").slice(0, 200)}`);
  return d.json;
}

// ---------- kiểm ----------
const epcCuaLo = (lot) => lot.lines.flatMap((l) => l.epcs);
const dongTheoEpc = (lot) => Object.fromEntries(lot.lines.flatMap((l) => l.epcs.map((e) => [e, l])));

async function kiemTheTruoc(lot) {
  const epcs = epcCuaLo(lot);
  const dmap = dongTheoEpc(lot);
  const tags = await timThe(epcs);
  const kq = [];
  for (const e of epcs) {
    const l = dmap[e];
    const sl = l.slTheoEpc[e];
    const t = tags[e];
    const loi = [];
    if (!t) loi.push("không thấy thẻ (tags/search)");
    else {
      if (L(t.status) !== "active") loi.push("trạng thái " + t.status);
      if (L(t.homeWarehouseId) !== LUM) loi.push("kho hiện tại " + tenKho(t.homeWarehouseId));
      if (L(t.productId) !== l.productId) loi.push("thẻ thuộc SP khác " + t.productId);
    }
    const c = await checkThe(e, LUM);
    if (!c.coThe) loi.push("check 404");
    else if (c.soDu !== sl) loi.push(`số dư tại Lumina ${c.soDu} ≠ slLedger ${sl}`);
    kq.push({ epc: e, circa: l.circaProductId, sl, status: t ? t.status : null, kho: t ? tenKho(t.homeWarehouseId) : null, soDuLum: c.soDu, loi });
    if (kq.length % 50 === 0) console.log(`   … ${kq.length}/${epcs.length} thẻ`);
  }
  return { dat: kq.every((x) => !x.loi.length), the: kq };
}

async function kiemPhieu(lot, st) {
  const ds = new Set(epcCuaLo(lot));
  const dau = lot.op.tao;
  const all = await dsPhieu();
  const lienQuan = [];
  for (const t of all) {
    const ep = (t.items || []).flatMap((it) => (Array.isArray(it.epcs) ? it.epcs : []).map(U));
    const chung = ep.filter((e) => ds.has(e));
    const coDau = String(t.notes || "").includes(dau);
    if (chung.length || coDau) {
      lienQuan.push({ id: t.id, transferNumber: t.transferNumber, status: t.status, nguon: tenKho(t.sourceWarehouseId), dich: tenKho(t.destinationWarehouseId), notes: t.notes, soEpcChung: chung.length, coDau, cuaLo: !!(st && st.transferId === t.id) });
    }
  }
  return { tongPhieu: all.length, lienQuan, vuong: lienQuan.filter((x) => U(x.status) !== "CANCELLED" && !x.cuaLo) };
}

async function chupSoDu(plan, lot) {
  const dsAll = new Set(plan.lots.flatMap((l) => l.lines.flatMap((x) => x.epcs)));
  const sp = {};
  for (const ln of lot.lines) {
    const lum = await tonSP(ln.productId, LUM);
    const tv = await tonSP(ln.productId, TV);
    const gL = await soKho(ln.productId, LUM, 0);
    const gT = await soKho(ln.productId, TV, 0);
    const bL = soDuEpc(gL.rows);
    const ngoaiDS = {};
    for (const [e, q] of Object.entries(bL)) if (q > 1e-9 && !dsAll.has(e)) ngoaiDS[e] = { soDu: q };
    sp[ln.productId] = {
      circa: ln.circaProductId, tenSP: ln.tenSP, quantity: ln.quantity, lum, tv,
      conTro: { lum: gL.conTro, tv: gT.conTro }, soDongSoKho: { lum: gL.rows.length, tv: gT.rows.length },
      soDuSoKhoDS: Object.fromEntries(ln.epcs.map((e) => [e, bL[e] || 0])),
      tongSoDuTheSoKho: r6(sum(Object.values(bL).filter((q) => q > 1e-9))), ngoaiDS,
    };
  }
  const ngoaiAll = Object.values(sp).flatMap((s) => Object.keys(s.ngoaiDS));
  const tags = ngoaiAll.length ? await timThe(ngoaiAll) : {};
  for (const s of Object.values(sp)) {
    for (const [e, o] of Object.entries(s.ngoaiDS)) { const t = tags[e]; o.status = t ? L(t.status) : null; o.kho = t ? L(t.homeWarehouseId) : null; }
    s.soNgoaiActive = Object.values(s.ngoaiDS).filter((o) => o.status === "active" && o.kho === LUM).length;
  }
  return { at: iso(), sp };
}

async function kiemDayDu(plan, lot, st) {
  console.log("1/3 Thẻ của lô: tags/search + check @Lumina");
  const the = await kiemTheTruoc(lot);
  console.log(`2/3 Phiếu chuyển đã có trên NW (cập nhật từ ${vn(SINCE)})`);
  const phieu = await kiemPhieu(lot, st);
  console.log("3/3 Số dư theo SP trước khi chuyển (Lumina, Tam Việt, thẻ Lumina ngoài danh sách)");
  const snap = await chupSoDu(plan, lot);
  const loiThu = [];
  if (lot.lo === "thu" && plan.thuChon && plan.thuChon.batBuocNgoai) {
    const s = snap.sp[plan.thuChon.dong1];
    if (!s || !s.soNgoaiActive) loiThu.push(`Dòng 1 lô thử (CIRCA ${s ? s.circa : plan.thuChon.dong1}) không còn thẻ active nào của Lumina ngoài DS: phép thử "không đụng thẻ khác" mất ý nghĩa`);
  }
  return { dat: the.dat && !phieu.vuong.length && !loiThu.length, the, phieu, snap, loiThu };
}

function inKetQuaKiem(r) {
  const hong = r.the.the.filter((x) => x.loi.length);
  console.log(`\nThẻ: đạt ${r.the.the.length - hong.length}/${r.the.the.length}`);
  for (const x of hong) console.log(`  KHÔNG ĐẠT ${x.epc} CIRCA ${x.circa} SL ${x.sl}: ${x.loi.join("; ")}`);
  console.log(`Phiếu chuyển: đọc ${r.phieu.tongPhieu} phiếu cập nhật từ ${vn(SINCE)}; liên quan lô: ${r.phieu.lienQuan.length}`);
  for (const x of r.phieu.lienQuan) {
    console.log(`  ${x.cuaLo ? "PHIẾU CỦA LÔ" : U(x.status) === "CANCELLED" ? "đã huỷ" : "VƯỚNG"} ${x.transferNumber} ${x.id} ${x.status} ${x.nguon}→${x.dich} · ${x.soEpcChung} EPC chung${x.coDau ? " · mang dấu op của lô" : ""}`);
  }
  console.log("Số dư theo SP (trước):");
  console.log("  CIRCA     SL dòng  Lumina sys/rfid   Σ thẻ sổ kho  TamViet sys  Thẻ ngoài DS (active/tổng)");
  for (const s of Object.values(r.snap.sp)) {
    const lech = Math.abs(s.tongSoDuTheSoKho - s.lum.rfidStock) > 1e-6 ? `  ! Σ thẻ sổ kho ${s.tongSoDuTheSoKho} ≠ rfidStock ${s.lum.rfidStock}` : "";
    console.log(`  ${pad(s.circa, 9)} ${pad(s.quantity, 8)} ${pad(s.lum.systemStock + "/" + s.lum.rfidStock, 17)} ${pad(s.tongSoDuTheSoKho, 13)} ${pad(s.tv.systemStock, 12)} ${s.soNgoaiActive}/${Object.keys(s.ngoaiDS).length}${lech}`);
  }
  for (const x of r.loiThu) console.log("  KHÔNG ĐẠT: " + x);
}

async function cmdKiem(ten) {
  const plan = docPlan();
  const lot = layLo(plan, ten);
  inLo(lot, "KIỂM (chỉ đọc)");
  kiemMoiTruong(true, false);
  const st = docState(lot.lo);
  const r = await kiemDayDu(plan, lot, st);
  st.snap.kiem = r.snap;
  st.kiem = { at: iso(), dat: r.dat, theKhongDat: r.the.the.filter((x) => x.loi.length), phieuLienQuan: r.phieu.lienQuan, loiThu: r.loiThu };
  luuState(st);
  inKetQuaKiem(r);
  if (!r.dat) throw new Dung(`KIỂM KHÔNG ĐẠT lô ${lot.lo}`, 1);
  console.log(`\nKIỂM ĐẠT lô ${lot.lo}: ${lot.soEpc}/${lot.soEpc} thẻ active @Lumina đúng số dư, không phiếu chuyển nào đang giữ EPC của lô.`);
}

// ---------- so phiếu với kế hoạch ----------
function soPhieu(t, lot, trangThai) {
  const loi = [];
  const canhBao = [];
  const itemIds = {};
  if (trangThai && !trangThai.includes(U(t.status))) loi.push(`trạng thái ${t.status}, cần ${trangThai.join("/")}`);
  if (L(t.sourceWarehouseId) !== LUM) loi.push("kho nguồn " + tenKho(t.sourceWarehouseId));
  if (L(t.destinationWarehouseId) !== TV) loi.push("kho đích " + tenKho(t.destinationWarehouseId));
  if (!Array.isArray(t.items)) { loi.push("phiếu không có items"); return { dat: false, loi, canhBao, itemIds }; }
  const byP = {};
  for (const it of t.items) (byP[L(it.productId)] = byP[L(it.productId)] || []).push(it);
  for (const p of Object.keys(byP)) if (!lot.lines.some((l) => l.productId === p)) loi.push("dòng lạ trên phiếu: productId " + p);
  const nhan = trangThai && trangThai.includes("COMPLETED");
  for (const ln of lot.lines) {
    const c = "CIRCA " + ln.circaProductId;
    const its = byP[ln.productId] || [];
    if (its.length !== 1) { loi.push(`${c}: ${its.length} dòng trên phiếu (cần 1)`); continue; }
    const it = its[0];
    itemIds[ln.productId] = it.id;
    if (r6(it.quantity) !== ln.quantity) loi.push(`${c}: quantity ${it.quantity} ≠ ${ln.quantity}`);
    const ep = (Array.isArray(it.epcs) ? it.epcs : []).map(U);
    const a = new Set(ep);
    const b = new Set(ln.epcs);
    if (ep.length !== a.size) loi.push(`${c}: epcs trùng trên phiếu`);
    const thieu = ln.epcs.filter((e) => !a.has(e));
    const la = ep.filter((e) => !b.has(e));
    if (thieu.length) loi.push(`${c}: phiếu thiếu ${thieu.length} EPC: ${cat(thieu, 5)}`);
    if (la.length) loi.push(`${c}: phiếu có ${la.length} EPC ngoài kế hoạch: ${cat(la, 5)}`);
    if (it.epcAmounts && typeof it.epcAmounts === "object") {
      const am = Object.fromEntries(Object.entries(it.epcAmounts).map(([k, v]) => [U(k), r6(v)]));
      for (const e of ln.epcs) if (am[e] !== ln.slTheoEpc[e]) loi.push(`${c}: epcAmounts[${e}] = ${am[e]} ≠ slLedger ${ln.slTheoEpc[e]}`);
      for (const k of Object.keys(am)) if (!b.has(k)) loi.push(`${c}: epcAmounts có EPC ngoài kế hoạch ${k}`);
    } else {
      const u = [...new Set(Object.values(ln.slTheoEpc))];
      canhBao.push(`${c}: phiếu không trả epcAmounts` + (u.length > 1 ? `; dòng có SL/thẻ khác nhau (${u.join("/")}): CHƯA kiểm được SL từng EPC` : ""));
    }
    if (nhan) {
      if (r6(it.receivedQuantity) !== ln.quantity) loi.push(`${c}: receivedQuantity ${it.receivedQuantity} ≠ ${ln.quantity}`);
      if (Array.isArray(it.receivedEpcs)) {
        const rs = new Set(it.receivedEpcs.map(U));
        if (rs.size !== b.size || ln.epcs.some((e) => !rs.has(e))) loi.push(`${c}: receivedEpcs (${rs.size}) ≠ epcs của dòng (${b.size})`);
      } else canhBao.push(`${c}: phiếu không trả receivedEpcs`);
    }
  }
  return { dat: !loi.length, loi, canhBao, itemIds };
}
function inSoPhieu(v, t) {
  console.log(`Phiếu ${t.transferNumber} (${t.id}) · ${t.status} · ${tenKho(t.sourceWarehouseId)} → ${tenKho(t.destinationWarehouseId)} · ${(t.items || []).length} dòng`);
  for (const x of v.loi) console.log("  LỆCH: " + x);
  for (const x of v.canhBao) console.log("  Cảnh báo: " + x);
}

// ---------- tạo ----------
function bodyTao(lot) {
  return {
    sourceWarehouseId: LUM, destinationWarehouseId: TV,
    notes: `Chuyển thẻ nhập nhầm Lumina → Tam Việt (23/11) · lô ${lot.lo} · ${lot.soEpc} EPC · op:${lot.op.tao}`,
    items: lot.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, epcs: l.epcs.slice() })),
    clientOperationId: lot.op.tao,
  };
}
async function xacMinhTao(lot, st) {
  const t = await docPhieu(st.transferId);
  const v = soPhieu(t, lot, ["DRAFT"]);
  st.transferNumber = t.transferNumber;
  st.items = lot.lines.map((l) => ({ productId: l.productId, circa: l.circaProductId, itemId: v.itemIds[l.productId] || null, quantity: l.quantity, soEpc: l.epcs.length }));
  st.soKhop = v.dat;
  st.xacMinhTao = { at: iso(), dat: v.dat, status: t.status, loi: v.loi, canhBao: v.canhBao };
  luuState(st);
  inSoPhieu(v, t);
  if (!v.dat) throw new Dung(`PHIẾU TẠO RA LỆCH kế hoạch: dừng ở DRAFT, không làm gì thêm. Huỷ: node chuyen-kho.js huy ${lot.lo} --ghi --ly-do "phiếu lệch kế hoạch"`, 1);
  console.log(`ĐẠT: phiếu ${t.transferNumber} DRAFT khớp kế hoạch (${lot.soDong} dòng, ${lot.soEpc} EPC, tổng ${lot.tongSL}). itemId đã lưu ở ${stateFile(lot.lo)}`);
}
async function cmdTao(ten) {
  const plan = docPlan();
  const lot = layLo(plan, ten);
  inLo(lot, "TẠO PHIẾU DRAFT");
  chanLoDaTach(lot, "tao");
  const lanCo = dongLanCo(lot);
  if (lanCo.length) throw new Dung(`Lô ${lot.lo} có dòng lẫn cỡ thẻ: ${moTaLanCo(lanCo)}. NW chia đều quantity cho các EPC của dòng → số dư từng thẻ sai. Không tạo phiếu. Dùng: node chuyen-kho.js tach ${lot.lo}`, 1);
  const body = bodyTao(lot);
  if (!GHI) return inKho("POST /stock-transfers", body, lot.op.tao);
  kiemMoiTruong(true, true);
  const st = docState(lot.lo);
  const tt = ttBuoc(st, "tao");
  if (!MO.includes(tt)) throw new Dung(`Bước tạo của lô ${lot.lo} đã "${tt}"${st.transferNumber ? " (" + st.transferNumber + ")" : ""}: không chạy lại.`, 1);
  const r = await kiemDayDu(plan, lot, st);
  st.snap.tao = r.snap;
  luuState(st);
  inKetQuaKiem(r);
  if (!r.the.dat || r.loiThu.length) throw new Dung("Kiểm trước không đạt: không tạo phiếu", 1);
  const ungVien = r.phieu.vuong;
  if (ungVien.length) {
    if (tt !== "chua" && ungVien.length === 1 && ungVien[0].coDau) {
      const x = ungVien[0];
      console.log(`Phiếu ${x.transferNumber} (${x.id}, ${x.status}) mang dấu op của lô: lần POST trước đã tạo phiếu. KHÔNG gửi lại; nhận phiếu này.`);
      st.transferId = x.id;
      st.transferNumber = x.transferNumber;
      st.buoc.tao.trangThai = "thanh-cong";
      st.buoc.tao.nhanLai = { at: iso(), id: x.id, transferNumber: x.transferNumber };
      luuState(st);
      return xacMinhTao(lot, st);
    }
    throw new Dung("Đã có phiếu chuyển chứa EPC của lô / mang dấu lô: không tạo thêm. " + ungVien.map((x) => `${x.transferNumber} ${x.id} ${x.status}`).join("; "), 1);
  }
  const { r: res, ketQua } = await ghi(st, lot, "tao", "/stock-transfers", body, lot.op.tao, "Tạo phiếu chuyển DRAFT");
  xuLyKetQuaXau(res, ketQua, lot, "tao");
  st.transferId = res.json.id;
  st.transferNumber = res.json.transferNumber || null;
  luuState(st);
  console.log(`Đã tạo phiếu ${st.transferNumber} (${st.transferId}), status trả về ${res.json.status}`);
  await xacMinhTao(lot, st);
}

// ---------- so sánh sau khi chuyển ----------
async function kiemTheSau(lot, mode) {
  const epcs = epcCuaLo(lot);
  const dmap = dongTheoEpc(lot);
  const tags = await timThe(epcs);
  const kq = [];
  for (const e of epcs) {
    const l = dmap[e];
    const sl = l.slTheoEpc[e];
    const t = tags[e];
    const loi = [];
    const cL = await checkThe(e, LUM);
    if (!cL.coThe) loi.push("check 404");
    else if (cL.soDu !== 0) loi.push(`số dư tại Lumina còn ${cL.soDu}`);
    let soDuTV = null;
    if (mode === "soat") {
      const cT = await checkThe(e, TV);
      soDuTV = cT.soDu;
      if (cT.soDu !== sl) loi.push(`số dư tại Tam Việt ${cT.soDu} ≠ slLedger ${sl}`);
      if (!t) loi.push("không thấy thẻ");
      else {
        if (L(t.homeWarehouseId) !== TV) loi.push("kho hiện tại " + tenKho(t.homeWarehouseId));
        if (L(t.status) !== "active") loi.push("trạng thái " + t.status);
      }
    }
    kq.push({ epc: e, circa: l.circaProductId, sl, status: t ? t.status : null, kho: t ? tenKho(t.homeWarehouseId) : null, soDuLum: cL.soDu, soDuTV, loi });
    if (kq.length % 50 === 0) console.log(`   … ${kq.length}/${epcs.length} thẻ`);
  }
  const nhom = {};
  for (const x of kq) { const k = `${x.status}@${x.kho}`; nhom[k] = (nhom[k] || 0) + 1; }
  return { dat: kq.every((x) => !x.loi.length), the: kq, nhom };
}

async function soSanhSau(lot, truoc, mode, soPhieuNW) {
  const loi = [];
  const canhBao = [];
  const sp = {};
  const ngoaiAll = [];
  if (!truoc) return { at: iso(), mode, dat: false, loi: ["không có số dư trước (snap) để so"], canhBao, sp };
  const cua = (x) => soPhieuNW && String(x.actionReference || "") === soPhieuNW;
  for (const ln of lot.lines) {
    const c = "CIRCA " + ln.circaProductId;
    const b = truoc.sp[ln.productId];
    if (!b) { loi.push(`${c}: không có số dư trước`); continue; }
    const q = ln.quantity;
    const dsSet = new Set(ln.epcs);
    const lum = await tonSP(ln.productId, LUM);
    const tv = await tonSP(ln.productId, TV);
    const mL = await soKho(ln.productId, LUM, b.conTro.lum);
    const mT = await soKho(ln.productId, TV, b.conTro.tv);
    const o = { circa: ln.circaProductId, quantity: q, lumTruoc: b.lum.systemStock, lumSau: lum.systemStock, tvTruoc: b.tv.systemStock, tvSau: tv.systemStock, soNgoaiDS: Object.keys(b.ngoaiDS).length, ngoaiDoi: [] };
    // Lumina: giảm đúng q, chỉ các EPC của dòng
    const kyL = r6(b.lum.systemStock - q);
    if (lum.systemStock !== kyL) loi.push(`${c}: tồn Lumina trước ${b.lum.systemStock} → sau ${lum.systemStock}, kỳ vọng ${kyL} (giảm đúng ${q})`);
    const pL = mL.rows.filter(cua);
    const kL = mL.rows.filter((x) => !cua(x));
    const qL = r6(sum(pL.map((x) => Number(x.quantity))));
    const eL = new Set(pL.flatMap((x) => (x.epcs || []).map(U)));
    o.soKhoLumPhieu = { soDong: pL.length, tong: qL };
    if (qL !== -q) loi.push(`${c}: sổ kho Lumina của phiếu ${soPhieuNW} cộng ${qL}, kỳ vọng ${-q}`);
    const laL = [...eL].filter((e) => !dsSet.has(e));
    if (laL.length) loi.push(`${c}: phiếu trừ thẻ NGOÀI danh sách tại Lumina: ${cat(laL, 5)}`);
    const chuaL = ln.epcs.filter((e) => !eL.has(e));
    if (chuaL.length) loi.push(`${c}: sổ kho Lumina chưa ghi phiếu trừ ${chuaL.length} EPC của dòng: ${cat(chuaL, 5)}`);
    if (kL.length) canhBao.push(`${c}: ${kL.length} dòng sổ kho Lumina khác trong lúc chạy: ` + kL.slice(0, 5).map((x) => `${x.actionType} ${x.actionReference || ""} ${x.quantity}`).join("; "));
    const d = soDuEpc(mL.rows);
    for (const [e, ob] of Object.entries(b.ngoaiDS)) {
      const sau = r6(ob.soDu + (d[e] || 0));
      if (sau !== ob.soDu) { loi.push(`${c}: thẻ ngoài DS ${e} số dư Lumina ${ob.soDu} → ${sau}`); o.ngoaiDoi.push(e); }
      ngoaiAll.push([ln, e, ob, o]);
    }
    // Tam Việt
    const pT = mT.rows.filter(cua);
    const kT = mT.rows.filter((x) => !cua(x));
    const qT = r6(sum(pT.map((x) => Number(x.quantity))));
    const eT = new Set(pT.flatMap((x) => (x.epcs || []).map(U)));
    o.soKhoTvPhieu = { soDong: pT.length, tong: qT };
    if (mode === "gui") {
      if (tv.systemStock !== b.tv.systemStock) canhBao.push(`${c}: tồn Tam Việt đổi ngay sau submit: ${b.tv.systemStock} → ${tv.systemStock}`);
    } else {
      const kyT = r6(b.tv.systemStock + q);
      if (tv.systemStock !== kyT) loi.push(`${c}: tồn Tam Việt trước ${b.tv.systemStock} → sau ${tv.systemStock}, kỳ vọng ${kyT} (tăng đúng ${q})`);
      if (qT !== q) loi.push(`${c}: sổ kho Tam Việt của phiếu ${soPhieuNW} cộng ${qT}, kỳ vọng ${q}`);
      const laT = [...eT].filter((e) => !dsSet.has(e));
      if (laT.length) loi.push(`${c}: phiếu nhập thẻ NGOÀI danh sách vào Tam Việt: ${cat(laT, 5)}`);
      const chuaT = ln.epcs.filter((e) => !eT.has(e));
      if (chuaT.length) loi.push(`${c}: sổ kho Tam Việt chưa ghi ${chuaT.length} EPC của dòng: ${cat(chuaT, 5)}`);
    }
    if (kT.length) canhBao.push(`${c}: ${kT.length} dòng sổ kho Tam Việt khác: ` + kT.slice(0, 5).map((x) => `${x.actionType} ${x.actionReference || ""} ${x.quantity}`).join("; "));
    sp[ln.productId] = o;
  }
  const tags = ngoaiAll.length ? await timThe(ngoaiAll.map((x) => x[1])) : {};
  for (const [ln, e, ob, o] of ngoaiAll) {
    const t = tags[e];
    const s = t ? L(t.status) : null;
    const k = t ? L(t.homeWarehouseId) : null;
    if (s !== ob.status || k !== ob.kho) {
      loi.push(`CIRCA ${ln.circaProductId}: thẻ ngoài DS ${e} trước ${ob.status}@${tenKho(ob.kho)} → nay ${t ? t.status : "không thấy"}@${tenKho(k)}`);
      if (!o.ngoaiDoi.includes(e)) o.ngoaiDoi.push(e);
    }
  }
  return { at: iso(), mode, dat: !loi.length, loi, canhBao, sp };
}
function inSoSanh(ss, the) {
  if (the) {
    const hong = the.the.filter((x) => x.loi.length);
    console.log(`Thẻ trong DS: đạt ${the.the.length - hong.length}/${the.the.length}; trạng thái@kho: ` + Object.entries(the.nhom).map(([k, v]) => `${k}: ${v}`).join(", "));
    for (const x of hong) console.log(`  KHÔNG ĐẠT ${x.epc} CIRCA ${x.circa} SL ${x.sl}: ${x.loi.join("; ")}`);
  }
  console.log("Theo SP: CIRCA     SL dòng  Lumina trước→sau  TamViet trước→sau  Thẻ ngoài DS (đổi/tổng)");
  for (const o of Object.values(ss.sp)) console.log(`         ${pad(o.circa, 9)} ${pad(o.quantity, 8)} ${pad(o.lumTruoc + "→" + o.lumSau, 17)} ${pad(o.tvTruoc + "→" + o.tvSau, 18)} ${o.ngoaiDoi.length}/${o.soNgoaiDS}`);
  for (const x of ss.loi) console.log("  KHÔNG ĐẠT: " + x);
  for (const x of ss.canhBao) console.log("  Cảnh báo: " + x);
}

// ---------- gửi (submit) ----------
// Lô khác (chưa tách) có chung SP, đã submit mà chưa soát đạt và chưa huỷ: tồn SP đang đổi vì lô đó.
function loCungSPDangDo(plan, lot) {
  const pids = new Set(lot.lines.map((l) => l.productId));
  const out = [];
  for (const y of loConLai(plan.lots)) {
    if (y.lo === lot.lo || !y.lines.some((l) => pids.has(l.productId)) || !fs.existsSync(stateFile(y.lo))) continue;
    const s = docState(y.lo);
    if (ttBuoc(s, "gui") === "chua" || ttBuoc(s, "huy") === "thanh-cong" || (s.soat && s.soat.dat)) continue;
    out.push(`${y.lo} (gửi ${ttBuoc(s, "gui")}, nhận ${ttBuoc(s, "nhan")}, soát ${s.soat ? (s.soat.dat ? "đạt" : "KHÔNG ĐẠT") : "chưa"})`);
  }
  return out;
}
async function sauGui(lot, st) {
  const t = await docPhieu(st.transferId);
  const v = soPhieu(t, lot, ["SUBMITTED", "IN_TRANSIT"]);
  inSoPhieu(v, t);
  console.log("Kiểm thẻ trong DS (số dư Lumina phải = 0) và SP / thẻ ngoài DS (so với số dư ngay trước submit)");
  const the = await kiemTheSau(lot, "gui");
  const ss = await soSanhSau(lot, st.snap.gui || st.snap.tao, "gui", t.transferNumber || st.transferNumber);
  const dat = v.dat && the.dat && ss.dat;
  st.kiemGui = { at: iso(), dat, phieu: { status: t.status, loi: v.loi, canhBao: v.canhBao }, theKhongDat: the.the.filter((x) => x.loi.length), nhomThe: the.nhom, soSanh: ss };
  luuState(st);
  inSoSanh(ss, the);
  if (!dat) throw new Dung(`SAU SUBMIT KHÔNG ĐẠT (lô ${lot.lo}, phiếu ${t.transferNumber} ${t.status}). KHÔNG chạy nhan. Gợi ý: phiếu chưa COMPLETED nên huỷ được, hàng trả về Lumina: node chuyen-kho.js huy ${lot.lo} --ghi --ly-do "<lý do>"`, 1);
  console.log(`ĐẠT: phiếu ${t.transferNumber} ${t.status}; ${lot.soEpc} thẻ đã rời Lumina; tồn Lumina từng SP giảm đúng quantity; thẻ Lumina ngoài DS không đổi.`);
}
async function cmdGui(ten) {
  const plan = docPlan();
  const lot = layLo(plan, ten);
  inLo(lot, "GỬI PHIẾU (submit: hàng rời Lumina)");
  chanLoDaTach(lot, "gui");
  const st = docState(lot.lo);
  if (!GHI) return inKho(`POST /stock-transfers/${st.transferId || "<id có sau bước tao>"}/submit`, undefined, lot.op.gui);
  kiemMoiTruong(true, true);
  if (ttBuoc(st, "tao") !== "thanh-cong" || !st.transferId || !st.soKhop) throw new Dung("Cần bước tạo thành công và phiếu DRAFT đã so khớp kế hoạch (state.soKhop)", 1);
  if (ttBuoc(st, "huy") === "thanh-cong") throw new Dung("Phiếu của lô đã huỷ", 1);
  const tt = ttBuoc(st, "gui");
  if (!MO.includes(tt)) throw new Dung(`Bước gửi của lô ${lot.lo} đã "${tt}": không chạy lại.`, 1);
  const dangDo = loCungSPDangDo(plan, lot);
  if (dangDo.length) throw new Dung(`Lô khác cùng SP đã gửi mà chưa soát đạt: ${dangDo.join("; ")}. Phép kiểm sau submit so tồn SP trước/sau nên các lô cùng SP phải chạy tuần tự: xong nhan + soat lô đó rồi mới gui ${lot.lo}.`, 1);
  const t = await docPhieu(st.transferId);
  const s = U(t.status);
  if (s !== "DRAFT") {
    if (tt !== "chua" && ["SUBMITTED", "IN_TRANSIT"].includes(s)) {
      console.log(`Phiếu đang ${s}: lần submit trước đã qua. KHÔNG gửi lại.`);
      st.buoc.gui.trangThai = "thanh-cong";
      st.buoc.gui.nhanLai = { at: iso(), status: s };
      luuState(st);
      return sauGui(lot, st);
    }
    throw new Dung(`Phiếu ${t.transferNumber} đang ${s}, cần DRAFT`, 1);
  }
  const v = soPhieu(t, lot, ["DRAFT"]);
  inSoPhieu(v, t);
  if (!v.dat) throw new Dung("Phiếu DRAFT không còn khớp kế hoạch: không submit", 1);
  console.log("Kiểm lại thẻ ngay trước submit");
  const the = await kiemTheTruoc(lot);
  if (!the.dat) {
    for (const x of the.the.filter((y) => y.loi.length)) console.log(`  KHÔNG ĐẠT ${x.epc} CIRCA ${x.circa}: ${x.loi.join("; ")}`);
    throw new Dung("Thẻ không còn đạt: không submit", 1);
  }
  console.log("Chụp số dư theo SP ngay trước submit");
  st.snap.gui = await chupSoDu(plan, lot);
  luuState(st);
  const { r, ketQua } = await ghi(st, lot, "gui", `/stock-transfers/${st.transferId}/submit`, undefined, lot.op.gui, "Submit phiếu chuyển: hàng rời Lumina");
  xuLyKetQuaXau(r, ketQua, lot, "gui");
  await sauGui(lot, st);
}

// ---------- nhận (complete) ----------
function bodyNhan(lot, itemIds) {
  return {
    items: lot.lines.map((l) => ({ itemId: (itemIds && itemIds[l.productId]) || `<itemId dòng CIRCA ${l.circaProductId}: có sau bước tao>`, receivedQuantity: l.quantity, receivedEpcs: l.epcs.slice() })),
    clientOperationId: lot.op.nhan,
  };
}
async function sauNhan(lot, st) {
  const t = await docPhieu(st.transferId);
  const v = soPhieu(t, lot, ["COMPLETED"]);
  st.xacMinhNhan = { at: iso(), dat: v.dat, status: t.status, loi: v.loi, canhBao: v.canhBao };
  luuState(st);
  inSoPhieu(v, t);
  if (!v.dat) throw new Dung(`Sau complete phiếu không khớp (lô ${lot.lo}): xem LỆCH ở trên, chạy soat`, 1);
  console.log(`ĐẠT: phiếu ${t.transferNumber} COMPLETED, số nhận = số gửi từng dòng. Bước tiếp: node chuyen-kho.js soat ${lot.lo}`);
}
async function cmdNhan(ten) {
  const plan = docPlan();
  const lot = layLo(plan, ten);
  inLo(lot, "NHẬN PHIẾU (complete: hàng vào Tam Việt)");
  chanLoDaTach(lot, "nhan");
  const st = docState(lot.lo);
  const idsState = Object.fromEntries((st.items || []).map((x) => [x.productId, x.itemId]));
  if (!GHI) return inKho(`POST /stock-transfers/${st.transferId || "<id có sau bước tao>"}/complete`, bodyNhan(lot, idsState), lot.op.nhan);
  kiemMoiTruong(true, true);
  if (ttBuoc(st, "gui") !== "thanh-cong" || !st.transferId) throw new Dung("Cần bước gửi (submit) thành công", 1);
  if (ttBuoc(st, "huy") === "thanh-cong") throw new Dung("Phiếu của lô đã huỷ", 1);
  const tt = ttBuoc(st, "nhan");
  if (!MO.includes(tt)) throw new Dung(`Bước nhận của lô ${lot.lo} đã "${tt}": không chạy lại.`, 1);
  if (!st.kiemGui || !st.kiemGui.dat) {
    if (!OPT["chap-nhan-lech-gui"]) throw new Dung("Kiểm sau submit CHƯA ĐẠT (state.kiemGui): không nhận. Huỷ phiếu bằng `huy`, hoặc nếu PM đã xác minh là báo động giả thì chạy lại với --chap-nhan-lech-gui", 1);
    st.chapNhanLechGui = { at: iso() };
    luuState(st);
    console.log("PM chấp nhận lệch ở bước gửi (--chap-nhan-lech-gui)");
  }
  const t = await docPhieu(st.transferId);
  const s = U(t.status);
  if (s === "COMPLETED" && tt !== "chua") {
    console.log("Phiếu đã COMPLETED: lần complete trước đã qua. KHÔNG gửi lại.");
    st.buoc.nhan.trangThai = "thanh-cong";
    st.buoc.nhan.nhanLai = { at: iso() };
    luuState(st);
    return sauNhan(lot, st);
  }
  if (!["SUBMITTED", "IN_TRANSIT"].includes(s)) throw new Dung(`Phiếu ${t.transferNumber} đang ${s}, cần SUBMITTED hoặc IN_TRANSIT`, 1);
  const v = soPhieu(t, lot, ["SUBMITTED", "IN_TRANSIT"]);
  inSoPhieu(v, t);
  if (!v.dat) throw new Dung("Phiếu không khớp kế hoạch: không complete", 1);
  for (const l of lot.lines) if (idsState[l.productId] && idsState[l.productId] !== v.itemIds[l.productId]) throw new Dung(`itemId dòng CIRCA ${l.circaProductId} trên NW (${v.itemIds[l.productId]}) khác state (${idsState[l.productId]})`, 1);
  const body = bodyNhan(lot, v.itemIds);
  const { r, ketQua } = await ghi(st, lot, "nhan", `/stock-transfers/${st.transferId}/complete`, body, lot.op.nhan, "Complete phiếu chuyển: nhận đủ mọi EPC");
  xuLyKetQuaXau(r, ketQua, lot, "nhan");
  await sauNhan(lot, st);
}

// ---------- soát ----------
async function cmdSoat(ten) {
  const plan = docPlan();
  const lot = layLo(plan, ten);
  inLo(lot, "SOÁT SAU KHI NHẬN (chỉ đọc)");
  kiemMoiTruong(true, false);
  const st = docState(lot.lo);
  if (!st.transferId) throw new Dung(`Lô ${lot.lo} chưa có phiếu trong state`, 1);
  const t = await docPhieu(st.transferId);
  const v = soPhieu(t, lot, ["COMPLETED"]);
  inSoPhieu(v, t);
  const the = await kiemTheSau(lot, "soat");
  const goc = st.snap.gui ? "gui" : st.snap.tao ? "tao" : null;
  if (goc !== "gui") console.log(`Cảnh báo: không có số dư chụp ngay trước submit; so với số dư lúc ${goc || "(không có)"}`);
  const ss = await soSanhSau(lot, goc ? st.snap[goc] : null, "soat", t.transferNumber || st.transferNumber);
  const dat = v.dat && the.dat && ss.dat;
  const out = { at: iso(), lo: lot.lo, transferId: st.transferId, transferNumber: t.transferNumber, status: t.status, dat, soDuTruocLuc: goc, phieu: { loi: v.loi, canhBao: v.canhBao }, the: the.the, nhomThe: the.nhom, soSanh: ss };
  const f = path.join(DIR, lot.lo + ".soat.json");
  ghiDe(f, out);
  st.soat = { at: out.at, dat, file: path.basename(f) };
  luuState(st);
  inSoSanh(ss, the);
  const hong = the.the.filter((x) => x.loi.length).length;
  console.log(`\nSOÁT lô ${lot.lo}: thẻ đạt ${the.the.length - hong} / không đạt ${hong}; SP lỗi ${ss.loi.length}; phiếu ${v.dat ? "khớp" : "LỆCH"} → ${dat ? "ĐẠT" : "KHÔNG ĐẠT"}. Ghi ${f}`);
  if (!dat) throw new Dung(`SOÁT KHÔNG ĐẠT lô ${lot.lo}`, 1);
}

// ---------- huỷ ----------
async function cmdHuy(ten) {
  const plan = docPlan();
  const lot = layLo(plan, ten);
  inLo(lot, "HUỶ PHIẾU");
  const st = docState(lot.lo);
  const lyDo = typeof OPT["ly-do"] === "string" ? OPT["ly-do"].trim() : "";
  const body = { reason: lyDo || "<--ly-do>", clientOperationId: lot.op.huy };
  if (!GHI) return inKho(`POST /stock-transfers/${st.transferId || "<id có sau bước tao>"}/cancel`, body, lot.op.huy);
  kiemMoiTruong(true, true);
  if (!lyDo) throw new Dung('Cần --ly-do "<lý do>"', 1);
  if (!st.transferId) throw new Dung(`Lô ${lot.lo} chưa có phiếu trong state`, 1);
  const tt = ttBuoc(st, "huy");
  if (!MO.includes(tt)) throw new Dung(`Bước huỷ của lô ${lot.lo} đã "${tt}": không chạy lại.`, 1);
  const t = await docPhieu(st.transferId);
  const s = U(t.status);
  if (s === "CANCELLED" && tt !== "chua") {
    console.log("Phiếu đã CANCELLED: lần huỷ trước đã qua. KHÔNG gửi lại.");
    st.buoc.huy.trangThai = "thanh-cong";
    st.sauHuy = { at: iso(), status: t.status };
    luuState(st);
    return;
  }
  if (!["DRAFT", "SUBMITTED", "IN_TRANSIT"].includes(s)) throw new Dung(`Phiếu ${t.transferNumber} đang ${s}: chỉ huỷ được DRAFT / SUBMITTED / IN_TRANSIT`, 1);
  console.log(`Phiếu ${t.transferNumber} đang ${s}${s !== "DRAFT" ? ": huỷ sẽ trả hàng về Lumina" : ""}`);
  const { r, ketQua } = await ghi(st, lot, "huy", `/stock-transfers/${st.transferId}/cancel`, body, lot.op.huy, "Huỷ phiếu chuyển: " + lyDo);
  xuLyKetQuaXau(r, ketQua, lot, "huy");
  const t2 = await docPhieu(st.transferId);
  st.sauHuy = { at: iso(), status: t2.status };
  luuState(st);
  console.log(`Sau huỷ: phiếu ${t2.transferNumber} ${t2.status}${t2.cancelReason ? " · lý do: " + t2.cancelReason : ""}`);
  if (s !== "DRAFT") {
    const the = await kiemTheTruoc(lot);
    const hong = the.the.filter((x) => x.loi.length);
    console.log(`Thẻ về lại Lumina (active, số dư = slLedger): ${the.the.length - hong.length}/${the.the.length}`);
    for (const x of hong) console.log(`  CHƯA VỀ ${x.epc} CIRCA ${x.circa}: ${x.loi.join("; ")}`);
  }
  if (U(t2.status) !== "CANCELLED") throw new Dung(`Phiếu chưa CANCELLED (đang ${t2.status})`, 1);
}

// ---------- trạng thái ----------
async function cmdTrangThai() {
  const plan = docPlan();
  const coKhoa = !!ENV.NW_KEY;
  kiemMoiTruong(false, false);
  let tatCa = null;
  console.log(`Kế hoạch ${planFile()} (lập ${vn(plan.taoLuc)})${coKhoa ? "" : ": không có NW_KEY, chỉ in state"}`);
  console.log("Lô      SP  EPC  SL     Phiếu NW                                  Trạng thái NW  tạo        gửi        nhận       huỷ        sau-gửi  soát   Ghi chú");
  const ghiChu = [];
  for (const lot of thuTuHienThi(plan.lots)) {
    const st = fs.existsSync(stateFile(lot.lo)) ? docState(lot.lo) : null;
    let nw = "";
    let so = st && st.transferNumber ? st.transferNumber : "";
    if (st && st.transferId && coKhoa) {
      try { const t = await docPhieu(st.transferId); nw = t.status; so = t.transferNumber; } catch (e) { nw = "lỗi đọc"; }
    } else if (st && !st.transferId && ttBuoc(st, "tao") !== "chua" && coKhoa) {
      if (!tatCa) tatCa = await dsPhieu();
      const m = tatCa.filter((t) => String(t.notes || "").includes(lot.op.tao));
      nw = m.length ? "xem dưới" : "không thấy";
      ghiChu.push(`${lot.lo}: bước tạo "${ttBuoc(st, "tao")}", chưa có id trong state; ` + (m.length ? "TÌM THẤY phiếu mang dấu op:" + m.map((t) => ` ${t.transferNumber} ${t.status} ${t.id}`).join(";") + `. Chạy lại "tao ${lot.lo} --ghi" sẽ nhận phiếu này, không POST.` : `không thấy phiếu nào mang dấu op:${lot.op.tao} (đọc ${tatCa.length} phiếu cập nhật từ ${vn(SINCE)}).`));
    }
    const b = (k) => (st ? ttBuoc(st, k) : "chua");
    const kg = st && st.kiemGui ? (st.kiemGui.dat ? "đạt" : "KHÔNG") : "";
    const sa = st && st.soat ? (st.soat.dat ? "đạt" : "KHÔNG") : "";
    const gc = [];
    if (lot.daTach) gc.push(`ĐÃ TÁCH → ${lot.daTach.thanh.join(", ")} (không chạy tao/gui/nhan; không tính vào tổng)`);
    if (lot.tachTu) gc.push(`tách từ ${lot.tachTu}` + (lot.lines.length === 1 ? ` · CIRCA ${lot.lines[0].circaProductId} cỡ ${coCuaDong(lot.lines[0]).join("/")}` : ""));
    if (!lot.daTach && dongLanCo(lot).length) gc.push("DÒNG LẪN CỠ: chạy tach " + lot.lo);
    console.log(`${pad(lot.lo, 7)} ${pad(lot.soDong, 3)} ${pad(lot.soEpc, 4)} ${pad(lot.tongSL, 6)} ${pad(so, 41)} ${pad(nw, 14)} ${pad(b("tao"), 10)} ${pad(b("gui"), 10)} ${pad(b("nhan"), 10)} ${pad(b("huy"), 10)} ${pad(kg, 8)} ${pad(sa, 6)} ${gc.join("; ")}`);
  }
  const con = loConLai(plan.lots);
  console.log(`Các lô chưa tách: ${con.length} lô, ${sum(con.map((l) => l.soEpc))} EPC, tổng SL ${r6(sum(con.map((l) => l.tongSL)))}`);
  for (const x of ghiChu) console.log("  " + x);
}

// ---------- main ----------
async function main() {
  const [cmd, lo] = POS;
  kiemMoiTruong(false, false);
  if (lo && !/^(thu|lo-\d{2}[a-z]?)$/.test(lo)) throw new Dung(`Tên lô lạ "${lo}"`);
  switch (cmd) {
    case "plan": return cmdPlan();
    case "kiem": return cmdKiem(lo);
    case "tao": return cmdTao(lo);
    case "gui": return cmdGui(lo);
    case "nhan": return cmdNhan(lo);
    case "soat": return cmdSoat(lo);
    case "huy": return cmdHuy(lo);
    case "trang-thai": return cmdTrangThai();
    case "tach": return cmdTach(lo);
    default:
      console.log("Lệnh: plan | kiem <lô> | tao <lô> [--ghi] | gui <lô> [--ghi] | nhan <lô> [--ghi] | soat <lô> | huy <lô> [--ghi] --ly-do \"…\" | trang-thai | tach <lô>");
      throw new Dung("Lệnh không rõ: " + (cmd || "(trống)"));
  }
}
const inMang = () => console.log(`[request mạng: GET ${NET.get} · POST đọc ${NET.docPost} · POST ghi ${NET.ghiPost}]`);
main().then(
  () => { inMang(); },
  (e) => {
    inMang();
    if (e instanceof Dung) { console.error("DỪNG: " + scrub(e.message)); process.exitCode = e.code; }
    else { console.error("LỖI: " + scrub(String((e && e.stack) || e))); process.exitCode = 1; }
  }
);
