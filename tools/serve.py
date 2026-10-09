#!/usr/bin/env python3
"""Dev server for the browser build. Threads need cross-origin isolation (COOP/COEP).
Usage: serve.py [port] [--pages] [--verbose]"""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WWW = os.path.join(ROOT, "web/bin/Release/net10.0/publish/wwwroot")
GAMEFILES = os.path.join(ROOT, "gamefiles")


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".json": "application/json",
    }

    def translate_path(self, path):
        path = super().translate_path(path)
        rel = os.path.relpath(path, os.getcwd())
        if rel == "gamefiles" or rel.startswith("gamefiles" + os.sep):
            return os.path.join(GAMEFILES, rel[len("gamefiles") + 1:])
        return os.path.join(WWW, rel)

    def end_headers(self):
        # --pages: behave like GitHub Pages (no COOP/COEP; coi-serviceworker.js has to add them).
        if "--pages" not in sys.argv:
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        if not self.path.startswith("/gamefiles/") or self.path.endswith("manifest.json"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "--verbose" in sys.argv:
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(next((a for a in sys.argv[1:] if a.isdigit()), 8080))
    print(f"Serving TowerFall on http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
