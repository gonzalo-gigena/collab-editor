import * as Y from 'yjs';

// Every query that reads or writes one document's log takes this lock first. seq is handed out
// before commit, so without it a slow append could commit a seq that a compaction had already
// read past, and the compaction would delete it.
const LOCK = 'SELECT pg_advisory_xact_lock(hashtext($1))';

/** Append one (batched) update. Every `compactEvery` rows, merge the log into the snapshot. */
export async function append(pool, docId, update, compactEvery = 500) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(LOCK, [docId]);
    await client.query('INSERT INTO doc_updates (doc_id, update) VALUES ($1, $2)', [docId, update]);
    const { rows: [{ n }] } = await client.query('SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1', [docId]);
    if (n >= compactEvery) await compact(client, docId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Runs inside append's transaction, so it holds the same lock.
async function compact(client, docId) {
  const { rows: log } = await client.query('DELETE FROM doc_updates WHERE doc_id = $1 RETURNING update, seq', [docId]);
  const { rows: snap } = await client.query('SELECT state FROM doc_snapshots WHERE doc_id = $1', [docId]);
  const state = Y.mergeUpdates([...snap.map((r) => r.state), ...log.map((r) => r.update)]);
  const upto = log.reduce((max, r) => (BigInt(r.seq) > max ? BigInt(r.seq) : max), 0n); // pg returns bigint as a string
  await client.query(
    `INSERT INTO doc_snapshots (doc_id, state, upto_seq) VALUES ($1, $2, $3)
     ON CONFLICT (doc_id) DO UPDATE SET state = EXCLUDED.state, upto_seq = EXCLUDED.upto_seq`,
    [docId, state, upto.toString()],
  );
}

/** The latest snapshot plus every update after it, merged into one update (null if none). */
export async function load(pool, docId) {
  // One statement, so it sees one consistent view even if a compaction commits meanwhile.
  // Order doesn't matter: Yjs updates commute.
  const { rows } = await pool.query(
    `SELECT state AS u FROM doc_snapshots WHERE doc_id = $1
     UNION ALL
     SELECT update FROM doc_updates
      WHERE doc_id = $1 AND seq > coalesce((SELECT upto_seq FROM doc_snapshots WHERE doc_id = $1), 0)`,
    [docId],
  );
  return rows.length ? Y.mergeUpdates(rows.map((r) => r.u)) : null;
}
