# CamDongHang Web

Ứng dụng Next.js + TypeScript quay video đóng hàng, đọc QR/mã vạch tại trình duyệt. Phát triển bởi **@luudhung**.

Website: https://camdonghang.vercel.app

## Sử dụng

1. Mở bằng Chrome hoặc Edge trên máy có camera. Cho phép camera khi trình duyệt hỏi.
2. Vào **Lưu trữ → Chọn thư mục lưu**. Mỗi video được ghi ra thư mục sau khi dừng hoặc chuyển vận đơn. Nếu chưa chọn thư mục, trình duyệt tải video xuống; có thể cần cho phép tải nhiều file.
3. Đăng nhập Google nếu muốn đồng bộ cài đặt/thông tin video. Chọn **Kết nối Google Drive**, sau đó bật **Tự tải video mới lên Drive**.
4. Gắn thêm camera rồi bấm Refresh. Số camera nhận được phụ thuộc thiết bị, quyền trình duyệt và băng thông USB; 4 camera 1080p không bảo đảm 30fps trên mọi máy.

Quay và quét dùng tài nguyên máy người dùng. Vercel cung cấp giao diện và xử lý OAuth; **dữ liệu video không đi qua Vercel/Supabase**. Upload video chạy trực tiếp từ trình duyệt lên Drive của người dùng. Supabase chỉ giữ tài khoản, cài đặt và metadata có RLS theo `auth.uid()`.

Video hoàn tất được giữ dự phòng trong IndexedDB trước khi lưu/upload. Đừng xóa dữ liệu trình duyệt hoặc dùng chế độ ẩn danh cho công việc cần lưu lâu dài. Hết dung lượng/quyền thư mục/mất mạng được báo lỗi và giữ bản dự phòng khi có thể. Quay rất dài vẫn dùng RAM cho MediaRecorder; hãy kết thúc từng đơn và lưu thường xuyên. Ứng dụng không phát trực tiếp các đoạn video đang quay lên Drive.

Chrome/Edge hỗ trợ chọn thư mục. Trình duyệt khác có thể chỉ hỗ trợ tải file xuống. Quay nhiều camera, PiP hoặc tab chạy nền có thể giảm FPS. Không thể cam kết FPS chỉ từ cấu hình CPU: camera, cổng USB, độ sáng/phơi sáng, encoder và trình duyệt đều ảnh hưởng.

## Chạy mã nguồn

Yêu cầu Node.js 24 LTS, npm; không cần Python.

```powershell
npm ci
Copy-Item .env.example .env.local
# Điền biến môi trường của riêng bạn.
npm run dev
```

Mở `http://localhost:3000`. Kiểm tra:

```powershell
npm test
npm run typecheck
npm run build
npm start
```

`npm test` kiểm tra storage thật với fake IndexedDB và mô phỏng mạng: cách ly tài khoản, giữ video khi upload lỗi, khóa upload giữa các cửa sổ, tiếp tục sau khi Drive nhận một phần, bảo vệ thao tác giải phóng cache. Kiểm thử này không giả vờ xác nhận camera USB thực tế.

## Thiết lập dịch vụ

### Supabase

Chạy `supabase/migrations/202610080001_initial.sql` trong SQL Editor. Bật Google provider với OAuth client ID và secret. Site URL là URL production; allowlist redirect:

```text
https://camdonghang.vercel.app/auth/callback
http://localhost:3000/auth/callback
```

Đặt URL và publishable key vào `.env.local` và Vercel. Publishable key được phép gửi xuống frontend; không dùng service-role key ở frontend. Schema không lưu video hay Google refresh token.

### Google Cloud / Google Auth Platform

Tên project và Application name trong Branding: **CamDongHang**. Tạo Web OAuth client, bật Drive API, cấu hình External và trạng thái xuất bản phù hợp. Các scope sử dụng: `openid`, `email`, `profile` cho đăng nhập; thêm `https://www.googleapis.com/auth/drive.file` khi kết nối Drive. Không xin quyền đọc toàn bộ Drive.

Authorized redirect URIs:

```text
https://<PROJECT_REF>.supabase.co/auth/v1/callback
https://camdonghang.vercel.app/api/drive/callback
http://localhost:3000/api/drive/callback
```

Đăng nhập và kết nối Drive là hai thao tác riêng. Người dùng có thể chọn Drive khác tài khoản đăng nhập. Google có thể yêu cầu xác minh thương hiệu/domain để hiển thị tên đầy đủ trên mọi màn hình OAuth; đặt tên trong console không tự thay thế quy trình xác minh của Google.

### Vercel

Import đúng **branch `vercel`** của repo; branch `main` là bản offline Python. Framework Next.js, build command `npm run build`. Hoặc triển khai từ thư mục này bằng Vercel CLI:

```powershell
npx vercel --prod
```

Đặt đủ biến trong `.env.example`. `APP_ORIGIN` phải khớp chính xác origin production (không dùng URL preview cho callback production). `TOKEN_ENCRYPTION_KEY` là 32 byte ngẫu nhiên dạng base64:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Giữ Google client secret và encryption key ở server env. Cookie Drive được mã hóa AES-256-GCM, HttpOnly, SameSite=Lax, Secure trên HTTPS và gắn với user ID. Đổi encryption key sẽ yêu cầu người dùng kết nối Drive lại. OAuth state có hạn 10 phút; endpoint token kiểm tra Origin và xác thực Supabase JWT.

## Cấu trúc

- `src/components/workspace.tsx`: giao diện React, tài khoản, lưu trữ.
- `src/studio/bridge.ts`: nối bộ quay camera với storage trình duyệt.
- `src/lib/storage.ts`: IndexedDB, thư mục máy, upload resumable Drive 8MiB/chunk và Web Locks.
- `src/app/api/drive/*`: OAuth và làm mới access token, không nhận video.
- `public/studio/*`: bộ quay và scanner Web Worker, WASM local; không gọi CDN giải mã.

Camera nằm trong iframe cùng origin để cập nhật React không chen vào vòng vẽ từng frame. Bộ scanner chia lượt công bằng giữa camera, ưu tiên QR vận đơn hợp lệ, bỏ URL quảng cáo và tăng độ chi tiết khi quét hụt. Các mẫu vận đơn thật dùng kiểm thử nằm ngoài repo và không được deploy.

Muốn nhập lại engine từ bản offline:

```powershell
node scripts/sync-studio.mjs F:/CamDongHang/public
npm test
npm run build
```

Script kiểm tra ranh giới markup/controller và loại bỏ WhatsApp/AI, không sao chép cấu hình riêng, runtime Python hoặc mẫu vận đơn.

## Kéo thả ghép camera

Giữ chuột trái trên hình camera muốn làm cam phụ, kéo vào hình cam chính rồi thả.
Camera được kéo vào trở thành cam phụ PiP; camera nhận vẫn là cam chính.
Có thể kéo cả hình PiP nhỏ sang cam chính khác. Mỗi cam chính ghép một cam phụ;
4 camera có thể ghép thành 2 cặp. Kéo cam phụ mới vào một cặp sẽ trả cam phụ cũ
về ô riêng. Vẫn có thể chọn qua menu “Cam phụ”.

Bấm **Reset bố cục** để tách toàn bộ camera thành các ô riêng (2 cam → 2 ô,
4 cam → 4 ô). Reset chỉ xóa cách ghép đã nhớ, giữ nguyên độ phân giải và nhân viên;
không xin lại quyền camera hoặc mở lại luồng. Refresh làm mới danh sách thiết bị
và giữ cách ghép đã lưu. Dừng quay trước khi đổi bố cục hoặc Reset.

### Đổi vị trí các ô camera

Giữ chuột trên **nhãn “⠿ Camera 1”** rồi kéo thả lên ô camera khác để đổi vị trí
trái/phải. Cặp chính–phụ được giữ nguyên: ví dụ cặp 1–2 đổi chỗ với cặp 3–4.
Kéo trên phần hình (không kéo nhãn) vẫn dùng để ghép camera phụ. Có thể chọn
nhãn bằng Tab rồi nhấn mũi tên trái/phải. Ứng dụng nhớ thứ tự hiển thị; Reset
bố cục tách các cặp và đưa camera về thứ tự ban đầu. Dừng quay các camera
liên quan trước khi đổi vị trí.

### Kiểm tra bộ đọc mã

Mỗi ô camera hiển thị **“QR / mã vạch sẵn sàng”** khi bộ đọc đã bật. Đọc được
QR và các mã vạch vận đơn thông dụng như Code128, Code39, ITF, EAN/UPC.
Chọn **Hàng hoàn** trước khi đưa mã vào camera. Mã đã có video vẫn được quay
lại; cảnh báo trùng đơn chỉ nhắc, không chặn ghi hình. Nếu bộ đọc báo lỗi tải,
bấm Refresh để khởi động lại.

Bấm **Nhập mã** trên ô camera, gõ vận đơn rồi Enter để bắt đầu quay thủ công.
Chức năng dùng được cả cam đơn lẫn cặp chính–phụ; chọn Hàng gửi/Hàng hoàn
trước khi nhập. Với nhãn nhiệt có mã vạch Code128 ngắn, bộ đọc tự thử chế độ
tăng cường sau các lần chưa nhận; kết quả tăng cường phải khớp trên hai khung
hình. Lúc kéo camera có ảnh thu nhỏ đi theo con trỏ và ô nhận được viền sáng.

### Hướng dẫn setup

Nút **Hướng dẫn setup** mở 7 bước có hình vector và mẫu QR LEAVEIT để in. Tự mở lần đầu, ghi nhớ khi đóng; mở lại bằng nút trên thanh công cụ. Có hướng dẫn 1/2/4 cam, ghép và đổi vị trí, QR/mã vạch, nhập mã, hàng hoàn, lưu tại máy và Drive. Hướng dẫn đóng khi camera bắt đầu quay để hiện lại hình camera.

Đặt thẻ QR chứa đúng `LEAVEIT` dưới vùng để đơn: đơn che kín QR khi quay, nhấc đơn ra để cam đọc QR và kết thúc. Chỉ có chữ LEAVEIT in thường không kích hoạt tự dừng.
