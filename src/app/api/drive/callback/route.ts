import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {appOrigin} from '@/lib/server-auth';
import {seal,unseal,type OAuthContext,type DriveCredentials} from '@/lib/token-vault';
export async function GET(request:Request){
  const origin=appOrigin(),jar=await cookies(),url=new URL(request.url);
  try{
    const raw=jar.get('cam_oauth')?.value;jar.set('cam_oauth','',{path:'/api/drive',maxAge:0});
    if(!raw)throw new Error('missing_state');const context=unseal<OAuthContext>(raw);
    if(context.state!==url.searchParams.get('state')||context.expiresAt<Date.now())throw new Error('invalid_state');
    if(url.searchParams.has('error'))return NextResponse.redirect(`${origin}/?drive=cancelled`);
    const code=url.searchParams.get('code');if(!code)throw new Error('missing_code');
    const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:process.env.GOOGLE_CLIENT_ID!,client_secret:process.env.GOOGLE_CLIENT_SECRET!,redirect_uri:`${origin}/api/drive/callback`,grant_type:'authorization_code'}),cache:'no-store'});
    const token=await response.json();if(!response.ok||!token.access_token)throw new Error('token_failed');
    if(token.scope&&!token.scope.split(' ').includes('https://www.googleapis.com/auth/drive.file'))throw new Error('scope_failed');
    if(context.mode==='pick'){
      const rawDrive=jar.get('cam_drive')?.value;if(!rawDrive)throw new Error('drive_missing');
      const current=unseal<DriveCredentials>(rawDrive);
      if(current.uid!==context.uid||current.email!==context.email)throw new Error('drive_mismatch');
      const aboutResponse=await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',{headers:{Authorization:`Bearer ${token.access_token}`},cache:'no-store'});
      const about=await aboutResponse.json();
      if(!aboutResponse.ok||about.user?.emailAddress?.toLowerCase()!==current.email.toLowerCase())throw new Error('account_mismatch');
      const ids=url.searchParams.get('picked_file_ids')?.split(',').filter(Boolean)||[];
      if(ids.length!==1)throw new Error('folder_missing');
      const folderResponse=await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(ids[0])}?fields=id,name,mimeType,trashed`,{headers:{Authorization:`Bearer ${token.access_token}`},cache:'no-store'});
      const folder=await folderResponse.json();
      if(!folderResponse.ok||folder.mimeType!=='application/vnd.google-apps.folder'||folder.trashed)throw new Error('invalid_folder');
      jar.set('cam_drive',seal({...current,refreshToken:token.refresh_token||current.refreshToken,accessToken:token.access_token,expiresAt:Date.now()+token.expires_in*1000}),{httpOnly:true,secure:origin.startsWith('https:'),sameSite:'lax',path:'/api/drive',maxAge:60*60*24*400});
      jar.set('cam_picked',seal({id:folder.id,name:folder.name,path:folder.name,grant:'picker',email:current.email}),{httpOnly:true,secure:origin.startsWith('https:'),sameSite:'lax',path:'/api/drive',maxAge:120});
      return NextResponse.redirect(`${origin}/?drive=picked`);
    }
    if(!token.refresh_token)throw new Error('token_failed');
    const profileResponse=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${token.access_token}`},cache:'no-store'});
    if(!profileResponse.ok)throw new Error('profile_failed');const profile=await profileResponse.json();
    jar.set('cam_drive',seal({uid:context.uid,refreshToken:token.refresh_token,accessToken:token.access_token,expiresAt:Date.now()+token.expires_in*1000,email:profile.email,scopeVersion:'drive-file'}),{httpOnly:true,secure:origin.startsWith('https:'),sameSite:'lax',path:'/api/drive',maxAge:60*60*24*400});
    return NextResponse.redirect(`${origin}/?drive=connected`);
  }catch{return NextResponse.redirect(`${origin}/?drive=error`);}
}
