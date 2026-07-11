import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchConfiguredPortals } from '../ui/lib/ats.mjs';
import { resolveWorkspaceRoot } from '../ui/lib/workspace.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const repoRoot = resolveWorkspaceRoot({ appRoot });

const result = await fetchConfiguredPortals(repoRoot);
console.log(JSON.stringify(result, null, 2));
