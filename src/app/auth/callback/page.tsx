'use client';
import {useEffect,useState} from 'react';
import {getClient} from '@/lib/config';
export default function AuthCallback(){const [message,setMessage]=useState('Đang đăng nhập CamDongHang…');useEffect(()=>{let cancelled=false;void(async()=>{try{const client=await getClient();const code=new URL(location.href).searchParams.get('code');if(!client||!code)throw new Error('Đường dẫn đăng nhập không hợp lệ.');const {error}=await client.auth.exchangeCodeForSession(code);if(error)throw error;if(!cancelled)location.replace('/');}catch(error){setMessage(error instanceof Error?error.message:'Đăng nhập chưa thành công.');}})();return()=>{cancelled=true;};},[]);return <main className="legal"><h1>CamDongHang</h1><p>{message}</p><a href="/">Trở về ứng dụng</a></main>;}
