import {openDB,type DBSchema,type IDBPDatabase} from 'idb';
import {getClient,session,driveToken} from './config';
export type Recording={id:string;owner:string;filename:string;code:string;cameraId:number;employee:string;duration:number;size:number;mime:string;createdAt:string;folder:string;blob?:Blob;localSaved:boolean;cloudOnly?:boolean;driveId?:string;driveUrl?:string;uploadStatus:'local'|'queued'|'uploading'|'uploaded'|'error';error?:string};
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
export type DirectoryHandle={name:string;queryPermission(options:{mode:string}):Promise<string>;requestPermission(options:{mode:string}):Promise<string>;getDirectoryHandle(name:string,options?:{create:boolean}):Promise<DirectoryHandle>;getFileHandle(name:string,options?:{create:boolean}):Promise<{createWritable():Promise<{write(blob:Blob):Promise<void>;close():Promise<void>}>;getFile():Promise<File>}>};
export async function chooseDirectory(){
  const picker=(window as unknown as {showDirectoryPicker?:(options:{mode:string})=>Promise<DirectoryHandle>}).showDirectoryPicker;
  if(!picker)throw new Error('Trình duyệt này chưa hỗ trợ chọn thư mục. Dùng Chrome/Edge hoặc tải video bằng nút Tải xuống.');
  const handle=await picker({mode:'readwrite'});
  await setPreference('directory',handle);return handle.name;
}
function safeName(name:string){return name.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,150);}
export async function saveRecording(blob:Blob,info:{filename:string;code:string;cameraId:number;employee:string;duration:number},recordingOwner?:string){
  const who=recordingOwner??await owner(),now=new Date();
  const localSave=await(await db()).get('preferences',`${who}:localSave`)!==false;
  const autoDrive=!!await(await db()).get('preferences',`${who}:autoDrive`);
  const id=crypto.randomUUID();const parts=info.filename.split('.');const ext=parts.pop()||'webm';
  const filename=safeName(`${parts.join('.')}_${now.getHours().toString().padStart(2,'0')}${now.getMinutes().toString().padStart(2,'0')}${now.getSeconds().toString().padStart(2,'0')}_${id.slice(0,6)}.${ext}`);
  const row:Recording={...info,id,owner:who,filename,size:blob.size,mime:blob.type,createdAt:now.toISOString(),folder:`${String(now.getDate()).padStart(2,'0')}-${String(now.getMonth()+1).padStart(2,'0')}-${now.getFullYear()}`,blob,localSaved:false,cloudOnly:!localSave&&autoDrive&&who!=='guest',uploadStatus:'local'};
  // Persist before any upload/download: network failures cannot discard a completed clip.
  await updateRecording(row);
  const directory=await(await db()).get('preferences',`${who}:directory`) as DirectoryHandle|null;
  if(!row.cloudOnly&&directory){try{
    if(await directory.queryPermission({mode:'readwrite'})!=='granted')throw new Error('Cần cấp lại quyền thư mục lưu.');
    const file=await directory.getFileHandle(filename,{create:true});const writable=await file.createWritable();await writable.write(blob);await writable.close();row.localSaved=true;
  }catch(error){row.error=error instanceof Error?error.message:'Không ghi được vào thư mục.';}}
  else if(!row.cloudOnly){downloadBlob(blob,filename);}
  if(autoDrive&&who!=='guest')row.uploadStatus='queued';
  await updateRecording(row);void runUploadQueue();return row;
}
export function downloadBlob(blob:Blob,filename:string){const url=URL.createObjectURL(blob);const anchor=document.createElement('a');anchor.href=url;anchor.download=filename;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
export async function recordingBlob(row:Recording):Promise<Blob>{
  if(row.blob)return row.blob;
  const directory=await preference<DirectoryHandle|null>('directory',null);
  if(directory){
    try{
      if(await directory.queryPermission({mode:'readwrite'})!=='granted'&&await directory.requestPermission({mode:'readwrite'})!=='granted')throw new Error('Cần cấp lại quyền thư mục lưu trên máy.');
      return(await directory.getFileHandle(row.filename)).getFile();
    }catch(error){if(!row.driveId)throw error;}
  }
  if(row.driveId)return driveRecordingBlob(row.driveId);
  throw new Error('Video nằm trên máy đã quay. Mở liên kết Drive nếu đã tải lên.');
}
export async function driveRecordingBlob(fileId:string){
  const {accessToken}=await driveToken();const response=await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,{headers:{Authorization:`Bearer ${accessToken}`}});
  if(!response.ok)throw new Error('Không tải lại được video từ Drive. Hãy kiểm tra quyền và file trên Drive.');
  return response.blob();
}
export async function downloadAllRecordings(onProgress:(done:number,total:number)=>void){
  const rows=await listRecordings();if(!rows.length)throw new Error('Trình duyệt này chưa có video để tải.');
  const picker=(window as unknown as {showDirectoryPicker?:(options:{mode:string})=>Promise<DirectoryHandle>}).showDirectoryPicker;
  if(!picker)throw new Error('Hãy dùng Chrome hoặc Edge để chọn thư mục tải tất cả video.');
  const target=await picker({mode:'readwrite'});let done=0;const failed:string[]=[];
  for(const row of rows){try{const blob=await recordingBlob(row);const day=await target.getDirectoryHandle(row.folder,{create:true});const file=await day.getFileHandle(row.filename,{create:true});const writable=await file.createWritable();await writable.write(blob);await writable.close();done++;}catch{failed.push(row.filename);}onProgress(done,rows.length);}
  return {done,total:rows.length,failed};
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
      const result=await uploadToDrive(row);if(!result.id)throw new Error('Drive chưa xác nhận đã lưu video.');row.driveId=result.id;row.driveUrl=result.webViewLink||`https://drive.google.com/file/d/${result.id}/view`;row.uploadStatus='uploaded';
      if(row.cloudOnly)delete row.blob;
    }catch(error){row.uploadStatus='error';row.error=error instanceof Error?error.message:'Tải Drive chưa thành công.';}
    await updateRecording(row);
  }};
  try{if(navigator.locks){await navigator.locks.request(`camdonghang-upload:${await owner()}`,{ifAvailable:true},async lock=>{if(lock)await process();});}else await process();}finally{queueBusy=false;}
}
export async function retryUploads(){await runUploadQueue(true);}
export type DriveFolder={id:string;name:string;path?:string;grant?:'picker'};
function driveQueryValue(value:string){return value.replace(/\\/g,'\\\\').replace(/'/g,"\\'");}
export async function selectedDriveFolder(email:string){const value=await preference<DriveFolder|string|null>(`driveFolder:${email}`,null);return value&&typeof value==='object'&&typeof value.id==='string'&&typeof value.name==='string'&&value.grant==='picker'?value:null;}
export async function chooseDriveFolder(email:string,folder:DriveFolder){await setPreference(`driveFolder:${email}`,folder);}
async function dailyDriveFolder(parentId:string,day:string,accessToken:string){
  const q=`'${driveQueryValue(parentId)}' in parents and name = '${driveQueryValue(day)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const find=async()=>{
    const params=new URLSearchParams({q,fields:'nextPageToken,files(id,name,createdTime)',pageSize:'1000',spaces:'drive'});
    const found:{id:string;createdTime?:string}[]=[];let pageToken='';
    do{if(pageToken)params.set('pageToken',pageToken);const response=await fetch(`https://www.googleapis.com/drive/v3/files?${params}`,{headers:{Authorization:`Bearer ${accessToken}`},cache:'no-store'});
      if(!response.ok)throw new Error(response.status===403?'Hãy kết nối lại Google Drive để cấp quyền thư mục.':'Không kiểm tra được thư mục ngày trên Drive.');
      const data=await response.json();found.push(...(data.files||[]));pageToken=data.nextPageToken||'';
    }while(pageToken);
    return found.sort((a,b)=>(a.createdTime||'').localeCompare(b.createdTime||'')||a.id.localeCompare(b.id))[0]?.id;
  };
  const existing=await find();if(existing)return existing;
  const response=await fetch('https://www.googleapis.com/drive/v3/files?fields=id',{method:'POST',headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},body:JSON.stringify({name:day,mimeType:'application/vnd.google-apps.folder',parents:[parentId]})});
  if(!response.ok)throw new Error('Không tạo được thư mục ngày trên Drive.');
  const created=(await response.json()).id as string;
  return await find()||created;
}
async function uploadToDrive(row:Recording):Promise<{id:string;webViewLink?:string}>{
  const blob=await recordingBlob(row);let credentials=await driveToken();
  const selected=await selectedDriveFolder(credentials.email);
  if(!selected)throw new Error('Hãy chọn thư mục trong My Drive trước khi tải video.');
  const folderId=await dailyDriveFolder(selected.id,row.folder,credentials.accessToken);
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
