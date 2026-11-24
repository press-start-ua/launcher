// Press Start UA – the home page: hero with the newest translation, the shelf of games, search in the header.
'use strict';

function cart(g) {
  const p = pct(g);
  const meta = g.status === 'wip'
    // one line like the other cards: the «У роботі» tag is on the cover, here the bar and the percent
    ? [p != null ? el('div', { class: 'm prog' }, el('div', { class: 'hp' }, el('i', { style: `width:${p}%` })), el('span', { textContent: p + '%' }))
      : el('div', { class: 'm', textContent: 'У роботі' })]
    : [el('div', { class: 'm', textContent: [g.version && 'v' + g.version, ...(g.discs || []).map((d) => d.game)].filter(Boolean).join(' · ') })];
  return el('li', {},
    el('a', { class: 'cart', href: gameUrl(g) }, coverBox(g, '', true), el('h3', { textContent: ukTitle(g) }),
      el('div', { class: 'orig', textContent: g.title_uk && g.title ? g.title : '' }), meta)); // always 4 parts: the subgrid rows
}

(async () => {
  if (!await loadCatalog()) { $('state').textContent = 'Не вдалося завантажити список ігор. Спробуйте оновити сторінку.'; return; }
  const games = catalog.games;
  $('shelf').replaceChildren(...games.map(cart));
  $('state').hidden = games.length > 0;
  if (!games.length) $('state').textContent = 'Поки що тут порожньо.';

  const ready = games.filter((g) => g.status !== 'wip'), wip = games.filter((g) => g.status === 'wip');
  $('stats').replaceChildren(...[
    el('div', {}, el('b', { textContent: String(ready.length) }), el('span', { textContent: 'готові переклади' })),
    wip.length && el('div', {}, el('b', { textContent: String(wip.length) }), el('span', { textContent: 'у роботі' })),
  ].filter(Boolean));
  if (catalog.updated) $('updated').textContent = 'Список оновлено ' + date(catalog.updated);

  // the newest ready translation is the hero
  const f = [...ready].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
  if (f) {
    const feature = $('feature');
    feature.href = gameUrl(f);
    feature.setAttribute('aria-label', ukTitle(f));
    feature.replaceChildren(coverBox(f, '', true));
    feature.hidden = false;
    $('hero').prepend(backdrop(f));
    const btn = $('feature-btn');
    btn.href = gameUrl(f);
    btn.textContent = 'Перекласти ' + (f.short || f.title.split(/[:.]/)[0]);
  }
  if (location.hash === '#games' || location.hash === '#how') $(location.hash.slice(1)).scrollIntoView();
})();
