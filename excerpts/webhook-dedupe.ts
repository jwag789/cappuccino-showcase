import { pool } from "./db";

/**
 * Claiming a webhook delivery, so a redelivery cannot be acted on twice.
 *
 * Shared by the Slack and GitHub endpoints because the requirement is
 * identical and the consequence of getting it wrong is the same on both: an
 * interruption repeated, which reads as a broken bot rather than a helpful one.
 *
 * The claim is taken *before* the work rather than after, which makes this
 * at-most-once — a delivery that fails mid-flight is not retried. That is the
 * right way round for both callers. Neither loses anything permanent: the
 * hourly sync ingests the same Slack messages and the same pull request
 * afterwards and detection compares them like anything else. A duplicate
 * costs a person being told the same thing twice, or a second identical
 * comment under somebody's work, which is the failure that gets a feature
 * switched off.
 */

/**
 * Records a delivery id, returning false if it was already recorded.
 *
 * The insert is the lock: `ON CONFLICT DO NOTHING` makes the claim atomic, so
 * a retry arriving while the first delivery is still being worked on cannot
 * also decide it is first.
 *
 * The provider prefixes the id because two providers' id spaces are unrelated,
 * and a bare id would let one silently mask the other.
 */
export async function claimDelivery(provider: string, id: string): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO webhook_deliveries_seen (event_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [`${provider}:${id}`]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Drops ids past any redelivery either provider would still attempt.
 *
 * Called from the hourly sync cron rather than from the endpoints: those are
 * the hot path and this is housekeeping, so paying for a delete on every
 * delivery to clean up after a handful would be the wrong trade.
 */
export async function pruneWebhookDeliveries(): Promise<void> {
  await pool.query(
    `DELETE FROM webhook_deliveries_seen WHERE created_at < now() - interval '1 day'`
  );
}
