#!/usr/bin/env python3
# Harbor promo frame generator.
# Recreates the Liquid Harbour side panel (real sidepanel.css tokens + logo.svg)
# and animates a short product tour, then rasterizes each frame to PNG.
# ffmpeg stitches the PNGs into demo.mp4 + demo.gif.
#
# Requirements: a Japanese gothic font (e.g. IPAPGothic / fonts-ipafont-gothic),
#   pip install cairosvg pillow   ·   ffmpeg on PATH (or npm i ffmpeg-static)
#
# Reproduce:
#   python3 make_promo.py                       # -> ./frames/f0000.png ...
#   # MP4 (1280x720, h264) for SNS / Chrome Web Store:
#   ffmpeg -y -framerate 24 -i frames/f%04d.png \
#     -vf "scale=1280:720:flags=lanczos,format=yuv420p" \
#     -c:v libx264 -profile:v high -crf 20 -pix_fmt yuv420p -movflags +faststart demo.mp4
#   # GIF (palette, ~5MB) for the README:
#   ffmpeg -y -framerate 24 -i frames/f%04d.png \
#     -vf "fps=14,scale=680:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff" palette.png
#   ffmpeg -y -framerate 24 -i frames/f%04d.png -i palette.png \
#     -lavfi "fps=14,scale=680:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" demo.gif

import math, os, html, cairosvg

# ---- canvas ----
W, H = 1280, 720
FPS = 24
OUT = os.path.join(os.path.dirname(__file__), "frames")
os.makedirs(OUT, exist_ok=True)

# ---- brand tokens (from sidepanel.css :root) ----
BG0, BG1, BG2 = "#081019", "#0b1a25", "#0e2733"
ANCHOR, ANCHOR2 = "#ffc24d", "#ffd98a"
LIVE, LIVE2 = "#54e6d6", "#8af3e8"
INK, INK_DIM, INK_FAINT = "#eaf2f6", "#a6b7c2", "#6a7c87"

# cairosvg uses cairo's "toy" text API with NO per-glyph fallback, so the
# primary family must itself contain the Japanese glyphs. IPAPGothic carries
# both Latin and JP; all non-ASCII symbols are drawn as paths instead.
SANS = "IPAPGothic"
MONO = "IPAGothic"

# favicon brand map (mirrors assets/preview.html)
BRAND = {
    "github.com": ("#3a3f46", "#24292e", "G"),
    "mail.google.com": ("#ea4335", "#c5221f", "M"),
    "calendar.google.com": ("#4285f4", "#1a73e8", "C"),
    "aws": ("#ff9900", "#ec7211", "a"),
    "gcloud": ("#4285f4", "#1a73e8", "G"),
    "cloudflare": ("#f6821f", "#faad3f", "C"),
    "datadog": ("#774aa4", "#632ca6", "D"),
    "grafana": ("#f46800", "#e87a00", "G"),
    "docs": ("#3a3f46", "#24292e", "G"),
    "jira": ("#2684ff", "#0052cc", "J"),
    "stack": ("#f7a04c", "#f48024", "S"),
    "mdn": ("#4d4dff", "#1b1b1b", "M"),
    "figma": ("#a259ff", "#f24e1e", "F"),
}

# ---- easing helpers ----
def clamp(v, a=0.0, b=1.0): return max(a, min(b, v))
def lerp(a, b, t): return a + (b - a) * t
def smooth(t): t = clamp(t); return t * t * (3 - 2 * t)
def ease_out(t): t = clamp(t); return 1 - (1 - t) ** 3
def ease_in_out(t): t = clamp(t); return 4*t*t*t if t < .5 else 1-((-2*t+2)**3)/2
def seg(t, a, b): return clamp((t - a) / (b - a)) if b > a else (1.0 if t >= b else 0.0)

# ---- svg primitives ----
def esc(s): return html.escape(str(s), quote=True)

def rrect(x, y, w, h, r, fill, opacity=1.0, stroke=None, sw=1.0, sop=1.0, filt=None):
    f = f' filter="url(#{filt})"' if filt else ""
    s = f' stroke="{stroke}" stroke-width="{sw}" stroke-opacity="{sop}"' if stroke else ""
    return (f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" rx="{r:.2f}" '
            f'fill="{fill}" fill-opacity="{opacity:.3f}"{s}{f}/>')

def text(x, y, s, size, fill=INK, op=1.0, weight=400, anchor="start", font=SANS, ls=None, op_attr=True):
    lsa = f' letter-spacing="{ls}"' if ls is not None else ""
    return (f'<text x="{x:.1f}" y="{y:.1f}" font-family="{font}" font-size="{size}" '
            f'font-weight="{weight}" fill="{fill}" fill-opacity="{op:.3f}" '
            f'text-anchor="{anchor}"{lsa}>{esc(s)}</text>')

def fav(x, y, size, key, op=1.0):
    c1, c2, ltr = BRAND[key]
    gid = f"fav{key}"
    r = size * 0.24
    return (f'<g opacity="{op:.3f}">'
            f'<defs><linearGradient id="{gid}" x1="0" y1="0" x2="1" y2="1">'
            f'<stop offset="0" stop-color="{c1}"/><stop offset="1" stop-color="{c2}"/></linearGradient></defs>'
            f'{rrect(x, y, size, size, r, f"url(#{gid})")}'
            f'{text(x+size/2, y+size*0.70, ltr, size*0.58, fill="#fff", op=0.96, weight=700, anchor="middle")}'
            f'</g>')

# ---- drawn glyph icons (cairo toy text has no symbol fallback) ----
def tri(cx, cy, s, color, op=1.0):
    # small downward disclosure triangle
    return (f'<path d="M{cx-s:.1f} {cy-s*0.6:.1f} L{cx+s:.1f} {cy-s*0.6:.1f} '
            f'L{cx:.1f} {cy+s*0.7:.1f} Z" fill="{color}" fill-opacity="{op:.3f}"/>')

def icon_anchor(cx, cy, s, color, op=1.0):
    # minimalist anchor mark, ~s tall
    u = s / 14.0
    return (f'<g transform="translate({cx:.1f},{cy:.1f}) scale({u:.3f})" '
            f'stroke="{color}" stroke-opacity="{op:.3f}" stroke-width="1.7" '
            f'fill="none" stroke-linecap="round" stroke-linejoin="round">'
            '<circle cx="0" cy="-6" r="2.2"/><line x1="0" y1="-3.8" x2="0" y2="6"/>'
            '<line x1="-3.4" y1="-1.6" x2="3.4" y2="-1.6"/>'
            '<path d="M-5 2 C -5 6, -2.4 7.2, 0 7.2 C 2.4 7.2, 5 6, 5 2"/></g>')

def icon_split(cx, cy, s, color, op=1.0):
    # split-view glyph: rounded rect with a centre divider
    h = s; w = s * 1.15
    return (f'<g stroke="{color}" stroke-opacity="{op:.3f}" stroke-width="1.4" fill="none">'
            f'<rect x="{cx-w/2:.1f}" y="{cy-h/2:.1f}" width="{w:.1f}" height="{h:.1f}" rx="2.2"/>'
            f'<line x1="{cx:.1f}" y1="{cy-h/2:.1f}" x2="{cx:.1f}" y2="{cy+h/2:.1f}"/></g>')

# ---- the anchor logo (from assets/logo.svg), placeable/scalable ----
def logo(cx, cy, scale, op=1.0):
    s = scale / 128.0
    return (f'<g transform="translate({cx-64*s:.2f},{cy-64*s:.2f}) scale({s:.4f})" opacity="{op:.3f}">'
            '<circle cx="64" cy="64" r="60" fill="url(#amberL)"/>'
            '<circle cx="64" cy="64" r="60" fill="url(#sheenL)"/>'
            '<circle cx="64" cy="64" r="59" fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="1.5"/>'
            '<g fill="none" stroke="#23160a" stroke-width="9" stroke-linecap="round" stroke-linejoin="round">'
            '<circle cx="64" cy="33" r="9.5"/><line x1="64" y1="42.5" x2="64" y2="99"/>'
            '<line x1="41" y1="53" x2="87" y2="53"/>'
            '<path d="M28 69 C 28 92, 44 101, 64 101 C 84 101, 100 92, 100 69"/></g>'
            '<g fill="#23160a"><path d="M28 71 L15 62 L34 55 Z"/><path d="M100 71 L113 62 L94 55 Z"/></g>'
            '<circle cx="64" cy="101" r="5.5" fill="#23160a"/></g>')

# ---- panel geometry ----
PX, PY, PW, PH, PR = 802.0, 34.0, 400.0, 652.0, 22.0

def defs():
    return ('<defs>'
            f'<linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">'
            f'<stop offset="0" stop-color="{BG2}"/><stop offset="0.5" stop-color="{BG1}"/>'
            f'<stop offset="1" stop-color="{BG0}"/></linearGradient>'
            '<radialGradient id="glowA" cx="0.5" cy="0.5" r="0.5">'
            f'<stop offset="0" stop-color="{ANCHOR}" stop-opacity="0.55"/>'
            f'<stop offset="1" stop-color="{ANCHOR}" stop-opacity="0"/></radialGradient>'
            '<radialGradient id="glowT" cx="0.5" cy="0.5" r="0.5">'
            f'<stop offset="0" stop-color="{LIVE}" stop-opacity="0.5"/>'
            f'<stop offset="1" stop-color="{LIVE}" stop-opacity="0"/></radialGradient>'
            '<linearGradient id="glass" x1="0" y1="0" x2="0" y2="1">'
            '<stop offset="0" stop-color="#ffffff" stop-opacity="0.10"/>'
            '<stop offset="1" stop-color="#ffffff" stop-opacity="0.03"/></linearGradient>'
            '<linearGradient id="amberL" x1="0" y1="0" x2="1" y2="1">'
            '<stop offset="0" stop-color="#ffe0a3"/><stop offset=".5" stop-color="#ffc24d"/>'
            '<stop offset="1" stop-color="#f5a623"/></linearGradient>'
            '<radialGradient id="sheenL" cx="0.34" cy="0.26" r="0.8">'
            '<stop offset="0" stop-color="#ffffff" stop-opacity="0.55"/>'
            '<stop offset="0.45" stop-color="#ffffff" stop-opacity="0"/></radialGradient>'
            '<linearGradient id="shine" x1="0" y1="0" x2="1" y2="0">'
            '<stop offset="0" stop-color="#fff" stop-opacity="0"/>'
            '<stop offset="0.5" stop-color="#fff" stop-opacity="0.16"/>'
            '<stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>'
            '<filter id="soft" x="-40%" y="-40%" width="180%" height="180%">'
            '<feGaussianBlur stdDeviation="18"/></filter>'
            '<filter id="softer" x="-60%" y="-60%" width="220%" height="220%">'
            '<feGaussianBlur stdDeviation="40"/></filter>'
            f'<clipPath id="panelClip"><rect x="{PX:.1f}" y="{PY:.1f}" width="{PW:.1f}" height="{PH:.1f}" rx="{PR:.1f}"/></clipPath>'
            '</defs>')

# background with drifting harbour-night glows
def background(t):
    ax = 360 + 60*math.sin(t*0.5)
    ay = 230 + 40*math.cos(t*0.4)
    tx = 980 + 70*math.cos(t*0.45+1)
    ty = 560 + 50*math.sin(t*0.5+2)
    return (rrect(0, 0, W, H, 0, "url(#bg)") +
            f'<circle cx="{ax:.0f}" cy="{ay:.0f}" r="360" fill="url(#glowA)" filter="url(#softer)"/>' +
            f'<circle cx="{tx:.0f}" cy="{ty:.0f}" r="320" fill="url(#glowT)" filter="url(#softer)"/>')

# ---- panel content blocks ----
def tag(x, y, label, color):
    w = 9 + len(label)*8.0
    return (rrect(x, y-13, w, 19, 6, color, 0.16, stroke=color, sw=1, sop=0.5) +
            text(x+w/2, y+1.5, label, 10.5, fill=color, weight=700, anchor="middle", ls="1.2"))

def medallion(x, y, key, label, glow=0.0, lit=0.0, sz=66):
    g = ""
    if glow > 0.001:
        g += f'<circle cx="{x+sz/2:.1f}" cy="{y+sz/2:.1f}" r="{sz*0.9:.1f}" fill="url(#glowA)" opacity="{glow:.3f}" filter="url(#soft)"/>'
    ring = ""
    if lit > 0.001:
        ring = rrect(x-3, y-3, sz+6, sz+6, 17, "none", stroke=ANCHOR, sw=2, sop=lit)
    tile = rrect(x, y, sz, sz, 15, "url(#glass)", 1.0, stroke="#ffffff", sw=1, sop=0.18)
    spec = rrect(x+1, y+1, sz-2, sz*0.42, 13, "#ffffff", 0.06)
    f = fav(x+sz/2-15, y+13, 30, key)
    lab = text(x+sz/2, y+sz+15, label, 10.5, fill=INK_DIM, anchor="middle")
    return g + ring + tile + spec + f + lab

def pin(x, y, key):
    sz = 26
    return (rrect(x, y, sz, sz, 8, "url(#glass)", 1.0, stroke="#ffffff", sw=1, sop=0.16) +
            fav(x+4, y+4, 18, key))

def livetab(x, y, w, key, title, accent=None, anchored=False, split=False, active=False, op=1.0):
    h = 34
    fillop = 0.10 if active else 0.05
    bar = ""
    if accent:
        bar = rrect(x, y+5, 3, h-10, 1.5, accent, 0.9)
    badge = ""
    bx = x + w - 16
    if anchored:
        badge += icon_anchor(bx, y+h/2, 13, ANCHOR, op=0.9)
        bx -= 18
    if split:
        badge += icon_split(bx, y+h/2, 11, INK_FAINT)
    return (f'<g opacity="{op:.3f}">' +
            rrect(x, y, w, h, 9, "url(#glass)", fillop, stroke="#ffffff", sw=1, sop=0.10 if not active else 0.18) +
            bar +
            fav(x+10, y+8, 18, key) +
            text(x+36, y+h/2+4, title, 12, fill=INK if active else INK_DIM) +
            badge + '</g>')

def panel_chrome(active_space, shine_x=None):
    o = []
    # panel base + shadow + glass
    o.append(rrect(PX, PY+10, PW, PH, PR, "#000000", 0.40, filt="soft"))
    o.append(rrect(PX, PY, PW, PH, PR, "url(#bg)", 0.55))
    o.append(rrect(PX, PY, PW, PH, PR, "url(#glass)", 1.0))
    o.append(rrect(PX+0.5, PY+0.5, PW-1, PH-1, PR-0.5, "none", stroke="#ffffff", sw=1, sop=0.16))
    o.append(rrect(PX+1, PY+1, PW-2, 1.5, 1, "#ffffff", 0.28))  # specular top edge
    # optional shine sweep (clipped)
    if shine_x is not None:
        o.append(f'<g clip-path="url(#panelClip)"><rect x="{shine_x:.1f}" y="{PY:.1f}" '
                 f'width="160" height="{PH:.1f}" fill="url(#shine)" transform="skewX(-12)"/></g>')
    return "".join(o)

def topbar():
    x = PX + 22; y = PY + 22
    o = [logo(x+10, y+10, 30)]
    o.append(text(x+30, y+15, "HARBOR", 15, fill=INK, weight=700, ls="2.5"))
    # tools
    o.append(rrect(PX+PW-150, y-2, 78, 24, 7, "url(#glass)", 1.0, stroke="#ffffff", sw=1, sop=0.12))
    o.append(text(PX+PW-140, y+14, "絞り込み", 10.5, fill=INK_FAINT))
    o.append(rrect(PX+PW-66, y-2, 26, 24, 7, "url(#glass)", 1.0, stroke="#ffffff", sw=1, sop=0.12))
    o.append(icon_split(PX+PW-53, y+10, 11, INK_DIM))
    o.append(rrect(PX+PW-36, y-2, 24, 24, 7, "url(#glass)", 1.0, stroke="#ffffff", sw=1, sop=0.12))
    o.append(text(PX+PW-24, y+15, "編集", 9, fill=INK_DIM, anchor="middle"))
    return "".join(o)

def spaces(active, highlight=0.0):
    x = PX + 22; y = PY + 64
    o = []
    for i, name in enumerate(["クラウド", "開発"]):
        w = 22 + len(name)*13
        on = (i == active)
        col = ANCHOR if on else "#ffffff"
        o.append(rrect(x, y, w, 30, 15, col, 0.18 if on else 0.05,
                       stroke=col, sw=1.2 if on else 1, sop=(0.7 if on else 0.12)))
        if on and highlight > 0:
            o.append(rrect(x, y, w, 30, 15, "none", stroke=ANCHOR, sw=2, sop=highlight))
        o.append(text(x+w/2, y+20, name, 12.5, fill=INK if on else INK_DIM,
                      weight=600 if on else 400, anchor="middle"))
        o.append(text(x+w-12, y+13, str(i+1), 8, fill=col, op=0.6, anchor="middle"))
        x += w + 10
    return "".join(o)

def block_head(y, label, color, title, count, btn):
    x = PX + 22
    o = [tag(x, y, label, color)]
    tw = 9 + len(label)*8.0
    o.append(text(x+tw+10, y+1, title, 12, fill=INK_DIM))
    o.append(text(PX+PW-22, y+1, btn, 10.5, fill=color, op=0.8, anchor="end"))
    return "".join(o), x

# ANCHORED grid for a given space, with optional new tile + drag glow
def anchored(active_space, y0, opacity=1.0, new_tile=0.0, lit_idx=None, lit=0.0):
    o = []
    cnt = "3" if active_space == 0 else "2"
    if active_space == 0 and new_tile > 0.5:
        cnt = "4"
    head, x = block_head(y0, "ANCHORED", ANCHOR,
                         "クラウド" if active_space == 0 else "開発",
                         cnt, "すべて開く")
    o.append(f'<g opacity="{opacity:.3f}">')
    o.append(head)
    gx, gy = PX + 24, y0 + 22
    step = 92
    if active_space == 0:
        items = [("aws", "AWS"), ("gcloud", "GCloud"), ("cloudflare", "CF")]
        for i, (k, lab) in enumerate(items):
            li = lit if (lit_idx == i) else 0.0
            o.append(medallion(gx + i*step, gy, k, lab, lit=li))
        # 4th medallion (slot 3, same row): the dragged-in tab settling into place
        if new_tile > 0.001:
            pop = ease_out(new_tile)
            nx, ny = gx + 3*step, gy
            o.append(f'<g opacity="{pop:.3f}" transform="translate({nx+33},{ny+33}) '
                     f'scale({lerp(0.55,1.0,pop):.3f}) translate(-33,-33)">'
                     + medallion(0, 0, "figma", "Fig", glow=(1-new_tile)*0.7 + 0.25*math.sin(new_tile*math.pi)) +
                     '</g>')
        # section 監視
        sy = gy + 96
        o.append(tri(gx+4, sy-4, 4, INK_FAINT))
        o.append(text(gx+14, sy, "監視", 11, fill=INK_FAINT))
        o.append(medallion(gx, sy+14, "datadog", "Datadog"))
        o.append(medallion(gx+step, sy+14, "grafana", "Grafana"))
    else:
        items = [("docs", "Docs"), ("jira", "Jira")]
        for i, (k, lab) in enumerate(items):
            o.append(medallion(gx + i*step, gy, k, lab))
    o.append('</g>')
    return "".join(o)

def pins_row(y0):
    o = []
    x = PX + 22
    o.append(tag(x, y0, "PINS", ANCHOR2))
    o.append(text(PX+PW-22, y0+1, "3", 10.5, fill=INK_FAINT, anchor="end"))
    px = x
    for k in ["github.com", "mail.google.com", "calendar.google.com"]:
        o.append(pin(px, y0+12, k)); px += 36
    return "".join(o)

def live(y0, drag=None, figma_anchored=False):
    # drag: progress 0..1 lifts the Figma row off; figma_anchored: row regains ⚓ after landing
    o = []
    head, x = block_head(y0, "LIVE", LIVE, "", "7", "片付け")
    o.append(head)
    ly = y0 + 22
    w = PW - 44
    rows = [
        ("github.com", "Harbor ・ GitHub", None, True, False, True),
        ("figma", "Figma ・ Harbor UI", None, figma_anchored, False, False),  # index 1 -> draggable
    ]
    hide_drag = drag is not None and drag >= 0.02
    for i, (k, title, accent, anchored_b, split, active) in enumerate(rows):
        if i == 1 and hide_drag:
            # leave a faint gap where it lifted off
            o.append(rrect(x, ly, w, 34, 9, "#ffffff", 0.02))
            ly += 40
            continue
        o.append(livetab(x, ly, w, k, title, accent, anchored_b, split, active))
        ly += 40
    # group 調査 (blue)
    o.append(rrect(x, ly, w, 24, 8, "#2684ff", 0.14, stroke="#2684ff", sw=1, sop=0.4))
    o.append(tri(x+13, ly+11, 4, "#8ab6ff"))
    o.append(text(x+23, ly+16, "調査", 11, fill="#8ab6ff", weight=600))
    o.append(text(x+w-12, ly+16, "3", 10, fill="#8ab6ff", anchor="end"))
    ly += 30
    for k, title, split in [("stack", "Stack Overflow", True), ("mdn", "MDN ・ Bookmarks", True), ("docs", "chrome.tabGroups", False)]:
        o.append(livetab(x+10, ly, w-10, k, title, "#2684ff", False, split, False))
        ly += 38
    return "".join(o), (x, y0 + 22 + 40, w)  # also return AWS row origin for drag

# ---- left caption column ----
def caption(t, title, sub, appear, color=ANCHOR):
    cx = 86
    cy = 320
    a = ease_out(appear)
    dy = (1 - a) * 18
    o = []
    o.append(rrect(cx, cy-44, 40, 4, 2, color, 0.9*a))
    o.append(text(cx, cy + dy, title, 38, fill=INK, op=a, weight=700))
    for i, line in enumerate(sub):
        o.append(text(cx, cy + 46 + i*30 + dy, line, 17, fill=INK_DIM, op=a*0.95))
    return "".join(o)

# ---- master frame ----
DUR = 13.0

def frame_svg(t):
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">']
    o.append(defs())
    o.append(background(t))

    # ---- scene timing ----
    # S0 intro 0.0-2.2 | S1 panel 2.2-3.6 | S2 spaces 3.6-6.0
    # S3 drag 6.0-9.0 | S4 light 9.0-11.0 | S5 outro 11.0-13.0
    panel_in = ease_out(seg(t, 2.0, 3.4))
    # global fade for clean loop at very end
    loop_fade = 1.0
    if t > DUR - 0.5:
        loop_fade = 1 - smooth(seg(t, DUR-0.5, DUR))

    o.append(f'<g opacity="{loop_fade:.3f}">')

    # intro logo (big -> docks to topbar handled by panel topbar after panel_in)
    if t < 3.4:
        intro = smooth(seg(t, 0.2, 1.2))
        sc = lerp(160, 30, ease_in_out(seg(t, 2.0, 3.4)))
        lx = lerp(W/2, PX+32, ease_in_out(seg(t, 2.0, 3.4)))
        ly = lerp(H/2-40, PY+32, ease_in_out(seg(t, 2.0, 3.4)))
        o.append(logo(lx, ly, sc, op=intro))
        if t < 2.4:
            tfade = smooth(seg(t, 0.7, 1.6)) * (1 - smooth(seg(t, 2.0, 2.5)))
            o.append(text(W/2, H/2+90, "HARBOR", 40, fill=INK, op=tfade, weight=700, anchor="middle", ls="8"))
            o.append(text(W/2, H/2+130, "錨で、タブの海をしずめる。", 18, fill=INK_DIM, op=tfade, anchor="middle", ls="2"))

    # panel + content
    if panel_in > 0.01:
        slide = (1 - panel_in) * 60
        o.append(f'<g transform="translate(0,{slide:.1f})" opacity="{panel_in:.3f}">')

        # ---- space-switch state (クラウド ⇄ 開発 ⇄ クラウド) ----
        def space_state(tt):
            if tt < 4.6: return (0, 0, 1.0)
            if tt < 5.1: return (1, 0, seg(tt, 4.6, 5.1))
            if tt < 5.5: return (1, 1, 1.0)
            if tt < 6.0: return (0, 1, seg(tt, 5.5, 6.0))
            return (0, 0, 1.0)
        active, prev, fade = space_state(t)
        space_hl = 0.0
        for c in (4.15, 4.85, 5.75):
            space_hl = max(space_hl, max(0.0, 1 - abs(t - c) / 0.4))

        # shine sweep right after panel docks
        shine_x = None
        sh = seg(t, 3.2, 4.2)
        if 0 < sh < 1:
            shine_x = lerp(PX-160, PX+PW, sh)

        o.append(panel_chrome(active, shine_x))
        o.append(topbar())
        o.append(spaces(active, space_hl))

        ay = PY + 116
        # S3 drag Figma->grid ; S4 click-to-light an anchor
        drag_p = seg(t, 6.2, 8.2)
        new_tile = ease_out(seg(t, 7.4, 8.6)) if t >= 7.4 else 0.0  # settled 4th medallion
        figma_anchored = t >= 8.4
        lit = 0.0; lit_idx = None
        if t >= 9.2:
            lit = seg(t, 9.3, 9.8) * (1 - seg(t, 10.4, 11.0)); lit_idx = 0

        nt = new_tile if active == 0 else 0.0
        if fade < 1.0:
            o.append(anchored(prev, ay, opacity=1-fade))
            o.append(anchored(active, ay, opacity=fade,
                              new_tile=(new_tile if active == 0 else 0.0)))
        else:
            o.append(anchored(active, ay, new_tile=nt,
                              lit_idx=(lit_idx if active == 0 else None),
                              lit=(lit if active == 0 else 0.0)))

        # PINS + LIVE
        pins_y = ay + 250
        o.append(pins_row(pins_y))
        live_y = pins_y + 54
        dragging = (active == 0 and 0.0 < drag_p < 1.0)
        live_svg, drag_origin = live(live_y,
                                     drag=(drag_p if dragging else None),
                                     figma_anchored=figma_anchored)
        o.append(live_svg)

        # dragged Figma ghost traveling from the LIVE row up into the grid (slot 3)
        if dragging and drag_p > 0.02:
            ax0, ay0, aw = drag_origin
            tgt_x, tgt_y = PX + 24 + 3*92 + 33, ay + 22 + 33
            p = ease_in_out(drag_p)
            cx = lerp(ax0 + 24, tgt_x, p)
            cy = lerp(ay0 + 17, tgt_y, p)
            scale = lerp(1.0, 1.18, math.sin(p*math.pi))
            o.append(f'<g transform="translate({cx:.1f},{cy:.1f}) scale({scale:.3f}) translate(-15,-15)" opacity="0.96">')
            o.append(f'<circle cx="15" cy="15" r="26" fill="url(#glowA)" opacity="{0.55*math.sin(p*math.pi):.3f}" filter="url(#soft)"/>')
            o.append(fav(0, 0, 30, "figma"))
            o.append('</g>')
            o.append(f'<circle cx="{cx+17:.1f}" cy="{cy+17:.1f}" r="4" fill="#fff" opacity="0.85"/>')

        o.append('</g>')  # panel group

    # ---- captions (left column) ----
    if 2.4 < t < 3.8:
        o.append(caption(t, "錨と、流れ。", ["ブックマーク＝戻る場所（Anchor）", "タブ＝いまの流れ（Live）"], seg(t, 2.6, 3.4)))
    elif 4.0 < t < 6.0:
        o.append(caption(t, "スペースで切替", ["作業文脈をフォルダ単位で", "1〜9 キーで瞬時に移動"], seg(t, 4.1, 4.8)))
    elif 6.0 < t < 9.0:
        o.append(caption(t, "ドラッグで係留", ["LIVE タブを ANCHORED へ", "そのままブックマーク化"], seg(t, 6.1, 6.8)))
    elif 9.0 < t < 11.0:
        o.append(caption(t, "クリックで戻る", ["既存タブにフォーカス", "無ければ開く／スナップで戻す"], seg(t, 9.1, 9.8)))
    elif t >= 11.0:
        a = seg(t, 11.1, 11.9)
        cx, cy = 86, 300
        o.append(logo(cx+34, cy-70, lerp(40, 64, ease_out(a)), op=a))
        o.append(text(cx, cy+10, "Harbor", 44, fill=INK, op=a, weight=700))
        o.append(text(cx, cy+44, "Liquid Harbour ・ Chrome 拡張", 17, fill=ANCHOR2, op=a))
        for i, ln in enumerate(["外部通信なし・すべてローカル", "Chrome 標準ブックマークに連動", "GPLv3 / オープンソース"]):
            o.append(text(cx, cy+86+i*28, "・" + ln, 15, fill=INK_DIM, op=seg(t, 11.4+i*0.15, 12.1+i*0.15)))

    o.append('</g>')  # loop_fade
    o.append('</svg>')
    return "".join(o)


def main():
    n = int(DUR * FPS)
    scale = 1.5  # render at 1920x1080 then downscale for crisp AA
    for i in range(n):
        t = i / FPS
        svg = frame_svg(t)
        cairosvg.svg2png(bytestring=svg.encode("utf-8"),
                         write_to=os.path.join(OUT, f"f{i:04d}.png"),
                         output_width=int(W*scale), output_height=int(H*scale))
        if i % 24 == 0:
            print(f"frame {i}/{n}")
    print(f"done {n} frames")


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "test":
        # render a few representative frames only
        for t in [0.8, 3.0, 5.0, 7.2, 9.4, 11.8]:
            svg = frame_svg(t)
            cairosvg.svg2png(bytestring=svg.encode("utf-8"),
                             write_to=os.path.join(OUT, f"test_{t:.1f}.png"),
                             output_width=W*2, output_height=H*2)
            print("wrote test", t)
    else:
        main()
