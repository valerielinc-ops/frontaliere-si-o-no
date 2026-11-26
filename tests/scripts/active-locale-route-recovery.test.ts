// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  addServedRoutePaths,
  applyActiveLocaleRouteAlias,
  collectServedRoutePaths,
  planActiveLocaleRouteRecovery,
  stableJobIdentityKeys,
} from '../../scripts/lib/active-locale-route-recovery.mjs';

const routeFor = (job: Record<string, unknown>, locale: string, slug: string) => (
  `/${locale}/${String(job.canton || 'ti').toLowerCase()}/${slug}/`
);
const fingerprintOf = (job: Record<string, unknown>) => String(job.fp || '');
const isHeld = (job: Record<string, unknown>) => job.held === true;

function row({
  fp = 'id|one',
  fileName = 'current.json',
  index = 0,
  job = {},
}: {
  fp?: string;
  fileName?: string;
  index?: number;
  job?: Record<string, unknown>;
} = {}) {
  return {
    ownerId: `${fileName}\u0000${index}`,
    file: `/tmp/${fileName}`,
    fileName,
    index,
    fingerprint: fp,
    job: {
      fp,
      canton: 'ti',
      slug: 'current-it',
      slugByLocale: { it: 'current-it' },
      ...job,
    },
  };
}

function plan({
  baseRows,
  headRows,
  denylist = new Set<string>(),
  servedRoutes,
  localeCap = 20,
  legacyCap = 80,
}: {
  baseRows: ReturnType<typeof row>[];
  headRows: ReturnType<typeof row>[];
  denylist?: Set<string>;
  servedRoutes?: Set<string>;
  localeCap?: number;
  legacyCap?: number;
}) {
  return planActiveLocaleRouteRecovery({
    baseRows,
    headRows,
    routeFor,
    fingerprintOf,
    denylist,
    localeCap,
    legacyCap,
    isHeld,
    servedRoutes,
  });
}

describe('active locale route recovery', () => {
  it('recovers the canonical fallback route for every locale', () => {
    const base = row({
      job: { slug: 'old', slugByLocale: {} },
    });
    const head = row({
      job: { slug: 'new', slugByLocale: {} },
    });
    const result = plan({ baseRows: [base], headRows: [head] });

    expect(result.actions).toHaveLength(4);
    expect(result.actions.map((action) => action.locale)).toEqual(['de', 'en', 'fr', 'it']);
    expect(result.actions.every((action) => action.slug === 'old')).toBe(true);

    for (const action of result.actions) applyActiveLocaleRouteAlias(head.job, action);
    expect(head.job.previousSlugsByLocale).toEqual({
      de: ['old'],
      en: ['old'],
      fr: ['old'],
      it: ['old'],
    });
  });

  it('uses exact identity across a crawler transfer and never changes the active slug', () => {
    const base = row({
      fileName: 'source.json',
      job: { slugByLocale: { it: 'current-it', en: 'old-en' } },
    });
    const destination = row({
      fileName: 'destination.json',
      job: { slugByLocale: { it: 'current-it', en: 'new-en' } },
    });
    const result = plan({ baseRows: [base], headRows: [destination] });

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      fileName: 'destination.json',
      locale: 'en',
      slug: 'old-en',
      includeFlat: true,
    });

    applyActiveLocaleRouteAlias(destination.job, result.actions[0]);
    expect(destination.job.slugByLocale).toEqual({ it: 'current-it', en: 'new-en' });
    expect(destination.job.previousSlugsByLocale).toEqual({ en: ['old-en'] });
    expect(destination.job.previousSlugs).toEqual(['old-en']);
  });

  it('does not use mutable slug fields as identity evidence', () => {
    expect(stableJobIdentityKeys({ slug: 'old-route', slugByLocale: { en: 'old-en' } }, () => ''))
      .toEqual([]);
    expect(stableJobIdentityKeys({ id: 'mutable-id' }, () => 'tl|title|location|host'))
      .toEqual([]);
    expect(plan({
      baseRows: [row({ fp: 'tl|weak', job: { slugByLocale: { en: 'old-en' } } })],
      headRows: [row({ fp: 'tl|weak', job: { slugByLocale: { en: 'new-en' } } })],
    }).summary.skippedByReason.weakFingerprint).toBe(1);
  });

  it('rejects held, missing, and duplicate owners', () => {
    const held = plan({
      baseRows: [row({ job: { held: true, slugByLocale: { en: 'held-en' } } })],
      headRows: [],
    });
    expect(held.actions).toHaveLength(0);
    expect(held.summary.skippedByReason.held).toBe(1);

    const missing = plan({
      baseRows: [row({ fp: 'id|missing', job: { slugByLocale: { en: 'missing-en' } } })],
      headRows: [],
    });
    expect(missing.summary.skippedByReason.missingHeadOwner).toBe(1);

    const duplicate = plan({
      baseRows: [row({ job: { slugByLocale: { en: 'duplicate-en' } } })],
      headRows: [
        row({ fileName: 'a.json', job: { slugByLocale: { en: 'a-en' } } }),
        row({ fileName: 'b.json', job: { slugByLocale: { en: 'b-en' } } }),
      ],
    });
    expect(duplicate.actions).toHaveLength(0);
    expect(duplicate.summary.skippedByReason.ambiguousHeadOwner).toBe(1);
  });

  it('skips a covered route and a route whose canton context moved', () => {
    const base = row({ job: { slugByLocale: { en: 'old-en' } } });
    const covered = plan({
      baseRows: [base],
      headRows: [row({ job: { slugByLocale: { en: 'new-en' } } })],
      servedRoutes: new Set([routeFor(base.job, 'en', 'old-en')]),
    });
    expect(covered.actions).toHaveLength(0);
    expect(covered.summary.skippedByReason.alreadyCovered).toBe(1);

    const moved = plan({
      baseRows: [base],
      headRows: [row({ job: { canton: 'zh', slugByLocale: { en: 'new-en' } } })],
    });
    expect(moved.actions).toHaveLength(0);
    expect(moved.summary.skippedByReason.routeContextChanged).toBe(1);
  });

  it('rejects denylisted and colliding candidates', () => {
    const denylisted = plan({
      baseRows: [row({ job: { slugByLocale: { en: 'denylisted-en' } } })],
      headRows: [row({ job: { slugByLocale: { en: 'new-en' } } })],
      denylist: new Set(['current.json\u0000denylisted-en']),
    });
    expect(denylisted.actions).toHaveLength(0);
    expect(denylisted.summary.skippedByReason.denylisted).toBe(1);

    const first = row({ fileName: 'first.json', job: { slugByLocale: { en: 'shared-old' } } });
    const second = row({ fp: 'id|two', fileName: 'second.json', job: { slugByLocale: { en: 'shared-old' } } });
    const collision = plan({
      baseRows: [first, second],
      headRows: [
        row({ fileName: 'first-head.json', job: { slugByLocale: { en: 'first-new' } } }),
        row({ fp: 'id|two', fileName: 'second-head.json', job: { slugByLocale: { en: 'second-new' } } }),
      ],
    });
    expect(collision.actions).toHaveLength(0);
    expect(collision.summary.skippedByReason.candidateRouteCollision).toBe(2);
  });

  it('keeps the locale alias when the flat legacy cap is full', () => {
    const flat = ['existing'];
    const base = row({ job: { slugByLocale: { en: 'old-en' } } });
    const head = row({ job: { slugByLocale: { en: 'new-en' }, previousSlugs: flat } });
    const result = plan({
      baseRows: [base],
      headRows: [head],
      legacyCap: 1,
    });

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].includeFlat).toBe(false);
    applyActiveLocaleRouteAlias(head.job, result.actions[0], { legacyCap: 1 });
    expect(head.job.previousSlugsByLocale).toEqual({ en: ['old-en'] });
    expect(head.job.previousSlugs).toEqual(flat);
  });

  it('does not derive a route from an expired title when no slug is stored', () => {
    const expired = { title: 'Title only', canton: 'TI' };
    const derived = collectServedRoutePaths([expired], { routeFor });
    const strict = collectServedRoutePaths([expired], {
      routeFor,
      includeDerivedActiveSlug: false,
    });
    const target = new Set<string>();
    addServedRoutePaths(target, [expired], { routeFor, includeDerivedActiveSlug: false });

    expect(derived.size).toBeGreaterThan(0);
    expect(strict).toEqual(new Set());
    expect(target).toEqual(new Set());
  });
});
