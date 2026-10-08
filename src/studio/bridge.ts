import {getClient,session} from '../lib/config';
import {owner,preference,setPreference,saveRecording,listRecordings,recordingBlob,downloadBlob,runUploadQueue,type Recording} from '../lib/storage';
const nativeFetch=window.fetch.bind(window);
let cameraOwner='guest';
type VideoInfo=Record<string,unknown>;
function escapeHtml(value:unknown){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));}
function info(row:Recording):VideoInfo{return {filename:row.filename,code:escapeHtml(row.code),cameraId:row.cameraId,employee:escapeHtml(row.employee),duration:row.duration,size:row.size,timestamp:row.createdAt,folder:row.folder,orderType:row.filename.includes('_Return')?'return':'normal',uploaded:!!row.driveId,googleDriveLink:row.driveUrl,relativePath:`${row.folder}/${row.filename}`};}
async function allVideos(){
  const rows=await listRecordings();const result=new Map(rows.map(row=>[row.id,info(row)]));
  const client=await getClient(),current=await session();
  if(client&&current){const {data}=await client.from('recordings').select('*').eq('user_id',current.user.id).order('created_at',{ascending:false}).limit(1000);
    for(const item of data||[]){if(result.has(item.id))continue;const date=new Date(item.created_at);const folder=`${String(date.getDate()).padStart(2,'0')}-${String(date.getMonth()+1).padStart(2,'0')}-${date.getFullYear()}`;
      result.set(item.id,{filename:item.filename,code:escapeHtml(item.code),cameraId:item.camera_id,employee:escapeHtml(item.employee),duration:item.duration,size:item.size,timestamp:item.created_at,folder,orderType:item.filename.includes('_Return')?'return':'normal',uploaded:!!item.drive_file_id,googleDriveLink:item.drive_url,relativePath:`${folder}/${item.filename}`});}}
  return [...result.values()];
}
async function settings(){const cached=await preference<Record<string,unknown>>('settings',{}),client=await getClient(),current=await session();if(client&&current){const {data,error}=await client.from('user_settings').select('settings').eq('user_id',current.user.id).maybeSingle();if(!error&&data){await setPreference('settings',data.settings);return data.settings;}}return cached;}
async function openVideo(relativePath:string){const local=(await listRecordings()).find(row=>`${row.folder}/${row.filename}`===relativePath);
  const dialog=document.createElement('dialog');dialog.style.cssText='width:min(900px,90vw);background:#101722;color:white;border:1px solid #334155;border-radius:16px';
  const close=document.createElement('button');close.textContent='Đóng';close.onclick=()=>dialog.close();dialog.append(close);
  let url:string|undefined;
  if(local){try{url=URL.createObjectURL(await recordingBlob(local));const video=document.createElement('video');video.src=url;video.controls=true;video.autoplay=true;video.style.cssText='display:block;width:100%;max-height:75vh';dialog.append(video);}catch{/* Drive fallback below */}}
  if(!url){const video=(await allVideos()).find(row=>row.relativePath===relativePath);const link=document.createElement('a');if(video?.googleDriveLink){link.href=String(video.googleDriveLink);link.target='_blank';link.rel='noopener';link.textContent='Mở video trên Google Drive';}else link.textContent='Video này nằm trên máy đã quay. Mở mục Lưu trữ trên máy đó để tải xuống.';dialog.append(link);}
  dialog.onclose=()=>{if(url)URL.revokeObjectURL(url);dialog.remove();};document.body.append(dialog);dialog.showModal();
}
window.fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(input instanceof Request?input.url:String(input),location.href);
  if(url.origin!==location.origin)return nativeFetch(input,init);
  const path=url.pathname;
  const supported=['/upload-video','/api/settings','/api/check-duplicate','/api/statistics','/api/videos/list','/api/open-video'];
  if(!supported.includes(path)&&!/^\/Videos\/[^/]+\/stats\.json$/.test(path))return nativeFetch(input,init);
  try{
    const request=new Request(url,input instanceof Request?input:init);
    if(path==='/upload-video'){
      const form=await request.formData(),video=form.get('video');if(!(video instanceof Blob))throw new Error('Thiếu dữ liệu video.');
      const row=await saveRecording(video,{filename:video instanceof File?video.name:'Video.webm',code:String(form.get('code')||''),cameraId:Number(form.get('cameraId')||1),employee:String(form.get('employee')||''),duration:Number(form.get('duration')||0)},cameraOwner);
      return Response.json({success:true,filename:row.filename});
    }
    if(path==='/api/settings'){
      if(request.method==='GET')return Response.json({success:true,settings:await settings()});
      const value=(await request.json()).settings;await setPreference('settings',value);
      const client=await getClient(),current=await session();if(client&&current){const {error}=await client.from('user_settings').upsert({user_id:current.user.id,settings:value,updated_at:new Date().toISOString()});if(error)console.warn('Cài đặt đã lưu tại máy; chưa đồng bộ được.');}
      return Response.json({success:true});
    }
    if(path==='/api/open-video'){await openVideo((await request.json()).relativePath);return Response.json({success:true});}
    const videos=await allVideos();
    if(path==='/api/check-duplicate'){const data=await request.json();const today=new Date().toLocaleDateString('en-CA');return Response.json({exists:videos.some(row=>row.code===escapeHtml(data.code)&&row.orderType===data.orderType&&new Date(String(row.timestamp)).toLocaleDateString('en-CA')===today)});}
    if(path==='/api/videos/list'){
      const groups=new Map<string,VideoInfo[]>();for(const video of videos){const date=String(video.folder);if(!groups.has(date))groups.set(date,[]);groups.get(date)!.push(video);}
      return Response.json({groups:[...groups].map(([date,items])=>({date,videos:items,totalCount:items.length,uploadedCount:items.filter(video=>video.uploaded).length,totalSize:items.reduce((total,row)=>total+Number(row.size),0)})).sort((a,b)=>String(b.videos[0]?.timestamp).localeCompare(String(a.videos[0]?.timestamp)))});
    }
    if(path.startsWith('/Videos/'))return Response.json({videos:videos.filter(row=>row.folder===path.split('/')[2])});
    const filter=await request.json();return Response.json({videos:videos.filter(row=>filter.fetchAll||(!filter.startDate||String(row.timestamp).slice(0,10)>=filter.startDate)&&(!filter.endDate||String(row.timestamp).slice(0,10)<=filter.endDate))});
  }catch(error){return Response.json({error:error instanceof Error?error.message:'Lưu dữ liệu chưa thành công.'},{status:500});}
};
async function start(){
  try{const current=await session();const config=await settings();for(const key of ['autoSwitch','extraRecording','extraRecordingOriginal','scanFrequency','timeOffset','pipScale','recordAudio','employees'])localStorage.removeItem(key);
    for(const [key,value]of Object.entries(config)){if(typeof value==='string')localStorage.setItem(key,value);else if(key==='employees')localStorage.setItem(key,JSON.stringify(value));}
    cameraOwner=await owner();const cached=await preference<Record<string,unknown>>('cameraSettings',{});localStorage.setItem('cameraSettings',JSON.stringify(cached));
    let lastCameraSettings=localStorage.getItem('cameraSettings');
    setInterval(()=>{const current=localStorage.getItem('cameraSettings');if(current!==lastCameraSettings){lastCameraSettings=current;void setPreference('cameraSettings',JSON.parse(current||'{}'));}
      const recording=[...document.querySelectorAll<HTMLElement>('.recording-indicator')].some(node=>node.style.display==='block');
      parent.postMessage({type:'cam-state',recording,owner:cameraOwner},location.origin);
    },1000);
    if(current){const client=await getClient();client?.auth.onAuthStateChange((_event,next)=>{if((next?.user.id||'guest')!==cameraOwner){parent.postMessage({type:'cam-session-changed'},location.origin);}});}
  }catch(error){console.warn('Chế độ tại máy:',error);}
  const script=document.createElement('script');script.src='/studio/script.js';script.onload=()=>{
    window.addEventListener('message',event=>{
      if(event.origin!==location.origin||event.source!==parent||event.data?.type!=='cam-command')return;
      const ids:Record<string,string>={videos:'videos-btn',statistics:'statistics-btn',settings:'settings-btn',refresh:'refresh-btn'};
      if(event.data.command==='search'){
        const input=document.getElementById('header-quick-search') as HTMLInputElement;input.value=String(event.data.query||'');input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      }else if(ids[event.data.command])document.getElementById(ids[event.data.command])?.click();
    });
    parent.postMessage({type:'cam-ready'},location.origin);
    (window as unknown as {downloadVideo:(video:VideoInfo)=>Promise<void>}).downloadVideo=async video=>{
      const row=(await listRecordings()).find(item=>`${item.folder}/${item.filename}`===video.relativePath||item.filename===video.filename);
      if(row){try{downloadBlob(await recordingBlob(row),row.filename);return;}catch{/* Fall back to the remote copy. */}}
      if(video.relativePath)await openVideo(String(video.relativePath));else alert('Video nằm trên máy đã quay.');
    };
  };document.body.append(script);
  window.addEventListener('online',()=>void runUploadQueue());void runUploadQueue();
}
void start();
