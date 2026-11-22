# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Công cụ đối soát và trừ tồn giữa **Circa POS** (`api.v2.circa.vn`) và **Nextwaves RFID** (`api-circa.nextwaves.app/api/v1/public`) cho 2 cửa hàng Florita và Lumina. Không có package manager. Code là JS thuần (Chrome MV3 + Node 18+), không có bước build chung, không có lint.

## Bố cục

- `circa-tru-ton-bu-v0.1.1/`: Chrome extension "Trừ tồn bù theo đơn". Đọc `HUONG-DAN.md` trong thư mục này trước khi sửa.
  - `lib/core.js` và `lib/rfid-core.js` là **bản sao trùng byte** của Agent `circa-qr-scan-log` v0.8.0.5. Test kiểm SHA-256, nên **không sửa 2 file này**.
  - `lib/backfill-engine.js` dựng lại payload notify giống hệt Agent từ API POS (order, activity-log) và NW (by-uid, generation, epcs).
  - `lib/backfill-runner.js` là hàng đợi gửi: ghi bền bản ghi trước khi POST, dùng `Idempotency-Key` = mã DHC, không tự gửi lại.
  - `lib/pos-bridge.js` chạy trong tab `pos.v2.circa.vn` (world MAIN), dùng cookie `session_token` của trang. Extension không lưu token POS.
- `.claude/skills/circa-nextwaves-check/`: skill của project.
  - `SKILL.md` gồm hằng số (warehouseId / store id), endpoint kèm các điểm bất thường đã kiểm thực tế, playbook P1–P7, P-KD3 (kiểm đếm) và §6 Quy tắc an toàn. **Đọc SKILL.md trước khi gọi API.**
  - `scripts/*.js`: script tra cứu chỉ-đọc. Ngoại lệ là `notify-resend.js` và `so-epc.js`, hai script này **ghi** lên NW.
  - `scripts/kiem-dem/`: batch Kiểm đếm (xem 2 mục kiến trúc bên dưới).
    - `v2/`: nguồn tool HTML v2 (`page.html`, `app.js`, `worker.js`, `core.js`, `build.js`, `test.js`, `live.js`). `v2/r2.js`: dựng file kiểm lại cho một danh sách mã (R2).
    - `fetch-phien.js`: kéo dữ liệu đối soát vào `kiem-dem/phien/` (cạnh script, hoặc `$PHIEN_DIR`).
    - `phan-tich-phien.js`: đối soát phiên **Kiểm kê** NW.
    - `phan-tich-kiem-dem.js`: đối soát phiên **Kiểm đếm** NW (app điện thoại), báo cáo theo SP, phân nhóm nguyên nhân A–E.
    - R2 (kiểm lại một danh sách mã): `v2/r2.js` → `r2-verify-pos.js` → `r2-out.js`. `r2-can-kiem.js` quyết định mã nào thật sự cần kiểm lại.
    - Phiên kiểm kê POS bằng QR ↔ phiên RFID: `pos-count-scans.js`, `ics-scans-xlsx.js`, `pos-qr-resolve.js`, `fetch-ledger.js`, `pos-sold-window.js`, `pos-qr-vs-rfid.js`.
    - `nw-tags2.js` + `build-kd.js`: luồng v1 cũ (playbook P-KD).
    - `load-tool.js`, `tool-worker-raw.js`: SheetJS + `KiemDem` v1, dùng chung cho Node và build.
- `tools/nw-sang-circa/`: công cụ đưa phiên kiểm kê NW sang phiên kiểm kê Circa (`/v1/inventory/count/…`). Đọc `HUONG-DAN.md` ở đó.
  - `core.js` (`NWC`, thuần, dùng chung Node + trình duyệt): đọc file xuất phiên, lập kế hoạch gửi từng thẻ, chia lô, kiểm phản hồi, đối chiếu lượt quét đã lưu. Quy tắc: số gốc Circa ghi = "Số lượng thẻ" NW; khớp quy đổi thì gửi thô, lệch thì gửi kèm đơn vị gốc; thẻ E280 gửi bằng UID; mỗi thẻ một mã.
  - `gui.js`: **GHI lên Circa** (tạo phiên, gửi lô). Chỉ PM chạy sau khi user đồng ý. Sổ ghi ở `records/pos-writes/`.
  - `page.html` + `app.js` + `build.js` → `build/nw-sang-circa.html`. `test.js` (lõi), `test-ui.js` + `mock-server.js` (Playwright với máy chủ giả; không bao giờ trỏ vào Circa thật).
  - `ext/`: Chrome extension "Kiểm kê Circa ↔ NW" (tự tạo phiên NW khi admin tạo phiên Circa; gửi kết quả NW về Circa). Đọc `ext/HUONG-DAN.md`. `api.js` là nơi duy nhất gọi mạng (bảng API được phép; không có lệnh đóng/duyệt/huỷ phiên). Dựng `node tools/nw-sang-circa/build-ext.js` → `build/kiem-ke-circa-nw-ext/`; thử `test-ext.js`, `test-ext-ui.js` + `mock-ext-server.js` (không bao giờ trỏ vào Circa/NW thật). API nội bộ NW dùng ở đây: `/auth/me` (`permissionNames`), `/warehouses`, `/stock/reconciliations` (tạo với `clientOperationId` để chống trùng), `…/export`.
  - API Circa đã kiểm: mọi request cần `X-Store-Id`; tạo phiên không được tự gửi lại; số ghi lần đầu không sửa được bằng API; `sessions/<id>/scans` là nguồn đối chiếu cuối.
- `.claude/agents/`: 4 agent con của project (`tra-cuu`, `lap-trinh`, `kiem-chung`, `van-thu`). Xem mục "Vai trò và giao việc".
- `refs/`: tài liệu tham chiếu, không chạy. `nextwaves-tra-cuu-curl.html` là trang tham khảo lệnh cURL; `notify-201-*.json` là payload mẫu đã gửi.
- `records/nw-writes/`: **sổ ghi mọi lần GHI lên NW** (`*.payload.json` = nội dung định gửi, `*.record.json` = kết quả đã gửi). Chỉ thêm, không sửa, không xoá. Trước khi gửi một mã, tìm ở đây và `GET /orders/{code}`.
- `work/<yyyymmdd-tên-việc>/`: thư mục làm việc của từng việc (dữ liệu kéo về, script nháp, output trung gian). Chia `in/` (file user gửi, chỉ đọc bằng node), `phien/` (dữ liệu kéo từ API), `out/`. Không chứa khoá.
- `build/`: `kiem-dem-circa.html` (tool v1: giữ nguyên, không sửa; build lấy CSS từ đây) và `kiem-dem-circa-v2.html` (sinh ra từ build).
- `giao/<yyyymmdd>/`: **file giao cho user** và file phiên user gửi (import CSV, báo cáo xlsx, file xuất phiên NW). File từ 17/11 đã chép vào đây; file cũ hơn còn ở `C:\Users\Administrator\Downloads\`.
  - `kiem-ke-*.xlsx`: file xuất phiên kiểm kê NW. `kiem-dem-YYYYMMDD-HHMM.xlsx`: file xuất phiên Kiểm đếm NW.
  - `kiem-dem-lumina-*.csv` / `*.xlsx`, `kiem-ke-pos-ICS*.xlsx`: file import và báo cáo đã giao.
  - Không ghi đè file đã giao: bản sửa lưu tên mới (`-v2`, `-v3`…). File đang mở trong Excel mà chép đè sẽ lỗi "Device or resource busy".
- `docs/nhat-ky.md`: nhật ký việc (yêu cầu, dữ liệu, script, kết quả, file giao, có ghi NW/POS không). PM ghi khi đóng việc.
- Git: remote `origin` = `github.com/Kai-D13/circa_nw_rfid`. `work/`, `giao/`, `records/` không đưa lên git (xem `.gitignore`). Xem thay đổi bằng `git diff`; commit sau mỗi việc đã đóng. `.gitattributes` tắt đổi xuống dòng để 2 file `lib/` giữ nguyên byte.

**Bốn loại việc và chỗ của chúng:** check (tra cứu) = `scripts/*.js` của skill; batch (đối soát phiên) = `scripts/kiem-dem/`; build = `scripts/kiem-dem/v2/build.js` → `build/`; diff = git.

## Vai trò và giao việc

Phiên chính là **PM** của project. PM là đầu mối duy nhất với stakeholder và là người duy nhất được ghi lên NW/POS. Việc xử lý giao xuống agent con chạy model nhỏ hơn.

| Vai | Model | Làm gì | Không làm |
|---|---|---|---|
| **PM** (phiên chính) | Fable 5.2 | Nhận yêu cầu, làm rõ, đối chiếu với SKILL.md và memory, lập kế hoạch, chia việc, duyệt kết quả, trả lời stakeholder, cập nhật tài liệu. Chạy lệnh GHI sau khi user xác nhận. | Không tự làm phần tra cứu / viết script dài khi giao được |
| `tra-cuu` | Sonnet 5.5 | Tra cứu chỉ-đọc NW/POS, kéo dữ liệu phiên, đọc docs / OpenAPI / file export | Ghi API, sửa repo |
| `lap-trinh` | Opus 5.5 | Viết / sửa script đối soát, tool v2, extension theo đặc tả đã chốt; chạy trên dữ liệu thật | Tự đổi logic nghiệp vụ, chạy script ghi |
| `kiem-chung` | Opus 5.5 | Soát độc lập kết quả với dữ liệu thô trước khi giao | Sửa cái đang kiểm |
| `van-thu` | Haiku 5.5 | Việc cơ học về file: đếm, gộp, đổi định dạng, so 2 danh sách mã | Gọi API, diễn giải nghiệp vụ |

**Quy trình một yêu cầu.**
1. **Tiếp nhận.** Ghi lại yêu cầu bằng một câu: hỏi gì, trên dữ liệu nào (cửa hàng, phiên, danh sách mã), kết quả giao dạng gì. Thiếu thông tin mà không suy ra được từ file / SKILL.md / memory thì hỏi user ngay, gộp các câu hỏi vào một lần.
2. **Soát và lập kế hoạch.** Đọc playbook liên quan trong SKILL.md và "Ca đã gặp". Xác định: dữ liệu cần kéo, công thức, nhóm kết luận, ca biên, các ca dùng để kiểm thử. Việc có đổi công thức hoặc có GHI thì trình kế hoạch cho user trước.
3. **Giao việc.** Mỗi việc một agent, đề bài tự đủ (agent không thấy cuộc trò chuyện). Việc độc lập thì giao song song trong một lượt.
4. **Duyệt.** PM đọc kết quả, tự soát vài mã bằng dữ liệu thô. Báo cáo giao cho stakeholder mà có phân nhóm / kết luận nguyên nhân thì qua `kiem-chung` trước.
5. **Giao kết quả.** Trả lời user theo sản phẩm, nêu rõ phần đã kiểm, phần suy ra, phần chưa kiểm được. File giao lưu ở `giao/<yyyymmdd>/`, nêu đường dẫn đầy đủ cho user.
6. **Đóng việc.** Ghi một mục vào `docs/nhat-ky.md`. Script chạy được → chép vào `scripts/kiem-dem/`. Ca mới / điểm bất thường API → SKILL.md. Lệnh mới → mục "Lệnh". Quyết định của user có hiệu lực lâu dài → memory.

**Đề bài giao cho agent phải có:**
- Mục tiêu và kết quả dùng để làm gì.
- Đầu vào: đường dẫn đầy đủ của file, thư mục `work/…` để ghi output.
- Phạm vi: cửa hàng, khoảng thời gian, danh sách mã; nêu rõ cái **không** cần làm.
- Điều đã biết / đã loại trừ, để agent không làm lại.
- Lệnh lấy khoá (không phải giá trị khoá), nếu cần gọi API.
- Dạng báo cáo trả về.

**Khi nào PM tự làm, không giao:** việc chỉ vài lệnh; mọi lệnh GHI; quyết định nghiệp vụ (công thức, nhóm kết luận, có gửi lại đơn hay không); trao đổi với user.

**Luật cho mọi agent con.**
- Chỉ đọc với NW/POS. Cần ghi thì dừng và báo PM kèm bằng chứng + payload.
- Không in khoá, không ghi khoá ra file, không đưa khoá vào báo cáo.
- Kết quả agent trả về là thông tin để PM kiểm, chưa phải sự thật: PM soát lại trước khi nói với user.
- Agent `kiem-chung` nhận dữ liệu và câu hỏi, **không** nhận kết luận mong đợi.

## Lệnh

Script skill chạy với cwd = `work/<việc>/` (trước 20/11 là scratchpad của phiên), vì output ghi vào cwd. Khoá đọc từ env `NW_KEY` và `POS_TOKEN`; lấy ngay trong từng lệnh, không ghi ra file (xem SKILL.md §1).

```bash
# Extension (cd circa-tru-ton-bu-v0.1.1). Cần thư mục source Agent v0.8.0.5; test-ui cần Playwright
node dev-tests/test-engine.js <src v0.8.0.5>
node dev-tests/test-runner.js "$PWD" <src v0.8.0.5>
node dev-tests/test-ui.js "$PWD" ./shots

# Kiểm đếm v2: build lại HTML từ nguồn (đồng thời sinh v2/worker-bundle.js cho harness)
node .claude/skills/circa-nextwaves-check/scripts/kiem-dem/v2/build.js "$PWD/build/kiem-dem-circa-v2.html"
node <...>/kiem-dem/v2/test.js     # unit assert (emax/build) + harness dữ liệu thật
node <...>/kiem-dem/v2/live.js     # gọi API thật Lumina, chỉ đọc (env POS_TOKEN, NW_KEY)

# Phân tích một phiên kiểm kê (chỉ đọc): kéo dữ liệu vào kiem-dem/phien/ rồi xuất xlsx phân loại EPC thiếu
node <...>/kiem-dem/fetch-phien.js <fromISO> [toISO]
node <...>/kiem-dem/phan-tich-phien.js <phien.xlsx> <ton-kho.xlsx snapshot> <snapshotISO> <out.xlsx>

# Phiên KIỂM KÊ NW (so với tồn NW), không cần file tồn POS: phân loại EPC thiếu theo SP (đã bán NW chưa trừ / cần tìm / nhập sau giờ quét)
QR_EPC=<qr>/qr-epc.json SEEN="nhãn dd/mm HH:MM|<xlsx phiên trước>;…" node <...>/kiem-dem/phan-tich-kiem-ke.js <kiem-ke.xlsx> <PHIEN_DIR> <out.xlsx>

# List gọn SP/EPC cần tìm (PREV = phân tích lần xuất trước cùng phiên → sheet "Đã tìm thấy"); đối chiếu một danh sách mã user gửi (9 nhóm cần kiểm / đủ / sai)
PREV=<phan-tich cũ.xlsx> node <...>/kiem-dem/list-thieu.js <phan-tich.xlsx> <out.xlsx>
node <...>/kiem-dem/doi-chieu-ds.js <list.xlsx> <kiem-ke.xlsx> <phan-tich.xlsx> <PHIEN_DIR> <out.xlsx>
QR_EPC=<qr-epc.json> node <...>/kiem-dem/kiem-thieu-hang.js <rows.txt pid:D:E:H:flag> <kiem-ke.xlsx> <phan-tich.xlsx> <PHIEN_DIR> <out.xlsx> [bản trước.xlsx]   # mã "Thiếu hàng": so theo SL còn lại trên từng thẻ → quét sót / POS cao / chưa có thẻ
PHIEN_DIR=<dir> node <...>/kiem-dem/fetch-rcv.js <fromISO>   # phiếu RCV nhận chuyển kho (POS TRANSFER_IN) → pos-rcv.json
QR_EPC=<qr-epc.json> node <...>/kiem-dem/anh-huong-phat-sinh.js <list.xlsx> <kiem-ke.xlsx> <phan-tich.xlsx> <PHIEN_DIR> <out.xlsx>   # phát sinh nào (đơn/TRF/RCV/chờ giao/NW/bán lẻ) làm phiên thiếu/thừa
QR_EPC=<qr-epc.json> node <...>/kiem-dem/kiem-du-hang.js <rows.txt> <kiem-ke.xlsx> <PHIEN_DIR> <out.xlsx>   # mã "Dư hàng": dư thật hay do bán lẻ / hộp mở dở / bán sau giờ quét

# Phân tích một phiên Kiểm đếm (app NW), theo SP. PREV = file phiên trước (tuỳ chọn)
PREV=<prev.xlsx> PHIEN_DIR=<dir> node <...>/kiem-dem/phan-tich-kiem-dem.js <kiem-dem.xlsx> <import.csv> <importISO> <out.xlsx>

# R2: file kiểm lại cho danh sách mã (R2_CODES = json mảng product_id), tồn POS đúng (mọi vị trí trừ Kho thất lạc)
R2_CODES=<codes.json> R2_OUT=<dir> node <scratch>/kd/v2/r2.js
node <...>/kiem-dem/r2-verify-pos.js <codes.json> <dir>/build-pos.json <verify.json>   # đối chiếu từng mã với trang tồn POS
node <...>/kiem-dem/r2-out.js <dir> <codes.json> <out dir> [file import cũ để so]   # CSV import + xlsx kiểm tra
node <...>/kiem-dem/pos-pull-check.js            # kiểm phần kéo tồn POS: kéo 2 lần + so mẫu với trang tồn từng mã

# Phiên kiểm kê POS bằng QR (admin kiem-ke-ton-kho/<id>) ↔ phiên Kiểm đếm RFID (chỉ đọc API, phần so sánh offline)
node <...>/kiem-dem/pos-count-scans.js <sessionId> <storeId> <dir>        # scans/lines/summary → <dir>
node <...>/kiem-dem/pos-qr-resolve.js <dir>                              # QR → EPC (by-uid, generations) → <dir>/qr-epc.json
node <...>/kiem-dem/fetch-ledger.js <dir>/nw-ledger-now.json             # kéo SAU phiên POS
node <...>/kiem-dem/pos-sold-window.js <fromISO> <toISO> <dir>/sold-x.json
LEDGER=<dir>/nw-ledger-now.json SOLD=<dir>/sold-x.json RFID2=<phiên RFID sau.xlsx> \
  node <...>/kiem-dem/pos-qr-vs-rfid.js <dir> <kiem-dem.xlsx> <out.xlsx>
node <...>/kiem-dem/r2-can-kiem.js <so-sanh-548.xlsx> <phan-tich.xlsx> <rfid1.xlsx> <rfid2.xlsx> <dir> <out.xlsx>
```

`test.js` và `live.js` được viết cho bố cục scratchpad `<scratch>/kd/v2/`. `test.js` đọc fixture ở 2 cấp phía trên:
- `kd-input2/stock6.xlsx`, `kd-input2/master2.xlsx`, `kd-input2/kiem-ke-lumina-2026-11-17-20-43.xlsx` (bản chép file xuất phiên, không đọc thẳng Downloads; env `SESS` để đổi file);
- `kd/phien/nw-ledger.json`, `kd/phien/pos-orders.json`.

Muốn chạy thì chép `v2/` vào bố cục đó. Nếu không, phần unit chạy xong rồi dừng ở bước đọc file.

## Kiến trúc Kiểm đếm v2

**Bài toán.** App Kiểm đếm của NW cần danh sách "Dự kiến": số EPC quét được nếu tồn POS đúng.
- NW **không tự trừ khi POS bán**, nên số thẻ NW active ≥ thực tế.
- Kiểm kê so với tồn NW. Kiểm đếm so với tồn POS quy ra thẻ.

**Đóng gói.** `build.js` ghép `page.html` từ các placeholder:
- `/*__STYLE__*/`: CSS lấy từ v1 (`build/kiem-dem-circa.html`).
- `/*__WORKER__*/`: SheetJS + `KiemDem` của v1 (`../tool-worker-raw.js`, build patch thêm export `masterRatio`/`ratioFor`/`num`/`strip`) + `core.js` (`KD2`) + `worker.js`.
- `/*__APP__*/`: `app.js`.

Worker chạy từ blob của `<script type="text/plain" id="worker-src">`. **Sửa nguồn rồi build lại, không sửa file HTML sinh ra.** Nguồn không được chứa chuỗi `</script`.

**Luồng dữ liệu.** `app.js` chạy trên main thread, gọi `fetch`. CORS cho phép gọi từ `file://`. Các nguồn:
- Tồn POS: `/v1/inventory/admin/stock/search`, 500 dòng/trang. Cộng mọi dòng seller của cùng product_id.
- Đơn ONLINE chờ giao.
- Sổ kho NW: `/stock/ledger`, phân trang bằng con trỏ `afterLedgerNumber`.
- Master từ Google Sheet: gviz CSV, tab `final data v4` + tab ẩn `Adhoc`. Nếu sai tên tab, gviz trả tab đầu tiên, nên luôn kiểm header.
- (Bỏ từ 19/11) Đơn POS COMPLETED để xét hộp bán lẻ: không còn dùng trong công thức; trang ẩn tuỳ chọn này, `r2.js` không kéo đơn.

Mọi phần nặng (đọc xlsx/CSV, công thức, sinh CSV, đối soát phiên) chạy trong worker qua các message `masterCsv | masterXlsx | posApi | posXlsx | tags | pend | orders | build | session`.

**Công thức** (`core.js`, từ 19/11 theo yêu cầu user: "đừng phức tạp", bỏ mọi ca adhoc):
- **Dự kiến E = ⌈Tồn POS ÷ Quy đổi⌉.** Ví dụ 82278: 215 viên, tem dán theo hộp 20 viên → 11.
- **Tồn POS** = `on_hand` theo đơn vị gốc POS, cộng mọi dòng seller và mọi vị trí, bỏ Kho thất lạc. KHÔNG cộng đơn online chờ giao (ô trên trang mặc định tắt).
  - Phần kéo đã kiểm 19/11 bằng `pos-pull-check.js`: 2 lần kéo đều 5.922 dòng, không sót/trùng, 43 mã mẫu khớp trang tồn từng mã.
- **Quy đổi** = số đơn vị gốc POS trong 1 đơn vị dán tem RFID, lấy từ **master** (Google Sheet, `final_unit_print` + `convert_rate`; tab Adhoc ghi đè).
- **Master là chuẩn, mã lệch để riêng** (user chọn 19/11): SP có thẻ NW nhưng cỡ thẻ đã nhập NW ≠ quy đổi master, đơn vị in trên NW ≠ master, hoặc thiếu master → `row.hold`, **không vào file import**. Các SP này ra danh sách riêng (`holdCsv`, nút "quy đổi lệch") cho tới khi sửa master hoặc SL thẻ NW.
  - R2 19/11: 64/548 mã bị để riêng. Ví dụ 4707: master hộp = 720 viên, nhưng NW có 55 thẻ × chai 30 viên.
- Thẻ NW **không** tham gia công thức, chỉ dùng để cảnh báo:
  - `M = E − thẻ active` > 0 → gắn thêm tem trước khi kiểm.
  - Thẻ NW > E → đã bán/chuyển mà NW chưa trừ.
- Không xét hộp bán lẻ: E_max = E, bỏ phần kéo đơn POS.
  - Bản cũ (đến 18/11) lấy cỡ thẻ NW làm quy đổi và cộng dồn SL ghi trên từng thẻ (`need()`); sai khi NW ghi sai SL thẻ. Bản sao lưu ở scratch `kd/v2/bak/*.before-simple.*`.
- File import điền Dự kiến = E. `session()` so số quét với chính E đó.

**Đọc xlsx trong Node.** SheetJS UMD sẽ ghi vào `exports` khi chạy CommonJS. Dùng `scripts/kiem-dem/load-tool.js`: file này chạy `tool-worker-raw.js` trong `vm` và trả `{XLSX, KiemDem}` (đã có patch export `ratioFor`…).
- Đọc: `XLSX.read(fs.readFileSync(f), {type: "buffer"})`.
- Ghi: `fs.writeFileSync(out, Buffer.from(XLSX.write(wb, {type: "array", bookType: "xlsx"})))`. `XLSX.writeFile` lỗi trong vm vì không có fs.
- `test.js`, `live.js`, `r2.js` cần `v2/worker-bundle.js`, nên chạy `build.js` trước (bundle cũ gây lỗi kiểu `KD2.need is not a function`).

## Đối soát phiên: Kiểm đếm RFID, kiểm kê POS bằng QR, kiểm lại R2

**Ba nguồn đếm.**
- Phiên **Kiểm đếm** NW. Export có các sheet Tổng hợp / Chi tiết thẻ / Thẻ chưa quét / Ngoại lệ, và "Tồn hệ thống lúc" = giờ app tải danh sách thẻ.
- Phiên **kiểm kê POS bằng QR** (mã ICS…). Lấy qua `/v1/inventory/count/sessions/<id>/scans`.
- Đơn bán POS và sổ kho NW, dùng cho khoảng thời gian giữa các phiên.

**Đặc điểm của app Kiểm đếm NW** (đã kiểm thực tế):
- App giữ nguyên Dự kiến đã import.
- Cột "Trạng thái" so Đã đếm với **Có thể quét**, không so với Dự kiến. Với SP có thẻ nhiều cỡ, Có thể quét = tổng SL ÷ Quy đổi, nên app báo "Còn thiếu" giả.
- Thẻ nhập NW sau khi app tải danh sách, hoặc tem dán trước khi stock-in: RFID vẫn đọc được, nhưng nằm ở Ngoại lệ "Không nhận ra mã". Phải tính là đã đọc.
- Phiên không chọn kho thì lẫn thẻ của cả 2 cửa hàng.

**QR POS → EPC.**
- Phần lớn QR là **tem gốc**: `generations/<uid>` trả source tags, parentQr = chính QR đó, children = các thẻ NW. Một QR hộp hoặc thùng có thể ra nhiều EPC.
- QR lốc/hộp ngoài có thể chỉ nối 1 thẻ con. Vì vậy thẻ RFID đọc được mà không thuộc QR nào phải so **theo số lượng** (base_qty POS trừ SL trên thẻ) trước khi kết luận POS bỏ sót.

**Báo cáo.**
- Luôn **theo sản phẩm** (1 dòng/SP, có cột Kết luận + Việc cần làm). Chi tiết từng EPC/UID để ở sheet tham chiếu.
- Dự kiến = ⌈tồn POS ÷ quy đổi master⌉, không bao giờ lấy số thẻ NW. SP lệch quy đổi (master ≠ tem thật trên NW) để riêng, không vào import.
- Nhóm nguyên nhân lệch (`phan-tich-kiem-dem.js`):

| Nhóm | Ý nghĩa | Xử lý |
|---|---|---|
| A | Thẻ NW ghi sai SL/đơn vị | Sửa thẻ NW |
| A3 | Lẫn cỡ thẻ, số quét hợp lý | Không cần làm gì |
| B | Quét nhiều hơn tối đa theo POS, tức POS thấp | Điều chỉnh POS |
| C | Quét đủ mọi thẻ NW mà POS cao hơn: hàng chưa gắn tem | Gắn tem / đếm QR |
| D | C + có thẻ không thấy | Tìm thẻ + gắn tem |
| E | Thẻ NW không thấy, POS còn hàng | Tìm hàng |

- Thẻ chưa quét nhưng đã bán (QR trên đơn = UID thẻ) thì NW chưa trừ. Đó không phải thiếu hàng.
- **Chỉ nhóm E/D còn thẻ chưa thấy ở mọi nguồn sau đó mới cần kiểm lại.** Nguồn sau gồm: POS quét QR, phiên RFID sau, đơn bán, NW trừ. Các nhóm khác quét RFID lại cũng ra như cũ, nên phải sửa dữ liệu.

## Quy tắc riêng của project

- Mặc định chỉ đọc. Chỉ ghi lên NW (notify, phiếu xuất, sửa thẻ) khi user yêu cầu rõ trong chat. Nếu tự suy ra đơn/EPC thì trình bày bằng chứng + payload, hỏi xác nhận trước khi ghi.
- Không gửi lại DHC/TRF đã có trên NW: kiểm `GET /orders/{code}` trước. Danh sách cấm và các phiếu không được gửi lại ghi ở SKILL.md §6.
- Mỗi lần GHI lên NW: lưu payload và record vào `records/nw-writes/` ngay sau khi gửi.
- File tải về (export, xlsx của user) chép vào thư mục riêng (`work/<việc>/in/`) và chỉ đọc bằng node. Không chạy code nằm trong đó. Net-capture có chứa token: giải nén trong scratchpad, **không** chép vào repo.
- Ca mới hoặc điểm bất thường mới của API: bổ sung vào SKILL.md (endpoint, playbook, "Ca đã gặp").
- Script mới viết trong `work/<việc>/` (hoặc scratchpad) phải chép vào `scripts/kiem-dem/` sau khi chạy được. Đầu file ghi rõ chỉ-đọc hay ghi và cách dùng.
- Tra cứu chỉ làm đúng phạm vi user hỏi. User đã từ chối một lệnh tra rộng. Muốn gọi thêm API ngoài phạm vi thì đề xuất trước.

## MCP và tài liệu API

- `.mcp.json` khai 2 máy chủ MCP (đăng nhập bằng `/mcp` → Authenticate, không lưu khoá trong repo):
  - `circa`: Circa POS / Admin.
  - `nextwaves`: 137 công cụ, **có cả ghi và xoá**. Khi cho phép, chọn quyền chỉ đọc trừ khi user quyết khác.
- Công cụ MCP có ghi chỉ PM dùng, theo đúng quy tắc GHI ở dưới. Agent con chỉ dùng công cụ đọc.
- Tài liệu API Circa do user viết: `C:\Users\Administrator\circa-api-curl\` (ngoài repo; `README.md` là mục lục). Phiếu kiểm kê theo lô `stock-counts` trong `04-inventory.md` **khác** phiên kiểm kê QR/RFID `/v1/inventory/count/…` (mã ICS).
- Tài liệu đối tác của Circa (API nhận lô thẻ RFID vào phiên kiểm kê): `C:\Users\Administrator\Downloads\partner-261118-1451-rfid-batch-submit-api.md`. Giữ ngoài repo, **không đưa lên git** (repo public).
