# Hướng dẫn: kéo tồn POS ↔ NW vào Google Sheet

Code: `tools/ton-pos-nw-sheet/Code.gs` (một file, dán vào Apps Script của một Google Sheet).

Script **chỉ đọc** Circa POS và Nextwaves (chỉ gọi GET). Script chỉ ghi vào chính Google Sheet đó: tab `Chon_kho`, tab `Ton_POS_NW` và chỗ lưu khoá.

Cần chuẩn bị:
- Một Google Sheet mới (hoặc Sheet riêng cho việc này).
- Khoá Circa POS (`POS_TOKEN`) và khoá Nextwaves (`NW_KEY`).
- Tài khoản Google đang dùng phải **xem được** file master quy đổi (Google Sheet `18nLllIlORaki3por1diKzNo2tWvdVyUnB1xbZXDv8Xc`).

## Cài đặt (làm một lần)

1. Mở Google Sheet. Vào **Tiện ích mở rộng → Apps Script**.
2. Vào **Cài đặt dự án** (biểu tượng bánh răng). Bật **"Bật thời gian chạy Chrome V8"**. Script **cần runtime V8**; dự án mới thường đã bật sẵn.
3. Quay lại **Trình chỉnh sửa**. Xoá hết chữ có sẵn trong `Code.gs`. Dán toàn bộ nội dung file `Code.gs`. Bấm **Lưu**.
4. Quay lại Sheet, tải lại trang (F5). Trên thanh menu có thêm **Tồn POS ↔ NW**.
5. Bấm **Tồn POS ↔ NW → 1. Nhập khoá API**.
   - Lần đầu Google hỏi cấp quyền: bấm Tiếp tục, chọn tài khoản. Nếu thấy "Google chưa xác minh ứng dụng này": bấm **Nâng cao → Đi tới … (không an toàn) → Cho phép**. Script cần quyền: xem/sửa bảng tính, kết nối dịch vụ bên ngoài (gọi API), hiện hộp thoại.
   - Sau khi cấp quyền, bấm lại menu 1.
   - Hộp 1: dán `POS_TOKEN`, bấm OK. Hộp 2: dán `NW_KEY`, bấm OK.
   - Hộp thoại chỉ báo "đã có" / "chưa có", không hiện lại khoá. Để trống rồi bấm OK là giữ khoá cũ.
6. Bấm **2. Cập nhật danh sách cửa hàng**. Script tạo tab `Chon_kho`:
   - Từ dòng 4: mã cửa hàng, tên, id POS, kho NW trùng tên, id kho NW.
   - Ô **B1**: ô thả xuống để chọn cửa hàng.

Khoá nằm ở Script Properties của file, không nằm trong code. Ai có quyền **sửa** file đều mở được Apps Script và xem được khoá. Chỉ chia quyền sửa cho người được phép. Chia quyền xem thì không lộ khoá.

## Mỗi lần dùng

1. Tab `Chon_kho`, ô **B1**: chọn cửa hàng, ví dụ `POS0059 - CIRCA TAM VIET`.
2. Bấm **Tồn POS ↔ NW → 3. Kéo tồn cửa hàng đang chọn**. Góc dưới hiện tiến độ (trang POS, NW, master).
   - Cửa hàng khoảng 6.000 dòng tồn: chờ khoảng 1 phút.
   - Mỗi lúc chỉ một người chạy được menu 3 trên cùng Sheet.
3. Xong thì hộp thoại báo số dòng, số tem cần in. Kết quả ở tab **`Ton_POS_NW`**.
   - Mỗi lần chạy, dữ liệu mới ghi đè lên tab này, phần thừa của lần trước bị xoá. Muốn giữ bản cũ thì sao chép tab trước khi chạy.
   - Ô **B2** tab `Chon_kho` ghi giờ kéo, cửa hàng, số tem, số dòng đoán quy đổi từ tên, và **số mã master đã nạp**. Số mã master giảm mạnh so với lần trước là dấu hiệu tab master bị thiếu dòng: báo người quản lý master.
4. Có lỗi thì script dừng và **không ghi gì**. Tab kết quả giữ nguyên lần chạy trước.

Có cửa hàng mới, hoặc NW vừa tạo kho mới: chạy lại menu 2.

## Ý nghĩa từng cột (tab `Ton_POS_NW`)

Mỗi dòng là 1 mã sản phẩm × 1 chủ hàng (seller) trên POS.

| Cột | Ý nghĩa |
|---|---|
| `POS_code`, `POS_name` | Cửa hàng đã chọn. |
| `product_id` | Mã sản phẩm Circa. |
| `product_name` | Tên trên POS. |
| `owner_name` | `CIRCA` nếu seller là CIRCA. Seller khác (CIRCA_MKP, CIRCA_SPONSOR, MARKETING…) để trống. |
| `total_on_hand_qty` | Tồn tổng, theo đơn vị gốc POS, cộng mọi vị trí **trừ Kho thất lạc**. |
| `total_available_qty` | Tồn bán, cộng mọi vị trí trừ Kho thất lạc. |
| `total_rfid_need_print` | Số tem RFID cần in = ⌈tồn tổng ÷ `quy_doi`⌉. Ví dụ 215 viên, tem dán theo hộp 20 viên → 11. Tồn ≤ 0 → 0. Cách tính giống tool Kiểm đếm v2. |
| `quy_doi` | Số đơn vị gốc POS trong 1 tem, chính là số đã dùng để chia. Lấy từ master. Mã không có trong tab master lúc chạy thì **đoán từ tên SP**. Ví dụ 1109 (Diacerein, tồn 180 viên): lần chạy 24/11 tab master không có mã này, nên `quy_doi` đoán từ "(hộp/100 viên nang)" = 100 → ⌈180 ÷ 100⌉ = 2 tem. Trống khi không chia (tồn ≤ 0, hàng không phải hàng bán). |
| `nw_ten_san_pham` | Tên sản phẩm trên Nextwaves. |
| `nw_kho` | Kho NW cùng tên cửa hàng. |
| `nw_don_vi` | Đơn vị gốc trên NW. |
| `nw_so_luong` | Số lượng tồn NW (đơn vị gốc). |
| `nw_tong_the_epc` | Số thẻ RFID (EPC) đang có trên NW. |
| `ghi_chu` | Xem bảng dưới. |

Cột NW chỉ điền ở dòng seller CIRCA. Dòng seller khác để trống cột NW. Sản phẩm NW có số lượng 0 **và** 0 thẻ thì bỏ qua (không ghép, không tạo dòng).

Thứ tự: theo `product_id` tăng dần rồi seller. Các dòng "chỉ có ở NW" nằm cuối bảng.

| Ghi chú | Nghĩa |
|---|---|
| `không có trong master; quy đổi đoán từ tên → …` | Mã không có trong tab master lúc chạy. `quy_doi` đoán từ quy cách trong tên. **Phải kiểm trước khi in tem** (xem "Rủi ro của quy đổi đoán từ tên"), rồi bổ sung master (tab Adhoc). |
| `master thiếu đơn vị in; quy đổi đoán từ tên → …` | Master có mã nhưng không quy được đơn vị tồn POS ra đơn vị in. Cũng đoán từ tên, cũng **phải kiểm trước khi in**. |
| `… đoán từ tên: <cảnh báo> → …` | Bộ đoán không chắc, ví dụ "không tìm thấy số cái trong (bịch/12 túi), để 1" (1 tem / 1 cái), hoặc "tem trên lốc hay đơn vị bên trong?". Kiểm kỹ. |
| `chưa có quy đổi → không tính được số tem` | Đoán ra quy đổi 0. Cột tem để trống. Bổ sung master. |
| `master không có …, tính theo …` / `đơn vị in … nhỏ hơn …` | Có quy đổi trong master nhưng nên kiểm lại master. |
| `quy đổi X khác cỡ thẻ NW ~Y` | NW đang có thẻ, trung bình mỗi thẻ ~Y đơn vị gốc (`nw_so_luong` ÷ `nw_tong_the_epc`), khác `quy_doi` X. Có thể tem đang dán khác master, NW ghi sai SL thẻ, hoặc lẫn cỡ thẻ. Chỉ là ghi chú, số tem vẫn tính theo X. Kiểm trước khi in. |
| `owner khác còn tồn N` | Ở dòng CIRCA: các seller khác của cùng mã còn N (đơn vị gốc). Hàng đó cũng nằm trên kệ, có tem hay không tuỳ cách cửa hàng dán. |
| `Kho thất lạc N (không tính)` | POS còn N ở Kho thất lạc, không cộng vào tồn. |
| `POS tồn 0, NW còn hàng` | POS hết hàng nhưng NW còn tồn hoặc còn thẻ. Dòng được giữ để thấy chênh lệch. |
| `chỉ có ở NW` | NW có tồn mà POS không có dòng seller CIRCA nào cho mã này. Các cột POS để trống. |
| `chỉ có ở NW (POS có owner khác: N)` | Như trên, nhưng POS có seller khác của mã này còn N. |
| `mã NW không đúng dạng CIRCA-<số>` | Sản phẩm trên NW mang mã lạ, không ghép được. `product_id` để trống. |
| `seller …: không ghép NW` | Dòng của seller khác CIRCA. |
| `không phải hàng bán (…)` | Phiếu mua hàng, tạp chí, tờ rơi, lồng đèn, voucher. Tem = 0 (giống tool Kiểm đếm v2). |

Dòng tồn POS bằng 0 (cả tồn tổng và tồn bán) không hiện, trừ ca `POS tồn 0, NW còn hàng`.

### Rủi ro của quy đổi đoán từ tên

Bộ đoán chỉ đọc quy cách trong ngoặc của tên SP. Nó có thể sai theo **cả hai chiều**:
- **Dư tem** khi đoán ra `quy_doi` = 1 (1 tem cho mỗi đơn vị gốc). Ví dụ 256598 tăm chỉ "(bịch/12 túi)", tồn 2.000 cái: đoán 1 → 2.000 tem; master 17/11 ghi 50 cái/tem → 40 tem.
- **Thiếu tem** khi đoán theo hộp, lốc, thùng mà tem thật dán theo đơn vị nhỏ hơn. Ví dụ 2005763 mặt nạ Banobagi "(H/10m)", tồn 121 miếng: đoán 10 → 13 tem; master 17/11 ghi tem từng miếng → 121 tem (NW đang có 16 thẻ).

Trước khi in: lọc `ghi_chu` theo "đoán từ tên", so `quy_doi` với cách dán tem thật và với cột NW (cỡ thẻ trung bình). Sai thì bổ sung master rồi chạy lại.

## Khi gặp X thì làm Y

| Gặp | Làm |
|---|---|
| Không thấy menu "Tồn POS ↔ NW" | Tải lại trang Sheet. Vẫn không có: mở Apps Script, chọn hàm `onOpen`, bấm Chạy. |
| Lỗi cú pháp khi lưu / khi chạy (ví dụ "Unexpected token") | Dự án chưa bật runtime V8. Làm lại bước 2 phần Cài đặt. |
| "Chưa có khoá POS_TOKEN / NW_KEY" | Chạy menu 1, dán khoá. |
| "POS: khoá sai hoặc hết hạn (HTTP 401)" | Lấy `POS_TOKEN` mới, chạy menu 1, dán lại (hộp NW để trống). |
| "POS: khoá không có quyền với cửa hàng/kho này hoặc đã hết hạn (HTTP 403)" | Tài khoản của khoá không được xem cửa hàng này, hoặc khoá hết hạn. Dùng khoá của tài khoản có quyền. |
| "Nextwaves: khoá sai hoặc hết hạn" / "… không có quyền …" | Dán lại `NW_KEY` ở menu 1 (hộp POS để trống). |
| "… không phản hồi được sau 3 lần thử lại" | Mạng hoặc máy chủ đang lỗi. Chạy lại sau ít phút. Chưa có gì bị ghi. |
| "Tồn POS: kéo được X dòng khác nhau …, nhưng POS báo tổng Y dòng" | Tồn POS thay đổi trong lúc kéo, hoặc POS trả thiếu. Chạy lại. Lặp lại nhiều lần thì báo PM. |
| "Tồn POS / Tồn NW: … dòng không thuộc cửa hàng / kho đã chọn" | API trả dữ liệu của nơi khác. Script dừng, không ghi. Báo PM. |
| "Đang có người chạy "Kéo tồn" trên Sheet này" | Chờ người kia chạy xong (khoảng 1 phút), rồi chạy lại. |
| "Có N kho Nextwaves cùng tên …" | Không biết lấy kho nào nên dừng. Báo người quản lý NW gộp hoặc đổi tên kho. |
| Ô B2 ghi "chưa có kho NW trùng tên" | Cửa hàng chưa có kho NW cùng tên. Phần POS vẫn đúng, các cột NW để trống. |
| "Không mở được Google Sheet master" | Tài khoản đang chạy chưa xem được file master. Xin quyền xem file master rồi chạy lại. |
| "Master không có tab …" / "thiếu cột …" | Master bị đổi tên tab hoặc cột. Báo PM, không tự sửa code. |
| "Chưa chọn cửa hàng" | Chọn cửa hàng ở ô B1 tab `Chon_kho`. Ô B1 trống sau menu 2 là do cửa hàng cũ không còn trong danh sách. |
| "Chưa có danh sách cửa hàng" | Chạy menu 2. |
| "Exceeded maximum execution time" (quá 6 phút) | Chạy lại. Lặp lại thì báo PM, kèm tên cửa hàng. |
| Rất nhiều dòng `quy đổi đoán từ tên` | Các mã đó không có trong tab master lúc chạy. Xem số mã master ở ô B2. Kiểm `quy_doi` trước khi in, rồi báo người quản lý master bổ sung. |
| Số tem rất lớn so với số hộp thật (ví dụ 2.000 tem cho 2.000 cái tăm) | Thường là dòng đoán từ tên với `quy_doi` = 1. Không in theo số này. Kiểm quy đổi, bổ sung master rồi chạy lại. |

## Không làm

- Không dán khoá vào ô của Sheet, vào chat, hay vào code.
- Không sửa tay tab `Ton_POS_NW` rồi chạy lại: tab bị ghi đè.
- Không đổi tên tab `Chon_kho`, `Ton_POS_NW`.

## Cho lập trình

```bash
# kéo dữ liệu thật để test (chỉ đọc; env POS_TOKEN, NW_KEY; ghi vào <cwd>/phien/)
cd work/20261124-ton-pos-nw-sheet
node ../../tools/ton-pos-nw-sheet/fetch-data.js <posStoreId> <nwWarehouseId> <nhãn>
# test: unit + giả lập Apps Script + dữ liệu thật + đối chiếu file POS + đối chiếu tool Kiểm đếm v2
node tools/ton-pos-nw-sheet/test.js        # env DATA_DIR, LABEL (mặc định tamviet), XLSX_POS, MASTER_1711
```

- Code.gs chia 2 phần: hàm thuần (test bằng Node qua `vm`) và lớp Apps Script (menu, `UrlFetchApp`, sheet, `LockService`).
- Logic đọc master và quy đổi (`loadMaster`, `masterRatio`, `ratioFor` để đoán từ tên khi master thiếu) port nguyên từ `KiemDem` (`scripts/kiem-dem/tool-worker-raw.js`), cách dùng giống `KD2.build` (`v2/core.js`). Đổi logic ở tool v2 thì phải đổi ở đây và chạy lại test (phần B so `ratioFor` trên mọi tên SP thật, phần D so số tem với `KD2.build`).
- `test.js` không gọi mạng. Kết quả thật ghi ra `work/…/out/ton-pos-nw-<nhãn>.csv` (master hiện tại) và `…-master1711.csv` (master ngày 17/11).
