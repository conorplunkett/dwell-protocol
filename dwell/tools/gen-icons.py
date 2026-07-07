#!/usr/bin/env python3
"""Generate the DWELL app/extension icons — the eight-dot clock-sweep mark —
for every surface, from a single definition. No third-party deps: it drives a
local Chromium and writes PNGs by hand.

The mark is the same eight-dot ring as the site .logo chip and favicon
(web/assets/logo.svg): a solid accent red dot at 12 o'clock fading clockwise
through opacity, on a white chip. The dot color is read straight from the
design-system source of truth, `theme.css` (--accent), so the icon can never
drift from the palette.

Writes (overwrites) every committed app icon:
  chrome-extension/icons/icon16.png, icon48.png, icon128.png
  desktop/macos/SponsorOverlay/packaging/assets/AppIcon-1024.png

Run:  make icons   (or:  python3 tools/gen-icons.py)
Set DWELL_CHROME to point at a Chrome/Chromium binary if autodetection fails.
"""
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Layout — the mark is the eight-dot ring used by the site logo (.logo) and the
# favicon: dots swept clockwise from solid at 12 o'clock through fading opacity.
RADIUS_RATIO = 0.26   # matches the site logo chip (8/30) and favicon (rx 17/64)
DOT_ORBIT_RATIO = 0.325   # orbit radius / icon size (65/200 in the source SVG)
DOT_RATIO = 0.075         # dot radius / icon size (15/200 in the source SVG)
DOT_OPACITIES = [1, .08, .22, .38, .55, .72, .88, .95]  # clockwise from 12 o'clock
PAD = 40  # transparent margin so the mark never touches the (height-capped) window

TARGETS = [
    ("chrome-extension/icons/icon16.png", 16),
    ("chrome-extension/icons/icon48.png", 48),
    ("chrome-extension/icons/icon128.png", 128),
    ("desktop/macos/SponsorOverlay/packaging/assets/AppIcon-1024.png", 1024),
]


def read_accent():
    """Pull --accent from theme.css (the palette source of truth)."""
    css = open(os.path.join(ROOT, "web", "theme.css")).read()
    m = re.search(r"--accent:\s*(#[0-9a-fA-F]{6})", css)
    return m.group(1) if m else "#ff0000"


def find_chrome():
    for c in [os.environ.get("DWELL_CHROME"),
              "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"]:
        if c and os.path.exists(c):
            return c
    for name in ("google-chrome", "google-chrome-stable", "chromium",
                 "chromium-browser", "chrome"):
        p = shutil.which(name)
        if p:
            return p
    sys.exit("No Chrome/Chromium found. Set DWELL_CHROME=/path/to/chrome.")


def icon_html(size, accent):
    r = round(size * RADIUS_RATIO)
    cx = cy = size / 2
    orbit = size * DOT_ORBIT_RATIO
    dot_r = size * DOT_RATIO
    dots = ""
    for i, opacity in enumerate(DOT_OPACITIES):
        theta = math.radians(i * 45)
        x = cx + orbit * math.sin(theta)
        y = cy - orbit * math.cos(theta)
        dots += f"<circle cx='{x:.2f}' cy='{y:.2f}' r='{dot_r:.2f}' fill='{accent}' fill-opacity='{opacity}'/>"
    return (
        "<!doctype html><html><head><meta charset=utf-8>"
        "<style>html,body{margin:0;padding:0;background:transparent}"
        f"svg{{position:absolute;left:{PAD}px;top:{PAD}px}}</style></head><body>"
        f"<svg width={size} height={size} viewBox='0 0 {size} {size}' xmlns='http://www.w3.org/2000/svg'>"
        f"<rect width='{size}' height='{size}' rx='{r}' fill='#ffffff'/>"
        f"{dots}</svg></body></html>"
    )


# --- minimal PNG read (RGBA) / write ---------------------------------------
def _unfilter(raw, W, H):
    stride = W * 4
    prev = bytes(stride)
    pos = 0
    rows = []
    for _ in range(H):
        f = raw[pos]; pos += 1
        line = bytearray(raw[pos:pos + stride]); pos += stride
        if f == 1:
            for x in range(4, stride):
                line[x] = (line[x] + line[x - 4]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x - 4] if x >= 4 else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x - 4] if x >= 4 else 0
                b = prev[x]; c = prev[x - 4] if x >= 4 else 0
                p = a + b - c; pa = abs(p - a); pb = abs(p - b); pc = abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        prev = bytes(line); rows.append(line)
    return rows


def read_rgba(path):
    d = open(path, "rb").read()
    i = 8; W = H = ct = 0; idat = b""
    while i < len(d):
        ln = struct.unpack(">I", d[i:i + 4])[0]; t = d[i + 4:i + 8]
        if t == b"IHDR":
            W, H, _bd, ct = struct.unpack(">IIBB", d[i + 8:i + 18])
        elif t == b"IDAT":
            idat += d[i + 8:i + 8 + ln]
        elif t == b"IEND":
            break
        i += 12 + ln
    assert ct == 6, "expected RGBA screenshot"
    return W, H, _unfilter(zlib.decompress(idat), W, H)


def write_rgba(path, W, H, rows):
    raw = bytearray()
    for r in rows:
        raw.append(0); raw += r

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + chunk(b"IEND", b""))
    open(path, "wb").write(png)


def render(chrome, out_path, size, accent):
    win_w = size + 2 * PAD
    win_h = (size + 2 * PAD) * 2  # height is capped by headless; give it room
    with tempfile.TemporaryDirectory() as tmp:
        html = os.path.join(tmp, "m.html")
        shot = os.path.join(tmp, "m.png")
        open(html, "w").write(icon_html(size, accent))
        subprocess.run(
            [chrome, "--headless", "--no-sandbox", "--disable-gpu",
             "--hide-scrollbars", "--force-device-scale-factor=1",
             "--virtual-time-budget=4000",
             f"--window-size={win_w},{win_h}",
             "--default-background-color=00000000",
             f"--screenshot={shot}", "file://" + html],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        _W, _H, rows = read_rgba(shot)
        crop = []
        for y in range(PAD, PAD + size):
            src = rows[y]
            crop.append(src[PAD * 4:(PAD + size) * 4])
        write_rgba(os.path.join(ROOT, out_path), size, size, crop)
        print(f"  {out_path}  ({size}x{size})")


def main():
    chrome = find_chrome()
    accent = read_accent()
    print(f"eight-dot mark  accent {accent}  via {chrome}")
    for path, size in TARGETS:
        render(chrome, path, size, accent)
    print("done")


if __name__ == "__main__":
    main()
