# Extension "Kiểm kê Circa ↔ NW" v0.1.0

Extension làm hai việc:

1. Khi bạn tạo phiên kiểm kê (phương thức QR) trên `admin.v2.circa.vn`, nó tự tạo một phiên kiểm kê "Cả kho" trên Nextwaves (NW) cho đúng cửa hàng đó và liên kết hai phiên.
2. Khi quét RFID xong, bạn bấm một nút để nó lấy kết quả phiên NW và gửi vào phiên Circa.

Extension **không bao giờ** hoàn tất, đóng, duyệt, huỷ hay đặt lại phiên ở cả hai bên. Việc đó admin tự làm trên từng hệ thống.

## Điều kiện

- Chrome 111 trở lên.
- Đã đăng nhập `admin.v2.circa.vn` (tài khoản có quyền kiểm kê) và `circa.nextwaves.app` (tài khoản có quyền `stock.reconcile`) trong cùng trình duyệt. Giữ một tab NW mở.
- Kho trên NW phải có **tên trùng chính xác** với tên cửa hàng trên Circa, ví dụ `CIRCA LUMINA`. Khác dấu hoặc khác chữ là không khớp. Cửa hàng chưa có kho NW thì extension báo và không làm gì.

## Cài

1. Giải nén file zip vào một thư mục cố định.
2. Mở `chrome://extensions`, bật "Developer mode", bấm "Load unpacked", chọn thư mục vừa giải nén.
3. Tải lại các tab admin Circa đang mở.

## Dùng

1. **Tạo phiên Circa như bình thường.** Góc phải dưới của trang admin hiện thanh "Kiểm kê Circa ↔ NW":
   - "Đã tạo phiên NW liên kết": xong. Ghi chú phiên NW có dạng `CIRCA <mã ICS> <id phiên>`.
   - "Mở circa.nextwaves.app và đăng nhập": mở tab NW, extension tự tạo bù.
   - "Cửa hàng này chưa có kho trên NW" hoặc có hơn một kho trùng tên: sửa tên kho trên NW rồi bấm "Thử lại".
2. **Quét RFID** vào phiên NW đó bằng điện thoại và handheld như thường lệ.
3. **Gửi kết quả:** mở trang phiên trên admin Circa, bấm "Lấy kết quả từ NW và gửi vào Circa". Một tab mới mở ra: xem bảng xem trước theo sản phẩm, bấm gửi và xác nhận. Cuối cùng trang đối chiếu với lượt quét Circa đã lưu và cho tải sổ ghi.
4. Quét thêm rồi bấm gửi lần nữa: chỉ thẻ mới được gửi. Số đã ghi lần đầu trên Circa không sửa được bằng API.

Phiên Circa cũ, hoặc phiên tạo từ máy không cài extension: thanh trạng thái hỏi "Tạo phiên NW cho phiên này?" và chỉ tạo khi bạn bấm đồng ý.

## Khi có lỗi

| Thông báo | Việc cần làm |
|---|---|
| Không xác định được cửa hàng | Tải lại trang phiên trên admin Circa. |
| Thiếu quyền `stock.reconcile` / `inventory_count.manage` | Dùng tài khoản có quyền. |
| Phiên NW liên kết đã huỷ / hoàn tất | Extension không tạo phiên khác. Tạo phiên Circa mới nếu cần kiểm lại. |
| Token hết hạn (401) | Mở lại tab NW hoặc tab admin Circa rồi bấm "Thử lại". |
| KHÔNG RÕ Circa đã ghi lô này chưa | Không gửi lại tay. Xem kết quả đối chiếu ngay bên dưới. |
| Thẻ "giữ lại" / "Circa không nhận" | Các thẻ này không được gửi; kiểm tay theo danh sách trên trang. |

## Cho lập trình

- Nguồn: `tools/nw-sang-circa/ext/`. Dựng: `node tools/nw-sang-circa/build-ext.js` → `build/kiem-ke-circa-nw-ext/` (bản thật) và `build/kiem-ke-circa-nw-ext-test/` (bản thử, chỉ nhận `127.0.0.1`).
- Kiểm thử: `node tools/nw-sang-circa/test-ext.js` (node thuần) và `node tools/nw-sang-circa/test-ext-ui.js` (Playwright + `mock-ext-server.js`). Không bao giờ trỏ kiểm thử vào Circa hay NW thật.
- `api.js` là nơi duy nhất gọi mạng và chứa bảng API được phép. Thêm endpoint mới phải thêm vào bảng và vào test.
- `core.js` (`NWC`) dùng nguyên từ `tools/nw-sang-circa/core.js`; quy tắc gửi không đổi.
- Token Circa và NW được đọc từ tab đang đăng nhập ngay trước mỗi lần gọi, không lưu ở đâu.
