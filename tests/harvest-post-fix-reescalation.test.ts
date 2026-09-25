/**
 * lessons-harvester — post-fix re-escalation guard (#4578).
 *
 * `fix-outcome:revenue-tracker-manual` re-fired the day AFTER its own structural
 * fix shipped: #4517 (identical bucket) was closed by merging PR #4535, which
 * added a zero-Claude pre-flight preventing FUTURE burn. The next harvester run
 * still counted the same pre-fix occurrences still sitting in the trailing
 * 14-day window and minted a duplicate escalation (#4578) instead of recognizing
 * the fix already shipped. `lastEscalationClosedAt` + `examplesSinceFix` fix this
 * generically for any fix-outcome bucket: only examples newer than the bucket's
 * last shipped fix count toward `recurringDespiteRule`.
 */
import { describe, it, expect } from 'vitest';
import { lastEscalationClosedAt, examplesSinceFix, parseEscalationKey } from '../scripts/ci/harvest-agent-lessons.mjs';

describe('lastEscalationClosedAt — trova la chiusura più recente per lo stesso bucket', () => {
  const KEY = 'fix-outcome/fix-outcome:revenue-tracker-manual';

  it('nessuna issue chiusa corrispondente → null (nessun fix mai spedito)', () => {
    expect(lastEscalationClosedAt(KEY, [])).toBeNull();
    expect(lastEscalationClosedAt(KEY, [
      { title: 'escalation(harvester): fix-outcome/fix-outcome:no-root-cause ricorre nonostante regola', closedAt: '2026-07-10T00:00:00Z' },
    ])).toBeNull();
  });

  it('trova la issue #4517 chiusa e ne ritorna il closedAt in epoch ms', () => {
    const closedAt = '2026-07-19T11:46:22Z';
    const result = lastEscalationClosedAt(KEY, [
      { title: 'escalation(harvester): fix-outcome/fix-outcome:revenue-tracker-manual ricorre nonostante regola', closedAt },
    ]);
    expect(result).toBe(Date.parse(closedAt));
  });

  it('con più chiusure per lo stesso bucket, ritorna la PIÙ RECENTE', () => {
    const result = lastEscalationClosedAt(KEY, [
      { title: 'escalation(harvester): fix-outcome/fix-outcome:revenue-tracker-manual ricorre nonostante regola', closedAt: '2026-06-01T00:00:00Z' },
      { title: 'escalation(harvester): fix-outcome/fix-outcome:revenue-tracker-manual ricorre nonostante regola', closedAt: '2026-07-19T11:46:22Z' },
    ]);
    expect(result).toBe(Date.parse('2026-07-19T11:46:22Z'));
  });

  it('ignora titoli che non parsano a escalation o con bucket diverso', () => {
    expect(lastEscalationClosedAt(KEY, [
      { title: 'feat(seo): normal PR title', closedAt: '2026-07-19T11:46:22Z' },
      { title: 'escalation(harvester): reviewer-finding/sibling-class-fix ricorre nonostante regola', closedAt: '2026-07-19T11:46:22Z' },
    ])).toBeNull();
  });

  it('closedAt illeggibile viene ignorato', () => {
    expect(lastEscalationClosedAt(KEY, [
      { title: 'escalation(harvester): fix-outcome/fix-outcome:revenue-tracker-manual ricorre nonostante regola', closedAt: 'not-a-date' },
    ])).toBeNull();
  });

  it('input degeneri non lanciano', () => {
    expect(lastEscalationClosedAt(KEY, null as unknown as [])).toBeNull();
    expect(lastEscalationClosedAt(KEY, undefined as unknown as [])).toBeNull();
  });
});

describe('examplesSinceFix — conta solo gli esempi successivi al fix spedito', () => {
  const examples = [
    { issue: 4459, at: '2026-07-18T16:00:01Z' },
    { issue: 4462, at: '2026-07-18T16:00:07Z' },
    { issue: 9999, at: '2026-07-20T09:00:00Z' }, // post-fix, genuinely new
  ];

  it('cutoff null (nessun fix precedente) → ritorna tutti invariati', () => {
    expect(examplesSinceFix(examples, null)).toEqual(examples);
  });

  it('cutoff impostato (fix spedito il 2026-07-19) → scarta gli esempi pre-fix', () => {
    const cutoff = Date.parse('2026-07-19T11:46:22Z');
    const result = examplesSinceFix(examples, cutoff);
    expect(result).toEqual([{ issue: 9999, at: '2026-07-20T09:00:00Z' }]);
  });

  it('esempio senza timestamp `at` parseable viene scartato una volta che esiste un cutoff (conservativo)', () => {
    const cutoff = Date.parse('2026-07-19T11:46:22Z');
    expect(examplesSinceFix([{ issue: 1 }, { issue: 2, at: 'garbage' }], cutoff)).toEqual([]);
  });

  it('array vuoto/undefined non lancia', () => {
    expect(examplesSinceFix([], 123)).toEqual([]);
    expect(examplesSinceFix(undefined as unknown as [], 123)).toEqual([]);
  });
});

describe('integrazione concettuale: il bucket #4578 si sarebbe auto-soppresso', () => {
  it('gli 11 esempi pre-fix (2026-07-18) contro un fix spedito il 2026-07-19 danno effectiveCount 0 → niente re-escalation', () => {
    const closedEscalations = [{
      title: 'escalation(harvester): fix-outcome/fix-outcome:revenue-tracker-manual ricorre nonostante regola',
      closedAt: '2026-07-19T11:46:22Z',
    }];
    const key = 'fix-outcome:revenue-tracker-manual';
    const fullKey = `fix-outcome/${key}`;
    expect(parseEscalationKey(closedEscalations[0].title)).toBe(fullKey);
    const cutoff = lastEscalationClosedAt(fullKey, closedEscalations);
    const preFixExamples = Array.from({ length: 11 }, (_, i) => ({ issue: 4459 + i, at: '2026-07-18T16:00:00Z' }));
    expect(examplesSinceFix(preFixExamples, cutoff)).toHaveLength(0);
  });

  it('una NUOVA occorrenza dopo il fix conta normalmente (nessuna soppressione permanente)', () => {
    const closedEscalations = [{
      title: 'escalation(harvester): fix-outcome/fix-outcome:revenue-tracker-manual ricorre nonostante regola',
      closedAt: '2026-07-19T11:46:22Z',
    }];
    const cutoff = lastEscalationClosedAt('fix-outcome/fix-outcome:revenue-tracker-manual', closedEscalations);
    const mixed = [
      { issue: 1, at: '2026-07-18T16:00:00Z' }, // pre-fix, scartato
      { issue: 2, at: '2026-07-21T09:00:00Z' }, // post-fix, genuino
    ];
    expect(examplesSinceFix(mixed, cutoff)).toEqual([{ issue: 2, at: '2026-07-21T09:00:00Z' }]);
  });
});

describe('integrazione: reviewer-finding ora filtra come fix-outcome (#5516)', () => {
  // sibling-class-fix è escalato 6 volte (#3809/#4260/#4342/#4672/#4963/#5426) e
  // finché gli esempi reviewer-finding non portavano `at`, examplesSinceFix non
  // poteva mai scartare le PR pre-fix: il bucket ricontava all'infinito le stesse
  // occorrenze già "risolte" da un'escalation chiusa. Questo verifica che, con
  // `at` = mergedAt della PR, lo stesso meccanismo già provato per fix-outcome
  // funziona identico per reviewer-finding.
  it('esempi pre-fix contro un fix spedito danno effectiveCount 0 → niente re-escalation', () => {
    const closedEscalations = [{
      title: 'escalation(harvester): reviewer-finding/sibling-class-fix ricorre nonostante regola',
      closedAt: '2026-08-09T10:39:00Z',
    }];
    const key = 'sibling-class-fix';
    const fullKey = `reviewer-finding/${key}`;
    expect(parseEscalationKey(closedEscalations[0].title)).toBe(fullKey);
    const cutoff = lastEscalationClosedAt(fullKey, closedEscalations);
    const preFixExamples = [
      { pr: 5423, at: '2026-08-08T00:00:00Z' },
      { pr: 5419, at: '2026-08-08T00:00:00Z' },
      { pr: 5405, at: '2026-08-07T00:00:00Z' },
    ];
    expect(examplesSinceFix(preFixExamples, cutoff)).toHaveLength(0);
  });

  it('una PR mergiata DOPO il fix conta normalmente (nessuna soppressione permanente)', () => {
    const closedEscalations = [{
      title: 'escalation(harvester): reviewer-finding/sibling-class-fix ricorre nonostante regola',
      closedAt: '2026-08-09T10:39:00Z',
    }];
    const cutoff = lastEscalationClosedAt('reviewer-finding/sibling-class-fix', closedEscalations);
    const mixed = [
      { pr: 5423, at: '2026-08-08T00:00:00Z' }, // pre-fix, scartato
      { pr: 5600, at: '2026-08-11T09:00:00Z' }, // post-fix, genuino
    ];
    expect(examplesSinceFix(mixed, cutoff)).toEqual([{ pr: 5600, at: '2026-08-11T09:00:00Z' }]);
  });
});
