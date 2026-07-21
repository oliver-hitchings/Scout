#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../ui/lib/mainModule.mjs';
import { resolveTypstRuntime } from '../ui/lib/typstRuntime.mjs';

export const TYPST_VERSION = '0.14.2';
export const TYPST_ASSETS = Object.freeze({
  'darwin-arm64': { name: 'typst-aarch64-apple-darwin.tar.xz', sha256: '470aa49a2298d20b65c119a10e4ff8808550453e0cb4d85625b89caf0cedf048' },
  'darwin-x64': { name: 'typst-x86_64-apple-darwin.tar.xz', sha256: '4e91d8e1e33ab164f949c5762e01ee3faa585c8615a2a6bd5e3677fa8506b249' },
  'linux-x64': { name: 'typst-x86_64-unknown-linux-musl.tar.xz', sha256: 'a6044cbad2a954deb921167e257e120ac0a16b20339ec01121194ff9d394996d' },
  'win32-x64': { name: 'typst-x86_64-pc-windows-msvc.zip', sha256: '51353994ac83218c3497052e89b2c432c53b9d4439cdc1b361e2ea4798ebfc13' },
});

export function typstAsset(platform = process.platform, arch = process.arch) {
  const asset = TYPST_ASSETS[`${platform}-${arch}`];
  if (!asset) throw new Error(`Scout does not provide a Typst runtime for ${platform}-${arch}`);
  return { ...asset, url: `https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/${asset.name}` };
}

function findExecutable(root, name) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const value = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findExecutable(value, name);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === name) return value;
  }
  return null;
}

export async function installTypst({
  appRoot,
  platform = process.platform,
  arch = process.arch,
  fetchFn = globalThis.fetch,
  spawn = spawnSync,
} = {}) {
  const root = appRoot
    ? path.resolve(appRoot)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const asset = typstAsset(platform, arch);
  const runtimeDir = path.join(root, '.scout-runtime');
  const binaryName = platform === 'win32' ? 'typst.exe' : 'typst';
  const target = path.join(runtimeDir, binaryName);
  const manifest = path.join(runtimeDir, 'typst-version.json');
  if (fs.existsSync(target) && fs.existsSync(manifest)) {
    try {
      const current = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (current.version === TYPST_VERSION && current.asset === asset.name && current.sha256 === asset.sha256) {
        const resolved = resolveTypstRuntime({ appRoot: root, platform, env: {}, spawn });
        if (resolved.available && resolved.source === 'managed') return { installed: false, ...resolved, asset: asset.name };
      }
    } catch { /* replace incomplete or stale runtime */ }
  }

  const response = await fetchFn(asset.url);
  if (!response.ok) throw new Error(`Typst download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== asset.sha256) throw new Error(`Typst checksum mismatch for ${asset.name}`);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-typst-'));
  try {
    const archive = path.join(temporary, asset.name);
    const extracted = path.join(temporary, 'extracted');
    fs.writeFileSync(archive, bytes);
    fs.mkdirSync(extracted);
    const unpack = spawn('tar', ['-xf', archive, '-C', extracted], { encoding: 'utf8', windowsHide: true });
    if (unpack.status !== 0) throw new Error(`Could not unpack Typst: ${unpack.stderr || unpack.stdout}`);
    const source = findExecutable(extracted, binaryName);
    if (!source) throw new Error(`Typst archive did not contain ${binaryName}`);
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.copyFileSync(source, target);
    if (platform !== 'win32') fs.chmodSync(target, 0o755);
    fs.writeFileSync(manifest, `${JSON.stringify({ version: TYPST_VERSION, asset: asset.name, sha256: asset.sha256 }, null, 2)}\n`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  const resolved = resolveTypstRuntime({ appRoot: root, platform, env: {}, spawn });
  if (!resolved.available || resolved.source !== 'managed') throw new Error('Installed Typst runtime failed verification');
  return { installed: true, ...resolved, asset: asset.name };
}

export function verifyTypst({ appRoot, compile = false, spawn = spawnSync } = {}) {
  const root = appRoot
    ? path.resolve(appRoot)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const runtime = resolveTypstRuntime({ appRoot: root, spawn });
  if (!runtime.available) throw new Error(runtime.error);
  if (!compile) return runtime;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-typst-verify-'));
  try {
    const source = path.join(temporary, 'verify.typ');
    const output = path.join(temporary, 'verify.pdf');
    fs.writeFileSync(source, '#set page(width: 10cm, height: 5cm)\nScout Typst runtime verified.\n');
    const result = spawn(runtime.command, ['compile', source, output], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0 || !fs.existsSync(output) || fs.statSync(output).size === 0) {
      throw new Error(`Typst compile verification failed: ${result.stderr || result.stdout}`);
    }
    return { ...runtime, compiled: true };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  const command = process.argv[2];
  if (command === 'install') console.log(JSON.stringify(await installTypst({}), null, 2));
  else if (command === 'verify') console.log(JSON.stringify(verifyTypst({ compile: process.argv.includes('--compile') }), null, 2));
  else throw new Error('usage: node tools/typst-runtime.mjs install|verify [--compile]');
}
