import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(fs.readFileSync(new URL('./manifest.webmanifest', import.meta.url), 'utf8'));
const worker = fs.readFileSync(new URL('./service-worker.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');

test('Scout exposes installable home-screen metadata', () => {
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.ok(manifest.icons.some((icon) => icon.src === '/assets/scout-icon.png'));
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /apple-mobile-web-app-capable/);
});

test('service worker caches shell assets but never private APIs or workspace content', () => {
  assert.match(worker, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(worker, /request\.method !== 'GET'/);
  assert.doesNotMatch(worker, /\/api\/[a-z-]+['"]/);
  assert.doesNotMatch(worker, /data\/chats|reports|\/cv\//);
  assert.match(html, /Offline editing is not supported/);
});
