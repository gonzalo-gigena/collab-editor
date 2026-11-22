import os from 'node:os';
import { Server } from '@hocuspocus/server';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';

export const DOC = 'default'; // ponytail: one hard-coded document until phase 3 adds a documents table
const MB = 1024 * 1024;
const replica = os.hostname();

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, replica, ...extra }));

// Close codes in the 4000–4999 application range. The client sees them in onClose.
export const MALFORMED = { code: 4400, reason: 'malformed update' };
export const TOO_LARGE = { code: 4413, reason: 'document too large' };

// A value nested a few thousand levels decodes, then overflows the stack when the document is
// encoded for the next client to join, which locks everyone out. Editor content is never this deep.
const MAX_DEPTH = 100;
const tooDeep = (value, depth = 0) =>
  typeof value === 'object' && value !== null && !ArrayBuffer.isView(value) &&
  (depth > MAX_DEPTH || Object.values(value).some((child) => tooDeep(child, depth + 1)));

/**
 * Reject a Yjs sync message that doesn't decode or would grow the document past maxDocBytes.
 * `sizes` holds an upper bound of each document's encoded size, so the exact (expensive)
 * merge only runs when that bound crosses the cap.
 */
function check(message, document, maxDocBytes, sizes) {
  let update;
  try {
    const d = decoding.createDecoder(message);
    decoding.readVarString(d); // document name
    const type = decoding.readVarUint(d);
    if (type !== 0 && type !== 4) return; // not Sync / SyncReply: awareness, auth, … Hocuspocus validates those
    const step = decoding.readVarUint(d);
    const payload = decoding.readVarUint8Array(d);
    if (step > 2) throw MALFORMED;
    if (step === 0) return void Y.decodeStateVector(payload); // SyncStep1 carries a state vector
    // SyncStep2 and Update carry a Yjs update.
    for (const { id, origin, rightOrigin, parent, content: c } of Y.decodeUpdate(payload).structs) {
      // An item can only point at its own client's earlier items. One that doesn't decodes, then throws
      // half-way through applyUpdate, where y-protocols swallows the error and acks it.
      const ownFuture = (ref) => ref?.client === id.client && ref.clock >= id.clock;
      if (ownFuture(origin) || ownFuture(rightOrigin) || ownFuture(parent)) throw MALFORMED;
      // These four fields are where an update holds arbitrary values.
      if (c && tooDeep(c.arr ?? c.value ?? c.embed ?? c.opts)) throw MALFORMED;
    }
    update = payload;
  } catch {
    throw MALFORMED;
  }
  let size = (sizes.get(document) ?? Y.encodeStateAsUpdate(document).length) + update.length;
  if (size > maxDocBytes) {
    // Merge, don't add: after a restart every client re-sends the document the others already sent.
    size = Y.mergeUpdates([Y.encodeStateAsUpdate(document), update]).length;
    if (size > maxDocBytes) throw TOO_LARGE;
  }
  sizes.set(document, size);
}

export function createServer({ port = 1234, maxDocBytes = 5 * MB, stopOnSignals = true } = {}) {
  const sizes = new WeakMap();
  const server = new Server({
    port,
    quiet: true,
    stopOnSignals, // Hocuspocus closes every socket and unloads documents on SIGTERM, then exits
    // The first sync message carries the whole document, so allow a little more than the cap.
    // ws closes the socket with 1009 on anything bigger, before it is buffered in full.
    websocketOptions: { maxPayload: maxDocBytes + MB },
    async onConnect({ documentName }) {
      if (documentName !== DOC) throw new Error(`unknown document ${documentName}`);
    },
    async beforeHandleMessage({ update, document, connection, socketId }) {
      try {
        check(update, document, maxDocBytes, sizes);
      } catch (err) {
        log('warn', 'dropping client', { socketId, reason: err.reason });
        connection.webSocket.close(err.code, err.reason); // drop the whole socket, not just this document
        throw err;
      }
    },
  });
  // Node stops handling a socket's errors once it emits 'upgrade'. Without this, a client that
  // hangs up while the upgrade is being rejected crashes the process with EPIPE.
  server.httpServer.prependListener('upgrade', (request, socket) => socket.on('error', () => socket.destroy()));
  return server;
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 1234);
  await createServer({ port }).listen();
  log('info', `listening on :${port}`);
}
