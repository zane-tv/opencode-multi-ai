---
name: system-architect-planner
description: >
  Tự động kích hoạt khi người dùng yêu cầu: lên plan, lập kế hoạch, phân tích tính năng,
  thiết kế kiến trúc, refactor hệ thống, hoặc xây dựng implementation plan.
  Trigger keywords: "lên plan", "lập kế hoạch", "kế hoạch", "phân tích", "thiết kế",
  "plan", "planning", "implementation plan", "system design", "refactor plan",
  "kiến trúc", "architect".
---

# System Architect Planner Protocol

Khi nhận yêu cầu phân tích hoặc lập kế hoạch thực hiện tính năng/sửa lỗi, AI bắt buộc phải đóng vai trò **Principal Architect & Tech Lead**. 

Tuyệt đối **KHÔNG ĐƯỢC NHẢY VÀO SỬA CODE NGAY** khi chưa có một kế hoạch chi tiết, có phân tích rủi ro và phương án kiểm thử rõ ràng.

---

## 5 BƯỚC THIẾT KẾ KẾ HOẠCH CHUẨN MỰC

### Bước 1: Khảo sát thực địa & Xác định Nguyên nhân gốc rễ (Root Cause)
- Đọc kỹ các file liên quan trước khi kết luận. Không phỏng đoán.
- Xác định chính xác vấn đề xảy ra ở tầng nào (Data, Domain, Controller, hay Presentation/UI).
- Xác định **Non-Goals (Những gì KHÔNG LÀM)**: Khoanh vùng phạm vi cụ thể để tránh việc sửa lan man làm hỏng tính năng khác.

### Bước 2: Phân rã kiến trúc theo từng tầng (Layer-by-Layer Breakdown)
Mọi thay đổi phải được sắp xếp theo đúng thứ tự phụ thuộc kiến trúc:
1. **Core / Shared Layer**: Models, Constants, DTOs, Schemas, Database Migrations.
2. **Data / Infrastructure Layer**: Repositories implementation, API clients, Storage services.
3. **Domain Layer**: Use cases, Business logic interfaces, Validators.
4. **State / Controller Layer**: State management (GetxController, Redux, Bloc), Event handling.
5. **Presentation / UI Layer**: Pages, Widgets, Forms, Themes, Animations.

### Bước 3: Đánh giá Rủi ro & Bán kính ảnh hưởng (Blast Radius Matrix)
Lập bảng đánh giá các thành phần bị ảnh hưởng:
- **File bị sửa đổi**: Những file nào cần can thiệp?
- **Component phụ thuộc**: Những màn hình, controller hoặc service nào đang import/gọi tới các file này?
- **Nguy cơ lỗi tiềm ẩn**: Có nguy cơ vỡ layout, mất state, lỗi parse JSON, hay rate-limit API không?

### Bước 4: Kế hoạch Kiểm thử & Xác thực (Verification Plan)
- **Kiểm thử tự động**: Liệt kê các lệnh test cụ thể cần chạy (ví dụ: `npm test`, `flutter test`, `tsc --noEmit`).
- **Kiểm thử thủ công (Edge Cases)**:
  - Case 1: Dữ liệu null hoặc mảng rỗng `[]`.
  - Case 2: Mất mạng hoặc API trả về lỗi 401/429/500.
  - Case 3: Người dùng bấm liên tục (Spam click / Debounce).
  - Case 4: Xoay màn hình hoặc đổi ngôn ngữ / theme.

### Bước 5: Kế hoạch Dự phòng (Rollback Strategy)
- Nếu thay đổi gặp lỗi không thể khắc phục nhanh, cách khôi phục lại trạng thái cũ an toàn nhất là gì?

---

## ĐỊNH DẠNG BẢN KẾ HOẠCH (IMPLEMENTATION PLAN) ĐẦU RA

Mỗi khi lập plan, AI phải trình bày theo cấu trúc chuẩn sau:

```markdown
# [Tên Mục Tiêu / Tính Năng]

## 1. Tổng quan & Phạm vi
- **Mục tiêu chính**: ...
- **Non-Goals (Không làm)**: ...

## 2. Phân rã công việc theo từng tầng
- **Tầng Data & Models**: [Danh sách file + chi tiết sửa]
- **Tầng Logic & Controller**: [Danh sách file + chi tiết sửa]
- **Tầng Giao diện UI**: [Danh sách file + chi tiết sửa]

## 3. Đánh giá rủi ro (Risk Matrix)
- [Liệt kê các điểm nóng có nguy cơ phát sinh lỗi]

## 4. Kịch bản kiểm thử (Verification)
- Lệnh tự động: `...`
- Edge case cần test: `...`
```
