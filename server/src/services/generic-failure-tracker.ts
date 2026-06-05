/**
 * Cross-request dead-head eviction (2026-06-05 owl-alpha outage follow-up).
 *
 * A single generic 400 carries no signal: it could be a broken request or a
 * dead provider. The disambiguation is only solvable ACROSS requests — N
 * consecutive generic failures from the SAME provider/model on DISTINCT
 * zod-valid payloads means the provider is the constant, so cooldown and
 * advance it like a 429. Genuinely unservable requests keep failing on every
 * provider (no false advance), dead heads self-evict after N hits.
 *
 * The payload-hash distinctness requirement is load-bearing: without it, one
 * stuck client retrying a single broken payload N times evicts the head,
 * then the next provider, then CASCADE-EVICTS the whole chain. Distinct
 * hashes are what make "different requests" real.
 *
 * Eviction fires ON the Nth distinct failure, so the request that completes
 * the pattern advances and gets served instead of eating the last 502.
 *
 * In-memory by design (mirrors the cooldown/penalty state in ratelimit.ts):
 * a daemon restart resets the counters, which is safe — the worst case is a
 * dead head costs N fresh failures again.
 */

/** Distinct-payload failures required before a provider/model is evicted. */
export const EVICTION_THRESHOLD = 3;
/** Failures older than this no longer count toward the threshold. */
export const EVICTION_WINDOW_MS = 10 * 60 * 1000;

interface FailureRecord {
  hash: string;
  at: number;
}

const failures = new Map<string, FailureRecord[]>();

function key(platform: string, modelId: string): string {
  return `${platform}:${modelId}`;
}

/**
 * Record a generic (non-signature-retryable) provider failure.
 * Returns true when this failure completes the eviction pattern — the caller
 * should cooldown the model and advance the chain for THIS request.
 */
export function recordGenericFailure(
  platform: string,
  modelId: string,
  payloadHash: string,
  now: number = Date.now(),
): boolean {
  const k = key(platform, modelId);
  const recent = (failures.get(k) ?? []).filter(f => now - f.at <= EVICTION_WINDOW_MS);

  // Same payload failing again adds no information about the provider —
  // refresh the timestamp so a stuck client can't age the pattern out, but
  // never let identical payloads accumulate toward the threshold.
  const existing = recent.find(f => f.hash === payloadHash);
  if (existing) {
    existing.at = now;
  } else {
    recent.push({ hash: payloadHash, at: now });
  }
  if (recent.length >= EVICTION_THRESHOLD) {
    failures.delete(k); // pattern consumed — cooldown takes over from here
    return true;
  }
  failures.set(k, recent);
  return false;
}

/** A success proves the provider serves — drop its failure history. */
export function clearGenericFailures(platform: string, modelId: string): void {
  failures.delete(key(platform, modelId));
}

/** Test seam: wipe all state between cases. */
export function resetGenericFailuresForTest(): void {
  failures.clear();
}
