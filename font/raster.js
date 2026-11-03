/**
 * Anti-aliased coverage rasterizer.
 *
 * Two paths, because UI pixels come from two kinds of geometry:
 *
 *   polygons()  filled outlines (glyphs): analytical horizontal coverage with
 *               4x vertical supersampling, nonzero winding.
 *   strokes()   line art (Tabler icons): distance-to-segment brush, which gives
 *               round caps and joins for free.
 *
 * Output is an 8-bit coverage map, which is exactly what the runtime blends.
 */

const SUBSAMPLES = 4;

/** @param {Array<Array<{x:number,y:number}>>} contours closed polygons in px */
function polygons(contours, width, height) {
  const cover = new Float32Array(width * height);
  if (width <= 0 || height <= 0) return cover;

  // Build edges once.
  const edges = [];
  for (const contour of contours) {
    if (contour.length < 2) continue;
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i];
      const b = contour[(i + 1) % contour.length];
      if (a.y === b.y) continue;
      edges.push({
        x0: a.x, y0: a.y, x1: b.x, y1: b.y,
        dir: b.y > a.y ? 1 : -1,
        minY: Math.min(a.y, b.y),
        maxY: Math.max(a.y, b.y),
      });
    }
  }

  const crossings = [];
  const step = 1 / SUBSAMPLES;
  for (let py = 0; py < height; py++) {
    for (let sy = 0; sy < SUBSAMPLES; sy++) {
      const y = py + (sy + 0.5) * step;
      crossings.length = 0;
      for (const e of edges) {
        if (y < e.minY || y >= e.maxY) continue;
        const t = (y - e.y0) / (e.y1 - e.y0);
        crossings.push({ x: e.x0 + t * (e.x1 - e.x0), dir: e.dir });
      }
      if (crossings.length < 2) continue;
      crossings.sort((a, b) => a.x - b.x || a.dir - b.dir);

      let winding = 0;
      let spanStart = 0;
      for (const c of crossings) {
        const was = winding;
        winding += c.dir;
        if (was === 0 && winding !== 0) {
          spanStart = c.x;
        } else if (was !== 0 && winding === 0) {
          addSpan(cover, py, width, spanStart, c.x, step);
        }
      }
    }
  }

  const out = new Uint8Array(width * height);
  const scale = 255 / SUBSAMPLES;
  for (let i = 0; i < cover.length; i++) {
    const v = cover[i] * scale;
    out[i] = v >= 255 ? 255 : v <= 0 ? 0 : v | 0;
  }
  return out;
}

function addSpan(cover, py, width, x0, x1, weight) {
  if (x1 <= x0) return;
  const lo = Math.max(0, x0);
  const hi = Math.min(width, x1);
  if (hi <= lo) return;
  const row = py * width;
  let px = Math.floor(lo);
  const last = Math.ceil(hi);
  for (; px < last; px++) {
    const overlap = Math.min(hi, px + 1) - Math.max(lo, px);
    if (overlap > 0) cover[row + px] += overlap * weight;
  }
}

/**
 * @param {Array<Array<{x:number,y:number}>>} polylines in px
 * @param {number} halfWidth stroke half-width in px
 */
function strokes(polylines, width, height, halfWidth) {
  const out = new Uint8Array(width * height);
  if (width <= 0 || height <= 0) return out;
  const samples = 4;
  const sampleScale = 255 / (samples * samples);
  const reach = halfWidth + 1;
  const step = 1 / samples;

  const segments = [];
  for (const line of polylines) {
    if (line.length === 1) {
      segments.push({ ax: line[0].x, ay: line[0].y, bx: line[0].x, by: line[0].y });
      continue;
    }
    for (let i = 0; i + 1 < line.length; i++) {
      segments.push({ ax: line[i].x, ay: line[i].y, bx: line[i + 1].x, by: line[i + 1].y });
    }
  }

  const hw2 = halfWidth * halfWidth;
  for (const s of segments) {
    const minX = Math.max(0, Math.floor(Math.min(s.ax, s.bx) - reach));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(s.ax, s.bx) + reach));
    const minY = Math.max(0, Math.floor(Math.min(s.ay, s.by) - reach));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(s.ay, s.by) + reach));
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        let hits = 0;
        for (let sy = 0; sy < samples; sy++) {
          const y = py + (sy + 0.5) * step;
          for (let sx = 0; sx < samples; sx++) {
            const x = px + (sx + 0.5) * step;
            if (dist2ToSegment(x, y, s) <= hw2) hits++;
          }
        }
        if (hits === 0) continue;
        const idx = py * width + px;
        const add = hits * sampleScale;
        out[idx] = Math.min(255, out[idx] + add);
      }
    }
  }
  return out;
}

function dist2ToSegment(x, y, s) {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const px = x - s.ax;
    const py = y - s.ay;
    return px * px + py * py;
  }
  let t = ((x - s.ax) * dx + (y - s.ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = x - (s.ax + t * dx);
  const py = y - (s.ay + t * dy);
  return px * px + py * py;
}

function bounds(contours) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of contours) {
    for (const p of c) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

export { polygons, strokes, bounds };
