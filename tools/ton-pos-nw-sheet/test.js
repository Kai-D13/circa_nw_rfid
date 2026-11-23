// Test cho Code.gs (Tồn POS ↔ NW). CHỈ ĐỌC: không gọi mạng; chỉ đọc file đã kéo và ghi CSV kết quả vào work/…/out/.
// Nạp Code.gs bằng vm với stub các global Apps Script.
//   node tools/ton-pos-nw-sheet/test.js
// Phần:
//   A. unit cho hàm thuần (luôn chạy)
//   M. giả lập Apps Script (UrlFetchApp/SpreadsheetApp giả): menu 2, menu 3, thử lại, 401, lỗi giữa chừng không ghi
//   B. dữ liệu thật (nếu có file trong DATA_DIR/phien): chạy dungBang → out/ton-pos-nw-<LABEL>.csv, in số liệu theo nguồn
//      quy đổi, 10 dòng đoán từ tên nhiều tem nhất; so ratioFor port với KiemDem.ratioFor trên mọi tên SP thật (POS + master);
//      chạy lại với master ngày 17/11 (MASTER_1711, mặc định work/20261122-luu-scratchpad/kd-input2/master2.xlsx)
//      → out/ton-pos-nw-<LABEL>-master1711.csv; NW Florita/Lumina trong phien/overview-all.json: không dòng 0/0 nào lọt ra
//   C. đối chiếu phần POS với file xuất trang POS (DATA_DIR/in/ton-kho-7.xlsx, env XLSX_POS để đổi)
//   D. đối chiếu total_rfid_need_print + quy_doi với E của tool Kiểm đếm v2 (KD2.build) cho mọi SP một seller
// Env: DATA_DIR (mặc định work/20261124-ton-pos-nw-sheet), LABEL (mặc định tamviet), XLSX_POS.
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.resolve(__dirname, "../..");
const KD_DIR = path.join(ROOT, ".claude/skills/circa-nextwaves-check/scripts/kiem-dem");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "work/20261124-ton-pos-nw-sheet");
const LABEL = process.env.LABEL || "tamviet";
const CODE = fs.readFileSync(path.join(__dirname, "Code.gs"), "utf8");

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log("  FAIL:", msg); } }
function eq(a, b, msg) { const A = JSON.stringify(a), B = JSON.stringify(b); ok(A === B, msg + " — được " + A + ", cần " + B); }
function throwsLike(fn, re, msg) { try { fn(); ok(false, msg + " — không ném lỗi"); } catch (e) { ok(re.test(e.message), msg + " — lỗi: " + e.message); } }

// ---------- nạp Code.gs ----------
function load(stubs) {
  const ctx = Object.assign({ console }, stubs || {});
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx, { filename: "Code.gs" });
  return ctx;
}
const C = load();

// ---------- tiện ích dựng dữ liệu ----------
function posRow(pid, seller, oh, av, items, extra) {
  return Object.assign({ sku: seller + "." + pid, product_id: pid, product_name: "SP " + pid, base_unit: "viên", on_hand_qty: oh, available_qty: av, seller_code: seller, items: items || [] }, extra || {});
}
function it(loc, oh, av) { return { location_name: loc, on_hand_qty: oh, available_qty: av == null ? oh : av, details: [] }; }
function nwItem(idf, q, e, extra) { return Object.assign({ productTitle: "NW " + idf, productIdentifier: idf, baseUnitOfMeasure: "viên", warehouseName: "KHO X", quantity: q, epcCount: e }, extra || {}); }
const V4H = ["product_id", "product_name", "convert_unit", "convert_rate", "final_unit_print"];
const ADH = ["product_id", "product_name", "volumes", "product_category", "final_level_print", "name_tag", "final_quantity_rfid_print", "final_unit_print", "combine_unit"];
function adCombine(list) { return list.map(([u, r]) => "UNIT: " + u + "\nCONVERT RATE: " + r + "\nBASE UNIT: " + (r === 1) + "\nLEVEL: x").join("\n---\n"); }
const STORE = { code: "POS0059", name: "CIRCA TAM VIET" };
function rowOf(res, pid, seller) { return res.rows.find(r => String(r[2]) === String(pid) && (seller == null || (r[4] === "CIRCA") === (seller === "CIRCA"))); }

// =====================================================================================================
console.log("A. Unit hàm thuần");
// --- master ---
{
  const v4 = [V4H,
    [1109, "Diacerein (hộp/100 viên)", "hộp", 100, "hộp"], [1109, "", "viên", 1, "hộp"],
    [82278, "x (h/20v)", "hộp", 20, "hộp"], [82278, "", "viên", "1", "hộp"],
    [500, "y", "hộp", 30, "chai"], [500, "", "viên", 1, "chai"],        // in theo chai nhưng master không có chai → null
    [600, "z", "lọ", 1, "hũ"], [600, "", "hũ", 1, "hũ"],               // SAME_UNIT: tồn theo hũ/lọ
    [700, "w", "hộp", 10, "hộp"], [700, "", "vỉ", 1, "hộp"],            // tồn "viên" không có trong master, base duy nhất = vỉ
    [800, "a", "hộp", "1,200", "hộp"], [800, "", "viên", 1, "hộp"],      // số có dấu phẩy nghìn (gviz) → 1200
    [900, "b", "", 5, "hộp"], [901, "c", "hộp", 0, "hộp"]];             // thiếu unit / rate 0 → bỏ
  const ad = [ADH,
    [82278, "x", "", "", "level 2", "chai", "", "", adCombine([["hộp", 20], ["chai", 5], ["viên", 1]])], // Adhoc ghi đè: in theo chai 5 viên
    [1000, "m", "", "", "level 1", "gói", "", "8", adCombine([["lốc", 64], ["gói", 8], ["miếng", 1]])],
    [1001, "n", "", "", "level 1", "túi", "", "", adCombine([["gói", 8]])],  // không có ô in nào trùng UNIT → không ghi
    ["", "rỗng", "", "", "", "", "", "", ""]];
  const M = C.loadMaster(v4, ad);
  const mr = (pid, u) => { const e = M.get(String(pid)); return e ? C.masterRatio(e, u) : null; };
  eq(mr(1109, "viên"), ["hộp", 100, ""], "master 1109 hộp=100 viên");
  eq(M.get("82278").src, "Adhoc", "Adhoc ghi đè 82278");
  eq(mr(82278, "viên"), ["chai", 5, ""], "82278 sau Adhoc: chai = 5 viên");
  eq(mr(500, "viên"), null, "đơn vị in không có trong units → null");
  eq(mr(600, "lọ")[1], 1, "SAME_UNIT lọ/hũ");
  eq(mr(700, "viên"), ["hộp", 10, "master không có viên, tính theo vỉ (hộp=10, vỉ=1)"], "master không có đơn vị tồn → theo base duy nhất");
  eq(mr(800, "viên")[1], 1200, "convert_rate '1,200' → 1200");
  ok(!M.has("900") && !M.has("901"), "dòng thiếu unit / rate 0 bị bỏ");
  eq(mr(1000, "miếng"), ["gói", 8, ""], "Adhoc: đơn vị in = name_tag gói");
  ok(!M.has("1001"), "Adhoc không có ô in trùng UNIT → bỏ");
  throwsLike(() => C.loadMaster([["id", "x"]], ad), /thiếu cột product_id/, "master thiếu cột");
  throwsLike(() => C.loadMaster(v4, [["product_id", "x"]]), /combine_unit/, "Adhoc thiếu combine_unit");
  throwsLike(() => C.loadMaster(v4, []), /Adhoc/, "Adhoc trống");
  // port phải giống KiemDem.loadMaster + masterRatio (cùng dữ liệu, dạng chữ như gviz)
  const { XLSX, KiemDem } = require(path.join(KD_DIR, "load-tool.js"));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(v4.map(r => r.map(String))), "final data v4");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ad.map(r => r.map(String))), "Adhoc");
  const K = KiemDem.loadMaster(wb);
  eq(masterSig(M), masterSig(K), "loadMaster port = KiemDem.loadMaster (synthetic)");
  for (const [pid, u] of [[1109, "viên"], [82278, "viên"], [500, "viên"], [600, "lọ"], [700, "viên"], [800, "viên"], [1000, "miếng"]])
    eq(mr(pid, u), K.get(String(pid)) ? KiemDem.masterRatio(K.get(String(pid)), u) : null, "masterRatio = KiemDem " + pid);
}
function masterSig(M) { return Array.from(M.entries()).sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, e]) => [k, e.print, e.src, Array.from(e.units.entries()).sort()]); }

// --- công thức ---
eq([C.soTem(215, 20), C.soTem(180, 100), C.soTem(200, 100), C.soTem(0.3, 0.1), C.soTem(0, 10), C.soTem(-5, 10), C.soTem(5, 0)], [11, 2, 2, 3, 0, 0, 0], "soTem");

// --- gom vị trí ---
{
  const m = C.gomPos([
    posRow(1, "CIRCA", 95, 90, [it("Kho thất lạc", 5, 5), it("General", 90, 90)]),   // như 828044: available cấp dòng đã trừ thất lạc
    posRow(2, "CIRCA", 1, 0, [it(" kho THẤT LẠC ", 1, 1)]),                         // chỉ có ở Kho thất lạc (trim, hoa thường)
    posRow(3, "CIRCA", 3, 2, []),                                                    // không có items → lấy số cấp dòng
    posRow(4, "CIRCA", 12, 12, [it("General", 10, 10)]),                             // dòng vượt Σ items 2 → "không vị trí"
    posRow(5, "CIRCA", 8, 8, [it("General", 10, 10)]),                               // dòng < Σ items → không trừ
    posRow(6, "CIRCA", 20, 20, [it("General", 15, 15), it("Kho cắt liều", 5, 5)]),
    posRow(7, "CIRCA", 3, 3, [it("General", 3, 3)], { sku: "A" }), posRow(7, "CIRCA", 4, 4, [it("General", 4, 4)], { sku: "B" }), // 2 sku cùng seller → cộng
    posRow(8, "CIRCA", -3, -3, [it("General", -3, -3)])]);
  const v = pid => { const p = m.get(pid + "|CIRCA"); return [p.oh, p.av, p.lost]; };
  eq(v(1), [90, 90, 5], "Kho thất lạc bị trừ, available cấp dòng không cộng âm");
  eq(v(2), [0, 0, 1], "chỉ Kho thất lạc → 0/0");
  eq(v(3), [3, 2, 0], "không items → số cấp dòng");
  eq(v(4), [12, 12, 0], "phần vượt Σ items được tính");
  eq(v(5), [10, 10, 0], "dòng < Σ items: giữ Σ items");
  eq(v(6), [20, 20, 0], "nhiều vị trí");
  eq(v(7), [7, 7, 0], "2 sku cùng product_id + seller cộng lại");
  eq(v(8), [-3, -3, 0], "tồn âm giữ nguyên");
}

// --- lật trang + khử trùng ---
{
  const mk = (a, b) => Array.from({ length: b - a }, (_, i) => posRow(a + i, "CIRCA", 1, 1, [it("General", 1)]));
  const P = { 1: mk(0, 3), 2: mk(2, 5), 3: mk(5, 6), 4: [] }; // trang 2 lặp 1 dòng của trang 1
  let calls = [];
  const r = C.keoHetTrang(p => { calls.push(p); return { list: P[p] || [], total: 6 }; }, 3, 50);
  eq([r.rows.length, r.dup, r.pages, calls], [6, 1, 3, [1, 2, 3]], "khử trùng giữa trang, dừng khi đủ total");
  throwsLike(() => C.keoHetTrang(p => ({ list: p === 1 ? mk(0, 3) : p === 2 ? mk(0, 3) : [], total: 6 }), 3, 50), /3 dòng khác nhau.*tổng 6/, "thiếu dòng (trang rỗng sớm) → lỗi, không ghi");
  throwsLike(() => C.keoHetTrang(p => ({ list: mk(0, 3), total: 6 }), 3, 5), /tổng 6/, "lặp mãi không đủ → dừng ở maxPages, lỗi");
  throwsLike(() => C.keoHetTrang(p => ({ items: [] }), 3, 5), /không đúng dạng/, "trang sai dạng");
  eq(C.keoHetTrang(p => ({ list: [], total: 0 }), 3, 5).rows.length, 0, "cửa hàng không có dòng nào");
}

// --- bảng kết quả: nhiều seller, tồn 0/âm, thiếu master (đoán từ tên), ghép NW, chỉ-NW, mã NW sai dạng ---
{
  const M = C.loadMaster([V4H, [10, "", "hộp", 10, "hộp"], [10, "", "viên", 1, "hộp"], [11, "", "hộp", 10, "hộp"], [11, "", "viên", 1, "hộp"],
    [12, "", "hộp", 10, "hộp"], [12, "", "viên", 1, "hộp"], [14, "", "hộp", 10, "hộp"], [14, "", "viên", 1, "hộp"],
    [17, "", "hộp", 30, "vỉ"], [17, "", "viên", 1, "vỉ"],                    // 17: đơn vị in "vỉ" không có trong units
    [21, "", "hộp", 10, "hộp"], [21, "", "viên", 1, "hộp"]], [ADH]);
  const pos = [
    posRow(10, "CIRCA", 25, 25, [it("General", 25)]), posRow(10, "CIRCA_MKP", 15, 15, [it("General", 15)]), posRow(10, "MARKETING", 0, 0, []),
    posRow(11, "CIRCA", 0, 0, []),                      // 0/0 + có NW → giữ
    posRow(12, "CIRCA", 0, 0, []),                      // 0/0 không NW → bỏ
    posRow(13, "CIRCA", 7, 7, [it("General", 7)], { product_name: "Thuốc X (hộp/10 viên)" }),   // không có trong master → đoán hộp 10
    posRow(14, "CIRCA", -2, -2, [it("General", -2)]),   // âm → 0 tem
    posRow(15, "CIRCA_MKP", 4, 4, [it("General", 4)]),  // NW có 15 nhưng POS không có dòng CIRCA → chỉ-NW; tên "SP 15" → đoán 1
    posRow(16, "CIRCA", 2, 2, [it("General", 2)], { product_name: "Phiếu mua hàng 100k" }),
    posRow(17, "CIRCA", 45, 45, [it("General", 45)], { product_name: "Thuốc Y (h/3 vỉ x 10 viên)" }),          // master thiếu đơn vị in → đoán 30
    posRow(18, "CIRCA", 100, 100, [it("General", 100)], { product_name: "Khăn ướt (lốc/8g/8m)", base_unit: "miếng" }), // đoán có cảnh báo
    posRow(19, "CIRCA", 5, 5, [it("General", 5)], { product_name: "Thuốc Z (h/0v)" }),         // đoán ra 0 → không tính được
    posRow(21, "CIRCA", 30, 30, [it("General", 30)]),                                            // master 10, NW 30/2 thẻ → cỡ thẻ ~15
    posRow(2, "CIRCA", 0, 0, [it("Kho thất lạc", 3)])];  // chỉ thất lạc → 0/0 → bỏ
  const nw = [nwItem("CIRCA-10", 30, 3), nwItem("CIRCA-11", 10, 1), nwItem("CIRCA-15", 8, 2), nwItem("CIRCA-99", 5, 1), nwItem("CIRCA-99", 7, 2),
    nwItem("CIRCA-ABC", 1, 1), nwItem("12345", 2, 1), nwItem(null, 3, 1),
    nwItem("CIRCA-12", 0, 0), nwItem("CIRCA-98", 0, 0), nwItem("CIRCA-XYZ", 0, 0), nwItem("CIRCA-96", -1, 0), // 0/0 (và âm/0) → bỏ hẳn
    nwItem("CIRCA-97", 0, 2),                                                                                  // SL 0 nhưng còn 2 thẻ → có tồn NW
    nwItem("CIRCA-18", 16, 2), nwItem("CIRCA-21", 30, 2)];
  const res = C.dungBang(STORE, pos, M, nw);
  const R = res.rows;
  ok(R.every(r => r.length === 15), "mỗi dòng 15 cột");
  ok(!R.some(r => r[12] === 0 && r[13] === 0), "không dòng nào mang NW 0/0");
  ok(!rowOf(res, 98) && !R.some(r => /CIRCA-XYZ|CIRCA-96/.test(r[14])), "NW 0/0 không tạo dòng chỉ-NW");
  eq(R[0].slice(0, 2), ["POS0059", "CIRCA TAM VIET"], "POS_code / POS_name");
  eq(rowOf(res, 10, "CIRCA").slice(4, 14), ["CIRCA", 25, 25, 3, 10, "NW CIRCA-10", "KHO X", "viên", 30, 3], "dòng CIRCA ghép NW, ⌈25/10⌉=3, quy_doi 10");
  eq(rowOf(res, 10, "CIRCA")[14], "owner khác còn tồn 15", "dòng CIRCA: owner khác còn tồn 15 (MARKETING 0 không tính); cỡ thẻ 30/3 = 10 = quy đổi → không ghi chú");
  eq(rowOf(res, 21)[14], "quy đổi 10 khác cỡ thẻ NW ~15", "quy đổi master khác cỡ thẻ NW trung bình");
  eq(rowOf(res, 97).slice(12, 15), [0, 2, "chỉ có ở NW"], "NW SL 0 mà còn thẻ → vẫn là có tồn NW");
  eq(rowOf(res, 10, "CIRCA_MKP").slice(4, 14), ["", 15, 15, 2, 10, "", "", "", "", ""], "seller khác: owner trống, NW trống, vẫn tính tem");
  ok(!R.some(r => r[2] === "10" && /MARKETING/.test(r[14])), "seller MARKETING 0/0 bị bỏ");
  eq(rowOf(res, 11).slice(5, 14).concat(/POS tồn 0/.test(rowOf(res, 11)[14])), [0, 0, 0, "", "NW CIRCA-11", "KHO X", "viên", 10, 1, true], "CIRCA 0/0 có NW → giữ, tem 0, quy_doi trống");
  ok(!rowOf(res, 12), "CIRCA 0/0 không NW → bỏ");
  eq(rowOf(res, 13).slice(7, 9).concat(rowOf(res, 13)[14]), [1, 10, "không có trong master; quy đổi đoán từ tên → kiểm tra/bổ sung master"], "không có trong master → đoán từ tên (hộp/10 viên)");
  eq(rowOf(res, 15).slice(7, 9).concat(/không có trong master; quy đổi đoán từ tên/.test(rowOf(res, 15)[14])), [4, 1, true], "tên không có quy cách → quy đổi 1");
  eq(rowOf(res, 17).slice(7, 9).concat(rowOf(res, 17)[14]), [2, 30, "master thiếu đơn vị in; quy đổi đoán từ tên → kiểm tra/bổ sung master"], "master thiếu đơn vị in → đoán 30");
  eq(rowOf(res, 18).slice(7, 9).concat(rowOf(res, 18)[14]), [2, 64, "không có trong master; quy đổi đoán từ tên: tem trên lốc hay đơn vị bên trong? (lốc/8g/8m) → kiểm tra/bổ sung master; quy đổi 64 khác cỡ thẻ NW ~8"], "đoán có cảnh báo của ratioFor + khác cỡ thẻ NW");
  eq(rowOf(res, 19).slice(7, 9).concat(/chưa có quy đổi/.test(rowOf(res, 19)[14])), ["", "", true], "đoán ra quy đổi 0 → trống");
  eq(rowOf(res, 14).slice(5, 9), [-2, -2, 0, ""], "tồn âm → 0 tem");
  eq([rowOf(res, 16)[7], rowOf(res, 16)[8], /không phải hàng bán/.test(rowOf(res, 16)[14])], [0, "", true], "phiếu mua hàng → 0 tem (như v2)");
  ok(!rowOf(res, 2), "chỉ Kho thất lạc → bỏ");
  const tail = R.slice(-6);
  eq(tail.map(r => [r[2], r[4], r[5], r[8], r[12], r[13], r[14].split(";")[0]]),
    [["15", "", "", "", 8, 2, "chỉ có ở NW (POS có owner khác: 4)"], ["97", "", "", "", 0, 2, "chỉ có ở NW"], ["99", "", "", "", 12, 3, "chỉ có ở NW"], ["", "", "", "", 1, 1, "chỉ có ở NW"], ["", "", "", "", 2, 1, "chỉ có ở NW"], ["", "", "", "", 3, 1, "chỉ có ở NW"]],
    "dòng chỉ-NW ở cuối: 15 (POS chỉ có MKP 4), 97, 99 (cộng 2 dòng NW), rồi 3 mã sai dạng");
  ok(/NW có 2 dòng cùng mã/.test(rowOf(res, 99)[14]), "ghi chú cộng dòng NW");
  ok(/CIRCA-ABC/.test(tail[3][14]) && /12345/.test(tail[4][14]), "ghi chú mã NW sai dạng");
  eq(R.filter(r => r[14].indexOf("chỉ có ở NW") < 0).map(r => r[2] + "/" + (r[4] || "-")), ["10/CIRCA", "10/-", "11/CIRCA", "13/CIRCA", "14/CIRCA", "15/-", "16/CIRCA", "17/CIRCA", "18/CIRCA", "19/CIRCA", "21/CIRCA"], "sắp xếp theo product_id rồi seller");
  const s = res.stats;
  eq([s.rows, s.ghepNw, s.chiNw, s.thieuMaster, s.doanTen, s.lechCoThe, s.sumRfid, s.nwQ, s.nwEpc, s.nwSai, s.nw0, s.master], [17, 4, 6, 1, 4, 2, 17, 112, 18, 3, 4, 6],
    "thống kê (Σ tem 3+2+1+4+2+2+3 = 17; đoán từ tên 13/15/17/18; trống 19; khác cỡ thẻ 18/21; NW 0/0 bỏ 4; Σ NW 112 / 18)");
  ok(/4 dòng quy đổi đoán từ tên \(kiểm trước khi in\), 1 dòng chưa tính được số tem · master 6 mã/.test(C.ghiChuLanKeo("x", STORE, null, s)), "ghi chú B2 nêu số dòng đoán từ tên + số mã master");
  // không có kho NW → cột NW trống, dòng CIRCA 0/0 bị bỏ
  const r0 = C.dungBang(STORE, pos, M, null);
  ok(!rowOf(r0, 11) && r0.rows.every(r => r[12] === "") && r0.stats.chiNw === 0, "không có kho NW: không ghép, không dòng chỉ-NW");
  // bảng ghi sheet
  const B = C.bangGhi([["POS0024", "111", "10", "=HYPERLINK(1)", "CIRCA", 1, 1, "", 0.333333333333, "+abc", "-x", "@y", 3, 1, "1/2"]]);
  eq(B[0], C.HEADER, "header");
  eq(B[1], ["POS0024", "'111", 10, "'=HYPERLINK(1)", "CIRCA", 1, 1, "", 0.333333333333, "'+abc", "'-x", "'@y", 3, 1, "'1/2"], "chữ an toàn khi setValues, product_id và quy_doi dạng số");
  eq(C.HEADER, ["POS_code", "POS_name", "product_id", "product_name", "owner_name", "total_on_hand_qty", "total_available_qty", "total_rfid_need_print", "quy_doi", "nw_ten_san_pham", "nw_kho", "nw_don_vi", "nw_so_luong", "nw_tong_the_epc", "ghi_chu"], "đúng thứ tự cột");
  // quy đổi lẻ (đơn vị in nhỏ hơn đơn vị tồn) ghi gọn 12 chữ số
  const M2 = C.loadMaster([V4H, [20, "", "hộp", 3, "viên"], [20, "", "viên", 1, "viên"]], [ADH]);
  eq(rowOf(C.dungBang(STORE, [posRow(20, "CIRCA", 2, 2, [it("General", 2)], { base_unit: "hộp" })], M2, []), 20).slice(7, 9), [6, 0.333333333333], "quy đổi 1/3 → 6 tem, quy_doi 0.333333333333");
}

// --- ratioFor port = KiemDem.ratioFor (mẫu tay) ---
{
  const { KiemDem } = require(path.join(KD_DIR, "load-tool.js"));
  const cases = [["Diacerein 50mg hv usp (hộp/100 viên nang)", "viên"], ["Khăn (lốc/8g/8m)", "miếng"], ["Tăm (bịch/12 túi)", "cái"], ["X (H/35Gói)", "viên"],
    ["Pocari (H/5g/13gr)", "gói"], ["Sữa (h/400gr)", "hộp"], ["Y (h/3 vỉ x 10 viên)", "viên"], ["Z (Cái) (Quà Tặng)", "cái"], ["A (c/1200v)", "viên"], ["B (thùng/24 lon x 330ml)", "lon"],
    ["C (hộp 2 vỉ x 10 viên)", "viên"], ["D (t/15gr)", "tuýp"], ["E", "hộp"], ["", ""], ["F (lốc/10c/60ml)", "chai"], ["G (h/0v)", "viên"], ["H (dây/10 gói)", "gói"]];
  cases.forEach(([n, u]) => eq(C.ratioFor(n, u), KiemDem.ratioFor(n, u), "ratioFor " + n + " / " + u));
  eq(C.ratioFor("Diacerein 50mg hv usp (hộp/100 viên nang)", "viên"), ["hộp", 100, ""], "ratioFor 1109 → hộp 100");
}

// --- kho NW ---
{
  const W = C.khoNwPhang([{ id: "a", name: "CIRCA TAM VIET", locationType: "warehouse", children: [{ id: "c", name: "Kệ con", locationType: "warehouse" }] },
    { id: "t", name: "In transit", locationType: "transit" }, { id: "b", name: " circa lumina ", locationType: "warehouse" }, { id: "d", name: "CIRCA TÂM VIỆT", locationType: "warehouse" }]);
  eq(W.map(w => w.id), ["a", "c", "b", "d"], "phẳng hoá children, bỏ transit");
  eq(C.timKhoNw(" circa tam viet ", W).id, "a", "khớp 1 kho: trim + không phân biệt hoa thường");
  eq(C.timKhoNw("CIRCA LUMINA", W).id, "b", "khớp tên kho có khoảng trắng");
  eq(C.timKhoNw("CIRCA FLORITA", W), null, "0 kho khớp → null");
  eq(C.timKhoNw("In transit", W), null, "kho transit không được chọn");
  throwsLike(() => C.timKhoNw("CIRCA X", W.concat([{ id: "x1", name: "CIRCA X" }, { id: "x2", name: "circa x" }])), /2 kho Nextwaves cùng tên/, "2 kho khớp → lỗi");
  eq(C.timKhoNw("CIRCA TÂM VIỆT", W).id, "d", "có dấu khác không dấu (không bỏ dấu)");
  eq(C.timKhoNw("Circa Tâm Việt".normalize("NFD"), W).id, "d", "tên dạng NFD vẫn khớp tên NFC");
  eq(C.dongDanhSach([{ code: "P9", name: "CIRCA TÂM VIỆT".normalize("NFD"), id: "s9" }], W)[0][4], "d", "danh sách cửa hàng: NFD khớp NFC");
  // dữ liệu phải đúng nguồn
  C.kiemDungNguon([{ pos_id: "s1" }, { pos_id: "s1" }], "pos_id", "s1", "Tồn POS");
  ok(true, "đúng nguồn → không lỗi");
  throwsLike(() => C.kiemDungNguon([{ pos_id: "s1" }, { pos_id: "s2" }, {}], "pos_id", "s1", "Tồn POS"), /Tồn POS: 2\/3 dòng không thuộc cửa hàng đã chọn \(pos_id = s2, \(trống\)\)/, "dòng POS sai / thiếu pos_id → lỗi");
  throwsLike(() => C.kiemDungNguon([{ warehouseId: "w2" }], "warehouseId", "w1", "Tồn NW"), /Tồn NW: 1\/1 dòng không thuộc kho đã chọn/, "dòng NW sai kho → lỗi");
  eq(C.khoNwPhang({ data: [{ id: "z", name: "Z" }] }).length, 1, "chấp nhận {data:[…]}");
  throwsLike(() => C.khoNwPhang({ x: 1 }), /không đúng dạng/, "kho sai dạng");
  eq(C.itemsOverview({ items: [1] }).length + C.itemsOverview({ data: { items: [1, 2] } }).length, 3, "overview có/không bọc data");
  eq(C.dongDanhSach([{ code: "P1", name: "CIRCA TAM VIET", id: "s1" }, { code: "P2", name: "CIRCA X", id: "s2" }], W),
    [["P1", "CIRCA TAM VIET", "s1", "CIRCA TAM VIET", "a"], ["P2", "CIRCA X", "s2", "chưa có kho NW trùng tên", ""]], "dòng danh sách cửa hàng");
}

// --- danh sách cửa hàng ---
{
  const L = C.cuaHangTuMe({ data: { clients: [{ stores: [{ id: "2", code: "POS0059", name: "CIRCA TAM VIET" }, { id: "1", code: "POS0012", name: "CIRCA LUMINA" }] }, { stores: [{ id: "1", code: "POS0012", name: "CIRCA LUMINA" }, { id: "3", code: "POS0005", name: " Circa 423 " }] }] } });
  eq(L.map(C.nhanCuaHang), ["POS0005 - Circa 423", "POS0012 - CIRCA LUMINA", "POS0059 - CIRCA TAM VIET"], "gộp stores mọi client, bỏ trùng, xếp theo mã");
  const list = L.map(s => [s.code, s.name, s.id, "", ""]);
  eq(C.timCuaHang("POS0059 - CIRCA TAM VIET", list), { code: "POS0059", name: "CIRCA TAM VIET", id: "2" }, "tìm cửa hàng theo nhãn B1");
  eq(C.timCuaHang("POS0012 - tên đã đổi", list).id, "1", "nhãn cũ: tìm theo mã");
  eq(C.timCuaHang("POS0005 - Circa 423".normalize("NFD"), list).id, "3", "nhãn B1 dạng NFD");
  eq(C.timCuaHang("", list), null, "B1 trống");
  throwsLike(() => C.cuaHangTuMe({ data: {} }), /không đúng dạng/, "authz/me sai dạng");
}

// =====================================================================================================
console.log("M. Giả lập Apps Script");
// --- SpreadsheetApp / UrlFetchApp giả ---
function fakeSheet(name, rows, cols) {
  const cells = new Map();
  const sh = {
    name, maxR: rows || 1000, maxC: cols || 26, frozen: 0, setValuesCalls: 0, clearAllCalls: 0, failSetValues: false, validation: {},
    _get(r, c) { const v = cells.get(r + "," + c); return v === undefined ? "" : v; },
    _set(r, c, v) { if (v === "" || v == null) cells.delete(r + "," + c); else cells.set(r + "," + c, typeof v === "string" && v[0] === "'" ? v.slice(1) : v); },
    getLastRow() { let m = 0; cells.forEach((v, k) => { m = Math.max(m, +k.split(",")[0]); }); return m; },
    getLastColumn() { let m = 0; cells.forEach((v, k) => { m = Math.max(m, +k.split(",")[1]); }); return m; },
    getMaxRows() { return sh.maxR; }, getMaxColumns() { return sh.maxC; },
    insertRowsAfter(a, n) { sh.maxR += n; }, insertColumnsAfter(a, n) { sh.maxC += n; },
    clearContents() { sh.clearAllCalls++; cells.clear(); }, setFrozenRows(n) { sh.frozen = n; },
    getDataRange() { return sh.getRange(1, 1, Math.max(1, sh.getLastRow()), Math.max(1, sh.getLastColumn())); },
    getRange(a, b, c, d) {
      if (typeof a === "string") { const m = a.match(/^([A-Z])(\d+)$/); return sh.getRange(+m[2], m[1].charCodeAt(0) - 64, 1, 1); }
      const r0 = a, c0 = b, nr = c || 1, nc = d || 1;
      if (r0 < 1 || c0 < 1 || r0 + nr - 1 > sh.maxR || c0 + nc - 1 > sh.maxC) throw new Error("The coordinates of the range are outside the dimensions of the sheet.");
      return {
        getValues() { return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => sh._get(r0 + i, c0 + j))); },
        getValue() { return sh._get(r0, c0); },
        setValues(v) { if (v.length !== nr || v.some(x => x.length !== nc)) throw new Error("setValues sai kích thước"); if (sh.failSetValues) { sh.failSetValues = false; throw new Error("Service Spreadsheets timed out"); } sh.setValuesCalls++; v.forEach((row, i) => row.forEach((x, j) => sh._set(r0 + i, c0 + j, x))); },
        setValue(v) { sh._set(r0, c0, v); },
        clearContent() { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sh._set(r0 + i, c0 + j, ""); },
        setDataValidation(dv) { sh.validation[r0 + "," + c0] = dv; },
      };
    },
  };
  return sh;
}
function fakeSS(sheets) {
  const ss = { sheets: new Map(), toasts: [], getSheetByName(n) { return ss.sheets.get(n) || null; }, insertSheet(n) { const s = fakeSheet(n); ss.sheets.set(n, s); return s; }, toast(m) { ss.toasts.push(m); } };
  (sheets || []).forEach(s => ss.sheets.set(s.name, s));
  return ss;
}
function sheetFrom(name, aoa) { const s = fakeSheet(name, Math.max(1000, aoa.length + 5), Math.max(26, aoa[0].length)); aoa.forEach((r, i) => r.forEach((v, j) => s._set(i + 1, j + 1, v))); return s; }
function resp(code, body) { const t = typeof body === "string" ? body : JSON.stringify(body); return { getResponseCode: () => code, getContentText: () => t }; }
// env: routes = [[regex, fn(url, opts, n) → resp | throw]]; trả context đã nạp Code.gs
function appsEnv(opts) {
  const ui = { alerts: [], prompts: opts.prompts || [], Button: { OK: "OK", CANCEL: "CANCEL" }, ButtonSet: { OK: "OK", OK_CANCEL: "OK_CANCEL" },
    alert(a, b) { ui.alerts.push(b === undefined ? a : a + ": " + b); },
    prompt() { const p = ui.prompts.shift() || ["CANCEL", ""]; return { getSelectedButton: () => p[0], getResponseText: () => p[1] }; },
    createMenu(n) { const m = { items: [], addItem(a, f) { m.items.push([a, f]); return m; }, addToUi() { ui.menu = m; } }; return m; } };
  const props = new Map(Object.entries(opts.props || {}));
  const calls = [], sleeps = [], lock = [];
  const ctx = load({
    LockService: { getDocumentLock: () => ({ tryLock: ms => { lock.push("try " + ms); return !opts.lockBusy; }, releaseLock: () => lock.push("release") }) },
    SpreadsheetApp: {
      getUi: () => ui, getActiveSpreadsheet: () => opts.ss,
      openById: id => { if (id !== "18nLllIlORaki3por1diKzNo2tWvdVyUnB1xbZXDv8Xc") throw new Error("không có quyền"); if (!opts.master) throw new Error("Bạn không có quyền truy cập"); return opts.master; },
      newDataValidation: () => { const v = { list: null, requireValueInList(l) { v.list = l; return v; }, setAllowInvalid() { return v; }, build() { return v; } }; return v; },
    },
    UrlFetchApp: { fetch(url, o) {
      calls.push(url); ok(o.muteHttpExceptions === true && (!o.method || o.method === "get"), "fetch chỉ GET + muteHttpExceptions");
      const rt = opts.routes.find(r => r[0].test(url)); if (!rt) throw new Error("URL lạ " + url);
      const n = calls.filter(u => rt[0].test(u)).length; return rt[1](url, o, n);
    } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.has(k) ? props.get(k) : null, setProperty: (k, v) => props.set(k, v) }) },
    Utilities: { sleep: ms => sleeps.push(ms), formatDate: () => "24/11/2026 01:00" },
  });
  return { ctx, ui, props, calls, sleeps, lock };
}
const MASTER_SS = () => fakeSS([sheetFrom("final data v4", [V4H, [1109, "x", "hộp", 100, "hộp"], [1109, "x", "viên", 1, "hộp"], [7, "y", "hộp", 10, "hộp"], [7, "y", "viên", 1, "hộp"]]), sheetFrom("Adhoc", [ADH])]);
const ME = { success: true, data: { clients: [{ stores: [{ id: "s-tv", code: "POS0059", name: "CIRCA TAM VIET" }, { id: "s-lu", code: "POS0012", name: "CIRCA LUMINA" }, { id: "s-x", code: "POS0001", name: "CIRCA X" }] }] } };
const WH = [{ id: "w-tv", name: "CIRCA TAM VIET", locationType: "warehouse", children: [] }, { id: "tr", name: "In transit", locationType: "transit" }, { id: "w-lu", name: "CIRCA LUMINA", locationType: "warehouse" }];
const TV = { pos_id: "s-tv" };
const POSP = { 1: [posRow(1109, "CIRCA", 180, 180, [it("General", 180)], TV), posRow(7, "CIRCA", 0, 0, [], TV)], 2: [posRow(1109, "CIRCA", 180, 180, [it("General", 180)], TV), posRow(7, "CIRCA_MKP", 3, 3, [it("General", 3)], TV)] };
const WTV = { warehouseId: "w-tv" };
function routes(over) {
  return [
    [/\/v1\/authz\/me$/, () => resp(200, ME)],
    [/\/inventory\/admin\/stock\/search/, (u, o) => { ok(o.headers["x-store-id"] === "s-tv" && /^Bearer posK$/.test(o.headers.authorization), "header POS"); const p = +u.match(/page=(\d+)/)[1]; return resp(200, { success: true, data: { list: POSP[p] || [], total: 3, limit: 2, page: p } }); }],
    [/\/warehouses$/, (u, o) => { ok(o.headers.authorization === "Bearer nwK", "header NW"); return resp(200, WH); }],
    [/\/stock\/overview\?warehouseId=w-tv$/, () => resp(200, { items: [nwItem("CIRCA-7", 10, 1, WTV), nwItem("CIRCA-5", 2, 1, WTV), nwItem("CIRCA-6", 0, 0, WTV)], totals: {} })],
  ].map(r => (over && over[String(r[0])]) ? [r[0], over[String(r[0])]] : r);
}
{
  // menu
  const e0 = appsEnv({ ss: fakeSS(), routes: routes() });
  e0.ctx.onOpen();
  eq(e0.ui.menu.items.map(x => x[1]), ["menuNhapKhoa", "menuCapNhatCuaHang", "menuKeoTon"], "menu 3 mục");
  // nhập khoá: không hiện giá trị cũ, để trống = giữ, Huỷ = dừng
  const e1 = appsEnv({ ss: fakeSS(), routes: routes(), props: { POS_TOKEN: "old" }, prompts: [["OK", " Bearer posK "], ["OK", ""]] });
  e1.ctx.menuNhapKhoa();
  eq([e1.props.get("POS_TOKEN"), e1.props.get("NW_KEY") || null], ["posK", null], "nhập khoá: bỏ 'Bearer', để trống = giữ");
  ok(!e1.ui.alerts.join(" ").includes("old") && /NW_KEY CHƯA CÓ/.test(e1.ui.alerts.join(" ")), "không hiện khoá, báo đã có / chưa có");
  // chưa có khoá
  const e2 = appsEnv({ ss: fakeSS(), routes: routes() });
  e2.ctx.menuKeoTon();
  ok(/Chưa có khoá POS_TOKEN và NW_KEY/.test(e2.ui.alerts[0]), "thiếu khoá → báo");
  // menu 2 + menu 3
  const ss = fakeSS(), props = { POS_TOKEN: "posK", NW_KEY: "nwK" };
  const e3 = appsEnv({ ss, routes: routes(), props, master: MASTER_SS() });
  e3.ctx.menuCapNhatCuaHang();
  const ch = ss.getSheetByName("Chon_kho");
  eq(ch.getRange(4, 1, 3, 5).getValues(), [["POS0001", "CIRCA X", "s-x", "chưa có kho NW trùng tên", ""], ["POS0012", "CIRCA LUMINA", "s-lu", "CIRCA LUMINA", "w-lu"], ["POS0059", "CIRCA TAM VIET", "s-tv", "CIRCA TAM VIET", "w-tv"]], "tab Chon_kho: danh sách từ dòng 4");
  eq(ch.validation["1,2"].list, ["POS0001 - CIRCA X", "POS0012 - CIRCA LUMINA", "POS0059 - CIRCA TAM VIET"], "ô B1 thả xuống");
  ch.getRange("B1").setValue("POS0059 - CIRCA TAM VIET");
  // tab kết quả cũ lớn hơn (10 dòng × 18 cột) → ghi đè trước, rồi xoá phần thừa; không xoá cả tab
  ss.sheets.set("Ton_POS_NW", sheetFrom("Ton_POS_NW", Array.from({ length: 10 }, (_, i) => Array.from({ length: 18 }, (_, j) => "cũ" + i + "_" + j))));
  const e4 = appsEnv({ ss, routes: routes(), props, master: MASTER_SS() });
  e4.ctx.menuKeoTon();
  const kq = ss.getSheetByName("Ton_POS_NW");
  ok(kq && kq.setValuesCalls === 1 && kq.clearAllCalls === 0, "ghi kết quả bằng MỘT setValues, không xoá cả tab trước");
  eq([kq.getLastRow(), kq.getLastColumn()], [5, 15], "phần thừa của lần chạy cũ (dòng 6–10, cột 16–18) đã xoá");
  eq(e4.lock, ["try 5000", "release"], "menu 3 lấy rồi trả khoá tài liệu");
  ok(/· master 2 mã/.test(ch.getRange("B2").getValue()), "B2 ghi số mã master đã nạp");
  const KQ = kq.getRange(1, 1, kq.getLastRow(), 15).getValues();
  eq(KQ.map(r => [r[2], r[4], r[5], r[7], r[8], r[12], r[14].split(";")[0]]),
    [["product_id", "owner_name", "total_on_hand_qty", "total_rfid_need_print", "quy_doi", "nw_so_luong", "ghi_chu"], [7, "CIRCA", 0, 0, "", 10, "POS tồn 0, NW còn hàng"], [7, "", 3, 1, 10, "", "seller CIRCA_MKP: không ghép NW"], [1109, "CIRCA", 180, 2, 100, "", ""], [5, "", "", "", "", 2, "chỉ có ở NW"]],
    "kết quả qua lớp Apps Script (trang 2 lặp dòng 1109)");
  ok(/^Kéo lúc 24\/11\/2026 01:00 · POS0059 - CIRCA TAM VIET · 4 dòng/.test(ch.getRange("B2").getValue()), "ghi chú B2: " + ch.getRange("B2").getValue());
  ok(e4.calls.filter(u => /stock\/search/.test(u)).length === 2 && e4.sleeps.length === 0, "2 trang POS, không chờ");
  // thử lại: 429, 502, body hỏng rồi 200 → chờ 2/4/8 s
  const e5 = appsEnv({ ss, props, master: MASTER_SS(), routes: routes({ [String(/\/warehouses$/)]: (u, o, n) => n === 1 ? resp(429, "") : n === 2 ? resp(502, "<html>") : n === 3 ? resp(200, '{"cut') : resp(200, WH) }) });
  e5.ctx.menuKeoTon();
  eq(e5.sleeps, [2000, 4000, 8000], "thử lại 3 lần, chờ 2/4/8 s");
  ok(/^Xong/.test(e5.ui.alerts[0]), "sau thử lại thì xong");
  // lỗi mạng (ném) cũng thử lại
  const e5b = appsEnv({ ss, props, master: MASTER_SS(), routes: routes({ [String(/\/v1\/authz\/me$/)]: (u, o, n) => { if (n === 1) throw new Error("Address unavailable"); return resp(200, ME); } }) });
  e5b.ctx.menuCapNhatCuaHang();
  eq(e5b.sleeps, [2000], "lỗi mạng → thử lại");
  // hết lượt thử → dừng, KHÔNG ghi (kết quả cũ còn nguyên, B2 cũ còn nguyên)
  const before = JSON.stringify(kq.getRange(1, 1, kq.getLastRow(), 15).getValues()), b2 = ch.getRange("B2").getValue(), calls0 = kq.setValuesCalls;
  const e6 = appsEnv({ ss, props, master: MASTER_SS(), routes: routes({ [String(/\/stock\/overview\?warehouseId=w-tv$/)]: () => resp(503, "") }) });
  e6.ctx.menuKeoTon();
  ok(/Nextwaves không phản hồi được sau 3 lần thử lại \(HTTP 503\)/.test(e6.ui.alerts[0]), "báo lỗi sau 3 lần: " + e6.ui.alerts[0]);
  ok(JSON.stringify(kq.getRange(1, 1, kq.getLastRow(), 15).getValues()) === before && ch.getRange("B2").getValue() === b2 && kq.setValuesCalls === calls0, "lỗi → không ghi gì");
  // 401 → dừng ngay, không thử lại
  const e7 = appsEnv({ ss, props, master: MASTER_SS(), routes: routes({ [String(/\/inventory\/admin\/stock\/search/)]: () => resp(401, "{}") }) });
  e7.ctx.menuKeoTon();
  ok(/POS: khoá sai hoặc hết hạn \(HTTP 401\)/.test(e7.ui.alerts[0]) && e7.sleeps.length === 0 && e7.calls.length === 1, "401 → dừng ngay");
  const e7b = appsEnv({ ss, props, master: MASTER_SS(), routes: routes({ [String(/\/warehouses$/)]: () => resp(403, "{}") }) });
  e7b.ctx.menuKeoTon();
  ok(/Nextwaves: khoá không có quyền với cửa hàng\/kho này hoặc đã hết hạn \(HTTP 403\).*NW_KEY/.test(e7b.ui.alerts[0]), "403 NW → báo không có quyền, NW_KEY");
  // dữ liệu sai nguồn → dừng, không ghi
  const e7c = appsEnv({ ss, props, master: MASTER_SS(), routes: routes({ [String(/\/inventory\/admin\/stock\/search/)]: u => { const p = +u.match(/page=(\d+)/)[1]; return resp(200, { data: { list: p === 1 ? POSP[1] : p === 2 ? [POSP[2][0], posRow(7, "CIRCA_MKP", 3, 3, [], { pos_id: "s-lu" })] : [], total: 3 } }); } }) });
  e7c.ctx.menuKeoTon();
  ok(/Tồn POS: 1\/3 dòng không thuộc cửa hàng đã chọn \(pos_id = s-lu\)/.test(e7c.ui.alerts[0]) && kq.setValuesCalls === calls0, "dòng POS của cửa hàng khác → dừng, không ghi: " + e7c.ui.alerts[0]);
  const e7d = appsEnv({ ss, props, master: MASTER_SS(), routes: routes({ [String(/\/stock\/overview\?warehouseId=w-tv$/)]: () => resp(200, { items: [nwItem("CIRCA-7", 10, 1, WTV), nwItem("CIRCA-5", 2, 1, { warehouseId: "w-lu" })] }) }) });
  e7d.ctx.menuKeoTon();
  ok(/Tồn NW: 1\/2 dòng không thuộc kho đã chọn \(warehouseId = w-lu\)/.test(e7d.ui.alerts[0]) && kq.setValuesCalls === calls0, "dòng NW của kho khác → dừng, không ghi");
  // đang có người chạy → báo, không gọi mạng
  const e7e = appsEnv({ ss, props, master: MASTER_SS(), routes: routes(), lockBusy: true });
  e7e.ctx.menuKeoTon();
  ok(/Đang có người chạy "Kéo tồn"/.test(e7e.ui.alerts[0]) && e7e.calls.length === 0 && !e7e.lock.includes("release"), "không lấy được khoá → báo, không chạy");
  // setValues lỗi giữa chừng → tab giữ nguyên dữ liệu cũ, B2 giữ nguyên
  kq.failSetValues = true;
  const e7f = appsEnv({ ss, props, master: MASTER_SS(), routes: routes() });
  e7f.ctx.menuKeoTon();
  ok(/timed out/.test(e7f.ui.alerts[0]) && JSON.stringify(kq.getRange(1, 1, kq.getLastRow(), 15).getValues()) === before && ch.getRange("B2").getValue() === b2 && e7f.lock.includes("release"), "setValues lỗi → tab cũ còn nguyên, vẫn trả khoá");
  // POS thiếu dòng (trang rỗng trước khi đủ total) → không ghi
  const e8 = appsEnv({ ss, props, master: MASTER_SS(), routes: routes({ [String(/\/inventory\/admin\/stock\/search/)]: (u) => resp(200, { data: { list: +u.match(/page=(\d+)/)[1] === 1 ? POSP[1] : [], total: 3 } }) }) });
  e8.ctx.menuKeoTon();
  ok(/kéo được 2 dòng khác nhau.*tổng 3/.test(e8.ui.alerts[0]) && kq.setValuesCalls === calls0, "POS thiếu dòng → dừng, không ghi");
  // master: không mở được / thiếu tab / sai header
  const e9 = appsEnv({ ss, props, master: null, routes: routes() });
  e9.ctx.menuKeoTon();
  ok(/Không mở được Google Sheet master/.test(e9.ui.alerts[0]) && kq.setValuesCalls === calls0, "master không mở được → dừng");
  const e10 = appsEnv({ ss, props, master: fakeSS([sheetFrom("final data v4", [V4H, [1, "", "hộp", 1, "hộp"]])]), routes: routes() });
  e10.ctx.menuKeoTon();
  ok(/không có tab "Adhoc"/.test(e10.ui.alerts[0]), "thiếu tab Adhoc → dừng");
  const e11 = appsEnv({ ss, props, master: fakeSS([sheetFrom("final data v4", [["a", "b"], [1, 2]]), sheetFrom("Adhoc", [ADH])]), routes: routes() });
  e11.ctx.menuKeoTon();
  ok(/thiếu cột product_id/.test(e11.ui.alerts[0]), "sai header master → dừng");
  // 2 kho NW trùng tên → dừng; 0 kho → ghi phần POS, B2 ghi chú
  const e12 = appsEnv({ ss, props, master: MASTER_SS(), routes: routes({ [String(/\/warehouses$/)]: () => resp(200, WH.concat([{ id: "w-tv2", name: "circa tam viet ", locationType: "warehouse" }])) }) });
  e12.ctx.menuKeoTon();
  ok(/2 kho Nextwaves cùng tên/.test(e12.ui.alerts[0]) && kq.setValuesCalls === calls0, "2 kho trùng tên → dừng, không ghi");
  const e13 = appsEnv({ ss, props, master: MASTER_SS(), routes: routes({ [String(/\/warehouses$/)]: () => resp(200, WH.slice(1)) }) });
  e13.ctx.menuKeoTon();
  ok(/chưa có kho NW trùng tên/.test(ch.getRange("B2").getValue()) && !e13.calls.some(u => /overview/.test(u)), "0 kho → không gọi overview, B2 ghi chú");
  ok(kq.getRange(1, 13, kq.getLastRow(), 2).getValues().slice(1).every(r => r[0] === "" && r[1] === ""), "0 kho → cột NW trống");
  eq(kq.getLastRow(), 3, "lần chạy ngắn hơn: dòng thừa của lần trước đã xoá");
  // B1 chưa chọn
  ch.getRange("B1").setValue("");
  const e14 = appsEnv({ ss, props, master: MASTER_SS(), routes: routes() });
  e14.ctx.menuKeoTon();
  ok(/Chưa chọn cửa hàng/.test(e14.ui.alerts[0]) && e14.calls.length === 0, "B1 trống → báo, không gọi mạng");
}

// =====================================================================================================
const F = n => path.join(DATA_DIR, "phien", n);
if (!fs.existsSync(F("pos-" + LABEL + ".json"))) { console.log("B/C/D: bỏ qua (không có " + F("pos-" + LABEL + ".json") + ")"); done(); return; }
console.log("B. Dữ liệu thật " + LABEL + " (" + DATA_DIR + ")");
const { XLSX, KiemDem } = require(path.join(KD_DIR, "load-tool.js"));
const POSRAW = JSON.parse(fs.readFileSync(F("pos-" + LABEL + ".json"), "utf8"));
const OV = JSON.parse(fs.readFileSync(F("nw-overview-" + LABEL + ".json"), "utf8"));
const V4CSV = fs.readFileSync(F("master-v4.csv"), "utf8"), ADCSV = fs.readFileSync(F("master-adhoc.csv"), "utf8");
// master như Apps Script getValues (ô số → number): đọc CSV có đoán kiểu
const aoaTyped = csv => XLSX.utils.sheet_to_json(XLSX.read(csv, { type: "string", dense: true }).Sheets.Sheet1, { header: 1, raw: true, defval: "", blankrows: false });
const v4Typed = aoaTyped(V4CSV), adTyped = aoaTyped(ADCSV);
const MASTER = C.loadMaster(v4Typed, adTyped);
// master như v2 (worker message masterCsv: CSV dạng chữ → KiemDem.loadMaster)
const wbv2 = XLSX.utils.book_new();
[["final data v4", V4CSV], ["Adhoc", ADCSV]].forEach(([n, t]) => { const w = XLSX.read(t, { type: "string", raw: true, dense: true }); XLSX.utils.book_append_sheet(wbv2, w.Sheets[w.SheetNames[0]], n); });
const MASTER_V2 = KiemDem.loadMaster(wbv2);
const sigA = JSON.stringify(masterSig(MASTER)), sigB = JSON.stringify(masterSig(MASTER_V2));
ok(sigA === sigB, "master (đọc kiểu getValues) giống hệt master v2 (gviz CSV chữ)");
let adhocN = 0; MASTER.forEach(e => { if (e.src === "Adhoc") adhocN++; });
console.log("  master: " + (v4Typed.length - 1) + " dòng final data v4, " + (adTyped.length - 1) + " dòng Adhoc → " + MASTER.size + " mã (" + adhocN + " từ Adhoc); giống v2: " + (sigA === sigB));
const pull = C.keoHetTrang(p => { const pg = POSRAW.pages[p - 1]; return pg ? { list: pg.list, total: pg.total } : { list: [], total: POSRAW.total }; }, 500, 200);
const WH_ID = (C.itemsOverview(OV)[0] || {}).warehouseId;
C.kiemDungNguon(pull.rows, "pos_id", POSRAW.storeId, "Tồn POS");
C.kiemDungNguon(C.itemsOverview(OV), "warehouseId", WH_ID, "Tồn NW");
ok(true, "dữ liệu thật đúng nguồn: mọi dòng POS pos_id = " + POSRAW.storeId + ", mọi dòng NW warehouseId = " + WH_ID);
const csvF = v => { const t = v == null ? "" : String(v); return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
fs.mkdirSync(path.join(DATA_DIR, "out"), { recursive: true });
function ghiCsv(file, res) { fs.writeFileSync(file, "﻿" + [C.HEADER].concat(res.rows).map(r => r.map(csvF).join(",")).join("\r\n") + "\r\n"); }
// in tóm tắt một lần chạy: nguồn quy đổi, Σ tem, khác cỡ thẻ, 10 dòng đoán nhiều tem nhất, dòng 1109
function tomTat(res, top) {
  const s = res.stats;
  console.log("  Kết quả: " + s.rows + " dòng, " + s.pids + " product_id POS; Σ on_hand " + s.sumOh + ", Σ available " + s.sumAv + ", Σ rfid " + s.sumRfid + "; master " + s.master + " mã");
  console.log("  đoán từ tên " + s.doanTen + " dòng; chưa tính được " + s.thieuMaster + "; khác cỡ thẻ NW " + s.lechCoThe + "; ghép NW " + s.ghepNw + "; chỉ-NW " + s.chiNw + " (mã NW sai dạng " + s.nwSai + ", NW 0/0 bỏ " + s.nw0 + "); giữ CIRCA tồn 0 vì có NW " + s.giuTon0 + "; bỏ dòng tồn 0 " + s.boTon0);
  const grp = { "master": [0, 0], "master, quy đổi 1": [0, 0], "đoán từ tên, không cảnh báo, quy đổi > 1": [0, 0], "đoán từ tên, quy đổi 1 (không cảnh báo)": [0, 0], "đoán từ tên, có cảnh báo": [0, 0],
    "tồn ≤ 0 → 0 tem": [0, 0], "không phải hàng bán → 0 tem": [0, 0], "chưa tính được (trống)": [0, 0] };
  const doan = [], lech = { master: 0, doan: 0 };
  res.rows.forEach(r => {
    if (r[14].indexOf("chỉ có ở NW") === 0) return;
    const g = r[14].indexOf("quy đổi đoán từ tên") >= 0;
    let k;
    if (r[8] === "") k = r[7] === "" ? "chưa tính được (trống)" : /không phải hàng bán/.test(r[14]) ? "không phải hàng bán → 0 tem" : "tồn ≤ 0 → 0 tem";
    else if (!g) k = r[8] === 1 ? "master, quy đổi 1" : "master";
    else if (/quy đổi đoán từ tên: /.test(r[14])) k = "đoán từ tên, có cảnh báo";
    else k = r[8] === 1 ? "đoán từ tên, quy đổi 1 (không cảnh báo)" : "đoán từ tên, không cảnh báo, quy đổi > 1";
    grp[k][0]++; grp[k][1] += r[7] === "" ? 0 : r[7];
    if (g && r[8] !== "") doan.push(r);
    if (/khác cỡ thẻ NW/.test(r[14])) lech[g ? "doan" : "master"]++;
  });
  console.log("  nguồn quy đổi (dòng / Σ tem):");
  Object.entries(grp).forEach(([k, v]) => console.log("    " + k + ": " + v[0] + " / " + v[1]));
  console.log("  ghi chú 'khác cỡ thẻ NW': " + s.lechCoThe + " dòng (quy đổi master " + lech.master + ", đoán từ tên " + lech.doan + ")");
  ok(doan.length === s.doanTen && lech.master + lech.doan === s.lechCoThe, "đếm dòng đoán từ tên / khác cỡ thẻ khớp stats");
  ok(!res.rows.some(r => r[12] === 0 && r[13] === 0), "không dòng nào mang NW 0/0");
  if (top) {
    doan.sort((a, b) => b[7] - a[7]);
    console.log("  " + top + " dòng đoán từ tên nhiều tem nhất (product_id | tên | seller | tồn | quy_doi | tem | thẻ NW | cảnh báo):");
    doan.slice(0, top).forEach(r => console.log("    " + [r[2], r[3], r[4] || "khác", r[5], r[8], r[7], r[13] === "" ? "-" : r[13], (r[14].match(/quy đổi đoán từ tên: (.*?) → kiểm tra/) || [, ""])[1]].join(" | ")));
  }
  const r1109 = rowOf(res, 1109, "CIRCA");
  console.log("  1109: " + JSON.stringify(r1109));
  return { grp, r1109 };
}
const res = C.dungBang(STORE, pull.rows, MASTER, C.itemsOverview(OV));
const s = res.stats;
const OUT = path.join(DATA_DIR, "out", "ton-pos-nw-" + LABEL + ".csv");
ghiCsv(OUT, res);
const ovQ = C.itemsOverview(OV).reduce((a, x) => a + x.quantity, 0), ovE = C.itemsOverview(OV).reduce((a, x) => a + x.epcCount, 0);
console.log("  POS: " + pull.pages + " trang, " + pull.rows.length + " dòng khác nhau (lặp " + pull.dup + "), total " + pull.total + "; kéo lúc " + POSRAW.at);
console.log("  [master hiện tại: phien/master-v4.csv + master-adhoc.csv]");
const T1 = tomTat(res, 10);
console.log("  Σ nw_so_luong " + s.nwQ + " / overview " + ovQ + " (totals.grand " + (OV.totals && OV.totals.grand) + "); Σ nw_tong_the_epc " + s.nwEpc + " / overview " + ovE + " (totals.grandCount " + (OV.totals && OV.totals.grandCount) + ")");
ok(s.nwQ === ovQ && s.nwEpc === ovE, "không mất dòng NW nào");
ok(s.ghepNw + s.chiNw === C.itemsOverview(OV).filter(x => x.quantity > 0 || x.epcCount > 0).length, "số dòng có NW = số dòng overview có tồn (không trùng mã)");
const r1109 = T1.r1109;
eq(r1109 && r1109.slice(0, 9), ["POS0059", "CIRCA TAM VIET", "1109", "Diacerein 50mg hv usp (hộp/100 viên nang)", "CIRCA", 180, 180, 2, 100], "dòng mẫu 1109 = 180/180/2, quy_doi 100");
ok(r1109 && r1109[12] === "", "1109 không có tồn NW");
console.log("  → " + OUT);
// cùng POS + NW, master ngày 17/11 (file master2.xlsx, như v2/test.js nạp qua message masterXlsx)
{
  const MF = process.env.MASTER_1711 || path.join(ROOT, "work/20261122-luu-scratchpad/kd-input2/master2.xlsx");
  if (!fs.existsSync(MF)) console.log("  master 17/11: bỏ qua (không có " + MF + ")");
  else {
    console.log("  [master 17/11: " + MF + "]");
    const wb = XLSX.read(fs.readFileSync(MF), { type: "buffer", sheets: ["final data v4", "Adhoc"], dense: true });
    const aoa = n => wb.Sheets[n] ? XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" }) : [];
    const M17 = C.loadMaster(aoa("final data v4"), aoa("Adhoc"));
    const K17 = KiemDem.loadMaster(wb);
    const same = JSON.stringify(masterSig(M17)) === JSON.stringify(masterSig(K17));
    let ad17 = 0; M17.forEach(e => { if (e.src === "Adhoc") ad17++; });
    console.log("  master 17/11: " + (aoa("final data v4").length - 1) + " dòng final data v4, " + (aoa("Adhoc").length - 1) + " dòng Adhoc → " + M17.size + " mã (" + ad17 + " từ Adhoc); giống KiemDem.loadMaster: " + same);
    ok(same, "master 17/11: loadMaster port = KiemDem.loadMaster");
    const res17 = C.dungBang(STORE, pull.rows, M17, C.itemsOverview(OV));
    const OUT17 = path.join(DATA_DIR, "out", "ton-pos-nw-" + LABEL + "-master1711.csv");
    ghiCsv(OUT17, res17);
    tomTat(res17, 0);
    console.log("  → " + OUT17);
  }
}
// NW Florita / Lumina trong overview-all.json (không có POS): không dòng NW 0/0 nào lọt ra
if (fs.existsSync(F("overview-all.json"))) {
  const all = C.itemsOverview(JSON.parse(fs.readFileSync(F("overview-all.json"), "utf8")));
  throwsLike(() => C.kiemDungNguon(all, "warehouseId", WH_ID, "Tồn NW"), /dòng không thuộc kho đã chọn/, "overview nhiều kho → kiểm đúng nguồn báo lỗi");
  for (const [ten, id] of [["CIRCA FLORITA", "eb5e2b4f-6f92-413b-90ef-6be1730b94c0"], ["CIRCA LUMINA", "3f7bd541-7370-4ce0-9048-231cf061e91a"]]) {
    const items = all.filter(x => x.warehouseId === id);
    C.kiemDungNguon(items, "warehouseId", id, "Tồn NW");
    const co = items.filter(x => x.quantity > 0 || x.epcCount > 0), q0 = items.filter(x => !(x.quantity > 0) && x.epcCount > 0).length;
    const r = C.dungBang({ code: "-", name: ten }, [], new Map(), items);
    const sq = co.reduce((a, x) => a + x.quantity, 0), se = co.reduce((a, x) => a + x.epcCount, 0);
    console.log("  overview-all " + ten + ": " + items.length + " dòng NW, 0/0 bỏ " + r.stats.nw0 + ", SL 0 mà còn thẻ (giữ) " + q0 + " → " + r.rows.length + " dòng chỉ-NW; Σ " + r.stats.nwQ + "/" + r.stats.nwEpc);
    ok(r.rows.length === co.length && r.stats.nw0 === items.length - co.length && !r.rows.some(x => x[12] === 0 && x[13] === 0) && r.stats.nwQ === sq && r.stats.nwEpc === se, ten + ": không dòng NW 0/0 nào lọt ra, Σ NW giữ nguyên");
  }
}
// port ratioFor = KiemDem.ratioFor trên toàn bộ tên SP thật (POS Tam Việt) + mọi tên × đơn vị trong master
{
  const pairs = new Map();
  pull.rows.forEach(x => pairs.set(x.product_name + "\u0000" + x.base_unit, [x.product_name, x.base_unit]));
  const nPos = pairs.size;
  v4Typed.slice(1).forEach(r => pairs.set(String(r[1]) + "\u0000" + String(r[2]), [String(r[1]), String(r[2])]));
  let bad = [];
  pairs.forEach(([n, u]) => { const a = JSON.stringify(C.ratioFor(n, u)), b = JSON.stringify(KiemDem.ratioFor(n, u)); if (a !== b) bad.push([n, u, a, b]); });
  console.log("  ratioFor port vs KiemDem.ratioFor: " + nPos + " cặp tên×đơn vị POS Tam Việt + " + (pairs.size - nPos) + " cặp từ master; lệch " + bad.length);
  bad.slice(0, 5).forEach(b => console.log("    lệch " + JSON.stringify(b)));
  ok(bad.length === 0, "ratioFor port = KiemDem.ratioFor trên dữ liệu thật");
}
const bySeller = {}; res.rows.forEach(r => { const k = r[4] === "CIRCA" ? "CIRCA" : (r[14].match(/seller (\S+):/) || [, r[14].indexOf("chỉ có ở NW") === 0 ? "(chỉ NW)" : "?"])[1]; bySeller[k] = (bySeller[k] || 0) + 1; });
console.log("  dòng theo seller: " + JSON.stringify(bySeller));
const notes = {}; res.rows.forEach(r => r[14].split("; ").filter(Boolean).forEach(n => { const k = n.replace(/: .*→/, ": … →").replace(/\(.*$/, "").replace(/\d+/g, "N").trim(); notes[k] = (notes[k] || 0) + 1; }));
console.log("  ghi chú (master hiện tại): " + JSON.stringify(notes));

// =====================================================================================================
console.log("C. Đối chiếu phần POS với file xuất trang POS");
const XF = process.env.XLSX_POS || path.join(DATA_DIR, "in", "ton-kho-7.xlsx");
if (!fs.existsSync(XF)) console.log("  bỏ qua (không có " + XF + ")");
else {
  const wbx = XLSX.read(fs.readFileSync(XF), { type: "buffer" });
  const a = XLSX.utils.sheet_to_json(wbx.Sheets[wbx.SheetNames[0]], { header: 1, defval: null });
  const h = a[0], ci = n => h.indexOf(n);
  const [cSku, cPid, cLoc, cTot, cBan] = ["SKU", "Mã sản phẩm", "Vị trí", "Tồn tổng", "Tồn bán"].map(ci);
  const X = new Map(); let lostX = 0;
  a.slice(1).forEach(r => {
    if (r[cPid] == null || r[cPid] === "") return;
    if (C.laKhoThatLac(r[cLoc])) { lostX += Number(r[cTot]) || 0; return; }
    const k = String(r[cPid]) + "|" + String(r[cSku]).split(".")[0];
    const x = X.get(k) || [0, 0]; x[0] += Number(r[cTot]) || 0; x[1] += Number(r[cBan]) || 0; X.set(k, x);
  });
  const Y = new Map();
  C.gomPos(pull.rows).forEach(p => { if (p.oh || p.av) Y.set(p.pid + "|" + p.seller, [p.oh, p.av]); });
  const keys = new Set([...X.keys(), ...Y.keys()]), diff = [];
  let same = 0;
  keys.forEach(k => { const x = X.get(k) || [0, 0], y = Y.get(k) || [0, 0]; if (Math.abs(x[0] - y[0]) < 1e-9 && Math.abs(x[1] - y[1]) < 1e-9) same++; else diff.push([k, x, y]); });
  diff.sort((p, q) => Number(p[0].split("|")[0]) - Number(q[0].split("|")[0]));
  console.log("  file " + path.basename(XF) + ": " + X.size + " product×seller (Kho thất lạc bỏ " + lostX + "); API: " + Y.size + "; khớp " + same + "/" + keys.size + ", lệch " + diff.length +
    " (chỉ file " + diff.filter(d => !Y.has(d[0])).length + ", chỉ API " + diff.filter(d => !X.has(d[0])).length + ", khác số " + diff.filter(d => X.has(d[0]) && Y.has(d[0])).length + ")");
  diff.slice(0, 10).forEach(d => console.log("    " + d[0] + ": file tồn tổng/bán " + d[1].join("/") + " · API on_hand/available " + d[2].join("/")));
  const sx = [...X.values()].reduce((a, x) => [a[0] + x[0], a[1] + x[1]], [0, 0]), sy = [...Y.values()].reduce((a, x) => [a[0] + x[0], a[1] + x[1]], [0, 0]);
  console.log("  Σ file " + sx.join("/") + " · Σ API " + sy.join("/"));
}

// =====================================================================================================
console.log("D. total_rfid_need_print so với E của tool Kiểm đếm v2");
{
  // bundle giống v2/build.js (SheetJS + KiemDem đã patch export + core.js), dựng trong bộ nhớ, không ghi file nào
  const raw = fs.readFileSync(path.join(KD_DIR, "tool-worker-raw.js"), "utf8");
  const cut = raw.indexOf("// Port of scripts/circa-tally-expected.py");
  const ret = "return { fold: fold, g: g, loadMaster: loadMaster, readStock: readStock, build: build, tallyCsv: tallyCsv, checkCsv: checkCsv };";
  const kd = raw.slice(cut).replace(ret, ret.replace(" };", ", masterRatio: masterRatio, ratioFor: ratioFor, num: num, strip: strip };"));
  const core = fs.readFileSync(path.join(KD_DIR, "v2", "core.js"), "utf8");
  const vctx = { self: {}, console, Uint8Array, ArrayBuffer, DataView, TextDecoder, TextEncoder, Date, Math, JSON, Set, Map, Promise, setTimeout };
  vm.createContext(vctx);
  vm.runInContext(raw.slice(0, cut) + "\n" + kd + "\n" + core + "\n;this.__KD2 = KD2; this.__KD = KiemDem; this.__X = XLSX;", vctx);
  const KD2 = vctx.__KD2;
  const wbm = vctx.__X.utils.book_new();
  [["final data v4", V4CSV], ["Adhoc", ADCSV]].forEach(([n, t]) => { const w = vctx.__X.read(t, { type: "string", raw: true, dense: true }); vctx.__X.utils.book_append_sheet(wbm, w.Sheets[w.SheetNames[0]], n); });
  const mV2 = vctx.__KD.loadMaster(wbm);
  // tồn POS dạng app.js loadPos
  const slim = pull.rows.map(x => ({ pid: String(x.product_id), name: x.product_name, base: x.base_unit, q: x.on_hand_qty, seller: x.seller_code || "", sku: x.sku || "", locs: (x.items || []).map(i => ({ loc: i.location_name, q: i.on_hand_qty })), units: (x.retail_units || []).map(u => ({ unit: u.unit, rate: u.convert_rate })) }));
  const v2 = KD2.build(KD2.posFromApi(slim), mV2, new Map(), null, {});
  const E = new Map(v2.rows.map(r => [r.code, r]));
  const sellers = new Map(); pull.rows.forEach(x => { const k = String(x.product_id); if (!sellers.has(k)) sellers.set(k, new Set()); sellers.get(k).add(x.seller_code); });
  let cmp = 0, same = 0, cmpM = 0, cmpG = 0, onlyOne = 0, blank = 0, lech = [], zeroBoth = 0, zeroKept = 0;
  sellers.forEach((set, pid) => {
    if (set.size !== 1) return;
    const mine = res.rows.find(r => r[2] === pid && r[14].indexOf("chỉ có ở NW") !== 0), v = E.get(pid);
    if (!mine && !v) { zeroBoth++; return; }
    if (!mine || !v) {
      // dòng CIRCA tồn 0 giữ lại vì có NW: v2 bỏ qua SP khi S ≤ 0 và không có thẻ → E coi là 0
      if (mine && !v && mine[5] <= 0 && mine[7] === 0) { zeroKept++; return; }
      onlyOne++; lech.push([pid, mine && mine[7], v && v.E, "chỉ một bên có dòng"]); return;
    }
    if (mine[7] === "") { blank++; lech.push([pid, "", v.E, "Code.gs không tính được (quy đổi 0), v2 E " + v.E]); return; }
    cmp++;
    if (v.mSrc === "tên sản phẩm") cmpG++; else cmpM++;
    if (mine[7] === v.E && (mine[8] === "" || Math.abs(mine[8] - v.ratio) < 1e-9)) same++;
    else lech.push([pid, mine[7], v.E, "S " + mine[5] + "/" + v.S + ", quy_doi " + mine[8] + " / v2 " + v.ratio + " " + v.unit + " (" + v.mSrc + ")"]);
  });
  console.log("  SP một seller: " + [...sellers.values()].filter(x => x.size === 1).length + "; so được " + cmp + " (master " + cmpM + ", đoán từ tên " + cmpG + "), bằng nhau (tem + quy đổi) " + same + ", lệch " + (cmp - same) +
    "; cả 2 bỏ (tồn 0) " + zeroBoth + "; CIRCA tồn 0 giữ vì NW (v2 không có dòng, E = 0) " + zeroKept + "; Code.gs trống " + blank + "; chỉ một bên " + onlyOne);
  lech.slice(0, 15).forEach(l => console.log("    lệch " + JSON.stringify(l)));
  ok(cmp - same === 0 && onlyOne === 0 && blank === 0, "rfid = E v2 cho mọi SP một seller (kể cả thiếu master)");
  // SP nhiều seller: v2 tính trên tổng S, Code.gs tính từng dòng
  let multi = 0, multiDiff = [];
  sellers.forEach((set, pid) => {
    if (set.size < 2) return;
    const mine = res.rows.filter(r => r[2] === pid && r[14].indexOf("chỉ có ở NW") !== 0), v = E.get(pid);
    if (!v && !mine.length) return;
    multi++;
    const sum = mine.reduce((a, r) => a + (r[7] === "" ? 0 : r[7]), 0);
    if (!v || sum !== v.E) multiDiff.push([pid, mine.map(r => (r[4] || "khác") + ":" + r[5] + "→" + r[7]).join(" "), v ? "v2 S " + v.S + " → E " + v.E : "v2 không có"]);
  });
  console.log("  SP nhiều seller có tồn: " + multi + "; Σ rfid từng dòng ≠ E v2 tính trên tổng (do làm tròn lên từng dòng): " + multiDiff.length);
  multiDiff.slice(0, 5).forEach(l => console.log("    " + JSON.stringify(l)));
}
done();

function done() {
  console.log((fail ? "CÓ LỖI: " : "OK: ") + pass + " đạt, " + fail + " lỗi");
  process.exitCode = fail ? 1 : 0;
}
