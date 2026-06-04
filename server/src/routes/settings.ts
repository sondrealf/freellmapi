import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import { getUnifiedApiKey, regenerateUnifiedKey } from '../db/index.js';

export const settingsRouter = Router();

// 2026-06-04 hardening: these routes used to be UNAUTHENTICATED. proxy.ts
// explicitly authenticates loopback callers ("browser pages can reach
// localhost, so socket locality is not a reliable authorization boundary")
// but the settings routes missed the same treatment — an unauth GET handed
// the unified key to any localhost process, and an unauth POST let anyone
// rotate it out from under every consumer. Both now require the CURRENT
// unified key as a bearer. NOTE: the bundled dashboard UI used these
// endpoints unauthenticated and loses key display/regenerate until it
// learns to send the bearer — retrieve the key via the vault
// (/shared/FREELLMAPI_TOKEN) or the DB instead.
function timingSafeEqualStr(provided: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireUnifiedKey(req: Request, res: Response): boolean {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token || !timingSafeEqualStr(token, getUnifiedApiKey())) {
    res.status(401).json({
      error: { message: 'Invalid API key', type: 'authentication_error' },
    });
    return false;
  }
  return true;
}

// Get the unified API key (requires knowing it already — kept for
// API-shape compatibility; effectively a validity check).
settingsRouter.get('/api-key', (req: Request, res: Response) => {
  if (!requireUnifiedKey(req, res)) return;
  res.json({ apiKey: getUnifiedApiKey() });
});

// Regenerate the unified API key
settingsRouter.post('/api-key/regenerate', (req: Request, res: Response) => {
  if (!requireUnifiedKey(req, res)) return;
  const newKey = regenerateUnifiedKey();
  res.json({ apiKey: newKey });
});
