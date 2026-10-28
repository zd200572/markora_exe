"""Markora desktop wrapper.

Serves the built frontend from an ephemeral localhost port, then opens it in a
native window (Edge/WebView2 via pywebview). Packaged with PyInstaller.
"""

from __future__ import annotations

import atexit
import json
import os
import socket
import sys
import tempfile
import threading
import http.server
import socketserver
import webview

# Theme colour shared by the app chrome and the splash, so window creation
# does not flash white before the page paints.
BG = "#f7f5f2"
INSTANCE_PORT_FILE = os.path.join(tempfile.gettempdir(), "markora_instance.port")
APPDATA_DIR = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "Markora")
os.makedirs(APPDATA_DIR, exist_ok=True)
DRAFT_FILE = os.path.join(APPDATA_DIR, "draft.json")
WEBVIEW_STORAGE_DIR = os.path.join(APPDATA_DIR, "webview")
APP_PORT = 18742


def _read_file_text(path: str) -> str | None:
    encodings = ("utf-8-sig", "utf-8", "gb18030", "gbk", "utf-16", "latin-1")
    for enc in encodings:
        try:
            with open(path, "r", encoding=enc) as f:
                return f.read()
        except (UnicodeDecodeError, LookupError):
            continue
        except Exception:
            return None
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except Exception:
        return None


def resolve_dist() -> str:
    """Locate the bundled `dist` directory (PyInstaller one-file, one-dir or source)."""
    if getattr(sys, "frozen", False):
        base = getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    dist = os.path.join(base, "dist")
    if not os.path.isdir(dist):
        raise SystemExit(f"dist not found: {dist}")
    return dist


class Handler(http.server.SimpleHTTPRequestHandler):
    directory = ""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=self.directory, **kwargs)

    def log_message(self, fmt, *args):  # keep the console quiet
        return

    def end_headers(self):
        # Local-only asset server: never let a proxy cache stale bundles.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def startup_document_path(argv: list[str]) -> str | None:
    """First existing file passed on the command line (e.g. via Windows "Open with")."""
    for arg in argv:
        if not arg or arg.startswith("-"):
            continue
        candidate = arg.strip().strip('"').strip("'")
        if candidate and os.path.isfile(candidate):
            return os.path.abspath(candidate)
    return None


def try_send_to_running_instance(file_path: str | None) -> bool:
    """If another Markora instance is running, notify it to open file_path (or focus) and return True."""
    if not os.path.isfile(INSTANCE_PORT_FILE):
        return False
    try:
        with open(INSTANCE_PORT_FILE, "r", encoding="ascii") as f:
            port = int(f.read().strip())
    except Exception:
        return False

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.8)
            s.connect(("127.0.0.1", port))
            msg = json.dumps({"action": "open", "path": file_path}) + "\n"
            s.sendall(msg.encode("utf-8"))
            resp = s.recv(1024)
            if resp.strip() == b"OK":
                return True
    except Exception:
        try:
            os.remove(INSTANCE_PORT_FILE)
        except Exception:
            pass
        return False
    return False


def start_ipc_server(on_open_file) -> int:
    """Start local socket server to listen for commands from second instances."""
    ipc_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    ipc_sock.bind(("127.0.0.1", 0))
    ipc_sock.listen(5)
    port = ipc_sock.getsockname()[1]

    def loop():
        while True:
            try:
                conn, _ = ipc_sock.accept()
                with conn:
                    conn.settimeout(2.0)
                    data = b""
                    while not data.endswith(b"\n") and len(data) < 65536:
                        chunk = conn.recv(1024)
                        if not chunk:
                            break
                        data += chunk
                    if data:
                        req = json.loads(data.decode("utf-8").strip())
                        if req.get("action") == "open":
                            conn.sendall(b"OK\n")
                            on_open_file(req.get("path"))
            except Exception:
                continue

    threading.Thread(target=loop, daemon=True).start()
    return port


def serve(dist: str) -> tuple[socketserver.TCPServer, int]:
    handler = type("BoundHandler", (Handler,), {"directory": dist})
    socketserver.TCPServer.allow_reuse_address = True
    try:
        port = APP_PORT
        httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    except OSError:
        port = free_port()
        httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


class DesktopAPI:
    """Exposed to JavaScript as window.pywebview.api."""

    def __init__(self):
        self._window = None
        self._pending_document: str | None = None

    def _get_window(self):
        return self._window or webview.active_window()

    def save_draft(self, data):
        temp_path = None
        try:
            draft = json.loads(data) if isinstance(data, str) else data
            if not isinstance(draft, dict):
                return False
            os.makedirs(APPDATA_DIR, exist_ok=True)
            fd, temp_path = tempfile.mkstemp(prefix="draft-", suffix=".tmp", dir=APPDATA_DIR)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(draft, f, ensure_ascii=False)
            os.replace(temp_path, DRAFT_FILE)
            return True
        except Exception:
            if temp_path and os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except Exception:
                    pass
            return False

    def load_draft(self):
        if not os.path.exists(DRAFT_FILE):
            return None
        try:
            with open(DRAFT_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            try:
                os.replace(DRAFT_FILE, DRAFT_FILE + ".bad")
            except Exception:
                pass
            return None

    def clear_draft(self):
        try:
            if os.path.exists(DRAFT_FILE):
                os.remove(DRAFT_FILE)
            return True
        except Exception:
            return False

    def export_html_file(self, suggested_name: str, contents: str):
        try:
            if not suggested_name.lower().endswith(".html") and not suggested_name.lower().endswith(".htm"):
                suggested_name += ".html"
            file_types = ("HTML Files (*.html;*.htm)", "All Files (*.*)")
            win = self._get_window()
            res = win.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=suggested_name,
                file_types=file_types,
            )
            if not res:
                return None
            path = res if isinstance(res, str) else res[0]
            with open(path, "w", encoding="utf-8") as f:
                f.write(contents)
            return os.path.basename(path)
        except Exception as e:
            return f"error: {e}"

    def open_export_in_browser(self, title: str, contents: str):
        try:
            safe_title = "".join(c for c in title if c.isalnum() or c in (" ", "-", "_")).strip() or "export"
            temp_path = os.path.join(tempfile.gettempdir(), f"markora_{safe_title}.html")
            with open(temp_path, "w", encoding="utf-8") as f:
                f.write(contents)
            os.startfile(temp_path)
            return True
        except Exception as e:
            return f"error: {e}"

    def open_markdown(self):
        try:
            win = self._get_window()
            res = win.create_file_dialog(
                webview.OPEN_DIALOG,
                file_types=("Markdown Files (*.md;*.markdown;*.txt)", "All Files (*.*)"),
            )
            if not res:
                return None
            path = res if isinstance(res, str) else res[0]
            contents = _read_file_text(path)
            if contents is None:
                return None
            title = os.path.splitext(os.path.basename(path))[0]
            return {"path": path, "title": title, "contents": contents}
        except Exception:
            return None

    def take_startup_document(self):
        """Document requested on the command line, consumed on first read."""
        path = self._pending_document
        self._pending_document = None
        if not path:
            return None
        contents = _read_file_text(path)
        if contents is None:
            return None
        title = os.path.splitext(os.path.basename(path))[0]
        return {"path": path, "title": title, "contents": contents}

    def read_markdown_file(self, path: str):
        """Contents of the given file, or None if it cannot be read."""
        return _read_file_text(path)

    def save_markdown(self, path: str | None, suggested_name: str, contents: str):
        try:
            if not path:
                if not suggested_name.lower().endswith(".md"):
                    suggested_name += ".md"
                win = self._get_window()
                res = win.create_file_dialog(
                    webview.SAVE_DIALOG,
                    save_filename=suggested_name,
                    file_types=("Markdown Files (*.md;*.markdown;*.txt)", "All Files (*.*)"),
                )
                if not res:
                    return None
                path = res if isinstance(res, str) else res[0]
            with open(path, "w", encoding="utf-8") as f:
                f.write(contents)
            return path
        except Exception as e:
            return None


def main() -> int:
    if "--disable-gpu" in sys.argv:
        current_args = os.environ.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "")
        if "--disable-gpu" not in current_args:
            os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = (current_args + " --disable-gpu").strip()

    target_file = startup_document_path(sys.argv[1:])

    # If an instance is already running, pass the file to it and exit immediately
    if try_send_to_running_instance(target_file):
        return 0

    dist = resolve_dist()
    _httpd, port = serve(dist)
    url = f"http://127.0.0.1:{port}/index.html?mode=desktop"

    api = DesktopAPI()
    api._pending_document = target_file

    def handle_external_open(path: str | None):
        try:
            if api._window:
                api._window.restore()
                api._window.show()
        except Exception:
            pass
        if not path or not os.path.isfile(path):
            return
        contents = _read_file_text(path)
        if contents is None:
            return
        title = os.path.splitext(os.path.basename(path))[0]
        doc = {"path": path, "title": title, "contents": contents}
        try:
            if api._window:
                js = f"window.__markoraOpenFile && window.__markoraOpenFile({json.dumps(doc)});"
                api._window.evaluate_js(js)
        except Exception:
            pass

    ipc_port = start_ipc_server(handle_external_open)
    try:
        with open(INSTANCE_PORT_FILE, "w", encoding="ascii") as f:
            f.write(str(ipc_port))
    except Exception:
        pass

    def cleanup():
        try:
            if os.path.isfile(INSTANCE_PORT_FILE):
                os.remove(INSTANCE_PORT_FILE)
        except Exception:
            pass

    atexit.register(cleanup)

    window = webview.create_window(
        "Markora",
        url,
        js_api=api,
        width=1220,
        height=820,
        min_size=(760, 560),
        resizable=True,
        background_color=BG,
        text_select=True,
        zoomable=True,
    )
    api._window = window

    def on_closing():
        try:
            s = window.evaluate_js("window.__getDraft && window.__getDraft()")
            if s:
                api.save_draft(s)
        except Exception:
            pass

    window.events.closing += on_closing
    os.makedirs(WEBVIEW_STORAGE_DIR, exist_ok=True)
    webview.start(debug=False, private_mode=False, storage_path=WEBVIEW_STORAGE_DIR)
    cleanup()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
