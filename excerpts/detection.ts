import { pool } from "./db";
import { detectConflicts } from "./conflicts";

// A detection run that has been "running" longer than this is treated as dead
// (e.g. the server crashed mid-run) so the slot can be reclaimed. Detection is
// paced around a low OpenAI tier but a full pass still completes well inside this.
const STALE_MS = 15 * 60 * 1000;

export type DetectionStatus = {
  status: "idle" | "running";
  lastFinishedAt: string | null;
  /**
   * Why the last completed run failed, or null if it succeeded. Cleared by the
   * next successful run, so this always describes the most recent outcome
   * rather than accumulating history.
   */
  lastError: string | null;
  lastErrorAt: string | null;
};

/**
 * How much of a failure message is worth keeping.
 *
 * Provider errors can arrive with a whole response body attached, and a column
 * that grows without limit is one bad day away from being the biggest thing in
 * the row. The first few hundred characters carry the part a human acts on.
 */
const MAX_ERROR_CHARS = 400;

export function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message.trim() || "The run failed without reporting a reason.";
  return trimmed.length > MAX_ERROR_CHARS ? `${trimmed.slice(0, MAX_ERROR_CHARS)}…` : trimmed;
}

type Claim = "claimed" | "queued";

function isStale(lastStartedAt: string | null): boolean {
  return lastStartedAt !== null && Date.now() - new Date(lastStartedAt).getTime() > STALE_MS;
}

// Atomically decide whether this caller should run detection for a workspace.
//   "claimed" — caller acquired the slot and MUST run `runDetectionJob`.
//   "queued"  — a live run is already in progress; it will pick up the new data
//               via the rerun flag, so the caller does nothing.
// The status flips to 'running' synchronously here (before the response is sent),
// so a client that polls immediately after triggering never sees a false 'idle'.
export async function claimDetection(workspaceId: string): Promise<Claim> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO detection_jobs (workspace_id, status) VALUES ($1, 'idle')
       ON CONFLICT (workspace_id) DO NOTHING`,
      [workspaceId]
    );
    const { rows } = await client.query<{ status: string; last_started_at: string | null }>(
      `SELECT status, last_started_at FROM detection_jobs WHERE workspace_id = $1 FOR UPDATE`,
      [workspaceId]
    );
    const job = rows[0];

    if (job.status === "running" && !isStale(job.last_started_at)) {
      await client.query(
        `UPDATE detection_jobs SET rerun_requested = true, updated_at = now() WHERE workspace_id = $1`,
        [workspaceId]
      );
      await client.query("COMMIT");
      return "queued";
    }

    await client.query(
      `UPDATE detection_jobs
         SET status = 'running', rerun_requested = false, last_started_at = now(), updated_at = now()
       WHERE workspace_id = $1`,
      [workspaceId]
    );
    await client.query("COMMIT");
    return "claimed";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Clears the rerun flag and reports whether one was pending. The FROM subquery
// captures the row's pre-update value (locking it with FOR UPDATE) so a rerun
// requested concurrently can't be lost between the read and the clear.
async function consumeRerun(workspaceId: string): Promise<boolean> {
  const { rows } = await pool.query<{ was_requested: boolean }>(
    `UPDATE detection_jobs AS d
        SET rerun_requested = false, last_started_at = now(), updated_at = now()
       FROM (
         SELECT workspace_id, rerun_requested
           FROM detection_jobs WHERE workspace_id = $1 FOR UPDATE
       ) AS old
      WHERE d.workspace_id = old.workspace_id
      RETURNING old.rerun_requested AS was_requested`,
    [workspaceId]
  );
  return rows[0]?.was_requested ?? false;
}

/**
 * Releases the slot and records how the run ended.
 *
 * Writing the outcome here rather than at the throw site is what makes it
 * impossible to release the slot without saying why — the two happen in one
 * statement, in the `finally` that already had to run.
 *
 * Never throws. This runs in a `finally`, and a failure to record the failure
 * must not replace the original error with a database one, nor leave the slot
 * held: a workspace that can never claim detection again is a worse outcome
 * than a missing error message.
 */
async function finishDetection(workspaceId: string, failure: string | null): Promise<void> {
  try {
    await pool.query(
      `UPDATE detection_jobs
          SET status = 'idle', rerun_requested = false, last_finished_at = now(),
              last_error = $2, last_error_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
              updated_at = now()
        WHERE workspace_id = $1`,
      [workspaceId, failure]
    );
  } catch (writeError) {
    console.error("could not record the end of a detection run", writeError);
  }
}

// Runs detection to completion for a workspace, looping while more data arrived
// mid-run, then releases the slot. Must only be called by a caller that got
// "claimed" from `claimDetection`. Intended to run in `after()` — off the request
// path — so ingestion returns immediately. Never throws: a detection failure must
// not surface as an ingest error, and the slot is always released.
export async function runDetectionJob(workspaceId: string): Promise<void> {
  let failure: string | null = null;
  try {
    let runAgain = true;
    while (runAgain) {
      await detectConflicts(workspaceId);
      runAgain = await consumeRerun(workspaceId);
    }
  } catch (error) {
    // Swallowed on the way out — an ingest must not fail because detection did
    // — but no longer swallowed entirely: it is on the row the pages read, so
    // "nothing found" and "the run broke" stop looking identical.
    console.error("Background detection failed", error);
    failure = describeFailure(error);
  } finally {
    await finishDetection(workspaceId, failure);
  }
}

// Inline detection that still participates in the single-flight lock and the
// status the UI polls. The streaming sync path reports a "detecting" phase and
// needs the conflict count in its result, so it awaits detection rather than
// deferring it — but it must not run concurrently with a background run, and a
// run started here has to be visible to `getDetectionStatus`. Returns 0 when a
// live run already holds the slot (that run picks up the new data via rerun).
export async function runDetectionTracked(workspaceId: string): Promise<number> {
  const claim = await claimDetection(workspaceId);
  if (claim === "queued") return 0;
  let failure: string | null = null;
  try {
    let count = 0;
    let runAgain = true;
    while (runAgain) {
      count = await detectConflicts(workspaceId);
      runAgain = await consumeRerun(workspaceId);
    }
    return count;
  } catch (error) {
    // Recorded and rethrown: the sync route reports this one to the caller, and
    // it still belongs on the row for whoever looks at Conflicts afterwards.
    failure = describeFailure(error);
    throw error;
  } finally {
    await finishDetection(workspaceId, failure);
  }
}

// Claims the slot and, if acquired, runs detection in the background via the
// supplied scheduler (the route handler's `after`). One call per ingest/trigger.
export async function scheduleDetection(
  workspaceId: string,
  schedule: (task: () => Promise<void>) => void
): Promise<void> {
  const claim = await claimDetection(workspaceId);
  if (claim === "claimed") {
    schedule(() => runDetectionJob(workspaceId));
  }
}

export async function getDetectionStatus(workspaceId: string): Promise<DetectionStatus> {
  const { rows } = await pool.query<{
    status: string;
    last_started_at: string | null;
    last_finished_at: string | null;
    last_error: string | null;
    last_error_at: string | null;
  }>(
    `SELECT status, last_started_at, last_finished_at, last_error, last_error_at
       FROM detection_jobs WHERE workspace_id = $1`,
    [workspaceId]
  );
  const job = rows[0];
  if (!job) return { status: "idle", lastFinishedAt: null, lastError: null, lastErrorAt: null };

  const abandoned = job.status === "running" && isStale(job.last_started_at);
  const running = job.status === "running" && !abandoned;

  return {
    status: running ? "running" : "idle",
    lastFinishedAt: job.last_finished_at,
    // A run that died with the process never reached `finishDetection`, so it
    // recorded nothing. Reclaiming the slot silently is what made a crash look
    // like a completed run; saying so is the whole point of this field.
    lastError: abandoned
      ? "The last run stopped before it finished — the server may have restarted mid-run."
      : job.last_error,
    lastErrorAt: abandoned ? job.last_started_at : job.last_error_at,
  };
}
