import crypto from 'crypto';
import Database from 'better-sqlite3';

const ALGORITHM = 'aes-256-gcm';

let cachedKey: Buffer | null = null;

/**
 * AES-256-GCM uses a 32-byte key, hex-encoded as 64 chars.
 * A typo'd ENCRYPTION_KEY (e.g. "abc") would historically fall through
 * the placeholder check, get truncated to 1.5 bytes, and only fail at
 * the first encrypt() call with a cryptic node:crypto error. Validate
 * the length up front and fail fast with an actionable message.
 */
const KEY_BYTES = 32;
const KEY_HEX_LEN = KEY_BYTES * 2;

function parseHexKey(value: string, source: 'env' | 'db'): Buffer {
  if (value.length !== KEY_HEX_LEN || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(
      `Invalid ENCRYPTION_KEY (${source}): expected ${KEY_HEX_LEN} hex chars (32 bytes), got ${value.length} chars. ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return Buffer.from(value, 'hex');
}

/**
 * Canary: an existing api_keys blob MUST decrypt with the resolved key.
 *
 * The 2026-05-29 incident: a half-up-vault boot left ENCRYPTION_KEY unset,
 * initEncryptionKey silently fell back to a stale first-boot DB key, and
 * every provider-credential decrypt then failed for 4+ days behind a green
 * /health (503 routing_error on every completion). Fail LOUD here instead:
 * a key that cannot decrypt existing data is the wrong key, and refusing to
 * boot is strictly better than serving 503s behind a healthy-looking probe.
 *
 * No-op on a fresh install (no encrypted blobs to validate against).
 */
function assertKeyDecryptsExistingData(db: Database.Database, key: Buffer, source: 'env' | 'db' | 'generated'): void {
  // The api_keys table may not exist yet if init runs before migrations
  // (or in minimal test DBs) — no table means no encrypted data to validate.
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='api_keys'",
  ).get();
  if (!tableExists) return;

  const row = db.prepare(
    "SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE encrypted_key IS NOT NULL AND iv IS NOT NULL AND auth_tag IS NOT NULL LIMIT 1",
  ).get() as { encrypted_key: string; iv: string; auth_tag: string } | undefined;
  if (!row) return; // fresh install — nothing encrypted yet

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(row.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(row.auth_tag, 'hex'));
    decipher.update(row.encrypted_key, 'hex', 'utf8');
    decipher.final('utf8'); // throws on auth-tag mismatch
  } catch {
    throw new Error(
      `ENCRYPTION_KEY canary FAILED: the ${source} key cannot decrypt existing api_keys data ` +
      `(AES-GCM auth-tag mismatch). The key does not match what the stored provider ` +
      `credentials were encrypted under — refusing to boot rather than 503 every request ` +
      `behind a green /health. Likely cause: the vault overlay returned empty/stale on a ` +
      `degraded-vault boot and a wrong key was resolved from '${source}'. Restore the correct ` +
      `ENCRYPTION_KEY (vault /infrastructure/freellmapi) before restarting.`,
    );
  }
}

/**
 * Initialize encryption key from env, DB, or generate a new one.
 * Must be called after DB is initialized.
 *
 * After resolving the key from any source, a canary test-decrypt
 * (assertKeyDecryptsExistingData) guarantees the key actually matches the
 * stored data before it is cached — no silent wrong-key fallback.
 */
export function initEncryptionKey(db: Database.Database): void {
  let key: Buffer;
  let source: 'env' | 'db' | 'generated';

  // 1. Check env var
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey && envKey !== 'your-64-char-hex-key-here') {
    key = parseHexKey(envKey, 'env');
    source = 'env';
  } else {
    // 2. Check DB for persisted key
    const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string } | undefined;
    if (row) {
      key = parseHexKey(row.value, 'db');
      source = 'db';
    } else {
      // 3. First run: generate. Persist only AFTER the canary passes, so we
      //    never write a fresh key over an install that already has blobs
      //    encrypted under a different (lost) key.
      key = crypto.randomBytes(KEY_BYTES);
      source = 'generated';
    }
  }

  // Fail loud if the resolved key cannot decrypt existing data.
  assertKeyDecryptsExistingData(db, key, source);

  if (source === 'generated') {
    db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run(key.toString('hex'));
  }
  cachedKey = key;
}

function getEncryptionKey(): Buffer {
  if (!cachedKey) {
    throw new Error('Encryption key not initialized. Call initEncryptionKey() first.');
  }
  return cachedKey;
}

export function encrypt(text: string): { encrypted: string; iv: string; authTag: string } {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag,
  };
}

export function decrypt(encrypted: string, iv: string, authTag: string): string {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function maskKey(key: string): string {
  if (key.length <= 8) return '****' + key.slice(-4);
  return key.slice(0, 4) + '...' + key.slice(-4);
}
