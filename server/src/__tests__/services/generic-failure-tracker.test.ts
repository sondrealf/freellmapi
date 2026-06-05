import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordGenericFailure,
  clearGenericFailures,
  resetGenericFailuresForTest,
  EVICTION_THRESHOLD,
  EVICTION_WINDOW_MS,
} from '../../services/generic-failure-tracker.js';

// Cross-request dead-head eviction (owl-alpha outage, 2026-06-05).
// The contract under test: N consecutive generic failures from the SAME
// provider/model on DISTINCT payloads → evict; identical payloads never
// accumulate (one stuck client must not cascade-evict the chain); success
// and window expiry reset the pattern.

const P = 'openrouter';
const M = 'openrouter/owl-alpha';

beforeEach(() => resetGenericFailuresForTest());

describe('recordGenericFailure', () => {
  it('evicts on the Nth DISTINCT payload failure', () => {
    expect(recordGenericFailure(P, M, 'hash-1')).toBe(false);
    expect(recordGenericFailure(P, M, 'hash-2')).toBe(false);
    expect(recordGenericFailure(P, M, 'hash-3')).toBe(true); // Nth fires
  });

  it('identical payloads never accumulate (anti-cascade)', () => {
    for (let i = 0; i < EVICTION_THRESHOLD * 3; i++) {
      expect(recordGenericFailure(P, M, 'same-hash')).toBe(false);
    }
  });

  it('a repeated payload refreshes recency but still needs distinct peers', () => {
    expect(recordGenericFailure(P, M, 'hash-1')).toBe(false);
    expect(recordGenericFailure(P, M, 'hash-1')).toBe(false);
    expect(recordGenericFailure(P, M, 'hash-2')).toBe(false);
    expect(recordGenericFailure(P, M, 'hash-3')).toBe(true);
  });

  it('tracks providers/models independently', () => {
    recordGenericFailure(P, M, 'hash-1');
    recordGenericFailure(P, M, 'hash-2');
    // different model on the same platform is its own counter
    expect(recordGenericFailure(P, 'other-model', 'hash-3')).toBe(false);
    expect(recordGenericFailure(P, M, 'hash-3')).toBe(true);
  });

  it('window expiry drops stale failures', () => {
    const t0 = 1_000_000;
    recordGenericFailure(P, M, 'hash-1', t0);
    recordGenericFailure(P, M, 'hash-2', t0 + 1000);
    // third distinct failure arrives after the window — old two aged out
    expect(recordGenericFailure(P, M, 'hash-3', t0 + EVICTION_WINDOW_MS + 2000)).toBe(false);
  });

  it('eviction consumes the pattern — the next failure starts a fresh count', () => {
    recordGenericFailure(P, M, 'hash-1');
    recordGenericFailure(P, M, 'hash-2');
    expect(recordGenericFailure(P, M, 'hash-3')).toBe(true);
    expect(recordGenericFailure(P, M, 'hash-4')).toBe(false); // count restarted
  });
});

describe('clearGenericFailures', () => {
  it('a success resets the counter', () => {
    recordGenericFailure(P, M, 'hash-1');
    recordGenericFailure(P, M, 'hash-2');
    clearGenericFailures(P, M);
    expect(recordGenericFailure(P, M, 'hash-3')).toBe(false);
    expect(recordGenericFailure(P, M, 'hash-4')).toBe(false);
    expect(recordGenericFailure(P, M, 'hash-5')).toBe(true);
  });
});
