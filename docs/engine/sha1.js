// Press Start UA – SHA-1 without WebCrypto. A Wii disc needs millions of hashes of 1 KiB blocks
// (31 for every 32 KiB), and one asynchronous WebCrypto call per block costs more than the hash itself.
// Licence: GPL-3.0-or-later (https://github.com/press-start-ua/launcher).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UaSha1 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const W = new Int32Array(80);
  const H = new Int32Array(5);

  function block(d, p) {
    for (let i = 0; i < 16; i++, p += 4) W[i] = (d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3];
    for (let i = 16; i < 80; i++) { const x = W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16]; W[i] = (x << 1) | (x >>> 31); }
    let a = H[0], b = H[1], c = H[2], e = H[4], dd = H[3];
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & dd); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ dd; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & dd) | (c & dd); k = 0x8F1BBCDC | 0; }
      else { f = b ^ c ^ dd; k = 0xCA62C1D6 | 0; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + W[i]) | 0;
      e = dd; dd = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + dd) | 0; H[4] = (H[4] + e) | 0;
  }

  const tail = new Uint8Array(128);

  /** SHA-1 of data[off, off+len) written as 20 bytes into out[outOff…]. */
  function into(data, off, len, out, outOff) {
    H[0] = 0x67452301; H[1] = 0xEFCDAB89 | 0; H[2] = 0x98BADCFE | 0; H[3] = 0x10325476; H[4] = 0xC3D2E1F0 | 0;
    const end = off + len, full = off + (len & ~63);
    let p = off;
    for (; p < full; p += 64) block(data, p);
    const rest = end - p;
    tail.fill(0);
    for (let i = 0; i < rest; i++) tail[i] = data[p + i];
    tail[rest] = 0x80;
    const n = rest < 56 ? 64 : 128;
    const bits = len * 8;
    const hi = Math.floor(bits / 0x100000000), lo = bits >>> 0;
    tail[n - 8] = hi >>> 24; tail[n - 7] = hi >>> 16; tail[n - 6] = hi >>> 8; tail[n - 5] = hi;
    tail[n - 4] = lo >>> 24; tail[n - 3] = lo >>> 16; tail[n - 2] = lo >>> 8; tail[n - 1] = lo;
    block(tail, 0);
    if (n === 128) block(tail, 64);
    for (let i = 0; i < 5; i++) {
      const v = H[i];
      out[outOff++] = v >>> 24; out[outOff++] = (v >>> 16) & 255; out[outOff++] = (v >>> 8) & 255; out[outOff++] = v & 255;
    }
    return out;
  }

  const hex = (u) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
  const digest = (u) => into(u, 0, u.length, new Uint8Array(20), 0);
  const sha1Hex = (u) => hex(digest(u));

  return { into, digest, sha1Hex, hex };
});
