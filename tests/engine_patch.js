// node tests/engine_patch.js IMAGE(.rvz/.wia) PATCH|- OUT iso|wbfs|riiv
// Runs the web engine like the page does. PATCH "-" = no changes (round trip of the image).
const fs = require('fs');
const Pt = require('../docs/engine/patcher.js'), P = require('../docs/engine/uapatch.js');
const [image, patch, out, fmt] = process.argv.slice(2);
const fd = fs.openSync(image, 'r');
const read = async (off, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return new Uint8Array(b.buffer, b.byteOffset, len); };
const fileSink = (name) => { const o = fs.openSync(name, 'w'); return { write: async (u) => { fs.writeSync(o, u); }, close: async () => fs.closeSync(o) }; };
let last = 0;
const progress = (label) => (d, t) => { const now = Date.now(); if (now - last > 5000 || d === t) { last = now; console.log(`  ${label} ${d}/${t}`); } };
(async () => {
  const t0 = Date.now();
  const img = await Pt.openImage(read, fs.statSync(image).size);
  console.log(img.disc.kind, img.gameId, 'rev', img.rev, img.title, img.fsys.files.size, 'files');
  let changes = new Map(), head = null;
  if (patch !== '-') {
    const parsed = P.parse(new Uint8Array(fs.readFileSync(patch)));
    head = parsed.head;
    changes = await Pt.applyPatch(img, parsed, console.log);
  }
  if (fmt === 'riiv') { fs.writeFileSync(out, Pt.zip(Pt.riivolution(head, changes))); console.log('zip written'); return; }
  const job = await Pt.prepare(img, changes);
  for (const [off, b] of job.pl.writes) console.log('  write at', off.toString(16), b.length);
  if (fmt === 'iso') { const s = fileSink(out); await Pt.writeIso(img, job, s, progress('block')); await s.close(); }
  else { const r = await Pt.writeWbfs(img, job, async (i) => fileSink(i ? out.replace(/\.wbfs$/, '.wbf' + i) : out), progress('block')); console.log(r); }
  console.log('done', ((Date.now() - t0) / 1000).toFixed(1) + 's');
})().catch((e) => { console.error(e); process.exit(1); });
