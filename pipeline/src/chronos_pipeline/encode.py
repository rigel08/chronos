"""Bundle format 3 encodings and deterministic precompression (D-024, D-025).

Triangle indices are stored per render part, relative to the part's first vertex, delta-coded, zigzag-mapped
and written as LEB128 varints. Measured on the 1.2 bundle (2.75 M triangles): 31.5 MiB raw -> 7.9 MiB raw,
0.48 MiB with brotli, the same as spike 003's best lossless option, at a quarter of the memory.
Decoding is one sequential pass (`decode_triangles` here; `decodeTriangles` in apps/web).
"""
from __future__ import annotations

import gzip
import hashlib

import numpy as np


def zigzag(d: np.ndarray) -> np.ndarray:
    d = d.astype(np.int64)
    return ((d << 1) ^ (d >> 63)).astype(np.uint64)


def unzigzag(z: np.ndarray) -> np.ndarray:
    z = z.astype(np.uint64)
    return ((z >> np.uint64(1)).astype(np.int64)) ^ -((z & np.uint64(1)).astype(np.int64))


def leb128(values: np.ndarray) -> bytes:
    """Unsigned LEB128 for every value (vectorised). Values must be < 2**35."""
    v = values.astype(np.uint64)
    if len(v) and int(v.max()) >= 1 << 35:
        raise ValueError("leb128: value too large")
    n = np.ones(len(v), np.int64)
    for k in (7, 14, 21, 28):
        n += v >= np.uint64(1 << k)
    out = np.zeros(int(n.sum()), np.uint8)
    pos = np.concatenate([[0], np.cumsum(n)[:-1]]).astype(np.int64)
    for k in range(5):
        m = n > k
        byte = (v[m] >> np.uint64(7 * k)) & np.uint64(0x7F)
        cont = np.where(n[m] > k + 1, 0x80, 0).astype(np.uint64)
        out[pos[m] + k] = (byte | cont).astype(np.uint8)
    return out.tobytes()


def read_leb128(buf: bytes, count: int) -> np.ndarray:
    """Decode `count` LEB128 values (reference decoder for tests and the build's round-trip check)."""
    a = np.frombuffer(buf, np.uint8)
    ends = np.nonzero(a < 0x80)[0]
    if len(ends) != count or (count and ends[-1] != len(a) - 1):
        raise ValueError(f"leb128: expected {count} values, found {len(ends)}")
    starts = np.concatenate([[0], ends[:-1] + 1])
    out = np.zeros(count, np.uint64)
    for k in range(5):
        m = starts + k <= ends
        out[m] |= (a[starts[m] + k].astype(np.uint64) & np.uint64(0x7F)) << np.uint64(7 * k)
    return out


def _part_deltas(triangles: np.ndarray, part_triangle_start: np.ndarray, part_first_vertex: np.ndarray) -> np.ndarray:
    counts = np.diff(part_triangle_start.astype(np.int64)).astype(np.int64)
    part_of = np.repeat(np.arange(len(counts)), counts)
    local = triangles.astype(np.int64) - part_first_vertex.astype(np.int64)[part_of]
    if len(local) and (local.min() < 0):
        raise ValueError("triangle index below its part's first vertex")
    prev = np.empty_like(local)
    if len(local):
        prev[1:] = local[:-1]
        prev[0] = 0
        prev[part_triangle_start[:-1][counts > 0].astype(np.int64)] = 0
    return local - prev


def encode_triangles(triangles: np.ndarray, part_triangle_start: np.ndarray, part_first_vertex: np.ndarray) -> bytes:
    return leb128(zigzag(_part_deltas(triangles, part_triangle_start, part_first_vertex)))


def decode_triangles(buf: bytes, part_triangle_start: np.ndarray, part_first_vertex: np.ndarray) -> np.ndarray:
    counts = np.diff(part_triangle_start.astype(np.int64)).astype(np.int64)
    deltas = unzigzag(read_leb128(buf, int(counts.sum())))
    cs = np.cumsum(deltas)
    base = np.concatenate([[0], cs])[part_triangle_start[:-1].astype(np.int64)]
    out = cs - np.repeat(base, counts) + np.repeat(part_first_vertex.astype(np.int64), counts)
    return out.astype(np.uint32)


def compressed(data: bytes, brotli_quality: int, brotli_lgwin: int, gzip_level: int) -> dict[str, bytes]:
    """Deterministic precompressed copies: brotli (pinned library version) and gzip with mtime 0."""
    import brotli  # type: ignore[import-untyped]
    return {"br": brotli.compress(data, quality=brotli_quality, lgwin=brotli_lgwin),
            "gz": gzip.compress(data, compresslevel=gzip_level, mtime=0)}


def content_name(stem: str, data: bytes, ext: str, n: int = 12) -> str:
    """Immutable, content-hashed file name, e.g. geometry.3f2a9c1d0b7e.bin."""
    return f"{stem}.{hashlib.sha256(data).hexdigest()[:n]}{ext}"
