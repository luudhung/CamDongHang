import {driveToken} from './config';
import type {DriveFolder} from './storage';

type PickedDocument={id?:string;name?:string;mimeType?:string};
type PickerResponse={action?:string;docs?:PickedDocument[]};
type PickerView={setIncludeFolders(value:boolean):PickerView;setSelectFolderEnabled(value:boolean):PickerView;setMode(value:string):PickerView};
type PickerBuilder={addView(view:PickerView):PickerBuilder;setOAuthToken(token:string):PickerBuilder;setDeveloperKey(key:string):PickerBuilder;setAppId(id:string):PickerBuilder;setOrigin(origin:string):PickerBuilder;setLocale(locale:string):PickerBuilder;setCallback(callback:(result:PickerResponse)=>void):PickerBuilder;build():{setVisible(visible:boolean):void}};
type PickerApi={Action:{PICKED:string;CANCEL:string;ERROR:string};ViewId:{FOLDERS:string};DocsViewMode:{LIST:string};DocsView:new(id:string)=>PickerView;PickerBuilder:new()=>PickerBuilder};
type PickerWindow=Window&{gapi?:{load(name:string,options:{callback:()=>void;onerror:()=>void}):void};google?:{picker?:PickerApi}};
let pickerReady:Promise<PickerApi>|undefined;

function loadPicker():Promise<PickerApi>{
  if(pickerReady)return pickerReady;
  pickerReady=new Promise<PickerApi>((resolve,reject)=>{
    const host=window as PickerWindow;
    const ready=()=>{
      if(!host.gapi){reject(new Error('Không tải được Google Picker.'));return;}
      host.gapi.load('picker',{callback:()=>host.google?.picker?resolve(host.google.picker):reject(new Error('Google Picker chưa sẵn sàng.')),onerror:()=>reject(new Error('Không tải được Google Picker.'))});
    };
    if(host.google?.picker){resolve(host.google.picker);return;}
    if(host.gapi){ready();return;}
    const script=document.createElement('script');script.src='https://apis.google.com/js/api.js';script.async=true;
    script.onload=ready;script.onerror=()=>reject(new Error('Không tải được thư viện Google Picker.'));
    document.head.appendChild(script);
  }).catch(error=>{pickerReady=undefined;throw error;});
  return pickerReady!;
}

export async function pickDriveFolder():Promise<DriveFolder|null>{
  const [credentials,configResponse,picker]=await Promise.all([driveToken(),fetch('/api/config',{cache:'no-store'}),loadPicker()]);
  if(!configResponse.ok)throw new Error('Không tải được cấu hình Google Picker.');
  const config:{pickerApiKey?:string;pickerAppId?:string}=await configResponse.json();
  if(!config.pickerApiKey||!config.pickerAppId)throw new Error('Google Picker chưa được cấu hình trên máy chủ.');
  const view=new picker.DocsView(picker.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setMode(picker.DocsViewMode.LIST);
  return new Promise((resolve,reject)=>{
    try{
      const dialog=new picker.PickerBuilder().addView(view).setOAuthToken(credentials.accessToken).setDeveloperKey(config.pickerApiKey!).setAppId(config.pickerAppId!).setOrigin(location.origin).setLocale('vi').setCallback(result=>{
        if(result.action===picker.Action.CANCEL){resolve(null);return;}
        if(result.action===picker.Action.ERROR){reject(new Error('Google Picker không mở được thư mục. Hãy thử kết nối lại Drive.'));return;}
        if(result.action!==picker.Action.PICKED)return;
        const folder=result.docs?.[0];
        if(!folder?.id||folder.mimeType!=='application/vnd.google-apps.folder'){reject(new Error('Hãy chọn một thư mục trong My Drive.'));return;}
        resolve({id:folder.id,name:folder.name||'Thư mục Drive',path:folder.id==='root'?'My Drive':folder.name||'Thư mục Drive',grant:'picker'});
      }).build();
      dialog.setVisible(true);
    }catch(error){reject(error);}
  });
}
