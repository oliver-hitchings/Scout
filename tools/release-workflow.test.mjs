import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { artifactNames } from './build-platform.mjs';
import { validateReleaseManifest } from '../ui/lib/releaseManifest.mjs';
import { compareVersions, packageName } from '../ui/lib/updates.mjs';

const CANDIDATE_VERSION = '0.1.0-beta.24-rc1';

const workflow = fs.readFileSync(
  new URL('../.github/workflows/windows-release.yml', import.meta.url),
  'utf8',
).replaceAll('\r\n', '\n');
const ci = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const workspaceRepair = fs.readFileSync(new URL('../.github/workflows/vps-workspace-repair.yml', import.meta.url), 'utf8');
const deploy = fs.readFileSync(new URL('./deploy-vps.sh', import.meta.url), 'utf8');
const supplyChain = fs.readFileSync(new URL('../docs/SUPPLY_CHAIN_SECURITY.md', import.meta.url), 'utf8');

test('tagged release workflow validates version and requires private markers', () => {
  assert.match(workflow, /Tag does not match package version/);
  assert.match(workflow, /--require-markers/);
  assert.match(workflow, /SCOUT_RELEASE_MARKERS/);
});

test('CI audits fork pull requests without exposing private release markers', () => {
  assert.doesNotMatch(ci, /pull_request_target/);
  assert.match(ci, /Audit staged public tree for fork pull requests[\s\S]*if: github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.repo\.full_name != github\.repository[\s\S]*--root dist\/release\/stage --stage\s/);
  assert.match(ci, /Audit staged public tree with required private markers[\s\S]*if: github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository[\s\S]*--require-markers[\s\S]*SCOUT_RELEASE_MARKERS: \$\{\{ secrets\.SCOUT_RELEASE_MARKERS \}\}/);
});

test('release publication has scoped write permission and publishes checksum', () => {
  assert.match(workflow, /publish:[\s\S]*permissions:\s*\n\s*contents: write/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /checksums\.txt/);
  const globalWrite = workflow.match(/^permissions:\s*\n\s*contents: write/m);
  assert.equal(globalWrite, null);
});

test('tagged releases keylessly attest and verify every checksum subject before publication', () => {
  assert.match(workflow, /publish:[\s\S]*permissions:[\s\S]*id-token: write/);
  assert.match(workflow, /publish:[\s\S]*permissions:[\s\S]*attestations: write/);
  assert.match(workflow, /uses: actions\/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d # v4[\s\S]*subject-checksums: release-assets\/checksums\.txt/);
  assert.match(workflow, /steps\.attest\.outputs\.bundle-path/);
  assert.match(workflow, /checksums\.intoto\.jsonl/);
  assert.match(workflow, /gh attestation verify/);
  assert.doesNotMatch(workflow, /COSIGN_(?:PRIVATE_KEY|PASSWORD)/);
});

test('privileged release jobs reject every mutable action reference', () => {
  const headings = [...workflow.matchAll(/^  ([a-z0-9-]+):\n/gm)];
  const jobs = headings.map((heading, index) => ({
    name: heading[1],
    body: workflow.slice(
      heading.index + heading[0].length,
      headings[index + 1]?.index ?? workflow.length,
    ),
  }));
  const privileged = jobs.filter(({ body }) => (
    /^\s{6}(?:contents|id-token|packages|attestations): write$/m.test(body)
  ));
  assert.deepEqual(privileged.map(({ name }) => name), ['publish']);
  for (const { name, body } of privileged) {
    const references = [...body.matchAll(/^\s+- uses:\s+([^\s#]+)(?:\s+#.*)?$/gm)]
      .map((match) => match[1]);
    assert.ok(references.length > 0, `${name} has no reviewed action references`);
    for (const reference of references) {
      assert.match(reference, /@[a-f0-9]{40}$/, `${name}: mutable action reference ${reference}`);
    }
  }
});

test('secret-bearing workspace repair rejects every mutable action reference', () => {
  const references = [...workspaceRepair.matchAll(/^\s+-?\s*uses:\s+([^\s#]+)(?:\s+#.*)?$/gm)]
    .map((match) => match[1]);
  assert.ok(references.length > 0);
  for (const reference of references) {
    assert.match(reference, /@[a-f0-9]{40}$/, `mutable action reference ${reference}`);
  }
});

test('every secret-bearing workflow pins all reusable actions to immutable commits', () => {
  const directory = new URL('../.github/workflows/', import.meta.url);
  const workflows = fs.readdirSync(directory)
    .filter((name) => /\.ya?ml$/i.test(name))
    .map((name) => ({ name, body: fs.readFileSync(new URL(name, directory), 'utf8') }))
    .filter(({ body }) => /\bsecrets\s*(?:\.|\[)/.test(body));
  assert.ok(workflows.length > 0, 'no secret-bearing workflows were checked');
  const mutable = [];
  for (const { name, body } of workflows) {
    const references = body.split(/\r?\n/)
      .map((line) => line.match(/^\s*(?:-\s*)?uses:\s*(.*?)\s*(?:#.*)?$/)?.[1])
      .filter(Boolean)
      .map((reference) => reference.replace(/^(['"])(.*)\1$/, '$2'));
    assert.ok(references.length > 0, `${name} has no reviewed action references`);
    for (const reference of references) {
      if (!/@[a-f0-9]{40}$/.test(reference)) mutable.push(`${name}: ${reference}`);
    }
  }
  assert.deepEqual(mutable, [], 'secret-bearing workflows must not use mutable action references');
});

test('release documentation defines checksum, keyless identity and platform-signing boundaries', () => {
  assert.match(supplyChain, /checksums\.intoto\.jsonl/);
  assert.match(supplyChain, /gh attestation verify/);
  assert.match(supplyChain, /--custom-trusted-root/);
  assert.match(supplyChain, /GitHub OIDC/);
  assert.match(supplyChain, /no long-lived (?:project )?signing key/i);
  assert.match(supplyChain, /rotation/i);
  assert.match(supplyChain, /revocation|compromised release/i);
  assert.match(supplyChain, /Authenticode/);
  assert.match(supplyChain, /Developer ID/);
  assert.match(supplyChain, /checksums? verify bytes.*not.*publisher identity/is);
  assert.match(supplyChain, /Scout-<version>-macos-<architecture>\.dmg/);
  assert.doesNotMatch(supplyChain, /Developer ID Installer/);
});

test('release workflow builds and smoke tests every supported platform', () => {
  assert.match(workflow, /windows-2022/); assert.match(workflow, /macos-15-intel/); assert.match(workflow, /macos-15/); assert.match(workflow, /ubuntu-22\.04/);
  assert.match(workflow, /build-platform\.mjs mac/); assert.match(workflow, /build-platform\.mjs linux/); assert.match(workflow, /preserve workspace/i);
});

test('release version selection reads dispatch and ref context only through environment values', () => {
  const step = workflow.match(/- name: Select and validate version[\s\S]*?(?=\n      - (?:name:|run:|uses:))/)?.[0] || '';
  assert.match(step, /REQUESTED_VERSION: \$\{\{ inputs\.version \}\}/);
  assert.match(step, /\$version = \$env:REQUESTED_VERSION/);
  assert.doesNotMatch(step, /\$version\s*=\s*['"]\$\{\{/);
  assert.doesNotMatch(step, /if\s*\(['"]\$\{\{/);
});

test('tagged release deploys the private VPS before publication', () => {
  assert.match(workflow, /deploy-vps:[\s\S]*environment: beta-vps/);
  assert.match(workflow, /tailscale\/github-action@306e68a486fd2350f2bfc3b19fcd143891a4a2d8 # v4/);
  assert.match(workflow, /oauth-secret: \$\{\{ secrets\.TS_OAUTH_SECRET \}\}/);
  assert.match(workflow, /tags: tag:scout-deploy/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /inputs\.deploy_vps/);
  assert.match(workflow, /inputs\.test_rollback/);
  assert.match(workflow, /--connect-timeout 5 --max-time 10/);
  assert.match(workflow, /status" != 000 && "\$status" != 403/);
  assert.match(workflow, /deployment tag must be denied by the tailnet or Scout/i);
  assert.match(workflow, /scout-deploy@"\$VPS_HOST"/);
  assert.doesNotMatch(workflow, /ubuntu@"\$VPS_HOST"/);
  assert.match(workflow, /publish:[\s\S]*needs: \[windows, macos, linux, deploy-vps\]/);
  assert.match(deploy, /status --porcelain --untracked-files=normal -- \. ':\(exclude\)\.scout-runtime\/\*\*'/);
  assert.match(deploy, /refs\/tags\/v\$version:refs\/tags\/v\$version/);
  assert.match(deploy, /refs\/heads\/codex\/release-candidate/);
  assert.match(deploy, /npm ci --omit=dev[\s\S]*npm test/);
  assert.match(deploy, /npm ci[\s\S]*npm test[\s\S]*systemctl restart/);
  assert.match(deploy, /127\.0\.0\.1:8459\/api\/app-info/);
  assert.match(deploy, /cmp --silent "\$serve_before" "\$serve_after"/);
  assert.match(deploy, /remote preflight --require-serve-mapping/);
  assert.match(deploy, /127\.0\.0\.1:8459\/api\/cv/);
  assert.match(deploy, /Array\.isArray\(index\.entries\)/);
  assert.match(deploy, /entry\?\.source === true/);
  assert.match(deploy, /SCOUT_VPS_DEPLOY_USER:-scout-deploy/);
  assert.match(deploy, /SCOUT_VPS_SERVICE_USER:-ubuntu/);
  assert.match(deploy, /property=ExecStart/);
  assert.match(deploy, /export PATH="\$\(dirname "\$service_node"\):\$PATH"/);
  assert.match(deploy, /Controlled rehearsal failure requested/);
  assert.match(deploy, /Rollback restored Scout/);
  assert.match(deploy, /if \[\[ \$switched == 1 \]\]; then[\s\S]*if \[\[ \$previous_commit != "\$expected_commit" \]\]; then[\s\S]*checkout --detach "\$previous_commit"[\s\S]*fi[\s\S]*npm ci --omit=dev[\s\S]*typst-runtime\.mjs install[\s\S]*typst-runtime\.mjs verify --compile[\s\S]*systemctl restart/);
  assert.doesNotMatch(deploy, /\$switched == 1 && \$previous_commit !=/);
  assert.doesNotMatch(deploy, /tailscale serve (?:reset|--bg|--https)/);
  assert.doesNotMatch(deploy, /Documents\/Scout Workspace.*(?:rm|git|npm)/);
});

test('VPS deployment script has valid Bash syntax', { skip: process.platform === 'win32' && 'Bash is checked on Linux and macOS release runners' }, () => {
  const result = spawnSync('bash', ['-n', fileURLToPath(new URL('./deploy-vps.sh', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('VPS dirty check permits only Scout managed Typst files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-deploy-status-'));
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  try {
    assert.equal(git('init').status, 0);
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    assert.equal(git('add', 'package.json').status, 0);
    assert.equal(git('-c', 'user.name=Scout Test', '-c', 'user.email=scout@example.invalid', 'commit', '-m', 'seed').status, 0);
    fs.mkdirSync(path.join(root, '.scout-runtime'));
    fs.writeFileSync(path.join(root, '.scout-runtime', 'typst'), 'managed');
    const status = () => git('status', '--porcelain', '--untracked-files=normal', '--', '.', ':(exclude).scout-runtime/**').stdout;
    assert.equal(status(), '');
    fs.writeFileSync(path.join(root, 'unexpected.txt'), 'private');
    assert.match(status(), /unexpected\.txt/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace repair is protected, local-only and verifies backup plus rendered CVs', () => {
  assert.match(workspaceRepair, /environment: beta-vps/);
  assert.match(workspaceRepair, /concurrency:[\s\S]*group: scout-beta-vps/);
  assert.match(workspaceRepair, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4/);
  assert.match(workspaceRepair, /tailscale\/github-action@306e68a486fd2350f2bfc3b19fcd143891a4a2d8 # v4/);
  assert.match(workspaceRepair, /StrictHostKeyChecking=yes/);
  assert.match(workspaceRepair, /127\.0\.0\.1:8459\/api\/sync\/deploy-key/);
  assert.match(workspaceRepair, /127\.0\.0\.1:8459\/api\/workspace\/adopt-private/);
  assert.match(workspaceRepair, /rotate-and-verify/);
  assert.match(workspaceRepair, /127\.0\.0\.1:8459\/api\/sync\/passphrase/);
  assert.match(workspaceRepair, /SCOUT_WORKSPACE_PASSPHRASE/);
  assert.match(workspaceRepair, /expected_cv_sources/);
  assert.match(workspaceRepair, /api\/cv\/render/);
  assert.match(workspaceRepair, /api\/sync\/status/);
  assert.doesNotMatch(workspaceRepair, /echo .*PASSPHRASE/);
});

test('package, installer and release notes use one beta version', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const installer = fs.readFileSync(new URL('../installer/Scout.iss', import.meta.url), 'utf8');
  const release = fs.readFileSync(new URL(`../docs/releases/${pkg.version}.md`, import.meta.url), 'utf8');
  assert.equal(pkg.name, 'scout-opportunity-finder');
  assert.equal(pkg.version, CANDIDATE_VERSION);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.match(installer, new RegExp(`MyAppVersion "${pkg.version.replaceAll('.', '\\.')}"`));
  assert.equal(fs.existsSync(new URL(`../docs/releases/${pkg.version}.md`, import.meta.url)), true);
  assert.match(release, new RegExp(`^# Scout ${pkg.version.replaceAll('.', '\\.')}$`, 'm'));
  assert.deepEqual(artifactNames(), {
    macArm: `Scout-${pkg.version}-macos-arm64.dmg`,
    macIntel: `Scout-${pkg.version}-macos-x64.dmg`,
    linuxDeb: `Scout-${pkg.version}-linux-x64.deb`,
    linuxTar: `Scout-${pkg.version}-linux-x64.tar.gz`,
  });
});

test('the requested candidate uses exact version-bound artifacts and signed metadata', () => {
  const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const manifest = { schemaVersion: 1, repository: 'oliver-hitchings/Scout', version: CANDIDATE_VERSION,
    artifacts: [{ name: `Scout-${CANDIDATE_VERSION}-windows-x64.exe`, bytes: 1, sha256: 'a'.repeat(64) }] };
  assert.doesNotThrow(() => validateReleaseManifest(manifest, version));
  for (const other of ['0.1.0-beta.23', '0.1.0-beta.24', '0.1.0-beta.24-rc2', '0.1.0']) {
    assert.throws(() => validateReleaseManifest(manifest, other), /version/);
  }
  for (const [platform, arch, suffix] of [['win32', 'x64', 'windows-x64.exe'], ['darwin', 'arm64', 'macos-arm64.dmg'], ['darwin', 'x64', 'macos-x64.dmg'], ['linux', 'x64', 'linux-x64.deb']]) {
    assert.equal(packageName(version, platform, arch), `Scout-${CANDIDATE_VERSION}-${suffix}`);
  }
  assert.ok(compareVersions(version, '0.1.0-beta.23') > 0);
  assert.ok(compareVersions(version, '0.1.0-beta.24') < 0);
  assert.ok(compareVersions(version, '0.1.0-beta.24-rc2') < 0);
});

test('the actual Windows workflow version guard accepts only the exact requested candidate tag', { skip: process.platform !== 'win32' }, (t) => {
  const step = workflow.match(/- name: Select and validate version[\s\S]*?(?=\n      - (?:name:|run:|uses:))/)?.[0];
  assert.ok(step, 'The real version-selection step is required');
  const script = step.slice(step.indexOf('        run: |') + '        run: |'.length).trimEnd()
    .split('\n').map((line) => line.replace(/^          /, '')).join('\n');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-candidate-version-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const output = path.join(temporary, 'github-output.txt');
  const run = (refName, requested = '') => {
    fs.writeFileSync(output, '');
    return spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'\n${script}`], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 15000,
      env: { ...process.env, REQUESTED_VERSION: requested, RELEASE_REF_TYPE: 'tag', RELEASE_REF_NAME: refName, GITHUB_OUTPUT: output },
    });
  };
  const accepted = run(`v${CANDIDATE_VERSION}`);
  assert.equal(accepted.status, 0, 'The requested candidate tag must pass the unchanged workflow version guard');
  assert.match(fs.readFileSync(output, 'utf8'), new RegExp(`value=${CANDIDATE_VERSION.replaceAll('.', '\\.')}\\s`));
  for (const refName of ['v0.1.0-beta.23', 'v0.1.0-beta.24', 'v0.1.0-beta.24-rc2', CANDIDATE_VERSION, `vv${CANDIDATE_VERSION}`]) {
    assert.notEqual(run(refName, CANDIDATE_VERSION).status, 0, 'A different tag must fail before packaging');
    assert.equal(fs.readFileSync(output, 'utf8'), '', 'A rejected tag cannot publish a selected version');
  }
});

test('candidate refs retain every artifact-upload, deployment and publication guard', () => {
  assert.equal(`v${CANDIDATE_VERSION}`.includes('-rc'), true);
  const uploads = [...workflow.matchAll(/uses: actions\/upload-artifact@/g)];
  const guardedUploads = [...workflow.matchAll(/- if: \$\{\{ !contains\(github\.ref_name, '-rc'\) \}\}\s+uses: actions\/upload-artifact@/g)];
  assert.equal(uploads.length, 3, 'All three platform artifact uploads are checked');
  assert.equal(guardedUploads.length, uploads.length, 'Every platform upload must exclude release-candidate refs');
  assert.match(workflow, /deploy-vps:[\s\S]*?if: \(startsWith\(github\.ref, 'refs\/tags\/'\) && !contains\(github\.ref_name, '-rc'\)(?: && [^\n]+)?\) \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.deploy_vps\)/);
  assert.match(workflow, /publish:[\s\S]*?if: startsWith\(github\.ref, 'refs\/tags\/'\) && !contains\(github\.ref_name, '-rc'\)/);
  const permits = (job, { refName = `v${CANDIDATE_VERSION}`, event = 'push', enrolled = 'true', deploy = false } = {}) => {
    const body = workflow.slice(workflow.indexOf(`  ${job}:\n`));
    const expression = body.match(/^    if: (.+)$/m)?.[1];
    assert.ok(expression, `${job} must have an explicit release guard`);
    return vm.runInNewContext(expression.replaceAll('needs.signing-readiness', "needs['signing-readiness']"), {
      github: { ref: event === 'workflow_dispatch' ? 'refs/heads/codex/release-candidate' : `refs/tags/${refName}`, ref_name: refName, event_name: event },
      needs: { 'signing-readiness': { outputs: { enrolled } } }, inputs: { deploy_vps: deploy },
      startsWith: (value, prefix) => value.startsWith(prefix), contains: (value, part) => value.includes(part),
    }, { timeout: 100 });
  };
  for (const job of ['deploy-vps', 'publish']) {
    for (const enrolled of ['true', 'false']) assert.equal(permits(job, { enrolled }), false, `${job} cannot run for the candidate tag`);
    assert.equal(permits(job, { refName: 'v0.1.0-beta.24' }), true, `${job} retains the approved non-candidate path`);
  }
  assert.equal(permits('deploy-vps', { event: 'workflow_dispatch', deploy: true }), true, 'Explicit protected manual rehearsal remains available');
  assert.equal(permits('deploy-vps', { event: 'workflow_dispatch' }), false);
  assert.equal(permits('publish', { event: 'workflow_dispatch', deploy: true }), false);
});

test('Windows setup uses the tracked Scout icon', () => {
  const installer = fs.readFileSync(new URL('../installer/Scout.iss', import.meta.url), 'utf8');
  assert.match(installer, /#define IconFile "\.\.\\ui\\assets\\scout-icon\.ico"/);
  assert.match(installer, /SetupIconFile=\{#IconFile\}/);
  assert.equal(fs.existsSync(new URL('../ui/assets/scout-icon.ico', import.meta.url)), true);
});
