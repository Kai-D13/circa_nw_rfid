// BUILD extension "Kiểm kê Circa ↔ NW" từ tools/nw-sang-circa/ext/ ra 2 thư mục nạp được bằng "Load unpacked":
//   build/kiem-ke-circa-nw-ext/        BẢN THẬT: đúng 4 host thật (admin.v2.circa.vn, api.v2.circa.vn, circa.nextwaves.app, api-circa.nextwaves.app)
//   build/kiem-ke-circa-nw-ext-test/   BẢN THỬ: 4 host đổi thành http://127.0.0.1:<cổng> (4 cổng liên tiếp từ --port), TEST = true
// Offline: không gọi mạng, không dùng token. Không sửa nguồn; chép core.js (NWC) và SheetJS nguyên byte.
//
// Dùng (cwd bất kỳ):
//   node tools/nw-sang-circa/build-ext.js [--port 47900] [--real <dir>] [--test <dir>] [--only real|test]
//     --port P: bản thử dùng admin = 127.0.0.1:P, api Circa = P+1, web NW = P+2, api NW = P+3
// Trong Node: require("./build-ext.js").build({ outDir, test: { admin, circaApi, nwApp, nwApi, timeoutMs, retryBaseMs, scanGapMs } | null })
// Nguồn:
//   tools/nw-sang-circa/ext/*            manifest.json, config.js, api.js, chon.js, bridge.js, background.js, content-nw.js, panel.html, panel.js
//   tools/nw-sang-circa/core.js          → core.js (chép nguyên byte)
//   .claude/skills/circa-nextwaves-check/scripts/kiem-dem/tool-worker-raw.js  → xlsx.js (phần SheetJS, cách cắt như build.js)
//   build/kiem-dem-circa.html (CSS v1) + tools/nw-sang-circa/page.html (CSS trang) → panel.css
// Kiểm khi build: bản thật không có chuỗi 127.0.0.1 (cả dạng thoát \. / \x2e / .) / localhost, host_permissions đúng 4 host thật;
// bản thử không còn host thật nào trong file của extension; nguồn không có innerHTML / alert( / confirm( / eval( / new Function;
// chỉ api.js gọi fetch( (background truyền fetch cho api.js); không self./window.fetch(, ["fetch"], XMLHttpRequest, sendBeacon,
// WebSocket, EventSource, console.* / console[. manifest: chỉ quyền storage, scripting (không tabs); đúng một content script (config.js +
// content-nw.js, world ISOLATED) trên web NW; không content script nào trên admin Circa; không webRequest.
// CSP extension_pages (áp cho panel và service worker): default-src 'self', script-src 'self', object-src 'none', base-uri 'none',
// form-action 'none', frame-ancestors 'none', connect-src đúng 2 origin API (bản thật: api.v2.circa.vn + api-circa.nextwaves.app;
// bản thử: 2 origin API giả); không 'unsafe-*', không *, không http(s): trơn. panel.html giữ meta connect-src 'none'.
// Khối /*TEST-BEGIN*/ … /*TEST-END*/ (móc thử: TEST_ORIGIN, __KK_TEST__, __KK_PANEL__, shadow root mở, nhãn THỬ) bị CẮT khỏi bản thật;
// bản thật được kiểm không còn các chuỗi đó, và mỗi file .js của extension phải biên dịch được (vm.Script).
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), vm = require("vm");
const D = __dirname, ROOT = path.resolve(D, "..", ".."), SRC = path.join(D, "ext");
const read = f => fs.readFileSync(f, "utf8");
const REAL = {
  admin: "https://admin.v2.circa.vn",
  circaApi: "https://api.v2.circa.vn",
  nwApp: "https://circa.nextwaves.app",
  nwApi: "https://api-circa.nextwaves.app"
};
const OWN = ["manifest.json", "config.js", "api.js", "chon.js", "bridge.js", "background.js", "content-nw.js", "panel.html", "panel.js"];
const sha = b => crypto.createHash("sha256").update(b).digest("hex");

function sheetjs() {
  const raw = read(path.join(ROOT, ".claude/skills/circa-nextwaves-check/scripts/kiem-dem/tool-worker-raw.js")).replace(/\r\n?/g, "\n");
  const cut = raw.indexOf("// Port of scripts/circa-tally-expected.py");
  if (cut < 0) throw new Error("không thấy mốc KiemDem trong tool-worker-raw.js");
  const x = raw.slice(0, cut).trim() + "\n";
  if (!/var XLSX=\{\};/.test(x.slice(0, 200))) throw new Error("phần đầu tool-worker-raw.js không phải SheetJS");
  return x;
}
function panelCss() {
  const v1 = read(path.join(ROOT, "build/kiem-dem-circa.html")).replace(/\r\n?/g, "\n");
  const i0 = v1.indexOf("<style>"), i1 = v1.indexOf("</style>");
  if (i0 < 0 || i1 < i0) throw new Error("không thấy <style> trong build/kiem-dem-circa.html");
  const page = read(path.join(D, "page.html")).replace(/\r\n?/g, "\n");
  const j0 = page.indexOf("/*__STYLE__*/"), j1 = page.indexOf("</style>", j0);
  if (j0 < 0 || j1 < j0) throw new Error("không thấy CSS trong page.html");
  return "/* CSS tool v1 (build/kiem-dem-circa.html) */\n" + v1.slice(i0 + 7, i1).trim() + "\n/* CSS trang nw-sang-circa (page.html) */\n" + page.slice(j0 + "/*__STYLE__*/".length, j1).trim() + "\n";
}

// khối thử: dấu /*TEST-BEGIN*/ và /*TEST-END*/ xen kẽ, bắt đầu bằng BEGIN, kết thúc bằng END
function testBlocksOk(s) {
  const marks = String(s).match(/\/\*TEST-(BEGIN|END)\*\//g) || [];
  return marks.length % 2 === 0 && marks.every((m, i) => m === (i % 2 ? "/*TEST-END*/" : "/*TEST-BEGIN*/"));
}
// cắt khối thử khỏi bản thật
function cutTest(s) { return s.replace(/[ \t]*\/\*TEST-BEGIN\*\/[\s\S]*?\/\*TEST-END\*\/[ \t]*\n?/g, ""); }
// 127.0.0.1 dạng thường / thoát regex (127\.0\.0\.1) / \x2e / . / [.] / %2e, localhost, [::1]
const LOOPBACK = /127\s*(?:\\*\.|\\x2e|\\u002e|\[\.\]|%2e)\s*0\s*(?:\\*\.|\\x2e|\\u002e|\[\.\]|%2e)\s*0|localhost|\[::1\]/i;
// móc thử (chỉ có trong khối TEST): bản thật không được còn chuỗi nào trong số này
const TEST_MARKS = /TEST_ORIGIN|__KK_TEST__|__KK_PANEL__|TEST-BEGIN|TEST-END|dropSubmit|testThrow|throwAfterSubmit|throwInStep/;

// CSP extension_pages của manifest: → danh sách lỗi ([] = đúng). apis = 2 origin API được phép gọi (connect-src đúng 2 origin này)
function cspProblems(man, apis) {
  const bad = [], csp = man && man.content_security_policy;
  const s = csp && typeof csp === "object" ? csp.extension_pages : null;
  if (typeof s !== "string") return ["không có content_security_policy.extension_pages"];
  if (csp.sandbox != null) bad.push("không được có content_security_policy.sandbox");
  const d = {};
  for (const part of s.split(";")) {
    const w = part.trim().split(/\s+/).filter(Boolean);
    if (!w.length) continue;
    const k = w[0].toLowerCase();
    if (d[k]) bad.push("chỉ thị " + k + " lặp");
    d[k] = w.slice(1);
  }
  const eq = (k, v) => { if (JSON.stringify(d[k] || null) !== JSON.stringify(v)) bad.push(k + " phải là " + v.join(" ") + " (đang: " + (d[k] ? d[k].join(" ") : "không có") + ")"); };
  eq("default-src", ["'self'"]); eq("script-src", ["'self'"]); eq("object-src", ["'none'"]); eq("base-uri", ["'none'"]);
  eq("form-action", ["'none'"]); eq("frame-ancestors", ["'none'"]); eq("connect-src", apis.slice());
  if (/unsafe-|\*|\bdata:|\bblob:|\bfilesystem:|(^|\s)https?:(\s|;|$)/i.test(s)) bad.push("có 'unsafe-*' / * / data: / blob: / scheme trơn");
  const known = ["default-src", "script-src", "object-src", "base-uri", "form-action", "frame-ancestors", "connect-src"];
  for (const k of Object.keys(d)) if (known.indexOf(k) < 0) bad.push("chỉ thị lạ " + k);
  return bad;
}

// soát nguồn: những thứ cấm trong file của extension
function lintSources(files) {
  const bad = [];
  // bỏ chú thích trước khi soát (chú thích có nhắc tên hàm cấm); // chỉ tính khi đứng đầu dòng / sau khoảng trắng (không cắt "https://")
  const code = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  for (const [n, s0] of Object.entries(files)) {
    if (!/\.(js|html)$/.test(n)) continue;
    const s = code(s0);
    if (/\.innerHTML\b|\.outerHTML\s*=|insertAdjacentHTML|document\.write/.test(s)) bad.push(n + ": chèn HTML");
    if (/(^|[^.\w])(alert|confirm|prompt)\s*\(/.test(s)) bad.push(n + ": alert/confirm/prompt");
    if (/\beval\s*\(|new\s+Function\s*\(/.test(s)) bad.push(n + ": eval / new Function");
    if (n !== "api.js" && n !== "background.js" && /(^|[^.\w])fetch\s*\(/.test(s)) bad.push(n + ": gọi fetch( ngoài api.js");
    if (/\bconsole\s*(\.|\[)/.test(s)) bad.push(n + ": console.* / console[");
    if (/\.\s*fetch\s*\(|\[\s*["'`]fetch["'`]\s*\]/.test(s)) bad.push(n + ": gọi fetch qua đối tượng (self./window./globalThis.fetch( hoặc [\"fetch\"])");
    if (/XMLHttpRequest/.test(s)) bad.push(n + ": XMLHttpRequest");
    if (/sendBeacon|\bWebSocket\b|\bEventSource\b/.test(s)) bad.push(n + ": sendBeacon / WebSocket / EventSource");
    if (!testBlocksOk(s0)) bad.push(n + ": khối TEST-BEGIN/TEST-END không cân (phải xen kẽ BEGIN, END; không lồng)");
    if (/localStorage\.setItem|sessionStorage|indexedDB/.test(s)) bad.push(n + ": lưu ngoài chrome.storage");
    if (/\/auth\/refresh/.test(s)) bad.push(n + ": có /auth/refresh");
  }
  // background.js chỉ được gọi fetch bên trong lời gọi tạo api (fetch: function (u, o) { return fetch(u, o); })
  const bgf = code(files["background.js"] || "").match(/(^|[^.\w])fetch\s*\(/g) || [];
  if (bgf.length !== 1) bad.push("background.js: phải có đúng 1 chỗ fetch( (truyền cho api.js), có " + bgf.length);
  return bad;
}

function build(opt) {
  opt = opt || {};
  const outDir = path.resolve(opt.outDir);
  const t = opt.test || null;
  const files = {};
  for (const f of OWN) files[f] = read(path.join(SRC, f)).replace(/\r\n?/g, "\n");
  const bad = lintSources(files);
  if (bad.length) throw new Error("nguồn extension vi phạm:\n  " + bad.join("\n  "));
  if (t) {
    for (const k of ["admin", "circaApi", "nwApp", "nwApi"]) if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(t[k] || "")) throw new Error("bản thử: " + k + " phải là http://127.0.0.1:<cổng>");
    const pairs = [[REAL.nwApi, t.nwApi], [REAL.circaApi, t.circaApi], [REAL.admin, t.admin], [REAL.nwApp, t.nwApp]];
    for (const f of OWN) {
      let s = files[f];
      for (const [a, b] of pairs) s = s.split(a).join(b);
      files[f] = s;
    }
    const rep1 = (f, a, b) => { const n = files[f].split(a).length - 1; if (n !== 1) throw new Error(f + ": cần đúng 1 chỗ \"" + a + "\", có " + n); files[f] = files[f].replace(a, b); };
    rep1("config.js", "TEST: false,", "TEST: true,");
    if (t.timeoutMs) rep1("config.js", "TIMEOUT_MS: 30000,", "TIMEOUT_MS: " + (+t.timeoutMs) + ",");
    if (t.retryBaseMs != null) rep1("config.js", "RETRY_BASE_MS: 1000", "RETRY_BASE_MS: " + (+t.retryBaseMs));
    if (t.scanGapMs != null) rep1("config.js", "SCAN_READ_GAP_MS: 1500,", "SCAN_READ_GAP_MS: " + (+t.scanGapMs) + ",");
    rep1("manifest.json", "\"name\": \"Kiểm kê Circa ↔ NW\"", "\"name\": \"[THỬ] Kiểm kê Circa ↔ NW\"");
  } else {
    for (const f of OWN) if (/\.(js|html)$/.test(f)) files[f] = cutTest(files[f]);
  }
  files["core.js"] = fs.readFileSync(path.join(D, "core.js"));
  files["xlsx.js"] = sheetjs();
  files["panel.css"] = panelCss();
  for (const n of ["core.js", "xlsx.js", "panel.css"]) {
    const s = String(files[n]);
    if (/<\/script/i.test(s) && n === "panel.css") throw new Error(n + " chứa </script");
  }

  // ---- kiểm bản dựng ----
  const man = JSON.parse(files["manifest.json"]);
  const hosts = man.host_permissions;
  const ownText = OWN.map(f => files[f]).join("\n");
  if (!t) {
    const want = [REAL.admin, REAL.circaApi, REAL.nwApp, REAL.nwApi].map(x => x + "/*");
    if (JSON.stringify(hosts) !== JSON.stringify(want)) throw new Error("bản thật: host_permissions phải đúng 4 host thật");
    if (LOOPBACK.test(ownText)) throw new Error("bản thật còn chuỗi 127.0.0.1 (thường / thoát) / localhost / [::1]: " + LOOPBACK.exec(ownText)[0]);
    if (TEST_MARKS.test(ownText)) throw new Error("bản thật còn mã thử: " + TEST_MARKS.exec(ownText)[0]);
    if (/["']open["']/.test(files["content-nw.js"])) throw new Error("bản thật: content-nw.js còn shadow root \"open\"");
    if (!/TEST: false,/.test(files["config.js"])) throw new Error("bản thật phải có TEST: false");
  } else {
    for (const h of Object.values(REAL)) if (ownText.indexOf(h) >= 0) throw new Error("bản thử còn host thật " + h);
    if (!hosts.every(h => /^http:\/\/127\.0\.0\.1:\d+\/\*$/.test(h)) || hosts.length !== 4) throw new Error("bản thử: host_permissions phải là 4 host 127.0.0.1");
  }
  const cs = man.content_scripts, nwApp = t ? t.nwApp : REAL.nwApp;
  if (!Array.isArray(cs) || cs.length !== 1 || cs[0].world || JSON.stringify(cs[0].js) !== JSON.stringify(["config.js", "content-nw.js"]) ||
    JSON.stringify(cs[0].matches) !== JSON.stringify([nwApp + "/*"]) || cs[0].all_frames !== false)
    throw new Error("manifest: content_scripts phải đúng 1 mục: config.js + content-nw.js, world ISOLATED, chỉ trên web NW, all_frames false");
  if (JSON.stringify(man.permissions) !== JSON.stringify(["storage", "scripting"])) throw new Error("manifest: permissions phải đúng storage, scripting (không tabs)");
  const cspBad = cspProblems(man, t ? [t.circaApi, t.nwApi] : [REAL.circaApi, REAL.nwApi]);
  if (cspBad.length) throw new Error("manifest: CSP extension_pages sai: " + cspBad.join("; "));
  if (!/<meta http-equiv="Content-Security-Policy" content="[^"]*\bconnect-src 'none'/.test(files["panel.html"])) throw new Error("panel.html: phải giữ meta CSP connect-src 'none'");
  if (man.optional_permissions || man.optional_host_permissions || man.externally_connectable || man.web_accessible_resources)
    throw new Error("manifest: không được có optional_permissions / optional_host_permissions / externally_connectable / web_accessible_resources");
  // bảng API: đúng 1 lệnh POST (submit-rfid-batch), không lệnh PUT / PATCH / DELETE
  const apiTxt = files["api.js"];
  if ((apiTxt.match(/method:\s*"POST"/g) || []).length !== 1 || !/id: "circa\.submit", side: "circa", method: "POST"/.test(apiTxt) || /method:\s*"(PUT|PATCH|DELETE)"/.test(apiTxt))
    throw new Error("api.js: bảng API phải có đúng 1 lệnh ghi (POST submit-rfid-batch)");
  // mỗi file .js của extension phải biên dịch được (bản thật: sau khi cắt khối thử)
  for (const f of OWN.filter(x => /\.js$/.test(x))) {
    try { new vm.Script(files[f], { filename: f }); } catch (e) { throw new Error((t ? "bản thử" : "bản thật") + ": " + f + " không biên dịch được: " + e.message); }
  }

  // ---- ghi ----
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) {
    const p = path.join(outDir, f);
    // file của bản dựng (kể cả file đã bỏ từ v0.2.0, để bản dựng cũ không còn sót)
    if (fs.statSync(p).isFile() && (OWN.includes(f) || ["core.js", "xlsx.js", "panel.css", "BUILD.json", "watch-circa.js", "content-circa.js", "link.js"].includes(f))) fs.unlinkSync(p);
  }
  const info = { builtAt: new Date().toISOString(), variant: t ? "test" : "real", version: man.version, hosts: hosts, files: {} };
  for (const [n, s] of Object.entries(files)) {
    const b = Buffer.isBuffer(s) ? s : Buffer.from(s, "utf8");
    fs.writeFileSync(path.join(outDir, n), b);
    info.files[n] = { bytes: b.length, sha256: sha(b) };
  }
  if (sha(fs.readFileSync(path.join(outDir, "core.js"))) !== sha(fs.readFileSync(path.join(D, "core.js")))) throw new Error("core.js chép không trùng byte");
  fs.writeFileSync(path.join(outDir, "BUILD.json"), JSON.stringify(info, null, 1));
  return info;
}

module.exports = { build, REAL, OWN, lintSources, cutTest, testBlocksOk, cspProblems, LOOPBACK, TEST_MARKS };

if (require.main === module) {
  const a = process.argv.slice(2), arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const only = arg("--only", "");
  const port = +arg("--port", 47900);
  if (!(port >= 1024 && port <= 65532)) throw new Error("--port phải trong 1024..65532");
  if (only !== "test") {
    const r = build({ outDir: arg("--real", path.join(ROOT, "build/kiem-ke-circa-nw-ext")) });
    console.log("bản thật:", path.resolve(arg("--real", path.join(ROOT, "build/kiem-ke-circa-nw-ext"))), "·", Object.keys(r.files).length, "file · host", r.hosts.join(" "));
  }
  if (only !== "real") {
    const T = { admin: "http://127.0.0.1:" + port, circaApi: "http://127.0.0.1:" + (port + 1), nwApp: "http://127.0.0.1:" + (port + 2), nwApi: "http://127.0.0.1:" + (port + 3), timeoutMs: 8000, retryBaseMs: 50, scanGapMs: 100 };
    const r = build({ outDir: arg("--test", path.join(ROOT, "build/kiem-ke-circa-nw-ext-test")), test: T });
    console.log("bản thử:", path.resolve(arg("--test", path.join(ROOT, "build/kiem-ke-circa-nw-ext-test"))), "·", Object.keys(r.files).length, "file · host", r.hosts.join(" "));
  }
}
