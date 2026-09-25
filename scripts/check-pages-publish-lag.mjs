/**
 * check-pages-publish-lag.mjs — Watchdog for the deploy→PUBLISH gap.
 *
 * `deploy.yml` only BUILDS and uploads a `github-pages` artifact. A separate
 * workflow, `deploy-publish.yml` (triggered via `workflow_run` on deploy.yml
 * completion), does the actual `actions/deploy-pages` PUBLISH, under
 * `concurrency: { group: pages-deploy, cancel-in-progress: false }`. Per
 * GitHub's documented 1-running+1-pending cap for a concurrency group, a
 * burst of push-triggered build completions (bot articles, jobs-sync,
 * dist-history-append commits...) routinely supersedes/skips most pending
 * publish attempts before `actions/deploy-pages` ever runs — deploy-
 * starvation, the same failure class `deploy.yml`'s own `paths-ignore`
 * comment names and partially mitigates.
 *
 * Content is not permanently lost — a later successful publish carries every
 * earlier commit forward, since main is linear — but it can sit
 * built-and-not-yet-live for hours with zero visibility. That's exactly what
 * happened 2026-07-16: two published articles weren't visible for several
 * hours and only surfaced because a journalist personally asked, instead of
 * being caught by automation before anyone had to notice.
 *
 * ── THE SECOND FAILURE: THE QUEUE JAMS (added 2026-08-07) ─────────────────
 * Starvation above is self-limiting: the queue drains as soon as arrivals slow
 * down, and every superseded commit rides the next publish. The failure that
 * put `deploy-publish.yml` at 0 successes across 300 runs / ten days
 * (2026-08-01T20:25Z → 2026-08-07T05:40Z, last success 2026-07-27T22:15Z) is
 * not self-limiting, and this script reads IDENTICALLY in both cases — same
 * growing lag, same pending file list — which is why the distinction belongs
 * here. Two overlapping defects:
 *
 *   · `workflow_run: types: [completed]` fires for the build runs deploy.yml's
 *     own newest-wins lock CANCELS (121 of 141 builds per 48 h, #5251). Those
 *     runs skip every job, but a run joins its concurrency group BEFORE any
 *     job `if:` is evaluated, and an arrival into a full group (1 running +
 *     1 pending) cancels the PENDING member. No-op 31100260885 arrived
 *     12:10:14, killed queued publish 31100206740 at 12:10:15, then skipped at
 *     12:14:48: one second of work in exchange for a whole publish. Two thirds
 *     of everything entering the group was such a no-op.
 *   · nothing in that group had a deadline. A `deploy` job parked at the
 *     `github-pages` environment gate is not "running", so neither
 *     `timeout-minutes` nor the 360-min default applies — run 31118787881 sat
 *     in `waiting` 14 h with `wait_timer: 0`, no reviewers and no protection
 *     rules, and `cancel-in-progress: false` meant GitHub would never evict
 *     it. Run 31119921972 then sat pending 7 h 13 m without starting a job.
 *
 * The remedy, and why this script is not it: `.github/workflows/deploy-publish.yml`
 * routes no-op runs to a per-run concurrency group so only real publishes
 * contend, and `scripts/ci/unwedge-pages-deploy-queue.mjs` — run hourly by
 * pages-publish-lag-watchdog.yml immediately BEFORE this check — cancels runs
 * stuck in `waiting` and nothing else. Both are pinned by
 * tests/pages-deploy-queue-invariants.test.ts.
 *
 * The ordering is deliberate and does NOT mask anything: lag is measured from
 * the last SUCCESSFUL github-pages deployment, which a cancellation cannot
 * advance. So a wedge that has already cost hours still opens its issue on this
 * same tick, and only the following tick — once a publish has actually landed —
 * resolves it. If the lag issue reopens after an unwedge, the wedge is
 * recurring and the queue, not this watchdog, is where to look.
 *
 * This watchdog finds the last successful `github-pages` deployment (GitHub
 * Deployments API) and lists the files changed on `main` since that SHA. It
 * ignores exactly the paths `deploy.yml` itself ignores (parsed directly from
 * that file, not re-declared, so the two can never drift apart — AGENTS.md
 * #6). If real dist-affecting content has been waiting longer than the
 * threshold, it pages.
 *
 * TWO SIGNALS, deliberately different in kind (see DEFAULT_LAG_HOURS and
 * DEFAULT_STALLED_QUEUE_MINUTES below for the sizing of each):
 *   1. AGE — content pending for longer than the worst LEGITIMATE merge→live
 *      latency. Slow, tolerant, sized so a normally-serialized pipeline never
 *      trips it.
 *   2. STALLED QUEUE — content pending while the build pipeline shows no
 *      activity at all. Fast, and independent of how slow a *moving* pipeline
 *      happens to be.
 * They exist separately because "age of last publish" alone cannot tell
 * "slow but working" from "stopped": both look like a large age. Signal 2 is
 * what lets signal 1 be tolerant without going blind to a real stall.
 *
 * Exit code: non-zero if lag exceeds threshold; 0 otherwise (including on
 * inconclusive API results — fail open, matching the rest of this repo's
 * watchdogs: an indeterminate read must not page).
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { githubApiHeaders } from './lib/githubApiHeaders.mjs';
import { intFromEnv } from './lib/int-from-env.mjs';

const REPO = 'valerielinc-ops/frontaliere-si-o-no';
const API = 'https://api.github.com';

/**
 * DEFAULT_LAG_HOURS — sized ABOVE this system's worst LEGITIMATE merge→live
 * latency, with margin. NOT a round number picked by feel: a watchdog set
 * below the worst legitimate case fires when nothing is wrong, and a monitor
 * that flaps teaches everyone to ignore it. That is not a hypothetical here —
 * see the measured history at the bottom of this comment.
 *
 * ── The legitimate worst case, measured 2026-08-07 ──
 * Merge→live is a two-stage serialized pipeline:
 *   (a) `deploy.yml` BUILD, under `concurrency: pages-build-run`
 *       (cancel-in-progress: false). Builds run strictly one at a time — each
 *       run's first job starts within seconds of the previous run's last job
 *       finishing — so a merge waits out the in-flight build, then its own.
 *       Measured over the successful runs of the preceding 7 days (n=49),
 *       created→completed (queue wait + execution):
 *           p50 171 min · p90 251 min · p95 273 min · max 276 min
 *       Execution alone, from job timings: 111–166 min (median ~137).
 *   (b) `deploy-publish.yml` PUBLISH, under `concurrency: pages-deploy`.
 *       The 1-running+1-pending cap can drop a superseded publish entirely,
 *       which defers that content to the NEXT build's publish — one extra
 *       full build cycle, so up to +166 min. The publish tail itself
 *       (deployment created → success) is ~4 min, up to ~15 with the
 *       `actions/deploy-pages` 10-min polling cap (#987).
 * Worst legitimate total ≈ 276 + 166 + 15 = 457 min ≈ 7.6 h.
 *
 * NOTE the earlier informal estimate of "~2 h per deploy, so ~4 h worst case"
 * came from a single sample (06:08:03 → 08:13:41). That run was the FASTEST
 * of the window — the measured minimum, not the typical case. Do not re-derive
 * this threshold from one deploy.
 *
 * ── Cross-check against what actually fired ──
 * The 14 alert episodes this watchdog raised between 2026-07-17 and 2026-08-07
 * split cleanly by peak reported lag, with a wide empty band in the middle:
 *     250 · 252 · 255 · 258 · 264 · 273 · 306   ← every one self-resolved on
 *                                                  the next publish, no human
 *                                                  action: pure false alarms
 *     ⟨ no episode at all between 306 and 503 ⟩
 *     503 · 506 · 676 · 1013 · 1105 · 1745 · 4001  ← real multi-hour stalls
 * The modelled 457-min ceiling lands inside that empty band, which is the
 * point: two independent derivations — a queue model and three weeks of
 * outcomes — agree on where "legitimate" ends.
 *
 * ── The number ──
 * 9 h = 540 min ≈ 1.18× the modelled ceiling. Replayed over those 14 episodes
 * it suppresses 9 (all seven false alarms, plus the two 503/506-min ones that
 * sat barely above the envelope and also self-resolved) and still fires on
 * every episode ≥ 676 min. 10 h behaves identically on this history, so 9 h is
 * preferred: same noise suppression, one hour less blind.
 *
 * ── What this deliberately does NOT catch ──
 * A stall between ~7.6 h and 9 h is invisible to THIS signal. That is
 * acceptable only because of what it is: the pipeline still building and
 * publishing, merely having deferred this particular content. Nothing is lost
 * — main is linear, so the next successful publish carries it forward. The
 * dangerous case, a pipeline that has STOPPED, is caught much sooner and
 * independently of this number by DEFAULT_STALLED_QUEUE_MINUTES below.
 *
 * Kept as a fixed constant rather than derived from recent deploy durations
 * on purpose: a threshold that tracks the thing it measures cannot detect
 * that thing degrading — builds drifting from 2 h to 6 h would silently carry
 * the threshold up with them and the watchdog would never fire. A fixed
 * number also keeps the alerting semantics independent of a second API call
 * that can rate-limit or truncate. The build duration is stable enough
 * (p50 171 → p95 273 min) that a ceiling sized off p95 has ample headroom.
 * Re-measure if that spread changes, and update the figures above with it.
 */
const DEFAULT_LAG_HOURS = 9;

/**
 * DEFAULT_STALLED_QUEUE_MINUTES — the orthogonal signal, and the reason
 * DEFAULT_LAG_HOURS can afford to be tolerant.
 *
 * Content pending is only benign while the pipeline is actually chewing
 * through it. If dist-affecting files are waiting AND no `deploy.yml` run is
 * queued or in progress AND none has been active for this long, the build
 * pipeline is not merely slow, it has stopped — and that is worth paging at
 * once, whatever the content's age happens to be.
 *
 * 240 min: build runs are created every ~10 min at the median (p95 85 min,
 * p99 201 min over the 299 runs of the preceding 5 days), and a run in flight
 * counts as alive on its own, so 4 h of total silence is far outside normal
 * operation. Replayed hourly over those 5 days this condition was true at
 * exactly 3 ticks — all three inside the genuine 18.8 h publish stall of
 * 2026-08-06, none of them idle-period noise. It is additionally gated on
 * `pending > 0`, so a genuinely quiet main (no pushes, nothing to publish,
 * hence no builds) can never trip it.
 */
const DEFAULT_STALLED_QUEUE_MINUTES = 240;

// ── Pure logic (unit-tested; NO network/IO) ─────────────────────────

/**
 * Extract the `paths-ignore` glob list from deploy.yml's raw YAML text.
 * Deliberately NOT a full YAML parser: the block is a flat `- 'glob'` list
 * under a `paths-ignore:` key, and reading it as text keeps this script from
 * ever re-declaring (and drifting from) deploy.yml's own copy.
 * @param {string} yamlText
 * @returns {string[]}
 */
export function parsePathsIgnore(yamlText) {
  const lines = yamlText.split('\n');
  const startIdx = lines.findIndex((l) => /^\s*paths-ignore:\s*$/.test(l));
  if (startIdx === -1) return [];
  const globs = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    // Comments and blank lines sit BETWEEN entries in this block — each glob
    // carries its own rationale. Skipping them instead of stopping matters:
    // bailing on the first comment silently truncates the list, and every glob
    // after it (docs/**, .github/**, tests/**) stops being recognised as
    // ignorable, so unrelated commits start triggering full deploys. The
    // failure is invisible — the script still returns a plausible array.
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    const m = line.match(/^\s*-\s*'([^']+)'\s*$/);
    // A non-item, non-comment line means the block ended (next YAML key).
    if (!m) break;
    globs.push(m[1]);
  }
  return globs;
}

/**
 * Minimal glob → RegExp. A double-star crosses directories, a single `*`
 * does not (stops at `/`). A bare pattern with no `/` (e.g. `*.md`) matches
 * only at the repo root, mirroring deploy.yml's own documented intent (root
 * `*.md` vs a recursive `docs` glob, deliberately not a recursive `*.md` —
 * see that file's comment on why press-kit assets under public/ must stay
 * dist-bound).
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') {
      re += '[^/]*';
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * @param {string} filePath
 * @param {string[]} globs
 * @returns {boolean}
 */
export function isIgnoredPath(filePath, globs) {
  return globs.some((g) => globToRegExp(g).test(filePath));
}

/**
 * @param {string[]} changedFiles
 * @param {string[]} globs
 * @returns {string[]} files NOT covered by any ignore glob
 */
export function filterUnignored(changedFiles, globs) {
  return changedFiles.filter((f) => !isIgnoredPath(f, globs));
}

/**
 * The alerting decision, extracted from main() so the criterion is pinned by
 * unit tests instead of living only inside a network-bound code path.
 *
 * Order matters, twice over:
 *
 * 1. `pendingCount === 0` short-circuits everything. With nothing
 *    dist-affecting waiting, a large age just means main has been quiet, and a
 *    silent build queue is the correct state rather than a fault — neither
 *    signal may fire.
 * 2. When BOTH signals are true, the verdict is `stalled-queue`, not `lag`.
 *    They are not equally informative: a stopped build queue explains the age,
 *    so reporting `lag` would be reporting the symptom and hiding the cause.
 *    The two verdicts also route the on-call differently — `lag` says "the
 *    pipeline may still be moving, check the cadence", which is precisely the
 *    wrong first move when the queue has actually stopped. `stalled-queue` is
 *    the strictly more specific and more actionable of the two, so it wins.
 *
 * @param {object} o
 * @param {number} o.ageMinutes            age of the last successful publish
 * @param {number} o.pendingCount          dist-affecting files waiting
 * @param {number} o.lagHours              age threshold, hours
 * @param {number} [o.stalledQueueMinutes] build-silence threshold, minutes
 * @param {boolean} [o.buildInFlight]      a deploy.yml run is queued/in progress
 * @param {number|null} [o.buildIdleMinutes] minutes since the last deploy.yml
 *        activity, or null when unknown — an unreadable build history must not
 *        page (fail open), so null disables the stalled-queue signal only,
 *        leaving the age signal untouched.
 * @returns {{degraded: boolean, reason: 'lag'|'stalled-queue'|null}}
 */
export function evaluatePublishLag({
  ageMinutes,
  pendingCount,
  lagHours,
  stalledQueueMinutes = DEFAULT_STALLED_QUEUE_MINUTES,
  buildInFlight = false,
  buildIdleMinutes = null,
}) {
  if (pendingCount <= 0) return { degraded: false, reason: null };
  // Checked FIRST so it wins when both hold — see (2) above.
  if (!buildInFlight && buildIdleMinutes !== null && buildIdleMinutes > stalledQueueMinutes) {
    return { degraded: true, reason: 'stalled-queue' };
  }
  if (ageMinutes > lagHours * 60) return { degraded: true, reason: 'lag' };
  return { degraded: false, reason: null };
}

// ── Network (not unit-tested; exercised live) ───────────────────────

function authToken() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN required');
  return token;
}

async function ghJson(urlPath) {
  const res = await fetch(`${API}${urlPath}`, { headers: githubApiHeaders(authToken()) });
  if (!res.ok) throw new Error(`GitHub API ${urlPath} → HTTP ${res.status}`);
  return res.json();
}

/** Newest-first deployments; returns the first one whose latest status is `success`.
 * per_page=100 (API max) rather than a small window: during a prolonged
 * deploy-starvation stretch — the exact scenario this watchdog exists to
 * catch — the most recent records can all be non-success, and a narrow
 * window would fail-open (skip) instead of alerting. */
async function findLastSuccessfulDeployment() {
  const deployments = await ghJson(`/repos/${REPO}/deployments?environment=github-pages&per_page=100`);
  for (const d of deployments) {
    const statuses = await ghJson(`/repos/${REPO}/deployments/${d.id}/statuses?per_page=5`);
    if (statuses[0]?.state === 'success') {
      return { sha: d.sha, publishedAt: statuses[0].created_at };
    }
  }
  return null;
}

/** @returns {{ files: string[], truncated: boolean }} `truncated`: GitHub's
 * Compare API caps the `files` list at 300 entries — during a long
 * deploy-starvation stretch the real changed-file count can exceed that, so
 * callers must surface (not silently swallow) an undercount. */
async function getChangedFilesSince(baseSha, headRef) {
  const compare = await ghJson(`/repos/${REPO}/compare/${baseSha}...${headRef}`);
  return { files: (compare.files || []).map((f) => f.filename), truncated: Boolean(compare.files?.length === 300) };
}

/**
 * Is the BUILD half of the pipeline moving at all? Feeds the stalled-queue
 * signal (see DEFAULT_STALLED_QUEUE_MINUTES).
 *
 * `in_progress`/`queued` counts as alive on its own — a build legitimately
 * occupies the slot for ~2 h, and during that time the newest run's timestamps
 * stop advancing without anything being wrong.
 *
 * Returns `buildIdleMinutes: null` on any error or empty history, which
 * disables only this signal. Deliberately NOT throwing: this is a
 * later-added, secondary reading and it must never be able to turn a healthy
 * run into a crash-page via the workflow's "Alert on monitor crash" step.
 *
 * @returns {Promise<{buildInFlight: boolean, buildIdleMinutes: number|null}>}
 */
async function getBuildQueueState(nowMs) {
  try {
    const data = await ghJson(`/repos/${REPO}/actions/workflows/deploy.yml/runs?per_page=100`);
    const runs = data.workflow_runs || [];
    if (runs.length === 0) return { buildInFlight: false, buildIdleMinutes: null };
    const buildInFlight = runs.some((r) => r.status === 'in_progress' || r.status === 'queued');
    // Newest timestamp of any kind: a run that was just created is as much a
    // sign of life as one that just finished.
    const newest = Math.max(
      ...runs.flatMap((r) => [Date.parse(r.created_at), Date.parse(r.updated_at)]).filter((n) => Number.isFinite(n)),
    );
    if (!Number.isFinite(newest)) return { buildInFlight, buildIdleMinutes: null };
    return { buildInFlight, buildIdleMinutes: Math.round((nowMs - newest) / 60000) };
  } catch (err) {
    console.log(`⚠️ Could not read deploy.yml run history (${err.message}) — stalled-queue signal disabled this run.`);
    return { buildInFlight: false, buildIdleMinutes: null };
  }
}

// ── Orchestration ───────────────────────────────────────────────────

async function main() {
  const lagHours = intFromEnv('LAG_HOURS', DEFAULT_LAG_HOURS);

  const deployYmlPath = path.resolve(process.cwd(), '.github/workflows/deploy.yml');
  const globs = parsePathsIgnore(fs.readFileSync(deployYmlPath, 'utf8'));
  if (globs.length === 0) {
    console.log('⚠️ Could not parse paths-ignore from deploy.yml — skipping (fail open)');
    process.exit(0);
  }

  let last;
  let changed;
  let truncated;
  try {
    last = await findLastSuccessfulDeployment();
    if (!last) {
      console.log('⚠️ No successful github-pages deployment found in the last 100 — skipping (fail open)');
      process.exit(0);
    }
    ({ files: changed, truncated } = await getChangedFilesSince(last.sha, 'main'));
  } catch (err) {
    // The GitHub Deployments/Compare APIs can transiently error (e.g. a
    // freshly-pushed base SHA not yet indexed server-side, rate limits) —
    // an indeterminate read must not page, and it must not be mistaken for
    // the monitor itself being broken (see header comment + the workflow's
    // "Alert on monitor crash" step, which only fires when this script exits
    // non-zero with no `summary` output).
    console.log(`⚠️ GitHub API error while checking publish lag: ${err.message} — skipping (fail open)`);
    process.exit(0);
  }

  const nowMs = Date.now();
  const ageMinutes = Math.round((nowMs - Date.parse(last.publishedAt)) / 60000);
  const pending = filterUnignored(changed, globs);

  // Only worth an API call when something is actually waiting — with nothing
  // pending the stalled-queue signal cannot fire anyway.
  const { buildInFlight, buildIdleMinutes } =
    pending.length > 0 ? await getBuildQueueState(nowMs) : { buildInFlight: false, buildIdleMinutes: null };

  const thresholdMin = lagHours * 60;
  const queueState = buildInFlight
    ? 'a build is queued/in progress'
    : buildIdleMinutes === null
      ? 'unknown (build history unreadable)'
      : `no build activity for ${buildIdleMinutes} min`;

  console.log('── Pages publish-lag report ──');
  console.log(`Last successful publish: ${last.sha.slice(0, 10)} at ${last.publishedAt} (${ageMinutes} min ago)`);
  console.log(`Dist-affecting file(s) changed on main since then: ${pending.length} (of ${changed.length} total)`);
  console.log(`Build queue: ${queueState}`);
  if (truncated) {
    console.log('⚠️ Compare API capped the changed-file list at 300 — real pending count may be higher than reported.');
  }
  if (pending.length > 0) {
    console.log('Sample pending paths:');
    for (const f of pending.slice(0, 15)) console.log(`  - ${f}`);
  }
  console.log('────────────────────────────────');

  const { degraded, reason } = evaluatePublishLag({
    ageMinutes,
    pendingCount: pending.length,
    lagHours,
    stalledQueueMinutes: DEFAULT_STALLED_QUEUE_MINUTES,
    buildInFlight,
    buildIdleMinutes,
  });

  if (degraded) {
    const headline =
      reason === 'stalled-queue'
        ? `❌ DEGRADED (stalled queue) — ${pending.length} dist-affecting file(s) pending and no deploy.yml build activity for ${buildIdleMinutes} min (threshold ${DEFAULT_STALLED_QUEUE_MINUTES} min). The build pipeline has stopped, not merely slowed.`
        : `❌ DEGRADED (lag) — ${pending.length} dist-affecting file(s) built but not live for ${ageMinutes} min (threshold ${thresholdMin} min / ${lagHours}h).`;
    console.log(headline);
    if (process.env.GITHUB_OUTPUT) {
      const summary = [
        reason === 'stalled-queue'
          ? `Build queue STALLED: no deploy.yml run queued, in progress, or active for ${buildIdleMinutes} min (threshold ${DEFAULT_STALLED_QUEUE_MINUTES} min) while content is pending. The pipeline has stopped rather than slowed — check that pushes to main are still triggering deploy.yml.`
          : `Publish LAG: content pending longer than the worst legitimate merge->live latency.`,
        `Last successful GitHub Pages publish: ${last.sha.slice(0, 10)} at ${last.publishedAt} (${ageMinutes} min ago, threshold ${thresholdMin} min / ${lagHours}h).`,
        `Build queue at check time: ${queueState}.`,
        truncated ? '⚠️ Compare API capped the changed-file list at 300 — real pending count may be higher than reported.' : '',
        `${pending.length} dist-affecting file(s) changed on main since then and are NOT yet confirmed live:`,
        ...pending.slice(0, 20).map((f) => `- ${f}`),
        pending.length > 20 ? `...and ${pending.length - 20} more.` : '',
      ]
        .filter(Boolean)
        .join('\n')
        .split('"')
        .join("'")
        .split(String.fromCharCode(96))
        .join("'");
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `summary<<EOF_SUMMARY\n${summary}\nEOF_SUMMARY\n`);
    }
    process.exit(1);
  }

  console.log(
    `✅ HEALTHY — last publish ${ageMinutes} min ago, ${pending.length} dist-affecting file(s) pending (within threshold; ${queueState}).`,
  );
  process.exit(0);
}

const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[check-pages-publish-lag] Fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}
