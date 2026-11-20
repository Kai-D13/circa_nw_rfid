// Read-only. node uid-check.js <UID>  env NW_KEY, POS_TOKEN
const NW = "https://api-circa.nextwaves.app/api/v1/public";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const uid = process.argv[2];
async function g(url, headers) { try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {} return { s: r.status, j, t: t.slice(0, 800) }; } catch (e) { return { s: 0, t: String(e) }; } }
const nw = (p) => g(NW + p, { accept: "application/json", authorization: "Bearer " + process.env.NW_KEY });
const pos = (store, p) => g("https://api.v2.circa.vn" + p, { accept: "application/json, text/plain, */*", authorization: "Bearer " + process.env.POS_TOKEN, "x-circa-app": "pos", "x-client-id": "1", "x-store-id": store, "user-agent": UA, origin: "https://pos.v2.circa.vn", referer: "https://pos.v2.circa.vn/" });
const show = (label, r, n = 2500) => console.log("\n### " + label + " → " + r.s + "\n" + JSON.stringify(r.j || r.t, null, 1).slice(0, n));
(async () => {
  show("by-uid", await nw("/tags/by-uid/" + encodeURIComponent(uid)));
  const gen = await nw("/printing/labels/generations/" + encodeURIComponent(uid)); show("generations", gen, 3000);
  show("resolve", await nw("/printing/labels/resolve?code=" + encodeURIComponent(uid)), 2000);
  if (gen.j && gen.j.parentQr) { const pid = String(gen.j.parentQr).replace(/^.*\//, ""); show("by-uid parent " + pid, await nw("/tags/by-uid/" + encodeURIComponent(pid))); }
  const s = await nw("/tags?search=" + encodeURIComponent(uid) + "&limit=20");
  console.log("\n### tags?search uid → " + s.s + " total " + (s.j && (s.j.total || (s.j.meta && s.j.meta.total))) + " " + ((s.j && s.j.data) || []).map((t) => t.epc + " " + t.status + " " + t.unitUid).join(" | "));
  for (const [n, st] of [["Florita", "c476efb2-415c-429a-978e-d389b4b06607"], ["Lumina", "31493e74-3404-4c0e-a906-93691a6ee319"]]) show("POS qr " + n, await pos(st, `/v1/pos/${st}/qr/${encodeURIComponent(uid)}`), 1500);
})();
