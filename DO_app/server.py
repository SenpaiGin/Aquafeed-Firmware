"""Serve the DO monitor on localhost (required secure context for Web Bluetooth)."""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os


ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    address = ("127.0.0.1", 8765)
    print(f"DO monitor available at http://{address[0]}:{address[1]}")
    print("Open in a Web Bluetooth capable browser such as Chrome or Edge.")
    ThreadingHTTPServer(address, Handler).serve_forever()
