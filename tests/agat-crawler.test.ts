import { describe, expect, it } from 'vitest';
import {
  extractAgatDetailFields,
  extractAgatListingRows,
  isAgatJob,
  isTrustedDomain,
  AGAT_KEY,
} from '../scripts/lib/agat-job-parser.mjs';
import { loadSpec, templateToRegex } from '../scripts/lib/prospector/spec-crawler.mjs';

describe('AGAT! source-backed crawler', () => {
  const detailUrl = 'https://www.agat-job.com/post/ma%C3%A7on-q-a-b-100';
  const sourceSentence = 'Pour le compte de l’un de nos clients situé dans la région de Sion, nous recherchons un maçon expérimenté.';
  const detailHtml = `<html lang="fr"><head><title>Maçon Q/A/B 100%</title></head><body>
    <main><article class="tgMH9T"><div class="HW6ttf"><p>${sourceSentence}</p></div></article></main>
  </body></html>`;

  it('extracts the official post title, vacancy text and explicitly named Valais region', () => {
    const detail = extractAgatDetailFields(detailHtml, detailUrl);
    expect(detail.title).toBe('Maçon Q/A/B 100%');
    expect(detail.description).toContain(sourceSentence);
    expect(detail.location).toBe('région de Sion');
    expect(detail.canton).toBe('VS');
  });

  it('prefers the vacancy heading over the Wix document title', () => {
    const detail = extractAgatDetailFields(
      `<html lang="fr"><head><title>AGAT | Jobs</title></head><body>
        <main><article><h2>Maçon B H/F/D</h2>
          <p>Poste située dans la région de Sion.</p>
        </article></main>
      </body></html>`,
      detailUrl,
    );
    expect(detail.title).toBe('Maçon B H/F/D');
  });

  it('fails closed when the official detail body contains no source-backed workplace', () => {
    const detail = extractAgatDetailFields(
      '<html><head><title>Installateur Électricien CFC</title></head><body><main><article><p>Offer details.</p></article></main></body></html>',
      'https://www.agat-job.com/post/installateur-electricien',
    );
    expect(detail.title).toBe('Installateur Électricien CFC');
    expect(detail.location).toBe('');
    expect(detail.locationCandidates).toEqual([]);
  });

  it('gets job titles from official post-card headings rather than CTAs', () => {
    const rows = extractAgatListingRows(
      '<main><a href="/post/maçon-q-a-b-100"><h2>Maçon Q/A/B 100%</h2></a><a href="/post/no-title">En savoir plus</a></main>',
      'https://www.agat-job.com/blog',
    );
    expect(rows).toEqual([{
      title: 'Maçon Q/A/B 100%',
      url: 'https://www.agat-job.com/post/ma%C3%A7on-q-a-b-100',
    }]);
    expect(templateToRegex(loadSpec(AGAT_KEY).detailTemplate).test(new URL(rows[0].url).pathname)).toBe(true);
  });

  it('does not claim an AGAT driver posting absent from the observed official vacancy set', () => {
    const spec = loadSpec(AGAT_KEY);
    expect(spec.sampleTitles.some((title: string) => /chauffeur|chauffeuse|poids[- ]lourd|camion/i.test(title))).toBe(false);
    expect(isAgatJob({ companyKey: AGAT_KEY })).toBe(true);
    expect(isTrustedDomain(detailUrl)).toBe(true);
    expect(isTrustedDomain('https://www.jobup.ch/fr/')).toBe(false);
  });
});
