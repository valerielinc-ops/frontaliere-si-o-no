/**
 * jobCanonRedirectMapPlugin — emit a sharded slug→canonical-section map so the
 * 404 page can recover canton-drift orphans at request time.
 *
 * Why dynamic: a job slug is globally unique, but the canton (URL section) was
 * re-derived every crawl, so the same slug migrated between sections and the
 * previously-indexed URL orphaned → 404. These orphans are NOT enumerable
 * statically (measured: CF accumulator 9%, GSC Search Analytics 0.4% — a 404 URL
 * has no impressions so GSC never reports it). The only moment we can recover one
 * is when it is REQUESTED. The pin (assemble-jobs-dataset.mjs) stops NEW orphans;
 * this map recovers the EXISTING ones: public/404.html looks the slug up and
 * redirects to its current canonical page.
 *
 * Output: dist/job-canon/<shard>.json where <shard> = first 2 chars of the slug
 * (lowercased, non-alnum → '_'). Value is a PER-LOCALE object of canonical
 * section prefixes, `{ it: '/cerca-lavoro-zurigo', en: '/en/find-jobs-zurich',
 * de: '/de/jobs-in-zurich', fr: '/fr/trouver-emploi-zurich' }`; the consumer
 * (Worker / 404.html) picks the prefix matching the REQUEST's locale and rebuilds
 * the URL as `${prefix}/${slug}/`. A key whose en/de/fr registry path ends in
 * a different slug also carries `alias: { <loc>: '<full localized path>' }`
 * (see the alias pass below). Locale-keyed because the slug segment is
 * IDENTICAL across all 4 locales (only the section prefix is localized): a single
 * flat `{slug: prefix}` value collapsed to whichever locale wrote first (it), so
 * the en/de/fr Worker 301'd every orphan to the ITALIAN page — a permanent
 * cross-locale redirect that de-indexed the localized canonical. Keying by locale
 * keeps each locale's real section (no transform of the IT one). Emitted into
 * dist here, then pushed to cdn.frontaliereticino.ch and deleted from dist by
 * the deploy CDN-offload step (deploy-it-pages-prep.sh step_push_cdn +
 * offload-generated-images-cdn.mjs), same as /data and /og — 404.html and the
 * Worker both fetch shards via a CDN-absolute URL, not same-origin.
 *
 * Streaming + bounded: one small JSON per shard (a few hundred slugs each), keyed
 * by the localized last segment (identical across all 4 locales), built once from
 * the sharded data/all-known-job-slugs/ store. apply:'build', enforce:'post', closeBundle.
 */

import path from 'path';
import fs from 'node:fs';
import { readJsonFile } from '../scripts/lib/read-large-json.mjs';
import type { Plugin } from 'vite';
import { readAllKnownJobSlugs } from '../scripts/lib/all-known-job-slugs-store.mjs';
import { loadWinners } from '../services/previousSlugWinners';
import { SECTION_LEGACY_TI } from './shared/cantonSection';
import { getSafeDistPageTargets, isDistPathOverFilesystemLimits, isSafeDistPath } from './shared/distPathSafety';
import { localizedActiveJobSlug } from './shared/activeJobPageSelection';
import { clearJobCanonOrderingFields, getJobCanonOrderingFields } from './shared/jobCanonInputs';
import {
  emitActiveJobCanonAliases,
  JOB_CANON_LOCALES,
  type ActiveJobSlugMapRow,
  type JobCanonLocale,
} from './shared/jobCanonBridgePaths';

const OUT_SUBDIR = 'job-canon';
/** Locales whose legacy URLs carried the Italian registry key (see the alias pass). */
const REGISTRY_ALIAS_LOCALES = ['en', 'de', 'fr'] as const;

function shardKey(slug: string): string {
  const s = slug.slice(0, 2).toLowerCase().replace(/[^a-z0-9]/g, '_');
  return s.length === 2 ? s : (s + '__').slice(0, 2);
}

/** Section prefix the 404 page rebuilds into `${prefix}/${slug}/`. */
function sectionPrefix(canonicalPath: string): string | null {
  const segs = canonicalPath.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segs.length < 2) return null;
  // Drop the trailing slug segment, keep the (locale-prefixed) section.
  return '/' + segs.slice(0, segs.length - 1).join('/');
}

export function assertMaxShardGrowthWithinPercent(
  baselineShardBytes: readonly number[],
  currentShardBytes: readonly number[],
  maximumGrowthPercent: number,
): number {
  let baselineMaximum = 0;
  let currentMaximum = 0;
  for (const bytes of baselineShardBytes) baselineMaximum = Math.max(baselineMaximum, bytes);
  for (const bytes of currentShardBytes) currentMaximum = Math.max(currentMaximum, bytes);
  const growthPercent = baselineMaximum === 0
    ? (currentMaximum === 0 ? 0 : Number.POSITIVE_INFINITY)
    : ((currentMaximum - baselineMaximum) / baselineMaximum) * 100;
  if (growthPercent > maximumGrowthPercent) {
    throw new Error(
      `maximum job-canon shard grew ${growthPercent.toFixed(2)}%, above ${maximumGrowthPercent}%`,
    );
  }
  return growthPercent;
}

export function jobCanonRedirectMapPlugin(rootDir: string): Plugin {
  return {
    name: 'job-canon-redirect-map',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      const distDir = path.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;
      let peakHeapUsed = process.memoryUsage().heapUsed;
      const heapCheckpoints: Record<string, number> = { start: peakHeapUsed };
      const sampleHeap = (): void => {
        peakHeapUsed = Math.max(peakHeapUsed, process.memoryUsage().heapUsed);
      };
      const markHeap = (phase: string): void => {
        const used = process.memoryUsage().heapUsed;
        peakHeapUsed = Math.max(peakHeapUsed, used);
        heapCheckpoints[phase] = used;
      };
      // Sharded registry (#4248) via the single shared accessor — never the raw
      // file. An EMPTY registry means the same thing the old parse failure did:
      // no ledger, nothing to emit.
      let tracking: Record<
        string,
        Partial<Record<JobCanonLocale, string>>
      > | null = readAllKnownJobSlugs(rootDir) as Record<string, Partial<Record<JobCanonLocale, string>>>;
      markHeap('tracking-loaded');
      if (!tracking || Object.keys(tracking).length === 0) {
        clearJobCanonOrderingFields();
        return; // no tracking ledger — nothing to emit
      }

      // shard → { slug: { it, en, de, fr } } — per-locale section prefixes. The
      // slug segment is identical across locales, so a flat {slug: prefix} would
      // collapse to whichever locale wrote first; keep each locale's own prefix.
      type LocalePrefixes = Partial<Record<JobCanonLocale, string>> & {
        alias?: Partial<Record<JobCanonLocale, string>>;
      };
      const shards = new Map<string, Record<string, LocalePrefixes>>();
      let entries = 0;
      const aliasesByLocale: Record<JobCanonLocale, number> = { it: 0, en: 0, de: 0, fr: 0 };
      for (const key of Object.keys(tracking)) {
        const e = tracking[key];
        if (!e) continue;
        for (const loc of JOB_CANON_LOCALES) {
          const p = e[loc];
          if (!p) continue;
          const slug = p.replace(/\/+$/, '').split('/').pop();
          if (!slug) continue;
          const prefix = sectionPrefix(p);
          if (!prefix) continue;
          const sk = shardKey(slug);
          let bucket = shards.get(sk);
          if (!bucket) { bucket = {}; shards.set(sk, bucket); }
          let perLocale = bucket[slug];
          if (!perLocale) { perLocale = {}; bucket[slug] = perLocale; entries++; }
          // First write wins PER LOCALE (the ledger is first-write-wins per slug),
          // so a re-keyed locale can't clobber another locale's prefix.
          if (!(loc in perLocale)) perLocale[loc] = prefix;
        }
      }
      markHeap('registry-prefixes-built');

      // Registry aliases (en/de/fr). Before the cathedral every locale path was
      // `/<locale>/<TI section>/<registry key>`, i.e. the Italian slug under a
      // localized section; the build kept those URLs alive with a 200 copy whose
      // canonical named another page (911k canonicalMismatch advisories on the
      // full-corpus replay). It no longer does, so the Worker must be able to
      // 301 them — but when this locale's registry path ends in a DIFFERENT
      // slug, `${prefix}/${key}/` would be a URL that does not exist. For those
      // keys record the full localized path instead (`alias`). An exact prefix
      // for the key — some registry path in this locale really ends in it —
      // always wins, so an alias never shadows a real page.
      let aliases = 0;
      for (const key of Object.keys(tracking)) {
        const e = tracking[key];
        if (!e) continue;
        for (const loc of REGISTRY_ALIAS_LOCALES) {
          const p = e[loc];
          if (!p) continue;
          const target = p.replace(/\/+$/, '');
          const seg = target.split('/').pop();
          if (!seg || seg === key || !sectionPrefix(target)) continue;
          const sk = shardKey(key);
          let bucket = shards.get(sk);
          if (!bucket) { bucket = {}; shards.set(sk, bucket); }
          let perLocale = bucket[key];
          if (!perLocale) { perLocale = {}; bucket[key] = perLocale; entries++; }
          if (loc in perLocale) continue;
          const alias = (perLocale.alias ??= {});
          if (!(loc in alias)) {
            alias[loc] = target;
            aliases++;
            aliasesByLocale[loc]++;
          }
        }
      }
      markHeap('registry-aliases-built');
      if (process.env.BUILD_LOCALE !== 'it') {
        tracking = null;
        clearJobCanonOrderingFields();
        markHeap('inputs-released');
      }

      // This leg is the only one that publishes /job-canon. The preceding
      // localeJobsSplitPlugin closeBundle writes the all-locale compact source.
      // Keep jobs.json out of this path: it is too large for the DE build.
      const slugMapPath = path.join(distDir, 'data', 'jobs-slug-map.json');
      let activeAliasStats: ReturnType<typeof emitActiveJobCanonAliases> | null = null;
      if (process.env.BUILD_LOCALE === 'it') {
        if (!fs.existsSync(slugMapPath)) {
          throw new Error(`[job-canon-redirect-map] BUILD_LOCALE=it requires ${path.relative(rootDir, slugMapPath)} from localeJobsSplitPlugin`);
        }
        const activeJobsRaw = readJsonFile(slugMapPath) as unknown;
        if (!Array.isArray(activeJobsRaw)) {
          throw new Error(`[job-canon-redirect-map] ${path.relative(rootDir, slugMapPath)} must contain an array`);
        }
        markHeap('slug-map-loaded');
        const {
          buildNativeJobPrefixIndex,
          buildReservedHubSlugs,
          compareActiveJobsByStableOrder,
          nativeJobPathRecoveredByWorker,
        } = await import('./jobsSeoPagesPlugin');
        let orderingFieldsById = getJobCanonOrderingFields();
        if (!orderingFieldsById) {
          throw new Error('[job-canon-redirect-map] localeJobsSplitPlugin did not provide ordering fields in this Vite process');
        }
        const jobs = activeJobsRaw as ActiveJobSlugMapRow[];
        let writeIndex = 0;
        for (const row of jobs) {
          if (!row || typeof row !== 'object') continue;
          const job = row;
          const stableId = String(job.id || job.slug || '').trim();
          const orderingFields = stableId ? orderingFieldsById.get(stableId) : undefined;
          if (!orderingFields) {
            throw new Error('[job-canon-redirect-map] slug map and in-memory ordering fields do not match');
          }
          Object.assign(job, orderingFields);
          jobs[writeIndex++] = job;
        }
        jobs.length = writeIndex;
        jobs.sort(compareActiveJobsByStableOrder);
        orderingFieldsById = null;
        clearJobCanonOrderingFields();
        markHeap('active-jobs-ordered');
        const nativeRouteSnapshotSlugs = new Set<string>();
        const activeRouteOwners = new Map<string, number>();
        const localeBits: Record<JobCanonLocale, number> = { it: 1, en: 2, de: 4, fr: 8 };
        for (const job of jobs) {
          if (typeof job.slug === 'string' && job.slug) nativeRouteSnapshotSlugs.add(job.slug);
          for (const locale of JOB_CANON_LOCALES) {
            const slug = localizedActiveJobSlug(job, locale);
            if (!slug) continue;
            nativeRouteSnapshotSlugs.add(slug);
            activeRouteOwners.set(slug, (activeRouteOwners.get(slug) ?? 0) | localeBits[locale]);
          }
        }
        const nativeIndex = buildNativeJobPrefixIndex(
          tracking as Parameters<typeof buildNativeJobPrefixIndex>[0],
          { it: '', en: '/en', de: '/de', fr: '/fr' },
          SECTION_LEGACY_TI,
          nativeRouteSnapshotSlugs,
          activeRouteOwners,
        );
        markHeap('native-index-built');
        const winners = loadWinners(path.resolve(rootDir, 'data', 'previous-slug-winners.json'));
        const entryForSlug = (slug: string): LocalePrefixes | undefined => shards.get(shardKey(slug))?.[slug];
        activeAliasStats = emitActiveJobCanonAliases(jobs, {
          winners,
          reservedHubSlugs: buildReservedHubSlugs(),
          entryForSlug,
          workerWouldRecover: (locale, slug, bridgePath) => nativeJobPathRecoveredByWorker(
            locale,
            slug,
            bridgePath,
            tracking as NonNullable<typeof tracking>,
            nativeIndex as Parameters<typeof nativeJobPathRecoveredByWorker>[4],
          ),
          canWriteCrossLocalePath: (bridgePath) => {
            const relPath = bridgePath.replace(/^\/+|\/+$/g, '');
            return !isDistPathOverFilesystemLimits(relPath)
              && isSafeDistPath(relPath)
              && getSafeDistPageTargets(distDir, relPath) !== null;
          },
          emitAlias: (slug, locale, targetPath) => {
            const sk = shardKey(slug);
            let bucket = shards.get(sk);
            if (!bucket) { bucket = {}; shards.set(sk, bucket); }
            let entry = bucket[slug];
            if (!entry) { entry = {}; bucket[slug] = entry; entries++; }
            const alias = (entry.alias ??= {});
            if (locale in alias) return;
            alias[locale] = targetPath;
            // all-known-job-slugs retains historical sections for old slugs.
            // jobCanonTarget gives prefixes precedence, so remove only the prefix
            // for the locale this active alias resolves.
            delete entry[locale];
            aliases++;
            aliasesByLocale[locale]++;
          },
          onHeapSample: sampleHeap,
        });
        markHeap('active-aliases-emitted');
        // The compact alias pass has consumed all full job rows, ordering
        // fields, registry input, and winner state. Release them before JSON
        // serialization, where the largest shard temporarily needs a buffer.
        jobs.length = 0;
        activeJobsRaw.length = 0;
        tracking = null;
        clearJobCanonOrderingFields();
        nativeRouteSnapshotSlugs.clear();
        activeRouteOwners.clear();
        markHeap('inputs-released');
      }

      if (shards.size === 0) return;

      const outDir = path.join(distDir, OUT_SUBDIR);
      fs.mkdirSync(outDir, { recursive: true });
      const shardBytes: number[] = [];
      for (const [sk, bucket] of shards) {
        const serialized = JSON.stringify(bucket);
        const bytes = Buffer.byteLength(serialized, 'utf8');
        shardBytes.push(bytes);
        fs.writeFileSync(path.join(outDir, `${sk}.json`), serialized, 'utf-8');
      }
      shardBytes.sort((a, b) => a - b);
      const middle = Math.floor(shardBytes.length / 2);
      const maxShardBytes = shardBytes.at(-1) ?? 0;
      const medianShardBytes = shardBytes.length === 0
        ? 0
        : shardBytes.length % 2 === 1
          ? shardBytes[middle]
          : Math.round((shardBytes[middle - 1] + shardBytes[middle]) / 2);
      sampleHeap();
      markHeap('shards-serialized');
      console.log(
        `\x1b[36m[job-canon-redirect-map]\x1b[0m Emitted ${shards.size} shards, ${entries} slug→canonical entries (${aliases} localized-slug aliases) for 404-page canton-drift recovery.`,
      );
      console.log(`[job-canon-redirect-map] aliases by locale: ${JSON.stringify(aliasesByLocale)}`);
      if (activeAliasStats) {
        console.log(`[job-canon-redirect-map] active alias groups: ${JSON.stringify(activeAliasStats)}`);
      }
      console.log(`[job-canon-redirect-map] shard bytes: count=${shardBytes.length}, max=${maxShardBytes}, median=${medianShardBytes}`);
      console.log(`[job-canon-redirect-map] closeBundle heap checkpoints: ${JSON.stringify(heapCheckpoints)}; sampled peak=${peakHeapUsed}`);
    },
  };
}
