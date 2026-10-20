document.body.classList.add(api.platform);
const ui = (m) => { try { api.log(m); } catch {} }; // one line in the run log for what the user does
const $ = (s) => document.querySelector(s);
const island = $('#island');
let closeTimer, playing = false, toastTimer = null, toastOn = false;

// The main process polls the cursor and tells us when it is over the island
const MACOS = api.platform === 'darwin';
const SIZES = { compact: MACOS ? [464, 34] : [234, 34], open: [464, 360], toast: MACOS ? [520, 100] : [380, 100] };
// the pill is as tall as the menu bar (notched MacBooks) and leaves the notch free
api.metrics().then((m) => {
  const h = m.bar;
  SIZES.compact[1] = h; SIZES.toast[1] = h + 64;
  if (MACOS) SIZES.open[1] = 360 + h - 10;
  document.documentElement.style.setProperty('--ph', h + 'px');
  document.documentElement.style.setProperty('--gap', m.notch ? '210px' : '0px');
  if (!isOpen) { api.islandSize(...SIZES.compact); api.windowSize(...SIZES.compact); }
});
let needLeave = false, hoverInside = false, isOpen = false, shrinkTimer, pinned = false;
const setOpen = (v) => {
  if (v !== isOpen) ui(v ? 'island panel opened' : 'island panel closed');
  isOpen = v;
  island.classList.toggle('open', v);
  island.classList.toggle('compact', !v);
  api.islandSize(...SIZES[v ? 'open' : 'compact']);
  // the window is exactly as big as the island: grow at once, shrink after the animation
  clearTimeout(shrinkTimer);
  if (v) { endToast(); api.windowSize(...SIZES.open); }
  else shrinkTimer = setTimeout(() => { if (!isOpen) api.windowSize(...(toastOn ? SIZES.toast : SIZES.compact)); }, 450);
};
setOpen(false);
api.onHover((inside) => {
  hoverInside = inside;
  clearTimeout(closeTimer);
  if (!inside) needLeave = false;
  if (inside) { if (!isOpen && !needLeave) setOpen(true); return; }
  if (pinned) return; // a click inside keeps the island open until you click outside
  closeTimer = setTimeout(() => {
    if (document.activeElement && /INPUT|SELECT/.test(document.activeElement.tagName)) return;
    setOpen(false);
  }, 350);
});
// clicking anything inside pins the island open; main tells us when a click lands outside
document.getElementById('panel').addEventListener('mousedown', () => { if (!pinned) { pinned = true; api.pin(true); } });
api.onUnpin(() => { pinned = false; api.pin(false); if (!hoverInside) setOpen(false); });
// keep the popover open while typing in the link form
document.addEventListener('focusin', (e) => /INPUT|SELECT/.test(e.target.tagName) && api.keepOpen(true));
document.addEventListener('focusout', () => api.keepOpen(false));
// a file dropped anywhere on the island (not just on a zone) goes to the tray instead of falling through
['dragover', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault()));
document.addEventListener('drop', (e) => {
  if (e.defaultPrevented && e.target.closest && e.target.closest('.zone')) return;
  const ps = [...e.dataTransfer.files].map((f) => api.pathFor(f)).filter(Boolean);
  ps.forEach((p) => files.includes(p) || files.push(p));
  if (ps.length) { api.setTray(files); renderFiles(); }
});
// drag diagnostics (read from the app log while testing drops)
['dragenter', 'dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => console.log('[drag]', ev, Math.round(e.clientX) + ',' + Math.round(e.clientY), (e.target.id || e.target.className || e.target.tagName), 'files', e.dataTransfer ? e.dataTransfer.files.length : '-')));
let lastOver = 0;
document.addEventListener('dragover', (e) => { if (Date.now() - lastOver > 700) { lastOver = Date.now(); console.log('[drag] over', Math.round(e.clientX) + ',' + Math.round(e.clientY), 'island', island.offsetWidth + 'x' + island.offsetHeight); } });
// dragging a file onto the island jumps straight to the tray
document.addEventListener('dragenter', () => {
  console.log('[drop] dragenter');
  const b = document.querySelector('nav button[data-tab="tray"]');
  if (!b.classList.contains('on')) b.click();
});

const clock = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
// pill text: shown as is; when it is wider than the pill it glides back and forth (pause - slide - pause), smoothly
let pillShown = null;
function setPillText(t) {
  if (t === pillShown) return; // the clock ticks every second: don't restart the animation for identical text
  pillShown = t;
  const box = $('#pill-text');
  box.classList.remove('marquee');
  box.textContent = '';
  const inner = document.createElement('span');
  inner.textContent = t;
  box.appendChild(inner);
  requestAnimationFrame(() => {
    const over = inner.scrollWidth - box.clientWidth;
    if (over > 2) {
      inner.style.setProperty('--shift', -over + 'px');
      inner.style.animationDuration = (over / 28 + 3.5).toFixed(1) + 's';
      box.classList.add('marquee');
    }
  });
}
setInterval(() => { if (!playing) setPillText(clock()); }, 1000);
setPillText(clock());

document.querySelectorAll('nav button[data-tab]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('nav button[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
  ui('island tab -> ' + b.dataset.tab);
  ['media', 'tray', 'link'].forEach((t) => ($(`#tab-${t}`).hidden = t !== b.dataset.tab));
}));
// the gear opens the settings window (everything that can be set lives there)
$('#gear').onclick = () => {
  ui('island gear clicked');
  api.openSettings();
  // the panel gets out of the way: back to the small pill (it opens again only after the pointer has left it once)
  pinned = false; api.pin(false); needLeave = hoverInside; setOpen(false);
};

// media button icons: the normal ones are text symbols, the "10 seconds" ones are small drawings
const MEDIA_ICON = {
  prev: '&#9198;', next: '&#9197;',
  back10: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.6 12a8.4 8.4 0 1 0 2.5-5.9"/><path d="M3.4 3.8v4.2h4.2"/><text x="12" y="15.4" font-size="7.4" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui, sans-serif">10</text></svg>',
  fwd10: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.4 12a8.4 8.4 0 1 1-2.5-5.9"/><path d="M20.6 3.8v4.2h-4.2"/><text x="12" y="15.4" font-size="7.4" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui, sans-serif">10</text></svg>',
};
const setIcon = (btn, name) => { if (btn.dataset.icon !== name) { btn.dataset.icon = name; btn.innerHTML = MEDIA_ICON[name]; } };
// media
api.onMedia((m) => {
  playing = m.status === 'Playing';
  $('#np-title').textContent = m.title || 'Nothing playing';
  $('#np-artist').textContent = m.artist || '';
  if (m.thumb !== undefined || !m.title) { const t = m.title ? m.thumb : '', img = $('#np-img'); if (t) img.src = t; img.hidden = !t; $('#np-note').hidden = !!t; }
  $('#play').innerHTML = playing ? '&#9208;' : '&#9654;';
  // a player without previous / next tracks (a podcast, a single video): the buttons go back / forward 10 seconds, and say so with their icon
  const seekBack = m.canPrev === false, seekFwd = m.canNext === false;
  $('#prev').title = seekBack ? 'Back 10 seconds' : 'Previous';
  $('#next').title = seekFwd ? 'Forward 10 seconds' : 'Next';
  setIcon($('#prev'), seekBack ? 'back10' : 'prev');
  setIcon($('#next'), seekFwd ? 'fwd10' : 'next');
  $('#pill-dot').classList.toggle('live', playing);
  setPillText(playing && m.title ? m.title : clock());
});
$('#prev').onclick = () => api.mediaKey('prev');
$('#play').onclick = () => api.mediaKey('play');
$('#next').onclick = () => api.mediaKey('next');

// file tray
let files = [], connected = false;
// Dragging a file chip: our own ghost follows the pointer (always visible). Let go on "Send" = send it to the other
// computer; leave the island with the button held = a normal drag out to Finder / Explorer.
let chipDragEnd = 0;
function startChipDrag(e0, f, chip) {
  const sx = e0.clientX, sy = e0.clientY;
  let ghost = null;
  const finish = () => {
    document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.documentElement.removeEventListener('mouseleave', leave);
    const had = !!ghost;
    if (ghost) { ghost.remove(); ghost = null; $('#send').classList.remove('over'); chipDragEnd = Date.now(); }
    return had;
  };
  const move = (ev) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      ghost = chip.cloneNode(true); ghost.classList.add('ghost'); document.body.appendChild(ghost);
    }
    ghost.style.left = ev.clientX + 'px'; ghost.style.top = ev.clientY + 'px';
    const t = document.elementFromPoint(ev.clientX, ev.clientY);
    $('#send').classList.toggle('over', !!(t && t.closest('#send')));
  };
  const up = (ev) => {
    if (!finish()) return;
    const t = document.elementFromPoint(ev.clientX, ev.clientY);
    if (t && t.closest('#send')) {
      if (!connected) $('#xfer').textContent = 'Link a computer first (Link tab)'; else sendPath(f);
    }
  };
  const leave = () => { if (finish()) api.dragOut(f); };
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up); document.documentElement.addEventListener('mouseleave', leave);
}
const renderFiles = () => {
  $('#files-head').hidden = !files.length;
  $('#files-count').textContent = files.length === 1 ? '1 file in the tray' : files.length + ' files in the tray';
  $('#send-label').textContent = connected ? (files.length ? `Send tray (${files.length})` : 'Send to other PC') : 'Link a computer to send';
  const box = $('#files'); box.innerHTML = '';
  files.forEach((f, i) => {
    const el = document.createElement('div');
    el.className = 'file';
    const nm = document.createElement('span'); nm.className = 'fname'; nm.textContent = f.split(/[\\/]/).pop(); el.appendChild(nm);
    el.title = f + '\n(drag onto "Send" to send it, double-click to open, right-click to remove)';
    el.draggable = false;
    el.onmousedown = (e) => { if (e.button === 0) startChipDrag(e, f, el); };
    // own double-click detection: some pointers (and first clicks on macOS) don't produce dblclick events
    let lastClick = 0;
    el.onclick = () => { if (Date.now() - chipDragEnd < 300) return; const t = Date.now(); if (t - lastClick < 500) { lastClick = 0; api.open(f); } else lastClick = t; };
    el.oncontextmenu = (e) => { e.preventDefault(); files.splice(i, 1); api.setTray(files); renderFiles(); };
    box.appendChild(el);
  });
};
api.getTray().then((l) => { files = l; renderFiles(); });
api.onTray((l) => { files = l; renderFiles(); document.querySelector('nav button[data-tab="tray"]').click(); });
const zone = (el, onFiles) => {
  ['dragenter', 'dragover'].forEach((ev) => el.addEventListener(ev, (e) => { e.preventDefault(); el.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => el.addEventListener(ev, () => el.classList.remove('over')));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    onFiles([...e.dataTransfer.files].map((f) => api.pathFor(f)).filter(Boolean));
  });
};
zone($('#drop'), (ps) => {
  console.log('[drop] keep-in-tray', ps.length); ps.forEach((p) => files.includes(p) || files.push(p)); api.setTray(files); renderFiles(); });
// click the Send tile: sends everything that is in the tray to the other computer
$('#send').addEventListener('click', () => {
  if (!connected) { $('#xfer').textContent = 'Link a computer first (Link tab)'; return; }
  if (!files.length) { $('#xfer').textContent = 'The tray is empty: drop files on Files Tray first'; return; }
  files.slice().forEach(sendPath);
});
zone($('#send'), (ps) => { console.log('[drop] send', ps.length); if (!connected) { $('#xfer').textContent = 'Link a computer first (Link tab)'; return; } ps.forEach(sendPath); });
$('#clear').onclick = () => { ui('tray cleared'); files = []; api.setTray(files); renderFiles(); $('#xfer').textContent = ''; };
// macOS: the main process recognises a file dragged onto the island itself (the panel window may not receive the drop)
let lastDomDrop = 0;
document.addEventListener('drop', () => { lastDomDrop = Date.now(); }, true);
api.onDragStart(() => { const b = document.querySelector('nav button[data-tab="tray"]'); if (!b.classList.contains('on')) b.click(); });
api.onNativeDrop((ps, x, y) => {
  if (Date.now() - lastDomDrop < 1500) return; // the page got the drop itself
  const el = document.elementFromPoint(x, y);
  console.log('[drop] native', ps.length, el && (el.id || el.className || el.tagName));
  if (el && el.closest('#send')) { if (!connected) { $('#xfer').textContent = 'Link a computer first (Link tab)'; return; } ps.forEach(sendPath); }
  else { ps.forEach((p) => files.includes(p) || files.push(p)); api.setTray(files); renderFiles(); }
  const b = document.querySelector('nav button[data-tab="tray"]'); if (!b.classList.contains('on')) b.click();
});

const sendPath = async (p) => {
  ui('tray send file ' + String(p).split(/[\\/]/).pop());
  const r = await api.sendFile(p);
  if (!r.ok) $('#xfer').textContent = 'Send failed: ' + r.error;
};
api.onTransfer((t) => {
  const arrow = t.dir === 'out' ? 'Sending' : 'Receiving';
  $('#xfer').textContent = t.done ? `${t.dir === 'out' ? 'Sent' : 'Received'} ${t.name}` : `${arrow} ${t.name} ${t.pct}%`;
  if (t.done && t.dir === 'in' && t.path && !files.includes(t.path)) { files.push(t.path); api.setTray(files); renderFiles(); }
});

// link
const ICON = {
  win32: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/></svg>',
  darwin: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/></svg>',
};
const SIDE_TEXT = { left: 'on the left', right: 'on the right', top: 'above', bottom: 'below' };
let sideVal = 'right', linkInfo = { connected: false }, connecting = false;
const setSide = (s) => { sideVal = s; document.querySelectorAll('#side button').forEach((b) => b.classList.toggle('on', b.dataset.side === s)); };
document.querySelectorAll('#side button').forEach((b) => (b.onclick = () => setSide(b.dataset.side)));
// connected: the same four buttons move the other computer's screens in the layout (and show where it is now)
document.querySelectorAll('#peer-side button').forEach((b) => (b.onclick = async () => { ui('link side -> ' + b.dataset.side); await api.linkSetSide(b.dataset.side); }));
const fmtPin = (p) => (p && p.length === 6 ? p.slice(0, 3) + ' ' + p.slice(3) : p || '');
const say = (text, good) => { const m = $('#link-msg'); m.textContent = text; m.style.color = good ? '#30d158' : ''; };
const renderLink = (s) => {
  linkInfo = s;
  if (connected !== s.connected) { connected = s.connected; $('#send').classList.toggle('off', !connected); $('#send-label').textContent = connected ? 'Send to other PC' : 'Link a computer to send'; renderFiles(); }
  $('#me-name').textContent = s.name || '';
  $('#pin').textContent = fmtPin(s.pin);
  $('#addr').textContent = (s.addresses || []).join('  ') || 'No network';
  // connected: the other computer gets a card; the pairing form becomes "connect a different computer"
  $('#peer-card').hidden = !s.connected;
  $('#peer-actions').hidden = !s.connected;
  $('#peer-side-row').hidden = !s.connected;
  document.querySelectorAll('#peer-side button').forEach((b) => b.classList.toggle('on', b.dataset.side === s.peerSide));
  if (s.connected) {
    $('#peer-icon').innerHTML = ICON[s.peerPlat] || ICON.win32;
    $('#peer-name').textContent = s.peerName || 'Other computer';
    $('#peer-sub').textContent = (s.peerPlat === 'darwin' ? 'Mac' : 'Windows PC') + ' · ' + (SIDE_TEXT[s.peerSide] || '');
    $('#peer-state').textContent = s.state === 'controlling' ? 'Controlling it' : s.state === 'controlled' ? 'Controlled by it' : 'Ready';
    $('#peer-state').classList.toggle('live', s.state !== 'idle');
  }
  $('#pair-title').textContent = s.connected ? 'Connect a different computer (replaces this link)' : 'Connect to a computer';
  $('#pill-link').textContent = s.connected ? '⇄' : '';
  // the other computer is steering this one: the link mark turns amber and pulses, so nobody wonders why the pointer moves
  $('#pill-link').classList.toggle('ctl', !!s.connected && s.state === 'controlled');
  $('#pill-link').title = s.connected ? (s.state === 'controlled' ? 'Being controlled by ' + (s.peerName || 'the other computer') : s.state === 'controlling' ? 'Controlling ' + (s.peerName || 'the other computer') : 'Linked to ' + (s.peerName || 'the other computer')) : '';
  renderNearby();
};

// computers found on this network
let nearby = [];
const renderNearby = () => {
  const box = $('#nearby'); box.innerHTML = '';
  const list = nearby.filter((n) => !(linkInfo.connected && linkInfo.peerId === n.id));
  $('#nearby-empty').hidden = list.length > 0;
  list.forEach((n) => {
    const el = document.createElement('div');
    el.className = 'rec';
    el.innerHTML = '<i></i><b></b><span></span>';
    el.querySelector('i').innerHTML = ICON[n.plat] || ICON.win32;
    el.querySelector('b').textContent = n.name;
    el.querySelector('span').textContent = n.host;
    el.title = 'Enter its pairing code to connect';
    el.onclick = () => { $('#host').value = n.host; $('#code').focus(); say('Type the code shown on ' + n.name, true); };
    box.appendChild(el);
  });
};
api.linkNearby().then((l) => { nearby = l; renderNearby(); });
api.onNearby((l) => { nearby = l; renderNearby(); });

const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
const connectTo = async (host, code, side, label) => {
  if (connecting) return;
  connecting = true;
  ui('link connect to ' + host + (code ? ' with a code' : ' with the saved token'));
  const btn = $('#connect'); btn.disabled = true; btn.textContent = 'Connecting...';
  say('Connecting' + (label ? ' to ' + label : '') + '...', true);
  let r;
  try { r = await api.linkConnect(host, code, side); } catch (e) { r = { ok: false, error: e.message }; }
  connecting = false; btn.disabled = false; btn.textContent = 'Connect';
  if (r.ok) { say(''); $('#code').value = ''; if (code) await api.linkSetSide(side); return; }
  const e = String(r.error || '');
  say(/Wrong pairing code|denied/i.test(e) ? 'That code is not right. Check it on the other computer.'
    : /ECONNREFUSED|ETIMEDOUT|timeout|EHOSTUNREACH|ENETUNREACH/i.test(e) ? 'Could not reach that computer. Is A-tuls running there, on the same network?'
    : e || 'Could not connect');
};
const renderRecent = async () => {
  const list = await api.linkRecent();
  $('#recent-title').hidden = !list.length;
  const box = $('#recent'); box.innerHTML = '';
  list.forEach((r) => {
    const el = document.createElement('div');
    el.className = 'rec';
    el.innerHTML = '<i></i><b></b><span></span><span class="x" title="Forget this device">✕</span>';
    el.querySelector('i').innerHTML = ICON.win32;
    el.querySelector('b').textContent = r.name;
    el.querySelectorAll('span')[0].textContent = ago(r.lastSeen);
    el.onclick = () => connectTo(r.host, '', r.side || 'right', r.name);
    el.querySelector('.x').onclick = async (e) => { e.stopPropagation(); await api.linkForget(r.id); renderRecent(); };
    box.appendChild(el);
  });
};
api.onLink((s) => { if (!s.connected) renderRecent(); });
renderRecent();
api.onLink(renderLink);
api.linkStatus().then(renderLink);
// the code is typed as 123 456; Enter connects; a nearby computer fills in the address
$('#code').addEventListener('input', () => { const d = $('#code').value.replace(/\D/g, '').slice(0, 6); $('#code').value = d.length > 3 ? d.slice(0, 3) + ' ' + d.slice(3) : d; });
const submit = () => {
  const host = $('#host').value.trim(), code = $('#code').value.replace(/\D/g, '');
  if (!host) return say('Pick a computer from Nearby, or enter its address.');
  if (code.length !== 6) return say('Enter the 6-digit code shown on the other computer.');
  connectTo(host, code, sideVal);
};
$('#connect').onclick = submit;
['#code', '#host'].forEach((id) => $(id).addEventListener('keydown', (e) => e.key === 'Enter' && submit()));
$('#pin-box').onclick = async () => { try { await navigator.clipboard.writeText(linkInfo.pin || ''); say('Code copied', true); setTimeout(() => say(''), 1500); } catch {} };
$('#disconnect').onclick = () => { ui('link disconnect clicked'); api.linkDisconnect(); };

// permission warning
const showPerm = (ok) => ($('#perm').hidden = ok);
api.permGet().then(showPerm);
api.onPerm(showPerm);

$('#arrange').onclick = () => { ui('arrange screens clicked'); api.openArrange(); };

// Look to switch: the camera banner and the dot in the pill (the controls are in the settings window)
const renderGaze = (g) => { $('#cam-banner').hidden = !g.camera; $('#pill-cam').hidden = !g.camera; };
api.gazeGet().then(renderGaze);
api.onGaze(renderGaze);


// toast banner: a block that hangs under the pill for a few seconds (the pill stays on top, joined to it)
function endToast() {
  clearTimeout(toastTimer);
  if (typeof stopRing === 'function') stopRing();
  if (!toastOn) return;
  toastOn = false;
  island.classList.remove('toast');
  if (!isOpen) { api.islandSize(...SIZES.compact); api.windowSize(...SIZES.compact); }
}
let ringTimers = [];
const stopRing = () => { ringTimers.forEach(clearTimeout); ringTimers = []; };
// An arrow that points from this screen toward the other computer (screen sides come from the link status)
const ARROWS = {
  right: '<path d="M5 12h14M13 6l6 6-6 6"/>', left: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  top: '<path d="M12 19V5M6 11l6-6 6 6"/>', bottom: '<path d="M12 5v14M6 13l6 6 6-6"/>',
};
const HERE = '<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="8"/>'; // a target: look at this screen
// Calibration step. The ring is progress only (no number, so it cannot be mistaken for the step): it fills softly while you get
// ready, then fills blue while you hold still. The picture inside tells where to look; the step is shown as dots on the right.
function runRing(ready, hold, there) {
  const icon = $('#toast-icon');
  const dir = (linkInfo && linkInfo.peerSide) || 'right';
  icon.innerHTML = '<svg class="ring" viewBox="0 0 36 36"><circle class="track" cx="18" cy="18" r="15"/><circle class="bar" cx="18" cy="18" r="15"/></svg><svg id="ring-ico" viewBox="0 0 24 24">' + (there ? (ARROWS[dir] || ARROWS.right) : HERE) + '</svg>';
  const bar = icon.querySelector('.bar'), text = $('#toast-text');
  const run = (secs) => { bar.style.animation = 'none'; void bar.getBoundingClientRect(); bar.style.animation = `ringfill ${secs}s linear forwards`; };
  icon.classList.remove('hold');
  for (let i = 0; i < ready; i++) ringTimers.push(setTimeout(() => { text.textContent = `Get ready \u00b7 starting in ${ready - i} s`; }, i * 1000));
  run(ready);
  ringTimers.push(setTimeout(() => { icon.classList.add('hold'); run(hold); text.textContent = 'Hold still...'; }, ready * 1000));
}
api.onToast((t) => {
  stopRing();
  $('#toast-icon').classList.remove('hold');
  const err = t.kind === 'err', prog = t.kind === 'progress';
  $('#toast-title').textContent = t.title;
  $('#toast-text').textContent = t.text;
  $('#toast').classList.toggle('err', err);
  $('#toast').classList.toggle('prog', prog);
  $('#toast-text').textContent = t.text;
  const gl = $('#toast-glyph');
  gl.hidden = !(prog && t.step);
  gl.className = 'steps';
  gl.title = prog && t.step ? `Step ${t.step} of ${t.of || 2}` : '';
  gl.innerHTML = Array.from({ length: t.of || 2 }, (_x, i) => `<i class="${i + 1 === t.step ? 'on' : i + 1 < t.step ? 'done' : ''}"></i>`).join('');
  if (prog) runRing(t.ready || 3, t.hold || 2, t.glyph === 'there');
  else $('#toast-icon').innerHTML = err
    ? '<svg viewBox="0 0 24 24"><path d="M12 6.5v7"/><path d="M12 17.5v.01"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M5.5 12.5l4.2 4.2L18.5 7.8"/></svg>';
  // an open panel (e.g. right after pressing Connect) closes at once and the toast takes its place
  toastOn = true;
  island.classList.add('toast');
  if (isOpen) {
    pinned = false; api.pin(false);
    needLeave = hoverInside; // don't pop the panel open again until the mouse has left the pill
    setOpen(false);
  } else { api.islandSize(...SIZES.compact); api.windowSize(...SIZES.toast); }
  // replay the entrance animation (block drops in, icon pops, tick draws, text slides up)
  const box = $('#toast');
  box.classList.remove('play'); void box.offsetWidth; box.classList.add('play');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(endToast, prog ? ((t.ready || 3) + (t.hold || 2)) * 1000 + 6000 : 4500); // a step stays until the next message replaces it
});


// calendar strip: today and the days around it (a real calendar can be connected later)
const renderCalendar = () => {
  const now = new Date();
  $('#cal-month').textContent = now.toLocaleDateString([], { month: 'short' });
  $('#cal-year').textContent = now.getFullYear();
  const box = $('#cal-week'); box.innerHTML = '';
  for (let d = -2; d <= 2; d++) {
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
    const el = document.createElement('div');
    el.className = 'day' + (d === 0 ? ' today' : '') + (d < 0 ? ' past' : '');
    el.innerHTML = '<small></small><b></b>';
    el.querySelector('small').textContent = t.toLocaleDateString([], { weekday: 'short' }).toUpperCase();
    el.querySelector('b').textContent = t.getDate();
    box.appendChild(el);
  }
};
renderCalendar();
setInterval(renderCalendar, 60000);
// Home page, left button: Calibrate while a computer is linked, Connect (opens the Link tab) while none is. Under it, while linked, the
// Look to switch switch.
let gazeNow = { enabled: false }, nookLinked = false;
const gotoLink = () => document.querySelector('nav button[data-tab="link"]').click();
const renderNook = () => {
  const g = gazeNow;
  $('#nook-cal-ico').hidden = !nookLinked;
  $('#nook-cal-link').hidden = nookLinked;
  $('#nook-cal-text').textContent = !nookLinked ? 'Connect' : !g.enabled ? 'Calibrate' : g.calibrating ? 'Calibrating...' : g.calibrated ? 'Recalibrate' : 'Calibrate';
  $('#nook-gaze').hidden = !nookLinked;
  $('#nook-gaze-sw').classList.toggle('on', !!g.enabled);
  $('#nook-gaze-sw').setAttribute('aria-checked', g.enabled ? 'true' : 'false');
};
api.onGaze((g) => { gazeNow = g; renderNook(); });
api.gazeGet().then((g) => { gazeNow = g; renderNook(); });
api.onLink((st) => { nookLinked = !!st.connected; renderNook(); });
api.linkStatus().then((st) => { nookLinked = !!st.connected; renderNook(); });
$('#nook-cal').onclick = async () => {
  ui('home: ' + (nookLinked ? 'calibrate' : 'connect') + ' clicked');
  if (!nookLinked) return gotoLink(); // nothing to calibrate without a linked computer: open the Link tab
  if (!gazeNow.enabled) { await api.gazeSet(true); setTimeout(() => api.gazeCalibrate(), 2500); return; }
  api.gazeCalibrate();
};
$('#nook-gaze-sw').onclick = () => { ui('home: look to switch ' + (gazeNow.enabled ? 'off' : 'on')); api.gazeSet(!gazeNow.enabled); };

// the dot on the Pick color button shows the last color
api.colorsGet().then((list) => setLastColor(list[0]));
api.onColors((list) => setLastColor(list[0]));
function setLastColor(last) { $('#nook-pick').style.setProperty('--dot', last || 'transparent'); $('#nook-pick').classList.toggle('has', !!last); }
$('#nook-pick').onclick = () => { ui('home: pick color clicked'); api.colorPick(); };
