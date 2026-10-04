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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildGapState,
  serializeGapState,
  parseGapState,
  diffGapState,
  buildGapArtifact,
  renderDeltaSection,
  serializeStateMarker,
  parseStateMarker,
  buildIdSetState,
  diffIdSets,
  shouldSuppressRecurrence,
  latestStateEntry,
  renderIdSetDeltaSection,
  isIdSetState,
  isTiLegacyState,
  TI_LEGACY_STATE_MARKER,
  TI_SECTOR_STATE_MARKER,
  RECURRENCE_HEARTBEAT_DAYS,
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

// ── Famiglie A e B (issue 5429, issue 9938) ────────────────────────────────
// La famiglia B ha commentato 184 volte su 5429, 174 con lo stesso insieme di
// ruoli del commento precedente: createIssue senza condizioni a ogni deploy.
// Questi casi diventano rossi se un ramo del monitor torna a ricommentare lo
// stesso insieme a ogni deploy.

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-04T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('serializeStateMarker / parseStateMarker', () => {
  const state = { ids: ['farmacista', 'logopedista'], indexedViaGrace: ['farmacista'], bridgedNoindex: ['logopedista'] };

  it('round-trip con il marker della famiglia B', () => {
    const text = `## Testo\n\n${serializeStateMarker(TI_LEGACY_STATE_MARKER, state)}\n`;
    expect(parseStateMarker(TI_LEGACY_STATE_MARKER, text, isTiLegacyState)).toEqual(state);
  });

  it('prende l’ULTIMO marker', () => {
    const older = serializeStateMarker(TI_LEGACY_STATE_MARKER, { ...state, ids: ['vecchio'] });
    const newer = serializeStateMarker(TI_LEGACY_STATE_MARKER, state);
    expect(parseStateMarker(TI_LEGACY_STATE_MARKER, `${older}\n---\n${newer}`, isTiLegacyState)?.ids)
      .toEqual(state.ids);
  });

  it('marker assente, corrotto o con ids non array → null', () => {
    expect(parseStateMarker(TI_LEGACY_STATE_MARKER, '## nessuno stato', isTiLegacyState)).toBeNull();
    expect(parseStateMarker(TI_LEGACY_STATE_MARKER, `<!-- ${TI_LEGACY_STATE_MARKER}: {non json} -->`, isTiLegacyState)).toBeNull();
    expect(parseStateMarker(TI_SECTOR_STATE_MARKER, `<!-- ${TI_SECTOR_STATE_MARKER}: {"ids":"sicurezza"} -->`, isIdSetState)).toBeNull();
    expect(parseStateMarker(TI_LEGACY_STATE_MARKER, `<!-- ${TI_LEGACY_STATE_MARKER}: {"ids":["a"]} -->`, isTiLegacyState)).toBeNull();
  });

  it('non confonde i marker delle tre famiglie', () => {
    const sector = serializeStateMarker(TI_SECTOR_STATE_MARKER, { ids: ['sicurezza'] });
    expect(parseStateMarker(TI_LEGACY_STATE_MARKER, sector, isTiLegacyState)).toBeNull();
    expect(parseGapState(sector)).toBeNull();
  });

  it('un ultimo marker invalido non ricade su uno più vecchio', () => {
    const good = serializeStateMarker(TI_SECTOR_STATE_MARKER, { ids: ['a'] });
    expect(parseStateMarker(TI_SECTOR_STATE_MARKER, `${good}\n<!-- ${TI_SECTOR_STATE_MARKER}: {rotto} -->`)).toBeNull();
  });
});

describe('buildIdSetState / diffIdSets', () => {
  it('buildIdSetState deduplica e ordina', () => {
    expect(buildIdSetState(['b', 'a', 'b'])).toEqual({ ids: ['a', 'b'] });
  });

  it('prev null → changed, anche con insieme vuoto', () => {
    expect(diffIdSets(null, { ids: ['a'] }).changed).toBe(true);
    expect(diffIdSets(null, { ids: [] }).changed).toBe(true);
  });

  it('stesso insieme in ordine diverso → nessun cambio', () => {
    expect(diffIdSets({ ids: ['b', 'a'] }, { ids: ['a', 'b'] }).changed).toBe(false);
  });

  it('calcola entrati e usciti', () => {
    const d = diffIdSets({ ids: ['logopedista', 'farmacista'] }, { ids: ['logopedista', 'architetto'] });
    expect(d.opened).toEqual(['architetto']);
    expect(d.closed).toEqual(['farmacista']);
    expect(d.changed).toBe(true);
  });

  it('a parità di id, un ruolo che passa da grace a noindex è un cambio', () => {
    const prev = { ids: ['a', 'b'], indexedViaGrace: ['a'], bridgedNoindex: ['b'] };
    const next = { ids: ['a', 'b'], indexedViaGrace: [], bridgedNoindex: ['a', 'b'] };
    const d = diffIdSets(prev, next);
    expect(d.opened).toEqual([]);
    expect(d.closed).toEqual([]);
    expect(d.regrouped).toEqual(['bridgedNoindex', 'indexedViaGrace']);
    expect(d.changed).toBe(true);
  });
});

describe('shouldSuppressRecurrence', () => {
  const next = { ids: ['assistente-dentale', 'logopedista'] };

  it('stesso insieme, commento di ieri → sopprime', () => {
    const previous = { state: { ids: ['logopedista', 'assistente-dentale'] }, createdAt: iso(NOW - DAY) };
    expect(shouldSuppressRecurrence({ previous, next, now: NOW })).toBe(true);
  });

  it('stesso insieme, commento di 8 giorni → battito, commenta', () => {
    const previous = { state: next, createdAt: iso(NOW - 8 * DAY) };
    expect(shouldSuppressRecurrence({ previous, next, now: NOW })).toBe(false);
  });

  it('il battito scatta esattamente a maxAgeDays', () => {
    const previous = { state: next, createdAt: iso(NOW - RECURRENCE_HEARTBEAT_DAYS * DAY) };
    expect(shouldSuppressRecurrence({ previous, next, now: NOW })).toBe(false);
  });

  it('insieme diverso → commenta', () => {
    const previous = { state: { ids: ['logopedista'] }, createdAt: iso(NOW - DAY) };
    expect(shouldSuppressRecurrence({ previous, next, now: NOW })).toBe(false);
  });

  it('nessuno stato o data illeggibile → commenta', () => {
    expect(shouldSuppressRecurrence({ previous: null, next, now: NOW })).toBe(false);
    expect(shouldSuppressRecurrence({ previous: { state: next, createdAt: null }, next, now: NOW })).toBe(false);
    expect(shouldSuppressRecurrence({ previous: { state: next, createdAt: 'ieri' }, next, now: NOW })).toBe(false);
  });
});

describe('latestStateEntry', () => {
  it('prende lo stato del commento più recente che lo porta, con la sua data', () => {
    const issue = {
      body: `corpo\n${serializeStateMarker(TI_SECTOR_STATE_MARKER, { ids: ['a'] })}`,
      createdAt: iso(NOW - 30 * DAY),
      comments: [
        { body: serializeStateMarker(TI_SECTOR_STATE_MARKER, { ids: ['b'] }), createdAt: iso(NOW - 3 * DAY) },
        { body: '🔁 Recurrence senza marker (commento storico)', createdAt: iso(NOW - DAY) },
      ],
    };
    expect(latestStateEntry(issue, TI_SECTOR_STATE_MARKER)).toEqual({ state: { ids: ['b'] }, createdAt: iso(NOW - 3 * DAY) });
  });

  it('ricade sul body con la data della issue', () => {
    const issue = { body: serializeStateMarker(TI_SECTOR_STATE_MARKER, { ids: ['a'] }), createdAt: iso(NOW), comments: [] };
    expect(latestStateEntry(issue, TI_SECTOR_STATE_MARKER)?.createdAt).toBe(iso(NOW));
  });

  it('issue senza marker (i 184 commenti storici di 5429) → null', () => {
    expect(latestStateEntry({ body: 'x', createdAt: iso(NOW), comments: [{ body: 'y', createdAt: iso(NOW) }] }, TI_LEGACY_STATE_MARKER)).toBeNull();
  });
});

describe('renderIdSetDeltaSection', () => {
  it('elenca entrati e usciti come id nudi, senza incollare grassetti', () => {
    const out = renderIdSetDeltaSection({ opened: ['architetto'], closed: ['farmacista'], regrouped: [] }, { baseline: false, noun: 'ruoli' });
    expect(out).toContain('### Delta');
    expect(out).toContain('**1 ruoli entrati:**\n\n- `architetto`');
    expect(out).toContain('**1 ruoli usciti:**\n\n- `farmacista`');
    expect(out).not.toMatch(/\*\*\*\*/);
    expect(out).not.toMatch(/lavoro-ticino-/);
  });

  it('distingue baseline, battito e sola ripartizione', () => {
    const empty = { opened: [], closed: [], regrouped: [] };
    expect(renderIdSetDeltaSection(empty, { baseline: true, noun: 'ruoli' })).toMatch(/rilevazione di riferimento/);
    expect(renderIdSetDeltaSection(empty, { baseline: false, noun: 'ruoli' })).toMatch(/battito/);
    expect(renderIdSetDeltaSection({ ...empty, regrouped: ['bridgedNoindex'] }, { baseline: false, noun: 'ruoli' }))
      .toMatch(/ripartizione cambiata/);
  });
});

describe('ricorrenza sulla issue: un commento per insieme, non per deploy', () => {
  // Simula il giro post-deploy con la issue come unico store, nello stesso
  // modo del monitor: lettura dello stato, decisione, commento con marker in
  // coda. Ogni commento passa per il prefisso «Recurrence» che aggiunge
  // github-issue-creator.mjs.
  function makeIssue() {
    const issue = { body: 'storico senza marker', createdAt: iso(NOW - 90 * DAY), comments: [] as { body: string; createdAt: string }[] };
    let createCalls = 0;
    const run = (zeroIds: string[], now: number) => {
      const state = { ...buildIdSetState(zeroIds), indexedViaGrace: [], bridgedNoindex: [...zeroIds].sort() };
      const previous = latestStateEntry(issue, TI_LEGACY_STATE_MARKER, isTiLegacyState);
      if (shouldSuppressRecurrence({ previous, next: state, now })) return;
      const delta = renderIdSetDeltaSection(diffIdSets(previous?.state ?? null, state), { baseline: !previous, noun: 'ruoli' });
      createCalls += 1;
      issue.comments.push({
        body: `🔁 Recurrence on workflow run.\n\n## Professioni\n\n${delta}\n${serializeStateMarker(TI_LEGACY_STATE_MARKER, state)}`,
        createdAt: iso(now),
      });
    };
    return { run, calls: () => createCalls };
  }

  it('due giri con lo stesso insieme → una chiamata; un ruolo in più → la seconda', () => {
    const { run, calls } = makeIssue();
    run(['logopedista', 'assistente-dentale'], NOW);
    run(['assistente-dentale', 'logopedista'], NOW + 3_600_000);
    expect(calls()).toBe(1);
    run(['assistente-dentale', 'logopedista', 'farmacista'], NOW + 7_200_000);
    expect(calls()).toBe(2);
  });

  it('il gap che sparisce e ritorna identico riemerge col battito', () => {
    const { run, calls } = makeIssue();
    run(['logopedista'], NOW);
    // Gap azzerato: il monitor esce senza scrivere. Ricompare identico 10 giorni dopo.
    run(['logopedista'], NOW + 10 * DAY);
    expect(calls()).toBe(2);
  });
});

describe('contratto di sorgente: le famiglie A e B decidono prima di commentare', () => {
  const src = readFileSync(path.join(__dirname, '..', 'scripts/monitor-sector-coverage.mjs'), 'utf8');
  const fnBody = (name: string) => {
    const start = src.indexOf(`async function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\nasync function ', start + 1);
    return src.slice(start, end === -1 ? undefined : end);
  };

  for (const [name, marker] of [
    ['checkTiLegacyProfessions', 'TI_LEGACY_STATE_MARKER'],
    ['checkTiSectorHubs', 'TI_SECTOR_STATE_MARKER'],
  ] as const) {
    it(`${name}: shouldSuppressRecurrence( prima di createIssue(, e il marker nel corpo`, () => {
      const body = fnBody(name);
      const suppressAt = body.indexOf('shouldSuppressRecurrence(');
      const createAt = body.indexOf('createIssue(');
      expect(suppressAt).toBeGreaterThan(-1);
      expect(createAt).toBeGreaterThan(suppressAt);
      expect(body).toContain(`serializeStateMarker(${marker}, state)`);
    });
  }
});
