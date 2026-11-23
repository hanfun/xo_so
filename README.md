# XSKT Local — Xổ số kiến thiết 3 miền (Node.js)

Ứng dụng Node.js chạy **local**, dùng để thu thập, lưu và hiển thị kết quả xổ số kiến thiết **Bắc / Trung / Nam** theo ngày, có lịch quét tự động, nút quét thủ công và xuất dữ liệu CSV. **Không bao gồm Vietlott.**

## Bắt đầu nhanh

Yêu cầu **Node.js 20+**. Clone repository và chạy:

```bash
git clone https://github.com/hanfun/xo_so.git
cd xo_so
npm start
```

Mở **http://127.0.0.1:3000** trong trình duyệt. Không cần `npm install` vì dự án không dùng thư viện bên ngoài. Nhấn `Ctrl+C` để dừng.

Kiểm thử:

```bash
npm test
```

Chạy lấy dữ liệu thủ công từ terminal:

```bash
npm run collect -- 2026-11-22
npm run collect -- 2026-11-22 --yesterday
```

## Chức năng

- Giao diện responsive, lọc theo ngày và 3 miền, hiển thị đài và tất cả các giải thưởng.
- Nút **Quét kết quả** gọi API, kiểm tra tính hợp lệ của số giải và giữ số 0 đầu.
- Lưu **JSON theo ngày** trong thư mục `data/YYYY-MM-DD.json`, tránh ghi trùng trong 5 phút.
- Xuất **CSV** bằng giao diện để mở trong Excel.
- Không thay thế dữ liệu đã hợp lệ bằng dữ liệu thiếu từ nguồn vào các lượt sau.
- Cảnh báo nếu dữ liệu chưa khớp số đài/giải theo thông tin API.

## Lịch chạy khi Node.js đang mở

| Giờ Việt Nam (Asia/Ho_Chi_Minh) | Việc thực hiện |
| --- | --- |
| 19:15 | Quét kết quả ngày hiện tại |
| 20:00 | Kiểm tra bổ sung |
| 21:00 | Kiểm tra bổ sung |
| 07:30 sáng hôm sau | Quét bù ngày trước |

Bộ lập lịch nằm tại `src/scheduler.js` và tự kiểm tra mỗi 20 giây. **Máy phải bật, không ngủ và tiến trình `npm start` đang chạy**. Khi khởi động, ứng dụng còn thử tải ngày kết quả gần nhất. Không cần tạo cron mới mỗi ngày.

Để chạy 24/7, triển khai Node trên VPS hoặc cấu hình dịch vụ tự khởi động ở hệ điều hành (Windows Task Scheduler / systemd / launchd).

## REST API local

| Method | Endpoint | Ý nghĩa |
| --- | --- | --- |
| GET | `/api/status` | Thời gian, lịch quét, miền |
| GET | `/api/day?date=2026-11-22` | Dữ liệu một ngày |
| POST | `/api/collect?date=2026-11-22` | Quét và cập nhật |
| GET | `/api/history` | Các ngày đã lưu |
| GET | `/api/export.csv?date=2026-11-22` | Xuất CSV |

## Tùy chỉnh

- `PORT=3500 npm start` đổi cổng (PowerShell: `$env:PORT=3500; npm start`).
- `XSKT_DATA_DIR` đổi thư mục lưu.
- `XSKT_API_BASE_URL` đổi URL nguồn API **cùng cấu trúc JSON**; nguồn khác định dạng cần sửa adapter `src/lottery.js`.
- `HOST=0.0.0.0` cho phép truy cập từ mạng LAN tin cậy. Mặc định chỉ lắng nghe `127.0.0.1`; không có đăng nhập, **không mở trực tiếp ra Internet**.

## Nguồn dữ liệu và giới hạn

Nguồn mẫu: [Dò Vé Xổ Số](https://doveso.submit69.com/) — API bên thứ ba `https://doveso.submit69.com/api/YYYY-MM-DD.json`.

Đây **không phải** dữ liệu được công ty XSKT chính thức chứng nhận. `status=complete_by_provider_count` chỉ có nghĩa là bộ giải đúng cấu trúc và đủ số đài mà nhà cung cấp API thông báo; **không** khẳng định kết quả đúng với nguồn mở thưởng chính thức. Hãy đối chiếu với các công ty xổ số khi sử dụng để dò vé hoặc công bố lại. Khả năng lấy dữ liệu phụ thuộc vào sự sẵn sàng của API bên thứ ba.

Dữ liệu thật từ mạng chưa nằm trong bộ kiểm thử tự động; `npm test` dùng dữ liệu giả lập.

## Cấu trúc

```text
public/             # HTML, CSS, JS dashboard
src/config.js       # thiết lập và giờ Việt Nam
src/lottery.js      # lấy API và kiểm tra dữ liệu giải thưởng
src/collector.js    # quét, cache, kết hợp dữ liệu
src/store.js        # lưu JSON / xuất CSV
src/scheduler.js    # lịch quét hằng ngày
src/server.js       # HTTP server và REST API
src/index.js        # entrypoint của npm start
src/cli.js          # quét thủ công từ lệnh npm run collect
tests/app.test.js   # 9 tests
data/               # JSON local (được .gitignore)
```
