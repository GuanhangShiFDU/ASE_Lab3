"""Render both Lab3 PNGs in the docs directory.

Requires Pillow and a Chinese TrueType font. Set LAB3_DIAGRAM_FONT to the
font path when the default macOS Hiragino Sans GB font is unavailable.
Run: python3 docs/diagrams/render.py
"""
import math
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

DOCS = Path(__file__).resolve().parent.parent
FONT = os.environ.get("LAB3_DIAGRAM_FONT", "/System/Library/Fonts/Hiragino Sans GB.ttc")
BG, INK, MUTED, BORDER = "#eef4f3", "#132e2d", "#415c5b", "#c9dad7"
GREEN, BLUE, GOLD = "#13635c", "#2c5074", "#985322"
WHITE = "#ffffff"

def font(size):
    return ImageFont.truetype(FONT, size)

def txt(x, y, value, size=27, color=INK):
    draw.text((x, y), value, font=font(size), fill=color, anchor="lt")

def box(bounds, fill=WHITE, edge=BORDER, radius=18):
    draw.rounded_rectangle(bounds, radius, fill=fill, outline=edge, width=2)

def arrow(points, color=GREEN, width=4):
    draw.line(points, fill=color, width=width, joint="curve")
    x, y = points[-1]
    a, b = points[-2]
    angle = math.atan2(y - b, x - a)
    draw.polygon([(x, y), (x - 13 * math.cos(angle - .48), y - 13 * math.sin(angle - .48)),
                  (x - 13 * math.cos(angle + .48), y - 13 * math.sin(angle + .48))], fill=color)

def page(title, subtitle, height):
    img = Image.new("RGB", (1680, height), BG)
    global draw
    draw = ImageDraw.Draw(img)
    draw.rectangle((0, 0, 1680, 142), fill="#102f2d")
    txt(56, 35, title, 52, WHITE)
    txt(59, 105, subtitle, 22, "#b5dfd5")
    return img

img = page("上海叫车台 · Lab 3 架构", "两个用户角色 / 四个独立业务服务 / Docker Compose", 1110)
box((56, 172, 475, 274))
txt(78, 189, "乘客与司机浏览器", 30)
txt(78, 232, "界面操作、短轮询与 Leaflet", 22, MUTED)
box((624, 172, 1242, 274))
txt(650, 189, "Frontend · Nginx", 30)
txt(650, 232, "静态页面与公开 API 转发", 22, MUTED)
arrow([(475, 225), (624, 225)], BLUE)
txt(510, 195, "HTTP", 21, BLUE)
txt(1270, 197, "浏览器按需请求", 22, MUTED)
txt(1270, 233, "OSM 瓦片，失败用格网", 22, MUTED)

# One gateway fan-out for public HTTP paths.
draw.line([(933, 274), (933, 311), (238, 311)], fill=BLUE, width=4)
draw.line([(933, 311), (1438, 311)], fill=BLUE, width=4)
services = [
    ("Order", "估价、写入与状态裁决", "lab3_order", "订单 / 幂等 / 待办"),
    ("Driver", "身份、在线与司机占用", "lab3_driver", "身份 / 占用 / 释放记录"),
    ("Dispatch", "候选、邀约与确认", "lab3_dispatch", "匹配 / 邀约 / 截止时间"),
    ("Order Query", "读模型与司机资料组合", "lab3_order_query", "收件箱 / 订单读副本"),
]
box((44, 510, 1636, 663), "#e0eeeb", "#c8dcd7")
txt(60, 525, "MySQL 8.4 · 四个库、四个应用账号", 25, GREEN)
for i, (name, role, schema, records) in enumerate(services):
    x = 56 + i * 400
    cx = x + 182
    arrow([(cx, 311), (cx, 350)], BLUE)
    box((x, 350, x+364, 478))
    txt(x+20, 374, name, 34)
    txt(x+20, 428, role, 23, MUTED)
    arrow([(cx, 478), (cx, 514)], GREEN)
    box((x, 565, x+364, 646), "#f9fcfb", BORDER, 12)
    txt(x+15, 579, schema, 23, GREEN)
    txt(x+15, 610, records, 21, MUTED)

txt(56, 698, "服务间协作", 33)
txt(1180, 707, "蓝：同步 API   棕：后台投递", 22, MUTED)
links = [
    ("Dispatch → Order", "发现匹配订单，确认接单或标记失败", BLUE),
    ("Dispatch → Driver", "获取候选、预留占用、失败补偿", BLUE),
    ("Order → Driver", "取消或完单后的按订单释放", GOLD),
    ("Order → Order Query", "Outbox → HTTP → Inbox → 版本投影", GOLD),
    ("Order Query → Driver", "读取司机姓名，与本地快照组合", BLUE),
]
for i, (title, detail, color) in enumerate(links):
    x = 56 + i % 2 * 800
    y = 748 + i // 2 * 101
    box((x, y, x+768, y+89))
    txt(x+16, y+12, title, 25, color)
    txt(x+16, y+48, detail, 22, MUTED)
img.save(DOCS / "architecture.png", optimize=True)

img = page("Lab 3 数据模型与归属", "跨库仅传递标识与事件。所有表的 SQL 访问均限定在所属服务的库。", 1130)
modules = [
    (56, 174, "Order · lab3_order", [
        ("orders", "PK id · snapshot(JSON) · 两个唯一有效占用键"),
        ("order_requests", "PK (actor_role, actor_id, request_key) · 结果快照"),
        ("order_outbox", "PK sequence · UK event_id 和 (order_id, order_version)"),
        ("order_driver_releases", "PK order_id · driver_id · completed_at"),
        ("order_background_retries", "PK (task_type, task_id) · 次数、时间、错误"),
    ]),
    (856, 174, "Driver · lab3_driver", [
        ("demo_accounts", "PK id · role · display_name"),
        ("driver_state", "PK/FK driver_id · online · UK order_id"),
        ("driver_order_releases", "PK (driver_id, order_id) · FK driver_id"),
    ]),
    (56, 645, "Dispatch · lab3_dispatch", [
        ("dispatch_matches", "PK order_id · deadline · phase"),
        ("dispatch_offers", "PK id · FK order_id · driver_id · expires_at · status"),
        ("唯一规则", "每单每司机一个邀约；active_order 限一个未完成邀约"),
    ]),
    (856, 645, "Order Query · lab3_order_query", [
        ("order_event_inbox", "PK sequence · UK event_id · payload · processed_at"),
        ("order_read_model", "PK order_id · order_version · passenger_id · driver_id"),
        ("查询副本", "status · updated_ms · snapshot，由订单事件更新"),
    ]),
]
for x, y, title, rows in modules:
    box((x, y, x+768, y+(432 if y < 300 else 290)))
    txt(x+20, y+20, title, 31, GREEN)
    for i, (label, detail) in enumerate(rows):
        cy = y + 66 + i * 69
        txt(x+22, cy, label, 23)
        txt(x+22, cy+29, detail, 20, MUTED)
box((56, 978, 1624, 1082), "#dfede9", "#c4d9d5")
txt(77, 999, "跨服务引用：order_id → Order 的订单；driver_id / passenger_id → Driver 的身份。", 24)
txt(77, 1038, "PK 主键  /  UK 唯一约束  /  FK 仅库内外键。Order Query 接收带版本的订单快照。", 22, MUTED)
img.save(DOCS / "data-model.png", optimize=True)
