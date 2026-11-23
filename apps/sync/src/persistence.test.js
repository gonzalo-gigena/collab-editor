// Needs Postgres with the migrations applied: docker compose run --rm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { createServer } from './server.js';
import { append, load } from './persistence.js';

const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl && 'DATABASE_URL not set';
const pool = databaseUrl && new pg.Pool({ connectionString: databaseUrl });
const name = () => `test-${Math.random().toString(36).slice(2)}`;
after(async () => {
  if (!pool) return;
  await pool.query("DELETE FROM doc_updates WHERE doc_id LIKE 'test-%'");
  await pool.query("DELETE FROM doc_snapshots WHERE doc_id LIKE 'test-%'");
  await pool.end();
});

async function start(doc) {
  const server = createServer({ port: 0, stopOnSignals: false, databaseUrl, doc });
  await server.listen();
  return server;
}

const connect = (server, doc) =>
  new Promise((resolve) => {
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${server.address.port}`, name: doc, document: new Y.Doc(), onSynced: () => resolve(provider),
    });
  });

const acked = (provider) =>
  new Promise((resolve) => {
    const check = () => !provider.hasUnsyncedChanges && (provider.off('unsyncedChanges', check), resolve());
    provider.on('unsyncedChanges', check);
    check();
  });

test('a restart mid-batch loses no text', { skip }, async () => {
  const doc = name();
  const first = await start(doc);
  const writer = await connect(first, doc);
  writer.document.getText('t').insert(0, 'typed just before the restart');
  await acked(writer); // the server has it in memory; the 1 s batch hasn't been written yet
  await first.destroy(); // what SIGTERM does: close sockets, flush pending stores
  writer.destroy();

  const second = await start(doc);
  const reader = await connect(second, doc); // a fresh Y.Doc: everything it gets came from Postgres
  try {
    assert.equal(reader.document.getText('t').toString(), 'typed just before the restart');
  } finally {
    reader.destroy();
    await second.destroy();
  }
});

test('appends racing a compaction are never deleted', { skip }, async () => {
  const doc = name();
  const updates = [];
  const source = new Y.Doc();
  source.on('update', (u) => updates.push(u));
  for (let i = 0; i < 200; i++) source.getText('t').insert(0, String(i % 10));
  // All at once on 10 connections, compacting every 7 rows, so appends and compactions overlap.
  const racing = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  try {
    await Promise.all(updates.map((u) => append(racing, doc, u, 7)));
  } finally {
    await racing.end();
  }
  const loaded = new Y.Doc();
  Y.applyUpdate(loaded, await load(pool, doc));
  assert.equal(loaded.getText('t').toString(), source.getText('t').toString());
});

test('a document with 10k edits loads in under 300 ms', { skip }, async () => {
  const doc = name();
  const source = new Y.Doc();
  const edits = [];
  source.on('update', (u) => edits.push(u));
  const text = source.getText('t');
  for (let i = 0; i < 10_000; i++) {
    // Mostly typing, some deletes, at random places, one edit per transaction like keystrokes.
    if (i % 10 === 9 && text.length) text.delete(Math.floor(Math.random() * text.length), 1);
    else text.insert(Math.floor(Math.random() * (text.length + 1)), 'abcdefghij'[i % 10]);
  }
  // ~10 keystrokes per ~1 s batch: 999 rows, so one compaction at 500 and a 499-row tail, the worst case.
  for (let i = 0; i < 999; i++) {
    await append(pool, doc, Y.mergeUpdates(edits.slice(i * 10, i === 998 ? undefined : i * 10 + 10)));
  }
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1', [doc]);
  assert.equal(n, 499);

  const server = await start(doc);
  try {
    const started = performance.now();
    const reader = await connect(server, doc); // load from Postgres, apply, first sync to the client
    const ms = performance.now() - started;
    reader.destroy();
    assert.equal(reader.document.getText('t').toString(), text.toString());
    console.log(`10k edits (snapshot + 499 updates, ${text.length} chars): loaded and synced in ${ms.toFixed(1)} ms`);
    assert.ok(ms < 300, `load took ${ms.toFixed(1)} ms`);
  } finally {
    await server.destroy();
  }
});
