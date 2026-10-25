// Calendars from the phone or the account, with no sign-in: Google Calendar (and with it Android) and iCloud (iPhone) can each give out a link
// to the calendar in the iCal format (.ics). A-tuls reads those links, keeps the events of the coming weeks, and refreshes them now and then.
// The links are secret (anybody with the link can read the calendar), so the list of links is kept sealed like the pairing tokens.
const fs = require('fs');
const path = require('path');
const ICAL = require('ical.js');

const DAYS_BACK = 2, DAYS_AHEAD = 45, REFRESH_MS = 15 * 60 * 1000, MAX_BYTES = 8 * 1024 * 1024;
let store = null, cacheFile = '', events = [], status = {}, timer = null, onChange = () => {};

// webcal://... is https://... in disguise; only http(s) is ever fetched
function normalizeUrl(u) {
  let s = String(u || '').trim();
  if (/^webcals?:\/\//i.test(s)) s = s.replace(/^webcal/i, 'http').replace(/^http:\/\//i, 'https://');
  try { const x = new URL(s); if (x.protocol !== 'https:' && x.protocol !== 'http:') return ''; return x.href; } catch { return ''; }
}

const sources = () => (store.get('calendars', []) || []).filter((s) => s && s.url);
const publicSources = () => sources().map((s) => ({ id: s.id, name: s.name, ok: !(status[s.id] && status[s.id].error), error: (status[s.id] && status[s.id].error) || '', count: (status[s.id] && status[s.id].count) || 0, at: (status[s.id] && status[s.id].at) || 0 }));

async function fetchIcs(url) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'A-tuls', Accept: 'text/calendar, text/plain, */*' } });
    if (!r.ok) throw new Error('The server answered ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('That calendar is too big');
    const text = buf.toString('utf8');
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That link is not a calendar (it should end in .ics)');
    return text;
  } finally { clearTimeout(t); }
}

// every event that touches [from, to), recurring ones expanded
function expand(text, source, from, to) {
  const out = [];
  const comp = new ICAL.Component(ICAL.parse(text));
  for (const vevent of comp.getAllSubcomponents('vevent')) {
    let ev;
    try { ev = new ICAL.Event(vevent); } catch { continue; }
    if (!ev.startDate) continue;
    const push = (start, end) => {
      const s = start.toJSDate(), e = end ? end.toJSDate() : s;
      if (e < from && s < from) return;
      if (s >= to) return;
      out.push({ id: ev.uid + '@' + s.getTime(), title: ev.summary || '(no title)', start: s.getTime(), end: e.getTime(), allDay: !!start.isDate, place: ev.location || '', cal: source.name, src: source.id });
    };
    try {
      if (ev.isRecurring()) {
        const it = ev.iterator();
        let n = 0, next;
        while ((next = it.next()) && n++ < 800) {
          const d = ev.getOccurrenceDetails(next);
          if (d.startDate.toJSDate() >= to) break;
          push(d.startDate, d.endDate);
        }
      } else push(ev.startDate, ev.endDate);
    } catch { /* a broken event is skipped, the rest still shows */ }
  }
  return out;
}

async function refresh() {
  const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - DAYS_BACK);
  const to = new Date(from.getTime() + (DAYS_BACK + DAYS_AHEAD) * 86400000);
  const all = [], next = {};
  for (const s of sources()) {
    try {
      const list = expand(await fetchIcs(s.url), s, from, to);
      all.push(...list);
      next[s.id] = { count: list.length, at: Date.now() };
    } catch (e) {
      next[s.id] = { error: String(e && e.name === 'AbortError' ? 'No answer (timed out)' : (e && e.message) || e).slice(0, 120), at: Date.now() };
      // keep what was known for this calendar while it cannot be reached
      all.push(...events.filter((x) => x.src === s.id));
    }
  }
  events = all.sort((a, b) => a.start - b.start);
  status = next;
  try { fs.writeFileSync(cacheFile, JSON.stringify(events)); } catch {}
  onChange();
}

function init(st, dir, change) {
  store = st; cacheFile = path.join(dir, 'calendar-cache.json'); onChange = change || (() => {});
  try { events = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || []; } catch { events = []; }
  if (sources().length) setTimeout(() => refresh().catch(() => {}), 8000).unref();
  timer = setInterval(() => { if (sources().length) refresh().catch(() => {}); }, REFRESH_MS); timer.unref();
}

async function add(name, url) {
  const u = normalizeUrl(url);
  if (!u) return { ok: false, error: 'That is not a calendar link. It should start with https:// or webcal://' };
  const list = sources();
  if (list.some((s) => s.url === u)) return { ok: false, error: 'That calendar is already added' };
  try { await fetchIcs(u); } catch (e) { return { ok: false, error: String((e && e.name === 'AbortError') ? 'No answer (timed out)' : (e && e.message) || e).slice(0, 140) }; }
  const id = 'c' + Date.now().toString(36);
  store.set('calendars', [...list, { id, name: String(name || '').trim().slice(0, 40) || 'Calendar ' + (list.length + 1), url: u }]);
  await refresh();
  return { ok: true };
}
function remove(id) {
  store.set('calendars', sources().filter((s) => s.id !== id));
  events = events.filter((e) => e.src !== id);
  delete status[id];
  try { fs.writeFileSync(cacheFile, JSON.stringify(events)); } catch {}
  onChange();
}
const range = (from, to) => events.filter((e) => e.end > from && e.start < to);

module.exports = { init, add, remove, refresh, range, sources: publicSources, normalizeUrl };
