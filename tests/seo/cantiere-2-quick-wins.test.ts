import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SEO_SOURCE = readFileSync(
  path.resolve(__dirname, '../../services/seo/seo-pages.ts'),
  'utf-8',
);

function entrySource(key: string, nextKey: string): string {
  const start = SEO_SOURCE.indexOf(` ${key}: {`);
  const end = SEO_SOURCE.indexOf(`\n ${nextKey}: {`, start);
  expect(start, `missing SEO entry ${key}`).toBeGreaterThanOrEqual(0);
  expect(end, `missing boundary after SEO entry ${key}`).toBeGreaterThan(start);
  return SEO_SOURCE.slice(start, end);
}

describe('cantiere 2 — SEO metadata quick wins', () => {
  it('keeps jobboard metadata concise and free of fixed inventory claims', () => {
    const entry = entrySource('jobboard', 'glossario');
    const metadata = entry.slice(0, entry.indexOf('structuredData:'));
    expect(entry).toContain("title: 'Offerte di lavoro in Ticino 2026 | Aggiornate ogni giorno'");
    expect(entry).toContain("description: 'Cerca offerte di lavoro in Ticino per frontalieri: filtra per città, settore e contratto, confronta le posizioni e candidati direttamente alle aziende.'");
    expect(entry).toContain("ogTitle: 'Offerte di lavoro in Ticino 2026 | Aggiornate ogni giorno'");
    expect(entry).toContain("ogDescription: 'Offerte di lavoro in Ticino per frontalieri: filtra per città, settore e contratto e candidati direttamente alle aziende.'");
    expect(metadata).not.toContain('1500+');
    expect(metadata).not.toContain('100+ aziende');
    expect(metadata).toContain("canonicalPath: '/cerca-lavoro-ticino/'");
  });

  it('keeps calculator metadata grammatical and within the description budget', () => {
    const entry = entrySource('calcolatore', 'guide');
    const description = entry.match(/\n description: '([^']+)'/)?.[1] ?? '';
    const ogDescription = entry.match(/\n ogDescription: '([^']+)'/)?.[1] ?? '';
    expect(description).toBe('Calcola lo stipendio netto da frontaliere in Svizzera: imposta alla fonte, AVS, LPP, IRPEF e franchigia di 10.000 €. Simulatore gratuito aggiornato al 2026.');
    expect(ogDescription).toBe('Simula lo stipendio netto da frontaliere con imposta alla fonte, contributi AVS/LPP, IRPEF e franchigia di 10.000 €. Calcolo gratuito aggiornato al 2026.');
    expect(description.length).toBeLessThanOrEqual(160);
    expect(ogDescription.length).toBeLessThanOrEqual(160);
    expect(entry).not.toContain('un frontaliere netta');
    expect(entry).toContain("canonicalPath: '/calcola-stipendio/'");
  });

  it('describes the border map without an unverified crossing count', () => {
    const entry = entrySource("'border-map'", 'jobboard');
    expect(entry).toContain("title: 'Mappa confine Italia-Svizzera 2026 | Valichi del Ticino'");
    expect(entry).toContain("description: 'Mappa interattiva del confine Italia-Svizzera in Ticino: valichi, tempi di attesa live, webcam e comuni di frontiera.'");
    expect(entry).toContain("ogTitle: 'Mappa confine Italia-Svizzera 2026 | Valichi del Ticino'");
    expect(entry).toContain("ogDescription: 'Mappa interattiva del confine Italia-Svizzera in Ticino: valichi, tempi di attesa live, webcam e comuni di frontiera.'");
    expect(entry).not.toMatch(/title: '[^']*9 Valichi/);
    expect(entry).not.toMatch(/description: '[^']*9 valichi/);
    expect(entry).toContain("canonicalPath: '/guida-frontaliere/mappa-confine/'");
  });
});
