import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { RELEASE_FILES } from './build-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectories = new Set(['.git', 'dist', 'node_modules']);

function markdownFiles(directory = root) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(absolute);
  }
  return files;
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function currentGuide(file) {
  const name = relative(file);
  return !name.startsWith('docs/releases/');
}

function markdownTargets(content) {
  const targets = [];
  const pattern = /!?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  for (const match of content.matchAll(pattern)) targets.push(match[1].replace(/^<|>$/g, ''));
  return targets;
}

function includedInRelease(name) {
  return RELEASE_FILES.some((entry) => {
    if (entry.tree) return name === entry.source || name.startsWith(`${entry.source}/`);
    return name === entry.source;
  });
}

test('all local Markdown links resolve', () => {
  const broken = [];
  for (const file of markdownFiles()) {
    const content = fs.readFileSync(file, 'utf8');
    for (const target of markdownTargets(content)) {
      if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
      const pathname = decodeURIComponent(target.split('#')[0]);
      if (!pathname) continue;
      const resolved = path.resolve(path.dirname(file), pathname);
      if (!fs.existsSync(resolved)) broken.push(`${relative(file)} -> ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('relative links in packaged Markdown stay inside the release bundle', () => {
  const missing = [];
  for (const file of markdownFiles().filter((item) => includedInRelease(relative(item)))) {
    const content = fs.readFileSync(file, 'utf8');
    for (const target of markdownTargets(content)) {
      if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
      const pathname = decodeURIComponent(target.split('#')[0]);
      if (!pathname) continue;
      const targetName = relative(path.resolve(path.dirname(file), pathname));
      if (!includedInRelease(targetName)) missing.push(`${relative(file)} -> ${target}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('current documentation has no completed hosting handoff or stale release labels', () => {
  assert.equal(fs.existsSync(path.join(root, 'REMOTE_HOSTING_TODO.md')), false);
  const findings = [];
  for (const file of markdownFiles().filter(currentGuide)) {
    const content = fs.readFileSync(file, 'utf8');
    if (/REMOTE_HOSTING_TODO\.md|codex\/beta13-release-candidate|Beta\.5\b|Beta 13(?:'s)?\b|0\.1\.0-beta\.13/i.test(content)) {
      findings.push(relative(file));
    }
  }
  assert.deepEqual(findings, []);
});

test('current documentation contains no common encoding or private-path leaks', () => {
  const findings = [];
  for (const file of markdownFiles().filter(currentGuide)) {
    const content = fs.readFileSync(file, 'utf8');
    if (/Ã.|Â.|â(?:€|†|€™)|�/.test(content)) findings.push(`${relative(file)}: encoding`);
    if (/[A-Z]:\\Users\\(?!YOUR_USER|USERNAME|user\b)[^\\\s]+\\/i.test(content)) findings.push(`${relative(file)}: user path`);
    if (/github\.com\/oliver-hitchings\/scout-workspace/i.test(content)) findings.push(`${relative(file)}: private repository`);
  }
  assert.deepEqual(findings, []);
});

test('maintainer instructions require documentation upkeep and privacy review', () => {
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md']) {
    const content = fs.readFileSync(path.join(root, name), 'utf8');
    assert.match(content, /docs\/DOCUMENTATION\.md|Documentation maintenance/i, name);
  }
  const policy = fs.readFileSync(path.join(root, 'docs', 'DOCUMENTATION.md'), 'utf8');
  assert.match(policy, /release notes, and in-app help text/i);
  assert.match(policy, /same pull request as the implementation/i);
  assert.match(policy, /private workspace data/i);
  assert.match(policy, /Do not create root-level TODO/i);
});
