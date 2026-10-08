"""
CamĐóngHàng - Offline Server (No License Required)
=====================================================
Standalone Python HTTP server that serves the CamĐóngHàng web UI
and provides all necessary API endpoints including Google Drive integration.

Usage:
    python app.py
    Double-click run_CamDongHang-win.bat (Windows) or run_CamDongHang-mac.command (macOS)

Opens browser automatically at http://localhost:8080
"""

import http.server
import socketserver
import json
import os
import sys
import time
import webbrowser
import threading
import io
import shutil
import urllib.parse
import urllib.request
import ssl
import subprocess
import platform
import signal
import re as _re
import traceback
import argparse
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

# ============== COMMAND LINE ARGUMENTS ==============

def parse_args():
    parser = argparse.ArgumentParser(description='CamĐóngHàng - Offline Server')
    parser.add_argument('--port', type=int, default=8080,
                        help='Port to run the server on (default: 8080)')
    parser.add_argument('--no-bot', action='store_true',
                        help='Disable WhatsApp integration')
    parser.add_argument('--no-browser', action='store_true',
                        help='Do not automatically open the browser')
    parser.add_argument('--browser-path', default='',
                        help='Browser executable used to open the local camera page')
    return parser.parse_args()

_args = parse_args()

# ============== CONFIGURATION ==============

PORT = _args.port
IS_PRIMARY = (PORT == 8080)
SKIP_BOT = _args.no_bot
BASE_DIR = Path(__file__).parent.resolve()
PUBLIC_DIR = BASE_DIR / "public"
CONFIG_FILE = BASE_DIR / "camera_config.json"
BOT_JS = BASE_DIR / "bot.js"
PACKAGE_JSON = BASE_DIR / "package.json"

# Load config
def load_config():
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            config = json.load(f)
        videos_dir = config.get("videos_dir", str(BASE_DIR / "Videos"))
        # Make sure videos_dir is absolute
        if not os.path.isabs(videos_dir):
            videos_dir = str(BASE_DIR / videos_dir)
        return {
            "videos_dir": videos_dir,
            "storage_mode": config.get("storage_mode", "offline"),
            "retention_days": config.get("retention_days", 30),
            "drive_api_key": config.get("drive_api_key", ""),
            "drive_folder_id": config.get("drive_folder_id", ""),
            "drive_auto_upload": config.get("drive_auto_upload", False),
        }
    except Exception:
        return {
            "videos_dir": str(BASE_DIR / "Videos"),
            "storage_mode": "offline",
            "retention_days": 30,
            "drive_api_key": "",
            "drive_folder_id": "",
            "drive_auto_upload": False,
        }

def save_config_file(config_data):
    """Save config to camera_config.json"""
    try:
        # Load existing data
        existing = {}
        if CONFIG_FILE.exists():
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                existing = json.load(f)
        # Merge
        existing.update(config_data)
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(existing, f, ensure_ascii=False, indent=4)
        return True
    except Exception as e:
        print(f"[Config] Error saving: {e}")
        return False

CONFIG = load_config()
VIDEOS_DIR = Path(CONFIG["videos_dir"])

# Ensure Videos directory exists
VIDEOS_DIR.mkdir(parents=True, exist_ok=True)

print(f"[CamDongHang] Videos directory: {VIDEOS_DIR}")
print(f"[CamDongHang] Public directory: {PUBLIC_DIR}")


# ============== WHATSAPP BOT MANAGER ==============

class WhatsAppBotManager:
    """Quản lý subprocess chạy bot.js"""

    def __init__(self):
        self.process = None
        self.status = "stopped"       # stopped, starting, qr_pending, connected, error
        self.qr_data = None            # QR string gần nhất
        self.qr_image = None           # QR base64 image data URL
        self.last_error = None
        self.logs = []                 # 50 log entries gần nhất
        self._reader_thread = None
        self._stderr_thread = None
        self._auto_started = False     # Đã tự khởi động chưa

    def check_node_installed(self):
        """Kiểm tra Node.js đã cài chưa"""
        try:
            is_win = platform.system() == "Windows"
            result = subprocess.run(
                ["node", "--version"],
                capture_output=True, text=True, timeout=10,
                shell=is_win,
                creationflags=subprocess.CREATE_NO_WINDOW if is_win else 0
            )
            if result.returncode == 0:
                return {"installed": True, "version": result.stdout.strip()}
        except Exception:
            pass
        return {"installed": False, "version": None}

    def check_npm_installed(self):
        """Kiểm tra npm đã cài chưa"""
        try:
            is_win = platform.system() == "Windows"
            result = subprocess.run(
                ["npm", "--version"],
                capture_output=True, text=True, timeout=10,
                shell=is_win,
                creationflags=subprocess.CREATE_NO_WINDOW if is_win else 0
            )
            if result.returncode == 0:
                return {"installed": True, "version": result.stdout.strip()}
        except Exception:
            pass
        return {"installed": False, "version": None}

    def check_packages_installed(self):
        """Kiểm tra node_modules đã cài chưa"""
        node_modules = BASE_DIR / "node_modules"
        pkg_lock = BASE_DIR / "package-lock.json"
        return node_modules.exists() and pkg_lock.exists()

    def install_node_auto(self):
        """Tự động cài Node.js trên Windows bằng winget hoặc trả về lệnh thủ công"""
        system = platform.system()
        if system == "Windows":
            # Thử cài bằng winget
            try:
                result = subprocess.run(
                    ["winget", "install", "--id", "OpenJS.NodeJS.LTS",
                     "--accept-source-agreements", "--accept-package-agreements"],
                    capture_output=True, text=True, timeout=300,
                    creationflags=subprocess.CREATE_NO_WINDOW
                )
                if result.returncode == 0:
                    return {"success": True, "method": "winget", "message": "Node.js đã được cài đặt thành công qua winget! Vui lòng đóng và mở lại phần mềm."}
                else:
                    return {
                        "success": False,
                        "method": "manual",
                        "message": "Không thể tự động cài Node.js. Vui lòng cài thủ công.",
                        "manual_command": 'winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements',
                        "download_url": "https://nodejs.org/en/download/"
                    }
            except FileNotFoundError:
                return {
                    "success": False,
                    "method": "manual",
                    "message": "winget không khả dụng. Vui lòng cài Node.js thủ công.",
                    "manual_command": 'winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements',
                    "download_url": "https://nodejs.org/en/download/"
                }
            except Exception as e:
                return {"success": False, "method": "manual", "message": str(e), "download_url": "https://nodejs.org/en/download/"}
        else:
            return {
                "success": False,
                "method": "manual",
                "message": "Vui lòng cài Node.js thủ công cho hệ điều hành của bạn.",
                "download_url": "https://nodejs.org/en/download/"
            }

    def install_packages(self):
        """Chạy npm install"""
        try:
            is_win = platform.system() == "Windows"
            result = subprocess.run(
                ["npm", "install"],
                capture_output=True, text=True, timeout=120,
                cwd=str(BASE_DIR),
                shell=is_win,
                creationflags=subprocess.CREATE_NO_WINDOW if is_win else 0
            )
            if result.returncode == 0:
                return {"success": True, "message": "Đã cài đặt packages thành công!"}
            else:
                return {"success": False, "message": f"npm install lỗi: {result.stderr[:500]}"}
        except Exception as e:
            return {"success": False, "message": str(e)}

    def start_bot(self):
        """Khởi chạy bot.js dưới dạng subprocess"""
        if self.process and self.process.poll() is None:
            return {"success": False, "message": "Bot đang chạy rồi!"}

        if not BOT_JS.exists():
            return {"success": False, "message": "Không tìm thấy file bot.js!"}

        # QUAN TRỌNG: Dọn sạch Chromium cũ trước khi start
        self._kill_chrome_orphans()
        self._cleanup_chrome_locks()

        try:
            is_win = platform.system() == "Windows"
            kwargs = {
                "stdout": subprocess.PIPE,
                "stderr": subprocess.PIPE,
                "stdin": subprocess.PIPE,
                "cwd": str(BASE_DIR),
                "bufsize": 1,
                "shell": is_win,
            }
            if is_win:
                kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

            self.process = subprocess.Popen(
                ["node", str(BOT_JS)],
                **kwargs
            )

            self.status = "starting"
            self.qr_data = None
            self.last_error = None
            self.logs = []

            # Thread đọc output từ bot
            self._reader_thread = threading.Thread(target=self._read_output, daemon=True)
            self._reader_thread.start()

            # Thread đọc stderr (QUAN TRỌNG: nếu không đọc, pipe buffer đầy sẽ crash process)
            self._stderr_thread = threading.Thread(target=self._read_stderr, daemon=True)
            self._stderr_thread.start()

            print(f"[WhatsApp] Bot started (PID: {self.process.pid})")
            return {"success": True, "message": "Bot đang khởi động..."}

        except Exception as e:
            self.status = "error"
            self.last_error = str(e)
            return {"success": False, "message": str(e)}

    def _kill_process_tree(self):
        """Kill toàn bộ process tree (Windows: cmd.exe + node.exe)"""
        if not self.process:
            return
        pid = self.process.pid
        try:
            if platform.system() == "Windows":
                # taskkill /F /T kills the entire process tree
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(pid)],
                    capture_output=True, timeout=10,
                    creationflags=subprocess.CREATE_NO_WINDOW
                )
            else:
                import os as _os
                _os.killpg(_os.getpgid(pid), signal.SIGKILL)
        except Exception as e:
            print(f"[WhatsApp] Process tree kill error: {e}")
            try:
                self.process.kill()
            except Exception:
                pass
        # Wait for process to fully exit
        try:
            self.process.wait(timeout=5)
        except Exception:
            pass

    def _kill_chrome_orphans(self):
        """Kill các process Chrome/Chromium đang dùng thư mục .wwebjs_auth (còn sốt lại từ lần chạy trước)"""
        if platform.system() != "Windows":
            return
        auth_dir = str(BASE_DIR / '.wwebjs_auth').replace('/', '\\\\')
        try:
            # Liệt kê tất cả chrome.exe processes
            result = subprocess.run(
                ['wmic', 'process', 'where', "name='chrome.exe'", 'get', 'ProcessId,CommandLine', '/value'],
                capture_output=True, text=True, timeout=10,
                creationflags=subprocess.CREATE_NO_WINDOW
            )
            pids_to_kill = []
            current_pid = None
            current_cmdline = ""
            for line in result.stdout.split('\n'):
                line = line.strip()
                if line.startswith('CommandLine='):
                    current_cmdline = line[12:]
                elif line.startswith('ProcessId='):
                    current_pid = line[10:].strip()
                    if current_pid and '.wwebjs_auth' in current_cmdline:
                        pids_to_kill.append(current_pid)
                    current_pid = None
                    current_cmdline = ""

            for pid in pids_to_kill:
                try:
                    subprocess.run(
                        ['taskkill', '/F', '/PID', pid],
                        capture_output=True, timeout=5,
                        creationflags=subprocess.CREATE_NO_WINDOW
                    )
                except Exception:
                    pass
            if pids_to_kill:
                print(f"[WhatsApp] Killed {len(pids_to_kill)} orphaned Chrome processes")
                self._add_log(f"🗑️ Đã kill {len(pids_to_kill)} Chrome còn sót")
                time.sleep(1)
        except Exception as e:
            print(f"[WhatsApp] Chrome cleanup error: {e}")

    def _cleanup_chrome_locks(self):
        """Xóa các file lock của Chromium trong .wwebjs_auth (để tránh lỗi 'browser already running')"""
        auth_dir = BASE_DIR / '.wwebjs_auth'
        if not auth_dir.exists():
            return
        lock_files = ['SingletonLock', 'SingletonCookie', 'SingletonSocket']
        cleaned = False
        for root, dirs, files in os.walk(str(auth_dir)):
            for f in files:
                if f in lock_files:
                    try:
                        os.remove(os.path.join(root, f))
                        cleaned = True
                    except Exception:
                        pass
        if cleaned:
            print("[WhatsApp] Cleaned Chromium lock files")
            self._add_log("🗑️ Đã xóa lock files của Chromium")

    def stop_bot(self):
        """Dừng bot và dọn sạch process"""
        if not self.process or self.process.poll() is not None:
            self.status = "stopped"
            self.process = None
            return {"success": True, "message": "Bot đã dừng."}

        self._kill_process_tree()
        self._kill_chrome_orphans()
        self._cleanup_chrome_locks()

        self.status = "stopped"
        self.qr_data = None
        self.qr_image = None
        self.process = None
        print("[WhatsApp] Bot stopped.")
        return {"success": True, "message": "Bot đã dừng."}

    def restart_bot(self):
        """Dừng rồi khởi động lại bot"""
        self._add_log("🔄 Đang khởi động lại bot...")
        self.stop_bot()
        time.sleep(2)
        result = self.start_bot()
        return result

    def reset_bot(self):
        """Đặt lại hoàn toàn: kill tất cả, xóa session, khởi động lại"""
        self._add_log("🔄 Đang làm mới hoàn toàn bot...")
        self.stop_bot()

        # Xóa toàn bộ thư mục auth
        auth_dir = BASE_DIR / '.wwebjs_auth'
        if auth_dir.exists():
            try:
                shutil.rmtree(str(auth_dir))
                self._add_log("🗑️ Đã xóa toàn bộ session cũ.")
            except Exception as e:
                self._add_log(f"⚠️ Lỗi xóa session: {e}")

        time.sleep(2)
        self._add_log("🚀 Đang khởi động lại bot...")
        result = self.start_bot()
        return result

    def logout_and_restart(self):
        """Đăng xuất WhatsApp (xóa session) rồi khởi động lại để tạo QR mới"""
        self._add_log("🔄 Đang đăng xuất WhatsApp...")
        # Gửi lệnh logout qua stdin nếu bot đang chạy
        if self.process and self.process.poll() is None:
            try:
                self.process.stdin.write(b'logout\n')
                self.process.stdin.flush()
                # Chờ bot tự thoát
                try:
                    self.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
            except Exception as e:
                print(f"[WhatsApp] Logout stdin error: {e}")

        # Force stop everything
        self.stop_bot()

        # Xóa thư mục auth để đảm bảo session cũ bị xóa
        auth_dir = BASE_DIR / '.wwebjs_auth'
        if auth_dir.exists():
            try:
                shutil.rmtree(str(auth_dir))
                print("[WhatsApp] Deleted .wwebjs_auth session folder.")
                self._add_log("🗑️ Đã xóa session cũ.")
            except Exception as e:
                print(f"[WhatsApp] Error deleting auth: {e}")
                self._add_log(f"⚠️ Lỗi xóa session: {e}")

        # Khởi động lại bot
        time.sleep(1)
        self._add_log("🔄 Đang khởi động lại bot với tài khoản mới...")
        result = self.start_bot()
        return result

    def get_status(self):
        """Lấy trạng thái hiện tại"""
        # Kiểm tra process còn sống không
        if self.process and self.process.poll() is not None:
            if self.status not in ("stopped", "error"):
                self.status = "stopped"

        node_info = self.check_node_installed()
        return {
            "bot_status": self.status,
            "qr_data": self.qr_data if self.status == "qr_pending" else None,
            "qr_image": self.qr_image if self.status == "qr_pending" else None,
            "last_error": self.last_error,
            "node_installed": node_info["installed"],
            "node_version": node_info["version"],
            "packages_installed": self.check_packages_installed(),
            "bot_js_exists": BOT_JS.exists(),
            "logs": self.logs[-20:],  # 20 log gần nhất
            "base_dir": str(BASE_DIR),
        }

    def _read_output(self):
        """Thread đọc stdout từ subprocess bot"""
        try:
            for raw_line in iter(self.process.stdout.readline, b''):
                try:
                    line = raw_line.decode('utf-8', errors='replace').strip()
                except Exception:
                    continue

                if not line:
                    continue

                # Parse BOT_EVENT
                if line.startswith('@@BOT_EVENT@@'):
                    json_str = line[len('@@BOT_EVENT@@'):]
                    try:
                        event = json.loads(json_str)
                        self._handle_event(event)
                    except json.JSONDecodeError:
                        pass
                else:
                    # Log thường
                    self._add_log(line)
                    print(f"[WhatsApp] {line}")

        except Exception as e:
            print(f"[WhatsApp] Reader thread error: {e}")
        finally:
            if self.status not in ("stopped", "qr_pending"):
                exit_code = None
                try:
                    exit_code = self.process.returncode if self.process else None
                except Exception:
                    pass
                self.status = "error" if exit_code else "stopped"
                if exit_code:
                    self.last_error = f"Bot process thoát với mã lỗi {exit_code}"
                    self._add_log(f"❌ Bot process kết thúc bất thường (exit code: {exit_code})")
                else:
                    self._add_log("Bot process đã kết thúc.")

    def _read_stderr(self):
        """Thread đọc stderr từ subprocess bot (QUAN TRỌNG: tránh pipe buffer overflow)"""
        try:
            if not self.process or not self.process.stderr:
                return
            for raw_line in iter(self.process.stderr.readline, b''):
                try:
                    line = raw_line.decode('utf-8', errors='replace').strip()
                except Exception:
                    continue
                if not line:
                    continue
                # Chỉ log các dòng quan trọng, bỏ qua debug noise
                lower = line.lower()
                if any(kw in lower for kw in ['error', 'fatal', 'exception', 'cannot', 'failed', 'enoent', 'crash']):
                    self._add_log(f"⚠️ {line[:200]}")
                    print(f"[WhatsApp/stderr] {line[:200]}")
        except Exception:
            pass  # Stderr reader không cần báo lỗi

    def _handle_event(self, event):
        """Xử lý event JSON từ bot"""
        etype = event.get("type", "")

        if etype == "qr":
            self.qr_data = event.get("qr_data")
            self.qr_image = event.get("qr_image")  # base64 data URL from bot.js
            self.status = "qr_pending"
            self._add_log("📱 Mã QR đã sẵn sàng, chờ quét...")

        elif etype == "qr_image":
            # Follow-up event: cập nhật base64 image cho QR đã tạo
            if self.status == "qr_pending":
                self.qr_image = event.get("qr_image")


        elif etype == "authenticated":
            self.qr_data = None
            self.qr_image = None
            self.status = "authenticated"
            self._add_log("🔐 Xác thực thành công!")

        elif etype == "ready":
            self.qr_data = None
            self.qr_image = None
            self.status = "connected"
            self._add_log("✅ Bot đã kết nối WhatsApp!")

        elif etype == "disconnected":
            self.status = "disconnected"
            self._add_log(f"🔌 Ngắt kết nối: {event.get('reason', '')}")

        elif etype == "auth_failure":
            self.status = "error"
            self.last_error = event.get("message", "Auth failure")
            self._add_log(f"❌ Xác thực thất bại: {self.last_error}")

        elif etype == "message_received":
            self._add_log(f"📩 Tin nhắn từ {event.get('group','')}: {event.get('body','')[:50]}")

        elif etype == "searching":
            self._add_log(f"🔍 Tìm video: {event.get('code', '')}")

        elif etype == "found":
            self._add_log(f"✅ Tìm thấy: {event.get('path', '')}")

        elif etype == "not_found":
            self._add_log(f"❌ Không tìm thấy: {event.get('code', '')}")

        elif etype == "sent":
            self._add_log(f"📤 Đã gửi video: {event.get('code', '')} ({event.get('size_mb','')} MB)")

        elif etype == "compressing":
            self._add_log(f"🔄 Đang nén: {event.get('code', '')}")

        elif etype == "compressed":
            self._add_log(f"✅ Nén xong: {event.get('code', '')}")

        elif etype == "error":
            self._add_log(f"❌ Lỗi: {event.get('message', '')}")

        elif etype == "initializing":
            self.status = "starting"
            self._add_log("⏳ Đang khởi tạo...")

        elif etype == "loading":
            self._add_log(f"⏳ Loading: {event.get('percent', 0)}% - {event.get('message', '')}")

        elif etype == "ai_query":
            self._add_log(f"🤖 AI hỏi: {event.get('body', '')[:60]}")

        elif etype == "ai_response":
            self._add_log(f"🤖 AI trả lời (model: {event.get('model', '?')})")

    def _add_log(self, msg):
        """Thêm log entry (giới hạn 50)"""
        timestamp = datetime.now().strftime("%H:%M:%S")
        self.logs.append(f"[{timestamp}] {msg}")
        if len(self.logs) > 50:
            self.logs = self.logs[-50:]


# Global instance
wa_bot = WhatsAppBotManager()


# ============== AI KEY MANAGER ==============

class AIKeyManager:
    """Quản lý nhiều API keys cho AI - mỗi key có base_url + model riêng"""

    # Auto-detect base_url from key prefix (LONGEST prefix first!)
    KEY_PREFIXES = [
        ("sk-or-", "https://openrouter.ai/api/v1"),
        ("sk-ant-", "https://api.anthropic.com/v1"),
        ("gsk_", "https://api.groq.com/openai/v1"),
        ("sk-", "https://api.openai.com/v1"),
    ]

    def __init__(self):
        # Each entry: { "key": str, "base_url": str, "model": str }
        self.keys = []
        self.current_index = 0
        self.blocked_keys = {}   # key_string -> unblock_time
        self.cooldown = 60
        self._load_from_config()

    def _detect_base_url(self, key):
        """Auto-detect base_url from key prefix"""
        for prefix, url in self.KEY_PREFIXES:
            if key.startswith(prefix):
                return url
        return "https://api.openai.com/v1"

    def _load_from_config(self):
        """Load AI config from camera_config.json"""
        try:
            if CONFIG_FILE.exists():
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    config = json.load(f)

                # New format: ai_keys is array of dicts
                raw_keys = config.get("ai_keys", [])
                if raw_keys and isinstance(raw_keys, list):
                    if isinstance(raw_keys[0], dict):
                        self.keys = raw_keys
                    else:
                        # Migrate old format (list of strings)
                        old_model = config.get("ai_selected_model", "")
                        self.keys = []
                        for k in raw_keys:
                            self.keys.append({
                                "key": k,
                                "base_url": self._detect_base_url(k),
                                "model": old_model,
                            })

                # Also check old format ai_api_keys
                if not self.keys:
                    old_keys = config.get("ai_api_keys", [])
                    old_model = config.get("ai_selected_model", "")
                    for k in old_keys:
                        self.keys.append({
                            "key": k,
                            "base_url": self._detect_base_url(k),
                            "model": old_model,
                        })

                # Fix wrongly-saved base_urls (e.g. gsk_ key with openai url)
                changed = False
                for entry in self.keys:
                    key_str = entry.get("key", "")
                    correct_url = self._detect_base_url(key_str)
                    if entry.get("base_url", "") != correct_url:
                        entry["base_url"] = correct_url
                        changed = True
                if changed:
                    self.save_to_config()
        except Exception as e:
            print(f"[AI] Error loading config: {e}")

    def save_to_config(self):
        """Save AI config to camera_config.json"""
        save_config_file({"ai_keys": self.keys})

    def get_active_entry(self):
        """Get next available key entry (round-robin, skip blocked)"""
        if not self.keys:
            return None

        now = time.time()
        # Unblock expired keys
        self.blocked_keys = {
            k: t for k, t in self.blocked_keys.items() if t > now
        }

        for i in range(len(self.keys)):
            idx = (self.current_index + i) % len(self.keys)
            entry = self.keys[idx]
            key_str = entry.get("key", "")
            if key_str and key_str not in self.blocked_keys:
                self.current_index = (idx + 1) % len(self.keys)
                return entry

        return None  # All keys blocked

    def mark_rate_limited(self, key_str):
        """Mark a key as rate-limited"""
        self.blocked_keys[key_str] = time.time() + self.cooldown
        suffix = key_str[-6:] if len(key_str) > 6 else "***"
        print(f"[AI] Key ...{suffix} rate-limited, cooldown {self.cooldown}s")

    def get_config_masked(self):
        """Return config with masked keys for frontend"""
        masked = []
        now = time.time()
        for i, entry in enumerate(self.keys):
            k = entry.get("key", "")
            is_blocked = k in self.blocked_keys and self.blocked_keys[k] > now
            masked.append({
                "index": i,
                "masked": f"...{k[-6:]}" if len(k) > 6 else "***",
                "base_url": entry.get("base_url", ""),
                "model": entry.get("model", ""),
                "status": "blocked" if is_blocked else "active",
            })
        return {
            "keys": masked,
            "total_keys": len(self.keys),
        }

    def fetch_models_for_key(self, index):
        """Fetch available models for a specific key by index"""
        if index < 0 or index >= len(self.keys):
            return {"success": False, "message": "Index không hợp lệ"}

        entry = self.keys[index]
        key = entry.get("key", "")
        base_url = entry.get("base_url", "").rstrip("/")

        if not key:
            return {"success": False, "message": "Key trống"}
        if not base_url:
            return {"success": False, "message": "Base URL trống"}

        url = f"{base_url}/models"
        try:
            req = urllib.request.Request(url)
            req.add_header("Authorization", f"Bearer {key}")
            req.add_header("Content-Type", "application/json")
            req.add_header("User-Agent", "CamDongHang/1.0")

            ctx = ssl.create_default_context()
            with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
                data = json.loads(resp.read().decode("utf-8"))

            models = []
            if "data" in data:
                for m in data["data"]:
                    model_id = m.get("id", "")
                    if model_id:
                        models.append(model_id)
            models.sort()
            return {"success": True, "models": models}

        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", errors="replace")[:300]
            except Exception:
                pass
            return {"success": False, "message": f"HTTP {e.code}: {body}"}
        except Exception as e:
            return {"success": False, "message": str(e)}

    def chat_completion(self, messages):
        """Call AI chat completion with key rotation"""
        if not self.keys:
            return {"success": False, "message": "Chưa cấu hình API key AI"}

        attempts = len(self.keys)
        last_error = "Không có API key"

        for _ in range(attempts):
            entry = self.get_active_entry()
            if not entry:
                return {"success": False, "message": "Tất cả API keys đều bị rate-limited, vui lòng chờ"}

            key_str = entry.get("key", "")
            base_url = entry.get("base_url", "").rstrip("/")
            model = entry.get("model", "")

            if not model:
                last_error = f"Key ...{key_str[-6:]} chưa chọn model"
                continue

            url = f"{base_url}/chat/completions"
            payload = json.dumps({
                "model": model,
                "messages": messages,
                "max_tokens": 1024,
                "temperature": 0.7,
            }).encode("utf-8")

            try:
                req = urllib.request.Request(url, data=payload, method="POST")
                req.add_header("Authorization", f"Bearer {key_str}")
                req.add_header("Content-Type", "application/json")
                req.add_header("User-Agent", "CamDongHang/1.0")

                ctx = ssl.create_default_context()
                with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
                    data = json.loads(resp.read().decode("utf-8"))

                choices = data.get("choices", [])
                if choices:
                    content = choices[0].get("message", {}).get("content", "")
                    return {"success": True, "response": content, "model": model}
                return {"success": False, "message": "AI không trả về response"}

            except urllib.error.HTTPError as e:
                if e.code == 429:
                    self.mark_rate_limited(key_str)
                    last_error = "Rate limited, đang chuyển key..."
                    continue
                body = ""
                try:
                    body = e.read().decode("utf-8", errors="replace")[:200]
                except Exception:
                    pass
                last_error = f"HTTP {e.code}: {body}"
                break
            except Exception as e:
                last_error = str(e)
                break

        return {"success": False, "message": last_error}

    def build_video_context(self):
        """Build context string from Videos directory for AI queries"""
        context_parts = []
        if not VIDEOS_DIR.exists():
            return "Thư mục Videos trống."

        folders = sorted(VIDEOS_DIR.iterdir(), reverse=True)
        count = 0
        for folder in folders:
            if not folder.is_dir():
                continue
            try:
                parts = folder.name.split("-")
                if len(parts) != 3:
                    continue
            except Exception:
                continue

            stats_file = folder / "stats.json"
            videos = []
            if stats_file.exists():
                try:
                    with open(stats_file, "r", encoding="utf-8") as f:
                        stats = json.load(f)
                    videos = stats.get("videos", [])
                except Exception:
                    pass

            tracked_names = {v.get("filename") for v in videos}
            for mp4 in sorted([*folder.glob("*.mp4"), *folder.glob("*.webm")]):
                if mp4.name not in tracked_names:
                    fstat = mp4.stat()
                    videos.append({
                        "filename": mp4.name,
                        "code": mp4.stem.split("_", 1)[1] if "_" in mp4.stem else mp4.stem,
                        "size": fstat.st_size,
                        "timestamp": datetime.fromtimestamp(fstat.st_mtime).isoformat(),
                    })

            if videos:
                day_info = [f"\n📅 Ngày {folder.name} ({len(videos)} video):"]
                for v in videos:
                    ts = v.get("timestamp", "?")
                    code = v.get("code", "?")
                    fname = v.get("filename", "?")
                    size_mb = v.get("size", 0) / (1024 * 1024)
                    employee = v.get("employee", "")
                    emp_str = f", NV: {employee}" if employee else ""
                    day_info.append(
                        f"  - {fname} | Mã: {code} | Thời gian: {ts} | "
                        f"{size_mb:.1f}MB{emp_str}"
                    )
                context_parts.append("\n".join(day_info))

            count += 1
            if count >= 7:
                break

        if not context_parts:
            return "Thư mục Videos trống, chưa có video nào."

        return (
            "Dưới đây là dữ liệu video đóng hàng gần nhất:\n"
            + "\n".join(context_parts)
        )


# Global AI manager
ai_manager = AIKeyManager()


# ============== STATS HELPER ==============

_video_save_thread_lock = threading.Lock()


@contextmanager
def recording_save_lock():
    """Serialize saves across threads and any concurrent server processes."""
    with _video_save_thread_lock:
        with open(VIDEOS_DIR / ".recording-save.lock", "a+b") as lock_file:
            if os.name == "nt":
                import msvcrt
                lock_file.seek(0, os.SEEK_END)
                if lock_file.tell() == 0:
                    lock_file.write(b"0")
                    lock_file.flush()
                deadline = time.monotonic() + 30
                while True:
                    try:
                        lock_file.seek(0)
                        msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
                        break
                    except OSError:
                        if time.monotonic() >= deadline:
                            raise TimeoutError("Không lấy được khóa lưu video")
                        time.sleep(0.05)
                try:
                    yield
                finally:
                    lock_file.seek(0)
                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock_file, fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(lock_file, fcntl.LOCK_UN)

def get_today_folder():
    """Get today's folder name in DD-MM-YYYY format"""
    now = datetime.now()
    return now.strftime("%d-%m-%Y")


def get_stats_file(folder_name):
    """Get the stats.json path for a given date folder"""
    return VIDEOS_DIR / folder_name / "stats.json"


def load_stats(folder_name):
    """Load stats.json for a given date folder"""
    stats_file = get_stats_file(folder_name)
    if stats_file.exists():
        try:
            with open(stats_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    return {"videos": []}


def save_stats(folder_name, stats):
    """Save stats.json for a given date folder"""
    folder_path = VIDEOS_DIR / folder_name
    folder_path.mkdir(parents=True, exist_ok=True)
    stats_file = folder_path / "stats.json"
    temporary = stats_file.with_suffix(f".tmp-{os.getpid()}-{threading.get_ident()}")
    try:
        with open(temporary, "w", encoding="utf-8") as f:
            json.dump(stats, f, ensure_ascii=False, indent=2)
        for attempt in range(10):
            try:
                os.replace(temporary, stats_file)
                break
            except PermissionError:
                if attempt == 9:
                    raise
                time.sleep(0.02)
    finally:
        if temporary.exists():
            temporary.unlink()


def parse_folder_date(folder_name):
    """Parse DD-MM-YYYY folder name to datetime"""
    try:
        parts = folder_name.split("-")
        if len(parts) != 3:
            return None
        day, month, year = int(parts[0]), int(parts[1]), int(parts[2])
        return datetime(year, month, day)
    except (ValueError, IndexError):
        return None


# ============== REQUEST HANDLER ==============

class CamDongHangHandler(http.server.BaseHTTPRequestHandler):
    """HTTP request handler for CamĐóngHàng"""

    def log_message(self, format, *args):
        """Custom log format"""
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {args[0]}")

    def send_json(self, data, status=200):
        """Send JSON response"""
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", len(body))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, message, status=400):
        """Send JSON error response"""
        self.send_json({"error": message}, status)

    def read_body(self):
        """Read request body"""
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length > 0:
            return self.rfile.read(content_length)
        return b""

    def read_json(self):
        """Read and parse JSON body"""
        body = self.read_body()
        if body:
            return json.loads(body.decode("utf-8"))
        return {}

    # ---------- ROUTING ----------

    def do_GET(self):
        """Handle GET requests"""
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # Root -> serve index.html
        if path == "/" or path == "":
            self.serve_file(PUBLIC_DIR / "index.html")
            return

        # /public/* -> serve from public directory
        if path.startswith("/public/"):
            rel_path = path[len("/public/"):]
            self.serve_file(PUBLIC_DIR / rel_path)
            return

        # Files directly under public (script.js, styles.css, etc.)
        if path.startswith("/"):
            # Try public directory first
            public_file = PUBLIC_DIR / path.lstrip("/")
            if public_file.exists() and public_file.is_file():
                self.serve_file(public_file)
                return

        # /Videos/* -> serve video files and stats.json
        if path.startswith("/Videos/"):
            rel_path = path[len("/Videos/"):]
            file_path = VIDEOS_DIR / rel_path
            if file_path.exists() and file_path.is_file():
                self.serve_file(file_path)
                return
            self.send_error(404, "File not found")
            return

        # /sounds/* -> serve from public/sounds
        if path.startswith("/sounds/"):
            rel_path = path[len("/sounds/"):]
            self.serve_file(PUBLIC_DIR / "sounds" / rel_path)
            return

        # API GET endpoints

        if path == "/api/whatsapp/status":
            self.handle_wa_status()
            return

        if path == "/api/ai/config":
            self.handle_ai_config_get()
            return

        if path == "/api/settings":
            self.handle_settings_get()
            return

        self.send_error(404, "Not Found")

    def do_POST(self):
        """Handle POST requests"""
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path.startswith('/api/whatsapp/') and SKIP_BOT:
            self.send_json({"success": False, "disabled": True,
                            "message": "WhatsApp đang tắt trong chế độ chỉ dùng camera."}, 403)
            return

        if path == "/api/check-duplicate":
            self.handle_check_duplicate()
        elif path == "/upload-video":
            self.handle_upload_video()
        elif path == "/api/statistics":
            self.handle_statistics()
        elif path == "/api/videos/list":
            self.handle_videos_list()
        elif path == "/api/open-video":
            self.handle_open_video()
        elif path == "/api/whatsapp/start":
            self.handle_wa_start()
        elif path == "/api/whatsapp/stop":
            self.handle_wa_stop()
        elif path == "/api/whatsapp/restart":
            self.handle_wa_restart()
        elif path == "/api/whatsapp/reset":
            self.handle_wa_reset()
        elif path == "/api/whatsapp/logout":
            self.handle_wa_logout()
        elif path == "/api/ai/config":
            self.handle_ai_config_save()
        elif path == "/api/ai/models":
            self.handle_ai_models()
        elif path == "/api/ai/chat":
            self.handle_ai_chat()
        elif path == "/api/settings":
            self.handle_settings_save()
        else:
            self.send_error_json("Unknown endpoint", 404)

    def do_OPTIONS(self):
        """Handle CORS preflight"""
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    # ---------- STATIC FILE SERVING ----------

    MIME_TYPES = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".ico": "image/x-icon",
        ".svg": "image/svg+xml",
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".wasm": "application/wasm",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
        ".ttf": "font/ttf",
        ".webp": "image/webp",
    }

    def serve_file(self, file_path):
        """Serve a static file"""
        file_path = Path(file_path).resolve()

        if not file_path.exists() or not file_path.is_file():
            self.send_error(404, f"File not found: {file_path.name}")
            return

        ext = file_path.suffix.lower()
        content_type = self.MIME_TYPES.get(ext, "application/octet-stream")

        try:
            file_size = file_path.stat().st_size
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", file_size)
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()

            with open(file_path, "rb") as f:
                # Stream large files in chunks
                while True:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)

        except (IOError, BrokenPipeError) as e:
            print(f"[Error] Serving file {file_path.name}: {e}")

    # ---------- API: CHECK DUPLICATE ----------

    def handle_check_duplicate(self):
        try:
            data = self.read_json()
            code = data.get("code", "").strip()
            order_type = data.get("orderType", "normal")

            if not code:
                self.send_json({"exists": False})
                return

            today_folder = get_today_folder()
            stats = load_stats(today_folder)

            exists = False
            for video in stats.get("videos", []):
                video_code = video.get("code", "")
                video_order_type = video.get("orderType", "normal")
                if video_code == code and video_order_type == order_type:
                    exists = True
                    break

            self.send_json({"exists": exists})

        except Exception as e:
            print(f"[Error] check-duplicate: {e}")
            self.send_json({"exists": False})

    # ---------- API: UPLOAD VIDEO ----------

    def handle_upload_video(self):
        try:
            content_type = self.headers.get("Content-Type", "")

            if "multipart/form-data" not in content_type:
                self.send_error_json("Expected multipart/form-data", 400)
                return

            boundary = None
            for part in content_type.split(";"):
                part = part.strip()
                if part.startswith("boundary="):
                    boundary = part[len("boundary="):]
                    break

            if not boundary:
                self.send_error_json("No boundary in multipart", 400)
                return

            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)

            fields, files = self.parse_multipart(body, boundary)

            camera_id = fields.get("cameraId", "1")
            code = fields.get("code", "unknown")
            duration = int(fields.get("duration", "0"))
            order_type = fields.get("orderType", "normal")
            employee = fields.get("employee", "")

            if "video" not in files:
                self.send_error_json("No video file", 400)
                return

            video_data, video_filename = files["video"]

            with recording_save_lock():
                today_folder = get_today_folder()
                folder_path = VIDEOS_DIR / today_folder
                folder_path.mkdir(parents=True, exist_ok=True)

                # Enforce a filename, then reserve it under the shared process lock.
                video_filename = _re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', video_filename).strip(' .')
                if not video_filename or Path(video_filename).suffix.lower() not in {'.mp4', '.webm'}:
                    raise ValueError("Tên video không hợp lệ")
                original_name = Path(video_filename)
                video_path = folder_path / video_filename
                suffix = 0
                while video_path.exists():
                    video_filename = f"{original_name.stem}_{suffix:02d}{original_name.suffix}"
                    video_path = folder_path / video_filename
                    suffix += 1
                with open(video_path, "xb") as f:
                    f.write(video_data)

                file_size = len(video_data)
                timestamp = datetime.now().isoformat()

                print(f"[Save] Video saved: {video_filename} ({file_size / 1024 / 1024:.1f} MB)")

                stats = load_stats(today_folder)
                video_entry = {
                    "filename": video_filename,
                    "code": code,
                    "cameraId": int(camera_id),
                    "duration": duration,
                    "size": file_size,
                    "timestamp": timestamp,
                    "orderType": order_type,
                    "uploaded": False,
                    "relativePath": f"{today_folder}/{video_filename}"
                }

                if employee:
                    video_entry["employee"] = employee

                stats["videos"].append(video_entry)
                save_stats(today_folder, stats)

            self.send_json({
                "success": True,
                "filename": video_filename,
                "size": file_size,
            })

        except Exception as e:
            print(f"[Error] upload-video: {e}")
            traceback.print_exc()
            self.send_error_json(f"Upload failed: {str(e)}", 500)

    def parse_multipart(self, body, boundary):
        """Parse multipart/form-data body"""
        fields = {}
        files = {}

        boundary_bytes = f"--{boundary}".encode()

        parts = body.split(boundary_bytes)

        for part in parts:
            if not part or part.strip() == b"" or part.strip() == b"--":
                continue

            if part.startswith(b"\r\n"):
                part = part[2:]

            if part.endswith(b"--\r\n"):
                part = part[:-4]
            elif part.endswith(b"\r\n"):
                part = part[:-2]

            header_end = part.find(b"\r\n\r\n")
            if header_end == -1:
                continue

            headers_raw = part[:header_end].decode("utf-8", errors="replace")
            body_data = part[header_end + 4:]

            name = None
            filename = None
            for header_line in headers_raw.split("\r\n"):
                if "Content-Disposition" in header_line:
                    name_match = header_line.split('name="')
                    if len(name_match) > 1:
                        name = name_match[1].split('"')[0]
                    if 'filename="' in header_line:
                        fn_match = header_line.split('filename="')
                        if len(fn_match) > 1:
                            filename = fn_match[1].split('"')[0]

            if name:
                if filename:
                    files[name] = (body_data, filename)
                else:
                    fields[name] = body_data.decode("utf-8", errors="replace")

        return fields, files

    # ---------- API: STATISTICS ----------

    def handle_statistics(self):
        try:
            data = self.read_json()
            fetch_all = data.get("fetchAll", False)

            all_videos = []

            if fetch_all:
                if VIDEOS_DIR.exists():
                    for folder in sorted(VIDEOS_DIR.iterdir()):
                        if folder.is_dir() and parse_folder_date(folder.name):
                            stats = load_stats(folder.name)
                            all_videos.extend(stats.get("videos", []))
            else:
                start_date_str = data.get("startDate", "")
                end_date_str = data.get("endDate", "")

                if not start_date_str or not end_date_str:
                    self.send_json({"videos": []})
                    return

                try:
                    start_date = datetime.strptime(start_date_str, "%Y-%m-%d")
                    end_date = datetime.strptime(end_date_str, "%Y-%m-%d")
                    end_date = end_date.replace(hour=23, minute=59, second=59)
                except ValueError:
                    self.send_json({"videos": []})
                    return

                if VIDEOS_DIR.exists():
                    for folder in sorted(VIDEOS_DIR.iterdir()):
                        if not folder.is_dir():
                            continue
                        folder_date = parse_folder_date(folder.name)
                        if folder_date and start_date <= folder_date <= end_date:
                            stats = load_stats(folder.name)
                            all_videos.extend(stats.get("videos", []))

            self.send_json({"videos": all_videos})

        except Exception as e:
            print(f"[Error] statistics: {e}")
            traceback.print_exc()
            self.send_json({"videos": []})




    def handle_videos_list(self):
        """POST /api/videos/list - List all videos grouped by date"""
        try:
            video_groups = []

            if VIDEOS_DIR.exists():
                for folder in sorted(VIDEOS_DIR.iterdir(), reverse=True):
                    if not folder.is_dir() or not parse_folder_date(folder.name):
                        continue

                    stats = load_stats(folder.name)
                    videos = list(stats.get("videos", []))

                    # Also scan for mp4 files on disk not tracked in stats.json
                    tracked_files = {v.get("filename") for v in videos}
                    for mp4_file in sorted([*folder.glob("*.mp4"), *folder.glob("*.webm")]):
                        if mp4_file.name not in tracked_files:
                            file_stat = mp4_file.stat()
                            # Parse camera and code from filename: Camera1_CODE.mp4
                            parts = mp4_file.stem.split("_", 1)
                            camera_id = parts[0].replace("Camera", "") if parts[0].startswith("Camera") else "?"
                            code = parts[1] if len(parts) > 1 else mp4_file.stem

                            videos.append({
                                "filename": mp4_file.name,
                                "code": code,
                                "cameraId": int(camera_id) if camera_id.isdigit() else 0,
                                "duration": 0,
                                "size": file_stat.st_size,
                                "timestamp": datetime.fromtimestamp(file_stat.st_mtime).isoformat(),
                                "orderType": "normal",
                                "uploaded": False,
                                "relativePath": f"{folder.name}/{mp4_file.name}"
                            })

                    if videos:
                        group = {
                            "date": folder.name,
                            "videos": videos,
                            "totalSize": sum(v.get("size", 0) for v in videos),
                            "uploadedCount": sum(1 for v in videos if v.get("uploaded")),
                            "totalCount": len(videos),
                        }
                        video_groups.append(group)

            self.send_json({"groups": video_groups})

        except Exception as e:
            print(f"[Error] videos/list: {e}")
            self.send_json({"groups": []})

    def handle_open_video(self):
        """POST /api/open-video - Open a video file in default system player"""
        try:
            data = self.read_json()
            relative_path = data.get("relativePath", "")

            if not relative_path:
                self.send_error_json("relativePath is required", 400)
                return

            # Build full path relative to VIDEOS_DIR
            file_path = (VIDEOS_DIR / relative_path).resolve()

            # Security: ensure file is within VIDEOS_DIR
            if not str(file_path).startswith(str(VIDEOS_DIR.resolve())):
                self.send_error_json("Access denied", 403)
                return

            if not file_path.exists():
                self.send_error_json(f"File not found: {relative_path}", 404)
                return

            # Open with default system player
            system = platform.system()
            try:
                if system == "Windows":
                    os.startfile(str(file_path))
                elif system == "Darwin":  # macOS
                    subprocess.Popen(["open", str(file_path)])
                else:  # Linux
                    subprocess.Popen(["xdg-open", str(file_path)])

                print(f"[Videos] Opened: {file_path.name}")
                self.send_json({"success": True})
            except Exception as e:
                print(f"[Videos] Failed to open: {e}")
                self.send_error_json(f"Cannot open file: {str(e)}", 500)

        except Exception as e:
            print(f"[Error] open-video: {e}")
            self.send_error_json(str(e), 500)

    # ---------- API: SETTINGS PERSISTENCE ----------

    def handle_settings_get(self):
        """GET /api/settings - Trả về UI settings đã lưu"""
        try:
            settings = {}
            if CONFIG_FILE.exists():
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    config = json.load(f)
                settings = config.get("ui_settings", {})
            self.send_json({"success": True, "settings": settings})
        except Exception as e:
            self.send_json({"success": True, "settings": {}})

    def handle_settings_save(self):
        """POST /api/settings - Lưu UI settings vào config file"""
        try:
            data = self.read_json()
            settings = data.get("settings", {})
            if not settings:
                self.send_error_json("Settings rỗng", 400)
                return
            save_config_file({"ui_settings": settings})
            self.send_json({"success": True, "message": "Đã lưu cài đặt"})
        except Exception as e:
            self.send_error_json(str(e), 500)

    # ---------- API: WHATSAPP BOT ----------

    def handle_wa_status(self):
        """GET /api/whatsapp/status"""
        if SKIP_BOT:
            self.send_json({"disabled": True, "bot_status": "disabled", "logs": []})
            return
        try:
            self.send_json(wa_bot.get_status())
        except Exception as e:
            self.send_error_json(str(e), 500)

    def handle_wa_start(self):
        """POST /api/whatsapp/start"""
        try:
            result = wa_bot.start_bot()
            self.send_json(result)
        except Exception as e:
            self.send_error_json(str(e), 500)

    def handle_wa_stop(self):
        """POST /api/whatsapp/stop"""
        try:
            result = wa_bot.stop_bot()
            self.send_json(result)
        except Exception as e:
            self.send_error_json(str(e), 500)

    def handle_wa_restart(self):
        """POST /api/whatsapp/restart - Dừng rồi khởi động lại bot"""
        try:
            result = wa_bot.restart_bot()
            self.send_json(result)
        except Exception as e:
            self.send_error_json(str(e), 500)

    def handle_wa_reset(self):
        """POST /api/whatsapp/reset - Làm mới hoàn toàn (xóa session + kill Chrome + restart)"""
        try:
            result = wa_bot.reset_bot()
            self.send_json(result)
        except Exception as e:
            self.send_error_json(str(e), 500)

    def handle_wa_logout(self):
        """POST /api/whatsapp/logout - Đăng xuất và đổi tài khoản"""
        try:
            result = wa_bot.logout_and_restart()
            self.send_json(result)
        except Exception as e:
            self.send_error_json(str(e), 500)

    # ---------- API: AI CONFIGURATION ----------

    def handle_ai_config_get(self):
        """GET /api/ai/config - Lấy AI config (keys masked)"""
        try:
            self.send_json(ai_manager.get_config_masked())
        except Exception as e:
            self.send_error_json(str(e), 500)

    def handle_ai_config_save(self):
        """POST /api/ai/config - Quản lý AI keys"""
        try:
            data = self.read_json()
            action = data.get("action", "")

            if action == "add_key":
                new_key = data.get("key", "").strip()
                base_url = data.get("base_url", "").strip().rstrip("/")
                if not new_key:
                    self.send_error_json("API key không được để trống", 400)
                    return
                # Check duplicate
                for entry in ai_manager.keys:
                    if entry.get("key") == new_key:
                        self.send_error_json("Key này đã tồn tại", 400)
                        return
                # Auto-detect base_url if not provided
                if not base_url:
                    base_url = ai_manager._detect_base_url(new_key)
                ai_manager.keys.append({
                    "key": new_key,
                    "base_url": base_url,
                    "model": "",
                })
                ai_manager.save_to_config()
                # Auto-fetch models for this new key
                idx = len(ai_manager.keys) - 1
                models_result = ai_manager.fetch_models_for_key(idx)
                self.send_json({
                    "success": True,
                    "message": "Thêm key thành công",
                    "index": idx,
                    "base_url": base_url,
                    "models": models_result.get("models", []),
                })

            elif action == "remove_key":
                index = data.get("index")
                if index is not None:
                    index = int(index)
                    if 0 <= index < len(ai_manager.keys):
                        removed = ai_manager.keys.pop(index)
                        key_str = removed.get("key", "")
                        ai_manager.blocked_keys.pop(key_str, None)
                        ai_manager.save_to_config()
                        self.send_json({"success": True, "message": "Xóa key thành công"})
                    else:
                        self.send_error_json("Index không hợp lệ", 400)
                else:
                    self.send_error_json("Index không hợp lệ", 400)

            elif action == "update_key":
                index = data.get("index")
                if index is not None:
                    index = int(index)
                    if 0 <= index < len(ai_manager.keys):
                        if "model" in data:
                            ai_manager.keys[index]["model"] = data["model"]
                        if "base_url" in data:
                            ai_manager.keys[index]["base_url"] = data["base_url"].strip().rstrip("/")
                        ai_manager.save_to_config()
                        self.send_json({"success": True, "message": "Cập nhật thành công"})
                    else:
                        self.send_error_json("Index không hợp lệ", 400)
                else:
                    self.send_error_json("Index không hợp lệ", 400)

            else:
                self.send_error_json("Action không hợp lệ", 400)

        except Exception as e:
            self.send_error_json(str(e), 500)

    def handle_ai_models(self):
        """POST /api/ai/models - Fetch models cho 1 key"""
        try:
            data = self.read_json()
            index = data.get("index")
            if index is None:
                self.send_error_json("Thiếu index", 400)
                return
            index = int(index)
            result = ai_manager.fetch_models_for_key(index)
            self.send_json(result)
        except Exception as e:
            self.send_error_json(str(e), 500)

    def handle_ai_chat(self):
        """POST /api/ai/chat - Gọi AI với video context"""
        try:
            data = self.read_json()
            user_message = data.get("message", "").strip()
            if not user_message:
                self.send_error_json("Tin nhắn không được để trống", 400)
                return

            video_context = ai_manager.build_video_context()

            system_prompt = (
                "Bạn là trợ lý AI của hệ thống CamĐóngHàng - phần mềm quay video đóng hàng. "
                "Nhiệm vụ của bạn là trả lời các câu hỏi về các video đóng hàng "
                "dựa trên dữ liệu bên dưới. Trả lời ngắn gọn, chính xác, bằng tiếng Việt.\n\n"
                f"{video_context}"
            )

            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ]

            result = ai_manager.chat_completion(messages)
            self.send_json(result)

        except Exception as e:
            self.send_error_json(str(e), 500)


# ============== SERVER STARTUP ==============

class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    """HTTP Server with threading support"""
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, request, client_address):
        """Suppress broken pipe errors"""
        error = sys.exc_info()[1]
        if isinstance(error, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
            pass
        else:
            super().handle_error(request, client_address)


def open_browser(port):
    """Open browser after a short delay"""
    time.sleep(1.5)
    url = f"http://localhost:{port}"
    print(f"\n[CamDongHang] Opening browser: {url}")
    if _args.browser_path and Path(_args.browser_path).is_file():
        try:
            subprocess.Popen([_args.browser_path, "--new-window", url],
                             creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            return
        except OSError as error:
            print(f"[Browser] Could not open selected browser: {error}")
    webbrowser.open(url)


def main():
    instance_label = "PRIMARY" if IS_PRIMARY else f"SECONDARY (port {PORT})"
    print("=" * 55)
    print(f"  CamĐóngHàng - Offline Server [{instance_label}]")
    print("=" * 55)
    print()
    print(f"  Videos folder : {VIDEOS_DIR}")
    print(f"  Server port   : {PORT}")
    print(f"  Public folder : {PUBLIC_DIR}")
    print(f"  Instance      : {instance_label}")
    if SKIP_BOT:
        print(f"  WhatsApp Bot  : DISABLED (--no-bot)")
    print()

    # Check public directory
    if not PUBLIC_DIR.exists():
        print("[ERROR] Public directory not found!")
        print(f"  Expected: {PUBLIC_DIR}")
        print("  Make sure the 'public' folder exists with index.html")
        input("Press Enter to exit...")
        sys.exit(1)

    if not (PUBLIC_DIR / "index.html").exists():
        print("[ERROR] index.html not found in public directory!")
        input("Press Enter to exit...")
        sys.exit(1)

    # Start server
    try:
        server = ThreadedHTTPServer(("0.0.0.0", PORT), CamDongHangHandler)
        print(f"  [OK] Server started on http://localhost:{PORT}")
        print(f"  [OK] Press Ctrl+C to stop")
        print()

        # Auto-open browser
        if not _args.no_browser:
            browser_thread = threading.Thread(target=open_browser, args=(PORT,), daemon=True)
            browser_thread.start()

        # WhatsApp bot: chỉ chạy ở instance chính (port 8080) và không bị --no-bot
        if not SKIP_BOT and IS_PRIMARY:
            node_check = wa_bot.check_node_installed()
            if node_check["installed"] and wa_bot.check_packages_installed():
                print("[WhatsApp] Auto-starting bot...")
                wa_bot.start_bot()
                wa_bot._auto_started = True
            else:
                print("[WhatsApp] Node.js or packages not installed, skipping bot auto-start.")
        elif SKIP_BOT:
            print("[WhatsApp] Bot disabled by --no-bot flag.")
        else:
            print(f"[WhatsApp] Bot skipped (secondary instance on port {PORT}).")

        server.serve_forever()

    except KeyboardInterrupt:
        print("\n\n[CamDongHang] Server stopped by user.")
        server.shutdown()
    except OSError as e:
        if "address already in use" in str(e).lower() or e.errno == 10048:
            print(f"\n[ERROR] Port {PORT} is already in use!")
            print(f"  Another instance of CamĐóngHàng might be running on this port.")
            print(f"  Close it first or use a different --port")
        else:
            print(f"\n[ERROR] {e}")
        input("Press Enter to exit...")
        sys.exit(1)


if __name__ == "__main__":
    main()
