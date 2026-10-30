// The Usage page: how much memory this computer is using (and by which programs) and how many AI tokens were used today.
// Nothing runs in the background: the numbers are worked out when the page asks for them, and the token files are read from where
// they stopped the last time, so a refresh is cheap.
//
// AI tokens: Claude Code writes every conversation as a .jsonl file under ~/.claude/projects (on both Windows and macOS). Each answer carries
// the tokens it used; they are added up per day. Only the counts are read, never kept with the text.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DAYS = 7;
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (t) => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };

// ---- memory ---------------------------------------------------------------------------------------------------------------------------
let ramCache = { at: 0, top: [] };
function run(cmd, args) {
  return new Promise((resolve) => { try { execFile(cmd, args, { timeout: 6000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(err ? '' : String(out))); } catch { resolve(''); } });
}
async function topPrograms() {
  const sums = new Map();
  if (process.platform === 'win32') {
    const out = await run('tasklist', ['/fo', 'csv', '/nh']);
    for (const line of out.split('\n')) {
      const f = line.split('","');
      if (f.length < 5) continue;
      const name = f[0].replace(/^"/, '').replace(/\.exe$/i, ''), kb = Number(String(f[4]).replace(/\D/g, '')) || 0; // "123,456 K" (the separator depends on the language)
      sums.set(name, (sums.get(name) || 0) + kb / 1024);
    }
  } else {
    const out = await run('/bin/ps', ['-axo', 'rss=,comm=']);
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!m) continue;
      const name = path.basename(m[2]).replace(/ Helper.*$/, '').slice(0, 40); // all the helper processes of one app count as the app
      sums.set(name, (sums.get(name) || 0) + Number(m[1]) / 1024);
    }
  }
  return [...sums].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, mb]) => ({ name, mb: Math.round(mb) }));
}
async function ram(appMb) {
  const total = os.totalmem(), free = os.freemem();
  if (Date.now() - ramCache.at > 4000) { ramCache = { at: Date.now(), top: await topPrograms() }; }
  return { total, used: total - free, app: Math.round(appMb || 0), top: ramCache.top };
}

// ---- AI tokens (Claude Code) -----------------------------------------------------------------------------------------------------------
const root = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const files = new Map(); // path -> { offset, tail }
const seen = new Map(); // message id -> the tokens counted for it so far (an answer is written to the file more than once, growing each time)
const perDay = new Map(); // 'YYYY-MM-DD' -> { i, o, cw, cr, n }
const perModel = new Map(); // today's tokens per model: model -> total
let scanning = null, lastScan = 0, modelDay = '';

function add(day, model, u) {
  const d = perDay.get(day) || { i: 0, o: 0, cw: 0, cr: 0, n: 0 };
  d.i += u.i; d.o += u.o; d.cw += u.cw; d.cr += u.cr; d.n += u.n || 0;
  perDay.set(day, d);
  if (day === dayKey(Date.now())) { if (modelDay !== day) { perModel.clear(); modelDay = day; } perModel.set(model, (perModel.get(model) || 0) + u.i + u.o); }
}

function readLine(line) {
  if (line.indexOf('"usage"') < 0) return; // most lines are text, tool results and so on
  let j; try { j = JSON.parse(line); } catch { return; }
  const m = j && j.message;
  if (!m || !m.usage || j.type === 'user') return;
  const now = { i: m.usage.input_tokens || 0, o: m.usage.output_tokens || 0, cw: m.usage.cache_creation_input_tokens || 0, cr: m.usage.cache_read_input_tokens || 0 };
  const t = Date.parse(j.timestamp);
  if (!t) return;
  const id = (m.id || '') + ':' + (j.requestId || '');
  const prev = m.id ? seen.get(id) : null;
  if (m.id) seen.set(id, now);
  // the first write of an answer can hold only part of its output: a later one adds what grew
  const delta = prev ? { i: Math.max(0, now.i - prev.i), o: Math.max(0, now.o - prev.o), cw: Math.max(0, now.cw - prev.cw), cr: Math.max(0, now.cr - prev.cr), n: 0 } : { ...now, n: 1 };
  add(dayKey(t), String(m.model || 'unknown').replace(/^claude-/, ''), delta);
}

async function readNew(file, st) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    if (size < st.offset) { st.offset = 0; st.tail = ''; } // the file was replaced
    const buf = Buffer.alloc(1024 * 1024);
    while (st.offset < size) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, st.offset);
      if (!bytesRead) break;
      st.offset += bytesRead;
      const text = st.tail + buf.toString('utf8', 0, bytesRead);
      const lines = text.split('\n');
      st.tail = lines.pop(); // the last piece may be a line that is still being written
      for (const l of lines) readLine(l);
      await new Promise((r) => setImmediate(r)); // let the app breathe between megabytes
    }
  } finally { await fh.close(); }
}

async function scan() {
  const base = root();
  let dirs = [];
  try { dirs = await fs.promises.readdir(base, { withFileTypes: true }); } catch { return false; }
  const since = Date.now() - (DAYS + 1) * 86400000;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let names = [];
    try { names = await fs.promises.readdir(path.join(base, d.name)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const f = path.join(base, d.name, n);
      try {
        const s = await fs.promises.stat(f);
        if (s.mtimeMs < since) continue;
        let st = files.get(f);
        if (!st) { st = { offset: 0, tail: '' }; files.set(f, st); }
        if (s.size !== st.offset) await readNew(f, st);
      } catch { /* a file that vanished or is locked is skipped */ }
    }
  }
  return true;
}

async function tokens() {
  if (!scanning && Date.now() - lastScan > 3000) {
    scanning = scan().catch(() => false).finally(() => { scanning = null; lastScan = Date.now(); });
  }
  if (scanning && !perDay.size) await scanning; // the first look waits for the first read; later ones answer at once with what is known
  const today = dayKey(Date.now()), days = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const k = dayKey(Date.now() - i * 86400000), d = perDay.get(k) || { i: 0, o: 0, cw: 0, cr: 0, n: 0 };
    days.push({ day: k.slice(5), tokens: d.i + d.o, cache: d.cw + d.cr });
  }
  const t = perDay.get(today) || { i: 0, o: 0, cw: 0, cr: 0, n: 0 };
  return {
    found: fs.existsSync(root()),
    scanning: !!scanning,
    today: { input: t.i, output: t.o, cacheWrite: t.cw, cacheRead: t.cr, answers: t.n },
    days,
    models: [...perModel].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([model, tokens]) => ({ model, tokens })),
  };
}

// ---- the limits of the Claude plan (the "Session" and "Weekly" bars of Claude's own usage panel) ------------------------------------------
// Only when the person switched it on. Claude Code keeps its login on this computer (a file on Windows, the Keychain on a Mac); with it Anthropic is
// asked for the percentages. The login is used for that one request and is never stored or shown by A-tuls. If it has expired, opening Claude Code
// once renews it.
let planCache = { at: 0, data: null };
async function readLogin() {
  try {
    let raw = '';
    if (process.platform === 'darwin') raw = await run('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']); // the Keychain asks the person first
    else raw = fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'), 'utf8');
    const j = JSON.parse(raw.trim());
    return j && j.claudeAiOauth ? j.claudeAiOauth : null;
  } catch { return null; }
}
const bar = (b) => (b && Number.isFinite(Number(b.utilization)) ? { pct: Math.max(0, Math.min(100, Math.round(Number(b.utilization)))), resetsAt: b.resets_at ? Date.parse(b.resets_at) || 0 : 0 } : null);
function parsePlan(j, kind) {
  return { enabled: true, ok: true, plan: kind ? String(kind).replace(/^./, (c) => c.toUpperCase()) : '', session: bar(j && j.five_hour), week: bar(j && j.seven_day), weekOpus: bar(j && j.seven_day_opus) };
}
async function plan(enabled) {
  if (!enabled) return { enabled: false };
  if (planCache.data && Date.now() - planCache.at < 60000) return planCache.data;
  let data;
  const login = await readLogin();
  if (!login || !login.accessToken) data = { enabled: true, ok: false, error: 'No Claude Code login file here. The Claude desktop app keeps its login private, so A-tuls cannot read it: sign in once with the Claude Code command line (claude, then /login).' };
  else if (login.expiresAt && Number(login.expiresAt) < Date.now()) data = { enabled: true, ok: false, error: 'The Claude login has expired: open Claude Code once to renew it' };
  else {
    try {
      const res = await fetch('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: 'Bearer ' + login.accessToken, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'A-tuls' }, signal: AbortSignal.timeout(8000) });
      data = res.ok ? parsePlan(await res.json(), login.subscriptionType) : { enabled: true, ok: false, error: 'Anthropic did not answer (' + res.status + ')' };
    } catch (e) { data = { enabled: true, ok: false, error: 'Anthropic could not be reached' }; }
  }
  planCache = { at: Date.now(), data };
  return data;
}

async function get(appMb, planOn) {
  const [r, ai, pl] = await Promise.all([ram(appMb), tokens(), plan(planOn)]);
  return { ram: r, ai, plan: pl };
}

module.exports = { get, readLine, perDay, seen, parsePlan };
