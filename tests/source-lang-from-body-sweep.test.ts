/**
 * Issue 5253 sweep: the source language comes from the published BODY, not
 * from the job title (same class as kronenhof, mks-pamp, hes-so, decathlon).
 *
 * Titles are loanword soup — "Guest Experience Specialist", "Lift Operator",
 * "Candidatura spontanea" — and filed the body under a foreign source slot:
 * the Italian or German page then showed untranslated text and the real
 * source slot held a machine round-trip. Measured on the 2026-09-29 slices:
 * faulhaber 4/4, engadin-tourismus 1/2, pemsa 19/314.
 *
 * Fixtures are minimized page shapes of each source; no `data/**` is read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchHtml } = vi.hoisted(() => ({ fetchHtml: vi.fn() }));
vi.mock('../scripts/lib/crawler-template.mjs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchHtml };
});

const { fetchAllEngadinTourismusJobs } = await import('../scripts/lib/engadin-tourismus-job-parser.mjs');
const { fetchAllAirZermattJobs } = await import('../scripts/lib/air-zermatt-job-parser.mjs');
const { fetchAllMoncuccoJobs } = await import('../scripts/lib/moncucco-job-parser.mjs');
const { flagRelabeledSourceLang, withSourceLangRelabelFlags } = await import('../scripts/lib/source-lang-relabel.mjs');

const GERMAN_BODY = 'Du begrüsst unsere Gäste in der Tourist Information und berätst sie zu Wanderungen, Bergbahnen und Veranstaltungen im Engadin. '
  + 'Zu deinen weiteren Aufgaben gehören allgemeine administrative Tätigkeiten, die Betreuung der Leistungspartner und der Ticketverkauf. '
  + 'Wir bieten dir ein motiviertes Team, flexible Arbeitszeiten und Vergünstigungen bei unseren Partnern in der ganzen Region.';
const ITALIAN_BODY = 'Per il nostro reparto di cure intense cerchiamo una persona motivata che collabori con il team medico e infermieristico. '
  + 'Offriamo un ambiente di lavoro stimolante, formazione continua e condizioni di impiego interessanti presso la nostra clinica di Lugano.';

beforeEach(() => {
  fetchHtml.mockReset();
});

describe('engadin-tourismus', () => {
  const LISTING = '<a class="more" title="Guest Experience Specialist m/w/d, 70% Tourist Information Sils" href="/ueber-uns/jobs/jobs/guest-experience-specialist">Mehr lesen</a>';
  // Minimized from the live TYPO3 news page (2026-09-29): the vacancy is the
  // second grid row of `.news-single .article`; the page around it is the
  // navigation the old generic selectors published (2/2 jobs).
  const DETAIL = `<nav><ul><li>Über uns |</li><li>Jobs</li><li>Strategie &amp; Auftrag</li><li>Destinationsstrategie</li></ul></nav>
    <div class="news news-single"><div class="article">
      <div class="grid-x"><div class="cell"><h2>Guest Experience Specialist m/w/d, 70% Tourist Information Sils</h2><div class="news-detail__time">12. August</div></div></div>
      <div class="grid-x grid-margin-x space-element-b-large"><div class="cell">
        <p>${GERMAN_BODY}</p>
        <p><strong>Dein Rucksack</strong></p>
        <ul><li>Berufserfahrung im kaufmännischen Bereich oder im Tourismus</li><li>Sehr gute Destinations- und Angebotskenntnisse</li></ul>
        <p>Bitte sende dein Dossier an: <a href="mailto:recruiting@example-destination.ch">recruiting@example-destination.ch</a>, T <a href="tel:0041000000000">+41 00 000 00 00</a>.</p>
      </div></div>
    </div></div>`;

  it('publishes the vacancy text under de, without the navigation and the recruiter contacts', async () => {
    fetchHtml.mockResolvedValueOnce(LISTING).mockResolvedValueOnce(DETAIL);

    const [job] = await fetchAllEngadinTourismusJobs();

    expect(job.sourceLang).toBe('de');
    expect(Object.keys(job.descriptionByLocale)).toEqual(['de']);
    expect(Object.keys(job.titleByLocale)).toEqual(['de']);
    expect(job.description).toContain('• Berufserfahrung im kaufmännischen Bereich');
    expect(job.description).not.toContain('Strategie & Auftrag');
    expect(job.description).not.toContain('recruiting@');
    expect(job.description).not.toContain('+41');
  });

  it('does not publish a job whose page has no vacancy container (issue 5253)', async () => {
    fetchHtml.mockResolvedValueOnce(LISTING).mockResolvedValueOnce('<nav><ul><li>Über uns |</li><li>Jobs</li></ul></nav><main>Strategie &amp; Auftrag Destinationsstrategie Leistungsauftrag Organisation</main>');

    expect(await fetchAllEngadinTourismusJobs()).toEqual([]);
  });
});

describe('air-zermatt', () => {
  it('files the German body under de even when the title reads as English', async () => {
    fetchHtml
      .mockResolvedValueOnce(`<div class="listing_entry" data-entry-id="41"><h2 class="listing-title"><a href="/jobs/head-of-maintenance">Head of Maintenance for the Helicopter Fleet</a></h2><div class="listing-content-text"><p><strong>Raron</strong></p></div></div>`)
      .mockResolvedValueOnce(`<div class="listing-content-text"><p>${GERMAN_BODY}</p></div>`);

    const [job] = await fetchAllAirZermattJobs();

    expect(job.sourceLang).toBe('de');
    expect(Object.keys(job.descriptionByLocale)).toEqual(['de']);
  });
});

describe('moncucco', () => {
  const listing = '<div class="item-job"><a href="/infermiere-cure-intense.php5"><h3>Head Nurse for the Intensive Care Unit and the Recovery Room</h3><p class="info-job">Percentuale: 80-100%</p></a></div>';

  it('files the Italian detail body under it even when the title reads as English', async () => {
    fetchHtml
      .mockResolvedValueOnce(listing)
      .mockResolvedValueOnce(`<div class="testo-pagina"><p>${ITALIAN_BODY}</p></div>`);

    const [job] = await fetchAllMoncuccoJobs();

    expect(job.sourceLang).toBe('it');
    expect(Object.keys(job.descriptionByLocale)).toEqual(['it']);
  });

  it('does not publish a job without a detail body instead of an assembled snippet (issue 5253)', async () => {
    fetchHtml
      .mockResolvedValueOnce(listing)
      .mockRejectedValueOnce(new Error('HTTP 503'));

    // The old parser published "<title> — Gruppo Ospedaliero Moncucco, Lugano
    // <percentuale>"; the standard pipeline now keeps the stored record.
    expect(await fetchAllMoncuccoJobs()).toEqual([]);
  });
});

describe('flagRelabeledSourceLang', () => {
  const url = 'https://jobs.example-ats.ch/stellenangebot/57372/tecnico';

  it('flags only the jobs whose stored source language differs', () => {
    const fresh = [
      { url, sourceLang: 'it' },
      { url: 'https://jobs.example-ats.ch/stellenangebot/57373/altro', sourceLang: 'it' },
      { url: 'https://jobs.example-ats.ch/stellenangebot/57374/nuovo', sourceLang: 'it' },
    ];
    const stored = [
      { url, sourceLang: 'fr' },
      { url: 'https://jobs.example-ats.ch/stellenangebot/57373/altro', sourceLang: 'it' },
    ];

    expect(flagRelabeledSourceLang(fresh, stored)).toBe(1);
    expect(fresh.map((job) => Boolean((job as { needsRetranslation?: boolean }).needsRetranslation))).toEqual([true, false, false]);
  });

  it('keeps the fetch result unchanged and survives an unreadable slice', async () => {
    const jobs = Object.assign([{ url, sourceLang: 'it' }], { discoveredCount: 3 });
    const wrapped = withSourceLangRelabelFlags(async () => jobs, 'faulhaber', {
      readExisting: () => { throw new Error('slice unreadable'); },
    });

    const result = await wrapped();

    expect(result).toBe(jobs);
    expect((result as typeof jobs).discoveredCount).toBe(3);
    expect((result[0] as { needsRetranslation?: boolean }).needsRetranslation).toBeUndefined();
  });

  it('reads the stored slice of the crawler it wraps', async () => {
    const readExisting = vi.fn(() => [{ url, sourceLang: 'en' }]);
    const wrapped = withSourceLangRelabelFlags(async () => ({ jobs: [{ url, sourceLang: 'it' }] }), 'faulhaber', { readExisting });

    const result = (await wrapped()) as { jobs: Array<{ needsRetranslation?: boolean }> };

    expect(readExisting).toHaveBeenCalledWith('faulhaber');
    expect(result.jobs[0].needsRetranslation).toBe(true);
  });
});

describe('class guard — no title-only language detection left in the swept crawlers', () => {
  const root = path.resolve(__dirname, '..');
  const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
  const TITLE_ONLY = /sourceLang\s*[:=]\s*detectLang\(\s*(?:title|listing\.title|parsed\.title|detail\.title|raw\.title)\s*[,)]/;

  it.each([
    'scripts/lib/faulhaber-job-parser.mjs',
    'scripts/lib/engadin-tourismus-job-parser.mjs',
    'scripts/lib/air-zermatt-job-parser.mjs',
    'scripts/lib/bucher-suter-job-parser.mjs',
    'scripts/lib/moncucco-job-parser.mjs',
    'scripts/lib/zermatt-bergbahnen-job-parser.mjs',
    'scripts/update-pemsa-jobs.mjs',
  ])('%s derives the language from the body', (file) => {
    expect(read(file)).not.toMatch(TITLE_ONLY);
  });

  it('bucher-suter maps the body language, not the title language', () => {
    expect(read('scripts/lib/bucher-suter-job-parser.mjs')).toMatch(/detectLang\(description\) === 'de' \? 'de' : 'en'/);
  });

  it.each([
    ['scripts/update-helsinn-jobs.mjs', /\$\{listing\.title\} position at Helsinn/],
    ['scripts/update-interroll-jobs.mjs', /\$\{raw\.title\} position at Interroll/],
    ['scripts/update-zambon-jobs.mjs', /opportunità professionale presso \$\{COMPANY_NAME\}|posizione presso \$\{COMPANY_NAME\}/],
  ])('%s reads the detail page and no longer writes an invented description', (file, invented) => {
    const source = read(file);
    expect(source).not.toMatch(invented);
    expect(source).toMatch(/detectLang\(description(?: \|\| title)?, '(?:it|en)'\)/);
    expect(source).toMatch(/if \(isInvokedDirectly\(import\.meta\.url\)\)/);
  });

  it.each([
    'scripts/update-faulhaber-jobs.mjs',
    'scripts/update-engadin-tourismus-jobs.mjs',
    'scripts/update-air-zermatt-jobs.mjs',
    'scripts/update-bucher-suter-jobs.mjs',
    'scripts/update-moncucco-jobs.mjs',
    'scripts/update-zermatt-bergbahnen-jobs.mjs',
  ])('%s flags re-derived source languages for retranslation', (file) => {
    expect(read(file)).toMatch(/fetchJobs: withSourceLangRelabelFlags\(/);
  });
});
