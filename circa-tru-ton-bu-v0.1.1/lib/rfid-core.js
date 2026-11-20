// rfid-core.js — logic thuần phần RFID (không dùng chrome.*), chạy được trong Node để test.
// Nguyên là core.js của circa-rfid-scan-demo v0.1.7, chuyển sang đây khi gộp extension (0.2.0);
// cộng thêm tra cứu UID → EPC cho luồng QR và quy đổi kết quả gửi sang cột `result` của Sheet.
// Dùng chung cho content script RFID (isolated world) và service worker.
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.__CIRCA_RFID_DEMO_CORE__ = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- Route ----------
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SALE_ROUTE_RE = /^\/ban-hang\/([0-9a-f-]{36})(?:\/|$)/i;

  // UUID đơn trên /ban-hang/<UUID>, hoặc null.
  function saleOrderIdFromPath(pathname) {
    const m = String(pathname || "").match(SALE_ROUTE_RE);
    return m && UUID_RE.test(m[1]) ? m[1].toLowerCase() : null;
  }

  // ---------- Giao thức reader NATION (tái sử dụng từ Circa RFID 1.73, thêm kiểm checksum) ----------
  function crc16Ccitt(bytes) {
    let crc = 0;
    for (const byte of bytes) {
      crc ^= byte << 8;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
      }
    }
    return crc;
  }

  // 0x5A | PCW (4 byte) | độ dài dữ liệu (2 byte) | dữ liệu | CRC16 (2 byte, tính trên PCW..dữ liệu)
  function nationFrame(command, payload) {
    const data = payload || [];
    const category = (command >> 8) & 0xff;
    const mid = command & 0xff;
    const pcw = (0x01 << 16) | (category << 8) | mid;
    const body = [(pcw >> 24) & 0xff, (pcw >> 16) & 0xff, (pcw >> 8) & 0xff, pcw & 0xff, (data.length >> 8) & 0xff, data.length & 0xff, ...data];
    const crc = crc16Ccitt(body);
    return new Uint8Array([0x5a, ...body, (crc >> 8) & 0xff, crc & 0xff]);
  }

  const startInventoryFrame = () => nationFrame(0x0210, [0x00, 0x00, 0x00, 0x0f, 0x01]);
  const stopInventoryFrame = () => nationFrame(0x02ff);

  // Ghép các đoạn dữ liệu serial thành frame hoàn chỉnh. Frame đủ độ dài nhưng sai checksum bị bỏ
  // (đếm vào badCrc) và dò tiếp từ byte sau header, để một byte nhiễu không nuốt mất frame kế tiếp.
  function takeFrames(buffer) {
    const bytes = Array.from(buffer || []);
    const frames = [];
    let badCrc = 0;
    let offset = 0;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0x5a) {
        offset += 1;
        continue;
      }
      if (offset + 7 > bytes.length) break;
      const dataLength = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const frameLength = 7 + dataLength + 2;
      if (offset + frameLength > bytes.length) break;
      const frame = bytes.slice(offset, offset + frameLength);
      const expected = crc16Ccitt(frame.slice(1, frameLength - 2));
      const actual = (frame[frameLength - 2] << 8) | frame[frameLength - 1];
      if (expected === actual) {
        frames.push(frame);
        offset += frameLength;
      } else {
        badCrc += 1;
        offset += 1;
      }
    }
    return { frames, remainder: bytes.slice(offset), badCrc };
  }

  function normalizeEpc(value) {
    const hex = String(value || "").replace(/\s+/g, "").toUpperCase();
    return /^[0-9A-F]+$/.test(hex) && hex.length % 2 === 0 ? hex : null;
  }

  // Frame thông báo kiểm kê (category 0x02/0x12, MID 0x00, bit notify) → EPC hex viết hoa.
  function parseInventoryFrame(frame) {
    const bytes = Array.from(frame || []);
    if (bytes.length < 9 || bytes[0] !== 0x5a) return null;
    const pcw = (bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4];
    const notify = (pcw >> 12) & 1;
    const category = (pcw >> 8) & 0xff;
    const mid = pcw & 0xff;
    if (notify !== 1 || (category !== 0x02 && category !== 0x12) || mid !== 0) return null;
    const dataLength = (bytes[5] << 8) | bytes[6];
    const payload = bytes.slice(7, 7 + dataLength);
    if (payload.length < 5) return null;
    const epcLength = (payload[0] << 8) | payload[1];
    if (epcLength <= 0 || payload.length < 2 + epcLength + 2) return null;
    const epc = normalizeEpc(payload.slice(2, 2 + epcLength).map((b) => b.toString(16).padStart(2, "0")).join(""));
    return epc ? { epc } : null;
  }

  // ---------- Nextwaves GET /api/v1/public/tags/{EPC}/sale-eligibility?channel=circa ----------
  const NEXTWAVES_SALE_ELIGIBILITY_URL = (epc) =>
    "https://api-circa-medly.nextwaves.app/api/v1/public/tags/" + encodeURIComponent(epc) + "/sale-eligibility?channel=circa";

  const ELIGIBILITY_ERRORS = Object.freeze({
    bad_response: "Response Nextwaves không hợp lệ",
    no_epc: "Response không có EPC",
    epc_mismatch: "EPC trong response không khớp tem vừa đọc",
    bad_eligible: "Response thiếu trường eligible hoặc eligible không phải true/false",
    ineligible: "Tem chưa đủ điều kiện bán",
    no_uid: "Tem đủ điều kiện nhưng không có unitUid hợp lệ",
  });

  const textOrNull = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

  // Chỉ gửi QR khi đồng thời: EPC khớp tem vừa đọc, eligible === true, unitUid là chuỗi không rỗng.
  // Kiểm tra theo thứ tự, sai ở đâu dừng ở đó. Không dùng giá, tồn kho, thanh toán hay trạng thái tem.
  // Response phẳng; vẫn nhận dạng bọc trong "data" khi cấp ngoài không có epc/eligible.
  function parseSaleEligibilityResponse(json, expectedEpc) {
    if (!json || typeof json !== "object" || Array.isArray(json)) return { ok: false, reason: "bad_response" };
    const wrapped = !("epc" in json) && !("eligible" in json) && json.data && typeof json.data === "object" && !Array.isArray(json.data);
    const d = wrapped ? json.data : json;
    const epc = normalizeEpc(d.epc);
    if (!epc) return { ok: false, reason: "no_epc" };
    if (epc !== normalizeEpc(expectedEpc)) return { ok: false, reason: "epc_mismatch", epc };
    if (typeof d.eligible !== "boolean") return { ok: false, reason: "bad_eligible", epc };
    if (d.eligible === false) {
      const params = d.params && typeof d.params === "object" ? d.params : null;
      const out = { ok: false, reason: "ineligible", epc, code: textOrNull(d.code), message: textOrNull(d.message), params };
      // "Không được bán" KHÔNG có nghĩa là "chưa map": response có UID thì giữ lại cho nhật ký. Vẫn ok:false —
      // điều kiện gửi phím vào POS không đổi (eligible === false thì 0 phím).
      const heldUid = typeof d.unitUid === "string" ? d.unitUid.trim() : "";
      if (heldUid) out.uid = heldUid;
      return out;
    }
    const uid = typeof d.unitUid === "string" ? d.unitUid.trim() : ""; // giữ dạng chuỗi, không nhận số
    if (!uid) return { ok: false, reason: "no_uid", epc };
    return { ok: true, epc, uid };
  }


  // ---------- Nextwaves GET /api/v1/public/printing/labels/generations/{qrRaw} (0.3) ----------
  // Một mã QR nguồn (mã in trên hộp) có thể sinh NHIỀU tem con, mỗi tem một UID/EPC. Dùng khi by-uid trả
  // mapped:false. Hai điều lấy từ production 20/09/2026, không phải giả định:
  //   - Phải gọi bằng NGUYÊN VĂN mã đã quét (qrRaw): "thuocsi.vn/qr/1770516463904LL15" → 200;
  //     gọi bằng UID đã trích "1770516463904LL15" → 404 CIRCA_LABEL_GENERATION_NOT_FOUND.
  //   - 404 nghiệp vụ có message đúng bằng CIRCA_LABEL_GENERATION_NOT_FOUND.
  // Quy tắc an toàn: KHÔNG bao giờ tự chọn một child. 0 child mapped → chưa map; đúng 1 → mapped; nhiều hơn →
  // mapped_multiple, để trống UID/EPC đơn và lưu cả danh sách child.
  const NEXTWAVES_GENERATION_URL = (qrRaw) => "https://api-circa-medly.nextwaves.app/api/v1/public/printing/labels/generations/" + encodeURIComponent(String(qrRaw));
  const GENERATION_NOT_FOUND = "CIRCA_LABEL_GENERATION_NOT_FOUND";
  const GENERATION_ERRORS = Object.freeze({
    bad_response: "Response generation không hợp lệ",
    code_mismatch: "Mã trong response không khớp mã đã quét",
    state: "Generation chưa ở trạng thái generated",
    superseded: "Generation đã bị thay thế",
    generation_id: "Thiếu generationId",
    children: "Thiếu danh sách child hợp lệ",
    counts: "Số đếm của generation không hợp lệ",
    incomplete: "Generation chưa sinh đủ tem",
    child: "Child sai hình dạng",
    duplicate: "UID hoặc EPC lặp mâu thuẫn",
  });
  // Ô Sheet tối đa 50.000 ký tự; cắt ở 45.000 và chỉ cắt theo child hoàn chỉnh để JSON luôn hợp lệ.
  const RESOLVED_CHILDREN_LIMIT = 45000;

  const isCount = (v) => Number.isInteger(v) && v >= 0;
  const textOrNullStrict = (v) => (typeof v === "string" && v ? v : null);

  // Chỉ giữ những trường phục vụ đối chiếu; không lưu nguyên object của Nextwaves.
  function projectGenerationChild(child) {
    return {
      unitUid: String(child.unitUid),
      mapped: child.mapped === true,
      epc: child.mapped === true ? String(child.epc).toUpperCase() : null,
      tagStatus: textOrNullStrict(child.tagStatus),
      printState: textOrNullStrict(child.printState),
    };
  }

  // Chuỗi JSON compact lưu vào cột resolvedChildren. Sắp xếp ổn định theo unitUid rồi epc để hai lần tra cùng
  // một generation cho ra ĐÚNG một chuỗi (không làm tăng revision vô cớ).
  function resolvedChildrenJson(children) {
    const sorted = (children || []).slice().sort((a, b) => String(a.unitUid).localeCompare(String(b.unitUid)) || String(a.epc || "").localeCompare(String(b.epc || "")));
    const full = { v: 1, truncated: false, total: sorted.length, children: sorted };
    const text = JSON.stringify(full);
    if (text.length <= RESOLVED_CHILDREN_LIMIT) return text;
    let stored = sorted.length;
    let out = text;
    while (stored > 0) {
      stored -= 1;
      out = JSON.stringify({ v: 1, truncated: true, total: sorted.length, stored, children: sorted.slice(0, stored) });
      if (out.length <= RESOLVED_CHILDREN_LIMIT) break;
    }
    return out;
  }

  // Fail-closed: thiếu bằng chứng thì là lỗi, KHÔNG bao giờ tự kết luận "chưa map".
  function parseGenerationResponse(json, qrRaw) {
    const bad = (reason) => ({ ok: false, reason });
    if (!json || typeof json !== "object" || Array.isArray(json)) return bad("bad_response");
    if (typeof json.code !== "string" || json.code !== String(qrRaw)) return bad("code_mismatch");
    if (json.state !== "generated") return bad("state");
    if (json.superseded !== false) return bad("superseded");
    if (!textOrNullStrict(json.generationId)) return bad("generation_id");
    if (!Array.isArray(json.children)) return bad("children");
    const summary = json.summary && typeof json.summary === "object" && !Array.isArray(json.summary) ? json.summary : null;
    if (!summary) return bad("counts");
    if (!isCount(json.expectedCount) || !isCount(json.mintedCount) || !isCount(summary.total) || !isCount(summary.mapped) || !isCount(summary.unmapped)) return bad("counts");
    if (summary.total !== json.children.length) return bad("counts");
    if (summary.mapped + summary.unmapped !== summary.total) return bad("counts");
    if (json.mintedCount < json.expectedCount) return bad("incomplete");

    const children = [];
    const uidSeen = new Map();
    const epcSeen = new Map();
    for (const child of json.children) {
      if (!child || typeof child !== "object" || typeof child.mapped !== "boolean") return bad("child");
      // Child chưa map CŨNG phải có UID hợp lệ: đó là danh tính tem đã in.
      if (!looksLikeGenerationUid(child.unitUid)) return bad("child");
      if (child.mapped) {
        if (!strictEpc(child.epc)) return bad("child");
      } else if (!isBlank(child.epc)) {
        return bad("child");
      }
      for (const f of ["tagStatus", "printState"]) if (child[f] !== undefined && child[f] !== null && typeof child[f] !== "string") return bad("child");
      const projected = projectGenerationChild(child);
      const prevUid = uidSeen.get(projected.unitUid);
      if (prevUid !== undefined && prevUid !== (projected.epc || "")) return bad("duplicate");
      uidSeen.set(projected.unitUid, projected.epc || "");
      if (projected.epc) {
        const prevEpc = epcSeen.get(projected.epc);
        if (prevEpc !== undefined && prevEpc !== projected.unitUid) return bad("duplicate");
        epcSeen.set(projected.epc, projected.unitUid);
      }
      children.push(projected);
    }
    const mapped = children.filter((c) => c.mapped);
    if (mapped.length !== summary.mapped) return bad("counts");
    const base = { ok: true, generationId: json.generationId, mappedChildCount: mapped.length, children, resolvedChildren: resolvedChildrenJson(children) };
    if (!mapped.length) return Object.assign(base, { kind: "unmapped" });
    if (mapped.length === 1) return Object.assign(base, { kind: "mapped", resolvedUid: mapped[0].unitUid, epc: mapped[0].epc });
    return Object.assign(base, { kind: "mapped_multiple" });
  }

  function isBlank(v) {
    return v === null || v === undefined || v === "";
  }

  function looksLikeGenerationUid(uid) {
    return typeof uid === "string" && /^[0-9A-Za-z]{8,64}$/.test(uid);
  }

  // Quy tắc HTTP cho worker và probe. Phân biệt rõ ba loại 404 vì hậu quả khác hẳn nhau.
  //   infra: hạ tầng (route chưa deploy, 5xx, mạng) — thử lại giãn dần, KHÔNG tiêu lượt thử nghiệp vụ.
  //   contract: response sai hợp đồng — dừng tự động, chờ người kiểm tra.
  function generationVerdict(status, json, qrRaw) {
    if (status === 404) {
      const message = typeof json?.message === "string" ? json.message : "";
      const code = typeof json?.code === "string" ? json.code : "";
      if (/^Cannot GET\b/i.test(message)) return { ok: false, reason: "route_missing", infra: true, status };
      // Không có generation nào cho mã này: "chưa map". KHÔNG đặt mappedChildCount — 0 tem con của một
      // generation có thật khác hẳn với không có generation nào, cột trên Sheet phải phân biệt được.
      if (message === GENERATION_NOT_FOUND || code === GENERATION_NOT_FOUND) return { ok: true, kind: "unmapped", status, notFound: true };
      return { ok: false, reason: "http_404", status };
    }
    if (status === 401 || status === 403) return { ok: false, reason: "auth", auth: true, status };
    if (!Number.isInteger(status) || status < 200 || status > 299) return { ok: false, reason: "http_" + status, infra: status >= 500, status };
    const parsed = parseGenerationResponse(json, qrRaw);
    if (!parsed.ok) return { ok: false, reason: "contract:" + parsed.reason, contract: true, status };
    return Object.assign({ status }, parsed);
  }

  // Chuỗi QR giống tem thật, POS tự tách mã ở đoạn cuối.
  function qrTextForUid(uid) {
    return "https://qr.v2.circa.vn/item/" + String(uid);
  }

  // ---------- Nextwaves GET /api/v1/public/tags/by-uid/{uid} (luồng QR: mã → EPC) ----------
  const NEXTWAVES_BY_UID_URL = (uid) =>
    "https://api-circa-medly.nextwaves.app/api/v1/public/tags/by-uid/" + encodeURIComponent(String(uid));

  // 0.6 — pilot trừ tồn. Hai địa chỉ này ở chung một nơi với các URL Nextwaves khác: đổi host thì đổi
  // một chỗ. Hình dạng response của /tags/{epc} do CORE.parseNextwavesTag giữ (trường LỒNG NHAU).
  const NEXTWAVES_TAG_URL = (epc) => "https://api-circa-medly.nextwaves.app/api/v1/public/tags/" + encodeURIComponent(String(epc));
  const NEXTWAVES_ORDERS_SYNC_URL = "https://api-circa-medly.nextwaves.app/api/v1/public/orders/sync";
  // v0.7.3 — Phase 1 trừ tồn (tài liệu Nextwaves "Flow trừ tồn cho Circa" 06/10/2026): POST cả đơn một lần (quyền write), và
  // GET lượng còn trong một tag trước khi trừ (quyền read). /orders/sync ở trên vẫn FROZEN.
  const NEXTWAVES_NOTIFY_URL = "https://api-circa-medly.nextwaves.app/api/v1/public/integrations/circa/orders/notify";
  const NEXTWAVES_NOTIFY_EPC_URL = (epc) => "https://api-circa-medly.nextwaves.app/api/v1/public/integrations/circa/epcs/" + encodeURIComponent(String(epc));

  const BY_UID_ERRORS = Object.freeze({
    bad_request: "Chưa có UID để tra",
    bad_response: "Response Nextwaves không hợp lệ",
    no_uid: "Response không có UID dạng chuỗi",
    uid_mismatch: "UID trong response không khớp mã vừa quét",
    bad_mapped: "Response thiếu cờ mapped hoặc mapped không phải true/false",
    bad_epc: "Response thiếu EPC hoặc EPC không phải chuỗi hex hợp lệ",
    unmapped_with_epc: "Response báo chưa map nhưng lại kèm EPC",
    auth: "Nextwaves từ chối xác thực",
  });

  // EPC trong response tra UID: CHUỖI hex, độ dài chẵn, không khoảng trắng. Chặt hơn normalizeEpc
  // (bộ đó phục vụ reader, nhận cả số và bỏ khoảng trắng) — ở đây một EPC dạng số là response sai
  // hình dạng, và chuyển nó thành chuỗi là tự bịa ra một EPC.
  function strictEpc(value) {
    return typeof value === "string" && /^[0-9A-Fa-f]+$/.test(value) && value.length % 2 === 0 ? value.toUpperCase() : null;
  }

  // Fail-closed, cùng tinh thần với parseSaleEligibilityResponse. Chỉ có hai kết luận:
  //   mapped   — UID khớp chính xác, mapped === true, EPC là chuỗi hex hợp lệ;
  //   unmapped — UID khớp chính xác, mapped === false, epc === null.
  // Mọi thứ khác — UID thiếu/null/số/lệch, cờ thiếu hay sai kiểu, EPC hỏng, hoặc mâu thuẫn "chưa
  // map mà có EPC" — là LỖI để thử lại, không bao giờ là "chưa map".
  // Hình dạng là tạm cho tới khi Batch A ghim từ response thật của 1789791653507C2 / …C6; đổi
  // shape thì đổi ở đây và ở test.
  function parseByUidResponse(json, expectedUid) {
    const wanted = typeof expectedUid === "string" ? expectedUid : "";
    if (!wanted) return { ok: false, reason: "bad_request" };
    if (!json || typeof json !== "object" || Array.isArray(json)) return { ok: false, reason: "bad_response" };
    const wrapped = !("mapped" in json) && json.data && typeof json.data === "object" && !Array.isArray(json.data);
    const d = wrapped ? json.data : json;

    // UID là bắt buộc và phải trùng từng ký tự — không trim, không đổi hoa/thường. Response cho mã
    // khác (hay không nói là cho mã nào) không được gán vào lượt quét này.
    const uid = "uid" in d ? d.uid : d.unitUid;
    if (typeof uid !== "string" || uid === "") return { ok: false, reason: "no_uid" };
    if (uid !== wanted) return { ok: false, reason: "uid_mismatch" };

    if (typeof d.mapped !== "boolean") return { ok: false, reason: "bad_mapped" };
    if (d.mapped === false) {
      if (!("epc" in d)) return { ok: false, reason: "bad_epc" };
      if (d.epc !== null) return { ok: false, reason: "unmapped_with_epc" };
      return { ok: true, mapped: false, uid, epc: null };
    }
    const epc = strictEpc(d.epc);
    if (!epc) return { ok: false, reason: "bad_epc" };
    return { ok: true, mapped: true, uid, epc };
  }

  // Kết luận từ (HTTP status, body). Một nơi quyết định, dùng chung cho worker (Batch B) và
  // scripts/probe-by-uid.mjs: 404 và mọi mã không phải 2xx là LỖI — không phải "chưa map" — cho
  // tới khi response thật chứng minh Nextwaves dùng 404 cho tem chưa map.
  function byUidVerdict(status, json, expectedUid) {
    if (status === 401 || status === 403) return { ok: false, reason: "auth", status };
    if (!Number.isInteger(status) || status < 200 || status > 299) return { ok: false, reason: "http_" + status, status };
    return Object.assign({ status }, parseByUidResponse(json, expectedUid));
  }

  // Trả lời CHECK_TAG (sale-eligibility) → phần "tra" của lượt RFID trong nhật ký chung (P1).
  //   res: trả lời của worker; tag: parseSaleEligibilityResponse(res.json, epc) khi res.ok, ngược lại null.
  // Hai khái niệm tách riêng (re-audit 2026-09-19): MAPPING = EPC có gắn UID không; ĐƯỢC BÁN = eligibility.
  //   - EPC khớp, có UID                         → "mapped" (kể cả khi không được bán — phần đó ở result)
  //   - không được bán, response không có UID    → "error": không đủ thông tin để kết luận mapping
  //   - được bán nhưng thiếu UID                 → "error"
  //   - lỗi gọi API / response sai / EPC lệch    → "error" (thử lại được)
  // sale-eligibility không bao giờ cho kết luận "unmapped": chỉ by-uid trả rõ mapped:false mới là "unmapped".
  function attemptMappingPatch(res, tag) {
    if (!res || res.ok !== true) {
      const why = (res && (res.error || (res.status ? "HTTP " + res.status : ""))) || "không có phản hồi";
      return { mappingStatus: "error", mappingError: String(why) };
    }
    const uid = tag && typeof tag.uid === "string" && tag.uid ? tag.uid : null;
    if (tag && (tag.ok || (tag.reason === "ineligible" && uid))) {
      return { mappingStatus: "mapped", mappingError: null, uid, qrRaw: qrTextForUid(uid), qrCode: uid };
    }
    const reason = (tag && tag.reason) || "bad_response";
    return { mappingStatus: "error", mappingError: reason + (reason === "ineligible" && tag.code ? ":" + tag.code : "") };
  }

  // Kết quả của lượt RFID dừng TRƯỚC khi gửi vì response Nextwaves không cho gửi (tag.ok === false):
  // Nextwaves nói rõ "không được bán" → "rejected"; mọi trường hợp khác (thiếu UID, EPC lệch, response sai) → "not_sent".
  function blockedTagResult(tag) {
    return tag && tag.reason === "ineligible" ? "rejected" : "not_sent";
  }

  // Kết quả một lượt RFID (submitQr / showOutcome) → cột `result` của nhật ký chung.
  // Không biết là không biết: kind lạ ra "unconfirmed", không đoán thành đã thêm hay chưa gửi.
  const RESULT_BY_OUTCOME = Object.freeze({
    added: "added",
    not_found: "rejected",
    unconfirmed: "unconfirmed",
    not_started: "not_sent",
  });
  function outcomeToResult(kind) {
    return RESULT_BY_OUTCOME[kind] || "unconfirmed";
  }

  // v0.7 Batch A — dựng trường `timing` của lượt RFID từ các mốc giờ (Date.now(), cùng đồng hồ máy cho content, worker
  // và trang). t0 = lúc reader đưa EPC tới (hoặc lúc người dùng bấm Thử lại / Cho phép thêm lại). Mốc thiếu, không phải
  // số, lệch trước t0 hay quá 1 giờ → null: số đo sai thì bỏ, không bao giờ đoán. Định nghĩa từng khoá: core.js
  // (RFID_TIMING_KEYS). durations: thời lượng đo riêng (nextwavesFetchMs, prepareMs), không tính từ t0.
  const TIMING_MARKS = Object.freeze({
    mark: "markMs",
    created: "createdMs",
    nextwaves: "nextwavesMs",
    saved: "savedMs",
    keys: "keysMs",
    lookup: "lookupMs",
    cart: "cartMs",
    done: "doneMs",
  });
  const TIMING_DURATIONS = Object.freeze(["nextwavesFetchMs", "prepareMs"]);
  const TIMING_MAX_MS = 3600000;
  const timingValue = (ms) => (Number.isFinite(ms) && ms >= 0 && ms <= TIMING_MAX_MS ? Math.round(ms) : null);
  function attemptTiming(t0, marks, durations) {
    const out = {};
    const m = marks || {};
    const base = Number(t0);
    for (const [name, field] of Object.entries(TIMING_MARKS)) {
      const at = m[name];
      out[field] = Number.isFinite(base) && typeof at === "number" ? timingValue(at - base) : null;
    }
    const d = durations || {};
    for (const field of TIMING_DURATIONS) out[field] = typeof d[field] === "number" ? timingValue(d[field]) : null;
    return out;
  }

  // ---------- Sự kiện phím do script tạo, phát thẳng vào document.body của trang POS ----------
  // Đã kiểm chứng trên POS thật 2026-09-17: bộ nhận quét toàn trang nhận chuỗi này và thêm đúng sản phẩm.
  // Mỗi "nhịp" = keydown + keypress + keyup của một ký tự; nhịp cuối là Enter. Giá trị keyCode/which/charCode
  // giống đoạn script đã kiểm chứng.
  const SYMBOL_KEYS = Object.freeze({
    ".": ["Period", 190],
    "/": ["Slash", 191],
    ":": ["Semicolon", 186],
    "-": ["Minus", 189],
    _: ["Minus", 189],
  });

  function scanTicksForText(text) {
    const ticks = [];
    for (const ch of String(text)) {
      let code;
      let keyCode;
      if (/^[a-zA-Z]$/.test(ch)) [code, keyCode] = ["Key" + ch.toUpperCase(), ch.toUpperCase().charCodeAt(0)];
      else if (/^[0-9]$/.test(ch)) [code, keyCode] = ["Digit" + ch, ch.charCodeAt(0)];
      else if (SYMBOL_KEYS[ch]) [code, keyCode] = SYMBOL_KEYS[ch];
      else throw new Error("Ký tự không hỗ trợ trong mã QR: " + JSON.stringify(ch));
      const charCode = ch.charCodeAt(0);
      ticks.push([
        { type: "keydown", key: ch, code, keyCode, charCode: 0 },
        { type: "keypress", key: ch, code, keyCode: charCode, charCode },
        { type: "keyup", key: ch, code, keyCode, charCode: 0 },
      ]);
    }
    ticks.push([
      { type: "keydown", key: "Enter", code: "Enter", keyCode: 13, charCode: 0 },
      { type: "keypress", key: "Enter", code: "Enter", keyCode: 13, charCode: 13 },
      { type: "keyup", key: "Enter", code: "Enter", keyCode: 13, charCode: 0 },
    ]);
    return ticks;
  }

  // Kết quả một lượt phát trong trang → một trong bốn:
  //  completed   : đã phát hết mọi nhịp, kể cả Enter
  //  not_started : chắc chắn chưa phát nhịp nào (bộ phát không nhận lượt, hoặc dừng trước nhịp đầu)
  //  partial     : đã phát một phần, KHÔNG có Enter
  //  unknown     : quá thời gian chờ kết quả / dữ liệu lạ → coi như có thể đã tới POS
  // v0.8.0.2: page-hook báo thêm terminatorSent (Enter đã phát). Bản ghi thiếu trường này (page-hook cũ) suy như trước từ sentTicks.
  function scanDelivery(run) {
    if (!run || typeof run !== "object") return "unknown";
    if (run.acked === false) return "not_started";
    if (run.acked !== true || run.timedOut || !Number.isInteger(run.sentTicks) || !Number.isInteger(run.total)) return "unknown";
    if (run.terminatorSent === true && run.sentTicks !== run.total) return "unknown"; // tự mâu thuẫn: không đoán
    if (run.completed === true && run.sentTicks === run.total && run.terminatorSent !== false) return "completed";
    if (run.sentTicks === 0 && run.terminatorSent !== true) return "not_started";
    return "partial";
  }

  // v0.8.0.2 (Batch 1, PM 27/10/2026): 0 phím CHẮC CHẮN và lý do là trang bận (hết hạn chờ trang rảnh) / trang khựng ngay trước phím
  // đầu → được tự thử lại cùng lượt. Mọi lý do khác (đổi đơn, huỷ, rời trang, không có bộ phát, hết hạn chờ kết quả) và mọi lượt đã
  // phát dù một phím → không. Nơi gọi kiểm thêm: POS chưa tra UID này sau mốc gửi, chưa có POST /item gắn lượt.
  function zeroKeyRetryable(run) {
    return (
      !!run &&
      typeof run === "object" &&
      run.acked === true &&
      !run.timedOut &&
      run.sentTicks === 0 &&
      run.terminatorSent === false &&
      (run.code === "busy" || run.code === "lag")
    );
  }

  // ---------- v0.8.0.2 (Batch 1): trạng thái từng tem của đơn đang mở ----------
  // seen → checking → prepared → sending → awaiting_pos → added | rejected | needs_review; not_sent = lỗi trước phím đầu (Thử lại);
  // reviewed = tem cần kiểm đã được người vận hành bấm "Đã kiểm giỏ".
  const TAG_STATE_LABELS = Object.freeze({
    seen: "Đang chờ",
    checking: "Đang kiểm tra",
    prepared: "Đang gửi",
    sending: "Đang gửi",
    awaiting_pos: "Đang xác nhận",
    added: "Đã thêm",
    rejected: "Không thêm được",
    needs_review: "Cần kiểm giỏ (có thể đã gõ)",
    not_sent: "Chưa gửi (0 phím)",
    reviewed: "Đã kiểm",
  });
  // v0.8.0.3 (PM audit 28/10/2026, P1): tem CHƯA chắc vào giỏ — chưa gửi (0 phím), không thêm được, cần kiểm giỏ (chưa bấm Đã kiểm giỏ). Luôn đứng
  // đầu danh sách và được đếm vào nhãn nút thu gọn "Cần xử lý N tem"; kết quả "Đã thêm" của tem sau không che được.
  const TAG_ATTENTION = Object.freeze(["not_sent", "rejected", "needs_review"]);
  const TAG_LIST_MAX_LINES = 8;
  const TAG_SUMMARY = [
    ["added", "Đã thêm"],
    ["needs_review", "Cần kiểm"],
    ["not_sent", "Chưa gửi"],
    ["rejected", "Không thêm được"],
    ["reviewed", "Đã kiểm"],
    ["active", "Đang xử lý"],
  ];

  // Dấu chống trùng trong storage.session → trạng thái hiển thị khi dựng lại danh sách (F5, worker khởi động lại, quay lại đơn).
  // "submitted" không có review (F5 giữa lúc gửi) cũng là cần kiểm: không biết phím đã tới POS hay chưa.
  function tagStateFromMark(mark) {
    if (!mark || typeof mark !== "object") return null;
    if (mark.state === "added") return "added";
    if (mark.state !== "submitted") return null;
    return mark.review && typeof mark.review === "object" && mark.review.reviewedAt ? "reviewed" : "needs_review";
  }

  // ---------- v0.8.0.4 (Batch 1b — dist/review/v0.8.0.4-batch1b-spec.md): sổ bền mọi tem đã gửi của đơn ----------
  // rfidAttn:<orderId> = { v: 2, orderId, tags: { <EPC>: mục }, updatedAt } (storage.local, một khoá mỗi đơn). Mục: state (ATTN_STATES), eventId + seq =
  // thẻ lượt lúc PREPARE, added = { eventId, at, uid, name } = lần POS đã xác nhận tem vào giỏ (chỉ worker ghi, không bao giờ xoá, giữ qua lượt Thêm
  // lại). Mục v1 (v0.8.0.3) không có seq / added — đọc nguyên, không suy ra added. Chỉ worker áp các hàm dưới đây; content chỉ gửi lệnh.
  const ATTN_STATES = Object.freeze(["submitted", "added", "not_sent", "rejected", "needs_review", "reviewed"]);
  const ATTN_SET_STATES = Object.freeze(["not_sent", "rejected", "needs_review", "reviewed"]); // content ghi qua RFID_ATTN_SET
  const ATTN_MAX_TAGS = 300;
  const attnText = (v, max) => (typeof v === "string" && v ? v.slice(0, max) : null);
  function cleanAttnAdded(a) {
    if (!a || typeof a !== "object") return null;
    return { eventId: attnText(a.eventId, 64), at: attnText(a.at, 40), uid: attnText(a.uid, 80), name: attnText(a.name, 200) };
  }
  // Mục đã chuẩn hoá (cắt chuỗi, bỏ trường lạ); null khi trạng thái không hợp lệ. at: giờ dùng khi mục không có.
  function cleanAttnEntry(e, at) {
    if (!e || typeof e !== "object" || !ATTN_STATES.includes(e.state)) return null;
    const out = {
      state: e.state,
      eventId: attnText(e.eventId, 64),
      seq: Number.isInteger(e.seq) ? e.seq : null,
      reason: attnText(e.reason, 300),
      at: attnText(e.at, 40) || at || null,
      sentTicks: Number.isInteger(e.sentTicks) && e.sentTicks >= 0 ? e.sentTicks : null,
      uid: attnText(e.uid, 80),
      name: attnText(e.name, 200),
      reviewedAt: attnText(e.reviewedAt, 40),
      retryable: e.retryable === true,
      readd: e.readd === true,
      attempt: null,
      added: cleanAttnAdded(e.added),
    };
    const a = e.attempt;
    if (a && typeof a === "object" && typeof a.eventId === "string" && Number.isInteger(a.seq) && a.fields && typeof a.fields === "object" && JSON.stringify(a.fields).length <= 4000)
      out.attempt = { eventId: a.eventId.slice(0, 64), seq: a.seq, fields: a.fields };
    return out;
  }
  // Lần POS đã xác nhận tem vào giỏ: bản ghi added (v2), hoặc chính mục "added" nếu thiếu bản ghi. Mục v1 không có → null.
  function attnAddedOf(e) {
    if (!e || typeof e !== "object") return null;
    if (e.added && typeof e.added === "object") return e.added;
    return e.state === "added" ? { eventId: e.eventId || null, at: e.at || null, uid: e.uid || null, name: e.name || null } : null;
  }
  // v0.8.0.5 (PM audit v0.8.0.4): mục hợp lệ = object (không phải mảng) có state thuộc ATTN_STATES, bản ghi 'added' (nếu có) là object — đúng dạng mọi mục
  // v0.8.0.3 (v1, không có added) / v0.8.0.4 (v2, added null hoặc object) đã ghi. 'added' hỏng làm tem đã vào giỏ mất chặn → coi cả mục là hỏng.
  function attnEntryValid(e) {
    if (!e || typeof e !== "object" || Array.isArray(e) || !ATTN_STATES.includes(e.state)) return false;
    return e.added === undefined || e.added === null || (typeof e.added === "object" && !Array.isArray(e.added));
  }
  // Giá trị khoá rfidAttn:<đơn> đọc từ storage.local → { ok: true, tags }. undefined = chưa có khoá = đơn chưa có tem → {}. Khoá có giá trị null / sai dạng,
  // tags sai dạng hay MỘT mục hỏng → { ok: false }: chặn CẢ đơn (GET_MARK / PREPARE / ghi mục), không ghi đè — sổ giữ nguyên để đối soát.
  function attnTagsOf(v) {
    if (v === undefined) return { ok: true, tags: {} };
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "rfidAttn_corrupt" };
    const t = v.tags;
    if (!t || typeof t !== "object" || Array.isArray(t)) return { ok: false, error: "rfidAttn_corrupt" };
    for (const e of Object.values(t)) if (!attnEntryValid(e)) return { ok: false, error: "rfidAttn_corrupt" };
    return { ok: true, tags: t };
  }
  // Mục bền → dạng dấu chống trùng (như dấu storage.session) để content đi chung một đường. null = không chặn gửi. null / undefined = không có mục;
  // giá trị khác không đọc được (chuỗi, số, false…) chặn như trạng thái lạ (v0.8.0.5).
  function attnToMark(e) {
    if (e === null || e === undefined) return null;
    const add = attnAddedOf(e);
    const addedMark = () => ({ state: "added", uid: add.uid || e.uid || null, productName: add.name || e.name || null, at: add.at || e.at || null, eventId: add.eventId || null, from: "attn" });
    if (e.state === "added") return addedMark();
    if (e.state === "not_sent" || e.state === "rejected") return add ? addedMark() : null;
    // submitted (có thể đã phát phím, chưa xác nhận) / needs_review / reviewed / trạng thái lạ: chặn, cần kiểm giỏ.
    const known = e.state === "submitted" || e.state === "needs_review" || e.state === "reviewed";
    return {
      state: "submitted",
      uid: e.uid || null,
      productName: e.name || null,
      at: e.at || null,
      review: { eventId: e.eventId || null, reason: known ? e.reason || null : "mục chống trùng không đọc được", at: e.at || null, reviewedAt: e.reviewedAt || null },
      from: "attn",
    };
  }
  // Bậc chặn của một dấu: 2 = có thể đã phát phím, chưa xác nhận (submitted / dấu lạ); 1 = đã vào giỏ; 0 = không chặn.
  function markRank(m) {
    if (!m || typeof m !== "object") return 0;
    return m.state === "added" ? 1 : 2;
  }
  // Bổ sung 1 của PM: hợp nhất dấu storage.session với mục bền — bậc cao hơn thắng; bằng nhau lấy bản bền, trừ khi chỉ bản session có mốc "Đã kiểm
  // giỏ". Dấu session cũ không hạ được mục bền đang chặn; mục bền "chưa gửi" không gỡ được dấu session đang chặn.
  function mergeTagMark(sessionMark, entry) {
    const s = sessionMark && typeof sessionMark === "object" ? sessionMark : null;
    const d = attnToMark(entry);
    const rs = markRank(s);
    const rd = markRank(d);
    if (rs > rd) return s;
    if (rd > rs) return d;
    if (!rd) return null;
    const reviewed = (m) => !!(m.review && typeof m.review === "object" && m.review.reviewedAt);
    return rd === 2 && reviewed(s) && !reviewed(d) ? s : d;
  }
  // Bổ sung 1, 3, 4 của PM: worker chỉ ghi mục khi lệnh hợp lệ với mục hiện tại (bảng §3 của spec). cmd:
  //   { op: "prepare", eventId, seq, uid, at, readd }       — trước phím đầu; sessionMark = dấu storage.session hiện tại của tem
  //   { op: "added", eventId, seq, uid, name, at }           — POS đã xác nhận tem vào giỏ, đúng thẻ lượt
  //   { op: "set", entry, prep: { eventId, seq } | null, at } — content ghi not_sent / rejected / needs_review / reviewed
  // → { ok: true, entry } | { ok: false, error: already_marked | attn_stale | attn_blocked | invalid_attn… }. Từ chối thì KHÔNG ghi gì.
  function attnTransition(cur, cmd, sessionMark) {
    const c = cur && typeof cur === "object" ? cur : null;
    const keep = attnAddedOf(c);
    const m = cmd && typeof cmd === "object" ? cmd : {};
    const sameTurn = (eventId, seq) => !!c && c.state === "submitted" && typeof eventId === "string" && c.eventId === eventId && Number.isInteger(seq) && c.seq === seq;
    if (m.op === "prepare") {
      const merged = mergeTagMark(sessionMark, c);
      if (merged && !(m.readd === true && merged.state === "added")) return { ok: false, error: "already_marked" };
      // Thêm lại tem chỉ có dấu session "added" (vd đã thêm trước khi nâng cấp): ghi bằng chứng đó vào mục bền.
      const fromSession = !keep && merged && merged.from !== "attn" ? { eventId: merged.eventId || null, at: merged.at || null, uid: merged.uid || null, name: merged.productName || null } : null;
      return { ok: true, entry: cleanAttnEntry({ state: "submitted", eventId: m.eventId, seq: m.seq, at: m.at, uid: m.uid, name: c && c.name, readd: m.readd === true, added: keep || fromSession }, m.at) };
    }
    if (m.op === "added") {
      if (!sameTurn(m.eventId, m.seq)) return { ok: false, error: "attn_stale" };
      const rec = { eventId: m.eventId, at: m.at, uid: m.uid || c.uid, name: m.name || c.name };
      return { ok: true, entry: cleanAttnEntry({ state: "added", eventId: m.eventId, seq: m.seq, at: m.at, uid: rec.uid, name: rec.name, sentTicks: c.sentTicks, added: rec }, m.at) };
    }
    if (m.op !== "set") return { ok: false, error: "invalid_attn" };
    const e = cleanAttnEntry(m.entry, m.at);
    if (!e || !ATTN_SET_STATES.includes(e.state)) return { ok: false, error: "invalid_attn:entry" };
    const p = m.prep && typeof m.prep === "object" ? m.prep : null;
    const token = !!p && sameTurn(p.eventId, p.seq) && e.eventId === p.eventId;
    const st = c ? c.state : null;
    const loose = !c || st === "not_sent" || st === "rejected"; // chưa có mục / mục không chặn
    let allowed;
    if (e.state === "not_sent" || e.state === "rejected") allowed = token || loose || (st === "added" && e.readd);
    else if (e.state === "needs_review") allowed = token || loose || (st === "needs_review" && c.eventId === e.eventId);
    else allowed = !c || ((st === "needs_review" || st === "submitted" || st === "reviewed") && c.eventId === e.eventId);
    if (!allowed) return { ok: false, error: p && st === "submitted" ? "attn_stale" : "attn_blocked" };
    return { ok: true, entry: Object.assign(e, { seq: c && Number.isInteger(c.seq) ? c.seq : null, added: keep }) };
  }
  // Áp lệnh lên mọi mục của MỘT đơn (đọc lại trong khoá đơn). Bổ sung 5 của PM: EPC chưa có mục mà đơn đã đủ ATTN_MAX_TAGS mục → từ chối, KHÔNG bỏ
  // mục nào. Tem đang bị chặn thì báo chặn trước. v0.8.0.5: sổ sai dạng / có mục hỏng (ở bất kỳ EPC nào) → attn_corrupt, không ghi đè (lớp thứ hai sau
  // readAttn của worker). tags null / undefined = đơn chưa có tem.
  function attnApply(tags, epc, cmd, sessionMark) {
    if (tags !== null && tags !== undefined && !attnTagsOf({ tags }).ok) return { ok: false, error: "attn_corrupt" };
    const all = tags || {};
    const cur = Object.prototype.hasOwnProperty.call(all, epc) ? all[epc] : null;
    const r = attnTransition(cur, cmd, sessionMark);
    if (!r.ok) return r;
    if (!cur && Object.keys(all).length >= ATTN_MAX_TAGS) return { ok: false, error: "order_tag_limit" };
    return { ok: true, entry: r.entry, prev: cur, tags: Object.assign({}, all, { [epc]: r.entry }) };
  }

  // entries: [{ epc, state, name, uid, reason, seq, retryable }] của ĐƠN ĐANG MỞ. Dòng cần xử lý (TAG_ATTENTION) lên đầu, còn lại mới nhất trước.
  // retryable = tem chưa gửi còn Thử lại được (chắc chắn 0 phím); retryOthers = số tem như vậy KHÔNG phải tem của khung kết quả đang hiện
  // (khung đó đã có nút Thử lại riêng) — nút "Thử lại tem chưa gửi".
  function tagListView(entries, shownRetryKey) {
    const list = (Array.isArray(entries) ? entries : []).filter((e) => e && TAG_STATE_LABELS[e.state]);
    if (!list.length) return null;
    const counts = { added: 0, needs_review: 0, not_sent: 0, rejected: 0, reviewed: 0, active: 0 };
    for (const e of list) {
      if (Object.prototype.hasOwnProperty.call(counts, e.state)) counts[e.state] += 1;
      else counts.active += 1;
    }
    const attn = (e) => TAG_ATTENTION.includes(e.state);
    const ordered = list.slice().sort((a, b) => attn(b) - attn(a) || (Number(b.seq) || 0) - (Number(a.seq) || 0));
    const lines = ordered.slice(0, TAG_LIST_MAX_LINES).map((e) => {
      const what = textOrNullStrict(e.name) || (textOrNullStrict(e.uid) ? "UID " + e.uid : "");
      const why = attn(e) ? textOrNullStrict(e.reason) : null;
      const label = TAG_STATE_LABELS[e.state] + (e.state === "not_sent" && e.retryable ? ", thử lại được" : "");
      return {
        state: e.state,
        epc: String(e.epc || ""),
        text: ["…" + String(e.epc || "").slice(-6), what, label + (why ? " — " + why : "")].filter(Boolean).join(" · "),
      };
    });
    return {
      summary: TAG_SUMMARY.filter(([k]) => counts[k] > 0).map(([k, label]) => label + " " + counts[k]).join(" · "),
      lines,
      more: ordered.length - lines.length,
      needsReview: counts.needs_review,
      attention: counts.not_sent + counts.rejected + counts.needs_review,
      retryOthers: list.filter((e) => e.retryable && e.key !== shownRetryKey).length,
    };
  }

  // ---------- Xác nhận POS đã thêm ----------
  // Lượt tra QR của POS (POST /v2/product, qr_code nằm trong request body).
  function summarizePosLookup(requestBody, json) {
    let body = requestBody;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch (_) {
        return null;
      }
    }
    const raw = body && typeof body.qr_code === "string" ? body.qr_code.trim() : "";
    if (!raw) return null;
    const products = json && json.data && Array.isArray(json.data.products) ? json.data.products : null;
    if (!products) return null;
    const entry = products.find((p) => p && typeof p === "object" && p.product) || null;
    const product = entry ? entry.product : null;
    return {
      qrCode: lastPathSegment(raw),
      found: !!entry,
      productName: product && typeof product.product_name === "string" ? product.product_name : null,
      productCode: product && typeof product.product_code === "string" ? product.product_code : null,
    };
  }

  function lastPathSegment(value) {
    const s = String(value || "").trim();
    if (s.indexOf("/") === -1) return s;
    const parts = s.split(/[?#]/)[0].split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : s;
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFC")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  // Số lượng trong ô nhập của dòng giỏ ("1", "2", "1,5"); không đọc được → null.
  function parseQuantity(value) {
    const s = String(value == null ? "" : value).trim().replace(",", ".");
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    return Number(s);
  }

  // Dòng giỏ thuộc sản phẩm POS vừa tra: theo tên sản phẩm (hoặc mã sản phẩm khi không có tên).
  function rowIsProduct(rowText, product) {
    const text = normalizeText(rowText);
    const name = normalizeText(product && product.productName);
    if (name) return text.includes(name);
    const code = normalizeText(product && product.productCode);
    return !!code && text.split(/[\s|]+/).includes(code);
  }

  // Ảnh chụp giỏ: [{ text, qty }] (qty đọc từ ô số lượng của dòng).
  // "Đã thêm" chỉ khi, xét riêng các dòng của đúng sản phẩm: có đúng MỘT dòng mới số lượng 1 (các dòng cũ giữ nguyên),
  // hoặc đúng MỘT dòng tăng số lượng thêm 1. Giảm số lượng, đổi giá, thiếu số lượng → không xác nhận.
  function cartAddedOne(before, after, product) {
    if (!Array.isArray(before) || !Array.isArray(after)) return false;
    const pick = (rows) => rows.filter((r) => r && rowIsProduct(r.text, product)).map((r) => r.qty);
    const was = pick(before);
    const now = pick(after);
    if (was.concat(now).some((q) => typeof q !== "number" || !Number.isFinite(q))) return false;
    const left = now.slice();
    const gone = [];
    for (const q of was) {
      const i = left.indexOf(q);
      if (i === -1) gone.push(q);
      else left.splice(i, 1);
    }
    if (gone.length === 0) return left.length === 1 && left[0] === 1; // thêm một dòng mới số lượng 1
    return gone.length === 1 && left.length === 1 && Math.abs(left[0] - (gone[0] + 1)) < 1e-9; // một dòng +1
  }

  // ---------- 0.3.2: tự kích hoạt đọc cho đơn mới khi reader đã trống ----------
  // Đổi đơn xong, extension KHÔNG đọc cho đơn mới ngay: tem của đơn cũ còn nằm trên reader sẽ bị thêm nhầm.
  // Điều kiện duy nhất để bắt đầu đọc là READER IM LẶNG đủ lâu (không frame EPC nào) — không phải một khoảng
  // thời gian cố định sau khi đổi đơn.
  //
  // Hàm thuần để mốc hẹn không bao giờ kích hoạt nhầm: mọi điều kiện được kiểm lại NGAY TRƯỚC khi đọc.
  // s: { reader, orderId, pendingOrderId, generation, pendingGeneration, busy, operation, inFlight, nowMs, lastTagAt, gapMs }
  //   → "arm"    : đủ điều kiện, bắt đầu đọc cho pendingOrderId
  //     "wait"   : chưa đủ (reader còn tem, hoặc lượt cũ chưa xong) — hẹn lại
  //     "cancel" : hẹn này đã hết hiệu lực (mất reader, rời màn bán hàng, đã đổi sang đơn khác)
  const AUTO_ARM_GAP_MS = 1500;
  // Hẹn lại tối thiểu khi quyết định là "wait" VÌ LƯỢT CŨ CÒN CHẠY: lúc đó reader có thể đã im lặng từ lâu nên
  // khoảng cách tới mốc 1,5 giây bằng 0 — hẹn 0 ms sẽ thành vòng setTimeout nóng cho tới khi lượt cũ xong
  // (re-audit 0.3.2, finding 1). Nhận EPC mới vẫn đặt lại đủ 1,5 giây như thường.
  const AUTO_ARM_MIN_RETRY_MS = 200;
  function autoArmDecision(state) {
    const s = state || {};
    if (!textOrNullStrict(s.pendingOrderId)) return "cancel";
    if (!s.reader || !textOrNullStrict(s.orderId)) return "cancel";
    if (s.orderId !== s.pendingOrderId) return "cancel"; // đã sang đơn khác
    if (s.generation !== s.pendingGeneration) return "cancel"; // có việc khác xen vào (ngắt, arm tay, đổi đơn nữa)
    if (s.busy || (s.operation && s.operation !== "idle") || Number(s.inFlight) > 0) return "wait";
    const gap = Number.isFinite(s.gapMs) && s.gapMs > 0 ? s.gapMs : AUTO_ARM_GAP_MS;
    const last = Number.isFinite(s.lastTagAt) ? s.lastTagAt : 0;
    const now = Number.isFinite(s.nowMs) ? s.nowMs : 0;
    return now - last < gap ? "wait" : "arm";
  }

  // Reader đã trống từ trước khi đổi đơn → 0 ms (đọc gần như tức thì). Vừa thấy tem → chờ nốt phần còn lại.
  function autoArmDelayMs(nowMs, lastTagAt, gapMs) {
    const gap = Number.isFinite(gapMs) && gapMs > 0 ? gapMs : AUTO_ARM_GAP_MS;
    const last = Number.isFinite(lastTagAt) ? lastTagAt : 0;
    const now = Number.isFinite(nowMs) ? nowMs : 0;
    return Math.max(0, gap - (now - last));
  }

  // Hẹn lại sau một quyết định "wait". Không bao giờ 0 ms: reader im lặng nhưng lượt cũ chưa xong thì phải
  // hỏi lại theo nhịp, không phải quay vòng liên tục.
  function autoArmRetryMs(nowMs, lastTagAt, gapMs, minMs) {
    const min = Number.isFinite(minMs) && minMs > 0 ? minMs : AUTO_ARM_MIN_RETRY_MS;
    return Math.max(autoArmDelayMs(nowMs, lastTagAt, gapMs), min);
  }

  // ---------- View model của thanh RFID ----------
  // Chỉ dựng dữ liệu hiển thị từ trạng thái; không quyết định nghiệp vụ. Renderer trong content.js chỉ đọc object này.
  // state: { onSaleRoute, connecting, connected, waitingClear, manualFallback, busy, operation, result, badCrc }
  //   waitingClear (0.3.2): vừa đổi đơn, reader còn tem của đơn cũ → KHÔNG đọc cho đơn mới cho tới khi reader trống.
  //     Extension tự bắt đầu đọc khi reader im lặng đủ lâu; người dùng không phải bấm gì.
  //   manualFallback: đã chờ khá lâu mà reader vẫn phát EPC → hiện thêm nút bấm tay (reader phát EPC "ảo").
  //   operation: "idle" | "reading" | "checking" | "sending" | "confirming"
  //   result: null | { kind: "success"|"warning"|"error"|"info", headline, message, detail, retryable, readdable }
  //   readdable: kết quả "Sản phẩm này đã có trên đơn" (dấu added) của đúng đơn đang mở, chưa có lượt nào chạy cho tem đó
  //   v0.7 Batch B: otherTab = tab POS khác đang giữ reader (tab này KHÔNG mở cổng) → nút "Dùng RFID ở tab này";
  //     handover = đã bấm nút đó, đang chờ tab kia nhả; off = người dùng đã bấm Ngắt (áp cho mọi tab, sống qua F5).
  const OPERATION_TEXT = Object.freeze({
    reading: ["Đang đọc tem…", "Đang đọc tem RFID"],
    checking: ["Đang đọc tem…", "Đang kiểm tra mã với Nextwaves"],
    sending: ["Đang gửi…", "Đang gửi mã vào đơn"],
    confirming: ["Đang xác nhận…", "Đang xác nhận sản phẩm trên giỏ"],
    power: ["Đang áp dụng…", "Đang áp dụng công suất — RFID tạm dừng, chưa thêm hàng"],
    resume: ["Đang bật lại…", "Đang bật lại đọc tem"],
  });
  const IDLE_MESSAGE = Object.freeze({
    disconnected: "Đặt sản phẩm có tem lên reader sau khi kết nối",
    connecting: "Chọn reader trong hộp thoại của Chrome",
    connected: "Đang chờ sản phẩm có tem RFID",
    waiting_clear: "Extension sẽ tự bắt đầu đọc cho đơn này.",
    other_tab: "RFID đang hoạt động ở tab POS khác.",
    handover: "Đang chờ tab POS kia nhả reader…",
    paused: "RFID tạm dừng — không thêm hàng bằng RFID. QR vẫn dùng được.",
  });
  const OFF_MESSAGE = "Đã ngắt kết nối reader trên mọi tab POS. Bấm Kết nối RFID để bật lại.";
  const OFF_UNKNOWN_MESSAGE = "Chưa đọc được trạng thái Ngắt RFID nên không tự kết nối. Bấm Kết nối RFID để dùng.";
  const WAITING_CLEAR_HEADLINE = "Vui lòng nhấc sản phẩm cũ khỏi reader";
  const STATUS = Object.freeze({
    disconnected: ["○", "Chưa kết nối"],
    connecting: ["◌", "Đang kết nối…"],
    connected: ["●", "Đã kết nối"],
    waiting_clear: ["◍", "Chờ reader trống"],
    other_tab: ["◐", "Tab khác đang dùng"],
    handover: ["◌", "Đang chuyển reader…"],
    paused: ["‖", "RFID tạm dừng"],
  });
  const RESULT_ICON = Object.freeze({ success: "✓", warning: "!", error: "×" });

  function buildView(state) {
    const s = state || {};
    const connection = s.connecting
      ? "connecting"
      : s.connected
      ? s.paused
        ? "paused"
        : s.waitingClear
        ? "waiting_clear"
        : "connected"
      : s.handover
      ? "handover"
      : s.otherTab
      ? "other_tab"
      : "disconnected";
    // A2: Áp dụng công suất / bật lại đọc tem là thao tác của reader, không phải lượt bán.
    const operation = s.powerApplying === "resume" ? "resume" : s.powerApplying ? "power" : OPERATION_TEXT[s.operation] ? s.operation : "idle";
    const processing = operation !== "idle";
    const r = s.result && RESULT_ICON[s.result.kind] ? s.result : null;
    const info = s.result && s.result.kind === "info" ? s.result : null;
    const busy = !!s.busy || processing;

    const canConnect = connection === "disconnected" && !busy;
    const canSendSample = connection === "disconnected" && !busy;
    const canDisconnect = connection === "connected" || connection === "waiting_clear" || connection === "paused";
    const canArm = connection === "waiting_clear" && !busy;
    const canRetry = !!(r && r.kind === "error" && r.retryable) && connection === "connected" && !busy;
    const canReadd = !!(r && r.kind === "success" && r.readdable) && connection === "connected" && !busy;
    const canTakeover = connection === "other_tab" && !busy;

    const actions = [];
    if (connection === "other_tab") {
      actions.push({ id: "takeover", label: "Dùng RFID ở tab này", kind: "primary", enabled: canTakeover });
    } else if (connection === "handover") {
      // Đang chờ tab kia nhả: không có nút (bấm lại cũng chỉ là cùng một yêu cầu).
    } else if (connection === "disconnected" || connection === "connecting") {
      actions.push({ id: "connect", label: "Kết nối RFID", kind: "primary", enabled: canConnect });
      actions.push({ id: "sample", label: "Thử mã mẫu", kind: "secondary", enabled: canSendSample });
    } else {
      // A2: RFID tạm dừng sau Áp dụng công suất — chỉ đọc tem tiếp khi công suất đã xác minh và người vận hành bấm.
      if (connection === "paused") {
        if (s.paused === "verified") actions.push({ id: "power_resume", label: "Tiếp tục đọc tem", kind: "primary", enabled: !busy });
      } else if (connection === "waiting_clear") {
        // Chờ reader trống: KHÔNG có nút bắt buộc. Nút bấm tay chỉ hiện khi đã chờ lâu mà reader vẫn phát EPC.
        if (s.manualFallback) actions.push({ id: "arm", label: "Bắt đầu đọc thủ công", kind: "secondary", enabled: canArm });
      } else if (r && r.kind === "error" && r.retryable) actions.push({ id: "retry", label: "Thử lại", kind: "primary", enabled: canRetry });
      else if (canReadd) actions.push({ id: "allow_readd", label: "Cho phép thêm lại sản phẩm này", kind: "primary", enabled: true });
      actions.push({ id: "disconnect", label: "Ngắt kết nối", kind: "secondary", enabled: canDisconnect });
    }

    // v0.8.0.2: còn tem cần kiểm ở đơn đang mở → nút ghi nhận đã kiểm giỏ (dấu vẫn chặn tự gửi lại). Không phụ thuộc kết nối reader.
    const tagList = s.tagList && typeof s.tagList === "object" ? s.tagList : null;
    if (tagList && tagList.needsReview > 0) actions.push({ id: "review_ack", label: "Đã kiểm giỏ", kind: "secondary", enabled: true });
    // v0.8.0.3: tem chưa gửi (0 phím) còn Thử lại được mà khung kết quả đang hiện không phải của nó (tem sau đã thay khung, hoặc sau F5).
    if (tagList && tagList.retryOthers > 0 && connection === "connected")
      actions.push({ id: "retry_unsent", label: "Thử lại tem chưa gửi (" + tagList.retryOthers + ")", kind: "secondary", enabled: !busy });
    // Audit Batch B (P1): lệnh Ngắt toàn bộ tab chưa được xác nhận đã lưu → nút Thử lại đứng đầu.
    if (r && r.retryOff) actions.unshift({ id: "retry_off", label: "Thử lại", kind: "primary", enabled: !s.offRetrying });
    const [statusIcon, statusLabel] = processing ? ["◌", OPERATION_TEXT[operation][0]] : STATUS[connection];
    let headline = null;
    let message = connection === "disconnected" && s.off ? OFF_MESSAGE : connection === "disconnected" && s.offUnknown ? OFF_UNKNOWN_MESSAGE : IDLE_MESSAGE[connection];
    let detail = null;
    let result = "none";
    if (processing) {
      message = OPERATION_TEXT[operation][1];
    } else if (r) {
      result = r.kind;
      headline = r.headline || null;
      message = r.message || "";
      detail = r.detail || null;
    } else if (info) {
      message = info.message || message;
      detail = info.detail || null;
    } else if (connection === "waiting_clear") {
      headline = WAITING_CLEAR_HEADLINE;
    }
    const badCrc = Number.isFinite(s.badCrc) && s.badCrc > 0 ? s.badCrc : 0;
    // A2: hàng chọn mức công suất (chỉ khi reader đang mở ở tab này). s.powerChoice = rfid-protocol powerChoice; s.powerDraft = mức đang
    // chọn. Chưa xác minh (sau một lần Áp dụng lỗi) thì cho áp dụng lại cùng mức.
    let powerControl = null;
    const pc = s.powerChoice;
    if (pc && (connection === "connected" || connection === "waiting_clear" || connection === "paused")) {
      if (pc.ok) {
        const value = Math.min(pc.max, Math.max(pc.min, Number.isInteger(s.powerDraft) ? s.powerDraft : pc.base));
        // Các cổng lệch mức (current null): hiện mức từng cổng; mức chung nào cũng là thay đổi nên được Áp dụng.
        const now = pc.current !== null ? String(pc.current) : pc.levels.map((l) => "cổng " + l.antenna + " = " + l.dbm).join(", ");
        powerControl = {
          label: "Mức mới cho cổng " + pc.ports.join(", ") + ":",
          value,
          canDec: !busy && value > pc.min,
          canInc: !busy && value < pc.max,
          canApply: !busy && (value !== pc.current || s.paused === "unverified"),
          hint: "Hiện tại " + now + " · lần này tối đa " + pc.max + ". Trong lúc áp dụng RFID tạm dừng, không thêm hàng.",
        };
      } else {
        powerControl = {
          label: null,
          hint:
            pc.reason === "no_port"
              ? "Đặt một sản phẩm có tem lên reader để xác định cổng anten đang dùng, rồi mới áp dụng công suất được."
              : "Chưa đọc được công suất reader nên chưa áp dụng công suất được.",
        };
      }
    }
    return {
      visible: !!s.onSaleRoute,
      state: processing ? "processing" : result !== "none" ? result : connection,
      connection,
      operation,
      result,
      status: { icon: statusIcon, label: statusLabel, spinning: processing || connection === "connecting" || connection === "handover" },
      resultIcon: RESULT_ICON[result] || null,
      headline,
      message,
      detail,
      actions,
      canConnect,
      canDisconnect,
      canSendSample,
      canRetry,
      canReadd,
      canArm,
      canTakeover,
      actionHint: canReadd ? "Chỉ dùng sau khi đã xoá sản phẩm này khỏi đơn trên POS." : null,
      badCrc,
      crcText: badCrc ? badCrc + " frame sai checksum đã bỏ qua" : null,
      // A1: dòng công suất đọc lúc kết nối (rfid-protocol powerText) — chỉ khi reader đang mở ở tab này.
      powerText: (connection === "connected" || connection === "waiting_clear" || connection === "paused") && s.powerText ? String(s.powerText) : null,
      powerControl,
      tagList, // v0.8.0.2: CORE.tagListView của đơn đang mở (null = chưa có tem nào)
    };
  }

  // ---------- Khoá chống thêm trùng ----------
  function tagKey(orderId, epc) {
    return String(orderId).toLowerCase() + "|" + normalizeEpc(epc);
  }

  // ---------- v0.7 Batch B: một reader, nhiều tab — trọng tài ở worker ----------
  // Hàm THUẦN: worker gọi brokerStep(state, event) cho mọi sự kiện (tab nối vào, xin quyền, nhả, nhịp, mất kết nối, Ngắt
  // chung, tick) rồi làm đúng các việc trong kết quả (gửi message tới tab, gửi trạng thái cho mọi tab, LƯU / XOÁ cờ Ngắt).
  // Bất biến: tại mọi thời điểm TỐI ĐA MỘT tab là chủ reader. Tab chủ nhả xong (hoặc chết / hết lease) thì mới có chủ mới.
  //   state = { owner: null | { tabId, beatAt }, lastOwnerTabId, pending: null | { tabId, at }, off, offSaved }
  //   owner.beatAt: nhịp gần nhất của tab chủ; quá BROKER_LEASE_MS không có nhịp → mất quyền (tab treo / mất kết nối ngầm).
  //   lastOwnerTabId: chủ gần nhất đã rời — tab nhận quyền SAU một chủ khác phải vào "chờ reader trống" (takeover).
  //   pending: tab đã bấm "Dùng RFID ở tab này", đang chờ chủ hiện tại nhả.
  //   off: cờ "Ngắt kết nối toàn bộ tab" — true | false | null (null = worker CHƯA đọc được cờ đã lưu). Chỉ off === false mới
  //     được cấp quyền; true và null đều chặn (fail-closed). offSaved: cờ true đã ghi xong vào chrome.storage.local.
  // Audit Batch B (P1): "đã ngắt toàn bộ tab" chỉ được báo SAU khi cờ đã lưu (event "off" → worker ghi → "offSaved" → ACK;
  // ghi lỗi → "offFailed" → ACK lỗi, cờ vẫn chặn trong bộ nhớ); bật lại chỉ SAU khi cờ đã xoá (claim "user" khi off !== false
  // → kết quả clearOff → worker xoá → "offCleared" → worker gửi lại chính claim đó); "resume" cũng bị cờ chặn.
  // Kiểu xin quyền: "auto" (tự kết nối lúc mở trang / quay lại tab / cắm reader — KHÔNG bao giờ lấy quyền của tab khác),
  // "user" (người dùng bấm Kết nối RFID / Dùng RFID ở tab này — xin bàn giao nếu tab khác đang giữ), "resume" (tab ĐANG mở
  // reader nối lại sau khi worker khởi động lại — nó đang thật sự giữ cổng).
  const BROKER_PORT = "circa-rfid-broker";
  const BROKER_BEAT_MS = 5000;
  const BROKER_LEASE_MS = 15000;
  const BROKER_RELEASE_TIMEOUT_MS = 15000;
  const BROKER_SESSION_KEY = "rfid:broker";
  const BROKER_OFF_KEY = "rfidDisconnected";

  const offValue = (v) => (v === true ? true : v === false ? false : null);

  // Worker khởi động (lại): chủ đã lưu được coi như vừa có nhịp lúc nowMs — cho tab đó một lease để nối lại ("resume");
  // không nối lại kịp thì hết lease như thường. off: true (cờ có trong storage) | false (không có) | null (đọc lỗi).
  function brokerInit(saved, off, nowMs) {
    const s = saved && typeof saved === "object" ? saved : {};
    const tab = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
    const ownerTab = tab(s.ownerTabId);
    const o = offValue(off);
    return {
      owner: ownerTab === null ? null : { tabId: ownerTab, beatAt: Number(nowMs) || 0 },
      lastOwnerTabId: tab(s.lastOwnerTabId),
      pending: null,
      off: o,
      offSaved: o === true,
    };
  }

  // Phần cần lưu để worker khởi động lại vẫn biết ai đang giữ reader (chrome.storage.session).
  function brokerSaved(state) {
    return { ownerTabId: state.owner ? state.owner.tabId : null, lastOwnerTabId: state.lastOwnerTabId };
  }

  // Góc nhìn của một tab. off chỉ true khi cờ ĐÃ LƯU (không bao giờ báo "đã ngắt toàn bộ tab" khi chưa lưu được);
  // offUnknown: worker chưa đọc được cờ — tab không tự kết nối, chờ người dùng bấm Kết nối RFID.
  function brokerViewFor(state, tabId) {
    return {
      t: "state",
      owner: !state.owner ? "none" : state.owner.tabId === tabId ? "self" : "other",
      off: state.off === true && state.offSaved === true,
      offUnknown: state.off === null,
      waiting: !!(state.pending && state.pending.tabId === tabId),
    };
  }

  function brokerStep(state, ev) {
    const s = {
      owner: state.owner ? { tabId: state.owner.tabId, beatAt: state.owner.beatAt } : null,
      lastOwnerTabId: state.lastOwnerTabId,
      pending: state.pending ? { tabId: state.pending.tabId, at: state.pending.at } : null,
      off: offValue(state.off),
      offSaved: state.offSaved === true,
    };
    const sends = [];
    let broadcast = false;
    let persistOff = false;
    let clearOff = false;
    const now = Number(ev && ev.now) || 0;
    const tabId = ev && Number.isInteger(ev.tabId) ? ev.tabId : null;
    const blockedReason = () => (s.off === null ? "off_unknown" : "off");
    const grant = (id) => {
      const takeover = s.lastOwnerTabId !== null && s.lastOwnerTabId !== id;
      s.owner = { tabId: id, beatAt: now };
      sends.push({ tabId: id, msg: { t: "granted", takeover } });
      broadcast = true;
    };
    // Chủ rời đi (nhả / chết / hết lease): ghi nhớ để chủ kế tiếp chờ reader trống; có tab đang chờ thì giao luôn — trừ khi
    // đang bị Ngắt (hoặc chưa đọc được cờ Ngắt).
    const vacate = () => {
      s.lastOwnerTabId = s.owner.tabId;
      s.owner = null;
      broadcast = true;
      if (s.pending) {
        const next = s.pending.tabId;
        s.pending = null;
        if (s.off === false) grant(next);
        else sends.push({ tabId: next, msg: { t: "denied", reason: blockedReason() } });
      }
    };
    const expire = () => {
      if (s.owner && now - s.owner.beatAt > BROKER_LEASE_MS) vacate();
      if (s.pending && now - s.pending.at > BROKER_RELEASE_TIMEOUT_MS) {
        sends.push({ tabId: s.pending.tabId, msg: { t: "denied", reason: "release_timeout" } });
        s.pending = null;
        broadcast = true;
      }
    };
    switch (ev && ev.type) {
      case "claim": {
        if (tabId === null) break;
        expire();
        const mode = ev.mode === "user" || ev.mode === "resume" ? ev.mode : "auto";
        if (s.off !== false) {
          // Người dùng bấm Kết nối: worker phải XOÁ cờ đã lưu TRƯỚC (clearOff → offCleared), rồi mới xét lại claim này.
          // Tự xin và "resume" (kể cả tab đang mở cổng): bị chặn — tab resume phải đóng reader của nó.
          if (mode === "user") clearOff = true;
          else sends.push({ tabId, msg: { t: "denied", reason: blockedReason() } });
          break;
        }
        if (mode === "resume") {
          // Tab này đang THẬT SỰ mở cổng: nó là chủ, kể cả khi bản lưu nói khác (chỉ một nơi mở được cổng serial).
          if (!s.owner || s.owner.tabId !== tabId) {
            s.owner = { tabId, beatAt: now };
            broadcast = true;
          } else s.owner.beatAt = now;
          sends.push({ tabId, msg: { t: "granted", takeover: false, resumed: true } });
          break;
        }
        if (!s.owner) {
          if (s.pending && s.pending.tabId !== tabId && mode === "auto") {
            sends.push({ tabId, msg: { t: "denied", reason: "busy" } });
            break;
          }
          if (s.pending && s.pending.tabId === tabId) s.pending = null;
          grant(tabId);
          break;
        }
        if (s.owner.tabId === tabId) {
          s.owner.beatAt = now;
          sends.push({ tabId, msg: { t: "granted", takeover: false } });
          break;
        }
        if (mode === "auto") {
          sends.push({ tabId, msg: { t: "denied", reason: "busy" } });
          break;
        }
        // Người dùng xin bàn giao: báo tab chủ nhả; tab xin chờ. Tab khác đang chờ thì nhường cho lần bấm mới nhất.
        // Chủ chỉ được yêu cầu nhả MỘT lần cho mỗi đợt chờ (đã có tab chờ nghĩa là đã yêu cầu rồi).
        const asked = !!s.pending;
        if (s.pending && s.pending.tabId !== tabId) sends.push({ tabId: s.pending.tabId, msg: { t: "denied", reason: "superseded" } });
        const already = !!(s.pending && s.pending.tabId === tabId);
        s.pending = { tabId, at: already ? s.pending.at : now };
        if (!asked) sends.push({ tabId: s.owner.tabId, msg: { t: "release" } });
        sends.push({ tabId, msg: { t: "waiting" } });
        broadcast = true;
        break;
      }
      case "released":
      case "gone": {
        if (tabId === null) break;
        if (s.pending && s.pending.tabId === tabId) {
          s.pending = null;
          broadcast = true;
        }
        if (s.owner && s.owner.tabId === tabId) vacate();
        break;
      }
      case "beat": {
        if (tabId !== null && s.owner && s.owner.tabId === tabId) s.owner.beatAt = now;
        expire();
        break;
      }
      case "off": {
        // Chặn cấp quyền NGAY trong bộ nhớ; chỉ báo "đã ngắt toàn bộ tab" khi worker ghi cờ xong (offSaved).
        if (s.pending) {
          sends.push({ tabId: s.pending.tabId, msg: { t: "denied", reason: "off" } });
          s.pending = null;
          broadcast = true;
        }
        if (s.off === true && s.offSaved) {
          if (tabId !== null) sends.push({ tabId, msg: { t: "offAck", ok: true } }); // đã lưu từ trước: xác nhận ngay
        } else {
          s.off = true;
          s.offSaved = false;
          persistOff = true;
        }
        break;
      }
      case "offSaved": {
        if (s.off === true && !s.offSaved) {
          s.offSaved = true;
          broadcast = true;
        }
        if (tabId !== null) sends.push({ tabId, msg: { t: "offAck", ok: s.off === true && s.offSaved } });
        break;
      }
      case "offFailed": {
        // Ghi cờ lỗi: vẫn chặn trong bộ nhớ (fail-closed), tab bấm Ngắt nhận ACK lỗi để báo đúng và thử lại.
        if (tabId !== null) sends.push({ tabId, msg: { t: "offAck", ok: false, error: String(ev.error || "ghi storage lỗi") } });
        break;
      }
      case "offCleared": {
        if (s.off !== false) {
          s.off = false;
          s.offSaved = false;
          broadcast = true;
        }
        break;
      }
      case "offLoaded": {
        // Worker đọc lại cờ (lần trước đọc lỗi). Chỉ nhận khi đang "chưa biết": không đè một lệnh Ngắt / bật lại vừa xảy ra.
        const o = offValue(ev.off);
        if (s.off === null && o !== null) {
          s.off = o;
          s.offSaved = o === true;
          broadcast = true;
        }
        break;
      }
      case "tick": {
        expire();
        break;
      }
      default:
        break;
    }
    return { state: s, sends, broadcast, persistOff, clearOff };
  }

  return {
    UUID_RE,
    saleOrderIdFromPath,
    crc16Ccitt,
    nationFrame,
    startInventoryFrame,
    stopInventoryFrame,
    takeFrames,
    normalizeEpc,
    parseInventoryFrame,
    NEXTWAVES_SALE_ELIGIBILITY_URL,
    ELIGIBILITY_ERRORS,
    parseSaleEligibilityResponse,
    qrTextForUid,
    NEXTWAVES_BY_UID_URL,
    NEXTWAVES_NOTIFY_URL,
    NEXTWAVES_NOTIFY_EPC_URL,
    NEXTWAVES_TAG_URL,
    NEXTWAVES_ORDERS_SYNC_URL,
    BY_UID_ERRORS,
    strictEpc, // 0.6: core.normalizeEpcStrict là bản sao của hàm này; test đối chứng hai bộ không trôi lệch
    parseByUidResponse,
    byUidVerdict,
    attemptMappingPatch,
    blockedTagResult,
    AUTO_ARM_GAP_MS,
    AUTO_ARM_MIN_RETRY_MS,
    autoArmDecision,
    autoArmDelayMs,
    autoArmRetryMs,
    NEXTWAVES_GENERATION_URL,
    GENERATION_NOT_FOUND,
    GENERATION_ERRORS,
    RESOLVED_CHILDREN_LIMIT,
    parseGenerationResponse,
    resolvedChildrenJson,
    generationVerdict,
    outcomeToResult,
    attemptTiming,
    scanTicksForText,
    scanDelivery,
    zeroKeyRetryable,
    TAG_STATE_LABELS,
    tagStateFromMark,
    ATTN_STATES,
    ATTN_MAX_TAGS,
    cleanAttnEntry,
    attnEntryValid,
    attnTagsOf,
    attnToMark,
    mergeTagMark,
    attnTransition,
    attnApply,
    tagListView,
    TAG_ATTENTION,
    summarizePosLookup,
    lastPathSegment,
    normalizeText,
    parseQuantity,
    rowIsProduct,
    cartAddedOne,
    buildView,
    tagKey,
    BROKER_PORT,
    BROKER_BEAT_MS,
    BROKER_LEASE_MS,
    BROKER_RELEASE_TIMEOUT_MS,
    BROKER_SESSION_KEY,
    BROKER_OFF_KEY,
    brokerInit,
    brokerSaved,
    brokerViewFor,
    brokerStep,
  };
});
