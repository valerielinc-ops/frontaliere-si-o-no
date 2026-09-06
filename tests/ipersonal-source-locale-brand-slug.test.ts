/**
 * OSSERVATORE #7722 — lo slug del locale SORGENTE non puo' nominare un datore
 * diverso da quello che il record dichiara.
 *
 * Le due slice gemelle `ipersonal` / `med-ipersonal` pubblicano brand distinti
 * su host che si somigliano (`www.ipersonal.ch` → iPersonal AG,
 * `med-ipersonal.ch` → MediPersonal). Dopo lo scambio di etichette di #7570 gli
 * slug per-locale hanno seguito il brand nuovo, ma quello del locale sorgente
 * no: `regenerate-slugs-by-locale.mjs` saltava il source-lang per costruzione,
 * quindi 15/15 righe di `med-ipersonal` servivano una route indicizzata che
 * diceva `-med-ipersonal-ch` mentre il contenuto dichiarava `iPersonal AG`.
 * Nessun 404 lo segnalava: la pagina esisteva, mentiva soltanto sul datore.
 *
 * Qui si pinna l'invariante che rende quel ritorno rosso prima del deploy —
 * nessuno slug, source-lang compreso, porta il token esclusivo del gemello — e
 * il ponte di redirect che la correzione non puo' perdere.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { IPERSONAL_COMPANY_NAME } from '../scripts/lib/ipersonal-job-parser.mjs';
import { MED_IPERSONAL_COMPANY_NAME } from '../scripts/lib/med-ipersonal-job-parser.mjs';
import { slugify } from '../scripts/lib/regenerate-slugs-helpers.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const SLICE_DIR = path.resolve(__dirname, '..', 'data', 'jobs', 'by-crawler');

type Job = {
  id: string;
  company?: string;
  sourceLang?: string;
  slug?: string;
  slugByLocale?: Record<string, string>;
  previousSlugsByLocale?: Record<string, string[]>;
};

function readSlice(key: string): Job[] {
  const file = path.join(SLICE_DIR, `${key}.json`);
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return Array.isArray(parsed?.jobs) ? parsed.jobs : [];
}

/** Token che nomina UN solo dei due brand: `ipersonal` compare in entrambi. */
const BRAND_TOKENS: Record<string, string> = {
  [IPERSONAL_COMPANY_NAME]: slugify(IPERSONAL_COMPANY_NAME), // medipersonal
  [MED_IPERSONAL_COMPANY_NAME]: 'ipersonal-ag',
};

/** Il token del gemello, cioe' quello che lo slug NON deve mai portare. */
function rivalToken(company: string): string {
  return company === IPERSONAL_COMPANY_NAME
    ? BRAND_TOKENS[MED_IPERSONAL_COMPANY_NAME]
    : BRAND_TOKENS[IPERSONAL_COMPANY_NAME];
}

/**
 * `med-ipersonal` / `medipersonal` dentro uno slug nominano MediPersonal; per
 * riconoscere `iPersonal AG` serve la forma con la ragione sociale, perche' il
 * solo `ipersonal` e' contenuto anche in `med-ipersonal`.
 */
function namesRival(slug: string, company: string): boolean {
  const token = rivalToken(company);
  if (token === 'ipersonal-ag') return slug.includes('ipersonal-ag');
  // MediPersonal: sia la forma compatta sia quella con la chiave crawler.
  return /(^|-)med-?ipersonal(-|$)/.test(slug);
}

describe('#7722 — slug e brand delle slice gemelle iPersonal/MediPersonal', () => {
  const slices = [
    { key: 'ipersonal', jobs: readSlice('ipersonal') },
    { key: 'med-ipersonal', jobs: readSlice('med-ipersonal') },
  ];

  it('le due slice sono presenti e mono-datore', () => {
    for (const { key, jobs } of slices) {
      expect(jobs.length, `${key} vuota`).toBeGreaterThan(0);
      expect(new Set(jobs.map((j) => j.company)).size, `${key} non e' mono-datore`).toBe(1);
    }
  });

  it('nessuno slug per-locale — source-lang e master compresi — nomina il datore gemello', () => {
    const offenders: string[] = [];
    for (const { key, jobs } of slices) {
      for (const job of jobs) {
        const company = String(job.company || '');
        if (!company) continue;
        const candidates: Array<[string, string]> = [['slug', String(job.slug || '')]];
        for (const locale of LOCALES) {
          candidates.push([locale, String((job.slugByLocale || {})[locale] || '')]);
        }
        for (const [where, slug] of candidates) {
          if (!slug) continue;
          if (namesRival(slug, company)) offenders.push(`${key}/${job.id} [${where}] ${slug}`);
        }
      }
    }
    expect(offenders, `slug che nominano il datore gemello:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('ogni slug del locale sorgente che porta un brand lo porta coerente con `company`', () => {
    // Uno slug puo' legittimamente NON nominare nessun datore: `buildSlug`
    // tronca a MAX_SLUG_LENGTH e su un titolo lunghissimo il tail
    // company+location cade fuori. Un URL senza brand non rivendica il datore
    // sbagliato — l'invariante e' sull'incoerenza, non sulla presenza.
    const offenders: string[] = [];
    for (const { key, jobs } of slices) {
      for (const job of jobs) {
        const company = String(job.company || '');
        const sourceLang = String(job.sourceLang || 'it');
        const slug = String((job.slugByLocale || {})[sourceLang] || '');
        if (!slug || !company) continue;
        if (namesRival(slug, company)) offenders.push(`${key}/${job.id} ${sourceLang}: ${slug}`);
      }
    }
    expect(offenders, `slug source-lang incoerenti:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('gli slug source-lang rietichettati conservano il ponte di redirect', () => {
    // Le righe gia' pubblicate sotto l'etichetta vecchia hanno cambiato slug in
    // questa correzione: la route indicizzata sopravvive solo via
    // `previousSlugsByLocale`. Il pin vale per le righe che portano il brand
    // NUOVO nello slug sorgente — una riga appena crawlata sotto l'etichetta
    // corretta non ha nessun URL precedente da preservare, e non e' un difetto.
    const missing: string[] = [];
    for (const { key, jobs } of slices) {
      for (const job of jobs) {
        const sourceLang = String(job.sourceLang || 'it');
        const slug = String((job.slugByLocale || {})[sourceLang] || '');
        const bridge = (job.previousSlugsByLocale || {})[sourceLang] || [];
        if (!slug) continue;
        const staleForms = bridge.filter((prev) => namesRival(prev, String(job.company || '')));
        // Se il ponte contiene una forma col brand vecchio, deve restare li'
        // (non essere stata potata come «uguale allo slug attivo»).
        for (const stale of staleForms) {
          if (stale === slug) missing.push(`${key}/${job.id}: ponte non piu' distinto (${stale})`);
        }
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('nessuna riga ha perso lo slug sorgente', () => {
    for (const { key, jobs } of slices) {
      for (const job of jobs) {
        const sourceLang = String(job.sourceLang || 'it');
        const slug = String((job.slugByLocale || {})[sourceLang] || '');
        expect(slug, `${key}/${job.id} senza slug per il locale sorgente`).not.toBe('');
      }
    }
  });
});
