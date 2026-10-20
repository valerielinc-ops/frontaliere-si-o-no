import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  fetchAllPromanFleurierJobs,
  extractPromanFleurierDetailFields,
  extractPromanFleurierListingCandidates,
  isPromanFleurierExpectedDetailFilter,
  isPromanFleurierJob,
  isTrustedDomain,
  PROMAN_FLEURIER_CAREER_URL,
  PROMAN_FLEURIER_KEY,
} from '../scripts/lib/proman-fleurier-job-parser.mjs';
import { loadSpec, templateToRegex } from '../scripts/lib/prospector/spec-crawler.mjs';

const detailUrl = 'https://www.proman-group.ch/job/25097/Automaticien-HF/';
const postedDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
const swissPostedDate = [
  postedDate.getUTCDate(),
  postedDate.getUTCMonth() + 1,
  postedDate.getUTCFullYear(),
].map((part) => String(part).padStart(2, '0')).join('.');
const detailFixture = readFileSync(
  new URL('./fixtures/proman-fleurier-detail.html', import.meta.url),
  'utf8',
).replace('{{POSTED_DATE}}', swissPostedDate);
const canonicalSeed = 'https://www.proman-group.ch/Job/SearchJobs?brancheId=0&regionId=0&typeId=0';
const currentRenderedFixture = `
  <section class="u-section-job-details-header"><div><h1>Automaticien de production</h1></div></section>
  <section class="u-section-job-details-content"><div class="u-job-details">
    <article class="u-job-item">
      <h2>Automaticien de production</h2>
      <ul class="u-job-infos">
        <li><u-svg source="24/job/location"></u-svg><span class="sr-only">lieu</span> Canton de Neuchâtel </li>
        <li><u-svg source="24/job/type"></u-svg><span class="sr-only">Type de poste</span> Poste fixe </li>
      </ul>
      <p class="u-intro"></p>
      <ul class="u-specs">
        <p>Votre profil</p><div><ul><li>Formation technique achevée</li><li>Expérience confirmée dans l'automation industrielle.</li></ul></div>
        <p>Vos tâches</p><div>Réaliser le montage, le câblage et la mise en service des équipements.</div>
      </ul>
    </article>
  </div></section>
`;

function response(url: string, body: string) {
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: () => null },
    body: { cancel: () => {} },
    text: async () => body,
  } as any;
}

describe('PROMAN Fleurier source-backed crawler', () => {
  it('extracts the official JobPosting location and keeps a substantial description', () => {
    const detail = extractPromanFleurierDetailFields(detailFixture, detailUrl);
    expect(detail.title).toBe('Automaticien de production');
    expect(detail.location).toBe('La Chaux-de-Fonds');
    expect(detail.canton).toBe('NE');
    expect(detail.addressLocality).toBe('La Chaux-de-Fonds');
    expect(detail.description.split(/\s+/u).length).toBeGreaterThan(50);
  });

  it('extracts the current rendered detail fields when structured vacancy data is absent', () => {
    const detail = extractPromanFleurierDetailFields(currentRenderedFixture, detailUrl);
    expect(detail.title).toBe('Automaticien de production');
    expect(detail.location).toBe('Canton de Neuchâtel');
    expect(detail.canton).toBe('NE');
    expect(detail.addressLocality).toBe('');
    expect(detail.description).toContain('montage');
    expect(detail.description).toContain('Expérience confirmée');
    expect(detail.description).not.toContain('Personne de contact');
  });

  it('accepts only an exact class token from a real class attribute', () => {
    const html = `
      <section class="u-section-job-details-header"><h1>Role</h1></section>
      <ul class="u-job-infos"><li><u-svg source="24/job/location"></u-svg> Fleurier</li></ul>
      <div data-class="u-specs">wrong-data</div>
      <div class="u-specs-extra">wrong-prefix</div>
      <div class="u-specs">real description</div>
    `;
    const detail = extractPromanFleurierDetailFields(html, detailUrl);
    expect(detail.description).toContain('real description');
    expect(detail.description).not.toContain('wrong');
  });

  it('keeps a long rendered posting detail and retains the crawled vacancy', async () => {
    const longDescription = 'Description complète du poste avec responsabilités et compétences. '.repeat(400);
    const longDetailFixture = `
      <section class="u-section-job-details-header"><h1>Automaticien de production</h1></section>
      <ul class="u-job-infos"><li><u-svg source="24/job/location"></u-svg><span>lieu</span>Fleurier</li></ul>
      <ul class="u-specs"><div>${longDescription}</div></ul>
    `;
    const fetchImpl = async (url: string) => {
      if (url.endsWith('/robots.txt')) return response(url, 'User-agent: *\nAllow: /');
      if (url === canonicalSeed) {
        return response(url, `<li class="u-job-item"><a class="u-link-fit" href="${new URL(detailUrl).pathname.replace(/\/$/, '')}" aria-hidden="true"></a><div><h3>Automaticien de production</h3><ul class="u-job-infos"><li><u-svg source="24/job/location"></u-svg><span>lieu</span>Fleurier</li></ul></div></li>`);
      }
      if (url === detailUrl.replace(/\/$/, '')) return response(url, longDetailFixture);
      throw new Error(`unexpected URL ${url}`);
    };
    const jobs = await fetchAllPromanFleurierJobs({
      fetchImpl,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      hostDelayMs: 0,
      retries: 0,
    });

    expect(extractPromanFleurierDetailFields(longDetailFixture, detailUrl).description.length).toBeGreaterThan(20_000);
    expect(jobs).toEqual([expect.objectContaining({
      url: detailUrl.replace(/\/$/, ''),
      canton: 'NE',
      description: expect.stringContaining('responsabilités et compétences'),
    })]);
  });

  it('rejects an incomplete rendered container instead of publishing its tail', () => {
    const incompleteFixture = `
      <section class="u-section-job-details-header"><h1>Automaticien de production</h1></section>
      <ul class="u-job-infos"><li><u-svg source="24/job/location"></u-svg> Fleurier</li></ul>
      <ul class="u-specs"><p>Vos tâches</p><div>source body before footer-leak`;
    const detail = extractPromanFleurierDetailFields(incompleteFixture, detailUrl);
    expect(detail.description).not.toContain('footer-leak');
  });

  it('uses only reviewed Proman aliases when the detail omits a recognized municipality', () => {
    const neuchatelAlias = extractPromanFleurierDetailFields(
      currentRenderedFixture.replace('Canton de Neuchâtel', 'Couvet'),
      detailUrl,
    );
    expect(neuchatelAlias.location).toBe('Couvet');
    expect(neuchatelAlias.canton).toBe('NE');
    expect(neuchatelAlias.addressLocality).toBe('Val-de-Travers');

    const foreignAlias = extractPromanFleurierDetailFields(
      currentRenderedFixture.replace('Canton de Neuchâtel', 'St-Léonard'),
      detailUrl,
    );
    expect(foreignAlias.location).toBe('');
    expect(foreignAlias.sourceBackedCanton).toBe('VS');
    expect(isPromanFleurierExpectedDetailFilter({ reason: 'geography', detail: foreignAlias })).toBe(true);
  });

  it('pairs an empty overlay link with the visible heading in the same listing card', () => {
    const rows = extractPromanFleurierListingCandidates(`
      <ul class="u-job-list">
        <li class="u-job-item">
          <a class="u-link-fit" href="/job/25097/Automaticien-HF" data-id="25097" aria-hidden="true"></a>
          <div class="u-tile">
            <h3 class="t-lg-bold">Automaticien de production &#233;lectrique</h3>
            <ul class="u-job-infos"><li><u-svg source="24/job/location"></u-svg><span>lieu</span>La Chaux-de-Fonds</li></ul>
          </div>
        </li>
        <li class="u-job-item">
          <a class="u-link-fit" href="/job/25098/Role-HF" aria-hidden="true"></a>
          <div class="u-tile">
            <h3>Role hors canton</h3>
            <ul class="u-job-infos"><li><u-svg source="24/job/location"></u-svg><span>lieu</span>Biel</li></ul>
          </div>
        </li>
        <li class="u-job-item">
          <a class="u-link-fit" href="/job/25099/Canton-Wide-HF" aria-hidden="true"></a>
          <div class="u-tile">
            <h3>Role senza comune</h3>
            <ul class="u-job-infos"><li><u-svg source="24/job/location"></u-svg><span>lieu</span>Canton de Neuchâtel</li></ul>
          </div>
        </li>
      </ul>
    `, canonicalSeed);

    expect(rows).toEqual([expect.objectContaining({
      title: 'Automaticien de production électrique',
      url: detailUrl.replace(/\/$/, ''),
    })]);
  });

  it('returns null when PROMAN listing markup is not recognized, but an empty array for recognized non-NE cards', () => {
    expect(extractPromanFleurierListingCandidates(`
      <a href="/job/25097/Automaticien-HF">Automaticien de production</a>
    `, canonicalSeed)).toBeNull();

    expect(extractPromanFleurierListingCandidates(`
      <li class="u-job-item">
        <a class="u-link-fit" href="/job/25098/Role-HF" aria-hidden="true"></a>
        <div class="u-tile">
          <h3>Role hors canton</h3>
          <ul class="u-job-infos"><li><u-svg source="24/job/location"></u-svg><span>lieu</span>Biel</li></ul>
        </div>
      </li>
    `, canonicalSeed)).toEqual([]);
  });

  it('classifies a source-backed non-NE detail as an expected canton filter', () => {
    const nonTargetFixture = detailFixture
      .replaceAll('La Chaux-de-Fonds', 'Biel');
    const detail = extractPromanFleurierDetailFields(nonTargetFixture, detailUrl);
    expect(detail.location).toBe('');
    expect(detail.sourceBackedCanton).toBe('BE');
    expect(isPromanFleurierExpectedDetailFilter({ reason: 'geography', detail })).toBe(true);
    expect(isPromanFleurierExpectedDetailFilter({ reason: 'geography', detail: {} })).toBe(false);
  });

  it('keeps the promoted spec and detail URL contract aligned with the official board', () => {
    const spec = loadSpec(PROMAN_FLEURIER_KEY);
    expect(spec.companyHost).toBe('proman-group.ch');
    expect(spec.canton).toBe('NE');
    expect(spec.seedUrls[0]).toBe(canonicalSeed);
    expect(PROMAN_FLEURIER_CAREER_URL).toBe(canonicalSeed);
    expect(spec.sampleTitles).toContain('Automaticien de production');
    expect(templateToRegex(spec.detailTemplate).test('/job/25097/Automaticien-HF')).toBe(true);
  });

  it('uses the canonical board URL and reaches the detail page when listings are present', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = async (url: string) => {
      requestedUrls.push(url);
      if (url.endsWith('/robots.txt')) return response(url, 'User-agent: *\nAllow: /');
      if (url === canonicalSeed) {
        return response(url, `
          <li class="u-job-item">
            <a class="u-link-fit" href="${new URL(detailUrl).pathname.replace(/\/$/, '')}" aria-hidden="true"></a>
            <div class="u-tile">
              <h3 class="t-lg-bold">Automaticien de production</h3>
              <ul class="u-job-infos"><li><u-svg source="24/job/location"></u-svg><span>lieu</span>La Chaux-de-Fonds</li></ul>
            </div>
          </li>
        `);
      }
      if (url === detailUrl.replace(/\/$/, '')) return response(url, detailFixture);
      throw new Error(`unexpected URL ${url}`);
    };
    const jobs = await fetchAllPromanFleurierJobs({
      fetchImpl,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      hostDelayMs: 0,
      retries: 0,
    });

    expect(jobs).toEqual([expect.objectContaining({
      url: detailUrl.replace(/\/$/, ''),
      canton: 'NE',
      title: 'Automaticien de production',
    })]);
    expect(requestedUrls).toContain(canonicalSeed);
    expect(requestedUrls).not.toContain('https://www.proman-group.ch/Job/SearchJobs/?brancheId=0&regionId=0&typeId=0');
  });

  it('keeps the generic candidate cascade when PROMAN markup is unrecognized', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = async (url: string) => {
      requestedUrls.push(url);
      if (url.endsWith('/robots.txt')) return response(url, 'User-agent: *\nAllow: /');
      if (url === canonicalSeed) {
        return response(url, `<a href="${new URL(detailUrl).pathname.replace(/\/$/, '')}">Automaticien de production</a>`);
      }
      if (url === detailUrl.replace(/\/$/, '')) return response(url, detailFixture);
      throw new Error(`unexpected URL ${url}`);
    };
    const jobs = await fetchAllPromanFleurierJobs({
      fetchImpl,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      hostDelayMs: 0,
      retries: 0,
    });

    expect(jobs).toEqual([expect.objectContaining({
      url: detailUrl.replace(/\/$/, ''),
      canton: 'NE',
      title: 'Automaticien de production',
    })]);
    expect(requestedUrls).toContain(detailUrl.replace(/\/$/, ''));
  });

  it('matches only the dedicated company key and official Proman hosts', () => {
    expect(isPromanFleurierJob({ companyKey: PROMAN_FLEURIER_KEY })).toBe(true);
    expect(isPromanFleurierJob({ companyKey: 'proman-other' })).toBe(false);
    expect(isTrustedDomain(detailUrl)).toBe(true);
    expect(isTrustedDomain('https://www.jobup.ch/fr/')).toBe(false);
  });
});
