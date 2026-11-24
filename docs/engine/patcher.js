// Press Start UA – the whole job, as uapatch/apply.py does it with wit: open the player's image, check every file,
// apply the translation, and stream out ISO, WBFS or a Riivolution pack. Used by the web page (in a worker) and by
// the Node tests in tests/. Licence: GPL-3.0-or-later (https://github.com/press-start-ua/launcher).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./rvz.js'), require('./wii.js'), require('./uapatch.js'), require('./sha1.js'));
  } else root.UaPatcher = factory(root.UaRvz, root.UaWii, root.UaPatch, root.UaSha1);
})(typeof self !== 'undefined' ? self : this, function (UaRvz, UaWii, UaPatch, UaSha1) {
  'use strict';

  const { DiscError } = UaRvz;
  const WBFS_SPLIT = 0xFFFF8000; // 4 GiB - 32 KiB: the part size USB loaders expect on FAT32
  const quiet = () => {};

  /** read(off, len) -> Promise<Uint8Array>. -> the image: its game ID, title and file system. */
  async function openImage(read, fileSize) {
    const disc = await UaRvz.open(read, fileSize);
    const parts = await UaWii.partitions(disc);
    const main = parts.find((p) => p.type === 0 && p.rvz);
    if (!main) throw new DiscError('На диску не знайдено розділу з грою.');
    const fsys = await UaWii.fileSystem(disc, main.rvz);
    return { disc, parts, main, fsys, gameId: UaWii.ascii(disc.header, 0, 6), rev: disc.header[7], title: fsys.title };
  }

  async function readFile(img, path) {
    const f = img.fsys.files.get(path);
    if (!f) throw new UaPatch.PatchError(`В образі немає файлу ${path}. Образ пошкоджений або змінений.`);
    return UaWii.readData(img.disc, img.main.rvz, f.off, f.size);
  }

  /** Check every file first, then apply them all (as apply_files). -> Map(path -> new bytes) */
  async function applyPatch(img, patch, log = quiet, progress = quiet) {
    const { head, blob } = patch;
    if (img.gameId !== head.game) throw new UaPatch.PatchError(`Цей патч для диска ${head.game}, а образ — ${img.gameId}.`);
    const cur = new Map();
    for (const f of head.files) {
      const bytes = await readFile(img, f.path);
      UaPatch.check(f, bytes);
      cur.set(f.path, bytes);
    }
    const changes = new Map();
    head.files.forEach((f, i) => {
      log(`  [${i + 1}/${head.files.length}] ${f.path}`);
      const out = UaPatch.applyFile(f, cur.get(f.path), blob);
      if (UaSha1.sha1Hex(out) !== f.result_sha1) log(`  (${f.path}: інший результат стиснення Yaz0, вміст той самий)`);
      changes.set(f.path, out);
      progress(i + 1, head.files.length);
    });
    return changes;
  }

  /** The plan and the changed hash groups for an image with these changes. */
  async function prepare(img, changes, progress = quiet) {
    const sys = await UaWii.systemRanges(img.disc, img.main.rvz, img.fsys);
    // the partition may grow up to the next partition or the end of the disc
    const start = img.main.off + img.main.dataOff;
    const limit = Math.min(img.disc.size, ...img.parts.filter((p) => p.off > img.main.off).map((p) => p.off));
    const maxEnd = Math.floor((limit - start) / UaRvz.SECTOR) * UaRvz.DATA;
    const pl = UaWii.plan(img.fsys, sys, changes, img.main.rvz.nSectors * UaRvz.DATA, maxEnd);
    const prep = await UaWii.prepareBuild(img.disc, img.parts, img.main, pl, progress);
    return { pl, prep };
  }

  /** sink: { write(bytes) } awaited in order. The whole ISO (4.7 GB for a single-layer disc). */
  async function writeIso(img, job, sink, progress = quiet) {
    await UaWii.build(img.disc, img.parts, job.prep, () => true, (i, bytes) => sink.write(bytes), progress);
  }

  /** WBFS: only the used 2 MiB blocks. part(i) -> sink for file i (0: .wbfs, 1: .wbf1, …). -> number of files */
  async function writeWbfs(img, job, part, progress = quiet) {
    const used = await UaWii.usedBlocks(img.disc, img.parts, img.main, job.pl);
    const { head, size } = UaWii.wbfsHead(img.disc.header, used);
    let file = 0, inFile = 0, sink = await part(0);
    const put = async (u) => {
      let p = 0;
      while (p < u.length) {
        if (inFile === WBFS_SPLIT) { if (sink.close) await sink.close(); sink = await part(++file); inFile = 0; }
        const n = Math.min(u.length - p, WBFS_SPLIT - inFile);
        await sink.write(u.subarray(p, p + n));
        p += n; inFile += n;
      }
    };
    await put(head);
    const total = used.reduce((a, b) => a + b, 0);
    let done = 0;
    await UaWii.build(img.disc, img.parts, job.prep, (i) => used[i] === 1, async (i, bytes) => {
      if (bytes.length < UaWii.BLOCK) { const z = new Uint8Array(UaWii.BLOCK); z.set(bytes); bytes = z; }
      await put(bytes);
      progress(++done, total);
    });
    if (sink.close) await sink.close();
    return { files: file + 1, size };
  }

  /** Riivolution pack: [{ name, data }] as patch_riivolution writes it (riivolution/*.xml and <root>/<game>/…). */
  function riivolution(head, changes) {
    const rv = head.riivolution, skip = new Set(rv.skip || []);
    const paths = [...changes.keys()].filter((p) => !skip.has(p)).sort();
    const files = paths.map((p) => ({ name: `${rv.root}/${head.game}/${p.slice(6)}`, data: changes.get(p) }));
    files.unshift({ name: `riivolution/${rv.root}_${head.game}.xml`, data: new TextEncoder().encode(UaPatch.riivolutionXml(head, paths)) });
    return files;
  }

  // ---------------------------------------------------------------- zip (stored, no compression)

  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(u) { let c = 0xFFFFFFFF; for (let i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

  /** [{ name, data }] -> zip bytes (store method, UTF-8 names). */
  function zip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let off = 0;
    const le = (n, v) => { const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = (v >>> (8 * i)) & 255; return u; };
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
      const common = [le(2, 20), le(2, 0x0800), le(2, 0), le(2, 0), le(2, 0x21), le(4, crc), le(4, size), le(4, size), le(2, name.length), le(2, 0)];
      const local = [le(4, 0x04034b50), ...common, name];
      central.push([le(4, 0x02014b50), le(2, 20), ...common, le(2, 0), le(2, 0), le(2, 0), le(4, 0), le(4, off), name]);
      for (const u of local) { parts.push(u); off += u.length; }
      parts.push(f.data); off += size;
    }
    let cSize = 0;
    for (const c of central) for (const u of c) { parts.push(u); cSize += u.length; }
    parts.push(le(4, 0x06054b50), le(2, 0), le(2, 0), le(2, files.length), le(2, files.length), le(4, cSize), le(4, off), le(2, 0));
    const total = parts.reduce((a, u) => a + u.length, 0), out = new Uint8Array(total);
    let p = 0;
    for (const u of parts) { out.set(u, p); p += u.length; }
    return out;
  }

  return { openImage, readFile, applyPatch, prepare, writeIso, writeWbfs, riivolution, zip, crc32, WBFS_SPLIT };
});
