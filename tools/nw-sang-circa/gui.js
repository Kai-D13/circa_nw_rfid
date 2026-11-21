// GHI LÊN CIRCA. Chỉ PM chạy, sau khi user đồng ý rõ trong chat.
// Tạo (hoặc dùng) một phiên kiểm kê Circa rồi gửi mọi thẻ của phiên kiểm kê NW vào đó, đối chiếu lượt quét đã lưu.
// Phiên được để ở trạng thái MỞ. Không đóng, không duyệt.
//
// Dùng (cwd = thư mục repo):
//   POS_TOKEN=... node tools/nw-sang-circa/gui.js <kiem-ke.xlsx> <qr-lookup.json> <nhãn sổ ghi> --tao
//   POS_TOKEN=... node tools/nw-sang-circa/gui.js <kiem-ke.xlsx> <qr-lookup.json> <nhãn sổ ghi> <sessionId>
// Sổ ghi: records/pos-writes/<nhãn>.*.json (payload ghi TRƯỚC khi gửi, record ghi sau).
const fs = require("fs"), path = require("path");
const NWC = require("./core.js");
const ROOT = path.resolve(__dirname, "../..");
const { XLSX } = require(path.join(ROOT, ".claude/skills/circa-nextwaves-check/scripts/kiem-dem/load-tool.js"));
const [, , XLS, QR, LABEL, TARGET] = process.argv;
if (!XLS || !QR || !LABEL || !TARGET) { console.error("thiếu tham số"); process.exit(2); }
if (!process.env.POS_TOKEN) { console.error("thiếu POS_TOKEN"); process.exit(2); }

const POS = "31493e74-3404-4c0e-a906-93691a6ee319"; // Lumina
const LOC = "0357db7a-f9be-4a9a-a70d-d70df7936503"; // vị trí General của Lumina
const B = "https://api.v2.circa.vn/v1/inventory/count";
const DEVICE = "NW-RFID";
const H = {
  Authorization: "Bearer " + process.env.POS_TOKEN, "X-Circa-App": "admin", "X-Client-Id": "1", "X-Store-Id": POS,
  "Grpc-Timeout": "30S", "Content-Type": "application/json; charset=UTF-8",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36",
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REC = path.join(ROOT, "records/pos-writes", LABEL);
const save = (suffix, o) => fs.writeFileSync(REC + "." + suffix + ".json", JSON.stringify(o, null, 1));

async function call(method, url, body) {
  try {
    const r = await fetch(B + url, { method, headers: H, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 500) }; }
    return { status: r.status, j };
  } catch (e) { return { status: 0, j: { err: String(e) } }; }
}
async function allScans(sid) {
  const r = await call("GET", "/sessions/" + sid + "/scans?limit=5000");
  if (r.status !== 200) throw new Error("đọc lượt quét lỗi " + r.status + " " + JSON.stringify(r.j).slice(0, 200));
  if (r.j.data.has_more) throw new Error("lượt quét còn trang sau (has_more) — chưa hỗ trợ, dừng");
  return r.j.data.scans || [];
}

(async () => {
  // 1. Kế hoạch (offline)
  const wb = XLSX.read(fs.readFileSync(XLS), { type: "buffer" });
  const ses = NWC.parseSession(XLSX.utils.sheet_to_json(wb.Sheets["Chi tiết quét"], { defval: "" }), XLSX.utils.sheet_to_json(wb.Sheets["Thẻ lạ"], { defval: "" }));
  const P = NWC.plan(ses, NWC.lookupMap(JSON.parse(fs.readFileSync(QR, "utf8")).res));
  console.log("kế hoạch: okToSend", P.sum.okToSend, "| blockers", JSON.stringify(P.sum.blockers || []));
  if (!P.sum.okToSend) { console.log("DỪNG: kế hoạch chưa đạt"); return; }

  // 2. Phiên đích
  let sid = TARGET;
  if (TARGET === "--tao") {
    const body = {
      pos_id: POS, scheduled_date: new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10), counting_mode: "QR", sync_baseline: true,
      designated_main_location_id: LOC, cleanup_missing: false, auto_approve_tolerance_pct: 2, auto_approve_tolerance_value: 50000,
      force_manual_review: false, allow_ad_hoc_sku: true, auto_writeoff_orphan_ghosts: false,
    };
    save("tao-phien.payload", { at: new Date().toISOString(), url: B + "/sessions", body });
    const r = await call("POST", "/sessions", body); // KHÔNG tự gửi lại: gửi lại có thể tạo 2 phiên
    save("tao-phien.record", { at: new Date().toISOString(), r });
    const s = r.j.data && r.j.data.session;
    if (r.status !== 200 || !s) { console.log("DỪNG: tạo phiên lỗi", r.status, JSON.stringify(r.j).slice(0, 400)); return; }
    sid = s.id; console.log("đã tạo phiên", s.code, sid, s.status);
  }
  let st = "";
  for (let i = 0; i < 60; i++) {
    const r = await call("GET", "/sessions/" + sid); const s = r.j.data && (r.j.data.session || r.j.data); st = s && s.status;
    if (st === "OPEN") { console.log("phiên", s.code, "OPEN"); break; }
    if (st && st !== "LOADING_BASELINE") break;
    await sleep(3000);
  }
  if (st !== "OPEN") { console.log("DỪNG: phiên không mở, trạng thái", st); return; }

  // 3. Lượt quét đã có trong phiên → loại khỏi lô
  const before = await allScans(sid);
  console.log("lượt quét có sẵn trong phiên:", before.length);
  const bodies = NWC.batches(P.items, sid, DEVICE, before);
  console.log("số lô:", bodies.length, "| mã bị loại vì đã có:", (bodies.excluded || []).length);
  save("lo.payload", { at: new Date().toISOString(), session_id: sid, bodies, excluded: bodies.excluded || [] });

  // 4. Gửi tuần tự; 5xx/timeout thì gửi lại nguyên lô (1s, 2s, 4s); sai một thẻ là dừng
  const log = []; let stop = "";
  for (let i = 0; i < bodies.length && !stop; i++) {
    const bi = NWC.itemsFor(bodies[i], P.items); let r, tries = 0, resend = false;
    for (;;) {
      r = await call("POST", "/submit-rfid-batch", bodies[i]); tries++;
      if (r.status === 200 || (r.status >= 400 && r.status < 500) || tries > 3) break;
      resend = true; await sleep(1000 << (tries - 1));
    }
    const chk = r.status === 200 && r.j.data ? NWC.checkResponse(bi, r.j.data, { resend }) : null;
    log.push({ lo: i + 1, at: new Date().toISOString(), tries, status: r.status, response: r.j, check: chk && { ok: chk.ok, counts: chk.counts, bad: chk.rows.filter(x => x.result !== "dung") } });
    save("lo.record", { session_id: sid, log });
    console.log("lô", i + 1, "/", bodies.length, "status", r.status, "lần gửi", tries, chk ? "ok=" + chk.ok + " " + JSON.stringify(chk.counts) : JSON.stringify(r.j).slice(0, 300));
    if (!chk || !chk.ok) stop = "lô " + (i + 1) + " không đạt";
  }
  if (stop) console.log("DỪNG GỬI:", stop);

  // 5. Đối chiếu lượt quét đã lưu
  const after = await allScans(sid);
  fs.writeFileSync(REC + ".scans-sau.json", JSON.stringify(after));
  const cs = NWC.checkScans(P.items, after);
  save("doi-chieu", { at: new Date().toISOString(), session_id: sid, ok: cs.ok, sum: cs.sum, foreign: cs.foreign, bad: (cs.rows || []).filter(x => x.result !== "dung"), bySp: cs.bySp });
  const nw = P.items.reduce((a, x) => a + x.nwQty, 0), ci = after.reduce((a, x) => a + Number(x.base_qty), 0);
  console.log("ĐỐI CHIẾU: ok", cs.ok, JSON.stringify(cs.sum.counts), "| lượt ngoài kế hoạch", (cs.foreign || []).length);
  console.log("gốc NW", nw, "| gốc Circa đã lưu", ci, "| lượt quét", after.length, "| SP chênh", (cs.bySp || []).filter(p => p.diff).length);
  console.log("phiên:", sid, "— để MỞ");
})().catch(e => { console.error("LỖI:", e.message); process.exit(1); });
