// Read-only: pull every scan + unmatched scan + lines of a POS inventory count session.
// usage: POS_TOKEN=… node pos-count-scans.js <sessionId> <storeId> <outDir>
const fs = require("fs"), path = require("path");
const [sid, store, out] = process.argv.slice(2);
const B = "https://api.v2.circa.vn/v1/inventory/count";
const H = { Authorization: "Bearer " + process.env.POS_TOKEN, Accept: "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/157 Safari/537.36", "x-store-id": store, "X-Circa-App": "admin", "X-Client-Id": "1", Origin: "https://admin.v2.circa.vn", Referer: "https://admin.v2.circa.vn/" };
async function get(u) { const r = await fetch(B + u, { headers: H }); const t = await r.text(); if (!r.ok) throw new Error(r.status + " " + u + " " + t.slice(0, 300)); return JSON.parse(t).data; }
async function pages(u, key) { const all = []; let total = null; for (let off = 0; ; off += 1000) { const d = await get(u + (u.includes("?") ? "&" : "?") + "limit=1000&offset=" + off); total = d.total ?? total; const a = d[key] || []; all.push(...a); if (a.length < 1000) break; } return { all, total }; }
(async () => {
  const sess = await get(`/sessions/${sid}`), sum = await get(`/sessions/${sid}/summary`);
  const sc = await pages(`/sessions/${sid}/scans`, "scans");
  let un = { all: [], total: 0, err: null }; try { un = await pages(`/sessions/${sid}/unmatched-scans`, "items"); if (!un.all.length) { const d = await get(`/sessions/${sid}/unmatched-scans?limit=1000`); un.raw = Object.keys(d || {}); } } catch (e) { un.err = e.message; }
  const lines = (await get(`/sessions/${sid}/lines?limit=-1`)).lines;
  fs.writeFileSync(path.join(out, "session.json"), JSON.stringify(sess, null, 1));
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(sum, null, 1));
  fs.writeFileSync(path.join(out, "scans.json"), JSON.stringify(sc.all));
  fs.writeFileSync(path.join(out, "unmatched.json"), JSON.stringify(un));
  fs.writeFileSync(path.join(out, "lines.json"), JSON.stringify(lines));
  console.log("status", sess.status, sess.code, "mode", sess.counting_mode, "| summary scans", sum.total_scans, "| scans got", sc.all.length, "total", sc.total, "| unmatched", un.all.length, un.total, un.err || "", un.raw || "", "| lines", lines.length);
  console.log("scan keys:", sc.all[0] && Object.keys(sc.all[0]).join(","));
  console.log("sample:", JSON.stringify(sc.all.slice(0, 2)));
  if (un.all[0]) console.log("unmatched sample:", JSON.stringify(un.all.slice(0, 2)));
})().catch((e) => { console.error(e.message); process.exit(1); });
