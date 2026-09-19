#!/usr/bin/env node
// scripts/ci/assert-articles-sync-delivered.mjs — a green sync must have
// DELIVERED, not merely have pulled.
//
// THE INCIDENT THIS CLOSES
// ────────────────────────
// sync-articles-sitemaps.yml reported `success` on eight consecutive
// repository_dispatch runs on 2026-09-19 (35414176623 01:56Z through
// 35420916144 04:18Z) while committing nothing. In the last of them
// `pull-articles-corpus.mjs` printed, verbatim:
//
//   [pull-articles-corpus] svizzera: 2157 → 2194 articles (+37 new)
//   [pull-articles-corpus] frontaliere: 3903 → 3921 articles (+18 new)
//
// and then `human-side-effect-gate` answered
// `DENY (publisher-source-run-unverified)`, so `Commit if changed` — which
// states the side-effect condition verbatim, as every writer step in this repo
// must — never ran. 55 articles were fetched into the runner's working tree and
// thrown away with the runner. The job still exited 0.
//
// The only actor that noticed was a DIFFERENT workflow:
// rerender-article-hubs.yml's freshness cross-check refused to push a 2157-item
// archive over a live 2194-item one (run 35423187532, `37 behind, tolerance
// 25`). A guard in the consumer is the wrong place to learn that the producer
// silently produced nothing.
//
// #9141 fixed THAT denial (the verifier admitted only an unreachable
// status/conclusion pair) and made a withheld permission set `skipped=true` so
// the escalation could fire. This step is the class guard underneath both: it
// asks the one question neither the gate nor the escalation asks — is the
// corpus this run pulled now ON main? — and it asks it of the committed tree,
// so no future skip, denial or committed-nothing path can answer it by
// assertion.
//
// WHY THE WORKING TREE AGAINST `HEAD`, and not against the published manifest:
// a manifest comparison is the rerender guard's job and needs a tolerance for
// transit (articles published between the pull and the read). This one needs
// none. The pull has already run; whatever it wrote is either in `HEAD` or it
// is lost. The residue is therefore exact, and a clean verdict here is a fact
// about bytes on main rather than about a count fetched over HTTP.
//
// It reports the residue per section in ARTICLES, the same unit the rerender
// guard and the pull's own log use, so the three numbers are comparable in a
// triage that spans all three.
//
// DELIBERATELY NOT `always()` in the workflow: when an earlier step already
// failed the job is red and this adds nothing but a second, more confusing
// cause. The failure mode it exists for is a job that is otherwise GREEN.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import {
  ARTICLE_REGISTRY_FILES,
  ARTICLE_SECTION_KEYS,
  readSlugRegistryWithRows,
} from '../lib/article-slug-registry.mjs';

const LOG = '[assert-articles-sync-delivered]';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY_DIR = 'packages/articles/content';

/**
 * The verdict, as a pure function of the measured residue.
 *
 * `pendingBySection` maps a section to the article IDS the working tree carries
 * and `HEAD` does not.
 *
 * IDENTITIES, NOT A NET COUNT. The first draft subtracted row counts and
 * ignored negatives, and review caught what that hides: the corpus retires
 * articles as well as adding them (`pinRetiredLocaleGroups`,
 * `scripts/lib/corpus-removal-guard.mjs`), so one new slug arriving alongside
 * one retirement nets to ZERO and a replacement nets to zero too. Both would
 * have passed as delivered with the new article absent from `main` — the exact
 * silent un-publish this guard exists to catch, reintroduced by the arithmetic.
 * A set difference cannot net out: a removal simply is not in it.
 */
export function deliveryVerdict({ pendingBySection = {}, skipReason = '' } = {}) {
  const undelivered = Object.entries(pendingBySection)
    .map(([section, ids]) => [section, [...new Set(ids ?? [])].sort()])
    .filter(([, ids]) => ids.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  if (undelivered.length === 0) {
    return { ok: true, message: `${LOG} every article this run pulled is committed — no residue` };
  }

  const total = undelivered.reduce((sum, [, ids]) => sum + ids.length, 0);
  const detail = undelivered
    .map(([section, ids]) => `${section} +${ids.length} (${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', …' : ''})`)
    .join(', ');
  const reason = skipReason.trim()
    ? `Reason recorded by the gate: ${skipReason.trim()}`
    : 'The gate recorded no skip reason, so the commit step itself delivered nothing — '
      + 'start from `Commit if changed` and `scripts/lib/git-push-with-retry.sh`.';

  return {
    ok: false,
    message:
      `${LOG} this run pulled ${total} article(s) it never committed (${detail}). ${reason}\n`
      + `${LOG} refusing to report success: a green run that delivers nothing is what let this `
      + 'checkout fall 37 articles behind the published corpus, which only '
      + 'rerender-article-hubs.yml noticed, by refusing to push the stale archive (issue #6650).',
  };
}

/**
 * Article ids present in the working tree's registry and absent from `HEAD`'s,
 * per section.
 *
 * `ARTICLE_REGISTRY_FILES` names each registry by its `services/` path — the
 * SPA's own copy, which this workflow does not touch. The synced corpus lives
 * under `packages/articles/content/` and is mapped by BASENAME, the same
 * `resolveFile` shape `pull-articles-corpus.mjs` uses on both of its trees. The
 * two paths hold different registries and comparing across them would report a
 * residue that is really the cutover gap.
 */
export function measureResidue({ root = ROOT, git = gitShow } = {}) {
  const pendingBySection = {};
  for (const section of ARTICLE_SECTION_KEYS) {
    const { file, constName } = ARTICLE_REGISTRY_FILES[section];
    const rel = `${REGISTRY_DIR}/${path.basename(file)}`;
    const worktree = Object.keys(readSlugRegistryWithRows(path.join(root, rel), constName).registry);
    const committed = Object.keys(readCommittedRegistry(rel, constName, git));

    // An empty registry on EITHER side is a measurement failure, never a fact,
    // and it is the one that fails OPEN if waved through: an absent
    // working-tree registry parses as ZERO ids (`readSlugRegistryWithRows`
    // swallows a missing file by design), an empty set has no difference, and
    // "no residue" reads as delivered. Found on the first local run of this
    // guard — in a sparse worktree `packages/articles/content/` is not
    // materialised and it cheerfully reported success while measuring nothing.
    // Neither section has ever had an empty registry (thousands of rows each),
    // so a zero means the file is missing, unparseable, or the const renamed.
    if (worktree.length < 1 || committed.length < 1) {
      throw new Error(
        `${rel} (${constName}) parses to ${worktree.length} id(s) in the working tree and `
        + `${committed.length} in HEAD — a registry is never legitimately empty, so this is a `
        + 'measurement failure, not a delivered sync',
      );
    }

    const onMain = new Set(committed);
    pendingBySection[section] = worktree.filter((id) => !onMain.has(id));
  }
  return pendingBySection;
}

/**
 * Write `HEAD`'s copy of `rel` to `dest`.
 *
 * Streamed into a file descriptor rather than captured as a string on purpose:
 * `routerBlogData.ts` is already ~1.5 MB at 3921 articles and grows with every
 * publish, so a captured stdout hits `spawnSync`'s 1 MB `maxBuffer` — which
 * surfaces as `status: null` and a TRUNCATED stdout, i.e. a plausible-looking
 * registry with a wrong row count. Measured: the first draft of this script
 * failed on the real tree with the file's own text as the error message. A
 * bigger `maxBuffer` would only move the date at which it breaks again.
 */
function gitShow(rel, dest) {
  const fd = fs.openSync(dest, 'w');
  try {
    const r = spawnSync('git', ['show', `HEAD:${rel}`], {
      cwd: ROOT,
      stdio: ['ignore', fd, 'pipe'],
      encoding: 'utf-8',
    });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`git show HEAD:${rel} exited ${r.status}: ${r.stderr ?? ''}`);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * `readSlugRegistryWithRows` takes a path, and reusing it is the point — both
 * sides must be parsed by exactly the same parser, or the set difference
 * measures the parser instead of the residue.
 */
function readCommittedRegistry(rel, constName, git) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-delivered-'));
  try {
    const dest = path.join(tmp, path.basename(rel));
    git(rel, dest);
    return readSlugRegistryWithRows(dest, constName).registry;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  let pendingBySection;
  try {
    pendingBySection = measureResidue({});
  } catch (err) {
    // Fail CLOSED. An unreadable registry on either side is exactly the state
    // this step must not wave through: it cannot tell a delivered sync from a
    // lost one, and the lost one is the one that stays invisible.
    console.error(`::error::${LOG} cannot measure the residue (${err.message}) — refusing to call this run delivered`);
    process.exit(1);
  }

  const verdict = deliveryVerdict({
    pendingBySection,
    skipReason: process.env.SKIP_REASON ?? '',
  });

  if (verdict.ok) {
    console.log(verdict.message);
    return;
  }
  console.error(`::error::${verdict.message}`);
  process.exit(1);
}

if (isInvokedDirectly(import.meta.url)) main();
