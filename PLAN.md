# 01 — Collaborative editor with offline sync

Several people edit one document in real time, keep editing offline, and see
everything merge when they reconnect. Follows the shared baseline
(`common/docs/baseline.md`).

**What it proves:** realtime systems, CRDTs, WebSockets at scale, sync across replicas.

## Stack

| Service | Tech | Scales? |
|---|---|---|
| `web` | React + Vite, TipTap (ProseMirror) editor, Yjs, `y-indexeddb` | static, served by Caddy |
| `api` | Node 22 + Fastify: auth, document list, sharing | yes, stateless |
| `sync` | Node 22 + Hocuspocus (Yjs WebSocket server) | yes, via Redis |
| `postgres` | Postgres 17: users, documents, Yjs updates (`bytea`) | single primary |
| `redis` | Redis 7: pub/sub between `sync` replicas | single |
| `caddy` | reverse proxy, `/ws/*` → `sync`, `/api/*` → `api` | entry point |

## Steps

### Phase 0 — Scaffold
1. Apply the baseline: compose, Dockerfiles, Caddy, migrate service, CI.
2. Shared TypeScript package `packages/shared` for types used by api, sync and web.
- **Done when:** `docker compose up` serves an empty page at `localhost:8080`.

### Phase 1 — Realtime on one server
1. TipTap editor with the Yjs collaboration extension in `web`.
2. Hocuspocus in `sync` with one hard-coded document.
3. Cap document size (e.g. 5 MB encoded) and set the WebSocket message limit a
   little above it, since the first sync message carries the whole document.
   Drop clients that send malformed updates.
- **Done when:** two browser windows edit the same text and see each
  other's changes in under 100 ms locally.

### Phase 2 — Persistence
1. Table `doc_updates(doc_id, seq bigserial, update bytea, created_at)`. Append
   each Yjs update, batched every ~1 s per document so you don't do one INSERT per keystroke.
2. Table `doc_snapshots(doc_id, state bytea, upto_seq)`. Every N updates (e.g. 500), merge
   the log into one state with `Y.mergeUpdates`, store it as a snapshot, delete older updates.
   Sequence numbers are handed out before commit, so a slow append can commit a
   lower `seq` after compaction has already read past it, and that update gets
   deleted. Take `pg_advisory_xact_lock(hashtext(doc_id))` in both the append and
   the compaction transaction so the two never interleave for one document.
3. On load: latest snapshot + updates after `upto_seq`.
- **Done when:** `docker compose restart sync` loses no text, and a
  document with 10k edits loads in under 300 ms.

### Phase 3 — Auth, documents, sharing
1. Email + password (argon2id) with HTTP-only session cookies in `api`, sessions stored in Redis.
2. Tables `documents`, `document_members(doc_id, user_id, role)` with roles `owner | editor | viewer`.
3. Before the WebSocket upgrade, `sync` calls `api` (or reads the DB)
   to check the session and role. **Viewers have updates rejected server-side**:
   don't rely on the UI being read-only.
4. Share by link with a role, and revoke access. Revoking access or downgrading a
   role disconnects open sockets. Send it through a Redis `revocations` channel
   from the start, because after phase 6 the socket may live on another replica.
- **Done when:** a viewer who edits through devtools never changes the stored document.

### Phase 4 — Offline
1. `y-indexeddb` keeps a local copy. The editor opens from it before the network connects.
2. Connection status indicator (online / syncing / offline).
- **Done when:** go offline in devtools in two windows, edit both,
  reconnect, and both edits are present in both windows. Cover this with a Playwright test.

### Phase 5 — Presence
1. Yjs awareness: cursor, selection, name, color per user.
2. "Who's here" avatars. Awareness goes stale after 30 s with no heartbeat.
- **Done when:** cursors appear and disappear correctly as tabs open and close.

### Phase 6 — Horizontal scale
1. Add the Hocuspocus Redis extension so updates and awareness on one `sync`
   replica are published to the others.
2. `docker compose up --scale sync=3`. Caddy round-robins new WebSocket connections across replicas.
3. Only one replica should write a given document to Postgres. Options: a Redis lock per document
   (`SET doc:{id}:writer <replica> NX PX 10000`, renewed) or make writes idempotent.
   Check first whether the Hocuspocus Redis extension already handles this, and
   don't build a second lock if it does. Document the choice.
4. Graceful shutdown: on SIGTERM, flush pending updates, close sockets with a
   "reconnect" code. Clients reconnect to another replica.
- **Done when:** a test running inside the compose network
  (`docker compose run --rm test`) connects client A to `<project>-sync-1` and
  client B to `<project>-sync-2` by container name, and they converge. `docker compose
  stop sync` on one replica mid-edit loses nothing.

### Phase 7 — Version history
1. A named snapshot each time a user clicks "save version", plus automatic snapshots hourly.
2. Read-only preview of a version, and "restore". Re-applying an old Yjs state
   does nothing, because the document already contains it. Instead, restore
   loads the version into a temporary `Y.Doc` and, inside one `transact`,
   replaces the live document's content with it. That produces a new update,
   which online collaborators receive like any other edit.
- **Done when:** you can restore a version while two people are online with no conflicts.

### Phase 8 — Tests and load
1. Unit: persistence/compaction round-trip (`encode → store → load → equal`).
2. Playwright: two browser contexts editing at once, the offline merge, and viewer enforcement.
3. Load: a k6 WebSocket script (or a Node script using `yjs` clients)
   with 500 clients across 50 documents, each sending an edit per second. Record
   p50/p95 propagation latency at `sync=1` vs `sync=3`.
- **Headline test:** a fuzz test where 5 simulated clients make random edits, random
  disconnects and random replica targets. All final documents must have identical
  content. Compare the editor's JSON (`getXmlFragment().toJSON()`), not encoded
  bytes, which can differ for the same content.

### Phase 9 — Ship
1. Deploy per the baseline, and record a GIF of two cursors plus the offline merge.
2. README tradeoffs: CRDT vs OT, why Hocuspocus, snapshot frequency, what
   happens at 100k documents (Redis pub/sub becomes the bottleneck; the next step
   is sharding documents to replicas by consistent hashing).

## Scaling notes
- The bottlenecks are Redis pub/sub fan-out and Postgres write rate. Batching
  updates (phase 2) and compaction keep Postgres small.
- Very large documents: cap document size, and lazy-load or split huge documents.
