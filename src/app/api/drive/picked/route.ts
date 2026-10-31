import {cookies} from 'next/headers';
import {unseal} from '@/lib/token-vault';

type Picked={id:string;name:string;path:string;grant:'picker';email:string};
export async function POST(){
  const jar=await cookies(),raw=jar.get('cam_picked')?.value;
  jar.set('cam_picked','',{path:'/api/drive',maxAge:0});
  if(!raw)return Response.json({error:'Không có thư mục vừa chọn.'},{status:404});
  try{
    const folder=unseal<Picked>(raw),driveRaw=jar.get('cam_drive')?.value;
    if(!driveRaw||unseal<{email:string}>(driveRaw).email!==folder.email)throw new Error('account_mismatch');
    return Response.json({id:folder.id,name:folder.name,path:folder.path,grant:folder.grant},{headers:{'Cache-Control':'no-store'}});
  }catch{return Response.json({error:'Thư mục chưa được xác nhận.'},{status:400});}
}
