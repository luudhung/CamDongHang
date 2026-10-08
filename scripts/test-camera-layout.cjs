const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const engineFile = [path.join(root,'public/script.js'),path.join(root,'public/studio/script.js')].find(fs.existsSync);
const source = fs.readFileSync(engineFile,'utf8');
const piece = (start,end) => source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
class Element {
 constructor(){this.dataset={};this.style={};this.value='';this.children=new Map();this.classes=new Set();this.classList={add:(...names)=>names.forEach(n=>this.classes.add(n)),remove:(...names)=>names.forEach(n=>this.classes.delete(n))};}
 querySelector(selector){return this.children.get(selector)||null;}
}
let clones=[];
function stream(){const track={readyState:'live',stop(){this.readyState='ended';}};return {getTracks:()=>[track],getVideoTracks:()=>[track],clone(){const copy=stream();clones.push(copy);return copy;}};}
const cards=[];
const grid=new Element();grid.setAttribute=(key,value)=>grid.dataset[key]=value;
grid.querySelectorAll=selector=>selector.includes('display:')?cards.filter(c=>c.style.display!=='none'):selector==='.camera-container'?cards:cards.filter(c=>[...c.classes].some(n=>selector.includes(n)));
grid.moveBefore=card=>{cards.splice(cards.indexOf(card),1);cards.push(card);};
const values=new Map();const localStorage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,String(value))};
const context=vm.createContext({console:{log(){},warn(){}},localStorage,clearTimeout,clearInterval,document:{getElementById:()=>grid,querySelectorAll:selector=>grid.querySelectorAll(selector),querySelector:()=>null,body:new Element()},window:{addEventListener(){}},cameraGrid:grid,statusMessage:{style:{}},cameraStates:new Map(),cameraInitPromise:null,cameraDrag:null,scanConfirmations:new WeakMap(),cancelScanRequests(){},showError(message){context.lastError=message;},startScanning(state,video){if(!state.isPipMode&&!state.masterDeviceId){state.scanInterval=true;state.scanVideo=video;}},startPipScanning(main,_video,pip){main.pipState.scanInterval=true;main.pipState.scanVideo=pip;}});
vm.runInContext(piece('function saveCameraSetting(', 'let scannerWorker =')+piece('function stopScanning(', '// ========== FORMAT TIMESTAMP')+piece('function cameraContainer(', 'function init()'),context);
function setup(count){cards.length=0;clones=[];values.clear();context.cameraStates.clear();context.lastError='';for(let i=1;i<=count;i++){
 const id='cam-'+i,card=new Element();card.dataset.deviceId=id;card.classes.add('camera-container');
 for(const selector of ['.camera-video','.pip-video','.pip-overlay','.pip-select','.pip-label'])card.children.set(selector,new Element());
 card.querySelector('.camera-video').srcObject=stream();card.querySelector('.pip-video').readyState=2;
 cards.push(card);context.cameraStates.set(id,{deviceId:id,cameraIndex:i-1,pipDeviceId:null,pipState:null,masterDeviceId:null,isPipMode:false,scanInterval:true,scanVideo:card.querySelector('.camera-video')});
 context.saveCameraSetting(id,'resolution',{width:1920,height:1080});context.saveCameraSetting(id,'employee','Nhân viên thử');
}context.updateCameraVisibility();}
const state=id=>context.cameraStates.get('cam-'+id);
const pair=(main,aux)=>context.setCameraPip('cam-'+main,aux?'cam-'+aux:'');
const visible=()=>cards.filter(c=>c.style.display!=='none').length;
const liveOriginals=()=>cards.every(c=>c.querySelector('.camera-video').srcObject.getVideoTracks()[0].readyState==='live');
const checks=[];
setup(2);assert(pair(1,2));assert.equal(visible(),1);assert.equal(state(2).masterDeviceId,'cam-1');assert.equal(state(1).scanInterval,null);assert.equal(state(2).scanVideo,cards[0].querySelector('.pip-video'));assert(liveOriginals());assert(context.resetCameraLayout());assert.equal(visible(),2);assert(clones.every(s=>s.getTracks()[0].readyState==='ended'));assert(liveOriginals());checks.push('2 cameras: pair, scan auxiliary, reset without stopping original streams');
setup(4);assert(pair(1,2));assert(pair(3,4));assert.equal(visible(),2);
const firstPair=state(1).pipState,secondPair=state(3).pipState;
assert(context.swapCameraPositions('cam-1','cam-3'));
assert.deepEqual(cards.filter(c=>c.style.display!=='none').map(c=>c.dataset.deviceId),['cam-3','cam-1']);
assert.equal(state(1).pipState,firstPair);assert.equal(state(3).pipState,secondPair);assert(liveOriginals());
assert.deepEqual(JSON.parse(localStorage.getItem('cameraSettings')).__layout.order,cards.map(c=>c.dataset.deviceId));
checks.push('Swap visible main cards while preserving pairs, streams and remembered order');
assert(pair(3,2));assert.equal(state(1).pipDeviceId,null);assert.equal(state(4).masterDeviceId,null);assert.equal(state(2).masterDeviceId,'cam-3');assert.equal(visible(),3);assert(liveOriginals());checks.push('4 cameras: two pairs, transfer owned auxiliary, release replaced auxiliary');
assert(pair(1,3));assert.equal(state(3).pipDeviceId,null);assert.equal(state(2).masterDeviceId,null);assert.equal(state(3).masterDeviceId,'cam-1');assert(!pair(3,1));assert(!pair(1,1));checks.push('Dragging an existing main releases its auxiliary; reject nested/self pairs');
const before=JSON.stringify(localStorage.getItem('cameraSettings'));state(1).isRecording=true;state(1).mediaRecorder={state:'recording',stop(){throw Error('Must not interrupt recording');}};const oldClone=cards[0].querySelector('.pip-video').srcObject;
assert(!pair(4,3));assert(!context.swapCameraPositions('cam-1','cam-4'));assert(!context.resetCameraLayout());assert.equal(state(1).pipDeviceId,'cam-3');assert.equal(cards[0].querySelector('.pip-video').srcObject,oldClone);assert.equal(JSON.stringify(localStorage.getItem('cameraSettings')),before);assert.equal(state(1).mediaRecorder.state,'recording');checks.push('Reject pair changes and reset during recording without touching recorder or persistence');
state(1).isRecording=false;state(1).mediaRecorder.state='inactive';state(1).isStartingRecording=true;assert(!context.resetCameraLayout());state(1).isStartingRecording=false;checks.push('Protect recorder startup');
const persisted=JSON.parse(localStorage.getItem('cameraSettings'));persisted.unplugged={pipDeviceId:'cam-2',resolution:{width:1280,height:720}};localStorage.setItem('cameraSettings',JSON.stringify(persisted));assert(context.resetCameraLayout());assert.equal(visible(),4);assert(liveOriginals());assert(clones.every(s=>s.getTracks()[0].readyState==='ended'));const reset=JSON.parse(localStorage.getItem('cameraSettings'));for(const [id,setting]of Object.entries(reset)){assert.equal(setting.pipDeviceId,null);if(id.startsWith('cam-')){assert.equal(setting.resolution.width,1920);assert.equal(setting.employee,'Nhân viên thử');}}assert([...context.cameraStates.values()].every(s=>!s.masterDeviceId&&!s.pipDeviceId&&s.scanInterval));checks.push('Reset all four, clear unplugged pairs, retain resolution/employees, restart standalone scanning');
assert(pair(1,2));cards[2].querySelector('.camera-video').srcObject.getTracks()[0].stop();assert(!pair(1,3));assert.equal(state(1).pipDeviceId,'cam-2');assert.equal(state(2).masterDeviceId,'cam-1');checks.push('Unavailable source preserves existing pair');
context.cameraInitPromise=Promise.resolve();assert(!context.resetCameraLayout());context.cameraInitPromise=null;checks.push('Reject reset while cameras initialize');
console.log(JSON.stringify({passed:checks.length,checks},null,2));
