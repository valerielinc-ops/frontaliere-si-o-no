/**
 * articles-sync-pin.mjs — the consistency token `sync-articles-sitemaps.yml` runs under.
 *
 * WHY THIS EXISTS (issue #5298)
 * ─────────────────────────────
 * That workflow writes TWO artifacts into ONE commit, and until this module they
 * came from two sources with different freshness:
 *
 *   - `pull-articles-corpus.mjs` cloned nanako at `--branch main`, i.e. whatever
 *     HEAD was at that instant — always current. It mirrors
 *     `packages/articles/content/`, and `services/routerBlogData.ts` /
 *     `services/routerSwissData.ts` are SYMLINKS into that directory. So the
 *     clone is what defines BLOG_SLUGS and SWISS_SLUGS.
 *   - `pull-articles-api.mjs` fetches `dist/api/`, which is GitHub Pages plus the
 *     R2/CDN copy in front of it, built by an EARLIER run of nanako's
 *     `publish-api.yml`. It writes the sitemaps.
 *
 * A publish landing between those two reads therefore committed a registry
 * describing corpus state N next to sitemaps describing state N-1, and
 * `tests/blog-slugs-sitemap-sync.test.ts` went red on every open branch with
 * nobody at fault. The tell that this was a race and not a defect is that the
 * SIGN inverted: slugs missing from the sitemap while the API lagged, sitemap
 * URLs missing from the registry once an article had been withdrawn upstream but
 * was still in the published surface. A stable defect does not change direction.
 *
 * The published surface already carries the token that closes this: `manifest.json`
 * has a `commit` field naming the exact corpus commit `build-api.mjs` read. Pin the
 * corpus clone to THAT commit and the two artifacts describe the same upstream
 * state by construction. The window is closed rather than tolerated.
 *
 * This is deliberately a fix at the WRITER, not at the reader. The issue body
 * proposes a temporal tolerance as the cheapest option, and one landed first in
 * tests/blog-slugs-sitemap-sync.test.ts: ignore entries newer than the opposing
 * producer's frontier. That suppresses the symptom at the cost of the gate's
 * whole purpose — a genuine #3012 / #3120 desync is indistinguishable, to a date
 * comparison, from an article still in transit, so anything recent enough stops
 * being checked. Closing the window here means the tolerance has no condition
 * left to excuse and can be retired; see that file's header for the criterion.
 *
 * THE PIN IS A FULL 40-CHAR SHA-1 and the check is strict, because the pin's only
 * job is to be the argument of `git fetch origin <sha>`: the protocol resolves
 * nothing shorter, so a short or truncated value is not a weaker pin, it is a
 * guaranteed skip that would read as "the mirror is behind".
 *
 * THE PROTOCOL between the two scripts:
 *   1. `pull-articles-corpus.mjs` resolves the commit from the manifest, checks
 *      the corpus out AT it, and publishes it as `ARTICLES_SYNC_COMMIT`.
 *   2. `pull-articles-api.mjs` re-reads the manifest (it needs it anyway) and
 *      asserts it still names the same commit. It does not, if a publish landed
 *      during the ~15k-file clone — and that is a real window, since nanako
 *      publishes every 10-20 minutes during generation hours.
 *   3. Either step failing to agree SKIPS the whole sync rather than committing
 *      half of it. Nothing is written, nothing is committed, and the next
 *      dispatch (or the 5:23/17:23 cron) retries against a settled surface.
 *
 * A SKIP EXITS 0 ON PURPOSE. It is not a failure — the previous commit keeps
 * serving and the state is consistent. Making it red would put the gate's own
 * flakiness back, one layer down. The cost of exiting 0 is that a mirror stuck
 * for good would be invisible, which is why every skip emits `::warning::` and
 * the workflow escalates N consecutive ones to an issue.
 */

import fs from 'node:fs';

/** Environment variable carrying the pin from one workflow step to the next. */
export const PIN_ENV = 'ARTICLES_SYNC_COMMIT';

/** Full SHA-1, lowercase hex. Nothing shorter is fetchable from the remote. */
export const COMMIT_RE = /^[0-9a-f]{40}$/;

/** `<sha>` if the value is a usable pin, else `null`. Never throws. */
export function normalizeCommit(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return COMMIT_RE.test(v) ? v : null;
}

/** The pin an earlier step published, or `null` when this step is the first. */
export function readPin(env = process.env) {
  return normalizeCommit(env[PIN_ENV]);
}

/**
 * May this step proceed, given the pin it inherited and what the API reports now?
 *
 * Three outcomes, and the two failing ones are deliberately distinguished because
 * they mean opposite things to whoever reads the run log:
 *
 *   - no usable commit  → the PUBLISHER is wrong (old build-api.mjs, truncated
 *     manifest, a placeholder). There is nothing to pin to and never will be
 *     until the corpus side is fixed.
 *   - moved             → the publisher is fine and FAST; we simply lost the
 *     race. Retrying is the whole remedy.
 */
export function pinVerdict({ pinned, manifestCommit }) {
  const commit = normalizeCommit(manifestCommit);
  if (!commit) {
    return {
      ok: false,
      kind: 'no-commit',
      reason:
        `the published manifest carries no usable commit (got ${JSON.stringify(manifestCommit)}); ` +
        'without it the corpus clone has nothing to pin to and the sitemaps would be ' +
        'committed next to a registry read from a different upstream state',
    };
  }
  const pin = normalizeCommit(pinned);
  if (pin && pin !== commit) {
    return {
      ok: false,
      kind: 'moved',
      reason:
        `the published API moved from ${pin} to ${commit} while this run was working; ` +
        `the corpus is already mirrored at ${pin}, so committing now would ship the ` +
        'exact registry/sitemap mismatch this pin exists to prevent',
      from: pin,
      to: commit,
    };
  }
  return { ok: true, commit };
}

/** Append `name=value` to a GitHub Actions file variable, when running in Actions. */
function appendActionsFile(envVar, name, value) {
  const file = process.env[envVar];
  if (!file) return false;
  // Single-line values only — every key this module writes is a sha, a boolean or
  // a one-line reason, and the heredoc form would only add a delimiter to collide
  // with. Newlines are folded rather than escaped so a multi-line git error can
  // never terminate the file's key/value framing.
  const flat = String(value).replace(/\s*\n\s*/g, ' ').trim();
  try {
    fs.appendFileSync(file, `${name}=${flat}\n`);
    return true;
  } catch {
    // Best effort: losing the hand-off is a skipped sync, not a corrupt commit.
    return false;
  }
}

/**
 * Publish the pin for the steps that follow.
 *
 * `$GITHUB_ENV` is the hand-off that matters (the next step reads it as
 * `ARTICLES_SYNC_COMMIT`); `$GITHUB_OUTPUT` is for the workflow's own reporting.
 * Outside Actions both are absent and this degrades to the log line, which is
 * what a local run wants anyway.
 */
export function publishPin(commit, { tag, log = console.log } = {}) {
  const pin = normalizeCommit(commit);
  if (!pin) throw new Error(`publishPin: ${JSON.stringify(commit)} is not a full sha`);
  appendActionsFile('GITHUB_ENV', PIN_ENV, pin);
  appendActionsFile('GITHUB_OUTPUT', 'articles-commit', pin);
  log(`[${tag}] pinned this sync to corpus commit ${pin}`);
  return pin;
}

/**
 * Record that this sync is being skipped, and why.
 *
 * `skipped=true` is what the workflow gates every later step on, so a skip can
 * never leave half the surface committed. The `::warning::` is the human-facing
 * half: a skipped run is GREEN, and a green run nobody looks at is precisely how
 * a mirror stuck for good would stay invisible.
 *
 * Does not exit — the caller owns its own cleanup (the corpus pull has a
 * multi-gigabyte temp clone to remove first).
 */
export function emitSkip(tag, reason, { log = console.warn } = {}) {
  log(`::warning::[${tag}] sync skipped, nothing written — ${reason}`);
  appendActionsFile('GITHUB_OUTPUT', 'skipped', 'true');
  appendActionsFile('GITHUB_OUTPUT', 'skip-reason', reason);
}
