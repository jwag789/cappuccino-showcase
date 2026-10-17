# Excerpts

These files are copied verbatim from the production codebase and are here to
be **read**, not run. They import modules (`./db`, `./conflicts`,
`next/headers`) that are not part of this repository, so they are excluded
from `tsc` and the test suite.

| File | What to look at |
| --- | --- |
| [`detection.ts`](detection.ts) | A per-workspace job slot claimed with `SELECT … FOR UPDATE`, a rerun flag so data arriving mid-run is never dropped, stale-lock recovery, and a `finally` that can't release the slot without recording why. |
| [`rate-limit.ts`](rate-limit.ts) | Fixed-window limits counted in Postgres with one atomic upsert, because in-memory counters multiply by however many serverless instances are warm. Every limit carries a comment explaining why it's set where it is. |
| [`webhook-dedupe.ts`](webhook-dedupe.ts) | At-most-once webhook handling: the `INSERT … ON CONFLICT DO NOTHING` *is* the lock. |
| [`schema-drift.ts`](schema-drift.ts) | Detecting a database behind the code in one round trip, latched so a healthy deployment stops asking. |
