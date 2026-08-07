import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { employerProfilePagesPlugin } from '../build-plugins/employerProfilePagesPlugin';
import { resolveSearchConsoleCompatTarget } from '../build-plugins/searchConsoleCompat';
import { canonicalCompanyProfileSlug } from '../build-plugins/shared/companyProfileSlug.mjs';
import { TITLE_MAX_CHARS } from '../build-plugins/shared/titleSuffix';
import committedDataset from '../data/employer-profiles.json';

/**
 * Full-pipeline test for the /aziende/<slug>/ employer-profile plugin (#4462).
 * Runs the real closeBundle() against a temp dist and asserts:
 *  - above-floor company → indexable page with COMPLETE JobPosting JSON-LD
 *    (Non-Negotiable #3), the publisher CTA and stat facts,
 *  - below-floor company → noindex,follow bridge at the SAME URL (no 404),
 *  - sitemap lists the indexable IT canonical only,
 *  - all 4 locales emitted with trailing-slash paths.
 */

const MANDATORY_JOBPOSTING_KEYS = [
  'title', 'description', 'datePosted', 'employmentType',
  'hiringOrganization', 'jobLocation', 'baseSalary', 'url',
];

let root: string;

function job(i: number) {
  return {
    slug: `sviluppatore-${i}-acme-corp-lugano`,
    company: 'Acme Corp',
    companyKey: 'acme',
    title: `Sviluppatore ${i}`,
    description:
      'Cerchiamo uno sviluppatore software con esperienza in TypeScript e React per unirsi al team di Lugano e lavorare su prodotti digitali per clienti internazionali.',
    location: 'Lugano',
    canton: 'TI',
    datePosted: '2026-07-10',
    employmentType: 'FULL_TIME',
    contract: 'full-time',
    salaryMin: 80000 + i * 1000,
    salaryMax: 120000 + i * 1000,
    url: `https://acme.example/job/${i}`,
  };
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'emp-profiles-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'dist', 'index.html'),
    '<!doctype html><html><head>' +
      '<script type="module" src="/assets/index-abc123.js"></script>' +
      '<link rel="stylesheet" href="/assets/index-abc123.css">' +
      '</head><body><div id="root"></div></body></html>',
  );
  fs.writeFileSync(
    path.join(root, 'data', 'employer-profiles.json'),
    JSON.stringify({
      _meta: { floor: 5 },
      profiles: [
        {
          slug: 'acme-corp',
          name: 'Acme Corp',
          companyKey: 'acme',
          sector: 'Informatica',
          activeJobs: 6,
          cantons: [{ name: 'TI', count: 6 }],
          cities: [{ name: 'Lugano', count: 6 }],
          salaryMedianChf: 100000,
          salarySamples: 6,
          trend: { added: 4, removed: 1, net: 3, windowDays: 28 },
        },
      ],
      belowFloor: [
        { slug: 'small-co', name: 'Small Co', activeJobs: 3, sector: 'Altro', canton: 'TI' },
        // 54-char legal name: BOTH title candidates overflow TITLE_MAX_CHARS
        // (66), so this exercises composePlaceTitle's truncateHeadline
        // fallback on the bridge — which had no length budget at all before
        // the 2026-08-07 title change.
        {
          slug: 'ente-ospedaliero-cantonale-della-svizzera-italiana-sagl',
          name: 'Ente Ospedaliero Cantonale Della Svizzera Italiana Sagl',
          activeJobs: 2,
          sector: null,
          canton: 'TI',
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(root, 'data', 'jobs.json'),
    JSON.stringify([
      ...Array.from({ length: 6 }, (_, i) => job(i + 1)),
      // Slugless job: must be skipped by BOTH the card renderer and the
      // ItemList JSON-LD (no JobPosting pointing at the bare homepage).
      { ...job(7), slug: '' },
    ]),
  );

  const plugin = employerProfilePagesPlugin(root) as unknown as {
    closeBundle: () => Promise<void>;
  };
  await plugin.closeBundle();
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function read(rel: string): string {
  return fs.readFileSync(path.join(root, 'dist', rel), 'utf-8');
}

describe('employerProfilePagesPlugin', () => {
  it('emits the above-floor profile page in all 4 locales', () => {
    for (const rel of [
      'aziende/acme-corp/index.html',
      'en/aziende/acme-corp/index.html',
      'de/aziende/acme-corp/index.html',
      'fr/aziende/acme-corp/index.html',
    ]) {
      expect(fs.existsSync(path.join(root, 'dist', rel)), rel).toBe(true);
    }
  });

  it('the profile page is indexable and shows the company H1 + facts', () => {
    const html = read('aziende/acme-corp/index.html');
    expect(html).toContain('name=robots content="index, follow');
    expect(html).toContain('max-image-preview:large');
    expect(html).toContain('Offerte di lavoro Acme Corp');
    expect(html).toContain('6'); // active jobs
    expect(html).toContain("CHF 100"); // median salary formatted
  });

  // Search-intent title/H1 (2026-08-07). GSC 90 d on data/evidence-index.json:
  // "offerte di lavoro" 46 341 impr / 7 227 click, while "lavorare in" has ZERO
  // brand-attached queries (all 41 matches are geographic) and "working at" has
  // zero queries at all. These assertions pin the phrase, not the prose — if a
  // future rewrite drops the head phrase from either the <title> or the <h1>,
  // that is the regression this test exists to catch.
  it('leads the <title> with the company and carries the searched phrase', () => {
    for (const [rel, expected] of [
      ['aziende/acme-corp/index.html', 'Acme Corp: offerte di lavoro e stipendi'],
      ['en/aziende/acme-corp/index.html', 'Acme Corp: jobs and salaries'],
      ['de/aziende/acme-corp/index.html', 'Acme Corp: offene Stellen und Gehalt'],
      ['fr/aziende/acme-corp/index.html', 'Acme Corp: offres d’emploi et salaires'],
    ] as const) {
      const title = read(rel).match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '';
      expect(title, rel).toContain(expected);
      // Brand-first: the SERP line is scanned left-to-right and Google bolds
      // the matched brand, so the company name owns character 0.
      expect(title.startsWith('Acme Corp'), `${rel} brand-first: ${title}`).toBe(true);
      // The retired editorial phrasings must not creep back in.
      expect(title).not.toMatch(/Lavorare in|Working at|Arbeiten bei|Travailler chez/);
    }
  });

  it('leads the <h1> with the phrase, and never repeats the <title> verbatim', () => {
    // The asymmetry (title = "{name}: {phrase}…", h1 = "{phrase} {name}") is
    // what guarantees title !== h1 BY CONSTRUCTION — it replaces the old
    // TITLE_SUFFIX_SHORT trick added after audit:h1-title-duplicates flagged
    // 157 offenders on validate-dist run 29794187475.
    for (const [rel, h1Text] of [
      ['aziende/acme-corp/index.html', 'Offerte di lavoro Acme Corp'],
      ['en/aziende/acme-corp/index.html', 'Jobs at Acme Corp'],
      ['de/aziende/acme-corp/index.html', 'Offene Stellen bei Acme Corp'],
      ['fr/aziende/acme-corp/index.html', 'Offres d’emploi chez Acme Corp'],
    ] as const) {
      const html = read(rel);
      const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '';
      const title = html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '';
      expect(h1, rel).toBe(h1Text);
      expect(title, `${rel} title must differ from h1`).not.toBe(h1);
    }
  });

  it('keeps BreadcrumbList + ItemList naming in step with the visible H1', () => {
    // Structured data must not advertise a heading the page does not show.
    const html = read('aziende/acme-corp/index.html');
    const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map((m) => JSON.parse(m[1]));
    const crumb = scripts.find((s) => s['@type'] === 'BreadcrumbList');
    expect(crumb.itemListElement[1].name).toBe('Offerte di lavoro Acme Corp');
    const itemList = scripts.find((s) => s['@type'] === 'ItemList');
    expect(itemList.name).toBe('Offerte di lavoro Acme Corp');
  });

  // text-html-ratio follow-up (validate-dist run 29794187475, PR #4611
  // follow-up): real per-company facts computed from the FULL active-job
  // set (not just the ≤8 cards shown), genuinely new visible text.
  it('adds a real contract-mix and salary-range sentence from the full active-job set', () => {
    const html = read('aziende/acme-corp/index.html');
    // All 7 seeded jobs are 'full-time' → unanimous contract-mix sentence.
    expect(html).toContain('Tutte le posizioni attive sono a tempo pieno.');
    // salaryMin/salaryMax vary 81'000..127'000 across the 7 jobs — a real
    // range distinct from the single CHF 100'000 median stat tile.
    expect(html).toContain('CHF 81');
    expect(html).toContain('CHF 127');
  });

  it('embeds COMPLETE JobPosting structured data (Non-Negotiable #3)', () => {
    const html = read('aziende/acme-corp/index.html');
    const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map((m) => JSON.parse(m[1]));
    const itemList = scripts.find((s) => s['@type'] === 'ItemList');
    expect(itemList, 'ItemList JSON-LD present').toBeTruthy();
    expect(itemList.itemListElement.length).toBeGreaterThan(0);
    const posting = itemList.itemListElement[0].item;
    for (const key of MANDATORY_JOBPOSTING_KEYS) {
      expect(posting[key], `JobPosting.${key}`).toBeTruthy();
    }
    expect(posting.jobLocation.address.postalCode).toBeTruthy();
    expect(posting.jobLocation.address.streetAddress).toBeTruthy();
    expect(posting.hiringOrganization.name).toBe('Acme Corp');
    expect(posting.baseSalary.value.minValue).toBeGreaterThan(0);
    // Slugless job guard: no ListItem may point at the bare homepage, and
    // positions stay contiguous 1..N after the skip (reviewer 🔴, PR #4511).
    const urls = itemList.itemListElement.map((el: { item: { url: string } }) => el.item.url);
    expect(urls).not.toContain('https://frontaliereticino.ch');
    expect(urls).not.toContain('https://frontaliereticino.ch/');
    const positions = itemList.itemListElement.map((el: { position: number }) => el.position);
    expect(positions).toEqual(Array.from({ length: positions.length }, (_, i) => i + 1));
  });

  // CompanyAlert (#5012 phase 2). The issue names this surface FIRST — "ogni
  // pagina azienda deve avere un pulsante/CTA: Segui questa azienda" — and it is
  // the top of the funnel: /aziende/<slug>/ is indexed and takes organic
  // "lavorare in X" traffic from visitors who are NOT looking at one specific
  // ad. These pages are staticOverlay, so the CTA is a hydration island; these
  // tests pin the emitted contract the island reads.
  it('emits the "Segui questa azienda" hydration placeholder on the profile page', () => {
    const html = read('aziende/acme-corp/index.html');
    expect(html).toContain('data-company-follow-mount');
    expect(html).toMatch(/data-surface=["']?employer_profile["']?/);
  });

  it('passes name + companyKey, NOT the pre-computed slug', () => {
    // companyAlertKey(company, companyKey) IS canonicalCompanyProfileSlug — the
    // same function that builds this page's URL. Handing the button the two raw
    // inputs makes it re-derive the token through the ONE shared normalisation,
    // so the URL and the persisted alert key cannot disagree. Emitting the slug
    // would be a second way to produce that token (#5151's whole review).
    const html = read('aziende/acme-corp/index.html');
    expect(html).toMatch(/data-company=["']?Acme Corp["']?/);
    expect(html).toMatch(/data-company-key=["']?acme["']?/);
  });

  it('emits the placeholder on the below-floor bridge too', () => {
    // The bridge is noindex but reachable, and a company just under the floor is
    // exactly one worth following: the next ad it posts is the reason to return.
    const html = read('aziende/small-co/index.html');
    expect(html).toContain('data-company-follow-mount');
    expect(html).toMatch(/data-surface=["']?employer_below_floor["']?/);
  });

  it('localises the placeholder skeleton label and carries the page locale', () => {
    // data-locale is what the mounted alert is created in — a German reader must
    // not end up with an Italian-locale alert. The skeleton label mirrors the
    // hydrated button so hydration swaps no visible text.
    for (const [rel, label] of [
      ['aziende/acme-corp/index.html', 'Segui questa azienda'],
      ['en/aziende/acme-corp/index.html', 'Follow this company'],
      ['de/aziende/acme-corp/index.html', 'Diesem Unternehmen folgen'],
      ['fr/aziende/acme-corp/index.html', 'Suivre cette entreprise'],
    ] as const) {
      const html = read(rel);
      expect(html, rel).toContain(label);
      expect(html, rel).toMatch(/data-locale=["']?(it|en|de|fr)["']?/);
    }
  });

  it('renders the benefit-first publisher CTA (reused shared block)', () => {
    const html = read('aziende/acme-corp/index.html');
    expect(html).toMatch(/data-employer-cta=["']?employer_profile["']?/);
    expect(html).not.toMatch(/prima paghi|pay first|paga prima/i);
  });

  it('emits a noindex,follow bridge (not a 404) for the below-floor company', () => {
    const html = read('aziende/small-co/index.html');
    expect(html).toContain('name=robots content=noindex,follow');
    expect(html).toContain('Small Co');
    // The bridge shares the full page's brand-first title shape, and its <h1>
    // is the bare company name, so the two can never collide.
    const title = html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '';
    expect(title).toContain('Small Co: offerte di lavoro');
    expect(title).not.toContain('Lavorare in');
  });

  it('holds the title budget on a name too long for either candidate', () => {
    // Both candidates overflow at 54 chars of legal name, so composePlaceTitle
    // falls through to truncateHeadline — the recovery path that did not exist
    // on this emit site before 2026-08-07 (audit:title-length, #4593).
    const html = read('aziende/ente-ospedaliero-cantonale-della-svizzera-italiana-sagl/index.html');
    const title = html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '';
    expect(title.length, `overflow title: ${title}`).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(title.startsWith('Ente Ospedaliero Cantonale')).toBe(true);
    // Brand suffix must be dropped rather than pushing past the cap.
    expect(title).not.toContain('| Frontaliere Ticino');
  });

  it('writes a sitemap listing the indexable IT canonical only', () => {
    const xml = read('sitemap-employer-profiles.xml');
    expect(xml).toContain('https://frontaliereticino.ch/aziende/acme-corp/');
    expect(xml).not.toContain('/aziende/small-co/'); // bridge is noindex → excluded
  });

  it('folds declared brand aliases into the canonical slug (no SERP cannibalization)', () => {
    // migros-ticino / gruppo-migros → migros (brandCanonicalMap), so the
    // evergreen surface never emits a second indexable page competing with the
    // jobsSeoPagesPlugin `azienda-migros` canonical hub (reviewer 🔴, PR #4511).
    expect(canonicalCompanyProfileSlug('Migros Ticino', 'migros-ticino')).toBe('migros');
    expect(canonicalCompanyProfileSlug('Gruppo Migros')).toBe('migros');
    expect(canonicalCompanyProfileSlug('Guess Ticino', 'guess-ticino')).toBe('guess-europe-sagl');
    // Unmanaged company → passes through unchanged.
    expect(canonicalCompanyProfileSlug('Acme Corp', 'acme')).toBe('acme-corp');
    // Lidl special-case still wins.
    expect(canonicalCompanyProfileSlug('Lidl Schweiz', 'lidl-schweiz')).toBe('lidl');
  });

  it('search-console compat self-maps every emitted /aziende/ slug', () => {
    // Use a real slug from the committed dataset (drift-robust: no hardcoded
    // company that a refresh could drop below floor).
    const slug = (committedDataset as { profiles: Array<{ slug: string }> }).profiles[0].slug;
    const known = resolveSearchConsoleCompatTarget(`/aziende/${slug}/`);
    expect(known).toEqual({ canonicalPath: `/aziende/${slug}/`, kind: 'legacy', locale: 'it' });
    // an unknown company slug must NOT be claimed live
    const unknown = resolveSearchConsoleCompatTarget('/aziende/definitely-not-a-real-company-xyz/');
    expect(unknown?.canonicalPath).not.toBe('/aziende/definitely-not-a-real-company-xyz/');
  });
});
