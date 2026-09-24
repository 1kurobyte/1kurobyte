#!/usr/bin/env python3
"""Serves a web build locally with the headers WebAssembly threads need.

SharedArrayBuffer (used by pthreads) is only available on cross-origin
isolated pages, i.e. when served with COOP/COEP. Static hosts that cannot set
headers (GitHub Pages, ...) get the same effect from coi-serviceworker.js.

    python3 serve.py [port] [directory]
"""
import http.server
import os
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".wasm": "application/wasm", ".mjs": "text/javascript"}

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.chdir(sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.abspath(__file__)))
    print(f"Serving {os.getcwd()} on http://localhost:{port}/")
    http.server.ThreadingHTTPServer(("", port), Handler).serve_forever()
