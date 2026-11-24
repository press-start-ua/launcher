"""Add a translation patch to the catalog (catalog/catalog.json + catalog/patches/).

Takes a patch made by a game's own make_patch.py (the older per-game format: one line of
magic, u32 header length, JSON header, LZMA deltas) and stores it in the shared format
with the Riivolution settings in its header. The deltas are copied untouched, so the patched
files are byte-identical to the game's own patcher.

usage: python3 -I tools/import_patch.py OLD.patch --id nsmbw --title "..." --riiv-root NSMBW_UA
           [--region Європа] [--note "Rev 2"] [--date 2026-11-17] [--change "..."]... [--status beta|done]
           [--riiv-section "..."] [--riiv-skip files/opening.bnr]
"""
import argparse, datetime, json, lzma, os, struct, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from uapatch.core import read_patch, sha256_file, write_patch  # noqa: E402

CATALOG = os.path.join(ROOT, 'catalog', 'catalog.json')


def read_old(path):
    b = open(path, 'rb').read()
    p = b.index(b'\n') + 1
    n = struct.unpack('>I', b[p:p + 4])[0]
    return json.loads(b[p + 4:p + 4 + n].decode('utf-8')), lzma.decompress(b[p + 4 + n:])


def main():
    a = argparse.ArgumentParser()
    a.add_argument('old')
    a.add_argument('--id', required=True)
    a.add_argument('--title')
    a.add_argument('--platform', default='Wii')
    a.add_argument('--region', default='')
    a.add_argument('--note', default='')
    a.add_argument('--date', default=datetime.date.today().isoformat())
    a.add_argument('--status', choices=('beta', 'done'), help='badge on the cover: БЕТА or ЗАВЕРШЕНО')
    a.add_argument('--change', action='append', default=[])
    a.add_argument('--riiv-root', required=True)
    a.add_argument('--riiv-section')
    a.add_argument('--riiv-skip', action='append', default=['files/opening.bnr'])
    o = a.parse_args()
    head, blob = read_old(o.old)
    title = o.title or head['title']
    head.update(title=title, date=o.date,
                riivolution=dict(root=o.riiv_root, section=o.riiv_section or title, skip=sorted(set(o.riiv_skip))))
    rel = f'patches/{o.id}_{head["game"]}_{head["version"]}.uapatch'
    out = os.path.join(ROOT, 'catalog', *rel.split('/'))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    write_patch(out, head, blob)
    assert read_patch(out)[1] == blob
    cat = json.load(open(CATALOG, encoding='utf-8')) if os.path.exists(CATALOG) else dict(format=1, games=[])
    game = next((g for g in cat['games'] if g['id'] == o.id), None)
    if game is None:
        game = dict(id=o.id, title=title, platform=o.platform, discs=[])
        cat['games'].append(game)
    if game.get('version') != head['version']:
        if game.get('version'):  # the site shows earlier versions under «Історія версій»
            game.setdefault('history', []).insert(0, dict(
                version=game['version'], date=game.get('date', ''), changes=game.get('changes', [])))
        game['changes'] = []
    game.update(title=title, version=head['version'], date=o.date)
    if o.status:
        game['status'] = o.status
    game['changes'] = o.change or game.get('changes', [])
    disc = dict(game=head['game'], region=o.region, note=o.note, patch=rel,
                sha256=sha256_file(out), size=os.path.getsize(out))
    game['discs'] = [d for d in game['discs'] if d['game'] != head['game']] + [disc]
    cat['updated'] = datetime.date.today().isoformat()
    with open(CATALOG, 'w', encoding='utf-8') as f:
        json.dump(cat, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(f'{out}: {len(head["files"])} files, {disc["size"]} bytes')


if __name__ == '__main__':
    main()
