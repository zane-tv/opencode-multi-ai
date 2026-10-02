---
name: deep-codebase-navigator
description: >
  Tự động kích hoạt khi người dùng yêu cầu: đọc code, tìm hiểu luồng dữ liệu,
  khảo sát codebase, tra cứu hàm/biến, giải thích cách hoạt động của hệ thống,
  hoặc phân tích kiến trúc dự án lớn. Trigger keywords: "đọc code", "tìm hiểu",
  "khảo sát", "đọc hiểu", "tra cứu", "tìm luồng", "read code", "trace code",
  "explore codebase", "understand architecture".
---

# Deep Codebase Navigator Protocol

Khi nhận yêu cầu đọc hiểu hoặc khảo sát dự án, AI bắt buộc phải áp dụng quy trình **Điều hướng Mã nguồn Chuyên sâu (Deep Navigation)** để thấu hiểu trọn vẹn bức tranh tổng thể, tránh việc đọc ngắt quãng, thiếu sót hoặc làm ngợp context.

---

## 4 NGUYÊN TẮC VÀNG KHI ĐỌC CODE

### 1. Tuyệt đối cấm "Đọc vụn vặt" (No Micro-Chunk Reads)
- **Không** gọi tool đọc 20–30 dòng nhiều lần liên tiếp một cách mù quáng.
- **Phải** đọc trọn vẹn cả hàm, cả class, hoặc toàn bộ file liên quan (đặc biệt khi Antigravity/Gemini hỗ trợ context lên đến 1M–2M tokens). Việc đọc trọn vẹn giúp nắm bắt đầy đủ biến toàn cục, imports, và logic bao bọc.

### 2. Quy trình "Top-Down" (Từ Tổng quan đến Chi tiết)
1. **Bước 1: Sơ đồ thư mục & Điểm bắt đầu (Entry points)**
   - Xác định file cấu hình (`pubspec.yaml`, `package.json`, `build.gradle`).
   - Xác định file routes/navigation (`m_routes.dart`, `AppPages`, `router.ts`).
2. **Bước 2: Tìm kiếm biểu tượng (Symbol & Dependency Tracing)**
   - Sử dụng `grep_search` hoặc `ripgrep` để tìm chính xác nơi hàm/class được định nghĩa và tất cả các nơi đang gọi nó.
3. **Bước 3: Dựng bản đồ luồng dữ liệu (Data Flow Mapping)**
   - Dữ liệu đi từ đâu: `API / Local Storage` $\rightarrow$ `Repository` $\rightarrow$ `Use Case / Service` $\rightarrow$ `Controller (State)` $\rightarrow$ `UI View (Widget/Page)`.

### 3. Đối chiếu Kiến trúc chuẩn (Architectural Sanity Check)
Khi đọc code, AI phải liên tục tự đặt câu hỏi phản biện:
- Code có tuân thủ cấu trúc Feature-First không?
- Controller có đang gọi trực tiếp API mà bỏ qua Repository không?
- UI có đang chứa heavy business logic không?
- Các barrel files (`index.ts`, `part / part of`) có được tổ chức sạch sẽ không?

---

## ĐỊNH DẠNG TÓM TẮT BÁO CÁO SAU KHI ĐỌC CODE

Mỗi khi giải thích hoặc tóm tắt luồng code, AI phải cung cấp:
1. **Sơ đồ luồng (Flowchart / Sequence bằng Mermaid hoặc bullet points rõ ràng)**: Thể hiện rõ các bước dữ liệu chạy qua từng tầng.
2. **Các điểm then chốt (Key Touchpoints)**: Danh sách file kèm số dòng chứa logic quan trọng.
3. **Cảnh báo kiến trúc (Architectural Warnings)**: Những chỗ code chưa tối ưu, tiềm ẩn rủi ro hoặc vi phạm convention của dự án.
