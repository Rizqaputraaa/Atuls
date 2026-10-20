// Finds other computers running A-tuls on the same network: every instance announces itself with a tiny UDP broadcast
// (every 2.5 s) and listens for the others. Nothing is sent beyond the local network and nothing sensitive is announced
// (a random id, the computer name, the platform and the TCP port) - pairing still needs the 6-digit code.
const dgram = require('dgram');
const os = require('os');
const EventEmitter = require('events');

const PORT = Number(process.env.ISLAND_DISCOVERY_PORT) || 47801;
const EVERY = 4000, EXPIRE = 13000;

class Discovery extends EventEmitter {
  constructor(getInfo) {
    super();
    this.getInfo = getInfo;
    this.peers = new Map();
    this.sock = null; this.timer = null; this.prune = null; this.failures = 0;
  }

  start() {
    try {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.sock = s;
      s.on('error', (e) => { this.emit('error', e.message); });
      s.on('message', (buf, rinfo) => this.onPacket(buf, rinfo));
      s.bind(PORT, () => {
        try { s.setBroadcast(true); } catch {}
        this.announce();
        this.timer = setInterval(() => this.announce(), EVERY);
        this.prune = setInterval(() => this.expire(), 2000);
        for (const t of [this.timer, this.prune]) if (t.unref) t.unref();
      });
    } catch (e) { this.emit('error', e.message); }
  }

  stop() {
    clearInterval(this.timer); clearInterval(this.prune); this.timer = this.prune = null;
    const s = this.sock; this.sock = null;
    if (s) { try { s.removeAllListeners('message'); s.close(); } catch {} }
  }

  // Only the directed broadcast of each private network this computer is on (not 255.255.255.255, which goes out of every adapter,
  // including ones that are flapping or half asleep).
  targets() {
    const out = new Set();
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list || []) {
        if (i.family !== 'IPv4' || i.internal || !i.netmask) continue;
        if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) continue; // private networks only
        const a = i.address.split('.').map(Number), m = i.netmask.split('.').map(Number);
        out.add(a.map((x, k) => (x & m[k]) | (~m[k] & 255)).join('.'));
      }
    }
    return [...out];
  }

  announce() {
    if (!this.sock) return;
    const info = this.getInfo();
    const buf = Buffer.from(JSON.stringify({ app: 'island-link', v: 1, id: info.id, name: info.name, plat: info.plat, port: info.port }));
    for (const host of this.targets()) {
      try { this.sock.send(buf, PORT, host, (err) => { if (err) { if (++this.failures >= 5) { this.emit('error', 'sending failed 5 times in a row; discovery paused: ' + err.message); this.stop(); } } else this.failures = 0; }); } catch { this.failures++; }
    }
  }

  onPacket(buf, rinfo) {
    let m;
    try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (!m || m.app !== 'island-link' || !m.id || m.id === this.getInfo().id) return;
    const known = this.peers.has(m.id);
    this.peers.set(m.id, { id: String(m.id), name: String(m.name || 'Computer').slice(0, 60), plat: m.plat === 'darwin' ? 'darwin' : 'win32', host: rinfo.address, port: Number(m.port) || 47800, seen: Date.now() });
    if (!known) this.emit('change');
  }

  expire() {
    let changed = false;
    for (const [id, p] of this.peers) if (Date.now() - p.seen > EXPIRE) { this.peers.delete(id); changed = true; }
    if (changed) this.emit('change');
  }

  list() { return [...this.peers.values()].map(({ id, name, plat, host, port }) => ({ id, name, plat, host, port })); }
}

module.exports = { Discovery };
