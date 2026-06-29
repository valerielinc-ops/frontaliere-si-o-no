# Self-hosted runner for article generation (Oracle Cloud Always-Free)

## Why

GitHub Models (gpt-4o/4.1, Llama, Phi, Cohere — the top of the LLM cascade) is
rate-limited **by source IP** on GitHub-hosted Actions runners. The shared runner
IPs are saturated, so even fresh GitHub-account PATs get throttled there — proven
2026-06-22: the PATs return HTTP 200 (incl. 8-call bursts on gpt-4o) from a normal
IP, but every PAT (#1/#2/#3) hit "daily limit" inside a GitHub Actions run.

Running generation from a **non-Actions IP** removes that throttle, so the
GitHub Models PATs (and the multi-PAT rotation in `scripts/lib/ai-models.mjs`)
deliver their full separate quotas. A free cloud VM also lets us run **local
models** for $0 unlimited generation later.

## What you set up (≈20 min, $0)

### 1. Oracle Cloud Always-Free VM
- Sign up at <https://cloud.oracle.com> (free tier; a card is required for
  identity verification but Always-Free resources never charge).
- Create a Compute instance:
  - Shape: **Ampere A1 (ARM)** — Always-Free allows up to 4 OCPU / 24 GB RAM.
    2 OCPU / 12 GB is plenty; 4/24 lets you run local models too.
  - Image: **Ubuntu 22.04 (aarch64)**.
  - Add your SSH public key.
- After it boots, SSH in: `ssh ubuntu@<public-ip>`.

### 2. Get a runner registration token
Repo → **Settings → Actions → Runners → New self-hosted runner**. Copy the token
from the shown `./config.sh --url … --token <TOKEN>` line (valid ~1 h). Or:
```
gh api -X POST repos/valerielinc-ops/frontaliere-si-o-no/actions/runners/registration-token -q .token
```

### 3. Bootstrap the runner (one command on the VM)
```bash
curl -fsSL https://raw.githubusercontent.com/valerielinc-ops/frontaliere-si-o-no/main/scripts/setup-selfhosted-runner.sh -o setup.sh
REG_TOKEN=<token-from-step-2> bash setup.sh
```
This installs Node 22 + deps, downloads the GitHub Actions runner, registers it
with the `article-gen` label, and starts it as a systemd service. Verify it shows
**Idle** under Settings → Actions → Runners.

### 4. Flip generation onto the runner
Repo → **Settings → Secrets and variables → Actions → Variables** → add:
```
ARTICLE_RUNNER = self-hosted
```
From the next scheduled/self-triggered run, `generate-article.yml` runs on the VM
(`runs-on` resolves to `[self-hosted, article-gen]`). To test one run first
without the variable: dispatch with input `runner=self-hosted`.

To revert at any time: delete the `ARTICLE_RUNNER` variable → runs go back to
GitHub-hosted `ubuntu-latest`. Nothing breaks if the VM is offline *unless*
`ARTICLE_RUNNER=self-hosted` is set with no runner online (jobs would queue) — so
remove the variable if you tear the VM down.

## Local open-source LLM fallback ($0, no quota)

The model cascade in `scripts/lib/ai-models.mjs` ends with a **local** model
(`AI_MODELS.LOCAL_FALLBACK`, id `local/fallback`) pinned to the very bottom of
every chain (`sortChainByScore`) and reached **only when every remote free-tier
provider is daily-exhausted** — the recurring `tutti i modelli AI gratuiti
esauriti` defer that drops frontaliere production to 0 for that window. It serves
an open-source model (default **Qwen2.5 7B**) via a local OpenAI-compatible
server, so generation keeps producing at $0 with no API quota.

**Activation (opt-in, off by default):** set the repo variable
`ARTICLE_LOCAL_FALLBACK=1`. Optionally `ARTICLE_LOCAL_MODEL` (default
`qwen2.5:7b`; use `qwen2.5:3b` for a faster/lighter CPU run). `generate-article.yml`
then installs ollama, caches the model (`~/.ollama/models`), serves it, and
exports `LOCAL_LLM_ENABLED=1` + `LOCAL_LLM_URL` + `LOCAL_LLM_MODEL` for that run.

- Works on the **GitHub-hosted** runner (public repo → free minutes; CPU
  inference is slow, ~minutes/article, but it is the last resort) **and** on the
  self-hosted Oracle VM (faster, model stays warm).
- `ai-models.mjs` env knobs: `LOCAL_LLM_ENABLED`, `LOCAL_LLM_URL` (default
  `http://127.0.0.1:8080/v1/chat/completions` for a llama.cpp `--server`),
  `LOCAL_LLM_MODEL`, `LOCAL_LLM_TIMEOUT_MS` (default 600000), `LOCAL_LLM_API_KEY`.
- **Inert unless enabled:** without the variable nothing is installed and
  `LOCAL_LLM_ENABLED` stays unset → `isModelAvailable('local/fallback')` is
  `false` → the model is skipped exactly as today. To revert: delete the variable.

## Notes
- The GitHub-hosted path stays the default + safety net; the variable is the only
  switch.
- The runner only needs to be online; the workflow's own `actions/setup-node` +
  `npm ci` handle the toolchain each run.
- Firebase RC secrets still load the same way (the runner inherits no repo
  secrets by itself; the workflow's "Load secrets from Remote Config" step runs
  as usual, needing the Firebase SA — already provided via the workflow).
- Security: a self-hosted runner executes workflow code. This repo is private and
  only trusted workflows target the runner, which is the supported model. Keep the
  VM patched; the runner auto-updates.
