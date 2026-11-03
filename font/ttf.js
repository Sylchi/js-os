/**
 * Small TrueType reader: enough of the sfnt format to pull glyph outlines out
 * of Inter and Noto Emoji and hand them to the rasterizer.
 *
 * Supported: head, maxp, hhea, hmtx, cmap (4 and 12), loca, glyf, and simple
 * plus composite glyphs. That is the whole of what a UI font needs.
 */

const TAG = (buf, off) => buf.toString('ascii', off, off + 4);

class Font {
  constructor(buffer) {
    this.buf = buffer;
    this.tables = new Map();
    this._readDirectory();
    this._readHead();
    this._readMaxp();
    this._readHhea();
    this._readHmtx();
    this._readCmap();
    this._outlineCache = new Map();
  }

  _readDirectory() {
    const numTables = this.buf.readUInt16BE(4);
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      const tag = TAG(this.buf, rec);
      this.tables.set(tag, {
        offset: this.buf.readUInt32BE(rec + 8),
        length: this.buf.readUInt32BE(rec + 12),
      });
    }
  }

  table(tag) {
    const t = this.tables.get(tag);
    if (!t) throw new Error(`missing table ${tag}`);
    return t;
  }

  has(tag) {
    return this.tables.has(tag);
  }

  _readHead() {
    const { offset } = this.table('head');
    this.unitsPerEm = this.buf.readUInt16BE(offset + 18);
    this.indexToLocFormat = this.buf.readInt16BE(offset + 50);
  }

  _readMaxp() {
    this.numGlyphs = this.buf.readUInt16BE(this.table('maxp').offset + 4);
  }

  _readHhea() {
    const { offset } = this.table('hhea');
    this.ascender = this.buf.readInt16BE(offset + 4);
    this.descender = this.buf.readInt16BE(offset + 6);
    this.numHMetrics = this.buf.readUInt16BE(offset + 34);
  }

  _readHmtx() {
    const { offset } = this.table('hmtx');
    this.advances = new Uint16Array(this.numGlyphs);
    let last = 0;
    for (let i = 0; i < this.numGlyphs; i++) {
      if (i < this.numHMetrics) last = this.buf.readUInt16BE(offset + i * 4);
      this.advances[i] = last;
    }
  }

  _readCmap() {
    const { offset } = this.table('cmap');
    const count = this.buf.readUInt16BE(offset + 2);
    const subtables = [];
    for (let i = 0; i < count; i++) {
      const rec = offset + 4 + i * 8;
      subtables.push({
        platform: this.buf.readUInt16BE(rec),
        encoding: this.buf.readUInt16BE(rec + 2),
        offset: offset + this.buf.readUInt32BE(rec + 4),
      });
    }
    // Prefer full-repertoire Unicode (format 12), then BMP (format 4).
    const score = (s) => {
      const format = this.buf.readUInt16BE(s.offset);
      if (format === 12) return 3;
      if (format === 4) return 2;
      return 1;
    };
    subtables.sort((a, b) => score(b) - score(a));
    this.cmap = new Map();
    for (const sub of subtables) {
      const format = this.buf.readUInt16BE(sub.offset);
      if (format === 4) {
        this._readCmap4(sub.offset);
        break;
      }
      if (format === 12) {
        this._readCmap12(sub.offset);
        break;
      }
    }
  }

  _readCmap4(off) {
    const segCountX2 = this.buf.readUInt16BE(off + 6);
    const segCount = segCountX2 / 2;
    const endOff = off + 14;
    const startOff = endOff + segCountX2 + 2;
    const deltaOff = startOff + segCountX2;
    const rangeOff = deltaOff + segCountX2;
    for (let i = 0; i < segCount; i++) {
      const end = this.buf.readUInt16BE(endOff + i * 2);
      const start = this.buf.readUInt16BE(startOff + i * 2);
      const delta = this.buf.readInt16BE(deltaOff + i * 2);
      const range = this.buf.readUInt16BE(rangeOff + i * 2);
      if (start === 0xffff) continue;
      for (let c = start; c <= end && c !== 0x10000; c++) {
        let gid;
        if (range === 0) {
          gid = (c + delta) & 0xffff;
        } else {
          const glyphOff = rangeOff + i * 2 + range + (c - start) * 2;
          gid = this.buf.readUInt16BE(glyphOff);
          if (gid !== 0) gid = (gid + delta) & 0xffff;
        }
        if (gid !== 0) this.cmap.set(c, gid);
      }
    }
  }

  _readCmap12(off) {
    const nGroups = this.buf.readUInt32BE(off + 12);
    for (let i = 0; i < nGroups; i++) {
      const rec = off + 16 + i * 12;
      const start = this.buf.readUInt32BE(rec);
      const end = this.buf.readUInt32BE(rec + 4);
      const gidStart = this.buf.readUInt32BE(rec + 8);
      for (let c = start; c <= end; c++) {
        this.cmap.set(c, gidStart + (c - start));
      }
    }
  }

  glyphIndex(codepoint) {
    return this.cmap.get(codepoint) ?? 0;
  }

  advance(gid) {
    return this.advances[gid] ?? 0;
  }

  // Outline in font units, y up. Returns [{x, y}...] contours, already
  // flattened from quadratic splines.
  outline(gid, depth = 0) {
    if (this._outlineCache.has(gid)) return this._outlineCache.get(gid);
    if (depth > 8) return [];
    const contours = this._readGlyph(gid, depth);
    this._outlineCache.set(gid, contours);
    return contours;
  }

  _glyphRange(gid) {
    const loca = this.table('loca');
    const short = this.indexToLocFormat === 0;
    const at = (i) => short
      ? this.buf.readUInt16BE(loca.offset + i * 2) * 2
      : this.buf.readUInt32BE(loca.offset + i * 4);
    return { start: at(gid), end: at(gid + 1) };
  }

  _readGlyph(gid, depth) {
    if (gid >= this.numGlyphs) return [];
    const { start, end } = this._glyphRange(gid);
    if (end <= start) return [];
    const glyf = this.table('glyf').offset;
    const off = glyf + start;
    const numberOfContours = this.buf.readInt16BE(off);
    if (numberOfContours === -1) return this._readComposite(off, depth);
    return this._readSimple(off, numberOfContours);
  }

  _readSimple(off, numberOfContours) {
    if (numberOfContours <= 0) return [];
    let p = off + 10;
    const endPts = [];
    for (let i = 0; i < numberOfContours; i++) {
      endPts.push(this.buf.readUInt16BE(p));
      p += 2;
    }
    const numPoints = endPts[endPts.length - 1] + 1;
    const instructionLength = this.buf.readUInt16BE(p);
    p += 2 + instructionLength;

    const flags = new Uint8Array(numPoints);
    for (let i = 0; i < numPoints;) {
      const f = this.buf[p++];
      flags[i++] = f;
      if (f & 0x08) {
        let repeat = this.buf[p++];
        while (repeat-- > 0 && i < numPoints) flags[i++] = f;
      }
    }

    const xs = new Int32Array(numPoints);
    let x = 0;
    for (let i = 0; i < numPoints; i++) {
      const f = flags[i];
      if (f & 0x02) {
        const d = this.buf[p++];
        x += f & 0x10 ? d : -d;
      } else if (!(f & 0x10)) {
        x += this.buf.readInt16BE(p);
        p += 2;
      }
      xs[i] = x;
    }

    const ys = new Int32Array(numPoints);
    let y = 0;
    for (let i = 0; i < numPoints; i++) {
      const f = flags[i];
      if (f & 0x04) {
        const d = this.buf[p++];
        y += f & 0x20 ? d : -d;
      } else if (!(f & 0x20)) {
        y += this.buf.readInt16BE(p);
        p += 2;
      }
      ys[i] = y;
    }

    const contours = [];
    let startPoint = 0;
    for (const last of endPts) {
      const pts = [];
      for (let i = startPoint; i <= last; i++) {
        pts.push({ x: xs[i], y: ys[i], on: (flags[i] & 0x01) !== 0 });
      }
      contours.push(flattenContour(pts));
      startPoint = last + 1;
    }
    return contours;
  }

  _readComposite(off, depth) {
    let p = off + 10;
    const contours = [];
    for (;;) {
      const flags = this.buf.readUInt16BE(p);
      const glyphIndex = this.buf.readUInt16BE(p + 2);
      p += 4;
      let dx, dy;
      if (flags & 0x0001) {
        dx = this.buf.readInt16BE(p);
        dy = this.buf.readInt16BE(p + 2);
        p += 4;
      } else {
        dx = this.buf.readInt8(p);
        dy = this.buf.readInt8(p + 1);
        p += 2;
      }
      let a = 1, b = 0, c = 0, d = 1;
      if (flags & 0x0008) {
        a = d = this.buf.readInt16BE(p) / 16384;
        p += 2;
      } else if (flags & 0x0040) {
        a = this.buf.readInt16BE(p) / 16384;
        d = this.buf.readInt16BE(p + 2) / 16384;
        p += 4;
      } else if (flags & 0x0080) {
        a = this.buf.readInt16BE(p) / 16384;
        b = this.buf.readInt16BE(p + 2) / 16384;
        c = this.buf.readInt16BE(p + 4) / 16384;
        d = this.buf.readInt16BE(p + 6) / 16384;
        p += 8;
      }
      const child = this.outline(glyphIndex, depth + 1);
      for (const contour of child) {
        contours.push(contour.map((pt) => ({
          x: a * pt.x + c * pt.y + dx,
          y: b * pt.x + d * pt.y + dy,
        })));
      }
      if (!(flags & 0x0020)) break;
    }
    return contours;
  }
}

/** Flatten one TrueType contour (mixture of on/off-curve points) to a polygon. */
function flattenContour(pts) {
  if (pts.length === 0) return [];
  const first = pts.find((p) => p.on);
  if (!first) return [];

  // Rotate so the contour starts on an on-curve point.
  const startIndex = pts.indexOf(first);
  const rotated = pts.slice(startIndex).concat(pts.slice(0, startIndex));

  const out = [{ x: first.x, y: first.y }];
  let prev = first;
  let i = 1;
  const n = rotated.length;
  let guard = 0;
  while (i <= n && guard++ < 10000) {
    const cur = rotated[i % n];
    if (cur.on) {
      out.push({ x: cur.x, y: cur.y });
      prev = cur;
      i++;
      continue;
    }
    // Off-curve: the next on-curve point (or implied midpoint) is the end.
    const nextRaw = rotated[(i + 1) % n];
    const nextOn = nextRaw.on
      ? nextRaw
      : { x: (cur.x + nextRaw.x) / 2, y: (cur.y + nextRaw.y) / 2, on: true };
    const steps = 8;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const mt = 1 - t;
      out.push({
        x: mt * mt * prev.x + 2 * mt * t * cur.x + t * t * nextOn.x,
        y: mt * mt * prev.y + 2 * mt * t * cur.y + t * t * nextOn.y,
      });
    }
    prev = nextOn;
    i += nextRaw.on ? 1 : 2;
    if (i > n) break;
  }
  return out;
}

export { Font };
