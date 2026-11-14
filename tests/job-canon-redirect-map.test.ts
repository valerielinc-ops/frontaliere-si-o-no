import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertJobCanonV2ShardWithinLimit,
  assertMaxShardGrowthWithinPercent,
  jobCanonRedirectMapPlugin,
} from '../build-plugins/jobCanonRedirectMapPlugin';
import {
  knownSlugsLegacyFile,
  knownSlugsShardFile,
  knownSlugsShardIndex,
  readAllKnownJobSlugs,
  writeAllKnownJobSlugs,
} from '../scripts/lib/all-known-job-slugs-store.mjs';
import {
  assertBridgePathDistCoverage,
  assertBridgePathClassificationCoverage,
  buildTrackedJobCanonEntries,
  buildTrackedJobCanonEntriesFromPersistedRegistry,
  buildActiveJobBridgePathPlan,
  classifyBridgePathsFromFinalWorkerMap,
  classifyBridgePaths,
  emitActiveJobCanonAliases,
  planActiveJobCanonAliases,
  reconcileFinalWorkerSlugMapRows,
  type ActiveJobSlugMapRow,
  type JobCanonEntryLike,
} from '../build-plugins/shared/jobCanonBridgePaths';
import { buildCanonicalJobDetailPath } from '../build-plugins/shared/jobDetailPath';
import { jobCanonTarget } from '../infra/cloudflare-worker/locale-router.js';
import { setJobCanonOrderingFields } from '../build-plugins/shared/jobCanonInputs';
import {
  buildJobSlugShards,
  jobCanonV2ShardKey,
  jobSlugShardKey,
  type SlugMapJobEntry,
} from '../services/jobSlugShards';

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

vi.mock('../build-plugins/jobsSeoPagesPlugin', () => ({
  compareActiveJobsByStableOrder: (left: ActiveJobSlugMapRow, right: ActiveJobSlugMapRow) => {
    const timestamp = (job: ActiveJobSlugMapRow): number => {
      for (const value of [job.datePosted, job.firstSeenAt]) {
        const parsed = value ? new Date(String(value)).getTime() : 0;
        if (parsed > 0 && !Number.isNaN(parsed)) return parsed;
      }
      return 0;
    };
    const delta = timestamp(right) - timestamp(left);
    return delta || String(left.id || left.slug || '').localeCompare(String(right.id || right.slug || ''));
  },
  buildNativeJobPrefixIndex: () => ({}),
  buildReservedHubSlugs: () => new Set<string>(),
  nativeJobPathRecoveredByWorker: () => false,
}));

/**
 * The plugin emits dist/job-canon/<shard>.json (slug → {locale: section prefix})
 * from the canonical slug registry, so public/404.html / the Worker can redirect
 * a canton-drift orphan (same slug, wrong/old canton section) to the slug's
 * current canonical page at request time. Invariants:
 *   - the slug is keyed under the 2-char shard of its localized last segment,
 *   - the value is a PER-LOCALE object of canonical section prefixes (URL minus the
 *     slug segment) — NOT collapsed to one locale, since the slug is identical
 *     across locales and a flat value would 301 en/de/fr orphans to the IT page,
 *   - the same slug under a DIFFERENT requested canton rebuilds to the canonical.
 */
describe('jobCanonRedirectMapPlugin', () => {
  let tmp: string;
  let previousBuildLocale: string | undefined;

  const tracking = {
    'capo-ottimizzazione-portafoglio-ffs-zollikofen': {
      it: '/cerca-lavoro-berna/capo-ottimizzazione-portafoglio-ffs-zollikofen',
      de: '/de/jobs-in-bern/capo-ottimizzazione-portafoglio-ffs-zollikofen',
    },
    'data-engineer-acme-lugano': {
      it: '/cerca-lavoro-ticino/data-engineer-acme-lugano',
    },
    // Registry key = Italian slug; the French/English pages carry localized
    // slugs (one of them with the trailing slash some registry rows have).
    'acquirente-strategico-yellowshark-weinfelden': {
      it: '/cerca-lavoro-turgovia/acquirente-strategico-yellowshark-weinfelden',
      fr: '/fr/trouver-emploi-thurgovie/acheteur-strategique-yellowshark-weinfelden/',
      en: '/en/find-jobs-thurgau/strategic-buyer-yellowshark-weinfelden',
    },
    // A second key whose German page really ends in the first key: that exact
    // prefix must win over any alias for the first key in `de`.
    'einkaufer-yellowshark': {
      de: '/de/jobs-im-thurgau/acquirente-strategico-yellowshark-weinfelden',
    },
  };

  beforeAll(async () => {
    previousBuildLocale = process.env.BUILD_LOCALE;
    process.env.BUILD_LOCALE = 'it';
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'job-canon-'));
    fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'dist', 'data'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'dist', 'data', 'jobs-slug-map.json'), '[]');
    setJobCanonOrderingFields([]);
    writeAllKnownJobSlugs(tracking, tmp);
    const plugin = jobCanonRedirectMapPlugin(tmp);
    await (plugin.closeBundle as () => Promise<void>).call(plugin);
  }, 60_000);

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (previousBuildLocale === undefined) delete process.env.BUILD_LOCALE;
    else process.env.BUILD_LOCALE = previousBuildLocale;
  });

  const readShard = (slug: string): Record<string, Record<string, string>> => {
    const sk = slug.slice(0, 2).toLowerCase().replace(/[^a-z0-9]/g, '_');
    return JSON.parse(fs.readFileSync(path.join(tmp, 'dist', 'job-canon', `${sk}.json`), 'utf-8'));
  };

  const readV2Shard = (slug: string): Record<string, Record<string, string>> =>
    JSON.parse(fs.readFileSync(path.join(tmp, 'dist', 'job-canon', 'v2', `${jobCanonV2ShardKey(slug)}.json`), 'utf-8'));

  it('maps the IT localized slug to its canonical section prefix', () => {
    const shard = readShard('capo-ottimizzazione-portafoglio-ffs-zollikofen');
    expect(shard['capo-ottimizzazione-portafoglio-ffs-zollikofen'].it).toBe('/cerca-lavoro-berna');
  });

  it('writes the same entry shape to the matching v1 and v2 shards', () => {
    const slug = 'capo-ottimizzazione-portafoglio-ffs-zollikofen';
    expect(readV2Shard(slug)[slug]).toEqual(readShard(slug)[slug]);
    const v2Files = fs.readdirSync(path.join(tmp, 'dist', 'job-canon', 'v2'));
    expect(v2Files.length).toBeGreaterThan(0);
    expect(v2Files.every((file) => /^[0-9a-f]{3}\.json$/.test(file))).toBe(true);
  });

  it('reconstructs the same Worker targets as PR-A registry output for bridge candidates', () => {
    const logicalTracking = readAllKnownJobSlugs(tmp) as Record<string, Record<string, string>>;
    const candidateSlugs = new Set(Object.keys(logicalTracking));
    for (const paths of Object.values(logicalTracking)) {
      for (const value of Object.values(paths ?? {})) {
        const slug = typeof value === 'string' ? value.replace(/\/+$/, '').split('/').pop() : '';
        if (slug) candidateSlugs.add(slug);
      }
    }
    const reconstructed = buildTrackedJobCanonEntries(logicalTracking, candidateSlugs);
    const emitted = new Map<string, Record<string, unknown>>();
    for (const file of fs.readdirSync(path.join(tmp, 'dist', 'job-canon'))) {
      if (!/^[a-z0-9_]{2}\.json$/.test(file)) continue;
      const shard = JSON.parse(fs.readFileSync(path.join(tmp, 'dist', 'job-canon', file), 'utf8')) as Record<string, Record<string, unknown>>;
      for (const [slug, entry] of Object.entries(shard)) emitted.set(slug, entry);
    }

    for (const slug of candidateSlugs) {
      for (const locale of ['it', 'en', 'de', 'fr'] as const) {
        expect(jobCanonTarget(reconstructed.entries.get(slug), slug, locale))
          .toBe(jobCanonTarget(emitted.get(slug), slug, locale));
      }
    }
  });

  it('uses the shared djb2-xor hash for v2 and preserves the v1 hash modulo', () => {
    for (const slug of [
      'servizio-clienti-transport-specialista-cippa-trasporti-sa-chiasso',
      'verkaufer-in-kassen-services-coop-genossenschaft-sins',
      'verkäufer-élève-東京',
    ]) {
      expect(Number.parseInt(jobCanonV2ShardKey(slug), 16) % 256)
        .toBe(Number.parseInt(jobSlugShardKey(slug), 16));
    }
  });

  it('keeps the v2 hash in parity with the Worker implementation', () => {
    // Expected keys are taken from the Worker implementation in PR #18442.
    // The branch base can predate that change, so these vectors keep the parity
    // test independent of which Worker blob a local sparse checkout materializes.
    expect(jobCanonV2ShardKey('servizio-clienti-transport-specialista-cippa-trasporti-sa-chiasso')).toBe('c63');
    expect(jobCanonV2ShardKey('verkaufer-in-kassen-services-coop-genossenschaft-sins')).toBe('675');
    expect(jobCanonV2ShardKey('verkäufer-élève-東京')).toBe('b6c');
  });

  it('keeps the DE prefix under its own locale (no cross-locale collapse to IT)', () => {
    // it + de share the same last segment; the per-locale object preserves BOTH,
    // so a /de orphan never 301s to the IT page (the bug this map shape prevents).
    const shard = readShard('capo-ottimizzazione-portafoglio-ffs-zollikofen');
    const entry = shard['capo-ottimizzazione-portafoglio-ffs-zollikofen'];
    expect(entry.it).toBe('/cerca-lavoro-berna');
    expect(entry.de).toBe('/de/jobs-in-bern');
  });

  it('rebuilds a canton-orphan request to the canonical page per locale (consumer logic)', () => {
    // Request the same slug under the WRONG canton — the consumer rebuilds the URL
    // using the prefix for the REQUEST's own locale.
    const shard = readShard('capo-ottimizzazione-portafoglio-ffs-zollikofen');
    const slug = 'capo-ottimizzazione-portafoglio-ffs-zollikofen';
    const itCanon = `${shard[slug].it}/${slug}/`;
    expect(itCanon).toBe('/cerca-lavoro-berna/capo-ottimizzazione-portafoglio-ffs-zollikofen/');
    expect(itCanon).not.toBe('/cerca-lavoro-ticino/capo-ottimizzazione-portafoglio-ffs-zollikofen/');
    const deCanon = `${shard[slug].de}/${slug}/`;
    // A /de orphan must resolve to the DE page, never the IT one.
    expect(deCanon).toBe('/de/jobs-in-bern/capo-ottimizzazione-portafoglio-ffs-zollikofen/');
    expect(deCanon).not.toBe(itCanon);
  });

  // The build no longer writes a 200 copy at /<loc>/<TI section>/<registry key>/
  // for en/de/fr; when this locale's page has a DIFFERENT slug the Worker needs
  // the full localized path to 301 there (`alias`).
  it('records an en/de/fr alias when the localized slug differs from the registry key', () => {
    const entry = readShard('acquirente-strategico-yellowshark-weinfelden')['acquirente-strategico-yellowshark-weinfelden'] as unknown as {
      it?: string; fr?: string; en?: string; de?: string; alias?: Record<string, string>;
    };
    expect(entry.it).toBe('/cerca-lavoro-turgovia');
    expect(entry.fr).toBeUndefined();
    expect(entry.alias?.fr).toBe('/fr/trouver-emploi-thurgovie/acheteur-strategique-yellowshark-weinfelden');
    expect(entry.alias?.en).toBe('/en/find-jobs-thurgau/strategic-buyer-yellowshark-weinfelden');
  });

  it('lets an exact prefix win over an alias and never aliases IT', () => {
    const entry = readShard('acquirente-strategico-yellowshark-weinfelden')['acquirente-strategico-yellowshark-weinfelden'] as unknown as {
      de?: string; alias?: Record<string, string>;
    };
    expect(entry.de).toBe('/de/jobs-im-thurgau');
    expect(entry.alias?.de).toBeUndefined();
    expect(entry.alias?.it).toBeUndefined();
    // Keys whose localized slug equals the key get no alias at all.
    const same = readShard('capo-ottimizzazione-portafoglio-ffs-zollikofen')['capo-ottimizzazione-portafoglio-ffs-zollikofen'] as unknown as {
      alias?: unknown;
    };
    expect(same.alias).toBeUndefined();
  });
});

describe('active job aliases in the IT /job-canon publishing leg', () => {
  let tmp: string;
  let previousBuildLocale: string | undefined;
  let activePluginLogs: string[] = [];

  const job = (
    id: string,
    canton: string,
    slugs: Record<'it' | 'en' | 'de' | 'fr', string>,
    extras: Pick<ActiveJobSlugMapRow, 'previousSlugs' | 'previousSlugsByLocale'> = {},
  ): ActiveJobSlugMapRow => ({ id, slug: slugs.it, canton, slugByLocale: slugs, ...extras });

  const activeJobs: ActiveJobSlugMapRow[] = [
    job('localized-claimant', 'ZH', {
      it: 'locale-it-current', en: 'locale-en-current', de: 'locale-de-current', fr: 'locale-fr-current',
    }, {
      previousSlugsByLocale: {
        it: ['legacy-it-v1'],
        en: ['legacy-en-v1', 'cross-foreign-en-v1', 'registry-collision-old-v1'],
        de: ['legacy-de-v1'],
        fr: ['legacy-fr-v1'],
      },
    }),
    job('flat-claimant', 'GE', {
      it: 'flat-it-current', en: 'flat-en-current', de: 'flat-de-current', fr: 'flat-fr-current',
    }, { previousSlugs: ['flat-old-v1'] }),
    job('winner-a', 'ZH', {
      it: 'winner-a-it', en: 'winner-a-en', de: 'winner-a-de', fr: 'winner-a-fr',
    }, { previousSlugsByLocale: { it: ['shared-old-v1'] } }),
    job('winner-b', 'ZH', {
      it: 'winner-b-it', en: 'winner-b-en', de: 'winner-b-de', fr: 'winner-b-fr',
    }, { previousSlugsByLocale: { it: ['shared-old-v1'] } }),
    job('real-page-claimant', 'VD', {
      it: 'real-current-it', en: 'real-current-en', de: 'real-current-de', fr: 'real-current-fr',
    }, { previousSlugsByLocale: { it: ['real-old-v1'] } }),
    job('active-slug-wins', 'TI', {
      it: 'real-old-v1', en: 'active-slug-en', de: 'active-slug-de', fr: 'active-slug-fr',
    }),
    job('cippatrasporti-c38396f76831', 'TI', {
      it: 'customer-service-transport-specialist-cippa-trasporti-sa-chiasso',
      en: 'customer-service-transport-specialist-cippa-trasporti-sa-chiasso-en',
      de: 'kundenservice-transport-spezialist-cippa-trasporti-sa-chiasso',
      fr: 'specialiste-service-client-transport-cippa-trasporti-sa-chiasso',
    }, {
      previousSlugsByLocale: {
        it: ['servizio-clienti-transport-specialista-cippa-trasporti-sa-chiasso'],
      },
    }),
    job('sins-active-prefix', 'AG', {
      it: 'sins-it-current', en: 'sins-en-current',
      de: 'verkaufer-in-kassen-services-coop-genossenschaft-sins', fr: 'sins-fr-current',
    }),
    job('prefix-conflict-ag', 'AG', {
      it: 'prefix-conflict-ag-it', en: 'prefix-conflict-ag-en',
      de: 'shared-active-prefix-conflict', fr: 'prefix-conflict-ag-fr',
    }),
    job('prefix-conflict-zh', 'ZH', {
      it: 'prefix-conflict-zh-it', en: 'prefix-conflict-zh-en',
      de: 'shared-active-prefix-conflict', fr: 'prefix-conflict-zh-fr',
    }),
    job('locale-prefix-owner', 'ZH', {
      it: 'locale-prefix-legacy-v1', en: 'locale-prefix-current-en',
      de: 'locale-prefix-legacy-v1', fr: 'locale-prefix-legacy-v1',
    }, { previousSlugsByLocale: { en: ['locale-prefix-legacy-v1'] } }),
    job('ambiguous-zh', 'ZH', {
      it: 'ambiguous-zh-it', en: 'ambiguous-zh-en', de: 'ambiguous-zh-de', fr: 'ambiguous-zh-fr',
    }, { previousSlugsByLocale: { it: ['ambiguous-old-v1'] } }),
    job('ambiguous-vd', 'VD', {
      it: 'ambiguous-vd-it', en: 'ambiguous-vd-en', de: 'ambiguous-vd-de', fr: 'ambiguous-vd-fr',
    }, { previousSlugsByLocale: { it: ['ambiguous-old-v1'] } }),
    job('auto-alias', 'TI', {
      it: 'same-real-slug', en: 'same-real-slug', de: 'same-real-slug', fr: 'same-real-slug',
    }, {
      previousSlugsByLocale: {
        it: ['same-real-slug'], en: ['same-real-slug'], de: ['same-real-slug'], fr: ['same-real-slug'],
      },
    }),
    // Deliberately older first in the artifact: jobsSeoPagesPlugin orders by
    // datePosted, and the newer claimant owns a colliding cross-locale path.
    { ...job('cross-a-older', 'GE', {
      it: 'cross-a-it', en: 'cross-foreign', de: 'cross-a-de', fr: 'cross-a-fr',
    }), datePosted: daysAgo(43) },
    { ...job('cross-z-newer', 'ZH', {
      it: 'cross-z-it', en: 'cross-foreign', de: 'cross-z-de', fr: 'cross-z-fr',
    }), datePosted: daysAgo(12) },
    job('worker-override-claim', 'ZH', {
      it: 'worker-override-claim-it', en: 'worker-override-claim-en',
      de: 'worker-override-claim-de', fr: 'worker-override-claim-fr',
    }, {
      previousSlugsByLocale: {
        it: [
          'worker-override-omitted-en',
          'worker-effective-direct-en',
          'worker-native-recovery-en',
          'worker-duplicate-entry-en',
        ],
      },
    }),
    job('worker-reset-route', 'ZH', {
      it: 'worker-reset-route-it', en: 'worker-reset-route-en',
      de: 'worker-reset-candidate', fr: 'worker-reset-route-fr',
    }),
    job('worker-reset-target-route', 'ZH', {
      it: 'worker-reset-target-it', en: 'worker-reset-target-en',
      de: 'worker-reset-target-de', fr: 'worker-reset-native-target',
    }),
  ];

  beforeAll(async () => {
    previousBuildLocale = process.env.BUILD_LOCALE;
    process.env.BUILD_LOCALE = 'it';
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'job-canon-active-'));
    fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'dist', 'data'), { recursive: true });
    setJobCanonOrderingFields(activeJobs);
    const publicSlugMapRows = activeJobs.map((job) => {
      const { datePosted: _datePosted, firstSeenAt: _firstSeenAt, ...row } = job;
      return row;
    });
    fs.writeFileSync(path.join(tmp, 'dist', 'data', 'jobs-slug-map.json'), JSON.stringify(publicSlugMapRows));
    fs.writeFileSync(path.join(tmp, 'data', 'previous-slug-winners.json'), JSON.stringify({
      'ZH::it::shared-old-v1': {
        winnerJobIdentifier: 'winner-b',
        winnerCanonical: 'winner-b-it',
        decidedAt: '2026-11-13T00:00:00.000Z',
        lastSeenAt: '2026-11-13T00:00:00.000Z',
        score: 0.7,
        candidatesCount: 2,
        canton: 'ZH',
      },
    }));
    writeAllKnownJobSlugs({
      'real-old-v1': { it: '/cerca-lavoro-ticino/real-old-v1' },
      'servizio-clienti-transport-specialista-cippa-trasporti-sa-chiasso': {
        it: '/cerca-lavoro-ticino/servizio-clienti-transport-specialista-cippa-trasporti-sa-chiasso',
      },
      'locale-prefix-legacy-v1': {
        it: '/cerca-lavoro-ticino/locale-prefix-legacy-v1',
        en: '/en/find-jobs-geneva/locale-prefix-legacy-v1',
        de: '/de/jobs-im-genf/locale-prefix-legacy-v1',
        fr: '/fr/trouver-emploi-geneve/locale-prefix-legacy-v1',
      },
      'registry-collision-old-v1': {
        it: '/cerca-lavoro-ticino/registry-collision-old-v1',
        en: '/en/find-jobs-thurgau/registry-canonical-v1',
      },
      'cross-foreign': { en: '/en/find-jobs-geneva/cross-foreign' },
      'verkaufer-in-kassen-services-coop-genossenschaft-sins': {
        de: '/de/jobs-im-zurich/verkaufer-in-kassen-services-coop-genossenschaft-sins',
      },
      'shared-active-prefix-conflict': {
        de: '/de/jobs-in-zurich/shared-active-prefix-conflict',
      },
      'worker-override-omitted-en': { de: '/de/jobs-im-tessin/worker-override-omitted-en' },
      'worker-effective-direct-en': { en: '/en/find-jobs-geneva/worker-effective-direct-en' },
      'worker-native-recovery-en': { de: '/de/jobs-im-tessin/worker-native-recovery-en' },
      'worker-override-claim-en': { en: '/en/find-jobs-zurich/worker-native-recovery-en' },
      'worker-duplicate-entry-en': { de: '/de/jobs-im-tessin/worker-duplicate-entry-en' },
      'worker-reset-candidate': { en: '/en/find-jobs-zurich/worker-reset-candidate' },
    }, tmp);
    const duplicateSlug = 'worker-duplicate-entry-en';
    const duplicateShardFile = knownSlugsShardFile(knownSlugsShardIndex(duplicateSlug), tmp);
    const duplicateShard = JSON.parse(fs.readFileSync(duplicateShardFile, 'utf-8')) as {
      slugs: Record<string, Record<string, string>>;
    };
    delete duplicateShard.slugs[duplicateSlug];
    const duplicateShardEntries = Object.entries(duplicateShard.slugs).map(([slug, paths]) =>
      `    ${JSON.stringify(slug)}: ${JSON.stringify(paths)}`);
    duplicateShardEntries.push(
      `    ${JSON.stringify(duplicateSlug)}: ${JSON.stringify({ en: `/en/find-jobs-geneva/${duplicateSlug}` })}`,
      `    ${JSON.stringify(duplicateSlug)}: ${JSON.stringify({ de: `/de/jobs-im-tessin/${duplicateSlug}` })}`,
    );
    fs.writeFileSync(
      duplicateShardFile,
      `{
  "slugs": {
${duplicateShardEntries.join(',\n')}
  }
}
`,
    );
    fs.writeFileSync(knownSlugsLegacyFile(tmp), JSON.stringify({
      'worker-override-omitted-en': { en: '/en/find-jobs-geneva/worker-override-omitted-en' },
      'worker-effective-direct-en': { en: '/en/find-jobs-geneva/worker-effective-direct-en' },
      'worker-native-recovery-en': { en: '/en/find-jobs-geneva/worker-native-recovery-en' },
      'worker-reset-candidate': { en: '/en/find-jobs-zurich/worker-reset-candidate' },
    }));
    const resetSlug = 'worker-reset-candidate';
    const resetShardFile = knownSlugsShardFile(knownSlugsShardIndex(resetSlug), tmp);
    const resetShard = JSON.parse(fs.readFileSync(resetShardFile, 'utf-8')) as {
      slugs: Record<string, Record<string, string>>;
    };
    delete resetShard.slugs[resetSlug];
    const resetShardEntries = Object.entries(resetShard.slugs).map(([slug, paths]) =>
      '    ' + JSON.stringify(slug) + ': ' + JSON.stringify(paths));
    resetShardEntries.push(
      '    ' + JSON.stringify(resetSlug) + ': ' + JSON.stringify({
        en: '/en/find-jobs-ticino/worker-reset-candidate',
        de: '/de/jobs-im-tessin/worker-reset-candidate',
        fr: '/fr/trouver-emploi-tessin/worker-reset-candidate',
      }),
      '    ' + JSON.stringify(resetSlug) + ': ' + JSON.stringify({
        en: '/en/find-jobs-ticino/worker-reset-candidate',
        de: '/de/jobs-in-zurich/worker-reset-native-target',
        fr: '/fr/trouver-emploi-zurich/worker-reset-candidate',
      }),
    );
    fs.writeFileSync(resetShardFile, [
      '{',
      '  "slugs": {',
      resetShardEntries.join(',\n'),
      '  }',
      '}',
      '',
    ].join('\n'));
    const plugin = jobCanonRedirectMapPlugin(tmp);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await (plugin.closeBundle as () => Promise<void>).call(plugin);
      activePluginLogs = logSpy.mock.calls.map((call) => String(call[0]));
    } finally {
      logSpy.mockRestore();
    }
  }, 60_000);

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (previousBuildLocale === undefined) delete process.env.BUILD_LOCALE;
    else process.env.BUILD_LOCALE = previousBuildLocale;
  });

  const readShard = (slug: string): Record<string, Record<string, unknown>> => {
    const sk = slug.slice(0, 2).toLowerCase().replace(/[^a-z0-9]/g, '_');
    return JSON.parse(fs.readFileSync(path.join(tmp, 'dist', 'job-canon', `${sk}.json`), 'utf-8'));
  };

  const readEntry = (slug: string): JobCanonEntryLike | undefined => {
    const sk = slug.slice(0, 2).toLowerCase().replace(/[^a-z0-9]/g, '_');
    const file = path.join(tmp, 'dist', 'job-canon', `${sk}.json`);
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf-8'))[slug] as JobCanonEntryLike | undefined;
  };

  it('emits each locale-aware previous slug in its own locale, plus cross-locale bridges', () => {
    const cases = [
      ['legacy-it-v1', 'it', '/cerca-lavoro-zurigo/locale-it-current'],
      ['legacy-en-v1', 'en', '/en/find-jobs-zurich/locale-en-current'],
      ['legacy-de-v1', 'de', '/de/jobs-in-zurich/locale-de-current'],
      ['legacy-fr-v1', 'fr', '/fr/trouver-emploi-zurich/locale-fr-current'],
      ['cross-foreign-en-v1', 'it', '/cerca-lavoro-zurigo/locale-it-current'],
      ['locale-en-current', 'it', '/cerca-lavoro-zurigo/locale-it-current'],
    ] as const;
    for (const [slug, locale, target] of cases) {
      expect(readEntry(slug)?.alias?.[locale]).toBe(target);
    }
  });

  it('fans flat legacy previousSlugs out to all four locale prefixes', () => {
    const alias = readEntry('flat-old-v1')?.alias;
    expect(alias).toEqual({
      it: '/cerca-lavoro-ginevra/flat-it-current',
      en: '/en/find-jobs-geneva/flat-en-current',
      de: '/de/jobs-in-genf/flat-de-current',
      fr: '/fr/trouver-emploi-geneve/flat-fr-current',
    });
  });

  it('uses the previousSlugWinners registry winner for a contested slug', () => {
    expect(readEntry('shared-old-v1')?.alias?.it).toBe('/cerca-lavoro-zurigo/winner-b-it');
  });

  it('keeps a registry alias when active bridge candidates claim the same locale and slug', () => {
    expect(readEntry('registry-collision-old-v1')?.alias?.en)
      .toBe('/en/find-jobs-thurgau/registry-canonical-v1');
  });

  it('uses the effective registry locale map and preserves separate native recovery evidence', () => {
    expect(readEntry('worker-override-omitted-en')?.alias?.en)
      .toBe('/en/find-jobs-zurich/worker-override-claim-en');
    expect(readEntry('worker-duplicate-entry-en')?.alias?.en)
      .toBe('/en/find-jobs-zurich/worker-override-claim-en');
    expect(readEntry('worker-effective-direct-en')?.alias?.en).toBeUndefined();
    expect(readEntry('worker-native-recovery-en')?.alias?.en).toBeUndefined();
  });

  it('clears stale native recovery when a later store part replaces a candidate map', () => {
    expect(readEntry('worker-reset-candidate')?.alias?.en)
      .toBe('/en/find-jobs-zurich/worker-reset-route-en');
    // The candidate and active-route identity bits survive both replacements:
    // the final FR self-path remains direct recovery, and its DE target remains
    // native recovery for the other active route.
    expect(readEntry('worker-reset-candidate')?.alias?.fr).toBeUndefined();
    expect(readEntry('worker-reset-native-target')?.alias?.de).toBeUndefined();
  });

  it('uses the stable SEO job order when a cross-locale bridge path has multiple claimants', () => {
    expect(readEntry('cross-foreign')?.alias?.it).toBe('/cerca-lavoro-zurigo/cross-z-it');
  });

  it('preserves real pages and omits ambiguous, automatic, or chained aliases', () => {
    expect(readEntry('real-old-v1')?.it).toBe('/cerca-lavoro-ticino');
    expect(readEntry('real-old-v1')?.alias?.it).toBeUndefined();
    expect(readEntry('ambiguous-old-v1')?.alias?.it).toBeUndefined();
    expect(readEntry('same-real-slug')?.alias).toBeUndefined();
    expect(readEntry('same-real-slug')?.it).toBe('/cerca-lavoro-ticino');
  });

  it('reports ambiguous canton destinations with concrete examples', () => {
    const line = activePluginLogs.find((item) => item.includes('active aliases: '));
    const payload = line?.match(/active aliases: (\{.*\}), heap=/)?.[1];
    expect(payload).toBeDefined();
    const stats = JSON.parse(payload!) as {
      ambiguousCantonGroups: number;
      ambiguousExamples: Array<{ locale: string; slug: string; targets: string[] }>;
    };
    expect(stats.ambiguousCantonGroups).toBeGreaterThan(0);
    expect(stats.ambiguousExamples).toContainEqual(expect.objectContaining({
      locale: 'it',
      slug: 'ambiguous-old-v1',
      targets: [
        '/cerca-lavoro-vaud/ambiguous-vd-it',
        '/cerca-lavoro-zurigo/ambiguous-zh-it',
      ],
    }));
  });

  it('maps the cippa previous IT slug to its current IT URL and removes the historical prefix', () => {
    const oldSlug = 'servizio-clienti-transport-specialista-cippa-trasporti-sa-chiasso';
    const entry = readEntry(oldSlug);
    expect(entry?.it).toBeUndefined();
    expect(entry?.alias?.it).toBe(
      '/cerca-lavoro-ticino/customer-service-transport-specialist-cippa-trasporti-sa-chiasso',
    );
  });

  it('lets a current active slug win over a historical prefix', () => {
    const entry = readEntry('real-old-v1');
    expect(entry?.it).toBe('/cerca-lavoro-ticino');
    expect(entry?.alias?.it).toBeUndefined();
  });

  it('removes a historical prefix only for the locale receiving the alias', () => {
    const entry = readEntry('locale-prefix-legacy-v1');
    expect(entry?.alias?.en).toBe('/en/find-jobs-zurich/locale-prefix-current-en');
    expect(entry?.en).toBeUndefined();
    expect(entry?.it).toBe('/cerca-lavoro-zurigo');
    expect(entry?.de).toBe('/de/jobs-in-zurich');
    expect(entry?.fr).toBe('/fr/trouver-emploi-zurich');
  });

  it('overwrites the Sins historical DE prefix with the active Aargau section', () => {
    const slug = 'verkaufer-in-kassen-services-coop-genossenschaft-sins';
    expect(readEntry(slug)?.de).toBe('/de/jobs-im-aargau');
  });

  it('leaves the active prefix unchanged when two current jobs disagree', () => {
    expect(readEntry('shared-active-prefix-conflict')?.de).toBe('/de/jobs-in-zurich');
    expect(activePluginLogs.some((line) =>
      line.includes('"activeSlugPrefixConflict":2')
      && line.includes('shared-active-prefix-conflict'),
    )).toBe(true);
  });

  it('keeps the two-character shard key and the canonical path builder matches the SEO path', () => {
    expect(fs.existsSync(path.join(tmp, 'dist', 'job-canon', 'fl.json'))).toBe(true);
    expect(readShard('flat-old-v1')['flat-old-v1']).toBeDefined();
    expect(buildCanonicalJobDetailPath('it', { canton: 'ZH' }, 'parity-slug')).toBe('/cerca-lavoro-zurigo/parity-slug/');
    expect(buildCanonicalJobDetailPath('en', { canton: 'ZH' }, 'parity-slug')).toBe('/en/find-jobs-zurich/parity-slug/');
    expect(buildCanonicalJobDetailPath('de', { canton: 'ZH' }, 'parity-slug')).toBe('/de/jobs-in-zurich/parity-slug/');
    expect(buildCanonicalJobDetailPath('fr', { canton: 'ZH' }, 'parity-slug')).toBe('/fr/trouver-emploi-zurich/parity-slug/');
  });
});

describe('job canon bridge path planning and PR-B classification', () => {
  const active = {
    id: 'owner',
    slug: 'owner-it',
    canton: 'ZH',
    slugByLocale: { it: 'owner-it', en: 'owner-en', de: 'owner-de', fr: 'owner-fr' },
    previousSlugs: ['flat-old'],
    previousSlugsByLocale: { en: ['old-en', 'worker-owned', 'reserved-hub', 'azienda-acme'] },
  } satisfies ActiveJobSlugMapRow;

  it('matches the cross-locale emitter predicate and creates legacy-TI mirror paths', () => {
    const plan = buildActiveJobBridgePathPlan([active], {
      winners: {},
      reservedHubSlugs: new Set(['reserved-hub']),
      workerWouldRecover: (_locale, slug) => slug === 'worker-owned',
    });
    const exact = (kind: string, locale: string, slug: string, path: string, target: string) =>
      plan.bridgePaths.some((bridge) => bridge.kind === kind && bridge.locale === locale
        && bridge.slug === slug && bridge.path === path && bridge.targetPath === target);

    expect(exact('legacyTiMirror', 'it', 'flat-old', '/cerca-lavoro-ticino/flat-old/', '/cerca-lavoro-zurigo/owner-it/')).toBe(true);
    expect(exact('crossLocale', 'it', 'owner-en', '/cerca-lavoro-ticino/owner-en/', '/cerca-lavoro-zurigo/owner-it/')).toBe(true);
    expect(exact('crossLocale', 'it', 'old-en', '/cerca-lavoro-ticino/old-en/', '/cerca-lavoro-zurigo/owner-it/')).toBe(true);
    expect(plan.bridgePaths.some((bridge) => bridge.kind === 'crossLocale' && bridge.locale === 'it' && bridge.slug === 'owner-it')).toBe(false);
    expect(plan.bridgePaths.some((bridge) => bridge.slug === 'reserved-hub')).toBe(false);
    expect(plan.bridgePaths.some((bridge) => bridge.kind === 'crossLocale' && bridge.slug === 'worker-owned')).toBe(false);
    expect(plan.bridgePaths.some((bridge) => bridge.kind === 'crossLocale' && bridge.locale === 'it' && bridge.slug === 'azienda-acme')).toBe(false);
    expect(plan.bridgePaths.some((bridge) => bridge.kind === 'crossLocale' && bridge.slug === 'flat-old')).toBe(false);
  });

  it('treats a flat slug duplicated in a locale list as locale-aware, not legacy flat', () => {
    const overlap = {
      ...active,
      previousSlugs: ['flat-overlap'],
      previousSlugsByLocale: { en: ['flat-overlap'] },
    } satisfies ActiveJobSlugMapRow;
    const plan = buildActiveJobBridgePathPlan([overlap], { winners: {}, reservedHubSlugs: new Set() });
    expect(plan.bridgePaths
      .filter((bridge) => bridge.kind === 'previousSlug' && bridge.slug === 'flat-overlap')
      .map((bridge) => bridge.locale)
      .sort()).toEqual(['en']);
    expect(plan.bridgePaths
      .filter((bridge) => bridge.kind === 'legacyTiMirror' && bridge.slug === 'flat-overlap')
      .map((bridge) => bridge.locale)
      .sort()).toEqual(['en']);
  });

  it('applies active-prefix precedence before deciding whether an alias is exact', () => {
    const currentOwner = {
      id: 'current-owner',
      slug: 'current-it',
      canton: 'ZH',
      slugByLocale: { it: 'current-it', en: 'current-en', de: 'shared-current', fr: 'current-fr' },
    } satisfies ActiveJobSlugMapRow;
    const previousOwner = {
      id: 'previous-owner',
      slug: 'previous-it',
      canton: 'TI',
      slugByLocale: { it: 'previous-it', en: 'previous-en', de: 'previous-de', fr: 'previous-fr' },
      previousSlugsByLocale: { de: ['shared-current'] },
    } satisfies ActiveJobSlugMapRow;
    const plan = buildActiveJobBridgePathPlan(
      [currentOwner, previousOwner],
      { winners: {}, reservedHubSlugs: new Set() },
    );
    const bridge = plan.bridgePaths.find((candidate) =>
      candidate.kind === 'previousSlug' && candidate.locale === 'de' && candidate.slug === 'shared-current');
    expect(bridge).toBeDefined();
    expect(plan.activePrefixByLocaleSlug.get('de\u0000shared-current')).toBe('/de/jobs-in-zurich');

    const entry: JobCanonEntryLike = {
      alias: { de: bridge!.targetPath.replace(/\/$/, '') },
    };
    entry.de = plan.activePrefixByLocaleSlug.get('de\u0000shared-current')!;
    const classification = classifyBridgePaths(
      [bridge!],
      new Map([['shared-current', entry]]),
      new Set(),
      plan.activeRouteSlugKeys,
    );
    expect(classification.removable.has(bridge!.path)).toBe(false);
    expect(classification.keepBridge.get(bridge!.path)).toBe('exactPrefix');

    const conflictingOwner = {
      id: 'conflicting-owner',
      slug: 'conflicting-it',
      canton: 'GE',
      slugByLocale: { it: 'conflicting-it', en: 'conflicting-en', de: 'shared-current', fr: 'conflicting-fr' },
    } satisfies ActiveJobSlugMapRow;
    const conflictPlan = buildActiveJobBridgePathPlan(
      [currentOwner, conflictingOwner, previousOwner],
      { winners: {}, reservedHubSlugs: new Set() },
    );
    expect(conflictPlan.activePrefixByLocaleSlug.get('de\u0000shared-current')).toBeNull();
  });

  it('streams the same alias destinations as the bridge-path reference planner', () => {
    const options = {
      winners: {},
      reservedHubSlugs: new Set(['reserved-hub']),
      workerWouldRecover: (_locale: string, slug: string) => slug === 'worker-owned',
    };
    const jobs: ActiveJobSlugMapRow[] = [
      active,
      {
        id: 'ti-old-claim',
        slug: 'ti-current-it',
        canton: 'TI',
        slugByLocale: { it: 'ti-current-it', en: 'ti-current-en', de: 'ti-current-de', fr: 'ti-current-fr' },
        previousSlugsByLocale: { it: ['shared-ti-old'] },
      },
      {
        id: 'zh-old-claim',
        slug: 'zh-current-it',
        canton: 'ZH',
        slugByLocale: { it: 'zh-current-it', en: 'zh-current-en', de: 'zh-current-de', fr: 'zh-current-fr' },
        previousSlugsByLocale: { it: ['shared-ti-old'] },
      },
    ];
    const bridgePlan = buildActiveJobBridgePathPlan(jobs, options);
    const expected = planActiveJobCanonAliases(bridgePlan, () => undefined).aliases
      .map(({ slug, locale, targetPath }) => `${locale}\u0000${slug}\u0000${targetPath.replace(/\/+$/, '')}`)
      .sort();
    const actual: string[] = [];
    emitActiveJobCanonAliases(jobs, {
      ...options,
      entryForSlug: () => undefined,
      emitAlias: (slug, locale, targetPath) => actual.push(`${locale}\u0000${slug}\u0000${targetPath}`),
    });
    expect(actual.sort()).toEqual(expected);
  });

  it('keeps an active current-slug TI mirror ahead of a stale previous-slug mirror', () => {
    const current = {
      id: 'a-current',
      slug: 'current-it-slug',
      canton: 'GE',
      slugByLocale: { it: 'current-it-slug', en: 'current-en-slug', de: 'current-de-slug', fr: 'current-fr-slug' },
    } satisfies ActiveJobSlugMapRow;
    const stale = {
      id: 'b-stale',
      slug: 'stale-it-slug',
      canton: 'ZH',
      slugByLocale: { it: 'stale-it-slug', en: 'stale-en-slug', de: 'stale-de-slug', fr: 'stale-fr-slug' },
      previousSlugsByLocale: { it: ['current-it-slug'] },
    } satisfies ActiveJobSlugMapRow;
    const plan = buildActiveJobBridgePathPlan([current, stale], { winners: {}, reservedHubSlugs: new Set() });
    expect(plan.bridgePaths.some((bridge) => bridge.kind === 'legacyTiMirror'
      && bridge.locale === 'it' && bridge.slug === 'current-it-slug')).toBe(false);
    expect(plan.bridgePaths.some((bridge) => bridge.kind === 'previousSlug'
      && bridge.locale === 'it' && bridge.slug === 'current-it-slug'
      && bridge.path === '/cerca-lavoro-zurigo/current-it-slug/')).toBe(true);
  });

  it('marks a bridge removable only when jobCanonTarget resolves to its exact target', () => {
    const bridgePaths = [
      { path: '/old-section/old-slug/', locale: 'it', slug: 'old-slug', targetPath: '/new-section/current/', kind: 'previousSlug', canton: 'ZH' },
      { path: '/another-section/old-slug/', locale: 'it', slug: 'old-slug', targetPath: '/other-section/other/', kind: 'legacyTiMirror', canton: 'ZH' },
    ] as const;
    const entries = new Map<string, JobCanonEntryLike>([
      ['old-slug', { alias: { it: '/new-section/current' } }],
    ]);
    const classified = classifyBridgePaths(bridgePaths, entries);
    expect(classified.removable).toEqual(new Set(['/old-section/old-slug/']));
    expect(classified.keepBridge.get('/another-section/old-slug/')).toBe('targetMismatch');
  });

  it('keeps late fuzzy and implicit slugs until they exist in the final Worker map', () => {
    const serializedJob = {
      id: 'late-worker-map-fixture',
      slug: 'implicit-legacy-job-slug',
      canton: 'ZH',
      slugByLocale: {
        it: 'current-worker-map-slug',
        en: 'current-worker-map-slug',
        de: 'current-worker-map-slug',
        fr: 'current-worker-map-slug',
      },
    } satisfies ActiveJobSlugMapRow;
    const finalJob = {
      ...serializedJob,
      previousSlugs: ['implicit-legacy-job-slug', 'late-fuzzy-orphan-slug'],
      previousSlugsByLocale: {
        it: ['implicit-legacy-job-slug', 'late-fuzzy-orphan-slug'],
      },
    } satisfies ActiveJobSlugMapRow;
    const emittedBridges = buildActiveJobBridgePathPlan([finalJob], {
      winners: {},
      reservedHubSlugs: new Set(),
    }).bridgePaths;
    const targetBridges = emittedBridges.filter((bridge) =>
      bridge.locale === 'it'
      && ['implicit-legacy-job-slug', 'late-fuzzy-orphan-slug'].includes(bridge.slug),
    );
    expect(targetBridges.length).toBeGreaterThanOrEqual(2);

    const workerEntriesFromRows = (rows: readonly ActiveJobSlugMapRow[]) => {
      const entries = new Map<string, JobCanonEntryLike>();
      emitActiveJobCanonAliases(rows, {
        winners: {},
        reservedHubSlugs: new Set(),
        entryForSlug: () => undefined,
        workerWouldRecover: () => false,
        canWriteCrossLocalePath: () => true,
        emitAlias: (slug, locale, targetPath) => {
          const entry = entries.get(slug) ?? {};
          entry.alias = { ...(entry.alias ?? {}), [locale]: targetPath };
          entries.set(slug, entry);
        },
      });
      return entries;
    };

    // This is the file as localeJobsSplitPlugin originally serialized it:
    // it contains the legacy `job.slug`, but not the later previous-slug fact.
    const workerRows: ActiveJobSlugMapRow[] = [serializedJob];
    const staleInMemoryClassification = classifyBridgePaths(
      targetBridges,
      workerEntriesFromRows([finalJob]),
    );
    expect(staleInMemoryClassification.removable).toEqual(new Set(targetBridges.map((bridge) => bridge.path)));

    const preReconciliationClassification = classifyBridgePathsFromFinalWorkerMap(
      targetBridges,
      workerEntriesFromRows(workerRows),
      new Set(),
    );
    expect(preReconciliationClassification.removable.size).toBe(0);
    expect([...preReconciliationClassification.keepBridge.values()]).toEqual(
      Array.from({ length: targetBridges.length }, () => 'noEntry'),
    );

    const reconciliation = reconcileFinalWorkerSlugMapRows(workerRows, [finalJob]);
    expect(reconciliation.matchedJobIdentifiers).toEqual(new Set(['late-worker-map-fixture']));
    expect(reconciliation.unmatchedJobIdentifiers.size).toBe(0);
    expect(reconciliation.updatedJobCount).toBe(1);
    expect(workerRows[0].previousSlugsByLocale).toEqual({
      it: ['implicit-legacy-job-slug', 'late-fuzzy-orphan-slug'],
    });

    // Round-trip the updated JSON exactly as jobCanonRedirectMapPlugin does
    // when it reads dist/data/jobs-slug-map.json after jobsSeoPagesPlugin.
    const consumedWorkerRows = JSON.parse(JSON.stringify(workerRows)) as ActiveJobSlugMapRow[];
    const consumedShards = buildJobSlugShards(consumedWorkerRows as unknown as SlugMapJobEntry[]);
    expect(consumedShards[jobSlugShardKey('late-fuzzy-orphan-slug')]['late-fuzzy-orphan-slug']?._id)
      .toBe('late-worker-map-fixture');
    const exactMapClassification = classifyBridgePathsFromFinalWorkerMap(
      targetBridges,
      workerEntriesFromRows(consumedWorkerRows),
      reconciliation.matchedJobIdentifiers,
    );
    expect(exactMapClassification.removable).toEqual(new Set(targetBridges.map((bridge) => bridge.path)));
    expect(exactMapClassification.keepBridge.size).toBe(0);
  });

  it('does not reconcile aliases into a serialized row whose route identity drifted', () => {
    const serializedJob: ActiveJobSlugMapRow = {
      id: 'route-drift-fixture',
      slug: 'old-route-slug',
      canton: 'ZH',
      slugByLocale: { it: 'serialized-route' },
      previousSlugs: ['serialized-previous'],
    };
    const finalJob: ActiveJobSlugMapRow = {
      ...serializedJob,
      slugByLocale: { it: 'final-route' },
      previousSlugs: ['late-previous'],
    };

    const reconciliation = reconcileFinalWorkerSlugMapRows([serializedJob], [finalJob]);

    expect(reconciliation.matchedJobIdentifiers.size).toBe(0);
    expect(reconciliation.unmatchedJobIdentifiers).toEqual(new Set(['route-drift-fixture']));
    expect(reconciliation.updatedJobCount).toBe(0);
    expect(serializedJob.previousSlugs).toEqual(['serialized-previous']);
  });

  it('reconstructs registry prefixes and same-locale aliases for candidate paths', () => {
    const tracked = buildTrackedJobCanonEntries({
      'old-it': { it: '/cerca-lavoro-zurigo/old-it' },
      'legacy-en': { en: '/en/find-jobs-ticino/current-en' },
      'prefix-owner': { fr: '/fr/trouver-emploi-zurich/shared-route' },
      'prefix-owner-2': { fr: '/fr/trouver-emploi-berne/shared-route' },
    }, new Set(['old-it', 'legacy-en', 'current-en', 'shared-route']));

    expect(tracked.entries.get('old-it')?.it).toBe('/cerca-lavoro-zurigo');
    expect(tracked.entries.get('legacy-en')?.alias?.en).toBe('/en/find-jobs-ticino/current-en');
    expect(tracked.entries.get('current-en')?.en).toBe('/en/find-jobs-ticino');
    expect(tracked.entries.get('shared-route')?.fr).toBe('/fr/trouver-emploi-zurich');
  });

  it('classifies from the persisted streamed registry after a late compatibility overwrite', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-canon-persisted-classification-'));
    const previousLocale = process.env.BUILD_LOCALE;
    try {
      fs.mkdirSync(path.join(root, 'data'), { recursive: true });
      fs.mkdirSync(path.join(root, 'dist', 'data'), { recursive: true });
      fs.writeFileSync(path.join(root, 'dist', 'data', 'jobs-slug-map.json'), '[]');

      const persistedRegistry = {
        'compatibility-old-route': { en: '/en/find-jobs-zurich/worker-actual-destination' },
        'exact-old-route': { en: '/en/find-jobs-bern/worker-exact-destination' },
        'later-prefix-owner': { fr: '/fr/trouver-emploi-berne/shared-prefix-candidate' },
      };
      writeAllKnownJobSlugs(persistedRegistry, root);
      // The legacy part is read first, but the numbered shard is the later
      // owner of compatibility-old-route. Duplicate source keys inside the
      // legacy part retain file-order behavior for equal-order prefix paths.
      fs.writeFileSync(knownSlugsLegacyFile(root), `{
  "compatibility-old-route": { "en": "/en/find-jobs-ticino/legacy-compatibility-target" },
  "first-prefix-owner": { "fr": "/fr/trouver-emploi-zurich/shared-prefix-candidate" },
  "first-prefix-owner": { "fr": "/fr/trouver-emploi-geneve/shared-prefix-candidate" }
}`);

      process.env.BUILD_LOCALE = 'it';
      setJobCanonOrderingFields([]);
      const workerPlugin = jobCanonRedirectMapPlugin(root);
      await (workerPlugin.closeBundle as () => Promise<void>).call(workerPlugin);
      const workerShard = JSON.parse(fs.readFileSync(
        path.join(root, 'dist', 'job-canon', 'v2', `${jobCanonV2ShardKey('compatibility-old-route')}.json`),
        'utf8',
      )) as Record<string, { alias?: Record<string, string> }>;
      expect(workerShard['compatibility-old-route']?.alias?.en)
        .toBe('/en/find-jobs-zurich/worker-actual-destination');
      const workerPrefixShard = JSON.parse(fs.readFileSync(
        path.join(root, 'dist', 'job-canon', 'v2', `${jobCanonV2ShardKey('shared-prefix-candidate')}.json`),
        'utf8',
      )) as Record<string, Record<string, string>>;
      expect(workerPrefixShard['shared-prefix-candidate']?.fr).toBe('/fr/trouver-emploi-zurich');

      // This models the GSC compatibility merge performed after the registry
      // write: the in-memory row now disagrees with the Worker input on disk.
      const tracking = readAllKnownJobSlugs(root) as Record<string, Record<string, string>>;
      tracking['compatibility-old-route'].en = '/en/find-jobs-ticino/legacy-compatibility-target';
      const bridgePaths = [
        {
          path: '/en/jobs-im-tessin/compatibility-old-route/',
          locale: 'en',
          slug: 'compatibility-old-route',
          targetPath: '/en/find-jobs-ticino/legacy-compatibility-target/',
          kind: 'previousSlug',
          canton: 'TI',
          sourceJobIdentifier: 'reconciled-active-job',
        },
        {
          path: '/en/jobs-im-tessin/exact-old-route/',
          locale: 'en',
          slug: 'exact-old-route',
          targetPath: '/en/find-jobs-bern/worker-exact-destination/',
          kind: 'previousSlug',
          canton: 'BE',
          sourceJobIdentifier: 'reconciled-active-job',
        },
      ] as const;
      const bridgeSlugs = new Set(bridgePaths.map(({ slug }) => slug));
      bridgeSlugs.add('shared-prefix-candidate');

      const inMemoryEntries = buildTrackedJobCanonEntries(tracking, bridgeSlugs).entries;
      expect(inMemoryEntries.get('shared-prefix-candidate')?.fr).toBe('/fr/trouver-emploi-geneve');
      const staleClassification = classifyBridgePaths(bridgePaths, inMemoryEntries);
      expect(staleClassification.removable).toContain('/en/jobs-im-tessin/compatibility-old-route/');

      const serializedWorkerJob: ActiveJobSlugMapRow = {
        id: 'reconciled-active-job',
        slug: 'reconciled-active-job',
        canton: 'ZH',
        slugByLocale: {
          it: 'reconciled-active-job',
          en: 'reconciled-active-job',
          de: 'reconciled-active-job',
          fr: 'reconciled-active-job',
        },
      };
      const finalWorkerJob: ActiveJobSlugMapRow = {
        ...serializedWorkerJob,
        previousSlugsByLocale: { en: ['compatibility-old-route', 'exact-old-route'] },
      };
      const reconciliation = reconcileFinalWorkerSlugMapRows([serializedWorkerJob], [finalWorkerJob]);
      expect(reconciliation.matchedJobIdentifiers).toEqual(new Set(['reconciled-active-job']));
      expect(reconciliation.unmatchedJobIdentifiers.size).toBe(0);
      expect(reconciliation.updatedJobCount).toBe(1);
      expect(serializedWorkerJob.previousSlugsByLocale)
        .toEqual({ en: ['compatibility-old-route', 'exact-old-route'] });

      const persistedEntries = buildTrackedJobCanonEntriesFromPersistedRegistry(root, bridgeSlugs).entries;
      expect(persistedEntries.get('shared-prefix-candidate')?.fr).toBe('/fr/trouver-emploi-zurich');
      const persistedClassification = classifyBridgePathsFromFinalWorkerMap(
        bridgePaths,
        persistedEntries,
        reconciliation.matchedJobIdentifiers,
      );
      expect(persistedClassification.removable).toEqual(new Set(['/en/jobs-im-tessin/exact-old-route/']));
      expect(persistedClassification.keepBridge.get('/en/jobs-im-tessin/compatibility-old-route/'))
        .toBe('targetMismatch');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      if (previousLocale === undefined) delete process.env.BUILD_LOCALE;
      else process.env.BUILD_LOCALE = previousLocale;
    }
  });

  it('rejects a fixture whose maximum shard grows beyond five percent', () => {
    expect(assertMaxShardGrowthWithinPercent([100, 900], [100, 945], 5)).toBe(5);
    expect(() => assertMaxShardGrowthWithinPercent([100, 900], [100, 946], 5))
      .toThrow('maximum job-canon shard grew 5.11%, above 5%');
  });

  it('rejects a v2 shard larger than 256 KiB', () => {
    expect(() => assertJobCanonV2ShardWithinLimit(256 * 1024)).not.toThrow();
    expect(() => assertJobCanonV2ShardWithinLimit((256 * 1024) + 1))
      .toThrow('job-canon v2 shard is 262145 bytes, above 262144 bytes');
  });

  it('keeps ambiguous paths, exact-prefix paths, missing entries, and alias chains for PR-B', () => {
    const bridgePaths = [
      { path: '/it/ambiguous/', locale: 'it', slug: 'ambiguous', targetPath: '/it/one/', kind: 'previousSlug', canton: 'ZH' },
      { path: '/it/exact/', locale: 'it', slug: 'exact', targetPath: '/it/current/', kind: 'previousSlug', canton: 'ZH' },
      { path: '/it/missing/', locale: 'it', slug: 'missing', targetPath: '/it/current/', kind: 'previousSlug', canton: 'ZH' },
      { path: '/it/chain/', locale: 'it', slug: 'chain', targetPath: '/it/current/', kind: 'previousSlug', canton: 'ZH' },
      { path: '/it/next-bridge/', locale: 'it', slug: 'next-bridge', targetPath: '/it/current/', kind: 'crossLocale', canton: 'ZH' },
    ] as const;
    const entries = new Map<string, JobCanonEntryLike>([
      ['exact', { it: '/it/other-section' }],
      ['chain', { alias: { it: '/it/next-bridge' } }],
      ['next-bridge', { alias: { it: '/it/current' } }],
    ]);
    const classified = classifyBridgePaths(
      bridgePaths,
      entries,
      new Set(['it\u0000ambiguous']),
      new Set(['it\u0000exact']),
    );
    expect(classified.keepBridge.get('/it/ambiguous/')).toBe('ambiguousCanton');
    expect(classified.keepBridge.get('/it/exact/')).toBe('exactPrefix');
    expect(classified.keepBridge.get('/it/missing/')).toBe('noEntry');
    expect(classified.keepBridge.get('/it/chain/')).toBe('chain');
    expect(classified.removable.has('/it/next-bridge/')).toBe(true);
  });

  it('fails the build gate on a residual page, missing alias target, or missing keepBridge page', () => {
    const removableBridge = {
      path: '/cerca-lavoro-ticino/old-route/',
      locale: 'it',
      slug: 'old-route',
      targetPath: '/cerca-lavoro-zurigo/current-route/',
      kind: 'previousSlug',
      canton: 'ZH',
    } as const;
    const removableEntries = new Map<string, JobCanonEntryLike>([
      ['old-route', { alias: { it: removableBridge.targetPath.replace(/\/$/, '') } }],
    ]);
    const removableClassification = classifyBridgePaths([removableBridge], removableEntries);
    expect(removableClassification.removable.has(removableBridge.path)).toBe(true);
    expect(() => assertBridgePathDistCoverage(
      [{ indexPath: '/dist/cerca-lavoro-ticino/old-route/index.html', flatPath: '/dist/cerca-lavoro-ticino/old-route.html' }],
      [],
      () => true,
      () => true,
    )).toThrow('[job-alias-redirect-gate] removable path still has static HTML');
    expect(() => assertBridgePathClassificationCoverage(
      [removableBridge],
      { removable: new Set([removableBridge.path]), keepBridge: new Map() },
      new Map(),
    )).toThrow('[job-alias-redirect-gate] removable path has no exact Worker target');

    const keepBridge = { ...removableBridge, path: '/cerca-lavoro-ticino/unmapped-route/', slug: 'unmapped-route' };
    const keepClassification = classifyBridgePaths([keepBridge], new Map());
    expect(keepClassification.keepBridge.get(keepBridge.path)).toBe('noEntry');
    expect(() => assertBridgePathDistCoverage(
      [],
      [{ indexPath: '/dist/cerca-lavoro-ticino/unmapped-route/index.html', targetPath: 'https://frontaliereticino.ch/cerca-lavoro-zurigo/current-route/' }],
      () => false,
      () => false,
    )).toThrow('[job-alias-redirect-gate] path has neither an exact 301 nor a retained bridge');

    expect(() => assertBridgePathDistCoverage(
      [],
      [{ indexPath: '/dist/cerca-lavoro-ticino/unmapped-route/index.html', targetPath: 'https://frontaliereticino.ch/cerca-lavoro-zurigo/current-route/' }],
      () => true,
      () => false,
    )).toThrow('[job-alias-redirect-gate] retained bridge does not point to its planned canonical');
  });

  it('measures four-locale bridge removal on a synthetic full-content corpus', () => {
    const locales = ['it', 'en', 'de', 'fr'] as const;
    const syntheticJobCount = 2048;
    const syntheticHtml = `<html><head></head><body>${'x'.repeat(32 * 1024)}</body></html>`;
    const htmlBytes = Buffer.byteLength(syntheticHtml, 'utf8');
    const jobs: ActiveJobSlugMapRow[] = Array.from({ length: syntheticJobCount }, (_, index) => {
      const suffix = String(index).padStart(4, '0');
      const currentSlug = `fixture-current-${suffix}`;
      const oldSlug = `fixture-previous-${suffix}`;
      return {
        id: `fixture-${suffix}`,
        slug: currentSlug,
        canton: 'TI',
        slugByLocale: Object.fromEntries(locales.map((locale) => [locale, currentSlug])),
        previousSlugsByLocale: Object.fromEntries(locales.map((locale) => [locale, [oldSlug]])),
      };
    });
    const heapStart = process.memoryUsage().heapUsed;
    let heapPeak = heapStart;
    const sampleHeap = (): void => {
      heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
    };
    const bridgePlan = buildActiveJobBridgePathPlan(jobs, {
      winners: {},
      reservedHubSlugs: new Set(),
      onHeapSample: sampleHeap,
    });
    const entries = new Map<string, JobCanonEntryLike>();
    const firstOldSlug = 'fixture-previous-0000';
    entries.set(firstOldSlug, {
      alias: Object.fromEntries(locales.map((locale) => [locale, `/wrong/${firstOldSlug}`])),
    });
    const activeAliasPlan = planActiveJobCanonAliases(
      bridgePlan,
      (slug) => entries.get(slug),
      sampleHeap,
    );
    for (const alias of activeAliasPlan.aliases) {
      const entry = { ...(entries.get(alias.slug) ?? {}) };
      const registryAlias = { ...(entry.alias ?? {}) };
      registryAlias[alias.locale] = alias.targetPath;
      entry.alias = registryAlias;
      entries.set(alias.slug, entry);
    }
    const classification = classifyBridgePaths(
      bridgePlan.bridgePaths,
      entries,
      activeAliasPlan.ambiguousCantonKeys,
      bridgePlan.activeRouteSlugKeys,
      sampleHeap,
    );
    sampleHeap();

    const metrics = Object.fromEntries(locales.map((locale) => {
      const paths = bridgePlan.bridgePaths.filter((bridge) => bridge.locale === locale);
      const removable = paths.filter((bridge) => classification.removable.has(bridge.path)).length;
      const retained = paths.filter((bridge) => classification.keepBridge.has(bridge.path)).length;
      return [locale, {
        bridgeCountBefore: paths.length,
        bridgeFullCountBefore: paths.length,
        removableBridgeCountBefore: removable,
        removableBridgeCountAfter: 0,
        bridgeCountAfter: retained,
        bridgeFullCountAfter: retained,
        htmlFilesRemoved: removable * 2,
        bytesRemoved: removable * 2 * htmlBytes,
      }];
    }));
    assertBridgePathClassificationCoverage(bridgePlan.bridgePaths, classification, entries);
    const removableOutputs = bridgePlan.bridgePaths
      .filter((bridge) => classification.removable.has(bridge.path))
      .map((bridge) => ({
        indexPath: `/dist/${bridge.path.replace(/^\/+|\/+$/g, '')}/index.html`,
        flatPath: `/dist/${bridge.path.replace(/^\/+|\/+$/g, '')}.html`,
      }));
    const retainedOutputs = bridgePlan.bridgePaths
      .filter((bridge) => classification.keepBridge.has(bridge.path))
      .map((bridge) => ({
        indexPath: `/dist/${bridge.path.replace(/^\/+|\/+$/g, '')}/index.html`,
        targetPath: bridge.targetPath,
      }));
    const retainedIndexes = new Set(retainedOutputs.map((output) => output.indexPath));
    const retainedTargets = new Map(retainedOutputs.map((output) => [output.indexPath, output.targetPath]));
    assertBridgePathDistCoverage(
      removableOutputs,
      retainedOutputs,
      (filePath) => retainedIndexes.has(filePath),
      (filePath, targetPath) => retainedTargets.get(filePath) === targetPath,
    );
    console.log(`[job-alias-fixture-measure] ${JSON.stringify({
      syntheticJobs: syntheticJobCount,
      htmlBytesPerPage: htmlBytes,
      byLocale: metrics,
      heapPeakMb: Number((heapPeak / (1024 * 1024)).toFixed(1)),
      heapOverStartMb: Number(((heapPeak - heapStart) / (1024 * 1024)).toFixed(1)),
    })}`);
    for (const locale of locales) {
      expect(metrics[locale]).toMatchObject({
        bridgeCountBefore: syntheticJobCount,
        bridgeFullCountBefore: syntheticJobCount,
        removableBridgeCountBefore: syntheticJobCount - 1,
        removableBridgeCountAfter: 0,
        bridgeCountAfter: 1,
        bridgeFullCountAfter: 1,
      });
    }
  });
});
