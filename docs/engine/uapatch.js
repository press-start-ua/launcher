// Press Start UA – the .uapatch format in the browser: the same as uapatch/core.py and apply.py of the launcher.
// .uapatch: 'UAPATCH1\n' · u32 BE header length · JSON header · .xz with the deltas.
// The Yaz0 encoder and the delta format match the Python code byte for byte, so the files are the same.
// Licence: GPL-3.0-or-later (https://github.com/press-start-ua/launcher).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./lzma.js'), require('./sha1.js'));
  else root.UaPatch = factory(root.UaLzma, root.UaSha1);
})(typeof self !== 'undefined' ? self : this, function (UaLzma, UaSha1) {
  'use strict';

  const MAGIC = 'UAPATCH1\n', FORMAT = 1;
  class PatchError extends Error {}

  function yaz0Decode(src) {
    const size = ((src[4] << 24) | (src[5] << 16) | (src[6] << 8) | src[7]) >>> 0;
    const dst = new Uint8Array(size);
    let si = 16, di = 0;
    while (di < size) {
      const code = src[si++];
      for (let bit = 0; bit < 8 && di < size; bit++) {
        if (code & (0x80 >> bit)) { dst[di++] = src[si++]; continue; }
        const b1 = src[si], b2 = src[si + 1]; si += 2;
        const dist = (((b1 & 0xF) << 8) | b2) + 1;
        let n = b1 >> 4;
        if (n === 0) n = src[si++] + 0x12; else n += 2;
        for (let i = 0, from = di - dist; i < n; i++) dst[di++] = dst[from + i];
      }
    }
    return dst;
  }

  /** Greedy LZ77 (window 4096, match 3..273) with hash chains of depth 48, as yaz0_encode in core.py. */
  function yaz0Encode(data, depth = 48) {
    const n = data.length;
    let out = new Uint8Array(16 + n + Math.ceil(n / 8) + 64), o = 16;
    out.set([0x59, 0x61, 0x7A, 0x30, n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
    const chains = new Map();
    const key = (j) => (data[j] << 16) | (data[j + 1] << 8) | data[j + 2];
    let i = 0;
    while (i < n) {
      const codePos = o++;
      let code = 0;
      for (let bit = 0; bit < 8; bit++) {
        if (i >= n) break;
        let bestLen = 0, bestPos = 0;
        if (i + 3 <= n) {
          const cand = chains.get(key(i));
          if (cand) {
            const limit = Math.min(273, n - i), lo = i - 4096;
            for (let c = cand.length - 1, stop = Math.max(0, cand.length - depth); c >= stop; c--) {
              const p = cand[c];
              if (p < lo) break;
              if (bestLen >= limit || data[p + bestLen] !== data[i + bestLen]) continue;
              let k = 3;
              while (k < limit && data[p + k] === data[i + k]) k++;
              if (k > bestLen) {
                bestLen = k; bestPos = p;
                if (k === limit) break;
              }
            }
          }
        }
        let step;
        if (bestLen >= 3) {
          const dist = i - bestPos - 1;
          if (bestLen >= 0x12) { out[o++] = dist >> 8; out[o++] = dist & 0xFF; out[o++] = bestLen - 0x12; }
          else { out[o++] = ((bestLen - 2) << 4) | (dist >> 8); out[o++] = dist & 0xFF; }
          step = bestLen;
        } else {
          code |= 0x80 >> bit;
          out[o++] = data[i];
          step = 1;
        }
        for (let j = i, e = Math.min(i + step, n - 2); j < e; j++) {
          const k = key(j), l = chains.get(k);
          if (l) l.push(j); else chains.set(k, [j]);
        }
        i += step;
      }
      out[codePos] = code;
    }
    o += (0x20 - (o % 0x20)) % 0x20; // zero padding to 0x20, as in core.py
    return out.slice(0, o);
  }

  function readVarint(b, p) {
    let v = 0, mul = 1;
    for (;;) {
      const c = b[p.i++];
      if (c === undefined) throw new PatchError('Пошкоджений патч.');
      v += (c & 0x7F) * mul; mul *= 128;
      if (c < 0x80) return v;
    }
  }

  /** Ops: varint len<<1 + literal bytes, or varint len<<1|1 + varint source offset. */
  function deltaApply(src, delta) {
    const parts = [], p = { i: 0 };
    let total = 0;
    while (p.i < delta.length) {
      const v = readVarint(delta, p), n = Math.floor(v / 2);
      if (v % 2) {
        const off = readVarint(delta, p);
        parts.push(src.subarray(off, off + n));
      } else {
        parts.push(delta.subarray(p.i, p.i + n));
        p.i += n;
      }
      total += parts[parts.length - 1].length;
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const u of parts) { out.set(u, o); o += u.length; }
    return out;
  }

  /** .uapatch bytes -> { head, blob }. */
  function parse(bytes) {
    const magic = new TextEncoder().encode(MAGIC);
    for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) throw new PatchError('Файл патчу пошкоджено або це не патч.');
    let p = magic.length;
    const n = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
    p += 4;
    const head = JSON.parse(new TextDecoder().decode(bytes.subarray(p, p + n)));
    if (head.format !== FORMAT) throw new PatchError('Цей патч новішого формату. Оновіть сторінку.');
    const size = Math.max(0, ...head.files.map((f) => f.offset + f.size));
    return { head, blob: UaLzma.xz(bytes.subarray(p + n), size) };
  }

  /** Check one clean file of the disc before patching (as apply_files). Throws PatchError. */
  function check(f, cur) {
    const s = UaSha1.sha1Hex(cur);
    if (s === f.result_sha1 || (s !== f.src_sha1 && cur[0] === 0x59 && cur[1] === 0x61 && cur[2] === 0x7A && cur[3] === 0x30
        && UaSha1.sha1Hex(yaz0Decode(cur)) === f.dst_sha1)) {
      throw new PatchError('Цей образ уже перекладено. Потрібен оригінальний образ гри.');
    }
    if (s !== f.src_sha1) {
      throw new PatchError(`Файл ${f.path} відрізняється від оригіналу. Потрібен чистий, не змінений образ гри (тієї ж ревізії диска).`);
    }
  }

  /** The new bytes of one file (checked first). */
  function applyFile(f, cur, blob) {
    check(f, cur);
    const out = deltaApply(f.yaz0 ? yaz0Decode(cur) : cur, blob.subarray(f.offset, f.offset + f.size));
    if (UaSha1.sha1Hex(out) !== f.dst_sha1) throw new PatchError(`Не вдалося застосувати патч до ${f.path}.`);
    return f.yaz0 ? yaz0Encode(out) : out;
  }

  const xmlAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  /** riivolution_xml of apply.py. paths: "files/…" paths that go into the pack. */
  function riivolutionXml(head, paths) {
    const rv = head.riivolution, game = head.game, pid = rv.root.toLowerCase() + '_' + game;
    const files = paths.map((p) => `    <file disc="/${p.slice(6)}" external="${game}/${p.slice(6)}" />`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<wiidisc version="1" root="/${rv.root}">
  <id game="${game.slice(0, 3)}">
    <region type="${game[3]}" />
  </id>
  <options>
    <section name="${xmlAttr(rv.section)}">
      <option name="Ukrainian translation" default="1">
        <choice name="Enabled">
          <patch id="${pid}" />
        </choice>
      </option>
    </section>
  </options>
  <patch id="${pid}">
${files}
  </patch>
</wiidisc>
`;
  }

  return { parse, check, applyFile, riivolutionXml, yaz0Decode, yaz0Encode, deltaApply, PatchError };
});
