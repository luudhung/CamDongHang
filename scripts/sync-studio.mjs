import fs from 'node:fs';
import path from 'node:path';
const source=process.argv[2]||'F:/CamDongHang/public';
const target=path.resolve('public/studio');
fs.mkdirSync(target,{recursive:true});
for(const file of ['styles.css','scanner-worker.js','setup-guide.html','setup-guide.css','setup-guide.js'])fs.copyFileSync(path.join(source,file),path.join(target,file));
for(const folder of ['sounds','vendor','guide'])fs.cpSync(path.join(source,folder),path.join(target,folder),{recursive:true});
let html=fs.readFileSync(path.join(source,'index.html'),'utf8');
html=html.replace('<html lang="en">','<html lang="vi">').replace(/    <script>[\s\S]*?<\/script>/,'');
html=html.replace(/    <link[^\n]*href="\/public\/[^\n]*\n/g,'');
html=html.replace(/    <!-- QR Code generator[^\n]*\n    <script[^\n]*\n/,'');
html=html.replace(/    <link href="https:\/\/fonts\.googleapis[^\n]*\n/,'');
const start=html.indexOf('                <!-- WhatsApp Bot Section -->'),end=html.indexOf('                <p class="developer-credit">');
if(start<0||end<start)throw new Error('Studio markup changed: inspect settings before importing.');
html=html.slice(0,start)+html.slice(end);
html=html.replace('<script src="script.js"></script>','<script src="bridge.js"></script>');
html=html.replace('    <script src="setup-guide-host.js"></script>','');
html=html.replace('Loading cameras...','Đang nhận diện camera…');
html=html.replace('</head>','<style>body > .header{display:none!important}</style></head>');
fs.writeFileSync(path.join(target,'index.html'),html);
let engine=fs.readFileSync(path.join(source,'script.js'),'utf8');
const controller=engine.indexOf('// 💬 WHATSAPP BOT CONTROLLER');
if(controller<0)throw new Error('Studio controller boundary changed.');
engine=engine.slice(0,engine.lastIndexOf('// ============================================================',controller));
engine=`function escapeStudioHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }\n`+engine;
engine=engine.replace('${emp} (${empCode})','${escapeStudioHtml(emp)} (${empCode})')
  .replace('📁 ${video.filename}','📁 ${escapeStudioHtml(video.filename)}')
  .replaceAll('data-key="${videoKey}"','data-key="${escapeStudioHtml(videoKey)}"')
  .replace('title="${video.filename}">${cameraLabel}','title="${escapeStudioHtml(video.filename)}">${escapeStudioHtml(cameraLabel)}')
  .replace('title="${code}">${code}','title="${escapeStudioHtml(code)}">${escapeStudioHtml(code)}');
// QR contents can contain arbitrary characters. Escape the user's search text before HTML output.
engine=engine.replace('function displaySearchResults(results, searchTerm) {',`function displaySearchResults(results, searchTerm) {\n    searchTerm = String(searchTerm).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));`);
engine=engine.replace('Gửi tên nhân viên chuẩn lên server','Đưa tên nhân viên vào bản lưu tại trình duyệt');
engine=engine.replace('Video saved successfully:','Video saved locally:').replace('Error uploading video:','Error saving video locally:').replace('Chưa lưu được video. Tải bản dự phòng trước khi đóng trang:','Chưa ghi được vào bộ nhớ trình duyệt. Tải bản dự phòng trước khi đóng trang:');
fs.writeFileSync(path.join(target,'script.js'),engine);
console.log('Imported camera engine, scanner, local WASM and sounds. No Python, bot, credentials or labels included.');
