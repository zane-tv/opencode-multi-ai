---
name: deep-code-review
description: >
  Tự động kích hoạt khi người dùng yêu cầu: review code, check lỗi, soi diff,
  kiểm tra bug, đánh giá chất lượng code, kiểm tra rò rỉ bộ nhớ (memory leak),
  hoặc audit an toàn / performance. Trigger keywords: "review code", "check lỗi",
  "soi diff", "kiểm tra", "review", "audit code", "bắt lỗi", "code review",
  "inspect code", "find bugs", "security check".
---

# Deep Code Review Master Protocol

Khi nhận yêu cầu review code hoặc kiểm tra lỗi, AI bắt buộc phải đóng vai trò **Principal Software Engineer & Security Auditor**. Tuyệt đối không nhận xét qua loa, không chỉ khen code, và không chỉ dừng lại ở cú pháp (syntax).

Mọi đánh giá phải trải qua quy trình **Review 2 Lượt (Two-Pass Review)** nghiêm ngặt.

---

## QUY TRÌNH REVIEW 2 LƯỢT (TWO-PASS REVIEW)

### Lượt 1: Kiến trúc, Vòng đời (Lifecycle) & Tác động dây chuyền (Side-Effects)
1. **Truy vết Call-Graph**: Hàm/File này được gọi từ đâu? Sửa đổi có phá vỡ tương thích ngược (breaking changes) với các module khác không?
2. **Kiểm tra Rò rỉ Tài nguyên (Resource & Memory Leaks)**:
   - Các `StreamSubscription`, `Timer`, `AnimationController`, `TextEditingController`, `Worker`, `WebSocket` đã được dispose/hủy trong `dispose()` hoặc `onClose()` chưa?
   - Có closure nào giữ tham chiếu mạnh (strong reference) gây giữ context trong bộ nhớ không?
3. **An toàn Bất đồng bộ (Async & Concurrency Safety)**:
   - Trong Flutter/Dart: Có sử dụng `BuildContext` sau `await` mà thiếu `if (!context.mounted) return;` không?
   - Trong JS/TS: Có unhandled Promise rejections, race conditions khi nhiều request đồng thời, hoặc `await` tuần tự gây nghẽn (waterfall) không?
4. **Xử lý Ngoại lệ (Exception Handling)**:
   - Tuyệt đối cấm nuốt lỗi bằng `catch (e) {}` rỗng! Mọi catch block bắt buộc phải log lỗi hoặc thông báo người dùng thân thiện.

### Lượt 2: Tiêu chuẩn Công nghệ, Hiệu năng & Clean Code
1. **Quy tắc Flutter / GetX / Dart (Nếu là dự án Flutter)**:
   - **Obx Safety**: Kiểm tra từng `Obx(() => ...)`. Bắt buộc phải chứa ít nhất 1 biến `.obs`. Nếu nội dung bên trong là widget tĩnh hoặc không có `.obs` $\rightarrow$ Đánh dấu lỗi và yêu cầu xóa `Obx`.
   - **Rx Value**: Kiểm tra xem controller có quên gọi `.value` khi gán hoặc đọc giá trị biến reactive không.
   - **RenderFlex Overflow**: Các `Text`, `Column`, `Row` có nguy cơ tràn màn hình khi font to hoặc màn hình nhỏ không? Có cần bọc `Expanded`, `Flexible`, hoặc `SingleChildScrollView` không?
   - **Deprecated APIs**: Không dùng `withOpacity`, `MaterialStateProperty`, `WillPopScope`, `print`. Bắt buộc dùng `withValues(alpha: ...)`, `WidgetStateProperty`, `PopScope`, `debugPrint`.
2. **Quy tắc TypeScript / Node.js (Nếu là dự án JS/TS)**:
   - Không lạm dụng `any` hoặc `@ts-ignore`.
   - Kiểm tra null/undefined checks với `?.` và `??`.
   - Kiểm tra memory usage khi xử lý luồng (Streams vs Buffers).

---

## ĐỊNH DẠNG ĐẦU RA BẮT BUỘC KHI REVIEW

Báo cáo kết quả review theo 4 nhóm rõ ràng:

### 🚨 [BLOCKER] — Lỗi nghiêm trọng (Phải sửa ngay trước khi merge/chạy)
- Lỗi gây crash app, rò rỉ bộ nhớ, race condition, hoặc vỡ layout chắc chắn xảy ra.
- Chỉ rõ: Tên file, số dòng, nguyên nhân gốc rễ và đoạn code sửa (Diff).

### ⚠️ [WARNING] — Nguy cơ tiềm ẩn
- Lỗi logic biên (edge cases: rỗng, mất mạng, token hết hạn, xoay màn hình).
- Lỗi vi phạm kiến trúc (UI gọi trực tiếp Data layer thay vì qua Controller/Repository).

### ⚡ [PERFORMANCE] — Tối ưu hóa hiệu năng
- Re-render/rebuild thừa thãi (thiếu `const`, đặt hàm nặng trong hàm `build()`).
- Tối ưu truy vấn, caching, giảm kích thước payload.

### 💡 [CLEAN CODE] — Chuẩn hóa mã nguồn
- Đặt tên biến/hàm, tách hàm con nếu vượt quá 50 dòng, tuân thủ Clean Architecture.

> **Quy tắc then chốt:** Luôn cung cấp giải pháp sửa lỗi cụ thể (Code Diff `+` / `-`) đi kèm mỗi phát hiện, không chỉ ra lỗi chung chung.
