import shutil
import os
import ctypes
import json
import urllib.request
import urllib.error
import sys
import subprocess
from ctypes import wintypes

from pty_manager import PtyManager
from config import get as config_get, set as config_set


APP_VERSION = "0.1.0"
GITHUB_REPO = "noahain/Monolith"
OPENCODE_CONFIG_DIR = os.path.join(os.path.expanduser("~"), ".config", "opencode")

# Persistent local configs directory (downloaded/cached)
LOCAL_CONFIGS_DIR = os.path.join(
    os.environ.get('APPDATA', os.path.expanduser('~')), 'Monolith', 'configs'
)
OPENCODE_JSON_PATH = os.path.join(OPENCODE_CONFIG_DIR, "opencode.json")


def get_resource_path(relative_path):
    """Get absolute path to resource, works for dev and for PyInstaller."""
    if getattr(sys, 'frozen', False):
        base_path = sys._MEIPASS
    else:
        base_path = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base_path, relative_path)


BUNDLED_CONFIGS_DIR = get_resource_path('configs')


# Win32 constants for SHBrowseForFolder
BIF_NEWDIALOGSTYLE = 0x00000040
BIF_NONEWFOLDERBUTTON = 0x00000200
WM_USER = 0x0400
BFFM_INITIALIZED = 1
BFFM_SETSELECTIONW = WM_USER + 103


class BROWSEINFO(ctypes.Structure):
    _fields_ = [
        ("hwndOwner", wintypes.HWND),
        ("pidlRoot", ctypes.c_void_p),
        ("pszDisplayName", wintypes.LPWSTR),
        ("lpszTitle", wintypes.LPCWSTR),
        ("ulFlags", wintypes.UINT),
        ("lpfn", ctypes.c_void_p),
        ("lParam", ctypes.c_void_p),
        ("iImage", wintypes.INT),
    ]


BROWSEPROC = ctypes.WINFUNCTYPE(
    ctypes.c_int,
    wintypes.HWND,
    wintypes.UINT,
    ctypes.c_void_p,
    ctypes.c_void_p
)


def _browse_callback_proc(hwnd, msg, lp, data):
    """Callback to set the initial directory when the dialog is initialized."""
    if msg == BFFM_INITIALIZED and data:
        ctypes.windll.user32.SendMessageW(
            hwnd, BFFM_SETSELECTIONW, 1, ctypes.cast(data, wintypes.LPARAM)
        )
    return 0


def _pick_folder_win32(initial_dir=''):
    """Native Windows folder picker with initial directory support via ctypes."""
    display_name = ctypes.create_unicode_buffer(260)
    callback = None
    dir_buffer = None
    lparam = 0

    if initial_dir and os.path.isdir(initial_dir):
        dir_buffer = ctypes.create_unicode_buffer(initial_dir)
        lparam = ctypes.cast(dir_buffer, ctypes.c_void_p)
        callback = BROWSEPROC(_browse_callback_proc)
        lpfn = callback
    else:
        lpfn = None
        lparam = ctypes.c_void_p(0)

    bi = BROWSEINFO()
    bi.hwndOwner = 0
    bi.pidlRoot = None
    bi.pszDisplayName = ctypes.cast(display_name, wintypes.LPWSTR)
    bi.lpszTitle = "Choose Directory"
    bi.ulFlags = BIF_NEWDIALOGSTYLE
    bi.lpfn = ctypes.cast(lpfn, ctypes.c_void_p) if lpfn else ctypes.c_void_p(0)
    bi.lParam = lparam
    bi.iImage = 0

    shell32 = ctypes.windll.shell32
    shell32.SHBrowseForFolderW.restype = ctypes.c_void_p
    shell32.SHGetPathFromIDListW.restype = wintypes.BOOL
    shell32.SHGetPathFromIDListW.argtypes = [ctypes.c_void_p, wintypes.LPWSTR]

    pidl = shell32.SHBrowseForFolderW(ctypes.byref(bi))

    if pidl:
        path_buffer = ctypes.create_unicode_buffer(260)
        shell32.SHGetPathFromIDListW(pidl, path_buffer)
        ole32 = ctypes.windll.ole32
        ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
        ole32.CoTaskMemFree(ctypes.c_void_p(pidl))
        result = path_buffer.value
        return result if result else None
    return None


def _copy_tree(src, dst):
    """Copy a directory tree, overwriting existing files. Skips files that are locked."""
    errors = []
    if not os.path.exists(dst):
        os.makedirs(dst, exist_ok=True)
    for item in os.listdir(src):
        s = os.path.join(src, item)
        d = os.path.join(dst, item)
        if os.path.isdir(s):
            sub_errors = _copy_tree(s, d)
            errors.extend(sub_errors)
        else:
            try:
                os.makedirs(os.path.dirname(d), exist_ok=True)
                if os.path.exists(d):
                    try:
                        os.chmod(d, 0o777)
                        os.remove(d)
                    except Exception:
                        pass
                shutil.copyfile(s, d)
            except PermissionError:
                errors.append(f"Permission denied: {item}")
            except Exception as exc:
                errors.append(f"Failed to copy {item}: {exc}")
    return errors


def _download_configs_from_github():
    """Download configs from GitHub repo to LOCAL_CONFIGS_DIR.
    Tries 'main' branch first, then 'master'. Returns (success: bool, result: str or list)."""
    temp_zip = os.path.join(os.path.expanduser("~"), "AppData", "Local", "Temp", "monolith_update.zip")
    extract_dir = os.path.join(os.path.expanduser("~"), "AppData", "Local", "Temp", "monolith_update")
    tried_branches = []

    def _try_branch(branch):
        tried_branches.append(branch)
        zip_url = f"https://github.com/{GITHUB_REPO}/archive/refs/heads/{branch}.zip"
        req = urllib.request.Request(zip_url, headers={"User-Agent": "Monolith-Updater"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            with open(temp_zip, 'wb') as f:
                f.write(resp.read())
        return branch

    try:
        # Try main first, then master
        branch = None
        for b in ('main', 'master'):
            try:
                branch = _try_branch(b)
                break
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    continue
                raise

        if branch is None:
            return False, f"Branch not found on GitHub. Tried: {', '.join(tried_branches)}"

        import zipfile
        if not zipfile.is_zipfile(temp_zip):
            return False, "Downloaded file is not a valid archive."

        with zipfile.ZipFile(temp_zip, 'r') as z:
            z.extractall(extract_dir)

        repo_name = GITHUB_REPO.split('/')[1]
        source_configs = os.path.join(extract_dir, f"{repo_name}-{branch}", "configs")

        if not os.path.exists(source_configs):
            return False, "Configs folder not found in downloaded archive."

        if os.path.exists(LOCAL_CONFIGS_DIR):
            shutil.rmtree(LOCAL_CONFIGS_DIR)
        os.makedirs(LOCAL_CONFIGS_DIR, exist_ok=True)
        errors = _copy_tree(source_configs, LOCAL_CONFIGS_DIR)

        return True, errors
    except urllib.error.HTTPError as exc:
        return False, f"GitHub error {exc.code}: {exc.reason}"
    except urllib.error.URLError as exc:
        return False, f"Network error: {exc.reason}"
    except Exception as exc:
        return False, str(exc)
    finally:
        for path in (temp_zip, extract_dir):
            if os.path.exists(path):
                try:
                    if os.path.isdir(path):
                        shutil.rmtree(path)
                    else:
                        os.remove(path)
                except Exception:
                    pass


def ensure_configs():
    """Ensure configs are available locally. Downloads from GitHub on first run,
    falls back to bundled configs if download fails."""
    if os.path.exists(LOCAL_CONFIGS_DIR) and os.listdir(LOCAL_CONFIGS_DIR):
        return True, None

    # Try GitHub first
    success, result = _download_configs_from_github()
    if success:
        return True, None

    # Fallback to bundled configs
    if os.path.exists(BUNDLED_CONFIGS_DIR):
        os.makedirs(LOCAL_CONFIGS_DIR, exist_ok=True)
        _copy_tree(BUNDLED_CONFIGS_DIR, LOCAL_CONFIGS_DIR)
        return True, f"Using bundled configs (GitHub download failed: {result})"

    return False, f"Could not download or find configs. {result}"


def _find_opencode():
    """Find the opencode executable, checking PATH and common install locations."""
    # 1. Standard PATH search
    path = shutil.which('opencode')
    if path:
        return path

    # 2. Search common npm / pipx install locations on Windows
    candidates = []
    appdata = os.environ.get('APPDATA', '')
    localappdata = os.environ.get('LOCALAPPDATA', '')
    progfiles = os.environ.get('ProgramFiles', r'C:\Program Files')

    # npm global (various locations)
    if appdata:
        candidates.append(os.path.join(appdata, 'npm', 'opencode.cmd'))
        candidates.append(os.path.join(appdata, 'npm', 'opencode.exe'))
    if localappdata:
        candidates.append(os.path.join(localappdata, 'npm', 'opencode.cmd'))
        candidates.append(os.path.join(localappdata, 'npm', 'opencode.exe'))
        candidates.append(os.path.join(localappdata, 'pipx', 'venvs', 'opencode', 'Scripts', 'opencode.exe'))
    candidates.append(os.path.join(progfiles, 'nodejs', 'opencode.cmd'))
    candidates.append(os.path.join(progfiles, 'nodejs', 'opencode.exe'))

    # 3. Ask npm for its global prefix
    try:
        result = subprocess.run(
            ['npm', 'prefix', '-g'],
            capture_output=True,
            text=True,
            timeout=5,
            shell=True
        )
        if result.returncode == 0 and result.stdout.strip():
            npm_prefix = result.stdout.strip().strip().strip()
            candidates.append(os.path.join(npm_prefix, 'opencode.cmd'))
            candidates.append(os.path.join(npm_prefix, 'opencode.exe'))
            # npm usually puts binaries in a .bin or bin folder inside prefix
            candidates.append(os.path.join(npm_prefix, 'bin', 'opencode.cmd'))
            candidates.append(os.path.join(npm_prefix, 'bin', 'opencode.exe'))
    except Exception:
        pass

    # 4. Try using the shell's where command (inherits user's full PATH)
    try:
        result = subprocess.run(
            ['where', 'opencode'],
            capture_output=True,
            text=True,
            timeout=5,
            shell=True
        )
        if result.returncode == 0 and result.stdout.strip():
            first_line = result.stdout.strip().splitlines()[0]
            if os.path.exists(first_line):
                candidates.insert(0, first_line)
    except Exception:
        pass

    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate

    return None


def _find_node():
    """Find node.exe, which opencode.cmd depends on."""
    node = shutil.which('node')
    if node:
        return node
    candidates = [
        os.path.join(os.environ.get('ProgramFiles', r'C:\Program Files'), 'nodejs', 'node.exe'),
        os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Programs', 'nodejs', 'node.exe'),
        os.path.join(os.environ.get('ProgramFiles(x86)', r'C:\Program Files (x86)'), 'nodejs', 'node.exe'),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return None


class Api:
    def __init__(self):
        self._pty_manager = None
        self._window = None

    def set_window(self, window):
        self._window = window

    # --- Existing methods ---

    def pick_directory(self):
        """Open a native folder picker and return the selected path, or None if cancelled."""
        last_dir = config_get('last_directory') or ''
        if last_dir and not os.path.isdir(last_dir):
            last_dir = ''

        path = _pick_folder_win32(last_dir)
        if path:
            config_set('last_directory', path)
            return path
        return None

    def start_opencode(self, directory):
        """Spawn opencode in the given directory inside a PTY."""
        opencode_path = _find_opencode()

        if not opencode_path:
            self._write_to_terminal(
                "Error: 'opencode' command not found. "
                "Make sure it's installed and in your PATH.\r\n"
            )
            return False

        try:
            self._pty_manager = PtyManager()
            self._pty_manager.spawn(
                opencode_path,
                directory,
                on_output=self._write_to_terminal
            )
            return True
        except Exception as exc:
            self._write_to_terminal(f"\r\nError starting opencode: {exc}\r\n")
            return False

    def send_input(self, data):
        """Forward terminal input to the PTY."""
        if self._pty_manager:
            self._pty_manager.write_input(data)

    def resize_terminal(self, cols, rows):
        """Resize the PTY when the terminal resizes."""
        if self._pty_manager:
            self._pty_manager.resize(cols, rows)

    def terminate(self):
        """Clean up the PTY on shutdown."""
        if self._pty_manager:
            self._pty_manager.terminate()
            self._pty_manager = None

    def _write_to_terminal(self, data):
        """Push data to the frontend terminal via JS evaluation."""
        if self._window:
            escaped = json.dumps(data)
            try:
                self._window.evaluate_js(f'window.writeToTerm({escaped})')
            except Exception:
                pass

    # --- Settings: Setup ---

    def setup_configs(self, api_key):
        """Copy local configs to ~/.config/opencode/ and inject the 21st API key."""
        try:
            if not os.path.exists(LOCAL_CONFIGS_DIR):
                return {"success": False, "error": "Local configs directory not found. Run the app once to download configs."}

            os.makedirs(OPENCODE_CONFIG_DIR, exist_ok=True)
            errors = _copy_tree(LOCAL_CONFIGS_DIR, OPENCODE_CONFIG_DIR)

            # Inject API key into opencode.json
            if os.path.exists(OPENCODE_JSON_PATH):
                with open(OPENCODE_JSON_PATH, 'r', encoding='utf-8') as f:
                    config = json.load(f)

                if 'mcp' not in config:
                    config['mcp'] = {}
                if 'magic-21st' not in config['mcp']:
                    config['mcp']['magic-21st'] = {}
                if 'environment' not in config['mcp']['magic-21st']:
                    config['mcp']['magic-21st']['environment'] = {}

                config['mcp']['magic-21st']['environment']['API_KEY'] = api_key or ''

                with open(OPENCODE_JSON_PATH, 'w', encoding='utf-8') as f:
                    json.dump(config, f, indent=2)

            if errors:
                error_msg = "Setup completed with warnings:\n" + "\n".join(errors)
                return {"success": True, "warning": error_msg}
            return {"success": True}
        except PermissionError as exc:
            return {"success": False, "error": f"Permission denied. Close opencode and try again. ({exc})"}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    def is_setup_complete(self):
        """Check if configs have already been copied."""
        return os.path.exists(OPENCODE_JSON_PATH)

    # --- Settings: Config ---

    def get_opencode_config(self):
        """Read the opencode.json content."""
        try:
            if not os.path.exists(OPENCODE_JSON_PATH):
                return {"success": False, "error": "Config file not found. Run Setup first."}
            with open(OPENCODE_JSON_PATH, 'r', encoding='utf-8') as f:
                content = f.read()
            return {"success": True, "content": content}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    def save_opencode_config(self, content):
        """Save the opencode.json content."""
        try:
            os.makedirs(OPENCODE_CONFIG_DIR, exist_ok=True)
            parsed = json.loads(content)
            with open(OPENCODE_JSON_PATH, 'w', encoding='utf-8') as f:
                json.dump(parsed, f, indent=2)
            return {"success": True}
        except json.JSONDecodeError as exc:
            return {"success": False, "error": f"Invalid JSON: {exc}"}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    # --- Settings: Updater ---

    def get_current_version(self):
        """Return the current app version."""
        return APP_VERSION

    def check_for_updates(self):
        """Check GitHub releases for a newer version."""
        try:
            url = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
            req = urllib.request.Request(url, headers={"User-Agent": "Monolith-Updater"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode('utf-8'))
            latest_tag = data.get('tag_name', 'v0.0.0').lstrip('v')
            current = APP_VERSION
            def _vtuple(v):
                return tuple(int(x) for x in v.split('.') if x.isdigit())
            has_update = _vtuple(latest_tag) > _vtuple(current)
            return {
                "success": True,
                "has_update": has_update,
                "current_version": current,
                "latest_version": latest_tag,
                "release_url": data.get('html_url', '')
            }
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return {"success": False, "error": "No releases found on GitHub."}
            elif exc.code == 403:
                return {"success": False, "error": "GitHub API rate limit exceeded. Try again later."}
            else:
                return {"success": False, "error": f"GitHub API error {exc.code}: {exc.reason}"}
        except urllib.error.URLError as exc:
            return {"success": False, "error": f"Network error: {exc.reason}"}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    def update_configs_from_github(self):
        """Download the latest configs from the GitHub repo."""
        success, result = _download_configs_from_github()
        if success:
            return {"success": True, "message": "Configs updated from GitHub.", "warnings": result}
        else:
            return {"success": False, "error": result}
