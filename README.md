# Collaborative editor

Several people edit one document in real time, keep editing offline, and everything merges when they reconnect.

The step-by-step build plan is in [PLAN.md](PLAN.md).

> **Status:** phase 1. Everyone who opens the page edits one shared document in real time, on one `sync` replica.
> Nothing is saved yet: the text is gone when the last tab closes or `sync` restarts (persistence is phase 2).
> There is no auth yet either, so don't expose it publicly (phase 3).

## Run it

```bash
git clone --recurse-submodules https://github.com/gonzalo-gigena/collab-editor.git
cd collab-editor
cp .env.example .env
docker compose up --watch
```

Open http://localhost:8080 in two windows and type. Needs only Docker with Compose v2 and about 4 GB of RAM for it. Code changes reload
automatically (Compose Watch). On Windows, clone inside the WSL filesystem, not `/mnt/c`.

Cloned without `--recurse-submodules`? Run `git submodule update --init`.

## Everyday commands

| What | Command |
|---|---|
| Seed demo data | `docker compose run --rm seed` |
| SQL shell | `docker compose exec db psql -U app app` |
| Scale the api | `docker compose up -d --scale api=3` |
| Prove scaling works | `sh common/scripts/smoke.sh 3` |
| Run exactly what CI runs | `sh common/scripts/ci-stack.sh 3` |
| Load test at 1, 2, 4 replicas | `sh common/scripts/scale.sh` |
| Metrics (Prometheus) | `docker compose --profile observability up -d`, then http://localhost:9090 |
| Unit tests | `docker run --rm -v "$PWD/apps/api:/app" -w /app node:26.13-bookworm-slim node --test` |
| Sync tests | `docker run --rm -v "$PWD/apps/sync:/app" -w /app node:26.13.1-bookworm-slim sh -c 'npm ci && npm test'` |
| Sync tests through Caddy (stack running) | `cd apps/sync && npm ci && SYNC_URL=ws://localhost:8080/ws/sync npm test` |
| New migration | add `infra/db/migrations/00000N_name.up.sql` + `.down.sql`, restart |
| Update shared code | `git submodule update --remote common` |
| Reset everything | `docker compose down -v` |

## Architecture

```mermaid
flowchart LR
  browser["Browser<br/>TipTap + Yjs"]
  local[("IndexedDB<br/>offline copy")]
  subgraph stack["docker compose"]
    caddy["Caddy :8080"]
    api["api ×N<br/>auth, documents, sharing"]
    sync["sync<br/>Hocuspocus (Yjs)"]
    redis[("Redis<br/>pub/sub, sessions")]
    db[("Postgres<br/>documents, update log, snapshots")]
  end
  browser -->|"HTTP /api/*"| caddy
  browser -->|"WebSocket /ws/*"| caddy
  browser -.-> local
  caddy --> api
  caddy --> sync
  api --> db
  sync -.->|"batched appends, ~1 s"| db
  sync <-.->|"updates, presence, revocations"| redis
  api -.->|"sessions"| redis
  class local,redis planned
  classDef planned stroke-dasharray: 5 5
```

Solid boxes and arrows run today. Dashed ones are planned in [PLAN.md](PLAN.md).

Edits travel over a WebSocket to `sync`, which merges them and relays them to everyone else in the document. Once phases 2 and 6 are built, Postgres keeps an append-only log of updates plus periodic snapshots, and Redis relays updates between `sync` replicas.

## Stack

- **api:** Node 26 (`node:http` + `pg`), plain JavaScript. Stateless, so it scales with `--scale api=N`.
- **sync:** Node 26 + Hocuspocus 4. One hard-coded document, held in memory, capped at 5 MB encoded.
  One replica only until phase 6: a second one would have its own separate copy of the document.
- **web:** React, Vite and TipTap, built into the Caddy image.
- **Caddy:** the only service with a host port. It load-balances `/api/*` across every
  replica (`import lb api 8080`, from common), sends `/ws/*` to `sync` and serves the built editor.
- **Postgres 18:** migrations run once before the api starts (`golang-migrate`).
- **common/:** git submodule with the shared fakes, scripts, Caddy snippet and Prometheus.
  See [portfolio-common](common/README.md).

## Deploy (one VM)

```bash
docker compose -f compose.yaml -f compose.prod.yaml up -d
```

The server's `.env` needs `SITE_ADDRESS`, `IMAGE_REPO`, `TAG`, a strong password, and no `fakes`
profile. Caddy gets TLS automatically. CI pushes multi-arch images to GHCR on every merge to `main`.

## Decisions & tradeoffs

| Decision | Chosen | Rejected | Why, and what it costs |
|---|---|---|---|
| Merging concurrent edits | Yjs (a CRDT) | Operational transform (ShareDB) | A CRDT merges edits made offline without a server ordering every operation. OT needs that server, so offline editing breaks. Cost: deleted text leaves tombstones, so a document only grows until compacted. |
| Sync server | Hocuspocus | A hand-written `y-websocket` server | Auth hooks, persistence hooks and a Redis extension already exist, so there's less code to get wrong. |
| Storage | Append-only update log, plus a snapshot every ~500 updates (`bytea` in Postgres) | Rewriting the whole document on every save | Appends are cheap and never overwrite an edit. Snapshots keep loads fast. Cost: compaction could delete an update that commits late, so append and compaction take the same advisory lock per document. |
| Write rate | Batch updates for ~1 s per document | One INSERT per keystroke | Postgres writes are the bottleneck. A crash loses at most ~1 s on the server, and clients send it again on reconnect, because Yjs syncs by state vector in both directions. |
| Several sync replicas | Redis pub/sub between replicas, so any replica serves any document | Routing each document to one replica | Plain round-robin works, and a replica can die without a handoff. Cost: one Redis carries all the fan-out. |
| Document size | 5 MB encoded, WebSocket messages 6 MB. Over either, the client is dropped and its editor turns read-only with a notice | Trimming, or silently ignoring the update | Ignoring leaves that client showing text nobody else has. Cost: a document at the cap may even refuse deletes, because those add bytes until merged. |
| Hostile updates | Checked before they are applied: must decode, must not point at their own future items, and nest at most 100 levels | Trusting Yjs to throw | `y-protocols` swallows apply errors and acks them, and a deeply nested value decodes but breaks encoding for everyone who joins later. Cost: each update is decoded twice. |
| `sync` memory | 768 MB heap in a 1 GB container | Node's default, 268 MB in a 512 MB container | 5 MB of tiny edits takes about 350 MB of heap. With the default, one such message crashed the process. |
| Permissions | Enforced in `sync`: updates from viewers are rejected server-side | A read-only editor in the UI | Anyone can send updates from devtools. |
| Load balancing | Caddy `dynamic a` upstreams (the `lb` snippet in `common/`) | `reverse_proxy api:8080`, Traefik | Caddy re-reads Docker DNS every 5 s, so `--scale api=N` needs no config change and no Docker socket mount. A plain `reverse_proxy api:8080` is a single upstream to Caddy and doesn't reliably spread load. |
| Migrations | A one-shot `migrate` service that finishes before the api starts | Each replica migrating on boot | Replicas starting together would race on the same migration. |

Rows for parts that aren't built yet record the plan's choice. Each one gets confirmed or revised when that phase is built.

## Scaling

### Measured

**Edit propagation (phase 1):** the time until a second client sees an edit, with one `sync` replica behind Caddy. Run on an Apple M1 laptop with 8 GB given to Docker, while other projects' containers shared that VM, so treat it as a busy-laptop number.

| How it was measured | Edits | p50 | p95 | max |
|---|---|---|---|---|
| Two Yjs clients in Node, through the published port (middle of 3 runs) | 100 | 2.2 ms | 7.2 ms | 12.9 ms |
| Two browser tabs, scripted inserts, A to B, until it's in B's DOM | 100 | 6.9 ms | 17.4 ms | 37.9 ms |
| Two browser tabs, scripted inserts, B to A | 100 | 7.2 ms | 14.1 ms | 26.6 ms |
| Two browser tabs, key presses, keydown in A until it's in B's DOM | 30 | 9.4 ms | 45.3 ms | 51.3 ms |

All under the 100 ms target. The first row is what the "Sync tests through Caddy" command prints, and CI fails if its p95 reaches 100 ms.

**HTTP (skeleton):** k6 with 20 virtual users for 20 s against `GET /api/hello`, which reads one row from Postgres through Caddy. Run on an Apple M1 laptop with 8 CPUs and 8 GB given to Docker, with the dev override left out:

```bash
COMPOSE_FILE=compose.yaml sh common/scripts/scale.sh
```

| api replicas | req/s | p95 latency | failed |
|---|---|---|---|
| 1 | 15,521 | 2.33 ms | 0.00% |
| 2 | 13,853 | 2.8 ms | 0.00% |
| 4 | 10,708 | 3.85 ms | 0.00% |

4 replicas served 0.7× the requests of 1. At 1 replica the api used about one core, while Caddy, Postgres and k6 together used about four of the laptop's eight (sampled with `docker stats` during the run). The api isn't the bottleneck on one machine, so more replicas only compete for the same CPUs. Replicas pay off when the api is the busiest process, and a hello endpoint doing one query isn't.

### How each part scales

| Part | Scales by | Limit |
|---|---|---|
| `api` | `--scale api=N` (stateless) | Postgres connections. Add PgBouncer past ~2 replicas. |
| `sync` | One replica today. From phase 6, `--scale sync=N` with Redis relaying updates | A WebSocket stays on the replica it first reached. Only new connections spread. |
| Postgres | One primary | Write rate of the update log. Batching and compaction keep it small. |
| Redis | One instance | Pub/sub fan-out across all active documents. |

### Where it breaks next

- **Redis pub/sub, at around 100k active documents.** Next: assign documents to `sync` replicas by consistent hashing, so each update stays on one replica.
- **Postgres write rate.** Widen the batch window first, then split documents across databases.
- **Documents of tiny items.** The cap is on bytes, and 5 MB can be a million items. Applying or joining one blocks `sync` for seconds (7 s to join in testing, and over 7 s with half a million distinct client IDs). Next: cap items and client IDs too, or decode off the main thread.
- **Presence state.** Awareness messages aren't part of the document, so the 5 MB cap doesn't bound them. Next: cap them in phase 5.
- **Very large documents.** The first sync message carries the whole document, so documents are capped (about 5 MB). Past that, lazy-load or split them.

Phase 8 adds the real test: 500 WebSocket clients across 50 documents, one edit per second each, with p50/p95 propagation latency at `sync=1` vs `sync=3`.
