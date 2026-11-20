"""Make a catalog cover from our own Ukrainian logo: a gradient card with the logo, no Nintendo art.

usage: python3 -I tools/make_cover.py LOGO.png OUT.png --colors '#1d5a2c' '#0b2414' [--label 'WII']

The cover is 480x640 (3:4, like a game case). The label at the bottom is drawn with Nunito
(SIL OFL, fonts/), as every text in our releases uses free fonts only.
"""
import argparse, os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NUNITO = os.path.join(HERE, 'fonts', 'Nunito-VariableFont_wght.ttf')
W, H = 480, 640


def rgb(s):
    s = s.lstrip('#')
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


def main():
    p = argparse.ArgumentParser()
    p.add_argument('logo')
    p.add_argument('out')
    p.add_argument('--colors', nargs=2, required=True, help='top and bottom colour')
    p.add_argument('--label', default='WII · УКРАЇНСЬКОЮ')
    a = p.parse_args()
    top, bottom = rgb(a.colors[0]), rgb(a.colors[1])

    img = Image.new('RGB', (W, H))
    px = img.load()
    for y in range(H):
        t = y / (H - 1)
        c = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(W):
            px[x, y] = c
    # soft light behind the logo
    glow = Image.new('L', (W, H), 0)
    ImageDraw.Draw(glow).ellipse((-60, 90, W + 60, 470), fill=90)
    glow = glow.filter(ImageFilter.GaussianBlur(70))
    img = Image.composite(Image.new('RGB', (W, H), (255, 255, 255)), img, glow)

    logo = Image.open(a.logo).convert('RGBA')
    bbox = logo.getbbox()
    logo = logo.crop(bbox)
    scale = min((W * 0.86) / logo.width, 300 / logo.height)
    logo = logo.resize((round(logo.width * scale), round(logo.height * scale)), Image.LANCZOS)
    shadow = Image.new('RGBA', logo.size, (0, 0, 0, 0))
    shadow.putalpha(logo.getchannel('A').point(lambda v: v * 0.45))
    shadow = shadow.filter(ImageFilter.GaussianBlur(10))
    x, y = (W - logo.width) // 2, 280 - logo.height // 2
    img.paste(shadow, (x, y + 10), shadow)
    img.paste(logo, (x, y), logo)

    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(NUNITO, 26)
    try:
        font.set_variation_by_axes([900])
    except Exception:
        pass
    tw = d.textlength(a.label, font=font)
    pad, bh = 22, 50
    bx, by = (W - tw) / 2 - pad, H - 92
    d.rounded_rectangle((bx, by, bx + tw + 2 * pad, by + bh), radius=bh // 2, fill=(255, 255, 255))
    d.text((W / 2, by + bh / 2), a.label, font=font, fill=bottom, anchor='mm')
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    img.save(a.out, optimize=True)
    print(a.out, os.path.getsize(a.out), 'bytes')


if __name__ == '__main__':
    main()
