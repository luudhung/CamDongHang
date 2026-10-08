const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),file=[path.join(root,'public/script.js'),path.join(root,'public/studio/script.js')].find(fs.existsSync),source=fs.readFileSync(file,'utf8');
const section=source.slice(source.indexOf('let scannerWorker ='),source.indexOf('function getScanDelay'));
let next={code:'SHORT128123',requiresConfirmation:true};const queue=[],video={readyState:2,videoWidth:1280,videoHeight:720};
class Worker{constructor(){this.listeners=new Map();}addEventListener(name,fn){this.listeners.set(name,fn);}terminate(){}postMessage({data}){queue.push(data);queueMicrotask(()=>this.listeners.get('message')({data:{type:'result',scanId:data.scanId,...next}}));}}
const context=vm.createContext({Worker,document:{querySelectorAll:()=>[],createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(4)})})})},setTimeout,clearTimeout,console:{log(){},warn(){},error(){}},showError(){},Date,Promise});
vm.runInContext(section+'\ninitScannerWorker();scannerWorker.listeners.get("message")({data:{type:"ready"}});clearTimeout(scannerStartupTimeout);',context);
(async()=>{
 assert.equal(await context.scanCode(video),null,'One low-line-count result must not start recording');assert.equal(await context.scanCode(video),'SHORT128123','Matching independent frame confirms Code128');
 next={code:'DIFFERENT128',requiresConfirmation:true};assert.equal(await context.scanCode(video),null,'Different code resets confirmation');
 vm.runInContext('scanConfirmations.set(testVideo,{code:"DIFFERENT128",time:Date.now()-6000,count:1});',Object.assign(context,{testVideo:video}));
 assert.equal(await context.scanCode(video),null,'Stale confirmation expires');assert.equal(await context.scanCode(video),'DIFFERENT128');
 next={code:'QR123456789',requiresConfirmation:false};assert.equal(await context.scanCode(video),'QR123456789','Normal QR decoder result is immediate');
 assert.equal(queue.length,6);console.log('PASS: thin Code128 confirmed on separate frames, mismatch and timeout rejected, normal QR immediate');
})().catch(error=>{console.error(error);process.exitCode=1;});
