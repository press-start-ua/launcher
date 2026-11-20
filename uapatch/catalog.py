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
      "status": "beta",                    optional badge: "beta" (БЕТА) or "done" (ЗАВЕРШЕНО)
      "discs": [
        {"game": "SMNP01", "region": "Європа", "note": "Rev 2",
         "patch": "patches/nsmbw_SMNP01_0.9.uapatch", "sha256": "...", "size": 252016}
      ]
    }
  ]
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


def cache_dir():
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

    def game(self, gid):
        return next((g for g in self.games if g['id'] == gid), None)

    def find_disc(self, game_id6):
        """-> (game, disc) for a disc ID6, or (None, None)."""
        for g in self.games:
            for d in g['discs']:
                if d['game'] == game_id6:
                    return g, d
        return None, None

    def cover(self, game):
        return _resolve(self.source, game['cover']) if game.get('cover') else None

    def fetch_cover(self, game, limit=4 << 20):
        """-> local path of the game's cover picture (downloaded once into the cache), or None."""
        src = self.cover(game)
        if not src:
            return None
        if not _is_url(src):
            return src if os.path.exists(src) else None
        import hashlib
        local = os.path.join(cache_dir(), 'cover_' + hashlib.sha256(src.encode()).hexdigest()[:16] + '.png')
        if not os.path.exists(local):
            with _open(src) as f:
                data = f.read(limit + 1)
            if len(data) > limit:
                raise PatchError('Обкладинка завелика.')
            with open(local + '.part', 'wb') as out:
                out.write(data)
            os.replace(local + '.part', local)
        return local

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
