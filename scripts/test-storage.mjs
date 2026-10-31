import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import 'fake-indexeddb/auto';

// Exercise the real storage/upload module with IndexedDB and mocked network boundaries.
const output=new URL('../test-results/storage-under-test.mjs',import.meta.url);
await fs.mkdir(new URL('../test-results/',import.meta.url),{recursive:true});
await build({entryPoints:['src/lib/storage.ts'],outfile:fileURLToPath(output),bundle:true,platform:'node',format:'esm',plugins:[{name:'mock-auth-boundary',setup(builder){builder.onResolve({filter:/^\.\/config$/},()=>({path:'config',namespace:'test'}));builder.onLoad({filter:/.*/,namespace:'test'},()=>({contents:`export const session=async()=>globalThis.testSession; export const getClient=async()=>null; export const driveToken=async()=>({email:'test@example.invalid',accessToken:'test-token'});`,loader:'js'}));}}]});
const downloads=[];globalThis.window=new EventTarget();
globalThis.document={createElement:()=>({click(){downloads.push(this.download);}})};
const locks=new Set();Object.defineProperty(globalThis,'navigator',{value:{onLine:true,locks:{async request(name,options,callback){if(locks.has(name))return callback(null);locks.add(name);try{return await callback({name});}finally{locks.delete(name);}}}}});
const a=await import(output.href+'?a'),b=await import(output.href+'?b');
globalThis.testSession=null;
const clip=new Blob([new Uint8Array(10*1024*1024)],{type:'video/webm'});
const info={filename:'ORDER123.webm',code:'ORDER123',cameraId:1,employee:'Test',duration:2};
const first=await a.saveRecording(clip,info);
assert.equal(first.uploadStatus,'local');assert.equal((await a.recordingBlob(first)).size,clip.size);assert.equal(downloads.length,1);
await assert.rejects(a.removeCachedVideo(first),/lưu ra thư mục/);
globalThis.testSession={user:{id:'user-a'}};
assert.equal((await a.listRecordings()).length,0,'guest records must stay separate');
const accountA=await a.saveRecording(clip,info);assert.equal(accountA.owner,'user-a');
globalThis.testSession={user:{id:'user-b'}};
const oldOwner=await a.saveRecording(clip,info,'user-a');assert.equal(oldOwner.owner,'user-a');assert.equal((await a.listRecordings()).length,0);
globalThis.testSession={user:{id:'user-a'}};
let starts=0,putCount=0,failedOnce=false,folderCreates=0,folderExists=false;const ranges=[];
globalThis.fetch=async(url,options={})=>{
  if(String(url).includes('uploadType=resumable')){starts++;await new Promise(resolve=>setTimeout(resolve,20));return new Response('',{headers:{Location:'https://upload.example.invalid/session'}});}
  if(String(url).includes('/drive/v3/files?')){
    if(options.method==='POST'){folderCreates++;folderExists=true;return Response.json({id:'day-folder'});}
    return Response.json({files:folderExists?[{id:'day-folder',name:accountA.folder,createdTime:'2026-10-31T00:00:00Z'}]:[]});
  }
  assert.equal(url,'https://upload.example.invalid/session');
  const range=options.headers['Content-Range'];ranges.push(range);
  if(range.startsWith('bytes */'))return new Response('',{status:308,headers:{Range:'bytes=0-4194303'}});
  putCount++;
  if(!failedOnce){failedOnce=true;throw new Error('simulated network interruption after partial acceptance');}
  return Response.json({id:'drive-test',webViewLink:'https://drive.google.com/file/d/drive-test/view'});
};
await a.chooseDriveFolder('test@example.invalid',{id:'parent-folder',name:'Đóng hàng'});
accountA.uploadStatus='queued';await a.updateRecording(accountA);
await Promise.all([a.runUploadQueue(),b.runUploadQueue()]);
assert.equal(starts,1,'cross-window lock must prevent duplicate uploads');
assert.equal(folderCreates,1,'first machine creates a dated folder only once');
assert(ranges.includes('bytes 4194304-10485759/10485760'),'resume must start after bytes already accepted');
let rows=await a.listRecordings();let uploaded=rows.find(row=>row.id===accountA.id);assert.equal(uploaded.uploadStatus,'uploaded');assert.equal(uploaded.driveId,'drive-test');
const second=await b.saveRecording(clip,info);second.uploadStatus='queued';await b.updateRecording(second);
for(let attempt=0;attempt<10;attempt++){await b.runUploadQueue();if((await b.listRecordings()).find(row=>row.id===second.id)?.uploadStatus==='uploaded')break;await new Promise(resolve=>setTimeout(resolve,25));}
assert.equal(folderCreates,1,'second machine reuses the existing dated folder');
await a.removeCachedVideo(uploaded);assert.equal((await a.listRecordings()).find(row=>row.id===accountA.id).blob,undefined);
oldOwner.uploadStatus='queued';await a.updateRecording(oldOwner);
globalThis.fetch=async()=>new Response('capacity error',{status:403});
await a.runUploadQueue();const failed=(await a.listRecordings()).find(row=>row.id===oldOwner.id);assert.equal(failed.uploadStatus,'error');assert.equal((await a.recordingBlob(failed)).size,clip.size,'upload failure must retain clip');
navigator.onLine=false;await a.retryUploads();assert.equal((await a.listRecordings()).find(row=>row.id===oldOwner.id).uploadStatus,'error');
const result={localPersistence:'PASS',accountIsolation:'PASS',ownerSnapshot:'PASS',crossWindowUploadLock:'PASS',existingDatedDriveFolder:'PASS',resumablePartialAcceptance:'PASS',uploadFailureRetention:'PASS',cacheReleaseGuard:'PASS',resumableRequests:ranges,uploadSessions:starts,putCount};
await fs.writeFile(new URL('../test-results/storage.json',import.meta.url),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
// Download URL cleanup timers should not keep this command open.
process.exit(0);

