import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyFusalpCountry, fetchAllFusalpJobs, parseListingPage } from '../scripts/lib/fusalp-job-parser.mjs';

// Structure of the live WelcomeKit board; every text value is invented.
const card = (attrs: string, href: string, title: string, contract: string, office: string) => `
<li ${attrs}>
<a class="jobs-list-item-link" href="${href}"><h3 class="jobs-list-item-title">
${title}
</h3>
<ul class="jobs-list-item-details">
<li class="jobs-list-item-contract-type">
<i class="icon-secondary icon-briefcase"></i>
${contract}
</li>
<li class="jobs-list-item-office">
<i class="icon-secondary icon-location"></i>
${office}
</li>
</ul>
</a></li>`;

const LISTING = `<ul class="jobs-list">${[
  card('class="jobs-list-item" data-department="1" data-office="10"', '/jobs/role-a_paris', 'Role A', 'CDD / Temporaire', 'Paris'),
  card('data-office="11" class="jobs-list-item"', '/jobs/role-b_lyon', 'Role B', 'CDI', 'Lyon'),
  card("class='jobs-list-item'", '/jobs/role-c_zermatt', 'Role C', 'CDI', 'Zermatt'),
].join('\n')}</ul>`;

const detail = (country: string) => `<html><head><script type="application/ld+json">${JSON.stringify({
  '@type': 'JobPosting',
  title: 'Role',
  description: '<p>Invented description</p>',
  jobLocation: { address: { addressLocality: 'Somewhere', addressCountry: country } },
})}</script></head><body></body></html>`;

function stubFetch(pages: Record<string, string>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const key = url === 'https://fusalp.welcomekit.co' ? '/' : Object.keys(pages).find((k) => k !== '/' && url.endsWith(k));
    return key === undefined
      ? { ok: false, status: 404, text: async () => '' }
      : { ok: true, status: 200, text: async () => pages[key] };
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('Fusalp listing markup', () => {
  it('parses double quotes, single quotes, extra attributes and any attribute order', () => {
    const jobs = parseListingPage(LISTING);
    expect(jobs.map((j) => j.path)).toEqual(['/jobs/role-a_paris', '/jobs/role-b_lyon', '/jobs/role-c_zermatt']);
    expect(jobs[0]).toMatchObject({ title: 'Role A', contract: 'CDD / Temporaire' });
    expect(jobs[1].contract).toBe('CDI');
  });

  it('returns no cards for a page without a jobs list', () => {
    expect(parseListingPage('<html><body><p>No openings</p></body></html>')).toEqual([]);
  });

  it('reports filtered_empty when every observed card is outside Switzerland', async () => {
    stubFetch({
      '/': LISTING,
      '/jobs/role-a_paris': detail('France'),
      '/jobs/role-b_lyon': detail('France'),
      '/jobs/role-c_zermatt': detail('Germany'),
    });
    const jobs = await fetchAllFusalpJobs();
    expect(jobs).toHaveLength(0);
    expect((jobs as any).discoveredCount).toBe(3);
    expect((jobs as any).fetchOutcome).toBe('filtered_empty');
  }, 15000);

  it('does not claim filtered_empty when a detail page could not be observed', async () => {
    stubFetch({
      '/': LISTING,
      '/jobs/role-a_paris': detail('France'),
      '/jobs/role-b_lyon': detail('France'),
    });
    const jobs = await fetchAllFusalpJobs();
    expect(jobs).toHaveLength(0);
    expect((jobs as any).fetchOutcome).toBeUndefined();
  }, 15000);

  it('keeps Swiss jobs and the discovered count', async () => {
    stubFetch({
      '/': LISTING,
      '/jobs/role-a_paris': detail('France'),
      '/jobs/role-b_lyon': detail('France'),
      '/jobs/role-c_zermatt': detail('Switzerland'),
    });
    const jobs = await fetchAllFusalpJobs();
    expect(jobs).toHaveLength(1);
    expect((jobs as any).discoveredCount).toBe(3);
    expect(jobs[0].country).toBe('CH');
  }, 15000);

  it('counts raw card nodes, including cards that cannot be parsed', () => {
    const html = `<ul>${[
      card('class="jobs-list-item"', '/jobs/role-a_paris', 'Role A', 'CDI', 'Paris'),
      card('class="jobs-list-item"', '', '', 'CDI', 'Zermatt'),
    ].join('')}</ul>`;
    const jobs = parseListingPage(html);
    expect(jobs).toHaveLength(1);
    expect((jobs as any).cardCount).toBe(2);
  });

  it('recognises Swiss spellings and only known foreign countries', () => {
    for (const swiss of ['CH', 'che', 'Switzerland', 'Schweiz', 'Suisse', 'Svizzera', ' SUISSE ', 'Confédération suisse']) {
      expect(classifyFusalpCountry(swiss)).toBe('CH');
    }
    for (const foreign of ['France', 'Germany', 'Allemagne', 'Italia', 'Luxembourg', 'FR', 'DEU']) {
      expect(classifyFusalpCountry(foreign)).toBe('foreign');
    }
    for (const unknown of ['', undefined, null, 'Atlantis', 'Europe']) {
      expect(classifyFusalpCountry(unknown)).toBe('unknown');
    }
  });

  it('does not claim filtered_empty for a recognised foreign card, a Suisse card and an unparsable card', async () => {
    const html = `<ul>${[
      card('class="jobs-list-item"', '/jobs/role-a_paris', 'Role A', 'CDI', 'Paris'),
      card('class="jobs-list-item"', '/jobs/role-c_zermatt', 'Role C', 'CDI', 'Zermatt'),
      card('class="jobs-list-item"', '', '', 'CDI', 'Sion'),
    ].join('')}</ul>`;
    stubFetch({
      '/': html,
      '/jobs/role-a_paris': detail('France'),
      '/jobs/role-c_zermatt': detail('Suisse'),
    });
    const jobs = await fetchAllFusalpJobs();
    expect((jobs as any).fetchOutcome).not.toBe('filtered_empty');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].country).toBe('CH');
  }, 15000);

  it('does not claim filtered_empty when foreign cards are accompanied by an unparsable card', async () => {
    const html = `<ul>${[
      card('class="jobs-list-item"', '/jobs/role-a_paris', 'Role A', 'CDI', 'Paris'),
      card('class="jobs-list-item"', '/jobs/role-b_lyon', 'Role B', 'CDI', 'Lyon'),
      card('class="jobs-list-item"', '', '', 'CDI', 'Sion'),
    ].join('')}</ul>`;
    stubFetch({
      '/': html,
      '/jobs/role-a_paris': detail('France'),
      '/jobs/role-b_lyon': detail('France'),
    });
    const jobs = await fetchAllFusalpJobs();
    expect(jobs).toHaveLength(0);
    expect((jobs as any).fetchOutcome).toBeUndefined();
  }, 15000);

  it('does not claim filtered_empty when a country value is not recognised', async () => {
    stubFetch({
      '/': LISTING,
      '/jobs/role-a_paris': detail('France'),
      '/jobs/role-b_lyon': detail('France'),
      '/jobs/role-c_zermatt': detail('Atlantis'),
    });
    const jobs = await fetchAllFusalpJobs();
    expect(jobs).toHaveLength(0);
    expect((jobs as any).fetchOutcome).toBeUndefined();
  }, 15000);
});
