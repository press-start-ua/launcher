// Press Start UA – the patcher worker: everything runs here, on the player's computer. The image is never uploaded.
// Messages in:  { cmd: 'open', file } · { cmd: 'patch', file, patchUrl, sha256, format, target }
// Messages out: { type: 'info'|'log'|'progress'|'stage'|'done'|'error', … }
// Licence: GPL-3.0-or-later (https://github.com/press-start-ua/launcher).
'use strict';
importScripts(...['engine/vendor/fzstd.js', 'engine/lzma.js', 'engine/sha1.js', 'engine/uapatch.js', 'engine/rvz.js', 'engine/wii.js', 'engine/patcher.js']
  .map((f) => f + self.location.search)); // the same ?v= as the worker itself

const post = (m) => self.postMessage(m);
const log = (text) => post({ type: 'log', text });
const known = (e) => e instanceof UaPatch.PatchError || e instanceof UaRvz.DiscError || e instanceof UaLzma.LzmaError;

const reader = (file) => async (off, len) => new Uint8Array(await file.slice(off, off + len).arrayBuffer());

async function openImage(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const magic = String.fromCharCode(...head);
  if (magic !== 'RVZ\x01' && magic !== 'WIA\x01') {
    if (magic === 'WBFS' || /\.(iso|wbfs|wbf1|ciso)$/i.test(file.name)) {
      throw new UaRvz.DiscError('Сторінка читає лише RVZ. У Dolphin: правий клік по грі → «Конвертувати файл…» → формат RVZ. Або скористайтеся лаунчером для Windows: він бере ISO та WBFS.');
    }
    throw new UaRvz.DiscError('Це не образ RVZ.');
  }
  return UaPatcher.openImage(reader(file), file.size);
}

async function fetchPatch(url, sha256) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new UaPatch.PatchError('Не вдалося завантажити патч перекладу. Перевірте з\'єднання й спробуйте ще раз.');
  const bytes = new Uint8Array(await r.arrayBuffer());
  const got = UaSha1.hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  if (got !== sha256) throw new UaPatch.PatchError('Завантажений патч не збігається з каталогом. Спробуйте ще раз пізніше.');
  return UaPatch.parse(bytes);
}

// ---------------------------------------------------------------- where the result goes

/** A file in the folder: a writable stream (File System Access) or a sync handle in the private storage (OPFS). */
async function fileSink(dir, name) {
  const h = await dir.getFileHandle(name, { create: true });
  if (h.createSyncAccessHandle) {
    try {
      const s = await h.createSyncAccessHandle();
      s.truncate(0);
      let at = 0;
      return { write: async (u) => { s.write(u, { at }); at += u.length; }, close: async () => { s.flush(); s.close(); } };
    } catch (e) { /* not the private storage: use a stream */ }
  }
  const w = await h.createWritable();
  return { write: (u) => w.write(u), close: () => w.close() };
}

/** target: { kind: 'file', handle } | { kind: 'dir', handle } | { kind: 'opfs' } -> the folder and file names */
async function outputDir(target) {
  if (target.kind === 'dir') return target.handle;
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('result', { recursive: true }); } catch (e) { /* nothing there */ }
  return root.getDirectoryHandle('result', { create: true });
}

// ---------------------------------------------------------------- the job

async function patch(m) {
  post({ type: 'stage', text: 'Відкриваємо образ…' });
  const img = await openImage(m.file);
  log(`${img.title} (${img.gameId}, ревізія ${img.rev}), ${img.disc.kind}`);
  post({ type: 'stage', text: 'Завантажуємо переклад…' });
  const p = await fetchPatch(m.patchUrl, m.sha256);
  log(`Переклад версії ${p.head.version}`);
  post({ type: 'stage', text: 'Перевіряємо файли й накладаємо переклад…' });
  const changes = await UaPatcher.applyPatch(img, p, log, (d, t) => post({ type: 'progress', done: d, total: t }));
  const safe = (s) => s.replace(/[\\/:*?"<>|]+/g, ' ').trim();
  const base = `${safe(p.head.title || img.title)} [${img.gameId}] UA`;

  if (m.format === 'riiv') {
    const files = UaPatcher.riivolution(p.head, changes);
    const zip = UaPatcher.zip(files);
    post({ type: 'done', blob: new Blob([zip], { type: 'application/zip' }), name: `${base} Riivolution.zip`,
      note: `Розпакуйте архів у корінь SD-картки: там з'являться теки riivolution і ${p.head.riivolution.root}.` });
    return;
  }

  post({ type: 'stage', text: 'Розміщуємо файли й рахуємо хеші…' });
  const job = await UaPatcher.prepare(img, changes);
  const dir = await outputDir(m.target);
  const files = [];
  const progress = (d, t) => post({ type: 'progress', done: d, total: t });
  if (m.format === 'iso') {
    post({ type: 'stage', text: 'Шифруємо й записуємо ISO…' });
    let sink;
    if (m.target.kind === 'file') {
      const w = await m.target.handle.createWritable();
      sink = { write: (u) => w.write(u), close: () => w.close() };
    } else { sink = await fileSink(dir, `${img.gameId}.iso`); files.push(`${img.gameId}.iso`); }
    await UaPatcher.writeIso(img, job, sink, progress);
    await sink.close();
  } else {
    post({ type: 'stage', text: 'Шифруємо й записуємо WBFS…' });
    let folder = dir;
    if (m.target.kind === 'dir') {
      folder = await (await dir.getDirectoryHandle('wbfs', { create: true })).getDirectoryHandle(`${safe(p.head.title || img.title)} [${img.gameId}]`, { create: true });
    }
    const r = await UaPatcher.writeWbfs(img, job, async (i) => {
      const name = img.gameId + (i ? `.wbf${i}` : '.wbfs');
      files.push(name);
      return fileSink(folder, name);
    }, progress);
    log(`WBFS: ${(r.size / 1048576).toFixed(0)} МБ${r.files > 1 ? `, ${r.files} частини` : ''}`);
  }
  post({ type: 'done', opfs: m.target.kind === 'opfs' ? files : null, base, format: m.format });
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.cmd === 'open') {
      const img = await openImage(m.file);
      post({ type: 'info', gameId: img.gameId, rev: img.rev, title: img.title, kind: img.disc.kind });
    } else if (m.cmd === 'patch') await patch(m);
  } catch (err) {
    post({ type: 'error', text: known(err) ? err.message : 'Несподівана помилка: ' + (err && err.message || err) });
  }
};
