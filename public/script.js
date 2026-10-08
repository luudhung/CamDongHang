const cameraGrid = document.getElementById('camera-grid');
const statusMessage = document.getElementById('status-message');
const refreshBtn = document.getElementById('refresh-btn');

const cameraStates = new Map();
const audioCache = new Map();
let cameraInitPromise = null;
let deviceChangeTimer = null;
let cameraDrag = null;

// [THÊM MỚI] Hàm lưu cài đặt camera vào localStorage
function saveCameraSetting(deviceId, key, value) {
    try {
        const settings = JSON.parse(localStorage.getItem('cameraSettings') || '{}');
        if (!settings[deviceId]) settings[deviceId] = {};
        settings[deviceId][key] = value;
        localStorage.setItem('cameraSettings', JSON.stringify(settings));
    } catch (e) {
        console.error("Error saving camera settings:", e);
    }
}

// [THÊM MỚI] Hàm đọc cài đặt camera từ localStorage
function getCameraSetting(deviceId, key) {
    try {
        const settings = JSON.parse(localStorage.getItem('cameraSettings') || '{}');
        return settings[deviceId] ? settings[deviceId][key] : null;
    } catch (e) {
        return null;
    }
}

let scannerWorker = null;
let workerReady = false;
let scannerBusy = false;
let scanIdCounter = 0;
let scannerRestarts = 0;
const pendingScans = new Map();
const scanCanvasCache = new WeakMap();
const scanPasses = new WeakMap();
const scanMisses = new WeakMap();
const scannerWaiters = [];

function clearScannerWaiters() {
    for (const request of scannerWaiters.splice(0)) request.resume(false);
}

function cancelScanRequests(video) {
    for (let i = scannerWaiters.length - 1; i >= 0; i--) {
        if (scannerWaiters[i].video === video) scannerWaiters.splice(i, 1)[0].resume(false);
    }
}

function initScannerWorker() {
    if (scannerWorker) scannerWorker.terminate();
    workerReady = false;
    scannerBusy = false;
    clearScannerWaiters();
    for (const finish of pendingScans.values()) finish(null);
    pendingScans.clear();
    const worker = new Worker('scanner-worker.js');
    scannerWorker = worker;
    worker.addEventListener('message', ({ data }) => {
        if (scannerWorker !== worker) return;
        if (data.type === 'ready') {
            workerReady = true;
            console.log('[Scanner] Ready (local WASM)');
        } else if (data.type === 'result' || data.type === 'error') {
            const finish = pendingScans.get(data.scanId);
            if (finish) finish(data.code ? data : null);
            if (data.type === 'error') console.warn('[Scanner]', data.error);
        }
    });
    worker.addEventListener('error', (error) => {
        console.error('[Scanner] Worker failed:', error.message);
        workerReady = false;
        scannerBusy = false;
        clearScannerWaiters();
        for (const finish of pendingScans.values()) finish(null);
        pendingScans.clear();
    });
}

function getOrCreateScanCanvas(video) {
    if (!scanCanvasCache.has(video)) {
        const canvas = document.createElement('canvas');
        scanCanvasCache.set(video, {
            canvas, context: canvas.getContext('2d', { willReadFrequently: true, alpha: false })
        });
    }
    return scanCanvasCache.get(video);
}

async function scanCode(video) {
    if (!workerReady || !scannerWorker || video.readyState < 2) return null;
    const worker = scannerWorker;
    // Fair turns for all cameras. Queue only requests, then capture a fresh frame
    // when the worker is available; never retain a backlog of camera images.
    if (scannerBusy && !await new Promise(resume => scannerWaiters.push({ video, resume }))) return null;
    if (scannerWorker !== worker || !workerReady) return null;
    scannerBusy = true;
    let bitmap = null;
    try {
        const srcW = video.videoWidth, srcH = video.videoHeight;
        if (!srcW || !srcH || video.readyState < 2) return null;
        const pass = scanPasses.get(video) || 0;
        scanPasses.set(video, pass + 1);
        // Each camera alternates independently. Preserve pixels in the central crop.
        const center = pass % 2 === 1;
        const cropW = center ? Math.floor(srcW * 0.6) : srcW;
        const cropH = center ? Math.floor(srcH * 0.6) : srcH;
        const cropX = Math.floor((srcW - cropW) / 2);
        const cropY = Math.floor((srcH - cropH) / 2);
        const thorough = pass % 3 === 2 || (scanMisses.get(video) || 0) >= 2;
        // Small/dense shipping QR codes need more pixels than a 960px full frame.
        // Escalate only after misses; keep transfer/capture bounded on 4K cameras.
        const scale = Math.min(1, (center ? 1920 : thorough ? 2560 : 1440) / cropW);
        const width = Math.max(1, Math.round(cropW * scale));
        const height = Math.max(1, Math.round(cropH * scale));
        let imageData;
        if (typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined') {
            bitmap = await createImageBitmap(video, cropX, cropY, cropW, cropH, {
                resizeWidth: width, resizeHeight: height, resizeQuality: 'low'
            });
        } else {
            const { canvas, context } = getOrCreateScanCanvas(video);
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width; canvas.height = height;
            }
            context.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, width, height);
            imageData = context.getImageData(0, 0, width, height);
        }
        if (scannerWorker !== worker || !workerReady) return null;
        const result = await new Promise((resolve) => {
            const scanId = scanIdCounter++;
            const finish = (value) => {
                clearTimeout(timeout);
                pendingScans.delete(scanId);
                resolve(value);
            };
            const timeout = setTimeout(() => {
                finish(null);
                // A timed-out job may still consume CPU. Terminate before accepting another.
                if (scannerWorker === worker) {
                    worker.terminate();
                    workerReady = false;
                    clearScannerWaiters();
                    if (scannerRestarts++ < 3) initScannerWorker();
                }
            }, 2500);
            pendingScans.set(scanId, finish);
            try {
                worker.postMessage({ type: 'scan', data: {
                    scanId, bitmap, imageData, width, height, thorough
                } }, bitmap ? [bitmap] : [imageData.data.buffer]);
                bitmap = null; // Ownership transferred to worker.
            } catch (error) {
                finish(null);
                console.warn('[Scanner] Transfer failed:', error);
            }
        });
        scanMisses.set(video, result ? 0 : (scanMisses.get(video) || 0) + 1);
        return result ? result.code : null;
    } catch (error) {
        console.warn('[Scanner] Frame capture failed:', error);
        return null;
    } finally {
        if (bitmap) bitmap.close();
        if (scannerWorker === worker) {
            const request = scannerWaiters.shift();
            if (request) request.resume(true);
            else scannerBusy = false;
        }
    }
}

function getScanDelay(state, elapsed, frequency) {
    const recording = state.isRecording || (state.masterDeviceId && cameraStates.get(state.masterDeviceId)?.isRecording);
    const target = recording ? Math.max(frequency, 400) : frequency;
    // Reserve CPU time for encoding even when a difficult decode exceeds the interval.
    return Math.max(40, target - elapsed);
}


function preloadAudio(filename) {
    if (!audioCache.has(filename)) {
        const audio = new Audio(`sounds/${filename}`);
        audio.preload = 'auto';
        audio.load();
        audioCache.set(filename, audio);
    }
    return audioCache.get(filename);
}

function initializeSounds() {
    for (let i = 1; i <= 10; i++) {
        preloadAudio(`${i}start.wav`);
        preloadAudio(`${i}stop.wav`);
    }
    for (let i = 1; i <= 10; i++) {
        const code = `SNV-${String(i).padStart(3, '0')}`;
        preloadAudio(`${code}_select.wav`);
        preloadAudio(`${code}_start.wav`);
        preloadAudio(`${code}_stop.wav`);
        preloadAudio(`${code}_duplicate.wav`);
    }
    preloadAudio('leaveit.wav');
    preloadAudio('duplicate.wav');
}

window.addEventListener('load', async () => {

    // Initialize Web Worker
    initScannerWorker();

    setTimeout(initializeSounds, 500);
});

class CameraState {
    constructor(deviceId, cameraIndex) {
        this.deviceId = deviceId;
        this.cameraIndex = cameraIndex;
        this.isRecording = false;
        this.currentCode = null;
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.selectedEmployee = null;
        this.employeeCode = null;
        this.scanEnabled = true;
        this.scanInterval = null;
        this.lastScanTime = 0;

        this.isPipMode = false;
        this.pipDeviceId = null;
        this.pipState = null;

        this.stopRecordingTimeout = null;
        this.leaveItActive = false;
        this.isDuplicateRecording = false;
        // [FIX FINAL] Biến này lưu ID của Camera Chủ (nếu camera này đang làm phụ)
        this.masterDeviceId = null;
        // [THÊM] Trạng thái loại đơn hàng: 'normal' (Hàng gửi) hoặc 'return' (Hàng hoàn)
        this.orderType = 'normal';
    }
}

async function getCameras() {
    try {
        // Xin quyền truy cập camera để lấy được tên thiết bị (label)
        const permissionStream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                frameRate: { ideal: 30 }
            }
        });

        // Tắt stream ngay sau khi xin quyền xong
        permissionStream.getTracks().forEach(track => track.stop());
        await new Promise(resolve => setTimeout(resolve, 100));

        // Lấy danh sách thiết bị
        const devices = await navigator.mediaDevices.enumerateDevices();

        return filterCameraDevices(devices);
    } catch (err) {
        console.error("Error enumerating devices:", err);
        showError("Could not access cameras. Please check permissions.");
        return [];
    }
}

function filterCameraDevices(devices) {
    const blockedNames = ['WebcastMate VirtualCamera', 'LSVCam',
        'ByteCast VirtualCamera', 'OBS Virtual Camera', 'NVIDIA Broadcast'];
    return devices.filter(device => {
        if (device.kind !== 'videoinput') return false;
        const label = (device.label || '').toLowerCase();
        if (blockedNames.some(name => label.includes(name.toLowerCase()))) {
            console.log(`[Camera] Ignored virtual camera: ${device.label}`);
            return false;
        }
        return true;
    });
}

async function startStream(deviceId, videoElement, resolution = { width: 1920, height: 1080 }) {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                deviceId: { exact: deviceId },
                width: { ideal: resolution.width },
                height: { ideal: resolution.height },
                frameRate: { ideal: 30 }
            }
        });
        videoElement.srcObject = stream;
        return stream;
    } catch (err) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    deviceId: deviceId,
                    frameRate: { ideal: 30 }
                }
            });
            videoElement.srcObject = stream;
            return stream;
        } catch (retryErr) {
            console.error("Retry failed", retryErr);
            return null;
        }
    }
}

function getEffectiveExtraRecording(isPipMode) {
    const autoSwitch = localStorage.getItem('autoSwitch') === 'true';

    if (isPipMode) {
        const originalValue = localStorage.getItem('extraRecordingOriginal');
        if (originalValue) {
            return parseInt(originalValue) || 4;
        }

        const savedValue = localStorage.getItem('extraRecording');
        if (savedValue && savedValue !== '0') {
            return parseInt(savedValue) || 4;
        }

        return 4;
    } else {
        if (autoSwitch) {
            return 0;
        } else {
            return parseInt(document.getElementById('extra-recording').value) || 0;
        }
    }
}

function playSound(soundFile) {
    const audio = preloadAudio(soundFile);
    const audioClone = audio.cloneNode();
    audioClone.volume = 1.0;
    const playPromise = audioClone.play();
    if (playPromise !== undefined) {
        playPromise.catch(() => { });
    }
}

// Hàm kiểm tra xem chuỗi có phải là URL không
function isUrl(string) {
    try {
        // Kiểm tra cơ bản bằng RegEx trước để loại bỏ nhanh các trường hợp rõ ràng
        // Chấp nhận http, https, ftp, hoặc bắt đầu bằng www.
        const urlPattern = /^(https?:\/\/|ftp:\/\/|www\.)/i;
        if (urlPattern.test(string)) return true;

        // Kiểm tra kỹ hơn bằng URL constructor (nhưng cẩn thận vì nó có thể chấp nhận các chuỗi lạ)
        new URL(string);
        return true;
    } catch (_) {
        return false;
    }
}

// Hàm kiểm tra mã đã tồn tại (GỌI API PYTHON AN TOÀN)
async function checkDuplicateCode(code, orderType) {
    try {
        // Gọi API backend thay vì đọc file tĩnh
        const response = await fetch('/api/check-duplicate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            // Gửi cả code và orderType lên server
            body: JSON.stringify({
                code: code,
                orderType: orderType
            })
        });

        if (!response.ok) {
            return false;
        }

        const data = await response.json();

        if (data.exists) {
            console.log(`[Duplicate Check] ⚠️ Code ${code} (${orderType}) already exists today`);
        }

        return data.exists;

    } catch (error) {
        console.log('[Duplicate Check] Error checking duplicate:', error);
        return false;
    }
}

// Hàm tìm filename tiếp theo chưa bị trùng
async function findNextAvailableFilename(baseFilename, extension = 'mp4') {
    const today = new Date();
    const folderName = `${String(today.getDate()).padStart(2, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${today.getFullYear()}`;

    try {
        // Thử fetch stats.json, nếu fail thì thử lại 1 lần sau 100ms
        let response;
        try {
            response = await fetch(`/Videos/${folderName}/stats.json`);
        } catch (e) {
            await new Promise(r => setTimeout(r, 200)); // Wait 200ms
            response = await fetch(`/Videos/${folderName}/stats.json`);
        }

        let existingFiles = [];

        if (response.ok) {
            const stats = await response.json();
            existingFiles = stats.videos.map(v => v.filename);
        }

        // [FIX QUAN TRỌNG] 1. Kiểm tra tên gốc trước (Không có hậu tố _00)
        let filename = `${baseFilename}.${extension}`;
        if (!existingFiles.includes(filename)) {
            // Nếu tên gốc chưa có -> Dùng luôn tên này
            return filename;
        }

        // [FIX QUAN TRỌNG] 2. Nếu tên gốc đã có -> Mới bắt đầu tìm suffix _00, _01...
        let suffix = 0;

        while (true) {
            const suffixStr = String(suffix).padStart(2, '0');
            filename = `${baseFilename}_${suffixStr}.${extension}`;

            // Kiểm tra xem file đã tồn tại chưa
            if (!existingFiles.includes(filename)) {
                return filename; // Trả về ngay khi tìm thấy
            }

            suffix++;

            // Giới hạn tối đa 99 file trùng
            if (suffix > 99) {
                console.warn('[Save] Too many duplicate files, using random suffix');
                const randomSuffix = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
                return `${baseFilename}_${randomSuffix}.${extension}`;
            }
        }

    } catch (error) {
        console.error('[Save] Error finding next filename:', error);
        // Fallback: dùng timestamp
        const timestamp = Date.now();
        return `${baseFilename}_${timestamp}.${extension}`;
    }
}

// [THAY THẾ TOÀN BỘ HÀM startRecording BẰNG ĐOẠN NÀY]
async function startRecording(state, mainVideoElement, pipVideoElement = null) {
    if (cameraStates.get(state.deviceId) !== state) return;
    if (state.masterDeviceId) return;
    if (state.isRecording || state.isStartingRecording) return;
    state.isStartingRecording = true;
    state.isRecording = true;
    state.recordingPerformance = null;
    let videoStream, audioStream, recorder;
    const cleanup = () => {
        if (videoStream?._cleanup) videoStream._cleanup();
        if (audioStream) audioStream.getTracks().forEach(track => track.stop());
    };
    try {
        videoStream = pipVideoElement?.srcObject
            ? await createCompositeStream(mainVideoElement, pipVideoElement, state)
            : await createSingleCameraStream(mainVideoElement, state);
        if (localStorage.getItem('recordAudio') === 'true') {
            try {
                audioStream = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: true, noiseSuppression: true }, video: false
                });
            } catch (error) { console.warn('[Recording] Microphone unavailable:', error); }
        }
        if (!state.isRecording || cameraStates.get(state.deviceId) !== state) {
            cleanup();
            return;
        }
        const combinedStream = new MediaStream([
            ...videoStream.getVideoTracks(), ...(audioStream?.getAudioTracks() || [])
        ]);
        const width = mainVideoElement.videoWidth;
        const videoBitsPerSecond = width >= 2560 ? 8000000 : width >= 1920 ? 5000000 : 2500000;
        const mimeTypes = audioStream
            ? ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm']
            : ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp8', 'video/webm'];
        const mimeType = mimeTypes.find(type => MediaRecorder.isTypeSupported(type));
        const options = { videoBitsPerSecond, ...(mimeType ? { mimeType } : {}) };
        try { recorder = new MediaRecorder(combinedStream, options); }
        catch { recorder = new MediaRecorder(combinedStream); }
        state.mediaRecorder = recorder;
        state.recordingStartTime = Date.now();
        const chunks = [];
        state.recordedChunks = chunks;
        // Each recording owns its metadata. A new order can start while this one uploads.
        const snapshot = {
            cameraIndex: state.cameraIndex, currentCode: state.currentCode,
            selectedEmployee: state.selectedEmployee, orderType: state.orderType,
            recordingStartTime: state.recordingStartTime, mediaRecorder: recorder
        };
        recorder.ondataavailable = ({ data }) => { if (data?.size) chunks.push(data); };
        recorder.onstop = async () => {
            snapshot.recordingEndTime = Date.now();
            cleanup();
            if (state.mediaRecorder === recorder) {
                state.isRecording = false;
                state.recordedChunks = [];
            }
            try { await saveRecordingWithData(snapshot, chunks, snapshot.currentCode); }
            finally { chunks.length = 0; }
        };
        recorder.onerror = ({ error }) => {
            console.error('[Recording] Encoder error:', error);
            if (state.mediaRecorder === recorder) state.isRecording = false;
            if (recorder.state !== 'inactive') recorder.stop();
            else cleanup();
            showError('Lỗi ghi video: ' + (error?.message || 'bộ mã hóa không hoạt động'));
        };
        recorder.start(1000);
        console.log('[Recording] Started:', recorder.mimeType, width, mainVideoElement.videoHeight,
            mainVideoElement.srcObject.getVideoTracks()[0].getSettings());
    } catch (error) {
        cleanup();
        state.isRecording = false;
        console.error('[Recording] Could not start:', error);
        showError('Không bắt đầu được video: ' + error.message);
    } finally { state.isStartingRecording = false; }
}


async function waitForVideoFrame(video, state) {
    const deadline = performance.now() + 5000;
    while (video.readyState < 2 || !video.videoWidth) {
        if (!state.isRecording || performance.now() > deadline) throw new Error('Camera chưa có hình để ghi');
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

async function createRenderedRecordingStream(mainVideo, pipVideo, state) {
    await waitForVideoFrame(mainVideo, state);
    if (pipVideo) await waitForVideoFrame(pipVideo, state);
    const canvas = document.createElement('canvas');
    canvas.width = mainVideo.videoWidth;
    canvas.height = mainVideo.videoHeight;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    const sourceTrack = mainVideo.srcObject.getVideoTracks()[0];
    const sourceFps = sourceTrack.getSettings().frameRate || 30;
    const fps = Math.min(30, sourceFps);
    const interval = 1000 / fps;
    const stream = canvas.captureStream(0);
    let track = stream.getVideoTracks()[0];
    // Engines without manual capture need automatic canvas capture.
    let manualCapture = typeof track.requestFrame === 'function';
    if (!manualCapture) {
        track.stop();
        stream.removeTrack(track);
        track = canvas.captureStream(fps).getVideoTracks()[0];
        stream.addTrack(track);
    }
    const overlay = document.createElement('canvas');
    overlay.width = canvas.width; overlay.height = 60;
    const overlayCtx = overlay.getContext('2d');
    let overlayKey = '';
    let running = true, callbackId = null, timerId = null;
    let nextFrame = 0, lastMediaTime = -1;
    let sampleStart = performance.now(), drawn = 0;
    const useVideoCallback = typeof mainVideo.requestVideoFrameCallback === 'function';

    const draw = (now, metadata) => {
        if (!running || !state.isRecording || mainVideo.readyState < 2) return;
        const mediaTime = metadata ? metadata.mediaTime : mainVideo.currentTime;
        if (mediaTime === lastMediaTime) return;
        // Video callbacks already run at source cadence. Only cap sources faster than 30 FPS.
        if ((!metadata || sourceFps > 30.5) && now + 1 < nextFrame) return;
        nextFrame = now + interval - Math.max(0, now - nextFrame) % interval;
        lastMediaTime = mediaTime;
        ctx.drawImage(mainVideo, 0, 0, canvas.width, canvas.height);
        if (pipVideo && pipVideo.readyState >= 2) {
            const scale = Math.max(10, Math.min(100, parseInt(localStorage.getItem('pipScale')) || 35));
            const h = canvas.height * scale / 100, w = h * 9 / 16, x = canvas.width - w;
            ctx.save();
            ctx.translate(x + w / 2, h / 2);
            ctx.rotate(Math.PI / 2);
            ctx.drawImage(pipVideo, -h / 2, -w / 2, h, w);
            ctx.restore();
            ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 4;
            ctx.strokeRect(x, 0, w, h);
        }
        // Text rasterization and measurement once per second, rather than every frame.
        const second = Math.floor(Date.now() / 1000);
        const key = `${second}|${state.currentCode}|${localStorage.getItem('timeOffset')}`;
        if (key !== overlayKey) {
            overlayKey = key;
            overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
            overlayCtx.font = 'bold 24px Arial';
            overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            overlayCtx.fillRect(10, 10, 320, 40);
            overlayCtx.fillStyle = '#fff';
            overlayCtx.fillText(formatTimestamp(), 20, 38);
            if (state.currentCode) {
                const text = `REC: ${state.currentCode}`;
                const width = overlayCtx.measureText(text).width;
                overlayCtx.fillStyle = 'rgba(37, 99, 235, 0.9)';
                overlayCtx.fillRect(canvas.width - width - 30, 10, width + 20, 40);
                overlayCtx.fillStyle = '#fff';
                overlayCtx.fillText(text, canvas.width - width - 20, 38);
            }
        }
        ctx.drawImage(overlay, 0, 0);
        if (manualCapture) track.requestFrame();
        drawn++;
        if (now - sampleStart >= 1000) {
            state.recordingPerformance = {
                sourceFps, renderFps: Math.round(drawn * 1000 / (now - sampleStart)),
                width: canvas.width, height: canvas.height
            };
            drawn = 0; sampleStart = now;
        }
    };

    const cancel = () => {
        if (callbackId !== null) {
            if (useVideoCallback) mainVideo.cancelVideoFrameCallback(callbackId);
            else cancelAnimationFrame(callbackId);
            callbackId = null;
        }
        if (timerId !== null) { clearTimeout(timerId); timerId = null; }
    };
    const schedule = () => {
        if (!running || !state.isRecording) return;
        if (document.hidden) {
            timerId = setTimeout(() => {
                timerId = null; draw(performance.now()); schedule();
            }, interval);
        } else if (useVideoCallback) {
            callbackId = mainVideo.requestVideoFrameCallback((now, metadata) => {
                callbackId = null; draw(now, metadata); schedule();
            });
        } else {
            callbackId = requestAnimationFrame(now => {
                callbackId = null; draw(now); schedule();
            });
        }
    };
    const visibilityChanged = () => { cancel(); nextFrame = 0; schedule(); };
    document.addEventListener('visibilitychange', visibilityChanged);
    stream._cleanup = () => {
        if (!running) return;
        running = false; cancel();
        document.removeEventListener('visibilitychange', visibilityChanged);
        stream.getTracks().forEach(t => t.stop());
    };
    draw(performance.now());
    schedule();
    return stream;
}

function createSingleCameraStream(video, state) {
    return createRenderedRecordingStream(video, null, state);
}

function createCompositeStream(mainVideo, pipVideo, state) {
    return createRenderedRecordingStream(mainVideo, pipVideo, state);
}


function stopRecording(state, extraTime = 0) {
    if (state.isStartingRecording) {
        state.isRecording = false;
        return;
    }
    if (!state.isRecording || !state.mediaRecorder) return;

    if (state.stopRecordingTimeout) {
        clearTimeout(state.stopRecordingTimeout);
        state.stopRecordingTimeout = null;
    }

    if (extraTime > 0) {
        state.stopRecordingTimeout = setTimeout(() => {
            if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
                state.mediaRecorder.stop();
                state.isRecording = false;
                state.stopRecordingTimeout = null;
            }
        }, extraTime * 1000);
    } else {
        if (state.mediaRecorder.state === 'recording') {
            state.mediaRecorder.stop();
            state.isRecording = false;
        }
    }
}

async function saveRecordingWithData(state, chunks, code) {
    if (chunks.length === 0) {
        console.error('No chunks to save');
        return;
    }

    const blob = new Blob(chunks, { type: state.mediaRecorder.mimeType });
    const recordingDuration = state.recordingStartTime
        ? Math.floor(((state.recordingEndTime || Date.now()) - state.recordingStartTime) / 1000)
        : 0;

    console.log('Recording duration:', recordingDuration, 'seconds');

    // ========== TẠO FILENAME ==========
    let baseFilename;
    if (state.selectedEmployee) {
        baseFilename = `${state.selectedEmployee}_${code}`;
    } else {
        baseFilename = `Camera${state.cameraIndex + 1}_${code}`;
    }

    if (state.orderType === 'return') {
        baseFilename += '_Return';
    }

    const extension = blob.type.includes('mp4') ? 'mp4' : 'webm';
    let filename = await findNextAvailableFilename(baseFilename, extension);
    const formData = new FormData();
    formData.append('video', blob, filename);
    formData.append('cameraId', state.cameraIndex + 1);
    formData.append('code', code);
    formData.append('duration', recordingDuration);
    formData.append('orderType', state.orderType);

    // [THÊM DÒNG NÀY QUAN TRỌNG] Gửi tên nhân viên chuẩn lên server
    if (state.selectedEmployee) {
        formData.append('employee', state.selectedEmployee);
    }

    try {
        const response = await fetch('/upload-video', {
            method: 'POST',
            body: formData
        });
        if (!response.ok) throw new Error(await response.text());
        console.log('Video saved successfully:', filename);
    } catch (err) {
        console.error('Error uploading video:', err);
        // Keep the Blob reachable through a download link if the server/disk fails.
        let recovery = document.getElementById('recording-recovery');
        if (!recovery) {
            recovery = document.createElement('div');
            recovery.id = 'recording-recovery';
            recovery.style.cssText = 'padding:12px;color:#fff;background:#7f1d1d;border-radius:12px;margin:12px;';
            cameraGrid.before(recovery);
        }
        const item = document.createElement('div');
        item.append(document.createTextNode('Chưa lưu được video. Tải bản dự phòng trước khi đóng trang: '));
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.textContent = filename;
        link.style.color = '#fff';
        item.append(link);
        recovery.append(item);
    }
}

async function handlePipCodeDetection(mainState, code, mainVideo, pipVideo) {
    const now = Date.now();

    // Reduce debounce from 1000ms to 500ms (match single camera)
    if (now - mainState.lastScanTime < 500) return;
    mainState.lastScanTime = now;

    // [THÊM MỚI] Kiểm tra nếu mã là URL thì bỏ qua
    if (isUrl(code)) {
        console.log(`[PiP] Ignored URL code: ${code}`);
        return;
    }

    // Bỏ qua nếu mã bắt đầu bằng dấu #
    if (code.startsWith('#')) {
        console.log(`[PiP] Ignored hashtag code: ${code}`);
        return;
    }

    // [THÊM ĐOẠN NÀY] Bỏ qua nếu mã có đúng 8 ký tự
    //if (code.length === 8) {
    //console.log(`[Scanner] Ignored 8-char code: ${code}`);
    //return;
    //}

    const employeeMatch = code.match(/^SNV-(\d+)$/);
    if (employeeMatch) {
        const employeeIndex = parseInt(employeeMatch[1]) - 1;
        const employees = getEmployees();

        if (employeeIndex >= 0 && employeeIndex < employees.length) {
            mainState.selectedEmployee = employees[employeeIndex];
            mainState.employeeCode = code;

            const container = document.querySelector(`.camera-container[data-device-id="${mainState.deviceId}"]`);
            if (container) {
                const employeeSelect = container.querySelector('.employee-selector');
                if (employeeSelect) {
                    employeeSelect.value = mainState.selectedEmployee;
                }
            }

            playSound(`${code}_select.wav`);
        }
        return;
    }

    if (code === 'LEAVEIT') {
        if (mainState.isRecording) {
            if (mainState.leaveItActive) return;

            mainState.leaveItActive = true;
            playSound('leaveit.wav');

            const extraRecording = getEffectiveExtraRecording(true);
            stopRecording(mainState, extraRecording);

            const soundFile = mainState.employeeCode ? `${mainState.employeeCode}_stop.wav` : `${mainState.cameraIndex + 1}stop.wav`;

            // Store timeout ID để có thể hủy nếu có mã mới xuất hiện
            mainState.stopSoundTimeout = setTimeout(() => {
                // Chỉ phát stop sound nếu không có mã mới đã xuất hiện
                if (mainState.leaveItActive) {
                    playSound(soundFile);
                }
            }, Math.max(0, extraRecording * 1000 - 100));

            setTimeout(() => {
                mainState.leaveItActive = false;
            }, (extraRecording * 1000) + 1000);
        }
        return;
    }

    // DUAL CAMERA MODE
    if (!mainState.isRecording) {
        // START NEW RECORDING

        // CRITICAL: Disable scanning IMMEDIATELY
        if (mainState.pipState) {
            mainState.pipState.scanEnabled = false;
        }
        console.log('[PiP] Disabled scanning for 3s (recording start)');

        // ========== KIỂM TRA MÃ TRÙNG (PiP Mode) ==========
        const isDuplicate = await checkDuplicateCode(code, mainState.orderType);
        mainState.isDuplicateRecording = isDuplicate; // Lưu trạng thái duplicate

        mainState.currentCode = code;

        // Play sound - DUPLICATE hoặc START
        let soundFile;
        if (isDuplicate) {
            // Phát âm thanh duplicate
            soundFile = mainState.employeeCode
                ? `${mainState.employeeCode}_duplicate.wav`
                : 'duplicate.wav';
            console.log(`[PiP] ⚠️ DUPLICATE code detected: ${code}`);
        } else {
            // Phát âm thanh start bình thường
            soundFile = mainState.employeeCode
                ? `${mainState.employeeCode}_start.wav`
                : `${mainState.cameraIndex + 1}start.wav`;
        }
        playSound(soundFile);
        // ========== KẾT THÚC KIỂM TRA ==========

        startRecording(mainState, mainVideo, pipVideo);

        // Re-enable after 3s
        setTimeout(() => {
            if (mainState.pipState) {
                mainState.pipState.scanEnabled = true;
            }
            console.log('[PiP] Re-enabled scanning');
        }, 3000);

    } else {
        // ALREADY RECORDING
        if (code !== mainState.currentCode) {
            // DIFFERENT CODE: SWITCH IMMEDIATELY (no stop sound!)
            console.log(`[PiP] Switching from ${mainState.currentCode} to ${code}`);

            // Disable scanning immediately
            if (mainState.pipState) {
                mainState.pipState.scanEnabled = false;
            }
            console.log('[PiP] Disabled scanning for 3s (switching)');

            // Clear any pending stop timeout

            // HUY TIMEOUT AM THANH STOP NEU DANG TRONG GIAI DOAN GHI HINH THEM
            if (mainState.stopSoundTimeout) {
                clearTimeout(mainState.stopSoundTimeout);
                mainState.stopSoundTimeout = null;
                //console.log('[PiP] Cancelled stop sound (switching to new code)');
            }
            if (mainState.stopRecordingTimeout) {
                clearTimeout(mainState.stopRecordingTimeout);
                mainState.stopRecordingTimeout = null;
            }

            mainState.leaveItActive = false;

            // Stop current recording (NO STOP SOUND!)
            if (mainState.mediaRecorder && mainState.mediaRecorder.state === 'recording') {
                mainState.isRecording = false;
                mainState.mediaRecorder.stop();

                // Start new recording after brief delay
                setTimeout(async () => {
                    // ========== KIỂM TRA MÃ TRÙNG KHI SWITCH ==========
                    const isDuplicate = await checkDuplicateCode(code, mainState.orderType);
                    mainState.isDuplicateRecording = isDuplicate;

                    mainState.currentCode = code;

                    // Play sound - DUPLICATE hoặc START (no stop sound to avoid confusion)
                    let soundFile;
                    if (isDuplicate) {
                        soundFile = mainState.employeeCode
                            ? `${mainState.employeeCode}_duplicate.wav`
                            : 'duplicate.wav';
                        console.log(`[PiP] ⚠️ DUPLICATE code detected when switching: ${code}`);
                    } else {
                        soundFile = mainState.employeeCode
                            ? `${mainState.employeeCode}_start.wav`
                            : `${mainState.cameraIndex + 1}start.wav`;
                    }
                    playSound(soundFile);
                    // ========== KẾT THÚC KIỂM TRA ==========

                    console.log(`[PiP] Starting new recording for ${code}`);
                    startRecording(mainState, mainVideo, pipVideo);

                    // Re-enable scanning after 3s
                    setTimeout(() => {
                        if (mainState.pipState) {
                            mainState.pipState.scanEnabled = true;
                        }
                        console.log('[PiP] Re-enabled scanning');
                    }, 3000);
                }, 500);
            }
        }
        // If same code: ignore (can't stop by re-scanning in dual mode)
    }
}

async function handleCodeDetection(state, code, videoElement) {
    // Lấy state mới nhất để kiểm tra chủ quyền
    const liveState = cameraStates.get(state.deviceId);

    // Nếu camera này là Nô lệ (có Master) -> CẤM TỰ XỬ LÝ
    if (liveState && liveState.masterDeviceId) {
        stopScanning(state);
        return;
    }

    // Debounce: Chống quét liên tục quá nhanh (500ms)
    const now = Date.now();
    if (now - state.lastScanTime < 500) return;
    state.lastScanTime = now;

    // [THÊM MỚI] Kiểm tra nếu mã là URL thì bỏ qua
    if (isUrl(code)) {
        console.log(`[Scanner] Ignored URL code: ${code}`);
        return;
    }
    // Bỏ qua nếu mã bắt đầu bằng dấu #
    if (code.startsWith('#')) {
        console.log(`[Scanner] Ignored hashtag code: ${code}`);
        return;
    }

    // [THÊM ĐOẠN NÀY] Bỏ qua nếu mã có đúng 8 ký tự
    //if (code.length === 8) {
    //console.log(`[Scanner] Ignored 8-char code: ${code}`);
    //return;
    //}

    // 1. Xử lý mã nhân viên
    const employeeMatch = code.match(/^SNV-(\d+)$/);
    if (employeeMatch) {
        // ... (Giữ nguyên logic nhân viên cũ) ...
        const employeeIndex = parseInt(employeeMatch[1]) - 1;
        const employees = getEmployees();
        if (employeeIndex >= 0 && employeeIndex < employees.length) {
            state.selectedEmployee = employees[employeeIndex];
            state.employeeCode = code;
            const container = document.querySelector(`.camera-container[data-device-id="${state.deviceId}"]`);
            if (container) {
                const employeeSelect = container.querySelector('.employee-selector');
                if (employeeSelect) employeeSelect.value = state.selectedEmployee;
            }
            playSound(`${code}_select.wav`);
        }
        return;
    }

    const autoSwitch = localStorage.getItem('autoSwitch') === 'true';

    // 2. Xử lý LEAVEIT
    if (code === 'LEAVEIT') {
        if (state.isRecording) {
            // [LOGIC YÊU CẦU]: Quét LEAVEIT thì dừng luôn (bất kể chế độ nào)
            // Do đó tham số extraTime truyền vào là 0
            console.log('[Scanner] LEAVEIT detected -> Stop Immediately');

            const soundFile = state.employeeCode ? `${state.employeeCode}_stop.wav` : `${state.cameraIndex + 1}stop.wav`;
            playSound(soundFile);

            stopRecording(state, 0); // 0 giây = Dừng ngay lập tức
        }
        return;
    }

    // 3. Xử lý Bắt đầu / Dừng quay
    if (!state.isRecording) {
        // --- BẮT ĐẦU QUAY (Logic chung cho cả 2 chế độ) ---
        state.scanEnabled = false;

        // [SỬA] Truyền thêm state.orderType
        const isDuplicate = await checkDuplicateCode(code, state.orderType);
        state.isDuplicateRecording = isDuplicate;
        state.currentCode = code;

        let soundFile;
        if (isDuplicate) {
            soundFile = state.employeeCode ? `${state.employeeCode}_duplicate.wav` : 'duplicate.wav';
        } else {
            soundFile = state.employeeCode ? `${state.employeeCode}_start.wav` : `${state.cameraIndex + 1}start.wav`;
        }
        playSound(soundFile);

        startRecording(state, videoElement);

        setTimeout(() => {
            state.scanEnabled = true;
        }, 3000);

    } else {
        // --- ĐANG QUAY ---
        if (code === state.currentCode) {
            // >>> TRƯỜNG HỢP: QUÉT LẠI MÃ CŨ <<<

            if (autoSwitch) {
                // [LOGIC YÊU CẦU - CHẾ ĐỘ NHANH]:
                // Nếu bật đóng gói nhanh -> Quét mã cũ KHÔNG LÀM GÌ CẢ
                console.log('[Scanner] AutoSwitch ON + Same Code -> Ignored');
                return;
            } else {
                // [LOGIC YÊU CẦU - CHẾ ĐỘ THƯỜNG]:
                // Nếu tắt đóng gói nhanh -> Quét mã cũ -> Ghi thêm rồi dừng
                state.scanEnabled = false;

                const soundFile = state.employeeCode ? `${state.employeeCode}_stop.wav` : `${state.cameraIndex + 1}stop.wav`;
                playSound(soundFile);

                // Lấy thời gian ghi thêm từ cài đặt (ví dụ 4s hoặc 8s)
                const extraRecording = getEffectiveExtraRecording(false);
                console.log(`[Scanner] Normal Mode + Same Code -> Stop in ${extraRecording}s`);

                stopRecording(state, extraRecording);

                setTimeout(() => {
                    state.scanEnabled = true;
                }, (extraRecording * 1000) + 1000);
            }

        } else {
            // >>> TRƯỜNG HỢP: QUÉT MÃ MỚI <<<

            if (autoSwitch) {
                // [LOGIC YÊU CẦU - CHẾ ĐỘ NHANH]:
                // Quét mã khác -> Dừng mã cũ -> Quay mã mới luôn
                state.scanEnabled = false;

                if (state.stopRecordingTimeout) {
                    clearTimeout(state.stopRecordingTimeout);
                    state.stopRecordingTimeout = null;
                }

                if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
                    state.isRecording = false;
                    state.mediaRecorder.stop();

                    // Đợi file cũ lưu xong một chút rồi bắt đầu file mới
                    setTimeout(() => {
                        state.currentCode = code;
                        const soundFile = state.employeeCode ? `${state.employeeCode}_start.wav` : `${state.cameraIndex + 1}start.wav`;
                        playSound(soundFile);

                        // Kiểm tra trùng mã cho mã mới (optional nhưng tốt)
                        checkDuplicateCode(code, state.orderType).then(isDup => {
                            state.isDuplicateRecording = isDup;
                            startRecording(state, videoElement);
                        });

                        setTimeout(() => {
                            state.scanEnabled = true;
                        }, 3000);
                    }, 500);
                }
            } else {
                // [LOGIC - CHẾ ĐỘ THƯỜNG]:
                // Quét mã khác khi đang quay -> Bỏ qua (hoặc cảnh báo), ở đây ta chọn Bỏ qua để an toàn
                console.log('[Scanner] Normal Mode + Diff Code -> Ignored (Must stop first)');
            }
        }
    }
}

// ========== SCANNING LOOP - WORKER THREAD VERSION ==========

function startScanning(state, videoElement) {
    // [FIX FINAL] Kiểm tra thẻ chủ quyền trực tiếp
    // Nếu masterDeviceId khác null, nghĩa là camera này đang là nô lệ -> KHÔNG ĐƯỢC CHẠY
    const liveState = cameraStates.get(state.deviceId);
    if (liveState && liveState.masterDeviceId) {
        console.log(`[Scanner] Blocked start for Cam ${state.cameraIndex + 1} (Owned by another camera)`);
        return;
    }

    // [THÊM MỚI] Kiểm tra 2: Nếu là Chủ (Master) và đang bật PiP -> KHÔNG QUÉT
    if (liveState && liveState.isPipMode) {
        console.log(`[Scanner] Cam ${state.cameraIndex + 1} is Master - Internal scan disabled`);
        return;
    }

    const scanFrequency = parseInt(localStorage.getItem('scanFrequency')) || 300;

    if (state.scanInterval) {
        clearTimeout(state.scanInterval);
        state.scanInterval = null;
    }

    state.scanVideo = videoElement;
    const scanGeneration = state.scanGeneration = (state.scanGeneration || 0) + 1;
    const scanLoop = async () => {
        if (state.scanGeneration !== scanGeneration) return;
        // [FIX FINAL] Check lại trong vòng lặp
        const currentLiveState = cameraStates.get(state.deviceId);
        if (currentLiveState && currentLiveState.masterDeviceId) {
            console.log(`[Scanner] Killing loop for Cam ${state.cameraIndex + 1} (Became Slave)`);
            state.scanInterval = null;
            return;
        }

        if (!state.scanEnabled) {
            state.scanInterval = setTimeout(scanLoop, scanFrequency);
            return;
        }

        const startTime = Date.now();

        if (videoElement.readyState === videoElement.HAVE_ENOUGH_DATA) {
            const code = await scanCode(videoElement);
            if (state.scanGeneration !== scanGeneration) return;

            // [FIX FINAL] Check lại sau khi await (Quan trọng nhất)
            const postScanState = cameraStates.get(state.deviceId);
            if (postScanState && postScanState.masterDeviceId) {
                console.log(`[Scanner] Dropping result for Cam ${state.cameraIndex + 1} (Owned by Master)`);
                return;
            }

            if (!state.scanInterval) return;

            if (code && state.scanEnabled) {
                handleCodeDetection(state, code, videoElement);
            }
        }

        // ... logic delay giữ nguyên
        const elapsed = Date.now() - startTime;
        const delay = getScanDelay(state, elapsed, scanFrequency);
        if (state.scanInterval !== null) {
            state.scanInterval = setTimeout(scanLoop, delay);
        }
    };

    state.scanInterval = true;
    scanLoop();
}

// [THÊM MỚI] Hàm khởi động vòng lặp quét cho Camera Phụ (PiP)
function startPipScanning(mainState, mainVideo, pipVideo) {
    // Kiểm tra an toàn
    if (!mainState.pipState || !mainState.isPipMode) return;

    // Dừng quét cũ của camera phụ nếu có
    stopScanning(mainState.pipState);

    const scanFrequency = parseInt(localStorage.getItem('scanFrequency')) || 300;

    const scanState = mainState.pipState;
    scanState.scanVideo = pipVideo;
    const scanGeneration = scanState.scanGeneration = (scanState.scanGeneration || 0) + 1;
    const pipScanLoop = async () => {
        if (mainState.pipState !== scanState || scanState.scanGeneration !== scanGeneration) return;
        // 1. Kiểm tra nếu chế độ PiP bị tắt hoặc mất kết nối
        if (!mainState.pipState || !mainState.isPipMode) {
            if (mainState.pipState) mainState.pipState.scanInterval = null;
            return;
        }

        // 2. Nếu đang tạm dừng quét (ví dụ lúc vừa bắt đầu quay), đợi và check lại
        if (!mainState.pipState.scanEnabled) {
            mainState.pipState.scanInterval = setTimeout(pipScanLoop, scanFrequency);
            return;
        }

        const startTime = Date.now();

        // 3. Thực hiện quét
        if (pipVideo && pipVideo.readyState >= pipVideo.HAVE_ENOUGH_DATA) {
            const code = await scanCode(pipVideo);
            if (mainState.pipState !== scanState || scanState.scanGeneration !== scanGeneration) return;

            // Check lại state sau khi await (đề phòng người dùng tắt PiP trong lúc đang quét)
            if (code && mainState.pipState && mainState.pipState.scanEnabled) {
                handlePipCodeDetection(mainState, code, mainVideo, pipVideo);
            }
        }

        // 4. Tính toán delay bù trừ
        const elapsed = Date.now() - startTime;
        const delay = getScanDelay(scanState, elapsed, scanFrequency);

        // Tiếp tục vòng lặp nếu vẫn còn state
        if (mainState.pipState) {
            mainState.pipState.scanInterval = setTimeout(pipScanLoop, delay);
        }
    };

    // Đánh dấu là đang chạy
    mainState.pipState.scanInterval = true;
    pipScanLoop();
    console.log(`[PiP] Started scanning loop for Cam ${mainState.pipState.cameraIndex + 1} (Slave)`);
}

function stopScanning(state) {
    state.scanGeneration = (state.scanGeneration || 0) + 1;
    cancelScanRequests(state.scanVideo);
    state.scanVideo = null;
    if (state.scanInterval) {
        clearTimeout(state.scanInterval);
        state.scanInterval = null;
        console.log('[Scanner] Stopped scan loop for camera', state.cameraIndex + 1);
    }
}

// ========== FORMAT TIMESTAMP FOR VIDEO ==========
let timeOffsetStart = null; // Lưu thời điểm bắt đầu offset
let realTimeStart = null;   // Lưu thời gian thực khi bắt đầu

function formatTimestamp() {
    const timeOffsetSetting = localStorage.getItem('timeOffset');

    if (timeOffsetSetting) {
        // Nếu có offset
        if (!timeOffsetStart || !realTimeStart) {
            // Khởi tạo lần đầu
            timeOffsetStart = new Date(timeOffsetSetting);
            realTimeStart = new Date();
        }

        // Tính thời gian đã trôi qua kể từ khi bắt đầu
        const now = new Date();
        const elapsed = now - realTimeStart; // milliseconds

        // Thời gian hiển thị = offset + elapsed
        const displayTime = new Date(timeOffsetStart.getTime() + elapsed);

        const hours = String(displayTime.getHours()).padStart(2, '0');
        const minutes = String(displayTime.getMinutes()).padStart(2, '0');
        const seconds = String(displayTime.getSeconds()).padStart(2, '0');

        const day = String(displayTime.getDate()).padStart(2, '0');
        const month = String(displayTime.getMonth() + 1).padStart(2, '0');
        const year = displayTime.getFullYear();

        return `${hours}:${minutes}:${seconds} - ${day}/${month}/${year}`;
    } else {
        // Không có offset - dùng thời gian thực
        timeOffsetStart = null;
        realTimeStart = null;

        const now = new Date();

        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');

        const day = String(now.getDate()).padStart(2, '0');
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const year = now.getFullYear();

        return `${hours}:${minutes}:${seconds} - ${day}/${month}/${year}`;
    }
}
// ========== REST OF THE CODE (UNCHANGED) ==========

function getEmployees() {
    const savedEmployees = localStorage.getItem('employees');
    return savedEmployees ? JSON.parse(savedEmployees) : [];
}

function cameraContainer(deviceId) {
    return [...cameraGrid.querySelectorAll('.camera-container')].find(node => node.dataset.deviceId === deviceId);
}

function cameraLayoutBusy(states) {
    return states.some(state => state && (state.isRecording || state.isStartingRecording ||
        (state.mediaRecorder && state.mediaRecorder.state !== 'inactive')));
}

// Release only the PiP clone. The original preview stream stays live for Reset.
function releaseCameraPip(state) {
    const container = cameraContainer(state.deviceId);
    const pipVideo = container?.querySelector('.pip-video');
    if (state.pipState) {
        stopScanning(state.pipState);
        state.pipState.masterDeviceId = null;
        state.pipState.isAssignedAsPiP = false;
    }
    state.isPipMode = false;
    state.pipState = null;
    state.pipDeviceId = null;
    if (pipVideo) {
        pipVideo.onloadeddata = null;
        pipVideo.srcObject?.getTracks().forEach(track => track.stop());
        pipVideo.srcObject = null;
    }
    container?.querySelector('.pip-overlay')?.classList.remove('active');
    const select = container?.querySelector('.pip-select');
    if (select) select.value = '';
    saveCameraSetting(state.deviceId, 'pipDeviceId', null);
}

// Both the dropdown and drag gesture use the same ownership and recording checks.
function setCameraPip(mainId, auxiliaryId) {
    const main = cameraStates.get(mainId);
    const auxiliary = auxiliaryId ? cameraStates.get(auxiliaryId) : null;
    const previousOwner = auxiliary?.masterDeviceId ? cameraStates.get(auxiliary.masterDeviceId) : null;
    if (!main || main.masterDeviceId || mainId === auxiliaryId || (auxiliaryId && !auxiliary)) return false;
    if (main.pipDeviceId === (auxiliaryId || null)) return true;
    const involved = [main, main.pipState, auxiliary, auxiliary?.pipState, previousOwner];
    if (cameraLayoutBusy(involved)) {
        showError('Dừng quay các camera liên quan trước khi ghép hoặc tách cam phụ.');
        return false;
    }
    let clone = null;
    if (auxiliary) {
        const stream = cameraContainer(auxiliaryId)?.querySelector('.camera-video')?.srcObject;
        if (!stream?.getVideoTracks().some(track => track.readyState === 'live')) {
            showError('Camera phụ chưa có hình. Đợi camera kết nối rồi kéo lại.');
            return false;
        }
        try { clone = stream.clone(); }
        catch { showError('Chưa ghép được camera phụ. Thử lại sau.'); return false; }
    }
    stopScanning(main);
    releaseCameraPip(main);
    if (previousOwner && previousOwner !== main) releaseCameraPip(previousOwner);
    if (auxiliary?.isPipMode) releaseCameraPip(auxiliary);
    if (auxiliary) {
        stopScanning(auxiliary);
        main.isPipMode = true;
        main.pipDeviceId = auxiliaryId;
        main.pipState = auxiliary;
        auxiliary.masterDeviceId = mainId;
        auxiliary.isAssignedAsPiP = true;
        const container = cameraContainer(mainId);
        const pipVideo = container.querySelector('.pip-video');
        const overlay = container.querySelector('.pip-overlay');
        container.querySelector('.pip-select').value = auxiliaryId;
        container.querySelector('.pip-label').textContent = `Camera ${auxiliary.cameraIndex + 1}`;
        const scale = Math.max(10, Math.min(100, parseInt(localStorage.getItem('pipScale')) || 35));
        overlay.style.width = `${scale * 0.3164}%`;
        overlay.style.aspectRatio = '9/16';
        const ready = () => {
            if (main.pipState !== auxiliary || pipVideo.srcObject !== clone || cameraStates.get(mainId) !== main) return;
            overlay.classList.add('active');
            startPipScanning(main, container.querySelector('.camera-video'), pipVideo);
        };
        pipVideo.onloadeddata = ready;
        pipVideo.srcObject = clone;
        if (pipVideo.readyState >= 2) ready();
        saveCameraSetting(mainId, 'pipDeviceId', auxiliaryId);
    }
    statusMessage.style.display = 'none';
    updateCameraVisibility();
    return true;
}

function resetCameraLayout() {
    if (!cameraStates.size) { showError('Chưa có camera để Reset.'); return false; }
    if (cameraInitPromise) { showError('Đang nhận camera, đợi có hình rồi Reset.'); return false; }
    if (cameraLayoutBusy([...cameraStates.values()])) {
        showError('Dừng quay trước khi Reset bố cục camera. Video đang quay được giữ nguyên.');
        return false;
    }
    cancelCameraDrag();
    cameraStates.forEach(state => { clearTimeout(state.pipRestoreTimeout); releaseCameraPip(state); });
    // Also forget pairs belonging to unplugged devices so they do not return later.
    try {
        const settings = JSON.parse(localStorage.getItem('cameraSettings') || '{}');
        Object.values(settings).forEach(value => { if (value && typeof value === 'object') value.pipDeviceId = null; });
        localStorage.setItem('cameraSettings', JSON.stringify(settings));
    } catch (error) { console.warn('Could not reset saved camera pairs:', error); }
    statusMessage.style.display = 'none';
    updateCameraVisibility();
    return true;
}

function cancelCameraDrag() {
    const drag = cameraDrag;
    cameraDrag = null;
    if (drag?.wrapper.hasPointerCapture?.(drag.pointerId)) {
        drag.wrapper.releasePointerCapture(drag.pointerId);
    }
    document.body.classList.remove('camera-dragging');
    document.querySelector('.camera-drag-hint')?.remove();
    cameraGrid.querySelectorAll('.camera-drag-source, .camera-drop-target').forEach(node => {
        node.classList.remove('camera-drag-source', 'camera-drop-target');
        delete node.dataset.dropHint;
    });
}

function cameraDropTarget(x, y, sourceId) {
    const target = document.elementFromPoint(x, y)?.closest('.camera-container');
    const state = target && cameraStates.get(target.dataset.deviceId);
    return state && state.deviceId !== sourceId && !state.masterDeviceId ? target : null;
}

function enableCameraDragging(wrapper, deviceId) {
    wrapper.addEventListener('dragstart', event => event.preventDefault());
    wrapper.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.isPrimary === false || event.target.closest('button, input, select, a, textarea')) return;
        const state = cameraStates.get(deviceId);
        const sourceId = event.target.closest('.pip-overlay') ? state?.pipDeviceId : deviceId;
        if (!sourceId) return;
        cancelCameraDrag();
        cameraDrag = { wrapper, sourceId, pointerId: event.pointerId, x: event.clientX, y: event.clientY, active: false };
        wrapper.setPointerCapture(event.pointerId);
    });
    wrapper.addEventListener('pointermove', event => {
        const drag = cameraDrag;
        if (!drag || drag.wrapper !== wrapper || drag.pointerId !== event.pointerId) return;
        if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8) return;
        if (!drag.active) {
            drag.active = true;
            document.body.classList.add('camera-dragging');
            cameraContainer(drag.sourceId)?.classList.add('camera-drag-source');
            const hint = document.createElement('div');
            hint.className = 'camera-drag-hint';
            hint.textContent = `Kéo Camera ${cameraStates.get(drag.sourceId).cameraIndex + 1} vào cam chính · Esc để hủy`;
            document.body.appendChild(hint);
        }
        cameraGrid.querySelectorAll('.camera-drop-target').forEach(node => node.classList.remove('camera-drop-target'));
        const target = cameraDropTarget(event.clientX, event.clientY, drag.sourceId);
        if (target) {
            target.dataset.dropHint = `Thả để ghép Camera ${cameraStates.get(drag.sourceId).cameraIndex + 1} làm cam phụ`;
            target.classList.add('camera-drop-target');
        }
        event.preventDefault();
    });
    wrapper.addEventListener('pointerup', event => {
        const drag = cameraDrag;
        if (!drag || drag.wrapper !== wrapper || drag.pointerId !== event.pointerId) return;
        const target = drag.active && cameraDropTarget(event.clientX, event.clientY, drag.sourceId);
        const sourceId = drag.sourceId;
        cancelCameraDrag();
        if (target) setCameraPip(target.dataset.deviceId, sourceId);
    });
    wrapper.addEventListener('pointercancel', cancelCameraDrag);
    wrapper.addEventListener('lostpointercapture', () => { if (cameraDrag?.wrapper === wrapper) cancelCameraDrag(); });
}

window.addEventListener('keydown', event => { if (event.key === 'Escape') cancelCameraDrag(); });
window.addEventListener('blur', cancelCameraDrag);

function updateCameraVisibility() {
    document.querySelectorAll('.camera-container').forEach(container => {
        const deviceId = container.dataset.deviceId;
        const state = cameraStates.get(deviceId);

        // [FIX FINAL] Kiểm tra thẻ chủ quyền (masterDeviceId) thay vì isAssignedAsPiP
        // Nếu camera này có Master, nghĩa là nó là nô lệ -> ẨN ĐI
        if (state && state.masterDeviceId) {
            container.style.display = 'none';
            // Không gọi startScanning ở đây, vì nô lệ không được tự quét
        } else {
            container.style.display = 'flex';

            if (state) {
                const video = container.querySelector('.camera-video');
                // Nếu là camera tự do (không có Master) và chưa chạy scanner thì start lại
                if (video && !state.scanInterval && !state.masterDeviceId) {
                    startScanning(state, video);
                }
            }
        }
    });

    updateCameraGridLayout();
}

function updateCameraGridLayout() {
    // Đếm số camera đang hiển thị (không bị ẩn)
    const visibleCameras = document.querySelectorAll('.camera-container[style*="display: flex"], .camera-container:not([style*="display: none"])').length;

    // Cập nhật attribute data-visible-count cho camera-grid
    const cameraGrid = document.getElementById('camera-grid');
    if (cameraGrid) {
        cameraGrid.setAttribute('data-visible-count', visibleCameras);
        console.log(`[Layout] Visible cameras: ${visibleCameras}`);
    }
}

function init() {
    // Refresh clicks and devicechange events must not initialize overlapping streams.
    if (!cameraInitPromise) {
        cameraInitPromise = initCameras().finally(() => { cameraInitPromise = null; });
    }
    return cameraInitPromise;
}

async function initCameras() {
    cancelCameraDrag();
    cameraStates.forEach(state => {
        stopScanning(state);
        clearInterval(state.uiInterval);
        clearTimeout(state.pipRestoreTimeout);
        clearTimeout(state.stopSoundTimeout);
        clearTimeout(state.stopRecordingTimeout);
        stopRecording(state);
    });
    cameraGrid.querySelectorAll('video').forEach(video => {
        if (video.srcObject) video.srcObject.getTracks().forEach(track => track.stop());
    });
    statusMessage.style.display = 'block';
    cameraGrid.innerHTML = '';
    cameraStates.clear();

    const cameras = await getCameras();
    statusMessage.style.display = 'none';

    if (cameras.length === 0) {
        showError("No cameras found.");
        return;
    }

    const streamStarts = [];
    const savedPairs = [];
    cameras.forEach((camera, index) => {
        const state = new CameraState(camera.deviceId, index);
        cameraStates.set(camera.deviceId, state);

        const container = document.createElement('div');
        container.className = 'camera-container';
        container.dataset.deviceId = camera.deviceId;

        const videoWrapper = document.createElement('div');
        videoWrapper.className = 'video-wrapper';
        enableCameraDragging(videoWrapper, camera.deviceId);

        const label = document.createElement('div');
        label.className = 'camera-label';
        label.textContent = `Camera ${index + 1}`;
        label.title = 'Giữ chuột và kéo hình camera này vào camera khác để làm cam phụ';

        const video = document.createElement('video');
        video.className = 'camera-video';
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;

        const recordingIndicator = document.createElement('div');
        recordingIndicator.className = 'recording-indicator';
        recordingIndicator.innerHTML = '● REC';
        recordingIndicator.style.display = 'none';

        // --- [THÊM MỚI] TẠO NÚT DỪNG ---
        const stopBtn = document.createElement('button');
        stopBtn.className = 'stop-recording-btn';
        stopBtn.innerHTML = '⏹ Dừng'; // Biểu tượng vuông và chữ Dừng

        // Sự kiện khi bấm nút Dừng
        stopBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Ngăn sự kiện nổi bọt

            if (state.isRecording) {
                console.log(`[Manual Stop] User clicked Stop on Camera ${index + 1}`);

                // 1. Phát âm thanh dừng (dựa vào nhân viên hoặc camera)
                const soundFile = state.employeeCode
                    ? `${state.employeeCode}_stop.wav`
                    : `${state.cameraIndex + 1}stop.wav`;
                playSound(soundFile);

                // 2. Gọi hàm dừng ghi hình ngay lập tức (0 giây delay)
                stopRecording(state, 0);

                // 3. Ẩn nút ngay lập tức cho phản hồi giao diện nhanh
                stopBtn.style.display = 'none';
            }
        });

        // --- [MỚI] NÚT BẮT ĐẦU ---
        const startBtn = document.createElement('button');
        startBtn.className = 'start-recording-btn';
        startBtn.innerHTML = '▶ Bắt đầu'; // Icon Play

        // --- [MỚI] INPUT NHẬP MÃ ---
        const manualInput = document.createElement('input');
        manualInput.className = 'manual-code-input';
        manualInput.type = 'text';
        manualInput.placeholder = 'Nhập mã & Enter...';

        // 1. Sự kiện khi bấm nút Bắt đầu
        startBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Ẩn nút bắt đầu, hiện ô input
            startBtn.style.display = 'none';
            manualInput.style.display = 'block';
            manualInput.value = ''; // Reset giá trị cũ
            manualInput.focus(); // Tự động focus để nhập luôn
        });

        // 2. Sự kiện xử lý Input
        manualInput.addEventListener('keydown', async (e) => {
            e.stopPropagation(); // Ngăn phím tắt chặn sự kiện

            if (e.key === 'Enter') {
                const code = manualInput.value.trim();
                if (code) {
                    console.log(`[Manual Input] Code entered: ${code}`);
                    // Gọi hàm xử lý như khi quét mã thật
                    // Hàm này sẽ tự lo việc: check trùng, phát âm thanh, start record
                    await handleCodeDetection(state, code, video);

                    // Ẩn input sau khi nhập xong
                    manualInput.style.display = 'none';
                    manualInput.blur();
                }
            } else if (e.key === 'Escape') {
                // Hủy nhập liệu khi bấm ESC
                manualInput.style.display = 'none';
                startBtn.style.display = 'block';
                manualInput.blur();
            }
        });

        // Xử lý khi click ra ngoài input -> Hủy nhập
        manualInput.addEventListener('blur', () => {
            // Delay nhỏ để tránh conflict nếu user bấm Enter
            setTimeout(() => {
                if (!state.isRecording && manualInput.style.display === 'block') {
                    // Nếu chưa bắt đầu quay mà bị blur thì hiện lại nút Start
                    // Trừ khi vừa bấm Enter xong và đang chuyển sang quay
                    if (document.activeElement !== manualInput) {
                        manualInput.style.display = 'none';
                        // Logic hiển thị lại startBtn sẽ do setInterval lo
                    }
                }
            }, 200);
        });

        // [THÊM MỚI] Tạo thẻ hiển thị Tracking Code
        const trackingDisplay = document.createElement('div');
        trackingDisplay.className = 'tracking-display';
        trackingDisplay.innerHTML = 'Tracking: ...';
        trackingDisplay.style.display = 'none';

        // Thêm duplicate warning indicator
        const duplicateWarning = document.createElement('div');
        duplicateWarning.className = 'duplicate-warning';
        duplicateWarning.innerHTML = '⚠️ TRÙNG ĐƠN';
        duplicateWarning.style.display = 'none';

        const resolutionSelect = document.createElement('select');
        resolutionSelect.className = 'resolution-selector';

        const resolutions = [
            { label: 'HD (720p)', width: 1280, height: 720 },
            { label: 'Full HD (1080p)', width: 1920, height: 1080 },
            { label: '2K (1440p)', width: 2560, height: 1440 },
            { label: '4K (2160p)', width: 3840, height: 2160 }
        ];

        const savedRes = getCameraSetting(camera.deviceId, 'resolution');

        resolutions.forEach(res => {
            const option = document.createElement('option');
            option.value = JSON.stringify({ width: res.width, height: res.height });
            option.textContent = res.label;

            // [SỬA] Logic chọn mặc định: Ưu tiên cái đã lưu, nếu không thì lấy 1080p
            if (savedRes) {
                if (res.width === savedRes.width && res.height === savedRes.height) {
                    option.selected = true;
                }
            } else {
                if (res.width === 1920) option.selected = true;
            }

            resolutionSelect.appendChild(option);
        });

        resolutionSelect.addEventListener('change', async (e) => {
            const resolution = JSON.parse(e.target.value);

            // [THÊM] Lưu lại lựa chọn khi người dùng thay đổi
            saveCameraSetting(camera.deviceId, 'resolution', resolution);

            if (video.srcObject) {
                video.srcObject.getTracks().forEach(track => track.stop());
            }
            await startStream(camera.deviceId, video, resolution);
        });

        const employeeSelect = document.createElement('select');
        employeeSelect.className = 'employee-selector';

        const defaultEmployeeOption = document.createElement('option');
        defaultEmployeeOption.value = "";
        defaultEmployeeOption.text = "Chọn nhân viên";
        employeeSelect.appendChild(defaultEmployeeOption);

        const employeeList = getEmployees();
        employeeList.forEach(emp => {
            const option = document.createElement('option');
            option.value = emp;
            option.text = emp;
            employeeSelect.appendChild(option);
        });

        employeeSelect.addEventListener('change', (e) => {
            const selectedEmp = e.target.value;
            if (selectedEmp) {
                state.selectedEmployee = selectedEmp;
                const empIndex = employeeList.indexOf(selectedEmp);
                if (empIndex >= 0) {
                    state.employeeCode = `SNV-${String(empIndex + 1).padStart(3, '0')}`;
                }
            } else {
                state.selectedEmployee = null;
                state.employeeCode = null;
            }
        });

        // [NEW] Order Type Selector
        const orderTypeSelect = document.createElement('select');
        orderTypeSelect.className = 'order-type-selector';

        const optNormal = document.createElement('option');
        optNormal.value = 'normal';
        optNormal.text = 'Hàng gửi';
        orderTypeSelect.appendChild(optNormal);

        const optReturn = document.createElement('option');
        optReturn.value = 'return';
        optReturn.text = 'Hàng hoàn';
        orderTypeSelect.appendChild(optReturn);

        // Sự kiện thay đổi loại đơn
        orderTypeSelect.addEventListener('change', (e) => {
            state.orderType = e.target.value;

            // Đổi màu border để cảnh báo nếu là hàng hoàn
            if (state.orderType === 'return') {
                orderTypeSelect.classList.add('is-return');
            } else {
                orderTypeSelect.classList.remove('is-return');
            }
            console.log(`[Camera ${index + 1}] Changed order type to: ${state.orderType}`);
        });

        const pipSelect = document.createElement('select');
        pipSelect.className = 'pip-select';

        const defaultOption = document.createElement('option');
        defaultOption.value = "";
        defaultOption.text = "Chọn cam phụ";
        pipSelect.appendChild(defaultOption);

        cameras.forEach((otherCam, otherIndex) => {
            if (otherCam.deviceId !== camera.deviceId) {
                const option = document.createElement('option');
                option.value = otherCam.deviceId;
                option.text = `Camera ${otherIndex + 1}`;
                pipSelect.appendChild(option);
            }
        });

        const pipOverlay = document.createElement('div');
        pipOverlay.className = 'pip-overlay';

        const pipVideo = document.createElement('video');
        pipVideo.className = 'pip-video';
        pipVideo.autoplay = true;
        pipVideo.playsInline = true;
        pipVideo.muted = true;

        const pipLabel = document.createElement('div');
        pipLabel.className = 'pip-label';
        pipLabel.textContent = 'Camera ?';

        pipOverlay.appendChild(pipVideo);
        pipOverlay.appendChild(pipLabel);

        pipSelect.setAttribute('aria-label', `Cam phụ cho Camera ${index + 1}`);
        pipSelect.addEventListener('change', event => {
            if (!setCameraPip(camera.deviceId, event.target.value)) {
                pipSelect.value = state.pipDeviceId || '';
            }
        });

        videoWrapper.appendChild(video);
        videoWrapper.appendChild(recordingIndicator);
        videoWrapper.appendChild(stopBtn);
        videoWrapper.appendChild(startBtn);
        videoWrapper.appendChild(manualInput);
        videoWrapper.appendChild(duplicateWarning);
        videoWrapper.appendChild(trackingDisplay);
        videoWrapper.appendChild(label);
        videoWrapper.appendChild(resolutionSelect);
        videoWrapper.appendChild(employeeSelect);
        videoWrapper.appendChild(orderTypeSelect);
        videoWrapper.appendChild(pipSelect);
        videoWrapper.appendChild(pipOverlay);
        container.appendChild(videoWrapper);
        cameraGrid.appendChild(container);

        const savedPipId = getCameraSetting(camera.deviceId, 'pipDeviceId');
        if (savedPipId) savedPairs.push([camera.deviceId, savedPipId]);

        // [SỬA] Lấy resolution hiện tại của dropdown (đã bao gồm logic load setting)
        const initialResolution = JSON.parse(resolutionSelect.value);

        streamStarts.push(startStream(camera.deviceId, video, initialResolution).then(stream => {
            if (!stream) return;
            const onReady = () => {
                const currentState = cameraStates.get(camera.deviceId);
                if (currentState === state && !state.isAssignedAsPiP) startScanning(state, video);
            };
            if (video.readyState >= 2) onReady();
            else video.addEventListener('loadeddata', onReady, { once: true });
        }));

        state.uiInterval = setInterval(() => {
            const perf = state.recordingPerformance;
            const cameraLabel = `Camera ${index + 1}` + (state.isRecording && perf ? ` · Vẽ ${perf.renderFps} FPS` : '');
            if (label.textContent !== cameraLabel) label.textContent = cameraLabel;
            label.title = perf ? `Camera báo: ${perf.sourceFps.toFixed(1)} FPS · ${perf.width}×${perf.height}. FPS vẽ canvas, chưa đo FPS file.` : 'Giữ chuột và kéo camera này vào camera khác để làm cam phụ';
            resolutionSelect.disabled = cameraLayoutBusy([state, cameraStates.get(state.masterDeviceId)]);
            pipSelect.disabled = cameraLayoutBusy([state, state.pipState]);
            // Kiểm tra xem camera này có đang bật chế độ PiP không
            const isPipActive = state.isPipMode;

            if (state.isRecording) {
                recordingIndicator.style.display = 'block';

                // Hiển thị nút Dừng khi đang quay
                stopBtn.style.display = 'block';

                // Dòng này đảm bảo dù quét mã thì nút cũng tự ẩn
                startBtn.style.display = 'none';
                manualInput.style.display = 'none';

                // [THÊM MỚI] Logic hiển thị Tracking Code
                if (state.currentCode) {
                    const trackingLabel = `Tracking: ${state.currentCode}`;
                    if (trackingDisplay.textContent !== trackingLabel) trackingDisplay.textContent = trackingLabel;
                    trackingDisplay.style.display = 'block';
                } else {
                    trackingDisplay.style.display = 'none';
                }

                // Hiển thị cảnh báo duplicate nếu đang ghi hình trùng
                if (state.isDuplicateRecording) {
                    duplicateWarning.style.display = 'block';
                } else {
                    duplicateWarning.style.display = 'none';
                }
            } else {
                recordingIndicator.style.display = 'none';
                duplicateWarning.style.display = 'none';
                // Ẩn nút Dừng khi không quay
                stopBtn.style.display = 'none';
                // [THÊM MỚI] Ẩn khi không quay
                trackingDisplay.style.display = 'none';
                // [LOGIC MỚI] Xử lý hiển thị nút Bắt đầu
                if (isPipActive) {
                    // Nếu đang ở chế độ PiP -> ẨN LUÔN nút bắt đầu và input
                    // (Để tránh bị video phụ che khuất)
                    startBtn.style.display = 'none';
                    manualInput.style.display = 'none';
                }
                else if (manualInput.style.display === 'block') {
                    // Nếu đang nhập liệu -> Ẩn nút bắt đầu
                    startBtn.style.display = 'none';
                }
                else {
                    // Chỉ hiện nút Bắt đầu khi: Không quay, Không PiP, Không đang nhập liệu
                    startBtn.style.display = 'block';
                }
            }
        }, 500);
    });
    await Promise.all(streamStarts);
    // Restore only after every original stream exists, without a delayed Reset race.
    for (const [mainId, auxiliaryId] of savedPairs) setCameraPip(mainId, auxiliaryId);
    cameraStates.forEach(state => saveCameraSetting(state.deviceId, 'pipDeviceId', state.pipDeviceId));
    // ===== THÊM MỚI: Cập nhật layout ngay sau khi khởi tạo =====
    // Đợi một chút để đảm bảo DOM đã render xong
    setTimeout(() => {
        updateCameraGridLayout();
    }, 100);
}

function showError(msg) {
    statusMessage.textContent = msg;
    statusMessage.style.display = 'block';
    statusMessage.style.color = '#ff6b6b';
}

function scheduleCameraDeviceRefresh(delay = 500) {
    clearTimeout(deviceChangeTimer);
    deviceChangeTimer = setTimeout(async () => {
        try {
            if (cameraInitPromise) await cameraInitPromise;
            const connected = filterCameraDevices(await navigator.mediaDevices.enumerateDevices());
            const unchanged = connected.length === cameraStates.size &&
                connected.every(device => cameraStates.has(device.deviceId));
            if (unchanged) return; // Ignore microphone/speaker changes.
            if ([...cameraStates.values()].some(state => state.isRecording)) {
                // Preserve ongoing recordings; apply the new camera list once all are stopped.
                statusMessage.textContent = 'Danh sách camera đã thay đổi. Sẽ tự cập nhật khi dừng quay.';
                statusMessage.style.display = 'block';
                statusMessage.style.color = '';
                scheduleCameraDeviceRefresh(1000);
                return;
            }
            await init();
        } catch (error) {
            console.warn('[Camera] Could not refresh changed devices:', error);
        }
    }, delay);
}

refreshBtn.addEventListener('click', () => {
    if (cameraLayoutBusy([...cameraStates.values()])) {
        showError('Dừng quay trước khi làm mới danh sách camera.');
        return;
    }
    init();
});
document.getElementById('reset-layout-btn')?.addEventListener('click', resetCameraLayout);
if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => scheduleCameraDeviceRefresh());
}

init();

// Settings management
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettingsBtn = document.getElementById('close-settings');
const addEmployeeBtn = document.getElementById('add-employee-btn');
const employeeNameInput = document.getElementById('employee-name-input');
const employeeList = document.getElementById('employee-list');
const employeeStatus = document.querySelector('.employee-status');

let employees = [];

function loadSettings() {
    // Load từ backend config trước (persistent), rồi fallback về localStorage
    fetch('/api/settings').then(r => r.json()).then(data => {
        const s = (data && data.settings) || {};
        if (Object.keys(s).length > 0) {
            // Có settings từ server -> ghi vào localStorage và UI
            if (s.autoSwitch !== undefined) localStorage.setItem('autoSwitch', s.autoSwitch);
            if (s.extraRecording !== undefined) localStorage.setItem('extraRecording', s.extraRecording);
            if (s.scanFrequency !== undefined) localStorage.setItem('scanFrequency', s.scanFrequency);
            if (s.timeOffset !== undefined) {
                if (s.timeOffset) localStorage.setItem('timeOffset', s.timeOffset);
                else localStorage.removeItem('timeOffset');
            }
            if (s.pipScale !== undefined) localStorage.setItem('pipScale', s.pipScale);
            if (s.recordAudio !== undefined) localStorage.setItem('recordAudio', s.recordAudio);
            if (s.employees) localStorage.setItem('employees', JSON.stringify(s.employees));
        }
        // Giờ apply từ localStorage vào UI
        _applySettingsFromLocalStorage();
    }).catch(() => {
        _applySettingsFromLocalStorage();
    });
}

function _applySettingsFromLocalStorage() {
    const savedEmployees = localStorage.getItem('employees');
    if (savedEmployees) {
        employees = JSON.parse(savedEmployees);
        renderEmployeeList();
    }

    const autoSwitch = localStorage.getItem('autoSwitch');
    if (autoSwitch !== null) {
        document.getElementById('auto-switch').checked = autoSwitch === 'true';
    }

    const extraRecording = localStorage.getItem('extraRecording');
    if (extraRecording) {
        document.getElementById('extra-recording').value = extraRecording;
    }

    const scanFrequency = localStorage.getItem('scanFrequency');
    if (scanFrequency) {
        document.getElementById('scan-frequency').value = scanFrequency;
    }

    const timeOffset = localStorage.getItem('timeOffset');
    if (timeOffset) {
        document.getElementById('time-offset').value = timeOffset;
    }

    // [THÊM MỚI] Load Pip Scale
    const savedPipScale = localStorage.getItem('pipScale');
    if (savedPipScale) {
        document.getElementById('pip-scale').value = savedPipScale;
    } else {
        document.getElementById('pip-scale').value = "35"; // Mặc định 35%
    }

    // --- Ghi âm thanh ---
    const recordAudio = localStorage.getItem('recordAudio');
    if (recordAudio !== null) {
        document.getElementById('record-audio').checked = recordAudio === 'true';
    } else {
        // Mặc định là tắt để tránh ồn/tốn dung lượng nếu không cần
        document.getElementById('record-audio').checked = false;
    }

    updateExtraRecordingState();
}

function updateExtraRecordingState() {
    const autoSwitch = document.getElementById('auto-switch').checked;
    const extraRecordingInput = document.getElementById('extra-recording');
    const extraRecordingDesc = extraRecordingInput.parentElement.previousElementSibling.querySelector('.setting-description');

    if (autoSwitch) {
        const currentValue = extraRecordingInput.value;
        if (currentValue && currentValue !== '0') {
            localStorage.setItem('extraRecordingOriginal', currentValue);
        }

        extraRecordingInput.disabled = true;
        extraRecordingInput.value = 0;
        extraRecordingInput.style.opacity = '0.5';
        extraRecordingInput.style.cursor = 'not-allowed';
        extraRecordingDesc.textContent = 'Tự động kết thúc khi quét vận đơn mới';
    } else {
        extraRecordingInput.disabled = false;
        extraRecordingInput.style.opacity = '1';
        extraRecordingInput.style.cursor = '';
        extraRecordingDesc.textContent = 'Thời gian ghi hình thêm trước khi lưu video';

        const originalValue = localStorage.getItem('extraRecordingOriginal');
        if (originalValue && originalValue !== '0') {
            extraRecordingInput.value = originalValue;
        } else {
            const savedValue = localStorage.getItem('extraRecording');
            if (savedValue && savedValue !== '0') {
                extraRecordingInput.value = savedValue;
            } else {
                extraRecordingInput.value = 4;
            }
        }
    }
}

function saveSettings() {
    // 1. Lưu cài đặt
    localStorage.setItem('employees', JSON.stringify(employees));

    // [FIX QUAN TRỌNG] Xử lý logic lưu thời gian
    const isAutoSwitch = document.getElementById('auto-switch').checked;
    localStorage.setItem('autoSwitch', isAutoSwitch);

    // Nếu TẮT chế độ đóng gói nhanh -> XÓA biến nhớ đệm cũ đi
    // Điều này ép hệ thống phải dùng giá trị mới bạn vừa nhập (8s)
    if (!isAutoSwitch) {
        localStorage.removeItem('extraRecordingOriginal');
    }

    localStorage.setItem('extraRecording', document.getElementById('extra-recording').value);
    localStorage.setItem('scanFrequency', document.getElementById('scan-frequency').value);

    const timeOffsetValue = document.getElementById('time-offset').value;
    if (timeOffsetValue) {
        localStorage.setItem('timeOffset', timeOffsetValue);
    } else {
        localStorage.removeItem('timeOffset');
    }

    // [THÊM MỚI] Lưu Pip Scale
    const pipScaleVal = document.getElementById('pip-scale').value;
    localStorage.setItem('pipScale', pipScaleVal);

    // Cập nhật CSS cho các PiP đang hiển thị (Live Preview)
    const scalePercent = parseInt(pipScaleVal) || 35;

    // [SỬA LẠI CÔNG THỨC TẠI ĐÂY]
    // 0.3164 là hệ số vàng để: Chiều cao PiP (tỷ lệ 9:16) = Scale% của Chiều cao Main (tỷ lệ 16:9)
    const cssWidth = scalePercent * 0.3164;

    document.querySelectorAll('.pip-overlay').forEach(overlay => {
        overlay.style.width = `${cssWidth}%`;
        // Thêm dòng này để đảm bảo khung hình luôn giữ tỷ lệ dọc 9:16
        overlay.style.aspectRatio = "9/16";
    });

    // --- Ghi âm thanh ---
    const isRecordAudio = document.getElementById('record-audio').checked;
    localStorage.setItem('recordAudio', isRecordAudio);

    // 2. Khởi động lại scanner (CHỈ ÁP DỤNG VỚI CAMERA ĐANG RẢNH)
    cameraStates.forEach((state, deviceId) => {
        // [QUAN TRỌNG] Nếu đang quay video -> BỎ QUA để không làm đứt video
        if (state.isRecording) {
            console.log(`[Settings] Cam ${state.cameraIndex + 1} đang ghi hình -> Bỏ qua restart scanner.`);
            return;
        }

        // Dừng scanner hiện tại
        if (state.scanInterval) {
            stopScanning(state);
        }

        const container = document.querySelector(`.camera-container[data-device-id="${deviceId}"]`);

        // Chỉ khởi động lại nếu camera đang hiển thị (không bị ẩn)
        if (container && container.style.display !== 'none') {
            const video = container.querySelector('.camera-video');

            // A. Khởi động lại quét cho Camera CHÍNH
            if (video) {
                startScanning(state, video);
            }

            // B. Khởi động lại quét cho Camera PHỤ (PiP) nếu đang bật
            if (state.isPipMode && state.pipState && state.pipDeviceId) {
                const pipVideo = container.querySelector('.pip-video');
                if (pipVideo) {
                    startPipScanning(state, video, pipVideo);
                }
            }
        }
    });

    console.log('[Settings] Saved. Scanners restarted (only idle ones).');

    // ---- Lưu vào backend (persistent qua restart app) ----
    const settingsPayload = {
        autoSwitch: String(document.getElementById('auto-switch').checked),
        extraRecording: document.getElementById('extra-recording').value,
        scanFrequency: document.getElementById('scan-frequency').value,
        timeOffset: document.getElementById('time-offset').value || '',
        pipScale: document.getElementById('pip-scale').value,
        recordAudio: String(document.getElementById('record-audio').checked),
        employees: employees
    };
    fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: settingsPayload })
    }).catch(e => console.error('[Settings] Backend save error:', e));
}

settingsBtn.addEventListener('click', () => {
    settingsModal.classList.add('active');
});

closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.remove('active');
    saveSettings();
    updateEmployeeSelectors();
});

settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
        settingsModal.classList.remove('active');
        saveSettings();
        updateEmployeeSelectors();
    }
});

document.getElementById('auto-switch').addEventListener('change', (e) => {
    updateExtraRecordingState();
    console.log('[Settings] Auto-switch mode:', e.target.checked ? 'ENABLED' : 'DISABLED');
});

addEmployeeBtn.addEventListener('click', () => {
    const employeeName = employeeNameInput.value.trim();
    if (employeeName) {
        employees.push(employeeName);
        employeeNameInput.value = '';
        renderEmployeeList();
        saveSettings();
        updateEmployeeSelectors();
    }
});

employeeNameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        addEmployeeBtn.click();
    }
});

function removeEmployee(index) {
    employees.splice(index, 1);
    renderEmployeeList();
    saveSettings();
    updateEmployeeSelectors();
}

function renderEmployeeList() {
    if (employees.length === 0) {
        employeeStatus.style.display = 'block';
        employeeList.innerHTML = '';
    } else {
        employeeStatus.style.display = 'none';
        employeeList.innerHTML = employees.map((emp, index) => {
            const empCode = `SNV-${String(index + 1).padStart(3, '0')}`;
            return `
            <div class="employee-item">
                <span class="employee-name">${emp} (${empCode})</span>
                <button class="remove-employee-btn" onclick="removeEmployee(${index})">Remove</button>
            </div>
        `}).join('');
    }
}

function updateEmployeeSelectors() {
    const employeeSelects = document.querySelectorAll('.employee-selector');
    employeeSelects.forEach(select => {
        const currentValue = select.value;
        select.innerHTML = '<option value="">Chọn Nhân Viên</option>';

        employees.forEach(emp => {
            const option = document.createElement('option');
            option.value = emp;
            option.text = emp;
            select.appendChild(option);
        });

        if (currentValue && employees.includes(currentValue)) {
            select.value = currentValue;
        }
    });
}

loadSettings();

window.removeEmployee = removeEmployee;

// ========== STATISTICS MODAL ==========

const statisticsBtn = document.getElementById('statistics-btn');
const statisticsModal = document.getElementById('statistics-modal');
const closeStatisticsBtn = document.getElementById('close-statistics');
// Cập nhật selector mới
const statsStartDate = document.getElementById('stats-start-date');
const statsEndDate = document.getElementById('stats-end-date');
const statsEmployeeFilter = document.getElementById('stats-employee-filter');

const refreshStatsBtn = document.getElementById('refresh-stats-btn');
const exportExcelBtn = document.getElementById('export-excel-btn');
const searchTrackingInput = document.getElementById('search-tracking-code');
const searchBtn = document.getElementById('search-btn');
const searchResults = document.getElementById('search-results');
const searchResultsList = document.getElementById('search-results-list');

// Statistics data
let statisticsData = {
    videos: [],
    totalVideos: 0,
    uniqueCodes: 0,
    activeCameras: 0,
    avgDuration: 0,
    cameraStats: {}
};

// Open statistics modal
statisticsBtn.addEventListener('click', () => {
    statisticsModal.classList.add('active');

    // [THAY ĐỔI] Luôn set mặc định ngày hôm nay vào input (để nếu user muốn lọc thì có sẵn)
    // NHƯNG gọi hàm loadStatistics(true) để lấy TẤT CẢ dữ liệu trước.
    const today = new Date();
    if (!statsStartDate.value) statsStartDate.valueAsDate = today;
    if (!statsEndDate.value) statsEndDate.valueAsDate = today;

    // Load ALL data by default
    loadStatistics(true);
});

// Close statistics modal
closeStatisticsBtn.addEventListener('click', () => {
    statisticsModal.classList.remove('active');
    searchResults.style.display = 'none';
    searchTrackingInput.value = '';
});

// Close modal when clicking outside
statisticsModal.addEventListener('mousedown', (e) => {
    if (e.target === statisticsModal) {
        statisticsModal.classList.remove('active');
        searchResults.style.display = 'none';
        searchTrackingInput.value = '';
    }
});

// Refresh stats (Nút Xem)
refreshStatsBtn.addEventListener('click', () => {
    // Gọi hàm không có tham số -> Mặc định isFetchAll = false -> Sẽ lấy ngày từ input
    loadStatistics(false);
});

// Employee Filter Change -> Update UI only (Client-side filtering)
statsEmployeeFilter.addEventListener('change', () => {
    updateStatisticsUI();
});

// Export to Excel
exportExcelBtn.addEventListener('click', () => {
    exportToExcel();
});

// Search tracking code
searchBtn.addEventListener('click', () => {
    searchTrackingCode();
});

// Search on Enter key
searchTrackingInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        searchTrackingCode();
    }
});

// === MAIN STATISTICS LOADING FUNCTION ===
// [SỬA] Thêm tham số isFetchAll mặc định là false
async function loadStatistics(isFetchAll = false) {
    console.log(`[Statistics] Loading statistics... (FetchAll: ${isFetchAll})`);

    // Set UI to loading state
    document.getElementById('total-videos').textContent = '...';
    document.getElementById('normal-orders').textContent = '...';
    document.getElementById('return-orders').textContent = '...';
    document.getElementById('avg-duration').textContent = '...';

    // Nếu đang tìm tất cả, hiển thị trạng thái đang tải lên list kết quả tìm kiếm (nếu đang mở)
    if (isFetchAll) {
        // Có thể reset input date về rỗng để người dùng hiểu là đang xem tất cả
        // statsStartDate.value = '';
        // statsEndDate.value = '';
    }

    try {
        let payload = {};

        if (isFetchAll) {
            // Chế độ lấy tất cả
            payload = { fetchAll: true };
        } else {
            // Chế độ lọc theo ngày (Logic cũ)
            const startDate = statsStartDate.value;
            const endDate = statsEndDate.value;

            if (!startDate || !endDate) {
                alert("Vui lòng chọn ngày bắt đầu và kết thúc.");
                return;
            }
            payload = {
                startDate: startDate,
                endDate: endDate
            };
        }

        const response = await fetch('/api/statistics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error('Failed to fetch statistics');
        const data = await response.json();

        processStatistics(data);
        console.log('[Statistics] ✅ Loaded successfully');

    } catch (error) {
        console.error('[Statistics] Error:', error);
        document.getElementById('total-videos').textContent = '0';
        document.getElementById('normal-orders').textContent = '0';
        document.getElementById('return-orders').textContent = '0';
        document.getElementById('avg-duration').textContent = '--';
    }
}

// Function to parse folder name to date (DD-MM-YYYY)
function parseFolderDate(folderName) {
    const parts = folderName.split('-');
    if (parts.length !== 3) return null;

    const day = parseInt(parts[0]);
    const month = parseInt(parts[1]) - 1; // Month is 0-indexed
    const year = parseInt(parts[2]);

    if (isNaN(day) || isNaN(month) || isNaN(year)) return null;

    return new Date(year, month, day);
}

// === PROCESS DATA ===
function processStatistics(data) {
    // Lưu dữ liệu thô để dùng cho bộ lọc
    statisticsData.rawVideos = data.videos || [];

    // 1. Tạo danh sách Employee/Camera duy nhất để đổ vào Dropdown
    const uniqueEmployees = new Set();
    statisticsData.rawVideos.forEach(v => {
        // Ưu tiên tên nhân viên, nếu không có thì lấy tên Camera
        const name = v.employee || `Camera ${v.cameraId || '?'}`;
        uniqueEmployees.add(name);
    });

    // 2. Cập nhật Dropdown Filter
    const currentSelection = statsEmployeeFilter.value; // Giữ lại lựa chọn hiện tại
    statsEmployeeFilter.innerHTML = '<option value="all">Tất cả</option>';

    Array.from(uniqueEmployees).sort().forEach(empName => {
        const option = document.createElement('option');
        option.value = empName;
        option.textContent = empName;
        statsEmployeeFilter.appendChild(option);
    });

    // Khôi phục lựa chọn cũ nếu còn tồn tại
    if (currentSelection && uniqueEmployees.has(currentSelection)) {
        statsEmployeeFilter.value = currentSelection;
    } else {
        statsEmployeeFilter.value = 'all';
    }

    // 3. Tính toán và hiển thị
    updateStatisticsUI();
}

// === UPDATE UI WITH FILTER ===
function updateStatisticsUI() {
    const selectedFilter = statsEmployeeFilter.value;

    // 1. Lọc dữ liệu dựa trên dropdown
    let filteredVideos = statisticsData.rawVideos;

    // Nếu chọn cụ thể nhân viên thì lọc
    if (selectedFilter !== 'all') {
        filteredVideos = statisticsData.rawVideos.filter(v => {
            const name = v.employee || `Camera ${v.cameraId || '?'}`;
            return name === selectedFilter;
        });
    }

    // Lưu lại videos đã lọc để dùng cho hiển thị và Excel
    statisticsData.videos = filteredVideos;
    statisticsData.totalVideos = filteredVideos.length;

    // 2. Tính toán lại các chỉ số dựa trên dữ liệu đã lọc
    let uniqueSendCodes = new Set();
    let returnOrdersCount = 0;
    let totalDuration = 0;
    let cameraStats = {};
    let activeCameras = new Set();

    filteredVideos.forEach(video => {
        let isReturn = false;
        if (video.orderType) {
            isReturn = video.orderType === 'return';
        } else {
            isReturn = video.filename && video.filename.includes('_Return');
        }

        const employee = video.employee || `Camera ${video.cameraId || '?'}`;
        activeCameras.add(employee);

        if (!cameraStats[employee]) {
            cameraStats[employee] = { simple: 0, returned: 0, totalVideos: 0, totalDuration: 0 };
        }

        cameraStats[employee].totalVideos++;
        if (video.duration) {
            cameraStats[employee].totalDuration += video.duration;
            totalDuration += video.duration;
        }

        if (isReturn) {
            returnOrdersCount++;
            cameraStats[employee].returned++;
        } else {
            cameraStats[employee].simple++;
            if (video.code && video.code !== 'unknown') {
                uniqueSendCodes.add(video.code);
            }
        }
    });

    statisticsData.cameraStats = cameraStats;
    statisticsData.activeCameras = activeCameras.size;
    statisticsData.uniqueCodes = uniqueSendCodes.size;
    statisticsData.returnOrdersCount = returnOrdersCount;
    statisticsData.avgDuration = statisticsData.totalVideos > 0 ? totalDuration / statisticsData.totalVideos : 0;

    // 3. Render lên DOM
    document.getElementById('total-videos').textContent = statisticsData.totalVideos;
    document.getElementById('normal-orders').textContent = statisticsData.uniqueCodes;
    document.getElementById('return-orders').textContent = statisticsData.returnOrdersCount;
    document.getElementById('active-cameras').textContent = statisticsData.activeCameras;

    const avgDur = statisticsData.avgDuration;
    const min = Math.floor(avgDur / 60);
    const sec = Math.floor(avgDur % 60);
    document.getElementById('avg-duration').textContent = avgDur > 0 ? `${min}:${sec.toString().padStart(2, '0')}` : '--';

    updateCameraStatsTable();
}

// Function to update camera stats table
function updateCameraStatsTable() {
    const tbody = document.getElementById('camera-stats-tbody');
    tbody.innerHTML = '';

    // Sort cameras by total videos (descending)
    const sortedCameras = Object.entries(statisticsData.cameraStats)
        .sort((a, b) => b[1].totalVideos - a[1].totalVideos);

    sortedCameras.forEach(([camera, stats]) => {
        const row = document.createElement('tr');

        // Calculate average duration for this camera
        const avgDuration = stats.totalVideos > 0
            ? stats.totalDuration / stats.totalVideos
            : 0;

        const minutes = Math.floor(avgDuration / 60);
        const seconds = Math.floor(avgDuration % 60);
        const durationText = avgDuration > 0
            ? `${minutes}:${seconds.toString().padStart(2, '0')}`
            : '--';

        row.innerHTML = `
            <td>${camera}</td>
            <td>${stats.simple}</td>
            <td>${stats.returned}</td>
            <td>${stats.totalVideos}</td>
            <td>${durationText}</td>
        `;

        tbody.appendChild(row);
    });

    // If no data
    if (sortedCameras.length === 0) {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td colspan="5" style="text-align: center; color: #8b92a7;">
                Không có dữ liệu
            </td>
        `;
        tbody.appendChild(row);
    }
}

// Function to search tracking code
function searchTrackingCode() {
    const searchTerm = searchTrackingInput.value.trim();

    if (!searchTerm) {
        alert('Vui lòng nhập mã vận đơn để tìm kiếm!');
        return;
    }

    console.log('[Statistics] Searching for:', searchTerm);

    // Filter videos by tracking code
    const results = statisticsData.videos.filter(video => {
        const code = video.code || '';
        return code.toLowerCase().includes(searchTerm.toLowerCase());
    });

    console.log('[Statistics] Found', results.length, 'results');

    // Display results
    displaySearchResults(results, searchTerm);
}

// Function to display search results
function displaySearchResults(results, searchTerm) {
    searchResultsList.innerHTML = '';

    if (results.length === 0) {
        searchResults.style.display = 'block';
        searchResultsList.innerHTML = `
            <div style="text-align: center; padding: 40px; color: #8b92a7;">
                <div style="font-size: 3rem; margin-bottom: 16px;">📦</div>
                <div style="font-size: 1rem; font-weight: 600; margin-bottom: 8px;">
                    Không tìm thấy kết quả
                </div>
                <div style="font-size: 0.875rem;">
                    Không có video nào với mã vận đơn "${searchTerm}"
                </div>
            </div>
        `;
        return;
    }

    searchResults.style.display = 'block';

    // Sort results by date (newest first)
    results.sort((a, b) => {
        const dateA = new Date(a.timestamp || 0);
        const dateB = new Date(b.timestamp || 0);
        return dateB - dateA;
    });

    // Display each result
    results.forEach(video => {
        const item = createSearchResultItem(video);
        searchResultsList.appendChild(item);
    });
}

// Function to create search result item
function createSearchResultItem(video) {
    const item = document.createElement('div');
    item.className = 'search-result-item';

    // Format timestamp
    const timestamp = video.timestamp ? new Date(video.timestamp) : null;
    const dateStr = timestamp ? timestamp.toLocaleString('vi-VN') : 'Không rõ';

    // Get employee/camera name
    const employee = video.employee || `Camera ${video.cameraId || '?'}`;

    // Format file size
    const sizeInMB = video.size ? (video.size / (1024 * 1024)).toFixed(2) : '?';

    // Format duration
    let durationStr = '--';
    if (video.duration) {
        const minutes = Math.floor(video.duration / 60);
        const seconds = Math.floor(video.duration % 60);
        durationStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    // Create info section
    const info = document.createElement('div');
    info.className = 'search-result-info';
    info.innerHTML = `
        <div class="search-result-code">📦 ${video.code}</div>
        <div class="search-result-meta">
            🎥 ${employee} |
            📅 ${dateStr} |
            💾 ${sizeInMB} MB |
            ⏱️ ${durationStr}
        </div>
        <div class="search-result-meta" style="margin-top: 4px; font-size: 0.75rem;">
            📁 ${video.filename}
        </div>
    `;

    // Create actions section
    const actions = document.createElement('div');
    actions.className = 'search-result-actions';

    // Check if video is uploaded to Google Drive
    if (video.uploaded && video.googleDriveLink) {
        // Tạo nút Copy Link thay vì Mở Drive
        const driveLinkBtn = document.createElement('button');
        driveLinkBtn.className = 'drive-link-btn';
        driveLinkBtn.textContent = '📋 Copy Link'; // Đổi nhãn nút

        driveLinkBtn.onclick = async () => {
            try {
                // Lệnh copy vào clipboard
                await navigator.clipboard.writeText(video.googleDriveLink);

                // [UX] Hiệu ứng thông báo đã copy thành công
                const originalText = '📋 Copy Link';
                driveLinkBtn.textContent = '✅ Đã Copy!';
                driveLinkBtn.style.backgroundColor = '#10b981'; // Chuyển màu xanh lá tạm thời

                // Trả lại trạng thái cũ sau 1.5 giây
                setTimeout(() => {
                    driveLinkBtn.textContent = originalText;
                    driveLinkBtn.style.backgroundColor = ''; // Reset màu về CSS gốc
                }, 1500);

            } catch (err) {
                console.error('Failed to copy: ', err);
                // Fallback nếu trình duyệt không hỗ trợ hoặc lỗi
                alert('Không thể copy link. Bạn hãy thử chọn và copy thủ công.');
            }
        };
        actions.appendChild(driveLinkBtn);
    } else {
        // Show local download button
        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'download-btn';
        downloadBtn.textContent = '⬇️ Lưu video';
        downloadBtn.onclick = () => {
            downloadVideo(video);
        };
        actions.appendChild(downloadBtn);

        // Show local path info
        if (video.relativePath) {
            const pathInfo = document.createElement('div');
            pathInfo.style.fontSize = '0.75rem';
            pathInfo.style.color = '#8b92a7';
            pathInfo.style.marginTop = '4px';
            pathInfo.textContent = `📂 ${video.relativePath}`;
            info.appendChild(pathInfo);
        }
    }

    item.appendChild(info);
    item.appendChild(actions);

    return item;
}

// Function to download video
function downloadVideo(video) {
    // Get the relative path from Videos folder
    const relativePath = video.relativePath || video.filename;

    if (!relativePath) {
        alert('Không tìm thấy đường dẫn video!');
        return;
    }

    // Create download link
    const downloadUrl = `/Videos/${relativePath}`;

    console.log('[Statistics] Downloading:', downloadUrl);

    // Create temporary link and trigger download
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = video.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    console.log('[Statistics] ✅ Download started');
}

// === EXPORT TO EXCEL WITH FILTERS & LINKS ===
function exportToExcel() {
    console.log('[Statistics] Exporting to Excel...');

    if (!statisticsData.videos || statisticsData.videos.length === 0) {
        alert('Không có dữ liệu để xuất (theo bộ lọc hiện tại)!');
        return;
    }

    try {
        let csvContent = '';

        // Metadata
        const exportDate = new Date().toLocaleString('vi-VN');
        csvContent += `Báo cáo thống kê hiệu suất\n`;
        csvContent += `Từ ngày: ${statsStartDate.value} - Đến ngày: ${statsEndDate.value}\n`;
        csvContent += `Bộ lọc: ${statsEmployeeFilter.options[statsEmployeeFilter.selectedIndex].text}\n`;
        csvContent += `Ngày xuất: ${exportDate}\n\n`;

        // Summary
        csvContent += `TỔNG QUAN\n`;
        csvContent += `Tổng số video,${statisticsData.totalVideos}\n`;
        csvContent += `Mã vận đơn duy nhất,${statisticsData.uniqueCodes}\n`;
        csvContent += `Đơn hoàn,${statisticsData.returnOrdersCount}\n\n`;

        // Details
        // [QUAN TRỌNG] Thêm cột Link Google Drive
        csvContent += `STT,Mã vận đơn,Nhân viên/Camera,Ngày giờ,Kích thước (MB),Thời lượng,Tên file,Trạng thái,Link Google Drive\n`;

        const sortedVideos = [...statisticsData.videos].sort((a, b) => {
            return new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
        });

        sortedVideos.forEach((video, index) => {
            const stt = index + 1;
            // Quote để tránh lỗi CSV nếu mã chứa dấu phẩy
            const code = `"${video.code || 'N/A'}"`;
            const employee = `"${video.employee || `Camera ${video.cameraId || '?'}`}"`;
            const timestamp = video.timestamp ? new Date(video.timestamp).toLocaleString('vi-VN') : 'N/A';
            const sizeInMB = video.size ? (video.size / (1024 * 1024)).toFixed(2) : '0';

            let durationStr = '--';
            if (video.duration) {
                const m = Math.floor(video.duration / 60);
                const s = Math.floor(video.duration % 60);
                durationStr = `${m}:${s.toString().padStart(2, '0')}`;
            }

            const filename = `"${video.filename || 'N/A'}"`;
            const status = video.uploaded ? 'Đã upload' : 'Local';

            csvContent += `${stt},${code},${employee},${timestamp},${sizeInMB},${durationStr},${filename},${status}\n`;
        });

        // Download
        const BOM = '\uFEFF'; // Fix lỗi font tiếng Việt trong Excel
        const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);

        const dateStr = new Date().toISOString().slice(0, 10);
        const filename = `ThongKe_${statsStartDate.value}_${statsEndDate.value}.csv`;

        link.setAttribute('href', url);
        link.setAttribute('download', filename);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

    } catch (error) {
        console.error('Export Error:', error);
        alert('Lỗi xuất Excel: ' + error.message);
    }
}

// ========== CẢNH BÁO KHI ĐÓNG TRÌNH DUYỆT ==========

window.addEventListener('beforeunload', function (e) {
    const message = 'Bạn có chắc chắn muốn thoát?';
    e.preventDefault();
    e.returnValue = message;
    return message;
});

// ========== QUICK SEARCH HEADER LOGIC ==========

const headerQuickSearch = document.getElementById('header-quick-search');

headerQuickSearch.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
        const keyword = headerQuickSearch.value.trim();
        if (!keyword) return;

        console.log(`[Quick Search] Searching for: ${keyword}`);

        statisticsModal.classList.add('active');
        searchTrackingInput.value = keyword;
        headerQuickSearch.value = '';
        headerQuickSearch.blur();

        searchResults.style.display = 'block';
        searchResultsList.innerHTML = '<div style="padding:20px; text-align:center">⏳ Đang đồng bộ toàn bộ dữ liệu...</div>';

        try {
            await loadStatistics(true);
            searchTrackingCode();
        } catch (error) {
            console.error("[Quick Search] Error:", error);
            searchResultsList.innerHTML = '<div style="color:red; text-align:center">Lỗi khi tải dữ liệu. Vui lòng thử lại.</div>';
        }
    }
});



// ========== VIDEOS MODAL ==========

const videosBtn = document.getElementById('videos-btn');
const videosModal = document.getElementById('videos-modal');
const closeVideosBtn = document.getElementById('close-videos');
const videosList = document.getElementById('videos-list');
const videosSelectedCount = document.getElementById('videos-selected-count');
const videosSelectedSize = document.getElementById('videos-selected-size');

let videosData = [];
let selectedVideos = new Set();

videosBtn.addEventListener('click', () => {
    videosModal.classList.add('active');
    loadVideosList();
});

closeVideosBtn.addEventListener('click', () => {
    videosModal.classList.remove('active');
});

videosModal.addEventListener('mousedown', (e) => {
    if (e.target === videosModal) {
        videosModal.classList.remove('active');
    }
});

async function loadVideosList() {
    videosList.innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-secondary);">⏳ Đang tải...</div>';
    selectedVideos.clear();
    updateSelectedCount();

    try {
        const resp = await fetch('/api/videos/list', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const data = await resp.json();
        videosData = data.groups || [];

        renderVideosList();
    } catch (err) {
        videosList.innerHTML = `<div style="text-align:center; padding:40px; color:var(--accent-red);">Lỗi: ${err.message}</div>`;
    }
}

function renderVideosList() {
    if (videosData.length === 0) {
        videosList.innerHTML = `
            <div style="text-align:center; padding:40px; color:var(--text-secondary);">
                <div style="font-size:3rem; margin-bottom:12px;">📁</div>
                <div>Chưa có video nào</div>
            </div>`;
        return;
    }

    videosList.innerHTML = '';

    videosData.forEach(group => {
        const groupEl = document.createElement('div');
        groupEl.className = 'video-date-group';

        const totalSize = (group.totalSize / (1024 * 1024)).toFixed(1);

        const header = document.createElement('div');
        header.className = 'video-date-header';
        header.innerHTML = `
            <div class="video-date-title">📅 ${group.date}</div>
            <div class="video-date-stats">
                <span>${group.totalCount} video</span>
                <span>${totalSize} MB</span>
                <span>${group.uploadedCount}/${group.totalCount} uploaded</span>
            </div>
        `;

        const itemsContainer = document.createElement('div');
        itemsContainer.className = 'video-items video-grid';

        header.addEventListener('click', () => {
            itemsContainer.style.display = itemsContainer.style.display === 'none' ? 'grid' : 'none';
        });

        group.videos.forEach(video => {
            const videoKey = `${group.date}/${video.filename}`;
            const item = document.createElement('div');
            item.className = 'video-card';

            const isUploaded = video.uploaded;
            const sizeMB = video.size ? (video.size / (1024 * 1024)).toFixed(1) : '?';
            const parts = video.filename.replace(/\.(mp4|webm)$/i, '').split('_');
            const cameraLabel = parts[0] || 'Camera';
            const code = parts.slice(1).join('_') || video.code || '';

            // Video URL for thumbnail
            const videoUrl = `/Videos/${group.date}/${encodeURIComponent(video.filename)}`;

            item.innerHTML = `
                <div class="video-card-thumb" data-key="${videoKey}">
                    <div class="video-thumb-placeholder">🎬</div>
                    <div class="video-card-play">▶</div>
                    <div class="video-card-duration">${sizeMB} MB</div>
                </div>
                <div class="video-card-body">
                    <div class="video-card-checkbox">
                        <input type="checkbox" data-key="${videoKey}" ${isUploaded ? 'disabled' : ''}>
                    </div>
                    <div class="video-card-info">
                        <div class="video-card-name" title="${video.filename}">${cameraLabel}</div>
                        <div class="video-card-code" title="${code}">${code}</div>
                    </div>
                    </div>
                    <div class="video-card-actions">
                    </div>
                </div>
            `;

            // Click thumbnail to open in default player
            const thumb = item.querySelector('.video-card-thumb');
            thumb.addEventListener('click', async () => {
                thumb.querySelector('.video-card-play').textContent = '⏳';
                try {
                    await fetch('/api/open-video', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ relativePath: videoKey })
                    });
                } catch (e) {
                    console.error('Open video error:', e);
                }
                setTimeout(() => {
                    thumb.querySelector('.video-card-play').textContent = '▶';
                }, 1500);
            });

            itemsContainer.appendChild(item);
        });

        groupEl.appendChild(header);
        groupEl.appendChild(itemsContainer);
        videosList.appendChild(groupEl);
    });

    // LIGHTWEIGHT: No video preloading, just CSS placeholders
    // This prevents browser from downloading all videos simultaneously
}

function updateSelectedCount() {
    videosSelectedCount.textContent = `${selectedVideos.size} video được chọn`;
    if (selectedVideos.size > 0) {
        videosSelectedSize.textContent = '';
    } else {
        videosSelectedSize.textContent = '';
    }
}


// ============================================================
// 💬 WHATSAPP BOT CONTROLLER
// ============================================================

(function () {
    // DOM Elements
    const waStatusDot = document.getElementById('wa-status-dot');
    const waStatusText = document.getElementById('wa-status-text');
    const waNodeSetup = document.getElementById('wa-node-setup');
    const waDepsSetup = document.getElementById('wa-deps-setup');
    const waControls = document.getElementById('wa-controls');
    const waRestartBtn = document.getElementById('wa-restart-btn');
    const waDisconnectBtn = document.getElementById('wa-disconnect-btn');
    const waSwitchBtn = document.getElementById('wa-switch-btn');
    const waResetBtn = document.getElementById('wa-reset-btn');
    const waQrContainer = document.getElementById('wa-qr-container');
    const waQrCanvas = document.getElementById('wa-qr-canvas');
    const waQrFallback = document.getElementById('wa-qr-fallback');
    const waUsageGuide = document.getElementById('wa-usage-guide');
    const waLogSection = document.getElementById('wa-log-section');
    const waLogBox = document.getElementById('wa-log-box');

    let waPollingTimer = null;
    let waLastQrData = null;
    let waLastQrImage = null;
    let waAutoRestartAttempted = false;
    let waAutoRestartCount = 0;
    let waAutoRestartExhausted = false;

    // Bắt đầu polling NGAY khi trang load (bot đã auto-start từ server)
    waStartPolling();
    waRefreshStatus();

    // Polling status - tần suất thay đổi theo trạng thái
    function waStartPolling() {
        waStopPolling();
        waPollingTimer = setInterval(waRefreshStatus, 2000);
    }

    function waStopPolling() {
        if (waPollingTimer) {
            clearInterval(waPollingTimer);
            waPollingTimer = null;
        }
    }

    // Fetch trạng thái từ server
    async function waRefreshStatus() {
        try {
            const resp = await fetch('/api/whatsapp/status');
            if (!resp.ok) return;
            const data = await resp.json();
            if (data.disabled) {
                waStopPolling();
                const section = document.getElementById('whatsapp-section');
                if (section) section.style.display = 'none';
                return;
            }
            waUpdateUI(data);
        } catch (e) {
            // Ignore fetch errors silently (server might be restarting)
        }
    }

    // Cập nhật giao diện theo trạng thái
    function waUpdateUI(data) {
        const { bot_status, qr_data, qr_image, node_installed, node_version,
            packages_installed, logs, last_error } = data;

        // 1. Status bar
        const statusMap = {
            'stopped': { dot: 'wa-dot-offline', text: '🔴 Bot đang tắt' },
            'starting': { dot: 'wa-dot-starting', text: '🟡 Đang khởi động...' },
            'qr_pending': { dot: 'wa-dot-qr', text: '🟡 Chờ quét mã QR' },
            'authenticated': { dot: 'wa-dot-starting', text: '🟡 Đã xác thực, đang kết nối...' },
            'connected': { dot: 'wa-dot-connected', text: '🟢 Bot đang hoạt động' },
            'disconnected': { dot: 'wa-dot-offline', text: '🔴 Bị ngắt kết nối' },
            'error': { dot: 'wa-dot-error', text: '❌ Lỗi: ' + (last_error || 'Unknown') },
        };

        const status = statusMap[bot_status] || statusMap['stopped'];
        if (waStatusDot) {
            waStatusDot.className = 'wa-status-dot ' + status.dot;
        }
        if (waStatusText) {
            waStatusText.textContent = status.text;
        }

        // 2. Node.js setup section
        if (!node_installed) {
            if (waNodeSetup) waNodeSetup.style.display = 'block';
            if (waDepsSetup) waDepsSetup.style.display = 'none';
            if (waControls) waControls.style.display = 'none';
            if (waQrContainer) waQrContainer.style.display = 'none';
            if (waUsageGuide) waUsageGuide.style.display = 'none';
            return;
        } else {
            if (waNodeSetup) waNodeSetup.style.display = 'none';
        }

        // 3. Packages setup
        if (!packages_installed) {
            if (waDepsSetup) waDepsSetup.style.display = 'block';
            if (waControls) waControls.style.display = 'none';
            if (waQrContainer) waQrContainer.style.display = 'none';
            if (waUsageGuide) waUsageGuide.style.display = 'none';
            if (data.base_dir) {
                const cdCmd = document.getElementById('wa-cd-cmd');
                if (cdCmd) cdCmd.textContent = 'cd "' + data.base_dir + '"';
            }
            return;
        } else {
            if (waDepsSetup) waDepsSetup.style.display = 'none';
        }

        // 4. Auto-restart: nếu bot bị tắt/lỗi + node & packages OK → tự khởi động lại (GIỚI HẠN 3 LẦN)
        if (['stopped', 'disconnected', 'error'].includes(bot_status) && node_installed && packages_installed) {
            if (!waAutoRestartAttempted && waAutoRestartCount < 3) {
                waAutoRestartAttempted = true;
                waAutoRestartCount++;
                console.log(`[WA] Bot stopped, auto-restarting... (attempt ${waAutoRestartCount}/3)`);
                fetch('/api/whatsapp/restart', { method: 'POST' }).then(function () {
                    setTimeout(function () { waAutoRestartAttempted = false; }, 30000);
                }).catch(function () {
                    waAutoRestartAttempted = false;
                });
            } else if (waAutoRestartCount >= 3) {
                // Đã thử 3 lần, không auto-restart nữa
                if (!waAutoRestartExhausted) {
                    waAutoRestartExhausted = true;
                    console.log('[WA] Auto-restart exhausted after 3 attempts');
                }
            }
        } else if (bot_status === 'connected') {
            // Reset counter khi kết nối thành công
            waAutoRestartCount = 0;
            waAutoRestartExhausted = false;
        }

        // 5. Controls
        const isRunning = ['starting', 'qr_pending', 'authenticated', 'connected'].includes(bot_status);
        const isStopped = ['stopped', 'error', 'not_running'].includes(bot_status) || !bot_status;
        if (waRestartBtn) waRestartBtn.style.display = isStopped ? 'inline-flex' : 'none';
        if (waDisconnectBtn) waDisconnectBtn.style.display = isRunning ? 'inline-flex' : 'none';
        if (waSwitchBtn) waSwitchBtn.style.display = isRunning ? 'inline-flex' : 'none';
        if (waResetBtn) waResetBtn.style.display = 'inline-flex'; // Luôn hiện

        // 6. QR Code - render bằng canvas
        if (bot_status === 'qr_pending' && qr_data) {
            if (waQrContainer) waQrContainer.style.display = 'block';
            if (waUsageGuide) waUsageGuide.style.display = 'none';

            // Render lại QR nếu data hoặc image thay đổi
            if (qr_data !== waLastQrData || qr_image !== waLastQrImage) {
                waLastQrData = qr_data;
                waLastQrImage = qr_image;
                waRenderQR(qr_data, qr_image);
            }
        } else {
            if (waQrContainer) waQrContainer.style.display = 'none';
            waLastQrData = null;
            waLastQrImage = null;
        }

        // 7. Usage guide (khi đã connected)
        if (waUsageGuide) {
            waUsageGuide.style.display = bot_status === 'connected' ? 'block' : 'none';
        }

        // 8. Logs - luôn hiển thị
        if (logs && logs.length > 0 && waLogBox) {
            waLogBox.innerHTML = logs.map(function (l) {
                return '<div class="wa-log-line">' + waEscapeHtml(l) + '</div>';
            }).join('');
            waLogBox.scrollTop = waLogBox.scrollHeight;
        }
    }

    function waEscapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // Render QR Code vào canvas element
    // Ưu tiên 1: dùng server-rendered base64 image (qr_image từ bot.js)
    // Ưu tiên 2: dùng QRCode.toCanvas() từ CDN
    // Ưu tiên 3: dùng QRCode.toDataURL() từ CDN
    // Fallback: hiện thông báo quét QR trong CMD
    function waRenderQR(data, serverImage) {
        if (!waQrCanvas) return;

        // Ưu tiên 1: Dùng server-rendered base64 image (đáng tin cậy nhất)
        if (serverImage) {
            var img = new Image();
            img.onload = function () {
                var ctx = waQrCanvas.getContext('2d');
                waQrCanvas.width = 280;
                waQrCanvas.height = 280;
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, 280, 280);
                ctx.drawImage(img, 0, 0, 280, 280);
                if (waQrFallback) waQrFallback.style.display = 'none';
                console.log('[WA] QR rendered from server image');
            };
            img.onerror = function () {
                console.error('[WA] Server QR image load failed, trying client-side');
                waRenderQRClientSide(data);
            };
            img.src = serverImage;
            return;
        }

        // Fallback: client-side rendering
        waRenderQRClientSide(data);
    }

    function waRenderQRClientSide(data) {
        if (!waQrCanvas) return;

        // Thử dùng QRCode library từ CDN
        if (typeof QRCode !== 'undefined' && typeof QRCode.toCanvas === 'function') {
            QRCode.toCanvas(waQrCanvas, data, {
                width: 280,
                margin: 2,
                color: { dark: '#000000', light: '#ffffff' },
                errorCorrectionLevel: 'M'
            }, function (err) {
                if (err) {
                    console.error('[WA] QR canvas render error:', err);
                    waShowQrFallback();
                } else {
                    if (waQrFallback) waQrFallback.style.display = 'none';
                    console.log('[WA] QR rendered via client-side toCanvas');
                }
            });
        } else if (typeof QRCode !== 'undefined' && typeof QRCode.toDataURL === 'function') {
            // Fallback: dùng toDataURL rồi vẽ lên canvas
            QRCode.toDataURL(data, {
                width: 280,
                margin: 2,
                color: { dark: '#000000', light: '#ffffff' }
            }).then(function (url) {
                var img = new Image();
                img.onload = function () {
                    var ctx = waQrCanvas.getContext('2d');
                    waQrCanvas.width = 280;
                    waQrCanvas.height = 280;
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, 280, 280);
                    ctx.drawImage(img, 0, 0, 280, 280);
                    if (waQrFallback) waQrFallback.style.display = 'none';
                    console.log('[WA] QR rendered via client-side toDataURL');
                };
                img.src = url;
            }).catch(function (err) {
                console.error('[WA] QR toDataURL error:', err);
                waShowQrFallback();
            });
        } else {
            console.error('[WA] QRCode library not loaded');
            waShowQrFallback();
        }
    }

    function waShowQrFallback() {
        if (waQrFallback) waQrFallback.style.display = 'block';
        // Vẽ thông báo lỗi lên canvas
        if (waQrCanvas) {
            var ctx = waQrCanvas.getContext('2d');
            waQrCanvas.width = 280;
            waQrCanvas.height = 280;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, 280, 280);
            ctx.fillStyle = '#999999';
            ctx.font = '14px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('QR không hiển thị được', 140, 130);
            ctx.fillText('Quét QR trong CMD/Terminal', 140, 155);
        }
    }

    // Nút: Khởi động lại Bot
    if (waRestartBtn) {
        waRestartBtn.addEventListener('click', async function () {
            waRestartBtn.disabled = true;
            waRestartBtn.textContent = '⏳ Đang khởi động...';
            waAutoRestartAttempted = true; // Ngăn auto-restart conflict
            try {
                var resp = await fetch('/api/whatsapp/restart', { method: 'POST' });
                var data = await resp.json();
                if (!data.success) {
                    alert('Lỗi: ' + (data.message || 'Không thể khởi động lại bot'));
                }
            } catch (e) {
                console.error('[WA] Restart error:', e);
                alert('Lỗi khởi động bot: ' + e.message);
            }
            waRestartBtn.disabled = false;
            waRestartBtn.textContent = '🚀 Khởi động lại Bot';
            // Reset auto-restart counter khi user bấm thủ công
            waAutoRestartCount = 0;
            waAutoRestartExhausted = false;
            setTimeout(function () { waAutoRestartAttempted = false; }, 30000);
            waRefreshStatus();
        });
    }

    // Nút: Ngắt kết nối
    if (waDisconnectBtn) {
        waDisconnectBtn.addEventListener('click', async function () {
            if (!confirm('Bạn có chắc muốn ngắt kết nối WhatsApp Bot?')) return;
            waDisconnectBtn.disabled = true;
            waAutoRestartAttempted = true; // Ngăn auto-restart ngay sau khi ngắt
            try {
                await fetch('/api/whatsapp/stop', { method: 'POST' });
            } catch (e) {
                console.error('[WA] Stop error:', e);
            }
            waDisconnectBtn.disabled = false;
            // Cho phép auto-restart lại sau 60s
            setTimeout(function () { waAutoRestartAttempted = false; }, 60000);
            waRefreshStatus();
        });
    }

    // Nút: Đổi tài khoản (logout + restart)
    if (waSwitchBtn) {
        waSwitchBtn.addEventListener('click', async function () {
            if (!confirm('Đổi tài khoản sẽ xóa session hiện tại và yêu cầu quét QR mới. Tiếp tục?')) return;
            waSwitchBtn.disabled = true;
            waSwitchBtn.textContent = '⏳ Đang xử lý...';
            waAutoRestartAttempted = true;
            try {
                var resp = await fetch('/api/whatsapp/logout', { method: 'POST' });
                var respData = await resp.json();
                if (!respData.success) {
                    alert('Lỗi: ' + (respData.message || 'Không thể đổi tài khoản'));
                }
            } catch (e) {
                console.error('[WA] Logout error:', e);
                alert('Lỗi kết nối server: ' + e.message);
            }
            waSwitchBtn.disabled = false;
            waSwitchBtn.textContent = '🔄 Đổi tài khoản';
            waAutoRestartCount = 0;
            waAutoRestartExhausted = false;
            setTimeout(function () { waAutoRestartAttempted = false; }, 30000);
            waRefreshStatus();
        });
    }

    // Nút: Làm mới hoàn toàn (xóa toàn bộ session + kill Chrome + restart)
    if (waResetBtn) {
        waResetBtn.addEventListener('click', async function () {
            if (!confirm('Làm mới hoàn toàn sẽ xóa toàn bộ phiên đăng nhập, kill Chrome cũ, và khởi động lại bot. Tiếp tục?')) return;
            waResetBtn.disabled = true;
            waResetBtn.textContent = '⏳ Đang làm mới...';
            waAutoRestartAttempted = true;
            try {
                var resp = await fetch('/api/whatsapp/reset', { method: 'POST' });
                var respData = await resp.json();
                if (!respData.success) {
                    alert('Lỗi: ' + (respData.message || 'Không thể làm mới bot'));
                }
            } catch (e) {
                console.error('[WA] Reset error:', e);
                alert('Lỗi: ' + e.message);
            }
            waResetBtn.disabled = false;
            waResetBtn.textContent = '🧹 Làm mới hoàn toàn';
            waAutoRestartCount = 0;
            waAutoRestartExhausted = false;
            setTimeout(function () { waAutoRestartAttempted = false; }, 30000);
            waRefreshStatus();
        });
    }
})();

// ============================================================
// 🤖 AI CONFIGURATION CONTROLLER (Per-Key Model)
// ============================================================

(function () {
    var aiKeyInput = document.getElementById('ai-key-input');
    var aiAddKeyBtn = document.getElementById('ai-add-key-btn');
    var aiKeysList = document.getElementById('ai-keys-list');

    // Cache models per base_url to avoid re-fetching
    var modelsCache = {};

    aiLoadConfig();

    async function aiLoadConfig() {
        try {
            var resp = await fetch('/api/ai/config');
            if (!resp.ok) return;
            var data = await resp.json();
            aiRenderKeys(data.keys || []);
        } catch (e) {
            console.error('[AI] Load config error:', e);
        }
    }

    function aiRenderKeys(keys) {
        if (!aiKeysList) return;
        if (keys.length === 0) {
            aiKeysList.innerHTML = '<div style="padding:16px;color:var(--text-secondary);font-size:0.85em;text-align:center;border:1px dashed var(--border-color);border-radius:8px;">Chưa có API key nào. Paste key vào ô bên trên để bắt đầu.</div>';
            return;
        }

        aiKeysList.innerHTML = '';
        keys.forEach(function (k) {
            var card = document.createElement('div');
            card.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:8px;padding:10px 14px;margin-bottom:8px;';

            // Row 1: key info + status + delete
            var statusColor = k.status === 'blocked' ? '#ef4444' : '#10b981';
            var statusIcon = k.status === 'blocked' ? '⛔' : '✅';
            var providerName = aiDetectProvider(k.base_url);

            var row1 = document.createElement('div');
            row1.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;';
            row1.innerHTML =
                '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
                '<span style="font-family:monospace;font-size:0.85em;color:var(--text-primary);">🔑 ' + k.masked + '</span>' +
                '<span style="font-size:0.7em;padding:2px 6px;border-radius:4px;background:rgba(99,102,241,0.15);color:#818cf8;">' + providerName + '</span>' +
                '<span style="font-size:0.7em;color:' + statusColor + ';font-weight:600;">' + statusIcon + '</span>' +
                '</div>' +
                '<button class="ai-del-btn" data-index="' + k.index + '" style="background:var(--accent-red,#ef4444);color:#fff;border:none;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:0.8em;" title="Xóa key">✕</button>';

            // Row 2: model selector + refresh
            var row2 = document.createElement('div');
            row2.style.cssText = 'display:flex;align-items:center;gap:6px;';

            var label = document.createElement('span');
            label.style.cssText = 'font-size:0.8em;color:var(--text-secondary);white-space:nowrap;';
            label.textContent = 'Model:';

            var select = document.createElement('select');
            select.className = 'ai-model-sel';
            select.setAttribute('data-index', String(k.index));
            select.style.cssText = 'flex:1;padding:5px 8px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-primary);color:var(--text-primary);font-size:0.82em;';

            // Populate with current model
            var defaultOpt = document.createElement('option');
            defaultOpt.value = '';
            defaultOpt.textContent = '-- Chọn model --';
            select.appendChild(defaultOpt);

            if (k.model) {
                var opt = document.createElement('option');
                opt.value = k.model;
                opt.textContent = k.model;
                select.appendChild(opt);
                select.value = k.model;
            }

            var refreshBtn = document.createElement('button');
            refreshBtn.className = 'ai-refresh-btn';
            refreshBtn.setAttribute('data-index', String(k.index));
            refreshBtn.style.cssText = 'background:var(--accent-blue,#3b82f6);color:#fff;border:none;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:0.75em;white-space:nowrap;';
            refreshBtn.textContent = '🔄 Models';

            row2.appendChild(label);
            row2.appendChild(select);
            row2.appendChild(refreshBtn);

            card.appendChild(row1);
            card.appendChild(row2);

            // Events
            card.querySelector('.ai-del-btn').addEventListener('click', function () {
                aiRemoveKey(parseInt(this.getAttribute('data-index')));
            });

            select.addEventListener('change', function () {
                var idx = parseInt(this.getAttribute('data-index'));
                aiUpdateModel(idx, this.value);
            });

            refreshBtn.addEventListener('click', function () {
                var idx = parseInt(this.getAttribute('data-index'));
                aiFetchModels(idx);
            });

            aiKeysList.appendChild(card);

            // Auto-fetch models if we have cached models for this base_url
            if (modelsCache[k.base_url] && !k.model) {
                aiPopulateSelect(select, modelsCache[k.base_url], k.model);
            }
        });
    }

    function aiDetectProvider(baseUrl) {
        if (!baseUrl) return 'Unknown';
        if (baseUrl.includes('groq.com')) return 'Groq';
        if (baseUrl.includes('openai.com')) return 'OpenAI';
        if (baseUrl.includes('openrouter.ai')) return 'OpenRouter';
        if (baseUrl.includes('anthropic.com')) return 'Anthropic';
        if (baseUrl.includes('together.xyz')) return 'Together';
        if (baseUrl.includes('deepseek.com')) return 'DeepSeek';
        return baseUrl.replace(/https?:\/\//, '').split('/')[0];
    }

    function aiPopulateSelect(select, models, currentModel) {
        select.innerHTML = '<option value="">-- Chọn model --</option>';
        models.forEach(function (m) {
            var opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            select.appendChild(opt);
        });
        if (currentModel) select.value = currentModel;
    }

    // Add key
    if (aiAddKeyBtn) {
        aiAddKeyBtn.addEventListener('click', async function () {
            var key = aiKeyInput ? aiKeyInput.value.trim() : '';
            if (!key) { alert('Vui lòng nhập API key!'); return; }

            aiAddKeyBtn.disabled = true;
            aiAddKeyBtn.textContent = '⏳ Đang thêm...';

            try {
                var resp = await fetch('/api/ai/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'add_key', key: key })
                });
                var data = await resp.json();

                if (data.success) {
                    if (aiKeyInput) aiKeyInput.value = '';

                    // Cache models from auto-fetch
                    if (data.models && data.models.length && data.base_url) {
                        modelsCache[data.base_url] = data.models;
                    }

                    // Reload to show new key card with models
                    aiLoadConfig();

                    // If models were fetched, auto-populate the new card after render
                    if (data.models && data.models.length) {
                        setTimeout(function () {
                            var sel = aiKeysList.querySelector('.ai-model-sel[data-index="' + data.index + '"]');
                            if (sel) {
                                aiPopulateSelect(sel, data.models, '');
                            }
                        }, 200);
                    }
                } else {
                    alert(data.error || data.message || 'Lỗi thêm key');
                }
            } catch (e) {
                alert('Lỗi: ' + e.message);
            }

            aiAddKeyBtn.disabled = false;
            aiAddKeyBtn.textContent = '➕ Thêm Key';
        });
    }

    // Remove key
    async function aiRemoveKey(index) {
        if (!confirm('Xóa API key này?')) return;
        try {
            var resp = await fetch('/api/ai/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'remove_key', index: index })
            });
            var data = await resp.json();
            if (data.success) aiLoadConfig();
            else alert(data.error || data.message || 'Lỗi xóa key');
        } catch (e) { alert('Lỗi: ' + e.message); }
    }

    // Fetch models for a specific key
    async function aiFetchModels(index) {
        var btn = aiKeysList.querySelector('.ai-refresh-btn[data-index="' + index + '"]');
        var sel = aiKeysList.querySelector('.ai-model-sel[data-index="' + index + '"]');
        if (btn) { btn.disabled = true; btn.textContent = '⏳...'; }

        try {
            var resp = await fetch('/api/ai/models', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ index: index })
            });
            var data = await resp.json();

            if (data.success && data.models && sel) {
                var current = sel.value;
                aiPopulateSelect(sel, data.models, current);
            } else {
                alert('❌ ' + (data.message || 'Không thể lấy models'));
            }
        } catch (e) {
            alert('Lỗi: ' + e.message);
        }

        if (btn) { btn.disabled = false; btn.textContent = '🔄 Models'; }
    }

    // Update model for a key (auto-save)
    async function aiUpdateModel(index, model) {
        try {
            await fetch('/api/ai/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'update_key', index: index, model: model })
            });
        } catch (e) {
            console.error('[AI] Update model error:', e);
        }
    }
})();
