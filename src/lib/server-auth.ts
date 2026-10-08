import 'server-only';
import {createClient} from '@supabase/supabase-js';
export async function requireUser(request:Request){
  const token=request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
  if(!token)throw new Error('UNAUTHORIZED');
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if(!url||!key)throw new Error('AUTH_NOT_CONFIGURED');
  const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data,error}=await client.auth.getUser(token);if(error||!data.user)throw new Error('UNAUTHORIZED');
  return data.user;
}
export function appOrigin(){
  const origin=process.env.APP_ORIGIN;if(!origin)throw new Error('APP_ORIGIN chưa được cấu hình.');
  return new URL(origin).origin;
}
export function assertSameOrigin(request:Request){
  const origin=request.headers.get('Origin');if(origin!==appOrigin())throw new Error('INVALID_ORIGIN');
}
