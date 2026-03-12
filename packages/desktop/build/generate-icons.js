/**
 * Generate app icons for AutoLander Electron app.
 * Pure Node.js - no external dependencies required.
 * Renders the Lucide CarFront icon on the brand blue gradient
 * to match the in-app logo exactly.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BUILD_DIR = __dirname;

// Brand colors from tailwind.config.js
const BRAND_500 = { r: 38, g: 101, b: 255 };  // #2665ff
const BRAND_700 = { r: 29, g: 76, b: 161 };   // #1d4ca1

// ---- PNG generation (raw, no canvas needed) ----

function createPNG(width, height, drawFn) {
  const pixels = Buffer.alloc(width * height * 4);
  drawFn(pixels, width, height);

  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0;
    pixels.copy(rawData, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressed = zlib.deflateSync(rawData, { level: 9 });
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; ihdrData[9] = 6;
  const ihdr = makeChunk('IHDR', ihdrData);
  const idat = makeChunk('IDAT', compressed);
  const iend = makeChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

function makeChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput) >>> 0, 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function setPixel(pixels, width, x, y, r, g, b, a) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || x >= width || y < 0) return;
  const idx = (y * width + x) * 4;
  if (idx + 3 >= pixels.length) return;
  if (a < 255 && pixels[idx + 3] > 0) {
    const srcA = a / 255;
    const dstA = pixels[idx + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA > 0) {
      pixels[idx] = Math.round((r * srcA + pixels[idx] * dstA * (1 - srcA)) / outA);
      pixels[idx + 1] = Math.round((g * srcA + pixels[idx + 1] * dstA * (1 - srcA)) / outA);
      pixels[idx + 2] = Math.round((b * srcA + pixels[idx + 2] * dstA * (1 - srcA)) / outA);
      pixels[idx + 3] = Math.round(outA * 255);
    }
  } else {
    pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b; pixels[idx + 3] = a;
  }
}

function fillCircle(pixels, width, cx, cy, radius, r, g, b, a) {
  for (let dy = -Math.ceil(radius) - 1; dy <= Math.ceil(radius) + 1; dy++) {
    for (let dx = -Math.ceil(radius) - 1; dx <= Math.ceil(radius) + 1; dx++) {
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= radius - 0.5) {
        setPixel(pixels, width, cx + dx, cy + dy, r, g, b, a);
      } else if (dist < radius + 0.5) {
        const aa = Math.max(0, Math.min(1, radius + 0.5 - dist));
        setPixel(pixels, width, cx + dx, cy + dy, r, g, b, Math.round(a * aa));
      }
    }
  }
}

function fillRect(pixels, width, x, y, w, h, r, g, b, a) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      setPixel(pixels, width, x + dx, y + dy, r, g, b, a);
    }
  }
}

function fillRoundedRect(pixels, imgWidth, x, y, w, h, radius, r, g, b, a) {
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      let dx = 0, dy = 0;
      if (px < radius) dx = radius - px;
      else if (px >= w - radius) dx = px - (w - radius - 1);
      if (py < radius) dy = radius - py;
      else if (py >= h - radius) dy = py - (h - radius - 1);

      if (dx > 0 && dy > 0) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= radius + 0.5) {
          const aa = Math.min(1, radius + 0.5 - dist);
          setPixel(pixels, imgWidth, x + px, y + py, r, g, b, Math.round(a * Math.max(0, aa)));
        }
      } else {
        setPixel(pixels, imgWidth, x + px, y + py, r, g, b, a);
      }
    }
  }
}

// Draw a thick line with anti-aliasing
function drawLine(pixels, width, x1, y1, x2, y2, thickness, r, g, b, a) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return;
  const nx = -dy / len, ny = dx / len;
  const half = thickness / 2;

  const minX = Math.floor(Math.min(x1, x2) - half - 1);
  const maxX = Math.ceil(Math.max(x1, x2) + half + 1);
  const minY = Math.floor(Math.min(y1, y2) - half - 1);
  const maxY = Math.ceil(Math.max(y1, y2) + half + 1);

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const vx = px - x1, vy = py - y1;
      const along = (vx * dx + vy * dy) / len;
      const perp = Math.abs(vx * nx + vy * ny);

      if (along >= -half && along <= len + half && perp <= half + 0.5) {
        const edgeDist = half + 0.5 - perp;
        const aa = Math.min(1, edgeDist);
        // Also soften the line caps
        let capAA = 1;
        if (along < 0) capAA = Math.max(0, 1 + along);
        else if (along > len) capAA = Math.max(0, 1 - (along - len));
        setPixel(pixels, width, px, py, r, g, b, Math.round(a * Math.max(0, aa) * capAA));
      }
    }
  }
}

// Draw a rounded rectangle outline (stroke)
function strokeRoundedRect(pixels, imgWidth, x, y, w, h, radius, thickness, r, g, b, a) {
  const half = thickness / 2;
  // We'll check every pixel in the bounding area
  const pad = Math.ceil(thickness) + 2;
  for (let py = y - pad; py < y + h + pad; py++) {
    for (let px = x - pad; px < x + h + pad && px < x + w + pad; px++) {
      // Distance to the rounded rect border
      const dist = distToRoundedRect(px, py, x, y, w, h, radius);
      const d = Math.abs(dist) - half;
      if (d < 0.5) {
        const aa = Math.min(1, 0.5 - d);
        setPixel(pixels, imgWidth, px, py, r, g, b, Math.round(a * Math.max(0, aa)));
      }
    }
  }
}

// Signed distance from point to rounded rect border
function distToRoundedRect(px, py, rx, ry, rw, rh, radius) {
  const cx = rx + rw / 2, cy = ry + rh / 2;
  const hw = rw / 2, hh = rh / 2;
  const dx = Math.abs(px - cx) - hw + radius;
  const dy = Math.abs(py - cy) - hh + radius;
  if (dx > 0 && dy > 0) return Math.sqrt(dx * dx + dy * dy) - radius;
  return Math.max(dx, dy) - radius;
}

// ---- Lucide CarFront icon rendering ----
// SVG viewBox: 0 0 24 24, stroke-width 2, stroke-linecap round, stroke-linejoin round
// Paths:
//   path d="m21 8-2 2-1.5-3.7A2 2 0 0 0 15.646 5H8.4a2 2 0 0 0-1.903 1.257L5 10 3 8"
//   path d="M7 14h.01"       (left headlight dot)
//   path d="M17 14h.01"      (right headlight dot)
//   rect width="18" height="8" x="3" y="10" rx="2"  (car body)
//   path d="M5 18v2"          (left wheel)
//   path d="M19 18v2"         (right wheel)

function drawCarFront(pixels, imgWidth, imgHeight, iconX, iconY, iconSize, strokeW) {
  // Scale from 24x24 viewBox to actual icon size
  const s = iconSize / 24;
  const tx = iconX, ty = iconY;

  function sx(x) { return tx + x * s; }
  function sy(y) { return ty + y * s; }

  const white = { r: 255, g: 255, b: 255 };
  const a = 255;

  // 1. Car body: rounded rect x=3 y=10 w=18 h=8 rx=2
  strokeRoundedRect(pixels, imgWidth,
    sx(3), sy(10), 18 * s, 8 * s, 2 * s, strokeW,
    white.r, white.g, white.b, a);

  // 2. Roof line: m21 8 -2 2 => line from (21,8) to (19,10)
  drawLine(pixels, imgWidth, sx(21), sy(8), sx(19), sy(10), strokeW, white.r, white.g, white.b, a);

  // 3. Right windshield slope: (19,10) to (17.5, 6.3)
  //    -1.5 -3.7 => relative from (19,10): (17.5, 6.3)
  drawLine(pixels, imgWidth, sx(19), sy(10), sx(17.5), sy(6.3), strokeW, white.r, white.g, white.b, a);

  // 4. Roof top: approximate the arc — from ~(17.5, 6.3) curving to (15.646, 5) then across to (8.4, 5) curving to (~6.5, 6.257)
  // Simplify: line from (17.5, 6.3) → (16.2, 5.2) → (15.646, 5) → (8.4, 5) → (7.8, 5.2) → (6.5, 6.257)
  drawLine(pixels, imgWidth, sx(17.5), sy(6.3), sx(16), sy(5.15), strokeW, white.r, white.g, white.b, a);
  drawLine(pixels, imgWidth, sx(16), sy(5.15), sx(15.646), sy(5), strokeW, white.r, white.g, white.b, a);
  drawLine(pixels, imgWidth, sx(15.646), sy(5), sx(8.4), sy(5), strokeW, white.r, white.g, white.b, a);
  drawLine(pixels, imgWidth, sx(8.4), sy(5), sx(8), sy(5.15), strokeW, white.r, white.g, white.b, a);
  drawLine(pixels, imgWidth, sx(8), sy(5.15), sx(6.5), sy(6.257), strokeW, white.r, white.g, white.b, a);

  // 5. Left windshield slope: from (6.5, 6.257) to (5, 10)
  drawLine(pixels, imgWidth, sx(6.5), sy(6.257), sx(5), sy(10), strokeW, white.r, white.g, white.b, a);

  // 6. Left mirror: (5,10) to (3,8)
  drawLine(pixels, imgWidth, sx(5), sy(10), sx(3), sy(8), strokeW, white.r, white.g, white.b, a);

  // 7. Headlight dots at (7, 14) and (17, 14)
  fillCircle(pixels, imgWidth, sx(7), sy(14), strokeW * 0.7, white.r, white.g, white.b, a);
  fillCircle(pixels, imgWidth, sx(17), sy(14), strokeW * 0.7, white.r, white.g, white.b, a);

  // 8. Left wheel: line from (5,18) to (5,20)
  drawLine(pixels, imgWidth, sx(5), sy(18), sx(5), sy(20), strokeW, white.r, white.g, white.b, a);

  // 9. Right wheel: line from (19,18) to (19,20)
  drawLine(pixels, imgWidth, sx(19), sy(18), sx(19), sy(20), strokeW, white.r, white.g, white.b, a);
}

// ---- Main drawing function ----

function drawIcon(pixels, width, height) {
  // Clear to transparent
  pixels.fill(0);

  // Draw rounded rectangle background with gradient (brand-500 top to brand-700 bottom)
  const cornerRadius = Math.round(width * 0.18);
  for (let y = 0; y < height; y++) {
    const t = y / (height - 1);
    const r = Math.round(BRAND_500.r + (BRAND_700.r - BRAND_500.r) * t);
    const g = Math.round(BRAND_500.g + (BRAND_700.g - BRAND_500.g) * t);
    const b = Math.round(BRAND_500.b + (BRAND_700.b - BRAND_500.b) * t);
    for (let x = 0; x < width; x++) {
      // Check if inside rounded rect
      let dx = 0, dy2 = 0;
      if (x < cornerRadius) dx = cornerRadius - x;
      else if (x >= width - cornerRadius) dx = x - (width - cornerRadius - 1);
      if (y < cornerRadius) dy2 = cornerRadius - y;
      else if (y >= height - cornerRadius) dy2 = y - (height - cornerRadius - 1);

      if (dx > 0 && dy2 > 0) {
        const dist = Math.sqrt(dx * dx + dy2 * dy2);
        if (dist <= cornerRadius + 0.5) {
          const aa = Math.min(1, cornerRadius + 0.5 - dist);
          setPixel(pixels, width, x, y, r, g, b, Math.round(255 * aa));
        }
      } else {
        setPixel(pixels, width, x, y, r, g, b, 255);
      }
    }
  }

  // Draw the CarFront icon centered
  // Icon occupies ~60% of the icon area, centered
  const iconSize = width * 0.6;
  const iconX = (width - iconSize) / 2;
  const iconY = (height - iconSize) / 2;
  const strokeWidth = Math.max(1.5, width * 0.04);

  drawCarFront(pixels, width, height, iconX, iconY, iconSize, strokeWidth);
}

// ---- ICO file generation ----

function createICO(pngBuffers) {
  const numImages = pngBuffers.length;
  const headerSize = 6 + numImages * 16;

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(numImages, 4);

  const entries = [];
  let dataOffset = headerSize;

  for (const { png, size } of pngBuffers) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(dataOffset, 12);
    entries.push(entry);
    dataOffset += png.length;
  }

  return Buffer.concat([header, ...entries, ...pngBuffers.map(p => p.png)]);
}

// ---- Generate all icons ----

const SIZES = [256, 128, 64, 48, 32, 16];

console.log('Generating 512x512 PNG icon...');
const png512 = createPNG(512, 512, drawIcon);
fs.writeFileSync(path.join(BUILD_DIR, 'icon.png'), png512);
console.log(`  icon.png: ${png512.length} bytes`);

console.log('Generating multi-size ICO file...');
const icoBuffers = SIZES.map(size => {
  console.log(`  Adding ${size}x${size}...`);
  return { png: createPNG(size, size, drawIcon), size };
});

const ico = createICO(icoBuffers);
fs.writeFileSync(path.join(BUILD_DIR, 'icon.ico'), ico);
console.log(`  icon.ico: ${ico.length} bytes (${SIZES.length} sizes)`);

console.log('\nDone! Icons generated in:', BUILD_DIR);
