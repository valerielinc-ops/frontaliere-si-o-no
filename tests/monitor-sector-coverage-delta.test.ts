/**
 * monitor-sector-coverage — delta del gap set + artefatto (#5323).
 *
 * #5323 ri-firava a ogni post-deploy con lo STESSO commento di 15 bullet,
 * consumando budget del fixer. Il gap set ora viaggia come marker HTML nel
 * commento: al giro dopo lo si rilegge e si commenta solo il delta.
 *
 * Il bias e' esplicito e testato: stato precedente assente o corrotto →
 * `null` → `changed: true` → si commenta. Non si sopprime mai su incertezza.
 */
import { describe, it, expect } from 'vitest';
import {
  buildGapState,
  serializeGapState,
  parseGapState,
  diffGapState,
  buildGapArtifact,
  renderDeltaSection,
} from '../scripts/monitor-sector-coverage.mjs';

const mkMap = (obj: Record<string, [string, number][]>) =>
  new Map(
    Object.entries(obj).map(([id, entries]) => [
      id,
      entries.map(([cantonKey, liveCount]) => ({ cantonKey, liveCount })),
    ]),
  );

describe('buildGapState', () => {
  it('produce coppie professione:cantone ordinate (diff stabile)', () => {
    const state = buildGapState({
      nationalZero: ['sommelier', 'archivista'],
      belowFloorByProfession: mkMap({ cuoco: [['ZH', 1], ['BE', 0]], autista: [['VS', 2]] }),
    });
    expect(state.nationalZero).toEqual(['archivista', 'sommelier']);
    expect(state.pairs).toEqual(['autista:VS', 'cuoco:BE', 'cuoco:ZH']);
  });

  it('è stabile rispetto all’ordine di inserimento nella Map', () => {
    const a = buildGapState({ nationalZero: [], belowFloorByProfession: mkMap({ b: [['ZH', 1]], a: [['BE', 1]] }) });
    const b = buildGapState({ nationalZero: [], belowFloorByProfession: mkMap({ a: [['BE', 1]], b: [['ZH', 1]] }) });
    expect(a.pairs).toEqual(b.pairs);
  });
});

describe('serializeGapState / parseGapState — round-trip', () => {
  const state = { nationalZero: ['sommelier'], pairs: ['cuoco:ZH', 'cuoco:BE'] };

  it('round-trip attraverso il marker HTML', () => {
    expect(parseGapState(serializeGapState(state))).toEqual(state);
  });

  it('estrae il marker anche annegato in un corpo markdown', () => {
    const body = `## Titolo\n\nTesto vario.\n\n${serializeGapState(state)}\n`;
    expect(parseGapState(body)).toEqual(state);
  });

  it('prende l’ULTIMO marker quando il testo concatena piu’ commenti', () => {
    const older = serializeGapState({ nationalZero: [], pairs: ['vecchio:ZH'] });
    const newer = serializeGapState({ nationalZero: [], pairs: ['nuovo:BE'] });
    expect(parseGapState(`${older}\n---\n${newer}`)?.pairs).toEqual(['nuovo:BE']);
  });

  it('ritorna null senza marker', () => {
    expect(parseGapState('## Nessuno stato qui')).toBeNull();
  });

  it('ritorna null su marker corrotto invece di lanciare', () => {
    expect(parseGapState('<!-- COVERAGE_GAP_STATE_V1: {non json} -->')).toBeNull();
  });

  it('ritorna null su marker con JSON valido ma forma sbagliata', () => {
    expect(parseGapState('<!-- COVERAGE_GAP_STATE_V1: {"altro":1} -->')).toBeNull();
  });

  it('ritorna null su input vuoto/null', () => {
    expect(parseGapState('')).toBeNull();
    expect(parseGapState(undefined as unknown as string)).toBeNull();
  });
});

describe('diffGapState', () => {
  const prev = { nationalZero: ['sommelier'], pairs: ['cuoco:ZH', 'autista:VS'] };

  it('non segnala nulla quando lo stato è identico', () => {
    expect(diffGapState(prev, prev).changed).toBe(false);
  });

  it('rileva un gap NUOVO', () => {
    const next = { nationalZero: ['sommelier'], pairs: ['cuoco:ZH', 'autista:VS', 'cuoco:BE'] };
    const d = diffGapState(prev, next);
    expect(d.openedPairs).toEqual(['cuoco:BE']);
    expect(d.closedPairs).toEqual([]);
    expect(d.changed).toBe(true);
  });

  it('rileva un gap CHIUSO', () => {
    const next = { nationalZero: ['sommelier'], pairs: ['cuoco:ZH'] };
    const d = diffGapState(prev, next);
    expect(d.closedPairs).toEqual(['autista:VS']);
    expect(d.openedPairs).toEqual([]);
    expect(d.changed).toBe(true);
  });

  it('rileva i movimenti dello zero nazionale in entrambe le direzioni', () => {
    const next = { nationalZero: ['archivista'], pairs: prev.pairs };
    const d = diffGapState(prev, next);
    expect(d.openedZero).toEqual(['archivista']);
    expect(d.closedZero).toEqual(['sommelier']);
    expect(d.changed).toBe(true);
  });

  it('prev null (primo giro o stato illeggibile) → changed, cioè si commenta', () => {
    // Il bias che conta: su incertezza non si sopprime mai.
    expect(diffGapState(null, { nationalZero: [], pairs: ['cuoco:ZH'] }).changed).toBe(true);
  });

  it('prev null con gap set vuoto non inventa un cambiamento', () => {
    expect(diffGapState(null, { nationalZero: [], pairs: [] }).changed).toBe(false);
  });
});

describe('renderDeltaSection', () => {
  const ctx = {
    minJobs: 3,
    totalPairs: 12,
    totalZero: 1,
    pairLabel: (p: string) => {
      const [id, k] = p.split(':');
      return `\`${id}\` — ${k}`;
    },
  };
  const empty = { openedZero: [], closedZero: [], openedPairs: [], closedPairs: [] };

  it('SOLO chiusure: non incolla "Nessun gap nuovo." al blocco successivo', () => {
    // Regressione: la concatenazione a rami opzionali produceva
    // "**Nessun gap nuovo.****1 gap CHIUSI**" — grassetto rotto.
    const out = renderDeltaSection({ ...empty, closedPairs: ['cuoco:ZH'] }, ctx);
    expect(out).toContain('**Nessun gap nuovo.**');
    expect(out).not.toMatch(/\*\*\*\*/);
    expect(out).toContain('**Nessun gap nuovo.**\n\n**1 gap CHIUSI**');
  });

  it('non dichiara "Nessun gap nuovo." quando ci sono gap nuovi', () => {
    const out = renderDeltaSection({ ...empty, openedPairs: ['cuoco:ZH'] }, ctx);
    expect(out).not.toContain('Nessun gap nuovo');
    expect(out).toContain('**1 gap NUOVI**');
  });

  it('separa sempre i blocchi con una riga vuota, in ogni combinazione', () => {
    const out = renderDeltaSection(
      { openedZero: ['a'], closedZero: ['b'], openedPairs: ['c:ZH'], closedPairs: ['d:BE'] },
      ctx,
    );
    expect(out).not.toMatch(/\*\*\*\*/);
    for (const frag of ['a ZERO nazionale', 'gap NUOVI', 'non più a zero', 'gap CHIUSI']) {
      expect(out).toContain(frag);
    }
  });

  it('tronca gli elenchi lunghi rimandando all’artefatto', () => {
    const many = Array.from({ length: 26 }, (_, i) => `p${i}:ZH`);
    const out = renderDeltaSection({ ...empty, openedPairs: many }, ctx);
    expect(out).toContain('e altri 6 (elenco completo nell\'artefatto)');
  });

  it('chiude sempre con il totale corrente', () => {
    const out = renderDeltaSection({ ...empty, closedPairs: ['x:ZH'] }, ctx);
    expect(out).toContain('Totale corrente: 12 coppie sotto soglia, 1 professioni a zero nazionale.');
  });
});

describe('buildGapArtifact', () => {
  const artifact = buildGapArtifact({
    nationalZero: ['sommelier'],
    belowFloorByProfession: mkMap({
      autista: [['VS', 2]],
      cuoco: [['ZH', 1], ['BE', 0], ['GR', 2]],
    }),
    minJobs: 3,
    cantonCount: 25,
  });

  it('ordina per numero di cantoni sotto soglia (desc) e NON tronca', () => {
    expect(artifact.belowFloor.map((e) => e.professionId)).toEqual(['cuoco', 'autista']);
    expect(artifact.belowFloor[0].cantonCount).toBe(3);
  });

  it('conserva i liveCount per cantone, ordinati per chiave', () => {
    expect(artifact.belowFloor[0].cantons.map((c) => c.cantonKey)).toEqual(['BE', 'GR', 'ZH']);
    expect(artifact.belowFloor[0].cantons[0].liveCount).toBe(0);
  });

  it('documenta perché l’ordinamento per domanda non è applicato', () => {
    expect(artifact._orderingNote).toMatch(/circolar|noindex/i);
    expect(artifact._minJobs).toBe(3);
  });
});
