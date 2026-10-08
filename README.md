# CamĐóngHàng

Ứng dụng quay video đóng hàng, đọc mã vận đơn, QR và mã vạch ngay trên máy.
Phát triển bởi @luudhung.

## Chạy trên Windows

Giải nén toàn bộ vào một thư mục có quyền ghi, rồi bấm đúp
`run_CamDongHang-win.bat`. Dùng Windows 10/11 64-bit Intel/AMD và Chrome/Edge.
Lần đầu tự chuẩn bị Python riêng trong `.runtime`, lần sau dùng lại.
Không cần Python hệ thống, pip, Node.js, npm hoặc quyền quản trị.

## Chạy trên macOS

Giải nén toàn bộ, rồi mở `run_CamDongHang-mac.command`. File này dành cho
Mac Intel và Apple Silicon; tự chọn và chuẩn bị Python đúng kiến trúc.
Nếu file tải từ GitHub chưa có quyền chạy, mở Terminal tại thư mục ứng dụng:

```sh
chmod +x run_CamDongHang-mac.command
./run_CamDongHang-mac.command
```

Nếu macOS yêu cầu xác nhận ứng dụng tải từ Internet, xem và cho phép file
trong System Settings → Privacy & Security. Dùng Chrome/Edge và cấp quyền
Camera cho trình duyệt. Bộ khởi động macOS đã được kiểm tra cú pháp và luồng
thiết lập bằng môi trường giả lập; chưa chạy thử trên máy Mac thật.

## Camera và ghi hình

Một server ở `http://localhost:8080` quản lý tất cả camera thật được trình duyệt
nhận diện. Gắn 2 camera thì có 2 thiết bị, gắn 4 thì có 4; không cần các file
CAMERA12/CAMERA34. Camera laptop tích hợp cũng nằm trong danh sách.
Camera phụ được ghép PiP có thể được ẩn khỏi lưới để hiển thị chung với camera chính.

Khi cắm/rút camera, ứng dụng tự cập nhật danh sách. Nếu đang quay, ứng dụng chờ
tất cả phiên quay dừng rồi mới cập nhật để tránh ngắt bản ghi đang chạy.
Rút chính camera đang quay vẫn làm mất nguồn hình của camera đó.
Số camera quay đồng thời phụ thuộc thiết bị, băng thông USB và cấu hình máy.

Video lưu trong `Videos` theo mặc định. Đọc mã dùng WASM đi kèm trong `public/vendor`.
WhatsApp đã tắt ở cả hai launcher, không cài thêm thư viện bot.
Dòng tác giả chỉ xuất hiện ở cuối Cài đặt, không chèn vào video.

## Dữ liệu và bộ cài

Giữ nguyên thư mục `public` và `installer` cùng các file khởi động.
Bộ cài có sẵn các archive Python thì chuẩn bị lần đầu không cần Internet.
Nếu thiếu archive đúng hệ điều hành, launcher tải đúng bản đã ghim và kiểm tra SHA-256.
Nguồn và giấy phép thư viện được ghi trong `installer/PYTHON-SOURCE.txt` và `public/vendor/zxing/LICENSE`.

`camera_config.json`, video, runtime, tài khoản và API key không được đưa lên GitHub.
Khi chạy bản tải mới, ứng dụng tự dùng cấu hình mặc định; có thể sao chép
`camera_config.example.json` thành `camera_config.json` để chỉnh trước khi chạy.
Không chép cấu hình riêng của máy cũ lên repository công khai.

Tham số kiểm tra mà không mở server:

```powershell
.\run_CamDongHang-win.bat -CheckOnly
```

```sh
./run_CamDongHang-mac.command --check-only
```
