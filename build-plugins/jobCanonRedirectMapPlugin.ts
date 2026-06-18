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
 * (lowercased, non-alnum → '_'). Value is the canonical section prefix
 * (`/cerca-lavoro-zurigo`, `/de/jobs-in-zurich`, …); 404.html rebuilds the URL as
 * `${value}/${slug}/`. Emitted at the dist ROOT (not /data/, which is
 * CDN-offloaded → same-origin 404) so the 404.html fetch is same-origin.
 *
 * Streaming + bounded: one small JSON per shard (a few hundred slugs each), keyed
 * by the localized last segment across all 4 locales, built once from
 * data/all-known-job-slugs.json. apply:'build', enforce:'post', closeBundle.
 */

import path from 'path';
import fs from 'node:fs';
import type { Plugin } from 'vite';

const OUT_SUBDIR = 'job-canon';

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

export function jobCanonRedirectMapPlugin(rootDir: string): Plugin {
  return {
    name: 'job-canon-redirect-map',
    apply: 'build',
    enforce: 'post',
    closeBundle() {
      const distDir = path.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;
      let tracking: Record<string, Partial<Record<'it' | 'en' | 'de' | 'fr', string>>>;
      try {
        tracking = JSON.parse(
          fs.readFileSync(path.resolve(rootDir, 'data/all-known-job-slugs.json'), 'utf-8'),
        );
      } catch {
        return; // no tracking ledger — nothing to emit
      }

      // shard → { slug: sectionPrefix }
      const shards = new Map<string, Record<string, string>>();
      let entries = 0;
      for (const key of Object.keys(tracking)) {
        const e = tracking[key];
        if (!e) continue;
        for (const loc of ['it', 'en', 'de', 'fr'] as const) {
          const p = e[loc];
          if (!p) continue;
          const slug = p.replace(/\/+$/, '').split('/').pop();
          if (!slug) continue;
          const prefix = sectionPrefix(p);
          if (!prefix) continue;
          const sk = shardKey(slug);
          let bucket = shards.get(sk);
          if (!bucket) { bucket = {}; shards.set(sk, bucket); }
          // First write wins (the tracking ledger is already first-write-wins per
          // slug); skip duplicates so a re-keyed locale can't clobber.
          if (!(slug in bucket)) { bucket[slug] = prefix; entries++; }
        }
      }
      if (shards.size === 0) return;

      const outDir = path.join(distDir, OUT_SUBDIR);
      fs.mkdirSync(outDir, { recursive: true });
      for (const [sk, bucket] of shards) {
        fs.writeFileSync(path.join(outDir, `${sk}.json`), JSON.stringify(bucket), 'utf-8');
      }
      console.log(
        `\x1b[36m[job-canon-redirect-map]\x1b[0m Emitted ${shards.size} shards, ${entries} slug→canonical entries for 404-page canton-drift recovery.`,
      );
    },
  };
}
