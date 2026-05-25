import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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

describe('related search cluster lean shell', () => {
  it('keeps indexation tags and SPA assets while dropping repeated preview chrome', () => {
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
    expect(page.html).not.toContain('og:image');
    expect(page.html).not.toContain('google-adsense');
    expect(page.html).not.toContain('seo-static.css');
    expect(page.html).toContain('Rel 4');
    expect(page.html).not.toContain('Rel 5');
  });
});

describe('flat redirect bridge payload', () => {
  it('keeps noindex/canonical redirect but strips repeated preview meta by default', () => {
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
    expect(bridge).not.toContain('og:image');
    expect(bridge).not.toContain('og:description');
    expect(bridge).not.toContain('Long social description');
  });
});
