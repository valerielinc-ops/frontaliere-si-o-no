import { describe, expect, it } from 'vitest';
import {
  extractLeTeamDetailFields,
  isLeTeamJob,
  isTrustedDomain,
  LE_TEAM_KEY,
} from '../scripts/lib/le-team-job-parser.mjs';
import { loadSpec, templateToRegex } from '../scripts/lib/prospector/spec-crawler.mjs';

describe('le team sa source-backed crawler', () => {
  const detailUrl = 'https://team.jobs/fr/offres-demplois/-/macon-b-h-f-d/Hagz1kmEzkUfZnEz9JwcJO';
  const description = '- Tu feras des travaux de maçonnerie traditionnelle (briques, blocs, coffrage, béton). - Tu participeras aux fondations, dalles,';
  const detailHtml = `<html lang="fr"><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: 'Maçon B  H/F/D',
    description,
    datePosted: '2026-07-02T14:02:48.467',
    jobLocation: { '@type': 'Place', address: {
      '@type': 'PostalAddress', addressLocality: 'Porrentruy',
    } },
  })}</script></head><body><h1>Maçon B H/F/D</h1></body></html>`;

  it('reads title, detailed description and JU workplace from the official JobPosting', () => {
    const detail = extractLeTeamDetailFields(detailHtml, detailUrl);
    expect(detail.title).toBe('Maçon B  H/F/D');
    expect(detail.description).toContain('maçonnerie traditionnelle');
    expect(detail.location).toBe('Porrentruy');
    expect(detail.canton).toBe('JU');
    expect(detail.locationCandidates).toContainEqual(expect.objectContaining({
      addressLocality: 'Porrentruy',
    }));
  });

  it('uses the official category listing plus the currently applyable official detail URL', () => {
    const spec = loadSpec(LE_TEAM_KEY);
    expect(spec.candidateKey).toBe('le-team@delemont');
    expect(spec.seedUrls).toContain('https://team.jobs/fr/jobs?professionCategoryIds=5');
    expect(spec.seedUrls).toContain(detailUrl);
    expect(spec.listingCandidateText).toBe('maçon');
    expect(spec.sampleVacancyCount).toBe(3);
    expect(templateToRegex(spec.detailTemplate).test(new URL(detailUrl).pathname)).toBe(true);
  });

  it('matches only the le-team source and rejects marketplace domains', () => {
    expect(isLeTeamJob({ companyKey: LE_TEAM_KEY })).toBe(true);
    expect(isLeTeamJob({ url: detailUrl })).toBe(true);
    expect(isTrustedDomain(detailUrl)).toBe(true);
    expect(isTrustedDomain('https://www.jobup.ch/fr/')).toBe(false);
    expect(isLeTeamJob({ companyKey: 'other', url: 'https://example.org/jobs' })).toBe(false);
  });
});
