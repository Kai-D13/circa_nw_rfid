// DRY-RUN "NW kiểm kê → Circa kiểm kê". CHỈ ĐỌC / OFFLINE: không gọi mạng, không dùng token, không gửi gì lên Circa/NW.
// Đọc file xuất phiên kiểm kê NW + kết quả tra qr-lookup Circa đã kéo sẵn (+ tuỳ chọn lượt quét đã lưu của phiên Circa
// đích), chạy lõi NWC (core.js), in tóm tắt và ghi:
//   <outDir>/dry-run.json           kế hoạch đầy đủ: tổng, lý do chặn, theo SP, từng thẻ, các body sẽ gửi, mô phỏng đường ống
//   <outDir>/dry-run-theo-sp.csv    1 dòng / SP, có Kết luận + Việc cần làm (UTF-8 có BOM)
//   <outDir>/dry-run-theo-the.csv   tham chiếu 1 dòng / thẻ (UTF-8 có BOM)
// Đối chiếu thêm (chỉ đọc): sheet "Danh sách kiểm kê" (Đã đếm / Thủ công theo SP) và sổ records/pos-writes (mã đã gửi thử).
// File đang mở trong Excel (EBUSY/EPERM) → ghi tên mới có hậu tố giờ, không xoá file cũ.
//
// Dùng (cwd bất kỳ):
//   [SCANS=<scans.json>] [SESSION_ID=<id>] [DEVICE_ID=<tên>] node tools/nw-sang-circa/dry-run.js [kiem-ke.xlsx] [qr-lookup.json] [outDir]
//   Mặc định: work/20261121-nw-sang-circa-kiem-ke/in/kiem-ke-lumina-2026-11-21-15-42.xlsx,
//             work/20261121-nw-sang-circa-kiem-ke/phien/qr-lookup.json, work/20261121-nw-sang-circa-kiem-ke/out
//   SCANS: lượt quét đã lưu của PHIÊN CIRCA ĐÍCH (mảng, hoặc {scans}/{data:{scans}} của GET …/sessions/<id>/scans, đã kéo sẵn)
//          → loại mã đã có khỏi lô (báo riêng) + checkScans kế hoạch với phiên hiện tại. Không có SCANS: coi phiên đích rỗng.
//   SESSION_ID / DEVICE_ID chỉ để điền body mẫu (mặc định "<SESSION_ID>", "NW-RFID").
// Đầu vào: sheet "Chi tiết quét" + "Thẻ lạ" của file xuất NW; qr-lookup.json dạng {at, current, res:[{code, status, d}]}.
"use strict";
const fs = require("fs"), path = require("path");
const NWC = require("./core.js");
const sim = require("./sim.js");

const ROOT = path.resolve(__dirname, "..", "..");
const W = path.join(ROOT, "work/20261121-nw-sang-circa-kiem-ke");
const XLSX_F = path.resolve(process.argv[2] || path.join(W, "in/kiem-ke-lumina-2026-11-21-15-42.xlsx"));
const QR_F = path.resolve(process.argv[3] || path.join(W, "phien/qr-lookup.json"));
const OUT = path.resolve(process.argv[4] || path.join(W, "out"));
const DEVICE = process.env.DEVICE_ID || "NW-RFID";
const SESSION = process.env.SESSION_ID || "<SESSION_ID>";
const SCANS_F = process.env.SCANS ? path.resolve(process.env.SCANS) : null;

const { XLSX } = require(path.join(ROOT, ".claude/skills/circa-nextwaves-check/scripts/kiem-dem/load-tool.js"));
const wb = XLSX.read(fs.readFileSync(XLSX_F), { type: "buffer" });
for (const s of ["Chi tiết quét", "Thẻ lạ"]) if (!wb.Sheets[s]) { console.error("Không có sheet \"" + s + "\" trong " + XLSX_F); process.exit(2); }
const rows = XLSX.utils.sheet_to_json(wb.Sheets["Chi tiết quét"], { defval: "" });
const la = XLSX.utils.sheet_to_json(wb.Sheets["Thẻ lạ"], { defval: "" });
const qr = JSON.parse(fs.readFileSync(QR_F, "utf8"));
let scans = null;
if (SCANS_F) { const j = JSON.parse(fs.readFileSync(SCANS_F, "utf8")); scans = Array.isArray(j) ? j : (j.scans || (j.data && j.data.scans) || []); }

const ses = NWC.parseSession(rows, la);
const lookups = NWC.lookupMap(qr.res);
const P = NWC.plan(ses, lookups);
const S = P.sum;
let B = [], batchErr = null;
try { B = NWC.batches(P.items, SESSION, DEVICE, scans || []); } catch (e) { batchErr = String(e.message || e); }
const lotOf = {};
B.forEach((b, i) => NWC.bodyCodes(b).forEach(c => { lotOf[NWC._codeKey(c)] = i + 1; }));
const CS = scans ? NWC.checkScans(P.items, scans) : null;
const csSp = {};
if (CS) CS.bySp.forEach(p => { csSp[p.pid] = p; });

// ĐƯỜNG ỐNG mô phỏng (sim.js, KHÔNG phải số Circa thật): phiên đích (có sẵn SCANS nếu có) nhận đúng các lô ở trên
const simS = sim.session(scans || []);
B.forEach(b => simS.submit(b, lookups));
const simOk = NWC.checkScans(P.items, simS.scans());
const simRawS = sim.session();
NWC.batches(P.items, SESSION, DEVICE).forEach(b => simRawS.submit(b, lookups, { raw: true }));
const simRaw = NWC.checkScans(P.items, simRawS.scans());

// ---------- in tóm tắt ----------
const n = x => Number(x).toLocaleString("vi-VN");
console.log("DRY-RUN NW → Circa (chỉ đọc, không gửi)");
console.log("  file NW   : " + XLSX_F);
console.log("  qr-lookup : " + QR_F + " (tra lúc " + (qr.at || "?") + ")");
const cur = qr.current && qr.current.j && qr.current.j.data;
if (cur) console.log("  phiên Circa đang mở lúc tra: " + cur.code + " " + cur.status + " (" + cur.id + ")");
console.log("  lượt quét phiên đích: " + (SCANS_F ? SCANS_F + " (" + scans.length + " lượt)" : "không có SCANS → coi phiên đích rỗng"));
console.log("Đọc phiên: " + ses.tags.length + " thẻ, " + new Set(ses.tags.map(t => t.pid)).size + " SP, gốc NW " + n(ses.tags.reduce((a, t) => a + t.nwQty, 0)) +
  "; thẻ lạ " + ses.strange.length + "; lỗi " + ses.errors.length + "; bỏ qua " + ses.skipped.length + "; cảnh báo " + ses.warnings.length);
ses.errors.slice(0, 20).forEach(e => console.log("  LỖI " + e.msg));
ses.skipped.slice(0, 20).forEach(e => console.log("  BỎ QUA dòng " + e.row + " " + e.epc + ": " + e.reason + (e.value ? " (" + e.value + ")" : "")));
ses.warnings.slice(0, 20).forEach(e => console.log("  CẢNH BÁO " + e.msg));
console.log("Kế hoạch: tho " + S.modes.tho + " · kem-don-vi " + S.modes["kem-don-vi"] + " · giu " + S.modes.giu + " · khong-nhan " + S.modes["khong-nhan"] + " · chua-tra " + S.modes["chua-tra"]);
console.log("  gửi qua EPC " + S.via.EPC + ", qua UID " + S.via.UID + "; gốc NW thẻ gửi " + n(S.sendBase) + ", gốc Circa dự tính theo payload " + n(S.predBase) +
  " (thẻ lệch " + S.predMismatch + "), gốc không gửi " + n(S.holdBase));
console.log("  okToSend = " + S.okToSend + (S.blockers.length ? "; LÝ DO CHẶN: " + S.blockers.join(" | ") : ""));
if (batchErr) console.log("  KHÔNG CHIA LÔ ĐƯỢC: " + batchErr);
else {
  console.log("  " + B.length + " lô: " + B.map((b, i) => "#" + (i + 1) + " " + (b.tags || []).length + " thô + " + (b.items || []).length + " kèm đv" + (b.items ? "" : " (không khoá items)")).join(", "));
  if (B.excluded.length) {
    console.log("  Loại khỏi lô vì phiên đích đã có: " + B.excluded.length + " mã");
    B.excluded.slice(0, 20).forEach(x => console.log("    " + x.code + " SP " + x.pid + " (" + x.why + (x.matched !== x.code ? ", phiên có " + x.matched : "") + ")"));
  }
}
const kemSp = P.bySp.filter(p => p.modes["kem-don-vi"]);
if (kemSp.length) {
  console.log("SP lệch quy đổi (gửi kèm đơn vị gốc): " + kemSp.length);
  kemSp.forEach(p => {
    const its = P.items.filter(x => x.pid === p.pid && x.mode === "kem-don-vi");
    const raw = its.reduce((a, x) => a + x.circaRate, 0), nw = its.reduce((a, x) => a + x.nwQty, 0);
    console.log("  " + String(p.pid).padEnd(8) + " " + its.length + " thẻ, NW " + nw + " " + p.nwUnit + " | Circa mã = " + p.circaUnits + " | gửi thô sẽ ghi " + raw + " | " + p.name.slice(0, 60));
  });
}
const notSent = P.items.filter(x => x.mode !== "tho" && x.mode !== "kem-don-vi");
if (notSent.length) {
  console.log("Thẻ KHÔNG gửi: " + notSent.length);
  notSent.forEach(x => console.log("  " + x.mode.padEnd(10) + " SP " + x.pid + " " + x.epc + (x.uid && x.uid !== x.epc ? " / " + x.uid : "") + " NW " + x.nwQty + " " + x.nwUnit + ": " + x.reason));
} else console.log("Thẻ KHÔNG gửi: 0");
// đối chiếu với sheet "Danh sách kiểm kê" (Đã đếm theo SP, Thủ công) nếu có
let doiChieu = null;
if (wb.Sheets["Danh sách kiểm kê"]) {
  const ds = XLSX.utils.sheet_to_json(wb.Sheets["Danh sách kiểm kê"], { defval: "" });
  const dem = {}, tc = {};
  ds.forEach(r => {
    const pid = +String(r["Mã SP"]).trim().replace(/^CIRCA-/i, "");
    if (+r["Đã đếm"]) dem[pid] = (dem[pid] || 0) + +r["Đã đếm"];
    if (+r["Thủ công"]) tc[pid] = (tc[pid] || 0) + +r["Thủ công"];
  });
  const nw = {};
  P.bySp.forEach(p => { nw[p.pid] = p.predBase + p.holdBase; });
  const lech = [...new Set(Object.keys(dem).concat(Object.keys(nw)))].filter(k => (dem[k] || 0) !== (nw[k] || 0)).map(k => ({ pid: +k, daDem: dem[k] || 0, keHoach: nw[k] || 0, thuCong: tc[k] || 0 }));
  doiChieu = { spDaDem: Object.keys(dem).length, tongDaDem: Object.values(dem).reduce((a, x) => a + x, 0), tongThuCong: Object.values(tc).reduce((a, x) => a + x, 0), lech };
  console.log("Đối chiếu 'Danh sách kiểm kê': " + doiChieu.spDaDem + " SP đã đếm, tổng " + n(doiChieu.tongDaDem) + ", thủ công " + doiChieu.tongThuCong +
    ", SP lệch với kế hoạch (gốc dự tính + gốc không gửi) " + lech.length);
  lech.slice(0, 20).forEach(x => console.log("  SP " + x.pid + ": Đã đếm " + x.daDem + " ≠ kế hoạch " + x.keHoach + (x.thuCong ? " (thủ công " + x.thuCong + ", không có thẻ để gửi)" : "")));
}
// mã của kế hoạch đã từng gửi thử lên Circa (sổ records/pos-writes, chỉ đọc)
const daGui = [];
const RECD = path.join(ROOT, "records/pos-writes");
if (fs.existsSync(RECD)) {
  const byCode = {};
  P.items.forEach(x => { if (x.code) byCode[NWC._codeKey(x.code)] = x; });
  for (const f of fs.readdirSync(RECD).filter(f => f.endsWith(".record.json")).sort()) {
    let j, pl = {};
    try { j = JSON.parse(fs.readFileSync(path.join(RECD, f), "utf8")); } catch (e) { continue; }
    try { pl = JSON.parse(fs.readFileSync(path.join(RECD, f.replace(/\.record\.json$/, ".payload.json")), "utf8")); } catch (e) { /* không có payload */ }
    const sid = pl.body && pl.body.session_id || "?";
    const resps = [j.lan1, j.lan2, j].filter(x => x && x.j && x.j.data && Array.isArray(x.j.data.resolved_tags));
    const seen = {};
    resps.forEach(r => r.j.data.resolved_tags.forEach(g => {
      const k = NWC._codeKey(g.tag), it = byCode[k];
      if (!it || seen[k]) return;
      seen[k] = 1;
      daGui.push({ file: f, session_id: sid, code: g.tag, pid: it.pid, ghi: g.base_quantity, keHoach: it.expectBase, dung: g.base_quantity === it.expectBase && g.product_id === it.pid });
    }));
  }
  if (daGui.length) {
    console.log("Mã đã gửi thử trước đây (records/pos-writes): " + daGui.length + " mã, phiên " + [...new Set(daGui.map(x => x.session_id))].join(", ") + "; ghi khác kế hoạch " + daGui.filter(x => !x.dung).length +
      " → không gửi vào phiên đó; nếu buộc phải dùng, chạy với SCANS của phiên để loại mã đã có");
  }
}
if (CS) {
  console.log("checkScans kế hoạch ↔ phiên đích hiện tại: " + Object.entries(CS.sum.counts).map(([k, v]) => k + " " + v).join(", ") + "; lượt ngoài " + CS.foreign.length + " (" + CS.sum.foreignBase + " gốc)");
  CS.rows.filter(r => r.result !== "dung" && r.result !== "thieu").slice(0, 20).forEach(r => console.log("  " + r.result.padEnd(7) + " " + r.code + " SP " + r.pid + ": " + r.msg));
  CS.foreign.slice(0, 20).forEach(f => console.log("  ngoài   " + f.code + " SP " + f.product_id + " " + f.base_qty + " gốc: " + f.why));
}
console.log("Đường ống mô phỏng (sim.js, giả định trong sim.js; KHÔNG phải số Circa thật):");
console.log("  gửi các lô trên → phiên ghi " + n(simOk.sum.circaBase) + " + lượt ngoài " + n(simOk.sum.foreignBase) + " / NW " + n(simOk.sum.nwBase) + "; " +
  Object.entries(simOk.sum.counts).filter(e => e[1]).map(([k, v]) => k + " " + v).join(", ") + "; ok " + simOk.ok);
console.log("  gửi thô hết vào phiên rỗng → phiên ghi " + n(simRaw.sum.circaBase) + ", " + simRaw.sum.counts["sai-so"] + " thẻ sai-so ở " + simRaw.bySp.filter(p => p.diff !== 0).length + " SP");

// ---------- ghi file ----------
fs.mkdirSync(OUT, { recursive: true });
function stamp() { const d = new Date(), p = v => String(v).padStart(2, "0"); return p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
function writeSafe(file, data) {
  try { fs.writeFileSync(file, data); return file; }
  catch (e) {
    if (e.code !== "EBUSY" && e.code !== "EPERM") throw e;
    const ext = path.extname(file), alt = file.slice(0, -ext.length) + "-" + stamp() + ext;
    fs.writeFileSync(alt, data);
    console.log("  (" + path.basename(file) + " đang mở, ghi sang " + path.basename(alt) + ")");
    return alt;
  }
}
const csvCell = v => { const s = v == null ? "" : String(v); return /[",\r\n;]/.test(s) ? "\"" + s.replace(/"/g, "\"\"") + "\"" : s; };
const csv = (head, data) => "﻿" + [head].concat(data).map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

const sev = p => (p.modes["chua-tra"] || p.modes["khong-nhan"] || p.modes.giu || p.predMismatch) ? 0 : p.modes["kem-don-vi"] ? 1 : 2;
const spHead = ["Mã SP", "Tên sản phẩm", "ĐVT NW", "Số thẻ", "Gốc NW", "Gốc Circa dự tính (payload)", "Gốc không gửi", "Chênh", "Thẻ gửi thô", "Thẻ kèm đơn vị",
  "Thẻ giữ", "Thẻ Circa không nhận", "Thẻ chưa tra", "Thẻ gửi qua UID", "Đơn vị mã trên Circa", "Gốc nếu gửi thô hết"]
  .concat(CS ? ["Phiên đích đã có (gốc, mã kế hoạch)", "Phiên đích lượt ngoài (gốc)", "Kết luận phiên đích"] : [])
  .concat(["Kết luận", "Việc cần làm"]);
const spRows = P.bySp.slice().sort((a, b) => sev(a) - sev(b) || a.name.localeCompare(b.name, "vi")).map(p => {
  const c = csSp[p.pid];
  return [p.pid, p.name, p.nwUnit, p.tags, p.nwBase, p.predBase, p.holdBase, p.diff,
    p.modes.tho, p.modes["kem-don-vi"], p.modes.giu, p.modes["khong-nhan"], p.modes["chua-tra"], p.via.UID, p.circaUnits,
    P.items.filter(x => x.pid === p.pid).reduce((a, x) => a + (x.circaRate || 0), 0)]
    .concat(CS ? [c ? c.circaBase : 0, c ? c.foreignBase : 0, c ? c.ketLuan : ""] : [])
    .concat([p.ketLuan, p.viecCanLam]);
});
const tagRows = P.items.map(x => [
  x.pid, x.name, x.epc, x.uid, x.code || "", x.via || "", x.nwQty, x.nwUnit, x.circaUnit || "", x.circaRate == null ? "" : x.circaRate, x.baseUnit || "",
  x.mode, x.mode === "kem-don-vi" ? x.send.quantity + " " + x.send.unit_name : x.mode === "tho" ? "thô" : "", x.expectBase,
  lotOf[NWC._codeKey(x.code)] || (B.excluded && B.excluded.some(e => NWC._codeKey(e.code) === NWC._codeKey(x.code)) ? "đã có trong phiên" : ""), x.reason
]);
const tagHead = ["Mã SP", "Tên sản phẩm", "EPC", "UID", "Mã gửi", "Qua", "SL NW", "ĐVT NW", "Đơn vị mã Circa", "Quy đổi Circa", "Đơn vị gốc Circa",
  "Cách gửi", "Gửi kèm", "Gốc sẽ ghi", "Lô", "Lý do"];

const json = {
  chiDoc: true, ghiChu: "Dry-run offline: chưa gửi gì. session_id trong batches là " + SESSION + ". Phần sim là mô phỏng đường ống, không phải số Circa thật.",
  at: new Date().toISOString(),
  input: { xlsx: XLSX_F, qrLookup: QR_F, qrLookupAt: qr.at || null, scans: SCANS_F, circaSessionLucTra: cur ? { id: cur.id, code: cur.code, status: cur.status } : null },
  parse: { tags: ses.tags.length, strange: ses.strange, errors: ses.errors, skipped: ses.skipped, warnings: ses.warnings },
  doiChieuDanhSach: doiChieu, maDaGuiThu: daGui,
  sum: S, bySp: P.bySp, items: P.items, batchError: batchErr, batches: B, excluded: B.excluded || [],
  checkScans: CS ? { sum: CS.sum, problems: CS.rows.filter(r => r.result !== "dung" && r.result !== "thieu"), foreign: CS.foreign } : null,
  sim: { theoKeHoach: simOk.sum, guiThoHet: simRaw.sum }
};
const files = [
  writeSafe(path.join(OUT, "dry-run.json"), JSON.stringify(json, null, 1)),
  writeSafe(path.join(OUT, "dry-run-theo-sp.csv"), csv(spHead, spRows)),
  writeSafe(path.join(OUT, "dry-run-theo-the.csv"), csv(tagHead, tagRows)),
];
console.log("Đã ghi:\n  " + files.join("\n  "));
