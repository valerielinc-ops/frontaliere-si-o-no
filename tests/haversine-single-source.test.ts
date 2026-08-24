/**
 * Una sola implementazione della distanza great-circle (issue #5002).
 *
 * Il repo ne aveva SEI copie byte-equivalenti — `borderMunicipalityPagesPlugin`,
 * `FrontierGuide`, `FuelPriceStats`, `jobLocationSnapshot`,
 * `generate-fuel-prices-dataset`, `geocode-municipalities` — più il modulo
 * foglia `scripts/lib/haversine.mjs` che due script già importavano. Sei copie
 * della stessa formula significa che cinque si perdono la prossima correzione:
 * è il caso che AGENTS.md #6 chiama esplicitamente («una regex/costante
 * duplicata letteralmente in ≥2 file → estraila in UN modulo condiviso»).
 *
 * Due asserzioni, perché la deduplica non basta dichiararla:
 *
 *  1. le formule storiche e il modulo foglia danno lo STESSO numero — le copie
 *     usavano due forme algebriche diverse (`asin` e `atan2`) e sostituirle
 *     senza provarne l'equivalenza cambierebbe in silenzio i dataset generati
 *     da `geocode-municipalities.mjs`;
 *  2. nessun file reintroduce una copia locale.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { haversineKm } from '@/scripts/lib/haversine.mjs';

const REPO_ROOT = path.resolve(__dirname, '..');

/** La forma con `asin` che stava in borderMunicipalityPagesPlugin e FrontierGuide. */
const historicalAsin = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const earthKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * earthKm * Math.asin(Math.sqrt(h));
};

/** La forma con `atan2` che stava in FuelPriceStats, jobLocationSnapshot e nei due script. */
const historicalAtan2 = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

/** Punti reali del dominio: valichi, comuni di frontiera, città ticinesi. */
const PAIRS: Array<[number, number, number, number]> = [
  [45.8399, 9.0308, 45.8323, 8.9463], // Como → Chiasso
  [45.8206, 8.8228, 46.0037, 8.9511], // Varese → Lugano
  [46.1712, 8.7955, 46.0037, 8.9511], // Domodossola → Lugano
  [45.7, 8.8, 45.7, 8.8], // punto su se stesso
  [45.0, 8.0, 47.0, 10.0], // due gradi in entrambe le direzioni
  [45.0, 8.0, 45.0, 8.0001], // distanza minima
];

describe('haversine: una sola sorgente', () => {
  it('coincide con la forma storica ad asin', () => {
    for (const [a, b, c, d] of PAIRS) {
      expect(haversineKm(a, b, c, d)).toBeCloseTo(historicalAsin(a, b, c, d), 9);
    }
  });

  it('coincide con la forma storica ad atan2', () => {
    for (const [a, b, c, d] of PAIRS) {
      expect(haversineKm(a, b, c, d)).toBeCloseTo(historicalAtan2(a, b, c, d), 9);
    }
  });

  it('è simmetrica e zero su se stessa', () => {
    expect(haversineKm(45.8399, 9.0308, 45.8323, 8.9463)).toBeCloseTo(
      haversineKm(45.8323, 8.9463, 45.8399, 9.0308),
      12,
    );
    expect(haversineKm(45.7, 8.8, 45.7, 8.8)).toBe(0);
  });

  it('nessun file reintroduce una copia locale della formula', () => {
    const CONSUMERS = [
      'build-plugins/borderMunicipalityPagesPlugin.ts',
      'build-plugins/shared/nearestMunicipalityComparison.ts',
      'components/guide/FrontierGuide.tsx',
      'components/pages/FuelPriceStats.tsx',
      'services/jobLocationSnapshot.ts',
      'scripts/generate-fuel-prices-dataset.mjs',
      'scripts/geocode-municipalities.mjs',
      'scripts/lib/events-utils.mjs',
      'scripts/lib/evergreen-topic-generator.mjs',
    ];
    // Il marcatore della formula, non il nome della funzione: un wrapper che
    // delega (due file ne hanno uno, per non toccare call site a oggetti) è
    // legittimo, la trigonometria ricopiata no.
    const FORMULA_RE = /Math\.sin\(\s*dL(?:at|ng)\s*\/\s*2\s*\)/;
    const offenders = CONSUMERS.filter((rel) =>
      FORMULA_RE.test(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8')),
    );
    expect(
      offenders,
      'Questi file hanno di nuovo la formula in casa. Importa\n' +
        '`haversineKm` da scripts/lib/haversine.mjs (AGENTS.md #6): la stessa\n' +
        'formula in N posti significa che N-1 si perdono la prossima correzione.',
    ).toEqual([]);
  });
});
