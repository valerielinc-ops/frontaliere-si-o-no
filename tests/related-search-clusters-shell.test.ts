import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { renderClusterPage } from '../build-plugins/relatedSearchClustersPlugin';
import { buildFlatBridgeFromSibling } from '../build-plugins/flatHtmlRedirectPlugin';

const tmpDirs: string[] = [];

function makeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rsc-shell-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(
    join(dir, 'index.html'),
    '<script type="module" crossorigin src="/assets/index-test123.js"></script><link rel="stylesheet" href="/assets/index-test123.css">',
    'utf8',
  );
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('canton-aware cluster URL emission', () => {
  // Post-2026-05-28 refactor: `buildClusterContext` always sets
  // `cantonGroup: AGGREGATE_KEY` so every cluster canonicalizes to
  // /cerca-lavoro-svizzera/ricerca-{slug}/ regardless of the top-match
  // canton. Legacy per-canton URLs are emitted as mirror copies (see the
  // emit loop in `closeBundle`). `renderClusterPage` itself remains
  // canton-agnostic — it honours whatever `ctx.cantonGroup` is passed,
  // so the per-canton tests below still exercise the rendering path that
  // produces the mirror HTML.
  it('emits canonical at /cerca-lavoro-svizzera/ when cantonGroup is _AGGREGATE_', () => {
    const distDir = makeDist();
    const page = renderClusterPage({
      distDir,
      dateStamp: '2026-05-28',
      ctx: {
        candidate: {
          slug: 'ricerca-offerte-lavoro-addetto-a-cucina',
          locale: 'it',
          jobCount: 1,
          sampleTerms: ['offerte lavoro Addetto a cucina'],
          editorialCollision: null,
        },
        keyword: 'addetto a cucina',
        city: null,
        // 3 entries — clears MIN_JOBS_FOR_INDEXABLE_CLUSTER (issue #4303
        // item 4) so this test still exercises the full-page canton
        // routing path, not the below-floor bridge.
        matchingJobs: [
          { id: 'ksgr-x', title: 'Mitarbeiter:in Küche', company: 'KSGR', location: 'Walenstadt', canton: 'SG', slug: 'mitarbeiter-kueche-walenstadt' },
          { id: 'ksgr-y', title: 'Koch/Köchin', company: 'KSGR', location: 'Walenstadt', canton: 'SG', slug: 'koch-koechin-walenstadt' },
          { id: 'ksgr-z', title: 'Küchenhilfe', company: 'KSGR', location: 'Walenstadt', canton: 'SG', slug: 'kuechenhilfe-walenstadt' },
        ],
        topCompanies: ['KSGR'],
        cantonGroup: '_AGGREGATE_',
        legacyCantonGroup: 'SG',
      } as any,
      enriched: undefined,
      hreflang: [],
      related: [],
    });

    expect(page.urlPath).toBe('/cerca-lavoro-svizzera/ricerca-offerte-lavoro-addetto-a-cucina/');
    expect(page.loc).toBe('https://frontaliereticino.ch/cerca-lavoro-svizzera/ricerca-offerte-lavoro-addetto-a-cucina/');
    expect(page.html).toMatch(/<link rel=canonical href="https:\/\/frontaliereticino\.ch\/cerca-lavoro-svizzera\/ricerca-offerte-lavoro-addetto-a-cucina\/"/);
  });

  it('pins a Liestal-only cluster under /cerca-lavoro-basilea/ via cantonGroup', () => {
    const distDir = makeDist();
    const page = renderClusterPage({
      distDir,
      dateStamp: '2026-05-26',
      ctx: {
        candidate: {
          slug: 'ricerca-genitori-liestal',
          locale: 'it',
          jobCount: 1,
          sampleTerms: ['genitori Liestal'],
          editorialCollision: null,
        },
        keyword: 'genitori',
        city: 'Liestal',
        // 3 entries — clears MIN_JOBS_FOR_INDEXABLE_CLUSTER (issue #4303
        // item 4) so this test still exercises the full-page canton
        // routing path, not the below-floor bridge. First entry stays
        // the one asserted against below (job link href).
        matchingJobs: [
          { id: 'ksbl-x', title: 'Hebamme', company: 'Kantonsspital Baselland (KSBL)', location: 'Liestal', canton: 'BL', slug: 'hebamme-liestal' },
          { id: 'ksbl-y', title: 'Pflegefachperson', company: 'Kantonsspital Baselland (KSBL)', location: 'Liestal', canton: 'BL', slug: 'pflegefachperson-liestal' },
          { id: 'ksbl-z', title: 'Fachangestellte Gesundheit', company: 'Kantonsspital Baselland (KSBL)', location: 'Liestal', canton: 'BL', slug: 'fage-liestal' },
        ],
        topCompanies: ['Kantonsspital Baselland (KSBL)'],
        cantonGroup: 'BASILEA',
      } as any,
      enriched: undefined,
      hreflang: [],
      related: [],
    });

    expect(page.urlPath).toBe('/cerca-lavoro-basilea/ricerca-genitori-liestal/');
    expect(page.loc).toBe('https://frontaliereticino.ch/cerca-lavoro-basilea/ricerca-genitori-liestal/');
    // The HTML minifier strips quotes from attributes whose value has no
    // spaces, so `rel` becomes unquoted but `href` keeps its quotes.
    expect(page.html).toMatch(/<link rel=canonical href="https:\/\/frontaliereticino\.ch\/cerca-lavoro-basilea\/ricerca-genitori-liestal\/"/);
    // Job link uses the job's OWN canton-aware section (BL → basilea).
    // PR #651 relativized body anchors in cluster pages — drop the `https://frontaliereticino.ch` prefix.
    expect(page.html).toContain('href="/cerca-lavoro-basilea/hebamme-liestal/"');
  });

  it('falls back to TI when cantonGroup is omitted (backwards-compat)', () => {
    const distDir = makeDist();
    const page = renderClusterPage({
      distDir,
      dateStamp: '2026-05-26',
      ctx: {
        candidate: { slug: 'ricerca-test', locale: 'it', jobCount: 0, sampleTerms: ['test'], editorialCollision: null },
        keyword: 'test',
        city: null,
        matchingJobs: [],
        topCompanies: [],
      } as any,
      enriched: undefined,
      hreflang: [],
      related: [],
    });

    expect(page.urlPath).toBe('/cerca-lavoro-ticino/ricerca-test/');
  });
});

describe('related search cluster SEO shell', () => {
  it('keeps the full SEO shell, indexation tags, SPA assets, and crawl links', () => {
    const distDir = makeDist();
    const page = renderClusterPage({
      distDir,
      dateStamp: '2026-05-25',
      ctx: {
        candidate: {
          slug: 'ricerca-data-analyst-lugano',
          locale: 'it',
          jobCount: 1,
          sampleTerms: ['data analyst Lugano'],
          editorialCollision: null,
        },
        keyword: 'data analyst',
        city: 'Lugano',
        matchingJobs: [],
        topCompanies: [],
      } as any,
      enriched: {
        slug: 'ricerca-data-analyst-lugano',
        locale: 'it',
        keyword: 'data analyst',
        city: 'Lugano',
        intro: 'Pagina di ricerca per data analyst a Lugano con offerte aggiornate, aziende attive, criteri di candidatura, stipendio in franchi, costi da frontaliere e strumenti per confrontare netto, cambio e copertura sanitaria prima di inviare una candidatura.',
        faqs: [],
      },
      hreflang: [
        { locale: 'it', url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/ricerca-data-analyst-lugano/' },
        { locale: 'en', url: 'https://frontaliereticino.ch/en/find-jobs-ticino/search-data-analyst-lugano/' },
        { locale: 'de', url: 'https://frontaliereticino.ch/de/jobs-im-tessin/suche-data-analyst-lugano/' },
        { locale: 'fr', url: 'https://frontaliereticino.ch/fr/trouver-emploi-tessin/recherche-data-analyst-lugano/' },
      ],
      related: [
        { keyword: 'Rel 1', url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/ricerca-rel-1/' },
        { keyword: 'Rel 2', url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/ricerca-rel-2/' },
        { keyword: 'Rel 3', url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/ricerca-rel-3/' },
        { keyword: 'Rel 4', url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/ricerca-rel-4/' },
        { keyword: 'Rel 5', url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/ricerca-rel-5/' },
      ],
    });

    expect(page.html).toMatch(/<meta name="?robots"? content="?index,follow"?/);
    expect(page.html).toMatch(/<link rel="?canonical"? href="https:\/\/frontaliereticino\.ch\/cerca-lavoro-ticino\/ricerca-data-analyst-lugano\/"/);
    expect(page.html).toMatch(/hreflang="?x-default"?/);
    expect(page.html).toContain('<script type="application/ld+json">');
    expect(page.html).not.toContain('https:/frontaliereticino.ch');
    expect(page.html).toContain('/assets/index-test123.js');
    expect(page.html).toContain('/assets/index-test123.css');
    expect(page.html).toContain('<!--EJP_STRIPPED-->');
    expect(page.html).toContain('og:image');
    expect(page.html).toContain('Rel 4');
    expect(page.html).toContain('Rel 5');
  });
});

describe('flat redirect bridge payload', () => {
  it('keeps noindex/canonical redirect and preview meta by default', () => {
    const sibling = `<!doctype html><html><head>
      <title>Sample title</title>
      <meta name="description" content="Long social description">
      <meta property="og:title" content="OG title">
      <meta property="og:description" content="OG description">
      <meta property="og:image" content="https://frontaliereticino.ch/og-image.png">
    </head><body></body></html>`;
    const bridge = buildFlatBridgeFromSibling(
      sibling,
      'https://frontaliereticino.ch/cerca-lavoro-ticino/sample/',
    );

    expect(bridge).toContain('<meta name="robots" content="noindex,follow">');
    expect(bridge).toContain('<link rel="canonical" href="https://frontaliereticino.ch/cerca-lavoro-ticino/sample/">');
    expect(bridge).toContain('location.replace');
    expect(bridge).toContain('og:image');
    expect(bridge).toContain('og:description');
    expect(bridge).toContain('Long social description');
  });

  it('emits related-search hub flat variants with the standard bridge builder', () => {
    const src = readFileSync(
      join(process.cwd(), 'build-plugins/relatedSearchClustersPlugin.ts'),
      'utf8',
    );

    expect(src).toContain('collector.add(flatPath, buildFlatBridgeFromSibling(out.html, out.loc));');
    expect(src).not.toContain('renderLeanFlatBridge');
    expect(src).not.toContain('collector.add(flatPath, out.html);');
  });
});
