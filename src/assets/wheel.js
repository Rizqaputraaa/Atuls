// Shared by the radial menu, its settings window and the live preview: geometry of the ring and the icon set.
(function (root) {
  const DEFAULTS = { radius: 112, icon: 58, spacing: 14 };

  // Positions of n items on a ring around (0, 0), starting at the top. The ring grows when the items would otherwise touch
  // (distance between neighbours = icon size + spacing).
  function layout(n, a) {
    a = { ...DEFAULTS, ...(a || {}) };
    let R = a.radius;
    if (n > 1) R = Math.max(R, (a.icon + a.spacing) / (2 * Math.sin(Math.PI / n)));
    const pos = [];
    for (let i = 0; i < n; i++) {
      const ang = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      pos.push({ x: Math.round(R * Math.cos(ang)), y: Math.round(R * Math.sin(ang)), angle: ang });
    }
    return { R, pos };
  }
  // Window size that fits the largest ring (plus room for the label and the color dots)
  function size(maxItems, a) {
    a = { ...DEFAULTS, ...(a || {}) };
    const { R } = layout(Math.max(3, maxItems), a);
    return Math.max(340, Math.round(2 * (R + a.icon / 2) + 120));
  }
  // The item the pointer points at: the nearest by angle, once it is further than `zone` px from the centre
  function pick(n, a, dx, dy, zone) {
    if (!n || Math.hypot(dx, dy) < zone) return -1;
    const { pos } = layout(n, a);
    const ang = Math.atan2(dy, dx);
    let best = -1, bestD = Infinity;
    pos.forEach((p, i) => { let d = Math.abs(ang - p.angle); d = Math.min(d, 2 * Math.PI - d); if (d < bestD) { bestD = d; best = i; } });
    return bestD < Math.PI / Math.max(2, n) + 0.3 ? best : -1;
  }

  const svg = (body) => '<svg viewBox="0 0 24 24">' + body + '</svg>';
  const ICONS = {
    pickColor: svg('<path d="M14.5 5.5l4 4"/><path d="M16.5 3.5a2 2 0 0 1 3 3l-2 2-3-3z"/><path d="M14.5 8.5L5 18l-1 3 3-1 9.5-9.5"/>'),
    screenshot: svg('<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/>'),
    missionControl: svg('<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/><path d="M10.5 8.5l4 2-4 2z"/>'),
    desktopLeft: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M14 9l-3 3 3 3"/>'),
    desktopRight: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l3 3-3 3"/>'),
    back: svg('<path d="M15 6l-6 6 6 6"/>'),
    forward: svg('<path d="M9 6l6 6-6 6"/>'),
    workspace: svg('<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>'),
    app: svg('<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M4 9h16"/>'),
    url: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.4 3.6 5.2 3.6 8.5s-1.1 6.1-3.6 8.5c-2.5-2.4-3.6-5.2-3.6-8.5S9.5 5.9 12 3.5z"/>'),
    folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    none: svg('<circle cx="12" cy="12" r="8"/>'),
    back2: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  };

  const api = { DEFAULTS, layout, size, pick, ICONS };
  root.Wheel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
