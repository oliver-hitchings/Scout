import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { stageRelease } from './build-release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('native Windows host compiles and executes receipt tests, then measures installed long paths', { skip: process.platform !== 'win32' }, (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-native-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  assert.ok(fs.existsSync(csc), 'The actual Windows C# compiler is required');
  const host = path.join(root, 'installer/windows/ScoutHost.cs');
  const references = ['/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll'];
  for (const [target, extra] of [['Scout.exe', ['/target:winexe']], ['ScoutNativeTests.exe', ['/target:exe', '/main:ScoutHost.NativeTests', path.join(root, 'tests/native/ScoutHostTests.cs')]]]) {
    const compilation = spawnSync(csc, ['/nologo', ...references, `/out:${path.join(temporary, target)}`, ...extra, host], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(compilation.status, 0, `Native compilation failed: ${compilation.stdout}\n${compilation.stderr}`);
  }
  const native = spawnSync(path.join(temporary, 'ScoutNativeTests.exe'), [], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(native.status, 0, native.stdout + native.stderr);
  assert.match(native.stdout, /Native notification receipt assertions passed/);
  const stage = stageRelease({ root, stageDir: path.join(temporary, 'stage') });
  const install = path.join(process.env.LOCALAPPDATA, 'Programs', 'Scout');
  const files = fs.readdirSync(stage.appDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
  assert.ok(files.length > 0);
  const longest = files.map((file) => ({ file, relative: path.relative(stage.appDir, file) }))
    .sort((left, right) => right.relative.length - left.relative.length)[0];
  const measured = path.join(install, 'app', longest.relative).length;
  t.diagnostic(`Native Windows staged files: ${files.length}; longest relative path: ${longest.relative.length}; default installed path: ${measured} characters`);
  assert.ok(measured < 260, `Default install exceeds the measured legacy Windows path budget: ${measured}`);
  const deep = path.join(temporary, ...Array.from({ length: 14 }, () => 'synthetic-long-path'));
  const destination = path.join(deep, 'roundtrip.bin');
  assert.ok(destination.length > 260);
  fs.mkdirSync(deep, { recursive: true });
  fs.copyFileSync(longest.file, destination);
  assert.deepEqual(fs.readFileSync(destination), fs.readFileSync(longest.file), 'The bundled Node runtime must round-trip an actual staged payload above MAX_PATH');
});
