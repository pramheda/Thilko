#!/usr/bin/env python3
"""Generate minimal placeholder PNG icons for the extension.

Produces solid colored squares with a small accent dot in the lower-right
corner. Two variants:
  - icon-{N}.png:              connected    (indigo base, green dot)
  - icon-{N}-disconnected.png: disconnected (indigo base, red dot)

Sizes: 16, 32, 48, 128.

Pure-stdlib (zlib + struct). No Pillow required. Replace at any time with
real artwork — file names are the contract.
"""

from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

INDIGO = (79, 70, 229)
GREEN = (34, 197, 94)
RED = (220, 38, 38)


def make_png(size: int, base_rgb: tuple[int, int, int], dot_rgb: tuple[int, int, int]) -> bytes:
    """Render a square of base_rgb with a small dot in the bottom-right corner."""
    # Dot is roughly 30% the side, anchored at bottom-right with small inset.
    dot_radius = max(2, size // 4)
    inset = max(1, size // 10)
    cx, cy = size - inset - dot_radius, size - inset - dot_radius

    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            # Distance to dot center.
            dx, dy = x - cx, y - cy
            if dx * dx + dy * dy <= dot_radius * dot_radius:
                r, g, b = dot_rgb
            else:
                r, g, b = base_rgb
            row.extend([r, g, b, 255])
        # Filter byte (0 = None) + row bytes.
        rows.append(b"\x00" + bytes(row))
    raw = b"".join(rows)

    # PNG file structure: signature, IHDR, IDAT, IEND.
    def chunk(typ: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + typ + data + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA, no filter, no interlace
    idat = zlib.compress(raw, 9)
    iend = b""

    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", iend)


def write(filename: str, data: bytes) -> None:
    path = OUT / filename
    path.write_bytes(data)
    print(f"  wrote {path.relative_to(OUT.parent.parent)} ({len(data)} bytes)")


def main() -> int:
    # Connected: indigo base with a small GREEN dot in the bottom-right corner.
    for size in (16, 32, 48, 128):
        write(f"icon-{size}.png", make_png(size, INDIGO, GREEN))
    # Disconnected: same base, RED dot. Background swaps atomically.
    for size in (16, 32, 48, 128):
        write(f"icon-{size}-disconnected.png", make_png(size, INDIGO, RED))
    return 0


if __name__ == "__main__":
    sys.exit(main())
