# Hướng dẫn: đưa phiên kiểm kê NW vào phiên kiểm kê Circa

Trang: `build/nw-sang-circa.html` (một file, mở bằng Chrome hoặc Edge, không cần cài gì).

Cần chuẩn bị:
- File xuất phiên kiểm kê NW (.xlsx), có sheet "Chi tiết quét", "Thẻ lạ", "Tổng quan".
- Token Circa admin của tài khoản có quyền kiểm kê.
- Mạng vào được `api.v2.circa.vn`.

Trang chỉ **ghi** lên Circa ở 2 chỗ: **tạo phiên** và **gửi thẻ**. Mỗi chỗ đều có hộp xác nhận. Mọi bước khác chỉ đọc. Trang không đóng, không duyệt phiên.

## Các bước

1. **Thiết lập.** Chọn cửa hàng, dán token.
   - Token chỉ nằm trong trang. Tải lại hoặc đóng trang là phải dán lại.
2. **Nạp file.** Kéo file xuất phiên vào ô, hoặc bấm để chọn file.
   - Xem số thẻ, số SP, tổng gốc, thẻ lạ, Kho.
   - Có khung vàng "Kho … khác cửa hàng đã chọn" thì dừng lại, kiểm cửa hàng và file.
3. **Tra thẻ.** Bấm "Tra thẻ trên Circa" (khoảng 1–3 phút cho 700 mã).
   - Thẻ `E280…` chỉ tra được bằng UID. EPC của nó báo "không nhận" là bình thường.
4. **Xem trước.**
   - Bảng theo SP mặc định chỉ hiện SP cần chú ý. Bấm "Tất cả" để xem hết, hoặc gõ vào ô tìm.
   - Có khung đỏ "Chưa gửi được" thì làm theo dòng hướng dẫn trong khung. Bước 5 và 6 bị khoá tới khi hết lý do chặn.
   - Có thể tải CSV xem trước.
5. **Chọn phiên Circa đích**, theo một trong hai cách:
   - **a. Tạo phiên mới.**
     - Đọc cấu hình. Lumina dùng sẵn vị trí General. Florita phải bấm "Tải danh sách vị trí" rồi chọn (thường là General).
     - Bấm "Tạo phiên mới…", đọc hộp xác nhận, rồi bấm "Tạo phiên". Tồn sổ của cả cửa hàng được chốt ngay lúc tạo.
     - Chờ phiên chuyển sang OPEN (thường khoảng 15 giây, tối đa 3 phút).
   - **b. Dùng phiên có sẵn.**
     - Dán id hoặc link `admin.v2.circa.vn/kiem-ke-ton-kho/<id>` rồi bấm "Kiểm phiên". Hoặc bấm "Lấy phiên đang mở".
     - Nếu phiên đã có lượt quét, đọc khung báo: mã đã có sẽ không gửi lại; mã đã ghi sai thì sau này phải đếm lại trên Circa.
6. **Gửi.** Bấm "Gửi N thẻ…". Trang tải lại lượt quét của phiên, rồi hỏi xác nhận (mã phiên ICS…, số thẻ, số lô). Bấm "Gửi".
   - Không đóng trang khi đang gửi.
   - Lô nào sai thì trang dừng ngay và không gửi các lô sau.
7. **Đối chiếu.** Chạy tự động sau khi gửi, kể cả khi đã dừng giữa chừng.
   - **ĐẠT**: mọi thẻ đúng, gốc NW = gốc Circa, không có lượt ngoài kế hoạch.
   - **CHƯA ĐẠT**: xem bảng theo SP và các danh sách thẻ sai bên dưới. Bấm "Đối chiếu lại" để tải lại lượt quét.
8. **Sổ ghi.** Bấm "Tải sổ ghi (.json)" và "Tải CSV đối chiếu theo SP", rồi gửi cả hai cho PM.
   - Trang không lưu gì lại, nên phải tải sổ ghi trước khi đóng trang.
   - Sổ ghi không chứa token.

## Khi gặp X thì làm Y

| Gặp | Làm |
|---|---|
| Bước 3 báo "Token hết hạn hoặc sai (HTTP 401)" | Dán token mới ở bước 1, bấm "Tra lại phần chưa tra". |
| Bước 3 báo "N mã chưa tra được" | Bấm "Tra lại phần chưa tra". Vẫn lỗi thì kiểm mạng, báo PM. |
| Khung đỏ "Chưa gửi được" vì file có dòng lỗi (ví dụ Số lượng thẻ "1.000") | Sửa dữ liệu trên NW rồi xuất lại file. Không sửa tay file. |
| "Kho trong file … khác cửa hàng đã chọn" | Chọn lại đúng cửa hàng, hoặc lấy đúng file. |
| "File thiếu sheet …" / "thiếu cột …" | Cần đúng file xuất phiên **kiểm kê** NW (file Kiểm đếm có dạng khác). |
| "KHÔNG RÕ phiên đã được tạo hay chưa" | **Không tạo lại** (nút đã khoá). Mở `admin.v2.circa.vn/kiem-ke-ton-kho`. Nếu thấy phiên mới của cửa hàng: dùng mục b ("Lấy phiên đang mở" hoặc dán id). Nếu không thấy: báo PM trước khi tải lại trang để tạo lại. |
| "Circa từ chối tạo phiên — phiên CHƯA được tạo" | Đọc lỗi (token, vị trí…), sửa, rồi bấm "Tạo phiên mới…" lại. |
| "Phiên … chưa MỞ — dừng" (quá 3 phút vẫn LOADING_BASELINE) | Không tạo phiên khác. Xem phiên trên admin. Khi phiên OPEN, bấm "Kiểm phiên" ở mục b (id đã điền sẵn). |
| "Phiên … không phải OPEN" / "thuộc cửa hàng khác" | Chọn đúng phiên đang mở của đúng cửa hàng. |
| "Phiên có nhiều hơn 5000 lượt quét" | Dừng, báo PM (trang chưa hỗ trợ). |
| "ĐÃ DỪNG GỬI": lô không đạt, có bảng thẻ sai | Không gửi lại. Tải sổ ghi, báo PM. SP có thẻ sai cho đếm lại trên Circa. |
| "ĐÃ DỪNG GỬI": 400 FAILED_PRECONDITION | Phiên đã bị đóng hoặc huỷ. Kiểm trên admin, báo PM. |
| "ĐÃ DỪNG GỬI": 401 | Dán token mới, bấm "Đối chiếu lại". Muốn gửi tiếp thì làm theo dòng "gửi tiếp phần còn thiếu" bên dưới. |
| "ĐÃ DỪNG GỬI": "không gửi được sau 4 lần" (mạng / máy chủ) | Đối chiếu ở bước 7 cho biết Circa đã lưu gì. Báo PM trước khi gửi tiếp. |
| Muốn gửi tiếp phần còn thiếu (sau khi đã xử lý nguyên nhân dừng) | Tải sổ ghi. Tải lại trang, làm lại bước 1–4, chọn "Dùng phiên có sẵn" với **cùng phiên**. Mã đã có tự bỏ qua. |
| Đối chiếu CHƯA ĐẠT: sai số / sai SP / mã có nhiều lượt | API không sửa được. Cho đếm lại SP đó trên Circa, báo PM. |
| Đối chiếu CHƯA ĐẠT: có lượt ngoài kế hoạch | Có người quét QR thêm, hoặc còn lượt thử cũ: có thể đếm đôi. Báo PM. |
| Đối chiếu CHƯA ĐẠT: thẻ thiếu | Nếu do dừng giữa chừng thì gửi tiếp như trên. Nếu không, báo PM. |
| Đối chiếu CHƯA ĐẠT: gốc không gửi > 0 (thẻ giữ lại / Circa không nhận) | Phần này phải kiểm hoặc đếm tay. Danh sách nằm ở bước 4, mục "Thẻ không gửi". |
| "Chưa đối chiếu được" | Bấm "Đối chiếu lại" (nếu báo 401 thì dán token mới trước). |
| Ngay lần gọi đầu đã báo "lỗi mạng hoặc bị chặn" | Kiểm mạng. Vẫn lỗi thì báo PM (có thể Circa chặn gọi từ file). |
| Lỡ đóng trang trước khi tải sổ ghi | Phiên vẫn còn trên Circa. Mở lại trang, nạp file, chọn "Dùng phiên có sẵn", đối chiếu, rồi tải sổ ghi. Sổ mới không có body/response của các lô đã gửi: báo PM. |
| Đầu trang có băng đỏ "CHẾ ĐỘ THỬ — máy chủ giả" | Trang đang chạy thử, không gửi lên Circa thật. Mở lại file **không** có `?api=` trong địa chỉ. |

## Không làm

- Không đóng / duyệt phiên trong trang này. Việc đó làm trên admin khi PM cho phép.
- Không mở 2 tab cùng gửi vào một phiên.
- Không dán token vào chat hoặc file.

## Cho lập trình

```bash
node tools/nw-sang-circa/build.js            # sinh build/nw-sang-circa.html từ page.html + app.js + core.js + SheetJS + CSS v1
node tools/nw-sang-circa/test-ui.js          # kiểm thử trình duyệt với máy chủ giả (ảnh → work/20261121-nw-sang-circa-kiem-ke/out/shots)
node tools/nw-sang-circa/mock-server.js 8787 # máy chủ giả để thử tay: mở build/nw-sang-circa.html?api=http://127.0.0.1:8787
```

Sửa nguồn (`page.html`, `app.js`) rồi build lại. Không sửa file HTML sinh ra. Không đổi `core.js` trong lúc sửa trang.
