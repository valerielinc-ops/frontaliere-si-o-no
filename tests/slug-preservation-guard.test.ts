import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  preserveSlugHistory,
  reachableSlugs,
  isGuardedSlicePath,
  GUARD_PER_LOCALE_CAP,
  _resetDenylistCache,
} from '../scripts/lib/slug-preservation-guard.mjs';
import { clear, getEvents } from '../scripts/lib/slug-history-journal.mjs';
import { restoreLocaleSlug, mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
import { writeJsonAtomic } from '../scripts/lib/atomic-write-json.mjs';

/**
 * Regression tests for issue #5157 — "previousSlugs writer regression detected".
 *
 * The recovery workflow's 24h tripwire fired at 79 lost previousSlugs against a
 * threshold of 10, spread across 21 commits and a dozen different crawlers.
 * That distribution — many commits, few losses each — is the signature of a
 * rule that many authors independently forget, not of a single broken commit.
 * The rule was: "call addPreviousSlugForLocale / captureLostSlugs before you
 * overwrite a slug". It was enforced by convention across ~40 call sites.
 *
 * These tests pin the structural replacement: a write that would drop a slug
 * is impossible at the boundary where slices become durable, so forgetting to
 * journal degrades into a logged `restore` instead of a silent 404 on an
 * already-indexed URL.
 */

const IT_SLUG = 'consulente-alla-clientela-privata-individuale-lugano-m-w-d-80-100-banca-cler-8440-iva-che-sbman6';

/** The real production loss, verbatim from banca-cler.json @ commit 8b8b68208b. */
function bancaClerBefore() {
  return {
    jobs: [{
      id: 'company-sbman6',
      sourceLang: 'it',
      slug: IT_SLUG,
      slugByLocale: {
        it: IT_SLUG,
        en: 'individual-customer-advisor-lugano-f-m-80-100-banca-cler-8440-iva-che',
        de: 'individueller-kundenberater-lugano-w-m-80-100-banca-cler-8440-iva-che',
        fr: 'conseiller-client-individuel-lugano-f-m-80-100-banca-cler-8440-iva-che',
      },
      previousSlugsByLocale: {
        it: [
          'consulente-alla-clientela-privata-individuale-lugano-m-w-d-80-100-banca-cler-8440-iva-che',
          'consulente-alla-clientela-privata-individuale-lugano-f-m-banca-cler',
          'consulente-alla-clientela-privata-individuale-lugano-m-w-d-80-100-bank-cler-8440-mwst-che',
        ],
      },
    }],
  };
}

/**
 * What the crawler actually wrote: the fresh (untranslated) record replaced the
 * old one wholesale, so every translated per-locale slug collapsed onto the IT
 * slug and two thirds of the IT history vanished. `previousSlugs` was never
 * touched — the loss was entirely in the ACTIVE slug fields, which is why the
 * previousSlugs-focused tooling could not see it.
 */
function bancaClerAfterUnguarded() {
  return {
    jobs: [{
      id: 'company-sbman6',
      sourceLang: 'it',
      slug: IT_SLUG,
      slugByLocale: { it: IT_SLUG, en: IT_SLUG, de: IT_SLUG, fr: IT_SLUG },
      previousSlugsByLocale: {
        it: ['consulente-alla-clientela-privata-individuale-lugano-m-w-d-80-100-banca-cler-8440-iva-che'],
      },
    }],
  };
}

const SLICE = path.join('data', 'jobs', 'by-crawler', 'banca-cler.json');

describe('slug-preservation-guard (issue #5157)', () => {
  beforeEach(() => {
    clear();
    _resetDenylistCache();
    delete process.env.SLUG_PRESERVATION_GUARD;
  });

  it('rescues every active per-locale slug a wholesale job replacement would drop', () => {
    const next = bancaClerAfterUnguarded();
    const result = preserveSlugHistory(SLICE, next, {
      previousValue: bancaClerBefore(),
      denylist: new Set(),
    });

    const job = next.jobs[0];
    // The three translated URLs Google had already indexed must still resolve.
    expect(job.previousSlugsByLocale.en).toContain('individual-customer-advisor-lugano-f-m-80-100-banca-cler-8440-iva-che');
    expect(job.previousSlugsByLocale.de).toContain('individueller-kundenberater-lugano-w-m-80-100-banca-cler-8440-iva-che');
    expect(job.previousSlugsByLocale.fr).toContain('conseiller-client-individuel-lugano-f-m-80-100-banca-cler-8440-iva-che');

    // ...and the two IT history entries the replacement discarded.
    expect(job.previousSlugsByLocale.it).toContain('consulente-alla-clientela-privata-individuale-lugano-f-m-banca-cler');
    expect(job.previousSlugsByLocale.it).toContain('consulente-alla-clientela-privata-individuale-lugano-m-w-d-80-100-bank-cler-8440-mwst-che');

    expect(result.restored).toBe(5);
    expect(result.jobsTouched).toBe(1);
  });

  it('journals every rescue with an attributable source instead of losing it silently', () => {
    preserveSlugHistory(SLICE, bancaClerAfterUnguarded(), {
      previousValue: bancaClerBefore(),
      denylist: new Set(),
    });

    const restores = getEvents().filter(e => e.action === 'restore');
    expect(restores).toHaveLength(5);
    expect(restores.every(e => e.source === 'slug-preservation-guard')).toBe(true);
    expect(restores.every(e => e.reason?.includes('banca-cler.json'))).toBe(true);
    // Locale attribution is preserved so the bridge page is emitted under the
    // right locale prefix rather than blindly across all four.
    expect(restores.filter(e => e.locale === 'en')).toHaveLength(1);
    expect(restores.filter(e => e.locale === 'de')).toHaveLength(1);
    expect(restores.filter(e => e.locale === 'fr')).toHaveLength(1);
    expect(restores.filter(e => e.locale === 'it')).toHaveLength(2);
  });

  it('mirrors rescued slugs onto the flat legacy previousSlugs array', () => {
    const next = bancaClerAfterUnguarded();
    preserveSlugHistory(SLICE, next, { previousValue: bancaClerBefore(), denylist: new Set() });
    // Consumers that never migrated off the flat array still emit the redirect.
    expect(next.jobs[0].previousSlugs).toContain('individual-customer-advisor-lugano-f-m-80-100-banca-cler-8440-iva-che');
  });

  it('is a no-op when the write drops nothing (no churn on healthy writes)', () => {
    const before = bancaClerBefore();
    const next = bancaClerBefore();
    const result = preserveSlugHistory(SLICE, next, { previousValue: before, denylist: new Set() });
    expect(result.restored).toBe(0);
    expect(getEvents()).toHaveLength(0);
    expect(next).toEqual(before);
  });

  it('is idempotent — re-running over its own output rescues nothing new', () => {
    const next = bancaClerAfterUnguarded();
    preserveSlugHistory(SLICE, next, { previousValue: bancaClerBefore(), denylist: new Set() });
    clear();
    const second = preserveSlugHistory(SLICE, next, { previousValue: bancaClerBefore(), denylist: new Set() });
    expect(second.restored).toBe(0);
    expect(getEvents()).toHaveLength(0);
  });

  it('treats a renamed active slug as history rather than a loss', () => {
    const previousValue = {
      jobs: [{ id: 'j1', slug: 'old-master', slugByLocale: { it: 'old-master', en: 'old-en' } }],
    };
    const next = {
      jobs: [{ id: 'j1', slug: 'new-master', slugByLocale: { it: 'new-master', en: 'new-en' } }],
    };
    preserveSlugHistory(SLICE, next, { previousValue, denylist: new Set() });
    expect(next.jobs[0].previousSlugsByLocale.it).toContain('old-master');
    expect(next.jobs[0].previousSlugsByLocale.en).toContain('old-en');
  });

  it('never resurrects slugs on the decontamination denylist (#4055/#4056)', () => {
    const poison = 'individual-customer-advisor-lugano-f-m-80-100-banca-cler-8440-iva-che';
    const next = bancaClerAfterUnguarded();
    const denylist = new Set([`banca-cler.json\u0000${poison}`]);

    const result = preserveSlugHistory(SLICE, next, { previousValue: bancaClerBefore(), denylist });

    expect(next.jobs[0].previousSlugsByLocale.en ?? []).not.toContain(poison);
    // The other four are still rescued — the denylist is surgical, not a mute.
    expect(result.restored).toBe(4);
  });

  it('respects the per-locale cap instead of fighting documented LRU eviction', () => {
    const full = Array.from({ length: GUARD_PER_LOCALE_CAP }, (_, i) => `banked-${i}`);
    const previousValue = {
      jobs: [{ id: 'j1', slugByLocale: { en: 'about-to-be-dropped' }, previousSlugsByLocale: { en: [...full] } }],
    };
    const next = {
      jobs: [{ id: 'j1', slugByLocale: { en: 'brand-new' }, previousSlugsByLocale: { en: [...full] } }],
    };

    const result = preserveSlugHistory(SLICE, next, { previousValue, denylist: new Set() });

    // The bucket is legitimately full: eviction of the oldest is the documented
    // capSlugArray behaviour, and scan-prev-slug-losses.mjs classifies it as
    // cap-explained rather than a regression. Do not exceed the cap to "win".
    expect(next.jobs[0].previousSlugsByLocale.en).toHaveLength(GUARD_PER_LOCALE_CAP);
    expect(result.restored).toBe(0);
    expect(result.capTrimmed).toBe(1);
  });

  it('ignores brand-new jobs, non-slice paths, and first writes', () => {
    const fresh = { jobs: [{ id: 'brand-new', slug: 's', slugByLocale: { it: 's' } }] };
    expect(preserveSlugHistory(SLICE, fresh, { previousValue: { jobs: [] }, denylist: new Set() }).restored).toBe(0);

    expect(isGuardedSlicePath(SLICE)).toBe(true);
    expect(isGuardedSlicePath(path.join('data', 'jobs.json'))).toBe(false);
    expect(isGuardedSlicePath(path.join('data', 'slug-registry.json'))).toBe(false);

    // A non-slice path is left completely alone even with a lossy payload.
    const lossy = bancaClerAfterUnguarded();
    const untouched = JSON.parse(JSON.stringify(lossy));
    preserveSlugHistory(path.join('data', 'jobs.json'), lossy, {
      previousValue: bancaClerBefore(), denylist: new Set(),
    });
    expect(lossy).toEqual(untouched);
  });

  it('can be switched off for scripts that delete slug history on purpose', () => {
    process.env.SLUG_PRESERVATION_GUARD = 'off';
    const next = bancaClerAfterUnguarded();
    const result = preserveSlugHistory(SLICE, next, {
      previousValue: bancaClerBefore(), denylist: new Set(),
    });
    expect(result.restored).toBe(0);
    expect(next.jobs[0].previousSlugsByLocale.en).toBeUndefined();
  });

  it('reachableSlugs attributes the master slug to IT and keeps locale buckets distinct', () => {
    const map = reachableSlugs({
      slug: 'master', slugByLocale: { en: 'en-active' }, previousSlugsByLocale: { fr: ['fr-old'] },
      previousSlugs: ['unattributed'],
    });
    expect(map.get('master')).toBe('it');
    expect(map.get('en-active')).toBe('en');
    expect(map.get('fr-old')).toBe('fr');
    expect(map.get('unattributed')).toBe(null);
  });
});

describe('restoreLocaleSlug — the authorized way to un-blank an active slug (#5157)', () => {
  beforeEach(() => clear());

  it('re-instates the slug and journals it as a restore', () => {
    const job = { id: 'j1', slugByLocale: { it: 'it-slug' } };
    expect(restoreLocaleSlug(job, 'en', 'en-slug', 'test-source')).toBe(true);
    expect(job.slugByLocale.en).toBe('en-slug');

    const [event] = getEvents();
    expect(event).toMatchObject({ action: 'restore', locale: 'en', slug: 'en-slug' });
    expect(event.source).toContain('test-source');
  });

  it('is a no-op when the slug is already active (no journal noise)', () => {
    const job = { id: 'j1', slugByLocale: { en: 'en-slug' } };
    expect(restoreLocaleSlug(job, 'en', 'en-slug')).toBe(false);
    expect(getEvents()).toHaveLength(0);
  });

  it('refuses empty input rather than blanking the field it exists to protect', () => {
    const job = { id: 'j1', slugByLocale: { en: 'en-slug' } };
    expect(restoreLocaleSlug(job, 'en', '')).toBe(false);
    expect(restoreLocaleSlug(job, 'en', '   ')).toBe(false);
    expect(job.slugByLocale.en).toBe('en-slug');
    expect(getEvents()).toHaveLength(0);
  });

  it('creates slugByLocale when the job has none', () => {
    const job: any = { id: 'j1' };
    expect(restoreLocaleSlug(job, 'fr', 'fr-slug')).toBe(true);
    expect(job.slugByLocale).toEqual({ fr: 'fr-slug' });
  });
});

describe('mergePreserveLocaleData no longer blanks a live locale slug (#5157)', () => {
  beforeEach(() => clear());

  it('keeps the existing slug when the fresh crawl has none for that locale', () => {
    const existing = [{
      id: 'company-1',
      url: 'https://example.com/jobs/1',
      sourceLang: 'it',
      title: 'Consulente alla clientela',
      titleByLocale: { it: 'Consulente alla clientela', en: 'Customer advisor' },
      slug: 'consulente-alla-clientela',
      slugByLocale: { it: 'consulente-alla-clientela', en: 'customer-advisor' },
    }];
    // Fresh crawl produced no EN slug at all — the shape that used to drop it.
    const fresh = [{
      id: 'company-1',
      url: 'https://example.com/jobs/1',
      sourceLang: 'it',
      title: 'Consulente alla clientela',
      titleByLocale: { it: 'Consulente alla clientela' },
      slug: 'consulente-alla-clientela',
      slugByLocale: { it: 'consulente-alla-clientela' },
    }];

    const merged = mergePreserveLocaleData(existing, fresh);
    const job = merged.find((j: any) => j.id === 'company-1');

    // The indexed EN URL must still be served by SOMETHING: either still
    // active, or banked as a redirect bridge. Never simply gone.
    const stillReachable = job.slugByLocale?.en === 'customer-advisor'
      || (job.previousSlugsByLocale?.en || []).includes('customer-advisor')
      || (job.previousSlugs || []).includes('customer-advisor');
    expect(stillReachable).toBe(true);
  });
});

describe('writeJsonAtomic wiring (the guard cannot be bypassed by forgetting it)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    clear();
    _resetDenylistCache();
    delete process.env.SLUG_PRESERVATION_GUARD;
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-guard-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('rescues dropped slugs on a real slice write without the caller doing anything', () => {
    const slicePath = path.join(tmpRoot, 'data', 'jobs', 'by-crawler', 'banca-cler.json');
    fs.mkdirSync(path.dirname(slicePath), { recursive: true });
    fs.writeFileSync(slicePath, JSON.stringify(bancaClerBefore(), null, 2));

    // A caller that never heard of addPreviousSlugForLocale — the exact
    // scenario that produced the 79 losses.
    writeJsonAtomic(slicePath, bancaClerAfterUnguarded());

    const written = JSON.parse(fs.readFileSync(slicePath, 'utf8'));
    expect(written.jobs[0].previousSlugsByLocale.en)
      .toContain('individual-customer-advisor-lugano-f-m-80-100-banca-cler-8440-iva-che');
    expect(getEvents().filter(e => e.action === 'restore')).toHaveLength(5);
  });

  it('leaves non-slice writes byte-identical', () => {
    const target = path.join(tmpRoot, 'data', 'slug-registry.json');
    const payload = { jobs: [{ id: 'x', slug: 'y' }] };
    writeJsonAtomic(target, payload);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(payload);
    expect(getEvents()).toHaveLength(0);
  });
});
