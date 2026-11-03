/**
 * Minimal SVG geometry reader for Tabler icons.
 *
 * Tabler's outline set is stroke art: 24x24 viewBox, stroke-width 2, round caps
 * and joins, no fills and no transforms. So we only need path data (including
 * arcs) plus the handful of primitive elements, flattened to polylines.
 */

const NUMBER = /-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

function tokenize(d) {
  const tokens = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
  let m;
  while ((m = re.exec(d))) tokens.push(m[1] ?? Number(m[2]));
  return tokens;
}

function arcToPoints(x0, y0, rx, ry, xAxisRotation, largeArc, sweep, x1, y1, steps = 12) {
  // F.6.5 endpoint to center parameterization.
  if (rx === 0 || ry === 0) return [{ x: x1, y: y1 }];
  const phi = (xAxisRotation * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx2 = (x0 - x1) / 2;
  const dy2 = (y0 - y1) / 2;
  const x1p = cos * dx2 + sin * dy2;
  const y1p = -sin * dx2 + cos * dy2;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const sign = largeArc === sweep ? -1 : 1;
  const numer = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denom = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, numer / denom));
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x0 + x1) / 2;
  const cy = sin * cxp + cos * cyp + (y0 + y1) / 2;

  const angle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  let theta1 = angle(1, 0, ux, uy);
  let dtheta = angle(ux, uy, vx, vy);
  if (!sweep && dtheta > 0) dtheta -= Math.PI * 2;
  if (sweep && dtheta < 0) dtheta += Math.PI * 2;

  const points = [];
  for (let i = 1; i <= steps; i++) {
    const t = theta1 + (dtheta * i) / steps;
    points.push({
      x: cos * rx * Math.cos(t) - sin * ry * Math.sin(t) + cx,
      y: sin * rx * Math.cos(t) + cos * ry * Math.sin(t) + cy,
    });
  }
  return points;
}

/** @returns {Array<Array<{x:number,y:number}>>} polylines in viewBox units */
function parsePath(d) {
  const t = tokenize(d);
  const subpaths = [];
  let current = null;
  let x = 0, y = 0;
  let startX = 0, startY = 0;
  let prevCtrlX = null, prevCtrlY = null;
  let cmd = null;
  let i = 0;

  const num = () => t[i++];
  const push = (px, py) => {
    if (!current) {
      current = [{ x: px, y: py }];
      subpaths.push(current);
    } else {
      current.push({ x: px, y: py });
    }
  };
  const cubic = (x1, y1, x2, y2, x3, y3) => {
    const steps = 12;
    for (let s = 1; s <= steps; s++) {
      const u = s / steps;
      const mu = 1 - u;
      push(
        mu * mu * mu * x + 3 * mu * mu * u * x1 + 3 * mu * u * u * x2 + u * u * u * x3,
        mu * mu * mu * y + 3 * mu * mu * u * y1 + 3 * mu * u * u * y2 + u * u * u * y3,
      );
    }
    x = x3;
    y = y3;
  };
  const quad = (x1, y1, x2, y2) => {
    const steps = 10;
    for (let s = 1; s <= steps; s++) {
      const u = s / steps;
      const mu = 1 - u;
      push(
        mu * mu * x + 2 * mu * u * x1 + u * u * x2,
        mu * mu * y + 2 * mu * u * y1 + u * u * y2,
      );
    }
    x = x2;
    y = y2;
  };

  while (i < t.length) {
    if (typeof t[i] === 'string') cmd = t[i++];
    if (!cmd) break;
    const rel = cmd >= 'a';
    switch (cmd.toUpperCase()) {
      case 'M': {
        const nx = num(), ny = num();
        x = rel ? x + nx : nx;
        y = rel ? y + ny : ny;
        current = [{ x, y }];
        subpaths.push(current);
        startX = x;
        startY = y;
        cmd = rel ? 'l' : 'L';
        prevCtrlX = prevCtrlY = null;
        break;
      }
      case 'L': {
        const nx = num(), ny = num();
        x = rel ? x + nx : nx;
        y = rel ? y + ny : ny;
        push(x, y);
        prevCtrlX = prevCtrlY = null;
        break;
      }
      case 'H': {
        const nx = num();
        x = rel ? x + nx : nx;
        push(x, y);
        prevCtrlX = prevCtrlY = null;
        break;
      }
      case 'V': {
        const ny = num();
        y = rel ? y + ny : ny;
        push(x, y);
        prevCtrlX = prevCtrlY = null;
        break;
      }
      case 'C': {
        const x1 = rel ? x + num() : num();
        const y1 = rel ? y + num() : num();
        const x2 = rel ? x + num() : num();
        const y2 = rel ? y + num() : num();
        const x3 = rel ? x + num() : num();
        const y3 = rel ? y + num() : num();
        cubic(x1, y1, x2, y2, x3, y3);
        prevCtrlX = x2;
        prevCtrlY = y2;
        break;
      }
      case 'S': {
        const x2 = rel ? x + num() : num();
        const y2 = rel ? y + num() : num();
        const x3 = rel ? x + num() : num();
        const y3 = rel ? y + num() : num();
        const x1 = prevCtrlX === null ? x : 2 * x - prevCtrlX;
        const y1 = prevCtrlY === null ? y : 2 * y - prevCtrlY;
        cubic(x1, y1, x2, y2, x3, y3);
        prevCtrlX = x2;
        prevCtrlY = y2;
        break;
      }
      case 'Q': {
        const x1 = rel ? x + num() : num();
        const y1 = rel ? y + num() : num();
        const x2 = rel ? x + num() : num();
        const y2 = rel ? y + num() : num();
        quad(x1, y1, x2, y2);
        prevCtrlX = x1;
        prevCtrlY = y1;
        break;
      }
      case 'T': {
        const x2 = rel ? x + num() : num();
        const y2 = rel ? y + num() : num();
        const x1 = prevCtrlX === null ? x : 2 * x - prevCtrlX;
        const y1 = prevCtrlY === null ? y : 2 * y - prevCtrlY;
        quad(x1, y1, x2, y2);
        prevCtrlX = x1;
        prevCtrlY = y1;
        break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num();
        const large = num(), sweep = num();
        const nx = num(), ny = num();
        const ex = rel ? x + nx : nx;
        const ey = rel ? y + ny : ny;
        for (const p of arcToPoints(x, y, rx, ry, rot, large, sweep, ex, ey)) push(p.x, p.y);
        x = ex;
        y = ey;
        prevCtrlX = prevCtrlY = null;
        break;
      }
      case 'Z': {
        if (current && (x !== startX || y !== startY)) push(startX, startY);
        x = startX;
        y = startY;
        current = null;
        prevCtrlX = prevCtrlY = null;
        break;
      }
      default:
        cmd = null;
    }
    if (cmd && cmd.toUpperCase() === 'Z') cmd = null;
  }
  return subpaths.filter((p) => p.length > 0);
}

const attr = (svg, name) => {
  const m = svg.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : undefined;
};

/** @returns {{width:number,height:number,polylines:Array,strokeWidth:number}} */
function parseSvg(svg) {
  const width = Number(attr(svg, 'width') ?? 24);
  const height = Number(attr(svg, 'height') ?? 24);
  const strokeWidth = Number(attr(svg, 'stroke-width') ?? 2);
  const polylines = [];

  for (const m of svg.matchAll(/<path\b[^>]*>/g)) {
    const d = attr(m[0], 'd');
    if (d) polylines.push(...parsePath(d));
  }
  for (const m of svg.matchAll(/<(line|polyline|polygon|rect|circle)\b[^>]*>/g)) {
    const tag = m[1];
    const el = m[0];
    const n = (name) => Number(attr(el, name) ?? 0);
    if (tag === 'line') {
      polylines.push([{ x: n('x1'), y: n('y1') }, { x: n('x2'), y: n('y2') }]);
    } else if (tag === 'polyline' || tag === 'polygon') {
      const pts = (attr(el, 'points') ?? '').match(NUMBER)?.map(Number) ?? [];
      const line = [];
      for (let i = 0; i + 1 < pts.length; i += 2) line.push({ x: pts[i], y: pts[i + 1] });
      if (tag === 'polygon' && line.length) line.push({ ...line[0] });
      if (line.length) polylines.push(line);
    } else if (tag === 'rect') {
      const x = n('x'), y = n('y'), w = n('width'), h = n('height');
      polylines.push([
        { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y },
      ]);
    } else if (tag === 'circle') {
      const cx = n('cx'), cy = n('cy'), r = n('r');
      const line = [];
      for (let i = 0; i <= 32; i++) {
        const a = (i / 32) * Math.PI * 2;
        line.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
      }
      polylines.push(line);
    }
  }
  return { width, height, polylines, strokeWidth };
}

export { parsePath, parseSvg };
