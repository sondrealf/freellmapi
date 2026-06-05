import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { resetGenericFailuresForTest } from '../../services/generic-failure-tracker.js';

// E2E for the cross-request dead-head eviction (owl-alpha outage class):
// a provider returning OPAQUE generic 400s — no retryable signature — must
// 502 the first N-1 distinct requests (fail-fast preserved), then evict on
// the Nth distinct payload so that request advances and is served. The same
// payload retried never evicts (anti-cascade).

async function request(app: Express, body: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getUnifiedApiKey()}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(data); } catch {}
  return { status: res.status, body: json, headers: res.headers };
}

// An error string deliberately matching NO retryable signature.
const OPAQUE = 'upstream rejected the request for inscrutable reasons';

describe('cross-request dead-head eviction (proxy e2e)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    resetGenericFailuresForTest();
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();

    // Two platforms so the chain has somewhere to advance TO. google's
    // top-ranked model outranks groq (see router tests), so google is the
    // dead head and groq is the rescuer. Pin google to a SINGLE model —
    // otherwise each google row is its own eviction counter and the Nth
    // request would just 502 on the next google sibling.
    db.prepare('UPDATE models SET enabled = 1').run();
    db.prepare("UPDATE models SET enabled = 0 WHERE platform = 'google' AND model_id != 'gemini-3.1-pro-preview'").run();
    // Generous limits so the head's real-world rpm/rpd caps don't silently
    // drop it from the chain mid-test — this file tests eviction, not limits.
    db.prepare("UPDATE models SET rpm_limit = 10000, rpd_limit = 10000, tpm_limit = NULL, tpd_limit = NULL WHERE model_id = 'gemini-3.1-pro-preview'").run();

    // Reset fallback order to intelligence ranking (router-test pattern) —
    // the migrated default order puts other platforms ahead; this pins
    // google's rank-1 model as the chain head.
    const models = db.prepare('SELECT id, intelligence_rank FROM models ORDER BY intelligence_rank ASC').all() as any[];
    const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
    for (let i = 0; i < models.length; i++) update.run(i + 1, models[i].id);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function seedKeys() {
    // Insert directly (router-test pattern) — the POST /api/keys route
    // live-validates against the real provider API, which would mark these
    // fake keys invalid and silently drop google out of the chain.
    const db = getDb();
    for (const [platform, key] of [['google', 'g-key'], ['groq', 'gsk-key']] as const) {
      const { encrypted, iv, authTag } = encrypt(key);
      db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(platform, 'dead-head-test', encrypted, iv, authTag, 'healthy', 1);
    }
  }

  function mockProviders() {
    const origFetch = global.fetch;
    const calls = { google: 0, groq: 0 };
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      // Dead head: google always opaque-400s.
      if (urlStr.includes('generativelanguage.googleapis.com')) {
        calls.google++;
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          json: () => Promise.resolve({ error: { message: OPAQUE } }),
        } as any;
      }
      // Rescuer: groq serves anything.
      if (urlStr.includes('api.groq.com')) {
        calls.groq++;
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-rescue',
            object: 'chat.completion',
            created: 1,
            model: 'openai/gpt-oss-120b',
            choices: [{ index: 0, message: { role: 'assistant', content: 'rescued' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });
    return calls;
  }

  it('fail-fasts N-1 distinct requests, evicts on the Nth, never evicts on identical retries', async () => {
    seedKeys();
    const calls = mockProviders();

    // Identical payload retried — anti-cascade: stays 502 forever.
    for (let i = 0; i < 4; i++) {
      const r = await request(app, { messages: [{ role: 'user', content: 'same broken payload' }] });
      expect(r.status).toBe(502);
    }
    expect(calls.groq).toBe(0); // never advanced

    resetGenericFailuresForTest();

    // Distinct payloads: 1st and 2nd fail fast, 3rd evicts and is SERVED.
    const r1 = await request(app, { messages: [{ role: 'user', content: 'distinct payload one' }] });
    expect(r1.status).toBe(502);
    const r2 = await request(app, { messages: [{ role: 'user', content: 'distinct payload two' }] });
    expect(r2.status).toBe(502);
    const r3 = await request(app, { messages: [{ role: 'user', content: 'distinct payload three' }] });
    expect(r3.status).toBe(200);
    expect(r3.body.choices[0].message.content).toBe('rescued');
    expect(r3.headers.get('x-fallback-attempts')).toBe('1');
    expect(calls.groq).toBe(1);

    // Head is now on cooldown — the NEXT request skips it entirely (no new
    // google call) and goes straight to the rescuer.
    const before = calls.google;
    const r4 = await request(app, { messages: [{ role: 'user', content: 'distinct payload four' }] });
    expect(r4.status).toBe(200);
    expect(calls.google).toBe(before);
  });
});
