// node tests/engine_apply_files.js PATCH DATA_DIR: applies every file of the patch to DATA_DIR/<path>, checks result_sha1.
const fs = require('fs'), path = require('path');
const P = require('../docs/engine/uapatch.js'), S = require('../docs/engine/sha1.js');
const [patch, dir] = process.argv.slice(2);
const { head, blob } = P.parse(new Uint8Array(fs.readFileSync(patch)));
let ok = 0;
for (const f of head.files) {
  const out = P.applyFile(f, new Uint8Array(fs.readFileSync(path.join(dir, f.path))), blob);
  if (S.sha1Hex(out) === f.result_sha1) ok++; else console.log('DIFF', f.path);
}
console.log(head.game, ok + '/' + head.files.length, 'files match result_sha1');
