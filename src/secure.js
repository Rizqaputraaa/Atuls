// Encrypted channel on top of a WebSocket. Everything the two computers exchange (pointer, keys, clipboard, files, pairing codes and
// tokens) goes through it, so nothing readable crosses the network.
//
//  1. Each side makes a fresh X25519 key pair and sends the public half in one plain "kx" frame.
//  2. Both compute the shared secret and derive two AES-256-GCM keys with HKDF-SHA256 (one per direction). The salt is the hash of both
//     public keys, which is also exposed as `binding` (it identifies exactly this session).
//  3. Every later frame is  [8-byte counter][ciphertext][16-byte tag]  with the counter as GCM nonce. The receiver demands the next counter
//     in order, so a recorded frame cannot be replayed, dropped or reordered, and a changed byte fails the tag.
//  4. Who is on the other end is proven by an HMAC over `binding`, keyed with the pairing code or the saved token (see proof/check). A
//     machine in the middle runs two separate sessions with two different bindings, so a proof cannot be passed along.
//
// Known limit: a 6-digit pairing code can be guessed offline by someone who actively sits in the middle during the FIRST pairing. After
// pairing the token (128 bits) is used instead. The server also locks the code after repeated wrong attempts (see link.js).
const crypto = require('crypto');
const { EventEmitter } = require('events');

const VERSION = 1;
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex'); // DER header of an X25519 public key
const OPEN = 1; // ws readyState

const rawPublic = (key) => key.export({ type: 'spki', format: 'der' }).subarray(SPKI_PREFIX.length);
const publicFromRaw = (raw) => crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });

function proof(secret, label, binding) {
  return crypto.createHmac('sha256', String(secret)).update(label).update(binding).digest('hex');
}
function check(secret, label, binding, given) {
  if (typeof given !== 'string' || !secret) return false;
  const a = Buffer.from(proof(secret, label, binding), 'hex'), b = Buffer.from(given, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class SecureChannel extends EventEmitter {
  // role: 'client' (we opened the connection) or 'server' (we accepted it)
  constructor(ws, role) {
    super();
    this.ws = ws;
    this.role = role;
    this.ready = false;
    this.binding = null;
    this.txSeq = 0n;
    this.rxSeq = 0n;
    this.keys = null;
    const kp = crypto.generateKeyPairSync('x25519');
    this.priv = kp.privateKey;
    this.pub = rawPublic(kp.publicKey);
    ws.on('message', (raw, isBinary) => this.onFrame(raw, isBinary));
    ws.on('close', () => this.emit('close'));
    ws.on('error', (e) => this.emit('error', e));
    if (role === 'client') {
      if (ws.readyState === OPEN) this.sendKx(); else ws.on('open', () => this.sendKx());
    }
  }

  get readyState() { return this.ws.readyState; }
  get bufferedAmount() { return this.ws.bufferedAmount; }
  get remoteAddress() { return String((this.ws._socket && this.ws._socket.remoteAddress) || '').replace(/^::ffff:/, ''); }
  close() { try { this.ws.close(); } catch {} }
  terminate() { try { this.ws.terminate(); } catch {} }

  sendKx() { this.ws.send(JSON.stringify({ t: 'kx', v: VERSION, epk: this.pub.toString('base64') })); }

  fail(why) { this.emit('error', new Error(why)); this.terminate(); }

  derive(peerPub) {
    const client = this.role === 'client' ? this.pub : peerPub, server = this.role === 'client' ? peerPub : this.pub;
    const secret = crypto.diffieHellman({ privateKey: this.priv, publicKey: publicFromRaw(peerPub) });
    this.binding = crypto.createHash('sha256').update(client).update(server).digest();
    const key = (info) => Buffer.from(crypto.hkdfSync('sha256', secret, this.binding, info, 32));
    const c2s = key('islandlink v1 client-to-server'), s2c = key('islandlink v1 server-to-client');
    this.keys = this.role === 'client' ? { tx: c2s, rx: s2c } : { tx: s2c, rx: c2s };
    this.priv = null;
    this.ready = true;
  }

  onFrame(raw, isBinary) {
    if (!this.ready) {
      let m;
      try { m = JSON.parse(String(raw)); } catch { return this.fail('bad key exchange'); }
      if (isBinary || !m || m.t !== 'kx' || m.v !== VERSION || typeof m.epk !== 'string') return this.fail('bad key exchange (the other computer may run an older version)');
      const peer = Buffer.from(m.epk, 'base64');
      if (peer.length !== 32) return this.fail('bad key exchange');
      try {
        if (this.role === 'server') this.sendKx();
        this.derive(peer);
      } catch (e) { return this.fail('key exchange failed: ' + e.message); }
      this.emit('ready');
      return;
    }
    if (!isBinary) return this.fail('plain frame on an encrypted link');
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.concat([].concat(raw));
    if (buf.length < 8 + 1 + 16) return this.fail('short frame');
    const seq = buf.readBigUInt64BE(0);
    if (seq !== this.rxSeq) return this.fail('frame out of order (replay?)');
    let plain;
    try {
      const nonce = Buffer.alloc(12); nonce.writeBigUInt64BE(seq, 4);
      const d = crypto.createDecipheriv('aes-256-gcm', this.keys.rx, nonce, { authTagLength: 16 });
      d.setAuthTag(buf.subarray(buf.length - 16));
      plain = Buffer.concat([d.update(buf.subarray(8, buf.length - 16)), d.final()]);
    } catch { return this.fail('frame failed authentication'); }
    this.rxSeq++;
    if (plain[0] === 1) this.emit('message', plain.subarray(1), true);
    else this.emit('message', plain.subarray(1).toString('utf8'), false);
  }

  // same shape as ws.send: text by default, { binary: true } for raw bytes
  send(data, opts) {
    if (!this.ready || this.ws.readyState !== OPEN) return;
    const nonce = Buffer.alloc(12); nonce.writeBigUInt64BE(this.txSeq, 4);
    const c = crypto.createCipheriv('aes-256-gcm', this.keys.tx, nonce, { authTagLength: 16 });
    const body = Buffer.concat([c.update(Buffer.concat([Buffer.from([opts && opts.binary ? 1 : 0]), Buffer.from(data)])), c.final()]);
    const head = Buffer.alloc(8); head.writeBigUInt64BE(this.txSeq, 0);
    this.txSeq++;
    this.ws.send(Buffer.concat([head, body, c.getAuthTag()]), { binary: true });
  }
}

// Six numbers both people compare on first pairing. They come from the session binding, so a machine in the middle (two sessions) shows each
// side a different number.
function sas(binding) {
  const h = crypto.createHash('sha256').update('islandlink sas v1').update(binding).digest();
  return String(h.readUInt32BE(0) % 1000000).padStart(6, '0');
}

module.exports = { SecureChannel, proof, check, sas, VERSION };
