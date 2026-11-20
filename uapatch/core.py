"""Patch file format and the byte-level parts shared by every game: Yaz0, delta, hashes.

A .uapatch file:
    MAGIC, u32 big-endian header length, JSON header (UTF-8), LZMA-compressed deltas.
The header names the disc (game ID6), the title, the version and every changed file:
    path (inside the data partition), yaz0 (compared unpacked), src_sha1 (clean file),
    dst_sha1 (patched, unpacked), result_sha1 (the file written), offset/size in the blob.
Riivolution settings (folder name, menu title, files to skip) travel in the header too, so a
new game needs only a new patch, never a new program.

Standard library only. The Yaz0 encoder and the delta format are the same as in the older
per-game patchers (patch_ua.py), so a converted patch gives byte-identical files.
"""
import hashlib, json, lzma, struct

MAGIC = b'UAPATCH1\n'
FORMAT = 1


class PatchError(Exception):
    """A problem to show to the user (in Ukrainian), without a traceback."""


def yaz0_decode(src):
    size = struct.unpack('>I', src[4:8])[0]
    dst = bytearray()
    si = 16
    while len(dst) < size:
        code = src[si]; si += 1
        for bit in range(8):
            if len(dst) >= size:
                break
            if code & (0x80 >> bit):
                dst.append(src[si]); si += 1
            else:
                b1, b2 = src[si], src[si + 1]; si += 2
                dist = ((b1 & 0xF) << 8 | b2) + 1
                n = b1 >> 4
                if n == 0:
                    n = src[si] + 0x12; si += 1
                else:
                    n += 2
                start = len(dst) - dist
                for i in range(n):
                    dst.append(dst[start + i])
    return bytes(dst)


def yaz0_encode(data, depth=48):
    """Greedy LZ77 (window 4096, match 3..273) with hash chains."""
    n = len(data)
    out = bytearray(b'Yaz0' + struct.pack('>I', n) + bytes(8))
    chains = {}
    i = 0
    while i < n:
        code_pos = len(out)
        out.append(0)
        code = 0
        for bit in range(8):
            if i >= n:
                break
            best_len, best_pos = 0, 0
            if i + 3 <= n:
                cand = chains.get(data[i:i + 3])
                if cand:
                    limit = min(273, n - i)
                    lo = i - 4096
                    for p in reversed(cand[-depth:]):
                        if p < lo:
                            break
                        if data[p + best_len] != data[i + best_len] if best_len < limit else True:
                            continue
                        k = 3
                        while k < limit and data[p + k] == data[i + k]:
                            k += 1
                        if k > best_len:
                            best_len, best_pos = k, p
                            if k == limit:
                                break
            if best_len >= 3:
                dist = i - best_pos - 1
                if best_len >= 0x12:
                    out += bytes((dist >> 8, dist & 0xFF, best_len - 0x12))
                else:
                    out += bytes(((best_len - 2) << 4 | dist >> 8, dist & 0xFF))
                step = best_len
            else:
                code |= 0x80 >> bit
                out.append(data[i])
                step = 1
            for j in range(i, min(i + step, n - 2)):
                chains.setdefault(data[j:j + 3], []).append(j)
            i += step
        out[code_pos] = code
    out += bytes(-len(out) % 0x20)
    return bytes(out)


def read_varint(b, p):
    v = shift = 0
    while True:
        c = b[p]; p += 1
        v |= (c & 0x7F) << shift
        shift += 7
        if c < 0x80:
            return v, p


def delta_apply(src, delta):
    """Ops: varint len<<1 + literal bytes, or varint len<<1|1 + varint source offset."""
    out = bytearray()
    p = 0
    while p < len(delta):
        v, p = read_varint(delta, p)
        n = v >> 1
        if v & 1:
            off, p = read_varint(delta, p)
            out += src[off:off + n]
        else:
            out += delta[p:p + n]
            p += n
    return bytes(out)


def sha1(b):
    return hashlib.sha1(b).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def read_patch(path):
    """-> (header dict, blob bytes)."""
    with open(path, 'rb') as f:
        b = f.read()
    if b[:len(MAGIC)] != MAGIC:
        raise PatchError('Файл патчу пошкоджено або це не патч.')
    p = len(MAGIC)
    n = struct.unpack('>I', b[p:p + 4])[0]
    p += 4
    head = json.loads(b[p:p + n].decode('utf-8'))
    if head.get('format') != FORMAT:
        raise PatchError('Цей патч новішого формату. Оновіть програму.')
    return head, lzma.decompress(b[p + n:])


def write_patch(path, head, blob):
    head = dict(head, format=FORMAT)
    h = json.dumps(head, ensure_ascii=False).encode('utf-8')
    with open(path, 'wb') as f:
        f.write(MAGIC + struct.pack('>I', len(h)) + h + lzma.compress(bytes(blob), preset=9))
