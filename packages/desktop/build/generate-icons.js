/**
 * Generate app icons for AutoLander Electron app.
 * Pure Node.js - no external dependencies required.
 * Creates a 512x512 PNG with blue background and white "AL" text,
 * then creates an ICO file from it.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BUILD_DIR = __dirname;

// ---- PNG generation (raw, no canvas needed) ----

function createPNG(width, height, drawFn) {
  // RGBA pixel buffer
  const pixels = Buffer.alloc(width * height * 4);
  drawFn(pixels, width, height);

  // Build raw image data with filter bytes
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0; // filter: None
    pixels.copy(
      rawData,
      y * (1 + width * 4) + 1,
      y * width * 4,
      (y + 1) * width * 4
    );
  }

  const compressed = zlib.deflateSync(rawData, { level: 9 });

  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 6;  // color type: RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = makeChunk('IHDR', ihdrData);

  // IDAT chunk
  const idat = makeChunk('IDAT', compressed);

  // IEND chunk
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

// CRC32 for PNG chunks
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

// Set a pixel in the RGBA buffer
function setPixel(pixels, width, x, y, r, g, b, a) {
  if (x < 0 || x >= width || y < 0) return;
  const idx = (y * width + x) * 4;
  if (idx + 3 >= pixels.length) return;
  // Alpha blending
  if (a < 255 && pixels[idx + 3] > 0) {
    const srcA = a / 255;
    const dstA = pixels[idx + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    pixels[idx] = Math.round((r * srcA + pixels[idx] * dstA * (1 - srcA)) / outA);
    pixels[idx + 1] = Math.round((g * srcA + pixels[idx + 1] * dstA * (1 - srcA)) / outA);
    pixels[idx + 2] = Math.round((b * srcA + pixels[idx + 2] * dstA * (1 - srcA)) / outA);
    pixels[idx + 3] = Math.round(outA * 255);
  } else {
    pixels[idx] = r;
    pixels[idx + 1] = g;
    pixels[idx + 2] = b;
    pixels[idx + 3] = a;
  }
}

// Fill a circle
function fillCircle(pixels, width, cx, cy, radius, r, g, b, a) {
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= r2) {
        setPixel(pixels, width, cx + dx, cy + dy, r, g, b, a);
      }
    }
  }
}

// Fill a rectangle
function fillRect(pixels, width, x, y, w, h, r, g, b, a) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      setPixel(pixels, width, x + dx, y + dy, r, g, b, a);
    }
  }
}

// Draw a rounded rectangle
function fillRoundedRect(pixels, imgWidth, x, y, w, h, radius, r, g, b, a) {
  // Fill center
  fillRect(pixels, imgWidth, x + radius, y, w - 2 * radius, h, r, g, b, a);
  // Fill left/right strips
  fillRect(pixels, imgWidth, x, y + radius, radius, h - 2 * radius, r, g, b, a);
  fillRect(pixels, imgWidth, x + w - radius, y + radius, radius, h - 2 * radius, r, g, b, a);
  // Fill corners
  fillCircleQuadrant(pixels, imgWidth, x + radius, y + radius, radius, r, g, b, a, 'tl');
  fillCircleQuadrant(pixels, imgWidth, x + w - radius - 1, y + radius, radius, r, g, b, a, 'tr');
  fillCircleQuadrant(pixels, imgWidth, x + radius, y + h - radius - 1, radius, r, g, b, a, 'bl');
  fillCircleQuadrant(pixels, imgWidth, x + w - radius - 1, y + h - radius - 1, radius, r, g, b, a, 'br');
}

function fillCircleQuadrant(pixels, width, cx, cy, radius, r, g, b, a, quadrant) {
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= r2) {
        let draw = false;
        if (quadrant === 'tl' && dx <= 0 && dy <= 0) draw = true;
        if (quadrant === 'tr' && dx >= 0 && dy <= 0) draw = true;
        if (quadrant === 'bl' && dx <= 0 && dy >= 0) draw = true;
        if (quadrant === 'br' && dx >= 0 && dy >= 0) draw = true;
        if (draw) setPixel(pixels, width, cx + dx, cy + dy, r, g, b, a);
      }
    }
  }
}

// Simple bitmap font for "A" and "L" at large scale
// Each letter is defined on a 7x9 grid, scaled up
const FONT = {
  'A': [
    '..###..',
    '.##.##.',
    '##...##',
    '##...##',
    '#######',
    '##...##',
    '##...##',
    '##...##',
    '##...##',
  ],
  'L': [
    '##.....',
    '##.....',
    '##.....',
    '##.....',
    '##.....',
    '##.....',
    '##.....',
    '##.....',
    '#######',
  ],
};

function drawLetter(pixels, imgWidth, letter, startX, startY, scale, r, g, b, a) {
  const glyph = FONT[letter];
  if (!glyph) return;
  for (let row = 0; row < glyph.length; row++) {
    for (let col = 0; col < glyph[row].length; col++) {
      if (glyph[row][col] === '#') {
        fillRect(pixels, imgWidth, startX + col * scale, startY + row * scale, scale, scale, r, g, b, a);
      }
    }
  }
}

// ---- Main drawing function ----

function drawIcon(pixels, width, height) {
  // Background: blue #2563EB = rgb(37, 99, 235)
  const bgR = 37, bgG = 99, bgB = 235;

  // Fill with rounded rect background
  // First fill transparent
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 0;
    pixels[i + 1] = 0;
    pixels[i + 2] = 0;
    pixels[i + 3] = 0;
  }

  // Draw rounded rectangle background
  const cornerRadius = Math.round(width * 0.18);
  fillRoundedRect(pixels, width, 0, 0, width, height, cornerRadius, bgR, bgG, bgB, 255);

  // Draw "AL" text centered
  // Each letter is 7 units wide, 9 units tall
  // Two letters + 1 unit gap = 15 units wide
  const scale = Math.round(width / 22); // scale factor for the font grid
  const textWidth = 15 * scale;
  const textHeight = 9 * scale;
  const startX = Math.round((width - textWidth) / 2);
  const startY = Math.round((height - textHeight) / 2);

  // Draw with white
  drawLetter(pixels, width, 'A', startX, startY, scale, 255, 255, 255, 255);
  drawLetter(pixels, width, 'L', startX + 8 * scale, startY, scale, 255, 255, 255, 255);

  // Add a subtle car/road icon below the text - a simple horizontal line
  const lineY = startY + textHeight + Math.round(scale * 1.5);
  const lineHeight = Math.round(scale * 0.4) || 2;
  const lineWidth = Math.round(textWidth * 0.8);
  const lineX = Math.round((width - lineWidth) / 2);
  fillRect(pixels, width, lineX, lineY, lineWidth, lineHeight, 255, 255, 255, 200);
}

// ---- ICO file generation ----

function createICO(pngBuffers) {
  // ICO header: 6 bytes
  // Each entry: 16 bytes
  // Then PNG data for each entry
  const numImages = pngBuffers.length;
  const headerSize = 6 + numImages * 16;

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: ICO
  header.writeUInt16LE(numImages, 4);

  const entries = [];
  let dataOffset = headerSize;

  for (const { png, size } of pngBuffers) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // width (0 = 256)
    entry[1] = size >= 256 ? 0 : size; // height (0 = 256)
    entry[2] = 0; // color palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8); // data size
    entry.writeUInt32LE(dataOffset, 12); // data offset
    entries.push(entry);
    dataOffset += png.length;
  }

  return Buffer.concat([header, ...entries, ...pngBuffers.map(p => p.png)]);
}

// ---- Generate all icons ----

console.log('Generating 512x512 PNG icon...');
const png512 = createPNG(512, 512, drawIcon);
fs.writeFileSync(path.join(BUILD_DIR, 'icon.png'), png512);
console.log(`  icon.png: ${png512.length} bytes`);

console.log('Generating 256x256 PNG for ICO...');
const png256 = createPNG(256, 256, drawIcon);

console.log('Generating additional sizes for ICO...');
const png48 = createPNG(48, 48, drawIcon);
const png32 = createPNG(32, 32, drawIcon);
const png16 = createPNG(16, 16, drawIcon);

console.log('Creating ICO file...');
const ico = createICO([
  { png: png256, size: 256 },
  { png: png48, size: 48 },
  { png: png32, size: 32 },
  { png: png16, size: 16 },
]);
fs.writeFileSync(path.join(BUILD_DIR, 'icon.ico'), ico);
console.log(`  icon.ico: ${ico.length} bytes`);

// For .icns - electron-builder will fall back to icon.png on non-macOS
// Create a copy named icon.icns as a placeholder
// (Real .icns requires macOS iconutil or specialized tooling)
// electron-builder handles the conversion from .png if .icns is missing
console.log('Note: icon.icns not generated (requires macOS tooling).');
console.log('      electron-builder will auto-convert from icon.png on macOS builds.');

console.log('\nDone! Icons generated in:', BUILD_DIR);
