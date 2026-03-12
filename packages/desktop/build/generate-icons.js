/**
 * Generate app icons for AutoLander Electron app.
 * Pure Node.js - no external dependencies required.
 * Creates a car-themed logo for an auto dealership app.
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
  if (a < 255) {
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
    pixels[idx] = r;
    pixels[idx + 1] = g;
    pixels[idx + 2] = b;
    pixels[idx + 3] = a;
  }
}

// Fill a circle with basic anti-aliasing
function fillCircle(pixels, width, cx, cy, radius, r, g, b, a) {
  const r2 = radius * radius;
  for (let dy = -Math.ceil(radius); dy <= Math.ceil(radius); dy++) {
    for (let dx = -Math.ceil(radius); dx <= Math.ceil(radius); dx++) {
      const dist2 = dx * dx + dy * dy;
      if (dist2 <= r2) {
        setPixel(pixels, width, Math.round(cx + dx), Math.round(cy + dy), r, g, b, a);
      } else if (dist2 <= (radius + 1) * (radius + 1)) {
        // Very basic AA
        const alpha = Math.max(0, Math.min(a, a * (1 - (Math.sqrt(dist2) - radius))));
        setPixel(pixels, width, Math.round(cx + dx), Math.round(cy + dy), r, g, b, Math.round(alpha));
      }
    }
  }
}

// Fill a rectangle
function fillRect(pixels, width, x, y, w, h, r, g, b, a) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      setPixel(pixels, width, Math.round(x + dx), Math.round(y + dy), r, g, b, a);
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
        if (draw) setPixel(pixels, width, Math.round(cx + dx), Math.round(cy + dy), r, g, b, a);
      }
    }
  }
}

// ---- Main drawing function ----

function drawIcon(pixels, width, height) {
  // Background: Dark Navy #1E293B (Slate 800)
  const bgR = 30, bgG = 41, bgB = 59;
  
  // Fill transparent initially
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 0; pixels[i+1] = 0; pixels[i+2] = 0; pixels[i+3] = 0;
  }

  // Draw rounded rectangle background
  const cornerRadius = Math.round(width * 0.18);
  fillRoundedRect(pixels, width, 0, 0, width, height, cornerRadius, bgR, bgG, bgB, 255);

  // Car proportions
  const carW = width * 0.65;
  const carH = width * 0.35;
  const carX = (width - carW) / 2;
  const carY = (height - carH) / 2 - (width * 0.02);

  // Car body colors
  const carR = 255, carG = 255, carB = 255; // White car

  // 1. Cabin (Top)
  const cabinW = carW * 0.55;
  const cabinH = carH * 0.55;
  const cabinX = carX + carW * 0.22;
  const cabinY = carY;
  fillRoundedRect(pixels, width, cabinX, cabinY, cabinW, cabinH, cabinH * 0.45, carR, carG, carB, 255);
  
  // 2. Main Body (Bottom)
  const bodyW = carW;
  const bodyH = carH * 0.5;
  const bodyX = carX;
  const bodyY = carY + carH * 0.4;
  fillRoundedRect(pixels, width, bodyX, bodyY, bodyW, bodyH, bodyH * 0.35, carR, carG, carB, 255);

  // 3. Windows (Cut out from cabin)
  const windowGap = Math.max(1, Math.round(width * 0.015));
  const windowW = (cabinW - windowGap * 3) / 2;
  const windowH = cabinH * 0.6;
  const windowX1 = cabinX + windowGap;
  const windowX2 = cabinX + windowGap * 2 + windowW;
  const windowY = cabinY + windowGap;
  
  // Fill windows with background color to "cut" them
  fillRoundedRect(pixels, width, windowX1, windowY, windowW, windowH, windowH * 0.2, bgR, bgG, bgB, 255);
  fillRoundedRect(pixels, width, windowX2, windowY, windowW, windowH, windowH * 0.2, bgR, bgG, bgB, 255);

  // 4. Wheels
  const wheelRadius = carH * 0.22;
  const wheelY = bodyY + bodyH * 0.85;
  const wheelX1 = carX + carW * 0.22;
  const wheelX2 = carX + carW * 0.78;
  
  // Outer wheel (cut out from body)
  fillCircle(pixels, width, wheelX1, wheelY, wheelRadius, bgR, bgG, bgB, 255);
  fillCircle(pixels, width, wheelX2, wheelY, wheelRadius, bgR, bgG, bgB, 255);
  
  // Inner wheel (rim)
  fillCircle(pixels, width, wheelX1, wheelY, wheelRadius * 0.5, carR, carG, carB, 255);
  fillCircle(pixels, width, wheelX2, wheelY, wheelRadius * 0.5, carR, carG, carB, 255);

  // 5. Road line (subtle)
  const roadW = carW * 1.1;
  const roadH = Math.max(1, Math.round(width * 0.015));
  const roadX = (width - roadW) / 2;
  const roadY = wheelY + wheelRadius + (width * 0.05);
  fillRect(pixels, width, roadX, roadY, roadW, roadH, 255, 255, 255, 120);
}

// ---- ICO file generation ----

function createICO(pngBuffers) {
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
    entry[0] = size >= 256 ? 0 : size; // width
    entry[1] = size >= 256 ? 0 : size; // height
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

const SIZES = [256, 128, 64, 48, 32, 16];

console.log('Generating 512x512 PNG icon...');
const png512 = createPNG(512, 512, drawIcon);
fs.writeFileSync(path.join(BUILD_DIR, 'icon.png'), png512);
console.log(`  icon.png: ${png512.length} bytes`);

console.log('Generating multi-size ICO file...');
const icoBuffers = SIZES.map(size => {
  console.log(`  Adding ${size}x${size}...`);
  return {
    png: createPNG(size, size, drawIcon),
    size
  };
});

const ico = createICO(icoBuffers);
fs.writeFileSync(path.join(BUILD_DIR, 'icon.ico'), ico);
console.log(`  icon.ico: ${ico.length} bytes (${SIZES.length} sizes)`);

console.log('\nDone! Icons generated in:', BUILD_DIR);
