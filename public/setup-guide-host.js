(() => {
    const key = 'camdonghang.setup.v1.seen';
    const button = document.getElementById('setup-guide-btn');
    const dialog = document.createElement('dialog');
    dialog.className = 'setup-guide-shell';
    dialog.setAttribute('aria-label', 'Hướng dẫn setup CamDongHang');
    const frame = document.createElement('iframe');
    frame.title = 'Hướng dẫn setup từng bước';
    dialog.append(frame);
    document.body.append(dialog);
    const recording = () => [...document.querySelectorAll('.recording-indicator')].some(node => node.style.display === 'block');
    const recorderWatch = new MutationObserver(() => { if (dialog.open && recording()) dialog.close(); });
    function open() {
        if (recording()) { alert('Dừng quay trước khi mở hướng dẫn setup.'); return; }
        frame.src = 'setup-guide.html?platform=offline';
        dialog.showModal();
        recorderWatch.observe(document.getElementById('camera-grid'), {subtree:true, childList:true, attributes:true, attributeFilter:['style']});
    }
    function finish() { recorderWatch.disconnect(); try { localStorage.setItem(key, '1'); } catch {} button?.focus(); }
    dialog.addEventListener('close', finish);
    button?.addEventListener('click', open);
    window.addEventListener('message', event => {
        if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.type !== 'cam-setup-guide') return;
        const ids = {settings:'settings-btn', videos:'videos-btn', refresh:'refresh-btn'};
        if (event.data.action === 'close' || ids[event.data.action]) {
            dialog.close();
            if (ids[event.data.action]) document.getElementById(ids[event.data.action])?.click();
        }
    });
    let seen = false; try { seen = localStorage.getItem(key) === '1'; } catch {}
    if (!seen) open();
})();
