"""gaze_server.py — 常驻解析服务：UIParser 只加载一次，HTTP 收截图返回归一化元素列表。

Usage:
  python gaze_server.py [--port 8765] [--max-dim 1366] [--weights <dir>]

  curl -s --data-binary @shot.png "http://127.0.0.1:8765/parse"            -> JSON (server default max_dim)
  curl -s --data-binary @shot.png "http://127.0.0.1:8765/parse?max_dim=1024"
  curl -s "http://127.0.0.1:8765/health"                                    -> {"ok":true,...}

输出 JSON 与 gaze.py 相同：{image:{width,height}, parse_ms, elements:[{id,kind,text,
bbox_norm,center_norm,bbox_px,center_px}]}。坐标空间与请求图片一致（cua click 空间）。
单线程锁串行解析（onnxruntime session 并发跑两个 parse 不保证安全，单 Agent 场景够用）。
"""
import argparse
import json
import logging
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ui_parser import UIParser  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("gaze_server")

STATE = {"parser": None, "default_max_dim": 1366, "started": time.time(), "parses": 0}
PARSE_LOCK = threading.Lock()


def parse_bytes(img_bytes: bytes, max_dim: int) -> dict:
    img = cv2.imdecode(np.frombuffer(img_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("cannot decode image bytes")
    h, w = img.shape[:2]
    parser = STATE["parser"]
    t0 = time.time()
    with PARSE_LOCK:
        merged = parser.parse(img)
        STATE["parses"] += 1
    dt = (time.time() - t0) * 1000

    elements = []
    for i, item in enumerate(merged, 1):
        x1, y1, x2, y2 = item["bbox"]
        cx, cy = item["center"]
        kind = "text" if item.get("text") else "icon"
        elements.append({
            "id": i,
            "kind": kind,
            "text": item.get("text") or item.get("label", ""),
            "bbox_norm": [x1, y1, x2, y2],
            "center_norm": [cx, cy],
            "bbox_px": [round(x1 / 1000 * w), round(y1 / 1000 * h), round(x2 / 1000 * w), round(y2 / 1000 * h)],
            "center_px": [round(cx / 1000 * w), round(cy / 1000 * h)],
        })
    return {"image": {"width": w, "height": h, "max_dim": max_dim}, "parse_ms": round(dt), "elements": elements}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path.startswith("/health"):
            self._send(200, {"ok": True, "uptime_s": round(time.time() - STATE["started"]),
                             "parses": STATE["parses"], "default_max_dim": STATE["default_max_dim"]})
        else:
            self._send(404, {"error": "GET /health or POST /parse"})

    def do_POST(self) -> None:
        u = urlparse(self.path)
        if u.path != "/parse":
            self._send(404, {"error": "POST /parse"})
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            img_bytes = self.rfile.read(n)
            q = parse_qs(u.query)
            max_dim = int(q.get("max_dim", [STATE["default_max_dim"]])[0])
            self._send(200, parse_bytes(img_bytes, max_dim))
        except Exception as e:  # noqa: BLE001
            self._send(400, {"error": str(e)})

    def log_message(self, fmt, *args) -> None:  # 静默逐请求日志，解析耗时在响应里自带
        pass


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--max-dim", type=int, default=1366)
    ap.add_argument("--weights", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "weights"))
    args = ap.parse_args()

    t0 = time.time()
    STATE["parser"] = UIParser(weights_dir=args.weights, screenshot_max_dim=args.max_dim, use_dml=False)
    STATE["default_max_dim"] = args.max_dim
    log.info("models loaded in %.1fs, listening on 127.0.0.1:%d", time.time() - t0, args.port)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
