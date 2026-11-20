// Node harness: run the HTML's worker bundle in a vm and drive it with the same messages the page sends.
// usage: node kd/v2/test.js  (uses kd-input2/{stock6,master2,kiem-ke-lumina-2026-11-17-20-43}.xlsx, kd/phien/{nw-ledger,pos-orders}.json;
// env SESS = other session export copy, CUTOFF = ledger/orders cut-off ISO, NOORD = 1 to skip orders)
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const D = __dirname, SP = path.join(D, "..", "..");
const self = {}; const posted = [];
self.postMessage = (m) => posted.push(m);
const ctx = { self, console, Uint8Array, ArrayBuffer, DataView, TextDecoder, TextEncoder, Date, Math, JSON, Set, Map, Promise, setTimeout, Intl };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(D, "worker-bundle.js"), "utf8") + "\n;this.__XLSX = XLSX; this.__KD2 = KD2; this.__K = KiemDem;", ctx);
const KD2 = ctx.__KD2, K = ctx.__K;
let id = 0;
const send = (msg) => { msg.id = ++id; self.onmessage({ data: msg }); const r = posted.pop(); if (r.error) throw new Error(r.error); return r; };
const ab = (f) => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

// ---- unit: opened-box range (user's case: 230 viên, hộp 100, 4 thẻ)
assert.strictEqual(KD2.OPEN_MAX, 2);
assert.strictEqual(KD2.emax(4, 230, 100, 2, 3, 2), 4);
assert.strictEqual(KD2.emax(4, 230, 100, 0, 3, 2), 3);
assert.strictEqual(KD2.emax(4, 230, 100, 5, 3, 2), 4);
assert.strictEqual(KD2.emax(10, 230, 100, 1, 3, 2), 4); // 1 loose order (+1 box open at tagging): 2 full + 2 opened → floor(228/100)+2 = 4
assert.strictEqual(KD2.emax(4, 200, 100, 2, 2), 4); // no cap: 1 full + 3 opened (e.g. 33+33+34)
assert.strictEqual(KD2.emax(4, 200, 100, 2, 2, 2), 3); // cap 2 opened boxes: 1 full + 2 opened
assert.strictEqual(KD2.emax(4, 0, 100, 3, 0, 2), 0);
// review #1: k never exceeds S (1 viên left cannot sit in 5 opened boxes)
assert.strictEqual(KD2.emax(6, 1, 100, 5, 1), 1);
assert.strictEqual(KD2.emax(10, 2, 100, 9, 1), 2);
// review #5: lifetime loose orders no longer push Emax up to T
assert.strictEqual(KD2.emax(8, 500, 100, 30, 5, 2), 6);
assert.strictEqual(KD2.emax(8, 500, 100, 30, 5), 8);
console.log("unit emax ok");
const t0 = "2026-11-10T00:00:00Z";
const pos = KD2.posFromApi([{ pid: "X", name: "Thuốc X (h/100v)", base: "viên", locs: [{ loc: "General", q: 230 }], units: [{ unit: "hộp", rate: 100 }, { unit: "viên", rate: 1 }] }]);
const tags = KD2.tagsFromLedger([{ c: "X", q: 400, t: "stock_in", at: t0, epcs: ["e1", "e2", "e3", "e4"], fup: "hộp", base: "viên", title: "Thuốc X" }]);
const mk = (n) => Array.from({ length: n }, (_, i) => ({ c: "X", base: 10 * (i + 1), t: Date.parse("2026-11-12T00:00:00Z"), code: "DHC" + i }));
let r = KD2.build(pos, new Map(), tags, null, {}, mk(2)).rows[0];
assert.deepStrictEqual([r.E, r.Emax, r.L], [3, 3, null]); // 19/11: no loose-box range, Dự kiến = ⌈230/100⌉
r = KD2.build(pos, new Map(), tags, null, {}, []).rows[0];
assert.deepStrictEqual([r.E, r.Emax, r.L], [3, 3, null]);
r = KD2.build(pos, new Map(), tags, null, {}, [{ c: "X", base: 100, t: Date.parse("2026-11-12T00:00:00Z"), code: "DHCfull" }, { c: "X", base: 10, t: Date.parse("2026-11-01T00:00:00Z"), code: "DHCbefore" }]).rows[0];
assert.deepStrictEqual([r.E, r.Emax, r.L], [3, 3, null]); // whole-box sale and a sale before tagging are not loose
r = KD2.build(pos, new Map(), tags, null, {}, null).rows[0];
assert.deepStrictEqual([r.E, r.Emax, r.L], [3, 3, null]);
console.log("unit build ok:", JSON.stringify(KD2.build(pos, new Map(), tags, null, {}, mk(2)).rows[0].flags));

// review #4: an order deducted on NW for product Y must not hide X's loose line in the same order
const inX = { c: "X", q: 400, t: "stock_in", at: t0, epcs: ["e1", "e2", "e3", "e4"], fup: "hộp", base: "viên", title: "Thuốc X" };
let tg = KD2.tagsFromLedger([inX, { c: "Y", q: 100, t: "stock_in", at: t0, epcs: ["y1"] }, { c: "Y", q: -100, t: "stock_out", at: t0, ref: "CIR-DHC0", epcs: ["y1"] }]);
r = KD2.build(pos, new Map(), tg, null, {}, mk(2)).rows.find((x) => x.code === "X");
assert.deepStrictEqual([r.E, r.Emax, r.L], [3, 3, null]); // 19/11: no loose-box range, Dự kiến = ⌈230/100⌉
// …while X's own deducted order is skipped
tg = KD2.tagsFromLedger([inX, { c: "X", q: 0, t: "adjust", at: t0, ref: "CIR-DHC1", epcs: [] }]);
r = KD2.build(pos, new Map(), tg, null, {}, mk(2)).rows[0];
assert.strictEqual(r.L, null);
// review #2: pending ONLINE orders already deducted on NW for this product are not added back to S
r = KD2.build(pos, new Map(), tg, new Map([["X", [[20, "DHC9"], [30, "DHC1"]]]]), { addPending: true }, null).rows[0];
assert.strictEqual(r.S, 250);
assert.ok(r.flags.some((f) => /đã trừ trên NW.*DHC1/.test(f)), "flag for the skipped pending order");
// review #9: tags that arrived by transfer set the first-tag time
tg = KD2.tagsFromLedger([{ c: "Z", q: 200, t: "transfer_in", at: "2026-11-15T03:00:00Z", epcs: ["z1", "z2"] }]);
assert.strictEqual(tg.get("Z").first, Date.parse("2026-11-15T03:00:00Z"));
// review #10 + #8: stock outside listed locations is kept; a row repeated across pages is counted once
const pp = KD2.posFromApi([{ pid: "P", name: "P", base: "viên", q: 5, seller: "S1", sku: "K1", locs: [{ loc: "A", q: 0 }] }, { pid: "P", name: "P", base: "viên", q: 5, seller: "S1", sku: "K1", locs: [{ loc: "A", q: 0 }] }, { pid: "P", name: "P", base: "viên", q: 2, seller: "S2", sku: "K2", locs: [] }]).get("P");
assert.deepStrictEqual([...pp.locs.entries()], [["A", 0], ["(không vị trí)", 7]]);
// review #12 + #14: nonmerch rows have no "over" count; stock is written without exponent/rounding
const big = KD2.posFromApi([{ pid: "B", name: "Dung dịch B", base: "ml", q: 1234567, locs: [{ loc: "General", q: 1234567 }] }, { pid: "V", name: "Voucher 50k", base: "cái", q: 0, locs: [] }]);
const btags = KD2.tagsFromLedger([{ c: "B", q: 2000000, t: "stock_in", at: t0, epcs: ["b1", "b2"] }, { c: "V", q: 3, t: "stock_in", at: t0, epcs: ["v1", "v2", "v3"] }]);
const bres = KD2.build(big, new Map(), btags, null, {}, null);
assert.ok(KD2.checkCsv(bres).indexOf(",1234567,") > 0 && KD2.holdCsv(bres).indexOf(",1234567,") > 0, "plain stock in CSV (no master → held, still written without exponent)");
const vline = KD2.checkCsv(bres).split("\r\n").find((l) => l.startsWith("V,"));
assert.strictEqual(vline.split(",")[16], "", "nonmerch: no 'Thẻ NW dư' value");
console.log("unit review fixes ok");

// 19/11 (user rule): Dự kiến = ⌈tồn POS ÷ quy đổi master⌉ — NW tags never change it
const ms = (print, units) => ({ print, units: new Map(units.map(([u, q]) => [K.fold(u), [u, q]])), src: "final data v4" });
// 82278: 215 viên (General 200 + Tu4 15; Kho thất lạc bỏ), tem dán theo hộp 20 viên → 11; NW has 5 hộp tags of 20 → gắn thêm 6
const p82 = KD2.posFromApi([{ pid: "82278", name: "Ngậm ho prospan (h/20v)", base: "viên", locs: [{ loc: "General", q: 200 }, { loc: "Tu4", q: 15 }, { loc: "Kho thất lạc", q: 40 }], units: [] }]);
const m82 = new Map([["82278", ms("hộp", [["hộp", 20], ["viên", 1]])]]);
const t82 = KD2.tagsFromLedger([{ c: "82278", q: 100, t: "stock_in", at: t0, epcs: ["a", "b", "c", "d", "e"], fup: "hộp", base: "viên" }]);
const r82 = KD2.build(p82, m82, t82, null, {}, null);
assert.deepStrictEqual([r82.rows[0].S, r82.rows[0].unit, r82.rows[0].ratio, r82.rows[0].E, r82.rows[0].M, r82.rows[0].hold], [215, "hộp", 20, 11, 6, ""]);
assert.ok(KD2.importCsv(r82).indexOf("82278,Ngậm ho prospan (h/20v),hộp,20,215,11") > 0, "import line 82278");
assert.ok(r82.rows[0].flags.some((f) => /cần gắn thêm 6 tem/.test(f)), "flag tags to attach");
// "Master là chuẩn, mã lệch để riêng": NW tags recorded as 1 viên each ≠ master 20 → NOT in the import, listed in holdCsv
const bad82 = KD2.build(p82, m82, KD2.tagsFromLedger([{ c: "82278", q: 5, t: "stock_in", at: t0, epcs: ["a", "b", "c", "d", "e"], fup: "hộp", base: "viên" }]), null, {}, null);
assert.ok(/cỡ thẻ NW 1 ≠ master 20/.test(bad82.rows[0].hold), "hold reason");
assert.strictEqual(KD2.importCsv(bad82).indexOf("82278,"), -1, "held product left out of the import");
assert.ok(KD2.holdCsv(bad82).indexOf("82278,") > 0, "held product listed separately");
assert.deepStrictEqual([bad82.sum.imp, bad82.sum.hold, bad82.sum.holdE], [0, 1, 11]);
// no master → name guess → held as well
assert.ok(/chưa có quy đổi trong master/.test(KD2.build(p82, new Map(), t82, null, {}, null).rows[0].hold));
// exact multiple, just over, below one box, 250/100
const one = (S, q) => KD2.build(KD2.posFromApi([{ pid: "Y", name: "Y", base: "viên", locs: [{ loc: "General", q: S }], units: [] }]), new Map([["Y", ms("hộp", [["hộp", q], ["viên", 1]])]]), new Map(), null, {}, null).rows[0];
assert.strictEqual(one(200, 20).E, 10); assert.strictEqual(one(201, 20).E, 11); assert.strictEqual(one(5, 20).E, 1); assert.strictEqual(one(250, 100).E, 3);
// 5977: tem dán từng gói (master gói) → 41 gói = 41 thẻ; NW mới 1 thẻ → gắn thêm 40
const m41 = KD2.build(KD2.posFromApi([{ pid: "5977", name: "Matrix (h/10g)", base: "gói", locs: [{ loc: "General", q: 41 }], units: [] }]), new Map([["5977", ms("gói", [["gói", 1], ["hộp", 10]])]]),
  KD2.tagsFromLedger([{ c: "5977", q: 1, t: "stock_in", at: t0, epcs: ["m1"], fup: "gói", base: "gói" }]), null, {}, null);
assert.deepStrictEqual([m41.rows[0].E, m41.rows[0].M, m41.sum.E], [41, 40, 41]);
assert.ok(KD2.importCsv(m41).indexOf("5977,Matrix (h/10g),gói,1,41,41") > 0, "import carries Dự kiến = POS");
// NW has MORE tags than expected: Dự kiến stays ⌈S/q⌉
const many = KD2.build(KD2.posFromApi([{ pid: "Z", name: "Z", base: "viên", locs: [{ loc: "General", q: 60 }], units: [] }]), new Map([["Z", ms("hộp", [["hộp", 20], ["viên", 1]])]]),
  KD2.tagsFromLedger([{ c: "Z", q: 200, t: "stock_in", at: t0, epcs: ["z1", "z2", "z3", "z4", "z5", "z6", "z7", "z8", "z9", "z10"] }]), null, {}, null).rows[0];
assert.deepStrictEqual([many.E, many.M], [3, 0]); assert.ok(many.flags.some((f) => /nhiều hơn dự kiến 7/.test(f)));
console.log("unit simple formula ok");

// ---- real data 17/11 Lumina
const m = send({ type: "masterXlsx", buf: ab(path.join(SP, "kd-input2/master2.xlsx")) });
console.log("master", m.size, "adhoc", m.adhoc);
const p = send({ type: "posXlsx", buf: ab(path.join(SP, "kd-input2/stock6.xlsx")) });
console.log("pos", p.products, "locations", p.locations.length);
const L = JSON.parse(fs.readFileSync(path.join(SP, "kd/phien/nw-ledger.json"), "utf8"));
const cutoff = process.env.CUTOFF || "2026-11-17T11:30:00Z";
const t = send({ type: "tags", rows: L.filter((x) => x.at <= cutoff) });
console.log("tags", t.tags, "products", t.products, "(ledger ≤", cutoff + ")");
send({ type: "pend", items: [] });
const O = JSON.parse(fs.readFileSync(path.join(SP, "kd/phien/pos-orders.json"), "utf8"));
const rows = []; for (const o of O) if (!o.err && o.completed_date <= cutoff) for (const it of o.items) rows.push({ c: it.product_id, base: Number(it.base_quantity) || 0, t: Date.parse(o.completed_date), code: o.code });
console.log("orders", send({ type: "orders", rows: process.env.NOORD ? null : rows }).lines);
const b = send({ type: "build", opts: { exclude: ["Kho thất lạc"], addPending: false } });
console.log("sum", JSON.stringify(b.sum));
fs.writeFileSync(path.join(D, "out-import.csv"), b.imp); fs.writeFileSync(path.join(D, "out-dem-tay.csv"), b.man); fs.writeFileSync(path.join(D, "out-kiem-tra.csv"), b.chk);
for (const c of ["1176", "116227", "284394", "1127079", "93933", "1608", "1165"]) { const x = b.rows.find((y) => y.code === c); console.log(c, x ? JSON.stringify({ S: x.S, base: x.posBase, T: x.T, E: x.E, Emax: x.Emax, L: x.L, ratio: x.ratio }) : "—"); }
// the session export is read from a scratch copy (kd-input2/), never straight from Downloads
const s = send({ type: "session", buf: ab(process.env.SESS || path.join(SP, "kd-input2/kiem-ke-lumina-2026-11-17-20-43.xlsx")) });
console.log("session", JSON.stringify(s.sum));
console.log("khớp nhờ hộp lẻ:", s.rows.filter((x) => /hộp lẻ/.test(x.hint)).map((x) => `${x.code} quét ${x.sc} / ${x.E}–${x.Emax} (L=${x.L})`).join("; "));
