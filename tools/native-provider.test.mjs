import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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
