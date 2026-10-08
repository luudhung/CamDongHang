import {cookies} from 'next/headers';
import {requireUser,assertSameOrigin,appOrigin} from '@/lib/server-auth';
import {unseal,seal,type DriveCredentials} from '@/lib/token-vault';
export async function POST(request:Request){try{
  assertSameOrigin(request);const user=await requireUser(request),jar=await cookies(),raw=jar.get('cam_drive')?.value;
  if(!raw)return Response.json({error:'Chưa kết nối Google Drive.'},{status:409});
  const token=unseal<DriveCredentials>(raw);if(token.uid!==user.id)return Response.json({error:'Hãy kết nối Drive cho tài khoản này.'},{status:409});
  if(token.expiresAt<Date.now()+120000){
    const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID!,client_secret:process.env.GOOGLE_CLIENT_SECRET!,refresh_token:token.refreshToken,grant_type:'refresh_token'}),cache:'no-store'});
    const refreshed=await response.json();if(!response.ok||!refreshed.access_token)return Response.json({error:'Phiên Drive đã hết hiệu lực. Hãy kết nối lại.'},{status:409});
    token.accessToken=refreshed.access_token;token.expiresAt=Date.now()+refreshed.expires_in*1000;
    jar.set('cam_drive',seal(token),{httpOnly:true,secure:appOrigin().startsWith('https:'),sameSite:'lax',path:'/api/drive',maxAge:60*60*24*180});
  }
  return Response.json({accessToken:token.accessToken,email:token.email},{headers:{'Cache-Control':'no-store'}});
}catch{return Response.json({error:'Không xác thực được tài khoản. Hãy đăng nhập lại.'},{status:401});}}
