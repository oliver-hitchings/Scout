import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');

test('phone layout keeps navigation scrollable and primary controls touch sized', () => {
  assert.match(html, /@media \(max-width:700px\)/);
  assert.match(html, /nav \{[^}]*overflow-x:auto/);
  assert.match(html, /nav button \{[^}]*min-height:44px/);
  assert.match(html, /\.setup-actions button \{[^}]*min-height:44px/);
});

test('phone layout constrains chat and strong-match arrival to the viewport', () => {
  assert.match(html, /\.chat-drawer \{ width:100vw/);
  assert.match(html, /\.scout-arrival \{[^}]*max-width:calc\(100vw - 8px\)/);
  assert.match(html, /\.chat-companion \.scout-bubble \{[^}]*max-width:calc\(100vw - 118px\)/);
});

test('chat drawer stays interactive when opened from the setup modal', () => {
  const setupZ = Number(html.match(/\.setup-overlay\s*\{[^}]*z-index:\s*(\d+)/s)?.[1]);
  const chatZ = Number(html.match(/\.chat-drawer\s*\{[^}]*z-index:\s*(\d+)/s)?.[1]);
  assert.ok(chatZ > setupZ, `expected chat drawer z-index ${chatZ} above setup overlay ${setupZ}`);
});
