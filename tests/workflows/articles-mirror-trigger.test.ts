import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The corpus mirror must NOT be able to fire on its own (issue #4974 item 3).
 *
 * This file used to assert the opposite, and was right at the time: while this
 * repo was the only writer and the articles repo a read-only copy, the mirror
 * needed a `schedule:`, because a `GITHUB_TOKEN` push never triggers another
 * workflow — so `on: push` silently never fired and the published API froze at
 * the extraction snapshot.
 *
 * The cutover reversed the direction. nanako GENERATES articles now, and
 * `scripts/pull-articles-corpus.mjs` (run by sync-articles-sitemaps.yml) pulls
 * its `content/` back into `packages/articles/content/`. The mirror still does
 * `rm -rf content && cp -R packages/articles/content`, so anything that fires
 * it now DELETES every article generated in nanako since the last pull — and
 * reports success while doing it. `mirror-articles-corpus.yml` disabled its
 * `push` and `schedule` triggers for exactly that reason.
 *
 * The dispatch in `generate-article.yml` outlived that change: it was the one
 * remaining path that could still fire the mirror, and nothing tested for it.
 * This file was still asserting the pre-cutover invariant, so it failed on
 * `main` for days and its failure read as noise.
 *
 * Hence the inversion. `workflow_dispatch` stays — a human may still need it,
 * e.g. to seed a fresh corpus — but nothing may fire it automatically.
 *
 * ── The same hole, one workflow over (#5289) ──────────────────────────────
 * `generate-article.yml` got the same treatment at cutover and only half of
 * it: its `schedule:` was commented out, `workflow_dispatch` was kept "so it
 * can still be run by hand". Nothing enforced the "by hand" half, and
 * `workflow_dispatch` is not a synonym for a human. On 2026-08-06 at
 * 09:51:54Z `refresh-bfs-stats.yml` saw the BFS quarter roll 2026-Q1 →
 * 2026-Q2 and ran `gh workflow run generate-article.yml`; that workflow's
 * last step dispatches ITSELF, so one quarterly nudge became ~22h of
 * unattended writes to `packages/articles/content/`.
 *
 * The damage was not the writes — it was what the writes did to the pull.
 * Five articles existed downstream and nowhere upstream, so
 * `scripts/pull-articles-corpus.mjs` measured a LARGER local tree and refused
 * (correctly). The sitemap sync stopped, `tests/blog-slugs-sitemap-sync.test.ts`
 * went red on `main` itself, and every PR in the repo lost auto-merge. When
 * nanako later published enough articles for the counts to cross back over,
 * the pull went through and its `mirrorTree` deleted all five. They answer
 * 200 today with no corpus entry behind them.
 *
 * The second describe below locks the missing half: the producer runs only
 * when a dispatcher passes `confirm_corpus_write=yes`, and nothing in the
 * repo can pass it on its own.
 *
 * ── LOCAL producer, not the name (#5341) ──────────────────────────────────
 * The scan below used to flag any workflow that merely NAMED
 * `generate-article.yml` in a dispatch command, regardless of which repo the
 * command targeted. That conflated two opposite things. Firing THIS repo's
 * producer is the #5289 incident. Firing the CORPUS's producer
 * (`--repo nanakokyobashi-rgb/frontaliere-articles`) is what this test's own
 * failure message tells the reader to do instead — it writes nothing here,
 * cannot desynchronise `scripts/pull-articles-corpus.mjs`, and starts no local
 * self-chain. The bare-name rule also flagged the documented manual-fallback
 * command quoted inside an issue body, which is text, not an actor.
 * `dispatchesLocalProducer` draws the line, and is unit-tested on both shapes
 * so a broken matcher cannot pass by finding nothing.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const WF = (name: string) =>
  fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf-8');

/** Where article generation lives since the 2026-08-02 cutover (#4974 item 3). */
const CORPUS_REPO = 'nanakokyobashi-rgb/frontaliere-articles';

/**
 * Join `\`-continued shell lines so one logical command is one string. Without this
 * the `--repo` argument of a multi-line `gh workflow run` sits on a different line
 * than the command name, and a per-line test cannot tell local from cross-repo.
 */
function joinContinuations(text: string): string {
  return text.replace(/\\\n\s*/g, ' ');
}

/**
 * Does this logical line fire THIS repo's retired producer?
 *
 * The distinction is the whole point (#5341). What #5289 cost was firing the LOCAL
 * `generate-article.yml`: a retired producer, in a repo that is a pure consumer since
 * the cutover, whose last step dispatches ITSELF — one quarterly nudge became ~22h of
 * unattended writes to `packages/articles/content/`, five articles that existed
 * downstream and nowhere upstream, a blocked pull and a repo-wide merge block.
 *
 * A dispatch aimed at `nanakokyobashi-rgb/frontaliere-articles` is the opposite of that
 * incident: it asks the repo that OWNS generation to generate, which is what this very
 * test's failure message tells the reader to do instead. It writes nothing here, cannot
 * desynchronise the pull, and starts no local self-chain.
 *
 * So the rule is not "never name generate-article.yml" — it is "never fire the local
 * one". Matching the bare filename would also flag the documented manual-fallback
 * command inside an issue body, which is text, not an actor.
 */
function dispatchesLocalProducer(logicalLine: string): boolean {
  const cli = /gh workflow run\s+generate-article\.yml/.test(logicalLine);
  const api = /workflows\/generate-article\.yml\/dispatches/.test(logicalLine);
  if (!cli && !api) return false;
  // Cross-repo dispatch to the corpus → post-cutover architecture, not the #5289 shape.
  return !logicalLine.includes(CORPUS_REPO);
}

/** The `on:` block, up to the next top-level key. */
function onBlock(src: string): string {
  return src.match(/^on:\n(?:[ \t].*\n|\n)*/m)?.[0] ?? '';
}

/** The disabled triggers are kept as comments on purpose — ignore those. */
function withoutComments(text: string): string {
  return text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

describe('the corpus mirror cannot fire on its own (#4974 item 3)', () => {
  it('mirror-articles-corpus.yml is dispatch-only', () => {
    const block = onBlock(WF('mirror-articles-corpus.yml'));
    expect(block, 'no `on:` block found').not.toBe('');

    const live = withoutComments(block);
    expect(
      /^\s+workflow_dispatch:/m.test(live),
      'workflow_dispatch must stay — the mirror is still how a corpus gets seeded by hand',
    ).toBe(true);

    for (const trigger of ['push', 'schedule'] as const) {
      expect(
        new RegExp(`^\\s+${trigger}:`, 'm').test(live),
        `mirror-articles-corpus.yml must NOT be ${trigger}-triggered: it does ` +
          '`rm -rf content && cp -R packages/articles/content`, so an automatic run ' +
          'deletes every article generated in nanako since the last pull and reports ' +
          'success. Direction reversed at cutover — nanako writes, this repo pulls ' +
          '(scripts/pull-articles-corpus.mjs).',
      ).toBe(false);
    }
  });

  it('no workflow dispatches the mirror', () => {
    const dir = path.join(ROOT, '.github', 'workflows');
    const offenders: string[] = [];

    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
      if (file === 'mirror-articles-corpus.yml') continue;
      const live = withoutComments(fs.readFileSync(path.join(dir, file), 'utf-8'));
      if (live.includes('mirror-articles-corpus.yml')) offenders.push(file);
    }

    expect(
      offenders,
      `these workflows still dispatch the mirror: ${offenders.join(', ')}. Each ` +
        'dispatch is a path to deleting nanako-generated articles — the mirror ' +
        'replaces its content/ wholesale from this repo.',
    ).toEqual([]);
  });
});

describe('the article producer cannot fire on its own (#5289)', () => {
  const GEN = 'generate-article.yml';

  it(`${GEN} declares the confirm_corpus_write input`, () => {
    const live = withoutComments(WF(GEN));
    expect(
      /^\s+confirm_corpus_write:/m.test(live),
      'the cutover guard is an INPUT, not an actor check, on purpose: ' +
        'refresh-bfs-stats.yml and this workflow\'s own self-trigger both dispatch ' +
        'as the same App identity a human uses through `gh`, so no actor test can ' +
        'separate them. An input only arrives from whoever typed it.',
    ).toBe(true);
  });

  it(`${GEN}'s generating job runs only with confirm_corpus_write=yes`, () => {
    const live = withoutComments(WF(GEN));
    expect(
      /confirm_corpus_write\s*==\s*'yes'/.test(live),
      'the job that writes packages/articles/content/ must be gated on ' +
        "`github.event.inputs.confirm_corpus_write == 'yes'`. Without the gate, a " +
        'single dispatch from any workflow restarts an unattended producer in a ' +
        'repo that is a pure consumer since the 2026-08-02 cutover (#4974 item 3).',
    ).toBe(true);
  });

  it('the self-trigger cannot carry the confirmation forward', () => {
    // The chain is the amplifier: one authorized dispatch must stay one
    // article, not become a producer. trigger-self.sh builds its payload from
    // a fixed shape (retry_count / no_changes_streak / section / url) — adding
    // a passthrough here re-creates the two-writer state.
    const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'trigger-self.sh'), 'utf-8');
    expect(
      sh.includes('confirm_corpus_write'),
      'trigger-self.sh must NOT forward confirm_corpus_write — that would let a ' +
        'hand-authorized run chain into an unattended one, which is exactly how ' +
        '2026-08-06 09:51 became 22h of corpus writes.',
    ).toBe(false);
  });

  it('no workflow dispatches the LOCAL producer', () => {
    const dir = path.join(ROOT, '.github', 'workflows');
    const offenders: string[] = [];

    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
      if (file === GEN) continue; // its own self-trigger is gated by the input
      const live = joinContinuations(withoutComments(fs.readFileSync(path.join(dir, file), 'utf-8')));
      for (const line of live.split('\n')) {
        if (dispatchesLocalProducer(line)) offenders.push(file);
      }
    }

    expect(
      [...new Set(offenders)],
      `these workflows dispatch the retired LOCAL producer: ${offenders.join(', ')}. ` +
        'refresh-bfs-stats.yml was the one that did it on 2026-08-06 and it cost ' +
        'five orphaned articles plus a repo-wide merge block. Dispatch ' +
        `${CORPUS_REPO} instead — generation lives there since the cutover.`,
    ).toEqual([]);
  });

  // The predicate above is the load-bearing part of this guard, so it is tested
  // directly rather than only through the directory scan: a scan that finds nothing
  // looks identical whether the rule is right or the matcher is broken.
  it('the detector still catches the #5289 shape, and only that one', () => {
    // The exact command that caused the incident.
    expect(dispatchesLocalProducer('gh workflow run generate-article.yml')).toBe(true);
    expect(dispatchesLocalProducer('gh workflow run generate-article.yml -f section=svizzera')).toBe(true);
    // API form, local repo.
    expect(
      dispatchesLocalProducer('gh api -X POST repos/valerielinc-ops/frontaliere-si-o-no/actions/workflows/generate-article.yml/dispatches'),
    ).toBe(true);

    // Cross-repo to the corpus: the post-cutover architecture (#5341), not the incident.
    expect(
      dispatchesLocalProducer(`gh workflow run generate-article.yml --repo ${CORPUS_REPO} -f url=stats-bfs://2026-Q2`),
    ).toBe(false);
    expect(
      dispatchesLocalProducer(`gh api -X POST repos/${CORPUS_REPO}/actions/workflows/generate-article.yml/dispatches`),
    ).toBe(false);

    // Unrelated lines never match.
    expect(dispatchesLocalProducer('gh workflow run deploy.yml')).toBe(false);
    expect(dispatchesLocalProducer('generation lives in the corpus')).toBe(false);
  });
});
