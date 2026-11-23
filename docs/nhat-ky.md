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


## 2026-11-24 · Apps Script "Tồn POS ↔ NW" trên Google Sheet (pilot CIRCA TAM VIET)
- Yêu cầu: trên Google Sheet, chọn 1 cửa hàng → kéo tồn POS (1 dòng / product_id × owner: POS_code, POS_name, product_id, product_name, owner_name, total_on_hand_qty, total_available_qty, total_rfid_need_print) và ghép tồn NW của kho cùng tên (tên SP, kho, đơn vị, số lượng, tổng thẻ EPC). Sau này dùng cho mọi cửa hàng.
- Quyết định của user: gọi API (không nhập file xlsx); bỏ avg_cost_price; số tem theo tool Kiểm đếm v2; bỏ Kho thất lạc; owner khác CIRCA để trống owner_name và không ghép NW; SP chỉ có ở NW thành dòng riêng. User cấp khoá Circa `ck_u_…` và khoá NW mới (thấy nhiều kho hơn khoá cũ) trong chat 24/11.
- Dữ liệu: `work/20261124-ton-pos-nw-sheet/` (`in/ton-kho-7.xlsx` file user xuất 00:16; `phien/` POS kéo 00:51, NW overview, master gviz; `kiem-chung/`).
- Nguồn: `tools/ton-pos-nw-sheet/` (`Code.gs` chỉ GET, `test.js` 243 đạt, `fetch-data.js`, `HUONG-DAN.md`).
- Kết quả Tam Việt: 3.650 dòng (3.649 POS + 1 chỉ-NW); Σ on_hand 294.030; NW 110.409 đơn vị / 5.158 thẻ, 1.518 dòng ghép. `kiem-chung` dựng lại độc lập khớp 3.650/3.650; khớp file trang POS 3.641/3.642 (2008025 đổi tồn giữa hai lần). Số tem bằng E của v2 ở 3.578 SP một seller.
- Phát hiện: tab master `final data v4` ngày 24/11 chỉ còn 27.218 mã (5004…124899), 17/11 có 63.996 mã → 2.462 dòng Tam Việt phải đoán quy đổi từ tên (Σ tem 14.401; với master 17/11 là 12.927, chỉ 3 dòng đoán). Đã báo user; tool Kiểm đếm v2 đọc cùng tab nên cũng bị ảnh hưởng.
- File giao: `giao/20261124/ton-pos-nw-sheet-Code.gs`, `ton-pos-nw-sheet-HUONG-DAN.md`, `ton-pos-nw-tamviet-master-hien-tai.csv`, `ton-pos-nw-tamviet-master-1711.csv`.
- Ghi lên NW/POS: không.
- Còn mở: CHƯA chạy trong Apps Script thật (gọi từ IP Google, `openById` master, thời gian chạy, menu/ô thả xuống, LockService). Phần sửa sau vòng `kiem-chung` (dòng NW 0/0, kiểm đúng kho, thứ tự ghi, ghi chú mới) chưa qua soát độc lập lần hai. User kiểm lại Sheet master. Màn chọn kho cho mọi cửa hàng: mới có ô thả xuống.

## 2026-11-23 · Extension "Kiểm kê Circa ↔ NW": tạm dừng ở v0.2.1
- Yêu cầu: user bảo đóng và khoá việc này lại (23/11 tối) để làm việc khác gấp hơn; khi mở lại thì tiếp tục dựng và cải tiến từ đây.
- Trạng thái: bản đang dùng là v0.2.1 (`giao/20261123/kiem-ke-circa-nw-ext-v0.2.1.zip`, trùng byte với bản dựng từ commit `d522444`). User đã cài được trên Chrome ("Load unpacked" từ `giao/20261123/kiem-ke-circa-nw-ext-v0.2.1/kiem-ke-circa-nw-ext`) và nói "QA tạm ổn"; **PM chưa nhận ảnh, sổ ghi hay số liệu nào của lần chạy thật**, nên chưa có gì được xác nhận với Circa/NW thật.
- Soát độc lập v0.2.1 (`work/20261122-kiem-ke-circa-nw-ext/kiem-chung-v4/`): không có lỗi chặn giao. test.js 94, test-ext.js 244, test-ext-ui.js 168 đều đạt. Chọn thẻ trên 4 file xuất thật trùng với `chon.js`.
- Quyết định của user 23/11: mỗi cửa hàng chỉ mở 1 phiên NW tại một thời điểm, súng RFID nối đúng 1 phiên → không xử lý ca hai phiên có lần quét cuối trùng giờ.
- Việc để lại cho v0.2.2 (làm một lượt khi mở lại, qua `lap-trinh` rồi `kiem-chung`):
  - N1: tổng `summary` lệch ổn định với số lượt quét bị báo là "đang có người quét?"; thử lại không giúp gì. Cần thông báo đúng nguyên nhân.
  - N2: mọi phần tử trong `data.scans` được coi là lượt còn hiệu lực; nếu Circa trả cả lượt đã xoá thì báo ĐẠT sai. Chưa biết Circa có xoá mềm không.
  - N3: không chặn được việc quét QR cùng SP trong lúc đang gửi (đếm đôi, API không sửa được). Hiện chỉ có lời dặn người dùng.
  - N4: service worker MV3 có thể bị tắt khi một fetch chờ quá 30 giây → trạng thái "KHÔNG RÕ".
  - N5: hướng dẫn nói "đặt lại SP trên Circa rồi gửi lại" nhưng chưa kiểm.
  - N6: một mã thẻ có ký tự ngoài `[A-Za-z0-9_-]` chặn cả kế hoạch, đáng ra chỉ để riêng SP đó.
  - Nhỏ: M1 SP "Chưa đếm" mà có dòng quét chưa bị để riêng; M3 thẻ của một SP có thể nằm ở hai lô; M4 tên file trong zip dùng `\` (macOS có thể giải nén lỗi); M5 khoảng mười chỗ hướng dẫn lệch với mã, thiếu cảnh báo "không quét QR khi đang gửi" và "một người gửi cho một phiên Circa".
- Cần kiểm khi chạy thật (danh sách G1–G16 trong báo cáo `kiem-chung-v4`): `limit=60000` trên phiên >1.000 lượt; `total_scans` có bằng số lượt `/scans`; `/scans` có trả lượt đã xoá; gửi lại lô có đếm trùng không; SP gửi theo đơn vị gốc ghi đúng số; Circa trả lời trong 30 giây; tên kho NW = `pos_name`; danh sách phiên Circa gọi không kèm `X-Store-Id` có chạy không.
- Hoãn: đưa extension lên mục "Tiện ích" của NW (`/vi/addons`, cần user gửi zip mẫu hoặc tài liệu); báo Circa lỗi lật trang lượt quét và lỗi đơn vị QR; `pos-count-scans.js` còn lật trang bằng offset.
- File giao: `giao/20261123/prompt-phien-moi-v2.md` (lời nhắc mở phiên Claude mới, thay bản 22/11).
- Ghi lên NW/POS: không.

## 2026-11-23 · Thẻ Tam Việt nhập nhầm kho Lumina → chuyển kho trên NW
- Yêu cầu: kéo danh sách tem đã map (UID ↔ EPC) vào kho Lumina từ 09:00 23/11 bởi tài khoản Duy và Ly (hàng của CIRCA TAM VIET chọn nhầm kho), rồi chuyển kho Lumina → Tam Việt trên NW. Chỉ sửa NW. 3 phiếu FLOR/IN/07896–07898 của Duy: user nói không chỉnh.
- Dữ liệu: `work/20261123-tem-tam-viet-nham-lumina/` (sổ kho Lumina kéo 12:12, phiếu nhập 21–23/11, OpenAPI NW).
- Script: `chuyen-kho.js` (+ test 125 đạt) → chép vào `scripts/chuyen-kho/`; script kéo/đối chiếu (`fetch-*.js`, `stage*.js`, `build-xlsx.js`) để ở thư mục việc.
- Kết quả: 269 thẻ / 150 phiếu nhập / 81 SP / 1.707 gốc (Duy 144 thẻ, Ly 125), 10:28–11:34; `kiem-chung` dựng lại độc lập trùng khít. Chuyển bằng 8 phiếu `…/INT/00006`, `00008`–`00014`; sau chuyển 269/269 thẻ active @ CIRCA TAM VIET, tồn Lumina từng SP giảm đúng số chuyển, 263 thẻ Lumina khác của các SP đó không đổi.
- Sự cố khi chạy: `…/INT/00007` (lô 60 thẻ) đã submit rồi HUỶ vì NW chia đều `quantity` cho các thẻ khác cỡ của mã 2007233; hàng về lại Lumina đúng số dư; lô được tách thành 3 phiếu theo cỡ thẻ.
- File giao: `giao/20261123/the-map-nham-lumina-20261123.xlsx`.
- Ghi lên NW/POS: NW có — 9 phiếu chuyển kho (8 COMPLETED, 1 CANCELLED), sổ `records/nw-writes/20261123-chuyen-kho-lumina-tamviet-*`. POS không.
- Còn mở: không. Việc "đây là hàng Tam Việt" dựa trên lời user.

## 2026-11-23 · Extension "Kiểm kê Circa ↔ NW" v0.2.0
- Yêu cầu: bỏ luồng tự tạo phiên NW; thay bằng nút "Gửi sang Circa" trên trang phiên kiểm kê NW: chọn 1 phiên Circa đang mở + 1 hay nhiều phiên NW, chỉ gửi thẻ của SP "Khớp" bằng RFID.
- Dữ liệu: `work/20261122-kiem-ke-circa-nw-ext/` (ảnh chụp, kết quả test, script soát `kiem-chung-v2/`, `kiem-chung-v3/`, `sau-sua-v3/`).
- Nguồn: `tools/nw-sang-circa/ext/` (thêm `chon.js`, `content-nw.js`; bỏ `content-circa.js`, `link.js`, `watch-circa.js`), `build-ext.js`, máy chủ giả, `test-ext.js`, `test-ext-ui.js`.
- Kết quả: test.js 94 đạt; test-ext.js 237 đạt; test-ext-ui.js 157 đạt; test-ui.js 141 đạt. Hai vòng `kiem-chung`: vòng 1 ra 2 lỗi chặn giao (phiên mới để riêng mà vẫn gửi thẻ phiên cũ; chỉ đọc 1 trang lượt quét), vòng 2 ra 1 lỗi chặn giao (đọc lượt quét theo trang trùng/sót không báo). Đều đã sửa; phần sửa sau vòng 2 chưa qua soát độc lập.
- Quyết định của PM: phiên quét SP gần nhất quyết định (không "Khớp" thì để riêng); đọc lượt quét sai thì dừng (summary trước/sau = số id, đọc lại tối đa 3 lần); lượt quét thiếu `product_id` thì không gửi.
- File giao: `giao/20261123/kiem-ke-circa-nw-ext-v0.2.0.zip`, `giao/20261123/kiem-ke-circa-nw-ext-HUONG-DAN.md`.
- Ghi lên NW/POS: không.
- v0.2.1 (cùng ngày): đo chỉ-đọc trên ICS00242 (604 lượt, khoá `ck_u_…` của user) cho thấy `scans?limit=100&offset=N` trả 604 dòng nhưng 594 id (10 trùng, 10 sót), lặp lại y hệt; một request `limit` lớn trả đủ. Extension đổi sang đọc MỘT request `limit=60000` kẹp giữa hai lần `summary`. test-ext.js 244 đạt, test-ext-ui.js 168 đạt. File giao: `giao/20261123/kiem-ke-circa-nw-ext-v0.2.1.zip`, `kiem-ke-circa-nw-ext-HUONG-DAN-v0.2.1.md` (bản v0.2.0 đã giao: không dùng cho phiên trên 1.000 lượt). Kết quả đo: `work/20261122-kiem-ke-circa-nw-ext/kiem-offset/ket-qua.json`; đã ghi SKILL.md.
- Còn mở: CHƯA chạy extension với Circa/NW thật. Chưa biết giới hạn `limit` phía Circa và `total_scans` có tính lượt unmatched không. Phần sửa sau vòng soát 2 và v0.2.1 chưa qua soát độc lập. Báo Circa: sắp lượt quét theo (`scanned_at`, `id`). `pos-count-scans.js` còn lật trang bằng offset. Danh sách phiên Circa gọi không kèm mã cửa hàng. Hai máy cùng gửi một phiên Circa không khoá được nhau.

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
