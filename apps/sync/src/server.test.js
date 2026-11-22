// Runs against an in-process server by default. Point it at the stack to test through Caddy:
//   SYNC_URL=ws://localhost:8080/ws/sync npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { createServer, DOC, MALFORMED, TOO_LARGE } from './server.js';

let url = process.env.SYNC_URL;
let local;
before(async () => {
  if (url) return;
  local = createServer({ port: 0, stopOnSignals: false });
  await local.listen();
  url = `ws://127.0.0.1:${local.address.port}`;
});
after(() => local?.destroy());

const connect = (doc = new Y.Doc()) =>
  new Promise((resolve) => {
    const provider = new HocuspocusProvider({ url, name: DOC, document: doc, onSynced: () => resolve(provider) });
  });

// A raw socket: Auth message, then one Sync message (type 0) of the given step and payload.
function sendRaw(target, step, payload) {
  const msg = (write) => {
    const e = encoding.createEncoder();
    encoding.writeVarString(e, DOC);
    write(e);
    return encoding.toUint8Array(e);
  };
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      ws.send(msg((e) => { encoding.writeVarUint(e, 2); encoding.writeVarUint(e, 0); encoding.writeVarString(e, ''); }));
      ws.send(msg((e) => { encoding.writeVarUint(e, 0); encoding.writeVarUint(e, step); encoding.writeVarUint8Array(e, payload); }));
    };
    ws.onclose = (ev) => {
      clearTimeout(timer);
      resolve(ev.code);
    };
    ws.onerror = () => {}; // a close follows
    const timer = setTimeout(() => { ws.close(); reject(new Error('server did not drop the client')); }, 5000);
  });
}

test('two clients see each other\'s edits', async () => {
  const [a, b] = await Promise.all([connect(), connect()]);
  const samples = [];
  for (let i = 0; i < 100; i++) {
    const marker = `edit-${i}-${Math.random()}`;
    const seen = new Promise((resolve) => {
      const check = () => b.document.getText('t').toString().includes(marker) && (b.document.off('update', check), resolve());
      b.document.on('update', check);
    });
    const started = performance.now();
    a.document.getText('t').insert(0, marker);
    await seen;
    samples.push(performance.now() - started);
  }
  b.document.getText('t').insert(0, 'from-b ');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(a.document.getText('t').toString(), b.document.getText('t').toString());
  samples.sort((x, y) => x - y);
  const at = (q) => samples[Math.ceil(q * samples.length) - 1].toFixed(1);
  console.log(`propagation A→B over ${url}: p50 ${at(0.5)} ms, p95 ${at(0.95)} ms, max ${at(1)} ms (n=${samples.length})`);
  assert.ok(Number(at(0.95)) < 100, `p95 propagation ${at(0.95)} ms`); // not max: one GC pause on a CI runner would fail it
  a.destroy();
  b.destroy();
});

test('a client sending a malformed update is dropped', async () => {
  const garbage = new Uint8Array(10).fill(255);
  assert.equal(await sendRaw(url, 2, garbage), MALFORMED.code); // Update
  assert.equal(await sendRaw(url, 1, garbage), MALFORMED.code); // SyncStep2
  assert.equal(await sendRaw(url, 9, new Uint8Array()), MALFORMED.code); // no such sync step

  // An item whose right origin is its own client's future: it decodes, then throws when applied.
  const unappliable = new Uint8Array([1, 3, 5, 0, 4, 1, 1, 116, 1, 97, 132, 5, 0, 1, 98, 196, 5, 0, 5, 11, 1, 99, 0]);
  assert.equal(await sendRaw(url, 2, unappliable), MALFORMED.code);

  let nested = 0;
  for (let i = 0; i < 1000; i++) nested = [nested];
  const deep = new Y.Doc();
  deep.getMap('m').set('k', nested);
  assert.equal(await sendRaw(url, 2, Y.encodeStateAsUpdate(deep)), MALFORMED.code); // decodes, but too deep
});

test('re-sending content the document already has is not counted twice', async () => {
  const small = createServer({ port: 0, stopOnSignals: false, maxDocBytes: 10_000 });
  await small.listen();
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({ url: `ws://127.0.0.1:${small.address.port}`, name: DOC, document: doc });
  try {
    await new Promise((resolve) => provider.on('synced', resolve));
    doc.getText('t').insert(0, 'x'.repeat(6_000));
    await new Promise((resolve) => setTimeout(resolve, 100));
    let closed = false;
    provider.on('close', () => { closed = true; });
    // 6 KB + 6 KB is over the 10 KB cap, but merged it is still 6 KB.
    const e = encoding.createEncoder();
    encoding.writeVarString(e, DOC);
    encoding.writeVarUint(e, 0);
    encoding.writeVarUint(e, 2);
    encoding.writeVarUint8Array(e, Y.encodeStateAsUpdate(doc));
    provider.configuration.websocketProvider.webSocket.send(encoding.toUint8Array(e));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(closed, false);
    assert.equal(small.hocuspocus.documents.get(DOC).getText('t').length, 6_000);
  } finally {
    provider.destroy();
    await small.destroy();
  }
});

test('a client growing the document past the cap is dropped, and the document keeps its size', async () => {
  const small = createServer({ port: 0, stopOnSignals: false, maxDocBytes: 10_000 });
  await small.listen();
  const target = `ws://127.0.0.1:${small.address.port}`;
  try {
    const big = new Y.Doc();
    big.getText('t').insert(0, 'x'.repeat(20_000));
    assert.equal(await sendRaw(target, 2, Y.encodeStateAsUpdate(big)), TOO_LARGE.code);

    // Bigger than the WebSocket limit (cap + 1 MB): ws drops it before buffering it all.
    big.getText('t').insert(0, 'x'.repeat(1_100_000));
    assert.equal(await sendRaw(target, 2, Y.encodeStateAsUpdate(big)), 1009);

    const doc = small.hocuspocus.documents.get(DOC);
    assert.ok(!doc || Y.encodeStateAsUpdate(doc).length < 10_000);
  } finally {
    await small.destroy();
  }
});

test('a bad upgrade request from a client that hangs up does not crash the server', async () => {
  const server = createServer({ port: 0, stopOnSignals: false });
  await server.listen();
  const { port } = server.address;
  try {
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write('GET http://[ HTTP/1.1\r\nHost: [\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n', () => {
            socket.resetAndDestroy();
            resolve();
          });
        });
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  } finally {
    await server.destroy();
  }
});
