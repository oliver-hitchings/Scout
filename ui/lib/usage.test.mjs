import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeUsageFromLines, codexUsageFromLines, readUsage, windowLabel } from './usage.mjs';

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

const AT = Date.parse('2026-07-22T12:00:00.000Z');
const claudeLine = (model, minutesAgo, tokens) => JSON.stringify({
  timestamp: new Date(AT - minutesAgo * 60000).toISOString(),
  message: { model, usage: { input_tokens: tokens, output_tokens: 0, cache_creation_input_tokens: 0 } },
});

test('Claude usage is split per model for spend, keeping account totals intact', () => {
  const usage = claudeUsageFromLines([
    claudeLine('claude-opus-4-8', 30, 1000),
    claudeLine('claude-opus-4-8', 60 * 24, 2000),
    claudeLine('claude-sonnet-5', 60, 500),
  ], AT);
  assert.equal(usage.fiveHourTokens, 1500);
  assert.equal(usage.weekTokens, 3500);
  // Heaviest weekly spend first.
  assert.deepEqual(usage.byModel, [
    { model: 'claude-opus-4-8', fiveHourTokens: 1000, weekTokens: 3000 },
    { model: 'claude-sonnet-5', fiveHourTokens: 500, weekTokens: 500 },
  ]);
});

test('Claude turns without a recorded model still count towards the account total', () => {
  const line = JSON.stringify({
    timestamp: new Date(AT - 60000).toISOString(),
    message: { usage: { input_tokens: 700, output_tokens: 0 } },
  });
  const usage = claudeUsageFromLines([line], AT);
  assert.equal(usage.fiveHourTokens, 700);
  assert.deepEqual(usage.byModel, []);
});

test('each limit window is labelled from its own length', () => {
  assert.equal(windowLabel(300), '5-hour');
  assert.equal(windowLabel(10080), 'weekly');
  assert.equal(windowLabel(1440), 'daily');
  assert.equal(windowLabel(null), 'current window');
  assert.equal(windowLabel(0), 'current window');
});

test('a weekly primary window is not reported as a five-hour window', () => {
  const line = JSON.stringify({
    rate_limits: {
      primary: { used_percent: 100, window_minutes: 10080, resets_in_seconds: 3600 },
      secondary: null,
      plan_type: 'plus',
    },
  });
  const usage = codexUsageFromLines([line], AT);
  assert.equal(usage.primary.label, 'weekly');
  assert.equal(usage.primary.usedPercent, 100);
  assert.equal(usage.primary.resetsAt, new Date(AT + 3600 * 1000).toISOString());
  assert.equal(usage.planType, 'plus');
  assert.equal(usage.windows.length, 1);
});

test('Codex usage stays unknown when no rate limits were recorded', () => {
  assert.equal(codexUsageFromLines(['{"not":"rate limits"}'], AT).unknown, true);
});
