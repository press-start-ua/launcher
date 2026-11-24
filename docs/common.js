// Press Start UA – shared by the pages: the catalog (the same catalog.json as the launcher), covers, the header.
// Data only: every value from the catalog goes into the page as text; links only if https/mailto.
'use strict';

// bump with every change of the site's scripts, docs/engine or worker.js, so browsers do not keep old copies
const VERSION = '?v=14';
const ONLINE = 'https://raw.githubusercontent.com/press-start-ua/launcher/main/catalog/catalog.json';
const LOCAL = '../catalog/catalog.json'; // preview served from the repository root
const SOURCES = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? [LOCAL, ONLINE] : [ONLINE, LOCAL];
const GAMETDB = 'https://art.gametdb.com/wii';
const STATUS = { wip: 'У роботі', beta: 'Бета', done: 'Завершено' };
const REGION = { E: 'US', J: 'JA', K: 'KO', D: 'DE', F: 'FR', S: 'ES', I: 'IT', H: 'NL' };
const RELEASES = 'https://github.com/press-start-ua/launcher/releases/latest';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('data-') || k.startsWith('aria-')) e.setAttribute(k, v);
    else e[k] = v;
  }
  e.append(...kids.flat().filter((x) => x != null && x !== false));
  return e;
};
const safeLink = (u) => (typeof u === 'string' && /^(https:|mailto:)/i.test(u) ? u : '');
const date = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : (s || '');
};
const pct = (g) => {
  const p = Number(g && g.wip && g.wip.progress);
  return Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : null;
};

let catalog = null, base = '';

async function loadCatalog() {
  for (const src of SOURCES) {
    try {
      const r = await fetch(src, { cache: 'no-cache' });
      if (!r.ok) continue;
      const data = await r.json();
      if (data.format !== 1) continue;
      base = new URL('.', new URL(src, location.href)).href;
      data.games = Array.isArray(data.games) ? data.games : [];
      catalog = data;
      const tg = safeLink(data.contact);
      document.querySelectorAll('[data-contact]').forEach((a) => { if (tg) a.href = tg; });
      return data;
    } catch (e) { /* try the next source */ }
  }
  return null;
}

const asset = (path) => (path ? new URL(path, base).href : '');
const gameUrl = (g) => 'game.html?id=' + encodeURIComponent(g.id);

/** Picture candidates, best first: GameTDB whole-case scan, its front-only cover, our own picture. */
function coverUrls(g) {
  const id = g.gametdb || (g.discs && g.discs[0] && g.discs[0].game);
  const urls = [];
  if (id) {
    const first = REGION[id[3]] || 'EN';
    for (const reg of [first, ...['EN', 'US'].filter((r) => r !== first)]) {
      urls.push(`${GAMETDB}/coverfullHQ/${reg}/${id}.png`, `${GAMETDB}/cover/${reg}/${id}.png`);
    }
  }
  if (g.cover) urls.push(asset(g.cover));
  return urls;
}

/** An <img> that tries the next picture when one is missing. onNone: called when none works. */
function pictureImg(g, onNone) {
  const urls = coverUrls(g);
  // the browser's default referrer policy: GameTDB sees only our site's address, nothing about the visitor
  const img = el('img', { alt: '', decoding: 'async' });
  let i = 0;
  const next = () => { if (i < urls.length) img.src = urls[i++]; else { img.remove(); if (onNone) onNone(); } };
  img.addEventListener('error', next);
  if (urls.length) next(); else setTimeout(() => onNone && onNone());
  return img;
}

/** The Ukrainian name when there is one; the original stays as a subtitle (folder names keep the original). */
const ukTitle = (g) => g.title_uk || g.title || g.id;

function hue(s) { let h = 0; for (const c of s) h = (h * 31 + c.codePointAt(0)) % 360; return h; }
function initials(title) {
  return title.split(/[\s:.\-–]+/).filter((w) => /^[\p{L}\d]/u.test(w)).slice(0, 3).map((w) => w[0].toUpperCase()).join('');
}

/** The case cover: a scan, or a coloured tile with initials. tag: add the status label. */
function coverBox(g, cls, tag) {
  const box = el('div', { class: 'cover ' + (cls || '') });
  const tile = () => {
    const h = hue(g.title || g.id);
    box.prepend(el('div', { class: 'ini', textContent: initials(g.title || g.id),
      style: `background: linear-gradient(160deg, hsl(${h} 45% 42%), hsl(${h} 50% 16%))` }));
  };
  box.append(pictureImg(g, tile));
  if (tag && STATUS[g.status]) box.append(el('span', { class: 'tag ' + g.status, textContent: STATUS[g.status] }));
  return box;
}

/** The blurred picture behind a hero. */
function backdrop(g) {
  return el('div', { class: 'backdrop', 'aria-hidden': 'true' }, pictureImg(g));
}


