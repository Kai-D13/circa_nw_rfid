# Nhật ký việc

Mỗi yêu cầu một mục, mới nhất ở trên. PM ghi khi đóng việc. Mục đích: lần sau truy lại được ai hỏi gì, làm bằng dữ liệu nào, giao file nào, đã ghi gì lên NW/POS.

Mẫu:

```
## yyyy-mm-dd · <tên việc>
- Yêu cầu: <một câu>
- Dữ liệu: work/<thư mục>/ (phiên, giờ kéo)
- Script: <tên script + tham số chính>
- Kết quả: <số liệu chính>
- File giao: giao/<yyyymmdd>/<tên file>
- Ghi lên NW/POS: không | <mã phiếu, record trong records/nw-writes/>
- Còn mở: <việc chờ user quyết>
```

---


## 2026-11-23 · Extension "Kiểm kê Circa ↔ NW" v0.2.0
- Yêu cầu: bỏ luồng tự tạo phiên NW; thay bằng nút "Gửi sang Circa" trên trang phiên kiểm kê NW: chọn 1 phiên Circa đang mở + 1 hay nhiều phiên NW, chỉ gửi thẻ của SP "Khớp" bằng RFID.
- Dữ liệu: `work/20261122-kiem-ke-circa-nw-ext/` (ảnh chụp, kết quả test, script soát `kiem-chung-v2/`, `kiem-chung-v3/`, `sau-sua-v3/`).
- Nguồn: `tools/nw-sang-circa/ext/` (thêm `chon.js`, `content-nw.js`; bỏ `content-circa.js`, `link.js`, `watch-circa.js`), `build-ext.js`, máy chủ giả, `test-ext.js`, `test-ext-ui.js`.
- Kết quả: test.js 94 đạt; test-ext.js 237 đạt; test-ext-ui.js 157 đạt; test-ui.js 141 đạt. Hai vòng `kiem-chung`: vòng 1 ra 2 lỗi chặn giao (phiên mới để riêng mà vẫn gửi thẻ phiên cũ; chỉ đọc 1 trang lượt quét), vòng 2 ra 1 lỗi chặn giao (đọc lượt quét theo trang trùng/sót không báo). Đều đã sửa; phần sửa sau vòng 2 chưa qua soát độc lập.
- Quyết định của PM: phiên quét SP gần nhất quyết định (không "Khớp" thì để riêng); đọc lượt quét sai thì dừng (summary trước/sau = số id, đọc lại tối đa 3 lần); lượt quét thiếu `product_id` thì không gửi.
- File giao: `giao/20261123/kiem-ke-circa-nw-ext-v0.2.0.zip`, `giao/20261123/kiem-ke-circa-nw-ext-HUONG-DAN.md`.
- Ghi lên NW/POS: không.
- Còn mở: CHƯA chạy với Circa/NW thật. Chưa kiểm trên Circa thật: `offset` của `sessions/<id>/scans`, thứ tự lượt cùng `scanned_at`, `total_scans` có tính lượt unmatched không (đề xuất lệnh chỉ-đọc trên ICS00242, chờ user đồng ý). Danh sách phiên Circa gọi không kèm mã cửa hàng. Hai máy cùng gửi một phiên Circa không khoá được nhau.

## 2026-11-22 · So tồn POS–NW phiên ICS00242; extension "Kiểm kê Circa ↔ NW" v0.1.0
- Yêu cầu: (1) giải thích lệch tồn POS và tồn NW theo sản phẩm; (2) luồng mới: tạo phiên Circa → tự tạo phiên NW liên kết → quét RFID → một nút gửi kết quả về Circa, dạng Chrome extension, mọi cửa hàng.
- Dữ liệu: `work/20261121-nw-sang-circa-kiem-ke/in/` (file xuất ICS00242 và phiên NW), hai net-capture 22/11 (chỉ trong scratchpad).
- Script: `so-pos-nw.js`, `so-pos-nw-xlsx.js` (`scripts/kiem-dem/`); extension ở `tools/nw-sang-circa/ext/`, `build-ext.js`, `mock-ext-server.js`, `test-ext.js`, `test-ext-ui.js`.
- Kết quả so tồn: POS 195.721 / NW 231.354 đơn vị gốc; 1.237 SP bằng nhau, 1.157 NW cao hơn, 59 POS cao hơn, 208 chỉ có ở POS, 59 chỉ có ở NW. Hai ảnh chụp tồn khác giờ (NW 19/11, Circa 21/11).
- Kết quả extension: test.js 94 đạt; test-ext.js 196 đạt; test-ext-ui.js 114 đạt (1 lần trong 3 lần chạy có 1 kiểm tra trượt ở kịch bản A6, chạy lại đạt). Đã qua kiem-chung một vòng, 11 điểm đã sửa. CHƯA chạy với Circa/NW thật.
- Quyết định của user: tự tạo phiên NW khi extension thấy lệnh tạo phiên Circa; phiên cũ chỉ hỏi; ghép kho theo tên trùng chính xác (user đặt tên kho NW = tên cửa hàng Circa); extension không bao giờ đóng/hoàn tất phiên ở hai bên.
- File giao: `giao/20261121/so-ton-pos-nw-ICS00242.xlsx`; `giao/20261122/kiem-ke-circa-nw-ext-v0.1.0.zip`, `giao/20261122/kiem-ke-circa-nw-ext-HUONG-DAN.md`.
- Ghi lên NW/POS: NW có — tạo 1 phiên kiểm kê thử ở Lumina để kiểm chống trùng (`records/nw-writes/20261122-thu-tao-phien-kiem-ke.*`, user đã huỷ phiên). POS không.
- Còn mở: lần chạy thật đầu tiên của extension (NW có nhận POST từ extension không, trang admin gọi API kiểu nào, dạng `/v1/authz/me`); báo Circa lỗi đơn vị của QR tem RFID.

## 2026-11-21 · Công cụ đưa phiên kiểm kê NW sang phiên kiểm kê Circa
- Yêu cầu: sau khi quét RFID xong phiên kiểm kê NW, tạo phiên kiểm kê Circa và gửi mọi thẻ đã quét vào đó, để phiên MỞ; số đơn vị gốc Circa ghi phải bằng số NW từng thẻ. Đóng gói HTML.
- Dữ liệu: `work/20261121-nw-sang-circa-kiem-ke/` (file xuất phiên NW 21/11 15:42: 604 thẻ / 279 SP / 11.630 gốc; `phien/qr-lookup.json`).
- Script / nguồn: `tools/nw-sang-circa/` (core.js, gui.js = GHI, app.js, page.html, build.js, test.js 94 đạt, test-ui.js 14 kịch bản với máy chủ giả) → `build/nw-sang-circa.html`.
- Kết quả: thẻ in sẵn (A51A/B51A) Circa nhận bằng EPC; thẻ E280 chỉ nhận bằng UID. 39 thẻ / 7 SP Circa hiểu sai đơn vị (qr-lookup trả đơn vị mã cha "lốc" thay vì đơn vị RFID "gói") → gửi kèm đơn vị gốc + SL NW. Đối chiếu lượt quét đã lưu: 604/604 đúng, 0 SP chênh.
- File giao: `giao/20261121/nw-sang-circa.html`, `giao/20261121/nw-sang-circa-HUONG-DAN.md`
- Ghi lên NW/POS: POS có. ICS00240 (phiên thử của user): 12 lượt thử, 2 lượt cố ý gửi thô bị ghi sai. ICS00242 (tạo bằng API): 604 lượt. Sổ: `records/pos-writes/20261121-*`. Cả hai phiên để MỞ, là dữ liệu thử, không duyệt.
- Còn mở: trang HTML chưa chạy với Circa thật trong trình duyệt; gửi lại sau khi user reset SP trong phiên; phân trang `scans` (has_more); báo Circa lỗi đơn vị của QR sinh cho đơn vị RFID.

## 2026-11-20 · Cấu trúc lại project, phân vai PM và agent
- Yêu cầu: sắp lại thư mục, quy tắc làm việc, PM (Fable 5.2) giao việc xuống agent model nhỏ hơn; khởi tạo git.
- Kết quả: `.claude/agents/` (tra-cuu, lap-trinh, kiem-chung, van-thu), `refs/`, `records/nw-writes/` (109 file), `work/`, `giao/`, `build/`, `docs/`. Build tool v2 đọc v1 từ `build/`, kết quả trùng byte với bản đã giao.
- Dữ liệu cũ: `work/20261120-luu-tru-phien-cu/` (chép từ scratchpad phiên 5032f5fa, trừ net-capture).
- Ghi lên NW/POS: không.
- Còn mở: repo GitHub đang public → chưa push; plugin/MCP Circa POS, Circa Admin, Nextwaves.

## 2026-11-19 · Phát sinh làm lệch phiên kiểm kê, 523 mã
- Yêu cầu: trong 523 mã, bao nhiêu mã bị đơn bán / TRF / RCV… làm phiên thiếu hoặc thừa.
- Dữ liệu: `work/20261120-luu-tru-phien-cu/kd/gs-summary/phien/` (kéo 21:20), `kd/kk1902/`.
- Script: `fetch-rcv.js`, `anh-huong-phat-sinh.js`.
- Kết quả: 71 mã có phát sinh (15 lệch hoàn toàn, 56 một phần); 335 lệch không do phát sinh; 116 không có thẻ NW; 1 khớp.
- File giao: `giao/20261120/kiem-ke-lumina-20261119-1902-phat-sinh-523-ma.xlsx`
- Ghi lên NW/POS: không.

## 2026-11-19 · Soát lại 427 mã "Thiếu hàng"
- Script: `kiem-thieu-hang.js` (v2: so theo SL còn lại trên từng thẻ).
- Kết quả: quét sót 216, quét sót + POS cao 18, gắn tem sau giờ quét 1, cần xem tận nơi 2, POS cao hơn hàng có thẻ 74, chưa có thẻ NW 116. 21 mã đổi kết luận so với bản đầu.
- File giao: `giao/20261119/kiem-dem-lumina-20261119-thieu-hang-427-ma-v2.xlsx`
- Ghi lên NW/POS: không.

## 2026-11-19 · Kiểm 130 mã "Dư hàng"
- Script: `kiem-du-hang.js`.
- Kết quả theo 7 nhóm: 3 / 9 / 71 / 1 / 16 / 18 / 12. User chỉnh ca 2005580 (thẻ lốc + thẻ lẻ) → bản v2.
- File giao: `giao/20261119/kiem-dem-lumina-20261119-du-hang-130-ma-v2.xlsx` (bản không `-v2` đã cũ).
- Ghi lên NW/POS: không.

## Trước 2026-11-19
Chưa ghi nhật ký. Xem SKILL.md mục "Ca đã gặp", `records/nw-writes/` và memory của project.
