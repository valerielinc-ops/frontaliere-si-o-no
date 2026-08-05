/**
 * Issue #5168 — emission side of the inert band.
 *
 * `traffic-evidence-inert-band.test.ts` pins the DECISION. This file pins what
 * the decision does to bytes on disk, because that is where the two ways of
 * getting this wrong live:
 *
 *   1. the directive is written but never takes effect, and 137 k pages keep
 *      being indexed while the build log claims otherwise;
 *   2. the directive takes effect but the URL stays in
 *      `sitemap-search-clusters.xml`, which is the one combination Search
 *      Console flags back at you ("Submitted URL marked noindex").
 *
 * The rewrite goes through `replaceRobotsMeta`, which matches the robots meta
 * by NAME. That is not incidental. dist/ HTML is minified upstream (PR #478
 * `removeAttributeQuotes`), so the tag on disk reads
 * `<meta name=robots content=index,follow>` — and PR #5170 (#5001) is in flight
 * to replace that value with the `max-image-preview:large` directive on every
 * indexable family, clusters included. A matcher keyed to the value would pass
 * CI today, silently stop matching the day that PR lands, and ship the whole
 * band indexable with nothing red. So the value is a moving target under an
 * open PR and the tests below treat it as one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import np from 'node:path';
import os from 'node:os';

import { replaceRobotsMeta } from '../build-plugins/constants';
import { buildClusterThinHtml } from '../build-plugins/shared/clusterThinShell';
import { dropOverwrittenLocs } from '../build-plugins/relatedSearchClustersPlugin';

const BASE = 'https://frontaliereticino.ch';

/** The directive PR #5170 replaces `index,follow` with, verbatim. */
const ENHANCED = 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1';

const jobRow = (n: number) =>
  `<li><a href="/lavoro/posizione-${n}/">Operatore di produzione turnista ${n} — Azienda ${n} SA · Comune ${n}</a></li>`;

function fullClusterHtml(opts: { robots?: string; canonical: string; jobs?: number } = { canonical: '' }): string {
  const jobs = opts.jobs ?? 30;
  // Minified shape as it lands in dist/: unquoted single-token attributes.
  return (
    `<!doctype html><html><head>` +
    `<meta name=robots content=${opts.robots ?? 'index,follow'}>` +
    `<link rel=canonical href="${opts.canonical}">` +
    `</head><body><div id=root></div>` +
    `<main class=cluster-seo-prose><div class=related-search-cluster>` +
    `<h1>Formazione Basel</h1>` +
    `<ul class="cluster-seo-jobs">${Array.from({ length: jobs }, (_, i) => jobRow(i + 1)).join('')}</ul>` +
    `<section>related searches</section>` +
    `</div></main><div id=footer-root></div></body></html>`
  );
}

const countWords = (html: string): number =>
  html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;

const bodyOf = (html: string): string => html.replace(/[\s\S]*<\/head>/i, '');

describe('replaceRobotsMeta — matches the tag by name, not by its value', () => {
  it('rewrites the minified index,follow tag that dist/ actually contains', () => {
    const out = replaceRobotsMeta(fullClusterHtml({ canonical: BASE }), 'noindex,follow');
    expect(out).toContain('<meta name="robots" content="noindex,follow">');
    expect(out).not.toContain('content=index,follow');
  });

  it('rewrites the #5170 max-image-preview directive just as well', () => {
    // The forward-compatibility property: when #5170 lands, cluster pages stop
    // emitting `index,follow` and start emitting ENHANCED. Nothing here should
    // need to change, and the band must not quietly stop being applied.
    const html = fullClusterHtml({ canonical: BASE, robots: `"${ENHANCED}"` });
    const out = replaceRobotsMeta(html, 'noindex,follow');
    expect(out).toContain('<meta name="robots" content="noindex,follow">');
    expect(out).not.toContain('max-image-preview');
  });

  it('inserts a tag when the page carries none, rather than silently doing nothing', () => {
    const out = replaceRobotsMeta('<!doctype html><html><head><title>x</title></head><body></body></html>', 'noindex,follow');
    expect(out).toContain('<meta name="robots" content="noindex,follow">');
  });

  it('is idempotent — re-running it does not stack tags', () => {
    const once = replaceRobotsMeta(fullClusterHtml({ canonical: BASE }), 'noindex,follow');
    const twice = replaceRobotsMeta(once, 'noindex,follow');
    expect(twice).toBe(once);
    expect(twice.match(/name="robots"/g)).toHaveLength(1);
  });
});

describe('inert band leaves the sitemap, not just the index', () => {
  let dist: string;
  const IT = `${BASE}/cerca-lavoro-svizzera/ricerca-formazione-basel/`;
  const KEPT = `${BASE}/cerca-lavoro-svizzera/ricerca-saldatore-lugano/`;

  const write = (loc: string, html: string): void => {
    const dir = np.join(dist, new URL(loc).pathname.replace(/^\/|\/$/g, ''));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(np.join(dir, 'index.html'), html);
  };

  beforeEach(() => {
    dist = fs.mkdtempSync(np.join(os.tmpdir(), 'cluster-inert-band-'));
  });
  afterEach(() => {
    fs.rmSync(dist, { recursive: true, force: true });
  });

  it('dropOverwrittenLocs removes a noindexed cluster loc and keeps the indexable one', async () => {
    // A URL that is noindex AND still advertised in the sitemap is the exact
    // contradiction Search Console reports back. The plugin already re-reads
    // every emitted file to decide the sitemap, so marking the HTML is
    // sufficient — but only if the marking survives that reader, which is
    // what this asserts end to end.
    write(IT, replaceRobotsMeta(fullClusterHtml({ canonical: IT }), 'noindex,follow'));
    write(KEPT, fullClusterHtml({ canonical: KEPT }));

    const kept = await dropOverwrittenLocs(dist, [IT, KEPT]);
    expect(kept).toEqual([KEPT]);
  });

  it('a page left indexable stays in the sitemap even after being thinned', async () => {
    // Thinning and de-indexing are independent decisions; the still-indexed
    // thin band must not lose its sitemap entry as a side effect.
    write(KEPT, buildClusterThinHtml(fullClusterHtml({ canonical: KEPT }), 'it', { enrich: true }));
    expect(await dropOverwrittenLocs(dist, [KEPT])).toEqual([KEPT]);
  });
});

describe('enriched thin shell — real per-page content, only where it can still pay', () => {
  const html = fullClusterHtml({ canonical: BASE });

  it('is off by default, so every pre-#5168 caller keeps identical output', () => {
    expect(buildClusterThinHtml(html, 'it')).toBe(buildClusterThinHtml(html, 'it', { enrich: false }));
  });

  it('clears 300 words of body copy when enriched, against ~140 before', () => {
    // The live audit measured median 141 words across 200 sampled cluster
    // pages, 45,5 % of them under 140. That profile — one paragraph with a
    // token swapped, Auto Ads on all of it — is the finding of #5168.
    const before = countWords(bodyOf(buildClusterThinHtml(html, 'it')));
    const after = countWords(bodyOf(buildClusterThinHtml(html, 'it', { enrich: true })));
    expect(before).toBeLessThan(200);
    expect(after).toBeGreaterThanOrEqual(300);
  });

  it('fills the gap with REAL listings, not more boilerplate', () => {
    // The whole point: what makes the page longer has to be what makes it
    // different from its siblings. Employer names, locations and job titles
    // come from `ctx.matchingJobs` and no two cluster pages share them.
    const out = buildClusterThinHtml(html, 'it', { enrich: true });
    expect(out).toContain('Azienda 1 SA');
    expect(out).toContain('href="/lavoro/posizione-1/"');
    expect(out).toMatch(/provengono da \d+ datori di lavoro e coprono \d+ località/);
  });

  it('two clusters sharing the boilerplate do not share the enriched half', () => {
    const a = buildClusterThinHtml(html, 'it', { enrich: true });
    const b = buildClusterThinHtml(
      fullClusterHtml({ canonical: BASE }).replace(/Azienda (\d+) SA · Comune \1/g, 'Altra Ditta $1 SA · Altrove $1'),
      'it',
      { enrich: true },
    );
    expect(a).not.toBe(b);
    expect(b).toContain('Altra Ditta 1 SA');
    expect(b).not.toContain('Azienda 1 SA');
  });

  it('reuses already-escaped text verbatim instead of escaping it twice', () => {
    // Everything the shell re-emits was read back out of HTML the plugin had
    // already put through `esc()`. Escaping again turns `&amp;` into
    // `&amp;amp;`, which renders as a literal "&amp;" — and employer names
    // with an ampersand are common enough ("Ernst & Young", "Marks & Spencer")
    // that this would be visible across a large slice of the corpus.
    const amp = fullClusterHtml({ canonical: BASE }).replace('Azienda 1 SA', 'Rossi &amp; Bianchi SA');
    const out = buildClusterThinHtml(amp, 'it', { enrich: true });
    expect(out).toContain('Rossi &amp; Bianchi SA');
    expect(out).not.toContain('&amp;amp;');
  });

  it('caps the list instead of restoring the full 30-row page', () => {
    // The shell exists because this family was 57 % of a 5,17 GB dist. Growing
    // it back to the full listing would trade one problem for the other.
    const out = buildClusterThinHtml(html, 'it', { enrich: true });
    expect((out.match(/<li>/g) || []).length).toBeLessThanOrEqual(20);
    expect(out.length).toBeLessThan(html.length);
  });

  it('degrades to the plain shell when the cluster has no listings to show', () => {
    const noJobs = fullClusterHtml({ canonical: BASE, jobs: 0 });
    expect(buildClusterThinHtml(noJobs, 'it', { enrich: true })).toBe(buildClusterThinHtml(noJobs, 'it'));
  });

  it('enriches every locale, not just the Italian default', () => {
    for (const [locale, marker] of [['en', 'Open positions'], ['de', 'Offene Stellen'], ['fr', 'Postes ouverts']] as const) {
      const out = buildClusterThinHtml(html, locale, { enrich: true });
      expect(out).toContain(marker);
      expect(countWords(bodyOf(out))).toBeGreaterThanOrEqual(300);
    }
  });
});
