document.body.classList.add(api.platform);
const ui = (m) => { try { api.log(m); } catch {} }; // one line in the run log for what the user does
const $ = (s) => document.querySelector(s);
const island = $('#island');
let closeTimer, playing = false, toastTimer = null, toastOn = false;
let pillRight = false;
let lastOH = 410, ohTimer = null, macExtra = 0; // height of the open panel (it follows the page)
const KARA_FPS = 12; // steps per second of the colour fill in the open panel
let karaIdx = -1, karaEl = null, karaTimer = null; // the line whose colour fill runs, and the one element that shows it
let mixerOpen = false, mixTimer = null, mixDrag = 0, mixSyncAt = 0, mixSig = ''; // the volume mixer (declared early: setOpen runs before the mixer code)

// The main process polls the cursor and tells us when it is over the island
const MACOS = api.platform === 'darwin';
var replyMs = 5000;
var alarmCtx = null, alarmSound = null; // an alarm banner: it stays and its sound comes back until one of its buttons is pressed
var replyToastOn = false, replyCtx = null; // a message banner with a field to answer in (it takes the pointer and the keyboard, so hovering must not open the panel meanwhile)
const toastSize = () => [Math.max(SIZES.toast[0], SIZES.compact[0] + 32), SIZES.toast[1] + (replyToastOn ? 48 : 0)]; // the banner is never narrower than the pill above it
const SIZES = { compact: MACOS ? [464, 34] : [234, 34], open: [624, 410], toast: MACOS ? [520, 100] : [380, 100] };
// the pill is as tall as the menu bar (notched MacBooks) and leaves the notch free
api.metrics().then((m) => {
  const h = m.bar;
  setPillPos(m.pos === 'right', true);
  SIZES.compact[1] = h; SIZES.toast[1] = h + 64;
  if (MACOS) { macExtra = h - 10; SIZES.open[1] = lastOH + macExtra; }
  document.documentElement.style.setProperty('--ph', h + 'px');
  document.documentElement.style.setProperty('--gap', m.notch ? '210px' : '0px');
  if (!isOpen) { api.islandSize(...SIZES.compact); api.windowSize(...SIZES.compact); }
});
let needLeave = false, hoverInside = false, isOpen = false, shrinkTimer, pinned = false, dragging = false;
var openMode = 'hover', navMode = 'hover'; // Settings > General: the island opens on hover or on a click of the pill; its tab buttons work on hover or on a click
const setOpen = (v) => {
  if (v !== isOpen) ui(v ? 'island panel opened' : 'island panel closed');
  if (v && !isOpen && !dragging) goHome(); // every time the pill opens it shows the home page, whatever tab was used last
  isOpen = v;
  if (!v) closeMixer();
  applyKara();
  island.classList.toggle('open', v);
  island.classList.toggle('compact', !v);
  api.islandSize(...(v ? SIZES.open : replyToastOn ? toastSize() : SIZES.compact)); // (a banner with a reply field is still there: it keeps taking clicks)
  // the window is exactly as big as the island: grow at once, shrink after the animation
  clearTimeout(shrinkTimer);
  if (v) { endToast(); api.windowSize(...SIZES.open); }
  else shrinkTimer = setTimeout(() => { if (!isOpen) api.windowSize(...(toastOn ? toastSize() : SIZES.compact)); }, 450);
};
setOpen(false);
api.onHover((inside) => {
  hoverInside = inside;
  if (replyToastOn) return;
  clearTimeout(closeTimer);
  if (!inside) needLeave = false;
  if (inside) { if (!isOpen && !needLeave && openMode === 'hover') setOpen(true); return; }
  if (pinned) return; // a click inside keeps the island open until you click outside
  closeTimer = setTimeout(() => {
    if (document.activeElement && /INPUT|SELECT/.test(document.activeElement.tagName)) return;
    setOpen(false);
  }, 350);
});
// click mode: main saw a click on the small pill (it reads it from the input hook): the panel opens and stays until a click lands outside
api.onPillClick(() => { if (openMode !== 'click' || isOpen) return; ui('island pill clicked'); setOpen(true); pinned = true; api.pin(true); });
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
  dragging = true; setTimeout(() => { dragging = false; }, 3000);
  console.log('[drop] dragenter');
  showTab('tray');
});

const clock = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
// pill text: shown as is; when it is wider than the pill it glides back and forth (pause - slide - pause), smoothly
let pillShown = null;
function setPillText(t, kara) {
  const key = (kara ? 'k:' : 't:') + t;
  if (key === pillShown) return; // the clock ticks every second: don't restart the animation for identical text
  pillShown = key;
  const box = $('#pill-text');
  box.classList.remove('marquee');
  box.textContent = '';
  const inner = document.createElement('span');
  inner.textContent = t;
  if (kara) inner.className = 'k'; // a sung line: it fills with colour as it is sung
  box.appendChild(inner);
  if (kara) applyKara();
  requestAnimationFrame(() => {
    const over = inner.scrollWidth - box.clientWidth;
    if (over > 2) {
      inner.style.setProperty('--shift', -over + 'px');
      inner.style.animationDuration = (over / 28 + 3.5).toFixed(1) + 's';
      box.classList.add('marquee');
    }
  });
}
let curTitle = '', lyricNow = '';
let pillPw = 0, pillTimer;
const measure = document.createElement('canvas').getContext('2d');
// what the small pill shows: the lyric line that is being sung, else the title of what plays, else the time
function refreshPill() {
  const t = lyricNow || (playing && curTitle ? curTitle : clock());
  setPillText(t, !!lyricNow);
  fitPill(lyricNow ? t : '');
}
const topClock = () => { $('#top-clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
(function clockTick() { topClock(); if (!playing) refreshPill(); setTimeout(clockTick, 60000 - (Date.now() % 60000) + 50); })(); // on the minute: the clock has no seconds
topClock();
refreshPill();
// the letters are Gilroy: measure the pill again once the font is there
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { pillShown = null; refreshPill(); });

// pages: Home, WhatsApp, Water, Usage, Tray, Link. The mouse wheel moves between them and the dots show where you are.
const PAGES = ['media', 'chat', 'water', 'usage', 'tray', 'link'];
let pageIdx = 0, wheelLock = 0;
island.dataset.page = 0;
function showPage(i, instant) {
  i = Math.max(0, Math.min(PAGES.length - 1, i));
  const tr = $('#track');
  if (instant) tr.classList.add('instant');
  tr.style.transform = `translateX(${-i * 100}%)`;
  if (instant) { void tr.offsetHeight; tr.classList.remove('instant'); }
  if (i !== pageIdx) ui('island page -> ' + PAGES[i]);
  pageIdx = i;
  island.dataset.page = i;
  if (PAGES[i] === 'chat' && typeof waMarkSeen === 'function') waMarkSeen(); // the messages of the page have been seen after a moment
  if (typeof renderWaBadge === 'function') renderWaBadge();
  if (PAGES[i] === 'usage' && typeof usageRefresh === 'function') usageRefresh();
  updateOpenH();
  document.querySelectorAll('#dots i').forEach((d) => d.classList.toggle('on', Number(d.dataset.p) === i));
  $('#nav-prev').classList.toggle('off', i === 0);
  $('#nav-next').classList.toggle('off', i === PAGES.length - 1);
  if (i !== 0) closeMixer();
}
// arrow buttons at the left and right edge of the open island: previous / next tab, on hover (the pointer rests on the arrow for a moment: one tab)
// or on a click, as chosen in Settings > General
let navTimer = null;
function navButton(el, dir) {
  const stop = () => { clearTimeout(navTimer); navTimer = null; };
  const step = () => { navTimer = null; showPage(pageIdx + dir); }; // one tab per visit of the pointer: it has to leave the arrow and come back for the next one
  el.onmouseenter = () => { if (navMode !== 'hover' || el.classList.contains('off')) return; stop(); navTimer = setTimeout(step, 260); };
  el.onmouseleave = stop;
  el.onclick = () => { if (navMode === 'click') showPage(pageIdx + dir); };
}
navButton($('#nav-prev'), -1);
navButton($('#nav-next'), 1);
const showTab = (name) => showPage(PAGES.indexOf(name));
document.querySelectorAll('#dots i').forEach((d) => (d.onclick = () => showPage(Number(d.dataset.p))));
// Tabs move with a sideways swipe on a trackpad (and the arrow buttons at the edges). Scrolling up / down never changes the tab: it only
// scrolls the list under the pointer.
let wheelAt = 0, wheelHandled = false, wheelDir = 0, wheelMag = 0;
$('#panel').addEventListener('wheel', (e) => {
  const now = Date.now(), gap = now - wheelAt;
  wheelAt = now;
  if (gap > 140) wheelHandled = false; // a new gesture: the momentum of the last one has died out
  let d = 0;
  if (!e.shiftKey && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.5) d = e.deltaX; // only a clearly sideways swipe (Shift + wheel is vertical scrolling turned sideways)
  // the momentum of the last swipe keeps arriving for about a second: a swipe the other way, or a clearly stronger one, is a new gesture
  if (d) { if (wheelHandled && (Math.sign(d) !== wheelDir || Math.abs(d) > wheelMag * 1.8 + 6)) wheelHandled = false; wheelMag = Math.abs(d); }
  if (Math.abs(d) < 8 || wheelHandled) return;
  wheelHandled = true; wheelDir = Math.sign(d);
  showPage(pageIdx + (d > 0 ? 1 : -1));
}, { passive: true });
function goHome() { closeMixer(); showPage(0, true); }
// the gear opens the settings window (everything that can be set lives there)
$('#gear').onclick = () => {
  ui('island gear clicked');
  api.openSettings();
  // the panel gets out of the way: back to the small pill (it opens again only after the pointer has left it once)
  pinned = false; api.pin(false); needLeave = hoverInside; setOpen(false);
};
// media symbols, drawn in the style of Apple's SF Symbols. The 10 second ones are for players without previous / next tracks.
const SYM = {
  prev: '<svg viewBox="0 0 24 24"><path d="M11.5 7v10L4.5 12zM20.5 7v10L13.5 12z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M12.5 7v10l7-5zM3.5 7v10l7-5z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.6v12.8L18.6 12z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><rect x="6.6" y="5" width="3.8" height="14" rx="1.3"/><rect x="13.6" y="5" width="3.8" height="14" rx="1.3"/></svg>',
  back10: '<svg viewBox="0 0 24 24" style="fill:none"><path d="M3.6 12a8.4 8.4 0 1 0 2.5-5.9"/><path d="M3.4 3.8v4.2h4.2"/><text x="12" y="15.4" font-size="7.4" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="Gilroy, system-ui, sans-serif">10</text></svg>',
  fwd10: '<svg viewBox="0 0 24 24" style="fill:none"><path d="M20.4 12a8.4 8.4 0 1 1-2.5-5.9"/><path d="M20.6 3.8v4.2h-4.2"/><text x="12" y="15.4" font-size="7.4" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="Gilroy, system-ui, sans-serif">10</text></svg>',
};
const setIcon = (btn, name) => { if (btn.dataset.icon !== name) { btn.dataset.icon = name; btn.innerHTML = SYM[name]; } };
setIcon($('#prev'), 'prev'); setIcon($('#play'), 'play'); setIcon($('#next'), 'next');
// text that is wider than its box slides back and forth (only while the panel is open: an animation that never ends keeps the graphics process busy)
function setMarq(box, text) {
  const span = box.firstElementChild;
  if (span.textContent === text) return;
  span.textContent = text;
  box.classList.remove('marquee');
  requestAnimationFrame(() => {
    const over = span.scrollWidth - box.clientWidth;
    if (over > 2) { span.style.setProperty('--shift', -(over + 14) + 'px'); span.style.animationDuration = ((over + 14) / 22 + 4).toFixed(1) + 's'; box.classList.add('marquee'); }
  });
}
// media
let playLock = 0, playLockVal = false; // right after a press the button shows the new state at once; the player's answer is trusted again after a moment
let following = false, iMaster = false, localMedia = null, remote = { todos: [], events: [], media: null };
api.onMedia((m) => {
  localMedia = m && m.title ? m : null;
  if (iMaster) pushHome();
  if (!following) handleMedia(m);
});
function handleMedia(m) {
  playing = Date.now() < playLock ? playLockVal : m.status === 'Playing';
  setMarq($('#np-title'), m.title || 'Nothing playing');
  $('#np-artist').textContent = m.artist || '';
  if (m.thumb !== undefined || !m.title) { const t = m.title ? m.thumb : '', img = $('#np-img'); if (t) img.src = t; img.hidden = !t; $('#np-note').hidden = !!t; }
  setIcon($('#play'), playing ? 'pause' : 'play');
  // a player without previous / next tracks (a podcast, a single video): the buttons go back / forward 10 seconds, and say so with their icon
  const seekBack = m.canPrev === false, seekFwd = m.canNext === false;
  $('#prev').title = seekBack ? 'Back 10 seconds' : 'Previous';
  $('#next').title = seekFwd ? 'Forward 10 seconds' : 'Next';
  setIcon($('#prev'), seekBack ? 'back10' : 'prev');
  setIcon($('#next'), seekFwd ? 'fwd10' : 'next');
  curTitle = m.title || '';
  lyricsFollow(m);
  refreshPill();
  if (playing && isOpen) mixerSync();
}
$('#prev').onclick = () => api.mediaKey('prev');
$('#play').onclick = () => {
  lyr.pos += playing ? (Date.now() - lyr.at) / 1000 : 0; lyr.at = Date.now(); // keep the lyric position where it is while the state flips
  playing = !playing; playLock = Date.now() + 1200; playLockVal = playing; // no waiting for the player: the icon, the lyrics and the pill follow the press at once
  setIcon($('#play'), playing ? 'pause' : 'play');
  if (lyr.lines) lyricTick();
  refreshPill();
  api.mediaKey('play');
};
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
// a deleted file turns to dust: the chip is cut into small squares that drift up and away, left to right, like Thanos' snap
let dustCv = null, dustP = [], dustRaf = 0;
const rectOf = (el, delay) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, delay }; };
function dust(rects) {
  if (!dustCv) {
    dustCv = document.createElement('canvas');
    dustCv.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:60';
    document.body.appendChild(dustCv);
  }
  const k = window.devicePixelRatio || 1;
  dustCv.width = Math.round(innerWidth * k); dustCv.height = Math.round(innerHeight * k);
  dustCv.style.width = innerWidth + 'px'; dustCv.style.height = innerHeight + 'px';
  const deco = getComputedStyle(document.documentElement).getPropertyValue('--deco').trim() || '#0a84ff';
  const now = performance.now(), S = 3;
  const ms = Math.max(...rects.map((r) => r.delay)) + 2100;
  holdH = lastOH; holdUntil = Date.now() + ms; setTimeout(updateOpenH, ms + 30);
  rects.forEach((r) => {
    for (let gx = 0; gx < r.w; gx += S) for (let gy = 0; gy < r.h; gy += S) {
      const u = gx / r.w, v = (gy - r.h / 2) / r.h;
      const c = u < 0.17 && Math.abs(v) < 0.33 ? deco : (u > 0.2 && u < 0.85 && Math.abs(v) < 0.14 && Math.random() < 0.7 ? '#e5e5ea' : (Math.random() < 0.3 ? '#2a2a2e' : '#1c1c1e'));
      dustP.push({ x: r.x + gx, y: r.y + gy, vx: 14 + Math.random() * 46, vy: -(8 + Math.random() * 40), s: S - Math.random(), t0: now + r.delay + u * 380 + Math.random() * 120, life: 700 + Math.random() * 600, c });
    }
  });
  if (!dustRaf) dustRaf = requestAnimationFrame(dustLoop);
}
function dustLoop(t) {
  const ctx = dustCv.getContext('2d'), k = window.devicePixelRatio || 1;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  const live = [];
  for (const p of dustP) {
    if (t < p.t0) { ctx.globalAlpha = 1; ctx.fillStyle = p.c; ctx.fillRect(p.x, p.y, S3, S3); live.push(p); continue; } // not its turn yet: still part of the chip
    const f = (t - p.t0) / p.life;
    if (f >= 1) continue;
    const e = f * f;
    ctx.globalAlpha = 1 - f;
    ctx.fillStyle = p.c;
    ctx.fillRect(p.x + p.vx * e * 3.2, p.y + p.vy * e * 3.2 + Math.sin(f * 7 + p.x) * 3 * f, p.s * (1 - f * 0.6), p.s * (1 - f * 0.6));
    live.push(p);
  }
  dustP = live;
  if (live.length) dustRaf = requestAnimationFrame(dustLoop);
  else { dustRaf = 0; ctx.clearRect(0, 0, innerWidth, innerHeight); }
}
const S3 = 3;
// what kind of file it is (the badge shows its extension, the card its kind)
const KINDS = [['Image', 'png jpg jpeg gif webp bmp heic svg'], ['Video', 'mp4 mov mkv avi webm m4v'], ['Audio', 'mp3 wav flac m4a aac ogg'], ['Document', 'pdf doc docx xls xlsx ppt pptx txt md csv rtf key pages numbers'], ['Archive', 'zip rar 7z tar gz dmg iso'], ['App', 'exe msi apk pkg']];
const kindOf = (name) => {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  const k = KINDS.find(([, l]) => l.split(' ').includes(ext));
  return { label: k ? k[0] : 'File', ext: (String(name).includes('.') ? ext : 'file').slice(0, 4).toUpperCase() };
};
const fmtSize = (b) => (!b ? '' : b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + ' KB' : b < 1024 ** 3 ? (b / 1024 / 1024).toFixed(b < 1e7 ? 1 : 0) + ' MB' : (b / 1024 ** 3).toFixed(1) + ' GB');
let shownFiles = new Set(), filesFirst = true;
const renderFiles = () => {
  const n = files.length;
  $('#clear').hidden = !n;
  $('#files-count').textContent = n ? (n === 1 ? '1 file' : n + ' files') : '';
  $('#send-label').textContent = connected ? (n ? `Send tray (${n})` : 'A-Drop') : 'A-Drop';
  const box = $('#files'); box.innerHTML = '';
  let fresh = false;
  files.forEach((f, i) => {
    const base = f.split(/[\\/]/).pop(), el = document.createElement('div');
    el.className = 'file';
    if (!shownFiles.has(f)) { el.classList.add('new'); fresh = true; }
    const ext = document.createElement('b'); ext.className = 'ext'; ext.textContent = kindOf(base).ext;
    const nm = document.createElement('span'); nm.className = 'fname'; nm.textContent = base;
    const rm = document.createElement('button'); rm.className = 'rm'; rm.textContent = '\u2715'; rm.title = 'Remove from the tray';
    rm.onmousedown = (e) => e.stopPropagation();
    rm.onclick = (e) => { e.stopPropagation(); const r = rectOf(el, 0); files.splice(i, 1); api.setTray(files); dust([r]); renderFiles(); };
    el.append(ext, nm, rm);
    el.title = f + '\n(drag onto A-Drop to send it, double-click to open)';
    el.draggable = false;
    el.onmousedown = (e) => { if (e.button === 0) startChipDrag(e, f, el); };
    // own double-click detection: some pointers (and first clicks on macOS) don't produce dblclick events
    let lastClick = 0;
    el.onclick = () => { if (Date.now() - chipDragEnd < 300) return; const t = Date.now(); if (t - lastClick < 500) { lastClick = 0; api.open(f); } else lastClick = t; };
    el.oncontextmenu = (e) => { e.preventDefault(); const r = rectOf(el, 0); files.splice(i, 1); api.setTray(files); dust([r]); renderFiles(); };
    box.appendChild(el);
  });
  shownFiles = new Set(files);
  if (fresh && !filesFirst) { const d = $('#drop'); d.classList.remove('bump'); void d.offsetWidth; d.classList.add('bump'); }
  filesFirst = false;
  updateOpenH();
};
api.getTray().then((l) => { files = l; renderFiles(); });
api.onTray((l) => { files = l; renderFiles(); showTab('tray'); });
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
$('#clear').onclick = () => { ui('tray cleared'); const rs = [...document.querySelectorAll('#files .file')].map((el, i) => rectOf(el, i * 90)); files = []; api.setTray(files); dust(rs); renderFiles(); $('#xfer').textContent = ''; };
// macOS: the main process recognises a file dragged onto the island itself (the panel window may not receive the drop)
let lastDomDrop = 0;
document.addEventListener('drop', () => { lastDomDrop = Date.now(); }, true);
api.onDragStart(() => showTab('tray'));
api.onNativeDrop((ps, x, y) => {
  if (Date.now() - lastDomDrop < 1500) return; // the page got the drop itself
  const el = document.elementFromPoint(x, y);
  console.log('[drop] native', ps.length, el && (el.id || el.className || el.tagName));
  if (el && el.closest('#send')) { if (!connected) { $('#xfer').textContent = 'Link a computer first (Link tab)'; return; } ps.forEach(sendPath); }
  else { ps.forEach((p) => files.includes(p) || files.push(p)); api.setTray(files); renderFiles(); }
  showTab('tray');
});

const sendPath = async (p) => {
  ui('tray send file ' + String(p).split(/[\\/]/).pop());
  const r = await api.sendFile(p);
  if (!r.ok) {
    $('#xfer').textContent = 'Send failed: ' + r.error;
    const base = String(p).split(/[\\/]/).pop();
    for (const [k, x] of xfers) if (!x.done && x.dir === 'out' && (x.name === base || x.name === base + '.zip')) { x.el.remove(); xfers.delete(k); } // no card stays at 0%
    $('#send').classList.toggle('busy', [...xfers.values()].some((v) => !v.done));
    updateOpenH();
  }
};
// transfers: a card for every file on its way (kind, name, percent, time left), with a bar that fills in the decoration colour
const xfers = new Map();
const fmtLeft = (sec) => (sec < 2 ? 'almost done' : sec < 60 ? Math.ceil(sec) + ' s left' : Math.ceil(sec / 60) + ' min left');
const CHECK = '<svg viewBox="0 0 24 24"><path d="M5.5 12.5l4.2 4.2L18.5 7.8"/></svg>';
function xferCard(x) {
  const k = kindOf(x.name);
  const el = document.createElement('div'); el.className = 'xc';
  el.innerHTML = '<b class="ext"></b><div class="xi"><div class="xn"></div><div class="xm"></div></div><div class="xp"></div><i class="bar"><u></u></i>';
  el.querySelector('.ext').textContent = k.ext;
  el.querySelector('.xn').textContent = x.name; el.querySelector('.xn').title = x.name;
  return el;
}
function xferPaint(x) {
  const k = kindOf(x.name), out = x.dir === 'out', el = x.el;
  el.classList.toggle('done', !!x.done);
  el.querySelector('u').style.width = x.pct + '%';
  el.querySelector('.xp').innerHTML = x.done ? CHECK : x.pct + '%';
  const secs = (Date.now() - x.t0) / 1000;
  const left = !x.done && x.pct >= 4 && secs > 0.8 ? fmtLeft(secs * (100 - x.pct) / x.pct) : '';
  el.querySelector('.xm').textContent = x.done ? (out ? 'Sent' : 'Received') + ' \u00b7 ' + k.label : [out ? 'Sending' : 'Receiving', k.label, fmtSize(x.size), left].filter(Boolean).join(' \u00b7 ');
}
api.onTransfer((t) => {
  const key = t.dir + '|' + t.name;
  let x = xfers.get(key);
  if (!x || x.done) {
    x = { dir: t.dir, name: t.name, t0: Date.now(), size: t.size || 0, pct: 0, done: false };
    x.el = xferCard(x); xfers.set(key, x);
    $('#xcards').appendChild(x.el);
    showTab('tray');
  }
  x.pct = Math.max(x.pct, t.pct || 0); x.size = t.size || x.size;
  if (t.done) {
    x.done = true; x.pct = 100;
    const el = x.el;
    setTimeout(() => { el.classList.add('out'); setTimeout(() => { el.remove(); updateOpenH(); }, 400); }, 2600);
  }
  xferPaint(x);
  $('#send').classList.toggle('busy', [...xfers.values()].some((v) => !v.done));
  if (t.done && t.dir === 'in' && t.path && !files.includes(t.path)) { files.push(t.path); api.setTray(files); renderFiles(); }
  updateOpenH();
});

// the panel is as tall as its page needs (the tray page is short, the others are full)
function wantH() { const p = PAGES[pageIdx]; return p === 'tray' ? Math.max(190, Math.min(410, 90 + $('#tray-wrap').offsetHeight)) : p === 'link' ? Math.max(250, Math.min(450, 92 + $('#link-wrap').offsetHeight)) : 410; }
let holdH = 0, holdUntil = 0; // while dust is flying the panel keeps its height
function updateOpenH() {
  let h = wantH();
  if (Date.now() < holdUntil) h = Math.max(h, holdH);
  if (h === lastOH) return;
  const grow = h > lastOH;
  lastOH = h;
  document.documentElement.style.setProperty('--oh', h + 'px');
  SIZES.open[1] = h + macExtra;
  clearTimeout(ohTimer);
  const apply = () => { if (isOpen) { api.islandSize(...SIZES.open); api.windowSize(...SIZES.open); } };
  if (grow) apply(); else ohTimer = setTimeout(apply, 480);
}

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
  if (connected !== s.connected) { connected = s.connected; $('#send').classList.toggle('off', !connected); $('#send-label').textContent = connected ? (files.length ? 'Send tray (' + files.length + ')' : 'A-Drop') : 'A-Drop'; renderFiles(); }
  $('#me-name').textContent = s.name || '';
  $('#pin').textContent = fmtPin(s.pin);
  $('#addr').textContent = (s.addresses || []).join('  ') || 'No network';
  // connected: the other computer gets a card; the pairing form becomes "connect a different computer"
  $('#peer-card').hidden = !s.connected;
  $('#peer-actions').hidden = !s.connected;
  $('#peer-side-row').hidden = !s.connected;
  renderMaster(s);
  // this computer's own mouse and keyboard are off (the other one is the master): say so, and how to take over
  const lk = !!(s.connected && s.master && s.master.locked);
  $('#pill-lock').hidden = !lk;
  $('#lock-banner').hidden = !lk;
  $('#lock-banner').textContent = 'Locked · ' + String(s.peerName || 'the other computer').replace(/.local$/, '') + ' is master';
  $('#lock-banner').title = 'This mouse and keyboard are switched off because the other computer is the master. Ctrl+Alt+M here takes over.';
  setRole(!!(s.connected && s.master && s.master.on && s.master.peer), !!(s.connected && s.master && s.master.on && s.master.mine));
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
  $('#top-link').classList.toggle('on', !!s.connected); // green while linked, grey when not
  $('#top-link').classList.toggle('ctl', !!s.connected && s.state === 'controlled');
  $('#pill-link').title = s.connected ? (s.state === 'controlled' ? 'Being controlled by ' + (s.peerName || 'the other computer') : s.state === 'controlling' ? 'Controlling ' + (s.peerName || 'the other computer') : 'Linked to ' + (s.peerName || 'the other computer')) : '';
  renderNearby();
  updateOpenH();
};

// master: one computer's mouse and keyboard run both; the other ignores its own until it becomes the master (Ctrl+Alt+M on it)
function renderMaster(s) {
  $('#master-row').hidden = !s.connected;
  if (!s.connected) return;
  const m = s.master || { on: false };
  $('#master-peer').textContent = s.peerName || 'The other';
  $('#master-seg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === (!m.on || !m.id ? 'off' : m.mine ? 'me' : 'peer')));
  $('#master-hint').textContent = !m.on ? 'Off: each computer uses its own mouse and keyboard, and a computer takes control back when its own mouse moves.'
    : (m.mine ? 'This computer is the master. The other computer ignores its own mouse and keyboard.'
    : 'The other computer is the master: this mouse and keyboard are switched off. Press Ctrl+Alt+M on this keyboard to take over.') + (m.auto ? ' (Automatic: the first computer that was calibrated for Look to switch; until then the Windows PC.)' : '');
}
$('#master-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  ui('link master -> ' + b.dataset.m);
  api.masterSet(b.dataset.m !== 'off', b.dataset.m === 'peer' ? 'peer' : 'me');
});

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
const renderGaze = (g) => { $('#cam-banner').hidden = !g.camera; $('#pill-cam').hidden = true; $('#pill-dot').classList.toggle('live', !!g.camera); }; // the green dot in the pill = the camera is in use
api.gazeGet().then(renderGaze);
api.onGaze(renderGaze);


// toast banner: a block that hangs under the pill for a few seconds (the pill stays on top, joined to it)
function endToast() {
  clearTimeout(toastTimer);
  if (typeof stopRing === 'function') stopRing();
  if (!toastOn) return;
  toastOn = false;
  replyToastOn = false; replyCtx = null; alarmStop();
  island.classList.remove('toast', 'treply');
  $('#toast').classList.remove('reply', 'alarm'); $('#toast-reply').hidden = true; $('#toast-actions').hidden = true;
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
// notification sounds: short tones made with the browser's synthesizer (no sound files). Each kind has its own tune.
let audioCtx = null;
const TUNES = {
  ok: [[880, 0, 0.09], [1318, 0.09, 0.16]],
  sent: [[587, 0, 0.08], [880, 0.08, 0.08], [1175, 0.16, 0.18]],
  received: [[1175, 0, 0.1], [880, 0.1, 0.1], [659, 0.2, 0.22]],
  connected: [[523, 0, 0.09], [659, 0.09, 0.09], [784, 0.18, 0.09], [1047, 0.27, 0.26]],
  err: [[330, 0, 0.14, 'triangle'], [247, 0.17, 0.26, 'triangle']],
  start: [[196, 0, 0.7, 'triangle'], [392, 0.02, 0.14], [523, 0.14, 0.14], [659, 0.26, 0.14], [784, 0.38, 0.16], [1047, 0.52, 0.6]],
  shot: [[2400, 0, 0.03, 'square'], [1500, 0.035, 0.07, 'sine']],
  impact: [[95, 0, 0.14, 'sine'], [58, 0.015, 0.2, 'sine'], [1900, 0, 0.012, 'square']],
  chat: [[1047, 0, 0.07], [1397, 0.08, 0.12]],
  water: [[784, 0, 0.12], [988, 0.14, 0.12], [1319, 0.28, 0.12], [1568, 0.42, 0.3]],
};
function chime(kind, vol) {
  const tune = TUNES[kind] || TUNES.ok;
  if (!vol) return;
  if (MACOS) { api.soundPlay(kind, vol); return; } // the Mac plays its tones itself (afplay)
  try {
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime + 0.02, peak = Math.pow(vol / 100, 1.3) * 0.5;
    for (const [freq, at, len, type] of tune) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len + 0.06);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t0 + at); o.stop(t0 + at + len + 0.08);
    }
  } catch {}
}
api.onChime((c) => chime(c.kind, c.vol));
const soundKind = (t) => (t.kind === 'err' ? 'err' : t.icon === 'sent' ? 'sent' : t.icon === 'received' ? 'received' : t.icon === 'chat' || t.icon === 'claude' ? 'chat' : t.icon === 'water' ? 'water' : /^Connected/.test(t.title || '') ? 'connected' : /^Screenshot/.test(t.title || '') ? 'shot' : 'ok');
function alarmStop() { clearInterval(alarmSound); alarmSound = null; alarmCtx = null; }
api.onToast((t) => {
  if (alarmCtx && !t.alarm) return; // an alarm waiting for its answer is not pushed away by another banner
  if (t.kind !== 'progress') chime(soundKind(t), t.sound || 0);
  alarmStop();
  if (t.alarm) { alarmCtx = t.alarm; alarmSound = setInterval(() => chime(soundKind(t), t.sound || 0), 8000); }
  stopRing();
  $('#toast-icon').classList.remove('hold');
  const err = t.kind === 'err', prog = t.kind === 'progress';
  $('#toast-title').textContent = t.title;
  $('#toast-text').textContent = t.text;
  $('#toast').classList.toggle('err', err);
  $('#toast').classList.toggle('prog', prog);
  $('#toast').classList.toggle('water', t.icon === 'water');
  replyToastOn = !!(t.reply || t.alarm); replyCtx = t.reply || null;
  $('#toast').classList.toggle('reply', replyToastOn); island.classList.toggle('treply', replyToastOn); $('#toast').classList.toggle('alarm', !!t.alarm);
  $('#toast-reply').hidden = !t.reply;
  const acts = $('#toast-actions'); acts.textContent = ''; acts.hidden = !t.alarm;
  if (t.alarm) for (const a of t.alarm.actions) { const b = mk('button', a.primary ? 'main' : '', a.label); b.onclick = () => { const ctx = alarmCtx; endToast(); if (ctx) api.alarmAct(ctx.id, a.key); }; acts.appendChild(b); }
  if (t.reply) { const inp = $('#toast-reply-in'); inp.value = ''; inp.placeholder = 'Reply to ' + String(t.title || '').split(' (+')[0] + '...'; }
  $('#toast').classList.toggle('deco-icon', t.icon === 'sent' || t.icon === 'received' || t.icon === 'water'); // (not called 'ico': that class is the round icon button style)
  $('#toast-text').textContent = t.text;
  const gl = $('#toast-glyph');
  gl.hidden = !(prog && t.step);
  gl.className = 'steps';
  gl.title = prog && t.step ? `Step ${t.step} of ${t.of || 2}` : '';
  gl.innerHTML = Array.from({ length: t.of || 2 }, (_x, i) => `<i class="${i + 1 === t.step ? 'on' : i + 1 < t.step ? 'done' : ''}"></i>`).join('');
  if (prog) runRing(t.ready || 3, t.hold || 2, t.glyph === 'there');
  else if (t.icon === 'sent') $('#toast-icon').innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 12l16-8-6 16-3-7z"/></svg>';
  else if (t.icon === 'received') $('#toast-icon').innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>';
  else if (t.icon === 'chat') $('#toast-icon').innerHTML = '<svg viewBox="0 0 24 24"><path d="M4.5 5.5h15v10.5H11l-4.5 3.5V16h-2z" style="stroke-width:2.4;stroke-dasharray:none"/></svg>';
  else if (t.icon === 'claude') $('#toast-icon').innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 4v16M4.5 8l15 8M19.5 8l-15 8" style="stroke-width:2.4;stroke-dasharray:none"/></svg>';
  else if (t.icon === 'water') $('#toast-icon').innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3.5c3.4 4.1 5.5 7 5.5 10a5.5 5.5 0 0 1-11 0c0-3 2.1-5.9 5.5-10z" style="stroke-width:2.4;stroke-dasharray:none"/></svg>';
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
  } else { if (replyToastOn) api.islandSize(...toastSize()); else api.islandSize(...SIZES.compact); api.windowSize(...toastSize()); } // a banner with a reply field takes clicks
  // replay the entrance animation (block drops in, icon pops, tick draws, text slides up)
  const box = $('#toast');
  box.classList.remove('play'); void box.offsetWidth; box.classList.add('play');
  clearTimeout(toastTimer);
  if (t.reply) replyMs = Math.max(2000, (Number(t.secs) || 5) * 1000);
  toastTimer = setTimeout(endToast, t.alarm ? 180000 : replyToastOn ? replyMs : prog ? ((t.ready || 3) + (t.hold || 2)) * 1000 + 6000 : 4500); // a step stays until the next message replaces it
});

// calendar: yesterday, today, tomorrow and the day after, with a coloured dot for every activity (Settings > Calendar connects the calendars)
let calEvents = [], calSources = 0;
const DAY = 86400000;
const EV_COLORS = ['#0a84ff', '#30d158', '#ff9f0a', '#bf5af2', '#ff453a', '#64d2ff'];
function renderCalendar() {
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - DAY; // first shown day = yesterday
  const win = calEvents.filter((e) => e.start < base + 4 * DAY && e.end > base).sort((a, b) => a.start - b.start);
  // every activity has its own colour: the same dot sits on its days and in the list under them
  win.forEach((e, i) => { e.color = EV_COLORS[i % EV_COLORS.length]; });
  const box = $('#cal-week'); box.innerHTML = '';
  for (let d = 0; d < 4; d++) {
    const t = new Date(base + d * DAY + 3600000), s = base + d * DAY;
    const el = document.createElement('div');
    el.className = 'day ' + ['past', 'd0', 'd1', 'd2'][d];
    el.innerHTML = '<small></small><b></b><span class="dots"></span>';
    el.querySelector('small').textContent = t.toLocaleDateString([], { weekday: 'short' });
    el.querySelector('b').textContent = t.getDate();
    win.filter((e) => e.start < s + DAY && e.end > s).slice(0, 3).forEach((e) => { const i = document.createElement('i'); i.style.background = e.color; el.querySelector('.dots').appendChild(i); });
    box.appendChild(el);
  }
  const ev = $('#cal-events'); ev.innerHTML = '';
  win.slice(0, 3).forEach((e) => {
    const row = document.createElement('div'); row.className = 'e';
    const dot = document.createElement('i'); dot.style.background = e.color;
    const dn = document.createElement('time'); dn.textContent = new Date(Math.max(e.start, base) + 3600000).getDate();
    const tt = document.createElement('span'); tt.textContent = e.title; tt.title = e.title + (e.place ? ' - ' + e.place : '');
    row.append(dot, dn, tt); ev.appendChild(row);
  });
  if (win.length > 3) { const m = document.createElement('div'); m.className = 'more'; m.textContent = '+' + (win.length - 3) + ' more'; ev.appendChild(m); }
  const empty = $('#cal-empty');
  empty.hidden = win.length > 0;
  empty.textContent = calSources ? 'No activities in these days' : 'Add a calendar in Settings > Calendar';
}
async function loadEvents() {
  if (following) { calEvents = remote.events; calSources = 1; renderCalendar(); return; }
  try {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    const from = d.getTime() - 3 * DAY;
    calEvents = await api.calRange(from, from + 8 * DAY);
    calSources = (await api.calSources()).length;
  } catch {}
  renderCalendar();
  pushHome();
}
renderCalendar();
loadEvents();
api.onCal(() => loadEvents());
setInterval(renderCalendar, 60000);
setInterval(loadEvents, 10 * 60000);

// To Do list (kept on this computer)
let todos = [];
try { todos = JSON.parse(localStorage.getItem('atuls-todo') || '[]').filter((x) => x && typeof x.t === 'string'); } catch {}
const saveTodos = () => { try { localStorage.setItem('atuls-todo', JSON.stringify(todos)); } catch {} };
const T = () => (following ? remote.todos : todos); // the list on show: this computer's own, or the master's
function commitTodos() { if (following) api.homeTodo(remote.todos); else { saveTodos(); pushHome(); } }
function renderTodos() {
  const list = T(), box = $('#todo-list'); box.innerHTML = '';
  list.forEach((x, i) => {
    const row = document.createElement('div'); row.className = 'ti' + (x.done ? ' done' : '');
    const ck = document.createElement('button'); ck.className = 'ck'; ck.setAttribute('aria-label', 'Done');
    ck.onclick = () => { x.done = !x.done; commitTodos(); renderTodos(); };
    const tx = document.createElement('span'); tx.textContent = x.t; tx.title = x.t;
    const rm = document.createElement('button'); rm.className = 'rm'; rm.textContent = '\u2715'; rm.title = 'Remove';
    rm.onclick = () => { list.splice(i, 1); commitTodos(); renderTodos(); };
    row.append(ck, tx, rm); box.appendChild(row);
  });
}
$('#todo-in').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const t = e.target.value.trim(), list = T();
  if (!t || list.length >= 100) return;
  list.push({ t, done: false }); e.target.value = '';
  commitTodos(); renderTodos();
  const l = $('#todo-list'); l.scrollTop = l.scrollHeight;
});
// clear: the finished items go; when none is finished, the whole list goes
$('#todo-clear').onclick = () => {
  ui('home: to do list cleared');
  const keep = T().some((x) => x.done) ? T().filter((x) => !x.done) : [];
  if (following) remote.todos = keep; else todos = keep;
  commitTodos(); renderTodos();
};
renderTodos();

// master mode: the master's Home page (to do list, calendar, music) is what both computers show. The master sends it whenever it changes;
// the other computer shows it, sends its to do edits back, and its music buttons drive the master's player.
let pushTimer = 0, lastThumbSent = null, lastPushSig = '', lastPushAt = 0;
function pushHome(full) {
  if (!iMaster) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    let media = null;
    if (localMedia) { media = { ...localMedia }; if (!full && media.thumb === lastThumbSent) delete media.thumb; else lastThumbSent = media.thumb; }
    const sig = JSON.stringify([todos, calEvents, media]);
    if (!full && sig === lastPushSig && Date.now() - lastPushAt < 30000) return; // nothing new to send
    lastPushSig = sig; lastPushAt = Date.now();
    api.homePush({ todos, events: calEvents, media });
  }, 250);
}
setInterval(() => pushHome(), 5000);
function setRole(f, m) {
  if (f === following && m === iMaster) return;
  const wasFollowing = following;
  following = f; iMaster = m;
  if (m) pushHome(true);
  if (f) { remote = { todos: [], events: [], media: null }; handleMedia({}); calEvents = []; renderCalendar(); }
  if (wasFollowing && !f) { loadEvents(); }
  renderTodos();
}
api.onHome((m) => {
  if (!following) return;
  remote.todos = Array.isArray(m.todos) ? m.todos : []; remote.events = Array.isArray(m.events) ? m.events : [];
  renderTodos();
  calEvents = remote.events; calSources = 1; renderCalendar();
  if (m.media) { remote.media = { ...(m.media.thumb === undefined && remote.media ? { thumb: remote.media.thumb } : {}), ...m.media }; handleMedia(remote.media); }
  else { remote.media = null; handleMedia({}); }
});
api.onTodo((list) => { if (!iMaster) return; todos = list.filter((x) => x && typeof x.t === 'string'); saveTodos(); renderTodos(); pushHome(); });

// lyrics: the time-stamped lines of the playing song come from the main process (LRCLIB); the position is taken from every media update and
// carried on by the clock in between. The line being sung shows in the small pill and, with the lines around it, on the home page; it fills
// with colour as it is sung.
let lyr = { key: '', lines: null, pos: 0, at: 0, idx: -2, shown: -2, els: [] };
let lyricsEnabled = true;
api.startupGet().then((s) => { lyricsEnabled = s.lyrics !== false; }).catch(() => {});
const lyrNote = (t) => { $('#lyr-note').hidden = !t; $('#lyr-note').textContent = t || ''; };
function renderLyricList(lines) {
  const list = $('#lyr-list'); list.innerHTML = ''; lyr.els = [];
  list.style.transform = '';
  (lines || []).forEach((l) => {
    const d = document.createElement('div'); d.className = 'll';
    const s = document.createElement('span'); s.className = 't'; s.textContent = l.line || '♪';
    d.appendChild(s); list.appendChild(d); lyr.els.push(d);
  });
}
function lyricsFollow(m) {
  const key = (m.title || '') + '|' + (m.artist || '');
  if (key !== lyr.key) {
    lyr = { key, lines: null, pos: 0, at: 0, idx: -2, shown: -2, els: [] };
    setLyric('');
    karaIdx = -1; applyKara();
    renderLyricList(null);
    lyrNote(!m.title ? 'Nothing playing' : 'Looking for lyrics...');
    if (m.title) {
      api.startupGet().then((s) => {
        lyricsEnabled = s.lyrics !== false;
        if (!lyricsEnabled && lyr.key === key) lyrNote('Lyrics are off (Settings > General)');
      }).catch(() => {});
      api.lyricsGet({ title: m.title, artist: m.artist || '', duration: m.end || 0 }).then((lines) => {
        if (lyr.key !== key) return;
        if (lines && lines.length) { lyr.lines = lines; renderLyricList(lines); lyrNote(''); lyricTick(); }
        else if (lyricsEnabled) lyrNote('No lyrics found for this song');
      }).catch(() => {});
    }
  }
  if (m.pos !== undefined) { lyr.pos = m.pos; lyr.at = Date.now(); }
  lyricTick();
}
function setLyric(t) {
  if (t === lyricNow) return;
  lyricNow = t;
  refreshPill();
}
const lyrPos = () => lyr.pos + (playing ? (Date.now() - lyr.at) / 1000 : 0) + 0.2; // a little ahead: the pill takes a moment to show it
// keep the sung line in the middle of the lyrics area
function lyrScroll(i) {
  const el = lyr.els[Math.max(0, i)];
  if (!el) return;
  const h = $('#lyrics').clientHeight;
  $('#lyr-list').style.transform = `translateY(${Math.round(h * 0.42 - (el.offsetTop + el.offsetHeight / 2))}px)`;
}
function lyricTick() {
  lyrTimerSync();
  if (!lyricsEnabled || !lyr.lines) return setLyric('');
  const now = lyrPos();
  // a line becomes the big one a moment BEFORE its time (when the last words of the line before it are being sung), so the next words can be read
  // early; its colour fill still begins only at its own time
  let i = -1;
  for (let k = 0; k < lyr.lines.length && lyr.lines[k].t - lyrLead(k - 1) <= now; k++) i = k;
  if (i !== lyr.shown) {
    lyr.shown = i;
    lyr.els.forEach((el, k) => el.classList.toggle('cur', k === i));
    lyrScroll(i);
    startKara(i);
  }
  lyr.idx = i;
  if (karaEl) karaEl.style.animationPlayState = playing ? 'running' : 'paused';
  setLyric(playing && i >= 0 ? (lyr.lines[i].line || '♪') : '');
}
let lyrTimer = null;
function lyrTimerSync() { // runs only while a song with lyrics is playing (a paused or lyric-less song changes nothing on its own)
  const need = !!(lyricsEnabled && lyr.lines && playing);
  if (need && !lyrTimer) lyrTimer = setInterval(lyricTick, 250);
  else if (!need && lyrTimer) { clearInterval(lyrTimer); lyrTimer = null; }
}
// the colour that fills the sung line is one CSS animation (--p) lasting as long as the line; it pauses with the music
// how long before the next line the sung line is handed over: the last words of a line (about a fifth of it, at most 0.9 s)
function lyrLead(k) {
  const a = lyr.lines[k], b = lyr.lines[k + 1];
  return 0; // (a line used to be handed over a little early; it follows the song exactly again)
}
// The fill runs on ONE small element: the sung line in the small pill while the panel is closed, the big line in the panel while it is open.
// (It used to run on the whole island: every frame restyled and repainted the full window, about half of a CPU core with the GPU.)
function startKara(i) { karaIdx = i; applyKara(); }
function applyKara() {
  if (karaEl) { karaEl.style.animation = 'none'; karaEl = null; }
  if (karaTimer) { clearInterval(karaTimer); karaTimer = null; }
  if (karaIdx < 0 || !lyr.lines) return;
  const el = isOpen ? (lyr.els[karaIdx] && lyr.els[karaIdx].querySelector('.t')) : document.querySelector('#pill-text .k');
  if (!el) return;
  const inPill = !isOpen;
  const a = lyr.lines[karaIdx], b = lyr.lines[karaIdx + 1];
  const dur = Math.max(1.2, Math.min(b ? b.t - lyrLead(karaIdx) - a.t : 5, 9) * 0.92);
  // 24 steps a second instead of every screen frame: the soft edge of the fill hides the steps, and each repaint of the window costs (most of all
  // on Windows, where the transparent window is redrawn whole)
  const delay = (a.t - lyrPos()).toFixed(2); // a positive delay = the fill waits for the line's own time
  if (inPill) {
    // the small pill: no CSS animation (a running animation makes the window draw 60 times a second whatever its speed); a timer moves the fill
    // 10 times a second instead, and only while the song plays
    const t0 = a.t;
    const paint = () => { if (!playing) return; const f = Math.max(0, Math.min(1, (lyrPos() - t0) / dur)); el.style.setProperty('--p', (-8 + f * 116).toFixed(1) + '%'); };
    el.style.setProperty('--p', '-8%'); paint();
    karaTimer = setInterval(paint, 100);
  } else {
    el.style.animation = `kara ${dur.toFixed(2)}s steps(${Math.max(6, Math.round(dur * KARA_FPS))}, end) ${delay}s both`;
    el.style.animationPlayState = playing ? 'running' : 'paused';
  }
  karaEl = el;
}
// the pill is as wide as the lyric line it shows (a plain pill otherwise)
function fitPill(text) {
  if (MACOS && !pillRight) return;
  let pw = 210;
  if (text) {
    measure.font = getComputedStyle($('#pill-text')).font;
    pw = Math.max(210, Math.min(620, Math.ceil(measure.measureText(text).width) + 112 + 8));
  }
  if (pw === pillPw) return;
  const grow = pw > pillPw;
  pillPw = pw;
  const ear = 12;
  SIZES.compact[0] = pw + 2 * ear;
  clearTimeout(pillTimer);
  const apply = () => { if (isOpen) return; api.islandSize(...SIZES.compact); api.windowSize(...(toastOn ? toastSize() : SIZES.compact)); };
  if (grow) { apply(); island.style.setProperty('--pw', pw + 'px'); }
  else { island.style.setProperty('--pw', pw + 'px'); pillTimer = setTimeout(apply, 480); }
}

// top bar: your picture (or the logo), the link mark, the volume mixer
// where the pill sits: in the middle, or to the right of the camera notch (on the Mac it is then a small pill like on Windows)
function setPillPos(r, first) {
  if (r === pillRight && !first) return;
  pillRight = r;
  document.body.classList.toggle('pr', r);
  if (MACOS) { SIZES.compact[0] = r ? 234 : 464; SIZES.toast[0] = r ? 380 : 520; }
  pillPw = 0;
  if (!first) { refreshPill(); if (!isOpen) { api.islandSize(...SIZES.compact); api.windowSize(...SIZES.compact); } }
}
const applyLook = (l) => {
  if (l && l.pillPos) setPillPos(l.pillPos === 'right');
  if (l && l.openMode) openMode = l.openMode;
  if (l && l.navMode) navMode = l.navMode;
  document.documentElement.style.setProperty('--deco', (l && l.accent) || '#0a84ff');
  const img = $('#avatar-img');
  img.classList.toggle('logo', !(l && l.profile));
  img.src = (l && l.profile) || '../assets/logo.png';
};
api.lookGet().then(applyLook).catch(() => {});
api.onLook(applyLook);
$('#avatar').onclick = () => { ui('home: picture clicked'); api.profileChoose(); };
$('#top-link').onclick = () => showTab('link');

// volume: the slider under the music is the volume of the whole computer; the mixer icon opens one slider for every program
const throttle = (fn, ms) => { let t = 0, timer = null, last; return (...a) => { last = a; const w = ms - (Date.now() - t); if (w <= 0) { t = Date.now(); fn(...last); } else if (!timer) timer = setTimeout(() => { timer = null; t = Date.now(); fn(...last); }, w); }; };
const volFill = (el) => el.style.setProperty('--v', el.value + '%');
const sendMaster = throttle((v) => api.mixerMaster(v), 80);
// macOS has no volume per program: its mixer shows the three system volumes instead
$('#vol').addEventListener('input', (e) => { volFill(e.target); mixDrag = Date.now(); sendMaster(Number(e.target.value)); });
const setVol = (v) => { if (Date.now() - mixDrag < 1500) return; $('#vol').value = v; volFill($('#vol')); };
volFill($('#vol'));
function mixerSync() { // reads the computer's volume now and then (not on every song update)
  if (mixerOpen || Date.now() - mixSyncAt < 15000) return;
  mixSyncAt = Date.now();
  api.mixerList().then((r) => { if (r && r.master !== undefined) setVol(r.master); }).catch(() => {});
}
const appName = (n) => { n = String(n).replace(/\.exe$/i, ''); return n.charAt(0).toUpperCase() + n.slice(1); };
const SPK = '<svg viewBox="0 0 24 24"><path d="M4 9.5h3l4.5-3.8v12.6L7 14.5H4z" style="fill:currentColor;stroke:none"/><path d="M15 9.3a4 4 0 0 1 0 5.4M17.6 6.7a7.6 7.6 0 0 1 0 10.6"/></svg>';
const SPK_OFF = '<svg viewBox="0 0 24 24"><path d="M4 9.5h3l4.5-3.8v12.6L7 14.5H4z" style="fill:currentColor;stroke:none"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/></svg>';
function renderMixer(r) {
  const box = $('#mx-list');
  if (!r || r.error || r.unsupported) { mixSig = ''; box.innerHTML = '<div id="mx-empty">' + (r && r.unsupported ? 'The mixer is for Windows' : 'The mixer is starting... or could not be read') + '</div>'; return; }
  setVol(r.master);
  const rows = MACOS ? [
    { key: 'master', name: 'Output volume', vol: r.master, active: true, master: true },
    { key: 'alert', name: 'Alert volume', vol: r.alert, active: true, mac: 'alert' },
    { key: 'input', name: 'Microphone', vol: r.input, active: true, mac: 'input' },
  ] : (r.apps || []).filter((x) => x.name !== "System sounds").sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name)).map((a) => ({ key: a.name, ...a }));
  if (!rows.length) { mixSig = ""; box.innerHTML = "<div id=\"mx-empty\">No program is making sound right now. The volume of the whole computer is the slider under the music.</div>"; return; }
  const sig = rows.map((x) => x.key).join('|');
  if (sig !== mixSig) { // a program started or stopped playing: draw the rows again
    mixSig = sig; box.innerHTML = '';
    rows.forEach((x) => {
      const row = document.createElement('div'); row.className = 'mx'; row.dataset.key = x.key;
      const nm = document.createElement('b'); nm.textContent = MACOS ? x.name : appName(x.name); nm.title = nm.textContent;
      const rg = document.createElement('input'); rg.type = 'range'; rg.min = 0; rg.max = 100;
      const pc = document.createElement('span'); pc.className = 'pc';
      const send = throttle((v) => (x.mac ? api.mixerMac(x.mac, v) : x.master ? api.mixerMaster(v) : api.mixerSet(x.name, v)), 80);
      rg.addEventListener('input', () => { volFill(rg); pc.textContent = rg.value; mixDrag = Date.now(); if (x.master) { $('#vol').value = rg.value; volFill($('#vol')); } send(Number(rg.value)); });
      row.append(nm, rg, pc);
      if (!x.master && !x.mac) {
        const mu = document.createElement('button'); mu.className = 'ico mu'; mu.title = 'Mute';
        mu.onclick = async () => { const off = !mu.classList.contains('off'); mu.classList.toggle('off', off); mu.innerHTML = off ? SPK_OFF : SPK; await api.mixerMute(x.name, off); };
        row.appendChild(mu);
      } else { const sp = document.createElement('span'); sp.style.width = '28px'; sp.style.flex = 'none'; row.appendChild(sp); }
      box.appendChild(row);
    });
  }
  if (Date.now() - mixDrag < 1500) return; // do not move a slider that is being dragged
  rows.forEach((x) => {
    const row = [...box.children].find((c) => c.dataset.key === x.key);
    if (!row) return;
    const rg = row.querySelector('input'); rg.value = x.vol; volFill(rg);
    row.querySelector('.pc').textContent = x.vol;
    row.querySelector('b').classList.toggle('idle', !x.active);
    const mu = row.querySelector('.mu'); if (mu) { mu.classList.toggle('off', !!x.muted); mu.innerHTML = x.muted ? SPK_OFF : SPK; }
  });
}
let mixBusy = false;
async function mixerRefresh() {
  if (mixBusy) return;
  mixBusy = true;
  try { renderMixer(await api.mixerList()); } catch {}
  mixBusy = false;
}
function closeMixer() {
  mixerOpen = false; mixSig = '';
  $('#mixer').hidden = true; $('#top-mixer').classList.remove('on');
  clearInterval(mixTimer); mixTimer = null;
}
$('#top-mixer').onclick = () => {
  if (mixerOpen) return closeMixer();
  ui('home: mixer opened');
  showPage(0);
  mixerOpen = true;
  $('#mixer').hidden = false; $('#top-mixer').classList.add('on');
  $('#mx-list').innerHTML = '<div id="mx-empty">Reading the volumes...</div>';
  mixerRefresh();
  mixTimer = setInterval(mixerRefresh, 2500);
};
$('#mixer-x').onclick = closeMixer;

// Link page, while a computer is linked: Look to switch and its calibration (they used to sit on the home page)
let gazeNow = { enabled: false }, nookLinked = false;
const renderGazeRow = () => {
  const g = gazeNow;
  $('#lk-gaze').hidden = !nookLinked;
  $('#lk-cal').textContent = !g.enabled ? 'Calibrate' : g.calibrating ? 'Calibrating...' : g.calibrated ? 'Recalibrate' : 'Calibrate';
  $('#lk-gaze-sw').classList.toggle('on', !!g.enabled);
  $('#lk-gaze-sw').setAttribute('aria-checked', g.enabled ? 'true' : 'false');
};
api.onGaze((g) => { gazeNow = g; renderGazeRow(); });
api.gazeGet().then((g) => { gazeNow = g; renderGazeRow(); });
api.onLink((st) => { nookLinked = !!st.connected; renderGazeRow(); });
api.linkStatus().then((st) => { nookLinked = !!st.connected; renderGazeRow(); });
$('#lk-cal').onclick = async () => {
  ui('link: calibrate clicked');
  if (!nookLinked) return;
  if (!gazeNow.enabled) { await api.gazeSet(true); setTimeout(() => api.gazeCalibrate(), 2500); return; }
  api.gazeCalibrate();
};
$('#lk-gaze-sw').onclick = () => { ui('link: look to switch ' + (gazeNow.enabled ? 'off' : 'on')); api.gazeSet(!gazeNow.enabled); };

// ---- WhatsApp page: the messages of the linked WhatsApp (or, without one, the ones WhatsApp shows as notifications on the Windows PC), grouped
// by chat. They are read by the main process (wa-connect.js / notify.js) and also reach the linked computer. Rows with a green dot are new since
// the page was last looked at. With a connection a chat can be answered right here.
var waState = { on: false, canRead: false, items: [], conn: { state: 'off' }, canReply: false }, waSeenAt = Date.now(), waSeenTimer = null;
var waOpenChats = new Set(), waDrafts = new Map();
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const initialsOf = (s) => { const w = String(s || '?').split(' ').filter(Boolean); return (Array.from(w[0] || '?')[0] + (w.length > 1 ? Array.from(w[1])[0] : '')).toUpperCase(); };
const hueOf = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) % 360; return h; };
const clockOf = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function agoOf(t) {
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return m + ' min';
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString() ? clockOf(t) : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
const waUnread = () => waState.items.filter((e) => e.at > waSeenAt && !e.mine).length;
function renderWaBadge() { if (!waState) return; const d = document.querySelector('#dots i[data-p="' + PAGES.indexOf('chat') + '"]'); if (d) d.classList.toggle('badge', waUnread() > 0 && PAGES[pageIdx] !== 'chat'); }
const waApply = (r) => { waState = r; renderWa(); renderWaBadge(); };

// the connection card: connect (QR), connecting, connected
function renderWaConn() {
  const s = waState, box = $('#wa-conn'), c = s.conn || { state: 'off' };
  box.textContent = '';
  box.hidden = !s.on;
  if (!s.on) return;
  const btn = (label, fn, cls) => { const b = mk('button', cls || 'wa-btn', label); b.onclick = fn; return b; };
  if (c.state === 'open') {
    const line = mk('div', 'wa-line');
    line.append(mk('span', '', 'Connected' + (c.name ? ' as ' + c.name : '') + ' · you can reply here'), btn('Disconnect', () => { ui('whatsapp: disconnect'); api.waDisconnect().then(waApply); }, 'wa-linkbtn'));
    box.appendChild(line);
  } else if (c.state === 'qr') {
    const card = mk('div', 'wa-card wa-qr');
    const img = mk('img'); img.src = c.qr; img.alt = 'QR code';
    const side = mk('div', 'wa-qr-text');
    side.append(mk('b', '', 'Scan with your phone'), mk('span', '', 'WhatsApp › Settings › Linked devices › Link a device, then point the camera at this code.'), btn('Cancel', () => api.waCancel().then(waApply), 'wa-linkbtn'));
    card.append(img, side);
    box.appendChild(card);
  } else if (c.state === 'connecting') {
    const line = mk('div', 'wa-line');
    line.append(mk('span', '', 'Connecting to WhatsApp...'), btn('Cancel', () => api.waCancel().then(waApply), 'wa-linkbtn'));
    box.appendChild(line);
  } else {
    const card = mk('div', 'wa-card');
    const side = mk('div', 'wa-qr-text');
    side.append(mk('b', '', s.canReply ? 'The linked computer is connected' : 'Reply from here (optional)'),
      mk('span', '', s.canReply ? 'Replies from here are sent through it.' : 'Messages already show here from the WhatsApp Desktop notifications, with nothing to connect. Only to REPLY from the island does WhatsApp need a second linked device: scan one QR code (WhatsApp › Settings › Linked devices). It uses an unofficial feature of WhatsApp; you can unlink any time.'));
    if (!s.canReply) side.appendChild(btn('Connect', () => { ui('whatsapp: connect'); api.waConnect().then(waApply); }));
    card.appendChild(side);
    box.appendChild(card);
  }
}

function renderWa() {
  const s = waState, list = $('#wa-list'), note = $('#wa-note');
  const linked = typeof linkInfo !== 'undefined' && !!(linkInfo && linkInfo.connected);
  const connected = !!(s.conn && s.conn.state === 'open');
  $('#wa-sw').classList.toggle('on', !!s.on);
  $('#wa-sw').setAttribute('aria-checked', s.on ? 'true' : 'false');
  $('#wa-clear').hidden = !s.on || !s.items.length;
  $('#wa-sub').textContent = s.on && s.items.length ? s.items.length + (s.items.length === 1 ? ' message' : ' messages') : '';
  $('#wa-names').hidden = !(s.on && s.canRead && !connected && !(s.conn && s.conn.state !== 'off')); // names are only needed when WhatsApp is not connected
  if (document.activeElement !== $('#wa-names-in')) $('#wa-names-in').value = (s.names || []).join(', ');
  renderWaConn();
  // keep what the person is typing across a redraw
  const act = document.activeElement, focusChat = act && act.dataset && act.dataset.chat, caret = focusChat ? act.selectionStart : 0;
  list.textContent = '';
  note.textContent = '';
  note.hidden = false;
  if (!s.on) {
    note.appendChild(mk('div', '', s.canRead
      ? 'See the WhatsApp messages you get on this computer here, and answer them from the island once WhatsApp is connected.'
      : linked ? 'Turn this on to see the WhatsApp messages the linked computer receives.'
        : 'Turn this on to see WhatsApp messages here. A linked computer shows them too.'));
    const b = mk('button', '', 'Turn on'); b.onclick = () => { ui('whatsapp: turned on'); api.waSet(true).then(waApply); };
    note.appendChild(b);
    return;
  }
  if (!s.items.length) {
    note.textContent = connected || s.canRead || linked ? 'No messages yet. New WhatsApp messages show up here as they arrive.' : 'Connect WhatsApp above, or link a Windows PC with WhatsApp Desktop, to see messages here.';
    return;
  }
  note.hidden = true;
  const by = new Map();
  for (const e of s.items) { if (!by.has(e.chat)) by.set(e.chat, []); by.get(e.chat).push(e); }
  const chats = [...by.values()].sort((a, b) => b[b.length - 1].at - a[a.length - 1].at);
  for (const arr of chats) {
    const last = arr[arr.length - 1], theirs = arr.filter((e) => !e.mine), head = theirs.length ? theirs[theirs.length - 1] : last;
    const row = mk('div', 'wa-row' + (arr.some((e) => e.at > waSeenAt && !e.mine) ? ' new' : '') + (waOpenChats.has(last.chat) ? ' open' : ''));
    const av = mk('div', 'wa-av', initialsOf(head.title)); av.style.background = 'hsl(' + hueOf(last.chat) + ',42%,36%)';
    const body = mk('div', 'wa-body');
    const top = mk('div', 'wa-top'); top.appendChild(mk('b', '', head.title)); top.appendChild(mk('time', '', agoOf(last.at)));
    const msg = mk('div', 'wa-msg');
    if (last.mine) { const t = mk('span', 'wa-tick'); t.innerHTML = '<svg viewBox="0 0 24 24"><path d="M1.5 13l4.5 4.5L14 8.5M9 16l1.5 1.5L19 8"/></svg>'; msg.appendChild(t); }
    else if (last.from) msg.appendChild(mk('i', '', last.from + ': '));
    msg.appendChild(document.createTextNode(last.text));
    body.append(top, msg);
    const bar = mk('div', 'wa-bar');
    if (s.canReply && /@/.test(last.chat)) {
      const form = mk('form', 'wa-reply'), inp = mk('input'), go = mk('button', '', 'Send');
      inp.placeholder = 'Reply...'; inp.maxLength = 1000; inp.autocomplete = 'off'; inp.dataset.chat = last.chat; inp.value = waDrafts.get(last.chat) || '';
      inp.oninput = () => waDrafts.set(last.chat, inp.value);
      go.type = 'submit';
      form.onsubmit = (ev) => {
        ev.preventDefault();
        const text = inp.value.trim();
        if (!text) return;
        go.disabled = true;
        ui('whatsapp: reply from the list');
        api.waReply(last.chat, text, head.q ? { ...head.q, preview: head.text.slice(0, 100) } : undefined).then((r) => {
          go.disabled = false;
          if (r.ok) { inp.value = ''; waDrafts.delete(last.chat); waOpenChats.delete(last.chat); row.classList.remove('open'); } else { inp.placeholder = r.error || 'Not sent'; }
        });
      };
      form.append(inp, go);
      bar.appendChild(form);
    }
    const open = mk('button', 'wa-openchat'); open.type = 'button'; open.title = 'Open this chat in WhatsApp'; open.setAttribute('aria-label', 'Open this chat in WhatsApp');
    open.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/></svg>';
    open.onclick = () => { ui('whatsapp: open the chat'); api.waOpen(last.chat); };
    bar.appendChild(open);
    bar.onclick = (ev) => ev.stopPropagation();
    body.appendChild(bar);
    row.append(av, body);
    
    row.onclick = () => { row.classList.toggle('open'); if (row.classList.contains('open')) waOpenChats.add(last.chat); else waOpenChats.delete(last.chat); };
    list.appendChild(row);
    if (focusChat === last.chat) { const i = row.querySelector('input'); if (i) { i.focus(); try { i.setSelectionRange(caret, caret); } catch { /* not a text field */ } } }
  }
}
function waMarkSeen() {
  clearTimeout(waSeenTimer);
  waSeenTimer = setTimeout(() => { if (PAGES[pageIdx] === 'chat' && isOpen) { waSeenAt = Date.now(); renderWaBadge(); } }, 2500); // the green dots stay a moment so they can be seen
}
api.onWa((s) => {
  const had = waState.items.length;
  waApply(s);
  if (s.items.length > had && isOpen && PAGES[pageIdx] === 'chat') waMarkSeen();
});
api.waGet().then((s) => { waSeenAt = Date.now(); waApply(s); });
$('#wa-sw').onclick = () => { ui('whatsapp: switch ' + (waState.on ? 'off' : 'on')); api.waSet(!waState.on).then(waApply); };
$('#wa-names-in').onchange = (e) => { ui('whatsapp: tag names changed'); api.waNames(e.target.value).then(waApply); };
$('#wa-clear').onclick = () => { ui('whatsapp: list cleared'); api.waClear().then(waApply); };
setInterval(() => { if (isOpen && PAGES[pageIdx] === 'chat' && waState.on && !(document.activeElement && document.activeElement.dataset && document.activeElement.dataset.chat)) renderWa(); }, 30000); // the times ("5 min") move on

// ---- Water page: a reminder every so many minutes. The ring fills as the time to the next reminder runs out.
var water = null;
const WATER_FULL = 326.7; // length of the ring (2 * pi * 52)
function renderWaterNext() {
  const w = water;
  if (!w) return;
  const left = w.on && w.nextAt ? w.nextAt - Date.now() : 0;
  const frac = w.on && w.nextAt ? Math.min(1, Math.max(0, 1 - left / (w.every * 60000))) : 0;
  $('#water-bar').style.strokeDashoffset = String(WATER_FULL * (1 - frac));
  $('#water-ml').textContent = !w.on ? '-' : left <= 0 ? 'now' : String(Math.max(1, Math.ceil(left / 60000)));
  $('#water-of').textContent = !w.on ? 'off' : left <= 0 ? 'time to drink' : 'min';
  $('#water-next').textContent = !w.on ? 'Reminders are off' : w.snoozeUntil > Date.now() ? 'Snoozed until ' + clockOf(w.snoozeUntil) : left <= 0 ? 'A reminder is due' : 'Next reminder at ' + clockOf(w.nextAt);
}
function renderWater() {
  const w = water;
  if (!w) return;
  $('#water-sw').classList.toggle('on', !!w.on);
  $('#water-sw').setAttribute('aria-checked', w.on ? 'true' : 'false');
  if (document.activeElement !== $('#water-every')) $('#water-every').value = w.every;
  $('#pill-water').hidden = !w.alert;
  renderWaterNext();
}
const setWater = (w) => { water = w; renderWater(); };
api.onWater(setWater);
api.waterGet().then(setWater);
$('#water-add').onclick = () => { ui('water: drank'); api.waterDrink().then(setWater); };
$('#water-snooze').onclick = () => { ui('water: snooze 15 min'); api.waterSnooze(15).then(setWater); };
$('#water-test').onclick = () => { api.waterTest(); };
$('#water-sw').onclick = () => { if (!water) return; ui('water: reminders ' + (water.on ? 'off' : 'on')); api.waterSet({ on: !water.on }).then(setWater); };
$('#water-every').onchange = (e) => { const v = Number(e.target.value); if (v >= 5) api.waterSet({ every: v }).then(setWater); };
setInterval(renderWaterNext, 15000);

// ---- Usage page: memory of this computer and the AI tokens (Claude Code) used today. Asked for only while the page is in view.
var usageBusy = false;
const fmtTok = (n) => (n >= 1e7 ? Math.round(n / 1e6) + 'M' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
const fmtMem = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB');
function renderUsage(u) {
  const r = u.ram, pct = Math.round((r.used / r.total) * 100);
  $('#u-ram-used').textContent = (r.used / 1073741824).toFixed(1) + ' GB';
  $('#u-ram-of').textContent = 'of ' + (r.total / 1073741824).toFixed(1) + ' GB · ' + pct + '%';
  const bar = $('#u-ram-bar'); bar.style.width = pct + '%'; bar.style.background = pct >= 85 ? '#ff453a' : pct >= 70 ? '#ff9f0a' : '#30d158';
  const top = $('#u-top'); top.textContent = '';
  const max = Math.max(1, ...r.top.map((t) => t.mb));
  for (const t of r.top) {
    const row = mk('div', 'u-row'); const bg = mk('i'); bg.style.width = Math.max(4, (t.mb / max) * 100) + '%';
    row.append(bg, mk('span', '', t.name), mk('em', '', fmtMem(t.mb)));
    top.appendChild(row);
  }
  $('#u-app').textContent = 'A-tuls itself uses ' + fmtMem(r.app);
  renderPlan(u.plan);
}
// "Resets at 11:00 PM" (today) or "Resets Wed 9:00 AM"
function resetText(at) {
  if (!at) return '';
  if (at - Date.now() <= 60000) return 'Resets soon';
  const d = new Date(at), time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return 'Resets at ' + time;
  return 'Resets ' + d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
}
// the bars of the Claude plan (session and weekly limit), only when the person switched them on
function renderPlan(p) {
  const box = $('#u-plan'); box.textContent = '';
  $('#u-plan-name').textContent = p && p.ok && p.plan ? ' \u00b7 ' + p.plan : '';
  $('#u-seeall').hidden = !(p && p.enabled);
  $('#u-seeall').onclick = () => api.usageOpenWeb();
  const note = (text) => box.appendChild(mk('div', 'u-planhint', text));
  const link = (label, fn) => { const b = mk('button', 'wa-linkbtn', label); b.onclick = fn; return b; };
  const acts = (...els) => { const d = mk('div', 'u-planacts'); d.append(...els); box.appendChild(d); };
  if (!p || !p.enabled) {
    note('See how much of your Claude plan is used: the session limit and the weekly limit, like in Claude itself.');
    const b = mk('button', 'wa-btn', 'Show my limits'); b.onclick = () => api.usagePlan(true).then(usageRefresh); box.appendChild(b); return;
  }
  if (!p.ok) {
    if (p.need === 'signin') {
      note('Sign in to Claude once to see the limits. You type your password in the Claude window itself; A-tuls only asks for the usage numbers.');
      const b = mk('button', 'wa-btn', 'Sign in to Claude'); b.onclick = () => { ui('usage: sign in to Claude'); api.usageClaudeLogin(); }; box.appendChild(b);
    } else note(p.error || 'The limits could not be read');
    acts(link('Try again', usageRefresh), link('Hide', () => api.usagePlan(false).then(usageRefresh)));
    return;
  }
  for (const [label, b] of [['5-hour limit', p.session], ['Weekly \u00b7 all models', p.week], ['Weekly \u00b7 Opus', p.weekOpus]]) {
    if (!b) continue;
    const row = mk('div', 'u-limit'), top = mk('div', 'u-limtop');
    top.append(mk('span', '', label), mk('em', '', resetText(b.resetsAt) + '   ' + b.pct + '%'));
    const bar = mk('div', 'u-bar'), fill = mk('i'); fill.style.width = b.pct + '%'; fill.style.background = b.pct >= 90 ? '#ff453a' : b.pct >= 75 ? '#f5b73c' : '#4a86e8';
    bar.appendChild(fill); row.append(top, bar); box.appendChild(row);
  }
  if (p.credits) {
    const c = p.credits, row = mk('div', 'u-limit u-credit'), top = mk('div', 'u-limtop');
    top.append(mk('span', '', 'Cloud session credits'), mk('em', '', '$' + Math.round(c.left * 100) / 100 + ' of $' + Math.round(c.total * 100) / 100 + ' left'));
    const bar = mk('div', 'u-bar thin'), fill = mk('i'); fill.style.width = Math.max(1, Math.min(100, ((c.total - c.left) / (c.total || 1)) * 100)) + '%'; // the bar shows what was used, like in Claude fill.style.background = '#4a86e8';
    bar.appendChild(fill); row.append(top, bar);
    if (c.expiresAt) { const d = new Date(c.expiresAt); row.appendChild(mk('div', 'u-planhint', 'Expires ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) + ', ' + d.toLocaleDateString([], { month: 'long', day: 'numeric' }))); }
    box.appendChild(row);
  }
  acts(link('Hide', () => api.usagePlan(false).then(usageRefresh)), ...(p.source === 'web' ? [link('Sign out', () => api.usageClaudeOut().then(usageRefresh))] : []));
}
function usageRefresh() {
  if (usageBusy) return;
  usageBusy = true;
  api.usageGet().then(renderUsage).catch(() => {}).finally(() => { usageBusy = false; });
}
setInterval(() => { if (isOpen && PAGES[pageIdx] === 'usage') usageRefresh(); }, 3000);

// ---- the reply field of a message banner: it stays while the pointer is on it or something is typed, and goes a few seconds after
const replyIn = $('#toast-reply-in');
const replyRest = (ms) => { clearTimeout(toastTimer); toastTimer = setTimeout(() => { if (document.activeElement === replyIn || replyIn.value.trim()) return; endToast(); }, ms); };
$('#toast').addEventListener('mouseenter', () => { if (replyToastOn && !alarmCtx) clearTimeout(toastTimer); });
$('#toast').addEventListener('mouseleave', () => { if (replyToastOn && !alarmCtx) replyRest(Math.min(3000, replyMs)); });
replyIn.addEventListener('focus', () => { clearTimeout(toastTimer); api.keepOpen(true); });
replyIn.addEventListener('blur', () => { api.keepOpen(false); if (replyToastOn && !alarmCtx) replyRest(Math.min(3000, replyMs)); });
replyIn.addEventListener('keydown', (e) => { if (e.key === 'Escape') { replyIn.value = ''; replyIn.blur(); endToast(); } });
$('#toast-reply').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = replyIn.value.trim();
  if (!text || !replyCtx) return;
  const ctx = replyCtx;
  ui('whatsapp: reply from the banner');
  $('#toast-reply-go').disabled = true;
  api.waReply(ctx.chat, text, ctx.q ? { ...ctx.q, preview: ctx.preview || '' } : undefined).then((r) => {
    $('#toast-reply-go').disabled = false;
    if (r.ok) { replyIn.value = ''; replyIn.blur(); endToast(); } else { replyIn.placeholder = r.error || 'Not sent'; }
  });
});
