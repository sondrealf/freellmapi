import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. Load the repo-root .env first so INFISICAL_* + any non-vault config
//    (PORT, etc.) are in process.env before the vault fetch.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// 2. Vault overlay — fetches /infrastructure/freellmapi/* (currently
//    ENCRYPTION_KEY) using the freellmapi-runtime machine identity. Soft
//    fallback: any failure (missing INFISICAL_*, vault unreachable, etc.)
//    leaves whatever the .env already supplied in place.
//
//    Top-level await is fine here because env.ts is itself imported from
//    `src/index.ts` as the first statement (`import './env.js'`), and the
//    project is ES modules — the module graph waits for env.ts to settle
//    before index.ts runs the rest of its imports.
const { loadInfisical } = await import(path.resolve(__dirname, '../../vault-fetch.mjs'));
await loadInfisical({ paths: ['/infrastructure/freellmapi'] });
