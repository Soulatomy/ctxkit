// Generates build/icon.png (1024x1024 RGBA) with no external dependencies.
// Design: rounded dark tile + accent ring + offset dot (the "◍" mark).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "build", "icon.png");

const BG = [15, 17, 21, 255];
const ACCENT = [79, 140, 255, 255];
const ACCENT_SOFT = [126, 173, 255, 255];
const TRANSPARENT = [0, 0, 0, 0];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

const RADIUS = 190;
function insideRoundedRect(x, y) {
  const r = RADIUS;
  const w = SIZE;
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), w - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function pixel(x, y) {
  if (!insideRoundedRect(x, y)) return TRANSPARENT;
  const dx = x - SIZE / 2;
  const dy = y - SIZE / 2;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Outer accent ring (r 250..320)
  if (dist >= 250 && dist <= 320) {
    const t = (dist - 250) / 70;
    const edge = Math.min(1, Math.min(dist - 250, 320 - dist) / 6);
    return [
      Math.round(lerp(ACCENT[0], ACCENT_SOFT[0], t)),
      Math.round(lerp(ACCENT[1], ACCENT_SOFT[1], t)),
      Math.round(lerp(ACCENT[2], ACCENT_SOFT[2], t)),
      Math.round(255 * Math.max(0, edge)),
    ];
  }
  // Filled center dot (r <= 120)
  if (dist <= 120) {
    const edge = Math.min(1, (120 - dist) / 6);
    return [ACCENT[0], ACCENT[1], ACCENT[2], Math.round(255 * Math.max(0.15, edge))];
  }
  // Inner soft glow makes the tile read less flat.
  const glow = Math.max(0, 1 - dist / 512) * 18;
  return [BG[0] + glow, BG[1] + glow, BG[2] + glow * 1.4, 255];
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let offset = 0;
for (let y = 0; y < SIZE; y++) {
  raw[offset++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b, a] = pixel(x, y);
    raw[offset++] = r;
    raw[offset++] = g;
    raw[offset++] = b;
    raw[offset++] = a;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${png.length} bytes)`);
