# CareerViet HR Central — API đã khảo sát (2026-10-22)

Base: `https://internal-api.careerviet.vn/api/v1`, header `Authorization: Bearer <JWT từ /api/auth/employers/check>`.
Service prefix: `es` = employer, `js` = jobs, `jss` = jobseeker, `cs` = danh mục.

**Mã hoá ID**: API dùng 2 dạng cho cùng 1 ID — số (`2312199`) và hex (`35C83107`).
`hex = (n + 900000000).toString(16).toUpperCase()`.

Schema chi tiết từng response: `docs/careerviet-schema/*.txt` (field | kiểu | tỉ lệ có giá trị | ví dụ).

## Đã xác minh (GET, chỉ đọc)

| Dữ liệu | Endpoint | Ghi chú |
|---|---|---|
| Tin tuyển dụng | `/js/emp/jobs?type=3&action={1 đang đăng,0 chờ đăng,2 tạm dừng,3 hết hạn}&date_type=0&order=DESC&user_id=` | Tin chờ đăng không có `folder_id` |
| Hồ sơ ứng tuyển theo job | `/es/emp/folder-resumes/folder-apply?folder_id=<hex>&user_id=` | Không có SĐT; có % phù hợp `job_resume_coincidence` |
| Chi tiết hồ sơ | `/jss/emp/resumes/{resume_id}/detail?folder_resume_id=<hex>` | Có SĐT, địa chỉ, ngày sinh, thư xin việc; CV online có kinh nghiệm/học vấn/kỹ năng/chứng chỉ |
| File CV (PDF) | `resume_attachment_url` trong chi tiết → `/jss/emp/resumes/{resume_id}/view-file/{jobseeker_id}` | Cần Bearer. Chỉ CV upload (`resume_kind=2`) |
| Hồ sơ đã lưu | `/es/emp/folder-resumes/search-bookmarked?user_id=` | |
| Folder hồ sơ | `/js/emp/folders/active?user_id=&sort_type=0&sort=0&page=` | |
| Thống kê | `/js/emp/job-config-campaigns/folders/stats?user_id=` | total_apply / active / expire / bookmark |
| Ứng viên mới (dashboard) | `/es/emp/employer-dashboard/new-candidates` | 10 hồ sơ mới nhất |
| Thông tin công ty/user | `/es/emp/employer-users/info` | `emp_id` |
| Chiến dịch (gợi ý AI) | `/js/emp/job-config-campaigns/folders?user_id=&type=6\|7\|8`, `/jss/emp/resumes/hr-centrals/recruitment-campaigns` | Account hiện chưa có chiến dịch → rỗng |

## Trạng thái hồ sơ (`folder_resume_status`)

0 Chưa quyết định · 3 Kiểm tra · 4 Phỏng vấn · 5 Đề xuất tuyển · 6 Nhận việc · 1 Không phù hợp · 2 Từ chối

## `resume_kind`
0 = CV online tạo trên CareerViet · 2 = CV upload file · 3 = (38 hồ sơ, chưa rõ)

## Chưa dùng / lưu ý

- **Không gọi** các API ghi: `PUT /es/emp/folder-resumes` (xoá), `/classify` (đổi trạng thái), `POST /jss/emp/resumes/{id}/...` (xem liên hệ — tốn credit).
- Gọi chi tiết hồ sơ **chưa xem** (`folder_resume_viewed=0`) có thể đánh dấu "đã xem" trên HR Central — chưa kiểm chứng.
- CV online xuất PDF qua `POST /jss/emp/resumes/{id}/export-pdf` — chưa thử.
- Tìm kho hồ sơ (`/vi/employers/tim-ung-vien/...`) render phía server, xem liên hệ tốn credit — chưa khai thác.
- `job_apply_num` có thể lệch 1–3 so với list thực tế (ứng viên xoá tài khoản / thêm tay vào folder).
