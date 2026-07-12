import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const workflow = fs.readFileSync(new URL('../.github/workflows/windows-release.yml', import.meta.url), 'utf8');
const alpha = fs.readFileSync(new URL('../.github/workflows/alpha-build.yml', import.meta.url), 'utf8');
const ci = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

test('tagged release workflow validates version and requires private markers', () => {
  assert.match(workflow, /Tag does not match package version/);
  assert.match(workflow, /--require-markers/);
  assert.match(workflow, /SCOUT_RELEASE_MARKERS/);
});

test('release publication has scoped write permission and publishes checksum', () => {
  assert.match(workflow, /publish:[\s\S]*permissions:\s*\n\s*contents: write/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /checksums\.txt/);
  const globalWrite = workflow.match(/^permissions:\s*\n\s*contents: write/m);
  assert.equal(globalWrite, null);
});

test('release workflow builds and smoke tests every supported platform', () => {
  assert.match(workflow, /windows-2022/); assert.match(workflow, /macos-15-intel/); assert.match(workflow, /macos-15/); assert.match(workflow, /ubuntu-22\.04/);
  assert.match(workflow, /build-platform\.mjs mac/); assert.match(workflow, /build-platform\.mjs linux/); assert.match(workflow, /preserve workspace/i);
});

test('release workflow pins Wails source and initialises it recursively', () => {
  assert.match(workflow, /submodules: recursive/);
  assert.match(workflow, /setup-go/);
  const modules = fs.readFileSync(new URL('../.gitmodules', import.meta.url), 'utf8');
  assert.match(modules, /third_party\/wails-v3/);
  assert.match(modules, /v3\.0\.0-alpha\.87/);
});

test('package, installer and release notes use one beta version', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const installer = fs.readFileSync(new URL('../installer/Scout.iss', import.meta.url), 'utf8');
  assert.match(installer, new RegExp(`MyAppVersion "${pkg.version.replaceAll('.', '\\.')}"`));
  assert.equal(fs.existsSync(new URL(`../docs/releases/${pkg.version}.md`, import.meta.url)), true);
});

test('alpha action builds the pinned Wails host and publishes one combined manifest', () => {
  assert.match(alpha, /tags: \['alpha-\*'\]/);
  assert.match(alpha, /submodules: recursive/);
  assert.match(alpha, /setup-go/);
  assert.match(alpha, /libwebkit2gtk-4\.1-dev/);
  assert.match(alpha, /go test \.\/\.\.\./);
  assert.match(alpha, /checksums\.txt/);
  assert.match(alpha, /-eq 5/);
  assert.match(alpha, /--prerelease/);
});

test('fork CI runs the release audit without requiring unavailable private markers', () => {
  assert.match(ci, /SCOUT_RELEASE_MARKERS != '' && '--require-markers'/);
  assert.match(ci, /SCOUT_RELEASE_MARKERS/);
});
