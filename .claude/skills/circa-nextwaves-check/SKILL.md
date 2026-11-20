---
name: circa-nextwaves-check
description: Tra cứu & đối soát trừ tồn Circa POS ↔ Nextwaves (RFID) cho cửa hàng Florita / Lumina. Dùng khi user hỏi "check mã/UID/QR/tem này", "tra EPC", "tem gốc / tem gen có map EPC không", "vì sao đơn DHC… không tự trừ tồn", "tồn Nextwaves lệch tồn POS / tồn vật lý", "đơn online đã trừ chưa", "trừ tồn bù / xuất đơn này", hoặc gửi export qr-scan-log / net-capture POS để kiểm tra.
---

# Circa POS ↔ Nextwaves: tra cứu & trừ tồn bù

Mặc định chỉ ĐỌC. Mọi thao tác GHI (notify, phiếu xuất, sửa thẻ) chỉ làm khi user yêu cầu rõ trong chat và đã nêu đích danh đơn/EPC/số lượng (xem §6).

## 1. Hằng số
| | Florita | Lumina |
|---|---|---|
| Nextwaves warehouseId | `eb5e2b4f-6f92-413b-90ef-6be1730b94c0` | `3f7bd541-7370-4ce0-9048-231cf061e91a` |
| POS store (x-store-id) | `c476efb2-415c-429a-978e-d389b4b06607` | `31493e74-3404-4c0e-a906-93691a6ee319` |
| Mã phiếu NW | `FLOR/IN/…`, `FLOR/OUT/…` | `31493E74-3404-4C0E-A906-/IN/…` |

- Nextwaves public API: `https://api-circa.nextwaves.app/api/v1/public` (tenant circa; OpenAPI `/api/public-docs-json`).
- Circa POS API: `https://api.v2.circa.vn` — cần header `authorization: Bearer <POS_TOKEN>`, `x-circa-app: pos`, `x-client-id: 1`, `x-store-id: <store>`, `origin/referer: https://pos.v2.circa.vn`, và user-agent trình duyệt (thiếu UA → bị chặn).
- Khoá: env `NW_KEY` (khoá Florita `nwc_pk_4a56…` hoặc khoá "LUMINA" `nwc_pk_e22a866d…`; cả hai thấy cả 2 kho) và `POS_TOKEN` (JWT phiên POS user dán). **Không bao giờ ghi khoá ra file / log / memory.** Lấy khoá từ chat của phiên hiện tại ngay trong từng lệnh (grep transcript `.jsonl` của phiên) hoặc nhờ user dán lại. Không dùng JWT admin Nextwaves.
- Script nằm ở `scripts/` cạnh file này. Chạy bằng `node <path>` với cwd = `work/<việc>/` của project (file record/output ghi vào cwd; record GHI chép thêm vào `records/nw-writes/`).

## 2. Endpoint hay dùng
Nextwaves (đọc):
- `GET /tags/by-uid/{uid}` → `{mapped, epc, status}`; `POST /tags/by-uid/batch {uids:[…]}` (đọc, ≤30 UID).
- `GET /printing/labels/generations/{code}` → `source, generationId, parentQr, state, children[{unitUid,mapped,epc,tagStatus,warehouseId}]`. Từ 12/11/2026 có 2 loại theo trường `source`:
  - `source:"label_print"`: lần in qua Nextwaves. `state:"generated"`, có `generationId`. Tem con thì mã trần được. Tem gốc PHẢI có tên miền (`thuocsi.vn/qr/<uid>` hoặc `qr.v2.circa.vn/item/<uid>`, có/không https; URL-encode `/`); mã trần tem gốc → 404.
  - `source:"tags"`: dựng từ `parentUid` ghi trên thẻ lúc nhập kho, áp dụng cả tem in ngoài Nextwaves như Lumina. `state:"tagged"`, `generationId:""`, `parentQr` = UID trần, `printJobId:""`. Mã trần hay mọi dạng có tên miền đều ra.
  - 404 `CIRCA_LABEL_GENERATION_NOT_FOUND` = không có cả hai. Không có endpoint tra theo generationId.
  - **Agent ≤ 0.9.9.2 không nhận dạng `source:"tags"`**: `parseGenerationResponse` bắt buộc `state === "generated"` và `generationId` khác rỗng → báo lỗi hợp đồng `contract:state`, giữ đơn chờ người kiểm, không tự trừ. Cần đội extension sửa.
- `GET /tags/{epc}/check?warehouseId=` có thêm `parentUid` (tem gốc ghi lúc nhập; `null` nếu thẻ gắn thẳng hoặc in qua label_print). Purchase order `receivedUnits[]` cũng có `parentUid`.
- `GET /printing/labels/jobs?page=&pageSize=[&productId=&stationId=&startDate=&endDate=&state=]` (dùng `limit` → 400); `source.circaGenerationId/originalQr/unitUid`. `GET /printing/labels/jobs/{id}`.
- `GET /printing/labels/resolve?code=` ; `GET /integrations/circa/scan/qr?code=<dạng có tên miền>&warehouseId=`.
- `GET /integrations/circa/epcs/{epc}` (góc nhìn Circa: status, warehouseId, baseQuantity, unit×ratio, unitUid, circaProductId).
- `GET /tags/{epc}`, `/tags/{epc}/passport` (movements, lifecycle, order), `/tags/{epc}/check?warehouseId=`.
- `GET /tags?search=<EPC|đoạn EPC>&pageSize=` (toàn tenant, mọi trạng thái; `?epc=`/`?q=` bị bỏ qua).
- `GET /orders/{DHC}` (hoặc `CIR-{DHC}`) → 404 `ORDER_NOT_FOUND` = chưa trừ.
- `GET /products/by-external/{circaProductId}`, `/stock/inventory-position?productId=&warehouseId=`, `/stock-in/receipts/{ref}?actionType=stock_in`.
  - `by-external` nhận số trần (`1467`). Dạng `CIRCA-1467` trả 404.
  - `GET /stock/summary?productId=&warehouseId=` trả `{systemStock, rfidStock, untaggedStock, discrepancy}`. `rfidStock` là tổng đơn vị cơ sở trên các thẻ active, không phải số thẻ.
  - `/stock/levels?productIds=&warehouseIds=` và `/stock/system` cũng dùng được.
  - OpenAPI đầy đủ có ở `https://api-circa.nextwaves.app/api/docs-json` (1.152 path).
  - `/tags` BỎ QUA mọi bộ lọc trừ `search`. `/stock/rfid/…` và `/stock/epc-breakdown/…` không nhận public key (401).
  - **Đếm số thẻ EPC của sản phẩm trong kho:** đọc ledger theo productId và warehouseId, chia đều `quantity` cho các EPC của từng dòng, thẻ có số dư > 0 là còn tồn. Đối chiếu tổng với `rfidStock`.
  - Đã kiểm đúng trên 7 sản phẩm ngày 16/11/2026. Code: `node scripts/epc-stock.js <circaId> <wh> [--epcs] [--verify]`.
- `GET /stock/ledger?productId=&warehouseId=&limit=200&afterLedgerNumber=<n>`: **`offset`/`page` bị BỎ QUA**, lúc nào cũng trả 200 dòng mới nhất. Lật trang bằng con trỏ `afterLedgerNumber` (tăng dần, lấy `ledgerNumber` lớn nhất của trang trước). Phát hiện 12/11/2026, đã sửa trong store-pending, tag-hist, prod-tags. Kiểm tra: tổng `quantity` của ledger kho = `inventory-position.totalStock` (Lumina 12/11: 399 dòng = 19.469).

Circa POS (đọc):
- Danh sách đơn: `GET /v1/pos/<store>/order?page=&limit=100&query=status=COMPLETED,completed_time_from=<ISO>,completed_time_to=<ISO>` (filter nằm TRONG `query=`, nối dấu phẩy). Tìm 1 đơn: `query=code=DHC…`. Status khác: `PENDING, SHIPPING, AWAITING_SHIPMENT, READY_TO_PICK, WAITING_STOCK, OUT_OF_STOCK, CANCELED` (response có `total_pending/shipping/...`). Danh sách KHÔNG kèm items. **Thứ tự trả về KHÔNG ổn định**: lật nhiều trang sẽ sót hoặc trùng đơn (12/11: trang 20 bắt đầu 10/11, trang 24 lại là 26/10). Luôn dùng `scripts/pos-orders.js` `listCompleted()`, hàm này chia khung giờ sao cho mỗi khung ≤ 1 trang theo `total`, không lật trang.
- Chi tiết đơn: `GET /v1/order/<uuid>?get_rating=true` → `data.order.items[]` {product_id, quantity, unit, base_quantity, lot_date, qr_codes[]}; `type` OFFLINE/ONLINE, `source_type` POS/O2O.
- Tra mã QR: `GET /v1/pos/<store>/qr/<uid>` → sản phẩm, lô, `lot_detail`. Tồn thật theo lô = `lot_detail.simplify_location_details[].on_hand_qty` (location "General"); `lot_detail.on_hand_qty` thường = 0; `lot_detail: null` = cửa hàng không còn lô đó.
- Tồn theo sản phẩm (trang "Danh sách tồn kho"): `GET /v1/inventory/admin/stock/search?query=keyword=<productId>,pos_id=<store>,include_negative_qty=true,&limit=20&page=1&is_count_status=true` → `data.list[]`. Mỗi SKU/seller là **một dòng riêng**: dòng marketplace (`CIRCA_MKP`, `VLQEM8DN9F`…) thường = 0, dòng `CIRCA` mới là tồn thật. **Phải CỘNG `on_hand_qty` mọi dòng cùng product_id**, không lấy dòng đầu (lỗi 12/11 làm L'Oréal/Nizoral tưởng POS = 0). `items[].details[]` cho tồn theo lô + `doc_code` (PO).
- Phiên kiểm kê POS (admin `kiem-ke-ton-kho/<id>`, mã ICS…), chỉ đọc, base `/v1/inventory/count`. Header như trang admin: Bearer, `X-Circa-App: admin`, `X-Client-Id: 1`, `x-store-id`:
  - `GET /sessions/<id>`: thông tin phiên (status, counting_mode QR).
  - `/summary`: total_scans, counted_total_qty…
  - `/lines?limit=-1`: 1 dòng/SP·seller, gồm expected_qty và counted_qty (SL gốc). Thêm `query=include_line_details%3Dtrue` để có chi tiết theo lô.
  - **`/scans?limit=1000&offset=N`** → `data.scans[]`: `qr_code` (UID đã quét), product_id, unit_code, conversion_factor, base_qty, lot, po_code, device_id (tên người quét), scanned_at.
  - `/unmatched-scans` → `data.items[]`, key là `items`, không phải `scans`.
  - Script: `scripts/kiem-dem/pos-count-scans.js <id> <store> <outDir>` (env POS_TOKEN), sau đó `ics-scans-xlsx.js` để xuất xlsx theo UID và theo SP.
  - So với phiên RFID: `pos-qr-resolve.js <dir>` (env NW_KEY) tra QR → EPC. Thứ tự tra: by-uid batch, rồi `generations/<uid>`, rồi resolve EPC, ghi ra `qr-epc.json`. Sau đó `pos-qr-vs-rfid.js <dir> <kiem-dem.xlsx> <out>` (offline) xuất các sheet Theo sản phẩm / Từng QR POS / RFID có, POS chưa quét.
    - Phần lớn QR POS là **tem gốc**: `generations` có source tags, parentQr = chính QR đó, và các children là thẻ NW. Một QR hộp có thể ra nhiều EPC, ví dụ hộp Matrix 10 gói ra 10 EPC, thùng Pocari ra 24.
    - Ca 18/11: 357 QR ra 517 EPC (35 qua by-uid, 219 tem gốc, 94 QR chính là EPC, 9 không ra EPC).
    - Biến môi trường tuỳ chọn cho `pos-qr-vs-rfid.js`:
      - `LEDGER` (`fetch-ledger.js`, kéo SAU phiên POS): giờ nhập từng thẻ. Thẻ nhập sau phiên RFID thì không tính là RFID bỏ sót. Lưu ý: tem đã dán trước khi stock-in vẫn được RFID đọc, và nằm ở "Không nhận ra mã".
      - `SOLD` (`pos-sold-window.js <from> <to>`): đơn POS trong khoảng giữa 2 phiên, QR ra EPC. Thẻ RFID có mà POS không có, nếu đã bán thì ghi kèm mã đơn.
      - `RFID2`: thêm cột kết quả của phiên RFID sau, cho từng EPC.
    - Thẻ RFID đọc được nhưng không thuộc QR POS nào: trước hết trừ phần POS đếm qua QR lốc/hộp ngoài. Ví dụ QR lốc 12 tuýp chỉ nối 1 thẻ con. Lấy `base_qty` trừ số lượng trên thẻ của QR đó.
    - So với phiên 18:07 (danh sách tải 15:45): RFID đọc 448/517 (87%). Theo SP: 35 khớp từng thẻ, 15 khớp số lượng, 47 lệch. 69 thẻ POS thấy mà RFID không đọc; 23 thẻ RFID đọc mà POS chưa quét QR.
    - Phiên RFID 22:48 chỉ đọc được 21% số thẻ mà POS QR đã chứng minh có trên kệ. Tỉ lệ đọc thấp ở mọi cuộn (cả phiên chỉ đọc 33–45% thẻ trong danh sách), nên đây là quét RFID chưa phủ hết, không phải lỗi một cuộn thẻ.
  - Ca ICS00237 (Lumina, 18/11): `qr_code` có 2 dạng. Một là UID Buymed `\d{13}[A-Z]\d*`. Hai là mã 24 hex dạng EPC (in trên tem NW), cả 94 mã này đều có trong sổ kho NW và đúng SP.
- Đơn ONLINE chưa giao (AWAITING_SHIPMENT/SHIPPING) đã bị POS trừ `on_hand` nhưng chưa trừ Nextwaves → hiện thành "NW > POS". Lô của QR: `GET /v1/pos/<store>/qr/<uid>` → `lot_detail.simplify_location_details` theo phiếu PO của chính QR đó: = 0 nghĩa là hàng của phiếu đó đã ra khỏi kệ (dùng để chọn đúng thẻ, VD A.T 12/11: 10 thẻ /IN/00017 → 0).

## 3. Playbook

### P1. "Mã/UID này có ra EPC không?"
Nhanh nhất: `node scripts/parent-check.js <mã…> [--epc=…]` (by-uid + generations ở mọi dạng + `source` + `parentUid` của thẻ). Đối soát cả cửa hàng: `node scripts/store-retest.js <fromISO> [toISO] [seed-lines.json]` (env POS_STORE/WH/OUT): dò lại mọi mã đã bán, liệt kê dòng nay đã ra EPC, kèm trạng thái thẻ và đơn trên Nextwaves.
Chi tiết hơn: `node scripts/uid-check.js <UID>` (by-uid, generations, resolve, tags search, POS qr cả 2 store). Nếu chưa map: thử thêm generations với 4 dạng có tên miền (tem gốc). 13 chữ số đầu UID = thời điểm tạo mã (ms). Kết luận theo bảng: map trực tiếp → EPC; qua generation (tem con → parentQr → by-uid parent, hoặc parent → children) → EPC; không có cả hai → KHÔNG ra EPC, Agent sẽ không trừ.
Nếu không ra: `node scripts/prod-tags.js <circaProductId> <UID>` để xem sản phẩm có những thẻ nào (UID, lô POS, đang giữ) — thường tìm được thẻ "anh em" cùng lô mà user có thể đối chiếu trên hộp.

### P2. "Kiểm tra thẻ EPC này"
`node scripts/epc-check.js <EPC>`; lịch sử + bán hàng của sản phẩm: `node scripts/tag-hist.js <EPC> <posStore> <wh> <circaId> <fromISO> [qr…]` (chậm: mở từng đơn — chạy nền). EPC không có trên `/tags?search=` = chưa đăng ký.

### P3. "Tồn POS sản phẩm X = 0 (hoặc thấp) mà Nextwaves vẫn còn thẻ"
1. `node scripts/prod-tags.js <productId>` → thẻ active, UID, lô.
2. Đơn đang mở: `node scripts/open-orders.js <productId>` (SHIPPING/READY_TO_PICK/... — đơn online chưa giao chưa bị trừ là bình thường).
3. Đơn đã hoàn tất bị Agent giữ: grep export Agent mới nhất (`Downloads/qr-scan-log_tat-ca_*.json`) theo UID/EPC/SKU (`CIRCA.<code>`) → đọc `reasons` / `state` (bảng §4).
4. Không thấy trong export: quét POS completed từ ngày nhập thẻ bằng `tag-hist.js` (chạy nền).
5. `node scripts/order-check.js <DHC> <store> [EPC…]` → dòng POS (QR, lô), đơn NW, trạng thái từng EPC.

### P3b. "Từ ngày X đến nay có bao nhiêu đơn cần trừ?" (đối soát đầy đủ 1 cửa hàng)
`node scripts/store-pending.js <fromISO> [toISO]`. Env: NW_KEY, POS_TOKEN, POS_STORE, WH, OUT, và OVERRIDES (tuỳ chọn) dạng `{"DHC…":{"uids":["<QR user xác nhận>"]}}`. Script chạy nền khoảng 4 phút. Từng dòng bán POS, sau khi trừ phần đơn NW đã trừ, được xếp vào một nhóm:
- `TRU_DUOC`: QR ra thẻ active ở kho, đúng sản phẩm, còn lượng. Script ghi `<OUT>-<DHC>.payload.json` cho các dòng này.
- `TRU_DUOC_MOT_PHAN`: chỉ trừ được một phần dòng.
- `CAN_KIEM`: QR không ra thẻ, nhưng sản phẩm còn thẻ active in trước lúc bán, VÀ (tồn NW − sắp trừ) > tồn POS.
- `IT_KHA_NANG`: giống `CAN_KIEM`, nhưng NW − sắp trừ ≤ POS.
- `KHONG_CO_THE`: mọi thẻ active của sản phẩm đều in sau lúc bán. Thời điểm in = 13 chữ số đầu của UID tem, tính bằng ms.
- `KHONG_QUAN_LY`: sản phẩm chưa từng nhập kho NW.

Script cũng xuất `<OUT>-gap.csv`: tồn NW, số sắp trừ, tồn POS và độ lệch, theo từng sản phẩm.

Cách đọc kết quả:
- Ở các dòng QR không ra thẻ, QR đã quét gần như luôn là hộp KHÁC thẻ. Lý do: thẻ có `parentUid` (tem gốc) khác QR đó, hoặc lô khác, hoặc bán lẻ từ một hộp đã mở như Gofen `…C377`.
- Cột "NW − sắp trừ − POS" là bằng chứng mạnh nhất. Ví dụ Lumina 12/11: Fugacar 18 − 3 − 13 = 2, đúng bằng 2 hộp chưa trừ của DHC01349878.
- Sản phẩm có NW > POS mà không có đơn bán là lệch do nhập kho, không phải do đơn. Ví dụ: Healthy Life Pros 120/0, Clotrimazol 10/0, Eucatana 300/200.
- Sau đó dry-run từng payload bằng `notify-resend.js` (env WH), rồi trình user duyệt.
- **Không chạy song song với lệnh Nextwaves khác.** Nextwaves trả 429 khi bị gọi dồn. Script đã tự thử lại các EPC, mã QR và đơn bị lỗi, nhưng nếu output in "CẢNH BÁO … tra không được" thì kết quả có thể thiếu, cần chạy lại. Lỗi này từng làm sai số tồn NW 12/11: 24–48 EPC bị "?".
- Đơn NW nhiều dòng có `productSku: null`. Script xác định dòng đã trừ qua `tagEpc` / `productId` của dòng đó.

### P4. "Vì sao đơn DHC… không tự trừ?"
`order-check.js` + export Agent. Nguyên nhân hay gặp:
- Thu ngân quét tem không gắn chip (tem Buymed/thuocsi) và không có bản gen → `kind:"none"`.
- Tem gen in NGOÀI Nextwaves (Lumina) → quét tem gốc không bao giờ ra EPC; phải quét tem RFID.
- Dòng bán nhiều hơn thẻ đã quét giữ (`tag_short`) → cả đơn bị giữ.
- Agent dùng sai kho / thiếu warehouseId (đơn trước 10/11 15:00).
- Đơn trước 02/11 chưa bật auto-send → user xử lý tay.

### P5. Đơn ONLINE (O2O)
Agent chỉ trừ khi đơn giao xong. Thẻ Agent hiển thị: `ONLINE · đóng gói <t> · giao xong <t> · cập nhật <t>`, payload, "Từng dòng". Ví dụ DHC01343236: đóng gói 09/11 20:29, giao xong 11/11 17:59, NW `CIR-DHC01343236` tạo 18:06 (DONE, 3 EPC sold). Dòng Kamistad 4 hộp: 2 QR có chip → trừ 2 tuýp; 2 QR "đã tra mã gốc / tem con: không chip" → KHÔNG trừ → kiểm thẻ còn dư bằng `prod-tags.js <productId>` + tồn POS. Kết quả 12/11: Kamistad (1775) Florita chỉ từng có 2 thẻ (nhập 22/10, đều đã sold bởi đơn này); 2 tuýp kia (tem Buymed `…B558` 08/09, `…B5219` 18/09) chưa bao giờ gắn thẻ → NW 0 = POS 0, không cần trừ thêm. Tức là "không chip" thường nghĩa là hàng chưa từng lên Nextwaves, không phải thẻ bị sót.

### P6. Trừ tồn bù (GHI — chỉ khi user yêu cầu rõ)
- Đơn chưa có trên NW: viết payload `{"orderId":"DHC…","warehouseId":"<wh>","tags":[{"epc":"…","quantity":<base>}]}` → `node scripts/notify-resend.js <payload> --dry` → báo user → chạy thật. Env `WH` cho Lumina, `KEY_TAG` cho idempotency key. Script tự kiểm: đơn chưa có (404), EPC active, đúng kho, đủ lượng; ghi record trước khi POST.
- Bổ sung EPC thiếu vào đơn đã có: `ADD_TO_EXISTING=1 node scripts/notify-resend.js …` (NW thêm dòng, không trừ lại dòng cũ).
- Trừ lẻ / không gắn với đơn: `node scripts/so-epc.js <EPC> <QTY> "<lý do>" [--dry] [--wh=<wh>]` (phiếu stock_out DRAFT→complete).
- notify: 400 là nguyên tử (không trừ gì); 201 kiểm `GET /orders/` + trạng thái EPC sau gửi.
- Nếu auto-mode chặn lệnh ghi: dừng, báo user lệnh định chạy + payload, để user tự duyệt.

### P7. Tem gốc ↔ tem gen
Florita in tem qua Nextwaves → `generations` (`source:"label_print"`) có `parentQr` → quét tem gốc hay tem gen đều trừ được (`via:"goc"`). Lumina in tem `…C11/B71` ngoài Nextwaves; từ 12/11 Nextwaves ghi `parentUid` lên thẻ nên `generations` trả `source:"tags"` → API đã lần được tem gốc → EPC (Telfast `…C1133`→`…EF03A71B`, Dầu cá `…B715`→`…EB04A718`, Cephalexin `…C1215`→`…702AC4FA`). Tem gốc nào chưa có thẻ ghi `parentUid` vẫn 404 (ví dụ Kẽm `1794188251768Y21`). Agent phải được sửa để nhận `source:"tags"` thì mới tự trừ.

## 4. Mã lý do trong export Agent (v0.9.x)
| Mã / state | Nghĩa |
|---|---|
| `tag_short` | Thẻ đã quét giữ ít hơn số lượng dòng ("cần N / tem còn M") |
| `all_lines_held` | Mọi dòng có RFID đều bị giữ → đơn không gửi |
| `state: blocked`, "Cần kiểm tra — không gửi", `lineStatus v09_manual` | Agent sẽ không tự gửi; phải xử lý tay |
| `preview.links[].kind:"link", via:"goc"` | Tem con → EPC của tem gốc |
| `kind:"hold", code:"link_multi_child"` | Tem gốc có nhiều tem con → giữ |
| `kind:"none"` | Không có liên kết gen |
| `http_400:CIRCA_ORDER_QUANTITY_EXCEEDS_TAG` | NW từ chối (gửi lại để đọc `params.epc`) |
| `qrRaw` với `source:"rfid"` | Do Agent tự dựng `https://qr.v2.circa.vn/item/<uid>`, không phải chữ trên tem |

## 5. Ca đã gặp (tham chiếu nhanh)
- DHC01332160 (Florita, POS-02, 04/11 20:03): OPC 2740 2 chai, chỉ quét 1 QR `1792560926947Y21` (EPC `…AFE6C9D8` giữ 1) → `tag_short` + `all_lines_held` → blocked. NW còn 2 thẻ OPC lô 26034 (`…AFE6C9D8`, `…AFE6C5D8` UID `1792560888717Y21`), POS tồn 0. → 12/11 đã trừ cả 2 thẻ (user xác nhận): `CIR-DHC01332160` DONE, NW OPC = POS = 0. Không gửi lại.
- DHC01348847 (Florita, ONLINE, giao xong 11/11 14:41): Vitamin B1 Đại Y (2008802) 3 chai×100, chỉ quét 2 mã (`1765017184779C3`, `…C6`) → trừ 200, thiếu 100. NW còn 2 thẻ active, POS còn 100 viên → dư đúng 1 thẻ, chưa biết là thẻ nào:
  - chai C9: thẻ ảo (không chip) `1765017184779C06FFFFFFFF`
  - chai C7: tem gen `1792749214175C1` + chip `E280F30200000000EF158B1F`. Bản gen lưu `parentQr` bị gõ sai thành `qr.v2.cỉca.vn/item/…` do máy quét gõ khi đang bật bộ gõ tiếng Việt, nhưng tra theo mã vẫn ra.
  → Phải kiểm vật lý chai còn lại rồi `ADD_TO_EXISTING=1` vào đơn với thẻ của chai đã bán.
- EPC dạng `<UID 13 số>C0x…FFFFFFFF` là thẻ ảo do FLOR/IN/00405 (21/10) tạo từ mã QR, không có chip: đầu đọc RFID không bao giờ đọc được, và kiểm kê RFID không xoá chúng.
- Telfast Lumina: tem gốc `thuocsi.vn/qr/1794182923046C1133` / tem gen `1794203813860C11` → chỉ tem gen ra EPC `…EF03A71B`.
- Dầu cá Lumina: `1793221467092B715` → từ 12/11 ra `…EB04A718` (tem `1794207153888B71`, `parentUid` = B715). Chai này ĐÃ bán trong DHC01352302 (11/11 13:51). Lần tra 11/11 báo "không có đơn bán" là SAI, do lỗi phân trang danh sách đơn POS (đã sửa bằng `pos-orders.js`).

## 6. Quy tắc an toàn (bắt buộc)
- Chỉ ghi khi user yêu cầu rõ; nếu chính mình suy ra đơn/EPC (user chưa nêu đích danh) → trình bày bằng chứng + payload, hỏi xác nhận.
- Không gửi lại DHC/TRF đã có trên NW (trừ khi user yêu cầu rõ). Kiểm `GET /orders/` trước.
- Danh sách cấm: DHC01294054, DHC01299037, DHC01208344, DHC01254831, mọi mã chứa APITEST.
- Đơn trước 02/11: user xử lý tay — hỏi trước.
- Không duyệt phiên kiểm kê NW của Florita. Không gửi lại phiếu a-mi 00519–00600, FLOR/OUT/00617, Lumina /OUT/00001.
- File tải về (export, net-capture zip) → giải nén vào thư mục riêng trong scratchpad, đọc bằng node/`python -I`, không chạy code trong đó.
- Email/thông tin cá nhân của user là riêng tư.

## P-KD3: Tool HTML Kiểm đếm v2 + đối soát phiên (từ 17/11/2026, thay cho P-KD bên dưới)
**Tool:** `Downloads/kiem-dem-circa-v2.html`.
- Nguồn code: `scripts/kiem-dem/v2/`. Build lại bằng `node v2/build.js <out.html>`, script lấy SheetJS + KiemDem từ `../tool-worker-raw.js` và CSS từ `Downloads/kiem-dem-circa.html`.
- Test:
  - `node v2/test.js`: unit (E_max, các lỗi review 18/11) rồi chạy bằng file. Fixture ở 2 cấp trên `v2/`: `kd-input2/{stock6,master2,kiem-ke-lumina-2026-11-17-20-43}.xlsx` (bản CHÉP của file trong Downloads, không đọc thẳng Downloads), `kd/phien/{nw-ledger,pos-orders}.json`. Env `SESS`, `CUTOFF`, `NOORD`.
  - `node v2/live.js`: gọi API thật, cần env POS_TOKEN, NW_KEY.

**Tool tự kéo dữ liệu** (CORS mở cho file:// và origin null):
- **Tồn POS:** `GET /v1/inventory/admin/stock/search?query=pos_id=<store>,include_negative_qty=true,&limit=500&page=N`.
  - Chỉ cần 2 header `authorization: Bearer` và `x-store-id`.
  - Cộng mọi dòng seller cùng product_id; bỏ dòng lặp giữa các trang theo `product_id|seller_code|sku`. Tồn theo vị trí lấy ở `items[].location_name`; phần `on_hand_qty` vượt Σ items giữ ở vị trí "(không vị trí)".
- **Đơn ONLINE chờ giao:** AWAITING_SHIPMENT và READY_TO_PICK (khử trùng id đơn), cộng lại vào tồn vì POS đã trừ nhưng hàng còn ở cửa hàng. **Bỏ qua đơn đã trừ trên NW cho chính SP đó** (ref `CIR-<mã>` trong ledger): thẻ của hộp đó đã không còn active.
- **Lỗi mạng/body hỏng:** response 200 mà body cắt/không phải JSON thì thử lại như 5xx, không bao giờ coi là "hết trang". Một nhánh tải lỗi thì các nhánh khác dừng, kết quả cũ bị ẩn (không trộn 2 lần chạy / 2 cửa hàng).
- **Master từ Google Sheet** `18nLllIlORaki3por1diKzNo2tWvdVyUnB1xbZXDv8Xc`:
  - Gọi `gviz/tq?tqx=out:csv&headers=1&sheet=final data v4&tq=select A,B,C,D,E`, khoảng 10 MB, ~18 s.
  - Tab `Adhoc` lấy cả tab. Tab này đang ẩn và PHẢI đủ cột, vì loader tìm đơn vị in ở cột 4..combine_unit.
  - Nếu sai tên tab, gviz trả về tab ĐẦU TIÊN, nên phải kiểm header.
  - Google đôi khi từ chối/rớt request tạm thời; trình duyệt chỉ báo "Failed to fetch" (trang lỗi của Google không có header CORS). Ca 18/11 ~15:07 trên Lumina: chạy lại ngay thì 200, ACAO `null`, ~7 s. Trang thử lại 4 lần (chờ 3/6/12 s) rồi mới báo lỗi rõ ràng.
  - Ngày 17/11 kết quả khớp 100% file Master (2), gồm 63.996 mã.
- **Thẻ NW:** đọc ledger theo warehouseId (`afterLedgerNumber`). Số thẻ active và cỡ thẻ lúc nhập.

**CÔNG THỨC HIỆN HÀNH (từ 19/11/2026, user: "đừng phức tạp, bỏ các ca adhoc như hộp lẻ"). Phần "Công thức" cũ bên dưới chỉ để tham chiếu lịch sử.**
- **Dự kiến = ⌈Tồn POS ÷ Quy đổi⌉.** Ví dụ 82278: 215 viên, tem dán theo hộp 20 viên → 11.
- Tồn POS = `on_hand` mọi dòng seller và mọi vị trí, bỏ Kho thất lạc, không cộng đơn chờ giao.
  - Phần kéo tồn đúng: `pos-pull-check.js`, 2 lần kéo bằng nhau, khớp trang tồn từng mã.
- Quy đổi = master (`final_unit_print` + rate).
- **Master là chuẩn, mã lệch để riêng:** cỡ thẻ đã nhập NW ≠ master, đơn vị in NW ≠ master, hoặc thiếu master → không vào import, ra file "quy đổi lệch".
- Thẻ NW chỉ dùng để cảnh báo: gắn thêm tem khi E > thẻ, NW dư thẻ khi thẻ > E.
- R2 tạo lại 19/11 00:45: `Downloads/kiem-dem-lumina-R2-20261119-0045.csv` gồm 484 mã, ΣE 2.866. 64 mã lệch nằm ở sheet "Quy đổi lệch (để riêng)" của file `-kiem-tra.xlsx`, ΣE theo master 537.
- Chưa sửa: `phan-tich-kiem-dem.js`, script phân tích phiên cũ, vẫn dùng `need()` khi tính "Dự kiến theo POS".

**Công thức (cũ, đến 18/11):**
- E = số thẻ cần cho tồn POS (mọi vị trí trừ Kho thất lạc): thẻ NW có sẵn, cộng từ thẻ lớn trước, đến khi đủ; nếu cả các thẻ cộng lại chưa đủ thì phần còn lại tính thêm theo cỡ thẻ thường dùng (`need()` trong core.js và phan-tich-kiem-dem.js). **Tồn POS là chuẩn, KHÔNG chặn E theo số thẻ NW** (user 18/11: "tồn POS bắt buộc phải đủ"). Bản cũ chặn E ≤ số thẻ: file 15:14 ngày 18/11 thiếu 569 thẻ ở 126 SP (5977 POS 41 → Dự kiến 1, 399005 POS 49 → 1, 7237 45 → 1), app báo "Khớp" giả cho hàng chưa gắn tem.
- Chưa gắn tem = tồn POS vượt tổng số lượng trên thẻ, quy ra đơn vị in theo master. Vẫn nằm trong E (phiên sẽ báo thiếu nếu chưa gắn tem); danh sách `-chua-gan-tem.csv` để đi gắn tem trước khi mở phiên.
- File import điền sẵn Dự kiến = E. **App GIỮ số này** (xác nhận 18/11 bằng file xuất phiên: cột "Dự kiến" sheet Tổng hợp = E ở 2.438/2.438 SP, "Dự kiến (gốc)" = cột Tồn kho của file, Lệch = Đã đếm − Dự kiến).
- **File xuất phiên Kiểm đếm** (`kiem-dem-YYYYMMDD-HHMM.xlsx`, app điện thoại circa.nextwaves.app), KHÁC dạng file Kiểm kê:
  - `Tổng hợp`: dòng 1–5 là thông tin phiên (Kho, "Tồn hệ thống lúc", So sánh, Tổng); bảng từ dòng 7: SKU, Mã vạch, Mã sản phẩm (CIRCA-…), Tên hàng, Trạng thái, Đơn vị RFID, Quy đổi, Đã đếm, Có thể quét, Dự kiến, Lệch, Số thẻ, Thẻ đã mở, Đơn vị gốc, Đã đếm (gốc), Tồn hệ thống (gốc), Dự kiến (gốc), Lệch (gốc).
  - `Vòng N`: "So với" = Có thể quét (KHÔNG phải Dự kiến), Lệch, Thẻ chưa quét, Dự kiến (gốc).
  - `Chi tiết thẻ` (thẻ đã quét) và `Thẻ chưa quét`: EPC, UID, Số lượng thật, Quy đổi, Tình trạng (Nguyên/Đã mở/Chưa rõ), Vị trí, **Kho**. `Ngoại lệ`: Loại, EPC, Tên hàng, Mã.
- **Đối soát file xuất Kiểm đếm** (chỉ đọc): `PHIEN_DIR=<dir> node scripts/kiem-dem/fetch-phien.js <fromISO>` (ghi vào `<dir>`, KHÔNG đè `phien/` của test), rồi `PHIEN_DIR=<dir> node scripts/kiem-dem/phan-tich-kiem-dem.js <kiem-dem.xlsx> <file import đã nạp.csv> <importISO> <out.xlsx>` (env NW_KEY của kho; env PREV = file xuất phiên trước để so thẻ cần tìm). **User muốn báo cáo theo SẢN PHẨM, không theo thẻ**: sheet đầu `SP chưa quét` (1 dòng/SP: thẻ NW, đã quét, chưa quét chia theo nguyên nhân, dự kiến/thiếu theo POS, vị trí POS, ngày nhập, phiếu nhập, cuộn tem, so phiên trước, đơn bằng chứng, việc cần làm). Sheet khác: Tổng quan, SP theo POS (E thấp/cao/tối đa theo hàng bán + hàng nhập trong lúc kiểm), Thẻ chưa quét (nguyên nhân a–g, e1, e2), Quét ngoài danh sách, Theo cuộn tem, Ngoại lệ.
  - Cột "Trạng thái" của app so Đã đếm với **Có thể quét** (thẻ NW lúc tải danh sách), KHÔNG so với Dự kiến. "Đã đếm" của SP ngoài danh sách tính theo đơn vị gốc → dùng cột "Số thẻ".
  - **"Có thể quét" của app với SP lẫn cỡ thẻ = tổng số lượng ÷ Quy đổi, KHÔNG phải số thẻ.** Ví dụ SP có thẻ lốc 10 chai + thẻ chai lẻ: 10009 Povidine có 3 thẻ (10 + 1 + 1), app ghi Có thể quét 12. Quét đủ 3/3 thẻ mà app vẫn báo "Còn thiếu 9". Phiên 18/11 có 10 SP như vậy (5399, 10009, 67841, 2005700, 1453, 2005761, 84855, 54433, 4307, 70835). Với nhóm này, xem Lệch so với Dự kiến, đừng xem Trạng thái.
  - App tải danh sách thẻ 1 lần ("Tồn hệ thống lúc"): thẻ nhập NW sau mốc đó hiện ở Chi tiết thẻ với Kho trống, hoặc ở Ngoại lệ "Không nhận ra mã" (resolve ra active @kho) → phải tính là đã quét cho SP đó.
  - Thẻ nhập NW SAU mốc tải danh sách mà KHÔNG quét thấy thì app không liệt kê ở đâu cả (không có trong "Thẻ chưa quét") → script lấy từ ledger (nhập trong khoảng mốc→giờ xuất, còn active, không có trong file) và thêm vào danh sách chưa quét. Ca 18/11: 3 thẻ (5977 …0813, 3225 …0845, 208098 …0826).
  - **Ca 5977 Matrix gội nâu (18/11):** app hiện Có thể quét 1, Tồn hệ thống 1, Dự kiến 1, Đã đếm 40 → "Dư 39". Không sai dữ liệu: POS 41 gói; lúc tạo file import 15:14 NW mới có 1 thẻ (nhập 17/11) nên E = 1 và 40 gói vào danh sách đếm tay; 40 thẻ được nhập NW 16:51–17:10 (IN/05469, 05473, 05474, 05517) trong lúc kiểm. Thực tế 41 thẻ, quét 40, thiếu 1 (…0813). Bài học: nhập kho NW xong rồi mới xuất file Dự kiến và mở phiên (hoặc xuất lại file + tải lại danh sách).
  - **Chuẩn so sánh là tồn POS** (user 18/11: "tồn POS bắt buộc phải đủ"): cột "Dự kiến theo POS" của báo cáo = E tính lại lúc kiểm (tồn POS + đơn chờ giao + hàng nhập sau khi tạo file − bán trong lúc kiểm), KHÔNG phải Dự kiến của app (bị chặn bởi số thẻ NW lúc tạo file). 33 SP lệch giữa 2 số ở phiên 18/11 (5977 app 1 → POS 41; 3225 19 → 49; 1257 26 → 31).
  - **Phiên kiểm lại theo danh sách mã (R2, 18/11 20:03, 548 SP từ `Downloads/kiem_R2.md`):**
    - Tạo bằng `R2_OUT=<dir> R2_CODES=<codes.json> node scripts/kiem-dem/v2/r2.js` (env POS_TOKEN, NW_KEY; cần worker-bundle.js do build sinh ra), rồi `r2-verify-pos.js` (tra tồn từng mã như trang Danh sách tồn kho; 548/548 khớp), rồi `r2-out.js` (CSV import + xlsx kiểm tra).
    - "Đúng tồn POS" = tồn trên POS, cộng mọi dòng/vị trí của SP, trừ Kho thất lạc, KHÔNG cộng đơn online chờ giao (ở R2 có 3 mã: 1257, 348218, 3338).
    - Kết quả: ΣE 3.638 thẻ. 100 SP / 232 thẻ có tồn POS vượt số thẻ NW, phải gắn tem trước khi kiểm. 19 SP lẫn cỡ thẻ. 8 SP tồn POS = 0.
    - Files: `kiem-dem-lumina-R2-20261118-2003.csv` + `-kiem-tra.xlsx`.
    - **Mã nào thật sự cần kiểm lại:** `scripts/kiem-dem/r2-can-kiem.js`. Đầu vào:
      - file so sánh 548 mã (`r2-vs-phien`);
      - báo cáo `phan-tich-kiem-dem.js` của phiên 1, gồm sheet "Thẻ chưa quét" (nhóm e2) và "Nguyên nhân lệch";
      - export RFID phiên 1 và phiên 2;
      - thư mục ICS gồm `qr-epc.json`, `sold-*.json`, `nw-ledger-now.json`.
    - Quy tắc phân loại:
      - **Cần kiểm lại** khi là nhóm E/D và còn thẻ e2 chưa thấy ở mọi nguồn sau: POS quét QR, RFID phiên sau, đơn bán có QR = thẻ, NW trừ.
      - Khớp, A, A3, B, C, hoặc E/D đã thấy lại hết thẻ → **không** cần kiểm RFID lại. Với nhóm này, xử lý dữ liệu theo cột "Việc cần làm".
    - Kết quả 18/11 (file `Downloads/kiem-dem-lumina-R2-can-kiem-lai.xlsx`):
      - Cả 548 mã đều có trong phiên 18:07.
      - **227 mã / 335 thẻ cần kiểm lại**: 192 mã chỉ thiếu 1 thẻ; riêng Quickstick 93933 thiếu 43 thẻ.
      - 321 mã không cần kiểm lại: 68 khớp, 48 đã thấy lại, 8 không còn thẻ cần tìm, 93 B, 82 C, 19 A, 3 A3.
      - Phiên RFID R2 lúc 22:48 chỉ đọc được 21% số thẻ POS thấy, nên không dùng làm kết quả R2. Cần quét lại cho đủ.
  - **Nguyên nhân lệch theo SP** (cột "Nguyên nhân lệch" + sheet "Lệch do dữ liệu"), vì user báo nhiều SP tồn POS sai làm phiên "quét đủ vẫn báo thiếu / dư":
    - A: thẻ NW ghi sai số lượng/đơn vị (tem in theo hộp mà NW ghi 1 viên/thẻ: 399005, 7237, 7508; tem in theo chai mà NW ghi 10 chai/thẻ: 8523).
    - A3: lẫn cỡ thẻ, số quét vẫn nằm trong khoảng hợp lý (khoảng tính bằng cover thẻ nhỏ trước, `needAsc`).
    - B: quét nhiều hơn tối đa theo POS → tồn POS thấp hơn thực tế.
    - C: đã quét đủ thẻ NW mà POS cao hơn → hàng chưa gắn tem hoặc tồn POS cao hơn thực tế.
    - D: vừa có thẻ không thấy vừa có tồn POS chưa gắn tem.
    - E: thẻ NW không quét thấy (thiếu hàng thật).
    - Phiên 18/11 có 490 SP lệch: A 24, A3 3, B 95, C 84, D 20, E 264.
    - Chỉnh tồn POS hoặc sửa thẻ NW đều là thao tác GHI, user phải duyệt từng SP.
  - Phân bổ "đã bán, NW chưa trừ" theo số lượng: trừ đi số thẻ đã có bằng chứng QR = UID (lỗi cũ: đếm 2 lần); đơn NW mới trừ một phần (vd DHC01349878 Fugacar 3/5 hộp) vẫn tính phần còn lại; thẻ của đơn chờ giao KHÔNG chiếm suất "thẻ vượt tồn POS" (đơn chờ giao đã được cộng vào tồn).
  - **Ca 1257 Fugacar (18/11):** file 15:14 = 25 hộp + 1 hộp đơn ONLINE DHC01366536 chờ giao = 26; sau đó POS nhập 5 hộp (→ 30) và NW nhập 5 thẻ 18:07 IN/05560 (app báo "Không nhận ra mã" nên Đã đếm app 24, thật 29). POS tính lại 31, quét 29: thiếu 2 = thẻ hộp chờ giao …EF16E714 (17/11 có quét thấy) + …EF138717 (thiếu cả 2 phiên). NW 43 thẻ − 12 đã bán chưa trừ (5 QR=UID, 2 hộp còn lại DHC01349878, 5 của DHC01360156+DHC01367744) = 31 = POS + chờ giao.
  - Quy đổi thẻ NW → đơn vị POS: = 1 khi đơn vị gốc POS = NW (đừng chia theo cỡ thẻ phổ biến: SP nhiều cỡ thẻ như 8523 lốc 10 + chai lẻ sẽ sai).
  - **Phiên 18/11 Lumina** (import 15:14, danh sách 15:45, xuất 18:07): 8.387 thẻ trong danh sách, quét 7.689 (91,7%); thiếu 698 = a 191 (117+5 QR=UID trực tiếp) · b 24 · d 3 · e1 46 · e2 434. Theo POS: 7.537/7.978 (94,5%); 288 SP thiếu 446 thẻ, 108 SP dư 158 thẻ, 10 SP khớp nhờ hộp lẻ. 297 thẻ quét ngoài danh sách (292 nhập NW 16:50–18:12). Ngoại lệ 560: 429 tem dải Circa chưa nhập NW, 110 thẻ nhập sau 15:45, 13 tem ghi dạng UID (UID không có trên NW). e2: 407/434 là thẻ nhập 16–18/11; 185 cũng thiếu ở phiên 17/11; cuộn A51A1B5156F8D thiếu 10,7% (vs B51A1B510CC55 4%); Quickstick 93933 thiếu 43 que (IN/00336 28, IN/00350 8, IN/00317 7) cả 2 phiên. Báo cáo `Downloads/kiem-dem-lumina-1811-phan-tich.xlsx`.
- **Ca 18/11, 53027 Azoltel (phiên Kiểm đếm Lumina 15:19):** user thấy 14 thay vì 5. Dự kiến vẫn là 5; **14 là "Có thể quét" = 5 thẻ Lumina + 9 thẻ Florita**. Lý do: phiên **chưa chọn kho** (Tổng hợp ghi "Kho: Chọn kho để so tồn", "Tồn hệ thống (gốc)" trống mọi dòng) và danh sách thẻ lấy từ dữ liệu trên máy ("chưa tải được từ máy chủ"), nên "Có thể quét" / "Thẻ chưa quét" gồm cả 7.836 thẻ Florita (tổng 16.218 vs 8.382 thẻ Lumina). NW dùng chung 1 product id cho 2 kho (`578d9b0b-…`). Cách xử lý: chọn kho trong phiên; khi đối soát thì bỏ thẻ có Kho ≠ kho phiên và so Đã đếm với Dự kiến (E/E_max), không so với "So với"/"Có thể quét". Script: `kd/kd-export.js`, `kd/kd-tonghop.js <export.xlsx> <import.csv>`, `kd/case-53027.js <pid>` trong scratchpad.

**Hộp bán lẻ dở** (từ 18/11, checkbox "Xét hộp bán lẻ", mặc định bật):
- **Vấn đề:** hộp mở để bán lẻ vẫn giữ thẻ, còn NW vẫn coi đó là hộp đầy. Ví dụ POS 230 viên, hộp 100 viên, thực tế có 4 thẻ (100 + 100 + 10 + 20) nhưng E chỉ ra 3.
- **L = số đơn bán lẻ:** đơn POS COMPLETED có dòng `base_quantity` không chia hết cho cỡ thẻ, hoàn tất sau lần thẻ vào kho đầu tiên của SP (stock_in, pack_in hoặc transfer). Bỏ các đơn đã trừ NW **cho chính SP đó** (ref theo từng SP, không dùng tập chung: 1 đơn có thể trừ SP A mà chưa trừ SP B).
- **E_max** = max(E, max với k ≤ min(L+1, T, cap, ⌊S⌋) của min(T, ⌊(S−k)/cỡ⌋ + k)). Ví dụ trên cho khoảng 3–4.
  - `cap` = số hộp mở dở cùng lúc tối đa mỗi SP, ô "Tối đa … hộp mở dở" trên trang, **mặc định 2** (user chọn 18/11). Lý do: L tích luỹ trọn đời, không có cap thì SP bán vỉ hằng ngày có E_max ≈ T và che hết thẻ NW chưa trừ. Đổi cap tính lại ngay, không kéo lại dữ liệu.
  - k ≤ ⌊S⌋: mỗi hộp mở còn ít nhất 1 đơn vị gốc (trước 18/11 thiếu điều kiện này: S=1, L=5, T=6 cho E_max=5).
- **File import vẫn điền E** (số tối thiểu). Khi đối soát, quét được trong khoảng E..E_max thì tính "khớp nhờ hộp lẻ"; chỉ phần vượt E_max mới tính là dư.
- **Đọc đơn:** port `listCompleted`, chi tiết đơn chạy song song 5. Bộ nhớ đệm ở localStorage `kd2.ord.<store>`, chỉ lưu code, thời gian, product_id, base_quantity.
  - Lumina từ 08/11: 596 đơn, danh sách mất ~3 s, chi tiết ~43 s lần đầu.
  - Florita từ 12/10: ~1.600 đơn.
  - Chi tiết đơn được lưu đệm cả khi chạy lỗi giữa chừng (và mỗi 100 đơn); đơn trả 404 thì bỏ qua và báo số đơn bỏ.
- **Phiên 17/11** (cap 2, ref theo SP): 2 SP / 2 thẻ khớp nhờ hộp lẻ: Amoxicilin 1127079 (quét 7, khoảng 6–7) và Telfast 284394 (4, khoảng 3–4). Efferalgan 1176 (quét 6, khoảng 4–5) và Telfast 116227 (quét 4, khoảng 2–3) giờ bị tính dư 1 thẻ. Trước khi sửa: 4 SP / 6 thẻ, vì không có cap (1176 ra 4–8).
- **Đối soát phiên trên trang** tự tính lại sau mỗi lần build (đổi vị trí, đổi cap, chạy lại); chọn lại cùng file export vẫn nạp lại được.
- **Xử lý tại chỗ:** dồn hộp lẻ, rồi cập nhật số lượng thẻ trên NW. Đây là thao tác ghi, cần user xác nhận từng SP.

**Đối soát phiên:**
- Trong HTML: upload file xuất phiên (.xlsx), tool tính % theo NW và % theo POS (E).
- Bản đầy đủ có tách theo kênh bán: chạy `node scripts/kiem-dem/fetch-phien.js <fromISO>`, sau đó `node scripts/kiem-dem/phan-tich-phien.js <phien.xlsx> <ton.xlsx snapshot> <snapshotISO> <out.xlsx>`.
  - Cần env NW_KEY, POS_TOKEN. Chỉ đọc. Dữ liệu ra `kd/phien/`.
  - Đối chiếu QR trên đơn với UID qua `POST /tags/by-uid/batch`.
  - Phân loại: a OFFLINE / b ONLINE / c TRF / d chờ giao / e1 thẻ dư / e2 cần tìm.
- **Phiên KIỂM KÊ NW không có file tồn POS** (bản mới, báo cáo theo SP, 19/11): `scripts/kiem-dem/phan-tich-kiem-ke.js`.
  - Chạy: `PHIEN_DIR=<dir> node scripts/kiem-dem/fetch-phien.js <fromISO>`. Gom QR trên đơn/TRF/chờ giao vào `<qr>/scans.json` (`[{qr_code}]`), rồi `node scripts/kiem-dem/pos-qr-resolve.js <qr>`. Sau đó `QR_EPC=<qr>/qr-epc.json SEEN="17/11 20:43 kiểm kê|<xlsx>;18/11 18:07 kiểm đếm|<xlsx>;…" node scripts/kiem-dem/phan-tich-kiem-ke.js <kiem-ke.xlsx> <dir> <out.xlsx>`.
  - Tồn POS lấy bằng API (`pos-stock-now.json`) + bán/TRF từ giờ quét SP → lúc kéo. E = số thẻ ít nhất (thẻ lớn trước) phủ tồn POS lúc quét.
  - Phần thiếu vượt (thẻ − E) = đã bán/chuyển, NW chưa trừ. Phần (E − đã quét) = CẦN TÌM. Thẻ nhập NW sau giờ quét SP = g, không tính thiếu (file xuất tính thiếu lúc XUẤT).
  - QR → EPC (bằng chứng a): SL bán của dòng đơn chia lần lượt cho các EPC của QR (QR tem gốc ra nhiều EPC). Thẻ chỉ tính **đã bán** khi tổng SL bán qua QR của nó ≥ SL trên thẻ. **Bán lẻ vài viên từ hộp (SL < SL thẻ) không phải bằng chứng**: hộp mở dở có thể vẫn trên kệ (sửa 19/11 19:02 sau khi 3 thẻ "a" — 6091, 1458, 2776 — được quét thấy lại). Thẻ như vậy được coi là "thấy" vào giờ bán, cột Bằng chứng ghi "hộp đã mở". Thẻ đã quét thấy ở phiên SAU giờ bán thì không tính là đã bán. Thẻ phân bổ "đã bán theo SL": ưu tiên thẻ chưa từng thấy hoặc thấy sớm nhất; thẻ "cần tìm": ưu tiên thẻ thấy gần nhất.
  - **NW chỉ tự trừ theo đơn POS ngày 11–13/11** (sổ kho: ORDER_COMPLETED chỉ 3 ngày này). User xác nhận 19/11: trừ tồn bật vài ngày từ 06/11 rồi tắt hẳn.
  - **Phiên Lumina 19/11 13:07–15:12** (xuất 15:18, trạng thái "Đang kiểm"): 8.800 thẻ, quét 7.116 (80,9%), thiếu 1.684 / 761 SP. Gồm: đã bán/chuyển NW chưa trừ 308 (228 có QR = thẻ); NW dư so với POS mà không có đơn 85; nhập NW sau giờ quét 16; **cần tìm 1.275 / 557 SP**. Trong 1.275 thẻ cần tìm, 1.026 thẻ đã quét thấy tối 18/11 (18:07, ICS00237, 22:48), nên nhiều khả năng phiên này quét sót. Có 283 SP không đọc được thẻ nào. Cuộn A51A1B5156F8D chỉ đọc được 76%, B51A1B510CC55 đọc được 87,9%. Báo cáo: `Downloads/kiem-ke-lumina-20261119-1518-phan-tich-thieu.xlsx`.
  - **Cùng phiên, xuất lại 19:02** (quét bổ sung 16:00–19:01; nhân viên làm thêm 6 phiếu xuất /OUT/00029–00034 + 14 phiếu nhập /IN/05697–05710 kiểu thay tem): 8.804 thẻ, quét 8.095 (91,9%), thiếu 709 / 437 SP. Đã bán/chuyển NW chưa trừ 296 (a 216, b 68, c 7, d 3, e 2); NW dư 53 / 36 SP; nhập sau 1; **cần tìm 359 / 239 SP** (lần 15:18: 1.275 / 557 → 320 SP đã tìm thấy). 16/308 thẻ "đã bán" lần 15:18 nay quét thấy (3 thẻ a là hộp bán lẻ, 13 thẻ b là thẻ đoán theo SL) → **chỉ thẻ a là EPC chắc chắn; thẻ b–d chỉ chắc về SỐ LƯỢNG theo SP, không chắc EPC nào**. List gọn: `PREV=<phan-tich lần trước> node scripts/kiem-dem/list-thieu.js <phan-tich.xlsx> <out.xlsx>` (thêm sheet "Đã tìm thấy").
  - **Đối chiếu một danh sách mã user gửi** ("mã nào cần kiểm, đủ hay sai thế nào"): `node scripts/kiem-dem/doi-chieu-ds.js <list.xlsx> <kiem-ke.xlsx> <phan-tich.xlsx> <PHIEN_DIR> <out.xlsx>` → 1 dòng/mã, 9 nhóm (cần kiểm / quy đổi lệch master / POS cao hơn hàng có thẻ / quét dư quá mức hộp mở dở / NW dư / NW chưa trừ / chỉ dư hộp mở dở / khớp / không có thẻ NW). Quét dư ≤ 1 + số đơn bán lẻ từ khi gắn thẻ = hộp mở dở, bình thường — **trừ khi mỗi thẻ = 1 đơn vị gốc POS** (gấu bông, 1 chai, 1 hũ…): không thể mở dở → dư là POS thấp / 1 SP dán 2 tem → phải kiểm. 19/11 `kiem_ke_1.xlsx` 523 mã: 214 cần kiểm, 8 quy đổi lệch, 70 POS cao hơn hàng có thẻ, 30 quét dư bất thường, 116 không có thẻ NW (= 438 phải kiểm); không cần kiểm 85 = 3 NW dư + 7 NW chưa trừ + 74 chỉ hộp mở dở + 1 khớp. Sheet "Không cần kiểm" ghi lý do từng mã.
  - **Kiểm lại các mã "Thiếu hàng" trên sheet của user** (Google Sheet "Kiểm đếm RFID Lumina", tab Summary, cột G Phân loại; file chỉ xem được, gviz cần đăng nhập → đọc qua Chrome bằng `fetch(gviz?tq=select B,D,E,F,H,I,J,K,L where G = 'Thiếu hàng')` trong tab docs.google.com, KHÔNG tạo bộ lọc trên file; kết quả JS bị cắt ~1.000 ký tự → trả từng 50 dòng mã hoá `pid:D:E:H:flag` rồi đối chiếu tổng kiểm). Script `scripts/kiem-dem/kiem-thieu-hang.js <rows.txt> <kiem-ke.xlsx> <phan-tich.xlsx> <PHIEN_DIR> <out.xlsx>` → mỗi mã: (1) POS quy ra EPC, (2) EPC đã nhập NW, (3) quét được, (4) trừ mọi xuất NW + đã bán NW chưa trừ; so theo **số lượng** (SP có thẻ nhiều cỡ, vd 5399: 1 thẻ hộp 10 chai + 17 thẻ 1 chai). Cột sheet: D total_rfid = ⌈POS ÷ cỡ thẻ⌉, E total_rfid_scaned = SL quét ÷ cỡ thẻ (khớp 100% phiên 19:02), H Thực dán = thẻ NW active. Bản v2 (19/11 23h): thiếu d = POS lúc quét − Σ SL trên thẻ đã quét (kể cả thẻ ở "Thẻ lạ" đã đăng ký NW); thẻ chưa quét chỉ "cần tìm" tới mức phủ d (ưu tiên thẻ thấy gần nhất), phần vượt = POS đã bán NW chưa trừ (đối chiếu SL đơn bán từ khi nhập các thẻ đó, thiếu đơn → ghi "không thấy đơn"); thẻ nhập NW sau giờ quét SP không phải quét sót; QR bán chỉ tính khi thẻ không còn thấy ở phiên sau giờ bán. **SL thẻ = SL còn lại trên NW**: 11–13/11 NW tự trừ cả bán lẻ, trừ MỘT PHẦN SL trên thẻ (18 dòng ledger / 7 SP, vd 10772 thẻ 6 miếng trừ 4 qua DHC01354827 còn 2, thẻ vẫn active) → đừng lấy SL lúc nhập. Thẻ NW đã xuất (OUT, thay tem) vẫn đọc được thì không tính, chỉ ghi chú. Đơn POS trừ tồn lúc TẠO đơn (12823: tạo 15:01, hoàn tất 16:56, sheet 16h đã trừ). Sheet D cộng ⌈từng dòng seller ÷ quy đổi⌉ (128463: 200+2+192 → 5, đúng là 4). 427 mã = 216 quét sót (309 thẻ cần tìm) · 18 quét sót mà tìm hết vẫn thiếu (45 thẻ) · 1 hàng gắn tem sau giờ quét (150076) · 2 đọc được thẻ NW đã xuất (252429, 5399) · 74 mọi thẻ đã quét mà POS cao hơn · 116 chưa có thẻ NW.
  - **Phát sinh làm phiên thiếu/thừa** (đơn bán, TRF, RCV, đơn chờ giao, nhập/xuất NW, bán lẻ…) cho một danh sách mã: `PHIEN_DIR=<dir> node scripts/kiem-dem/fetch-rcv.js <fromISO>` (POS `GET /v1/inventory/transfer-request?query=pos_id=<store>,type=TRANSFER_IN` = phiếu **RCV** nhận chuyển kho, danh sách tăng dần theo created_at, lọc `dest_pos_id`; chi tiết `/transfer-request/<id>` → `transfer_items[]`; nhiều RCV tạo từ trước, hoàn tất dồn 18/11 ~10h) rồi `QR_EPC=<qr-epc.json> node scripts/kiem-dem/anh-huong-phat-sinh.js <list.xlsx> <kiem-ke.xlsx> <phan-tich.xlsx> <PHIEN_DIR> <out.xlsx>`. Đơn RETURNED chỉ 4 đơn (9–10/2026), bỏ qua; `created_time_from` không lọc được danh sách đơn. Không có API lịch sử tồn / nhập PO (thử `/v1/inventory/purchase-order`, `/inbound`, `/admin/stock/history`, `/stock-movement` đều 404) → nhập hàng PO chỉ suy ra qua stock_in NW. 19/11 list 523 mã: 71 mã bị phát sinh làm lệch (15 lệch hoàn toàn do phát sinh, 56 một phần) — đơn bán NW chưa trừ 37 mã/60 thẻ, bán lẻ 30 mã (thừa), bán giữa 16h và giờ quét 7 mã (sheet thiếu giả), chờ giao 3, RCV chưa gắn tem 2, QR bán mà thẻ còn 2, nhập NW sau giờ quét 1, thẻ đã xuất vẫn đọc 1; TRF và RCV trong giờ phiên: không có; 335 mã lệch không do phát sinh, 116 không có thẻ NW, 1 khớp.
  - **Mã "Dư hàng" trên sheet Summary** (quét > POS): `QR_EPC=<qr-epc.json> node scripts/kiem-dem/kiem-du-hang.js <rows.txt> <kiem-ke.xlsx> <PHIEN_DIR> <out.xlsx>`. Cơ chế: NW không trừ khi POS bán NGUYÊN hộp chỉ làm tồn NW cao (thẻ đi theo hàng, không quét thấy) → KHÔNG gây "quét > POS". Quét > POS chỉ do thẻ còn trong cửa hàng mà POS đã trừ: bán sau giờ quét, bán lẻ từ hộp (NW nhập/giữ cả hộp, kể cả bán lẻ trước khi gắn tem), hộp mở dở lúc gắn tem, QR bán nhầm, hoặc dư thật/dán trùng tem (thẻ 1 đơn vị). SP có thẻ nhiều cỡ (lốc + lẻ, vd 2005580: 1 thẻ lốc 64 tờ + 2 thẻ gói 8 tờ, POS 64) → dư là 2 gói chứ không phải 2 thẻ; có thể đếm trùng nếu gói lẻ lấy từ lốc đã dán tem → mở lốc đếm. Bán lẻ tính theo cỡ thẻ NHỎ nhất (bán 1 gói khi có thẻ gói không phải bán lẻ). 19/11 130 mã: 3 không dư lúc quét · 9 bán lẻ có đơn · 71 hộp mở dở (nhiều khả năng) · 1 QR bán mà thẻ còn · 16 nghi dư (hàng chỉ bán nguyên hộp) · 18 thẻ 1 đơn vị dư thật/dán trùng · 12 thẻ lốc + lẻ cần mở lốc đếm (2003919 Hũ hít +12: NW nhập 33 thẻ qua 13 lần).
- TRF xuất kho: `GET /v1/inventory/transfer-request?page=N&limit=50&query=pos_id=<store>,type=TRANSFER_OUT`.
  - Bộ lọc trong `query=` có tác dụng. Danh sách xếp tăng dần theo ngày tạo, nên lọc `src_pos_id` + ngày ở phía client.
  - Chi tiết từng phiếu: `/v1/inventory/transfer-request/<id>`.
- Phiên public `GET /stock-reconciliations/{id}` trả `details: []` khi phiên đang mở, nên phải dùng file xuất.

## P-KD: File Kiểm đếm v2 (danh sách dự kiến theo thẻ NW), bản script cũ
Cách chạy (cwd = `work/<việc>/`):
1. `node <skill>/scripts/kiem-dem/nw-tags2.js <wh> kd/nw-tags.json`: lấy số thẻ active và cỡ thẻ (số lượng/thẻ lúc nhập) theo mã, đọc từ ledger kho.
2. `node <skill>/scripts/kiem-dem/build-kd.js <tồn.xlsx> <master.xlsx> kd/nw-tags.json <outPrefix>`: dùng nguyên code KiemDem của `kiem-dem-circa.html` (bản trích sẵn trong `tool-worker-raw.js`).

Logic v2:
- **Vị trí:** lấy mọi vị trí trừ Kho thất lạc, vì Lumina có hơn 100 vị trí kệ.
- **Quy đổi với SP đã gắn thẻ:** chọn giữa quy đổi master và các cỡ thẻ thực tế trên NW. Lấy cỡ nào cho `max(ceil(tồn/QĐ), thẻ)` gần nhất với "thẻ đang có + phần POS chưa có thẻ". Nếu hoà thì giữ master.
- **Ba file đầu ra:**
  - `-da-gan-the.csv`: file IMPORT, gồm SP có thẻ và SP chỉ có trên NW (tồn 0).
  - `-chua-gan-the.csv`: SP chưa gắn thẻ.
  - `-kiem-tra.csv`: tất cả các dòng, kèm nhóm và ghi chú.
- **Loại bỏ:** hàng không phải hàng hoá (phiếu mua hàng, tạp chí, tờ rơi, lồng đèn).
- **Lưu ý tồn NW cao hơn POS:** thẻ dán lên hộp đã mở vẫn được nhập theo cả hộp, nên tồn NW tính theo viên thường cao hơn POS. Số thẻ thì vẫn đúng.
