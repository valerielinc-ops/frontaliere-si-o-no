/**
 * Soglia di ammissione dei job di agenzia (decisione del proprietario
 * 2026-10-03): un job di fachkraft/sta/stellentreff/stellenpartner che ARRIVA
 * con il titolo non tradotto resta nello slice — quindi nella coda di
 * translate-pending — ma non viene pubblicato finché tutti i suoi titoli non
 * sono tradotti. Nessun URL già servito viene ritirato.
 *
 * Questo file copre lo stato (timbro, rilascio, conteggio) e i punti di taglio
 * che non passano dall'assemblatore: archivio degli scaduti, mining degli slug,
 * registro degli slug, alert. L'assemblatore vero gira in
 * tests/scripts/assemble-translation-hold.test.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TRANSLATION_HOLD_CRAWLER_KEYS,
  TRANSLATION_HOLD_FIELD,
  TRANSLATION_HOLD_RELEASED_FIELD,
  applyTranslationHold,
  hasPublishableTitles,
  isHeldFromPublication,
  partitionHeldFromPublication,
  releaseTranslatedHolds,
  summarizeTranslationHold,
  untranslatedTitleLocales,
} from '../scripts/lib/translation-publication-hold.mjs';
import { archiveRemovedJobsToSlice } from '../scripts/lib/expired-jobs-archive.mjs';
import { selectNewlyPublishedJobs } from '../scripts/send-company-alerts.mjs';
import { isHeldOnlySlugForSource, mineActiveJobs } from '../scripts/mine-all-job-slugs.mjs';
import { releaseTranslationHolds } from '../scripts/release-translation-holds.mjs';

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

type Job = Record<string, any>;

/** A German-source agency posting as the crawler writes it under SKIP_AI_TRANSLATION. */
function agencyJob(n: number, overrides: Job = {}): Job {
  const title = `Polymechaniker/in CNC Fertigung ${n}`;
  return {
    id: `sta-test-${n}`,
    url: `https://jobs.example.invalid/job/11635${n}`,
    slug: `polymechaniker-in-cnc-fertigung-${n}-sta-personal-ag-zurich`,
    slugByLocale: {
      it: `polymechaniker-in-cnc-fertigung-${n}-sta-personal-ag-zurich`,
      en: `polymechaniker-in-cnc-fertigung-${n}-sta-personal-ag-zurich-en`,
      de: `polymechaniker-in-cnc-fertigung-${n}-zurich-sta-ch`,
      fr: `polymechaniker-in-cnc-fertigung-${n}-sta-personal-ag-zurich-fr`,
    },
    company: 'STA Personal AG',
    companyKey: 'sta',
    title,
    sourceLang: 'de',
    titleByLocale: { it: title, en: title, de: title, fr: title },
    location: 'Zürich',
    canton: 'ZH',
    crawledAt: daysAgo(0),
    firstSeenAt: daysAgo(3),
    ...overrides,
  };
}

function translated(job: Job): Job {
  return {
    ...job,
    titleByLocale: {
      de: job.title,
      it: `Polimeccanico/a produzione CNC ${job.id}`,
      en: `CNC production polymechanic ${job.id}`,
      fr: `Polymécanicien/ne production CNC ${job.id}`,
    },
  };
}

const tmpDirs: string[] = [];
function tmpDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  delete process.env.SLUG_REGISTRY_PATH_OVERRIDE;
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('registro dei crawler di agenzia', () => {
  it('names exactly the four agency crawlers of the owner decision', () => {
    expect([...TRANSLATION_HOLD_CRAWLER_KEYS].sort()).toEqual(['fachkraft', 'sta', 'stellenpartner', 'stellentreff']);
  });
});

describe('titolo tradotto = predicati condivisi (hasUsableTitle, isTitleSourceCopy, titleContainsLlmReasoning)', () => {
  it('reports every target locale still holding the source copy', () => {
    expect(untranslatedTitleLocales(agencyJob(1))).toEqual(['it', 'en', 'fr']);
  });

  it('is publishable once every locale has its own title', () => {
    expect(hasPublishableTitles(translated(agencyJob(1)))).toBe(true);
  });

  it('a missing slot or an LLM reasoning leak is not a translation', () => {
    const job = translated(agencyJob(2));
    expect(untranslatedTitleLocales({ ...job, titleByLocale: { ...job.titleByLocale, fr: '' } })).toEqual(['fr']);
    expect(untranslatedTitleLocales({
      ...job,
      titleByLocale: { ...job.titleByLocale, en: 'Here is the translation: CNC polymechanic' },
    })).toEqual(['en']);
  });
});

describe('applyTranslationHold — timbro al momento della scrittura del crawler', () => {
  it('never holds a job already in the slice: what is online stays online (transition and stickiness)', () => {
    const prior = agencyJob(1); // pre-gate record: no stamp, untranslated, already published
    const next = [agencyJob(1)];
    const stats = applyTranslationHold('sta', next, [prior], { now: daysAgo(0) });
    expect(next[0][TRANSLATION_HOLD_FIELD]).toBeUndefined();
    expect(isHeldFromPublication(next[0])).toBe(false);
    expect(stats).toMatchObject({ gated: true, held: 0, newlyHeld: 0 });
  });

  it('holds a NEW arrival whose title is not translated, and keeps it in the slice', () => {
    const now = daysAgo(0);
    const next = [agencyJob(1), agencyJob(2)];
    const stats = applyTranslationHold('sta', next, [agencyJob(1)], { now });
    expect(next).toHaveLength(2);
    expect(next[1][TRANSLATION_HOLD_FIELD]).toBe(now);
    expect(isHeldFromPublication(next[1])).toBe(true);
    expect(stats).toMatchObject({ held: 1, newlyHeld: 1 });
  });

  it('admits a new arrival that is already translated', () => {
    const next = [translated(agencyJob(3))];
    const stats = applyTranslationHold('fachkraft', next, [], { now: daysAgo(0) });
    expect(next[0][TRANSLATION_HOLD_FIELD]).toBeUndefined();
    expect(stats.admittedOnArrival).toBe(1);
  });

  it('keeps the original hold timestamp across re-crawls while untranslated', () => {
    const since = daysAgo(4);
    const next = [agencyJob(4)];
    applyTranslationHold('sta', next, [agencyJob(4, { [TRANSLATION_HOLD_FIELD]: since })], { now: daysAgo(0) });
    expect(next[0][TRANSLATION_HOLD_FIELD]).toBe(since);
  });

  it('releases a held job once translated, and the admission survives a later title regression', () => {
    const now = daysAgo(0);
    const priorHeldButTranslated = translated(agencyJob(5, { [TRANSLATION_HOLD_FIELD]: daysAgo(4) }));
    // The re-crawl brings the source copy back (e.g. the agency edited the title).
    const next = [agencyJob(5)];
    const stats = applyTranslationHold('sta', next, [priorHeldButTranslated], { now });
    expect(stats.released).toBe(1);
    expect(next[0][TRANSLATION_HOLD_FIELD]).toBeUndefined();
    expect(next[0][TRANSLATION_HOLD_RELEASED_FIELD]).toBe(now);
    expect(isHeldFromPublication(next[0])).toBe(false);

    // Next crawl: the released record is "already seen", so it is never re-held.
    const later = [agencyJob(5)];
    applyTranslationHold('sta', later, next, { now: daysAgo(-1) });
    expect(later[0][TRANSLATION_HOLD_FIELD]).toBeUndefined();
    expect(later[0][TRANSLATION_HOLD_RELEASED_FIELD]).toBe(now);
  });

  it('leaves every non-agency crawler untouched and strips a stale stamp', () => {
    const job = { ...agencyJob(6), companyKey: 'coop' };
    const next = [job, { ...agencyJob(7), companyKey: 'coop', [TRANSLATION_HOLD_FIELD]: daysAgo(9) }];
    const stats = applyTranslationHold('coop', next, [], { now: daysAgo(0) });
    expect(stats.gated).toBe(false);
    expect(next.every((j) => !j[TRANSLATION_HOLD_FIELD])).toBe(true);
    expect(isHeldFromPublication(job)).toBe(false);
  });
});

describe('il job trattenuto resta nella coda di translate-pending', () => {
  it('every hold condition is queued by a translator that never gives up on it', async () => {
    const held = agencyJob(1, {
      [TRANSLATION_HOLD_FIELD]: daysAgo(2),
      description: 'x'.repeat(200),
      descriptionByLocale: { it: 'x'.repeat(200), en: 'x'.repeat(200), de: 'x'.repeat(200), fr: 'x'.repeat(200) },
    });
    const { needsWork, missingSlots } = await import('../scripts/local-mt-mopup.mjs');
    const { needsTranslation } = await import('../scripts/relocalize-pending-jobs.mjs');
    const { titleLooksUntranslated } = await import('../scripts/lib/job-locale-utils.mjs');
    // Phase 2a/2c (Argos, titles first) and 2b (cascade) select it…
    expect(needsWork(held)).toBe(true);
    expect(missingSlots(held).filter((slot: Job) => slot.field === 'title').map((slot: Job) => slot.locale))
      .toEqual(untranslatedTitleLocales(held));
    expect(needsTranslation(held)).toBe(true);
    // …and Phases 2a.2/2d (fix-untranslated-titles) queue exactly the
    // source-copy / LLM-reasoning reasons, with no give-up valve.
    for (const locale of untranslatedTitleLocales(held)) {
      expect(titleLooksUntranslated({
        title: held.titleByLocale[locale], sourceTitle: held.title, sourceLang: 'de', targetLocale: locale,
      }).reason).toBe('source-copy');
    }
  });
});

describe('pubblicazione', () => {
  it('partitions held agency jobs out, translated and non-agency jobs stay in', () => {
    const held = agencyJob(1, { [TRANSLATION_HOLD_FIELD]: daysAgo(2) });
    const translatedHeld = translated(agencyJob(2, { [TRANSLATION_HOLD_FIELD]: daysAgo(2) }));
    const grandfathered = agencyJob(3);
    const nonAgency = { ...agencyJob(4), companyKey: 'coop', [TRANSLATION_HOLD_FIELD]: daysAgo(2) };
    const { published, held: out } = partitionHeldFromPublication([held, translatedHeld, grandfathered, nonAgency]);
    expect(out).toEqual([held]);
    expect(published).toEqual([translatedHeld, grandfathered, nonAgency]);
  });

  it('counts the admission queue per crawler with the oldest wait (capacity measure)', () => {
    const summary = summarizeTranslationHold([
      agencyJob(1, { [TRANSLATION_HOLD_FIELD]: daysAgo(5) }),
      agencyJob(2, { companyKey: 'fachkraft', [TRANSLATION_HOLD_FIELD]: daysAgo(1) }),
      translated(agencyJob(3, { [TRANSLATION_HOLD_FIELD]: daysAgo(9) })),
      agencyJob(4),
    ]);
    expect(summary.held).toBe(2);
    expect(summary.byCrawler).toEqual({ sta: 1, fachkraft: 1 });
    expect(summary.oldestHeldDays).toBe(5);
  });

  it('releaseTranslatedHolds frees only the translated ones', () => {
    const now = daysAgo(0);
    const jobs = [
      translated(agencyJob(1, { [TRANSLATION_HOLD_FIELD]: daysAgo(3) })),
      agencyJob(2, { [TRANSLATION_HOLD_FIELD]: daysAgo(3) }),
    ];
    expect(releaseTranslatedHolds(jobs, { now })).toBe(1);
    expect(jobs[0][TRANSLATION_HOLD_FIELD]).toBeUndefined();
    expect(jobs[0][TRANSLATION_HOLD_RELEASED_FIELD]).toBe(now);
    expect(isHeldFromPublication(jobs[1])).toBe(true);
  });

  it('the translate-pending release step rewrites only the agency slices, in place', () => {
    const dir = tmpDir('release-holds-');
    const heldTranslated = translated(agencyJob(1, { [TRANSLATION_HOLD_FIELD]: daysAgo(3) }));
    const heldPending = agencyJob(2, { [TRANSLATION_HOLD_FIELD]: daysAgo(3) });
    const assembledAt = daysAgo(1);
    fs.writeFileSync(path.join(dir, 'sta.json'), JSON.stringify({ crawlerKey: 'sta', assembledAt, jobs: [heldTranslated, heldPending] }));
    const lines: string[] = [];
    const result = releaseTranslationHolds({ dir, now: daysAgo(0), log: (line) => lines.push(line) });
    expect(result.released).toBe(1);
    expect(result.summary.held).toBe(1);
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'sta.json'), 'utf8'));
    expect(written.assembledAt).toBe(assembledAt); // not a new crawl
    expect(written.jobs).toHaveLength(2);
    expect(written.jobs[0][TRANSLATION_HOLD_FIELD]).toBeUndefined();
    expect(written.jobs[1][TRANSLATION_HOLD_FIELD]).toBeTruthy();
    expect(lines.join('\n')).toContain('1 job fuori dalla pubblicazione');
  });
});

describe('nessuna pagina scaduta, soft landing o alert per un job trattenuto', () => {
  it('a held job that leaves the source is not archived as expired; a published one is', () => {
    const dir = tmpDir('held-expired-');
    const held = agencyJob(1, { [TRANSLATION_HOLD_FIELD]: daysAgo(2) });
    const published = agencyJob(2);
    archiveRemovedJobsToSlice([held, published], 'sta', { dir });
    const archived = JSON.parse(fs.readFileSync(path.join(dir, 'sta.json'), 'utf8'));
    expect(archived.map((entry: Job) => entry.slug)).toEqual([published.slug]);
  });

  it('slug mining does not register a held job, nor its slugs from registry/git sources', () => {
    const dir = tmpDir('held-mining-');
    const held = agencyJob(1, { [TRANSLATION_HOLD_FIELD]: daysAgo(2) });
    const published = agencyJob(2);
    fs.writeFileSync(path.join(dir, 'sta.json'), JSON.stringify({ crawlerKey: 'sta', jobs: [held, published] }));
    const mined = mineActiveJobs(dir);
    expect(mined.has(published.slug)).toBe(true);
    expect(mined.has(held.slug)).toBe(false);
    for (const slug of Object.values(held.slugByLocale) as string[]) expect(mined.has(slug)).toBe(false);
    expect(isHeldOnlySlugForSource('Slug registry', held.slug)).toBe(true);
    expect(isHeldOnlySlugForSource('Git history (removed slugs)', held.slugByLocale.de)).toBe(true);
    // Sources that are themselves evidence of a public URL are never filtered.
    expect(isHeldOnlySlugForSource('Expired jobs', held.slug)).toBe(false);
    expect(isHeldOnlySlugForSource('Slug registry', published.slug)).toBe(false);
  });

  it('a held job is not pinned in the immutable slug registry; a published one is', async () => {
    const dir = tmpDir('held-registry-');
    const regPath = path.join(dir, 'slug-registry.json');
    fs.writeFileSync(regPath, '{}', 'utf-8');
    process.env.SLUG_REGISTRY_PATH_OVERRIDE = regPath;
    const { mergeAndDeduplicate } = await import('../scripts/lib/dedicated-crawler-common.mjs');
    const held = { ...agencyJob(1, { [TRANSLATION_HOLD_FIELD]: daysAgo(2) }), description: 'x'.repeat(200), source: 'Company Careers Crawler' };
    const published = { ...translated(agencyJob(2)), description: 'y'.repeat(200), source: 'Company Careers Crawler' };
    mergeAndDeduplicate([], [held, published], {});
    const registry = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    const pinned = Object.values(registry).map((entry: any) => (typeof entry === 'string' ? entry : entry.canonicalSlug));
    expect(pinned.some((slug) => String(slug).includes('-2-'))).toBe(true);
    expect(pinned.some((slug) => String(slug).includes('-1-'))).toBe(false);
  });

  it('once released, a job alerts like a new one (release time is the novelty clock)', () => {
    const now = Date.now();
    const released = translated(agencyJob(1, {
      firstSeenAt: daysAgo(6),
      [TRANSLATION_HOLD_RELEASED_FIELD]: new Date(now - 60 * 60 * 1000).toISOString(),
    }));
    const standing = translated(agencyJob(2, { firstSeenAt: daysAgo(6) }));
    const selected = selectNewlyPublishedJobs([released, standing], now, 6 * 60 * 60 * 1000);
    expect(selected.map((job: Job) => job.id)).toEqual([released.id]);
  });
});
