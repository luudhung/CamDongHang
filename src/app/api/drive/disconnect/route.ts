import {cookies} from 'next/headers';
import {assertSameOrigin,requireUser} from '@/lib/server-auth';
export async function POST(request:Request){try{assertSameOrigin(request);await requireUser(request);(await cookies()).set('cam_drive','',{path:'/api/drive',maxAge:0});return Response.json({success:true});}catch{return Response.json({error:'Không được phép.'},{status:401});}}
