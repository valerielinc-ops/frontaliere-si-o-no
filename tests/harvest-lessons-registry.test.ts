/**
 * lessons-harvester — registro versionato delle decisioni sui cluster.
 *
 * Senza registro `alreadyDocumented` cerca la frase del fingerprint nei doc,
 * che una regola in italiano non contiene: `fp:scripts-funnel-treats-every`
 * tornava NOVEL il giorno dopo la sua regola (#10153) e
 * `fp:body-not-closing-state` e' stato scartato (#10153) e poi accettato
 * (#10212) sugli stessi tre esempi. Qui si fissa il contratto: un cluster
 * registrato torna fuori solo con ≥ soglia esempi DOPO la decisione.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  LESSONS_REGISTRY_PATH,
  loadLessonsRegistry,
  parseLessonsRegistry,
  registryDecidedAtMs,
  registryKey,
  registryVerdict,
} from '../scripts/ci/harvest-agent-lessons.mjs';

const entry = (over: Record<string, unknown> = {}) => ({
  key: 'reviewer-finding/fp:body-not-closing-state',
  outcome: 'added',
  decidedAt: '2026-09-28T12:05:13Z',
  ref: '#10212',
  reason: 'regola in REVIEW.md',
  ...over,
});

describe('registryDecidedAtMs', () => {
  it('ISO con orario = quell\'istante; data sola = fine giornata UTC', () => {
    expect(registryDecidedAtMs('2026-09-28T12:05:13Z')).toBe(Date.parse('2026-09-28T12:05:13Z'));
    expect(registryDecidedAtMs('2026-09-28')).toBe(Date.parse('2026-09-28T23:59:59.999Z'));
  });

  it('valori non ISO → null', () => {
    expect(registryDecidedAtMs('ieri')).toBeNull();
    expect(registryDecidedAtMs('Sep 28 2026')).toBeNull();
    expect(registryDecidedAtMs(undefined)).toBeNull();
  });
});

describe('parseLessonsRegistry', () => {
  it('indicizza per chiave <source>/<key>', () => {
    const { entries, errors } = parseLessonsRegistry(JSON.stringify({ entries: [entry()] }));
    expect(errors).toEqual([]);
    expect(entries.get(registryKey('reviewer-finding', 'fp:body-not-closing-state'))?.outcome).toBe('added');
  });

  it('con due voci sulla stessa chiave vince la decisione piu\' recente', () => {
    const { entries } = parseLessonsRegistry({ entries: [
      entry({ outcome: 'declined', decidedAt: '2026-09-27T19:33:23Z' }),
      entry({ outcome: 'added', decidedAt: '2026-09-28T12:05:13Z' }),
    ] });
    expect(entries.get('reviewer-finding/fp:body-not-closing-state')?.outcome).toBe('added');
  });

  it('le voci invalide finiscono in errors e NON sopprimono niente', () => {
    const { entries, errors } = parseLessonsRegistry({ entries: [
      entry({ key: 'fp:senza-source' }),
      entry({ key: 'reviewer-finding/a', outcome: 'ignored' }),
      entry({ key: 'reviewer-finding/b', decidedAt: 'ieri' }),
      entry({ key: 'reviewer-finding/c', reason: '  ' }),
    ] });
    expect(entries.size).toBe(0);
    expect(errors).toHaveLength(4);
  });

  it('JSON rotto o senza entries → errore, registro vuoto', () => {
    expect(parseLessonsRegistry('{').errors[0]).toMatch(/JSON non valido/);
    expect(parseLessonsRegistry('{}').errors).toEqual(['manca l\'array `entries`']);
  });

  it('file assente = registro vuoto senza errori (corpus prima del suo registro)', () => {
    const enoent = () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
    const reg = loadLessonsRegistry('non/esiste.json', enoent);
    expect(reg.entries.size).toBe(0);
    expect(reg.errors).toEqual([]);
    expect(reg.missing).toBe(true);
  });
});

describe('registryVerdict — quando un cluster registrato torna fuori', () => {
  const decided = { decidedAtMs: Date.parse('2026-09-27T19:33:23Z') };
  const ex = (...ats: string[]) => ats.map((at, i) => ({ pr: 9000 + i, at }));

  it('senza voce il cluster resta com\'era', () => {
    const examples = ex('2026-09-20T00:00:00Z');
    expect(registryVerdict(null, examples, 3)).toEqual({ registered: false, resurfaced: true, examplesSinceDecision: examples });
  });

  it('fp:scripts-funnel-treats-every del 28-09: 5 esempi, 2 dopo la regola → NON riemerge', () => {
    const v = registryVerdict(decided, ex(
      '2026-09-17T10:00:00Z', '2026-09-22T10:00:00Z', '2026-09-26T10:00:00Z',
      '2026-09-28T01:00:00Z', '2026-09-28T03:00:00Z',
    ), 3);
    expect(v.registered).toBe(true);
    expect(v.examplesSinceDecision).toHaveLength(2);
    expect(v.resurfaced).toBe(false);
  });

  it('gli stessi esempi gia\' decisi non la fanno riemergere', () => {
    const v = registryVerdict(decided, ex('2026-09-18T00:00:00Z', '2026-09-19T00:00:00Z', '2026-09-20T00:00:00Z'), 3);
    expect(v.resurfaced).toBe(false);
  });

  it('≥ soglia esempi nuovi dopo la decisione → riemerge', () => {
    const v = registryVerdict(decided, ex('2026-09-28T00:00:00Z', '2026-09-29T00:00:00Z', '2026-09-30T00:00:00Z'), 3);
    expect(v.resurfaced).toBe(true);
    expect(v.examplesSinceDecision).toHaveLength(3);
  });
});

describe('registro versionato del sito', () => {
  it('e\' valido: nessuna voce scartata in silenzio a runtime', () => {
    const raw = readFileSync(LESSONS_REGISTRY_PATH, 'utf8');
    const { entries, errors } = parseLessonsRegistry(raw);
    expect(errors).toEqual([]);
    expect(entries.size).toBe(JSON.parse(raw).entries.length);
  });

  it('registra i cluster gia\' decisi da #10153 e #10212', () => {
    const { entries } = loadLessonsRegistry(LESSONS_REGISTRY_PATH);
    expect(entries.get('reviewer-finding/fp:scripts-funnel-treats-every')?.outcome).toBe('added');
    expect(entries.get('reviewer-finding/fp:body-not-closing-state')?.outcome).toBe('added');
    expect(entries.get('reviewer-finding/fp:codex-fallback-review-scope')?.outcome).toBe('declined');
  });
});
