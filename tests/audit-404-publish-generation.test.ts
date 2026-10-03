// @vitest-environment node
//
// Issue #4079 — "404-risk: URLs that would return a GitHub Pages 404".
//
// The audit compares the LIVE apex sitemap against the LIVE shard repos' git
// trees. Those are two different publication channels: a shard is live the
// instant push-section-shard.sh force-pushes it, the apex sitemap only once
// deploy-publish.yml's actions/deploy-pages finishes. The deploy is not atomic
// across ~110 repos, so the two sides can be from different deploys — and then
// "this URL is missing from the shard tree" is not evidence of a 404.
//
// Measured 2026-08-05 over five consecutive daily runs: 32 · 0 · 0 · 97 · 0
// offenders, none persisting into the next run, and 5/5 sampled offenders from
// the 97-run returning HTTP 200 live. The 32-offender run was entirely
// `…/2026-07` month-scoped URLs — a July sitemap against August shard trees.
//
// These tests pin the classification and, just as importantly, its BOUND: a
// shard that has stopped publishing must fail the audit rather than have its
// URLs deferred as skew forever.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = readFileSync(resolve(ROOT, 'scripts/audit-404-risk.mjs'), 'utf-8');

/**
 * The module runs `main()` on import, so the pure helpers are exercised through
 * a rebuilt copy of their source rather than by importing the script.
 */
function loadHelpers(env: Record<string, string> = {}) {
  const pick = (name: string) => {
    const start = SCRIPT.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`helper ${name} not found in audit-404-risk.mjs`);
    // Brace-match from the first `{` after the signature.
    let i = SCRIPT.indexOf('{', start);
    let depth = 0;
    for (; i < SCRIPT.length; i++) {
      if (SCRIPT[i] === '{') depth++;
      else if (SCRIPT[i] === '}' && --depth === 0) return SCRIPT.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces extracting ${name}`);
  };
  const constBlock = (name: string) => {
    const start = SCRIPT.indexOf(`const ${name} =`);
    if (start < 0) throw new Error(`const ${name} not found`);
    const end = SCRIPT.indexOf('\n\n', start);
    return SCRIPT.slice(start, end < 0 ? undefined : end);
  };

  const slugs = JSON.parse(readFileSync(resolve(ROOT, 'scripts/lib/section-shard-slugs.json'), 'utf-8'));
  const src = `
    const SECTION_SLUGS = ${JSON.stringify(slugs)};
    const process = { env: ${JSON.stringify(env)} };
    const flatString = (value) => value;
    ${pick('localeOf')}
    ${pick('extractAlternateHrefs')}
    ${constBlock('SECTION_BY_ROUTE_PREFIX')}
    ${pick('shardOwnerOf')}
    ${pick('ownerGeneration')}
    ${pick('classifyOffender')}
    ${pick('splitByGeneration')}
    ${pick('isSourceSnapshotNewer')}
    ${pick('splitHubOffenders')}
    ${constBlock('SHARD_MAX_AGE_H')}
    ${pick('generationSummary')}
    return { extractAlternateHrefs, shardOwnerOf, classifyOffender, splitByGeneration, splitHubOffenders, generationSummary };
  `;
  // eslint-disable-next-line no-new-func
  return new Function(src)() as {
    extractAlternateHrefs: (xml: string) => string[];
    shardOwnerOf: (p: string) => { kind: string; section?: string; loc: string };
    classifyOffender: (p: string, gen: unknown) => string;
    splitByGeneration: (paths: string[], gen: unknown) => { unserved: string[]; skew: string[] };
    splitHubOffenders: (
      offenders: Array<Record<string, unknown>>,
      deployedSitemapPaths: Set<string>,
      sourceAssembledAtByCompany: Map<string, string>,
      deployedAt: string | null,
      generation: unknown,
    ) => { unserved: Array<Record<string, unknown>>; publishSkew: Array<Record<string, unknown>>; sourceSkew: Array<Record<string, unknown>> };
    generationSummary: (gen: unknown, now?: number) => {
      apexSha: string | null;
      apexAt: string | null;
      shardsTotal: number;
      shardsSameGeneration: number;
      offGeneration: Array<{ shard: string }>;
      staleShards: Array<{ shard: string; ageHours: number }>;
    };
  };
}

const APEX = 'b4ece24cbb661929f597d667fe3a507a5aa1c8ee';

describe('deployed sitemap inventory — locale alternates are part of the set', () => {
  it('extracts xhtml alternate hrefs without changing the <loc> coverage count', () => {
    const { extractAlternateHrefs } = loadHelpers();
    expect(extractAlternateHrefs(`
      <url><loc>https://frontaliereticino.ch/cerca-lavoro-ticino/</loc>
      <xhtml:link rel="alternate" hreflang="de" href="https://frontaliereticino.ch/de/jobs-im-tessin/" />
      <xhtml:link rel="alternate" hreflang="fr" href="https://frontaliereticino.ch/fr/trouver-emploi-tessin/" /></url>
    `)).toEqual([
      'https://frontaliereticino.ch/de/jobs-im-tessin/',
      'https://frontaliereticino.ch/fr/trouver-emploi-tessin/',
    ]);
  });
});

describe('shardOwnerOf — which repo actually serves a path', () => {
  const { shardOwnerOf } = loadHelpers();

  it('attributes a section-shard path to its (section, locale) repo', () => {
    expect(shardOwnerOf('/de/jobs-im-tessin/x')).toEqual({ kind: 'section', section: 'ticino', loc: 'de' });
    expect(shardOwnerOf('/en/find-jobs-aargau/y')).toEqual({ kind: 'section', section: 'argovia', loc: 'en' });
    // IT section paths carry no locale prefix.
    expect(shardOwnerOf('/cerca-lavoro-ticino/z')).toEqual({ kind: 'section', section: 'ticino', loc: 'it' });
  });

  it('attributes a non-section locale path to the locale shard, and IT to the apex', () => {
    expect(shardOwnerOf('/en/border-wait/chiasso-brogeda/2026-07')).toEqual({ kind: 'locale', loc: 'en' });
    expect(shardOwnerOf('/qualcosa/it-only')).toEqual({ kind: 'apex', loc: 'it' });
  });
});

describe('classifyOffender — sound verdict vs snapshot skew', () => {
  const { classifyOffender, splitByGeneration } = loadHelpers();

  const gen = {
    apexSha: APEX,
    shards: {
      en: { sha: 'b4ece24c', at: '2026-08-05T08:46:02Z' }, // same deploy as the apex
      de: { sha: 'aaaaaaaa', at: '2026-08-05T09:10:00Z' }, // a NEWER deploy already pushed
      fr: { sha: 'b4ece24c', at: '2026-08-05T08:45:00Z' },
    },
    sectionShards: {
      ticino: {
        en: { sha: 'b4ece24c', at: '2026-08-05T08:09:50Z' },
        de: { sha: 'aaaaaaaa', at: '2026-08-05T09:05:00Z' },
      },
    },
  };

  it('counts an offender whose shard is on the same deploy as the sitemap', () => {
    expect(classifyOffender('/en/find-jobs-ticino/whatever', gen)).toBe('unserved');
    expect(classifyOffender('/fr/anything-else', gen)).toBe('unserved');
  });

  it('defers an offender whose shard is on a different deploy', () => {
    // Exactly the 2026-08-01 signature: a month-scoped URL from the previous
    // sitemap measured against a shard tree that has already moved on.
    expect(classifyOffender('/de/border-wait/chiasso-brogeda/2026-07', gen)).toBe('publish-skew');
    expect(classifyOffender('/de/jobs-im-tessin/whatever', gen)).toBe('publish-skew');
  });

  it('never excuses an offender when provenance is missing — ambiguity counts as unserved', () => {
    expect(classifyOffender('/de/jobs-im-tessin/x', { ...gen, apexSha: null })).toBe('unserved');
    expect(classifyOffender('/de/jobs-im-tessin/x', { apexSha: APEX, shards: {}, sectionShards: {} })).toBe('unserved');
    // An apex-owned (IT) path has no shard to be skewed against.
    expect(classifyOffender('/qualcosa/it-only', gen)).toBe('unserved');
  });

  it('splits a mixed offender list without losing any entry', () => {
    const paths = [
      '/en/find-jobs-ticino/a',
      '/de/jobs-im-tessin/b',
      '/de/border-wait/x/2026-07',
      '/fr/c',
    ];
    const { unserved, skew } = splitByGeneration(paths, gen);
    expect(unserved).toEqual(['/en/find-jobs-ticino/a', '/fr/c']);
    expect(skew).toEqual(['/de/jobs-im-tessin/b', '/de/border-wait/x/2026-07']);
    expect(unserved.length + skew.length).toBe(paths.length);
  });
});

describe('splitHubOffenders — current crawler data vs deployed pages', () => {
  const generation = {
    apexSha: APEX,
    shards: {},
    sectionShards: { ticino: { de: { sha: 'b4ece24c', at: '2026-10-02T08:00:00Z' } } },
  };

  it('defers a canonical hub absent from the live sitemap only when its source is newer', () => {
    const { splitHubOffenders } = loadHelpers();
    const result = splitHubOffenders(
      [{
        company: 'Città di Locarno',
        locale: 'de',
        builderUrl: '/de/jobs-im-tessin/unternehmen-citta-di-locarno',
        expectedUrl: '/de/jobs-im-tessin/unternehmen-citta-di-locarno',
      }],
      new Set(),
      new Map([['Città di Locarno', '2026-10-02T09:10:46Z']]),
      '2026-10-02T08:00:00Z',
      generation,
    );
    expect(result.sourceSkew).toHaveLength(1);
    expect(result.unserved).toHaveLength(0);
    expect(result.publishSkew).toHaveLength(0);
  });

  it('keeps old or ambiguous missing hubs as failures', () => {
    const { splitHubOffenders } = loadHelpers();
    const base = {
      company: 'Old Company',
      locale: 'de',
      builderUrl: '/de/jobs-im-tessin/unternehmen-old-company',
      expectedUrl: '/de/jobs-im-tessin/unternehmen-old-company',
    };
    const result = splitHubOffenders(
      [base, { ...base, company: 'Unknown Company', builderUrl: '/de/jobs-im-tessin/unternehmen-unknown-company', expectedUrl: '/de/jobs-im-tessin/unternehmen-unknown-company' }],
      new Set(),
      new Map([['Old Company', '2026-10-01T08:00:00Z']]),
      '2026-10-02T08:00:00Z',
      generation,
    );
    expect(result.unserved.map((o) => o.company)).toEqual(['Old Company', 'Unknown Company']);
    expect(result.sourceSkew).toHaveLength(0);
  });

  it('never defers a wrong locale prefix as source skew', () => {
    const { splitHubOffenders } = loadHelpers();
    const offGeneration = {
      ...generation,
      sectionShards: { ticino: { de: { sha: 'aaaaaaaa', at: '2026-10-02T08:30:00Z' } } },
    };
    const result = splitHubOffenders(
      [{
        company: 'Città di Locarno',
        locale: 'de',
        builderUrl: '/de/jobs-im-tessin/azienda-citta-di-locarno',
        expectedUrl: '/de/jobs-im-tessin/unternehmen-citta-di-locarno',
      }],
      new Set(),
      new Map([['Città di Locarno', '2026-10-02T09:10:46Z']]),
      '2026-10-02T08:00:00Z',
      offGeneration,
    );
    expect(result.unserved).toHaveLength(1);
    expect(result.publishSkew).toHaveLength(0);
    expect(result.sourceSkew).toHaveLength(0);
  });
});

describe('sitemap inventory completeness', () => {
  it('fails before newsletter hub classification when a child fetch fails', () => {
    const childFailure = SCRIPT.indexOf('failedSitemapChildren.push(child)');
    const guard = SCRIPT.indexOf('if (failedSitemapChildren.length > 0)');
    const newsletterCheck = SCRIPT.indexOf('// ── (B) NEWSLETTER HUB-LINK CORRECTNESS');

    expect(childFailure).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(childFailure);
    expect(guard).toBeLessThan(newsletterCheck);
    expect(SCRIPT.slice(guard, newsletterCheck)).toContain('process.exit(2)');
  });
});

describe('generationSummary — the deferral is bounded, not open-ended', () => {
  const NOW = Date.parse('2026-08-05T10:00:00Z');

  it('reports an off-generation but recently-pushed shard as skew, not stale', () => {
    const { generationSummary } = loadHelpers();
    const s = generationSummary(
      {
        apexSha: APEX,
        shards: { en: { sha: 'aaaaaaaa', at: '2026-08-05T09:30:00Z' } },
        sectionShards: {},
      },
      NOW,
    );
    expect(s.offGeneration.map((r) => r.shard)).toEqual(['locale-en']);
    expect(s.staleShards).toEqual([]);
  });

  it('flags a shard that has stopped publishing — the uri-it class the audit could not see', () => {
    const { generationSummary } = loadHelpers();
    const s = generationSummary(
      {
        apexSha: APEX,
        shards: { en: { sha: 'b4ece24c', at: '2026-08-05T09:50:00Z' } },
        // Failed on every deploy for 3 days behind a ::warning:: in a green run.
        sectionShards: { uri: { it: { sha: 'deadbeef', at: '2026-08-02T06:00:00Z' } } },
      },
      NOW,
    );
    expect(s.shardsSameGeneration).toBe(1);
    expect(s.staleShards.map((r) => r.shard)).toEqual(['uri-it']);
    expect(s.staleShards[0].ageHours).toBeGreaterThan(24);
  });

  it('honours AUDIT_404_SHARD_MAX_AGE_H for a deliberately frozen shard', () => {
    const { generationSummary } = loadHelpers({ AUDIT_404_SHARD_MAX_AGE_H: '96' });
    const s = generationSummary(
      {
        apexSha: APEX,
        shards: {},
        sectionShards: { uri: { it: { sha: 'deadbeef', at: '2026-08-02T06:00:00Z' } } },
      },
      NOW,
    );
    expect(s.staleShards).toEqual([]);
  });
});

describe('the audit still fails on a real finding', () => {
  it('exits non-zero on same-generation offenders AND on a stale shard', () => {
    // The exit condition must cover both, or the classification would become a
    // way to never fail (Non-Negotiable #1: never soften an audit to pass).
    expect(SCRIPT).toMatch(/if \(total404 > 0 \|\| staleCount > 0\)/);
    expect(SCRIPT).toMatch(/const staleCount = report\.checks\.publishGeneration\.staleShards\.length/);
  });

  it('still reports every deferred offender instead of dropping it', () => {
    expect(SCRIPT).toMatch(/publishSkew: sitemapSplit\.skew\.length/);
    expect(SCRIPT).toMatch(/publishSkewSample: sitemapSplit\.skew\.slice/);
    expect(SCRIPT).toMatch(/offendersBeforeGenerationSplit: sitemapOffenders\.length/);
  });

  it('reads the apex generation from the file the deploy actually publishes', () => {
    expect(SCRIPT).toContain('/commit-hash.txt');
  });
});
