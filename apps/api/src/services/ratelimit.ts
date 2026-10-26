import { query } from '../db/index.js';
import { tooMany } from '../lib/errors.js';

const memoryBuckets = new Map<string, { count: number; resetAt: number }>();

/** Persisted fixed-window limiter used for provisioning and flag submissions. */
export async function consumePersistentLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
  const windowStart = new Date(Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000);
  const res = await query<{ count: number }>(
    `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [key, windowStart],
  );
  const count = res.rows[0]?.count ?? 1;
  if (Math.random() < 0.01) void query('DELETE FROM rate_limits WHERE window_start < now() - interval \'2 days\'').catch(() => {});
  if (count > limit) throw tooMany('Too many requests for this action. Please wait and try again.');
}

/** Cheap in-process limiter applied to the whole API surface. */
export function memoryLimit(key: string, limit: number, windowMs = 60_000): void {
  const now = Date.now();
  const bucket = memoryBuckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    memoryBuckets.set(key, { count: 1, resetAt: now + windowMs });
    if (memoryBuckets.size > 5000) {
      for (const [k, v] of memoryBuckets) if (v.resetAt < now) memoryBuckets.delete(k);
    }
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) throw tooMany('Request rate limit exceeded');
}
