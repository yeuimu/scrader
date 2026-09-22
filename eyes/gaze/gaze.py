"""gaze.py — 截图 → YOLO+OCR → 归一化元素列表 (standalone, adapted from enikk ui_parser, MIT).

Usage:
  python gaze.py <screenshot.png> [--out elements.json] [--som som.png] [--max-dim 1366]

Output JSON:
{
  "image": {"width": W, "height": H},
  "elements": [
    {"id": 1, "kind": "text"|"icon", "text": "...", "label": "...",
     "bbox_norm": [x1,y1,x2,y2],          # [0,1000] normalized
     "center_norm": [cx,cy],              # [0,1000]
     "bbox_px": [x1,y1,x2,y2],            # pixels in the input screenshot space (cua click space)
     "center_px": [cx,cy]}
  ]
}
"""
import argparse
import json
import logging
import os
import sys
import time

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ui_parser import UIParser  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("image", help="screenshot PNG path")
    ap.add_argument("--out", default=None, help="output JSON path (default: <image>.elements.json)")
    ap.add_argument("--som", default=None, help="annotated SoM image output path")
    ap.add_argument("--max-dim", type=int, default=1366)
    ap.add_argument("--weights", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "weights"))
    args = ap.parse_args()

    img = cv2.imdecode(np.fromfile(args.image, dtype=np.uint8), cv2.IMREAD_COLOR)  # unicode-safe imread
    if img is None:
        print(json.dumps({"error": f"cannot read image: {args.image}"}))
        sys.exit(2)
    h, w = img.shape[:2]

    parser = UIParser(weights_dir=args.weights, screenshot_max_dim=args.max_dim, use_dml=False)
    t0 = time.time()
    merged = parser.parse(img)
    dt = (time.time() - t0) * 1000

    elements = []
    for i, item in enumerate(merged, 1):
        x1, y1, x2, y2 = item["bbox"]
        cx, cy = item["center"]
        kind = "text" if "text" in item and item.get("text") else "icon"
        elements.append({
            "id": i,
            "kind": kind,
            "text": item.get("text") or item.get("label", ""),
            "bbox_norm": [x1, y1, x2, y2],
            "center_norm": [cx, cy],
            "bbox_px": [round(x1 / 1000 * w), round(y1 / 1000 * h), round(x2 / 1000 * w), round(y2 / 1000 * h)],
            "center_px": [round(cx / 1000 * w), round(cy / 1000 * h)],
        })

    result = {"image": {"width": w, "height": h, "path": args.image}, "parse_ms": round(dt), "elements": elements}
    out = args.out or args.image + ".elements.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)

    if args.som:
        som = img.copy()
        for el in elements:
            x1, y1, x2, y2 = el["bbox_px"]
            color = (0, 180, 255) if el["kind"] == "text" else (255, 120, 0)
            cv2.rectangle(som, (x1, y1), (x2, y2), color, 2)
            cv2.putText(som, str(el["id"]), (x1, max(12, y1 - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA)
            cx, cy = el["center_px"]
            cv2.drawMarker(som, (cx, cy), (0, 0, 255), cv2.MARKER_CROSS, 10, 2)
        cv2.imwrite(args.som, som)

    # console digest
    texts = sum(1 for e in elements if e["kind"] == "text")
    print(json.dumps({"out": out, "som": args.som, "parse_ms": round(dt),
                      "total": len(elements), "text": texts, "icon": len(elements) - texts}, ensure_ascii=False))


if __name__ == "__main__":
    main()
