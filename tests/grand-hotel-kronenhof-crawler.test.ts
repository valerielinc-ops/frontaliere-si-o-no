/**
 * Grand Hotel Kronenhof / Kulm Group — detail page parser + job builder.
 *
 * Fixture: careers.kronenhof.com/en/vacancies/716 (live shape, minimised).
 * Regressions covered (#5253, source-detail-mismatch):
 *   - the "Similar jobs" section closing <main> carries the title and full
 *     teaser of three OTHER vacancies; its <h3> cards were appended to every
 *     description as sections of this role;
 *   - the company paragraph that opens `div.content-page` before the first
 *     heading was dropped;
 *   - sourceLang was detected from the title ("Chef de Rang", "Zimmerdame")
 *     instead of the /en/ body, filing a machine translation as the source.
 */
import { describe, expect, it } from 'vitest';

import { buildJob, mergeJobLists, parseDetailPage } from '@/scripts/update-kronenhof-jobs.mjs';

const DETAIL_HTML = `
<html><body><main>
<section class="entry">
  <a href="https://careers.kronenhof.com/en/vacancies" class="default-link">Back to vacancies</a>
  <h1 class="mb-0">Chef de Rang - immediate start (m/w/d)</h1>
  <div class="mb-3 flex"><span>Grand Hotel Kronenhof</span><span>100%</span><span>Season (3-4 months)</span></div>
  <a href="https://recruitingapp-2983.umantis.com/Vacancies/716/Application/CheckLogin/2?lang=eng" class="btn btn-primary">Apply now</a>
</section>
<section class="entry container"><div class="lg:col-span-7"><div class="content-page">
  <p>People at 1800m above sea level are shaping the Luxury Mountain Travel. Our dynamic and international community offers our guests smart Luxury for an inimitable holiday experience.</p><br />
  <h2>This is what you move with us</h2>
  <ul>
    <li>Exquisite guest hospitality: Welcome our international guests with warmth and professionalism.</li>
    <li>Team leadership: Guide and support a team of Commis de Rang, ensuring seamless collaboration on the floor.</li>
  </ul>
  <h2>This is you</h2>
  <ul>
    <li>Education &amp; foundation: Completed training in hospitality or equivalent practical experience.</li>
    <li>Languages: Good knowledge of English or German; Italian is a Plus.</li>
  </ul>
  <h2>Benefits</h2>
  <p>At Kulm Group, our employees are the heart of our success. We offer comfortable accommodations and affordable meals.</p>
  <a href="https://recruitingapp-2983.umantis.com/Vacancies/716/Application/CheckLogin/2?lang=eng" class="btn btn-primary">Apply now</a>
</div></div></section>
<section class="entry border-gray">
  <div class="flex"><h2>Similar jobs</h2><a href="https://careers.kronenhof.com/en/vacancies" class="default-link">See all jobs</a></div>
  <div class="flex flex-col gap-6">
    <article><a href="https://careers.kronenhof.com/en/vacancies/731" class="group flex">
      <h3 class="font-title">Demi Chef de Partie - start immediately (m/w/d)</h3>
      <p class="line-clamp-3">People at 1800m above sea level are shaping the Luxury Mountain Travel. Demi Chef de Partie teaser that belongs to another vacancy.</p>
    </a></article>
  </div>
</section>
</main></body></html>
`;

function isoDaysFromNow(days: number) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

describe('parseDetailPage', () => {
  it('keeps the whole vacancy body: intro paragraph, tasks, profile and benefits', () => {
    const description = parseDetailPage(DETAIL_HTML);
    expect(description.startsWith('People at 1800m above sea level')).toBe(true);
    expect(description).toContain('## This is what you move with us');
    expect(description).toContain('Team leadership: Guide and support a team of Commis de Rang');
    expect(description).toContain('## This is you');
    expect(description).toContain('## Benefits');
    expect(description).toContain('affordable meals');
  });

  it('stops at the "Similar jobs" section and drops call-to-action buttons', () => {
    const description = parseDetailPage(DETAIL_HTML);
    expect(description).not.toContain('Similar jobs');
    expect(description).not.toContain('Demi Chef de Partie');
    expect(description).not.toContain('belongs to another vacancy');
    expect(description).not.toContain('Apply now');
  });
});

describe('buildJob', () => {
  const raw = {
    id: 716,
    title: 'Chef de Rang - immediate start (m/w/d)',
    location: 'Grand Hotel Kronenhof',
    contract_duration: 'seasonal',
    workload: 100,
    contract_starts_at: `${isoDaysFromNow(10)}T00:00:00.000000Z`,
  };

  it('labels the /en/ body as English even when the title reads as French/German', () => {
    const detail = parseDetailPage(DETAIL_HTML);
    const job = buildJob(raw, detail);
    expect(job.sourceLang).toBe('en');
    expect(job.url).toBe('https://careers.kronenhof.com/en/vacancies/716');
    expect(job.description).toContain('Exquisite guest hospitality');
    expect(job.descriptionByLocale.en).toBe(job.description);
  });

  it('writes the facts line in the language of the English body, not in fixed German', () => {
    const job = buildJob(raw, parseDetailPage(DETAIL_HTML));
    expect(job.description).toContain('Workload: 100%. Contract:');
    expect(job.description).toContain('Start: ');
    expect(job.description).not.toContain('Pensum:');
    expect(job.description).not.toContain('Stellenantritt:');
  });

  it('builds no description at all when the detail page is thin (no invented fallback)', () => {
    const job = buildJob(raw, 'Chef de Rang wanted.');
    expect(job.description).toBe('');
    expect(job.descriptionByLocale).toEqual({});
    expect(job.sourceLang).toBe('');
    expect(job.title).toBe('Chef de Rang - immediate start (m/w/d)');
  });
});

describe('mergeJobLists', () => {
  const raw = {
    id: 716,
    title: 'Chef de Rang - immediate start (m/w/d)',
    location: 'Grand Hotel Kronenhof',
    contract_duration: 'seasonal',
    workload: 100,
  };
  // Marketing text earlier versions published for thin detail pages.
  const INVENTED_FALLBACK =
    'Chef de Rang — Grand Hotel Kronenhof, Pontresina. Die Kulm Gruppe betreibt zwei der exklusivsten 5-Sterne-Hotels im Engadin. Bewerbungen an: people@kulmgroup.com';

  it('keeps the body stored from an earlier read of the source when the fresh page is thin', () => {
    const stored = {
      ...buildJob(raw, parseDetailPage(DETAIL_HTML)),
      descriptionByLocale: {
        en: buildJob(raw, parseDetailPage(DETAIL_HTML)).description,
        it: 'Traduzione italiana del corpo letto dalla fonte.',
      },
    };
    const { mergedTarget, updated, skipped } = mergeJobLists([stored], [buildJob(raw, '')]);
    expect(updated).toBe(1);
    expect(skipped).toBe(0);
    expect(mergedTarget[0].description).toBe(stored.description);
    expect(mergedTarget[0].sourceLang).toBe('en');
    expect(mergedTarget[0].descriptionByLocale.it).toBe('Traduzione italiana del corpo letto dalla fonte.');
  });

  it('does not publish a job that has no body and nothing stored from the source', () => {
    const fresh = buildJob(raw, '');
    expect(mergeJobLists([], [fresh])).toMatchObject({ mergedTarget: [], added: 0, skipped: 1 });
    const storedFallback = { ...fresh, sourceLang: 'de', description: INVENTED_FALLBACK, descriptionByLocale: { de: INVENTED_FALLBACK } };
    expect(mergeJobLists([storedFallback], [fresh])).toMatchObject({ mergedTarget: [], updated: 0, skipped: 1 });
  });

  it('drops translations of a stale source (invented fallback, or Similar-jobs chrome) and flags retranslation', () => {
    const fresh = buildJob(raw, parseDetailPage(DETAIL_HTML));
    const fromFallback = {
      ...fresh,
      sourceLang: 'de',
      description: INVENTED_FALLBACK,
      descriptionByLocale: { de: INVENTED_FALLBACK, it: 'Il Gruppo Kulm gestisce due dei più esclusivi hotel 5 stelle.' },
    };
    const [a] = mergeJobLists([fromFallback], [fresh]).mergedTarget;
    expect(Object.keys(a.descriptionByLocale)).toEqual(['en']);
    expect(a.descriptionByLocale.en).toContain('Exquisite guest hospitality');
    expect(a.needsRetranslation).toBe(true);

    const withChrome = `${fresh.description}\n\n${'## Demi Chef de Partie (m/w/d)\nTeaser of another vacancy. '.repeat(40)}`;
    const fromChrome = {
      ...fresh,
      description: withChrome,
      descriptionByLocale: { en: withChrome, it: `Traduzione con le schede di altre offerte. ${'x '.repeat(2000)}` },
    };
    const [b] = mergeJobLists([fromChrome], [fresh]).mergedTarget;
    expect(Object.keys(b.descriptionByLocale)).toEqual(['en']);
    expect(b.descriptionByLocale.en).not.toContain('Teaser of another vacancy');
    expect(b.needsRetranslation).toBe(true);
  });

  it('keeps real translations of an unchanged source', () => {
    const fresh = buildJob(raw, parseDetailPage(DETAIL_HTML));
    const stored = { ...fresh, descriptionByLocale: { en: fresh.description, it: 'Traduzione italiana del corpo letto dalla fonte.' } };
    const [job] = mergeJobLists([stored], [fresh]).mergedTarget;
    expect(job.descriptionByLocale.it).toBe('Traduzione italiana del corpo letto dalla fonte.');
    expect(job.needsRetranslation).toBeUndefined();
  });
});
