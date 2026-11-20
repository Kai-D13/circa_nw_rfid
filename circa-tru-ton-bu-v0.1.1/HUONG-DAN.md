# Circa POS – Trừ tồn bù theo đơn (v0.1.1)

Extension riêng, chạy song song với `circa-qr-scan-log` (Agent), không sửa hay thay Agent. Dùng để trừ tồn Nextwaves cho các đơn POS v2 đã bán nhưng chưa được trừ.

## Luật trừ = core.js của Agent v0.8.0.5

- `lib/core.js` và `lib/rfid-core.js` là bản sao giống từng byte của v0.8.0.5 (SHA-256 `6f4e23af…a1cf` và `76a3b403…a8a7`, test kiểm).
- Payload trừ do `CORE.buildNotifyPreview` lập. Kết quả gửi do `CORE.notifyVerdict` đọc. Idempotency-Key lấy từ `CORE.notifyIdempotencyKey`, bằng mã DHC.
- Agent lập payload từ lượt quét ghi trên máy POS. Đơn cũ không có dữ liệu đó, nên `lib/backfill-engine.js` dựng lại đúng shape ấy từ API:
  - `ord`: GET `/v1/order/{id}`, qua `CORE.extractOrderInfo` + `CORE.mergeOrderInfo`.
  - Lượt quét / thao tác: activity-log POS.
  - UID → EPC: Nextwaves `by-uid` + `generation`, qua `RFID.byUidVerdict` / `generationVerdict` + `CORE.lookupPatch`.
  - Lượng tem: `/integrations/circa/epcs`, qua `CORE.parseNotifyEpcHolding`.
- Đã kiểm trên dữ liệu thật: DHC01299037 ra đúng payload Agent đã gửi ngày 24/10 (EPC `1784593522634C06FFFFFFFF`, 8).
- Đơn có cả dòng đạt và dòng bị giữ: gửi phần đạt, giống Agent. Dòng bị giữ phải xử lý tay, vì mỗi DHC chỉ gửi được 1 lần.
- Những chỗ chặt hơn Agent (giữ thay vì trừ):
  - Không áp luật "1 tem đổi đơn vị" của v0.7.10.5.
  - Dòng có đổi lô thì giữ.
  - Mã quét nằm trên nhiều dòng thì giữ cả đơn.
  - Thao tác tay trên SKU có nhiều dòng thì giữ.

## Cài đặt

1. `chrome://extensions` → bật Developer mode → Load unpacked → chọn thư mục này.
2. Bấm icon extension để mở trang công cụ.
3. Vào Cài đặt:
   - Tenant: `circa` (kho Florita).
   - API key: nên tạo key riêng, ví dụ `STOCK-SYNC-BATCH`. Cần quyền `write` mới gửi được; key chỉ đọc thì chỉ kiểm tra được.
   - Store id: Florita `c476efb2-…6607`.
   - Blocklist.
   - Số đơn tối đa mỗi lượt.
4. Bấm "Kiểm tra key" để xem tên key và quyền.

Key được lưu ở `chrome.storage.local`, che khi hiển thị, không ghi vào nhật ký.

## Vận hành

1. Mở `pos.v2.circa.vn` trong cùng trình duyệt, đã đăng nhập. Store đang chọn không quan trọng: store id lấy theo cài đặt, và đơn khác store sẽ bị loại.
2. Dán order_id (hoặc cột `order_code, order_id` từ Sheet) → bấm **Kiểm tra**. Bước này chỉ đọc, không gửi gì.
3. Xem kết luận từng đơn:

   | Kết luận | Ý nghĩa |
   |---|---|
   | Đủ điều kiện | Gửi được |
   | Cần xem lại | Có lý do từ core.js |
   | Đã có trên Nextwaves | Đã có đơn, không gửi |
   | Bị chặn | Trong blocklist |
   | Lỗi kiểm tra | Lỗi đọc dữ liệu |

   Bấm một dòng để xem chi tiết từng UID / EPC và activity-log. Xuất CSV đơn hoặc CSV dòng / UID nếu cần.
4. Muốn gửi thì phải đủ 4 điều kiện:
   - Bật "Cho phép gửi" trong Cài đặt.
   - Tick xác nhận notifyAuto đã tắt trên POS-01 / POS-02.
   - Chọn đơn.
   - Gõ lại đúng số đơn để xác nhận.
5. Mỗi đơn được gửi tuần tự như sau:
   1. Kiểm lại Nextwaves chưa có DHC. Nếu đã có (Agent vừa gửi) thì huỷ.
   2. Tra lại lượng mọi EPC. Payload phải trùng từng byte với bản đã kiểm; nếu khác thì "changed", không gửi.
   3. Ghi bền bản ghi `bf:<DHC>` = submitting.
   4. POST `/integrations/circa/orders/notify` với `Idempotency-Key: DHC`.
   5. Đọc kết quả bằng `CORE.notifyVerdict`.
   6. Đối soát: GET `/orders/{DHC}` phải khớp EPC + lượng.
6. Hàng đợi dừng ngay khi một đơn không ra "confirmed" (timeout, 401/403, 429, 5xx, từ chối…).
7. Đơn "Không rõ kết quả" (timeout, hoặc trang bị đóng giữa lúc gửi) không bao giờ tự gửi lại. Ở mục Nhật ký, bấm "Kiểm tra trên Nextwaves":
   - Nextwaves đã có đơn → đánh dấu đã trừ.
   - Nextwaves chưa có → chỉ được gửi lại đúng body + key cũ, sau khi xác nhận.

Thứ tự kiểm tra: các đơn trong một lượt được xét theo giờ hoàn tất. Lượng còn của một EPC được cộng dồn giữa các đơn, nên đơn sau không được trừ vượt phần đơn trước đã dùng.

## Quyền và dữ liệu

- `scripting` + `https://pos.v2.circa.vn/*`: đọc đơn POS bằng phiên của tab POS (chạy trong trang, world MAIN). Extension không đọc, không lưu token POS. Chỉ lấy các trường cần cho core.js, không lấy thông tin khách hàng.
- `https://*.nextwaves.app/*`: gọi API public của Nextwaves.
- `storage`: lưu cài đặt và nhật ký gửi.
- Không có tác vụ nền. Không bao giờ tự gửi.

## Kiểm thử (thư mục dev-tests, cần Node 18+ và Playwright cho test giao diện)

```
node dev-tests/test-engine.js <thư mục source v0.8.0.5>
node dev-tests/test-runner.js "$PWD" <thư mục source v0.8.0.5>
node dev-tests/test-ui.js "$PWD" ./shots
```

- `test-engine.js` (7 ca): payload DHC01299037, tem thiếu, cộng dồn, sửa lượng, ONLINE, 2 UID, sửa lượng via qr.
- `test-runner.js` (9 ca): core trùng byte, nhập liệu, kiểm tra không POST, ghi bền trước POST, Idempotency-Key, huỷ khi DHC vừa có, tem đổi lượng, timeout → không rõ, mở lại trang, 401.
- `test-ui.js`: nạp extension thật vào Chromium, kiểm tra, gửi 1 đơn với POS / Nextwaves giả lập.
