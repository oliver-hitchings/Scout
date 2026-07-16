import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function read(relative) { return fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8'); }

const guide = read('docs/PRIVATE_REMOTE_ACCESS.md');
const todo = read('REMOTE_HOSTING_TODO.md');

test('public guides explain optional owner-only hosting and recovery boundaries', () => {
  for (const file of ['README.md', 'docs/QUICK_START.md', 'docs/INSTALL_WINDOWS.md', 'docs/INSTALL_MACOS.md', 'docs/INSTALL_LINUX.md']) {
    assert.match(read(file), /Private Remote Access|private remote/i, file);
  }
  for (const phrase of ['non-commercial', '127.0.0.1:8459', 'tagged devices', 'Add to Home Screen', 'Offline editing is not supported', 'next message start']) {
    assert.match(guide, new RegExp(phrase, 'i'));
  }
  assert.match(guide, /must be awake/);
  assert.match(guide, /never runs `tailscale serve reset`/);
  assert.match(guide, /scout remote preflight --require-enabled/);
  assert.match(guide, /does not print the configured owner login or any provider credentials/);
});

test('manual macOS and Linux startup instructions are supervised and user scoped', () => {
  const mac = read('docs/INSTALL_MACOS.md');
  assert.match(mac, /LaunchAgents/);
  assert.match(mac, /launchctl bootstrap gui\/\$\(id -u\)/);
  assert.match(mac, /KeepAlive/);
  const linux = read('docs/INSTALL_LINUX.md');
  assert.match(linux, /systemd\/user\/scout-host\.service/);
  assert.match(linux, /Restart=on-failure/);
  assert.match(linux, /systemctl --user enable --now/);
  assert.match(linux, /Do not enable user lingering/);
});

test('maintainer checklist keeps live acceptance and the beta.11 release separate', () => {
  assert.match(read('README.md'), /REMOTE_HOSTING_TODO\.md/);
  for (const phrase of ['gh auth login', 'mobile data', 'different Tailscale user', 'within 90 seconds', 'unrelated Tailscale Serve mapping', 'separate beta.11 version']) {
    assert.match(todo, new RegExp(phrase, 'i'));
  }
  assert.match(todo, /validation artifact only/);
});
