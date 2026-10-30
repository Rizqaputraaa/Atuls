// WhatsApp, linked like WhatsApp Web / Desktop: the person scans a QR code once (WhatsApp > Settings > Linked devices) and A-tuls then receives the
// messages itself. That gives what the notifications cannot: who is tagged in a group, no setup of names or numbers, and answering from the island.
//
// This uses WhatsApp's own linked-device protocol through the Baileys library, which is not an official product of WhatsApp. A-tuls only listens
// and sends what the person types: it never marks messages as read, never shows "online" and sends nothing by itself.
// The login is kept in one file in the data folder, sealed with the system's own protection (see seal / unseal in main.js).
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const SILENT = { level: 'silent', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return SILENT; } };
const digitsOf = (jid) => String(jid || '').split('@')[0].split(':')[0];

class WaConnect extends EventEmitter {
  constructor({ dir, seal, unseal }) {
    super();
    this.file = path.join(dir, 'wa-session.bin');
    this.seal = seal; this.unseal = unseal;
    this.state = 'off'; // off | connecting | qr | open
    this.qr = ''; this.name = '';
    this.sock = null; this.B = null; this.wanted = false; this.retry = 0; this.timer = null; this.qrTimer = null; this.saveTimer = null;
    this.groups = new Map(); // group jid -> its name
    this.contacts = new Map(); // jid -> the name the person gave this contact in the phone (what WhatsApp itself shows)
    this.me = new Set(); // the normalised ids this account is known by (phone number id and "lid")
    this.data = null;
  }

  hasSession() { try { return fs.existsSync(this.file); } catch { return false; } }
  set(state) { if (this.state === state) return; this.state = state; this.emit('state'); }
  info() { return { state: this.state, name: this.name, qr: this.state === 'qr' ? this.qr : '' }; }

  async lib() {
    if (!this.B) this.B = await import('@whiskeysockets/baileys');
    return this.B;
  }

  // the login lives in memory and is written (sealed) a moment after every change
  async loadAuth(B) {
    let data = null;
    try { data = JSON.parse(this.unseal(fs.readFileSync(this.file)), B.BufferJSON.reviver); } catch { /* no login yet */ }
    // the server closes the connection right after the QR was scanned and the new one must find the login that was just made: it is kept in memory
    // between connections, and a change of the login itself is written at once (the many small key changes a moment later)
    const d = this.data = this.data || { creds: (data && data.creds) || B.initAuthCreds(), keys: (data && data.keys) || {} };
    const write = () => { try { fs.writeFileSync(this.file, this.seal(JSON.stringify(d, B.BufferJSON.replacer))); } catch (e) { this.emit('problem', 'the WhatsApp login could not be saved: ' + e.message); } };
    const save = (now) => {
      clearTimeout(this.saveTimer);
      if (now === true) write(); else this.saveTimer = setTimeout(write, 1500);
    };
    d.contacts = d.contacts || {};
    for (const k of Object.keys(d.contacts)) this.contacts.set(k, d.contacts[k]);
    this.persist = () => save();
    const keys = {
      get: (type, ids) => {
        const out = {};
        for (const id of ids) {
          let v = d.keys[type] && d.keys[type][id];
          if (type === 'app-state-sync-key' && v) v = B.proto.Message.AppStateSyncKeyData.fromObject(v);
          out[id] = v;
        }
        return out;
      },
      set: (upd) => {
        for (const type of Object.keys(upd)) {
          d.keys[type] = d.keys[type] || {};
          for (const id of Object.keys(upd[type])) { const v = upd[type][id]; if (v) d.keys[type][id] = v; else delete d.keys[type][id]; }
        }
        save();
      },
    };
    return { state: { creds: d.creds, keys }, save };
  }

  async start() {
    if (this.sock || this.starting) return;
    this.wanted = true; this.starting = true;
    clearTimeout(this.timer);
    try {
      this.set('connecting');
      const B = await this.lib();
      const { state, save } = await this.loadAuth(B);
      let version; try { ({ version } = await B.fetchLatestBaileysVersion()); } catch { /* the library's own version is used */ }
      const sock = (B.default || B.makeWASocket)({
        auth: state, version, logger: SILENT, browser: B.Browsers.appropriate('A-tuls'),
        markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false, generateHighQualityLinkPreview: false,
      });
      this.sock = sock;
      sock.ev.on('creds.update', (u) => { if (u) Object.assign(state.creds, u); save(true); }); // (the library hands over only what changed)
      sock.ev.on('connection.update', (u) => this.onUpdate(sock, u).catch(() => {}));
      sock.ev.on('messages.upsert', (m) => this.onMessages(sock, m).catch(() => {}));
      sock.ev.on('contacts.upsert', (l) => (l || []).forEach((c) => this.learn(c)));
      sock.ev.on('contacts.update', (l) => (l || []).forEach((c) => this.learn(c)));
      sock.ev.on('chats.upsert', (l) => (l || []).forEach((c) => { if (!c || !c.id) return; if (c.id.endsWith('@g.us')) { if (c.name) this.groups.set(c.id, c.name); } else this.learn({ id: c.id, name: c.name }); }));
    } catch (e) {
      this.emit('problem', 'WhatsApp could not start: ' + e.message);
      this.sock = null; this.set('off');
    } finally { this.starting = false; }
  }

  async onUpdate(sock, u) {
    if (sock !== this.sock) return;
    const B = this.B;
    if (u.qr) {
      this.qr = await require('qrcode').toDataURL(u.qr, { margin: 1, width: 240, color: { dark: '#000000', light: '#ffffff' } });
      this.set('qr'); this.emit('state');
      if (!this.qrTimer) this.qrTimer = setTimeout(() => { if (this.state === 'qr') this.stop(false); }, 150000); // nobody scanned it: stop asking
    }
    if (u.connection === 'open') {
      clearTimeout(this.qrTimer); this.qrTimer = null; this.retry = 0; this.qr = '';
      const me = sock.user || {};
      this.name = me.name || '';
      this.me = new Set([me.id, me.lid].filter(Boolean).map((j) => B.jidNormalizedUser(j)));
      this.set('open'); this.emit('state');
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
      this.emit('problem', 'connection closed, code ' + code + (u.lastDisconnect && u.lastDisconnect.error ? ' (' + String(u.lastDisconnect.error.message).slice(0, 60) + ')' : ''));
      this.sock = null;
      if (code === B.DisconnectReason.loggedOut) { this.wipe(); this.wanted = false; this.set('off'); return; } // unlinked from the phone
      if (!this.wanted) { this.set('off'); return; }
      // right after the QR was scanned the server asks for a fresh connection (515); anything else is a dropped line: try again, slowly
      const wait = code === B.DisconnectReason.restartRequired ? 300 : Math.min(60000, 3000 * 2 ** Math.min(this.retry++, 4));
      this.set('connecting');
      this.timer = setTimeout(() => { this.starting = false; this.start(); }, wait);
    }
  }

  wipe() { try { fs.unlinkSync(this.file); } catch { /* none */ } this.data = null; this.name = ''; this.qr = ''; this.groups.clear(); }

  // stop listening; with forget the login is removed too (the phone still lists the linked device until it is unlinked there, see logout)
  async stop(forget) {
    this.wanted = false; clearTimeout(this.timer); clearTimeout(this.qrTimer); this.qrTimer = null;
    const s = this.sock; this.sock = null;
    try { if (s) s.end(undefined); } catch { /* already closed */ }
    if (forget) this.wipe();
    this.set('off');
  }

  // unlink this computer from the phone (WhatsApp > Linked devices) and forget the login
  async logout() {
    const s = this.sock;
    try { if (s && this.state === 'open') await s.logout(); } catch { /* the connection was gone already */ }
    await this.stop(true);
  }

  async groupName(sock, jid) {
    if (this.groups.has(jid)) return this.groups.get(jid);
    let name = '';
    try { name = (await Promise.race([sock.groupMetadata(jid), new Promise((_r, rej) => setTimeout(() => rej(new Error('slow')), 4000))])).subject || ''; } catch { /* the name stays empty this time */ }
    if (name) this.groups.set(jid, name);
    return name;
  }

  // the readable part of a message: its text, or a label for what it carries
  static textOf(c) {
    if (!c) return '';
    if (c.conversation) return c.conversation;
    if (c.extendedTextMessage) return c.extendedTextMessage.text || '';
    if (c.imageMessage) return c.imageMessage.caption || '\u{1F4F7} Photo';
    if (c.videoMessage) return c.videoMessage.caption || '\u{1F3A5} Video';
    if (c.audioMessage) return c.audioMessage.ptt ? '\u{1F3A4} Voice message' : '\u{1F3B5} Audio';
    if (c.documentMessage) return c.documentMessage.caption || '\u{1F4C4} ' + (c.documentMessage.fileName || 'Document');
    if (c.stickerMessage) return 'Sticker';
    if (c.contactMessage) return '\u{1F464} Contact';
    if (c.locationMessage || c.liveLocationMessage) return '\u{1F4CD} Location';
    if (c.pollCreationMessage || c.pollCreationMessageV3) return '\u{1F4CA} ' + ((c.pollCreationMessage || c.pollCreationMessageV3).name || 'Poll');
    return '';
  }

  // the saved name of a contact: from the contact list, from chats, and from the title WhatsApp Desktop showed on a notification of the chat
  learn(c) {
    if (!c) return;
    const name = String(c.name || c.verifiedName || '').trim();
    if (!name || /^[+\d\s-]{6,}$/.test(name)) return; // a bare number is not a name
    let changed = false;
    for (const k of [c.id, c.lid, c.phoneNumber, c.jid]) {
      if (!k) continue;
      const key = this.norm(k);
      if (this.contacts.get(key) !== name) { this.contacts.set(key, name); if (this.data) this.data.contacts[key] = name; changed = true; }
    }
    if (changed && this.persist) this.persist();
  }
  norm(j) { return this.B ? this.B.jidNormalizedUser(j) : String(j).replace(/:\d+@/, '@'); }
  nameFor(...jids) { for (const j of jids) { if (!j) continue; const n = this.contacts.get(this.norm(j)); if (n) return n; } return ''; }
  learnTitle(chat, title, group) { if (!chat || !title) return; if (group) this.groups.set(chat, title); else this.learn({ id: chat, name: title }); }

  async onMessages(sock, { messages, type }) {
    if (sock !== this.sock || (type !== 'notify' && type !== 'append')) return;
    const B = this.B, out = [];
    for (const m of messages || []) {
      try {
        const jid = m.key && m.key.remoteJid;
        if (!m.message || !jid || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) continue;
        if (m.key.fromMe) { if (type === 'notify') this.emit('replied', jid); continue; } // answered on the phone or in WhatsApp Desktop: the chat needs no more attention
        if (type !== 'notify') continue;
        const c = B.normalizeMessageContent(m.message);
        const text = WaConnect.textOf(c).trim();
        if (!text) continue; // reactions, protocol messages, edits...
        const group = jid.endsWith('@g.us');
        const holder = Object.values(c).find((v) => v && typeof v === 'object' && v.contextInfo);
        const ctx = (holder && holder.contextInfo) || {};
        let tagged = false;
        if (group) {
          const norm = (j) => B.jidNormalizedUser(j);
          tagged = (ctx.mentionedJid || []).some((j) => this.me.has(norm(j))) || (!!ctx.participant && this.me.has(norm(ctx.participant))); // tagged, or an answer to a message of this account
          if (!tagged) continue; // in a group only what is meant for this person
        }
        const senderJid = group ? (m.key.participant || m.participant) : jid;
        const sender = this.nameFor(senderJid, group ? m.key.participantAlt : m.key.remoteJidAlt) || m.pushName || digitsOf(senderJid); // the saved name first, the name the sender chose itself after it
        const title = group ? (await this.groupName(sock, jid)) || 'Group' : sender || 'WhatsApp';
        out.push({ k: m.key.id, chat: jid, title, from: group ? sender : '', text: text.slice(0, 400), at: (Number(m.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000, group, tagged, q: { id: m.key.id, participant: m.key.participant || '' } });
      } catch { /* a message we cannot read is skipped */ }
    }
    if (out.length) this.emit('messages', out);
  }

  // the address of the profile picture of a chat or group (nothing when it is hidden or there is none)
  async picture(jid) {
    if (!this.sock || this.state !== 'open') return null;
    try { return (await Promise.race([this.sock.profilePictureUrl(jid, 'preview'), new Promise((_r, rej) => setTimeout(() => rej(new Error('slow')), 5000))])) || null; } catch { return null; }
  }

  // an answer typed on the island; quoted = the message it answers (groups)
  async send(jid, text, q) {
    if (!this.sock || this.state !== 'open') throw new Error('WhatsApp is not connected');
    const clean = String(text || '').trim().slice(0, 2000);
    if (!clean) throw new Error('Nothing to send');
    const opts = q && q.id && jid.endsWith('@g.us') ? { quoted: { key: { remoteJid: jid, id: String(q.id), participant: q.participant || undefined, fromMe: false }, message: { conversation: String(q.preview || '').slice(0, 200) } } } : undefined;
    const r = await this.sock.sendMessage(jid, { text: clean }, opts);
    return { id: r && r.key && r.key.id };
  }
}

module.exports = { WaConnect };
