// Press Start UA – a Wii disc in the browser: partitions, the file system (FST), hashes H0–H3, encryption,
// fake signing, and the new image with the translated files, streamed out as ISO or WBFS.
// The disc layout follows wiibrew.org/wiki/Wii_disc. Licence: GPL-3.0-or-later (https://github.com/press-start-ua/launcher).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./sha1.js'), require('./rvz.js'));
  else root.UaWii = factory(root.UaSha1, root.UaRvz);
})(typeof self !== 'undefined' ? self : this, function (UaSha1, UaRvz) {
  'use strict';

  const { SECTOR, DATA, HASHES, be32, be64, DiscError } = UaRvz;
  const CLUSTERS = 64; // clusters in one 2 MiB hash group
  const fail = (m) => { throw new DiscError(m); };
  const put32 = (u, o, v) => { u[o] = v >>> 24; u[o + 1] = (v >>> 16) & 255; u[o + 2] = (v >>> 8) & 255; u[o + 3] = v & 255; };
  const put64 = (u, o, v) => { put32(u, o, Math.floor(v / 0x100000000)); put32(u, o + 4, v >>> 0); };
  const ascii = (u, o, n) => { let s = ''; for (let i = 0; i < n && u[o + i]; i++) s += String.fromCharCode(u[o + i]); return s; };
  const subtle = () => globalThis.crypto.subtle;

  // ---------------------------------------------------------------- hashes

  /**
   * Hash area (0x400 bytes per cluster) for one 2 MiB group.
   * data: up to 64*0x7C00 bytes (missing clusters count as zeros); exceptions: [{ cluster (0..63), off, hash }].
   * -> { hashes: Uint8Array(64*0x400), h3: Uint8Array(20) }
   */
  const ZERO_CLUSTER = new Uint8Array(DATA);
  function hashGroup(data, exceptions) {
    const hashes = new Uint8Array(CLUSTERS * HASHES);
    const n = Math.ceil(data.length / DATA);
    for (let c = 0; c < CLUSTERS; c++) {
      const src = c < n ? data : ZERO_CLUSTER, base = c < n ? c * DATA : 0;
      if (c < n && (c + 1) * DATA > data.length) fail('internal: partial cluster');
      for (let b = 0; b < 31; b++) UaSha1.into(src, base + b * 0x400, 0x400, hashes, c * HASHES + b * 20);
    }
    const h1 = new Uint8Array(8 * 0xA0), h2 = new Uint8Array(0xA0);
    for (let s = 0; s < 8; s++) {
      for (let j = 0; j < 8; j++) UaSha1.into(hashes, (s * 8 + j) * HASHES, 0x26C, h1, s * 0xA0 + j * 20);
      UaSha1.into(h1, s * 0xA0, 0xA0, h2, s * 20);
    }
    for (let c = 0; c < CLUSTERS; c++) {
      hashes.set(h1.subarray((c >> 3) * 0xA0, ((c >> 3) + 1) * 0xA0), c * HASHES + 0x280);
      hashes.set(h2, c * HASHES + 0x340);
    }
    if (exceptions) for (const x of exceptions) hashes.set(x.hash, x.cluster * HASHES + x.off);
    // H3 is the hash of the H2 table as written (after exceptions) of cluster 0
    const h3 = UaSha1.digest(hashes.subarray(0x340, 0x340 + 0xA0));
    return { hashes, h3 };
  }

  /** Encrypt one group: n clusters of data + their hash areas -> n*0x8000 bytes of disc. */
  async function encryptGroup(key, data, hashes, n) {
    const out = new Uint8Array(n * SECTOR), zero = new Uint8Array(16);
    const aes = async (iv, u) => new Uint8Array(await subtle().encrypt({ name: 'AES-CBC', iv }, key, u)).subarray(0, u.length);
    await Promise.all(Array.from({ length: n }, async (_, c) => {
      const h = await aes(zero, hashes.subarray(c * HASHES, (c + 1) * HASHES));
      out.set(h, c * SECTOR);
      out.set(await aes(h.slice(0x3D0, 0x3E0), data.subarray(c * DATA, (c + 1) * DATA)), c * SECTOR + HASHES);
    }));
    return out;
  }

  const importKey = (raw) => subtle().importKey('raw', raw, { name: 'AES-CBC' }, false, ['encrypt']);

  // ---------------------------------------------------------------- disc layout

  /** Partitions from the partition table at 0x40000 -> [{ off, type, header fields }] */
  async function partitions(disc) {
    const t = await disc.readRaw(0x40000, 0x20);
    const out = [];
    for (let i = 0; i < 4; i++) {
      const count = be32(t, i * 8), tOff = be32(t, i * 8 + 4) * 4;
      if (!count) continue;
      const e = await disc.readRaw(tOff, count * 8);
      for (let k = 0; k < count; k++) out.push({ off: be32(e, k * 8) * 4, type: be32(e, k * 8 + 4), table: i });
    }
    for (const p of out) {
      const h = await disc.readRaw(p.off, 0x2C0);
      p.ticket = h.slice(0, 0x2A4);
      p.tmdSize = be32(h, 0x2A4); p.tmdOff = be32(h, 0x2A8) * 4;
      p.certSize = be32(h, 0x2AC); p.certOff = be32(h, 0x2B0) * 4;
      p.h3Off = be32(h, 0x2B4) * 4; p.dataOff = be32(h, 0x2B8) * 4; p.dataSize = be32(h, 0x2BC) * 4;
      p.rvz = disc.parts.find((x) => x.firstSector * SECTOR === p.off + p.dataOff) || null;
    }
    return out;
  }

  /** Read decrypted partition data at any offset (in the 0x7C00-per-cluster space). */
  async function readData(disc, rp, off, len) {
    const first = Math.floor(off / DATA), last = Math.floor((off + len - 1) / DATA);
    const r = await disc.readPart(rp, first, last - first + 1);
    return r.data.slice(off - first * DATA, off - first * DATA + len);
  }

  /** The file system of a partition -> { boot, fst, fstOff, fstSize, files: Map(path -> { entry, off, size }) } */
  async function fileSystem(disc, rp) {
    const boot = await readData(disc, rp, 0, 0x440);
    const fstOff = be32(boot, 0x424) * 4, fstSize = be32(boot, 0x428) * 4;
    const fst = await readData(disc, rp, fstOff, fstSize);
    const n = be32(fst, 8), names = n * 12;
    const files = new Map();
    const name = (i) => {
      let o = names + (be32(fst, i * 12) & 0xFFFFFF), s = [];
      while (fst[o]) s.push(fst[o++]);
      return new TextDecoder('latin1').decode(new Uint8Array(s));
    };
    const walk = (dir, end, prefix) => {
      let i = dir;
      while (i < end) {
        const isDir = fst[i * 12] === 1, nm = name(i);
        if (isDir) { const next = be32(fst, i * 12 + 8); walk(i + 1, next, prefix + nm + '/'); i = next; }
        else { files.set(prefix + nm, { entry: i, off: be32(fst, i * 12 + 4) * 4, size: be32(fst, i * 12 + 8) }); i++; }
      }
    };
    walk(1, n, 'files/');
    return { boot, fst, fstOff, fstSize, files, gameId: ascii(boot, 0, 6), title: ascii(boot, 0x20, 0x40) };
  }

  // ---------------------------------------------------------------- new layout

  const ALIGN = 0x20;
  const up = (v, a) => Math.ceil(v / a) * a;

  /** The system area of a partition (boot, bi2, apploader, main.dol, FST) as [from, to) ranges of data. */
  async function systemRanges(disc, rp, fsys) {
    const app = await readData(disc, rp, 0x2440, 0x20);
    const appEnd = 0x2440 + 0x20 + be32(app, 0x14) + be32(app, 0x18);
    const dolOff = be32(fsys.boot, 0x420) * 4;
    const dh = await readData(disc, rp, dolOff, 0x100);
    let dolSize = 0x100;
    for (let i = 0; i < 18; i++) dolSize = Math.max(dolSize, be32(dh, i * 4) + be32(dh, 0x90 + i * 4));
    return [[0, appEnd], [dolOff, dolOff + dolSize], [fsys.fstOff, fsys.fstOff + fsys.fstSize]];
  }

  /**
   * Where the changed files go. A file stays at its place when it fits there (with the free space after it),
   * else it goes into the smallest free gap of the partition that fits it.
   * The partition may grow up to maxEnd (as wit does when it rebuilds a disc): the space after its data.
   * changes: Map(path -> bytes) -> { fst (new), writes: [[off, bytes]], used: [[from, to]], nSectors }
   */
  function plan(fsys, sys, changes, dataEnd, maxEnd) {
    const ranges = sys.map((r) => r.slice());
    for (const [path, f] of fsys.files) if (!changes.has(path) && f.size) ranges.push([f.off, f.off + f.size]);
    const gapsOf = () => {
      ranges.sort((a, b) => a[0] - b[0]);
      const gaps = [];
      let at = 0;
      for (const [a, b] of ranges) { if (a > at) gaps.push([at, a]); at = Math.max(at, b); }
      if (Math.max(dataEnd, maxEnd || 0) > at) gaps.push([at, Math.max(dataEnd, maxEnd || 0)]);
      return gaps;
    };
    const fst = fsys.fst.slice(), writes = [];
    const order = [...changes.keys()].sort((a, b) => changes.get(b).length - changes.get(a).length);
    for (const path of order) {
      const bytes = changes.get(path), f = fsys.files.get(path), need = bytes.length;
      const gaps = gapsOf();
      let off = -1;
      const home = gaps.find(([a, b]) => f.off >= a && f.off < b);
      if (home && f.off + need <= home[1]) off = f.off;
      else {
        let best = null;
        for (const [a, b] of gaps) {
          const s = up(a, ALIGN);
          if (s + need <= b && (!best || b - a < best[1] - best[0])) best = [a, b];
        }
        if (!best) fail('У розділі гри не вистачає вільного місця для перекладених файлів.');
        off = up(best[0], ALIGN);
      }
      ranges.push([off, off + Math.max(need, 1)]);
      put32(fst, f.entry * 12 + 4, off / 4);
      put32(fst, f.entry * 12 + 8, need);
      writes.push([off, bytes]);
    }
    writes.push([fsys.fstOff, fst]);
    ranges.sort((a, b) => a[0] - b[0]);
    const end = Math.max(dataEnd, ...writes.map(([o, b]) => o + b.length));
    return { fst, writes, used: ranges, nSectors: Math.ceil(end / DATA) };
  }

  // ---------------------------------------------------------------- TMD

  /** Fake signing (the "trucha" way, as wit does): zero signature, then find a filler whose SHA-1 starts with 00. */
  function fakesign(tmd) {
    tmd.fill(0, 4, 0x104);
    const body = tmd.subarray(0x140), h = new Uint8Array(20), at = 0x1D4 - 0x140; // reserved bytes of the TMD
    for (let i = 0; i < 0x100000000; i++) {
      put32(body, at, i);
      UaSha1.into(body, 0, body.length, h, 0);
      if (h[0] === 0) return tmd;
    }
    fail('Не вдалося підписати TMD.');
  }

  // ---------------------------------------------------------------- building the new image

  const BLOCK = 0x200000; // WBFS sector and the unit in which the image is streamed out

  /**
   * Everything needed to stream the new image: per partition, its groups and what changed in them.
   * ctx: { disc, parts (from partitions()), main (the game partition), plan (for main) }
   */
  async function prepareBuild(disc, parts, main, pl, progress) {
    const rp = main.rvz, nSectors = Math.max(rp.nSectors, pl.nSectors);
    // which hash groups the writes touch, and the bytes going into each; new clusters of a grown partition too
    const touched = new Map();
    for (let g = Math.floor(rp.nSectors / CLUSTERS); g * CLUSTERS < nSectors && nSectors > rp.nSectors; g++) touched.set(g, []);
    for (const [off, bytes] of pl.writes) {
      for (let g = Math.floor(off / (CLUSTERS * DATA)); g * CLUSTERS * DATA < off + bytes.length; g++) {
        if (!touched.has(g)) touched.set(g, []);
        touched.get(g).push([off, bytes]);
      }
    }
    if (Math.max(-1, ...touched.keys()) * CLUSTERS >= nSectors) fail('internal: write past the partition');
    const h3 = await disc.readRaw(main.off + main.h3Off, 0x18000);
    const groups = new Map();
    let i = 0;
    for (const [g, ws] of touched) {
      const n = Math.min(CLUSTERS, nSectors - g * CLUSTERS);
      const { data } = await disc.readPart(rp, g * CLUSTERS, n); // clusters past the old end read as zeros
      const base = g * CLUSTERS * DATA;
      for (const [off, bytes] of ws) {
        const a = Math.max(off, base), b = Math.min(off + bytes.length, base + data.length);
        data.set(bytes.subarray(a - off, b - off), a - base);
      }
      const { hashes, h3: entry } = hashGroup(data); // a changed group gets clean hashes, no exceptions
      h3.set(entry, g * 20);
      groups.set(g, { data, hashes });
      if (progress) progress(++i, touched.size);
    }
    const tmd = await disc.readRaw(main.off + main.tmdOff, main.tmdSize);
    const header = await disc.readRaw(main.off + 0x2BC, 4);
    put32(header, 0, nSectors * SECTOR / 4); // partition data size
    if (!touched.size) return { main, groups, h3, tmd, header, nSectors }; // nothing changed: the original, signed TMD stays
    const nContents = (tmd[0x1DE] << 8) | tmd[0x1DF];
    if (nContents < 1) fail('Пошкоджений TMD.');
    tmd.set(UaSha1.digest(h3), 0x1F4); // contents[0].sha1: content records start at 0x1E4, the hash is at +0x10
    fakesign(tmd);
    return { main, groups, h3, tmd, header, nSectors };
  }

  /** Used parts of the disc (2 MiB blocks) for WBFS: headers and every cluster with data the game reads. */
  async function usedBlocks(disc, parts, main, pl) {
    const n = Math.ceil(disc.size / BLOCK), used = new Uint8Array(n);
    const mark = (a, b) => { for (let i = Math.floor(a / BLOCK); i * BLOCK < b && i < n; i++) used[i] = 1; };
    mark(0, 0x50000);
    for (const p of parts) {
      mark(p.off, p.off + p.dataOff);
      if (!p.rvz) continue;
      let ranges;
      if (p === main) ranges = pl.used;
      else {
        const fsys = await fileSystem(disc, p.rvz);
        ranges = (await systemRanges(disc, p.rvz, fsys)).concat([...fsys.files.values()].filter((f) => f.size).map((f) => [f.off, f.off + f.size]));
      }
      const start = p.off + p.dataOff;
      for (const [a, b] of ranges) mark(start + Math.floor(a / DATA) * SECTOR, start + Math.ceil(b / DATA) * SECTOR);
    }
    return used;
  }

  /**
   * Stream the new image block by block (2 MiB of disc each, the last one shorter).
   * want(i) -> whether block i is needed (WBFS skips unused ones); emit(i, bytes) is awaited in order.
   */
  async function build(disc, parts, prep, want, emit, progress) {
    const nBlocks = Math.ceil(disc.size / BLOCK);
    const keys = new Map();
    for (const p of parts) if (p.rvz) keys.set(p, await importKey(p.rvz.key));
    const main = prep.main, sectors = (p) => (p === main ? prep.nSectors : p.rvz.nSectors);
    const regions = parts.filter((p) => p.rvz).map((p) => ({ p, start: p.off + p.dataOff, end: p.off + p.dataOff + sectors(p) * SECTOR }))
      .sort((a, b) => a.start - b.start);
    const overlays = [ // raw areas that change: data size, H3 table and TMD of the game partition
      [main.off + 0x2BC, prep.header], [main.off + main.h3Off, prep.h3], [main.off + main.tmdOff, prep.tmd],
    ];
    let encCache = null; // { p, g, bytes } – the last encrypted group, shared by the blocks it covers
    const groupBytes = async (p, g) => {
      if (encCache && encCache.p === p && encCache.g === g) return encCache.bytes;
      const rp = p.rvz, n = Math.min(CLUSTERS, sectors(p) - g * CLUSTERS);
      let data, hashes;
      const changed = p === main && prep.groups.get(g);
      if (changed) ({ data, hashes } = changed);
      else {
        const r = await disc.readPart(rp, g * CLUSTERS, n);
        data = r.data;
        ({ hashes } = hashGroup(data, r.exceptions.map((x) => ({ ...x, cluster: x.cluster - g * CLUSTERS }))));
      }
      encCache = { p, g, bytes: await encryptGroup(keys.get(p), data, hashes, n) };
      return encCache.bytes;
    };
    for (let i = 0; i < nBlocks; i++) {
      if (!want(i)) continue;
      const a = i * BLOCK, b = Math.min(disc.size, a + BLOCK), out = new Uint8Array(b - a);
      let at = a;
      while (at < b) {
        const r = regions.find((x) => at >= x.start && at < x.end);
        if (r) {
          const gSize = CLUSTERS * SECTOR, g = Math.floor((at - r.start) / gSize);
          const bytes = await groupBytes(r.p, g), gStart = r.start + g * gSize;
          const e = Math.min(b, gStart + bytes.length);
          out.set(bytes.subarray(at - gStart, e - gStart), at - a);
          at = e;
        } else {
          const next = Math.min(b, ...regions.filter((x) => x.start > at).map((x) => x.start));
          out.set(await disc.readRaw(at, next - at), at - a);
          at = next;
        }
      }
      for (const [o, u] of overlays) {
        const s = Math.max(a, o), e = Math.min(b, o + u.length);
        if (s < e) out.set(u.subarray(s - o, e - o), s - a);
      }
      await emit(i, out);
      if (progress) progress(i + 1, nBlocks);
    }
  }

  // ---------------------------------------------------------------- WBFS

  const WBFS_DISC_SECTORS = 143432 * 2; // Wii sectors of a dual-layer disc: the size of the block table

  /** The WBFS header block for the used blocks (in order) -> { head: Uint8Array(BLOCK), map: Map(disc block -> file block) } */
  function wbfsHead(header, used) {
    const nWbfs = (WBFS_DISC_SECTORS * SECTOR) / BLOCK; // 4482 entries
    const head = new Uint8Array(BLOCK), map = new Map();
    let next = 1;
    used.forEach((u, i) => { if (u) map.set(i, next++); });
    const total = next * BLOCK;
    head.set([0x57, 0x42, 0x46, 0x53]); // WBFS
    put32(head, 4, total / 512);
    head[8] = 9; head[9] = 21; head[10] = 1;
    head[12] = 1; // disc slot 0 used
    head.set(header.subarray(0, 0x100), 512);
    for (const [disc, file] of map) {
      if (disc >= nWbfs) fail('Образ завеликий для WBFS.');
      head[512 + 0x100 + disc * 2] = file >> 8; head[512 + 0x100 + disc * 2 + 1] = file & 255;
    }
    return { head, map, size: total };
  }

  return {
    hashGroup, encryptGroup, importKey, partitions, readData, fileSystem, systemRanges, plan, fakesign,
    prepareBuild, usedBlocks, build, wbfsHead,
    CLUSTERS, BLOCK, put32, put64, ascii, be32, be64, DiscError,
  };
});
