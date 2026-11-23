"""Is there a newer version of the launcher? Asks GitHub for the latest release of the repository.

A release is made by pushing a tag like v0.2 (see .github/workflows/windows.yml); its zip is the
portable Windows build. Only the version and the page link are read: the program never downloads
or runs code by itself, the user downloads the new zip from the release page.
"""
import json, re, urllib.request

from .core import PatchError

REPO = 'press-start-ua/launcher'
LATEST = f'https://api.github.com/repos/{REPO}/releases/latest'
RELEASES = f'https://github.com/{REPO}/releases'
ISSUES = f'https://github.com/{REPO}/issues'
AGENT = 'PressStartUA/1'  # generic client name, nothing about the user
TIMEOUT = 15


def parse_version(text):
    """'v0.10.2' -> (0, 10, 2); text without digits -> ()."""
    return tuple(int(n) for n in re.findall(r'\d+', text or ''))


def is_newer(latest, current):
    return parse_version(latest) > parse_version(current)


def latest_release():
    """-> {'version', 'url', 'notes', 'date'} of the newest published release, or None if the
    repository has none yet. Raises PatchError when GitHub cannot be reached."""
    req = urllib.request.Request(LATEST, headers={'User-Agent': AGENT, 'Accept': 'application/vnd.github+json'})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as f:
            data = json.loads(f.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        if e.code == 404:  # no release yet
            return None
        raise PatchError(f'GitHub відповів помилкою {e.code}.')
    except OSError as e:
        raise PatchError(f'Не вдалося зв\'язатися з GitHub: {e}')
    url = data.get('html_url') or RELEASES
    if not url.startswith('https://github.com/'):
        url = RELEASES
    return dict(version=(data.get('tag_name') or '').lstrip('vV'), url=url,
                notes=(data.get('body') or '').strip(), date=(data.get('published_at') or '')[:10])
