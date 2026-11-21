// BUILD trang "NW kiểm kê → Circa kiểm kê": ghép page.html + CSS v1 + SheetJS + core.js + app.js thành MỘT file HTML tự chứa.
// Offline: không gọi mạng, không dùng token. Không sửa nguồn, chỉ ghi file đích.
//
// Dùng (cwd bất kỳ):
//   node tools/nw-sang-circa/build.js [out.html]        mặc định <repo>/build/nw-sang-circa.html
// Nguồn:
//   tools/nw-sang-circa/page.html   khung trang, placeholder /*__STYLE__*/ /*__XLSX__*/ /*__CORE__*/ /*__APP__*/ và __CSP__
//   build/kiem-dem-circa.html       CSS của tool v1 (giữ giao diện đồng bộ)
//   .claude/skills/circa-nextwaves-check/scripts/kiem-dem/tool-worker-raw.js   SheetJS (phần trước dòng "// Port of scripts/circa-tally-expected.py")
//   tools/nw-sang-circa/core.js     lõi NWC (không đổi)
//   tools/nw-sang-circa/app.js      giao diện + gọi API
// Kiểm khi build: nguồn không chứa "</script" hoặc "<script"; CSP có sha256 của đúng 3 khối script (chặn mọi script khác,
// kể cả thuộc tính onerror=… nếu dữ liệu lọt vào DOM dạng HTML).
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const D = __dirname, ROOT = path.resolve(D, "..", "..");
const read = f => fs.readFileSync(f, "utf8").replace(/\r\n?/g, "\n");

const raw = read(path.join(ROOT, ".claude/skills/circa-nextwaves-check/scripts/kiem-dem/tool-worker-raw.js"));
const cut = raw.indexOf("// Port of scripts/circa-tally-expected.py");
if (cut < 0) throw new Error("không thấy mốc KiemDem trong tool-worker-raw.js");
const xlsx = raw.slice(0, cut).trim() + "\n";
if (!/var XLSX=\{\};/.test(xlsx.slice(0, 200))) throw new Error("phần đầu tool-worker-raw.js không phải SheetJS");

const v1 = read(path.join(ROOT, "build/kiem-dem-circa.html"));
const i0 = v1.indexOf("<style>"), i1 = v1.indexOf("</style>");
if (i0 < 0 || i1 < i0) throw new Error("không thấy <style> trong build/kiem-dem-circa.html");
const style = v1.slice(i0 + 7, i1).trim();

const core = read(path.join(D, "core.js"));
const app = read(path.join(D, "app.js"));
for (const [n, s] of [["SheetJS", xlsx], ["core.js", core], ["app.js", app]]) {
  if (/<\/script/i.test(s)) throw new Error(n + " chứa chuỗi </script");
  if (/<script/i.test(s)) throw new Error(n + " chứa chuỗi <script");
}
if (/<\/style/i.test(style)) throw new Error("CSS chứa </style");

let html = read(path.join(D, "page.html"));
for (const ph of ["/*__STYLE__*/", "/*__XLSX__*/", "/*__CORE__*/", "/*__APP__*/", "__CSP__"]) {
  if (html.split(ph).length !== 2) throw new Error("page.html phải có đúng 1 placeholder " + ph);
}
const hash = s => "'sha256-" + crypto.createHash("sha256").update(s, "utf8").digest("base64") + "'";
const csp = [
  "default-src 'none'",
  "script-src " + [xlsx, core, app].map(hash).join(" "),
  "style-src 'unsafe-inline'",
  "connect-src https://api.v2.circa.vn http://localhost:* http://127.0.0.1:*",
  "img-src 'none'", "font-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'"
].join("; ");
html = html.replace("/*__STYLE__*/", () => style).replace("/*__XLSX__*/", () => xlsx).replace("/*__CORE__*/", () => core)
  .replace("/*__APP__*/", () => app).replace("__CSP__", () => csp);
// đúng 3 khối <script> (không có khối nào lọt vào từ nguồn)
const nScript = (html.match(/<script\b/gi) || []).length;
if (nScript !== 3) throw new Error("HTML có " + nScript + " thẻ <script>, cần đúng 3");

const out = path.resolve(process.argv[2] || path.join(ROOT, "build/nw-sang-circa.html"));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log("đã ghi", out, Math.round(Buffer.byteLength(html) / 1024) + " KB", "· sha256", crypto.createHash("sha256").update(html).digest("hex").slice(0, 16));
