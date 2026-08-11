/**
 * Generates the PWA icon set with no image-library dependency.
 *
 * Why hand-rolled: iOS ignores SVG for `apple-touch-icon`, and maskable icons must be
 * raster PNGs with a full-bleed background. Pulling in sharp/canvas for four flat
 * geometric images is not worth the install weight, so this writes PNGs directly
 * (IHDR/IDAT/IEND + CRC32, pixels deflated with node's zlib).
 *
 * Mark: a ring with a filled badge dot at the upper right — a reminder, orbiting.
 * Maskable variants keep the mark inside the central 40%-radius safe zone.
 *
 *   node scripts/generate-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public/icons');

const BG = [30, 27, 75];        // #1E1B4B  indigo-950, matches manifest theme_color
const FG = [238, 242, 255];     // #EEF2FF  indigo-50
const ACCENT = [129, 140, 248]; // #818CF8  indigo-400

// ---------------------------------------------------------------- PNG encoding

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** @param {number} size @param {Uint8Array} rgba length size*size*4 */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  // 10..12 = compression/filter/interlace, all 0

  // Each scanline is prefixed with filter type 0 (None).
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- drawing

/**
 * Signed-distance coverage with 3x3 supersampling, so edges are antialiased
 * rather than jagged. `sdf` returns negative inside the shape.
 */
function coverage(px, py, sdf) {
  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      if (sdf(px + (sx + 0.5) / 3, py + (sy + 0.5) / 3) < 0) hits++;
    }
  }
  return hits / 9;
}

function blend(target, i, color, alpha) {
  if (alpha <= 0) return;
  for (let c = 0; c < 3; c++) {
    target[i + c] = Math.round(target[i + c] * (1 - alpha) + color[c] * alpha);
  }
  target[i + 3] = Math.round(target[i + 3] * (1 - alpha) + 255 * alpha);
}

/**
 * @param {number} size
 * @param {number} scale  mark radius as a fraction of the canvas half-width.
 *                        0.40 keeps it inside the maskable safe zone; ~0.62 fills
 *                        the frame for the plain/apple variants.
 * @param {boolean} rounded  round the background corners (plain icons only —
 *                           maskable icons must be full-bleed, and iOS applies
 *                           its own mask to apple-touch-icon).
 */
function drawIcon(size, scale, rounded) {
  const rgba = new Uint8Array(size * size * 4);

  // Background, optionally with rounded corners.
  const cornerR = size * 0.22;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const a = rounded
        ? coverage(x, y, (fx, fy) => {
            // Rounded-rect SDF.
            const dx = Math.abs(fx - size / 2) - (size / 2 - cornerR);
            const dy = Math.abs(fy - size / 2) - (size / 2 - cornerR);
            const ox = Math.max(dx, 0);
            const oy = Math.max(dy, 0);
            return Math.min(Math.max(dx, dy), 0) + Math.hypot(ox, oy) - cornerR;
          })
        : 1;
      blend(rgba, i, BG, a);
    }
  }

  const cx = size / 2;
  const cy = size / 2;
  const R = (size / 2) * scale;          // ring outer radius
  const ringW = R * 0.26;                // stroke width
  const dotR = R * 0.30;                 // badge dot radius
  // Badge sits on the ring at 45° upper-right, the way a notification badge does.
  const dotX = cx + R * Math.SQRT1_2;
  const dotY = cy - R * Math.SQRT1_2;
  const gap = ringW * 0.55;              // knock the ring out behind the badge

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      const ring = coverage(x, y, (fx, fy) => {
        const d = Math.abs(Math.hypot(fx - cx, fy - cy) - (R - ringW / 2)) - ringW / 2;
        // Subtract a disc around the badge so the two shapes read as separate.
        // CSG subtraction is max(sdA, -sdB); `-sdB` is the negated disc distance.
        const negDisc = dotR + gap - Math.hypot(fx - dotX, fy - dotY);
        return Math.max(d, negDisc);
      });
      blend(rgba, i, FG, ring);

      const dot = coverage(x, y, (fx, fy) => Math.hypot(fx - dotX, fy - dotY) - dotR);
      blend(rgba, i, ACCENT, dot);
    }
  }

  return encodePng(size, rgba);
}

// ---------------------------------------------------------------- emit

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  // [filename, size, markScale, roundedCorners]
  ['icon-192.png', 192, 0.62, true],
  ['icon-512.png', 512, 0.62, true],
  // 0.38 not 0.40: the badge extends to ~1.007R from centre, so 0.38 keeps the
  // whole mark inside the maskable safe zone (central 40% radius).
  ['maskable-192.png', 192, 0.38, false],
  ['maskable-512.png', 512, 0.38, false],
  // iOS applies its own squircle mask and shows no transparency, so: square, full-bleed.
  ['apple-touch-icon-180.png', 180, 0.56, false],
  ['favicon-32.png', 32, 0.66, true],
];

for (const [name, size, scale, rounded] of targets) {
  const png = drawIcon(size, scale, rounded);
  writeFileSync(resolve(OUT_DIR, name), png);
  console.log(`${name}  ${size}x${size}  ${png.length} bytes`);
}
