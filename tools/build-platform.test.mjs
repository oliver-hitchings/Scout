import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artifactNames } from './build-platform.mjs';
test('cross-platform artifacts are versioned and architecture-specific', () => {
  assert.deepEqual(artifactNames('1.2.3-beta.1'), {
    macArm: 'Scout-1.2.3-beta.1-macos-arm64.dmg', macIntel: 'Scout-1.2.3-beta.1-macos-x64.dmg',
    linuxDeb: 'Scout-1.2.3-beta.1-linux-x64.deb', linuxTar: 'Scout-1.2.3-beta.1-linux-x64.tar.gz',
  });
});
