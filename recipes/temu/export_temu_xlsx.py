# -*- coding: utf-8 -*-
"""Temu harvest JSON -> 风格化 xlsx（xlsx skill design.md 规范，样式走 templates/base.py）
用法: uv run --with openpyxl python export_temu_xlsx.py <src.json> <out.xlsx> <标题> <来源行>
标题清洗同时兼容两种 anchorText：行式（\n 分隔，视口内渲染卡）与糊串（textContent 回退，离屏卡）
"""
import json
import re
import sys
import os

# 样式基座探测：XLSX_SKILL_DIR 环境变量 → ZCode 插件缓存（本机）→ 无则优雅降级为朴素表格（仍可打开）
_CANDIDATES = [
    os.environ.get("XLSX_SKILL_DIR"),
    os.path.expanduser(r"~/.zcode/cli/plugins/cache/zcode-plugins-official/spreadsheets/0.1.7/skills/xlsx"),
    r"C:\Users\Administrator\.zcode\cli\plugins\cache\zcode-plugins-official\spreadsheets\0.1.7\skills\xlsx",
]
XLSX_SKILL_DIR = next((c for c in _CANDIDATES if c and os.path.isdir(os.path.join(c, "templates"))), None)

if XLSX_SKILL_DIR:
    for sub in [XLSX_SKILL_DIR, os.path.join(XLSX_SKILL_DIR, "templates")]:
        if sub not in sys.path:
            sys.path.insert(0, sub)
    from base import (  # noqa: E402
        FONT_NAME, PRIMARY,
        font_caption, align_number,
        setup_sheet, style_header_row, style_data_row,
        auto_fit_columns, auto_fit_row_heights,
    )
else:  # 朴素降级：无样式基座时输出无样式但合法的 xlsx
    FONT_NAME, PRIMARY = "Calibri", "FF4472C4"
    font_caption = align_number = lambda *a, **k: None  # noqa: E731
    def setup_sheet(ws, title):
        return None
    def style_header_row(*a, **k):
        return None
    def style_data_row(*a, **k):
        return None
    def auto_fit_columns(*a, **k):
        return None
    def auto_fit_row_heights(*a, **k):
        return None
from openpyxl import Workbook  # noqa: E402
from openpyxl.styles import Font  # noqa: E402
from openpyxl.formatting.rule import DataBarRule  # noqa: E402

SRC, OUT, TITLE, SOURCE = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

ZW = re.compile(r"[\u200b-\u200d\u2060\ufeff]")
TAGS = {"从日本发货", "首选好物", "广告", "大码"}


def clean_title(anchor_text):
    """返回 (标签, 标题)。行式：按行拆标签与'在新标签页'尾巴；糊串：剥前缀标签 token + 去嵌入标签"""
    t = ZW.sub("", anchor_text or "").strip()
    lines = [ln.strip() for ln in t.split("\n") if ln.strip()]
    tags, title = [], []
    for ln in lines:
        if ln in TAGS:
            tags.append(ln)
        elif "在新标签页中打开" in ln and len(ln) < 15:
            continue
        else:
            title.append(ln)
    s = " ".join(title)
    if not s:  # 糊串整行被上面误吞时，回退原文按糊串处理
        s = t
    if "\n" not in t or len(title) <= 1:
        # 糊串模式：先采集出现的标签词，再剥前缀 token、去嵌入标签与尾巴
        for w in re.findall(r"从日本发货|首选好物|本地精选", s):
            if w not in tags:
                tags.append(w)
        s = re.sub(r"^(广告|预览|定制|棉|大码|本地精选|从日本发货|首选好物)+", "", s)
        s = re.sub(r"(从日本发货|首选好物|本地精选)", "", s)
        s = s.replace("在新标签页中打开。", "").replace("在新标签页中打开", "")
        s = s.strip(" |")
    return "、".join(tags), s


def parse_sold(v):
    if v is None:
        return None
    s = str(v).replace(",", "").strip()
    m = re.fullmatch(r"([\d.]+)\s*万", s)
    if m:
        return int(float(m.group(1)) * 10000)
    m = re.fullmatch(r"([\d.]+)\s*([KkMm])", s)
    if m:
        return int(float(m.group(1)) * {"k": 1000, "m": 1000000}[m.group(2).lower()])
    if re.fullmatch(r"[\d.]+", s):
        return int(float(s))
    return v


with open(SRC, encoding="utf-8") as f:
    items = json.load(f)["items"]

wb = Workbook()
ws = wb.active
ws.title = "商品数据"

headers = ["#", "标题", "标签", "价格(円)", "原价(円)", "折扣", "已售", "商品ID", "商品链接", "图片"]
last_col = len(headers) + 1

setup_sheet(ws, title=TITLE, last_col=last_col)
ws["B3"] = SOURCE
ws["B3"].font = font_caption()
ws.row_dimensions[3].height = 14

for c, h in enumerate(headers, start=2):
    ws.cell(row=4, column=c, value=h)
style_header_row(ws, row_num=4, col_start=2, col_end=last_col)

link_font = Font(name=FONT_NAME, size=11, color=PRIMARY, underline="single")
for i, it in enumerate(items):
    r = 5 + i
    tags, title = clean_title(it.get("anchorText"))
    price = it.get("price")
    op = it.get("originalPrice")
    discount = round(price / op, 4) if (price and op and op > 0 and price <= op) else None
    row = [i + 1, title or None, tags or None, price, op, discount, parse_sold(it.get("soldCount")),
           it.get("stableId"), "商品页", "查看图"]
    for c, v in enumerate(row, start=2):
        ws.cell(row=r, column=c, value=v)
    style_data_row(ws, row_num=r, col_start=2, col_end=last_col, row_index=i)
    for c, fmt in [(5, "#,##0"), (6, "#,##0"), (8, "#,##0")]:
        cell = ws.cell(row=r, column=c)
        cell.alignment = align_number()
        cell.number_format = fmt
    dcell = ws.cell(row=r, column=7)
    dcell.alignment = align_number()
    dcell.number_format = "0.0%"
    for c, url in [(10, it.get("href")), (11, it.get("image"))]:
        cell = ws.cell(row=r, column=c)
        if url:
            cell.hyperlink = url
            cell.font = link_font

n = len(items)
ws.conditional_formatting.add(f"E5:E{4 + n}",
                              DataBarRule(start_type="min", end_type="max", color=PRIMARY, showValue=True))
ws.freeze_panes = "A5"
ws.auto_filter.ref = f"B4:K{4 + n}"
auto_fit_columns(ws, min_width=8, max_width=42, header_row=4, data_start_row=5)
auto_fit_row_heights(ws, header_row=4, data_start_row=5)

wb.properties.creator = "Z.ai"
wb.save(OUT)

# 语义自检：行数 / 价格总和 / 空标题数
from openpyxl import load_workbook  # noqa: E402
ws2 = load_workbook(OUT).active
rows = ws2.max_row - 4
assert rows == len(items), f"行数 {rows} != {len(items)}"
price_sum = sum(ws2.cell(row=r, column=5).value or 0 for r in range(5, 5 + n))
src_sum = sum(it["price"] for it in items)
assert price_sum == src_sum, f"价格和不一致 {price_sum} vs {src_sum}"
empty_titles = sum(1 for r in range(5, 5 + n) if not (ws2.cell(row=r, column=3).value or "").strip())
print(f"OK {OUT} rows={rows} price_sum={price_sum} 空标题={empty_titles}")
