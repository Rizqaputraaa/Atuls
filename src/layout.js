// Geometry for several screens on several computers.
//
// Every display is { x, y, w, h } in the computer's own input pixels (what the mouse hook reports)
// plus { dx, dy, dw, dh } in device-independent points. Points are the common unit: each computer has an
// offset { x, y } that places its point-space in one shared "plane", which is what the arrange window edits.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const inRect = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
const planeRect = (d, off) => ({ x: d.dx + off.x, y: d.dy + off.y, w: d.dw, h: d.dh });

const dispAt = (disps, x, y) => disps.find((d) => inRect(d, x, y)) || null;

function toPlane(d, off, px, py) {
  return { x: d.dx + ((px - d.x) * d.dw) / d.w + off.x, y: d.dy + ((py - d.y) * d.dh) / d.h + off.y };
}

// plane point -> input pixels on the nearest of these displays
function fromPlane(disps, off, q) {
  let best = null, bestDist = Infinity, bx = 0, by = 0;
  for (const d of disps) {
    const r = planeRect(d, off);
    const cx = clamp(q.x, r.x, r.x + r.w), cy = clamp(q.y, r.y, r.y + r.h);
    const dist = Math.hypot(q.x - cx, q.y - cy);
    if (dist < bestDist) { best = d; bestDist = dist; bx = cx; by = cy; }
  }
  if (!best) return null;
  const r = planeRect(best, off);
  return {
    d: best,
    x: clamp(best.x + ((bx - r.x) * best.w) / best.dw, best.x, best.x + best.w - 1),
    y: clamp(best.y + ((by - r.y) * best.h) / best.dh, best.y, best.y + best.h - 1),
  };
}

const VEC = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

// Is the point on an exposed edge that faces a display of the other computer? If so, where does it land?
// `motion` (optional) limits the check to edges the pointer is moving out of.
function crossing(mine, mineOff, other, otherOff, px, py, motion) {
  const d = dispAt(mine, px, py);
  if (!d) return null;
  const edges = [];
  if (px <= d.x) edges.push('left');
  if (px >= d.x + d.w - 1) edges.push('right');
  if (py <= d.y) edges.push('top');
  if (py >= d.y + d.h - 1) edges.push('bottom');
  for (const dir of edges) {
    if (motion) {
      const [vx, vy] = VEC[dir];
      if ((vx && motion.dx * vx <= 0) || (vy && motion.dy * vy <= 0)) continue;
    }
    const p = toPlane(d, mineOff, clamp(px, d.x, d.x + d.w - 1), clamp(py, d.y, d.y + d.h - 1));
    const [vx, vy] = VEC[dir];
    for (let step = 0.3; step <= 25; step += 0.3) { // up to 25 mm of gap
      const h = { x: p.x + vx * step, y: p.y + vy * step };
      if (mine.some((m) => inRect(planeRect(m, mineOff), h.x, h.y))) break; // another screen of ours is in the way
      if (other.some((o) => inRect(planeRect(o, otherOff), h.x, h.y))) return { dir, h };
    }
  }
  return null;
}

// nearest point on any of these displays (keeps a pointer inside the screens)
function clampToDisplays(disps, x, y) {
  let best = null, bestDist = Infinity;
  for (const d of disps) {
    const cx = clamp(x, d.x, d.x + d.w - 1), cy = clamp(y, d.y, d.y + d.h - 1);
    const dist = Math.hypot(x - cx, y - cy);
    if (dist < bestDist) { best = { x: cx, y: cy, d }; bestDist = dist; }
  }
  return best;
}

// bounding box of a computer's displays in its own point space
function pointBounds(disps) {
  const x0 = Math.min(...disps.map((d) => d.dx)), y0 = Math.min(...disps.map((d) => d.dy));
  const x1 = Math.max(...disps.map((d) => d.dx + d.dw)), y1 = Math.max(...disps.map((d) => d.dy + d.dh));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// default placement of `other` next to `mine` on the chosen side
function placeBeside(mine, mineOff, other, side) {
  const a = pointBounds(mine), b = pointBounds(other);
  const ax = a.x + mineOff.x, ay = a.y + mineOff.y;
  const target = {
    right: { x: ax + a.w, y: ay },
    left: { x: ax - b.w, y: ay },
    bottom: { x: ax, y: ay + a.h },
    top: { x: ax, y: ay - b.h },
  }[side] || { x: ax + a.w, y: ay };
  return { x: target.x - b.x, y: target.y - b.y };
}

// which side of `mine` the other computer is on, judged from the main screens in the shared plane
function sideOf(mine, mineOff, other, otherOff) {
  const main = (ds) => { const m = ds.filter((d) => d.dx === 0 && d.dy === 0); return m.length ? m : ds; };
  const a = pointBounds(main(mine)), b = pointBounds(main(other));
  const ax = a.x + mineOff.x + a.w / 2, ay = a.y + mineOff.y + a.h / 2;
  const bx = b.x + otherOff.x + b.w / 2, by = b.y + otherOff.y + b.h / 2;
  const dx = (bx - ax) / ((a.w + b.w) / 2), dy = (by - ay) / ((a.h + b.h) / 2);
  return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top');
}

module.exports = { sideOf, dispAt, toPlane, fromPlane, crossing, clampToDisplays, pointBounds, placeBeside, planeRect, VEC };
