import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedWorkspace } from '../../ui/lib/workspace.mjs';

export default async function globalSetup() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-browser-'));
  seedWorkspace(root, workspace);

  const configPath = path.join(workspace, 'workspace.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  Object.assign(config, {
    schemaVersion: 2,
    profile: { displayName: 'Example Person', tone: 'natural and direct' },
    search: {
      roleFamilies: ['Product engineer'],
      sectors: ['Climate technology'],
      locations: ['Example City'],
      exclusions: ['Extensive travel'],
      salaryMinimum: 70000,
    },
    ai: { provider: null, model: null },
    setup: { completedAt: '2026-07-01T09:00:00.000Z', sections: {} },
  });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(path.join(workspace, 'data', 'opportunities.json'), `${JSON.stringify({
    updated: '2026-07-20',
    opportunities: [],
  }, null, 2)}\n`);

  process.env.SCOUT_WORKSPACE = workspace;
  process.env.SCOUT_DEVICE_SETTINGS = path.join(workspace, '.scout', 'device-settings.json');
  process.env.PORT = '8461';

  const { createServer } = await import('../../ui/server.mjs');
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(8461, '127.0.0.1', resolve);
  });

  return async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(workspace, { recursive: true, force: true });
  };
}
