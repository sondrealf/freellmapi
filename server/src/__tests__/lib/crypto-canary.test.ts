import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import { initEncryptionKey } from '../../lib/crypto.js';

// Canary test-decrypt at init (P2 RCA leg 3). The 2026-05-29 incident:
// a half-up-vault boot left ENCRYPTION_KEY unset, initEncryptionKey silently
// fell back to a stale first-boot DB key, and every provider-credential
// decrypt failed for 4+ days behind a green /health. These tests pin the
// fail-loud behavior: a resolved key that cannot decrypt existing api_keys
// data must throw, not cache.

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE api_keys (id INTEGER PRIMARY KEY, encrypted_key TEXT, iv TEXT, auth_tag TEXT);
  `);
  return db;
}

// Encrypt a sentinel under an explicit hex key (independent of module state).
function seedBlobUnder(db: Database.Database, hexKey: string, plaintext = 'sentinel-secret'): void {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), iv);
  let enc = cipher.update(plaintext, 'utf8', 'hex');
  enc += cipher.final('hex');
  db.prepare('INSERT INTO api_keys (encrypted_key, iv, auth_tag) VALUES (?, ?, ?)')
    .run(enc, iv.toString('hex'), cipher.getAuthTag().toString('hex'));
}

describe('initEncryptionKey — canary test-decrypt at init', () => {
  afterEach(() => { delete process.env.ENCRYPTION_KEY; });

  it('fresh install (no blobs): generates + persists a key, no throw', () => {
    const db = makeDb();
    expect(() => initEncryptionKey(db)).not.toThrow();
    expect(db.prepare("SELECT value FROM settings WHERE key='encryption_key'").get()).toBeTruthy();
  });

  it('env key that matches existing blobs: passes', () => {
    const db = makeDb();
    seedBlobUnder(db, KEY_A);
    process.env.ENCRYPTION_KEY = KEY_A;
    expect(() => initEncryptionKey(db)).not.toThrow();
  });

  it('env key that does NOT match existing blobs: FAILS LOUD', () => {
    const db = makeDb();
    seedBlobUnder(db, KEY_A);
    process.env.ENCRYPTION_KEY = KEY_B;
    expect(() => initEncryptionKey(db)).toThrow(/canary FAILED/);
  });

  it('db-fallback key that does NOT match blobs (the 2026-05-29 incident): FAILS LOUD', () => {
    const db = makeDb();
    seedBlobUnder(db, KEY_A);
    db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run(KEY_B);
    expect(() => initEncryptionKey(db)).toThrow(/canary FAILED/);
  });

  it('db-fallback key that matches blobs: passes', () => {
    const db = makeDb();
    seedBlobUnder(db, KEY_A);
    db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run(KEY_A);
    expect(() => initEncryptionKey(db)).not.toThrow();
  });

  it('generated path with existing blobs (lost key): FAILS LOUD and writes no bogus key', () => {
    const db = makeDb();
    seedBlobUnder(db, KEY_A); // blobs exist, but no env + no persisted key
    expect(() => initEncryptionKey(db)).toThrow(/canary FAILED/);
    // must NOT have persisted a freshly-generated key over the corrupt install
    expect(db.prepare("SELECT value FROM settings WHERE key='encryption_key'").get()).toBeUndefined();
  });
});
