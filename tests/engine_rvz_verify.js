// node tests/engine_rvz_verify.js IMAGE.rvz [all]: opens the image, lists partitions and files, and recomputes
// the hashes of hash groups, comparing each H3 with the H3 table stored on the disc (all groups with "all").
const fs = require('fs');
const R = require('../docs/engine/rvz.js'), W = require('../docs/engine/wii.js'), S = require('../docs/engine/sha1.js');
const [file, mode] = process.argv.slice(2);
const fd = fs.openSync(file, 'r');
const read = async (off, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return new Uint8Array(b.buffer, b.byteOffset, len); };
(async () => {
  const t0 = Date.now();
  const disc = await R.open(read, fs.statSync(file).size);
  console.log(disc.kind, 'size', disc.size, 'chunk', disc.chunk, 'id', W.ascii(disc.header, 0, 6), 'parts', disc.parts.length);
  const parts = await W.partitions(disc);
  for (const p of parts) {
    console.log(' partition type', p.type, 'at', p.off.toString(16), 'data', p.dataSize.toString(16), 'rvz', !!p.rvz);
    if (!p.rvz) continue;
    const fsys = await W.fileSystem(disc, p.rvz);
    console.log('  ', fsys.gameId, fsys.title, fsys.files.size, 'files');
    const h3 = await disc.readRaw(p.off + p.h3Off, 0x18000);
    const nGroups = Math.ceil(p.rvz.nSectors / 64);
    const list = mode === 'all' ? [...Array(nGroups).keys()] : [0, 1, 2, Math.floor(nGroups / 2), nGroups - 2, nGroups - 1].filter((g) => g >= 0 && g < nGroups);
    let bad = 0, t = Date.now();
    for (const g of [...new Set(list)]) {
      const n = Math.min(64, p.rvz.nSectors - g * 64);
      const r = await disc.readPart(p.rvz, g * 64, n);
      const ex = r.exceptions.map((x) => ({ ...x, cluster: x.cluster - g * 64 }));
      const { h3: got } = W.hashGroup(r.data, ex);
      const want = h3.subarray(g * 20, g * 20 + 20);
      if (S.hex(got) !== S.hex(want)) { bad++; if (bad < 5) console.log('   group', g, 'H3 MISMATCH', 'exceptions', ex.length); }
    }
    console.log('   checked', list.length, 'of', nGroups, 'groups,', bad, 'bad,', ((Date.now() - t) / 1000).toFixed(1) + 's');
  }
  console.log('total', ((Date.now() - t0) / 1000).toFixed(1) + 's');
})().catch((e) => { console.error(e); process.exit(1); });
