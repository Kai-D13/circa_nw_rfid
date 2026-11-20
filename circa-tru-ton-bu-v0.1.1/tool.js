// tool.js — giao diện công cụ trừ tồn bù. Luật: core.js; điều phối: backfill-runner.js; đọc POS: pos-bridge.js (trong tab POS).
(function () {
  "use strict";
  const CORE = self.__CIRCA_QR_SCAN_LOG_CORE__;
  const RFID = self.__CIRCA_RFID_DEMO_CORE__;
  const E = self.__CIRCA_BACKFILL_ENGINE__;
  const R = self.__CIRCA_BACKFILL_RUNNER__;
  const POS = self.__CIRCA_BACKFILL_POS__;
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v === null || v === undefined ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const vn = (s) => (s ? new Date(s).toLocaleString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).slice(0, 16) : "");
  const LBL = CORE.NOTIFY_REASON_LABELS || {};
  const VERDICT = {
    ready: "Đủ điều kiện",
    needs_review: "Cần xem lại",
    on_nextwaves: "Đã có trên Nextwaves",
    blocked: "Bị chặn",
    check_error: "Lỗi kiểm tra",
    sent: "Đã gửi",
    sent_ambiguous: "Không rõ kết quả",
    sent_rejected: "Bị từ chối",
    sent_submitting: "Đang gửi",
  };
  const REASON = {
    order_type: "Đơn ONLINE (core chỉ nhận OFFLINE)",
    order_not_completed: "Đơn chưa COMPLETED",
    no_passing_epc: "Không có EPC nào đạt",
    no_rfid_tags: "Không có UID nào gắn EPC",
    unplaced_scan: "Lượt quét không gắn được dòng",
    items_empty: "Đơn không có dòng",
    blocklist: "Trong blocklist",
    order_exists: "DHC đã có trên Nextwaves",
    wrong_store: "Đơn không thuộc store đã cấu hình",
    local_record: "Máy này đã có bản ghi gửi",
  };
  const reasonText = (c) => (c ? REASON[c] || LBL[c] || c : "");
  const DEFAULT_BLOCK = E.DEFAULT_BLOCKLIST.join("\n");

  const state = { settings: null, key: "", results: [], selected: new Set(), me: null, busy: false };

  // ---------- Cài đặt ----------
  async function loadSettings() {
    const got = await chrome.storage.local.get({ bfSettings: null, bfKey: "" });
    state.settings = Object.assign({ base: "https://api-circa.nextwaves.app/api/v1/public", storeId: "c476efb2-415c-429a-978e-d389b4b06607", maxPerBatch: 20, blocklist: DEFAULT_BLOCK, allowSend: false }, got.bfSettings || {});
    state.key = got.bfKey || "";
    $("sTenant").value = state.settings.base;
    $("sStore").value = state.settings.storeId;
    $("sMax").value = state.settings.maxPerBatch;
    $("sBlock").value = state.settings.blocklist;
    $("sAllow").checked = !!state.settings.allowSend;
    $("sKey").value = state.key ? maskKey(state.key) : "";
    paintPills();
  }
  const maskKey = (k) => String(k).split(":")[0] + ":••••";
  async function saveSettings() {
    const k = $("sKey").value.trim();
    if (k && k.indexOf("••••") < 0) state.key = k.replace(/^bearer\s+/i, "");
    state.settings = {
      base: $("sTenant").value,
      storeId: $("sStore").value.trim().toLowerCase(),
      maxPerBatch: Math.max(1, Math.min(200, Number($("sMax").value) || 20)),
      blocklist: $("sBlock").value,
      allowSend: $("sAllow").checked,
    };
    await chrome.storage.local.set({ bfSettings: state.settings, bfKey: state.key });
    $("sKey").value = state.key ? maskKey(state.key) : "";
    $("keyMsg").textContent = "Đã lưu.";
    paintPills();
    paintSend();
  }
  const blocklist = () => String(state.settings.blocklist || "").split(/\s+/).filter(Boolean);

  // ---------- Mạng ----------
  let slot = 0;
  async function nwFetch(method, path, o) {
    const opts = o || {};
    if (!state.key) return { transport: "no_token", auth: true };
    const url = state.settings.base + path;
    const headers = { accept: "application/json", authorization: "Bearer " + state.key };
    if (opts.bodyText !== undefined) headers["content-type"] = "application/json";
    if (opts.idempotencyKey && path === R.NOTIFY_PATH) headers["idempotency-key"] = String(opts.idempotencyKey);
    const tries = method === "GET" ? 4 : 1; // POST không bao giờ tự gửi lại
    for (let t = 0; t < tries; t++) {
      const wait = Math.max(0, slot - Date.now());
      slot = Math.max(Date.now(), slot) + 110; // < 600 request / phút
      if (wait) await new Promise((s) => setTimeout(s, wait));
      let res;
      try {
        res = await fetch(url, { method, headers, cache: "no-store", body: opts.bodyText, signal: AbortSignal.timeout(opts.timeoutMs || 20000) });
      } catch (e) {
        if (method === "GET" && t < tries - 1) continue;
        return { transport: e && e.name === "TimeoutError" ? "timeout" : "network" };
      }
      if (method === "GET" && (res.status === 429 || res.status >= 500) && t < tries - 1) {
        await new Promise((s) => setTimeout(s, 3000 * (t + 1)));
        continue;
      }
      const text = await res.text().catch(() => "");
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (_) {
        json = null;
      }
      const replay = res.headers.get("idempotent-replay");
      return typeof replay === "string" ? { status: res.status, json, replay } : { status: res.status, json };
    }
    return { transport: "network" };
  }
  async function sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function storeGet(k) {
    const got = await chrome.storage.local.get({ [k]: null });
    return got[k];
  }
  async function storeSet(k, v) {
    await chrome.storage.local.set({ [k]: v });
  }

  function makeRunner(tabId) {
    return R.createRunner({
      CORE,
      RFID,
      E,
      nwBase: state.settings.base,
      nwFetch,
      posFetchOrder: (id) => POS.posFetchOrder(tabId, id, state.settings.storeId),
      storeGet,
      storeSet,
      sha256,
      now: () => new Date().toISOString(),
      blocklist: blocklist(),
      storeId: state.settings.storeId,
      onProgress: progress,
    });
  }

  // ---------- Trạng thái kết nối ----------
  async function checkKey() {
    $("keyMsg").textContent = "Đang kiểm tra…";
    const r = await nwFetch("GET", "/me", {});
    if (r.status === 200 && r.json) {
      state.me = { name: r.json.name || r.json.keyId, scopes: r.json.scopes || [], owner: r.json.owner && (r.json.owner.email || r.json.owner.fullName) };
      $("keyMsg").textContent = "Key " + state.me.name + " · quyền: " + state.me.scopes.join(", ");
    } else {
      state.me = null;
      $("keyMsg").textContent = "Key lỗi: " + (r.transport || "HTTP " + r.status);
    }
    paintPills();
    paintSend();
  }
  async function checkPos() {
    const tab = await POS.findPosTab();
    $("pPos").textContent = tab ? "POS: đã mở" : "POS: chưa mở tab pos.v2.circa.vn";
    $("pPos").className = "pill " + (tab ? "ok" : "bad");
    return tab;
  }
  function canWrite() {
    return !!(state.me && state.me.scopes.indexOf("write") >= 0);
  }
  function paintPills() {
    $("pKey").textContent = state.me ? "Nextwaves: " + state.me.name + (canWrite() ? " (write)" : " (chỉ đọc)") : state.key ? "Nextwaves: chưa kiểm key" : "Nextwaves: chưa có key";
    $("pKey").className = "pill " + (state.me ? "ok" : "warn");
    $("pSend").textContent = state.settings && state.settings.allowSend ? "Gửi: BẬT" : "Gửi: TẮT (chỉ kiểm tra)";
    $("pSend").className = "pill " + (state.settings && state.settings.allowSend ? "bad" : "");
  }

  // ---------- Kiểm tra ----------
  function progress(p) {
    const names = { pos: "Đọc POS", nextwaves_orders: "Nextwaves: đơn đã có", uids: "Tra UID → EPC", holdings: "Lượng còn của tem" };
    $("prog").classList.remove("hidden");
    $("progBar").style.width = Math.round((p.done / Math.max(1, p.total)) * 100) + "%";
    $("progTxt").textContent = (names[p.phase] || p.phase) + ": " + p.done + "/" + p.total;
  }
  async function runCheck() {
    if (state.busy) return;
    const parsed = R.parseInput($("input").value);
    $("parseMsg").textContent = parsed.orders.length + " đơn hợp lệ" + (parsed.dups ? " · " + parsed.dups + " trùng đã bỏ" : "") + (parsed.errors.length ? " · " + parsed.errors.length + " dòng lỗi (" + parsed.errors.slice(0, 3).map((e) => e.reason).join(", ") + ")" : "");
    if (!parsed.orders.length) return;
    if (!state.key) return alert("Chưa có API key Nextwaves (Cài đặt).");
    const tab = await checkPos();
    if (!tab) return alert("Mở tab pos.v2.circa.vn và đăng nhập trước.");
    state.busy = true;
    $("btnCheck").disabled = true;
    try {
      const runner = makeRunner(tab.id);
      const res = await runner.check(parsed.orders);
      const byId = new Map(state.results.map((r) => [r.orderId, r]));
      for (const r of res) byId.set(r.orderId, r);
      state.results = [...byId.values()];
      state.selected.clear();
      render();
    } catch (e) {
      alert("Lỗi kiểm tra: " + ((e && e.message) || e));
    } finally {
      state.busy = false;
      $("btnCheck").disabled = false;
      $("progTxt").textContent += " · xong";
    }
  }

  // ---------- Bảng ----------
  function render() {
    const counts = {};
    let ready = 0, epcs = 0, units = 0;
    for (const r of state.results) {
      counts[r.verdict] = (counts[r.verdict] || 0) + 1;
      if (r.verdict === "ready") {
        ready++;
        epcs += r.payload.tags.length;
        units += r.units;
      }
    }
    $("chips").innerHTML = Object.entries(counts).map(([k, n]) => '<span class="chip v-' + esc(k) + '">' + esc(VERDICT[k] || k) + ": " + n + "</span>").join("") + (ready ? '<span class="chip">Nếu gửi mọi đơn đủ điều kiện: ' + epcs + " EPC · " + units + " đv cơ sở</span>" : "");
    const fv = $("fVerdict");
    const cur = fv.value;
    fv.innerHTML = '<option value="">Tất cả kết luận</option>' + Object.keys(counts).map((k) => '<option value="' + esc(k) + '">' + esc(VERDICT[k] || k) + "</option>").join("");
    fv.value = counts[cur] ? cur : "";
    const q = $("fSearch").value.trim().toUpperCase();
    const rows = state.results.filter((r) => (!fv.value || r.verdict === fv.value) && (!q || String(r.code || "").toUpperCase().indexOf(q) >= 0)).sort((a, b) => String(a.code).localeCompare(String(b.code)));
    $("tbl").tBodies[0].innerHTML = rows
      .map((r) => {
        const s = r.summary || {};
        const nw = r.nwStatus === 200 ? "Đã có" : r.nwStatus === 404 ? "Chưa có" : r.nwStatus ? "HTTP " + r.nwStatus : "";
        const sel = r.verdict === "ready" ? '<input type="checkbox" data-sel="' + esc(r.code) + '"' + (state.selected.has(r.code) ? " checked" : "") + ">" : "";
        const pay = r.verdict === "ready" ? r.payload.tags.length + " · " + r.units : "";
        const sent = r.sendState ? esc(r.sendState + (r.sendReason ? " (" + r.sendReason + ")" : "")) : "";
        return '<tr class="click" data-id="' + esc(r.orderId) + '"><td>' + sel + '</td><td class="mono"><a href="https://pos.v2.circa.vn/ban-hang/' + esc(r.orderId) + '" target="_blank">' + esc(r.code || r.orderId.slice(0, 8)) + "</a></td><td>" + esc(vn(r.completedDate)) + "</td><td>" + esc((r.posStatus || "") + " · " + (r.posType || "")) + "</td><td>" + (s.lines !== undefined ? s.ok + "/" + s.held + "/" + s.noRfid + "/" + s.failed + " (" + s.lines + ")" : "") + "</td><td>" + esc(nw) + '</td><td class="v-' + esc(r.verdict) + '">' + esc(VERDICT[r.verdict] || r.verdict) + "</td><td>" + esc(reasonText(r.reason)) + "</td><td>" + esc(pay) + "</td><td>" + sent + "</td></tr>";
      })
      .join("");
    paintSend();
  }
  function paintSend() {
    const n = state.selected.size;
    const max = state.settings ? state.settings.maxPerBatch : 20;
    const ok = n > 0 && n <= max && state.settings.allowSend && $("cAuto").checked && canWrite() && !state.busy;
    $("btnSend").disabled = !ok;
    $("btnSend").textContent = "Gửi " + n + " đơn đã chọn";
    const why = [];
    if (!n) why.push("chưa chọn đơn");
    if (n > max) why.push("vượt " + max + " đơn mỗi lượt");
    if (state.settings && !state.settings.allowSend) why.push("công tắc gửi đang tắt (Cài đặt → tick \"Cho phép gửi trừ tồn\")");
    if (!$("cAuto").checked) why.push("chưa xác nhận notifyAuto đã tắt");
    if (!canWrite()) why.push("key chưa có quyền write (bấm Kiểm tra key)");
    $("sendMsg").textContent = ok ? "" : why.join(" · ");
  }

  // ---------- Chi tiết ----------
  function showDetail(id) {
    const r = state.results.find((x) => x.orderId === id);
    if (!r) return;
    const names = new Map(((r.json && r.json.data.order.items) || []).map((i) => [String(i.id).toLowerCase(), i]));
    let h = "<h2>" + esc(r.code) + " · " + esc(VERDICT[r.verdict] || r.verdict) + "</h2><p class='muted'>" + esc(reasonText(r.reason)) + "</p>";
    if (r.payloadJson) h += "<p class='mono muted'>Payload: " + esc(r.payloadJson) + "<br>SHA-256: " + esc(r.hash) + "</p>";
    if (r.preview && r.preview.reasons && r.preview.reasons.length) h += "<p>Lý do cấp đơn: " + r.preview.reasons.map((x) => esc(reasonText(x.code))).join("; ") + "</p>";
    h += "<table><thead><tr><th>Sản phẩm</th><th>SL</th><th>Base</th><th>Dòng</th><th>Lý do dòng</th><th>UID</th><th>EPC</th><th>Tem còn</th><th>UID</th><th>Trừ</th></tr></thead><tbody>";
    for (const it of (r.preview && r.preview.items) || []) {
      const src = names.get(it.itemId) || {};
      const uids = it.uids && it.uids.length ? it.uids : [{ uid: "" }];
      uids.forEach((u, i) => {
        h += "<tr>" + (i === 0 ? "<td rowspan='" + uids.length + "'>" + esc(src.product_name || it.productName || it.productId) + "<br><span class='muted'>" + esc(src.sku_code || "") + "</span></td><td rowspan='" + uids.length + "'>" + esc(it.quantity + " " + (it.unit || "")) + "</td><td rowspan='" + uids.length + "'>" + esc((it.baseQuantity || "") + " " + (it.baseUnit || "")) + "</td><td rowspan='" + uids.length + "'>" + esc(it.status) + "</td><td rowspan='" + uids.length + "'>" + it.reasons.map((c) => '<span title="' + esc(LBL[c] || "") + '">' + esc(c) + "</span>").join(", ") + "</td>" : "") + "<td class='mono'>" + esc(u.uid) + "</td><td class='mono'>" + esc(u.epc || "") + "</td><td>" + esc(u.held === null || u.held === undefined ? "" : u.held) + "</td><td>" + esc(u.kind || "") + (u.reasons && u.reasons.length ? " · " + esc(u.reasons.join(", ")) : "") + "</td><td>" + esc(u.quantity === null || u.quantity === undefined ? "" : u.quantity) + "</td></tr>";
      });
    }
    h += "</tbody></table>";
    if (r.log) {
      h += "<h2 style='margin-top:14px'>Activity-log POS</h2><table><tbody>" + r.log.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map((a) => "<tr><td>" + esc(vn(a.created_at)) + "</td><td>" + esc(a.action) + "</td><td>" + esc(a.status) + "</td><td>" + esc(JSON.stringify(a.detail && a.detail.args)) + "</td><td class='mono'>" + esc([a.metadata.sku_code, a.metadata.qr_code, a.metadata.unit, a.metadata.via].filter(Boolean).join(" · ")) + "</td></tr>").join("") + "</tbody></table>";
    }
    $("drawerBody").innerHTML = h;
    $("drawer").classList.remove("hidden");
  }

  // ---------- Gửi ----------
  function confirmSend(list) {
    return new Promise((resolve) => {
      const epcs = list.reduce((a, r) => a + r.payload.tags.length, 0);
      const units = list.reduce((a, r) => a + r.units, 0);
      $("modalBody").innerHTML = "<h2>Gửi trừ tồn " + list.length + " đơn</h2><p>" + epcs + " EPC · " + units + " đơn vị cơ sở · tenant " + esc(state.settings.base.replace(/^https:\/\//, "").split("/")[0]) + "</p><p class='mono muted'>" + list.map((r) => esc(r.code)).join(", ") + "</p><p>Gõ lại số đơn (<b>" + list.length + "</b>) để xác nhận:</p><input id='mConfirm' autocomplete='off'><div class='row'><button class='danger' id='mOk'>Gửi</button><button class='ghost' id='mCancel'>Huỷ</button></div>";
      $("modal").classList.remove("hidden");
      const done = (v) => {
        $("modal").classList.add("hidden");
        resolve(v);
      };
      $("mOk").onclick = () => done($("mConfirm").value.trim() === String(list.length));
      $("mCancel").onclick = () => done(false);
    });
  }
  async function runSend() {
    const list = state.results.filter((r) => state.selected.has(r.code) && r.verdict === "ready").sort((a, b) => String(a.completedDate).localeCompare(String(b.completedDate)));
    if (!list.length || !(await confirmSend(list))) return;
    const tab = await checkPos();
    if (!tab) return alert("Mở tab pos.v2.circa.vn trước.");
    const runner = makeRunner(tab.id);
    state.busy = true;
    paintSend();
    try {
      for (const r of list) {
        $("sendMsg").textContent = "Đang gửi " + r.code + "…";
        const res = await runner.send(r);
        r.sendState = res.state;
        r.sendReason = res.reason || (res.record && res.record.reconcile) || "";
        if (res.state === "confirmed") r.verdict = "sent";
        else if (res.state === "on_nextwaves") r.verdict = "on_nextwaves";
        else if (res.state === "changed") r.verdict = "needs_review";
        state.selected.delete(r.code);
        render();
        if (res.stop || res.state === "stopped") {
          alert("Dừng hàng đợi ở " + r.code + ": " + res.state + " · " + (res.reason || ""));
          break;
        }
      }
    } finally {
      state.busy = false;
      $("sendMsg").textContent = "";
      paintSend();
      loadHistory();
    }
  }

  // ---------- Nhật ký ----------
  async function historyRecords() {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all).filter(([k]) => k.indexOf(R.REC_PREFIX) === 0).map(([, v]) => v).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }
  async function loadHistory() {
    const recs = await historyRecords();
    $("hist").tBodies[0].innerHTML = recs
      .map((r) => "<tr><td class='mono'>" + esc(r.code) + "</td><td>" + esc(r.state) + "</td><td>" + esc(r.reason || "") + "</td><td>" + esc(r.payloadJson ? JSON.parse(r.payloadJson).tags.length : "") + "</td><td>" + esc(vn(r.startedAt)) + "</td><td>" + esc(vn(r.finishedAt)) + "</td><td>" + esc(r.reconcile || "") + "</td><td>" + (r.state === "ambiguous" ? "<button class='ghost' data-amb='" + esc(r.code) + "'>Kiểm tra trên Nextwaves</button>" : "") + "</td></tr>")
      .join("");
  }
  async function onAmbiguous(code) {
    const tab = await checkPos();
    const runner = makeRunner(tab ? tab.id : 0);
    const r1 = await runner.resolveAmbiguous(code, false);
    if (r1.state === "resendable") {
      if (confirm(code + " chưa có trên Nextwaves. Gửi lại ĐÚNG lệnh cũ (cùng body + Idempotency-Key)?")) {
        const r2 = await runner.resolveAmbiguous(code, true);
        alert(code + ": " + r2.state + " · " + (r2.reason || ""));
      }
    } else alert(code + ": " + r1.state + " · " + (r1.reason || ""));
    loadHistory();
  }

  // ---------- CSV ----------
  function download(name, rows) {
    const csv = "﻿" + rows.map((r) => r.map((v) => {
      let s = v === null || v === undefined ? "" : String(v);
      if (/^[=+\-@]/.test(s)) s = "'" + s;
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  function csvOrders() {
    download("tru-ton-bu-don-" + stamp() + ".csv", [["DHC", "order_id", "Hoàn tất", "POS", "Loại", "Nextwaves", "Kết luận", "Lý do", "Số EPC", "Tổng trừ", "Dòng đạt", "Dòng giữ", "Dòng không EPC", "Dòng EPC không đạt", "Gửi"]].concat(state.results.map((r) => [r.code, r.orderId, vn(r.completedDate), r.posStatus, r.posType, r.nwStatus, VERDICT[r.verdict] || r.verdict, reasonText(r.reason), r.payload ? r.payload.tags.length : "", r.units || "", (r.summary || {}).ok, (r.summary || {}).held, (r.summary || {}).noRfid, (r.summary || {}).failed, r.sendState || ""])));
  }
  function csvLines() {
    const out = [["DHC", "order_id", "Kết luận đơn", "product_id", "SKU", "Sản phẩm", "SL", "ĐVT", "base_quantity", "ĐV cơ sở", "Kết quả dòng", "Lý do dòng", "UID", "EPC", "Tem còn", "Kết quả UID", "Lý do UID", "Lượng trừ"]];
    for (const r of state.results) {
      const names = new Map(((r.json && r.json.data.order.items) || []).map((i) => [String(i.id).toLowerCase(), i]));
      for (const it of (r.preview && r.preview.items) || []) {
        const src = names.get(it.itemId) || {};
        for (const u of it.uids && it.uids.length ? it.uids : [{ uid: "" }]) out.push([r.code, r.orderId, VERDICT[r.verdict] || r.verdict, it.productId, src.sku_code, src.product_name, it.quantity, it.unit, it.baseQuantity, it.baseUnit, it.status, it.reasons.join(" "), u.uid, u.epc, u.held, u.kind, (u.reasons || []).join(" "), u.quantity]);
      }
    }
    download("tru-ton-bu-dong-" + stamp() + ".csv", out);
  }
  async function csvHistory() {
    const recs = await historyRecords();
    download("tru-ton-bu-nhat-ky-" + stamp() + ".csv", [["DHC", "order_id", "Trạng thái", "Lý do", "Idempotency-Key", "Payload", "SHA-256", "Bắt đầu", "Xong", "Đối soát", "Tenant"]].concat(recs.map((r) => [r.code, r.orderId, r.state, r.reason, r.idempotencyKey, r.payloadJson, r.payloadHash, r.startedAt, r.finishedAt, r.reconcile, r.apiBase])));
  }

  // ---------- Khởi động ----------
  async function init() {
    $("ver").textContent = "v" + chrome.runtime.getManifest().version + " · core v0.8.0.5";
    await loadSettings();
    const all = await chrome.storage.local.get(null);
    const fixed = await R.createRunner({ CORE, RFID, E, storeGet, storeSet, now: () => new Date().toISOString(), nwFetch, nwBase: state.settings.base, sha256 }).recover(Object.keys(all));
    if (fixed.length) alert("Có " + fixed.length + " đơn đang gửi dở khi trang bị đóng, đã chuyển sang 'Không rõ kết quả' (không tự gửi lại): " + fixed.join(", "));
    checkPos();
    if (state.key) checkKey();
    loadHistory();
    $("btnSettings").onclick = () => $("settings").classList.toggle("hidden");
    $("btnSave").onclick = saveSettings;
    // v0.1.1: tick / bỏ tick "Cho phép gửi" lưu ngay (trước đây phải bấm Lưu, dễ tưởng đã bật mà thực tế chưa).
    $("sAllow").onchange = saveSettings;
    $("btnCheckKey").onclick = async () => {
      await saveSettings();
      await checkKey();
    };
    $("btnCheck").onclick = runCheck;
    $("btnClear").onclick = () => {
      state.results = [];
      state.selected.clear();
      render();
    };
    $("fVerdict").onchange = render;
    $("fSearch").oninput = render;
    $("cAuto").onchange = paintSend;
    $("btnSelAll").onclick = () => {
      const max = state.settings.maxPerBatch;
      for (const r of state.results.filter((x) => x.verdict === "ready").sort((a, b) => String(a.completedDate).localeCompare(String(b.completedDate)))) if (state.selected.size < max) state.selected.add(r.code);
      render();
    };
    $("btnSend").onclick = runSend;
    $("btnCsv").onclick = csvOrders;
    $("btnCsvLines").onclick = csvLines;
    $("btnHist").onclick = loadHistory;
    $("btnHistCsv").onclick = csvHistory;
    $("drawerClose").onclick = () => $("drawer").classList.add("hidden");
    $("drawer").onclick = (e) => {
      if (e.target === $("drawer")) $("drawer").classList.add("hidden");
    };
    $("tbl").addEventListener("click", (e) => {
      const cb = e.target.closest("input[data-sel]");
      if (cb) {
        if (cb.checked) state.selected.add(cb.dataset.sel);
        else state.selected.delete(cb.dataset.sel);
        paintSend();
        return;
      }
      if (e.target.closest("a")) return;
      const tr = e.target.closest("tr[data-id]");
      if (tr) showDetail(tr.dataset.id);
    });
    $("hist").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-amb]");
      if (b) onAmbiguous(b.dataset.amb);
    });
  }
  init();
})();
