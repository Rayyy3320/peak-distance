# -*- coding: utf-8 -*-
"""由现有品牌素材生成派生资源；原图（peak-mark / paper-tile）保留不动。

- peak-mark-crop.png  山形可见部分贴边裁剪：peak-mark.png 四周有大量透明留白与
  淡晕影，界面用 object-fit:contain 展示该副本即可任意尺寸完整居中。
- peak-icon.png       扩展图标：米白纸纹底 + 墨灰山形 + 轻边框圆角，
  manifest 16/32/48/128 共用。

用法：python tools/make-brand-assets.py
"""
from PIL import Image, ImageDraw

CANVAS = 512          # 图标工作分辨率，最后缩到 256
OUTPUT = 256          # manifest 最大声明尺寸 128，留 2x 余量
MARK_RATIO = 0.66     # 山形宽度占图标画布比例
RADIUS_RATIO = 0.18   # 图标圆角比例
BORDER_W = 4          # 512 画布上的描边宽（输出后约 2px）
BORDER_COLOR = (221, 217, 207, 255)  # 分隔线 #DDD9CF
CROP_PAD = 6          # 山形裁剪在 alpha>16 边界外留的余量，避免切出硬边

root = 'public/brand'

# ---- 山形裁剪副本 -------------------------------------------------------------
mark = Image.open(f'{root}/peak-mark.png').convert('RGBA')
bbox = mark.getchannel('A').point(lambda v: 255 if v > 16 else 0).getbbox()
box = (
    max(bbox[0] - CROP_PAD, 0),
    max(bbox[1] - CROP_PAD, 0),
    min(bbox[2] + CROP_PAD, mark.width),
    min(bbox[3] + CROP_PAD, mark.height),
)
crop = mark.crop(box)
crop.save(f'{root}/peak-mark-crop.png', optimize=True)
print(f'peak-mark-crop.png {crop.size} bbox={box}')

# ---- 扩展图标 -----------------------------------------------------------------
paper = Image.open(f'{root}/paper-tile.png').convert('RGB')
paper = paper.resize((CANVAS, CANVAS), Image.LANCZOS)

w, h = mark.size
mark_w = round(CANVAS * MARK_RATIO)
mark_scaled = mark.resize((mark_w, round(h * mark_w / w)), Image.LANCZOS)
paper.paste(mark_scaled, ((CANVAS - mark_scaled.width) // 2, (CANVAS - mark_scaled.height) // 2), mark_scaled)

# 4x 超采样画圆角蒙版，避免锯齿
ss = CANVAS * 4
mask = Image.new('L', (ss, ss), 0)
ImageDraw.Draw(mask).rounded_rectangle(
    (0, 0, ss - 1, ss - 1), radius=round(ss * RADIUS_RATIO), fill=255)
mask = mask.resize((CANVAS, CANVAS), Image.LANCZOS)

icon = paper.convert('RGBA')
icon.putalpha(mask)

outline = Image.new('RGBA', (ss, ss), (0, 0, 0, 0))
ImageDraw.Draw(outline).rounded_rectangle(
    (BORDER_W * 2, BORDER_W * 2, ss - 1 - BORDER_W * 2, ss - 1 - BORDER_W * 2),
    radius=round(ss * RADIUS_RATIO) - BORDER_W * 2,
    outline=BORDER_COLOR, width=BORDER_W * 2)
icon.alpha_composite(outline.resize((CANVAS, CANVAS), Image.LANCZOS))

icon = icon.resize((OUTPUT, OUTPUT), Image.LANCZOS)
icon.save(f'{root}/peak-icon.png', optimize=True)
print(f'peak-icon.png {icon.size}')

# 图标可视性预览：深色工具栏 / 浅色工具栏 / chrome://extensions 灰底 × 16/32/64px
tile = OUTPUT // 2
preview = Image.new('RGB', (tile * 6, tile * 3), (255, 255, 255))
for row, bg in enumerate([(32, 33, 36), (248, 249, 250), (222, 225, 230)]):
    for col, size in enumerate([16, 32, 64]):
        patch = Image.new('RGB', (tile, tile), bg)
        small = icon.resize((size, size), Image.LANCZOS)
        patch.paste(small, ((tile - size) // 2, (tile - size) // 2), small)
        preview.paste(patch, (col * tile, row * tile))
preview.save('assets/peak-icon-preview.png')
print('preview saved')
