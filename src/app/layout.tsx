import type {Metadata} from 'next';
import './globals.css';
export const metadata:Metadata={title:'CamDongHang — Quay video đóng hàng',description:'Quay video đóng hàng, đọc QR và mã vận đơn trên máy của bạn. Lưu tại máy hoặc Google Drive của bạn.',icons:{icon:[{url:'/favicon.svg',type:'image/svg+xml'},{url:'/favicon.ico',sizes:'any'}],apple:'/apple-touch-icon.png'}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="vi"><body>{children}</body></html>;}
