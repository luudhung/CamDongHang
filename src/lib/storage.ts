import {openDB,type DBSchema,type IDBPDatabase} from 'idb';
import {getClient,session,driveToken} from './config';
export type Recording={id:string;owner:string;filename:string;code:string;cameraId:number;employee:string;duration:number;size:number;mime:string;createdAt:string;folder:string;blob?:Blob;localSaved:boolean;driveId?:string;driveUrl?:string;uploadStatus:'local'|'queued'|'uploading'|'uploaded'|'error';error?:string};
interface LocalDB extends DBSchema {
  recordings:{key:string;value:Recording;indexes:{owner:string}};
  preferences:{key:string;value:unknown};
}
let databasePromise:Promise<IDBPDatabase<LocalDB>>|undefined;
export function db(){return databasePromise??=openDB<LocalDB>('camdonghang-web',1,{upgrade(database){
  const store=database.createObjectStore('recordings',{keyPath:'id'});store.createIndex('owner','owner');
  database.createObjectStore('preferences');
}});}
export async function owner(){return (await session())?.user.id||'guest';}
export async function preference<T>(key:string,fallback:T):Promise<T>{return ((await db()).get('preferences',`${await owner()}:${key}`)).then(value=>value===undefined?fallback:value as T);}
export async function setPreference(key:string,value:unknown){await(await db()).put('preferences',value,`${await owner()}:${key}`);}
export async function listRecordings(){return(await db()).getAllFromIndex('recordings','owner',await owner());}
export async function syncMetadata(row:Recording){
  if(row.owner==='guest') return;
  const client=await getClient();if(!client)return;
  const current=await session();if(current?.user.id!==row.owner)return;
  const {error}=await client.from('recordings').upsert({id:row.id,user_id:row.owner,filename:row.filename,code:row.code,camera_id:row.cameraId,employee:row.employee,duration:row.duration,size:row.size,mime:row.mime,created_at:row.createdAt,drive_file_id:row.driveId||null,drive_url:row.driveUrl||null,upload_status:row.uploadStatus});
  if(error) throw error;
}
export async function updateRecording(row:Recording){await(await db()).put('recordings',row);window.dispatchEvent(new Event('cam-recordings-changed'));void syncMetadata(row).catch(error=>console.warn('Chưa đồng bộ thông tin video:',error.message));}
export type DirectoryHandle={name:string;queryPermission(options:{mode:string}):Promise<string>;requestPermission(options:{mode:string}):Promise<string>;getFileHandle(name:string,options?:{create:boolean}):Promise<{createWritable():Promise<{write(blob:Blob):Promise<void>;close():Promise<void>}>;getFile():Promise<File>}>};
export async function chooseDirectory(){
  const picker=(window as unknown as {showDirectoryPicker?:(options:{mode:string})=>Promise<DirectoryHandle>}).showDirectoryPicker;
  if(!picker)throw new Error('Trình duyệt này chưa hỗ trợ chọn thư mục. Dùng Chrome/Edge hoặc tải video bằng nút Tải xuống.');
  const handle=await picker({mode:'readwrite'});
  await setPreference('directory',handle);return handle.name;
}
function safeName(name:string){return name.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,150);}
export async function saveRecording(blob:Blob,info:{filename:string;code:string;cameraId:number;employee:string;duration:number},recordingOwner?:string){
  const who=recordingOwner??await owner(),now=new Date();
  const id=crypto.randomUUID();const parts=info.filename.split('.');const ext=parts.pop()||'webm';
  const filename=safeName(`${parts.join('.')}_${now.getHours().toString().padStart(2,'0')}${now.getMinutes().toString().padStart(2,'0')}${now.getSeconds().toString().padStart(2,'0')}_${id.slice(0,6)}.${ext}`);
  const row:Recording={...info,id,owner:who,filename,size:blob.size,mime:blob.type,createdAt:now.toISOString(),folder:`${String(now.getDate()).padStart(2,'0')}-${String(now.getMonth()+1).padStart(2,'0')}-${now.getFullYear()}`,blob,localSaved:false,uploadStatus:'local'};
  // Persist before any upload/download: network failures cannot discard a completed clip.
  await updateRecording(row);
  const directory=await(await db()).get('preferences',`${who}:directory`) as DirectoryHandle|null;
  if(directory){try{
    if(await directory.queryPermission({mode:'readwrite'})!=='granted')throw new Error('Cần cấp lại quyền thư mục lưu.');
    const file=await directory.getFileHandle(filename,{create:true});const writable=await file.createWritable();await writable.write(blob);await writable.close();row.localSaved=true;
  }catch(error){row.error=error instanceof Error?error.message:'Không ghi được vào thư mục.';}}
  else{downloadBlob(blob,filename);}
  if(await(await db()).get('preferences',`${who}:autoDrive`)&&who!=='guest')row.uploadStatus='queued';
  await updateRecording(row);void runUploadQueue();return row;
}
export function downloadBlob(blob:Blob,filename:string){const url=URL.createObjectURL(blob);const anchor=document.createElement('a');anchor.href=url;anchor.download=filename;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
export async function recordingBlob(row:Recording):Promise<Blob>{
  if(row.blob)return row.blob;
  const directory=await preference<DirectoryHandle|null>('directory',null);
  if(directory)return(await directory.getFileHandle(row.filename)).getFile();
  throw new Error('Video nằm trên máy đã quay. Mở liên kết Drive nếu đã tải lên.');
}
export async function removeCachedVideo(row:Recording){
  if(!row.localSaved&&!row.driveId)throw new Error('Hãy lưu ra thư mục hoặc tải lên Drive trước khi giải phóng bản dự phòng.');
  delete row.blob;await updateRecording(row);
}
let queueBusy=false;
export async function runUploadQueue(retry=false){
  if(queueBusy||!navigator.onLine)return;queueBusy=true;
  const process=async()=>{if(retry){for(const row of await listRecordings()){if(row.uploadStatus==='error'||row.uploadStatus==='uploading'){row.uploadStatus='queued';await updateRecording(row);}}}
    const rows=await listRecordings();for(const row of rows.filter(item=>item.uploadStatus==='queued')){
    try{row.uploadStatus='uploading';row.error=undefined;await updateRecording(row);
      const result=await uploadToDrive(row);row.driveId=result.id;row.driveUrl=result.webViewLink||`https://drive.google.com/file/d/${result.id}/view`;row.uploadStatus='uploaded';
    }catch(error){row.uploadStatus='error';row.error=error instanceof Error?error.message:'Tải Drive chưa thành công.';}
    await updateRecording(row);
  }};
  try{if(navigator.locks){await navigator.locks.request(`camdonghang-upload:${await owner()}`,{ifAvailable:true},async lock=>{if(lock)await process();});}else await process();}finally{queueBusy=false;}
}
export async function retryUploads(){await runUploadQueue(true);}
async function uploadToDrive(row:Recording):Promise<{id:string;webViewLink?:string}>{
  const blob=await recordingBlob(row);let credentials=await driveToken();
  const folderKey=`driveFolder:${credentials.email}`;let folderId=await preference<string|null>(folderKey,null);
  if(!folderId){const response=await fetch('https://www.googleapis.com/drive/v3/files?fields=id',{method:'POST',headers:{Authorization:`Bearer ${credentials.accessToken}`,'Content-Type':'application/json'},body:JSON.stringify({name:'CamDongHang',mimeType:'application/vnd.google-apps.folder'})});
    if(!response.ok)throw new Error('Không tạo được thư mục CamDongHang trên Drive.');folderId=(await response.json()).id;await setPreference(folderKey,folderId);}
  const start=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink',{method:'POST',headers:{Authorization:`Bearer ${credentials.accessToken}`,'Content-Type':'application/json','X-Upload-Content-Type':row.mime,'X-Upload-Content-Length':String(blob.size)},body:JSON.stringify({name:row.filename,parents:[folderId],appProperties:{recordingId:row.id}})});
  if(!start.ok)throw new Error('Không bắt đầu được upload Drive. Hãy kiểm tra kết nối và dung lượng Drive.');
  const uploadUrl=start.headers.get('Location');if(!uploadUrl)throw new Error('Drive không trả về phiên tải video.');
  let offset=0;const chunkSize=8*1024*1024;
  while(offset<blob.size){const end=Math.min(offset+chunkSize,blob.size);let response:Response|undefined;
    for(let attempt=0;attempt<4;attempt++){
      try{response=await fetch(uploadUrl,{method:'PUT',headers:{Authorization:`Bearer ${credentials.accessToken}`,'Content-Range':`bytes ${offset}-${end-1}/${blob.size}`},body:blob.slice(offset,end)});
        if(response.status===401){credentials=await driveToken();continue;}
        if(response.status===429||response.status>=500)throw new Error('Drive đang bận.');
        break;
      }catch(error){if(attempt===3)throw error;await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));
        const status=await fetch(uploadUrl,{method:'PUT',headers:{Authorization:`Bearer ${credentials.accessToken}`,'Content-Range':`bytes */${blob.size}`},body:new Blob()});
        if(status.ok)return status.json();
        if(status.status===308){const last=status.headers.get('Range')?.match(/-(\d+)$/);if(last&&Number(last[1])+1>offset){offset=Number(last[1])+1;response=status;break;}}
      }
    }
    if(response?.ok)return response.json();
    if(response?.status!==308)throw new Error('Upload chưa hoàn tất. Bản dự phòng vẫn còn trên máy; bấm Thử lại.');
    const range=response.headers.get('Range')?.match(/-(\d+)$/);offset=range?Number(range[1])+1:end;
  }
  throw new Error('Chưa nhận được xác nhận lưu video từ Drive.');
}
