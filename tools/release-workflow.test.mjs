import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const workflow = fs.readFileSync(new URL('../.github/workflows/windows-release.yml', import.meta.url), 'utf8');
const deploy = fs.readFileSync(new URL('./deploy-vps.sh', import.meta.url), 'utf8');

test('tagged release workflow validates version and requires private markers', () => {
  assert.match(workflow, /Tag does not match package version/);
  assert.match(workflow, /--require-markers/);
  assert.match(workflow, /SCOUT_RELEASE_MARKERS/);
});

test('release publication has scoped write permission and publishes checksum', () => {
  assert.match(workflow, /publish:[\s\S]*permissions:\s*\n\s*contents: write/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /checksums\.txt/);
  const globalWrite = workflow.match(/^permissions:\s*\n\s*contents: write/m);
  assert.equal(globalWrite, null);
});

test('release workflow builds and smoke tests every supported platform', () => {
  assert.match(workflow, /windows-2022/); assert.match(workflow, /macos-15-intel/); assert.match(workflow, /macos-15/); assert.match(workflow, /ubuntu-22\.04/);
  assert.match(workflow, /build-platform\.mjs mac/); assert.match(workflow, /build-platform\.mjs linux/); assert.match(workflow, /preserve workspace/i);
});

test('tagged release deploys the private VPS before publication', () => {
  assert.match(workflow, /deploy-vps:[\s\S]*environment: beta-vps/);
  assert.match(workflow, /tailscale\/github-action@v4/);
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
  assert.match(deploy, /status --porcelain --untracked-files=normal/);
  assert.match(deploy, /refs\/tags\/v\$version:refs\/tags\/v\$version/);
  assert.match(deploy, /refs\/heads\/codex\/release-candidate/);
  assert.match(deploy, /npm ci --omit=dev[\s\S]*npm test/);
  assert.match(deploy, /npm ci[\s\S]*npm test[\s\S]*systemctl restart/);
  assert.match(deploy, /127\.0\.0\.1:8459\/api\/app-info/);
  assert.match(deploy, /cmp --silent "\$serve_before" "\$serve_after"/);
  assert.match(deploy, /remote preflight --require-serve-mapping/);
  assert.match(deploy, /127\.0\.0\.1:8459\/api\/cv/);
  assert.match(deploy, /Array\.isArray\(index\.entries\)/);
  assert.match(deploy, /SCOUT_VPS_DEPLOY_USER:-scout-deploy/);
  assert.match(deploy, /SCOUT_VPS_SERVICE_USER:-ubuntu/);
  assert.match(deploy, /property=ExecStart/);
  assert.match(deploy, /export PATH="\$\(dirname "\$service_node"\):\$PATH"/);
  assert.match(deploy, /Controlled rehearsal failure requested/);
  assert.match(deploy, /Rollback restored Scout/);
  assert.doesNotMatch(deploy, /tailscale serve (?:reset|--bg|--https)/);
  assert.doesNotMatch(deploy, /Documents\/Scout Workspace.*(?:rm|git|npm)/);
});

test('VPS deployment script has valid Bash syntax', { skip: process.platform === 'win32' && 'Bash is checked on Linux and macOS release runners' }, () => {
  const result = spawnSync('bash', ['-n', fileURLToPath(new URL('./deploy-vps.sh', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('package, installer and release notes use one beta version', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const installer = fs.readFileSync(new URL('../installer/Scout.iss', import.meta.url), 'utf8');
  assert.match(installer, new RegExp(`MyAppVersion "${pkg.version.replaceAll('.', '\\.')}"`));
  assert.equal(fs.existsSync(new URL(`../docs/releases/${pkg.version}.md`, import.meta.url)), true);
});

test('Windows setup uses the tracked Scout icon', () => {
  const installer = fs.readFileSync(new URL('../installer/Scout.iss', import.meta.url), 'utf8');
  assert.match(installer, /SetupIconFile=\.\.\\ui\\assets\\scout-icon\.ico/);
  assert.equal(fs.existsSync(new URL('../ui/assets/scout-icon.ico', import.meta.url)), true);
});
