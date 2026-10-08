import { createClient, type SupabaseClient } from '@supabase/supabase-js';
export type PublicConfig = { supabaseUrl:string; supabaseKey:string; driveEnabled:boolean };
let clientPromise: Promise<SupabaseClient|null>|null=null;
export function getClient(): Promise<SupabaseClient|null> {
  if (!clientPromise) clientPromise=(async()=>{
    const response=await fetch('/api/config',{cache:'no-store'});
    if(!response.ok) throw new Error('Không tải được cấu hình tài khoản.');
    const cfg:PublicConfig=await response.json();
    return cfg.supabaseUrl&&cfg.supabaseKey?createClient(cfg.supabaseUrl,cfg.supabaseKey,{
      auth:{flowType:'pkce',persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}
    }):null;
  })().catch(error=>{clientPromise=null;throw error;});
  return clientPromise;
}
export async function session() {
  const client=await getClient();
  return client?(await client.auth.getSession()).data.session:null;
}
export async function authHeaders():Promise<Record<string,string>> {
  const current=await session();
  if(!current) throw new Error('Hãy đăng nhập trước khi kết nối Google Drive.');
  return {Authorization:`Bearer ${current.access_token}`};
}
export async function driveToken():Promise<{accessToken:string;email:string}> {
  const response=await fetch('/api/drive/token',{method:'POST',headers:await authHeaders()});
  const data=await response.json();
  if(!response.ok) throw new Error(data.error||'Hãy kết nối lại Google Drive.');
  return data;
}
