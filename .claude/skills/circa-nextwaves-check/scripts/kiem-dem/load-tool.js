// Load the tool's own worker code (SheetJS + KiemDem) in a browser-like sandbox
// (same export patch as v2/build.js: masterRatio, ratioFor, num, strip are exposed too)
const fs = require("fs"), vm = require("vm"), path = require("path");
const ctx = { self: {}, console, Uint8Array, ArrayBuffer, DataView, TextDecoder, TextEncoder, Date, Math, JSON, Set, Map, Promise, setTimeout };
ctx.window = undefined;
vm.createContext(ctx);
let src = fs.readFileSync(path.join(__dirname, "tool-worker-raw.js"), "utf8");
const ret = "return { fold: fold, g: g, loadMaster: loadMaster, readStock: readStock, build: build, tallyCsv: tallyCsv, checkCsv: checkCsv };";
if (src.includes(ret)) src = src.replace(ret, ret.replace(" };", ", masterRatio: masterRatio, ratioFor: ratioFor, num: num, strip: strip };"));
vm.runInContext(src + "\n;this.__XLSX = XLSX; this.__KD = KiemDem;", ctx);
module.exports = { XLSX: ctx.__XLSX, KiemDem: ctx.__KD };
