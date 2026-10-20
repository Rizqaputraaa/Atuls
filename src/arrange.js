const stage = document.getElementById('stage');
let layout = null;
let drag = null;
let view = { scale: 0.2, ox: 0, oy: 0 };

const computers = () => (layout && layout.peer ? [layout.self, layout.peer] : []);
const rect = (d, off) => ({ x: d.x + off.x, y: d.y + off.y, w: d.w, h: d.h });

function fit() {
  const rs = computers().flatMap((c) => c.displays.map((d) => rect(d, c.off)));
  if (!rs.length) return;
  const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.w)), y1 = Math.max(...rs.map((r) => r.y + r.h));
  const W = stage.clientWidth, H = stage.clientHeight, pad = 70;
  // leave room around the layout so a computer can be dragged to any side
  const bw = (x1 - x0) * 1.9, bh = (y1 - y0) * 1.9;
  const scale = Math.min((W - pad) / bw, (H - pad) / bh, 1.5); // pixels per millimetre
  view = { scale, ox: W / 2 - ((x0 + x1) / 2) * scale, oy: H / 2 - ((y0 + y1) / 2) * scale };
}

function render() {
  stage.querySelectorAll('.disp').forEach((n) => n.remove());
  const cs = computers();
  document.getElementById('empty').style.display = cs.length ? 'none' : 'grid';
  cs.forEach((c, ci) => {
    c.displays.forEach((d, i) => {
      const r = rect(d, c.off);
      const el = document.createElement('div');
      el.className = 'disp' + (ci === 0 ? ' self' : '') + (drag && drag.id === c.id ? ' drag' : '');
      el.style.left = view.ox + r.x * view.scale + 'px';
      el.style.top = view.oy + r.y * view.scale + 'px';
      el.style.width = r.w * view.scale + 'px';
      el.style.height = r.h * view.scale + 'px';
      el.innerHTML = `<div class="label">${ci === 0 ? 'This computer' : c.name}<small>${ci === 0 ? 'THIS COMPUTER' : 'LINKED'} · SCREEN ${i + 1} · ${Math.round(Math.hypot(d.w, d.h) / 25.4)}″</small></div>`;
      el.addEventListener('mousedown', (e) => start(e, c));
      stage.appendChild(el);
    });
  });
  document.getElementById('info').textContent = cs.map((c) => `${c.name}: ${c.displays.length} screen${c.displays.length > 1 ? 's' : ''}`).join('   ·   ');
}

function snap(c, off) {
  const other = computers().find((x) => x.id !== c.id);
  if (!other) return off;
  const th = 28 / view.scale / 4; // about 7 screen pixels worth of millimetres
  let best = { x: off.x, dx: th }, bestY = { y: off.y, dy: th };
  for (const m of c.displays) for (const o of other.displays) {
    const a = rect(m, off), b = rect(o, other.off);
    for (const adj of [b.x + b.w - a.x, b.x - (a.x + a.w), b.x - a.x, b.x + b.w - (a.x + a.w)]) {
      if (Math.abs(adj) < best.dx) best = { x: off.x + adj, dx: Math.abs(adj) };
    }
    for (const adj of [b.y + b.h - a.y, b.y - (a.y + a.h), b.y - a.y, b.y + b.h - (a.y + a.h)]) {
      if (Math.abs(adj) < bestY.dy) bestY = { y: off.y + adj, dy: Math.abs(adj) };
    }
  }
  return { x: best.x, y: bestY.y };
}

function start(e, c) {
  drag = { id: c.id, c, mx: e.clientX, my: e.clientY, off: { ...c.off } };
  render();
  e.preventDefault();
}
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const raw = { x: drag.off.x + (e.clientX - drag.mx) / view.scale, y: drag.off.y + (e.clientY - drag.my) / view.scale };
  drag.c.off = snap(drag.c, raw);
  render();
});
window.addEventListener('mouseup', () => {
  if (!drag) return;
  const { c } = drag;
  drag = null;
  api.setOffset(c.id, Math.round(c.off.x), Math.round(c.off.y));
});

api.onLayout((l) => { if (drag) return; layout = l; fit(); render(); });
api.getLayout().then((l) => { layout = l; fit(); render(); });
window.addEventListener('resize', () => { fit(); render(); });
