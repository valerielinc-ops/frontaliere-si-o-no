import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { employerProfilePagesPlugin } from '../build-plugins/employerProfilePagesPlugin';
import { resolveSearchConsoleCompatTarget } from '../build-plugins/searchConsoleCompat';
import { canonicalCompanyProfileSlug } from '../build-plugins/shared/companyProfileSlug.mjs';
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
    expect(html).toContain('name=robots content=index,follow');
    expect(html).toContain('Lavorare in Acme Corp');
    expect(html).toContain('6'); // active jobs
    expect(html).toContain("CHF 100"); // median salary formatted
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

  it('renders the benefit-first publisher CTA (reused shared block)', () => {
    const html = read('aziende/acme-corp/index.html');
    expect(html).toMatch(/data-employer-cta=["']?employer_profile["']?/);
    expect(html).not.toMatch(/prima paghi|pay first|paga prima/i);
  });

  it('emits a noindex,follow bridge (not a 404) for the below-floor company', () => {
    const html = read('aziende/small-co/index.html');
    expect(html).toContain('name=robots content=noindex,follow');
    expect(html).toContain('Small Co');
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
