const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..');
const engine=[path.join(root,'public/script.js'),path.join(root,'public/studio/script.js')].find(fs.existsSync);
const source=process.argv.includes('--baseline')?require('node:child_process').execFileSync('git',['show','HEAD:'+path.relative(root,engine).replaceAll('\\','/')],{cwd:root,encoding:'utf8'}):fs.readFileSync(engine,'utf8');
function section(from,to){const a=source.indexOf(from),b=source.indexOf(to,a);assert(a>=0&&b>a);return source.slice(a,b);}
const checks=[];
for(const readyState of ['complete','loading']){
 const workers=[],events=new Map(),badge={dataset:{}};
 class Worker{constructor(url){this.url=url;this.events=new Map();workers.push(this);}addEventListener(name,callback){this.events.set(name,callback);}terminate(){this.terminated=true;}}
 const context=vm.createContext({Worker,window:{addEventListener:(name,fn)=>events.set(name,fn)},document:{readyState,querySelectorAll:()=>[badge]},setTimeout:()=>1,clearTimeout(){},console:{log(){},warn(){},error(){}},showError(message){context.lastError=message;},audioCache:new Map()});
 vm.runInContext(section('let scannerWorker =','class CameraState'),context);
 assert.equal(workers.length,1,`Scanner must initialize when engine is injected with document.readyState=${readyState}, without another window.load event`);
 assert.equal(workers[0].url,'scanner-worker.js');workers[0].events.get('message')({data:{type:'ready'}});
 assert.equal(vm.runInContext('workerReady',context),true);assert.equal(badge.dataset.state,'ready');
 context.initScannerWorker();assert.equal(workers.length,2);assert(workers[0].terminated);workers[1].events.get('message')({data:{type:'error',error:'test WASM load failure'}});assert.equal(badge.dataset.state,'error');assert(context.lastError.includes('Refresh'));
 checks.push(`Engine startup with document ${readyState}; worker-ready and initialization errors visible`);
}
(async()=>{
 const calls=[],requests=[];
 const states=new Map();
 const context=vm.createContext({cameraStates:states,URL,Date,localStorage:{getItem:()=>null},setTimeout:()=>1,clearTimeout(){},console:{log(){}},getEmployees:()=>[],playSound(){},stopScanning(){},startRecording:(state,_main,pip)=>{calls.push({code:state.currentCode,type:state.orderType,duplicate:state.isDuplicateRecording,pip:!!pip});state.isRecording=true;},fetch:async(_url,options)=>{requests.push(JSON.parse(options.body));return {ok:true,json:async()=>({exists:true})};}});
 vm.runInContext(section('function isUrl(', 'async function findNextAvailableFilename(')+section('async function handlePipCodeDetection(', '// ========== SCANNING LOOP'),context);
 for(const type of ['normal','return']){
  const single={deviceId:'cam-'+type,cameraIndex:0,lastScanTime:0,orderType:type,isRecording:false,scanEnabled:true};states.set(single.deviceId,single);await context.handleCodeDetection(single,'OLDORDER123456',{});
  const main={deviceId:'pip-'+type,cameraIndex:1,lastScanTime:0,orderType:type,isRecording:false,pipState:{scanEnabled:true}};states.set(main.deviceId,main);await context.handlePipCodeDetection(main,'OLDORDER123456',{},{});
 }
 assert.equal(calls.length,4);assert(calls.every(c=>c.duplicate));assert.equal(calls.filter(c=>c.type==='return').length,2);assert.equal(calls.filter(c=>c.pip).length,2);assert(requests.every(r=>r.code==='OLDORDER123456'));
 checks.push('Existing order QR still starts both normal and return recordings, single and PiP; duplicate flag warns without blocking');
 console.log(JSON.stringify({passed:checks.length,checks},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
