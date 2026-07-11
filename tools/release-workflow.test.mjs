import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const workflow = fs.readFileSync(new URL('../.github/workflows/windows-release.yml', import.meta.url), 'utf8');

test('tagged release workflow validates version and requires private markers', () => {
  assert.match(workflow, /Tag .* does not match package version/);
  assert.match(workflow, /--require-markers/);
  assert.match(workflow, /SCOUT_RELEASE_MARKERS/);
});

test('release publication has scoped write permission and publishes checksum', () => {
  assert.match(workflow, /publish:[\s\S]*permissions:\s*\n\s*contents: write/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /installer\/output\/checksums\.txt/);
  const globalWrite = workflow.match(/^permissions:\s*\n\s*contents: write/m);
  assert.equal(globalWrite, null);
});

test('release workflow smoke installs and preserves a workspace on uninstall', () => {
  assert.match(workflow, /Smoke install, initialise workspace, and uninstall/);
  assert.match(workflow, /Uninstall removed the private workspace/);
});

test('package, installer and release notes use one beta version', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const installer = fs.readFileSync(new URL('../installer/Scout.iss', import.meta.url), 'utf8');
  assert.match(installer, new RegExp(`MyAppVersion "${pkg.version.replaceAll('.', '\\.')}"`));
  assert.equal(fs.existsSync(new URL(`../docs/releases/${pkg.version}.md`, import.meta.url)), true);
});
