// Local, pinned reader: scanning also works without an internet connection.
importScripts('vendor/zxing/index.js');
let canvas, context;
let busy = false;
const ready = ZXingWASM.prepareZXingModule({
    overrides: { locateFile: (name) => new URL(`vendor/zxing/${name}`, self.location.href).href },
    fireImmediately: true
});
ready.then(() => self.postMessage({ type: 'ready' })).catch((error) => {
    self.postMessage({ type: 'error', error: `Không tải được bộ đọc mã: ${error.message}` });
});

function selectScanResult(results) {
    const candidates = results.filter(result => {
        const text = (result.text || '').trim();
        return text && !text.startsWith('#') && !/^(?:https?:\/\/|www\.)/i.test(text);
    });
    // Match the original app: employee/stop cards, then a valid shipping QR.
    // URL/advertising QR codes were filtered above, so they cannot hide a barcode.
    return candidates.find(r => /^(?:SNV-\d+|LEAVEIT)$/.test(r.text.trim()))
        || candidates.find(r => r.format === 'QRCode')
        || candidates.find(r => /\d/.test(r.text)) || candidates[0];
}

self.addEventListener('message', async ({ data: message }) => {
    if (message.type !== 'scan') return;
    const { scanId, bitmap, width, height, thorough } = message.data;
    if (busy) {
        if (bitmap) bitmap.close();
        self.postMessage({ type: 'result', scanId, code: null });
        return;
    }
    busy = true;
    const started = performance.now();
    try {
        await ready;
        let imageData = message.data.imageData;
        if (bitmap) {
            if (!canvas) {
                canvas = new OffscreenCanvas(width, height);
                context = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
            }
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width; canvas.height = height;
            }
            context.drawImage(bitmap, 0, 0);
            imageData = context.getImageData(0, 0, width, height);
        }
        const results = await ZXingWASM.readBarcodesFromImageData(imageData, {
            formats: ['QRCode', 'Code128', 'Code39', 'Code93', 'Codabar', 'EAN-13',
                'EAN-8', 'UPC-A', 'UPC-E', 'DataBar', 'DataBarExpanded', 'ITF', 'DataMatrix', 'PDF417'],
            tryHarder: true,
            tryRotate: true,
            tryInvert: !!thorough,
            maxNumberOfSymbols: 8
        });
        let result = selectScanResult(results);
        let requiresConfirmation = false;
        if (!result && thorough) {
            // Some thermal labels (including TikTok Hỏa tốc) have very short
            // Code128 bars. Keep checksum validation, but allow one intact line.
            // The camera loop confirms this fallback on a second captured frame.
            let thinBars = await ZXingWASM.readBarcodesFromImageData(imageData, {
                formats: ['Code128'], tryHarder: true, tryRotate: true,
                tryInvert: true, minLineCount: 1, maxNumberOfSymbols: 4
            });
            result = selectScanResult(thinBars);
            if (!result) {
                thinBars = await ZXingWASM.readBarcodesFromImageData(imageData, {
                    formats: ['Code128'], tryHarder: true, tryRotate: true,
                    binarizer: 'FixedThreshold', minLineCount: 1, maxNumberOfSymbols: 4
                });
                result = selectScanResult(thinBars);
            }
            requiresConfirmation = !!result;
        }
        self.postMessage({ type: 'result', scanId, code: result ? result.text.trim() : null,
            format: result?.format, requiresConfirmation, elapsed: performance.now() - started });
    } catch (error) {
        self.postMessage({ type: 'error', scanId, error: error.message });
    } finally {
        if (bitmap) bitmap.close();
        busy = false;
    }
});
