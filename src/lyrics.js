// Lyrics for what is playing, from LRCLIB (https://lrclib.net, free, no account). Only the title, artist and length of the current track are sent.
// Time-stamped lyrics ("synced") are what the pill shows line by line; a track without them just shows no lyrics.
// Answers are remembered on disk, so a song heard again (or offline) needs no request.
const fs = require('fs');
const path = require('path');

const API = 'https://lrclib.net/api';
let cacheFile = '', cache = null, ua = 'A-tuls';
const misses = new Map(); // key -> time of the miss (retried after 30 minutes)

function init(dir, version) {
  cacheFile = path.join(dir, 'lyrics-cache.json');
  ua = 'A-tuls/' + version + ' (https://github.com/Rizqaputraaa/Atuls)';
}
function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { cache = {}; }
  return cache;
}
function save() {
  try {
    const keys = Object.keys(cache);
    if (keys.length > 300) for (const k of keys.sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0)).slice(0, keys.length - 250)) delete cache[k];
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
  } catch {}
}

// "[01:23.45] text" lines -> [{ t: seconds, line }], in time order
function parseLrc(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const line = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) out.push({ t: Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3].padEnd(3, '0')) / 1000 : 0), line });
  }
  return out.sort((a, b) => a.t - b.t);
}

// A video title is not a song title: "Artist - Song (Official Video) [4K] | Label" -> artist "Artist", title "Song"
const NOISE = /\b(official|video|audio|lyrics?|lyric video|music video|mv|hd|hq|4k|remaster(ed)?|visuali[sz]er|explicit|clean|full song|full version|topic)\b/i;
function clean(title, artist) {
  let t = String(title || '').replace(/[\[(（【][^\])）】]*[\])）】]/g, (m) => (NOISE.test(m) ? '' : m)).replace(/\s*[|｜].*$/, '').replace(/\s{2,}/g, ' ').trim();
  let a = String(artist || '').replace(/\s*-\s*topic$/i, '').replace(/vevo$/i, '').trim();
  const dash = t.split(/\s+[-–—]\s+/);
  if (dash.length >= 2) { a = dash[0].trim(); t = dash.slice(1).join(' - ').trim(); }
  t = t.replace(/\s*(ft\.?|feat\.?|featuring)\s+.*$/i, '').trim();
  return { title: t, artist: a };
}

async function get(url) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': ua }, signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

// does a found song really look like the one that plays? (a video that is no song must not get the lyrics of a song that happens to match)
const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
function similar(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const ta = new Set(a.split(' ')), tb = b.split(' ');
  return tb.filter((w) => ta.has(w)).length / Math.max(tb.length, ta.size) >= 0.6;
}

const pick = (hit) => (hit && hit.syncedLyrics ? parseLrc(hit.syncedLyrics) : null);

async function lookup({ title, artist, duration }) {
  // a song is between 1 and 20 minutes; shorter or unknown lengths are videos, reels, ads: no lyrics for those
  if (!(duration >= 60 && duration <= 1200)) return null;
  // no artist and no "Artist - Song" in the title: a page or a video (a reel, a tab named "Instagram"), not a song
  if (!String(artist || '').trim() && !/\s[-–—]\s/.test(String(title))) return null;
  const key = (artist + '|' + title + '|' + Math.round((duration || 0) / 5)).toLowerCase();
  const c = load();
  if (c[key]) return c[key].lines.length ? c[key].lines : null;
  if (misses.has(key) && Date.now() - misses.get(key) < 30 * 60 * 1000) return null;

  const tries = [];
  const q = (o) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  const cl = clean(title, artist);
  const dur = duration > 0 ? Math.round(duration) : '';
  for (const [a, t] of [[artist, title], [cl.artist, cl.title]]) if (a && t) tries.push(() => get(`${API}/get?${q({ artist_name: a, track_name: t, duration: dur })}`));
  tries.push(async () => { // a search, then the hit whose length is closest to the playing one
    const list = await get(`${API}/search?${q({ q: (cl.artist ? cl.artist + ' ' : '') + cl.title })}`);
    if (!Array.isArray(list)) return null;
    const ok = list.filter((x) => x.syncedLyrics && similar(x.trackName, cl.title) && Math.abs((x.duration || 0) - duration) <= 8);
    if (!ok.length) return null;
    ok.sort((x, y) => Math.abs((x.duration || 0) - duration) - Math.abs((y.duration || 0) - duration));
    return ok[0];
  });
  for (const t of tries) {
    const hit = await t();
    if (hit && !(similar(hit.trackName, cl.title) || similar(hit.trackName, title))) continue;
    const lines = pick(hit);
    if (lines && lines.length) { c[key] = { at: Date.now(), lines }; save(); return lines; }
  }
  misses.set(key, Date.now());
  return null;
}

module.exports = { init, lookup, parseLrc, clean };
