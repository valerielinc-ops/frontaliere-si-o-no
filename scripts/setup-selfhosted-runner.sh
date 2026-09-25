#!/usr/bin/env bash
# One-shot bootstrap for a GitHub self-hosted runner on a fresh Ubuntu ARM64 VM
# (e.g. Oracle Cloud Always-Free Ampere A1). Purpose: run generate-article.yml
# from a NON-GitHub-Actions IP so GitHub Models PATs aren't IP-throttled and the
# multi-PAT rotation delivers full quota (see docs/SELFHOSTED-RUNNER.md).
#
# Idempotent-ish: safe to re-run; it reconfigures the runner.
#
# Usage (on the VM, as a sudo-capable non-root user):
#   REG_TOKEN=<runner-registration-token> \
#   REPO_URL=https://github.com/valerielinc-ops/frontaliere-si-o-no \
#   bash setup-selfhosted-runner.sh
#
# Get REG_TOKEN from: repo → Settings → Actions → Runners → New self-hosted
# runner (it's the token shown in the ./config.sh line; valid ~1h). Or via API:
#   gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token -q .token
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/valerielinc-ops/frontaliere-si-o-no}"
RUNNER_VERSION="${RUNNER_VERSION:-2.319.1}"
RUNNER_LABELS="${RUNNER_LABELS:-self-hosted,linux,arm64,article-gen}"
RUNNER_NAME="${RUNNER_NAME:-oracle-free-$(hostname | tr -dc 'a-z0-9')}"
WORKDIR="${WORKDIR:-$HOME/actions-runner}"

if [ -z "${REG_TOKEN:-}" ]; then
  echo "❌ REG_TOKEN not set. Get it from repo → Settings → Actions → Runners → New self-hosted runner." >&2
  exit 1
fi

arch="$(uname -m)"
case "$arch" in
  aarch64|arm64) RUNNER_ARCH="arm64" ;;
  x86_64)        RUNNER_ARCH="x64" ;;
  *) echo "❌ Unsupported arch: $arch" >&2; exit 1 ;;
esac

echo "▸ Installing prerequisites (Node 22, git, build tools, runner deps)…"
sudo apt-get update -y
sudo apt-get install -y curl git build-essential ca-certificates jq \
  libicu-dev liblttng-ust-dev libssl-dev   # .NET-based runner deps
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "  node $(node -v), npm $(npm -v)"

echo "▸ Downloading GitHub Actions runner v${RUNNER_VERSION} (${RUNNER_ARCH})…"
mkdir -p "$WORKDIR" && cd "$WORKDIR"
tarball="actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz"
if [ ! -f "$tarball" ]; then
  curl -fsSL -o "$tarball" \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${tarball}"
fi
tar xzf "$tarball"

echo "▸ Configuring runner '${RUNNER_NAME}' for ${REPO_URL} (labels: ${RUNNER_LABELS})…"
# --replace lets re-runs reuse the same name; --unattended for non-interactive.
./config.sh --url "$REPO_URL" --token "$REG_TOKEN" \
  --name "$RUNNER_NAME" --labels "$RUNNER_LABELS" \
  --work _work --unattended --replace

echo "▸ Installing + starting the runner as a systemd service…"
sudo ./svc.sh install "$(whoami)"
sudo ./svc.sh start
sudo ./svc.sh status || true

cat <<DONE

✅ Runner '${RUNNER_NAME}' is online with labels: ${RUNNER_LABELS}
   Verify: repo → Settings → Actions → Runners (should show 'Idle').

Next: the generation workflow targets this runner only when dispatched with
runner=self-hosted (or on its scheduled self-hosted path) — see
docs/SELFHOSTED-RUNNER.md. The default GitHub-hosted path keeps working as a
safety net, so nothing breaks if this VM is offline.

To stop/remove later:  cd ${WORKDIR} && sudo ./svc.sh stop && ./config.sh remove --token <removal-token>
DONE
