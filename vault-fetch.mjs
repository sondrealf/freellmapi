/**
 * Minimal Infisical Universal-Auth fetch helper.
 *
 * Ports `src/utils/infisical-fetch.ts` from cortextos into a single-file,
 * no-dependency ES module so it can drop into any Node 20+ service that
 * needs to load secrets from the self-hosted Infisical instance at boot.
 *
 * Contract (mirrors the cortextos daemon's contract exactly):
 *   - Reads INFISICAL_HOST + INFISICAL_CLIENT_ID + INFISICAL_CLIENT_SECRET
 *     from the env you pass in (default: process.env).
 *   - Universal Auth login → workspace lookup → GET /api/v3/secrets/raw
 *     for each path you request.
 *   - On success: returns { ok: true, values: { KEY: VALUE, ... } }.
 *   - On ANY failure: returns { ok: false, reason: 'short string' } —
 *     never throws. The caller decides how to recover (typically: keep
 *     using whatever .env already supplied).
 *
 * Usage (programmatic, normal case):
 *   import { loadInfisical } from './vault-fetch.mjs';
 *   await loadInfisical({ paths: ['/shared', '/dashboard'] });
 *   // process.env now has every secret merged in
 *
 * Usage (CLI, for shell-launched contexts like the orchestrator workspace):
 *   node vault-fetch.mjs --paths /shared,/infrastructure/orchestrator
 *   # prints `export KEY='value'` lines on stdout, ready for `eval $(…)`
 *   # exit code 0 even on soft-fail — caller decides whether to abort.
 */

const DEFAULT_PROJECT_SLUG = 'sondre-hq-bq-wx';

// Keys that this helper must NEVER overlay onto process.env or emit
// via the CLI's `export` lines, even if they happen to exist in vault.
// These look like secrets but are actually local-routing config that
// belongs in each consumer's own `.env` (e.g. ANTHROPIC_AUTH_TOKEN +
// ANTHROPIC_BASE_URL point at the local claude-code-router; agents
// that hit api.anthropic.com directly get 401'd if the "cortextos"
// router APIKEY leaks into their env). Mirrors the daemon-side
// blocklist in cortextos/src/utils/vault-overlay-blocklist.ts so all
// vault consumers (daemon + shell-launched workspaces) behave the
// same way. Override via $VAULT_FETCH_NO_BLOCKLIST=1 for debugging.
const VAULT_OVERLAY_BLOCKLIST = process.env.VAULT_FETCH_NO_BLOCKLIST === '1'
  ? new Set()
  : new Set(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);

// Timeout wrapper (5s + 1 retry): a no-timeout fetch against a half-up Infisical
// (TCP-accepting, not responding) hung the agent fleet on 2026-05-29. Abort ->
// throw -> the existing soft-fail catch proceeds on .env. Never hang on vault.
async function vfetch(url, init = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= 1; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    try { return await globalThis.fetch(url, { ...init, signal: ac.signal }); }
    catch (err) { lastErr = err; }
    finally { clearTimeout(timer); }
  }
  throw lastErr;
}


// Per-path transient-read retry (mirrors src/utils/infisical-fetch.ts): never
// silently drop a requested path on a transient non-200 → no missing-secret
// boot → no crash-restart-storm. 403/404 = legit skip; 429/5xx = bounded retry;
// thrown timeout = fast-fail. Hard ceiling ~sum(backoff) ≈ 4s, well bounded.
const PATH_TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
const PATH_RETRY_BACKOFF_MS = [1000, 3000];
const pathSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchInfisicalSecrets({
  host,
  clientId,
  clientSecret,
  projectSlug = DEFAULT_PROJECT_SLUG,
  paths = ['/shared'],
}) {
  const normalizedHost = host?.replace(/\/+$/, '');
  if (!normalizedHost || !clientId || !clientSecret) {
    return { values: {}, ok: false, reason: 'INFISICAL_* not set' };
  }

  // INFISICAL_LOG=1 prints every step to stderr — useful for debugging a
  // consumer that boots cleanly but seems to have stale/missing values.
  const debug = process.env.INFISICAL_LOG === '1';
  const log = (msg) => { if (debug) process.stderr.write(`[vault-fetch:debug] ${msg}\n`); };

  try {
    log(`POST ${normalizedHost}/api/v1/auth/universal-auth/login (clientId=${clientId.slice(0, 8)}...)`);
    const loginRes = await vfetch(`${normalizedHost}/api/v1/auth/universal-auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret }),
    });
    log(`login ${loginRes.status}`);
    if (!loginRes.ok) {
      return { values: {}, ok: false, reason: `login ${loginRes.status}` };
    }
    const { accessToken: token } = await loginRes.json();
    if (!token) return { values: {}, ok: false, reason: 'no accessToken' };

    log(`GET ${normalizedHost}/api/v1/workspace`);
    const wsRes = await vfetch(`${normalizedHost}/api/v1/workspace`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    log(`workspace ${wsRes.status}`);
    if (!wsRes.ok) {
      return { values: {}, ok: false, reason: `workspace ${wsRes.status}` };
    }
    const { workspaces = [] } = await wsRes.json();
    const project = workspaces.find(w => w.slug === projectSlug);
    if (!project) {
      log(`project '${projectSlug}' not found in [${workspaces.map(w => w.slug).join(', ')}]`);
      return { values: {}, ok: false, reason: 'project not found' };
    }
    log(`project ${projectSlug} → ${project.id}`);

    const merged = {};
    for (const path of paths) {
      const url = `${normalizedHost}/api/v3/secrets/raw?workspaceId=${encodeURIComponent(project.id)}&environment=prod&secretPath=${encodeURIComponent(path)}`;
      let lastFailure = null;
      for (let attempt = 0; ; attempt++) {
        let sRes;
        try {
          sRes = await vfetch(url, { headers: { Authorization: `Bearer ${token}` } });
        } catch (e) {
          // hung/half-up vault — vfetch already retried; degrade FAST, no path retry
          lastFailure = `read threw: ${(e?.message ?? String(e)).slice(0, 60)}`;
          break;
        }
        log(`GET secretPath=${path} → ${sRes.status}`);
        if (sRes.ok) {
          const { secrets = [] } = await sRes.json();
          for (const s of secrets) merged[s.secretKey] = s.secretValue;
          lastFailure = null;
          break;
        }
        if (sRes.status === 403 || sRes.status === 404) { lastFailure = null; break; } // out-of-scope/absent → legit skip
        if (PATH_TRANSIENT_STATUSES.has(sRes.status) && attempt < PATH_RETRY_BACKOFF_MS.length) {
          log(`  ${path} transient ${sRes.status} (attempt ${attempt + 1}); retrying`);
          await pathSleep(PATH_RETRY_BACKOFF_MS[attempt]);
          continue;
        }
        lastFailure = `HTTP ${sRes.status}`;
        break;
      }
      if (lastFailure) {
        // LOUD — never a silent partial; consumer must not boot with missing secrets.
        process.stderr.write(`[vault-fetch] read ${path} FAILED (${lastFailure}) — degraded, refusing silent partial\n`);
        return { values: {}, ok: false, reason: `read ${path}: ${lastFailure}` };
      }
    }

    log(`merged ${Object.keys(merged).length} total: ${Object.keys(merged).join(', ')}`);
    return { values: merged, ok: true };
  } catch (err) {
    return { values: {}, ok: false, reason: (err?.message ?? String(err)).slice(0, 80) };
  }
}

/**
 * Load vault secrets and overlay them onto process.env (in place).
 * Vault values overwrite existing process.env on key collision.
 *
 * @param opts.paths   Array of secret paths to read (default ['/shared']).
 * @param opts.env     Env map to read INFISICAL_* from (default process.env).
 * @param opts.log     Optional logger; defaults to console.warn for soft-fail.
 * @returns true if vault overlay applied, false on soft-fail.
 */
export async function loadInfisical(opts = {}) {
  const env = opts.env ?? process.env;
  const paths = opts.paths ?? ['/shared'];
  const log = opts.log ?? ((msg) => console.warn(msg));

  const result = await fetchInfisicalSecrets({
    host: env.INFISICAL_HOST,
    clientId: env.INFISICAL_CLIENT_ID,
    clientSecret: env.INFISICAL_CLIENT_SECRET,
    projectSlug: env.INFISICAL_PROJECT_SLUG,
    paths,
  });

  if (!result.ok) {
    if (result.reason !== 'INFISICAL_* not set') {
      log(`[vault-fetch] skipped (${result.reason}); falling back to .env`);
    }
    return false;
  }

  let count = 0;
  for (const [k, v] of Object.entries(result.values)) {
    if (VAULT_OVERLAY_BLOCKLIST.has(k)) continue;
    process.env[k] = v;
    count++;
  }
  log(`[vault-fetch] loaded ${count} secret(s) from vault (paths: ${paths.join(', ')})`);
  return true;
}

// --- CLI entry point ---
//
// Two modes (vendor-synced from cortextos vault-fetch, 102c32d hardening):
//   node vault-fetch.mjs [--paths /a,/b]        → `export KEY='value'` lines
//     for ALL (non-blocklisted) secrets, for `eval $(…)` boot wrappers.
//   node vault-fetch.mjs [--paths /a,/b] KEY    → the bare VALUE of exactly
//     one secret on stdout (no trailing decoration), for one-off command
//     substitution: TOKEN=$(node vault-fetch.mjs KEY).
//
// P2 2026-06-03 (arg footgun): the parser used to recognise ONLY --paths and
// silently IGNORE everything else, so `$(node vault-fetch.mjs GEMINI_API_KEY)`
// dumped the full multi-secret export blob into one env var (which a client
// library then echoed into logs). Now: unrecognised FLAGS fail loud (exit 2,
// usage on stderr, NOTHING on stdout); a positional arg selects single-secret
// mode; >1 positional is rejected (a multi-key dump is exactly the blob this
// guards against). In single-secret mode a vault failure or missing key is a
// HARD fail (exit 1/3, empty stdout) — there is no .env-fallback semantic for
// a one-off fetch, and a silently-empty substitution is its own footgun. The
// --paths eval mode keeps its soft-fail exit-0 contract for boot wrappers.
//
// isMain detection note: comparing import.meta.url directly to argv[1]
// breaks when the file is reached through a bind-mounted path (e.g.
// /root/storage/* on this host is a bind mount of /mnt/myvolume/*).
// Node canonicalises import.meta.url to the underlying path; argv[1]
// keeps whatever spelling the caller used. Compare basenames instead.
const argvFile = process.argv[1] ? process.argv[1].split('/').pop() : '';
const isMain = !!argvFile && import.meta.url.endsWith('/' + argvFile);

if (isMain) {
  const argv = process.argv.slice(2);
  const usage = () => process.stderr.write(
    'usage: node vault-fetch.mjs [--paths /a,/b]        # export lines for ALL secrets (eval mode)\n' +
    '       node vault-fetch.mjs [--paths /a,/b] KEY    # bare value of ONE secret (substitution mode)\n');
  let paths = ['/shared'];
  const keys = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--paths' && argv[i + 1]) {
      paths = argv[i + 1].split(',').map(s => s.trim()).filter(Boolean);
      i++;
    } else if (argv[i].startsWith('-')) {
      process.stderr.write(`# vault-fetch: unknown option '${argv[i]}'\n`);
      usage();
      process.exit(2); // fail LOUD, stdout stays empty
    } else {
      keys.push(argv[i]);
    }
  }
  if (keys.length > 1) {
    process.stderr.write('# vault-fetch: at most ONE key per invocation (multi-key dumps are the P2 footgun)\n');
    usage();
    process.exit(2);
  }
  const singleKey = keys[0];

  const result = await fetchInfisicalSecrets({
    host: process.env.INFISICAL_HOST,
    clientId: process.env.INFISICAL_CLIENT_ID,
    clientSecret: process.env.INFISICAL_CLIENT_SECRET,
    projectSlug: process.env.INFISICAL_PROJECT_SLUG,
    paths,
  });

  if (!result.ok) {
    console.error(`# vault-fetch ${singleKey ? 'FAIL' : 'soft-fail'}: ${result.reason}`);
    // single-secret mode: empty $(…) is its own footgun — fail HARD.
    // eval mode: soft-fail exit 0, boot wrappers proceed on .env (contract).
    process.exit(singleKey ? 1 : 0);
  }

  if (singleKey) {
    if (VAULT_OVERLAY_BLOCKLIST.has(singleKey)) {
      console.error(`# vault-fetch: '${singleKey}' is blocklisted (local-routing config; see VAULT_OVERLAY_BLOCKLIST)`);
      process.exit(3);
    }
    if (!(singleKey in result.values)) {
      console.error(`# vault-fetch: key '${singleKey}' not found in paths ${paths.join(', ')}`);
      process.exit(3);
    }
    process.stdout.write(result.values[singleKey]);
    process.exit(0);
  }

  let count = 0;
  for (const [k, v] of Object.entries(result.values)) {
    if (VAULT_OVERLAY_BLOCKLIST.has(k)) continue;
    // POSIX-safe single-quoting: wrap in single quotes, escape embedded single quotes.
    const escaped = v.replace(/'/g, `'\\''`);
    console.log(`export ${k}='${escaped}'`);
    count++;
  }
  console.error(`# vault-fetch: loaded ${count} secret(s) (paths: ${paths.join(', ')})`);
}
