import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { nativeInstallEnvironment } from './nativeInstallBoundary.mjs';

test('installed-artifact stand-ins cover both provider discovery paths without falling back to a host account', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-native-provider-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const schema = { type: 'object', properties: { ready: { type: 'boolean' } } };
  const schemaFile = path.join(root, 'schema.json'); fs.writeFileSync(schemaFile, JSON.stringify(schema));
  for (const provider of ['codex', 'claude']) {
    const script = path.join(root, `${provider}.mjs`);
    fs.copyFileSync(new URL('../tests/native/fake-provider.mjs', import.meta.url), script);
    const run = (args, input) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000, input });
    assert.equal(run(['--version']).status, 0);
    const local = run(provider === 'codex' ? ['login', 'status'] : ['auth', 'status']);
    assert.equal(local.status, 0, `${provider} discovery must stop at the synthetic authenticated executable`);
    assert.match(run(['--help']).stdout, provider === 'codex' ? /--output-schema/ : /--json-schema/);
    const turn = run(provider === 'codex' ? ['exec', '--output-schema', schemaFile] : ['-p', '--json-schema', JSON.stringify(schema)], '{}');
    assert.equal(turn.status, 0, turn.stderr);
    const events = turn.stdout.trim().split('\n').map(JSON.parse);
    const result = provider === 'codex' ? events.find(({ type }) => type === 'item.completed').item.text : events.find(({ type }) => type === 'result').result;
    assert.deepEqual(JSON.parse(result), { ready: true });
  }
});

test('installed scan acceptance uses production readiness before its synthetic source boundary', { timeout: 10000 }, async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-native-readiness-'));
  const appRoot = path.join(temporary, 'app');
  const workspace = path.join(temporary, 'workspace');
  const home = path.join(temporary, 'home');
  for (const directory of [path.join(appRoot, 'ui/lib'), path.join(appRoot, 'tools'), workspace, home]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'ui/lib/onboardingProposal.mjs'), 'export async function createOnboardingProposal() {}\n');
  fs.writeFileSync(path.join(appRoot, 'tools/scout.mjs'), `
    import fs from 'node:fs'; import path from 'node:path';
    export async function runScan(root, provider, mode, options) {
      if (!fs.existsSync(path.join(root, 'synthetic-reviewed'))) throw new Error('Synthetic readiness gate rejected the scan.');
      return options.runScanWithFn(root, provider, mode, { sentinel: 'production options retained' });
    }
    export async function runScanWith(root, provider, mode, options) {
      const collected = await options.collectSourcesFn();
      const checked = await options.checkLivenessFn([{ id: 'synthetic-item' }]);
      return { ok: true, sentinel: options.sentinel, collected: collected.sources.acceptance.count, live: checked.live.length };
    }
  `);
  const worker = fork(new URL('../tests/native/installed-worker.mjs', import.meta.url), [appRoot, workspace], {
    env: nativeInstallEnvironment(process.env, { home, temporary, workspace }),
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const closed = new Promise((resolve) => { worker.once('close', resolve); worker.once('error', resolve); });
  t.after(async () => {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill();
    await closed;
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  assert.equal((await once(worker, 'message'))[0].ready, true);
  let response = once(worker, 'message'); worker.send({ id: 1, command: 'scan' });
  assert.equal((await response)[0].error, 'Synthetic readiness gate rejected the scan.');
  fs.writeFileSync(path.join(workspace, 'synthetic-reviewed'), 'explicitly reviewed');
  response = once(worker, 'message'); worker.send({ id: 2, command: 'scan' });
  assert.deepEqual((await response)[0].result, { ok: true, sentinel: 'production options retained', collected: 1, live: 1 });
});
