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
| POST | `/api/collect?date=2026-11-22&overwrite=false` |
| GET | `/api/export.csv?date=2026-11-22` |
| GET | `/api/stats?from=2026-10-01&to=2026-11-22&province=dong-thap&prize=giaidb` |
| GET | `/api/prize8/predict?date=2026-11-24&province=dong-thap` |
| GET | `/api/prize8/v2/predict?date=2026-11-24&province=dong-thap&recentWeight=35&longWeight=30&digitWeight=20&uniformShrinkage=15` |
| GET / POST | `/api/prize8/daily?date=2026-11-23` |
| GET | `/api/prize8/distribution?date=2026-11-23&province=dong-thap&recent=40&long=25&weekday=25&parity=10` |

Dashboard có mục **Quét dữ liệu theo khoảng ngày** (tối đa 10 năm/lần), hiển thị trực tiếp phần trăm, số ngày đã xử lý, số ngày/số đài đã lưu, số ngày bỏ qua và số lỗi. Trình duyệt gửi từng ngày riêng lẻ và giãn nhịp khi có gọi nguồn. Khi không chọn ghi đè, server kiểm tra MySQL trước và trả bản đã lưu mà không gọi nguồn. Khi chọn ghi đè, `overwrite=true` buộc tải lại, kiểm tra và cập nhật transaction của ngày đó. Lỗi một ngày không dừng các ngày còn lại.

Khu vực **Kết quả xổ số miền Nam** đọc ngày đã chọn từ MySQL và trình bày theo bảng dò vé truyền thống: mỗi đài là một cột, mỗi giải là một hàng. Việc đổi ngày chỉ đọc `/api/day`; không gọi lại nguồn thu thập.

Tên đài trong bảng là liên kết drill-down. Khi bấm, dashboard tải 50 kỳ/lần từ `/api/station-results`, hiển thị toàn bộ giải theo ngày và tự chọn đài đó trong phần thống kê. Nút **Tải thêm kết quả** phân trang lùi theo ngày mà không tải lại các kỳ đã hiển thị.

Cả `province` và `prize` trong API thống kê là bộ lọc tùy chọn. Dự án chỉ lắng nghe `127.0.0.1` theo mặc định. API không có đăng nhập, **không công khai cổng 3000 lên Internet**.

## 7. Kiểm thử và hạn chế

```bash
npm test
```

Bộ kiểm thử dùng dữ liệu giả lập, không cần MySQL thật hoặc Internet. Các chức năng kết nối MySQL thực tế và lấy API trực tiếp cần chạy kiểm tra trên máy của bạn.

Nguồn chính là [Dò Vé Xổ Số API](https://doveso.submit69.com/api/). Khi nguồn chính lỗi hoặc không lưu ngày lịch sử, collector tự chuyển sang [Xổ Số VN API](https://www.xosovnm.net/nguon-api), chuẩn hóa JSON về cùng hợp đồng dữ liệu rồi mới ghi MySQL. Có thể đổi hai URL bằng `XSKT_API_BASE_URL` và `XSKT_FALLBACK_API_BASE_URL`. Khi chạy với MySQL, ứng dụng mặc định **không tạo file JSON**; chỉ bật bản sao dự phòng bằng `XSKT_BACKUP_JSON=true` nếu thực sự cần. Cả hai API đều là nguồn tổng hợp bên thứ ba; kết quả có giá trị chính thức phải đối chiếu với công ty XSKT phát hành. `complete_by_provider_count` chỉ xác nhận đúng định dạng và số đài thường lệ (3 đài/ngày, thứ Bảy 4 đài), không phải xác nhận chính thức.

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


## 9. Xếp hạng thử nghiệm giải 8 theo trọng số (00–99)

Vào phần **“Xếp hạng 00–99 bằng trọng số lịch sử”** trên dashboard local, chọn **một đài XSMN**, ngày cần dự đoán và các tham số rồi nhấn **Xếp hạng giải 8**.

**Phạm vi:** chỉ dùng **giải 8** (một số có hai chữ số trong mỗi kỳ của đài đã chọn), không trộn giải đặc biệt hay các đài khác.

**Cách tính điểm:**

- Dùng tối đa **52 kỳ trước ngày dự đoán** (tùy chọn 26, 52, 104 hoặc 156 kỳ).
- Cho các kỳ gần hơn trọng số lớn hơn: kỳ gần nhất nhận trọng số `1`; lùi mỗi `H` kỳ thì trọng số giảm một nửa. Mặc định `H = 12`.
- Đếm tần suất đã làm mượt bằng pseudo-count `alpha=0.5` cho **100** số từ `00` đến `99` (tránh số ít gặp bị gán trọng số 0).
- Trộn **70%** điểm tần suất suy giảm theo thời gian với **30%** tần suất lịch sử trong cửa sổ (có thể chọn tỷ trọng 50/50, 70/30, 90/10).
- Sắp xếp và hiển thị Top 10 số có điểm cao nhất, ngày xuất hiện gần nhất và số lần xuất hiện. **Điểm là chỉ số xếp hạng, không phải xác suất trúng được hiệu chỉnh.**

**Backtest:** kiểm định tối đa 80 kỳ gần đây, tại mỗi kỳ chỉ dùng những kỳ **trước đó** để lập bảng xếp hạng rồi so sánh với giải 8 thật. Hiển thị Top 1 và Top 10 trúng bao nhiêu lần, so sánh mốc kỳ vọng của chọn ngẫu nhiên lần lượt **1%** và **10%** nếu các số là đồng xác suất và độc lập. Kết quả kiểm định lịch sử **không bảo đảm** khả năng dự đoán tương lai.

**Tối thiểu 20 kỳ của mỗi đài** mới hiển thị Top 10; nếu chưa có, dashboard báo thiếu lịch sử. Với các đài miền Nam thường có một kỳ mỗi tuần, nên nhập thử khoảng 2–3 năm dữ liệu để có đủ mẫu huấn luyện và backtest:

```bash
npm run history:import -- 2024-01-01 2024-12-31
npm run history:import -- 2025-01-01 2025-12-31
npm run history:import -- 2026-01-01 2026-11-23
```

Mỗi lệnh tối đa 366 ngày. Collector thử nguồn chính trước rồi dùng nguồn phụ cho ngày bị thiếu; ngày cả hai nguồn đều không có sẽ được báo lỗi và không làm mất dữ liệu đã lưu. Nếu chưa nhập lịch sử, ứng dụng **không tự tạo số dự đoán từ dữ liệu giả**.

**Endpoint dự đoán thử nghiệm (V1 & V2):**

```http
# V1 (mặc định, tương thích ngược)
GET /api/prize8/predict?date=2026-11-24&province=dong-thap&window=52&halfLife=12&recentWeight=70&topK=10

# V2 (đa thành phần + kiểm định đối chuẩn)
GET /api/prize8/v2/predict?date=2026-11-24&province=dong-thap&window=52&halfLife=12&recentWeight=35&longWeight=30&digitWeight=20&uniformShrinkage=15&topK=10
```

**Cải tiến ở phiên bản V2 (`v2.0.0`):**

- Kết hợp 4 thành phần chuẩn hóa (tổng trọng số bằng `100%`, mặc định `35 / 30 / 20 / 15`): tần suất suy giảm gần đây trong cửa sổ `window`, tần suất trên **toàn bộ lịch sử** trước ngày dự đoán (không cắt bỏ kỳ cũ), **biên chữ số hàng chục × hàng đơn vị (`0–9`)** giúp giảm thưa dữ liệu và hạn chế thiên lệch hòa điểm `00–09`, cùng hệ số **co về phân bố đều (`1/100`)** giảm quá khớp.
- **Kiểm định đối chuẩn 4 mô hình** trên cùng tập kỳ cuốn chiếu (`V2`, `V1`, `Tần suất thô`, `Ngẫu nhiên đều`), kèm khoảng tin cậy **Wilson 95% CI**, **Log-loss** (mốc đều `4.605`), **Brier score** (`0.99`) và **MRR** (`0.052`).
- **Kiểm tra độ phủ lịch sử** theo lịch quay từng đài XSMN (ví dụ TP.HCM 2 kỳ/tuần, các đài khác 1 kỳ/tuần) để cảnh báo khi dữ liệu bị thiếu kỳ.
- **Lưu dự đoán hằng ngày bất biến (idempotent):** khi mở dashboard, server tự xác định các đài mở thưởng hôm nay (`POST /api/prize8/daily`); đài nào chưa có Top 10 trong MySQL (và đủ tối thiểu 20 kỳ trước hôm nay) sẽ được tạo bằng V2 và lưu đúng một lần vào bảng `model_versions` và `predictions`; đài nào đã có sẽ chỉ đọc lại và **tuyệt đối không tạo lại hay sửa đổi**. Khi kết quả Giải 8 thật được thu thập, bảng tự đối chiếu và hiển thị số xổ, thứ hạng trong Top 10 và trạng thái Top 1 / Top 10.

Màn hình **Tỷ trọng thống kê từng con số** hiển thị đủ `00..99` và bốn thành phần có trọng số: tần suất suy giảm gần đây, tần suất dài hạn, tần suất các kỳ cùng thứ với ngày mục tiêu, và tỷ lệ nhóm chẵn/lẻ. Mặc định là `40/25/25/10`; tổng bắt buộc bằng 100%. Bảng có thể lọc chẵn hoặc lẻ. Đây là tỷ trọng xếp hạng thống kê, không phải xác suất trúng đã hiệu chỉnh; mốc lý thuyết của mỗi số trong kỳ quay công bằng vẫn là 1%.

Trong đó `province` là mã đài lấy từ `GET /api/stations`. API trả về bảng xếp hạng, số kỳ dùng để phân tích, mốc ngày huấn luyện cuối và kết quả backtest. Tham số ngày được lọc nghiêm ngặt: `draw_date < date`, không dùng kết quả của ngày cần dự đoán hoặc tương lai.

**Kiểm thử:**

Để so sánh các cấu hình Top 5 trên MySQL cục bộ, chạy `npm run benchmark:top5 -- 2026-06-01 2026-11-23`. Lệnh dùng tối đa 500 kỳ mỗi đài, chọn cấu hình trên các kỳ trước mốc đầu, rồi so sánh với V2 và V3 từ mốc đầu đến trước mốc cuối. Mỗi lượt chỉ dùng lịch sử của cùng đài trước ngày quay.

Các bản dự đoán hằng ngày mới dùng V4: 80% phân phối V3, 12% tương đồng lịch (thứ, ngày trong tháng, tháng) và 8% thứ tự kỳ. Backtest tách mốc `2026-06-01` trên 21 đài cho kết quả giai đoạn sau mốc là 36/559 Top 5 (6,44%, Wilson 95% từ 4,69% đến 8,79%), so với V3 là 33/559 (5,90%). Trước mốc chia, V4 thấp hơn V3 (60 so với 63 lần trúng trên 1.196 kỳ), và mốc ngẫu nhiên 5% vẫn nằm trong khoảng tin cậy; vì vậy đây chỉ là thử nghiệm, không phải bằng chứng về lợi thế dự đoán.

Bản lưu mới giữ cả thứ tự 100 số trong metadata và vẫn trả 10 mục trong `top`. API hằng ngày trả `actualRank` và `top5Hit`. Bản lưu cũ chỉ xác định hạng nếu số xổ nằm trong 10 mục đã lưu. Endpoint V3 hỗ trợ `includeRanking=true` để trả thêm `forecast.ranking`. Màn hình Top 5 dùng phép tính này khi ngày được chọn chưa có bản lưu và ghi rõ đó là kết quả tính lại.

## Chạy trên máy chủ và lưu JSON dự phòng

### GitHub Pages

Trên địa chỉ `*.github.io`, giao diện tự chọn dữ liệu JSON. Bản chạy qua `npm start` dùng API MySQL và cơ chế lưu dự phòng. Lệnh `npm run build:pages` xuất trang tĩnh vào `pages-dist/`, lấy kết quả từ bản backup và các file ngày trong thư mục `data/`. Chỉ dữ liệu kết quả được đưa vào gói trang tĩnh.

Trong cài đặt Pages của repo, chọn nguồn **GitHub Actions** rồi chạy workflow **Deploy JSON dashboard to GitHub Pages**. Mỗi lần xuất bản lấy dữ liệu có trong checkout của workflow. Để đổi bản dữ liệu gốc khi build tại máy, truyền đường dẫn backup qua `npm run build:pages -- <file-json>`.

GitHub Pages đọc bộ dữ liệu đã xuất bản. Top 5 V4 tính trong trình duyệt dựa trên kết quả trước ngày được chọn và được hiển thị dưới nhãn tính lại để đối chiếu. Để đưa kết quả mới lên trang, cập nhật dữ liệu nguồn và xuất bản lại.

Chạy `npm ci` và `npm start` trên máy chủ Node.js. Đặt `HOST=0.0.0.0` nếu nền tảng yêu cầu và gắn ổ đĩa lưu trữ bền vững vào thư mục `XSKT_DATA_DIR`. Chạy một tiến trình ứng dụng trên ổ này. Khi triển khai qua proxy, cấu hình HTTPS và giới hạn quyền truy cập các API ghi dữ liệu.

Khi MySQL gặp lỗi kết nối, ứng dụng và lệnh `npm run collect` lưu kết quả vào `XSKT_DATA_DIR/YYYY-MM-DD.json`. Danh sách lịch sử và API xem kết quả đọc được các ngày dự phòng. Khi MySQL phục hồi, lần ghi tiếp theo dùng lại MySQL. Thống kê và dự đoán vẫn cần MySQL, và các tệp dự phòng chưa được đồng bộ tự động vào cơ sở dữ liệu.

```bash
npm test
```

Có thêm test cho thuật toán trọng số, giữ số 0 đầu, backtest không rò rỉ dữ liệu tương lai, truy vấn MySQL giải 8 theo đài và API.

> **Quan trọng:** xổ số là trò chơi ngẫu nhiên. Một mẫu lịch sử, dù có trọng số gần đây, có thể chỉ phản ánh nhiễu. Không dựa vào bảng xếp hạng để khẳng định khả năng thắng hoặc sử dụng như lời khuyên tài chính.

### Đồng bộ JSON khi mở GitHub Pages (không cron)

Worker chỉ đọc/ghi `data/YYYY-MM-DD.json` của ngày hiện tại theo giờ Việt Nam. Nếu trang đã có đủ đài và đủ giải thì không gọi Worker; nếu Worker đọc được file đủ kết quả thì không gọi nguồn xổ số. Từ 17:00, dữ liệu thiếu được bổ sung từ nguồn hiện có; kết quả đã hợp lệ được giữ nguyên. Không ghi file rỗng hoặc commit khi không có kết quả mới. GitHub Contents API dùng SHA để tránh ghi đè khi có nhiều lượt truy cập. Cache 5 phút theo điểm hiện diện Cloudflare và trong trình duyệt, không phải giới hạn toàn cầu.

Cài đặt một lần:
1. Tạo GitHub fine-grained personal access token chỉ cho `hanfun/xo_so` với quyền Contents: Read and write. Không đưa token vào frontend, file cấu hình, hay commit.
2. Từ thư mục dự án, chạy `npx wrangler login`, rồi `npx wrangler deploy --config worker/wrangler.toml`.
3. Chạy `npx wrangler secret put GITHUB_TOKEN --config worker/wrangler.toml` và nhập token tại prompt.
4. Điền URL Worker thực tế vào `public/pages-sync-config.js` (chỉ URL, không có token), commit và push. Workflow Pages tự build lại. Cần cho phép Pages deploy từ GitHub Actions.
5. Mở index.html hoặc today.html sau 17:00. Worker trả kết quả ngay sau khi lưu; push dữ liệu bằng PAT sẽ kích hoạt Pages build để cập nhật lịch sử. Kiểm tra tab Actions và thư mục data/. CORS chỉ cho origin https://hanfun.github.io; kiểm tra Origin không phải xác thực chống bot. Với lưu lượng lớn cần rate limit ở Cloudflare.

Mặc định URL Worker để trống cho tới khi deploy thật; site vẫn đọc JSON đã xuất bản. Không ảnh hưởng MySQL local. `.gitignore` vẫn bỏ qua backup MySQL/JSON local; Worker dùng Contents API để ghi đúng file ngày, không upload backup database. Không tự backfill ngày cũ. Worker không chứa lịch chạy định kỳ. Nguồn bên thứ ba có thể chưa sẵn sàng hoặc lỗi; khi đó giữ dữ liệu hiện có và thử lại sau khoảng 5 phút.

### Dự phòng trình duyệt khi chưa có Worker

Nếu JSON hôm nay thiếu, sau 17:00 Pages thử nguồn trực tiếp bằng GET CORS (nguồn chính rồi nguồn phụ khi lỗi). Kết quả hợp lệ lưu theo ngày trong LocalStorage, hoặc bộ nhớ phiên nếu trình duyệt chặn lưu. Không gửi lại khi ngày đã đủ; lần thử thất bại được giới hạn 5 phút trên trình duyệt. Không thể ghi repository từ trình duyệt; chỉ Worker đã cấu hình mới lưu file lên GitHub. Nếu API chặn CORS, giao diện báo lỗi và giữ dữ liệu đã có. CI mock nguồn ngoài; CORS thực tế cần kiểm tra trên trình duyệt.
