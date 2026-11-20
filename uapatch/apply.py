"""Apply a .uapatch to the user's own clean disc image -> a new ISO / WBFS, or a Riivolution folder.

Works on the files inside the image with wit (Wiimms ISO Tools): extract the data partition,
check every file by its hash, write the patched files, rebuild, then check the result again.
The input image is never changed. RVZ is not read (wit cannot); the user converts it to ISO in
Dolphin first.

Every step reports through `log(text)` and `progress(done, total)` so a window can show it.
"""
import os, platform, re, shutil, subprocess, sys, tempfile

from .core import PatchError, delta_apply, sha1, yaz0_decode, yaz0_encode

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NEED_FREE = 2 * 1024 ** 3
FORMATS = ('iso', 'wbfs', 'riivolution')


def _quiet(*a):
    pass


# ------------------------------------------------------------------ wit

def find_wit():
    system = {'Darwin': 'macos', 'Windows': 'windows'}.get(platform.system(), 'linux')
    name = 'wit.exe' if system == 'windows' else 'wit'
    for base in (getattr(sys, '_MEIPASS', None), HERE):  # _MEIPASS: inside a packed app
        if base:
            local = os.path.join(base, 'wit', system, name)
            if os.path.exists(local):
                return local
    found = shutil.which('wit')
    if found:
        return found
    raise PatchError('Не знайдено програму wit (Wiimms ISO Tools), вона має йти разом із програмою.')


def run_wit(wit, cwd, *args):
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)  # no console window flashing on Windows
    r = subprocess.run([wit] + list(args), cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       creationflags=flags)
    text = r.stdout.decode('utf-8', 'replace')
    if r.returncode:
        raise PatchError('wit завершився з помилкою:\n' + text.strip())
    return text


def link_input(src, tmp, log):
    """Give the image a plain Latin name in the work folder (wit on Windows cannot open Cyrillic
    paths). A hard link costs no disk space; a copy is the fallback."""
    ext = os.path.splitext(src)[1].lower()
    name = 'input' + (ext if all(ord(c) < 128 for c in ext) else '.img')
    try:
        os.link(src, os.path.join(tmp, name))
    except OSError:
        log('Копіюю образ у робочу папку, це може зайняти кілька хвилин...')
        shutil.copyfile(src, os.path.join(tmp, name))
    return name


def disc_id(src):
    """-> the game ID6 of an image, read with wit (None if it cannot be read)."""
    check_source(src)
    wit = find_wit()
    tmp = tempfile.mkdtemp(prefix='uapatch_id_')
    try:
        name = link_input(src, tmp, _quiet)
        words = run_wit(wit, tmp, 'ID6', name).split()
        return words[-1] if words else None
    except PatchError:
        return None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def check_source(src):
    if not os.path.isfile(src):
        raise PatchError(f'Файл не знайдено: {src}')
    if src.lower().endswith('.rvz'):
        raise PatchError('RVZ поки не підтримується. У Dolphin натисніть на грі правою кнопкою, '
                         'виберіть «Convert File...», формат ISO, а тоді вкажіть отриманий файл.')


# ------------------------------------------------------------------ files

def apply_files(head, blob, root, log=_quiet, progress=_quiet):
    """Check every file first, then write them all. -> {path: sha1 of the written file}."""
    files = head['files']
    for f in files:
        path = os.path.join(root, *f['path'].split('/'))
        if not os.path.exists(path):
            raise PatchError(f'В образі немає файлу {f["path"]}. Образ пошкоджений або змінений.')
        cur = open(path, 'rb').read()
        if sha1(cur) == f['result_sha1'] or sha1(cur) != f['src_sha1'] and cur[:4] == b'Yaz0' \
                and sha1(yaz0_decode(cur)) == f['dst_sha1']:
            raise PatchError('Цей образ уже перекладено. Потрібен оригінальний образ гри.')
        if sha1(cur) != f['src_sha1']:
            raise PatchError(f'Файл {f["path"]} відрізняється від оригіналу. '
                             'Потрібен чистий, не змінений образ гри (тієї ж ревізії диска).')
    done = {}
    for i, f in enumerate(files, 1):
        log(f'  [{i}/{len(files)}] {f["path"]}')
        path = os.path.join(root, *f['path'].split('/'))
        cur = open(path, 'rb').read()
        new = delta_apply(yaz0_decode(cur) if f['yaz0'] else cur, blob[f['offset']:f['offset'] + f['size']])
        if sha1(new) != f['dst_sha1']:
            raise PatchError(f'Не вдалося застосувати патч до {f["path"]}.')
        if f['yaz0']:
            new = yaz0_encode(new)
        with open(path, 'wb') as out:
            out.write(new)
        done[f['path']] = sha1(new)
        progress(i, len(files))
    return done


def verify_output(wit, tmp, name, done):
    rules = ';'.join('+/' + p for p in done)
    run_wit(wit, tmp, 'extract', name, 'check', '--psel', 'data', '--files', rules, '--overwrite')
    for path, want in done.items():
        got = os.path.join(tmp, 'check', *path.split('/'))
        if not os.path.exists(got) or sha1(open(got, 'rb').read()) != want:
            raise PatchError(f'Перевірка результату не пройшла: {path}')


# ------------------------------------------------------------------ image

def patch_image(head, blob, src, out, fmt, force=False, log=_quiet, progress=_quiet):
    """src image -> out (.iso or .wbfs) with the translation."""
    if fmt not in ('iso', 'wbfs'):
        raise PatchError(f'Невідомий формат: {fmt}')
    check_source(src)
    if os.path.abspath(src) == os.path.abspath(out):
        raise PatchError('Вихідний файл не може збігатися з вхідним.')
    if os.path.exists(out) and not force:
        raise PatchError(f'Файл уже існує: {out}')
    parent = os.path.dirname(os.path.abspath(out))
    if shutil.disk_usage(parent).free < NEED_FREE:
        raise PatchError(f'Замало місця на диску: потрібно щонайменше 2 ГБ у {parent}.')
    wit = find_wit()
    tmp = tempfile.mkdtemp(prefix='uapatch_', dir=parent)
    try:
        name = link_input(src, tmp, log)
        game = run_wit(wit, tmp, 'ID6', name).split()[-1]
        if game != head['game']:
            raise PatchError(f'Цей патч для диска {head["game"]}, а образ — {game}.')
        log(f'{head["title"]} ({head["game"]}), переклад версії {head["version"]}')
        log('Розпаковую гру...')
        run_wit(wit, tmp, 'extract', name, 'disc', '--psel', 'data', '--overwrite')
        log('Застосовую переклад...')
        done = apply_files(head, blob, os.path.join(tmp, 'disc'), log, progress)
        log('Збираю новий образ...')
        result = 'output.' + fmt
        run_wit(wit, tmp, 'copy', 'disc', result, '--' + fmt, '--overwrite')
        log('Перевіряю результат...')
        verify_output(wit, tmp, result, done)
        os.replace(os.path.join(tmp, result), out)  # only a checked image reaches the user
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    log(f'Готово: {out}')
    return out


# ------------------------------------------------------------------ Riivolution

def riivolution_xml(head, paths):
    rv, game = head['riivolution'], head['game']
    pid = rv['root'].lower() + '_' + game
    files = '\n'.join(f'    <file disc="/{p[len("files/"):]}" external="{game}/{p[len("files/"):]}" />'
                      for p in paths)
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<wiidisc version="1" root="/{rv['root']}">
  <id game="{game[:3]}">
    <region type="{game[3]}" />
  </id>
  <options>
    <section name="{rv['section']}">
      <option name="Ukrainian translation" default="1">
        <choice name="Enabled">
          <patch id="{pid}" />
        </choice>
      </option>
    </section>
  </options>
  <patch id="{pid}">
{files}
  </patch>
</wiidisc>
'''


def patch_riivolution(head, blob, src, out, force=False, log=_quiet, progress=_quiet):
    """Write riivolution/<root>_<game>.xml and <root>/<game>/... into the folder out."""
    check_source(src)
    wit = find_wit()
    rv, game = head['riivolution'], head['game']
    os.makedirs(out, exist_ok=True)
    xml = os.path.join(out, 'riivolution', f'{rv["root"]}_{game}.xml')
    files = os.path.join(out, rv['root'], game)
    if (os.path.exists(xml) or os.path.exists(files)) and not force:
        raise PatchError(f'У {out} уже є переклад для {game}.')
    tmp = tempfile.mkdtemp(prefix='uapatch_', dir=out)
    try:
        name = link_input(src, tmp, log)
        got = run_wit(wit, tmp, 'ID6', name).split()[-1]
        if got != game:
            raise PatchError(f'Цей патч для диска {game}, а образ — {got}.')
        log(f'{head["title"]} ({game}), переклад версії {head["version"]}, для Riivolution')
        log('Розпаковую потрібні файли...')
        rules = ';'.join('+/' + f['path'] for f in head['files'])
        run_wit(wit, tmp, 'extract', name, 'disc', '--psel', 'data', '--files', rules, '--overwrite')
        log('Застосовую переклад...')
        done = apply_files(head, blob, os.path.join(tmp, 'disc'), log, progress)
        skip = set(rv.get('skip', ()))
        paths = sorted(p for p in done if p not in skip)
        shutil.rmtree(files, ignore_errors=True)
        for p in paths:
            dst = os.path.join(files, *p[len('files/'):].split('/'))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copyfile(os.path.join(tmp, 'disc', *p.split('/')), dst)
            if sha1(open(dst, 'rb').read()) != done[p]:
                raise PatchError(f'Перевірка результату не пройшла: {p}')
        os.makedirs(os.path.dirname(xml), exist_ok=True)
        with open(xml, 'w', encoding='utf-8', newline='\n') as f:
            f.write(riivolution_xml(head, paths))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    log(f'Готово: {out}')
    log(f'Скопіюйте папки riivolution і {rv["root"]} з неї в корінь SD-картки.')
    return out


def default_output(src, fmt):
    base = os.path.splitext(os.path.abspath(src))[0]
    return base + (' (UA Riivolution)' if fmt == 'riivolution' else ' (UA).' + fmt)


def clean_path(text):
    """A path typed or dragged into a terminal -> a plain path."""
    text = text.strip().strip('"\'')
    if os.name == 'nt' or os.path.exists(text):
        return text
    return re.sub(r'\\(.)', r'\1', text)
