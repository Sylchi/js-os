#!/usr/bin/env node
/**
 * Bake text and icon assets into a runtime-usable atlas.
 *
 *   node font/bake.js
 *
 * Inputs are design-time only: Inter Variable (SIL OFL), Noto Emoji (OFL) and
 * Tabler icons (MIT). Output is one 8-bit coverage atlas plus a metrics table,
 * so the boot image carries no font parser, no SVG parser, and no crypto.
 *
 * Icon names are mapped into the Unicode private use area (U+E000+) so they can
 * be drawn by the same text path as any other glyph.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Font } from './ttf.js';
import { parseSvg } from './svg.js';
import { polygons, strokes, bounds } from './raster.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const assets = path.join(root, 'assets');

const SIZES = [
  { name: 'text13', font: 'InterVariable.ttf', px: 13, lineHeight: 16, pad: 1 },
  { name: 'text19', font: 'InterVariable.ttf', px: 19, lineHeight: 24, pad: 1 },
  { name: 'emoji13', font: 'NotoEmoji.ttf', px: 13, lineHeight: 16, pad: 1 },
  { name: 'emoji19', font: 'NotoEmoji.ttf', px: 19, lineHeight: 24, pad: 1 },
];

const TEXT_EXTRA = [
  0x2190, // left arrow
  0x2192, // right arrow
  0x2191,
  0x2193,
  0x2713, // check
  0x2715, // multiply
  0x2022, // bullet
  0x2014, // em dash
];

const EMOJI = [
  0x1f600, 0x1f642, 0x1f603, 0x1f60a, 0x1f60d, 0x1f60e, 0x1f609, 0x1f61b,
  0x1f914, 0x1f927, 0x1f973, 0x1f680, 0x1f525, 0x2728, 0x1f4a1, 0x1f4bb,
  0x1f4be, 0x1f50c, 0x1f4e1, 0x1f30d, 0x1f510, 0x1f4e6, 0x1f527, 0x1f9e0,
];

const ICON_SIZE = 20;
const ICON_CODEPOINT_BASE = 0xe000;

const atlases = [];

function makeGlyph(font, gid, px, pad) {
  const scale = px / font.unitsPerEm;
  const contours = font.outline(gid);
  if (!contours.length) return null;
  const box = bounds(contours);
  const w = Math.max(1, Math.ceil((box.maxX - box.minX) * scale) + pad * 2);
  const h = Math.max(1, Math.ceil((box.maxY - box.minY) * scale) + pad * 2);
  const moved = contours.map((c) => c.map((p) => ({
    x: (p.x - box.minX) * scale + pad,
    y: (box.maxY - p.y) * scale + pad,
  })));
  const alpha = polygons(moved, w, h);
  return {
    alpha,
    w,
    h,
    advance: Math.round(font.advance(gid) * scale),
    bearingX: Math.round(box.minX * scale) - pad,
    bearingY: Math.round(box.maxY * scale) + pad,
  };
}

function makeIcon(svgText, px) {
  const svg = parseSvg(svgText);
  const pad = 2;
  const scale = px / svg.width;
  const half = (svg.strokeWidth / 2) * scale;
  const w = Math.ceil(svg.width * scale) + pad * 2;
  const h = Math.ceil(svg.height * scale) + pad * 2;
  const lines = svg.polylines.map((line) => line.map((p) => ({
    x: p.x * scale + pad,
    y: p.y * scale + pad,
  })));
  const alpha = strokes(lines, w, h, half);
  return { alpha, w, h, advance: Math.ceil(px) + 2, bearingX: -pad, bearingY: Math.ceil(px) + pad };
}

// ---------------------------------------------------------------- rasterize
const entries = [];   // {cp,x,y,w,h,adv,bx,by,alpha}
const icons = new Map();

for (const size of SIZES) {
  const font = new Font(fs.readFileSync(path.join(assets, 'fonts', size.font)));
  const cps = [];
  for (let cp = 0x20; cp <= 0x7e; cp++) cps.push(cp);
  cps.push(...TEXT_EXTRA);
  if (size.name.startsWith('emoji')) cps.push(...EMOJI);

  for (const cp of cps) {
    const gid = font.glyphIndex(cp);
    if (!gid) continue;
    const g = makeGlyph(font, gid, size.px, size.pad);
    if (g) {
      entries.push({ cp, size: size.name, ...g });
    } else if (cp === 0x20) {
      // Space has no contours but still needs its real advance, otherwise the
      // binary search in cv_text treats it as a missing glyph.
      entries.push({
        cp,
        size: size.name,
        alpha: new Uint8Array(0),
        w: 0,
        h: 0,
        advance: Math.round(font.advance(gid) * size.px / font.unitsPerEm),
        bearingX: 0,
        bearingY: 0,
      });
    }
  }
}

const iconDir = path.join(assets, 'icons');
const iconFiles = fs.readdirSync(iconDir).filter((f) => f.endsWith('.svg')).sort();
iconFiles.forEach((file, index) => {
  const name = file.replace(/\.svg$/, '');
  const g = makeIcon(fs.readFileSync(path.join(iconDir, file), 'utf8'), ICON_SIZE);
  const cp = ICON_CODEPOINT_BASE + index;
  icons.set(name, cp);
  entries.push({ cp, size: 'icons', icon: name, ...g });
});

// ------------------------------------------------------------------- pack
const ATLAS_W = Number(process.env.ATLAS_W ?? 512);
const ATLAS_H = Number(process.env.ATLAS_H ?? 384);

const sorted = [...entries].sort((a, b) => b.h - a.h || b.w - a.w);
let shelfX = 0, shelfY = 0, shelfH = 0;
for (const e of sorted) {
  if (shelfX + e.w > ATLAS_W) {
    shelfX = 0;
    shelfY += shelfH + 1;
    shelfH = 0;
  }
  if (shelfY + e.h > ATLAS_H) throw new Error('atlas is too small; raise ATLAS_W/H');
  e.x = shelfX;
  e.y = shelfY;
  shelfX += e.w + 1;
  shelfH = Math.max(shelfH, e.h);
}

const alpha = Buffer.alloc(ATLAS_W * ATLAS_H);
for (const e of entries) {
  for (let row = 0; row < e.h; row++) {
    alpha.set(
      e.alpha.subarray(row * e.w, row * e.w + e.w),
      (e.y + row) * ATLAS_W + e.x,
    );
  }
}

// ------------------------------------------------------------------- emit
function tableFor(sizeName, ascentOverride) {
  const rows = entries
    .filter((e) => e.size === sizeName)
    .sort((a, b) => a.cp - b.cp);
  const ascent = ascentOverride ?? Math.round(rows[0]?.h ?? 0);
  return { name: sizeName, ascent, glyphs: rows };
}

const tables = [
  tableFor('text13', 12),
  tableFor('text19', 18),
  tableFor('emoji13', 13),
  tableFor('emoji19', 19),
  tableFor('icons', 20),
];

fs.writeFileSync(path.join(assets, 'atlas.bin'), alpha);

const lines = [];
lines.push('// Generated by font/bake.js. Do not edit.');
lines.push(`// Inter Variable (SIL OFL 1.1), Noto Emoji (OFL), Tabler Icons (MIT).`);
lines.push(`export const ATLAS_WIDTH = ${ATLAS_W};`);
lines.push(`export const ATLAS_HEIGHT = ${ATLAS_H};`);
lines.push(`export const ATLAS_FILE = 'assets/atlas.bin';`);
lines.push('');
lines.push('// [codepoint, x, y, w, h, advance, bearingX, bearingY]');
lines.push('export const TABLES = {');
for (const t of tables) {
  lines.push(`  ${t.name}: {`);
  lines.push(`    ascent: ${t.ascent},`);
  lines.push(`    glyphs: [`);
  for (const g of t.glyphs) {
    lines.push(`      [${g.cp},${g.x},${g.y},${g.w},${g.h},${g.advance},${g.bearingX},${g.bearingY}],`);
  }
  lines.push('    ],');
  lines.push('  },');
}
lines.push('};');
lines.push('');
lines.push('// Tabler icon name -> private use codepoint, usable inside strings.');
lines.push(`export const ICONS = {`);
for (const [name, cp] of [...icons.entries()].sort()) {
  lines.push(`  ${JSON.stringify(name)}: 0x${cp.toString(16)},`);
}
lines.push('};');
lines.push('');

fs.writeFileSync(path.join(assets, 'fontdata.js'), lines.join('\n'));

const total = entries.reduce((n, e) => n + e.w * e.h, 0);
console.log(
  `[font] ${entries.length} glyphs, ${(total / 1024).toFixed(1)}k px used, ` +
  `atlas ${ATLAS_W}x${ATLAS_H} (${((total / (ATLAS_W * ATLAS_H)) * 100).toFixed(0)}% packed)`,
);
for (const t of tables) console.log(`  ${t.name.padEnd(8)} ${t.glyphs.length} glyphs, ascent ${t.ascent}`);
console.log(`  icons    ${icons.size}`);
