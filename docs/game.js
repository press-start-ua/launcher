// Press Start UA – a game's own page (game.html?id=…): what the translation is, its versions, and the patcher.
'use strict';

const id = new URLSearchParams(location.search).get('id') || '';
let game = null;

// ---------------------------------------------------------------- the page

function bar(label, value, cls) {
  const m = /^(\d+)\s*%$/.exec(String(value)), yes = value === true || value === 'так';
  const p = m ? Math.min(100, +m[1]) : yes ? 100 : null;
  return el('div', { class: 'fact' },
    el('div', { class: 'r' }, el('span', { textContent: label }), el('b', { textContent: yes ? '✓' : String(value) })),
    p != null && el('div', { class: 'hp ' + (cls || '') }, el('i', { style: `width:${p}%` })));
}
const line = (k, v, code) => el('div', { class: 'line' }, el('span', { textContent: k }), code ? el('code', { textContent: v }) : el('b', { textContent: v }));
const panel = (title, ...kids) => el('section', { class: 'panel' }, el('h2', { textContent: title }), ...kids);
const fill = (node, ...kids) => node.replaceChildren(...kids.flat(2).filter((x) => x != null && x !== false && x !== ''));
const list = (items) => el('ul', {}, items.map((t) => el('li', { textContent: t })));

function render(g) {
  const wip = g.status === 'wip', p = pct(g);
  document.title = `${ukTitle(g)} · Press Start UA`;
  $('ghero').prepend(backdrop(g));
  $('g-cover').replaceChildren(coverBox(g, 'gcover', false));

  $('g-title').textContent = ukTitle(g);
  if (g.title_uk && g.title && g.title_uk !== g.title) { $('g-orig').textContent = g.title; $('g-orig').hidden = false; }
  fill($('g-chips'),
    STATUS[g.status] && el('span', { class: 'chip ' + g.status, textContent: STATUS[g.status] }),
    wip ? p != null && el('span', { class: 'chip', textContent: `${p}% готово` })
      : [g.version && el('span', { class: 'chip', textContent: 'Версія ' + g.version }), g.date && el('span', { class: 'chip', textContent: date(g.date) })],
    el('span', { class: 'chip', textContent: g.platform || 'Wii' }),
  );
  if (g.about) { $('g-about').textContent = g.about; $('g-about').hidden = false; }

  const contact = safeLink(g.contact || catalog.contact);
  fill($('g-acts'), (wip
    ? [contact && el('a', { class: 'btn y', href: contact, textContent: 'Слідкувати в Telegram' })]
    : [el('a', { class: 'btn y', href: '#patch', textContent: 'Перекласти свою гру ↓' }),
      el('a', { class: 'btn o', href: RELEASES, textContent: 'Лаунчер для Windows' })]));

  // the card on the right of the hero
  const facts = $('g-facts');
  if (wip) {
    const w = g.wip || {};
    fill(facts, el('h2', { textContent: 'Прогрес' }),
      p != null && bar('Загалом', p + '%'),
      w.eta && line('Орієнтовно', w.eta),
      w.updated && line('Оновлено', date(w.updated)));
  } else {
    fill(facts, el('h2', { textContent: Array.isArray(g.stats) && g.stats.length ? 'Що перекладено' : 'Коротко' }),
      ...(Array.isArray(g.stats) ? g.stats.map(([k, v]) => bar(k, v, 'green')) : []),
      g.version && line('Версія', g.version),
      g.date && line('Оновлено', date(g.date)),
      ...(g.discs || []).map((d) => line([d.region, d.note].filter(Boolean).join(', ') || 'Диск', d.game, true)));
  }
  facts.hidden = false;

  // below: what is new, versions, discs (or what is done and what is left)
  const left = [];
  if (wip) {
    const w = g.wip || {};
    if (Array.isArray(w.done) && w.done.length) left.push(panel('Готово', list(w.done)));
    if (Array.isArray(w.todo) && w.todo.length) left.push(panel('Ще треба', list(w.todo)));
    if (w.notes) left.push(panel('Примітки', el('p', { textContent: w.notes, style: 'margin:0' })));
  } else {
    if (Array.isArray(g.changes) && g.changes.length) left.push(panel('Що нового у ' + g.version, list(g.changes)));
    const hist = [{ version: g.version, date: g.date, changes: g.changes }, ...(Array.isArray(g.history) ? g.history : [])];
    if (hist.length > 1) {
      left.push(panel('Історія версій', el('ul', { class: 'tl' }, hist.map((h) =>
        el('li', {}, el('b', { textContent: h.version }), el('span', { class: 'muted', textContent: date(h.date) }),
          el('span', { textContent: (h.changes || []).join('; ') }))))));
    }
    if ((g.discs || []).length) {
      left.push(panel('Підходять диски', el('div', { class: 'discs' }, g.discs.map((d) =>
        el('div', { class: 'disc' }, el('span', { textContent: [d.region, d.note].filter(Boolean).join(' · ') || 'Диск' }), el('code', { textContent: d.game }))))));
    }
  }
  $('g-left').replaceChildren(...left);
  $('patch').hidden = wip || (g.platform && g.platform !== 'Wii') || !(g.discs || []).length;
  $('follow').hidden = !wip;
  $('g-cols').hidden = false;
}

// ---------------------------------------------------------------- the patcher (all work in worker.js)

const Patcher = (() => {
  let file = null, info = null, worker = null, busy = false;
  const fmt = () => document.querySelector('input[name="fmt"]:checked').value;
  const mb = (n) => (n / 1048576).toLocaleString('uk-UA', { maximumFractionDigits: 0 }) + ' МБ';
  const disc = () => game && info && (game.discs || []).find((d) => d.game === info.gameId);

  function found(text, ok) { const f = $('p-found'); f.hidden = !text; f.textContent = text || ''; f.className = 'found ' + (ok ? 'ok' : 'bad'); }
  function result(nodes, bad) { const r = $('p-result'); r.hidden = !nodes; r.className = 'result' + (bad ? ' bad' : ''); r.replaceChildren(...(nodes || [])); }
  function log(text) { $('p-logwrap').hidden = false; $('p-log').textContent += text + '\n'; }
  function stage(text) { $('p-stage').textContent = text || ''; }
  function progress(done, total) {
    $('p-barwrap').hidden = total == null;
    if (total) $('p-bar').style.width = Math.round((done / total) * 100) + '%';
  }
  function steps() {
    const ok = !!disc();
    $('s1').className = 'stp ' + (ok ? 'ok' : 'on');
    $('s1').querySelector('.n').textContent = ok ? '✓' : '1';
    $('s2').className = 'stp' + (ok ? ' on' : '');
    $('s3').className = 'stp' + (ok ? ' on' : '');
    $('p-go').disabled = !ok || busy;
  }
  function setBusy(on) {
    busy = on;
    $('p-go').hidden = on; $('p-cancel').hidden = !on;
    $('p-file').disabled = on;
    document.querySelectorAll('input[name="fmt"]').forEach((r) => { r.disabled = on; });
    steps();
  }
  function newWorker() { if (worker) worker.terminate(); worker = new Worker('worker.js' + VERSION); return worker; }

  /** A chosen image: ask the worker what disc it is. */
  function choose(f) {
    if (busy || !f) return;
    file = f; info = null;
    $('p-droptext').replaceChildren(el('b', { textContent: f.name }), ' · ' + mb(f.size));
    found('Читаємо образ…', true); result(null); stage(''); progress(); steps();
    const w = newWorker();
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'error') { found(m.text, false); w.terminate(); worker = null; steps(); return; }
      if (m.type !== 'info') return;
      info = m; w.terminate(); worker = null;
      const d = disc();
      if (d) found(`✓ ${m.gameId} · ${[d.region, d.note].filter(Boolean).join(', ')} — підходить`, true);
      else {
        const other = catalog.games.find((x) => (x.discs || []).some((y) => y.game === m.gameId));
        if (other) {
          found('', false);
          result([el('span', { textContent: `Це образ іншої гри: ${ukTitle(other)} (${m.gameId}). ` }), el('a', { href: gameUrl(other), textContent: 'Відкрити її сторінку →' })], true);
        } else found(`Для диска ${m.gameId} (${m.title.trim()}) цього перекладу немає. Підходять: ${(game.discs || []).map((x) => x.game).join(', ')}.`, false);
      }
      steps();
    };
    w.postMessage({ cmd: 'open', file: f });
  }

  /** Where to write. Asked here, in the click: the browser needs the user's gesture. */
  async function target(format) {
    if (format === 'riiv') return { kind: 'none' };
    try {
      if (format === 'iso' && window.showSaveFilePicker) {
        return { kind: 'file', handle: await showSaveFilePicker({ suggestedName: `${info.gameId} UA.iso`, types: [{ description: 'ISO', accept: { 'application/octet-stream': ['.iso'] } }] }) };
      }
      if (format === 'wbfs' && window.showDirectoryPicker) {
        return { kind: 'dir', handle: await showDirectoryPicker({ id: 'wbfs', mode: 'readwrite' }) };
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
    }
    if (!navigator.storage || !navigator.storage.getDirectory) {
      result([el('span', { textContent: 'Цей браузер не вміє зберігати великі файли. Відкрийте сторінку в Chrome, Edge або Firefox, або оберіть Riivolution.' })], true);
      return null;
    }
    return { kind: 'opfs' };
  }

  async function go() {
    const d = disc();
    if (!d || !file) return;
    const format = fmt(), t = await target(format);
    if (!t) return;
    setBusy(true); result(null); progress(0, 1); $('p-log').textContent = ''; $('p-logwrap').hidden = true;
    const started = Date.now(), folder = `${game.title} [${info.gameId}]`;
    const w = newWorker();
    w.onmessage = async (e) => {
      const m = e.data;
      if (m.type === 'log') log(m.text);
      else if (m.type === 'stage') { stage(m.text); progress(0, 1); }
      else if (m.type === 'progress') progress(m.done, m.total);
      else if (m.type === 'error') { finish(); stage(''); progress(); result([el('span', { textContent: m.text })], true); }
      else if (m.type === 'done') {
        finish();
        stage(`Готово за ${Math.round((Date.now() - started) / 1000)} с.`);
        progress(1, 1);
        if (m.blob) {
          const a = el('a', { href: URL.createObjectURL(m.blob), download: m.name, textContent: 'Завантажити ' + m.name });
          result([a, el('p', { textContent: m.note })]);
          a.click();
        } else if (m.opfs) {
          const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('result');
          const links = [];
          for (const name of m.opfs) {
            const f = await (await dir.getFileHandle(name)).getFile();
            links.push(el('a', { href: URL.createObjectURL(f), download: name, textContent: `Завантажити ${name} (${mb(f.size)})` }));
          }
          result([...links, el('p', { textContent: m.format === 'wbfs' ? `Покладіть файл у теку wbfs/${folder}/ на USB-диску.` : 'Відкрийте ISO в Dolphin.' })]);
          if (links.length === 1) links[0].click();
        } else {
          result([el('span', { textContent: m.format === 'wbfs' ? `Збережено в обрану теку: wbfs/${folder}/.` : 'Збережено.' })]);
        }
      }
    };
    w.postMessage({ cmd: 'patch', file, patchUrl: asset(d.patch), sha256: d.sha256, format, target: t });
  }

  function finish() { setBusy(false); if (worker) { worker.terminate(); worker = null; } }

  $('p-file').addEventListener('change', (e) => choose(e.target.files[0]));
  $('p-go').addEventListener('click', go);
  $('p-cancel').addEventListener('click', () => { finish(); stage('Скасовано.'); progress(); });
  const drop = $('p-drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  // an image dropped anywhere on the page goes into the patcher
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!$('patch').hidden && !busy && e.dataTransfer.types.includes('Files')) { depth++; document.body.classList.add('dragging'); }
  });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; document.body.classList.remove('dragging'); drop.classList.remove('over');
    if (!$('patch').hidden && e.dataTransfer.files[0]) { choose(e.dataTransfer.files[0]); $('patch').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  });
  window.addEventListener('beforeunload', (e) => { if (busy) { e.preventDefault(); e.returnValue = ''; } });
  return { steps };
})();

(async () => {
  // a result left in the browser's private storage by an earlier visit takes up to 4.7 GB: free it
  try { await (await navigator.storage.getDirectory()).removeEntry('result', { recursive: true }); } catch (e) { /* none */ }
  if (!await loadCatalog()) { $('g-title').textContent = 'Не вдалося завантажити список ігор. Спробуйте оновити сторінку.'; return; }
  game = catalog.games.find((g) => g.id === id);
  if (!game) {
    $('g-title').textContent = 'Такої гри в списку немає';
    $('g-acts').replaceChildren(el('a', { class: 'btn y', href: './#games', textContent: 'Усі ігри' }));
    return;
  }
  render(game);
  Patcher.steps();
  if (location.hash === '#patch') $('patch').scrollIntoView();
})();
