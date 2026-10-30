// WhatsApp messages from the notifications Windows shows for them.
// Windows keeps every notification of every app in one small database (wpndatabase.db). WhatsApp's own toasts carry the sender and the text;
// they are read from there, a few seconds after they arrive. Nothing is sent anywhere and no WhatsApp login is needed. The database is only
// opened (read only) when it changed since the last look, so this costs nothing while nothing happens.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* an old runtime: not available */ }

const FILETIME_TO_MS = 11644473600000; // Windows counts 100 ns steps from 1601
const POLL_MS = 3000;
const unescapeXml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// One toast: ["Sender", "message"] for a chat, ["Group", "Sender: message", ...] for a group.
function parseToast(xml, tag, arrivedAt, rowId) {
  const texts = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) => unescapeXml(m[1]).trim());
  if (!texts.length || !texts[0]) return null;
  const group = /@g\.us$/.test(tag);
  let title = texts[0], from = '', text = texts[1] || '';
  if (group) {
    const m = /^([^:\n]{1,60}): ([\s\S]*)$/.exec(text);
    if (m) { from = m[1]; text = m[2]; }
  }
  // the launch argument holds a key that is unique for the message ("msg:false_<chat>_<id>")
  const launch = /launch="([^"]*)"/.exec(xml);
  let key = '';
  if (launch) { const k = /(?:^|&amp;|&)key=([^&"]+)/.exec(launch[1]); if (k) { try { key = decodeURIComponent(k[1]); } catch { key = k[1]; } } }
  return {
    k: (/^msg:(?:true|false)_.+_([^_]+)$/.exec(key) || [])[1] || (key || 'row_' + rowId).slice(0, 120), // the message id: the same one a WhatsApp connection reports, so a message is never listed twice
    chat: String(tag || title).slice(0, 80),
    title: title.slice(0, 80),
    from: from.slice(0, 60),
    text: text.slice(0, 400),
    at: arrivedAt,
    group,
  };
}

class WaNotifier extends EventEmitter {
  constructor(lastId = 0) {
    super();
    this.file = process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db') : '';
    this.lastId = Number(lastId) || 0;
    this.sig = '';
    this.timer = null;
    this.error = '';
  }

  // Windows only, and only where WhatsApp has ever shown a notification
  available() { return !!DatabaseSync && !!this.file && fs.existsSync(this.file); }

  start() {
    if (this.timer || !this.available()) return false;
    this.first = true; // the first look takes what is there as history, without announcing it
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.timer.unref();
    setTimeout(() => this.poll(), 200).unref();
    return true;
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } this.sig = ''; }

  poll() {
    let db = null;
    try {
      const sig = [this.file, this.file + '-wal'].map((f) => { try { const s = fs.statSync(f); return s.mtimeMs + ':' + s.size; } catch { return '-'; } }).join('|');
      if (sig === this.sig) return;
      db = new DatabaseSync(this.file, { readOnly: true });
      const handlers = db.prepare("select RecordId from NotificationHandler where PrimaryId like '%WhatsApp%'").all().map((r) => Number(r.RecordId));
      if (!handlers.length) { this.sig = sig; return; }
      const rows = db.prepare(`select Id, Tag, Payload, (ArrivalTime / 10000 - ${FILETIME_TO_MS}) as ms from Notification where Type = 'toast' and Id > ? and HandlerId in (${handlers.join(',')}) order by Id limit 200`).all(this.lastId);
      this.sig = sig;
      this.error = '';
      const out = [];
      for (const r of rows) {
        this.lastId = Math.max(this.lastId, Number(r.Id));
        try { const e = parseToast(Buffer.from(r.Payload).toString('utf8'), r.Tag, Number(r.ms) || Date.now(), r.Id); if (e) out.push(e); } catch { /* a toast we cannot read is skipped */ }
      }
      const silent = this.first; this.first = false;
      if (rows.length || silent) this.emit('seen', this.lastId);
      if (out.length) this.emit('messages', out, silent);
    } catch (e) {
      const msg = String(e && e.message).slice(0, 120);
      if (msg !== this.error) { this.error = msg; this.emit('problem', msg); }
    } finally { try { db && db.close(); } catch { /* ignore */ } }
  }
}

module.exports = { WaNotifier, parseToast };
