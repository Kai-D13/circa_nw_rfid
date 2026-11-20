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
