/**
 * Maps `items` through `fn` with at most `limit` calls in flight at once.
 *
 * Sync routes fan out one LLM extraction per artifact; unbounded parallelism
 * would trip OpenAI rate limits, while the serial loop this replaces made a
 * 50-item sync take minutes. Results come back in input order regardless of
 * completion order.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}
