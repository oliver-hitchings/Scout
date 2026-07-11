import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskXml } from './scheduler.mjs';

test('scheduled task is catch-up enabled, non-overlapping and time limited', () => {
  const xml = taskXml({ command: 'node.exe', args: ['tools/scout.mjs', 'scan'], workingDirectory: 'C:\\Scout', time: '07:30', userId: 'user' });
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<ExecutionTimeLimit>PT45M<\/ExecutionTimeLimit>/);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
});

test('scheduled task rejects invalid times', () => {
  assert.throws(() => taskXml({ command: 'node', workingDirectory: '.', time: '25:00' }), /HH:MM/);
});
