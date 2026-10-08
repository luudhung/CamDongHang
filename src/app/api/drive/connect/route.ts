import {cookies} from 'next/headers';
import {randomBytes} from 'node:crypto';
import {requireUser,assertSameOrigin,appOrigin} from '@/lib/server-auth';
import {seal} from '@/lib/token-vault';
export async function POST(request:Request){try{
  assertSameOrigin(request);const user=await requireUser(request);
  if(!process.env.GOOGLE_CLIENT_ID||!process.env.GOOGLE_CLIENT_SECRET) return Response.json({error:'Kết nối Google Drive chưa được cấu hình.'},{status:503});
  const state=randomBytes(32).toString('hex');const origin=appOrigin();
  (await cookies()).set('cam_oauth',seal({uid:user.id,state,expiresAt:Date.now()+600000}),{httpOnly:true,secure:origin.startsWith('https:'),sameSite:'lax',path:'/api/drive',maxAge:600});
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search=new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,redirect_uri:`${origin}/api/drive/callback`,response_type:'code',scope:'openid email https://www.googleapis.com/auth/drive.file',access_type:'offline',prompt:'consent',state}).toString();
  return Response.json({url:url.toString()},{headers:{'Cache-Control':'no-store'}});
}catch{return Response.json({error:'Hãy đăng nhập lại trước khi kết nối Drive.'},{status:401});}}
