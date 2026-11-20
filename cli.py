"""Command-line front end of Press Start UA Launcher (the window comes later; this is for testing).

usage: python3 -I cli.py list [--catalog SRC]
       python3 -I cli.py patch IMAGE [-f iso|wbfs|riivolution] [-o OUT] [--force] [--catalog SRC]
SRC is a catalog.json path or https URL; by default the local catalog/catalog.json.
"""
import argparse, os, sys
sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from uapatch import PatchError, read_patch  # noqa: E402
from uapatch.apply import default_output, disc_id, patch_image, patch_riivolution  # noqa: E402
from uapatch.catalog import Catalog  # noqa: E402

DEFAULT = os.path.join(HERE, 'catalog', 'catalog.json')


def main():
    for s in (sys.stdout, sys.stderr):
        if hasattr(s, 'reconfigure'):
            s.reconfigure(encoding='utf-8', errors='replace')
    p = argparse.ArgumentParser(description='Українські переклади ігор Wii')
    p.add_argument('--catalog', default=DEFAULT)
    sub = p.add_subparsers(dest='cmd', required=True)
    sub.add_parser('list')
    pp = sub.add_parser('patch')
    pp.add_argument('image')
    pp.add_argument('-f', '--format', default='iso', choices=('iso', 'wbfs', 'riivolution'))
    pp.add_argument('-o', '--output')
    pp.add_argument('--force', action='store_true')
    a = p.parse_args()
    cat = Catalog(a.catalog)
    if a.cmd == 'list':
        print(f'Каталог від {cat.updated}')
        for g in cat.games:
            discs = ', '.join(f'{d["game"]} ({d["region"]}{", " + d["note"] if d.get("note") else ""})'
                              for d in g['discs'])
            print(f'- {g["title"]}: версія {g["version"]} від {g["date"]}; диски: {discs}')
            for c in g.get('changes', []):
                print(f'    • {c}')
        return
    gid = disc_id(a.image)
    game, disc = cat.find_disc(gid) if gid else (None, None)
    if not disc:
        raise PatchError(f'Для цього образу ({gid or "невідомий диск"}) перекладу в каталозі немає.')
    print(f'{game["title"]}, диск {gid}: переклад версії {game["version"]}')
    path = cat.fetch_patch(disc)
    head, blob = read_patch(path)
    out = a.output or default_output(a.image, a.format)
    if a.format == 'riivolution':
        patch_riivolution(head, blob, a.image, out, a.force, log=print)
    else:
        patch_image(head, blob, a.image, out, a.format, a.force, log=print)


if __name__ == '__main__':
    try:
        main()
    except PatchError as e:
        print('ПОМИЛКА: ' + str(e))
        sys.exit(1)
