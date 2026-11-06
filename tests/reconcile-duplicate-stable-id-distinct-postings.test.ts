/**
 * #9666 — stable-ID collision between DISTINCT postings must not delete a live
 * vacancy nor hand its indexed routes to an unrelated job.
 *
 * Shape measured on main 2026-09-24 (data/jobs/by-crawler/puk-zuerich.json):
 * refline posting 2117 (Unterassistenten) had inherited the id
 * `puk-zuerich-fadca51159cb`, which is sha1 of posting 2644's URL — the id the
 * PUK crawler legitimately assigns to 2644 (Advanced Practice Nurse). Every
 * crawl re-emitted 2644; every recover-prev-slugs run collapsed the pair by
 * dropping 2644 and folding its live slugs into 2117's previousSlugs (commits
 * 1be542ff664 … 40a060b953e). Before this fix `reconcileDuplicateIdJobs`
 * did not exist and the loop always collapsed by `.id` alone.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  reconcileDuplicateIdJobs,
  formatReconcileSummary,
} from '../scripts/reconcile-duplicate-stable-id-jobs.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
import { registerJobSlugMap, getJobMetaForSlug } from '@/services/router';

const sha12 = (url: string) => createHash('sha1').update(url).digest('hex').slice(0, 12);
const URL_2117 = 'https://apply.refline.ch/163206/2117/pub/4/index.html';
const URL_2644 = 'https://apply.refline.ch/163206/2644/pub/1/index.html';
const SHARED_ID = `puk-zuerich-${sha12(URL_2644)}`;

const SLUG_2117 = 'unterassistentinnen-unterassistenten-puk-zuerich-zurich';
const SLUG_2644 = 'advanced-practice-nurse-apn-alterspsychiatrie-konsiliar-und-liaisondienst-puk-zuerich';

function unterassistent(overrides: Record<string, unknown> = {}) {
  return {
    id: SHARED_ID,
    url: URL_2117,
    externalId: '2117',
    title: 'Unterassistentinnen / Unterassistenten',
    titleByLocale: { de: 'Unterassistentinnen / Unterassistenten' },
    sourceLang: 'de',
    slug: SLUG_2117,
    slugByLocale: { de: SLUG_2117 },
    previousSlugs: ['unterassistentinnen-unterassistenten-psychiatrische-universitatsklinik-zurich'],
    previousSlugsByLocale: { de: ['unterassistentinnen-unterassistenten-psychiatrische-universitatsklinik-zurich'] },
    firstSeenAt: '2026-05-19T17:18:42.497Z',
    crawledAt: '2026-09-23T23:39:19.274Z',
    ...overrides,
  };
}

function apn(overrides: Record<string, unknown> = {}) {
  return {
    id: SHARED_ID,
    url: URL_2644,
    externalId: '2644',
    title: 'Advanced Practice Nurse (APN) Alterspsychiatrie – Konsiliar- und Liaisondienst',
    titleByLocale: { de: 'Advanced Practice Nurse (APN) Alterspsychiatrie – Konsiliar- und Liaisondienst' },
    sourceLang: 'de',
    slug: SLUG_2644,
    slugByLocale: { de: SLUG_2644 },
    firstSeenAt: '2026-09-23T23:38:43.552Z',
    crawledAt: '2026-09-23T23:38:43.552Z',
    ...overrides,
  };
}

function historyOf(job: { previousSlugs?: string[]; previousSlugsByLocale?: Record<string, string[]> }) {
  return new Set([
    ...(job.previousSlugs || []),
    ...Object.values(job.previousSlugsByLocale || {}).flat(),
  ]);
}

describe('reconcileDuplicateIdJobs — distinct postings sharing an id (#9666)', () => {
  it('keeps both live vacancies and gives them distinct ids instead of deleting one', () => {
    const result = reconcileDuplicateIdJobs([unterassistent(), apn()]);

    expect(result.jobs).toHaveLength(2);
    expect(result.collapsed).toBe(0);
    expect(result.rekeyed).toBe(1);
    const ids = result.jobs.map((j) => j.id);
    expect(new Set(ids).size).toBe(2);

    // The record that held the id first keeps it; the later one is re-keyed.
    const keeper = result.jobs.find((j) => j.url === URL_2117)!;
    const moved = result.jobs.find((j) => j.url === URL_2644)!;
    expect(keeper.id).toBe(SHARED_ID);
    expect(moved.id).not.toBe(SHARED_ID);
    expect(moved.id.startsWith(`${SHARED_ID}-r`)).toBe(true);

    // No route handover: the APN live slug stays the APN's own route.
    expect(moved.slugByLocale.de).toBe(SLUG_2644);
    expect(historyOf(keeper).has(SLUG_2644)).toBe(false);
  });

  it('is deterministic regardless of input order and idempotent on a second pass', () => {
    const a = reconcileDuplicateIdJobs([unterassistent(), apn()]);
    const b = reconcileDuplicateIdJobs([apn(), unterassistent()]);
    const idOf = (jobs: Array<{ url: string; id: string }>, url: string) => jobs.find((j) => j.url === url)!.id;
    expect(idOf(b.jobs, URL_2644)).toBe(idOf(a.jobs, URL_2644));
    expect(idOf(b.jobs, URL_2117)).toBe(idOf(a.jobs, URL_2117));

    const again = reconcileDuplicateIdJobs(a.jobs);
    expect(again.groups).toBe(0);
    expect(again.collapsed + again.rekeyed).toBe(0);
  });

  it('never re-keys onto an id another record of the slice already holds', () => {
    const digestOwner = reconcileDuplicateIdJobs([unterassistent(), apn()]).jobs
      .find((j) => j.url === URL_2644)!.id;
    const squatter = { ...unterassistent(), id: digestOwner, url: 'https://apply.refline.ch/163206/9999/pub/1/index.html', slug: 'other', slugByLocale: { de: 'other' } };
    const result = reconcileDuplicateIdJobs([unterassistent(), apn(), squatter]);
    const ids = result.jobs.map((j) => j.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('still collapses same-requisition URL variants and keeps the dropped URL reachable', () => {
    // banca-cler shape: /de/bank-cler/… and /it/banca-cler/… are the same Cler
    // requisition (same mergeJobIdentity `req:cler.ch:2740`).
    const de = {
      id: 'company-ldhd7j',
      url: 'https://www.cler.ch/de/bank-cler/jobs-und-karriere/offene-stellen/kundenberaterin-biel-2740',
      slug: 'kundenberaterin-biel-bank-cler',
      slugByLocale: { de: 'kundenberaterin-biel-bank-cler' },
      crawledAt: '2026-09-23T23:39:15.567Z',
    };
    const it = {
      id: 'company-ldhd7j',
      url: 'https://www.cler.ch/it/banca-cler/jobs-und-karriere/offene-stellen/consulente-biel-2740',
      slug: 'consulente-biel-banca-cler',
      slugByLocale: { it: 'consulente-biel-banca-cler' },
      crawledAt: '2026-09-22T10:00:00.000Z',
    };
    const result = reconcileDuplicateIdJobs([de, it]);
    expect(result.jobs).toHaveLength(1);
    expect(result.collapsed).toBe(1);
    expect(result.rekeyed).toBe(0);
    expect(historyOf(result.jobs[0]).has('consulente-biel-banca-cler')).toBe(true);
  });
});

describe('crawl merge + reconcile reach a fixed point (#9666)', () => {
  it('the next crawl keeps the repaired ids instead of recreating the collision', () => {
    const reconciled = reconcileDuplicateIdJobs([unterassistent(), apn()]).jobs;

    // What the PUK refline crawler emits: id = companyKey + sha1(url)[0,12].
    const fresh2117 = { ...unterassistent(), id: `puk-zuerich-${sha12(URL_2117)}`, previousSlugs: undefined, previousSlugsByLocale: undefined };
    const fresh2644 = { ...apn(), id: `puk-zuerich-${sha12(URL_2644)}` };
    const merged = mergePreserveLocaleData(reconciled, [fresh2117, fresh2644], { nowMs: Date.parse('2026-09-25T00:00:00Z') });

    const live = merged.filter((j: { url: string }) => j.url === URL_2117 || j.url === URL_2644);
    expect(live).toHaveLength(2);
    expect(new Set(live.map((j: { id: string }) => j.id)).size).toBe(2);
    const after = reconcileDuplicateIdJobs(merged);
    expect(after.groups).toBe(0);
  });

  it('a slug change on the re-keyed posting keeps its old route resolving to it, not to the id sibling', () => {
    const reconciled = reconcileDuplicateIdJobs([unterassistent(), apn()]).jobs;
    const apnId = reconciled.find((j) => j.url === URL_2644)!.id;

    const renamedSlug = 'advanced-practice-nurse-apn-gerontopsychiatrie-puk-zuerich';
    const freshApn = {
      ...apn(),
      id: `puk-zuerich-${sha12(URL_2644)}`,
      title: 'Advanced Practice Nurse (APN) Gerontopsychiatrie',
      titleByLocale: { de: 'Advanced Practice Nurse (APN) Gerontopsychiatrie' },
      slug: renamedSlug,
      slugByLocale: { de: renamedSlug },
    };
    const fresh2117 = { ...unterassistent(), id: `puk-zuerich-${sha12(URL_2117)}` };
    const merged = mergePreserveLocaleData(reconciled, [fresh2117, freshApn], { nowMs: Date.parse('2026-09-25T00:00:00Z') });
    const apnAfter = merged.find((j: { url: string }) => j.url === URL_2644)!;

    expect(apnAfter.id).toBe(apnId);
    expect(apnAfter.slugByLocale.de).toBe(renamedSlug);
    expect(historyOf(apnAfter).has(SLUG_2644)).toBe(true);

    registerJobSlugMap(merged);
    expect(getJobMetaForSlug(renamedSlug)?.id).toBe(apnId);
    expect(getJobMetaForSlug(SLUG_2644)?.id).toBe(apnId);
    expect(getJobMetaForSlug(SLUG_2117)?.id).toBe(SHARED_ID);
  });
});

describe('summary line consumed by recover-prev-slugs.yml', () => {
  it('counts a re-key-only run in M, so the commit gate persists the repaired id', () => {
    const line = formatReconcileSummary({ apply: true, groups: 1, collapsed: 0, rekeyed: 1, marksCarried: 0 });
    // Same extraction the workflow runs with sed.
    const m = line.match(/^[A-Za-z-]+: [0-9]+ duplicate-id group\(s\), ([0-9]+) record/);
    expect(m?.[1]).toBe('1');
  });
});
