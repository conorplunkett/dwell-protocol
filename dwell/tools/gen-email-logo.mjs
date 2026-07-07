// Usage: node dwell/tools/gen-email-logo.mjs [out.png]
// Rasterize dwell/web/assets/logo.svg to a transparent PNG in pure Node.
// The mark is eight red circles with swept fill-opacity — trivially exact to
// rasterize (16x supersampling for smooth edges), and this avoids headless-
// browser flakiness entirely. Output: 176×176 RGBA PNG (@4x of the 44px
// display size used in the email header).
import fs from "node:fs";
import zlib from "node:zlib";

const SIZE = 176;             // output px (viewBox 200 → scale)
const SS = 4;                 // supersample factor per axis (16 samples/px)
const S = SIZE / 200;         // svg-unit → px

// Dots exactly as in assets/logo.svg: [cx, cy, r=15, fill-opacity]
const DOTS = [
  [100, 35, 1], [145.96, 54.04, .08], [165, 100, .22], [145.96, 145.96, .38],
  [100, 165, .55], [54.04, 145.96, .72], [35, 100, .88], [54.04, 54.04, .95],
].map(([cx, cy, o]) => [cx * S, cy * S, 15 * S, o]);

// Per-pixel coverage-weighted alpha, red channel constant (#ff0000).
const px = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const X = x + (sx + 0.5) / SS, Y = y + (sy + 0.5) / SS;
      for (const [cx, cy, r, o] of DOTS) {
        const dx = X - cx, dy = Y - cy;
        if (dx * dx + dy * dy <= r * r) { a += o; break; } // dots don't overlap
      }
    }
    const i = (y * SIZE + x) * 4;
    px[i] = 255; px[i + 1] = 0; px[i + 2] = 0;
    px[i + 3] = Math.round((a / (SS * SS)) * 255);
  }
}

// Minimal PNG encoder: IHDR + IDAT (filter 0 scanlines, zlib) + IEND.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) px.copy(raw, y * (1 + SIZE * 4) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
const out = process.argv[2] || "logo-email.png";
fs.writeFileSync(out, png);
console.log("wrote", out, png.length, "bytes");
