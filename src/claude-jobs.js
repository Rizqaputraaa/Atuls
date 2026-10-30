// What Claude Code is doing, read from its session files (~/.claude/projects/<project>/<session>.jsonl, the same on Windows and macOS).
// A job is one thing the person asked: it starts with their message and ends when Claude answers without asking for another tool. While it runs
// the tools it used say which step it is at: Read (looking at files), Edit (changing them), Test (running tests or a build), Done.
// Only the project name, the times, the tool names and the last answer are kept; the files are read from where they stopped the last time.
const fs = require('fs');
const os = require('os');
const path = require('path');

const READ = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead', 'ToolSearch']);
const EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL = new Set(['Bash', 'PowerShell']);
const TEST_RE = /\b(npm (run )?(test|build|lint)|npx (jest|vitest|tsc|eslint)|jest|vitest|pytest|mocha|cargo (test|build|check)|go (test|build|vet)|dotnet (test|build)|gradle|mvn|tsc|eslint|ruff|node --(check|test)|make (test|build))\b/i;
const STALE_MS = 5 * 60000; // a job with no sign of life for this long is not "running"
const dayKey = (t) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

const rootCache = new Map();
// the project of a working folder: the nearest folder above it that holds a .git (else the folder itself)
function projectOf(cwd) {
  if (!cwd) return '';
  if (rootCache.has(cwd)) return rootCache.get(cwd);
  let dir = cwd, name = path.basename(cwd);
  for (let i = 0; i < 8; i++) {
    try { if (fs.existsSync(path.join(dir, '.git'))) { name = path.basename(dir); break; } } catch { /* not readable */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  rootCache.set(cwd, name);
  return name;
}
const newJob = (at) => ({ start: at, last: at, end: 0, read: false, edit: false, test: false, text: '', act: null, ask: null });
// a question with answers to choose from: the question tool of Claude Code, or the box at the end of a turn in the Claude desktop app
function askOf(b) {
  const i = b.input || {};
  if (b.name === 'AskUserQuestion' && Array.isArray(i.questions) && i.questions[0]) {
    const q = i.questions[0];
    return { id: b.id, kind: 'question', text: short(q.question, 300), options: (Array.isArray(q.options) ? q.options : []).map((o) => short(o && o.label, 60)).filter(Boolean).slice(0, 4) };
  }
  if (/(^|__)wrap_up$/.test(b.name || '') && i.ask) return { id: b.id, kind: 'box', text: short([i.recap, i.ask].filter(Boolean).join('\n'), 500), options: (Array.isArray(i.actions) ? i.actions : []).map((o) => short(o && o.label, 60)).filter(Boolean).slice(0, 3) };
  return null;
}
const short = (s, n) => String(s || '').replace(/\r/g, '').slice(0, n);
const firstLines = (s, n, w) => String(s || '').replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '').slice(0, n).map((l) => short(l.trim(), w));
const base = (p) => String(p || '').split(/[\\/]/).pop();
// the latest thing Claude does with a tool, for the card of the working view (names, the changed lines and the command; never whole files)
function activity(b) {
  const i = b.input || {};
  if (EDIT.has(b.name)) {
    const e = b.name === 'MultiEdit' && Array.isArray(i.edits) && i.edits[0] ? i.edits[0] : i;
    return { kind: b.name === 'Write' ? 'write' : 'edit', file: base(i.file_path || i.notebook_path), del: b.name === 'Write' ? [] : firstLines(e.old_string, 2, 70), add: firstLines(b.name === 'Write' ? i.content : e.new_string, 2, 70) };
  }
  if (READ.has(b.name)) return { kind: 'read', file: base(i.file_path || i.path) || short(i.pattern || i.query || i.url || b.name, 60) };
  if (SHELL.has(b.name)) return { kind: TEST_RE.test(String(i.command || i.cmd || '')) ? 'test' : 'run', cmd: short(i.command || i.cmd, 90) };
  return null;
}

// one line of a session file into the state of that file
function feed(st, line) {
  if (line.indexOf('"type":"user"') < 0 && line.indexOf('"type":"assistant"') < 0 && line.indexOf('"custom-title"') < 0) return;
  let j; try { j = JSON.parse(line); } catch { return; }
  if (!j) return;
  if (j.type === 'custom-title' && j.customTitle) { st.title = String(j.customTitle).slice(0, 60); return; }
  if (j.isSidechain || (j.type !== 'user' && j.type !== 'assistant')) return;
  if (j.cwd) { st.cwd = String(j.cwd); if (!st.project) st.project = path.basename(st.cwd); }
  const at = Date.parse(j.timestamp) || 0;
  if (!at) return;
  const c = j.message && j.message.content;
  if (j.type === 'user') {
    if (j.isMeta) return;
    const blocks = Array.isArray(c) ? c : typeof c === 'string' ? [{ type: 'text', text: c }] : [];
    if (blocks.some((b) => b && b.type === 'tool_result')) { // the answer of a tool, not a new request
      if (st.job) { st.job.last = at; const a = st.job.ask; if (a && a.kind === 'question' && blocks.some((b) => b && b.tool_use_id === a.id)) st.job.ask = null; }
      return;
    }
    if (!blocks.some((b) => b && (b.type === 'text' || b.type === 'image'))) return;
    if (blocks.every((b) => !b || b.type !== 'text' || /^\s*<(task-notification|system-reminder|command-)/.test(b.text || ''))) { if (st.job) st.job.last = at; return; } // a message of the app itself (a finished background task...), not of the person
    st.job = newJob(at); // a new request
    return;
  }
  // an answer of Claude
  const job = st.job || (st.job = newJob(at));
  job.last = Math.max(job.last, at);
  for (const b of Array.isArray(c) ? c : []) {
    if (!b) continue;
    if (b.type === 'tool_use') {
      const q = askOf(b);
      job.ask = q; // any other tool use means Claude went on
      const a = q ? null : activity(b); if (a) job.act = a;
      if (READ.has(b.name)) job.read = true;
      else if (EDIT.has(b.name)) job.edit = true;
      else if (SHELL.has(b.name)) { const cmd = b.input && (b.input.command || b.input.cmd); if (typeof cmd === 'string' && TEST_RE.test(cmd)) job.test = true; }
    } else if (b.type === 'text' && b.text && b.text.trim()) job.text = b.text.trim().slice(0, 300);
  }
  if (j.message && j.message.stop_reason === 'end_turn' && !job.end) {
    job.end = at;
    if (j.message.id !== st.lastEndId) { st.lastEndId = j.message.id; (st.ended = st.ended || []).push(at); if (st.ended.length > 400) st.ended.shift(); }
  }
}

class ClaudeJobs {
  constructor(root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')) {
    this.root = root;
    this.files = new Map(); // path -> { offset, tail, project, title, job, ended: [times] }
    this.busy = null; this.at = 0;
  }

  async readNew(file, st) {
    const fh = await fs.promises.open(file, 'r');
    try {
      const size = (await fh.stat()).size;
      if (size < st.offset) { st.offset = 0; st.tail = ''; st.job = null; st.ended = []; }
      const buf = Buffer.alloc(1024 * 1024);
      while (st.offset < size) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, st.offset);
        if (!bytesRead) break;
        st.offset += bytesRead;
        const lines = (st.tail + buf.toString('utf8', 0, bytesRead)).split('\n');
        st.tail = lines.pop();
        for (const l of lines) feed(st, l);
        await new Promise((r) => setImmediate(r));
      }
    } finally { await fh.close(); }
  }

  async scan() {
    let dirs = [];
    try { dirs = await fs.promises.readdir(this.root, { withFileTypes: true }); } catch { return; }
    const since = Date.now() - 36 * 3600000; // sessions touched in the last day and a half
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      let names = [];
      try { names = await fs.promises.readdir(path.join(this.root, d.name)); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const f = path.join(this.root, d.name, n);
        try {
          const s = await fs.promises.stat(f);
          if (s.mtimeMs < since) { this.files.delete(f); continue; }
          let st = this.files.get(f);
          if (!st) { st = { offset: 0, tail: '', project: '', title: '', job: null, ended: [] }; this.files.set(f, st); }
          if (s.size !== st.offset) await this.readNew(f, st);
        } catch { /* a file that vanished or is locked is skipped */ }
      }
    }
  }

  // asks for a fresh look at most every 2 seconds
  async refresh() {
    if (!this.busy && Date.now() - this.at > 2000) this.busy = this.scan().catch(() => {}).finally(() => { this.busy = null; this.at = Date.now(); });
    if (this.busy && !this.files.size) await this.busy;
  }

  status(now = Date.now()) {
    const today = dayKey(now);
    let jobs = 0, cur = null, from = null;
    for (const st of this.files.values()) {
      for (const t of st.ended || []) if (dayKey(t) === today) jobs++;
      if (st.job && (!cur || st.job.last > cur.last)) { cur = st.job; from = st; }
    }
    if (!cur) return { found: fs.existsSync(this.root), jobsToday: jobs, current: null };
    const running = !cur.end && !cur.ask && now - cur.last < STALE_MS;
    const finished = !!cur.end || !!(cur.ask && cur.ask.kind === 'box'); // the box at the end of a turn: the work is done, only the answer is awaited
    const stage = cur.end ? 'done' : cur.test ? 'test' : cur.edit ? 'edit' : cur.read ? 'read' : 'start';
    return {
      found: true, jobsToday: jobs,
      current: {
        project: projectOf(from.cwd) || from.project || from.title || 'Claude Code',
        startedAt: cur.start, endedAt: cur.end, lastAt: cur.last, running, stale: !cur.end && !running,
        steps: { read: cur.read || finished, edit: cur.edit || finished, test: cur.test || finished, done: finished },
        did: { read: cur.read, edit: cur.edit, test: cur.test }, stage: cur.ask ? 'ask' : stage, text: cur.text, act: cur.end || cur.ask ? null : cur.act, ask: cur.ask ? { text: cur.ask.text, options: cur.ask.options, done: cur.ask.kind === 'box' } : null,
      },
    };
  }
}

module.exports = { ClaudeJobs, feed, newJob };
