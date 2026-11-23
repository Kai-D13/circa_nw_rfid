# Extension "Kiểm kê Circa ↔ NW" v0.2.0

Extension gửi thẻ RFID của các sản phẩm đã **"Khớp"** trong phiên kiểm kê Nextwaves (NW) vào một phiên kiểm kê Circa đang mở.

Khác bản v0.1.0: extension **không còn tự tạo phiên NW** và không còn thanh trạng thái trên trang admin Circa. Bạn tự tạo phiên ở hai bên như bình thường, rồi chọn phiên trong extension.

Extension **không bao giờ** tạo, hoàn tất, đóng, duyệt, huỷ hay đặt lại phiên ở cả hai bên. Lệnh ghi duy nhất là gửi thẻ vào phiên Circa bạn đã chọn, sau khi bạn xác nhận.

## Điều kiện

- Chrome 111 trở lên.
- Cùng một trình duyệt đang mở và đã đăng nhập:
  - một tab `admin.v2.circa.vn` (tài khoản có quyền `inventory_count.manage`; thiếu quyền thì chỉ xem trước được, nút gửi khoá);
  - một tab `circa.nextwaves.app`.
- Kho trên NW phải có **tên trùng chính xác** với tên cửa hàng trên Circa, ví dụ `CIRCA LUMINA`. Không có kho trùng tên, hoặc có hơn một kho trùng tên, thì extension báo và dừng.
- Phiên Circa ở trạng thái đang mở (OPEN). Phiên NW đang kiểm, thuộc đúng kho đó.
- **Mỗi phiên Circa chỉ một người gửi.** Trên cùng một máy extension tự khoá; hai máy khác nhau gửi cùng lúc thì extension không khoá được nhau.

## Cài

1. Nếu đang cài bản v0.1.0: gỡ ở `chrome://extensions` trước.
2. Giải nén file zip vào một thư mục cố định.
3. Mở `chrome://extensions`, bật "Developer mode", bấm "Load unpacked", chọn thư mục vừa giải nén.
4. Tải lại tab NW đang mở.

## Dùng

Mở trang danh sách phiên kiểm kê trên NW (`circa.nextwaves.app/…/stock/reconciliation`), bấm nút **"Gửi sang Circa"**. Một tab mới mở ra với 6 bước:

1. **Chọn phiên kiểm kê Circa đang mở.** Trang kiểm phiên còn OPEN và quyền của tài khoản.
2. **Chọn phiên kiểm kê NW.** Chỉ hiện phiên đang kiểm của kho trùng tên cửa hàng. Chọn một hoặc nhiều phiên, bấm "Xem trước".
3. **Xem trước theo sản phẩm.** Mỗi sản phẩm một dòng: phiên NW nguồn, số thẻ, số lượng gốc, trạng thái "Gửi" / "Đã có" / "Để riêng" kèm lý do. Tải được CSV.
4. **Gửi.** Bấm "Gửi N thẻ…" và xác nhận. Ngay trước khi gửi, trang đọc lại phiên Circa; nếu phiên vừa có lượt quét mới làm kế hoạch thay đổi, trang không gửi mà báo "Phiên Circa vừa thay đổi, xem lại rồi bấm gửi lần nữa".
5. **Đối chiếu.** Trang đọc lại toàn bộ lượt quét Circa đã lưu và so từng thẻ. "ĐẠT" nghĩa là mọi thẻ đã gửi có trên Circa với đúng sản phẩm và đúng số lượng gốc.
6. **Sổ ghi.** Bấm "Tải sổ ghi (.json)" **trước khi đóng trang**; trang không tự lưu.

Quét thêm rồi mở lại và gửi lần nữa: thẻ đã có trong phiên Circa tự được bỏ qua, chỉ thẻ mới được gửi.

## Thẻ nào được gửi

- Chỉ sản phẩm NW ghi **"Khớp"**, khớp hoàn toàn bằng RFID. Sản phẩm "Thiếu", "Thừa", "Chưa đếm" không gửi.
- Mỗi sản phẩm lấy thẻ từ **một** phiên NW. Khi chọn nhiều phiên, phiên quét sản phẩm đó gần nhất quyết định:
  - phiên đó "Khớp" → gửi thẻ của phiên đó;
  - phiên đó "Thiếu" / "Thừa" / khớp nhờ đếm thủ công → để riêng, không gửi (kể cả khi phiên cũ hơn ghi "Khớp"). Muốn gửi theo phiên cũ thì bỏ chọn phiên mới;
  - phiên mà sản phẩm "Chưa đếm" không ảnh hưởng.
- **Để riêng** (không gửi, kiểm tay theo danh sách):

| Lý do | Nghĩa |
|---|---|
| Khớp nhờ đếm thủ công | Có số đếm tay trong phiên NW; số thẻ RFID không đủ để ra số "Khớp". |
| File xuất không nhất quán | Tồn hệ thống ≠ Đã đếm, hoặc tổng số lượng thẻ ≠ Đã đếm. |
| Phiên mới hơn không khớp | Phiên quét sản phẩm này gần nhất không ghi "Khớp". |
| Không chọn được phiên | Có từ hai phiên đã đếm sản phẩm mà không rõ giờ quét của một phiên. |
| Có thẻ không gửi được | Circa không nhận ra một thẻ của sản phẩm; cả sản phẩm không gửi. |
| Phiên Circa đã có lượt quét khác | Sản phẩm đã được quét trong phiên Circa bằng mã không thuộc phiên NW nguồn (ví dụ quét QR bằng PDA). |

- Số đã ghi trên Circa không sửa được bằng API. Sản phẩm ghi sai thì đặt lại sản phẩm đó trên Circa rồi gửi lại.

## Khi có lỗi

| Thông báo | Việc cần làm |
|---|---|
| Không có tab admin Circa / tab NW | Mở và đăng nhập tab đó, rồi bấm "Tải lại danh sách". |
| Token hết hạn (401) | Mở lại tab NW hoặc tab admin Circa, đăng nhập, thử lại. |
| Không ghép được kho | Sửa tên kho NW cho trùng tên cửa hàng Circa. |
| Thiếu quyền `inventory_count.manage` | Dùng tài khoản có quyền. |
| Phiên Circa vừa thay đổi | Xem lại bảng ở bước 3 rồi bấm gửi lần nữa. |
| Phiên Circa không còn mở | Extension dừng. Thẻ đã gửi trước đó vẫn nằm trong phiên; xem bước 5. |
| KHÔNG RÕ Circa đã ghi lô này chưa | Không gửi lại tay. Xem kết quả đối chiếu ở bước 5, rồi mở lại trang và gửi lần nữa: thẻ đã có tự được bỏ qua. |
| Không đọc được ổn định lượt quét của phiên Circa | Đang có người quét vào phiên Circa. Chờ họ dừng, bấm "Xem trước" lại (hoặc "Đối chiếu lại" nếu đang ở bước 5). Lặp lại nhiều lần khi không ai quét: báo người phụ trách. |
| CHƯA ĐỐI CHIẾU ĐƯỢC | Extension chưa đọc được đủ lượt quét nên chưa kết luận. Bấm "Đối chiếu lại". Không coi là đã đạt. |
| Lượt quét không có id / không đọc được product_id / summary không có tổng số lượt | Extension dừng, không gửi. Tải sổ ghi và báo người phụ trách. |
| Phiên Circa còn lượt quét sau 60 trang | Phiên Circa có hơn 60.000 lượt quét; extension không gửi. Báo người phụ trách. |
| Lỗi bất ngờ của trang | Chưa gửi gì (trừ khi ghi "KHÔNG RÕ"). Bấm "Xem trước" lại. |
| Panel khác đang gửi vào phiên này | Chờ panel kia xong. |

## Cho lập trình

- Nguồn: `tools/nw-sang-circa/ext/`. Dựng: `node tools/nw-sang-circa/build-ext.js` → `build/kiem-ke-circa-nw-ext/` (bản thật) và `build/kiem-ke-circa-nw-ext-test/` (bản thử, chỉ nhận `127.0.0.1`).
- Kiểm thử: `node tools/nw-sang-circa/test-ext.js` (node thuần) và `node tools/nw-sang-circa/test-ext-ui.js` (Playwright + `mock-ext-server.js`). Không bao giờ trỏ kiểm thử vào Circa hay NW thật.
- `content-nw.js`: nút trên trang NW. `chon.js`: đọc file xuất phiên NW và chọn phiên nguồn cho từng sản phẩm (thuần, có test). `panel.js`: 6 bước. `background.js`: khoá gửi theo phiên Circa, chuyển lệnh tới `api.js`.
- `api.js` là nơi duy nhất gọi mạng và chứa bảng API được phép. Lệnh ghi duy nhất: `submit-rfid-batch`. Thêm endpoint mới phải thêm vào bảng và vào test.
- Lượt quét Circa đọc bằng `chon.js` `readScans`: `summary` trước và sau, `limit=1000`, `offset` = số lượt đã nhận, tới `has_more=false`, trần 60 trang. Lần đọc chỉ đạt khi `total_scans` trước = sau = số `id` khác nhau, không `id` trùng, mọi lượt có `product_id`; lệch thì đọc lại tối đa 3 lần rồi dừng. Đọc không đạt thì không lập kế hoạch, không gửi, không báo ĐẠT.
- Chưa kiểm trên Circa thật: cách máy chủ xử lý `offset`, thứ tự các lượt cùng `scanned_at` giữa hai request, `total_scans` có tính lượt unmatched không.
- Manifest: quyền `storage`, `scripting`; CSP `connect-src` chỉ gồm hai host API. `build-ext.js` kiểm cả hai.
- `core.js` (`NWC`) dùng nguyên từ `tools/nw-sang-circa/core.js`; quy tắc gửi từng thẻ không đổi.
- Token Circa và NW được đọc từ tab đang đăng nhập ngay trước mỗi lần gọi, không lưu ở đâu.
