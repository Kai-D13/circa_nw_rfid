// TEST lõi NWC (tools/nw-sang-circa/core.js). OFFLINE / CHỈ ĐỌC: không gọi mạng, không dùng token, không ghi file.
//
// Dùng (cwd bất kỳ):  node tools/nw-sang-circa/test.js
//   Phần 1: unit test bằng dữ liệu giả (luôn chạy).
//   Phần 2: dữ liệu thật phiên Lumina 21/11 (bỏ qua kèm thông báo nếu thiếu file, vì work/ không nằm trong git):
//     env NWC_XLSX  (mặc định work/20261121-nw-sang-circa-kiem-ke/in/kiem-ke-lumina-2026-11-21-15-42.xlsx)
//     env NWC_QR    (mặc định work/20261121-nw-sang-circa-kiem-ke/phien/qr-lookup.json)
//     env NWC_SCANS (mặc định work/20261121-nw-sang-circa-kiem-ke/phien/ics00240-scans.json; thiếu → dùng fixture 12 lượt
//                   thật của ICS00240 PM đã đọc 21/11)
//     Đối chiếu thêm với 2 lần gửi thử thật (records/pos-writes/20261121-ICS00240-thu-*) nếu có.
//   Phần "ĐƯỜNG ỐNG" dùng sim.js (mô phỏng Circa): chỉ kiểm chia lô → kiểm response → đối soát chạy liền mạch,
//   KHÔNG phải bằng chứng về số Circa sẽ ghi.
//   Số thật khác "sự thật đã kiểm" của đặc tả → test BÁO LỖI, không sửa test cho khớp.
"use strict";
const fs = require("fs"), path = require("path"), assert = require("assert");
const NWC = require("./core.js");
const sim = require("./sim.js");

const ROOT = path.resolve(__dirname, "..", "..");
let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; failures.push(name); console.log("FAIL  " + name + "\n      " + String(e && e.message || e).split("\n").join("\n      ")); }
}
const eq = assert.strictEqual, deq = assert.deepStrictEqual;

// ---------- dữ liệu giả ----------
const U = (unit, rate, base) => ({ unit, convert_rate: rate, base_unit: !!base });
const D = (pid, unitName, units) => ({ product_id: pid, product_name: "SP " + pid, sku_code: "SKU" + pid, unit_name: unitName, retail_units: units });
const VIEN_HOP10 = pid => D(pid, "hộp", [U("viên", 1, true), U("hộp", 10)]);
const T = (epc, uid, pid, qty, unit) => ({ epc, uid, pid, name: "SP " + pid, nwQty: qty, nwUnit: unit || "viên" });
const one = (tag, lk) => NWC.plan([tag], lk).items[0];
const PARSED = tags => ({ tags, strange: [], errors: [], skipped: [], warnings: [] });

console.log("== Phần 1: unit test (dữ liệu giả)");

t("UMD: gán globalThis.NWC và module.exports", () => {
  eq(globalThis.NWC, NWC);
  eq(NWC.BATCH, 100);
  ["parseSession", "lookupCodes", "plan", "batches", "checkResponse", "reconcile", "checkScans"].forEach(f => eq(typeof NWC[f], "function"));
});
t("UMD: chạy như trình duyệt (không có module) → globalThis.NWC", () => {
  const vm = require("vm");
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "core.js"), "utf8"), ctx);
  eq(typeof ctx.NWC.plan, "function");
  eq(vm.runInContext("typeof NWC.checkScans", ctx), "function");
});
t("core.js thuần: không có </script, require, fetch, XMLHttpRequest, env", () => {
  const src = fs.readFileSync(path.join(__dirname, "core.js"), "utf8");
  assert(!/<\/script/i.test(src), "có chuỗi </script");
  assert(!/\brequire\s*\(/.test(src), "có require(");
  assert(!/\bfetch\s*\(|XMLHttpRequest|\bprocess\.env/.test(src), "có gọi mạng / env");
});

// lookupCodes / lookupMap
t("lookupCodes: UID ≠ EPC → [uid, epc]", () => deq(NWC.lookupCodes({ epc: "E280AA", uid: "1794X" }), ["1794X", "E280AA"]));
t("lookupCodes: UID = EPC (khác hoa thường) → [epc]", () => deq(NWC.lookupCodes({ epc: "A51A00ff", uid: "A51A00FF" }), ["A51A00ff"]));
t("lookupCodes: thiếu UID → [epc]", () => deq(NWC.lookupCodes({ epc: "B51A01", uid: "" }), ["B51A01"]));
t("lookupMap: 200 → d, 404 → null, 5xx/0 → chưa tra; 200 thắng 404 dù đứng sau", () => {
  const d = VIEN_HOP10(1);
  const m = NWC.lookupMap([{ code: "A", status: 404 }, { code: "A", status: 200, d }, { code: "B", status: 404 }, { code: "C", status: 500 }, { code: "E", status: 0 }]);
  eq(m.A, d); eq(m.B, null);
  assert(!("C" in m) && !("E" in m));
});

// plan: quy tắc 0–8
t("Q0: thẻ parseSession đánh dấu hold → giu, không tra, không gửi", () => {
  const tag = Object.assign(T("A1", "", 1, 10), { hold: "Trùng EPC khác số liệu" });
  const it = one(tag, { A1: VIEN_HOP10(1) });
  eq(it.mode, "giu"); eq(it.send, null); assert(/Trùng EPC/.test(it.reason));
});
t("Q1 chưa tra: UID có, EPC chưa tra → chua-tra, không gửi", () => {
  const it = one(T("E2801", "U1", 1, 10), { U1: VIEN_HOP10(1) });
  eq(it.mode, "chua-tra"); eq(it.send, null); eq(it.expectBase, 0);
});
t("Q1 chưa tra: map rỗng → chua-tra; okToSend false với lý do", () => {
  const p = NWC.plan(PARSED([T("A51A01", "A51A01", 1, 10)]), {});
  eq(p.items[0].mode, "chua-tra"); eq(p.sum.okToSend, false); assert(p.sum.blockers.some(b => /chưa tra/.test(b)));
});
t("Q1 chưa tra: giá trị undefined trong Map coi như chưa tra", () => {
  eq(one(T("A51A01", "", 1, 10), new Map([["A51A01", undefined]])).mode, "chua-tra");
});
t("Q2 không nhận: UID và EPC đều null → khong-nhan", () => {
  const it = one(T("E2802", "U2", 1, 10), { U2: null, E2802: null });
  eq(it.mode, "khong-nhan"); eq(it.send, null);
});
t("Q3 chọn mã: UID nhận, EPC 404 → gửi UID, via UID", () => {
  const it = one(T("E2803", "U3", 1, 10), { U3: VIEN_HOP10(1), E2803: null });
  eq(it.mode, "tho"); eq(it.code, "U3"); eq(it.via, "UID"); eq(it.send, "U3");
});
t("Q3 chọn mã: UID 404, EPC nhận → gửi EPC, via EPC", () => {
  const it = one(T("E2804", "U4", 1, 10), { U4: null, E2804: VIEN_HOP10(1) });
  eq(it.code, "E2804"); eq(it.via, "EPC"); eq(it.mode, "tho");
});
t("Q3 chọn mã: cả 2 nhận cùng SP → chỉ gửi UID (mã đầu)", () => {
  const p = NWC.plan(PARSED([T("E2805", "U5", 1, 10)]), { U5: VIEN_HOP10(1), E2805: VIEN_HOP10(1) });
  eq(p.items[0].code, "U5"); eq(p.items[0].via, "UID");
  deq(NWC.bodyCodes(NWC.batches(p.items, "S", "D")[0]), ["U5"]);
});
t("Q3 mâu thuẫn: UID và EPC trỏ 2 SP khác → giu", () => {
  const it = one(T("E2806", "U6", 1, 10), { U6: VIEN_HOP10(1), E2806: VIEN_HOP10(2) });
  eq(it.mode, "giu"); eq(it.send, null); assert(/2 SP khác/.test(it.reason));
});
t("Q4 khác SP: Circa product_id ≠ NW pid → giu", () => {
  const it = one(T("A51A07", "", 1, 10), { A51A07: VIEN_HOP10(999) });
  eq(it.mode, "giu"); eq(it.circaPid, 999); assert(/Khác SP/.test(it.reason));
});
t("Q4: pid NW dạng chuỗi số vẫn so đúng; Circa thiếu product_id → giu", () => {
  eq(one(T("A1", "", "1", 10), { A1: VIEN_HOP10(1) }).mode, "tho");
  eq(one(T("A1", "", 1, 10), { A1: { unit_name: "hộp", retail_units: [U("viên", 1, true), U("hộp", 10)] } }).mode, "giu");
});
t("Q5 không có đơn vị gốc → giu", () => {
  eq(one(T("A1", "", 1, 10), { A1: D(1, "hộp", [U("hộp", 10)]) }).mode, "giu");
});
t("Q5 đơn vị gốc có quy đổi ≠ 1 → giu", () => {
  eq(one(T("A1", "", 1, 10), { A1: D(1, "hộp", [U("viên", 2, true), U("hộp", 10)]) }).mode, "giu");
});
t("Q5 hai đơn vị gốc → giu", () => {
  eq(one(T("A1", "", 1, 10), { A1: D(1, "hộp", [U("viên", 1, true), U("gói", 1, true), U("hộp", 10)]) }).mode, "giu");
});
t("Q5 tên đơn vị gốc trùng dòng khác (hoa thường) → giu", () => {
  const it = one(T("A1", "", 1, 10), { A1: D(1, "hộp", [U("viên", 1, true), U("Viên ", 10), U("hộp", 10)]) });
  eq(it.mode, "giu"); assert(/trùng dòng khác/.test(it.reason));
});
t("Q5 tên đơn vị gốc trùng dòng khác (khác dạng Unicode NFC/NFD) → giu", () => {
  const nfd = "viên".normalize("NFD");
  assert(nfd !== "viên");
  eq(one(T("A1", "", 1, 10), { A1: D(1, "hộp", [U("viên", 1, true), U(nfd, 5), U("hộp", 10)]) }).mode, "giu");
});
t("Q5 unit_name của mã không có trong retail_units → giu", () => {
  const it = one(T("A1", "", 1, 10), { A1: D(1, "thùng", [U("viên", 1, true), U("hộp", 10)]) });
  eq(it.mode, "giu"); assert(/thùng/.test(it.reason));
});
t("Q5 retail_units thiếu → giu", () => {
  eq(one(T("A1", "", 1, 10), { A1: { product_id: 1, unit_name: "hộp" } }).mode, "giu");
});
t("Q6 đơn vị gốc Circa ≠ ĐVT NW → giu, không đoán", () => {
  const it = one(T("A1", "", 1, 10, "chai"), { A1: VIEN_HOP10(1) });
  eq(it.mode, "giu"); assert(/Khác đơn vị gốc/.test(it.reason)); eq(it.send, null);
});
t("Q6 hoa/thường + khoảng trắng: ĐVT NW ' Viên ' = Circa 'viên' → không giữ", () => {
  eq(one(T("A1", "", 1, 10, " Viên "), { A1: VIEN_HOP10(1) }).mode, "tho");
});
t("Q7 quy đổi = SL NW → tho, send = mã (chuỗi), expectBase = nwQty", () => {
  const it = one(T("A51A08", "A51A08", 1, 10), { A51A08: VIEN_HOP10(1) });
  eq(it.mode, "tho"); eq(it.send, "A51A08"); eq(it.expectBase, 10); eq(it.circaRate, 10); eq(it.circaUnit, "hộp"); eq(it.baseUnit, "viên");
});
t("Q8 lệch → kem-don-vi, unit_name = chữ Circa trả (giữ hoa thường của Circa)", () => {
  const d = D(1, "Lốc", [U("Miếng", 1, true), U("lốc", 48), U("gói", 8)]);
  const it = one(T("U9X", "", 1, 8, "miếng"), { u9x: d });
  eq(it.mode, "kem-don-vi"); deq(it.send, { tag: "U9X", unit_name: "Miếng", quantity: 8 }); eq(it.expectBase, 8); eq(it.circaRate, 48);
});
t("Q8 SL NW lớn hơn quy đổi cũng gửi kèm đơn vị", () => {
  const it = one(T("A1", "", 1, 30), { A1: VIEN_HOP10(1) });
  eq(it.mode, "kem-don-vi"); deq(it.send, { tag: "A1", unit_name: "viên", quantity: 30 });
});
t("Q8 nwQty = 100000 → kem-don-vi; 100001 → giu", () => {
  eq(one(T("A1", "", 1, 100000), { A1: VIEN_HOP10(1) }).mode, "kem-don-vi");
  eq(one(T("A1", "", 1, 100001), { A1: VIEN_HOP10(1) }).mode, "giu");
});
t("Q7 trước Q8: quy đổi = SL NW = 200000 → vẫn tho", () => {
  eq(one(T("A1", "", 1, 200000), { A1: D(1, "thùng", [U("viên", 1, true), U("thùng", 200000)]) }).mode, "tho");
});
t("lookups dạng Map + khoá khác hoa thường", () => {
  const it = one(T("a51a0a", "", 1, 10), new Map([["A51A0A", VIEN_HOP10(1)]]));
  eq(it.mode, "tho"); eq(it.send, "a51a0a");
});

// plan: bảng theo SP + cờ okToSend
const MIX_TAGS = () => [T("A1", "", 1, 10), T("A2", "", 1, 5), T("A3", "", 1, 10, "chai"), T("E1", "U1", 2, 10), T("E2", "U2", 2, 10)];
const MIX_LK = { A1: VIEN_HOP10(1), A2: VIEN_HOP10(1), A3: VIEN_HOP10(1), U1: VIEN_HOP10(2), E1: null, U2: null, E2: null };
t("bySp/sum: đếm thẻ/gốc/mode theo SP; thẻ giữ / không nhận không chặn okToSend", () => {
  const p = NWC.plan(PARSED(MIX_TAGS()), MIX_LK);
  eq(p.bySp.length, 2);
  const s1 = p.bySp[0];
  eq(s1.pid, 1); eq(s1.tags, 3); eq(s1.nwBase, 25); eq(s1.sendBase, 15); eq(s1.predBase, 15); eq(s1.holdBase, 10);
  deq(s1.modes, { "tho": 1, "kem-don-vi": 1, "giu": 1, "khong-nhan": 0, "chua-tra": 0 });
  eq(p.bySp[1].modes["khong-nhan"], 1); eq(p.bySp[1].via.UID, 1);
  eq(p.sum.nwBase, 45); eq(p.sum.sendBase, 25); eq(p.sum.holdBase, 20); eq(p.sum.codes, 3);
  eq(p.sum.okToSend, true); deq(p.sum.blockers, []);
  assert(/Kiểm tay/.test(s1.viecCanLam));
});
t("okToSend: gọi plan với mảng tags trần (không có kết quả parse) → false", () => {
  const p = NWC.plan(MIX_TAGS(), MIX_LK);
  eq(p.sum.okToSend, false); assert(p.sum.blockers.some(b => /parseSession/.test(b)));
  const q = NWC.plan({ tags: MIX_TAGS() }, MIX_LK); // thiếu errors/skipped → cũng không coi là kết quả parse
  eq(q.sum.okToSend, false);
});
t("okToSend: parse có errors → false; có skipped → false", () => {
  const e = PARSED(MIX_TAGS()); e.errors = [{ row: 9, type: "sl-sai" }];
  eq(NWC.plan(e, MIX_LK).sum.okToSend, false);
  const s = PARSED(MIX_TAGS()); s.skipped = [{ row: 9, reason: "trang-thai" }];
  const ps = NWC.plan(s, MIX_LK);
  eq(ps.sum.okToSend, false); assert(ps.sum.blockers.some(b => /bỏ qua/.test(b)));
});
t("okToSend: không có thẻ nào gửi được → false", () => {
  eq(NWC.plan(PARSED([T("E2", "U2", 2, 10)]), { U2: null, E2: null }).sum.okToSend, false);
});
t("okToSend: hai thẻ cùng mã gửi (UID trùng) → dupCodes, false; batches ném lỗi", () => {
  const p = NWC.plan(PARSED([T("E1", "UX", 1, 10), T("E2", "ux", 1, 10)]), { UX: VIEN_HOP10(1), E1: null, E2: null });
  deq(p.sum.dupCodes, ["ux"]); eq(p.sum.okToSend, false);
  assert.throws(() => NWC.batches(p.items, "S", "D"), /trùng/);
});
t("okToSend: mã gửi (UID thẻ A) trùng EPC của thẻ B đang giữ → codeClash, false", () => {
  const tags = [T("E1", "X9", 1, 10), Object.assign(T("x9", "", 1, 10), { row: 7 })];
  tags[0].row = 6;
  const p = NWC.plan(PARSED(tags), { X9: VIEN_HOP10(1), E1: null });
  eq(p.items[0].mode, "tho"); eq(p.items[1].mode, "tho");
  // cả 2 thẻ cùng gửi mã X9 → vừa trùng mã gửi vừa trùng mã thẻ khác
  deq(p.sum.codeClash, ["X9"]); eq(p.sum.okToSend, false);
  const q = NWC.plan(PARSED([tags[0], Object.assign({}, tags[1], { hold: "giữ" })]), { X9: VIEN_HOP10(1), E1: null });
  deq(q.sum.dupCodes, []); deq(q.sum.codeClash, ["X9"]); eq(q.sum.okToSend, false);
});
t("summarize: sửa payload để gốc dự tính ≠ SL NW → bắt được (predMismatch, chênh theo SP ≠ 0, okToSend false)", () => {
  const p = NWC.plan(PARSED(MIX_TAGS()), MIX_LK);
  const parsed = PARSED(MIX_TAGS());
  eq(NWC.summarize(p.items, parsed).sum.okToSend, true);
  const kem = p.items.find(x => x.mode === "kem-don-vi");
  const tamper = (f) => { const its = JSON.parse(JSON.stringify(p.items)); f(its); return NWC.summarize(its, parsed); };
  const a = tamper(its => { its.find(x => x.mode === "kem-don-vi").send.quantity = 6; });
  eq(a.sum.predMismatch, 1); eq(a.bySp[0].diff, -1); eq(a.sum.okToSend, false);
  const b = tamper(its => { its.find(x => x.mode === "tho").circaRate = 12; });
  eq(b.sum.predMismatch, 1); eq(b.bySp[0].diff, -2); eq(b.sum.okToSend, false);
  const c = tamper(its => { its.find(x => x.mode === "kem-don-vi").send.unit_name = "hộp"; });
  eq(c.sum.predMismatch, 1); eq(c.sum.okToSend, false);
  eq(NWC.predictBase(kem), 5);
});

// parseSession
const R = (o) => Object.assign({ "Mã SP": "CIRCA-1", "Tên sản phẩm": "SP 1", "EPC": "", "UID": "", "Số lượng thẻ": "10", "ĐVT": "viên", "Trạng thái": "Đã quét" }, o);
t("parseSession: đọc cột, Mã SP bỏ tiền tố, SL thành số", () => {
  const p = NWC.parseSession([R({ EPC: " A51A01 ", UID: "A51A01", "Mã SP": "CIRCA-5085", "Số lượng thẻ": " 7 " }), R({ EPC: "A2", "Mã SP": 77, "Số lượng thẻ": 3 }), R({ EPC: "A3", "Mã SP": "88" })], []);
  eq(p.tags.length, 3); eq(p.errors.length, 0);
  deq([p.tags[0].epc, p.tags[0].pid, p.tags[0].nwQty, p.tags[0].nwUnit], ["A51A01", 5085, 7, "viên"]);
  eq(p.tags[1].pid, 77); eq(p.tags[2].pid, 88); eq(p.tags[1].nwQty, 3);
});
t("parseSession: SL không phải số nguyên dương → errors sl-sai", () => {
  const bad = ["0", "-1", "abc", "", 2.5, 0, null, "1e3"];
  const p = NWC.parseSession(bad.map((q, i) => R({ EPC: "B" + i, "Số lượng thẻ": q })), []);
  eq(p.tags.length, 0); deq(p.errors.map(e => e.type), bad.map(() => "sl-sai"));
});
t("parseSession: SL có dấu ngăn nghìn/thập phân (1.000, 1,000, 1.5, 2,5) → lỗi rõ ràng kèm số dòng, không đoán", () => {
  const vals = ["1.000", "1,000", "1.5", "2,5", "1.000.000"];
  const p = NWC.parseSession(vals.map((q, i) => R({ EPC: "S" + i, "Số lượng thẻ": q })), []);
  eq(p.tags.length, 0);
  p.errors.forEach((e, i) => { eq(e.type, "sl-dau-phan-cach"); eq(e.row, i + 2); assert(e.msg.includes("Dòng " + (i + 2)) && e.msg.includes(vals[i]), e.msg); });
});
t("parseSession: thiếu EPC / Mã SP hỏng → errors", () => {
  const p = NWC.parseSession([R({ EPC: "" }), R({ EPC: "C1", "Mã SP": "FOO-1" }), R({ EPC: "C2", "Mã SP": "" })], []);
  deq(p.errors.map(e => e.type), ["thieu-epc", "ma-sp-sai", "ma-sp-sai"]);
});
t("parseSession: Trạng thái ≠ 'Đã quét' → skipped (và chặn okToSend); không có cột → lấy hết", () => {
  const p = NWC.parseSession([R({ EPC: "D1" }), R({ EPC: "D2", "Trạng thái": "Chưa quét" }), R({ EPC: "D3", "Trạng thái": " đã QUÉT " })], []);
  deq(p.tags.map(x => x.epc), ["D1", "D3"]); eq(p.skipped.length, 1); eq(p.skipped[0].reason, "trang-thai");
  eq(NWC.plan(p, { D1: VIEN_HOP10(1), D3: VIEN_HOP10(1) }).sum.okToSend, false);
  const rows = [R({ EPC: "D4" }), R({ EPC: "D5" })].map(r => { delete r["Trạng thái"]; return r; });
  eq(NWC.parseSession(rows, []).tags.length, 2);
});
t("parseSession: trùng EPC giống hệt (khác hoa thường) → giữ dòng đầu, skipped", () => {
  const p = NWC.parseSession([R({ EPC: "abc1", UID: "u1" }), R({ EPC: "ABC1", UID: "U1" })], []);
  eq(p.tags.length, 1); eq(p.tags[0].epc, "abc1"); eq(p.errors.length, 0); eq(p.skipped[0].reason, "trung-epc-giong");
});
t("parseSession + plan: trùng EPC khác số liệu → giữ CẢ HAI dòng, mode giu, không vào lô", () => {
  const p = NWC.parseSession([R({ EPC: "E1", "Số lượng thẻ": "10" }), R({ EPC: "e1", "Số lượng thẻ": "20" }), R({ EPC: "F1" })], []);
  eq(p.tags.length, 3); eq(p.errors.length, 0); eq(p.skipped.length, 0);
  assert(p.tags[0].hold && p.tags[1].hold && !p.tags[2].hold);
  const w = p.warnings.find(x => x.type === "trung-epc-khac"); deq(w.rows, [2, 3]);
  const P = NWC.plan(p, { E1: VIEN_HOP10(1), F1: VIEN_HOP10(1) });
  deq(P.items.map(x => x.mode), ["giu", "giu", "tho"]);
  eq(P.bySp[0].holdBase, 30); eq(P.sum.okToSend, true);
  deq(NWC.batches(P.items, "S", "D").flatMap(NWC.bodyCodes), ["F1"]);
});
t("parseSession: 2 dòng giống + 1 dòng khác cùng EPC → 1 skipped, 2 dòng giữ", () => {
  const p = NWC.parseSession([R({ EPC: "G1" }), R({ EPC: "G1" }), R({ EPC: "G1", "Số lượng thẻ": "5" })], []);
  eq(p.skipped.length, 1); eq(p.tags.length, 2); assert(p.tags.every(x => x.hold));
});
t("parseSession: tên cột lệch hoa thường / khoảng trắng vẫn đọc", () => {
  const p = NWC.parseSession([{ " mã sp ": "CIRCA-9", "epc": "F1", "uid": "", "SỐ LƯỢNG THẺ": "4", "đvt": "gói", "trạng thái": "Đã quét" }], []);
  eq(p.tags.length, 1); eq(p.tags[0].pid, 9); eq(p.tags[0].nwQty, 4); eq(p.tags[0].nwUnit, "gói");
});
t("parseSession: thẻ lạ lọc trùng/rỗng, so với cả EPC lẫn UID thẻ đã quét (không phân biệt hoa thường)", () => {
  const p = NWC.parseSession([R({ EPC: "G1", UID: "UG1" }), R({ EPC: "G2", UID: "G2" })],
    [{ EPC: "X1", "Lý do": "Chưa đăng ký" }, { EPC: "x1" }, { EPC: "" }, { EPC: "g1" }, { EPC: "ug1" }, { EPC: "G2" }]);
  deq(p.strange, ["X1", "g1", "ug1", "G2"]);
  const w = p.warnings.filter(x => x.type === "the-la-trung-the-da-quet").map(x => x.epc);
  deq(w, ["g1", "ug1", "G2"]);
});
t("parseSession: UID trùng giữa 2 EPC → warning trung-ma", () => {
  const p = NWC.parseSession([R({ EPC: "H1", UID: "UH" }), R({ EPC: "H2", UID: "uh" })], []);
  assert(p.warnings.some(w => w.type === "trung-ma"));
});
t("parseSession: cột 'Thực tế nhập' khác rỗng → warning (vẫn dùng Số lượng thẻ)", () => {
  const p = NWC.parseSession([R({ EPC: "I1", "Thực tế nhập": "" }), R({ EPC: "I2", "Thực tế nhập": "7" }), R({ EPC: "I3", "Thực tế nhập": 0 })], []);
  deq(p.warnings.filter(w => w.type === "thuc-te-nhap").map(w => w.epc), ["I2", "I3"]);
  eq(p.tags[1].nwQty, 10);
});
t("parseSession: thiếu cột bắt buộc → errors thieu-cot", () => {
  const p = NWC.parseSession([{ "Mã SP": "CIRCA-1", "EPC": "H1" }], []);
  assert(p.errors.some(e => e.type === "thieu-cot" && /Số lượng thẻ/.test(e.msg)));
});

// batches
function mkItems(n, opt) {
  opt = opt || {};
  const out = [];
  for (let i = 0; i < n; i++) {
    const code = "C" + String(i).padStart(4, "0");
    const kem = opt.kem || (opt.mix && i % 3 === 1);
    out.push({ epc: "E" + code, uid: code, code, pid: 1, nwQty: 5, mode: kem ? "kem-don-vi" : "tho", send: kem ? { tag: code, unit_name: "viên", quantity: 5 } : code, expectBase: 5 });
    if (opt.holds && i % 7 === 0) out.push({ epc: "H" + i, code: null, pid: 1, nwQty: 5, mode: ["giu", "khong-nhan", "chua-tra"][i % 3], send: null, expectBase: 0 });
  }
  return out;
}
for (const [n, nb] of [[0, 0], [1, 1], [100, 1], [101, 2], [250, 3]]) {
  t(`batches: ${n} mã → ${nb} lô, mỗi lô ≤ 100, đủ mã, thứ tự ổn định, không trùng (trộn tags/items, chen thẻ không gửi)`, () => {
    const items = mkItems(n, { mix: true, holds: true });
    const b = NWC.batches(items, "SID", "DEV");
    eq(b.length, nb); deq(b.excluded, []);
    const sendable = items.filter(x => x.mode === "tho" || x.mode === "kem-don-vi");
    let all = [];
    b.forEach((body, i) => {
      eq(body.session_id, "SID"); eq(body.device_id, "DEV");
      const codes = NWC.bodyCodes(body);
      assert(codes.length <= 100 && codes.length > 0);
      const slice = sendable.slice(i * 100, i * 100 + 100);
      const tg = slice.filter(x => x.mode === "tho").map(x => x.code), im = slice.filter(x => x.mode === "kem-don-vi").map(x => ({ tag: x.code, unit_name: "viên", quantity: 5 }));
      deq(Object.keys(body), ["session_id", "device_id"].concat(tg.length ? ["tags"] : [], im.length ? ["items"] : []));
      if (tg.length) deq(body.tags, tg);
      if (im.length) deq(body.items, im);
      deq(NWC.itemsFor(body, items).map(x => x.code).sort(), slice.map(x => x.code).sort());
      all = all.concat(codes);
    });
    eq(all.length, sendable.length);
    eq(new Set(all).size, all.length);
    if (n === 250) deq(b.map(x => NWC.bodyCodes(x).length), [100, 100, 50]);
  });
}
t("batches: lô chỉ có thô → không có khoá items; lô chỉ có kèm đơn vị → không có khoá tags", () => {
  const a = NWC.batches(mkItems(3), "S", "D");
  deq(Object.keys(a[0]), ["session_id", "device_id", "tags"]);
  const b = NWC.batches(mkItems(3, { kem: true }), "S", "D");
  deq(Object.keys(b[0]), ["session_id", "device_id", "items"]);
  assert(!JSON.stringify(a).includes("\"items\"") && !JSON.stringify(b).includes("\"tags\""));
});
t("batches: mã đã có trong phiên (chuỗi / lượt quét, khác hoa thường) → loại khỏi lô, báo riêng; mã kia của cùng thẻ có trong phiên → cũng loại", () => {
  const items = mkItems(105);
  const b = NWC.batches(items, "S", "D", [{ qr_code: "c0001" }, "C0002", "EC0003"]);
  deq(b.excluded.map(x => [x.code, x.why, x.matched]), [["C0001", "da-co", "C0001"], ["C0002", "da-co", "C0002"], ["C0003", "ma-khac-da-co", "EC0003"]]);
  const all = b.flatMap(NWC.bodyCodes);
  eq(all.length, 102); assert(!all.includes("C0001") && !all.includes("C0003"));
  deq(b.map(x => NWC.bodyCodes(x).length), [100, 2]);
  const s = NWC.batches(items, "S", "D", new Set(["C0004"]));
  eq(s.excluded.length, 1);
});
t("batches: mã trùng khác hoa thường → ném lỗi", () => {
  const it = mkItems(2); it[1].code = it[1].send = it[0].code.toLowerCase();
  assert.throws(() => NWC.batches(it, "S", "D"), /trùng/);
});
t("batches: thiếu session/device → ném lỗi; send không khớp code → ném lỗi", () => {
  assert.throws(() => NWC.batches(mkItems(1), "", "D"));
  assert.throws(() => NWC.batches(mkItems(1), "S", " "));
  const it = mkItems(1); it[0].send = "KHAC";
  assert.throws(() => NWC.batches(it, "S", "D"), /không khớp/);
});

// checkResponse
const BI = [
  { code: "OK1", epc: "OK1", pid: 1, mode: "tho", expectBase: 10 },
  { code: "SO1", epc: "SO1", pid: 1, mode: "kem-don-vi", expectBase: 8 },
  { code: "SP1", epc: "SP1", pid: 1, mode: "tho", expectBase: 10 },
  { code: "UNK1", epc: "UNK1", pid: 2, mode: "tho", expectBase: 10 },
  { code: "REJ1", epc: "REJ1", pid: 2, mode: "tho", expectBase: 10 },
  { code: "LOST1", epc: "LOST1", pid: 2, mode: "tho", expectBase: 10 },
];
const RS = (tag, pid, base, unit, qty) => ({ tag, product_id: pid, unit_name: unit || "hộp", quantity: qty || 1, base_quantity: base });
const DATA = (o) => Object.assign({ inserted: 0, duplicates: 0, unknown_tags: [], resolved_tags: [], rejected_tags: [] }, o);
t("checkResponse: đủ 6 loại kết quả; so mã không phân biệt hoa thường", () => {
  const data = DATA({ inserted: 3, unknown_tags: ["unk1"], resolved_tags: [RS("ok1", 1, 10), RS("SO1", 1, 48, "lốc"), RS("SP1", 7, 10)], rejected_tags: [{ tag: "REJ1", code: "SESSION_LOCKED", message: "khoá" }] });
  const c = NWC.checkResponse(BI, data);
  deq(c.rows.map(r => r.result), ["dung", "sai-so", "sai-sp", "khong-nhan", "tu-choi", "mat"]);
  eq(c.ok, false); eq(c.counts.countOk, true); eq(c.needScanCheck, false);
  eq(c.rows[0].confirmed, true);
  eq(c.rows[1].gotBase, 48); eq(c.rows[1].gotUnit, "lốc"); eq(c.rows[1].gotQty, 1);
  eq(c.rows[2].gotPid, 7); eq(c.rows[4].rejectCode, "SESSION_LOCKED");
  deq([c.counts.dung, c.counts["sai-so"], c.counts["sai-sp"], c.counts["khong-nhan"], c.counts["tu-choi"], c.counts.mat], [1, 1, 1, 1, 1, 1]);
});
t("checkResponse: tất cả đúng, duplicates 0 → ok, confirmed, counts.duplicates = 0", () => {
  const c = NWC.checkResponse(BI.slice(0, 1), DATA({ inserted: 1, resolved_tags: [RS("OK1", 1, 10)] }));
  eq(c.ok, true); eq(c.needScanCheck, false); eq(c.rows[0].confirmed, true); eq(c.counts.duplicates, 0);
});
t("checkResponse: duplicates > 0, không phải gửi lại → ok false, chưa xác nhận, needScanCheck", () => {
  const c = NWC.checkResponse(BI.slice(0, 2), DATA({ inserted: 1, duplicates: 1, resolved_tags: [RS("OK1", 1, 10), RS("SO1", 1, 8)] }));
  deq(c.rows.map(r => r.result), ["dung", "dung"]);
  eq(c.ok, false); eq(c.needScanCheck, true); eq(c.counts.duplicates, 1);
  assert(c.rows.every(r => r.confirmed === false));
});
t("checkResponse: duplicates > 0 với {resend:true} → ok có thể true nhưng needScanCheck true", () => {
  const c = NWC.checkResponse(BI.slice(0, 2), DATA({ inserted: 0, duplicates: 2, resolved_tags: [RS("OK1", 1, 10), RS("SO1", 1, 8)] }), { resend: true });
  eq(c.ok, true); eq(c.needScanCheck, true); assert(c.rows.every(r => r.confirmed === false));
  const bad = NWC.checkResponse(BI.slice(0, 2), DATA({ duplicates: 2, resolved_tags: [RS("OK1", 1, 10), RS("SO1", 1, 48)] }), { resend: true });
  eq(bad.ok, false); eq(bad.rows[1].result, "sai-so");
});
t("checkResponse: thiếu trường duplicates → coi như không xác nhận được", () => {
  const c = NWC.checkResponse(BI.slice(0, 1), { inserted: 1, resolved_tags: [RS("OK1", 1, 10)] });
  eq(c.ok, false); eq(c.needScanCheck, true); eq(c.counts.countOk, false); assert("duplicates" in c.counts);
});
t("checkResponse: inserted + duplicates ≠ resolved → ok false", () => {
  const c = NWC.checkResponse(BI.slice(0, 1), DATA({ inserted: 2, resolved_tags: [RS("OK1", 1, 10)] }));
  eq(c.rows[0].result, "dung"); eq(c.counts.countOk, false); eq(c.ok, false); eq(c.needScanCheck, true);
});
t("checkResponse: mã lạ trong response (không thuộc lô) → extra, ok false", () => {
  const c = NWC.checkResponse(BI.slice(0, 1), DATA({ inserted: 2, resolved_tags: [RS("OK1", 1, 10), RS("ZZZ", 1, 10)] }));
  eq(c.extra.length, 1); eq(c.extra[0].code, "ZZZ"); eq(c.ok, false);
});
t("checkResponse: một mã ở 2 danh sách hoặc lặp trong resolved → note, ok false", () => {
  const c = NWC.checkResponse(BI.slice(0, 1), DATA({ inserted: 2, unknown_tags: ["OK1"], resolved_tags: [RS("OK1", 1, 10), RS("ok1", 1, 48)] }));
  eq(c.rows[0].result, "sai-so"); assert(c.rows[0].note); eq(c.ok, false);
});
t("checkResponse: data rỗng/null → mọi dòng mat, ok false", () => {
  const c = NWC.checkResponse(BI.slice(0, 2), null);
  deq(c.rows.map(r => r.result), ["mat", "mat"]); eq(c.ok, false);
});

// reconcile
t("reconcile: chênh theo SP, ưu tiên kết quả khi gửi lại, thẻ không gửi, ghi vào SP khác", () => {
  const items = [
    { epc: "A", code: "A", pid: 1, name: "SP1", nwQty: 10, mode: "tho", expectBase: 10 },
    { epc: "B", code: "B", pid: 1, name: "SP1", nwQty: 8, mode: "kem-don-vi", expectBase: 8 },
    { epc: "C", code: "C", pid: 2, name: "SP2", nwQty: 5, mode: "tho", expectBase: 5 },
    { epc: "D", code: null, pid: 2, name: "SP2", nwQty: 7, mode: "giu", expectBase: 0, reason: "Khác đơn vị gốc" },
    { epc: "E", code: "E", pid: 3, name: "SP3", nwQty: 4, mode: "tho", expectBase: 4 },
    { epc: "F", code: "F", pid: 3, name: "SP3", nwQty: 4, mode: "tho", expectBase: 4 },
  ];
  const c1 = { rows: [
    { code: "A", result: "mat" }, { code: "b", result: "sai-so", gotBase: 48, gotUnit: "lốc" }, { code: "C", result: "dung", gotBase: 5 },
    { code: "E", result: "sai-sp", gotBase: 4, gotPid: 9 } ] };
  const c2 = { rows: [{ code: "A", result: "dung", gotBase: 10 }, { code: "B", result: "dung", gotBase: 8 }] };
  const r = NWC.reconcile(items, [c1, c2]);
  const [s1, s2, s3] = r.bySp;
  eq(s1.nwBase, 18); eq(s1.circaBase, 58); eq(s1.diff, -40); eq(s1.problems.length, 1); eq(s1.problems[0].status, "sai-so");
  eq(s2.nwBase, 12); eq(s2.circaBase, 5); eq(s2.diff, 7); eq(s2.diffSent, 0); eq(s2.notSentBase, 7); eq(s2.problems[0].status, "khong-gui");
  eq(s3.circaBase, 0); deq(s3.problems.map(p => p.status), ["sai-sp", "chua-gui"]);
  eq(r.sum.wrongSpBase, 4); eq(r.sum.ok, false);
  assert(/sai số/.test(s1.ketLuan));
});
t("reconcile: dòng 'dung' chưa xác nhận (duplicates) → chua-xac-nhan, không cộng vào circaBase, needScanCheck, ok false", () => {
  const items = [{ epc: "A", code: "A", pid: 1, nwQty: 10, mode: "tho", expectBase: 10 }];
  const c = NWC.checkResponse(items, DATA({ duplicates: 1, resolved_tags: [RS("A", 1, 10)] }), { resend: true });
  const r = NWC.reconcile(items, [c]);
  eq(r.bySp[0].status["chua-xac-nhan"], 1); eq(r.sum.circaBase, 0); eq(r.sum.unconfirmedBase, 10);
  eq(r.sum.needScanCheck, true); eq(r.sum.ok, false);
  // có một lần xác nhận trước đó (inserted) → lấy lần đó
  const c0 = NWC.checkResponse(items, DATA({ inserted: 1, resolved_tags: [RS("A", 1, 10)] }));
  const r2 = NWC.reconcile(items, [c0, c]);
  eq(r2.sum.circaBase, 10); eq(r2.sum.ok, true);
});
t("reconcile: tất cả đúng → chênh 0, ok", () => {
  const items = [{ epc: "A", code: "A", pid: 1, nwQty: 10, mode: "tho", expectBase: 10 }];
  const r = NWC.reconcile(items, [{ rows: [{ code: "A", result: "dung", confirmed: true, gotBase: 10 }] }]);
  eq(r.sum.diff, 0); eq(r.sum.ok, true); eq(r.bySp[0].ketLuan, "Khớp: Circa ghi đúng gốc NW");
});

// checkScans
const SC = (qr, pid, qty, unit, rate, dev) => ({ qr_code: qr, product_id: pid, scanned_qty: qty, unit_code: unit, conversion_factor: rate, base_qty: qty * rate, device_id: dev || "NW-RFID" });
const SI = [
  { epc: "E-OK", uid: "OK1", code: "OK1", pid: 1, name: "SP1", nwQty: 10, mode: "tho", expectBase: 10 },
  { epc: "SO1", uid: "", code: "SO1", pid: 1, name: "SP1", nwQty: 8, mode: "kem-don-vi", expectBase: 8 },
  { epc: "SP1", uid: "", code: "SP1", pid: 2, name: "SP2", nwQty: 10, mode: "tho", expectBase: 10 },
  { epc: "TH1", uid: "", code: "TH1", pid: 2, name: "SP2", nwQty: 10, mode: "tho", expectBase: 10 },
  { epc: "LAP1", uid: "", code: "LAP1", pid: 2, name: "SP2", nwQty: 10, mode: "tho", expectBase: 10 },
  { epc: "GIU1", uid: "", code: null, pid: 3, name: "SP3", nwQty: 6, mode: "giu", expectBase: 0 },
];
t("checkScans: dung / sai-so / sai-sp / thieu / lap; khớp mã không phân biệt hoa thường; chưa có lượt ngoài", () => {
  const scans = [SC("ok1", 1, 1, "hộp", 10), SC("SO1", 1, 1, "lốc", 48), SC("SP1", 9, 1, "hộp", 10), SC("LAP1", 2, 1, "hộp", 10), SC("lap1", 2, 1, "hộp", 10)];
  const r = NWC.checkScans(SI, scans);
  deq(r.rows.map(x => x.result), ["dung", "sai-so", "sai-sp", "thieu", "lap"]);
  deq(r.foreign, []); eq(r.ok, false);
  eq(r.rows[1].gotBase, 48); eq(r.rows[1].gotUnit, "lốc"); eq(r.rows[1].gotRate, 48); eq(r.rows[4].gotBase, 20);
  const by = Object.fromEntries(r.bySp.map(p => [p.pid, p]));
  eq(by[1].nwBase, 18); eq(by[1].circaBase, 58); eq(by[1].diff, -40);
  eq(by[2].nwBase, 30); eq(by[2].circaBase, 20); eq(by[2].diff, 10);
  eq(by[9].nwBase, 0); eq(by[9].circaBase, 10); eq(by[9].diff, -10);
  eq(by[3].notSentBase, 6); eq(by[3].diff, 6);
  deq(r.sum.counts, { dung: 1, "sai-so": 1, "sai-sp": 1, thieu: 1, lap: 1 });
});
t("checkScans: lượt ngoài kế hoạch (QR khác, mã EPC của thẻ đã gửi UID, mã của thẻ không gửi) → foreign, ok false kèm lý do riêng", () => {
  const items = SI.slice(0, 1).concat([{ epc: "GIU1", uid: "", code: null, pid: 3, name: "SP3", nwQty: 6, mode: "giu", expectBase: 0 }]);
  const scans = [SC("OK1", 1, 1, "hộp", 10), SC("E-OK", 1, 1, "hộp", 10), SC("giu1", 3, 6, "viên", 1), SC("QR-NV", 1, 2, "hộp", 10, "nhan-vien")];
  const r = NWC.checkScans(items, scans);
  deq(r.rows.map(x => x.result), ["dung"]);
  eq(r.foreign.length, 3); eq(r.ok, false);
  assert(/đếm đôi/.test(r.foreign[0].why)); eq(r.foreign[0].tagEpc, "E-OK");
  assert(/không gửi/.test(r.foreign[1].why)); assert(/Ngoài kế hoạch/.test(r.foreign[2].why));
  const by = Object.fromEntries(r.bySp.map(p => [p.pid, p]));
  eq(by[1].foreignBase, 30); eq(by[1].circaBase, 10); eq(by[1].diff, 10 - 10 - 30);
  eq(r.sum.foreignBase, 36);
  assert(r.sum.reasons.some(x => /lượt ngoài kế hoạch/.test(x) && /đếm đôi/.test(x)));
});
t("checkScans: mọi thẻ đúng, không lượt ngoài → ok; nhận dạng {data:{scans}}", () => {
  const items = SI.slice(0, 2);
  const r = NWC.checkScans(items, { data: { scans: [SC("OK1", 1, 1, "hộp", 10), SC("SO1", 1, 8, "miếng", 1)] } });
  eq(r.ok, true); eq(r.sum.diff, 0); deq(r.sum.reasons, []);
});

// sim: mã trùng trả SỐ ĐÃ LƯU (giả định ghi trong sim.js)
t("sim: gửi thô rồi gửi lại kèm đơn vị → duplicates, resolved trả số đã lưu 48; checkResponse(resend) bắt sai-so", () => {
  const lkp = { X: D(1, "lốc", [U("miếng", 1, true), U("lốc", 48)]) };
  const it = one(T("X", "", 1, 8, "miếng"), lkp);
  const S = sim.session();
  S.submit({ session_id: "S", device_id: "D", tags: ["X"] }, lkp);
  const d = S.submit(NWC.batches([it], "S", "D")[0], lkp);
  eq(d.duplicates, 1); eq(d.resolved_tags[0].base_quantity, 48);
  const c = NWC.checkResponse([it], d, { resend: true });
  eq(c.rows[0].result, "sai-so"); eq(c.ok, false);
  eq(NWC.checkScans([it], S.scans()).rows[0].result, "sai-so");
});

// ---------- Phần 2: dữ liệu thật ----------
console.log("== Phần 2: dữ liệu thật");
const W = path.join(ROOT, "work/20261121-nw-sang-circa-kiem-ke");
const XLSX_F = process.env.NWC_XLSX || path.join(W, "in/kiem-ke-lumina-2026-11-21-15-42.xlsx");
const QR_F = process.env.NWC_QR || path.join(W, "phien/qr-lookup.json");
const SCANS_F = process.env.NWC_SCANS || path.join(W, "phien/ics00240-scans.json");
const LOADER = path.join(ROOT, ".claude/skills/circa-nextwaves-check/scripts/kiem-dem/load-tool.js");
// 12 lượt quét đã lưu của phiên thử ICS00240 (PM đọc GET …/sessions/<id>/scans 21/11, chỉ đọc)
const ICS00240_FIXTURE = [
  ["1794655791190B91", 2020797, 1, "lốc", 48], ["1794037081630Y21", 1103068, 1, "lốc", 10], ["1794655782952B91", 2020797, 1, "gói", 8],
  ["1794655730924B91", 2020797, 8, "miếng", 1], ["1794038729833B51", 12813, 1, "hộp", 20], ["1794802820050Y21", 12823, 1, "hộp", 10],
  ["A51A1B5156F8D00000000414", 122531, 1, "hộp", 30], ["1794040158639B31", 14638, 1, "hộp", 1], ["1794446417599C11", 12829, 1, "hộp", 20],
  ["B51A1B510CC55000000004B2", 5085, 1, "hộp", 10], ["A51A1B5156F8D000000003F7", 12826, 1, "hộp", 10], ["A51A1B5156F8D00000000E0A", 12825, 1, "hộp", 50],
].map(([qr, pid, qty, unit, rate]) => SC(qr, pid, qty, unit, rate, "NW-RFID-THU"));
const real = [];
if (!fs.existsSync(XLSX_F) || !fs.existsSync(QR_F) || !fs.existsSync(LOADER)) {
  console.log("BỎ QUA dữ liệu thật: thiếu " + [XLSX_F, QR_F, LOADER].filter(f => !fs.existsSync(f)).join(", "));
} else {
  const { XLSX } = require(LOADER);
  const wb = XLSX.read(fs.readFileSync(XLSX_F), { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets["Chi tiết quét"], { defval: "" });
  const la = XLSX.utils.sheet_to_json(wb.Sheets["Thẻ lạ"], { defval: "" });
  const qr = JSON.parse(fs.readFileSync(QR_F, "utf8"));
  const ses = NWC.parseSession(rows, la);
  const lookups = NWC.lookupMap(qr.res);
  const P = NWC.plan(ses, lookups);
  const S = P.sum;
  const LECH = [2020797, 1012426, 1103068, 2945, 1792, 4011, 381200].sort((a, b) => a - b);
  const kem = P.items.filter(x => x.mode === "kem-don-vi");
  const kemSp = [...new Set(kem.map(x => x.pid))].sort((a, b) => a - b);
  const tho = P.items.filter(x => x.mode === "tho");
  const thoEpc = tho.filter(x => x.via === "EPC").length, thoUid = tho.filter(x => x.via === "UID").length;
  const sumRate = P.items.reduce((a, x) => a + (x.circaRate || 0), 0);
  const B = S.okToSend ? NWC.batches(P.items, "SESSION-GIA", "NW-RFID") : [];
  const allCodes = B.flatMap(NWC.bodyCodes);
  let scans, scansFrom;
  if (fs.existsSync(SCANS_F)) {
    const j = JSON.parse(fs.readFileSync(SCANS_F, "utf8"));
    scans = Array.isArray(j) ? j : (j.scans || (j.data && j.data.scans) || []);
    scansFrom = SCANS_F;
  } else { scans = ICS00240_FIXTURE; scansFrom = "fixture 12 lượt trong test.js (chưa có " + SCANS_F + ")"; }
  console.log("Lượt quét ICS00240: " + scansFrom);
  const CS = NWC.checkScans(P.items, scans);
  real.push(["thẻ", 604, ses.tags.length], ["SP", 279, new Set(ses.tags.map(x => x.pid)).size], ["tổng gốc NW", 11630, ses.tags.reduce((a, x) => a + x.nwQty, 0)],
    ["thẻ lạ", 14, ses.strange.length], ["lỗi / bỏ qua / cảnh báo parse", "0/0/0", [ses.errors.length, ses.skipped.length, ses.warnings.length].join("/")],
    ["tho", 565, tho.length], ["tho qua EPC", 481, thoEpc], ["tho qua UID", 84, thoUid],
    ["kem-don-vi", 39, kem.length], ["SP kem-don-vi", LECH.join(","), kemSp.join(",")], ["giu", 0, S.modes.giu], ["khong-nhan", 0, S.modes["khong-nhan"]],
    ["chua-tra", 0, S.modes["chua-tra"]], ["tổng expectBase", 11630, S.sendBase], ["tổng gốc dự tính theo payload", 11630, S.predBase],
    ["tổng gốc nếu gửi thô", 12754, sumRate], ["okToSend", true, S.okToSend], ["số lô", 7, B.length], ["lô có khoá items", 3, B.filter(b => "items" in b).length],
    ["mã trong các lô", 604, allCodes.length], ["mã trùng", 0, allCodes.length - new Set(allCodes.map(NWC._codeKey)).size],
    ["checkScans ICS00240: dung", 10, CS.sum.counts.dung], ["checkScans ICS00240: sai-so", 2, CS.sum.counts["sai-so"]],
    ["checkScans ICS00240: thieu", 592, CS.sum.counts.thieu], ["checkScans ICS00240: foreign", 0, CS.foreign.length]);

  t("thật: parse 604 thẻ / 279 SP / 11.630 gốc / 14 thẻ lạ / 0 lỗi, 0 bỏ qua, 0 cảnh báo", () => {
    eq(ses.tags.length, 604); eq(new Set(ses.tags.map(x => x.pid)).size, 279);
    eq(ses.tags.reduce((a, x) => a + x.nwQty, 0), 11630); eq(ses.strange.length, 14);
    eq(ses.errors.length, 0); eq(ses.skipped.length, 0); eq(ses.warnings.length, 0);
  });
  t("thật: gốc Circa dự tính theo payload theo SP = 'Đã đếm' theo SP của sheet 'Danh sách kiểm kê' (nguồn độc lập), Thủ công = 0", () => {
    const ds = XLSX.utils.sheet_to_json(wb.Sheets["Danh sách kiểm kê"], { defval: "" });
    const dem = {};
    let thuCong = 0;
    ds.forEach(r => { const pid = +String(r["Mã SP"]).replace(/^CIRCA-/i, ""); if (+r["Đã đếm"]) dem[pid] = (dem[pid] || 0) + +r["Đã đếm"]; thuCong += +r["Thủ công"] || 0; });
    eq(thuCong, 0);
    deq(Object.keys(dem).sort(), P.bySp.map(p => String(p.pid)).sort());
    P.bySp.forEach(p => { eq(dem[p.pid], p.predBase + p.holdBase, "SP " + p.pid); eq(p.predMismatch, 0, "SP " + p.pid); });
  });
  t("thật: 481 thẻ EPC = UID (A51A/B51A), 123 thẻ E280 có UID riêng", () => {
    eq(ses.tags.filter(x => NWC.lookupCodes(x).length === 1 && /^[AB]51A/.test(x.epc)).length, 481);
    eq(ses.tags.filter(x => NWC.lookupCodes(x).length === 2 && /^E280/.test(x.epc)).length, 123);
  });
  t("thật: plan 565 tho (481 EPC + 84 UID), 39 kem-don-vi thuộc đúng 7 SP, không giu/khong-nhan/chua-tra", () => {
    eq(tho.length, 565); eq(thoEpc, 481); eq(thoUid, 84); eq(kem.length, 39); deq(kemSp, LECH);
    eq(S.modes.giu, 0); eq(S.modes["khong-nhan"], 0); eq(S.modes["chua-tra"], 0);
  });
  t("thật: thẻ E280 gửi bằng UID, thẻ A51A/B51A gửi bằng EPC", () => {
    P.items.forEach(x => { if (/^E280/.test(x.epc)) eq(x.via, "UID", x.epc); else eq(x.via, "EPC", x.epc); });
  });
  t("thật: tổng expectBase = gốc dự tính = 11.630, okToSend, không lý do chặn, không mã trùng / va chạm", () => {
    eq(S.sendBase, 11630); eq(S.predBase, 11630); eq(S.predMismatch, 0);
    eq(S.okToSend, true); deq(S.blockers, []); deq(S.dupCodes, []); deq(S.codeClash, []);
  });
  t("thật: gửi thô hết sẽ ra 12.754", () => eq(sumRate, 12754));
  t("thật: 7 lô, 604 mã, không mã trùng, thẻ lạ không vào lô, lô 4–7 không có khoá items", () => {
    eq(B.length, 7); eq(allCodes.length, 604); eq(new Set(allCodes.map(NWC._codeKey)).size, 604);
    const st = new Set(ses.strange.map(NWC._codeKey));
    assert(allCodes.every(c => !st.has(NWC._codeKey(c))));
    assert(B.every(b => NWC.bodyCodes(b).length <= 100));
    deq(B.map(b => "items" in b), [true, true, true, false, false, false, false]);
    assert(B.every(b => "tags" in b));
  });
  t("thật: chia lô loại 12 mã đã có trong ICS00240 → 592 mã, 6 lô, 12 mã báo riêng", () => {
    const b = NWC.batches(P.items, "SESSION-GIA", "NW-RFID", scans);
    eq(b.excluded.length, 12); assert(b.excluded.every(x => x.why === "da-co"));
    eq(b.flatMap(NWC.bodyCodes).length, 592); eq(b.length, 6);
  });
  t("thật: checkScans kế hoạch 604 thẻ với 12 lượt thật ICS00240 → 10 dung, 2 sai-so (48, 10), 592 thieu, 0 foreign, ok false", () => {
    eq(CS.sum.counts.dung, 10); eq(CS.sum.counts["sai-so"], 2); eq(CS.sum.counts.thieu, 592);
    eq(CS.sum.counts["sai-sp"], 0); eq(CS.sum.counts.lap, 0); eq(CS.foreign.length, 0); eq(CS.ok, false);
    const bad = CS.rows.filter(r => r.result === "sai-so").map(r => [r.code, r.gotBase, r.expectBase]);
    deq(bad, [["1794655791190B91", 48, 8], ["1794037081630Y21", 10, 1]]);
    const by = Object.fromEntries(CS.bySp.map(p => [p.pid, p]));
    eq(by[2020797].circaBase, 64); eq(by[2020797].nwBase, 40); eq(by[1103068].circaBase, 10);
  });

  // ---------- ĐƯỜNG ỐNG (sim.js, không phải kiểm số Circa) ----------
  const S1 = sim.session();
  const checks = B.map(b => NWC.checkResponse(NWC.itemsFor(b, P.items), S1.submit(b, lookups)));
  t("đường ống: gửi theo kế hoạch → mọi lô ok, reconcile ok, checkScans ok 604 dung, phiên = 11.630", () => {
    assert(checks.every(c => c.ok && !c.needScanCheck), "có lô không ok");
    const rec = NWC.reconcile(P.items, checks);
    eq(rec.sum.circaBase, 11630); eq(rec.sum.ok, true);
    const cs = NWC.checkScans(P.items, S1.scans());
    eq(cs.ok, true); eq(cs.sum.counts.dung, 604); eq(cs.sum.circaBase, 11630); eq(cs.sum.diff, 0);
  });
  const checks2 = B.map(b => NWC.checkResponse(NWC.itemsFor(b, P.items), S1.submit(b, lookups)));
  const checks2r = B.map(b => NWC.checkResponse(NWC.itemsFor(b, P.items), S1.submit(b, lookups), { resend: true }));
  t("đường ống: gửi lại cùng lô → toàn duplicates; không resend → ok false; resend → ok + needScanCheck; reconcile chỉ lần gửi lại → chưa xác nhận", () => {
    eq(checks2.reduce((a, c) => a + c.counts.duplicates, 0), 604);
    assert(checks2.every(c => !c.ok && c.needScanCheck));
    assert(checks2r.every(c => c.ok && c.needScanCheck));
    const r = NWC.reconcile(P.items, checks2r);
    eq(r.sum.circaBase, 0); eq(r.sum.unconfirmedBase, 11630); eq(r.sum.needScanCheck, true); eq(r.sum.ok, false);
    eq(NWC.reconcile(P.items, checks.concat(checks2r)).sum.ok, true);
    eq(NWC.checkScans(P.items, S1.scans()).ok, true);
  });
  const S2 = sim.session(scans);
  const checks3 = B.map(b => NWC.checkResponse(NWC.itemsFor(b, P.items), S2.submit(b, lookups)));
  t("đường ống: gửi đủ kế hoạch vào phiên đã có 12 lượt ICS00240 (không loại) → lô có mã trùng ok false; checkScans bắt 2 sai-so", () => {
    eq(checks3.reduce((a, c) => a + c.counts.duplicates, 0), 12);
    assert(checks3.some(c => !c.ok));
    const cs = NWC.checkScans(P.items, S2.scans());
    eq(cs.sum.counts.dung, 602); eq(cs.sum.counts["sai-so"], 2); eq(cs.ok, false);
    eq(cs.sum.circaBase, 11630 + 40 + 9);
  });
  const S3 = sim.session();
  const rawChecks = B.map(b => NWC.checkResponse(NWC.itemsFor(b, P.items), S3.submit(b, lookups, { raw: true })));
  const rawBad = rawChecks.flatMap(c => c.rows).filter(r => r.result === "sai-so");
  const rawScan = NWC.checkScans(P.items, S3.scans());
  real.push(["đường ống gửi thô hết: sai-so (response)", 39, rawBad.length], ["đường ống gửi thô hết: sai-so (scans)", 39, rawScan.sum.counts["sai-so"]],
    ["đường ống gửi thô hết: phiên ghi", 12754, rawScan.sum.circaBase]);
  t("đường ống GỬI THÔ HẾT: checkResponse và checkScans cùng bắt 39 sai-so (= 39 thẻ kem-don-vi), phiên = 12.754, lệch ở đúng 7 SP", () => {
    eq(rawBad.length, 39);
    deq(rawBad.map(r => r.code).sort(), kem.map(x => x.code).sort());
    eq(rawScan.sum.counts["sai-so"], 39); eq(rawScan.sum.counts.dung, 565); eq(rawScan.sum.circaBase, 12754);
    deq(rawScan.bySp.filter(p => p.diff !== 0).map(p => p.pid).sort((a, b) => a - b), LECH);
  });

  // ---------- đối chiếu 2 lần gửi thử thật (records/pos-writes) ----------
  const REC = path.join(ROOT, "records/pos-writes");
  const base1 = path.join(REC, "20261121-ICS00240-thu-1-tho"), base2 = path.join(REC, "20261121-ICS00240-thu-2-lech");
  const byCode = {};
  P.items.forEach(x => { if (x.code) byCode[NWC._codeKey(x.code)] = x; });
  const fromPayload = body => NWC.bodyCodes(body).map(c => byCode[NWC._codeKey(c)]).filter(Boolean);
  if (fs.existsSync(base1 + ".record.json") && fs.existsSync(base1 + ".payload.json")) {
    const pl = JSON.parse(fs.readFileSync(base1 + ".payload.json", "utf8")).body;
    const rec = JSON.parse(fs.readFileSync(base1 + ".record.json", "utf8"));
    t("thật: gửi thử 1 (payload 9 mã thô: 8 thẻ plan + 1 thẻ lạ): lần 1 → 8 dung đã xác nhận, thẻ lạ ra extra; lần 2 (8 duplicates) → không xác nhận, needScanCheck", () => {
      const its = fromPayload(pl);
      eq(NWC.bodyCodes(pl).length, 9); eq(its.length, 8); assert(its.every(x => x.mode === "tho"));
      const c1 = NWC.checkResponse(its, rec.lan1.j.data);
      eq(c1.counts.dung, 8); assert(c1.rows.every(r => r.confirmed)); deq(c1.extra.map(x => x.list), ["unknown_tags"]); eq(c1.needScanCheck, false);
      const c2 = NWC.checkResponse(its, rec.lan2.j.data, { resend: true });
      eq(c2.counts.duplicates, 8); eq(c2.needScanCheck, true); assert(c2.rows.every(r => !r.confirmed));
    });
  } else console.log("BỎ QUA đối chiếu gửi thử 1: thiếu " + base1 + ".*");
  if (fs.existsSync(base2 + ".record.json") && fs.existsSync(base2 + ".payload.json")) {
    const pl = JSON.parse(fs.readFileSync(base2 + ".payload.json", "utf8")).body;
    const d2 = JSON.parse(fs.readFileSync(base2 + ".record.json", "utf8")).j.data;
    t("thật: gửi thử 2: plan kem-don-vi cho cả 4 mã; response thật: 2 mã gửi thô = sai-so (48, 10), 2 mã gửi kèm đơn vị = dung (8, 8)", () => {
      const its = fromPayload(pl);
      deq(its.map(x => x.code), ["1794655791190B91", "1794037081630Y21", "1794655782952B91", "1794655730924B91"]);
      assert(its.every(x => x.mode === "kem-don-vi"));
      deq(byCode["1794655730924B91"].send, { tag: "1794655730924B91", unit_name: "miếng", quantity: 8 });
      const c = NWC.checkResponse(its, d2);
      deq(c.rows.map(r => r.result), ["sai-so", "sai-so", "dung", "dung"]);
      deq(c.rows.map(r => r.gotBase), [48, 10, 8, 8]); deq(c.rows.map(r => r.expectBase), [8, 1, 8, 8]);
    });
  } else console.log("BỎ QUA đối chiếu gửi thử 2: thiếu " + base2 + ".*");
}

// ---------- tóm tắt ----------
console.log("\n== Tóm tắt");
if (real.length) {
  console.log("Số liệu thật (kỳ vọng theo đặc tả | thực tế):");
  real.forEach(([k, want, got]) => console.log("  " + (String(want) === String(got) ? "  " : "≠ ") + k.padEnd(42) + String(want).padStart(10) + " | " + got));
}
console.log(`${pass} đạt, ${fail} lỗi` + (fail ? ":\n  - " + failures.join("\n  - ") : ""));
process.exitCode = fail ? 1 : 0;
