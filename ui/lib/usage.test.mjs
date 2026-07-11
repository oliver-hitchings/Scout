import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeUsageFromLines, codexUsageFromLines, readUsage } from './usage.mjs';

const NOW = Date.parse('2026-07-10T12:00:00Z');
const line = (hoursAgo, input, output) => JSON.stringify({
  timestamp: new Date(NOW - hoursAgo * 3600 * 1000).toISOString(),
  message: { usage: { input_tokens: input, output_tokens: output } },
});

test('claude usage sums 5h and 7d windows separately', () => {
  const lines = [
    line(1, 100, 50),        // in both windows
    line(6, 1000, 0),        // week only
    line(24 * 8, 99999, 0),  // too old - excluded
    'garbage not json',
    JSON.stringify({ timestamp: 'bad', message: { usage: { input_tokens: 5, output_tokens: 5 } } }),
  ];
  const u = claudeUsageFromLines(lines, NOW);
  assert.equal(u.fiveHourTokens, 150);
  assert.equal(u.weekTokens, 1150);
  assert.equal(u.approximate, true);
});

test('codex usage takes the latest rate_limits snapshot', () => {
  const lines = [
    JSON.stringify({ payload: { type: 'token_count', rate_limits: { primary: { used_percent: 10, window_minutes: 300, resets_in_seconds: 100 } } } }),
    'not json',
    JSON.stringify({ payload: { rate_limits: {
      primary: { used_percent: 42.5, window_minutes: 300, resets_in_seconds: 900 },
      secondary: { used_percent: 7, window_minutes: 10080, resets_in_seconds: 50000 },
    } } }),
  ];
  const u = codexUsageFromLines(lines);
  assert.equal(u.primary.usedPercent, 42.5);
  assert.equal(u.secondary.windowMinutes, 10080);
  assert.equal(u.approximate, true);
});

test('codex usage without snapshots is unknown', () => {
  assert.deepEqual(codexUsageFromLines(['{}', 'junk']), { unknown: true });
});

test('readUsage degrades to unknown when dirs are missing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-usage-'));
  const u = readUsage(home, NOW);
  assert.deepEqual(u.claude, { unknown: true });
  assert.deepEqual(u.codex, { unknown: true });
  assert.equal(u.checkedAt, new Date(NOW).toISOString());
});

test('readUsage reads real files under both trees', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-usage-'));
  const cdir = path.join(home, '.claude', 'projects', 'proj-a');
  fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, 's1.jsonl'), `${line(1, 200, 100)}\n`);
  const xdir = path.join(home, '.codex', 'sessions', '2026', '07', '10');
  fs.mkdirSync(xdir, { recursive: true });
  fs.writeFileSync(path.join(xdir, 'rollout-1.jsonl'), `${JSON.stringify({
    payload: { rate_limits: { primary: { used_percent: 55, window_minutes: 300, resets_in_seconds: 60 } } },
  })}\n`);
  const u = readUsage(home, NOW);
  assert.equal(u.claude.fiveHourTokens, 300);
  assert.equal(u.codex.primary.usedPercent, 55);
});
