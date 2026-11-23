// CHỈ ĐỌC (chỉ GET) với Circa POS, Nextwaves và Google Sheet master.
// Kéo dữ liệu thật cho test của tools/ton-pos-nw-sheet/Code.gs, lưu thô vào phien/.
// Dùng (cwd = thư mục việc, vd work/20261124-ton-pos-nw-sheet; env POS_TOKEN, NW_KEY):
//   node <repo>/tools/ton-pos-nw-sheet/fetch-data.js <posStoreId> <nwWarehouseId> <nhãn>      vd: node fetch-data.js 265ed9b9-… 7b9fde8f-… tamviet
//   SKIP_MASTER=1 → không tải lại master
// Ra: phien/pos-<nhãn>.json  {at, storeId, total, pages:[{page, ms, total, list:[…]}]}
//     phien/nw-warehouses.json (mảng thô) · phien/nw-overview-<nhãn>.json (thô) · phien/master-v4.csv · phien/master-adhoc.csv
//     phien/fetch-<nhãn>-timing.json (thời gian từng request)
const fs = require("fs"), path = require("path");
const [storeId, whId, label] = process.argv.slice(2);
if (!storeId || !whId || !label) { console.error("usage: node fetch-data.js <posStoreId> <nwWarehouseId> <nhãn>"); process.exit(1); }
const POS = "https://api.v2.circa.vn", NW = "https://api-circa.nextwaves.app/api/v1/public";
const MASTER = "18nLllIlORaki3por1diKzNo2tWvdVyUnB1xbZXDv8Xc";
const DIR = path.join(process.cwd(), "phien");
fs.mkdirSync(DIR, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const timing = [];

// cùng chính sách với Code.gs: thử lại 3 lần (2/4/8 s) khi lỗi mạng, 429, 5xx, 200 mà body không phải JSON
async function get(url, headers, asText) {
  let last = "";
  for (let t = 0; t <= 3; t++) {
    if (t) await sleep(2000 * Math.pow(2, t - 1));
    const t0 = Date.now();
    let r, body;
    try { r = await fetch(url, { headers }); body = await r.text(); } catch (e) { last = "mạng lỗi: " + e.message; continue; }
    timing.push({ url: url.replace(/\?.*/, ""), status: r.status, ms: Date.now() - t0, bytes: body.length });
    if (r.status === 401 || r.status === 403) throw new Error("HTTP " + r.status + " (khoá sai hoặc hết hạn)");
    if (r.status === 429 || r.status >= 500) { last = "HTTP " + r.status; continue; }
    if (r.status !== 200) throw new Error("HTTP " + r.status + " " + url.replace(/\?.*/, ""));
    if (asText) return body;
    try { return JSON.parse(body); } catch (e) { last = "body không phải JSON"; }
  }
  throw new Error("lỗi sau 3 lần thử: " + last + " " + url.replace(/\?.*/, ""));
}

(async () => {
  const at = new Date().toISOString();
  // 1. tồn POS
  const ph = { authorization: "Bearer " + process.env.POS_TOKEN, "x-store-id": storeId };
  const pages = [], seen = new Set();
  let total = null;
  for (let page = 1; page <= 200; page++) {
    const t0 = Date.now();
    const j = await get(POS + "/v1/inventory/admin/stock/search?query=pos_id=" + storeId + ",include_negative_qty=true,&limit=500&page=" + page, ph);
    const d = j && j.data;
    if (!d || !Array.isArray(d.list)) throw new Error("POS trang " + page + " sai dạng");
    pages.push({ page, ms: Date.now() - t0, total: d.total, list: d.list });
    total = Number(d.total);
    d.list.forEach(x => seen.add(x.product_id + "|" + x.seller_code + "|" + x.sku));
    console.log("POS trang", page, d.list.length, "dòng,", Date.now() - t0, "ms, khác nhau", seen.size, "/", total);
    if (!d.list.length || seen.size >= total) break;
  }
  fs.writeFileSync(path.join(DIR, "pos-" + label + ".json"), JSON.stringify({ at, storeId, total, pages }));
  // 2. kho NW + tồn NW
  const nh = { authorization: "Bearer " + process.env.NW_KEY };
  const wh = await get(NW + "/warehouses", nh);
  fs.writeFileSync(path.join(DIR, "nw-warehouses.json"), JSON.stringify(wh));
  console.log("NW kho:", Array.isArray(wh) ? wh.length : Object.keys(wh));
  const ov = await get(NW + "/stock/overview?warehouseId=" + whId, nh);
  fs.writeFileSync(path.join(DIR, "nw-overview-" + label + ".json"), JSON.stringify(ov));
  console.log("NW overview:", (ov.items || ov.data && ov.data.items || []).length, "dòng");
  // 3. master (gviz CSV, như tool v2)
  if (!process.env.SKIP_MASTER) {
    const base = "https://docs.google.com/spreadsheets/d/" + MASTER + "/gviz/tq?tqx=out:csv&headers=1&sheet=";
    const v4 = await get(base + encodeURIComponent("final data v4") + "&tq=" + encodeURIComponent("select A,B,C,D,E"), {}, true);
    fs.writeFileSync(path.join(DIR, "master-v4.csv"), v4);
    const ad = await get(base + encodeURIComponent("Adhoc"), {}, true);
    fs.writeFileSync(path.join(DIR, "master-adhoc.csv"), ad);
    console.log("master v4", v4.length, "byte; Adhoc", ad.length, "byte");
  }
  fs.writeFileSync(path.join(DIR, "fetch-" + label + "-timing.json"), JSON.stringify({ at, timing }, null, 1));
  console.log("xong", at);
})().catch(e => { console.error("LỖI:", e.message); process.exit(1); });
