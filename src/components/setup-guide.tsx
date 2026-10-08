'use client';
import {useEffect,useRef} from 'react';

const seenKey='camdonghang.setup.v1.seen';
type GuideAction='settings'|'refresh'|'videos'|'storage';
export default function SetupGuide({recording,onAction}:{recording:boolean;onAction:(action:GuideAction)=>void}){
  const dialog=useRef<HTMLDialogElement>(null),frame=useRef<HTMLIFrameElement>(null);
  const latest=useRef({recording,onAction});latest.current={recording,onAction};
  function open(){if(latest.current.recording||dialog.current?.open)return;dialog.current?.showModal();}
  useEffect(()=>{if(recording&&dialog.current?.open)dialog.current.close();},[recording]);
  useEffect(()=>{
    let seen=false;try{seen=localStorage.getItem(seenKey)==='1';}catch{}
    if(!seen)open();
    const onMessage=(event:MessageEvent)=>{
      if(event.origin!==location.origin||event.source!==frame.current?.contentWindow||event.data?.type!=='cam-setup-guide')return;
      const action=event.data.action;
      if(action==='close'||['settings','refresh','videos','storage'].includes(action)){
        dialog.current?.close();
        if(action!=='close')latest.current.onAction(action as GuideAction);
      }
    };
    window.addEventListener('message',onMessage);
    return()=>window.removeEventListener('message',onMessage);
  },[]);
  return <><button className="setup-guide-button" disabled={recording} onClick={open} title="Bố trí camera, quét mã, tự dừng và lưu video"><span aria-hidden="true">ⓘ</span> Hướng dẫn setup</button><dialog className="setup-guide-shell" ref={dialog} aria-label="Hướng dẫn setup CamDongHang" onClose={()=>{try{localStorage.setItem(seenKey,'1');}catch{}}}><iframe ref={frame} title="Hướng dẫn setup từng bước" src="/studio/setup-guide.html?platform=web"/></dialog></>;
}
