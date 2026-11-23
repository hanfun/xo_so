# XSMN Local — Node.js + MySQL + thống kê đơn giản

Ứng dụng **chỉ lấy kết quả xổ số kiến thiết miền Nam (XSMN)**, lưu trên **MySQL cài ở máy của bạn**, và hiển thị bảng phân tích đơn giản theo **ngày/tháng, đài xổ số và hạng giải**.

> **Lưu ý:** thống kê mô tả quá khứ, không phải thuật toán dự đoán hay bảo đảm kết quả kỳ tới.

## 1. Cài đặt trên máy local

Yêu cầu **Node.js 20 trở lên** (khuyên dùng Node.js 22 LTS) và **MySQL 8.0+** đang chạy.

```bash
git clone https://github.com/hanfun/xo_so.git
cd xo_so
npm install
```

Tạo file cấu hình **.env** từ **.env.example**:

- Windows PowerShell: `Copy-Item .env.example .env`
- macOS / Linux: `cp .env.example .env`

Mở file `.env` và điền thông số MySQL trên máy:

```dotenv
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=YOUR_LOCAL_MYSQL_PASSWORD
DB_DATABASE=xskt
DB_CONNECTION_LIMIT=5
PORT=3000
HOST=127.0.0.1
```

Sau đó tạo database / bảng rồi chạy server:

```bash
npm run db:init
npm start
```

Mở trình duyệt **http://127.0.0.1:3000**. Server có thể chạy trên Windows, macOS và Linux. Nếu MySQL user không có quyền `CREATE DATABASE`, tạo sẵn DB `xskt` trong phpMyAdmin/MySQL Workbench rồi chạy lại `npm run db:init` bằng user có quyền tạo bảng.

**Không được commit `.env` lên GitHub.** Mật khẩu chỉ lưu trong `.env` ở máy local; dùng tài khoản MySQL riêng với quyền tối thiểu phù hợp khi triển khai nghiêm túc.

## 2. Lưu dữ liệu ở đâu?

MySQL database: `xskt` (đặt bằng `DB_DATABASE`). Schema ở `db/migrations/001_initial.sql`:

| Bảng | Mục đích |
|---|---|
| `provinces` | Danh sách đài XSMN (mã, tên, miền) |
| `draws` | Một đài trong một ngày mở thưởng |
| `prize_results` | Mỗi số trúng giải một dòng, lưu dạng **VARCHAR** để giữ số 0 đầu |
| `source_snapshots` | Lưu kết quả XSMN của từng ngày và bản JSON đầu vào để đối chiếu |
| `features` | Sẵn cấu trúc cho thống kê/đặc trưng thuật toán về sau |
| `model_versions` | Phiên bản thuật toán (chưa có mô hình dự đoán) |
| `predictions` | Lịch sử dự đoán theo phiên bản |
| `prediction_evaluations` | Đối chiếu dự đoán với kết quả công bố |

Các bảng ML chỉ là phần chuẩn bị cấu trúc, **chưa có thuật toán dự đoán**. MySQL là nguồn dữ liệu chính. Sau mỗi lần lưu thành công, dự án cũng tạo bản sao JSON tại `data/YYYY-MM-DD.json`; thư mục này được Git bỏ qua.

## 3. Phân tích cơ bản trên dashboard

Trong mục **Tần suất 2 số cuối**, có thể lọc:

- **Từ ngày / đến ngày:** theo khoảng lịch sử đã thu thập
- **Đài:** tất cả hoặc một đài XSMN, ví dụ Đồng Tháp
- **Giải:** tất cả giải hoặc từng giải ĐB, 1, 2, ..., 8

Kết quả trả về:

1. **Tổng số kết quả** trong mẫu, **số lượt đài** mở thưởng và **số ngày** đã có dữ liệu
2. **Top 20 cặp 2 số cuối** xuất hiện nhiều nhất, số lần và ngày xuất hiện gần nhất
3. **Tổng hợp theo tháng:** số kết quả đã lưu mỗi tháng
4. **Bảng ngày gần nhất:** số lượt đài, số kết quả theo ngày

Cách đếm: mỗi số giải thưởng có **một cặp 2 số cuối**. Ví dụ `001234` và `1234` đều cho đuôi `34`. Một đài miền Nam có **18 kết quả** thuộc **9 hạng giải**; khi chọn `Giải 4` sẽ có tối đa 7 số mỗi đài trong một kỳ, còn `Giải đặc biệt` chỉ 1 số. Vì vậy khi so sánh tần suất phải chú ý kích thước mẫu.

`last_seen` là **ngày gần nhất xuất hiện trong dữ liệu đang lọc** chứ không phải ngày dự đoán kỳ tới.

## 4. Nhập dữ liệu lịch sử để có mẫu phân tích

Ứng dụng **không tự sinh dữ liệu cũ** và không đưa số mẫu giả lên database. Để nhập lịch sử XSMN từ API theo từng ngày:

```bash
npm run history:import -- 2026-10-01 2026-11-23
```

Mỗi lượt hỗ trợ tối đa 366 ngày; có thể chạy nhiều đợt. Chương trình:

- Chỉ lưu các đài **region = MN** và kiểm tra số lượng/độ dài các giải
- Bỏ qua những ngày đã có dữ liệu, hoặc dùng `--force` nếu muốn cập nhật lại
- Không xóa kết quả hợp lệ đã lưu nếu nguồn ngày mới chưa đủ
- Tạm nghỉ giữa các yêu cầu để hạn chế tải lên API bên thứ ba

Tình trạng lịch sử phụ thuộc vào nguồn dữ liệu; không phải ngày nào cũng chắc chắn có sẵn. Nếu nguồn không có ngày yêu cầu, ứng dụng báo lỗi ngày đó chứ không bịa dữ liệu.

Nhập một ngày:

```bash
npm run collect -- 2026-11-22
```

## 5. Cron tự quét (giờ Việt Nam)

Khi ứng dụng **npm start vẫn đang chạy**:

| Giờ VN | Hoạt động |
|---|---|
| 17:00 | Quét kết quả miền Nam ngày hiện tại |
| 18:00 | Kiểm tra cập nhật |
| 19:00 | Kiểm tra cập nhật |
| 07:30 | Quét bù kết quả hôm qua |

Lịch nằm trong Node.js, **không cần tạo cron mỗi ngày**. Máy phải luôn bật, không ngủ, server phải đang chạy thì lịch mới hoạt động.

## 6. REST API

| Phương thức | Endpoint |
|---|---|
| GET | `/api/status` |
| GET | `/api/stations` |
| GET | `/api/history` |
| GET | `/api/day?date=2026-11-22` |
| POST | `/api/collect?date=2026-11-22` |
| GET | `/api/export.csv?date=2026-11-22` |
| GET | `/api/stats?from=2026-10-01&to=2026-11-22&province=dong-thap&prize=giaidb` |

Cả `province` và `prize` trong API thống kê là bộ lọc tùy chọn. Dự án chỉ lắng nghe `127.0.0.1` theo mặc định. API không có đăng nhập, **không công khai cổng 3000 lên Internet**.

## 7. Kiểm thử và hạn chế

```bash
npm test
```

Bộ kiểm thử dùng dữ liệu giả lập, không cần MySQL thật hoặc Internet. Các chức năng kết nối MySQL thực tế và lấy API trực tiếp cần chạy kiểm tra trên máy của bạn.

Nguồn XSKT: [Dò Vé Xổ Số API](https://doveso.submit69.com/api/), API JSON của bên thứ ba không yêu cầu API key. Dữ liệu chỉ để tham khảo; kết quả có giá trị chính thức phải đối chiếu với công ty XSKT phát hành. `complete_by_provider_count` chỉ xác nhận đúng định dạng và số đài thường lệ (3 đài/ngày, thứ Bảy 4 đài), không phải xác nhận chính thức.

## 8. Cấu trúc thư mục

```text
xo_so/
├── .env.example
├── db/migrations/001_initial.sql
├── public/index.html, app.js, style.css
├── src/config.js, lottery.js, collector.js, mysql-store.js
├── src/database.js, migrate.js, history.js, scheduler.js
├── src/server.js, index.js, cli.js, store.js
├── tests/app.test.js
└── data/                 # JSON backup (git ignored)
```
