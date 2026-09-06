/**
 * Drift guard fra la sorgente manuale degli alias e lo snapshot generato.
 *
 * `data/canton-location-aliases.json` è la SORGENTE: `scripts/generate-canton-municipalities.mjs`
 * costruisce `cantons[X].aliases` di `data/canton-municipalities.json` esclusivamente da lì.
 * Un alias che vive solo nello snapshot (perché aggiunto a mano al file generato) viene
 * cancellato senza avviso alla prossima `npm run data:municipalities`, e la geografia degli
 * annunci che lo usano torna a `null` — è esattamente la deriva da ~53 alias trovata in #7638.
 *
 * Questo test rende la rigenerazione idempotente sul contenuto: se il diff qui è a zero,
 * rilanciare il generatore non può perdere alias.
 */
import { describe, it, expect } from 'vitest';

import MANUAL_ALIASES from '../data/canton-location-aliases.json';
import SNAPSHOT from '../data/canton-municipalities.json';

const manual = MANUAL_ALIASES as Record<string, unknown>;
const snapshotCantons = SNAPSHOT.cantons as Record<string, { aliases?: string[] }>;

/** Chiavi non-cantone del file manuale (metadati), ignorate dal generatore. */
const isCantonKey = (key: string) => /^[A-Z]{2}$/.test(key);

const manualAliasesFor = (canton: string): string[] => {
  const value = manual[canton];
  return Array.isArray(value) ? (value as string[]) : [];
};

const snapshotAliasesFor = (canton: string): string[] => snapshotCantons[canton]?.aliases ?? [];

describe('canton aliases ↔ snapshot drift (rigenerazione idempotente)', () => {
  it('nessun alias vive solo nello snapshot generato', () => {
    const orphans: string[] = [];
    for (const canton of Object.keys(snapshotCantons)) {
      const fromManual = new Set(manualAliasesFor(canton));
      for (const alias of snapshotAliasesFor(canton)) {
        if (!fromManual.has(alias)) orphans.push(`${canton}/${alias}`);
      }
    }
    // Ognuno di questi sparirebbe alla prossima `npm run data:municipalities`:
    // aggiungerlo a data/canton-location-aliases.json è il fix.
    expect(orphans).toEqual([]);
  });

  it('ogni alias manuale è già nello snapshot (snapshot non rigenerato)', () => {
    const missing: string[] = [];
    for (const canton of Object.keys(manual).filter(isCantonKey)) {
      const inSnapshot = new Set(snapshotAliasesFor(canton));
      for (const alias of manualAliasesFor(canton)) {
        if (!inSnapshot.has(alias)) missing.push(`${canton}/${alias}`);
      }
    }
    // Lo snapshot committato deve essere l'output reale del generatore:
    // dopo aver toccato il file manuale, rilancia `npm run data:municipalities`.
    expect(missing).toEqual([]);
  });

  it('ogni chiave cantone del file manuale esiste nello snapshot', () => {
    const unknown = Object.keys(manual)
      .filter(isCantonKey)
      .filter((canton) => !(canton in snapshotCantons));
    // Una chiave che non è un cantone BFS è un refuso: il generatore la ignora
    // in silenzio e gli alias sotto di essa non arrivano mai al matching.
    expect(unknown).toEqual([]);
  });
});
