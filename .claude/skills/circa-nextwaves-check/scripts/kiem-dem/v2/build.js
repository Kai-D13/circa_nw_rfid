// Assemble kiem-dem-circa-v2.html: SheetJS + KiemDem (from v1) + core + worker handler + app.
// usage: node kd/v2/build.js <out.html>
const fs = require("fs"), path = require("path");
const D = __dirname;
const raw = fs.readFileSync(path.join(D, "..", "tool-worker-raw.js"), "utf8");
const cut = raw.indexOf("// Port of scripts/circa-tally-expected.py");
if (cut < 0) throw new Error("KiemDem marker not found");
const sheetjs = raw.slice(0, cut);
let kiemdem = raw.slice(cut);
const ret = "return { fold: fold, g: g, loadMaster: loadMaster, readStock: readStock, build: build, tallyCsv: tallyCsv, checkCsv: checkCsv };";
if (!kiemdem.includes(ret)) throw new Error("KiemDem export line not found");
kiemdem = kiemdem.replace(ret, ret.replace(" };", ", masterRatio: masterRatio, ratioFor: ratioFor, num: num, strip: strip };"));
const V1_REPO = path.resolve(__dirname, "../../../../../../build/kiem-dem-circa.html"); // v1 (CSS + SheetJS + KiemDem) kept in repo build/; fallback Downloads
const v1 = fs.readFileSync(fs.existsSync(V1_REPO) ? V1_REPO : "C:/Users/Administrator/Downloads/kiem-dem-circa.html", "utf8");
const style = v1.slice(v1.indexOf("<style>") + 7, v1.indexOf("</style>")).trim();
const core = fs.readFileSync(path.join(D, "core.js"), "utf8");
const worker = fs.readFileSync(path.join(D, "worker.js"), "utf8");
const app = fs.readFileSync(path.join(D, "app.js"), "utf8");
const workerSrc = sheetjs + "\n" + kiemdem + "\n" + core + "\n" + worker;
for (const [n, s] of [["worker", workerSrc], ["app", app]]) if (/<\/script/i.test(s)) throw new Error(n + " contains </script");
let html = fs.readFileSync(path.join(D, "page.html"), "utf8");
html = html.replace("/*__STYLE__*/", () => style).replace("/*__WORKER__*/", () => workerSrc).replace("/*__APP__*/", () => app);
const out = process.argv[2] || path.join(D, "kiem-dem-circa-v2.html");
fs.writeFileSync(out, html);
// also emit the worker bundle for node tests
fs.writeFileSync(path.join(D, "worker-bundle.js"), workerSrc);
console.log("wrote", out, (html.length / 1024).toFixed(0) + " KB");
