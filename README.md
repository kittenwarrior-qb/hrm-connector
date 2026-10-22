# hrm-connector

Middleware đồng bộ **tin tuyển dụng** và **hồ sơ ứng tuyển** từ nhiều nguồn / nhiều account
(bắt đầu với CareerViet) vào **bảng chờ** của Odoo (module `satori_recruitment_jobboard` trong
repo satori_erp). Không có database riêng. Đăng nhập / OTP / cookie của trang tuyển dụng nằm ở
đây, **không** nằm trong ERP.

```
CareerViet acc 1 ─┐                                       ┌ Tin đăng tuyển  (gắn phiếu yêu cầu)
CareerViet acc 2 ─┼─> hrm-connector ──JSON-RPC──> Odoo ───┤
(ITviec, ... sau) ┘        ▲                              └ Hồ sơ chờ xử lý ──[HR: Đẩy thành ứng viên]──> hr.applicant
                           └──── POST /contacts (lấy email lúc HR bấm đẩy) ◀──┘
```

## Cách đồng bộ

| Dữ liệu nguồn | Odoo | Quy tắc |
|---|---|---|
| Tin tuyển dụng | `satori.jobboard.posting` | Upsert theo (nguồn, account, mã tin). HR gắn tin với **phiếu yêu cầu đã duyệt**; sync không bao giờ ghi đè |
| Hồ sơ ứng tuyển | `satori.jobboard.application` | Upsert theo (tin, mã hồ sơ). **Không gửi email/SĐT.** Trạng thái xử lý (chờ / đã đẩy / bỏ qua) là của HR |
| Ứng viên thật | `hr.applicant` | **Chỉ tạo khi HR bấm "Đẩy thành ứng viên"** trong Odoo |

- Chỉ đồng bộ tin còn chạy + tin hết hạn trong `SYNC_WINDOW_DAYS` ngày (mặc định 90). Odoo tự dọn
  hồ sơ chưa đẩy của tin hết hạn lâu hơn ngưỡng này.
- User Odoo dùng để kết nối: user **tích hợp** có nhóm *Tuyển dụng: Đồng bộ tin & hồ sơ nguồn ngoài*,
  được phép mọi công ty — chỉ ghi được bảng chờ, không đụng ứng viên.
- Bên Odoo cấu hình `satori_recruitment_jobboard.connector_url` + `connector_api_key` (= `API_KEY` ở đây)
  để nút "Đẩy" lấy được email.

## Cài đặt

```bash
npm ci
cp .env.example .env                 # điền ODOO_*, API_KEY
cp accounts.example.json accounts.json   # điền account các nguồn
npm run build
```

- `ODOO_API_KEY`: Odoo → avatar → My Profile/Preferences → Account Security → New API Key.
- `accounts.json`: mỗi account cần `id` cố định (a-z, 0-9, `_`). **Đổi `id` sẽ sinh bản ghi mới trong Odoo.**

## Vận hành hằng ngày

| Việc | Ở đâu | Tần suất |
|---|---|---|
| Kéo tin + hồ sơ mới từ CareerViet | connector, theo `SYNC_CRON` | mặc định 15 phút/lần, 7h–21h giờ VN (`SYNC_TZ`) + 1 lần khi khởi động |
| Đồng bộ ngay | Odoo → Nguồn tuyển dụng → nút **Đồng bộ ngay** | khi cần |
| Màn Odoo tự cập nhật số liệu | trình duyệt | mỗi 60 giây; khi đang đồng bộ thì 5 giây/lần, tự tải lại lúc xong |
| Làm mới access token CareerViet | connector tự gọi `/api/auth/employers/refresh` | ~mỗi giờ |
| Nhập OTP (nếu tài khoản bật 2FA) | Odoo hiện ô nhập OTP ngay trên trang khi cần | chỉ khi phiên đăng nhập hết hạn |

**Tài khoản & mật khẩu CareerViet** chỉ nằm trong `accounts.json` trên máy chạy connector (quyền file 600,
không commit) — không lưu trong Odoo. Đổi mật khẩu: sửa `accounts.json` → `pm2 restart hrm-connector`
→ nếu báo cần OTP thì nhập trên Odoo. Thêm tài khoản (vd. pháp nhân khác): thêm 1 phần tử vào mảng.

## Chạy trên VPS bằng PM2

```bash
npm i -g pm2
npm ci && npm run build
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup          # tự chạy lại khi VPS reboot
pm2 logs hrm-connector
```

Cập nhật code: `git pull && npm ci && npm run build && pm2 reload hrm-connector`.

> Chỉ chạy **1 instance** (fork mode). Scheduler nằm trong process; chạy cluster sẽ sync trùng.
> Nên đặt sau Nginx + HTTPS, hoặc chỉ bind nội bộ nếu không cần gọi API từ ngoài.

## API

Mọi route `/api/*` cần header `x-api-key: <API_KEY>`.

| Method | Path | Mô tả |
|---|---|---|
| GET | `/health` | Health check (không cần key) |
| GET | `/api/odoo/ping` | Kiểm tra kết nối/đăng nhập Odoo |
| GET | `/api/accounts` | Danh sách account + trạng thái sync gần nhất |
| GET | `/api/accounts/:id` | Trạng thái 1 account |
| POST | `/api/accounts/:id/sync` | Chạy sync 1 account (nền, trả 202) |
| POST | `/api/sync` | Sync tất cả account |
| POST | `/api/accounts/:id/otp` | Gửi mã OTP `{"code":"123456"}` khi account bật 2FA, xác thực xong tự sync |
| POST | `/api/accounts/:id/contacts` | Odoo gọi lúc đẩy: `{"folders":[{"folderRef","ids"}]}` → `{"emails":{id: email}}` |
| POST | `/api/accounts/:id/relogin` | Xoá phiên đã lưu, đăng nhập lại từ đầu |

`status` của account: `idle` · `running` · `ok` · `error` · `otp_required`.

### Luồng OTP (account bật xác thực 2 lớp)

1. Sync chạy (theo lịch hoặc gọi tay) → CareerViet gửi OTP về email, account chuyển `otp_required`.
2. `curl -X POST -H "x-api-key: $KEY" -H "content-type: application/json" -d '{"code":"123456"}' http://localhost:3000/api/accounts/cv_satori/otp`
3. Cookie phiên được lưu ở `data/cookies/<id>.json`, các lần sync sau không cần OTP nữa cho tới khi phiên hết hạn.

Khi đang chờ OTP, các lần sync theo lịch sẽ **không** đăng nhập lại (tránh spam OTP mới).
Nếu mã cũ đã hết hạn, gọi `/relogin` để lấy mã mới.

## Thêm nguồn mới

1. Tạo `src/sources/<nguon>/connector.ts` implement `SourceConnector` (`fetchJobs`, `fetchApplicants`), trả dữ liệu chuẩn hoá.
2. Thêm vào `SourceType` trong `src/config.ts`, `SOURCE_LABEL` trong `src/odoo/sink.ts` và `createConnector` trong `src/sources/registry.ts`.

Phần đẩy vào Odoo dùng lại nguyên vẹn.

## Chưa làm / cần xác minh

- Theo quyết định: SĐT không đồng bộ, HR mở link hồ sơ gốc để lấy. Chưa đính kèm **file CV**.
- Đã chạy thật với CareerViet + Odoo 18 dev (75 tin, 1.301 hồ sơ; chạy lại không trùng). Chưa chạy trên staging/prod.
- Hồ sơ **gợi ý** (kho hồ sơ) nằm ngoài phạm vi: xem liên hệ tốn credit.
