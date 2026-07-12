#!/usr/bin/env node
// Node does not expand globs on Windows. Keep the test command cross-platform.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['ui', 'ui/lib', 'tools'].flatMap((dir) => fs.readdirSync(path.join(root, dir)).filter((name) => name.endsWith('.test.mjs')).map((name) => path.join(dir, name)));
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
