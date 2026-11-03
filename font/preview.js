#!/usr/bin/env node
/**
 * Rasterize a sample sheet from the baked atlas so glyph quality can be checked
 * without booting firmware. Uses the same blit math as the runtime.
 *
 *   node font/preview.js out.png
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLES, ATLAS_WIDTH, ICONS } from '../assets/fontdata.js';
import { encodePng } from '../shot.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const atlas = fs.readFileSync(path.join(here, '..', 'assets', 'atlas.bin'));

const W = 900;
const H = 320;
const px = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) {
  px[i * 4] = 0x23; px[i * 4 + 1] = 0x26; px[i * 4 + 2] = 0x2e; px[i * 4 + 3] = 0xff;
}

function blend(x, y, a, r, g, b) {
  if (a === 0 || x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  const ia = 255 - a;
  px[i] = (r * a + px[i] * ia) / 255;
  px[i + 1] = (g * a + px[i + 1] * ia) / 255;
  px[i + 2] = (b * a + px[i + 2] * ia) / 255;
}

function findGlyph(table, cp) {
  let lo = 0, hi = table.glyphs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const g = table.glyphs[mid];
    if (g[0] === cp) return g;
    if (g[0] < cp) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

function drawText(table, x, y, text, color) {
  const [r, g, b] = color;
  let pen = x;
  for (const ch of text) {
    const g = findGlyph(table, ch.codePointAt(0));
    if (!g) { pen += 6; continue; }
    const [, gx, gy, w, h, adv, bx, by] = g;
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const a = atlas[(gy + row) * ATLAS_WIDTH + gx + col];
        if (a) blend(pen + bx + col, y - by + row, a, r, g, b);
      }
    }
    pen += adv;
  }
  return pen - x;
}

const white = [232, 236, 244];
const dim = [154, 163, 181];
const accent = [110, 168, 254];

drawText(TABLES.text19, 24, 40, 'REG-RUNTIME', white);
drawText(TABLES.text19, 24, 40, '  \u2728', accent);
drawText(TABLES.text13, 24, 76, 'Inter Variable 13px: The quick brown fox jumps over the lazy dog 0123456789',
  dim);
drawText(TABLES.text13, 24, 100, 'WAVE HANDGLIDES QUICKLY  !@#$%^&*()  \u2190 \u2192 \u2713 \u2022', white);
drawText(TABLES.text19, 24, 140, 'Tabler icons inline \uE000 \uE001 \uE002 \uE003 \uE004 \uE005 \uE006 \uE007', dim);

const iconNames = Object.keys(ICONS);
let pen = 24;
for (const name of iconNames.slice(8, 26)) {
  drawText(TABLES.icons, pen, 186, String.fromCodePoint(ICONS[name]), white);
  pen += 26;
  if (pen > W - 30) pen = 24;
}

drawText(TABLES.emoji19, 24, 240, '\u{1F600}\u{1F680}\u{1F525}\u2728\u{1F4BB}\u{1F50C}\u{1F30D}\u{1F510}\u{1F9E0}', white);
drawText(TABLES.text13, 24, 276, 'Emoji comes from Noto Emoji; icons from Tabler; text from Inter.', dim);

fs.writeFileSync(process.argv[2] ?? '/tmp/opencode/font-preview.png', encodePng({ width: W, height: H, pixels: px }));
console.log('wrote preview');
