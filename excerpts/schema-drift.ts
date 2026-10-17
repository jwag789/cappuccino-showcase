import { pool } from "./db";
import type { Queryable } from "./decision-register";

export type { Queryable };

/**
 * Whether the database has caught up with the code.
 *
 * Migrations are deliberately not run on deploy — `amplify.yml` says why, and
 * the reasoning holds: a build that rewrites a live schema on every push,
 * including from every preview branch, is a worse risk than a manual step. But
 * the manual step was unenforced *and* unreported, so forgetting it produced a
 * page that threw `relation "decisions" does not exist` and rendered
 * "Something went wrong" with a reference number that means nothing to the
 * person reading it. The database being behind the code is a fact Postgres can
 * be asked about directly, so it should never have to be guessed at from a
 * stack trace.
 *
 * This is the same argument the rest of `lib/notices.ts` makes. A failure the
 * customer cannot see is one they blame on the product — and this particular
 * failure is worse than most, because it is invisible to whoever deployed and
 * looks like a broken feature to everybody else.
 */

/**
 * Every table `db/schema.sql` creates.
 *
 * Hard-coded rather than read from the file, because the deployment artifact is
 * `.next` alone — `db/` is not shipped, so a runtime read would find nothing in
 * exactly the environment this exists to check. `tests/unit/schema-drift.test.ts`
 * compares this list against the file, which is where the file *is* available,
 * so the two cannot drift apart silently.
 */
export const REQUIRED_TABLES = [
  "alert_deliveries",
  "alert_rules",
  "api_tokens",
  "artifacts",
  "audit_events",
  "bean_ledger",
  "conflict_observations",
  "conflict_rejections",
  "conflict_shares",
  "conflicts",
  "decision_conflicts",
  "decision_edits",
  "decision_sources",
  "decisions",
  "detection_batches",
  "detection_jobs",
  "email_verification_tokens",
  "entities",
  "feedback",
  "live_warnings",
  "notification_reads",
  "observations",
  "password_reset_tokens",
  "plan_checks",
  "pr_checks",
  "rate_limits",
  "resolutions",
  "slack_channel_syncs",
  "stripe_events",
  "sync_cursors",
  "team_members",
  "usage_events",
  "user_recovery_codes",
  "users",
  "webhook_deliveries_seen",
  "workspace_connections",
  "workspace_domains",
  "workspace_invitations",
  "workspace_members",
  "workspace_people",
  "workspace_sso",
  "workspace_teams",
  "workspaces",
] as const;

/**
 * Latched, not cached.
 *
 * Notices are polled, and asking this on every poll forever would be a query
 * per reader per few seconds to answer a question that is almost always "no".
 * Once every table is present the answer cannot change back — nothing in this
 * product drops a table — so the check stops running. While something *is*
 * missing it keeps checking, which is what lets the notice clear itself the
 * moment somebody runs the migration, with no restart and nothing to invalidate.
 */
let schemaConfirmedComplete = false;

/** Only for tests, which need each case to start from an unlatched state. */
export function resetSchemaCheck(): void {
  schemaConfirmedComplete = false;
}

/**
 * Which required tables the database does not have, cheapest way possible.
 *
 * One round trip that asks Postgres to subtract what exists from what is
 * wanted, rather than selecting every table name and diffing in TypeScript.
 * Returns `[]` on a query failure: this runs inside the notice bar, and a
 * notice bar that throws takes down the page it was added to warn about.
 */
export async function missingTables(db: Queryable = pool): Promise<string[]> {
  if (schemaConfirmedComplete) return [];

  try {
    const { rows } = await db.query<{ name: string }>(
      `SELECT name FROM unnest($1::text[]) AS name
        EXCEPT
       SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'`,
      [REQUIRED_TABLES as unknown as string[]]
    );
    const missing = rows.map((row) => row.name).sort();
    if (missing.length === 0) schemaConfirmedComplete = true;
    return missing;
  } catch (error) {
    console.error("could not check whether the schema is up to date", error);
    return [];
  }
}
