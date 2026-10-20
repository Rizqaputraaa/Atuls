const test = require('node:test');
const assert = require('node:assert');
const { WebSocketServer, WebSocket } = require('ws');
const S = require('../src/secure');

// a server that wraps every connection and a client that wraps its socket
function pair() {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    let raw;
    const server = new Promise((res) => wss.on('connection', (ws) => { raw = ws; res(new S.SecureChannel(ws, 'server')); }));
    wss.on('listening', async () => {
      const rawClient = new WebSocket(`ws://127.0.0.1:${wss.address().port}`);
      const client = new S.SecureChannel(rawClient, 'client');
      const srv = await server;
      await Promise.all([new Promise((r) => client.on('ready', r)), new Promise((r) => srv.on('ready', r))]);
      resolve({ wss, client, srv, rawClient, raw: () => raw, close: () => { rawClient.terminate(); wss.close(); } });
    });
  });
}
const next = (ch) => new Promise((r) => ch.once('message', (m, b) => r([m, b])));

test('both sides derive the same session and text/binary round-trip in both directions', async () => {
  const p = await pair();
  assert.ok(p.client.binding.equals(p.srv.binding));
  let got = next(p.srv);
  p.client.send(JSON.stringify({ t: 'hi', n: 1 }));
  assert.deepStrictEqual(await got, ['{"t":"hi","n":1}', false]);
  got = next(p.client);
  p.srv.send(Buffer.from([1, 2, 3, 255]), { binary: true });
  const [bin, isBin] = await got;
  assert.strictEqual(isBin, true);
  assert.deepStrictEqual([...bin], [1, 2, 3, 255]);
  p.close();
});

test('nothing readable crosses the wire', async () => {
  const p = await pair();
  const seen = [];
  const orig = p.rawClient.send.bind(p.rawClient);
  p.rawClient.send = (d, o) => { seen.push(Buffer.from(d)); return orig(d, o); };
  const got = next(p.srv);
  p.client.send('SECRET-PAIRING-CODE-123456');
  await got;
  assert.ok(seen.length && seen.every((b) => !b.includes('SECRET')));
  p.close();
});

test('a changed byte, a replayed frame and a plain frame are all refused', async () => {
  const p = await pair();
  const frames = [];
  const orig = p.rawClient.send.bind(p.rawClient);
  p.rawClient.send = (d, o) => { frames.push(Buffer.from(d)); return orig(d, o); };
  const first = next(p.srv);
  p.client.send('one');
  await first;
  // replay of the same frame
  const errs = [];
  p.srv.on('error', (e) => errs.push(e.message));
  orig(frames[0], { binary: true });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(errs.some((m) => /out of order/.test(m)), errs.join());
  p.close();

  const q = await pair();
  const e2 = [];
  q.srv.on('error', (e) => e2.push(e.message));
  const sent = [];
  const o2 = q.rawClient.send.bind(q.rawClient);
  q.rawClient.send = (d, o) => { const b = Buffer.from(d); b[b.length - 20] ^= 1; sent.push(b); return o2(b, o); }; // flip a bit in the ciphertext
  q.client.send('tamper me');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(e2.some((m) => /authentication/.test(m)), e2.join());
  q.close();

  const r = await pair();
  const e3 = [];
  r.srv.on('error', (e) => e3.push(e.message));
  r.rawClient.send('{"t":"hello"}');
  await new Promise((res) => setTimeout(res, 100));
  assert.ok(e3.some((m) => /plain frame/.test(m)), e3.join());
  r.close();
});

test('proofs only verify for the same secret and the same session', async () => {
  const p = await pair();
  const proof = S.proof('123456', 'hello', p.client.binding);
  assert.ok(S.check('123456', 'hello', p.srv.binding, proof));
  assert.ok(!S.check('654321', 'hello', p.srv.binding, proof));
  assert.ok(!S.check('123456', 'ok', p.srv.binding, proof));
  assert.ok(!S.check('123456', 'hello', Buffer.alloc(32), proof));
  assert.ok(!S.check('123456', 'hello', p.srv.binding, undefined));
  p.close();
});

test('an old client that sends a plain hello is refused', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const refused = new Promise((res) => wss.on('connection', (ws) => { const c = new S.SecureChannel(ws, 'server'); c.on('error', (e) => res(e.message)); }));
  await new Promise((r) => wss.on('listening', r));
  const ws = new WebSocket(`ws://127.0.0.1:${wss.address().port}`);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', pin: '123456' })));
  ws.on('error', () => {});
  assert.match(await refused, /bad key exchange/);
  ws.terminate(); wss.close();
});
