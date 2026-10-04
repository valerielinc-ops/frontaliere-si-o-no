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
import { execFileSync } from 'node:child_process';
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
  publishedOnNextDeploy,
  releaseTranslatedHolds,
  summarizeTranslationHold,
  untranslatedTitleLocales,
} from '../scripts/lib/translation-publication-hold.mjs';
import { archiveRemovedJobsToSlice } from '../scripts/lib/expired-jobs-archive.mjs';
import { selectNewlyPublishedJobs } from '../scripts/send-company-alerts.mjs';
import {
  isHeldOnlySlugForSource,
  mergeMinedSources,
  mineActiveJobs,
  mineGitRemovedSlugs,
  mineSlugRegistry,
} from '../scripts/mine-all-job-slugs.mjs';
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
    const since = daysAgo(4);
    const next = [translated(agencyJob(5))];
    const stats = applyTranslationHold('sta', next, [agencyJob(5, { [TRANSLATION_HOLD_FIELD]: since })], { now });
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

  it('keeps a held job held when only its older copy was translated and the re-crawl regressed', () => {
    const since = daysAgo(4);
    const priorHeldButTranslated = translated(agencyJob(8, { [TRANSLATION_HOLD_FIELD]: since }));
    // The re-crawl brings the source copy back (e.g. the agency edited the title).
    const next = [agencyJob(8)];
    const stats = applyTranslationHold('sta', next, [priorHeldButTranslated], { now: daysAgo(0) });
    expect(stats.released).toBe(0);
    expect(stats.held).toBe(1);
    expect(next[0][TRANSLATION_HOLD_FIELD]).toBe(since);
    expect(isHeldFromPublication(next[0])).toBe(true);
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

describe('il riepilogo del crawler elenca solo ciò che il prossimo deploy pubblica', () => {
  it('lascia fuori un arrivo non tradotto e un job ancora trattenuto, tiene i già ammessi e i tradotti', () => {
    const slicesDir = path.join(tmpDir('held-summary-'), 'by-crawler');
    fs.mkdirSync(slicesDir, { recursive: true });
    const grandfathered = agencyJob(1);
    const stillHeld = agencyJob(4, { [TRANSLATION_HOLD_FIELD]: daysAgo(2) });
    fs.writeFileSync(path.join(slicesDir, 'sta.json'), JSON.stringify({ crawlerKey: 'sta', jobs: [grandfathered, stillHeld] }));
    const other = { id: 'acme-1', companyKey: 'acme', title: 'Contabile', titleByLocale: {} };
    const crawl = [
      agencyJob(1),
      agencyJob(2),
      translated(agencyJob(3)),
      agencyJob(4),
      other,
    ];
    expect(publishedOnNextDeploy(crawl, { slicesDir }).map((job) => job.id))
      .toEqual(['sta-test-1', 'sta-test-3', 'acme-1']);
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
    mergeAndDeduplicate([], [held, published], {}, { translationHoldSlicesDir: dir });
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

describe('un job trattenuto che lascia lo slice prima del rilascio non diventa un soft landing', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', [
    '-c', 'commit.gpgsign=false', '-c', 'user.name=hold-test', '-c', 'user.email=hold-test@example.invalid', ...args,
  ], { cwd, encoding: 'utf8' });
  const crawled = (job: Job): Job => ({ ...job, description: `${job.title} `.repeat(12), source: 'Company Careers Crawler' });
  const routeSlugs = (job: Job): string[] => [job.slug, ...Object.values(job.slugByLocale || {}) as string[], ...(job.previousSlugs || [])];
  const registeredSlugs = (regPath: string): Set<string> => {
    const out = new Set<string>();
    for (const entry of Object.values(JSON.parse(fs.readFileSync(regPath, 'utf8'))) as any[]) {
      if (typeof entry === 'string') { out.add(entry); continue; }
      if (entry?.canonicalSlug) out.add(entry.canonicalSlug);
      for (const value of Object.values(entry?.slugByLocale || {})) out.add(String(value));
    }
    return out;
  };
  const writeSlice = (dir: string, jobs: Job[]) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sta.json'), `${JSON.stringify({ crawlerKey: 'sta', jobs }, null, 2)}\n`);
  };

  it('the crawler localization pass does not register a new untranslated arrival before the slice writer stamps it', async () => {
    const dir = tmpDir('held-first-crawl-');
    const slicesDir = path.join(dir, 'by-crawler');
    const regPath = path.join(dir, 'slug-registry.json');
    fs.writeFileSync(regPath, '{}', 'utf-8');
    process.env.SLUG_REGISTRY_PATH_OVERRIDE = regPath;
    const grandfathered = crawled(agencyJob(1));
    const stampedOnDisk = crawled(agencyJob(4, { [TRANSLATION_HOLD_FIELD]: daysAgo(2) }));
    writeSlice(slicesDir, [grandfathered, stampedOnDisk]);
    const { mergeAndDeduplicate } = await import('../scripts/lib/dedicated-crawler-common.mjs');
    // crawler-template Step 5: the scratch copy carries no stamp yet.
    const newArrival = crawled(agencyJob(2));
    const translatedArrival = crawled(translated(agencyJob(3)));
    const scratchCopyOfHeld = crawled(agencyJob(4));
    mergeAndDeduplicate([grandfathered, newArrival, translatedArrival, scratchCopyOfHeld], [], {}, {
      localizeExistingOnly: true,
      translationHoldSlicesDir: slicesDir,
    });
    const registered = registeredSlugs(regPath);
    expect(registered.has(grandfathered.slug)).toBe(true); // already public: unchanged
    expect(registered.has(translatedArrival.slug)).toBe(true); // admitted on arrival
    for (const slug of routeSlugs(newArrival)) expect(registered.has(slug)).toBe(false);
    for (const slug of routeSlugs(scratchCopyOfHeld)) expect(registered.has(slug)).toBe(false);
  });

  it('registry, git history and slices: the departed held job is mined nowhere; the released job keeps its held-era slugs', async () => {
    const repo = tmpDir('held-departed-repo-');
    const slicesDir = path.join(repo, 'data', 'jobs', 'by-crawler');
    const regPath = path.join(tmpDir('held-departed-registry-'), 'slug-registry.json');
    fs.writeFileSync(regPath, '{}', 'utf-8');
    process.env.SLUG_REGISTRY_PATH_OVERRIDE = regPath;
    const { mergeAndDeduplicate } = await import('../scripts/lib/dedicated-crawler-common.mjs');
    git(repo, 'init', '-q');
    const commit = (jobs: Job[], message: string) => {
      writeSlice(slicesDir, jobs);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', message);
    };

    // Before: two published (pre-threshold) agency jobs.
    const published = crawled(agencyJob(1));
    const expiring = crawled(agencyJob(4));
    commit([published, expiring], 'seed');

    // First crawl of two untranslated arrivals: localization pass, then the
    // slice writer stamps them.
    const departing = crawled(agencyJob(2));
    const releasedLater = crawled(agencyJob(3));
    mergeAndDeduplicate([published, expiring, departing, releasedLater], [], {}, {
      localizeExistingOnly: true, translationHoldSlicesDir: slicesDir,
    });
    const crawl1 = [published, expiring, departing, releasedLater].map((job) => ({ ...job }));
    applyTranslationHold('sta', crawl1, [published, expiring], { now: daysAgo(2) });
    commit(crawl1, 'crawl: two agency arrivals held');

    // translate-pending translates one of them; slug regeneration keeps the
    // held-era slugs as bridges, the release step admits it.
    const heldEra = crawl1.find((job) => job.id === releasedLater.id)!;
    const released: Job = {
      ...translated(heldEra),
      slug: 'polimeccanico-a-produzione-cnc-3-sta-personal-ag-zurich',
      slugByLocale: {
        it: 'polimeccanico-a-produzione-cnc-3-sta-personal-ag-zurich',
        en: 'cnc-production-polymechanic-3-sta-personal-ag-zurich',
        de: heldEra.slugByLocale.de,
        fr: 'polymecanicien-ne-production-cnc-3-sta-personal-ag-zurich',
      },
      previousSlugs: [heldEra.slugByLocale.it, heldEra.slugByLocale.en, heldEra.slugByLocale.fr],
    };
    const crawl2 = crawl1.map((job) => (job.id === released.id ? released : job));
    expect(releaseTranslatedHolds(crawl2, { now: daysAgo(1) })).toBe(1);
    commit(crawl2, 'translate-pending: release');
    // Next pass over the admitted job registers it.
    mergeAndDeduplicate(crawl2, [], {}, { localizeExistingOnly: true, translationHoldSlicesDir: slicesDir });

    // The held job and an ordinary published job leave the source.
    const heldDeparted = crawl2.find((job) => job.id === departing.id)!;
    expect(isHeldFromPublication(heldDeparted)).toBe(true);
    commit(crawl2.filter((job) => job.id !== departing.id && job.id !== expiring.id), 'crawl: two jobs gone');

    const gitMined = mineGitRemovedSlugs({ cwd: repo });
    for (const slug of routeSlugs(heldDeparted)) expect(gitMined.has(slug)).toBe(false);
    expect(gitMined.has(expiring.slug)).toBe(true); // a public removal is still mined
    const registered = registeredSlugs(regPath);
    for (const slug of routeSlugs(heldDeparted)) expect(registered.has(slug)).toBe(false);
    expect(registered.has(released.slug)).toBe(true); // registered once admitted

    const { allSlugs } = mergeMinedSources([
      { name: 'Active jobs', fn: () => mineActiveJobs(slicesDir) },
      { name: 'Slug registry', fn: () => mineSlugRegistry(regPath) },
      { name: 'Git history (removed slugs)', fn: () => mineGitRemovedSlugs({ cwd: repo }) },
    ]);
    for (const slug of routeSlugs(heldDeparted)) expect(allSlugs.has(slug)).toBe(false);
    for (const slug of [...routeSlugs(released), ...routeSlugs(heldEra)]) expect(allSlugs.has(slug)).toBe(true);
    for (const slug of [...routeSlugs(published), ...routeSlugs(expiring)]) expect(allSlugs.has(slug)).toBe(true);
  });
});
