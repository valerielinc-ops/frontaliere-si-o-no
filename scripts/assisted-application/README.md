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
   unless installed with `--headed`. It kills the run after 120 minutes and reports a failed run to the flow,
   as the workflow does. Finally it releases the lease with the outcome.
4. **Runner offline.** When a request is still pending after 20 minutes and no runner has a fresh heartbeat
   (10 minutes) from a Swiss exit, the sweep holds the order in `owner_takeover` with
   `portal:swiss_runner_offline` and e-mails the owner (once per round). There is no fallback to GitHub. A
   held submission retries through the queue on the connection-stop ladder (5 min, 30 min, then every
   2 h), so it resumes by itself once the runner is back. A held draft waits for «Riprendi automazione».

Nothing personal or secret is logged. The agent's `::add-mask::` lines are consumed by the runner, and every
value they name is struck out of the log, together with every Remote Config value.

### Install (on the Swiss Mac)

```bash
# from a site checkout on main with node_modules (a dedicated worktree is best: the runner fast-forwards it)
bash scripts/dev/install-swiss-runner.sh install --checkout /path/to/site-checkout
bash scripts/dev/install-swiss-runner.sh status
```

This writes `~/Library/LaunchAgents/ch.frontaliere.swiss-runner.plist`, which runs one cycle every 2 minutes
and at login. The log goes to `~/Library/Logs/frontaliere/swiss-runner.log`. The install needs
`~/.config/frontaliere/sa-frontaliere-ticino.json` (override with `SWISS_RUNNER_SA`), `node` in `PATH`, and
this Mac's Codex login in `~/.codex/auth.json`. Add `--headed` to see the Chrome window.

Before each cycle the runner fast-forwards the checkout to `origin/main`, but only when the checkout is on
`main` with no local changes. It never runs `npm install`: after a dependency change, update
`node_modules` by hand.

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
