#!/usr/bin/env node
/**
 * Tiny TGA (type 2, 24/32-bit, either origin) to PNG converter, plus a FAT16
 * extractor. Build-time only: lets a headless run be inspected as an image.
 *
 *   node shot.js disk.img /shot.tga shot.png
 */

import fs from 'node:fs';
import zlib from 'node:zlib';
import { openFat16 } from './fatfs.js';

function decodeTga(buf) {
  const idLength = buf[0];
  const colorMapType = buf[1];
  const imageType = buf[2];
  if (colorMapType !== 0 || (imageType !== 2 && imageType !== 3)) {
    throw new Error(`unsupported TGA type ${imageType}`);
  }
  const width = buf.readUInt16LE(12);
  const height = buf.readUInt16LE(14);
  const depth = buf[16];
  const descriptor = buf[17];
  const topDown = (descriptor & 0x20) !== 0;
  const bytesPerPixel = depth / 8;
  const pixels = Buffer.alloc(width * height * 4);
  const start = 18 + idLength;

  for (let y = 0; y < height; y++) {
    const srcRow = topDown ? y : height - 1 - y;
    for (let x = 0; x < width; x++) {
      const s = start + (srcRow * width + x) * bytesPerPixel;
      const d = (y * width + x) * 4;
      if (imageType === 3) {
        const g = buf[s];
        pixels[d] = g;
        pixels[d + 1] = g;
        pixels[d + 2] = g;
        pixels[d + 3] = 0xff;
      } else {
        pixels[d] = buf[s + 2];
        pixels[d + 1] = buf[s + 1];
        pixels[d + 2] = buf[s];
        pixels[d + 3] = bytesPerPixel === 4 ? buf[s + 3] : 0xff;
      }
    }
  }
  return { width, height, pixels };
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

export function encodePng({ width, height, pixels }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const diskPath = process.argv[2] ?? 'disk.img';
  const inner = process.argv[3] ?? '/shot.tga';
  const pngPath = process.argv[4] ?? 'shot.png';

  const vol = openFat16(fs.readFileSync(diskPath));
  for (const entry of vol.list('/'))
    console.log(`[disk] ${entry.dir ? '<DIR>' : entry.size.toString().padStart(8)} ${entry.name}`);

  const tga = vol.read(inner);
  const image = decodeTga(tga);
  fs.writeFileSync(pngPath, encodePng(image));
  console.log(`[shot] ${inner} ${image.width}x${image.height} -> ${pngPath}`);
}
