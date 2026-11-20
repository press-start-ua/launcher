"""The catalog: which games are translated, their latest version and where their patches are.

catalog.json (format 1):
{
  "format": 1,
  "updated": "2026-11-18",
  "games": [
    {
      "id": "nsmbw",                       short name, stable across versions
      "title": "New Super Mario Bros. Wii",
      "platform": "Wii",
      "version": "0.9",
      "date": "2026-11-17",
      "changes": ["...", "..."],           what is new in this version, newest first
      "cover": "covers/nsmbw.png",         optional, relative to the catalog
      "status": "beta",                    optional badge: "wip" (У РОБОТІ), "beta" (БЕТА), "done" (ЗАВЕРШЕНО)
      "contact": "https://...",            optional, overrides the catalog-wide "contact" link
      "gametdb": "SMNP01",                 optional: whose box art to show (default: the first disc)
      "discs": [
        {"game": "SMNP01", "region": "Європа", "note": "Rev 2",
         "patch": "patches/nsmbw_SMNP01_0.9.uapatch", "sha256": "...", "size": 252016}
      ]
    },
    {                                      a translation still in work: no version, no discs
      "id": "kirby", "title": "...", "status": "wip", "gametdb": "SUKE01",
      "wip": {"progress": 30, "eta": "Кінець листопада 2026", "updated": "2026-11-15",
              "done": ["..."], "todo": ["..."], "notes": "..."}
    }
  ],
  "contact": "mailto:press.start.ukraine@gmail.com"   «Зв'язатися з автором» (https or mailto)
}

Paths are relative to the catalog, so the same catalog works from a local folder and from the
web (GitHub). A patch is downloaded once into the cache and always checked by its SHA-256:
a patch that does not match the catalog is never used. The catalog carries data only; the
program never downloads code.
"""
import json, os, platform, tempfile, urllib.parse, urllib.request

from .core import PatchError, sha256_file

FORMAT = 1
TIMEOUT = 30
AGENT = 'PressStartUA/1'  # generic client name, nothing about the user


def portable_dir():
    """The «data» folder beside the program when it runs as the portable Windows build (or when
    such a folder exists next to it), else None. A portable program leaves nothing in the system."""
    import sys
    if not getattr(sys, 'frozen', False):
        return None
    path = os.path.join(os.path.dirname(os.path.abspath(sys.executable)), 'data')
    if platform.system() == 'Windows' or os.path.isdir(path):
        try:
            os.makedirs(path, exist_ok=True)
            probe = os.path.join(path, '.write_test')
            open(probe, 'w').close()
            os.unlink(probe)
            return path
        except OSError:  # a read-only place (a CD, Program Files): fall back to the user folders
            return None
    return None


def cache_dir():
    portable = portable_dir()
    if portable:
        path = os.path.join(portable, 'cache')
        os.makedirs(path, exist_ok=True)
        return path
    if platform.system() == 'Windows':
        base = os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')
    elif platform.system() == 'Darwin':
        base = os.path.expanduser('~/Library/Caches')
    else:
        base = os.environ.get('XDG_CACHE_HOME') or os.path.expanduser('~/.cache')
    path = os.path.join(base, 'PressStartUA')
    os.makedirs(path, exist_ok=True)
    return path


def _is_url(s):
    return urllib.parse.urlparse(s).scheme in ('http', 'https')


def _resolve(base, rel):
    if _is_url(base):
        return urllib.parse.urljoin(base, rel)
    return os.path.join(os.path.dirname(os.path.abspath(base)), *rel.split('/'))


def _open(src):
    if _is_url(src):
        if not src.startswith('https://'):
            raise PatchError('Каталог і патчі завантажуються лише через https.')
        req = urllib.request.Request(src, headers={'User-Agent': AGENT})
        try:
            return urllib.request.urlopen(req, timeout=TIMEOUT)
        except OSError as e:
            raise PatchError(f'Не вдалося завантажити {src}: {e}')
    try:
        return open(src, 'rb')
    except OSError as e:
        raise PatchError(f'Не вдалося відкрити {src}: {e}')


GAMETDB = 'https://art.gametdb.com/wii'
COVER_LIMIT = 4 << 20


def _regions(gid):
    """GameTDB cover folders for a disc ID6, best first (the 4th letter is the region)."""
    first = {'E': 'US', 'J': 'JA', 'K': 'KO', 'D': 'DE', 'F': 'FR', 'S': 'ES', 'I': 'IT',
             'H': 'NL'}.get(gid[3:4], 'EN')
    return [first] + [r for r in ('EN', 'US') if r != first]


def _cached(url):
    """Download a picture once into the cache -> its local path, or None if it is not there."""
    import hashlib
    local = os.path.join(cache_dir(), 'cover_' + hashlib.sha256(url.encode()).hexdigest()[:16] + '.png')
    missing = local + '.none'
    if os.path.exists(local):
        return local
    if os.path.exists(missing):  # GameTDB had no such picture: do not ask again on every start
        return None
    try:
        with _open(url) as f:
            data = f.read(COVER_LIMIT + 1)
    except PatchError as e:
        if '404' in str(e):
            open(missing, 'w').close()
        return None
    if len(data) > COVER_LIMIT or not data.startswith((b'\x89PNG', b'\xff\xd8')):
        return None
    with open(local + '.part', 'wb') as out:
        out.write(data)
    os.replace(local + '.part', local)
    return local


class Catalog:
    def __init__(self, source):
        """source: a URL (https) or a local path to catalog.json."""
        self.source = source
        with _open(source) as f:
            data = json.loads(f.read().decode('utf-8'))
        if data.get('format') != FORMAT:
            raise PatchError('Каталог новішого формату. Оновіть програму.')
        self.updated = data.get('updated', '')
        self.games = data.get('games', [])
        self.contact = data.get('contact', '')   # https or mailto link for «Зв'язатися з автором»

    def game(self, gid):
        return next((g for g in self.games if g['id'] == gid), None)

    def find_disc(self, game_id6):
        """-> (game, disc) for a disc ID6, or (None, None)."""
        for g in self.games:
            for d in g.get('discs', []):
                if d['game'] == game_id6:
                    return g, d
        return None, None

    def cover(self, game):
        return _resolve(self.source, game['cover']) if game.get('cover') else None

    def cover_id(self, game):
        """The disc ID6 whose box art GameTDB shows: "gametdb" in the catalog, else the first disc."""
        return game.get('gametdb') or next((d['game'] for d in game.get('discs', [])), None)

    def fetch_cover(self, game):
        """-> (local path, kind) of the game's cover, or (None, None).

        kind "full": a GameTDB scan of the whole case (back, spine, front), the window shows its
        right part; kind "front": just the front. Box art is not kept in the repository: it is
        downloaded from GameTDB by the disc ID, like Dolphin does, and cached. A "cover" picture in
        the catalog is the fallback (our own art, for a game GameTDB does not have).
        """
        gid = self.cover_id(game)
        if gid:
            for region in _regions(gid):
                for kind, folder in (('full', 'coverfullHQ'), ('front', 'cover')):
                    path = _cached(f'{GAMETDB}/{folder}/{region}/{gid}.png')
                    if path:
                        return path, kind
        src = self.cover(game)
        if src and not _is_url(src):
            return (src, 'front') if os.path.exists(src) else (None, None)
        path = _cached(src) if src else None
        return (path, 'front') if path else (None, None)

    def fetch_patch(self, disc, progress=lambda done, total: None):
        """-> local path of the disc's patch, downloaded if needed and checked by SHA-256."""
        want = disc['sha256']
        local = os.path.join(cache_dir(), want + '.uapatch')
        if os.path.exists(local) and sha256_file(local) == want:
            return local
        src = _resolve(self.source, disc['patch'])
        fd, part = tempfile.mkstemp(dir=cache_dir(), suffix='.part')
        try:
            with os.fdopen(fd, 'wb') as out, _open(src) as f:
                total, done = disc.get('size') or 0, 0
                while True:
                    chunk = f.read(1 << 16)
                    if not chunk:
                        break
                    out.write(chunk)
                    done += len(chunk)
                    progress(done, total)
            if sha256_file(part) != want:
                raise PatchError('Завантажений патч не збігається з каталогом. Спробуйте ще раз пізніше.')
            os.replace(part, local)
        finally:
            if os.path.exists(part):
                os.unlink(part)
        return local
