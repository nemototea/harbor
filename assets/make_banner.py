#!/usr/bin/env python3
"""Harbor banner — 'Tidal Cartography'. 1280x640, rendered at 3x then downsampled."""
from PIL import Image, ImageDraw, ImageFont
import math

FONTS = "/Users/nemototaku/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/5d0f5528-8977-42eb-86a1-4325c5de52fe/8e80fd31-2321-4158-81fc-26d1147b5d31/skills/canvas-design/canvas-fonts"

S = 3
W, H = 1280 * S, 640 * S

# palette (from sidepanel.css :root)
BG       = (13, 17, 23)
BG_GRID  = (22, 27, 34)
GRID_MAJ = (28, 35, 45)
LINE     = (35, 43, 54)
LINE_SFT = (27, 33, 42)
INK      = (230, 237, 243)
INK_DIM  = (139, 152, 168)
INK_FAINT= (91, 102, 117)
ANCHOR   = (245, 183, 64)
ANCHOR_D = (200, 144, 42)
LIVE     = (77, 214, 200)
LIVE_D   = (47, 169, 156)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img, "RGBA")

def f(name, size):
    return ImageFont.truetype(f"{FONTS}/{name}", size * S)

def tracked(draw, xy, text, font, fill, tracking=0, anchor_left=True, mid_y=False):
    """Draw text with letter spacing. xy is top-left (or baseline-ish)."""
    x, y = xy
    if mid_y:
        asc, desc = font.getmetrics()
        y = y - (asc) // 2
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        w = draw.textlength(ch, font=font)
        x += w + tracking
    return x

def tracked_width(draw, text, font, tracking=0):
    x = 0
    for ch in text:
        x += draw.textlength(ch, font=font) + tracking
    return x - tracking if text else 0

# ---------------------------------------------------------------- engineering grid
step = 22 * S
for gx in range(0, W, step):
    d.line([(gx, 0), (gx, H)], fill=BG_GRID, width=1)
for gy in range(0, H, step):
    d.line([(0, gy), (W, gy)], fill=BG_GRID, width=1)
# major grid every ~5 cells
maj = step * 5
for gx in range(0, W, maj):
    d.line([(gx, 0), (gx, H)], fill=GRID_MAJ, width=1)
for gy in range(0, H, maj):
    d.line([(0, gy), (W, gy)], fill=GRID_MAJ, width=1)

# ---------------------------------------------------------------- chart frame + corner ticks
m = 46 * S
d.rectangle([m, m, W - m, H - m], outline=LINE, width=max(1, S))
tick = 14 * S
for (cx, cy) in [(m, m), (W - m, m), (m, H - m), (W - m, H - m)]:
    pass
# corner crosshair ticks (cartographic registration marks)
def crosshair(cx, cy, col=INK_FAINT):
    d.line([(cx - tick, cy), (cx + tick, cy)], fill=col, width=max(1, S))
    d.line([(cx, cy - tick), (cx, cy + tick)], fill=col, width=max(1, S))
for (cx, cy) in [(m, m), (W - m, m), (m, H - m), (W - m, H - m)]:
    crosshair(cx, cy)

# margin ruler ticks along top inner edge
mono_tiny = f("IBMPlexMono-Regular.ttf", 9)
ruler_y = m
rx0, rx1 = m, W - m
nticks = 24
for i in range(nticks + 1):
    tx = rx0 + (rx1 - rx0) * i / nticks
    th = 9 * S if i % 4 == 0 else 5 * S
    d.line([(tx, m), (tx, m + th)], fill=LINE, width=1)

# ======================================================================= LEFT BLOCK
LX = 84 * S

# kicker
mono_kick = f("IBMPlexMono-Regular.ttf", 12)
ky = 150 * S
# small anchor mark before kicker
d.ellipse([LX, ky + 2*S, LX + 9*S, ky + 11*S], fill=ANCHOR)
tracked(d, (LX + 20*S, ky), "ANCHOR-BASED  WORKSPACE", mono_kick, INK_DIM, tracking=3*S)

# wordmark HARBOR
word_font = f("Jura-Medium.ttf", 116)
wy = 184 * S
end_x = tracked(d, (LX, wy), "HARBOR", word_font, INK, tracking=14*S)
wm_width = end_x - LX - 14*S

# accent rule under wordmark: amber segment + teal segment
ry = 330 * S
seg = wm_width
amber_len = seg * 0.34
d.line([(LX, ry), (LX + amber_len, ry)], fill=ANCHOR, width=3*S)
d.line([(LX + amber_len + 10*S, ry), (LX + seg, ry)], fill=LIVE_D, width=3*S)

# tagline (mono, two lines)
mono_tag = f("IBMPlexMono-Regular.ttf", 13)
ty = 360 * S
tracked(d, (LX, ty), "Durable returns, plotted as anchors.", mono_tag, INK_DIM, tracking=1*S)
tracked(d, (LX, ty + 26*S), "Stop using tabs as storage.", mono_tag, INK_FAINT, tracking=1*S)

# legend
mono_leg = f("IBMPlexMono-Regular.ttf", 11)
ly = 430 * S
# anchored
d.ellipse([LX, ly, LX + 11*S, ly + 11*S], fill=ANCHOR)
lx2 = tracked(d, (LX + 22*S, ly - 1*S), "ANCHORED", mono_leg, INK, tracking=2*S)
tracked(d, (LX + 22*S, ly + 16*S), "durable / warm", mono_leg, INK_FAINT, tracking=1*S)
# live
LX2 = LX + 188*S
d.ellipse([LX2, ly, LX2 + 11*S, ly + 11*S], fill=LIVE)
tracked(d, (LX2 + 22*S, ly - 1*S), "LIVE", mono_leg, INK, tracking=2*S)
tracked(d, (LX2 + 22*S, ly + 16*S), "transient / cool", mono_leg, INK_FAINT, tracking=1*S)

# ======================================================================= RIGHT BLOCK: the chart
# dot grid
gx0 = 770 * S
gy0 = 150 * S
cols, rows = 9, 7
gap = 42 * S
r_dim = 4 * S

# precompute node centers
nodes = {}
for ri in range(rows):
    for ci in range(cols):
        nx = gx0 + ci * gap
        ny = gy0 + ri * gap
        nodes[(ci, ri)] = (nx, ny)

# anchors (amber) and the single live node (teal), echoing the app icon's spirit
anchor_cells = {(1, 1), (4, 0), (6, 2), (2, 4), (7, 5), (3, 6)}
live_cell = (5, 3)

# teal current: a flowing polyline threading through the field (drawn behind dots)
current = [(0, 2), (2, 2), (3, 3), (5, 3), (6, 4), (8, 4)]
cur_pts = [nodes[c] for c in current]
# smooth-ish: draw as connected segments with soft underglow
for w, a in [(7*S, 26), (4*S, 60), (2*S, 150)]:
    d.line([(x, y) for (x, y) in cur_pts], fill=LIVE + (a,), width=w, joint="curve")

# faint connecting hairlines from each anchor toward grid (chart "soundings")
for c in anchor_cells:
    cx, cy = nodes[c]
    d.line([(cx, gy0 - 18*S), (cx, cy)], fill=LINE_SFT, width=1)

# draw dim dots
for (ci, ri), (nx, ny) in nodes.items():
    if (ci, ri) in anchor_cells or (ci, ri) == live_cell:
        continue
    d.ellipse([nx - r_dim, ny - r_dim, nx + r_dim, ny + r_dim], fill=(43, 52, 64))

# draw anchors (amber, with subtle ring)
r_a = 8 * S
for c in anchor_cells:
    nx, ny = nodes[c]
    d.ellipse([nx - r_a - 5*S, ny - r_a - 5*S, nx + r_a + 5*S, ny + r_a + 5*S],
              outline=ANCHOR_D + (90,), width=max(1, S))
    d.ellipse([nx - r_a, ny - r_a, nx + r_a, ny + r_a], fill=ANCHOR)

# the live node (teal, halo)
nx, ny = nodes[live_cell]
for rr, a in [(16*S, 30), (11*S, 70)]:
    d.ellipse([nx - rr, ny - rr, nx + rr, ny + rr], fill=LIVE + (a,))
d.ellipse([nx - 8*S, ny - 8*S, nx + 8*S, ny + 8*S], fill=LIVE)

# column / row coordinate labels (instrument legend) along chart edges
coord_font = f("IBMPlexMono-Regular.ttf", 9)
for ci in range(cols):
    nx, _ = nodes[(ci, 0)]
    lbl = f"{ci+1:02d}"
    w = tracked_width(d, lbl, coord_font, 0)
    d.text((nx - w/2, gy0 - 34*S), lbl, font=coord_font, fill=INK_FAINT)
for ri in range(rows):
    _, ny = nodes[(0, ri)]
    lbl = chr(ord('A') + ri)
    d.text((gx0 - 30*S, ny - 6*S), lbl, font=coord_font, fill=INK_FAINT)

# ---------------------------------------------------------------- corner stamps (mono)
stamp = f("IBMPlexMono-Regular.ttf", 11)
# top-left inside frame
tracked(d, (m + 16*S, m + 14*S), "HARBOR · v0.1.0", stamp, INK_FAINT, tracking=1*S)
# top-right
s2 = "CHROME SIDE PANEL"
w2 = tracked_width(d, s2, stamp, 2*S)
tracked(d, (W - m - 16*S - w2, m + 14*S), s2, stamp, INK_FAINT, tracking=2*S)
# bottom-left
tracked(d, (m + 16*S, H - m - 26*S), "TIDAL CARTOGRAPHY", stamp, INK_FAINT, tracking=2*S)
# bottom-right
s3 = "FIG.01 — ANCHOR GRID"
w3 = tracked_width(d, s3, stamp, 1*S)
tracked(d, (W - m - 16*S - w3, H - m - 26*S), s3, stamp, INK_FAINT, tracking=1*S)

# ---------------------------------------------------------------- downsample & save
out = img.resize((1280, 640), Image.LANCZOS)
out.save("/Users/nemototaku/nemotea/harbor/assets/banner.png")
print("saved banner.png", out.size)
