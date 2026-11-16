import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  countSitemapFamilyUrls,
  diffSitemapFamilyUrls,
  evaluateSitemapFamilyCoverage,
  filterExternallyServedUrlsFromSitemapCoverage,
} from '../scripts/lib/sitemap-family-coverage.mjs';

const NO_DECLARATIONS = { version: 1, decreases: [] };

const snapshot = (perSitemap: Record<string, string[]>) => ({ version: 3, perSitemap });
const familyUrls = (family: string, count: number, origin = 'https://frontaliereticino.ch') =>
  Array.from({ length: count }, (_, index) => `${origin}/${family}/${String(index).padStart(4, '0')}/`);

function bridgeEvidence(previous: { perSitemap: Record<string, string[]> }, current: { perSitemap: Record<string, string[]> }, family: string) {
  const previousUrls = new Set(Object.values(previous.perSitemap).flat());
  const currentUrls = new Set(Object.values(current.perSitemap).flat());
  const removed = [...previousUrls].filter((url) => !currentUrls.has(url));
  return {
    schemaVersion: 1,
    kind: 'sitemap-family-bridge-evidence',
    complete: true,
    entries: removed.map((url) => ({
      family,
      url,
      path: `${new URL(url).pathname.replace(/^\/+|\/+$/gu, '')}/index.html`,
      sha256: 'a'.repeat(64),
      robots: 'noindex,follow',
    })),
  };
}

describe('sitemap family URL coverage ratchet', () => {
  it('counts unique URLs across topic shards and the separate event archives', () => {
    const counts = countSitemapFamilyUrls(snapshot({
      'sitemap-topics-frontaliere.xml': ['https://frontaliereticino.ch/topic/a/', 'https://frontaliereticino.ch/topic/shared/'],
      'sitemap-topics-svizzera.xml': ['https://frontaliereticino.ch/topic/b/', 'https://frontaliereticino.ch/topic/shared/'],
      'sitemap-eventi.xml': ['https://frontaliereticino.ch/eventi/futuro/', 'https://frontaliereticino.ch/eventi/archivio/'],
      'sitemap-eventi-storici.xml': ['https://frontaliereticino.ch/eventi/passato/', 'https://frontaliereticino.ch/eventi/archivio/'],
      'sitemap-pages.xml': ['https://frontaliereticino.ch/una-pagina/'],
    }));

    expect(counts.topics).toBe(3);
    expect(counts.events).toBe(3);
    expect(counts['job-market']).toBe(0);
  });

  it('passes when archived details move to a separate sitemap without lowering event coverage', () => {
    const previous = snapshot({
      'sitemap-eventi.xml': ['https://frontaliereticino.ch/eventi/futuro/', 'https://frontaliereticino.ch/eventi/passato/'],
      'sitemap-topics-frontaliere.xml': ['https://frontaliereticino.ch/topic/a/'],
    });
    const current = snapshot({
      'sitemap-eventi.xml': ['https://frontaliereticino.ch/eventi/futuro/'],
      'sitemap-eventi-storici.xml': ['https://frontaliereticino.ch/eventi/passato/'],
      'sitemap-topics-frontaliere.xml': ['https://frontaliereticino.ch/topic/a/'],
      'sitemap-topics-svizzera.xml': ['https://frontaliereticino.ch/topic/b/'],
    });

    const result = evaluateSitemapFamilyCoverage(previous, current, NO_DECLARATIONS);
    expect(result.regressions).toEqual([]);
    expect(result.families.find(({ family }) => family === 'events')?.delta).toBe(0);
    expect(result.families.find(({ family }) => family === 'topics')?.delta).toBe(1);
  });

  it('excludes corpus-owned article URLs from family coverage in both deploy gates', () => {
    const previous = snapshot({
      'sitemap-topics-frontaliere.xml': [
        'https://frontaliereticino.ch/articoli-frontaliere/argomenti/assicurazioni/',
        'https://frontaliereticino.ch/articoli-frontaliere/argomenti/lavoro/',
        'https://frontaliereticino.ch/tema-editoriale/',
      ],
    });
    const current = snapshot({
      'sitemap-topics-frontaliere.xml': [
        'https://frontaliereticino.ch/articoli-frontaliere/argomenti/lavoro/',
        'https://frontaliereticino.ch/tema-editoriale/',
      ],
    });
    const result = evaluateSitemapFamilyCoverage(
      filterExternallyServedUrlsFromSitemapCoverage(previous),
      filterExternallyServedUrlsFromSitemapCoverage(current),
      NO_DECLARATIONS,
    );

    expect(result.families.find(({ family }) => family === 'topics')).toMatchObject({
      previousCount: 1,
      currentCount: 1,
      delta: 0,
    });
    expect(result.regressions).toEqual([]);
  });

  it('fails a family count decrease unless the declaration matches both exact counts', () => {
    const previous = snapshot({ 'sitemap-profession-cities.xml': ['a', 'b', 'c'] });
    const current = snapshot({ 'sitemap-profession-cities.xml': ['a', 'b'] });

    const undeclared = evaluateSitemapFamilyCoverage(previous, current, NO_DECLARATIONS);
    expect(undeclared.regressions).toEqual([
      { family: 'profession-cities', previousCount: 3, currentCount: 2, delta: -1 },
    ]);

    const declared = evaluateSitemapFamilyCoverage(previous, current, {
      version: 1,
      decreases: [{
        family: 'profession-cities',
        previousCount: 3,
        currentCount: 2,
        reason: 'Removed one URL after confirming its canonical route redirects permanently.',
      }],
    });
    expect(declared.regressions).toEqual([]);
    expect(declared.allowedDecreases).toHaveLength(1);
    expect(declared.staleDeclarations).toEqual([]);
  });

  it('keeps the structural events family ratchet strict', () => {
    const result = evaluateSitemapFamilyCoverage(
      snapshot({ 'sitemap-eventi.xml': familyUrls('events', 100) }),
      snapshot({ 'sitemap-eventi.xml': familyUrls('events', 99) }),
      NO_DECLARATIONS,
    );

    expect(result.regressions).toEqual([
      { family: 'events', previousCount: 100, currentCount: 99, delta: -1 },
    ]);
    expect(result.churn).toEqual([]);
  });

  it('reports the measured orphan-landings decrease as data-driven churn', () => {
    const result = evaluateSitemapFamilyCoverage(
      snapshot({ 'sitemap-orphan-landings.xml': familyUrls('orphan-landings', 1913) }),
      snapshot({ 'sitemap-orphan-landings.xml': familyUrls('orphan-landings', 1906) }),
      NO_DECLARATIONS,
      bridgeEvidence(
        snapshot({ 'sitemap-orphan-landings.xml': familyUrls('orphan-landings', 1913) }),
        snapshot({ 'sitemap-orphan-landings.xml': familyUrls('orphan-landings', 1906) }),
        'orphan-landings',
      ),
    );

    expect(result.regressions).toEqual([]);
    expect(result.churn).toHaveLength(1);
    expect(result.churn[0]).toMatchObject({
      family: 'orphan-landings', previousCount: 1913, currentCount: 1906, delta: -7, tolerance: 0.1,
    });
  });

  it('fails a data-driven decrease closed when bridge evidence is absent', () => {
    const previous = snapshot({ 'sitemap-orphan-landings.xml': familyUrls('orphan-landings', 100) });
    const current = snapshot({ 'sitemap-orphan-landings.xml': familyUrls('orphan-landings', 93) });
    const result = evaluateSitemapFamilyCoverage(previous, current, NO_DECLARATIONS);

    expect(result.churn).toEqual([]);
    expect(result.regressions).toEqual([{ family: 'orphan-landings', previousCount: 100, currentCount: 93, delta: -7 }]);
    expect(result.bridgeEvidenceErrors.join('\n')).toContain('missing or has an unsupported schema');
  });

  it('admits exactly the 10% collapse bound and rejects a decrease beyond it', () => {
    const atBound = evaluateSitemapFamilyCoverage(
      snapshot({ 'sitemap-orphan-landings.xml': familyUrls('orphan-landings', 1000) }),
      snapshot({ 'sitemap-orphan-landings.xml': familyUrls('orphan-landings', 900) }),
      NO_DECLARATIONS,
      bridgeEvidence(
        snapshot({ 'sitemap-orphan-landings.xml': familyUrls('orphan-landings', 1000) }),
        snapshot({ 'sitemap-orphan-landings.xml': familyUrls('orphan-landings', 900) }),
        'orphan-landings',
      ),
    );
    const beyondBound = evaluateSitemapFamilyCoverage(
      snapshot({ 'sitemap-orphan-landings.xml': familyUrls('orphan-landings', 1000) }),
      snapshot({ 'sitemap-orphan-landings.xml': familyUrls('orphan-landings', 899) }),
      NO_DECLARATIONS,
    );

    expect(atBound.regressions).toEqual([]);
    expect(atBound.churn).toMatchObject([{ previousCount: 1000, currentCount: 900, delta: -100, tolerance: 0.1 }]);
    expect(beyondBound.regressions).toEqual([
      { family: 'orphan-landings', previousCount: 1000, currentCount: 899, delta: -101 },
    ]);
    expect(beyondBound.churn).toEqual([]);
  });

  it('treats a profession-cities collapse as a regression and the observed decrease as churn', () => {
    const collapsed = evaluateSitemapFamilyCoverage(
      snapshot({ 'sitemap-profession-cities.xml': familyUrls('profession-cities', 252) }),
      snapshot({ 'sitemap-profession-cities.xml': [] }),
      NO_DECLARATIONS,
    );
    const churn = evaluateSitemapFamilyCoverage(
      snapshot({ 'sitemap-profession-cities.xml': familyUrls('profession-cities', 252) }),
      snapshot({ 'sitemap-profession-cities.xml': familyUrls('profession-cities', 248) }),
      NO_DECLARATIONS,
      bridgeEvidence(
        snapshot({ 'sitemap-profession-cities.xml': familyUrls('profession-cities', 252) }),
        snapshot({ 'sitemap-profession-cities.xml': familyUrls('profession-cities', 248) }),
        'profession-cities',
      ),
    );

    expect(collapsed.regressions).toEqual([
      { family: 'profession-cities', previousCount: 252, currentCount: 0, delta: -252 },
    ]);
    expect(collapsed.churn).toEqual([]);
    expect(churn.regressions).toEqual([]);
    expect(churn.churn).toMatchObject([
      { family: 'profession-cities', previousCount: 252, currentCount: 248, delta: -4, tolerance: 0.1 },
    ]);
  });

  it('keeps churn empty when family coverage is unchanged or increases', () => {
    const unchanged = evaluateSitemapFamilyCoverage(
      snapshot({ 'sitemap-orphan-landings.xml': familyUrls('orphan-landings', 2) }),
      snapshot({ 'sitemap-orphan-landings.xml': familyUrls('orphan-landings', 2) }),
      NO_DECLARATIONS,
    );
    const increased = evaluateSitemapFamilyCoverage(
      snapshot({ 'sitemap-orphan-landings.xml': familyUrls('orphan-landings', 2) }),
      snapshot({ 'sitemap-orphan-landings.xml': familyUrls('orphan-landings', 3) }),
      NO_DECLARATIONS,
    );

    expect(unchanged.families.find(({ family }) => family === 'orphan-landings')?.delta).toBe(0);
    expect(unchanged.churn).toEqual([]);
    expect(increased.families.find(({ family }) => family === 'orphan-landings')?.delta).toBe(1);
    expect(increased.churn).toEqual([]);
  });

  it('keeps the existing exact fuel-stations declaration valid', () => {
    const result = evaluateSitemapFamilyCoverage(
      snapshot({ 'sitemap-fuel-italian-stations.xml': familyUrls('fuel-stations', 4116) }),
      snapshot({ 'sitemap-fuel-italian-stations.xml': familyUrls('fuel-stations', 4112) }),
      {
        version: 1,
        decreases: [{
          family: 'fuel-italian-stations',
          previousCount: 4116,
          currentCount: 4112,
          reason: 'Exact fuel-station decline declaration remains valid as an inline fixture.',
        }],
      },
    );

    expect(result.regressions).toEqual([]);
    expect(result.allowedDecreases).toMatchObject([
      { family: 'fuel-italian-stations', previousCount: 4116, currentCount: 4112, delta: -4 },
    ]);
    expect(result.invalidDeclarations).toEqual([]);
    expect(result.staleDeclarations).toEqual([]);
    expect(result.churn).toEqual([]);
  });

  it('diffs unique family URLs with sorted five-item samples without mutating snapshots', () => {
    const removedUrls = familyUrls('removed', 7);
    const addedUrls = familyUrls('added', 7);
    const sharedUrl = 'https://frontaliereticino.ch/shared/';
    const previous = snapshot({
      'sitemap-orphan-landings.xml': [...removedUrls, sharedUrl, removedUrls[0]],
      'archive/sitemap-orphan-landings.xml': [sharedUrl],
    });
    const current = snapshot({
      'sitemap-orphan-landings.xml': [...addedUrls, sharedUrl, addedUrls[0]],
      'archive/sitemap-orphan-landings.xml': [sharedUrl],
    });
    const previousBefore = structuredClone(previous);
    const currentBefore = structuredClone(current);

    expect(diffSitemapFamilyUrls(previous, current, 'orphan-landings')).toEqual({
      removed: 7,
      added: 7,
      removedSample: removedUrls.sort().slice(0, 5),
      addedSample: addedUrls.sort().slice(0, 5),
    });
    expect(previous).toEqual(previousBefore);
    expect(current).toEqual(currentBefore);
  });

  it('consumes an exact decrease declaration after its count becomes the live baseline', () => {
    const declaration = {
      version: 1,
      decreases: [{
        family: 'fuel-italian-stations',
        previousCount: 4,
        currentCount: 3,
        reason: 'Retired missing-price station URLs now resolve to noindex bridges.',
      }],
    };
    const deployed = evaluateSitemapFamilyCoverage(
      snapshot({ 'sitemap-fuel-italian-stations.xml': ['a', 'b', 'c'] }),
      snapshot({ 'sitemap-fuel-italian-stations.xml': ['a', 'b', 'c'] }),
      declaration,
    );
    const laterDecrease = evaluateSitemapFamilyCoverage(
      snapshot({ 'sitemap-fuel-italian-stations.xml': ['a', 'b', 'c'] }),
      snapshot({ 'sitemap-fuel-italian-stations.xml': ['a', 'b'] }),
      declaration,
    );

    expect(deployed.regressions).toEqual([]);
    expect(deployed.consumedDeclarations).toMatchObject([{ family: 'fuel-italian-stations' }]);
    expect(deployed.staleDeclarations).toEqual([]);
    expect(laterDecrease.regressions).toEqual([
      { family: 'fuel-italian-stations', previousCount: 3, currentCount: 2, delta: -1 },
    ]);
  });

  it('rejects broad, stale, malformed, and legacy flat declarations/snapshots', () => {
    const previous = snapshot({ 'sitemap-job-market.xml': ['a', 'b'] });
    const current = snapshot({ 'sitemap-job-market.xml': ['a'] });
    const stale = evaluateSitemapFamilyCoverage(previous, current, {
      version: 1,
      decreases: [{
        family: 'job-market', previousCount: 2, currentCount: 1,
        reason: 'A concrete reason with enough detail for a one-time change.',
      }],
    });
    expect(stale.invalidDeclarations).toHaveLength(0);

    const wrongCounts = evaluateSitemapFamilyCoverage(previous, current, {
      version: 1,
      decreases: [{
        family: 'job-market', previousCount: 200, currentCount: 100,
        reason: 'A concrete reason with enough detail for a one-time change.',
      }],
    });
    expect(wrongCounts.regressions).toHaveLength(1);
    expect(wrongCounts.staleDeclarations).toHaveLength(1);
    expect(() => evaluateSitemapFamilyCoverage([], current, NO_DECLARATIONS)).toThrow(/per-sitemap snapshot/);
    expect(() => evaluateSitemapFamilyCoverage(previous, current, { version: 1, decreases: [{}] }))
      .not.toThrow();
    const invalid = evaluateSitemapFamilyCoverage(previous, current, {
      version: 1,
      decreases: [{ family: 'job-market', previousCount: 2, currentCount: 1, reason: 'short' }],
    });
    expect(invalid.invalidDeclarations).toHaveLength(1);
  });

  it('runs as a blocking post-deploy validator', () => {
    const workflow = readFileSync(resolve(import.meta.dirname, '../.github/workflows/post-deploy-validate-dist.yml'), 'utf8');
    const fastGate = readFileSync(resolve(import.meta.dirname, '../scripts/ci/publisher-fast-gate.mjs'), 'utf8');
    const sitemapDiff = readFileSync(resolve(import.meta.dirname, '../scripts/diff-sitemaps.mjs'), 'utf8');
    expect(workflow).toContain('node scripts/ci/publisher-fast-gate.mjs');
    expect(fastGate).toContain('evaluateSitemapFamilyCoverage');
    expect(sitemapDiff).toContain('filterExternallyServedUrlsFromSitemapCoverage');
    expect(fastGate).toContain('pre-deploy-sitemap-urls.json');
    expect(fastGate).toContain('data/sitemap-family-coverage-declarations.json');
  });
});
