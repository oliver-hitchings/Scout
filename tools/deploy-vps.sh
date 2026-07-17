#!/usr/bin/env bash
set -Eeuo pipefail

tag=${1:-}
expected_commit=${2:-}
app_root=${SCOUT_VPS_APP_ROOT:-/home/ubuntu/apps/Scout}
workspace=${SCOUT_VPS_WORKSPACE:-/home/ubuntu/Documents/Scout Workspace}
service=${SCOUT_VPS_SERVICE:-scout-host.service}

if [[ ! $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$ ]]; then
  printf 'Refusing invalid Scout beta tag: %s\n' "$tag" >&2
  exit 2
fi
if [[ ! $expected_commit =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Expected release commit must be a full Git SHA.\n' >&2
  exit 2
fi
if [[ ! -d $app_root/.git || ! -f $workspace/workspace.json ]]; then
  printf 'Scout application checkout or separate workspace is missing.\n' >&2
  exit 2
fi
case "$workspace/" in
  "$app_root/"*) printf 'Scout workspace must remain outside the application checkout.\n' >&2; exit 2 ;;
esac
if [[ -n $(git -C "$app_root" status --porcelain --untracked-files=normal) ]]; then
  printf 'Refusing to deploy over a dirty Scout application checkout.\n' >&2
  exit 2
fi

remote=$(git -C "$app_root" remote get-url origin)
if [[ ! $remote =~ github\.com[:/]oliver-hitchings/Scout(\.git)?$ ]]; then
  printf 'Scout checkout has an unexpected origin.\n' >&2
  exit 2
fi
service_user=$(systemctl show "$service" --property=User --value)
if [[ $service_user != "$(id -un)" ]]; then
  printf 'Service %s must run as the deployment user, not %s.\n' "$service" "${service_user:-root}" >&2
  exit 2
fi
command -v tailscale >/dev/null
command -v curl >/dev/null
command -v npm >/dev/null

serve_before=$(mktemp)
serve_after=$(mktemp)
cleanup() { rm -f "$serve_before" "$serve_after"; }
trap cleanup EXIT
tailscale serve status --json >"$serve_before"

previous_commit=$(git -C "$app_root" rev-parse HEAD)
switched=0
rollback() {
  status=$?
  trap - ERR
  set +e
  if [[ $switched == 1 && $previous_commit != "$expected_commit" ]]; then
    printf 'Deployment failed; restoring Scout commit %s.\n' "$previous_commit" >&2
    git -C "$app_root" checkout --detach "$previous_commit"
    (cd "$app_root" && npm ci)
    sudo -n systemctl restart "$service"
  fi
  exit "$status"
}
trap rollback ERR

git -C "$app_root" fetch --force origin "refs/tags/$tag:refs/tags/$tag"
target_commit=$(git -C "$app_root" rev-parse "$tag^{commit}")
if [[ $target_commit != "$expected_commit" ]]; then
  printf 'Fetched tag %s resolves to %s, not workflow commit %s.\n' "$tag" "$target_commit" "$expected_commit" >&2
  exit 2
fi

git -C "$app_root" checkout --detach "$target_commit"
switched=1
version=${tag#v}
package_version=$(cd "$app_root" && node -p "require('./package.json').version")
if [[ $package_version != "$version" ]]; then
  printf 'Tag version and package version do not match.\n' >&2
  false
fi

(
  cd "$app_root"
  npm ci
  npm test
)

sudo -n systemctl restart "$service"
for attempt in {1..60}; do
  if systemctl is-active --quiet "$service"; then
    response=$(curl --fail --silent --show-error http://127.0.0.1:8459/api/app-info 2>/dev/null || true)
    if [[ -n $response ]] && node -e 'const info=JSON.parse(process.argv[1]); if(info.version!==process.argv[2]) process.exit(1)' "$response" "$version"; then
      break
    fi
  fi
  if [[ $attempt == 60 ]]; then
    printf 'Scout did not become healthy on 127.0.0.1:8459 with version %s.\n' "$version" >&2
    false
  fi
  sleep 2
done

tailscale serve status --json >"$serve_after"
if ! cmp --silent "$serve_before" "$serve_after"; then
  printf 'Tailscale Serve configuration changed during deployment.\n' >&2
  false
fi
node "$app_root/tools/scout.mjs" remote preflight --require-enabled

trap - ERR
printf 'Scout %s is healthy; workspace, provider homes and Tailscale Serve mapping were preserved.\n' "$version"
