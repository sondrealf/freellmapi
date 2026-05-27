# Infisical vault integration — freellmapi

freellmapi reads its symmetric encryption key (`ENCRYPTION_KEY`) from the
self-hosted Infisical instance at boot. Without that key the server can't
open its sqlite-backed encrypted credential store.

## What this consumer reads from vault

| Path | Keys |
|---|---|
| `/infrastructure/freellmapi` | `ENCRYPTION_KEY` |

No `/shared` access — minimum scope on purpose. If freellmapi ever needs an
org-wide value (e.g. a future telemetry token), expand the
`freellmapi-runtime-readonly` role to include `/shared/**`.

## Identity

| Field | Value |
|---|---|
| Identity name | `freellmapi-runtime` |
| Role slug | `freellmapi-runtime-readonly` |
| Scope | read-only on `/infrastructure/freellmapi/**` |
| `clientId` + `clientSecret` | committed to `.env` (gitignored — chmod 600) |

Created via `cortextos`'s admin bootstrap during Phase 6.2; the writer
identity used to mint it has been revoked.

## Where the integration code lives

- **Helper:** [`vault-fetch.mjs`](./vault-fetch.mjs) at the repo root —
  a single ES module, no deps, Node 20+ `fetch`. Ports
  `cortextos/src/utils/infisical-fetch.ts`.
- **Boot hook:** [`server/src/env.ts`](./server/src/env.ts) — `dotenv.config()`
  runs first to populate `INFISICAL_*` from `.env`, then
  `await loadInfisical({ paths: ['/infrastructure/freellmapi'] })` overlays
  the vault values onto `process.env`. Top-level await is safe because
  `server/src/index.ts` imports `./env.js` as its first statement and the
  project is ES modules.

## How to debug

Set `INFISICAL_LOG=1` in `.env` (or export before launching) to print a
per-step trace to stderr:

```
[vault-fetch:debug] POST http://localhost:8090/api/v1/auth/universal-auth/login (clientId=00b1ef2f...)
[vault-fetch:debug] login 200
[vault-fetch:debug] GET http://localhost:8090/api/v1/workspace
[vault-fetch:debug] workspace 200
[vault-fetch:debug] project sondre-hq-bq-wx → a1b1b213-...
[vault-fetch:debug] GET secretPath=/infrastructure/freellmapi → 200
[vault-fetch:debug]   /infrastructure/freellmapi returned 1 secret(s): ENCRYPTION_KEY
[vault-fetch:debug] merged 1 total: ENCRYPTION_KEY
```

The normal startup log line `[vault-fetch] loaded N secret(s) from vault`
goes to stderr regardless — visible in `pm2 logs freellmapi`.

Common boot states:
- `[vault-fetch] loaded 1 secret(s)` → vault reachable, key fetched, sqlite
  opens. Normal.
- `[vault-fetch] skipped (login 401)` → `INFISICAL_CLIENT_SECRET` is wrong.
  Rotate the secret via Infisical UI and update `.env`.
- `[vault-fetch] skipped (login ECONNREFUSED)` → Infisical instance is
  down. Server still boots if `.env` still has `ENCRYPTION_KEY` (which it
  shouldn't post-Phase-6.2). Otherwise sqlite open will fail loudly.

## Curl fallback (read this consumer's keys directly)

If the helper misbehaves and you need to confirm what vault actually
holds:

```bash
BASE=http://localhost:8090
CLIENT_ID=00b1ef2f-fda6-4676-b1d8-d86c361b1fe4         # freellmapi-runtime
CLIENT_SECRET=...                                       # see .env

TOKEN=$(curl -s -X POST "$BASE/api/v1/auth/universal-auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"clientId\":\"$CLIENT_ID\",\"clientSecret\":\"$CLIENT_SECRET\"}" | jq -r .accessToken)

PROJECT_ID=$(curl -s "$BASE/api/v1/workspace" -H "Authorization: Bearer $TOKEN" \
  | jq -r '.workspaces[] | select(.slug=="sondre-hq-bq-wx") | .id')

# Read ENCRYPTION_KEY:
curl -s "$BASE/api/v3/secrets/raw/ENCRYPTION_KEY?workspaceId=$PROJECT_ID&environment=prod&secretPath=/infrastructure/freellmapi" \
  -H "Authorization: Bearer $TOKEN" | jq -r .secret.secretValue
```

Or use the CLI (uses commander's identity by default; freellmapi's own
identity is enough for its scope):

```bash
INFISICAL_CLIENT_ID=$CLIENT_ID INFISICAL_CLIENT_SECRET=$CLIENT_SECRET \
  cortextos vault get /infrastructure/freellmapi/ENCRYPTION_KEY
```

## Restart contract

`ENCRYPTION_KEY` is loaded ONCE at server boot. If you rotate it:

1. Update vault (`cortextos vault rotate /infrastructure/freellmapi/ENCRYPTION_KEY`
   or via UI).
2. Hard-restart freellmapi: `pm2 restart freellmapi`.
3. **Critical:** the sqlite DB at `server/data/freeapi.db` is encrypted
   with the OLD key. Rotating `ENCRYPTION_KEY` without re-keying that
   database renders every stored provider credential unreadable. This is
   why Phase 6.2 populated the vault with the existing value and
   explicitly does NOT rotate it. If you ever truly need to rotate, plan
   for: snapshot DB → decrypt with old key → re-encrypt with new key →
   swap DB → restart.

## Related docs

- [`docs/infisical-vault.md`](../../cortextos/docs/infisical-vault.md) —
  full picture: architecture, identity model, runtime fetch path, backup
  strategy.
- Upstream API spec: <https://infisical.com/docs/api-reference/overview>.
- `cortextos vault --help` for the CLI.
