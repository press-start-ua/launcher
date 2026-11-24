// Press Start UA – LZMA / LZMA2 / .xz decoder for the browser.
// .uapatch deltas are packed by Python's lzma.compress (an .xz stream with one LZMA2 block); RVZ and WIA
// images may use LZMA or LZMA2 too. Written from Igor Pavlov's LZMA specification (public domain).
// Checksums of the .xz container are not checked: every patched file is checked by its SHA-1 afterwards.
// Licence: GPL-3.0-or-later (https://github.com/press-start-ua/launcher).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UaLzma = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class LzmaError extends Error {}
  const fail = (m) => { throw new LzmaError(m || 'Пошкоджені стиснені дані.'); };

  /** Output that grows; the whole output is the dictionary. */
  class Out {
    constructor(size) { this.buf = new Uint8Array(size || 1 << 16); this.pos = 0; }
    need(n) {
      if (this.pos + n <= this.buf.length) return;
      let len = this.buf.length * 2;
      while (len < this.pos + n) len *= 2;
      const b = new Uint8Array(len); b.set(this.buf.subarray(0, this.pos)); this.buf = b;
    }
    result() { return this.buf.subarray(0, this.pos); }
  }

  class Range {
    constructor(buf, pos, end) {
      this.buf = buf; this.pos = pos; this.end = end;
      if (buf[pos] !== 0) fail();
      this.pos++;
      this.range = 0xFFFFFFFF; this.code = 0;
      for (let i = 0; i < 4; i++) this.code = this.code * 256 + buf[this.pos++];
      if (this.code === this.range) fail();
    }
    norm() {
      if (this.range < 0x1000000) {
        if (this.pos >= this.end) fail('Стиснені дані обірвано.');
        this.range *= 256; this.code = this.code * 256 + this.buf[this.pos++];
      }
    }
    bit(p, i) {
      const v = p[i], bound = (this.range >>> 11) * v;
      let r;
      if (this.code < bound) { this.range = bound; p[i] = v + ((2048 - v) >>> 5); r = 0; }
      else { this.range -= bound; this.code -= bound; p[i] = v - (v >>> 5); r = 1; }
      this.norm();
      return r;
    }
    direct(n) {
      let res = 0;
      while (n--) {
        this.range = Math.floor(this.range / 2);
        let b = 0;
        if (this.code >= this.range) { this.code -= this.range; b = 1; }
        res = res * 2 + b;
        this.norm();
      }
      return res;
    }
    tree(p, base, bits) {
      let m = 1;
      for (let i = 0; i < bits; i++) m = (m << 1) + this.bit(p, base + m);
      return m - (1 << bits);
    }
    rtree(p, base, bits) {
      let m = 1, sym = 0;
      for (let i = 0; i < bits; i++) { const b = this.bit(p, base + m); m = (m << 1) + b; sym |= b << i; }
      return sym;
    }
  }

  // probability array layout
  const IS_MATCH = 0, IS_REP = 192, IS_REP_G0 = 204, IS_REP_G1 = 216, IS_REP_G2 = 228, IS_REP0_LONG = 240;
  const POS_SLOT = 432, POS_DEC = POS_SLOT + 256, ALIGN = POS_DEC + 115, LEN = ALIGN + 16, REP_LEN = LEN + 514, LIT = REP_LEN + 514;
  // length coder: choice 0, choice2 1, low 2 + 16*8, mid 130 + 16*8, high 258 + 256

  class Lzma {
    constructor(out) { this.out = out; this.lc = this.lp = this.pb = 0; }
    props(lc, lp, pb) {
      if (lc > 8 || lp > 4 || pb > 4) fail();
      this.lc = lc; this.lp = lp; this.pb = pb;
      this.probs = new Uint16Array(LIT + (0x300 << (lc + lp)));
    }
    reset() {
      this.probs.fill(1024);
      this.state = 0; this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
    }
    len(rc, base, posState) {
      const p = this.probs;
      if (!rc.bit(p, base)) return rc.tree(p, base + 2 + posState * 8, 3);
      if (!rc.bit(p, base + 1)) return 8 + rc.tree(p, base + 130 + posState * 8, 3);
      return 16 + rc.tree(p, base + 258, 8);
    }
    /** Decode until `size` more bytes are out (size -1: until the end marker). */
    run(rc, size, start) {
      const p = this.probs, o = this.out, lc = this.lc, lpMask = (1 << this.lp) - 1, pbMask = (1 << this.pb) - 1;
      const stop = size < 0 ? Infinity : o.pos + size;
      let state = this.state, rep0 = this.rep0, rep1 = this.rep1, rep2 = this.rep2, rep3 = this.rep3;
      while (o.pos < stop) {
        const pos = o.pos, posState = pos & pbMask;
        if (!rc.bit(p, IS_MATCH + (state << 4) + posState)) {
          const prev = pos > start ? o.buf[pos - 1] : 0;
          const base = LIT + 0x300 * (((pos & lpMask) << lc) + (prev >>> (8 - lc)));
          let sym = 1;
          if (state >= 7) {
            if (pos - rep0 - 1 < start) fail();
            let mb = o.buf[pos - rep0 - 1];
            do {
              const mbit = (mb >>> 7) & 1; mb <<= 1;
              const b = rc.bit(p, base + ((1 + mbit) << 8) + sym);
              sym = (sym << 1) | b;
              if (mbit !== b) break;
            } while (sym < 0x100);
          }
          while (sym < 0x100) sym = (sym << 1) | rc.bit(p, base + sym);
          o.need(1);
          o.buf[o.pos++] = sym & 0xFF;
          state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
          continue;
        }
        let len;
        if (rc.bit(p, IS_REP + state)) {
          if (pos === start) fail();
          if (!rc.bit(p, IS_REP_G0 + state)) {
            if (!rc.bit(p, IS_REP0_LONG + (state << 4) + posState)) {
              state = state < 7 ? 9 : 11;
              o.need(1); o.buf[o.pos] = o.buf[o.pos - rep0 - 1]; o.pos++;
              continue;
            }
          } else {
            let d;
            if (!rc.bit(p, IS_REP_G1 + state)) d = rep1;
            else {
              if (!rc.bit(p, IS_REP_G2 + state)) d = rep2; else { d = rep3; rep3 = rep2; }
              rep2 = rep1;
            }
            rep1 = rep0; rep0 = d;
          }
          len = this.len(rc, REP_LEN, posState);
          state = state < 7 ? 8 : 11;
        } else {
          rep3 = rep2; rep2 = rep1; rep1 = rep0;
          len = this.len(rc, LEN, posState);
          state = state < 7 ? 7 : 10;
          const slot = rc.tree(p, POS_SLOT + (len < 3 ? len : 3) * 64, 6);
          if (slot < 4) rep0 = slot;
          else {
            const nd = (slot >>> 1) - 1;
            let d = (2 | (slot & 1)) * 2 ** nd;
            if (slot < 14) d += rc.rtree(p, POS_DEC + d - slot, nd);
            else d += rc.direct(nd - 4) * 16 + rc.rtree(p, ALIGN, 4);
            if (d === 0xFFFFFFFF) { // end marker
              if (size >= 0) fail();
              break;
            }
            rep0 = d;
          }
        }
        len += 2;
        if (o.pos - rep0 - 1 < start) fail();
        if (o.pos + len > stop) fail();
        o.need(len);
        const b = o.buf;
        for (let i = 0, s = o.pos - rep0 - 1; i < len; i++) b[o.pos + i] = b[s + i];
        o.pos += len;
      }
      this.state = state; this.rep0 = rep0; this.rep1 = rep1; this.rep2 = rep2; this.rep3 = rep3;
    }
  }

  function propsByte(lz, b) {
    if (b >= 9 * 5 * 5) fail();
    lz.props(b % 9, Math.floor(b / 9) % 5, Math.floor(b / 45));
  }

  /** LZMA2 chunks from buf[pos…] into out. -> end position. */
  function lzma2(buf, pos, out, start) {
    const lz = new Lzma(out);
    let needProps = true;
    for (;;) {
      if (pos >= buf.length) fail('Стиснені дані обірвано.');
      const c = buf[pos++];
      if (c === 0) return pos;
      if (c === 1 || c === 2) {
        const n = ((buf[pos] << 8) | buf[pos + 1]) + 1; pos += 2;
        if (pos + n > buf.length) fail();
        out.need(n); out.buf.set(buf.subarray(pos, pos + n), out.pos); out.pos += n; pos += n;
        continue;
      }
      if (c < 0x80) fail();
      const unpacked = ((c & 0x1F) << 16) + ((buf[pos] << 8) | buf[pos + 1]) + 1;
      const packed = ((buf[pos + 2] << 8) | buf[pos + 3]) + 1;
      pos += 4;
      const mode = (c >>> 5) & 3;
      if (mode >= 2) { propsByte(lz, buf[pos++]); needProps = false; }
      else if (needProps) fail();
      if (mode >= 1) lz.reset();
      const rc = new Range(buf, pos, pos + packed);
      lz.run(rc, unpacked, start);
      pos += packed;
    }
  }

  function varint(buf, p) {
    let v = 0, mul = 1;
    for (let i = 0; i < 9; i++) {
      const b = buf[p.i++];
      v += (b & 0x7F) * mul; mul *= 128;
      if (b < 0x80) return v;
    }
    fail();
  }

  /** A whole .xz stream (as Python's lzma.compress writes it) -> Uint8Array. */
  function xz(buf, sizeHint) {
    const magic = [0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00];
    for (let i = 0; i < 6; i++) if (buf[i] !== magic[i]) fail('Це не архів xz.');
    const out = new Out(sizeHint || buf.length * 4);
    let pos = 12;
    for (;;) {
      const hs = buf[pos];
      if (hs === 0) break; // index: no more blocks
      const headerSize = (hs + 1) * 4, p = { i: pos + 2 };
      const flags = buf[pos + 1];
      if (flags & 0x40) varint(buf, p);
      if (flags & 0x80) varint(buf, p);
      const nFilters = (flags & 3) + 1;
      if (nFilters !== 1) fail('Непідтримуваний архів xz.');
      if (varint(buf, p) !== 0x21) fail('Непідтримуваний архів xz.');
      varint(buf, p); // props size (1: the dictionary size, not needed: the output is the dictionary)
      const blockStart = out.pos, dataStart = pos + headerSize;
      let end = lzma2(buf, dataStart, out, 0);
      end += (4 - ((end - dataStart) % 4)) % 4; // block padding
      const check = buf[7] & 0x0F;
      end += check === 0 ? 0 : check === 1 ? 4 : check === 4 ? 8 : check === 10 ? 32 : fail('Непідтримуваний архів xz.');
      pos = end;
      if (out.pos === blockStart) break;
    }
    return out.result();
  }

  /** Raw LZMA (RVZ/WIA: 5 bytes of props from the disc struct, no header in the data) -> exactly size bytes. */
  function lzmaRaw(buf, props, size) {
    const out = new Out(size), lz = new Lzma(out);
    propsByte(lz, props[0]);
    lz.reset();
    lz.run(new Range(buf, 0, buf.length), size, 0);
    return out.result();
  }

  /** Raw LZMA2 (RVZ/WIA) -> Uint8Array. */
  function lzma2Raw(buf, size) {
    const out = new Out(size);
    lzma2(buf, 0, out, 0);
    return out.result();
  }

  return { xz, lzmaRaw, lzma2Raw, LzmaError };
});
