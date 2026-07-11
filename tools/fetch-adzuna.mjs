import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../ui/lib/env.mjs';
import { fetchAdzuna, resolveAdzunaCredentials } from '../ui/lib/adzuna.mjs';
import { resolveWorkspaceRoot } from '../ui/lib/workspace.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const repoRoot = resolveWorkspaceRoot({ appRoot });

const env = { ...loadEnv(repoRoot), ...process.env };
const creds = resolveAdzunaCredentials(env);
if (!creds) {
  console.log(JSON.stringify({
    jobs: [], sources: {}, errors: [], available: false,
    note: 'ADZUNA_APP_ID / ADZUNA_API_KEY not set — get free keys at https://developer.adzuna.com/ and put them in .env',
  }, null, 2));
  process.exit(0);
}

const result = await fetchAdzuna(creds);
console.log(JSON.stringify(result, null, 2));
