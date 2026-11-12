# Assisted application runner

`agent.mjs` drafts (`--mode draft`) and sends (`--mode submit`) an assisted application. The Cloud Functions
(`functions/src/assistedApplicationAutomation.js`) ask for each run; normally the run is the GitHub workflow
`.github/workflows/assisted-application-agent.yml`.

## Swiss runner

Some portals refuse the application from GitHub's network: the portal stops on a regional notice and the
run reports `application_region_unsupported` (Yellowshark, order `1EpmkrDu`, November 2026). The portal
geolocates the runner's IP, not the candidate. Owner decision of 2026-11-11: such an order runs from a Mac in
Switzerland.

How the order gets there:

1. **Mark.** When the portal stops with `application_region_unsupported`, the state machine
   (`functions/src/assistedApplicationFlow.js`) writes `flow.egress = { required: 'ch', reason, round, at,
   source }` on the order's flow. The mark stays. A flow that was already held with
   `portal:application_region_unsupported` before the mark existed gets it on its next transition
   (`source: 'region_hold'`).
2. **Queue.** For a marked order, the `dispatch` effect
   (`functions/src/assistedApplicationAutomationEffects.js`) never calls GitHub. Instead it writes a request
   into `assisted_application_local_dispatch/{orderId}` (`mode`, `round`, `requestedAt`, and the idempotency
   `key = mode:rROUND:requestedAt`). The same key twice is one request. The Functions watchdog
   (`RUN_WATCHDOG_MS`) still applies: its new run is a new key.
3. **Runner.** `local-runner.mjs` first reads its network exit (`ipinfo.io/country`, then `ipapi.co`). When
   the exit is not `CH` it takes no work, and its heartbeat in `assisted_application_local_runners/{id}`
   says why. Otherwise it leases one request in a Firestore transaction, so the same order never has two
   runs at once. It closes as `stale` a request whose flow has moved on. Then it starts the workflow's Codex
   broker with this Mac's Codex login and runs `agent.mjs` with the workflow's variables. It uses the system
   Chrome when Playwright has no Chromium for the OS (macOS 13 with Playwright 1.63), and runs headless
   unless installed with `--headed`. While the run holds its lease, the runner reads the exit again with
   every heartbeat (each minute). If the exit turns non-Swiss, it stops the agent, reports the failed run and
   releases the lease, and the heartbeat says `eligible: false`. A probe that merely fails does not stop the
   run. It also kills the run after 120 minutes and reports a failed run to the flow, as the workflow does.
   Finally it releases the lease with the outcome.
4. **Crashed runner.** If a lease ends (140 minutes) without being released, it goes back to the queue. The
   next lease or the next sweep does this, keeping the request's original queue time.
5. **Runner offline.** When a request is still pending after 20 minutes and no runner has a fresh heartbeat
   (10 minutes) from a Swiss exit, the sweep holds the order in `owner_takeover` with
   `portal:swiss_runner_offline` and e-mails the owner (once per round). There is no fallback to GitHub. A
   held submission retries through the queue on the connection-stop ladder (5 min, 30 min, then every
   2 h), so it resumes by itself once the runner is back. A held draft waits for «Riprendi automazione».
   The hold takes two steps. The request becomes `expiring`, which no runner leases. Then the flow
   transition runs, and only after it does the request become `expired`. If the transition fails, the next
   sweep applies it again. If a runner is back online by then, the request returns to `pending`.

Nothing personal or secret is logged. The agent's `::add-mask::` lines are consumed by the runner, and every
value they name is struck out of the log, together with every Remote Config value.

### Install (on the Swiss Mac)

```bash
# from a site checkout on main (a dedicated worktree is best: the runner fast-forwards it)
bash scripts/dev/install-swiss-runner.sh install --checkout /path/to/site-checkout
bash scripts/dev/install-swiss-runner.sh status
```

This writes `~/Library/LaunchAgents/ch.frontaliere.swiss-runner.plist`, which runs one cycle every 2 minutes
and at login. The log goes to `~/Library/Logs/frontaliere/swiss-runner.log`. The install needs
`~/.config/frontaliere/sa-frontaliere-ticino.json` (override with `SWISS_RUNNER_SA`), `node` in `PATH`, and
this Mac's Codex login in `~/.codex/auth.json`. Add `--headed` to see the Chrome window.

The Swiss runner **never uses the checkout's shared `node_modules`**. The installer runs
`npm ci --ignore-scripts --no-audit --no-fund` for the root and `functions` lockfiles in private trees under
`~/.local/share/frontaliere/swiss-runner/root-deps/` and `functions-deps/`, keyed by each lockfile's SHA-256.
The checkout's two `node_modules` links point to those trees. It installs or verifies both private trees
before loading Firebase Admin. Before each lease, including after a
fast-forward to `origin/main`, the runner checks both lock hashes. If a lock changed, it installs and verifies
new trees first, then switches the links; a failed install leaves the prior links intact and the heartbeat
ineligible, so no order is leased. It also checks that the workflow agent entry point imports and, once for
each successful pair of dependency hashes, uploads and deletes a few random bytes under `diagnostics/` in the
assisted-application Storage bucket. Failed Storage probes keep the queue untouched and retry at most three
times for that dependency version, with a 1-minute then 5-minute backoff; after the final failure the runner
stays ineligible for that version until its dependency hashes change or the failed-probe state is cleared
after the Storage access problem is corrected.

Useful variables: `SWISS_RUNNER_CODEX_BIN` (a specific Codex CLI; default: the newest
`~/.codex/packages/standalone/releases/*/bin/codex`), `SWISS_RUNNER_BROKER_SOCKET` (reuse a broker that is
already running), `SWISS_RUNNER_CHROME`, `SWISS_RUNNER_ID`, `SWISS_RUNNER_STATE_DIR` (default
`~/.config/frontaliere/swiss-runner`: runner id and lock).

One cycle by hand: `GOOGLE_APPLICATION_CREDENTIALS=… node scripts/assisted-application/local-runner.mjs --once`.

### Turn it off

```bash
bash scripts/dev/install-swiss-runner.sh uninstall
```

Marked orders then wait in the queue. After 20 minutes the sweep holds them for the owner with
`portal:swiss_runner_offline`. They are never sent from GitHub.
