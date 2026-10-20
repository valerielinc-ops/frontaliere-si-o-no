import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import {
  extractRhExpertChDetailFields,
  fetchAllRhExpertChJobs,
  isRhExpertChJob,
  isTrustedDomain,
  RH_EXPERT_CH_KEY,
} from '../scripts/lib/rh-expert-ch-job-parser.mjs';
import { loadSpec } from '../scripts/lib/prospector/spec-crawler.mjs';

describe('RH-Expert source-backed detail extraction', () => {
  const detailUrl = 'https://rh-expert.ch/fr/offres-demploi/commis-de-salle';
  const taskText = '• Mise en place de la salle.• Assiste le chef de rang pendant la durée du service.• Effectue';
  const detailHtml = `<html lang="fr"><body><div class="page_emploi"><div class="inside"><div class="colcontainer">
    <div class="col col-9"><h1>Commis de salle</h1><p class="small">08/10/2026</p>
      <p>${taskText}</p><p>Lieu de travail : Genève et alentours.</p>
    </div><div class="col col-3"><p>1201 Genève</p></div>
  </div></div></div></body></html>`;

  it('uses the detail H1, actual role text and labelled workplace, not the listing CTA or office column', () => {
    const detail = extractRhExpertChDetailFields(detailHtml, detailUrl);
    expect(detail.title).toBe('Commis de salle');
    expect(detail.description).toContain(taskText);
    expect(detail.description).not.toContain('Lieu de travail');
    expect(detail.location).toBe('Genève et alentours');
    expect(detail.canton).toBe('GE');
    expect(detail.locationCandidates).toEqual([
      { location: 'Genève et alentours', addressRegion: 'GE' },
    ]);
  });

  it('reads list-item vacancy content and workplace evidence from the official detail column', () => {
    const detail = extractRhExpertChDetailFields(
      `<div class="page_emploi"><div class="col col-9"><h1>Commis de salle</h1>
        <ul><li>Mise en place de la salle et préparation du matériel nécessaire au service.</li>
          <li>Assiste le chef de rang pendant la durée du service et respecte les standards.</li>
          <li>Travaille de manière autonome, ponctuelle, flexible et dynamique.</li></ul>
        <ul><li>Lieu de travail : Genève.</li></ul>
      </div><div class="col col-3"><p>1201 Genève</p></div></div>`,
      detailUrl,
    );
    expect(detail.description).toContain('Mise en place de la salle');
    expect(detail.description).not.toContain('Lieu de travail');
    expect(detail.location).toBe('Genève');
    expect(detail.canton).toBe('GE');
  });

  it('withholds list-only bodies below the source floor and retains St. Gallen at the floor', async () => {
    const listingUrl = 'https://rh-expert.ch/fr/offres-demploi';
    const detailUrl = 'https://rh-expert.ch/fr/offres-demploi/assistant';
    const listingHtml = `<a href="${detailUrl}">En savoir plus</a>`;
    const bodyForWords = (count: number) => Array.from(
      { length: count },
      (_, index) => `mission${index}`,
    ).join(' ');
    let body = bodyForWords(30);
    const detailHtml = () => `<div class="page_emploi"><div class="col col-9"><h1>Assistant</h1>
      <ul><li>${body}</li></ul><ul><li>Lieu de travail : St. Gallen.</li></ul>
    </div></div>`;
    const fetchImpl = async (url: string) => {
      const requestedUrl = String(url);
      if (requestedUrl.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /', { status: 200 });
      if (requestedUrl === listingUrl) return new Response(listingHtml, { status: 200 });
      if (requestedUrl === detailUrl) return new Response(detailHtml(), { status: 200 });
      throw new Error(`unexpected URL ${requestedUrl}`);
    };
    const fetchJobs = () => fetchAllRhExpertChJobs({
      fetchImpl,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      retries: 0,
      disableWafProxy: true,
    });

    expect(await fetchJobs()).toHaveLength(0);

    body = bodyForWords(50);
    const jobs = await fetchJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].location).toBe('St. Gallen');
    expect(jobs[0].canton).toBe('SG');
  });

  it('drops a detail whose only heading is the source CTA and does not rescue its location from the office sidebar', () => {
    const detail = extractRhExpertChDetailFields(
      '<div class="page_emploi"><div class="col col-9"><h1>En savoir plus</h1><p>Lieu de travail : Genève.</p></div><div class="col col-3"><p>1201 Genève</p></div></div>',
      detailUrl,
    );
    expect(detail.title).toBe('');
    expect(detail.description).toBe('');
    expect(detail.locationCandidates).toEqual([]);
  });

  it('keeps the official RH-Expert spec and rejects marketplace URLs', () => {
    const spec = loadSpec(RH_EXPERT_CH_KEY);
    expect(spec.candidateKey).toBe('rh-expert@geneve');
    expect(spec.revalidateRejectedWithSourceAdapter).toBe(true);
    expect(spec.companyHost).toBe('rh-expert.ch');
    expect(spec.listingCandidateText).toBeUndefined();
    expect(spec.sampleVacancyCount).toBe(16);
    expect(spec.sampleTitles).toEqual([
      'Pâtissier', 'Commis de cuisine', 'Commis de salle', "Maîtres d'hôtel", 'Femme de chambre',
    ]);
    expect(isRhExpertChJob({ companyKey: RH_EXPERT_CH_KEY })).toBe(true);
    expect(isTrustedDomain(detailUrl)).toBe(true);
    expect(isTrustedDomain('https://www.jobup.ch/fr/')).toBe(false);
  });

  it('keeps every official listing candidate instead of overfitting to one title', async () => {
    const listingUrl = 'https://rh-expert.ch/fr/offres-demploi';
    const detailUrls = [
      'https://rh-expert.ch/fr/offres-demploi/commis-de-salle',
      'https://rh-expert.ch/fr/offres-demploi/commis-de-cuisine',
    ];
    const listingHtml = detailUrls.map((url, index) => (
      `<a href="${url}">${index === 0 ? 'Commis de salle' : 'Commis de cuisine'}</a>`
    )).join('');
    const detailHtml = (title: string) => `<div class="page_emploi"><div class="col col-9"><h1>${title}</h1>
      <ul><li>Prépare et organise le service avec rigueur dans un environnement professionnel.</li>
        <li>Collabore avec l'équipe, respecte les consignes et assure une qualité constante.</li>
        <li>Reste autonome, ponctuel, flexible et attentif aux besoins de la clientèle.</li>
        <li>Participe à la préparation des commandes et au suivi quotidien des priorités de l'équipe.</li>
        <li>Contribue à l'accueil des clients et communique avec les différents interlocuteurs du restaurant.</li></ul>
        <ul><li>Lieu de travail : Genève.</li></ul>
      </div></div>`;
    const fetchImpl = async (url: string) => {
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /', { status: 200 });
      if (url === listingUrl) return new Response(listingHtml, { status: 200 });
      const index = detailUrls.indexOf(url);
      if (index >= 0) {
        return new Response(detailHtml(index === 0 ? 'Commis de salle' : 'Commis de cuisine'), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    };
    const jobs = await fetchAllRhExpertChJobs({
      fetchImpl,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      retries: 0,
      disableWafProxy: true,
    });
    expect(jobs.map((job) => job.title)).toEqual(['Commis de salle', 'Commis de cuisine']);
    expect(jobs.every((job) => job.location === 'Genève' && job.canton === 'GE')).toBe(true);
  });

  it('registers the dedicated runner in the production crawler manifest', () => {
    const manifest = JSON.parse(fs.readFileSync('data/crawler-manifest.json', 'utf8'));
    const entry = manifest.manifest.find((crawler: { slug: string }) => crawler.slug === RH_EXPERT_CH_KEY);
    expect(entry?.runStep?.run).toBe('node scripts/update-rh-expert-ch-jobs.mjs');
    expect(entry?.postSteps?.[0]?.env?.JOBS_HOUSEKEEPING_SCOPE).toBe(RH_EXPERT_CH_KEY);
    expect(entry?.postSteps?.[0]?.env?.JOBS_SLICE_FILE).toBe('data/jobs/by-crawler/rh-expert-ch.json');
  });
});
