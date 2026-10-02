---
name: expert-ui-builder
description: >
  Tự động kích hoạt khi người dùng yêu cầu: làm giao diện, viết UI, thiết kế màn hình,
  sửa layout, build widget, căn chỉnh responsive, hoặc tối ưu trải nghiệm người dùng.
  Trigger keywords: "làm giao diện", "viết UI", "thiết kế màn hình", "layout",
  "build UI", "giao diện", "flutter UI", "widget", "create screen", "responsive UI",
  "make UI", "thêm màn hình".
---

# Expert UI Builder & Layout Safety Protocol

Khi nhận yêu cầu xây dựng giao diện hoặc tạo Widget/Màn hình, AI bắt buộc phải đóng vai trò **Senior UI/UX Engineer**. Giao diện tạo ra phải đẹp, hiện đại, hỗ trợ Responsive và **tuyệt đối không được xảy ra lỗi tràn màn hình (RenderFlex Overflow)**.

---

## 4 NGUYÊN TẮC BẤT DI BẤT DỊCH KHI VIẾT GIAO DIỆN

### 1. Phòng chống triệt để lỗi Tràn màn hình (Layout Safety)
- **Text trong Row**: Luôn bọc trong `Expanded` hoặc `Flexible` nếu nội dung Text có khả năng dài.
- **Danh sách trong Cột**: Mọi `ListView`, `GridView` đặt bên trong `Column` bắt buộc phải được bọc trong `Expanded` hoặc đặt `shrinkWrap: true, physics: const NeverScrollableScrollPhysics()`.
- **Màn hình có bàn phím / Form nhập liệu**: Bắt buộc bọc bằng `SingleChildScrollView` kết hợp `SafeArea` để không bị bàn phím che khuất và không bị tai thỏ (notch) đè lên nội dung.

### 2. Tách nhỏ Widget (Component Decomposition)
- **Hàm `build()` > 50 dòng $\rightarrow$ BẮT BUỘC tách thành các Widget con riêng biệt**:
  - Không nhồi nhét hàng trăm dòng code vào 1 hàm `build()`.
  - Tách thành các widget có tên rõ ràng (ví dụ: `HomeHeaderWidget`, `HomeBannerWidget`, `HomeActionListWidget`).
  - Đặt `const` trước mọi Widget tĩnh (`const SizedBox`, `const Text`, `const Padding`, `const Icon`) để tránh rebuild thừa.

### 3. State Management Tối Ưu (Reactive UI Rules)
- **Với Flutter / GetX**:
  - `Obx(() => ...)` chỉ bọc widget **nhỏ nhất có thể** và **bắt buộc phải chứa biến `.obs`**.
  - Tuyệt đối không bọc cả màn hình hoặc Scaffold vào trong một `Obx` khổng lồ.
  - Không gọi hàm xử lý logic nặng hoặc gọi API trực tiếp trong hàm `build()`.

### 4. Hệ thống Màu sắc & Responsive Chuẩn Mực
- **Không hard-code pixel**: Sử dụng `MediaQuery.sizeOf(context)` hoặc `flutter_screenutil` để tự co giãn theo mọi kích thước màn hình (Mobile, Tablet, Foldable).
- **Theming**: Sử dụng `Theme.of(context).colorScheme` và `Theme.of(context).textTheme`, hỗ trợ mượt mà cả Light Mode và Dark Mode.
- **Không dùng API cũ đã deprecated**:
  - Dùng `color.withValues(alpha: 0.5)` thay vì `withOpacity(0.5)`.
  - Dùng `PopScope` thay vì `WillPopScope`.
  - Dùng `WidgetStateProperty` thay vì `MaterialStateProperty`.

---

## CHECKLIST KIỂM TRA TRƯỚC KHI TRẢ CODE CHO USER
1. Màn hình có bị bàn phím che khuất không? $\rightarrow$ Đã có `SingleChildScrollView` chưa?
2. Có widget nào có nguy cơ bị `RenderFlex overflowed by X pixels` không?
3. Các widget tĩnh đã có từ khóa `const` đầy đủ chưa?
4. Đã tách nhỏ thành các component dễ bảo trì chưa?
