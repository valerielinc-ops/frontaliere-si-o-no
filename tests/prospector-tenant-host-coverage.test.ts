/**
 * A tenant we already crawl must not be promoted a second time (issue 5253).
 *
 * `recruitingapp-2998@umantis.com` was traced on 2026-08-22 — before the
 * exact-host coverage index of #6484 existed — and promoted in September as
 * `im-bethesda-spital`, while `bethesda-spital` had been reading the same
 * Umantis tenant since May. Coverage was asked only once, at discovery, and
 * every later stage compared vacancy URLs: the spec read the hospital's own
 * jobs page, whose JSON-LD postings carry no `url`, so each vacancy became
 * `jobs.html#job-<hash>` while the Umantis vacancy id sat in
 * `identifier.value` only. Nothing could match.
 *
 * Slices are written to a temporary `data/jobs/by-crawler` tree, so the
 * assertions do not depend on the live corpus.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCoverage, tenantHostOwner } from '../scripts/lib/prospector/coverage.mjs';
import { evaluatePromotion } from '../scripts/lib/prospector/promotion-gate.mjs';
import { extractJsonLd } from '../scripts/lib/prospector/extract.mjs';
import { loadSourceHostOwnership, matchExistingCrawler } from '../scripts/lib/crawler-source-hosts.mjs';

const UMANTIS = 'https://recruitingapp-2998.umantis.com';
const PUBLIC_PAGE = 'https://www.bethesda-spital.ch/de/ueber-uns/karriere/jobs.html';

// Two JobPosting nodes as the public page serves them (descriptions trimmed):
// no `url`, the Umantis vacancy id only in `identifier.value`.
const PUBLIC_PAGE_HTML = ['323', '328'].map((id, i) => `<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title: i === 0
    ? 'Technische*r Sterilisationsassistent*in AEMP im Wunschpensum 80- 100%'
    : 'Assistenzärztin/Assistenzarzt Klinik Rheumatologie und Schmerzmedizin 100%',
  description: 'Für unsere Abteilung suchen wir per sofort oder nach Vereinbarung eine Fachperson.',
  datePosted: '2026-08-28',
  identifier: { '@type': 'PropertyValue', name: 'Bethesda Spital', value: id },
  hiringOrganization: { '@type': 'Organization', name: 'Bethesda Spital', url: 'https://www.bethesda-spital.ch/de.html' },
  jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', postalCode: '4052', addressLocality: 'Basel', addressCountry: 'CH' } },
})}</script>`).join('\n');

/** The candidate record as it stood in data/prospector/candidates.json. */
const bethesdaCandidate = (over: Record<string, unknown> = {}) => ({
  key: 'recruitingapp-2998@umantis.com',
  status: 'promoted',
  sources: ['tenant:umantis.com'],
  firstSeenAt: '2026-08-22T04:28:47.145Z',
  name: '& im Bethesda Spital',
  tenantHost: 'recruitingapp-2998.umantis.com',
  platform: 'umantis.com',
  careersUrl: PUBLIC_PAGE,
  crawlerKey: 'im-bethesda-spital',
  mode: 'jsonld',
  vacancyCount: 13,
  validationHistory: [15, 17].map((day) => ({
    at: `2026-09-${day}T10:00:00Z`,
    verdict: 'good',
    score: 1,
    sampled: 4,
    reachableRate: 1,
    titleMatchRate: 1,
    contentfulRate: 1,
    locationSourceRate: 1,
    distinctRate: 1,
    jobLikeRate: 1,
    logoFound: true,
    vacancyCount: 13,
  })),
  ...over,
});

let root: string;

function slice(key: string, urls: string[]) {
  fs.writeFileSync(
    path.join(root, 'data', 'jobs', 'by-crawler', `${key}.json`),
    JSON.stringify({ crawlerKey: key, jobs: urls.map((url) => ({ companyKey: key, title: 'Ruolo', url })) }),
  );
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-host-coverage-'));
  fs.mkdirSync(path.join(root, 'data', 'jobs', 'by-crawler'), { recursive: true });
  // The dedicated crawler, reading the tenant since May.
  slice('bethesda-spital', [323, 367, 377, 390].map((id) => `${UMANTIS}/Vacancies/${id}/Description/1`));
  // An employer lobby that today only one of our crawlers happens to read.
  slice('buersten-technik', ['https://www.yousty.ch/de-CH/lehrstellen/firmen/123-buersten-technik']);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('tenant host coverage after discovery', () => {
  it('reproduces why the URL comparison could not see the duplicate', () => {
    const vacancies = extractJsonLd(PUBLIC_PAGE_HTML, PUBLIC_PAGE);
    expect(vacancies).toHaveLength(2);
    for (const v of vacancies) expect(v.url).toMatch(/jobs\.html#job-[0-9a-f]{12}$/);
    const ownership = loadSourceHostOwnership(root, { urls: true });
    expect(matchExistingCrawler(vacancies.map((v) => v.url), ownership, { exclude: 'im-bethesda-spital' })).toBeNull();
  });

  it('names the crawler already reading the tenant', () => {
    const { hostOwners } = loadCoverage(root);
    expect(tenantHostOwner(bethesdaCandidate(), hostOwners)).toBe('bethesda-spital');
    // Its own crawler reading its own tenant is not a duplicate.
    expect(tenantHostOwner(bethesdaCandidate({ crawlerKey: 'bethesda-spital' }), hostOwners)).toBeNull();
    // Another tenant of the same vendor is someone else.
    expect(tenantHostOwner(bethesdaCandidate({ tenantHost: 'recruitingapp-2979.umantis.com' }), hostOwners)).toBeNull();
  });

  it('never claims a candidate standing in a multi-employer lobby', () => {
    // `yousty.ch` is the platform itself, not a tenant subdomain of it: one of
    // our crawlers reading it says nothing about who this employer is.
    const { hostOwners } = loadCoverage(root);
    const lobby = bethesdaCandidate({ tenantHost: 'yousty.ch', platform: 'yousty.ch', crawlerKey: 'kursaal-bern' });
    expect(tenantHostOwner(lobby, hostOwners)).toBeNull();
  });

  it('blocks the promotion the gate used to allow', () => {
    const coverage = loadCoverage(root);
    const candidate = bethesdaCandidate();
    // The context the gate received before: every other check passes.
    expect(evaluatePromotion(candidate, { existingKeys: coverage.keys }).passed).toBe(true);

    const res = evaluatePromotion(candidate, { existingKeys: coverage.keys, hostOwners: coverage.hostOwners });
    expect(res.passed).toBe(false);
    expect(res.checks.tenantFree).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/recruitingapp-2998\.umantis\.com e' gia' letto dal crawler bethesda-spital/);
  });
});
