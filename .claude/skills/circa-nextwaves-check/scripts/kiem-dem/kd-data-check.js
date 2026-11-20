// READ-ONLY. Deep data check of a product list before building a Kiểm đếm import file.
// Uses the pulls saved by v2/r2.js (pos-rows.json, nw-ledger-raw.json, pend.json, verify-pos.json from r2-verify-pos.js)
// and fetches the master Google Sheet again (public gviz CSV) to show every unit/rate of each product.
// usage: node kd-data-check.js <r2 dir> <codes.json> <out.xlsx>     (needs v2/worker-bundle.js from build.js)
const fs = require("fs"), path = require("path"), vm = require("vm");
const [DIR, codesF, OUT] = process.argv.slice(2);
const codes = JSON.parse(fs.readFileSync(codesF, "utf8")).map(String), CODES = new Set(codes);
const ctx = { self: { postMessage() {} }, console, Uint8Array, ArrayBuffer, DataView, TextDecoder, TextEncoder, Date, Math, JSON, Set, Map, Promise, setTimeout, Intl };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "v2", "worker-bundle.js"), "utf8") + "\n;this.__KD2 = KD2; this.__K = KiemDem; this.__X = XLSX;", ctx);
const KD2 = ctx.__KD2, K = ctx.__K, XLSX = ctx.__X;
const J = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
const vn = (ms) => (ms ? new Date(ms + 7 * 3600e3).toISOString().slice(0, 16).replace("T", " ") : "");
const r3 = (x) => Math.round(x * 1000) / 1000;
(async () => {
  const base = "https://docs.google.com/spreadsheets/d/18nLllIlORaki3por1diKzNo2tWvdVyUnB1xbZXDv8Xc/gviz/tq?tqx=out:csv&headers=1&sheet=";
  const v4 = await (await fetch(base + encodeURIComponent("final data v4") + "&tq=" + encodeURIComponent("select A,B,C,D,E"))).text();
  const ad = await (await fetch(base + "Adhoc")).text();
  const wb = XLSX.utils.book_new();
  for (const [n, t] of [["final data v4", v4], ["Adhoc", ad]]) { const w = XLSX.read(t, { type: "string", raw: true, dense: true }); XLSX.utils.book_append_sheet(wb, w.Sheets[w.SheetNames[0]], n); }
  const master = K.loadMaster(wb);
  const v4rows = XLSX.utils.sheet_to_json(wb.Sheets["final data v4"], { header: 1, defval: "" }), v4h = v4rows[0].map((x) => K.fold(String(x)));
  const adRows = XLSX.utils.sheet_to_json(wb.Sheets["Adhoc"], { header: 1, defval: "" });
  const rawM = new Map(); for (const r of v4rows.slice(1)) { const c = String(r[v4h.indexOf("product_id")]).trim(); if (CODES.has(c)) { if (!rawM.has(c)) rawM.set(c, []); rawM.get(c).push(r.join(" | ")); } }
  const inAdhoc = new Set(adRows.slice(1).map((r) => String(r[0]).trim()).filter((c) => CODES.has(c)));
  if (!v4h.includes("product_id") || !v4h.includes("final_unit_print")) throw new Error("master header wrong: " + v4rows[0].join(","));

  const P = J("pos-rows.json"), L = J("nw-ledger-raw.json"), PD = J("pend.json"), V = fs.existsSync(path.join(DIR, "verify-pos.json")) ? J("verify-pos.json") : {};
  const pos = KD2.posFromApi(P.rows), tags = KD2.tagsFromLedger(L);
  const pend = new Map(); for (const [c, q, o] of PD.pend) { if (!pend.has(String(c))) pend.set(String(c), []); pend.get(String(c)).push([q, o]); }
  const B = KD2.build(pos, master, tags, null, { exclude: ["Kho thất lạc"], addPending: false }, null), by = new Map(B.rows.map((r) => [r.code, r]));
  const prev = J("build-pos.json"), prevBy = new Map(prev.rows.map((r) => [String(r.code), r]));
  const linesBy = new Map(); for (const r of P.rows) if (CODES.has(r.pid)) { if (!linesBy.has(r.pid)) linesBy.set(r.pid, []); linesBy.get(r.pid).push(r); }
  const lastIn = new Map(), firstIn = new Map();
  for (const r of L) if (CODES.has(r.c) && r.q > 0 && /stock_in|pack_in|transfer/.test(r.t)) { const t = Date.parse(r.at); if (!(lastIn.get(r.c) >= t)) lastIn.set(r.c, t); if (!(firstIn.get(r.c) <= t)) firstIn.set(r.c, t); }
  const fold = (s) => K.fold(String(s || ""));
  const dist = (a) => { const m = new Map(); for (const x of a) m.set(x, (m.get(x) || 0) + 1); return [...m.entries()].sort((x, y) => y[1] - x[1]).map(([q, n]) => `${n} thẻ × ${K.g(q)}`).join(" + "); };

  const prev0 = new Map(); if (process.env.PREV_SESS) { const w = XLSX.read(fs.readFileSync(process.env.PREV_SESS), { type: "buffer" }), a = XLSX.utils.sheet_to_json(w.Sheets["Tổng hợp"], { header: 1, defval: "" }); const hi = a.findIndex((x) => x.includes("Dự kiến") && x.includes("Trạng thái")), h = a[hi], ic = h.findIndex((k) => /Mã sản phẩm|Mã vạch/.test(k)), id = h.indexOf("Đã đếm"); for (const x of a.slice(hi + 1)) prev0.set(String(x[ic]).replace(/^CIRCA-/, ""), Number(x[id]) || 0); }
  const readPrev0 = (c) => prev0.get(c) || 0;
  const out = [], tally = {};
  for (const c of codes) {
    const r = by.get(c), p = pos.get(c), t = tags.get(c), e = master.get(c), ls = linesBy.get(c) || [];
    const issues = [], info = [];
    if (!r) { out.push([c, "", "KHÔNG CÓ DỮ LIỆU", "Không có tồn POS và không có thẻ NW"]); continue; }
    // 1. POS
    const neg = ls.some((x) => Number(x.q) < 0 || (x.locs || []).some((l) => Number(l.q) < 0));
    if (neg) issues.push("POS có dòng/vị trí tồn ÂM");
    if (!(r.S > 0)) issues.push("Tồn POS = " + r.S + " (Dự kiến 0)" + (readPrev0(c) ? `; phiên trước vẫn đọc được ${readPrev0(c)} thẻ → hàng thật còn, POS có thể thấp` : ""));
    const v = V[c]; const vOk = v ? Math.abs(v.q - r.S) < 1e-6 : null;
    if (v && !vOk) issues.push(`Tồn POS kéo hàng loạt ${r.S} ≠ trang tồn từng mã ${v.q}`);
    if (r.lost) info.push("Kho thất lạc " + r.lost + " (không tính)");
    const pd = pend.get(c) || [];
    if (pd.length) issues.push(`Đơn ONLINE chờ giao ${pd.map((x) => x[1] + ":" + x[0]).join(", ")} → POS đã trừ nhưng hàng có thể còn trên kệ; RFID sẽ đọc dư nếu không tách riêng`);
    // 2. master
    const mr = e ? K.masterRatio(e, r.posBase) : null;
    const munits = e ? [...e.units.values()].map((u) => u[0] + "=" + K.g(u[1])).join(", ") : "";
    if (!e) issues.push("Không có trong master");
    else if (!mr) issues.push("Master không có đơn vị in (" + e.print + ") hoặc không quy được về " + r.posBase);
    else if (mr[2]) issues.push("Master: " + mr[2]);
    // 3. name
    const nm = K.ratioFor(r.name, r.posBase), nameTxt = nm && nm[1] ? nm[0] + " = " + K.g(nm[1]) : "";
    const nameAgree = nm && nm[1] && mr ? (Math.abs(nm[1] - mr[1]) < 1e-6 ? "khớp" : fold(nm[0]) === fold(mr[0]) ? "KHÁC quy đổi" : "khác đơn vị") : "";
    const nwConfirms = t && t.sizes.size === 1 && mr && Math.abs([...t.sizes.keys()][0] - mr[1]) < 1e-6;
    if (nameAgree === "KHÁC quy đổi" && !nwConfirms) issues.push(`Tên SP gợi ý 1 ${nm[0]} = ${K.g(nm[1])} ${r.posBase}, master ${K.g(mr[1])} → kiểm tra master`);
    // 4. NW
    const T = t ? t.qs.length : 0, qsNow = t ? t.qs.map(r3) : [];
    const nwBase = t ? t.base : "", nwTitle = t ? t.title : "";
    if (t && nwBase && fold(nwBase) !== fold(r.posBase)) issues.push(`Đơn vị gốc NW (${nwBase}) ≠ POS (${r.posBase})`);
    if (t && nwTitle && p && fold(nwTitle) !== fold(p.name)) info.push("Tên trên NW khác tên POS: " + nwTitle);
    if (r.hold) issues.push("QUY ĐỔI LỆCH (master ≠ tem thật trên NW): " + r.hold);
    if (T > r.E) info.push(`NW có ${T} thẻ, nhiều hơn Dự kiến ${T - r.E} (đã bán/chuyển chưa trừ NW, hoặc hộp lẻ)`);
    if (r.M > 0) info.push(`Cần gắn thêm ${r.M} tem + nhập NW trước khi kiểm`);
    const partial = r.ratio ? qsNow.filter((q) => Math.abs(q - r.ratio * (fold(nwBase) === fold(r.posBase) || !nwBase ? 1 : 1)) > 1e-6).length : 0;
    // 5. consistency with the r2.js build
    const pr = prevBy.get(c); if (pr && (pr.E !== r.E || pr.ratio !== r.ratio || pr.S !== r.S)) issues.push(`Khác bản build r2.js (E ${pr.E}→${r.E})`);
    const verdict = r.hold ? "ĐỂ RIÊNG: quy đổi lệch, cần bạn xác nhận" : !e || !mr ? "ĐỂ RIÊNG: thiếu master" : issues.length ? "VÀO IMPORT, có cảnh báo cần xem" : r.M > 0 ? "VÀO IMPORT, cần gắn thêm tem trước" : "VÀO IMPORT, OK";
    tally[verdict] = (tally[verdict] || 0) + 1;
    out.push([c, r.name, verdict, issues.join(" | "), info.join(" | "),
      r.S, r.posBase, ls.length, [...new Set(ls.map((x) => x.seller))].join(", "), (r.locs || []).map((l) => `${l[0] || "(trống)"}:${K.g(l[1])}`).join(", "), r.lost || "", v ? (vOk ? "khớp" : "LỆCH " + v.q) : "chưa kiểm", pd.map((x) => x[1] + ":" + x[0]).join(", "),
      e ? e.src + (inAdhoc.has(c) ? " (có dòng Adhoc)" : "") : "", e ? e.print : "", munits, mr ? mr[0] : "", mr ? K.g(mr[1]) : "", nameTxt, nameAgree,
      T, dist(qsNow), t ? [...t.sizes.entries()].map(([q, n]) => `${n} thẻ × ${K.g(q)}`).join(" + ") : "", nwBase, t ? t.fup : "", vn(firstIn.get(c)), vn(lastIn.get(c)),
      r.E, T - r.E, r.M || 0, (rawM.get(c) || []).join("\n")]);
  }
  const head = ["Mã", "Tên POS", "Kết luận", "Vấn đề cần xem", "Thông tin thêm", "Tồn POS", "Đơn vị gốc POS", "Số dòng POS (seller)", "Seller", "Vị trí POS", "Kho thất lạc", "Khớp trang tồn từng mã", "Đơn ONLINE chờ giao (không cộng)",
    "Master: nguồn", "Master: đơn vị in", "Master: các đơn vị = rate", "Đơn vị dán tem", "Quy đổi", "Tên SP gợi ý", "Tên vs master",
    "Thẻ NW active", "SL/thẻ hiện tại trên NW", "SL/thẻ lúc nhập NW", "Đơn vị gốc NW", "Đơn vị in NW", "Nhập NW lần đầu", "Nhập NW gần nhất",
    "Dự kiến = ⌈Tồn POS ÷ Quy đổi⌉", "Thẻ NW − Dự kiến", "Cần gắn thêm tem", "Dòng master gốc (final data v4)"];
  const order = ["ĐỂ RIÊNG: quy đổi lệch, cần bạn xác nhận", "ĐỂ RIÊNG: thiếu master", "VÀO IMPORT, có cảnh báo cần xem", "VÀO IMPORT, cần gắn thêm tem trước", "VÀO IMPORT, OK"];
  out.sort((a, b) => order.indexOf(a[2]) - order.indexOf(b[2]) || Number(a[0]) - Number(b[0]));
  // ---- products held (master ≠ real NW tags): evidence for which side is right ----
  // optional env PREV_SESS = an earlier NW Kiểm đếm export: tags physically read per product
  const readPrev = new Map();
  if (process.env.PREV_SESS) {
    const w = XLSX.read(fs.readFileSync(process.env.PREV_SESS), { type: "buffer" }), a = XLSX.utils.sheet_to_json(w.Sheets["Tổng hợp"], { header: 1, defval: "" });
    const hi = a.findIndex((r) => r.includes("Dự kiến") && r.includes("Trạng thái")), h = a[hi], ic = h.findIndex((k) => /Mã sản phẩm|Mã vạch/.test(k)), id = h.indexOf("Đã đếm");
    for (const r of a.slice(hi + 1)) readPrev.set(String(r[ic]).replace(/^CIRCA-/, ""), Number(r[id]) || 0);
  }
  const unitFor = (e, posBase, size) => { if (Math.abs(size - 1) < 1e-9) return posBase; const pb = e && (e.units.get(fold(posBase)) || [0, 1])[1]; for (const [u, q] of e ? e.units.values() : []) if (Math.abs(q / pb - size) < 1e-9) return u; return "(đơn vị " + K.g(size) + " " + posBase + ")"; };
  const hold = [];
  for (const c of codes) {
    const r = by.get(c); if (!r || !r.hold) continue;
    const t = tags.get(c), e = master.get(c), T = r.T, qs = r.qs || [], Qnw = r3(qs.reduce((s, x) => s + x, 0));
    const sizesIn = t ? [...t.sizes.entries()].sort((a, b) => b[1] - a[1]) : [], single = sizesIn.length === 1, s0 = sizesIn.length ? sizesIn[0][0] : 0;
    // Dự kiến if the real tags are right: fewest existing tags (largest first) covering POS stock, the rest in tags of the usual size
    const Qm = r3(T * r.ratio), dNW = Math.abs(r.S - Qnw), dM = Math.abs(r.S - Qm), Enw = KD2.need(qs, r.S, s0);
    const nwUnit = unitFor(e, r.posBase, s0), prevRead = readPrev.has(c) ? readPrev.get(c) : "", maxSz = Math.max(0, ...sizesIn.map((x) => x[0]));
    const dup = /\[\s*tr[uù]ng m[aã]\s*\]/i.test(r.name) ? " Tên có [Trùng mã] → kiểm tra mã trên POS." : "";
    let grp, rec, sug, fix;
    if (!e || r.mSrc === "tên sản phẩm") { grp = "4. Thiếu master"; rec = Enw; sug = `Không có quy đổi trong master. Tem NW: ${T} thẻ × ${K.g(s0)} ${r.posBase}, tồn POS ${K.g(r.S)} → Dự kiến ${Enw}.` + dup; fix = `Bổ sung master: đơn vị dán tem = ${nwUnit} (${K.g(s0)} ${r.posBase})`; }
    else if (Enw === r.E) { grp = "1. Dự kiến như nhau theo master và theo tem NW"; rec = r.E; sug = `Tính theo master hay theo tem NW đều ra ${r.E} → đưa vào import an toàn.`; fix = single ? `Sửa tên đơn vị in trên NW (${t ? t.fup : ""}) cho khớp master (${r.unit})` : "Không bắt buộc (có thể dồn/sửa SL các thẻ lẻ trên NW sau)"; }
    else if (single && dNW < dM) { grp = "2. Tem NW khớp tồn POS → master ghi sai đơn vị dán tem"; rec = Enw; sug = `Tồn POS ${K.g(r.S)} ≈ ${T} thẻ × ${K.g(s0)} = ${K.g(Qnw)}` + (prevRead !== "" ? `; phiên 18/11 đọc được ${prevRead}/${T} thẻ` : "") + `. Tem thật dán theo ${nwUnit} (${K.g(s0)} ${r.posBase}), không phải ${r.unit} (${K.g(r.ratio)}) → Dự kiến ${Enw}` + (Enw > T ? ` (cần gắn thêm ${Enw - T} tem)` : "") + "."; fix = `Sửa master (tab Adhoc): đơn vị dán tem = ${nwUnit}, 1 ${nwUnit} = ${K.g(s0)} ${r.posBase}`; }
    else if (single) { grp = "5. Master khớp tồn POS → NW ghi sai SL thẻ"; rec = r.E; sug = `Tồn POS ${K.g(r.S)} ≈ ${T} thẻ × ${K.g(r.ratio)} = ${K.g(Qm)}. Tem dán theo ${r.unit} nhưng NW ghi ${K.g(s0)}/thẻ → Dự kiến ${r.E}.`; fix = `Sửa SL các thẻ trên NW = ${K.g(r.ratio)} ${r.posBase}/thẻ`; }
    else if (dNW <= maxSz) { grp = "3. Lẫn cỡ thẻ, tổng SL trên thẻ ≈ tồn POS"; rec = Enw; sug = `NW có ${sizesIn.map(([q, n]) => n + " thẻ × " + K.g(q)).join(" + ")} ${r.posBase}, tổng ${K.g(Qnw)} ≈ tồn POS ${K.g(r.S)}` + (prevRead !== "" ? `; phiên 18/11 đọc được ${prevRead}/${T} thẻ` : "") + `. Hàng dán tem 2 cấp (hộp + lẻ) → cần ${Enw} thẻ để phủ tồn POS (thẻ lớn trước, không tính hộp mở dở), master cho ${r.E}` + (Qnw > r.S + 1e-9 && Enw < T ? `; nếu có hộp đã mở dở thì có thể tới ${T} thẻ` : "") + "."; fix = `Dán tem 1 cấp cho đồng nhất (theo ${r.unit}) rồi sửa SL thẻ trên NW; tới lúc đó dùng Dự kiến theo tem NW`; }
    else { grp = "6. Lẫn cỡ thẻ, không khớp tồn POS → cần xem thực tế"; rec = ""; sug = `NW có ${sizesIn.map(([q, n]) => n + " thẻ × " + K.g(q)).join(" + ")} ${r.posBase}, tổng ${K.g(Qnw)}; tồn POS ${K.g(r.S)}; master ${r.unit} = ${K.g(r.ratio)}` + (prevRead !== "" ? `; phiên 18/11 đọc được ${prevRead}/${T} thẻ` : "") + `. Theo master ${r.E}, theo tem NW ${Enw}.`; fix = "Xem hàng thật: tem dán theo đơn vị nào, còn bao nhiêu"; }
    hold.push([c, r.name, r.S, r.posBase, r.unit + " = " + K.g(r.ratio), e ? [...e.units.values()].map((u) => u[0] + "=" + K.g(u[1])).join(", ") : "", T, sizesIn.map(([q, n]) => n + " thẻ × " + K.g(q)).join(" + "), t ? t.fup : "", Qnw, Qm, prevRead, r.E, Enw, grp, rec, sug, fix, ""]);
  }
  const W2 = XLSX.utils.book_new();
  const add = (n, aoa, w) => { const ws = XLSX.utils.aoa_to_sheet(aoa); ws["!cols"] = w.map((x) => ({ wch: x })); if (aoa.length > 1) ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: aoa[0].length - 1 } }) }; XLSX.utils.book_append_sheet(W2, ws, n); };
  const cnt = (f) => out.filter(f).length, sumC = (f, i) => out.filter(f).reduce((s, r) => s + (Number(r[i]) || 0), 0), iE = head.indexOf("Dự kiến = ⌈Tồn POS ÷ Quy đổi⌉"), iM = head.indexOf("Cần gắn thêm tem");
  const imp = (r) => r[2].startsWith("VÀO IMPORT"), hg = {}; for (const h of hold) { hg[h[14]] = hg[h[14]] || [0, 0]; hg[h[14]][0]++; hg[h[14]][1] += Number(h[15]) || 0; }
  add("Tóm tắt", [["Mục", "Giá trị", "Ghi chú"],
    ["Công thức", "Dự kiến = ⌈Tồn POS ÷ Quy đổi⌉", "Tồn POS = on_hand mọi dòng seller + mọi vị trí, bỏ Kho thất lạc, không cộng đơn chờ giao. Quy đổi = số đơn vị gốc POS trong 1 đơn vị dán tem (master)."],
    ["Tồn POS lấy lúc", vn(Date.parse(P.at)), "Tồn POS đổi theo bán hàng → tạo lại file ngay trước khi mở phiên"],
    ["Mã trong danh sách", codes.length, "không trùng; tất cả đều có tồn POS hoặc thẻ NW"],
    ["Tồn POS: kéo hàng loạt vs trang tồn từng mã", Object.keys(V).length ? cnt((r) => r[11] === "khớp") + "/" + codes.length + " khớp" : "chưa kiểm", ""],
    ["Vào import, OK", cnt((r) => r[2] === "VÀO IMPORT, OK"), "Σ Dự kiến " + sumC((r) => r[2] === "VÀO IMPORT, OK", iE)],
    ["Vào import, cần gắn thêm tem trước khi kiểm", cnt((r) => r[2] === "VÀO IMPORT, cần gắn thêm tem trước"), sumC((r) => imp(r), iM) + " tem (Dự kiến − thẻ NW active)"],
    ["Vào import, có cảnh báo", cnt((r) => r[2] === "VÀO IMPORT, có cảnh báo cần xem"), "xem cột 'Vấn đề cần xem' (tồn POS = 0, đơn online chờ giao)"],
    ["Σ Dự kiến các mã vào import", sumC(imp, iE), cnt(imp) + " mã"],
    ["Để riêng: quy đổi master ≠ tem thật trên NW", hold.length, "sheet 'Cần xác nhận quy đổi'"],
    ...Object.entries(hg).sort().map(([k, v]) => ["   " + k, v[0] + " mã", "Σ Dự kiến đề xuất " + v[1]])], [46, 26, 100]);
  add("Kiểm tra từng mã", [head, ...out], [9, 40, 30, 70, 50, 8, 8, 6, 10, 26, 7, 9, 16, 16, 9, 30, 9, 7, 12, 10, 7, 22, 22, 8, 8, 16, 16, 9, 8, 8, 50]);
  const hHead = ["Mã", "Tên POS", "Tồn POS", "Đơn vị gốc", "Master: đơn vị dán tem = quy đổi", "Master: các đơn vị", "Thẻ NW active", "SL/thẻ lúc nhập NW", "Đơn vị in NW", "Tổng SL trên thẻ NW", "Thẻ × quy đổi master", "Phiên trước: thẻ đọc được", "Dự kiến theo master", "Dự kiến theo tem NW", "Nhóm", "Dự kiến đề xuất", "Bằng chứng", "Cần sửa dữ liệu nguồn", "BẠN XÁC NHẬN (đồng ý / số khác)"];
  hold.sort((a, b) => a[14].localeCompare(b[14]) || Number(a[0]) - Number(b[0]));
  add("Cần xác nhận quy đổi", [hHead, ...hold], [9, 40, 8, 8, 16, 30, 7, 22, 8, 9, 9, 9, 9, 9, 34, 9, 90, 50, 18]);
  fs.writeFileSync(OUT, Buffer.from(XLSX.write(W2, { type: "array", bookType: "xlsx" })));
  fs.writeFileSync(OUT.replace(/\.xlsx$/, ".json"), JSON.stringify({ at: P.at, head, rows: out, hHead, hold }));
  console.log("POS at", P.at, "| master", master.size, "| list", codes.length);
  console.log(tally);
  const iss = {}; for (const r of out) for (const s of String(r[3]).split(" | ").filter(Boolean)) { const k = s.replace(/\d+([.,]\d+)?/g, "n").replace(/\(.*?\)/g, "()").slice(0, 70); iss[k] = (iss[k] || 0) + 1; }
  console.log(Object.entries(iss).sort((a, b) => b[1] - a[1]).map(([k, n]) => n + "  " + k).join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
