// node tests/engine_uapatch.js PATCH [FILE...]: prints sha1 of the unpacked blob and of yaz0Encode(FILE) for comparing with Python.
const fs = require('fs');
const P = require('../docs/engine/uapatch.js'), S = require('../docs/engine/sha1.js');
const [patch, ...files] = process.argv.slice(2);
let t = Date.now();
const { head, blob } = P.parse(new Uint8Array(fs.readFileSync(patch)));
console.log('blob', blob.length, S.sha1Hex(blob), Date.now() - t + 'ms', head.game, head.files.length + ' files');
for (const f of files) {
  const d = new Uint8Array(fs.readFileSync(f));
  t = Date.now();
  const e = P.yaz0Encode(d);
  console.log('yaz0', f.split('/').pop(), S.sha1Hex(e), Date.now() - t + 'ms', S.sha1Hex(P.yaz0Decode(e)) === S.sha1Hex(d));
}
