"""Markora desktop wrapper.

Serves the built frontend from an ephemeral localhost port, then opens it in a
native window (Edge/WebView2 via pywebview). Packaged with PyInstaller.
"""

from __future__ import annotations

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


def serve(dist: str) -> tuple[socketserver.TCPServer, int]:
    port = free_port()
    handler = type("BoundHandler", (Handler,), {"directory": dist})
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


class DesktopAPI:
    """Exposed to JavaScript as window.pywebview.api."""

    def __init__(self):
        self._window = None

    def _get_window(self):
        return self._window or webview.active_window()

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
            with open(path, "r", encoding="utf-8") as f:
                contents = f.read()
            title = os.path.splitext(os.path.basename(path))[0]
            return {"path": path, "title": title, "contents": contents}
        except Exception as e:
            return None

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
    dist = resolve_dist()
    _httpd, port = serve(dist)
    url = f"http://127.0.0.1:{port}/index.html?mode=desktop"

    api = DesktopAPI()
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
    webview.start(debug=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
