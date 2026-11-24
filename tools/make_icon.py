"""Draw the Press Start UA icon: a play triangle and «UA» on a green rounded square.

Only our own shapes and a free font (Russo One, SIL OFL; the licence file lies beside the font).
Writes assets/icon.png (1024), assets/icon.ico (16..256, the Windows build) and docs/icon.png (192, the site).
usage: python3 tools/make_icon.py        (plain python3: Pillow)
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT = os.path.join(ROOT, 'docs', 'fonts', 'RussoOne-Regular.ttf')
LICENCE = os.path.join(ROOT, 'docs', 'fonts', 'RussoOne-OFL.txt')
GREEN, PAPER = (47, 111, 79), (255, 253, 248)
SS = 4  # supersampling


def draw(size=1024):
    if not os.path.exists(LICENCE):
        raise SystemExit(f'no licence beside the font: {LICENCE}')
    k = size * SS / 1024
    s = lambda *v: [round(x * k) for x in v]  # noqa: E731
    im = Image.new('RGBA', (round(1024 * k),) * 2, (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle(s(40, 40, 984, 984), radius=round(190 * k), fill=GREEN)
    # the triangle and the plate form one group, centred in the square: 157 px free above and below.
    # The triangle is centred by its centroid (a third of its width from the flat side), as play icons are.
    d.polygon([tuple(s(402, 197)), tuple(s(402, 557)), tuple(s(732, 377))], fill=PAPER)
    # the «UA» plate
    plate = s(248, 617, 776, 827)
    d.rounded_rectangle(plate, radius=round(56 * k), fill=PAPER)
    f = ImageFont.truetype(FONT, round(196 * k))
    l, t, r, b = d.textbbox((0, 0), 'UA', font=f)
    cx, cy = (plate[0] + plate[2]) / 2, (plate[1] + plate[3]) / 2
    d.text((cx - (l + r) / 2, cy - (t + b) / 2), 'UA', font=f, fill=GREEN)
    return im.resize((size, size), Image.LANCZOS)


def main():
    big = draw(1024)
    big.save(os.path.join(ROOT, 'assets', 'icon.png'), optimize=True)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    draw(256).save(os.path.join(ROOT, 'assets', 'icon.ico'), sizes=[(n, n) for n in sizes])
    draw(192).save(os.path.join(ROOT, 'docs', 'icon.png'), optimize=True)
    print('assets/icon.png, assets/icon.ico, docs/icon.png')


if __name__ == '__main__':
    main()
