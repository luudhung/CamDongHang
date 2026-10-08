#!/bin/bash
# macOS counterpart of run_CamDongHang-win.bat. No Node.js or system Python required.
set -euo pipefail
cd "$(dirname "$0")"
app_root="$(pwd -P)"
locked=0
lock_dir=''

release_lock() {
    if [ "$locked" -eq 1 ]; then
        rm -f "$lock_dir/pid"
        rmdir "$lock_dir"
        locked=0
    fi
}
on_exit() {
    status=$?
    release_lock
    if [ "$status" -ne 0 ]; then
        echo '[ERROR] Khong khoi dong duoc. Xem thong bao phia tren.'
        if [ -t 0 ]; then read -r -p 'Nhan Enter de dong...' ignored || true; fi
    fi
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$(uname -s)" != Darwin ]; then
    echo '[ERROR] File .command nay chi danh cho macOS.'
    exit 1
fi
case "$(uname -m)" in
    arm64)
        arch=aarch64
        archive_hash=ed14e9042f36c0aa18383f5d9729bcbf17847e842666a793b5a5a5d8505c0ca1
        ;;
    x86_64)
        arch=x86_64
        archive_hash=08310045a2611bad730d7c1a01e847a1ea729d9dcfe29110ca67cbdf3998bb54
        ;;
    *) echo '[ERROR] Can Mac Intel hoac Apple Silicon.'; exit 1 ;;
esac
port=8080
check_only=0
no_browser=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --port|-Port)
            [ "$#" -ge 2 ] || { echo '[ERROR] Thieu so cong.'; exit 1; }
            port="$2"; shift 2 ;;
        --check-only|-CheckOnly) check_only=1; shift ;;
        --no-browser|-NoBrowser) no_browser=1; shift ;;
        *) echo "[ERROR] Tham so khong hop le: $1"; exit 1 ;;
    esac
done
case "$port" in ''|*[!0-9]*) echo '[ERROR] Cong phai la so.'; exit 1 ;; esac
[ "${#port}" -le 5 ] && [ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || {
    echo '[ERROR] Cong phai tu 1024 den 65535.'; exit 1;
}
for file in app.py public/index.html public/script.js public/scanner-worker.js public/vendor/zxing/zxing_reader.wasm; do
    [ -f "$file" ] || { echo "[ERROR] Thieu $file. Hay giai nen toan bo goi ZIP."; exit 1; }
done

runtime_base="$app_root/.runtime"
runtime_dir="$runtime_base/python-3.14.8-$arch-macos"
python_path="$runtime_dir/bin/python3.14"
archive_name="cpython-3.14.8+20261003-$arch-apple-darwin-install_only_stripped.tar.gz"
archive_path="$app_root/installer/$archive_name"
health_code='import sys,http.server,socketserver,json,ssl,subprocess,webbrowser,fcntl; assert sys.version_info[:3] == (3,14,8)'
test_python() { [ -x "$1" ] && "$1" -I -X utf8 -c "$health_code" >/dev/null 2>&1; }

mkdir -p "$runtime_base" "$app_root/installer"
lock_dir="$runtime_base/.mac-setup.lock"
attempt=0
until mkdir "$lock_dir" 2>/dev/null; do
    if [ -f "$lock_dir/pid" ]; then
        owner="$(cat "$lock_dir/pid")"
        case "$owner" in
            ''|*[!0-9]*) ;;
            *) if ! kill -0 "$owner" 2>/dev/null; then
                   rm -f "$lock_dir/pid"
                   rmdir "$lock_dir" 2>/dev/null || true
                   continue
               fi ;;
        esac
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -le 60 ] || { echo '[ERROR] Dang chuan bi o cua so khac. Thu lai sau.'; exit 1; }
    sleep 1
done
locked=1
echo "$$" > "$lock_dir/pid"
echo 'CamDongHang - Camera / QR / Barcode (khong WhatsApp)'
if test_python "$python_path"; then
    echo '[OK] Python da san sang; khong can cai lai.'
else
    if [ ! -f "$archive_path" ]; then
        echo '[SETUP] Dang tai Python rieng tu Astral GitHub. Can Internet lan dau...'
        url="https://github.com/astral-sh/python-build-standalone/releases/download/20261003/${archive_name/+/%2B}"
        download="$archive_path.download-$$"
        curl --fail --location --proto '=https' --tlsv1.2 --retry 2 --connect-timeout 15 --max-time 300 -o "$download" "$url"
        actual_hash="$(shasum -a 256 "$download" | awk '{print $1}')"
        [ "$actual_hash" = "$archive_hash" ] || { echo '[ERROR] Python tai ve sai SHA-256.'; exit 1; }
        mv "$download" "$archive_path"
    fi
    actual_hash="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
    [ "$actual_hash" = "$archive_hash" ] || { echo '[ERROR] Goi Python bi hong. Hay chep lai goi day du.'; exit 1; }
    echo '[SETUP] Dang chuan bi Python trong .runtime...'
    stage="$(mktemp -d "$runtime_base/.mac-setup.XXXXXXXX")"
    tar -xzf "$archive_path" -C "$stage"
    test_python "$stage/python/bin/python3.14" || {
        echo '[ERROR] Python khong chay duoc tren macOS nay. Kiem tra phien ban he dieu hanh.'; exit 1;
    }
    if [ -e "$runtime_dir" ]; then
        mv "$runtime_dir" "$runtime_base/python-broken-$(date +%Y%m%d%H%M%S)-$$"
    fi
    mv "$stage/python" "$runtime_dir"
    rmdir "$stage"
    echo '[OK] Chuan bi xong. Cac lan sau se dung lai Python nay.'
fi
release_lock
if [ "$check_only" -eq 1 ]; then echo '[OK] Kiem tra xong.'; exit 0; fi

server_args=("$app_root/app.py" --port "$port" --no-bot)
if [ "$no_browser" -eq 1 ]; then
    server_args+=(--no-browser)
else
    for browser in '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
                   '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' \
                   "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
                   "$HOME/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"; do
        if [ -x "$browser" ]; then server_args+=(--browser-path "$browser"); break; fi
    done
fi
echo "[START] http://localhost:$port - giu cua so nay mo khi quay."
"$python_path" -I -X utf8 "${server_args[@]}"
