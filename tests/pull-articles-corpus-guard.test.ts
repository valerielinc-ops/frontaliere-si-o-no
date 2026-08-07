/**
 * The refuse/proceed guard in `scripts/pull-articles-corpus.mjs` (issue #5289).
 *
 * WHAT BROKE, AND WHY IT NEEDS A TEST RATHER THAN A COMMENT
 * ────────────────────────────────────────────────────────
 * The guard used to be `srcN < dstN` — refuse when upstream has fewer files
 * than the local corpus. That single comparison has to separate two situations
 * that look identical to a counter:
 *
 *   TRUNCATION  upstream LOST files. Mirroring it deletes live articles.
 *   DIVERGENCE  the trees differ by a handful in BOTH directions. Routine,
 *               because the site → nanako content mirror is dispatch-only
 *               while this repo still generates articles locally.
 *
 * On 2026-08-07 it got both wrong, in opposite directions, within two hours:
 *
 *   05:28  refused a benign divergence (upstream 14984, local 14988). It is the
 *          FIRST step of sync-articles-sitemaps.yml, so the whole job aborted
 *          and the sitemaps went stale on main — which turned
 *          tests/blog-slugs-sitemap-sync.test.ts red on every unrelated PR.
 *   07:07  one article landed on each side, the counts balanced at 14988, and
 *          the same guard waved through a mirror that deleted three articles
 *          which were live and answering HTTP 200.
 *
 * So the count blocked on the accounting and never on the risk.
 *
 * The resolution is an asymmetry rather than a better threshold: the pull ADDS
 * and UPDATES, and never DELETES unless `--allow-deletions` says so. "Present
 * downstream, absent upstream" is what every site-published article looks like,
 * so it can never be treated as corruption. The tests below pin both ends —
 * the benign divergence proceeds, a live local article survives a default run,
 * and the bounds still refuse a truncation on the opt-in path.
 */
import { describe, expect, it } from 'vitest';
import { classifySync } from '../scripts/pull-articles-corpus.mjs';

/** `n` throwaway paths sharing a prefix — stands in for the untouched bulk. */
function files(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}/${i}.ts`);
}

/** One article = four locale body files, the unit the corpus actually moves in. */
function article(id: string): string[] {
  return ['it', 'en', 'de', 'fr'].map((l) => `blog-body/${l}/${id}.ts`);
}

describe('pull-articles-corpus guard — truncation vs divergence (#5289)', () => {
  it('PROCEEDS on the exact divergence that jammed the sync (upstream 14984 < local 14988)', () => {
    // The real shape: two articles present only downstream, one only upstream.
    const common = files('content', 14980);
    const dst = new Set([
      ...common,
      ...article('lavoro-forzato-catene-svizzere'),
      ...article('rimborsi-730-sostituti-imposta'),
    ]);
    const src = new Set([
      ...common,
      ...article('casse-di-disoccupazione-superati-i-problemi-tecnici'),
    ]);

    const r = classifySync(src, dst);

    expect(r.srcN).toBe(14984);
    expect(r.dstN).toBe(14988);
    // Upstream is SMALLER, which is exactly what the old guard refused on.
    expect(r.srcN).toBeLessThan(r.dstN);
    expect(r.refusal).toBeNull();
    expect(r.deletions).toHaveLength(8);
    expect(r.additions).toHaveLength(4);
  });

  it('never deletes by default, so a truncated upstream cannot take anything', () => {
    // With deletions off, a truncation is inert: the run adds nothing, removes
    // nothing, and the 6000 local files are still there afterwards. This is the
    // property that makes the sync safe to leave unattended.
    const dst = new Set(files('content', 15000));
    const src = new Set(files('content', 15000).slice(0, 9000)); // 6000 files absent upstream

    const r = classifySync(src, dst);

    expect(r.refusal).toBeNull();
    expect(r.willDelete).toBe(false);
    expect(r.deletions).toHaveLength(6000); // reported...
    expect(r.additions).toHaveLength(0); // ...but nothing is acted on
  });

  it('REFUSES a real truncation once deletions are explicitly opted into', () => {
    const dst = new Set(files('content', 15000));
    const src = new Set(files('content', 15000).slice(0, 9000));

    const r = classifySync(src, dst, { allowDeletions: true });

    expect(r.refusal).toMatch(/would remove 6000 local file\(s\)/);
    expect(r.refusal).toMatch(/upstream truncation/);
  });

  it('REFUSES a wholesale swap even when the two totals match exactly', () => {
    // The 07:07 failure mode. Counts balance, so `srcN < dstN` is false and the
    // old guard proceeded — while the mirror deleted 3000 files. A guard that
    // reads the balance instead of the deletions cannot see this at all.
    const common = files('content', 12000);
    const dst = new Set([...common, ...files('doomed', 3000)]);
    const src = new Set([...common, ...files('fresh', 3000)]);

    const r = classifySync(src, dst, { allowDeletions: true });

    expect(r.srcN).toBe(r.dstN); // the balance the old guard trusted
    expect(r.refusal).toMatch(/would remove 3000 local file\(s\)/);
  });

  it('keeps a site-published article that upstream has never seen', () => {
    // The #5289 data loss, as a unit. These four files are an article that
    // generate-article.yml published here and the (dispatch-only) content
    // mirror never carried up. It answers HTTP 200. A default sync must leave
    // it alone.
    const common = files('content', 14000);
    const dst = new Set([...common, ...article('lavoro-forzato-catene-svizzere')]);

    const r = classifySync(new Set(common), dst);

    expect(r.refusal).toBeNull();
    expect(r.willDelete).toBe(false);
    expect(r.deletions).toContain('blog-body/it/lavoro-forzato-catene-svizzere.ts');
  });

  it('REFUSES an upstream below the absolute floor, however the sets compare', () => {
    const r = classifySync(new Set(files('content', 4999)), new Set(files('content', 4999)));

    expect(r.deletions).toHaveLength(0); // nothing would be deleted...
    expect(r.refusal).toMatch(/only 4999 files/); // ...and it still refuses
  });

  it('PROCEEDS on a pure addition and reports nothing to delete', () => {
    const common = files('content', 14000);
    const r = classifySync(new Set([...common, ...article('nuovo')]), new Set(common));

    expect(r.refusal).toBeNull();
    expect(r.deletions).toHaveLength(0);
    expect(r.additions).toHaveLength(4);
  });

  it('names every file it would delete, so an un-listed article is never silent', () => {
    // The script prints this list; the guarantee under test is that the data
    // to print is returned at all. Reconstructing it after the fact means
    // diffing two 15k-file trees against a corpus that has since moved on.
    const common = files('content', 14000);
    const dst = new Set([...common, ...article('caldo-torrido-lavoro-ticino')]);

    const r = classifySync(new Set(common), dst);

    expect(r.refusal).toBeNull(); // allowed — but still fully reported
    expect(r.deletions).toEqual([
      'blog-body/de/caldo-torrido-lavoro-ticino.ts',
      'blog-body/en/caldo-torrido-lavoro-ticino.ts',
      'blog-body/fr/caldo-torrido-lavoro-ticino.ts',
      'blog-body/it/caldo-torrido-lavoro-ticino.ts',
    ]);
  });

  it('uses a relative bound too, so a small corpus cannot lose most of itself', () => {
    // 30 deletions is under the absolute bound of 200, but it is 3% of a
    // 1000-file tree — the absolute bound alone would let that through.
    const common = files('content', 970);
    const dst = new Set([...common, ...files('doomed', 30)]);

    const r = classifySync(new Set(common), dst, { minBodyFiles: 100, allowDeletions: true });

    expect(r.deletions).toHaveLength(30);
    expect(r.refusal).toMatch(/3\.00% of 1000/);
  });
});
