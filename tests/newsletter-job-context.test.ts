import { describe, expect, it } from 'vitest';
import {
  matchJobsForSubscriber,
  prepareNewsletterJobContext,
  validateJobUrls,
} from '../services/newsletter-content.mjs';

const JOBS = [
  {
    title: 'Sviluppatore backend', company: 'Tech SA', companyKey: 'tech-sa',
    location: 'Lugano', canton: 'TI', category: 'IT', sector: 'Software',
    slug: 'sviluppatore-backend-tech', postedDate: '2026-08-31T00:00:00.000Z',
    description: 'Sviluppo di servizi backend per prodotti digitali.',
  },
  {
    title: 'Tecnico sistemi', company: 'Infra SA', companyKey: 'infra-sa',
    location: 'Lugano', canton: 'TI', category: 'IT', sector: 'Sistemi',
    slug: 'tecnico-sistemi-infra', postedDate: '2026-08-30T00:00:00.000Z',
    description: 'Gestione dei sistemi informatici aziendali.',
  },
  {
    title: 'Infermiere', company: 'Clinica SA', companyKey: 'clinica-sa',
    location: 'Bellinzona', canton: 'TI', category: 'Sanita', sector: 'Sanita',
    slug: 'infermiere-clinica', postedDate: '2026-08-29T00:00:00.000Z',
    description: 'Assistenza infermieristica in reparto.',
  },
  {
    title: 'Contabile', company: 'Finanza SA', companyKey: 'finanza-sa',
    location: 'Locarno', canton: 'TI', category: 'Finanza', sector: 'Contabilita',
    slug: 'contabile-finanza', postedDate: '2026-08-28T00:00:00.000Z',
    description: 'Contabilita generale e chiusure mensili.',
  },
  {
    title: 'Project manager', company: 'Delivery SA', companyKey: 'delivery-sa',
    location: 'Lugano', canton: 'TI', category: 'Management', sector: 'Software',
    slug: 'project-manager-delivery', postedDate: '2026-08-27T00:00:00.000Z',
    description: 'Coordinamento di progetti software.',
  },
];

describe('prepareNewsletterJobContext', () => {
  it('preserva esattamente il ranking del percorso legacy per profili diversi', () => {
    const recent = ['sviluppatore-backend-tech'];
    const prepared = prepareNewsletterJobContext(JOBS, recent);
    const subscribers = [
      { locationInterest: null, sectorInterest: null },
      { locationInterest: 'Lugano', sectorInterest: null },
      { locationInterest: null, sectorInterest: 'Software' },
      {
        job_slug: 'sviluppatore-backend-tech',
        sourceJob: JOBS[0],
        locationInterest: 'Lugano',
        sectorInterest: 'Software',
      },
    ];

    for (const subscriber of subscribers) {
      const legacy = matchJobsForSubscriber(subscriber, JOBS, 4, 'it', recent);
      const indexed = matchJobsForSubscriber(subscriber, prepared, 4, 'it');
      expect(indexed).toEqual(legacy);
    }
  });

  it('costruisce una sola volta slug, hub e campi normalizzati', () => {
    const prepared = prepareNewsletterJobContext(JOBS, []);

    expect(prepared.validSlugs.size).toBe(JOBS.length);
    expect(prepared.emittedCompanyHubs.has('tech-sa')).toBe(true);
    expect(prepared.entries[0].locationSearch).toBe('lugano ti');
    expect(prepared.entries[0].sectorSearch).toEqual(['sviluppatore backend', 'it', 'software']);
    expect(prepared.locationMatchesByQuery.size).toBe(0);
    expect(prepared.sectorMatchesByQuery.size).toBe(0);

    matchJobsForSubscriber({ locationInterest: 'Lugano', sectorInterest: 'Software' }, prepared, 4, 'it');
    expect(prepared.locationMatchesByQuery.size).toBe(1);
    expect(prepared.sectorMatchesByQuery.size).toBe(1);

    matchJobsForSubscriber({ locationInterest: 'lugano', sectorInterest: 'software' }, prepared, 4, 'it');
    expect(prepared.locationMatchesByQuery.size).toBe(1);
    expect(prepared.sectorMatchesByQuery.size).toBe(1);
  });

  it('riusa il valid-slug set preparato nella validazione URL', () => {
    const prepared = prepareNewsletterJobContext(JOBS, []);
    const matched = [
      { title: 'Backend', url: '/cerca-lavoro-ticino/sviluppatore-backend-tech/' },
      { title: 'Ghost', url: '/cerca-lavoro-ticino/ghost/' },
    ];

    expect(validateJobUrls(matched, prepared)).toEqual([matched[0]]);
  });

  it('limita le cache delle preferenze free-text per non crescere con gli iscritti', () => {
    const prepared = prepareNewsletterJobContext(JOBS, []);

    for (let i = 0; i < 80; i += 1) {
      matchJobsForSubscriber({ locationInterest: `localita-${i}` }, prepared, 4, 'it');
      matchJobsForSubscriber({ sectorInterest: `settore-${i}` }, prepared, 4, 'it');
    }

    expect(prepared.locationMatchesByQuery.size).toBe(64);
    expect(prepared.sectorMatchesByQuery.size).toBe(64);
  });
});
