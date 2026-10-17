import { headers } from "next/headers";
import { pool } from "./db";

/**
 * Fixed-window rate limiting, counted in Postgres.
 *
 * In-memory counters are worthless here: every serverless instance keeps its
 * own, so the effective limit becomes the configured one multiplied by however
 * many instances happen to be warm. A shared counter is the only kind that
 * actually limits anything.
 *
 * Fixed windows can allow up to 2x the limit across a window boundary. That's
 * an accepted trade for the simplicity — these limits exist to stop brute force
 * and email flooding, not to meter a paid API precisely.
 */

export type RateLimitResult = {
  allowed: boolean;
  /** Seconds until the current window rolls over. */
  retryAfterSeconds: number;
};

export type RateLimitRule = { limit: number; windowSeconds: number };

/**
 * The limits, in one place so they can be reasoned about together.
 *
 * Auth limits are deliberately per-identifier *and* per-IP: keying only on
 * email lets an attacker spray many accounts from one host, and keying only on
 * IP lets a distributed attacker hammer a single account.
 */
export const RATE_LIMITS = {
  loginPerEmail: { limit: 10, windowSeconds: 15 * 60 },
  loginPerIp: { limit: 30, windowSeconds: 15 * 60 },
  signupPerIp: { limit: 5, windowSeconds: 60 * 60 },
  // The tightest limits in the app. This endpoint sends mail to an address the
  // requester names, so without a cap it is a spam cannon aimed at a stranger
  // — and it bills the workspace's email quota to do it.
  passwordResetPerEmail: { limit: 3, windowSeconds: 60 * 60 },
  passwordResetPerIp: { limit: 10, windowSeconds: 60 * 60 },
  // LLM-backed endpoints: these cost money per call.
  // Sends mail to addresses the caller names, so it is capped like the reset
  // endpoint rather than like a normal action — the caller is an authenticated
  // member here, which makes it a smaller cannon, not a harmless one. Counted
  // per address, so one invite to twelve people costs twelve.
  workspaceInvitePerUser: { limit: 40, windowSeconds: 60 * 60 },
  askPerUser: { limit: 40, windowSeconds: 60 * 60 },
  ingestPerUser: { limit: 25, windowSeconds: 60 * 60 },
  inviteSendPerUser: { limit: 20, windowSeconds: 60 * 60 },
  // Creating a task writes into a tracker other people work out of, so a loop
  // here fills a colleague's board rather than merely costing us money. Counted
  // per user, and set where a busy afternoon of triage fits comfortably inside
  // it while a runaway client does not.
  createTaskPerUser: { limit: 30, windowSeconds: 60 * 60 },
  // Each press creates a real meeting on somebody's Zoom or Teams account and
  // nothing here deletes them, so a loop leaves a trail of orphaned meetings on
  // a colleague's calendar rather than merely costing us money.
  scheduleMeetingPerUser: { limit: 30, windowSeconds: 60 * 60 },
  // The tightest of the three action limits. This writes into a ticket somebody
  // else owns, in front of everybody watching it, and a comment cannot be
  // unposted — the other two make something new, which is undone by deleting it.
  commentOnSourcePerUser: { limit: 20, windowSeconds: 60 * 60 },
  // API tokens, bucketed per token rather than per IP: a key is the identity
  // here, and several people behind one office address must not share a limit
  // while one runaway script gets a whole bucket to itself.
  //
  // Two limits because the tools are not alike. Reading conflicts is a database
  // query and can be generous; `check_plan` runs extraction, detection and
  // verification against the model on every call, so it gets its own, much
  // tighter bucket. The bean meter is the real spending limit — this is what
  // stops a loop reaching it in a minute.
  mcpPerToken: { limit: 600, windowSeconds: 60 * 60 },
  checkPlanPerToken: { limit: 30, windowSeconds: 60 * 60 },
  // The live Slack check, counted per channel rather than per user or per
  // workspace. The unit is the channel because that is where the cost and the
  // nuisance both scale: one busy release channel on a bad afternoon would
  // otherwise spend a quiet workspace's whole allowance, and interrupt the same
  // handful of people over and over while doing it.
  //
  // Nothing here is triggered by a person pressing anything, so the limit is
  // set at what a genuinely active channel produces rather than at what a
  // reasonable human does: past it, the hourly sync still finds everything, a
  // few minutes later.
  liveCheckPerChannel: { limit: 12, windowSeconds: 60 * 60 },
  // The pull-request check, counted per workspace. Unlike the Slack path the
  // volume is naturally bounded — a team opens tens of pull requests a day, not
  // thousands of messages — so this is a runaway guard rather than a gate, set
  // above what a busy engineering org opens in an hour. What it actually stops
  // is a misconfigured hook replaying, or a bot account opening PRs in a loop.
  prCheckPerWorkspace: { limit: 60, windowSeconds: 60 * 60 },
  // Publishing creates a page in a space colleagues read. Looser than
  // commenting — a page can be deleted where a comment cannot be unposted —
  // and tighter than creating a task, because a decision log filling with
  // near-duplicates is how it stops being read.
  publishDecisionPerUser: { limit: 20, windowSeconds: 60 * 60 },
  // The loosest of the action limits, because it is the least dangerous write:
  // a link asserts nothing, changes no field and is removed in one click. This
  // is a runaway guard, not a brake on a person.
  linkRecordsPerUser: { limit: 60, windowSeconds: 60 * 60 },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Records one hit against a bucket and reports whether it may proceed.
 *
 * The insert-or-increment is a single statement so concurrent requests can't
 * both read a stale count and both decide they're under the limit.
 */
export async function consumeRateLimit(
  bucket: string,
  rule: RateLimitRule
): Promise<RateLimitResult> {
  const { rows } = await pool.query<{ count: number; retry_after: number }>(
    `WITH bounds AS (
       SELECT to_timestamp(floor(extract(epoch from now()) / $2) * $2) AS window_start
     ), bumped AS (
       INSERT INTO rate_limits (bucket, window_start, count)
       SELECT $1, window_start, 1 FROM bounds
       ON CONFLICT (bucket, window_start)
         DO UPDATE SET count = rate_limits.count + 1
       RETURNING count, window_start
     )
     SELECT count,
            ceil(extract(epoch from (window_start + ($2 || ' seconds')::interval - now())))::int AS retry_after
       FROM bumped`,
    [bucket, rule.windowSeconds]
  );

  const row = rows[0];
  return {
    allowed: row.count <= rule.limit,
    retryAfterSeconds: Math.max(1, row.retry_after),
  };
}

/**
 * Undoes a consumed hit. Used when an action succeeded, so that a legitimate
 * user isn't penalised for a correct password by the same counter that exists
 * to stop guessing.
 */
export async function refundRateLimit(bucket: string, rule: RateLimitRule): Promise<void> {
  await pool.query(
    `UPDATE rate_limits
        SET count = greatest(count - 1, 0)
      WHERE bucket = $1
        AND window_start = to_timestamp(floor(extract(epoch from now()) / $2) * $2)`,
    [bucket, rule.windowSeconds]
  );
}

/** Housekeeping — windows older than a day can never be current again. */
export async function pruneRateLimits(): Promise<void> {
  await pool.query(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`);
}

/**
 * Best-effort client address.
 *
 * x-forwarded-for is client-controlled in general, but behind a platform proxy
 * (Vercel, most hosts) the left-most entry is rewritten by the proxy. It is
 * good enough to slow down abuse, which is all an IP bucket is for — the
 * per-identifier bucket is the one that has to hold.
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return h.get("x-real-ip") ?? "unknown";
}

export function retryMessage(seconds: number): string {
  if (seconds >= 60) {
    const minutes = Math.ceil(seconds / 60);
    return `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  }
  return `Too many attempts. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`;
}
