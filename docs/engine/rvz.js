// Press Start UA – reading RVZ (Dolphin) and WIA (wit) disc images in the browser.
// Written from Dolphin's docs/WiaAndRvz.md. Wii partition data is stored there decrypted, without hashes,
// together with the partition's title key, so no Wii common key is needed.
// Compression: none, Zstandard (RVZ), LZMA2. Not supported: bzip2, LZMA, PURGE (the user converts to RVZ zstd).
// Licence: GPL-3.0-or-later (https://github.com/press-start-ua/launcher).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vendor/fzstd.js'), require('./lzma.js'));
  else root.UaRvz = factory(root.fzstd, root.UaLzma);
})(typeof self !== 'undefined' ? self : this, function (fzstd, UaLzma) {
  'use strict';

  class DiscError extends Error {}
  const fail = (m) => { throw new DiscError(m); };

  const SECTOR = 0x8000, DATA = 0x7C00, HASHES = 0x400, GROUP = 0x200000;
  const be16 = (u, o) => (u[o] << 8) | u[o + 1];
  const be32 = (u, o) => ((u[o] << 24) | (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3]) >>> 0;
  const be64 = (u, o) => be32(u, o) * 0x100000000 + be32(u, o + 4);

  // ---------------------------------------------------------------- junk data (Lagged Fibonacci, RVZ packing)

  function lfgForward(b) {
    for (let i = 0; i < 32; i++) b[i] ^= b[i + 521 - 32];
    for (let i = 32; i < 521; i++) b[i] ^= b[i - 32];
  }

  /** size bytes of junk from a 68-byte seed, starting skip bytes into the stream, into out[o…]. */
  function junk(seed, skip, out, o, size) {
    const b = new Uint32Array(521);
    for (let i = 0; i < 17; i++) b[i] = be32(seed, i * 4);
    for (let i = 17; i < 521; i++) b[i] = ((b[i - 17] << 23) ^ (b[i - 16] >>> 9) ^ b[i - 1]) >>> 0;
    for (let i = 0; i < 4; i++) lfgForward(b);
    let word = skip >>> 2, byte = skip & 3;
    while (word >= 521) { lfgForward(b); word -= 521; }
    const end = o + size;
    while (o < end) {
      const w = b[word];
      const bytes = [w >>> 24, w >>> 18, w >>> 8, w];
      for (; byte < 4 && o < end; byte++) out[o++] = bytes[byte] & 0xFF;
      byte = 0;
      if (++word === 521) { lfgForward(b); word = 0; }
    }
  }

  // ---------------------------------------------------------------- the image

  /**
   * read(offset, length) -> Promise<Uint8Array>: random access to the image file.
   * -> disc { kind, size, chunk, header (0x80 bytes), parts [{ key, firstSector, nSectors }], readRaw, readPart }
   */
  async function open(read, fileSize) {
    const head = await read(0, 0x48);
    const magic = String.fromCharCode(head[0], head[1], head[2], head[3]);
    const rvz = magic === 'RVZ\x01';
    if (!rvz && magic !== 'WIA\x01') fail('Це не образ RVZ.');
    const discSize = be32(head, 0x0C);
    const isoSize = be64(head, 0x24);
    if (fileSize && be64(head, 0x2C) !== fileSize) fail('Файл RVZ неповний або пошкоджений (розмір не збігається). Завантажте його ще раз.');
    const d = await read(0x48, discSize);
    const discType = be32(d, 0), comp = be32(d, 4), chunk = be32(d, 0x0C);
    if (discType !== 2) fail(discType === 1 ? 'Це образ GameCube, а не Wii.' : 'Невідомий тип диска.');
    if (![0, 4, 5].includes(comp) || (comp === 4 && rvz)) {
      fail('Цей образ стиснено методом, який сторінка не читає. Конвертуйте його в Dolphin у RVZ зі стисненням Zstandard.');
    }
    if (chunk < SECTOR || chunk % SECTOR) fail('Пошкоджений образ RVZ (розмір блоку).');
    const header = d.slice(0x10, 0x90);
    const nPart = be32(d, 0x90), partT = be32(d, 0x94), partOff = be64(d, 0x98);
    const nRaw = be32(d, 0xB4), rawOff = be64(d, 0xB8), rawSize = be32(d, 0xC0);
    const nGroups = be32(d, 0xC4), groupOff = be64(d, 0xC8), groupSize = be32(d, 0xD0);

    const decompress = (u, size) => {
      if (comp === 5) return fzstd.decompress(u);
      if (comp === 4) return UaLzma.lzma2Raw(u, size || u.length * 4);
      return u;
    };

    const pt = await read(partOff, nPart * partT);
    const parts = [];
    for (let i = 0; i < nPart; i++) {
      const p = new Uint8Array(0x30);
      p.set(pt.subarray(i * partT, i * partT + Math.min(partT, 0x30)));
      const pd = [0, 1].map((k) => ({
        firstSector: be32(p, 0x10 + k * 16), nSectors: be32(p, 0x14 + k * 16),
        groupIndex: be32(p, 0x18 + k * 16), nGroups: be32(p, 0x1C + k * 16),
      }));
      parts.push({ key: p.slice(0, 16), pd, firstSector: pd[0].firstSector, nSectors: pd[0].nSectors + pd[1].nSectors });
    }

    const rt = decompress(await read(rawOff, rawSize), nRaw * 0x18);
    const raws = [];
    for (let i = 0; i < nRaw; i++) {
      let off = be64(rt, i * 0x18), size = be64(rt, i * 0x18 + 8);
      const down = off % SECTOR; off -= down; size += down;
      raws.push({ off, size, groupIndex: be32(rt, i * 0x18 + 0x10), nGroups: be32(rt, i * 0x18 + 0x14) });
    }

    const gEntry = rvz ? 12 : 8;
    const gt = decompress(await read(groupOff, groupSize), nGroups * gEntry);
    const groups = [];
    for (let i = 0; i < nGroups; i++) {
      const o = i * gEntry, size = be32(gt, o + 4);
      groups.push({
        off: be32(gt, o) * 4,
        size: rvz ? size & 0x7FFFFFFF : size,
        compressed: rvz ? size >>> 31 === 1 : comp !== 0,
        packed: rvz ? be32(gt, o + 8) : 0,
      });
    }

    // ---- one group -> { data, exceptions: [{ off, hash }] }
    const cache = new Map();
    async function group(gi, dataSize, nLists, junkBase) {
      const keyC = gi;
      if (cache.has(keyC)) { const v = cache.get(keyC); cache.delete(keyC); cache.set(keyC, v); return v; }
      const g = groups[gi];
      if (!g) fail('Пошкоджений образ RVZ (немає групи даних).');
      let res;
      if (g.size === 0) res = { data: new Uint8Array(dataSize), exceptions: [] };
      else {
        let u = await read(g.off, g.size);
        if (g.compressed) u = decompress(u, dataSize + nLists * 2 + 0x10000);
        let p = 0;
        const exceptions = [];
        for (let l = 0; l < nLists; l++) {
          const n = be16(u, p); p += 2;
          for (let k = 0; k < n; k++, p += 22) exceptions.push({ list: l, off: be16(u, p), hash: u.slice(p + 2, p + 22) });
        }
        if (nLists && !g.compressed) p = (p + 3) & ~3;
        let data;
        if (g.packed) {
          data = new Uint8Array(dataSize);
          let o = 0;
          const end = g.compressed ? u.length : Math.min(u.length, p + g.packed);
          while (p < end && o < dataSize) {
            let size = be32(u, p); p += 4;
            if (size & 0x80000000) {
              size &= 0x7FFFFFFF;
              junk(u.subarray(p, p + 68), (junkBase + o) % SECTOR, data, o, Math.min(size, dataSize - o));
              p += 68;
            } else {
              data.set(u.subarray(p, p + size), o);
              p += size;
            }
            o += size;
          }
        } else {
          data = u.subarray(p, p + dataSize);
          if (data.length < dataSize) { const z = new Uint8Array(dataSize); z.set(data); data = z; }
        }
        res = { data, exceptions };
      }
      cache.set(keyC, res);
      if (cache.size > 6) cache.delete(cache.keys().next().value);
      return res;
    }

    /** Bytes of the image outside Wii partition data (header, partition headers, update partition…). */
    async function readRaw(off, len) {
      const out = new Uint8Array(len);
      for (const r of raws) {
        const a = Math.max(off, r.off), b = Math.min(off + len, r.off + r.size);
        if (a >= b) continue;
        for (let i = Math.floor((a - r.off) / chunk); i < r.nGroups; i++) {
          const from = r.off + i * chunk, to = Math.min(from + chunk, r.off + r.size);
          if (from >= b) break;
          const g = await group(r.groupIndex + i, to - from, 0, from);
          const s = Math.max(a, from), e = Math.min(b, to);
          out.set(g.data.subarray(s - from, e - from), s - off);
        }
      }
      if (off < 0x80) out.set(header.subarray(off, Math.min(0x80, off + len)), 0);
      return out;
    }

    /**
     * Decrypted data of the partition's clusters [first, first+n) (cluster 0 = the partition's first data sector)
     * -> { data: n*0x7C00 bytes, exceptions: [{ cluster, off (0..0x3FF in the cluster's hash area), hash }] }
     */
    async function readPart(part, first, n) {
      const data = new Uint8Array(n * DATA), exceptions = [];
      const perChunk = chunk / SECTOR, listSpan = chunk >= GROUP ? GROUP / SECTOR : perChunk;
      const nLists = chunk >= GROUP ? chunk / GROUP : 1;
      for (const pd of part.pd) {
        if (!pd.nSectors) continue;
        const pdStart = pd.firstSector - part.firstSector; // in clusters
        const a = Math.max(first, pdStart), b = Math.min(first + n, pdStart + pd.nSectors);
        if (a >= b) continue;
        for (let i = Math.floor((a - pdStart) / perChunk); i < pd.nGroups; i++) {
          const c0 = pdStart + i * perChunk, c1 = Math.min(c0 + perChunk, pdStart + pd.nSectors);
          if (c0 >= b) break;
          const g = await group(pd.groupIndex + i, (c1 - c0) * DATA, nLists, c0 * DATA);
          const s = Math.max(a, c0), e = Math.min(b, c1);
          data.set(g.data.subarray((s - c0) * DATA, (e - c0) * DATA), (s - first) * DATA);
          for (const x of g.exceptions) {
            const cluster = c0 + x.list * listSpan + (x.off >>> 10);
            if (cluster >= s && cluster < e) exceptions.push({ cluster, off: x.off & 0x3FF, hash: x.hash });
          }
        }
      }
      return { data, exceptions };
    }

    return { kind: rvz ? 'RVZ' : 'WIA', size: isoSize, chunk, header, parts, readRaw, readPart };
  }

  return { open, junk, DiscError, SECTOR, DATA, HASHES, GROUP, be32, be64 };
});
