/**
 * Proves the USER-VISIBLE half of the slug-drift fix: when a Workday vendor
 * renames the title portion of a job URL but keeps the requisition id
 * (`…_R11696`), the merge layer matches old↔new on the stable requisition key
 * (mergeUrlKey Rule W) and captures the old slug into previousSlugs — which is
 * what the active-job bridge in jobsSeoPagesPlugin turns into a 301 from the old
 * indexed URL to the new canonical.
 *
 * This is the layer that actually cures the orphaned soft-landing the bug
 * reported. (The registry-fingerprint half — extractJobIdentityFromUrl, a
 * PERSISTED key — is tracked separately as a chained re-key migration; see the
 * PR's `## Non implementato`.) Without Rule W the two URLs key on their full
 * (renamed) path, never match, and the old slug is silently dropped.
 */
import { describe, expect, it } from 'vitest';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';

const REQ = '_R11696';
const WD = (titleLeaf: string) =>
  `https://swisslife.wd3.myworkdayjobs.com/en-US/Swiss_Life_Career_Site/job/Sion/${titleLeaf}${REQ}`;

const OLD_SLUG = 'conseiller-en-immobilier-agence-generale-sion-swiss-life';
const NEW_SLUG = 'immobilienberater-generalagentur-sion-swiss-life';

describe('Workday title rename keeps the old slug bridgeable (mergeUrlKey Rule W)', () => {
  it('captures the old slug into previousSlugs across a title-leaf rename (same _R11696)', () => {
    const base = {
      id: 'swiss-life-r11696',
      company: 'Swiss Life',
      location: 'Sion',
      addressLocality: 'Sion',
      canton: 'VS',
      sourceLang: 'it',
      description: 'x'.repeat(200),
      source: 'Company Careers Crawler',
    };
    const existing = [{
      ...base,
      url: WD('Conseiller-en-immobilier--f-h-d--'),
      title: 'Conseiller en immobilier',
      slug: OLD_SLUG,
      slugByLocale: { it: OLD_SLUG },
      crawledAt: '2026-05-01T10:00:00Z',
    }];
    const fresh = [{
      ...base,
      url: WD('Immobilienberater--w-m-d--'), // title leaf RENAMED, requisition unchanged
      title: 'Immobilienberater',
      slug: NEW_SLUG,
      slugByLocale: { it: NEW_SLUG },
      crawledAt: '2026-06-28T10:00:00Z',
    }];

    const merged = mergePreserveLocaleData(existing, fresh, {});
    expect(merged).toHaveLength(1);
    const job = merged[0];

    // The merge matched the two postings (Rule W) and recorded the old slug, so
    // the active-job bridge can 301 the old indexed URL to the new canonical.
    const carriedPrev = [
      ...(job.previousSlugs || []),
      ...((job.previousSlugsByLocale && job.previousSlugsByLocale.it) || []),
    ];
    expect(carriedPrev).toContain(OLD_SLUG);
    // The current slug advanced to the new posting (not stuck on the old one).
    expect(job.slug).toBe(NEW_SLUG);
  });
});
