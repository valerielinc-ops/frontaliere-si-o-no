/**
 * Decathlon — the source language comes from the ad body, not from the title
 * (audit-parser-quality issue 5253, sibling of kronenhof / mks-pamp / hes-so).
 *
 * The slice of 2026-09-29 had 5/54 French ads filed under a foreign source
 * slot because `detectLang(title)` read "CANDIDATURE SPONTANEE - STAGE SPORT
 * LEADER" as English and "Mécanicien⸱ne … - BIENNE" as Italian. The fixture
 * below is that listing row and a minimized copy of its detail JSON-LD.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchJson = vi.fn();
const fetchHtml = vi.fn();

vi.mock('../scripts/lib/crawler-template.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scripts/lib/crawler-template.mjs')>();
  return { ...actual, fetchJson, fetchHtml };
});

const { fetchAllDecathlonJobs } = await import('../scripts/lib/decathlon-job-parser.mjs');

const FRENCH_BODY = [
  '<p>Vous respirez le sport au quotidien et souhaitez transformer cette passion en expérience professionnelle ?</p>',
  '<p>Rejoins nos équipes en magasin : tu accueilles et conseilles nos clients sportifs, tu fais vivre ton rayon',
  'et tu participes à la réussite commerciale de ton magasin avec une équipe passionnée et engagée.</p>',
  '<ul><li>Tu es passionné·e par au moins un sport</li><li>Tu aimes le contact avec les clients</li></ul>',
].join('');

function detailHtml(description: string) {
  const ld = { '@context': 'https://schema.org', '@type': 'JobPosting', title: 'x', description };
  return `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body></body></html>`;
}

describe('Decathlon source language', () => {
  beforeEach(() => {
    fetchJson.mockReset();
    fetchHtml.mockReset();
  });

  it('files a French body under fr even when the title reads as English', async () => {
    fetchJson.mockResolvedValueOnce({
      count: 1,
      items: [{
        title: 'CANDIDATURE SPONTANEE - STAGE SPORT LEADER',
        url: 'candidature-spontanee-stage-sport-leader-1',
        location: 'Bussigny',
      }],
    });
    fetchHtml.mockResolvedValueOnce(detailHtml(FRENCH_BODY));

    const [job] = await fetchAllDecathlonJobs();

    expect(job.sourceLang).toBe('fr');
    expect(Object.keys(job.descriptionByLocale)).toEqual(['fr']);
    expect(job.descriptionByLocale.fr).toContain('Vous respirez le sport au quotidien');
    expect(Object.keys(job.titleByLocale)).toEqual(['fr']);
  });
});
