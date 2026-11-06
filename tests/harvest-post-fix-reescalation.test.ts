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
import {
  lastEscalationClosedAt,
  examplesSinceFix,
  parseEscalationKey,
  parseIssueEventLines,
  lastClosedEventAt,
  reopenedEscalationClosures,
  measureBucket,
} from '../scripts/ci/harvest-agent-lessons.mjs';

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

// Escalation RIAPERTA (titolo «Harvester: escalation riaperta ricontata
// sull'intera finestra (cutoff perso)»). Forma reale di 10112 il 2026-10-03:
// `state: OPEN`, `closedAt: null`, evento `closed` del 27-09 e `reopened`
// dell'01-10. Prima della fix il cutoff si leggeva solo dalle issue chiuse,
// quindi tornava null e l'escalation si ricontava sugli esempi pre-fix.
describe('cutoff di una escalation riaperta: viene dagli eventi', () => {
  const KEY = 'reviewer-finding/canonical-sitemap';
  const reopenedIssue = {
    number: 10112,
    title: `escalation(harvester): ${KEY} ricorre nonostante regola`,
    state: 'OPEN',
    closedAt: null,
  };
  const CLOSED_AT = '2026-09-27T20:19:47Z';
  const eventLines = [
    'labeled 2026-09-27T16:38:41Z',
    'project_v2_item_status_changed 2026-09-27T16:38:43Z',
    `closed ${CLOSED_AT}`,
    'reopened 2026-10-01T11:44:16Z',
    'labeled 2026-10-01T13:39:45Z',
  ].join('\n');

  it('le righe evento si leggono, nomi con cifre compresi', () => {
    const events = parseIssueEventLines(eventLines);
    expect(events).not.toBeNull();
    expect(events?.map((e) => e.event)).toContain('project_v2_item_status_changed');
    expect(lastClosedEventAt(events)).toBe(CLOSED_AT);
  });

  it('solo issue chiuse (il comportamento di prima) → cutoff null per la riaperta', () => {
    expect(lastEscalationClosedAt(KEY, [reopenedIssue])).toBeNull();
  });

  it('unione chiuse + chiusure delle aperte → cutoff = evento closed', () => {
    const { closures, unreadable } = reopenedEscalationClosures([reopenedIssue],
      () => parseIssueEventLines(eventLines));
    expect(unreadable).toEqual([]);
    expect(closures).toEqual([{ number: 10112, title: reopenedIssue.title, closedAt: CLOSED_AT }]);
    expect(lastEscalationClosedAt(KEY, [...closures])).toBe(Date.parse(CLOSED_AT));
  });

  it('più chiusure: vale l ultima', () => {
    const events = parseIssueEventLines([
      'closed 2026-09-10T00:00:00Z', 'reopened 2026-09-11T00:00:00Z',
      `closed ${CLOSED_AT}`, 'reopened 2026-10-01T11:44:16Z',
    ].join('\n'));
    expect(lastClosedEventAt(events)).toBe(CLOSED_AT);
  });

  it('eventi illeggibili → nessun cutoff (l allarme resta) e il numero è dichiarato', () => {
    for (const raw of ['', 'non è una riga evento', '[]']) {
      expect(parseIssueEventLines(raw)).toBeNull();
    }
    const { closures, unreadable } = reopenedEscalationClosures([reopenedIssue], () => null);
    expect(closures).toEqual([]);
    expect(unreadable).toEqual([10112]);
    expect(lastEscalationClosedAt(KEY, closures)).toBeNull();
  });

  it('mai chiusa → nessuna chiusura; titoli non di escalation ignorati senza leggere eventi', () => {
    let reads = 0;
    const { closures } = reopenedEscalationClosures([
      reopenedIssue,
      { number: 1, title: 'feat(seo): altro' },
    ], () => { reads += 1; return parseIssueEventLines('labeled 2026-09-27T16:38:41Z'); });
    expect(closures).toEqual([]);
    expect(reads).toBe(1);
  });
});

describe('measureBucket — conteggio dopo il cutoff, criterio invariato', () => {
  const cutoff = Date.parse('2026-09-27T20:19:47Z');
  const before = (i: number) => ({ pr: 9000 + i, at: '2026-09-20T10:00:00Z', snippet: `pre ${i}` });
  const after = (i: number) => ({ pr: 10500 + i, at: '2026-09-30T10:00:00Z', snippet: `post ${i}` });
  const window = (pre: number, post: number) => [
    ...Array.from({ length: pre }, (_, i) => before(i)),
    ...Array.from({ length: post }, (_, i) => after(i)),
  ];

  it('15 in finestra, 4 dopo il cutoff → effectiveCount 4, nessuna escalation', () => {
    const examples = window(11, 4);
    const m = measureBucket({ source: 'reviewer-finding', count: examples.length, examples,
      escalationCutoff: cutoff, threshold: 3, factor: 2 });
    expect(m.effectiveCount).toBe(4);
    expect(m.aboveLimit).toBe(false);
    expect(m.liveExamples.every((e: { snippet: string }) => e.snippet.startsWith('post'))).toBe(true);
  });

  it('15 in finestra, 7 dopo il cutoff → escalation', () => {
    const examples = window(8, 7);
    const m = measureBucket({ source: 'reviewer-finding', count: examples.length, examples,
      escalationCutoff: cutoff, threshold: 3, factor: 2 });
    expect(m.effectiveCount).toBe(7);
    expect(m.aboveLimit).toBe(true);
  });

  it('invariante: senza escalation precedente né regola conta l intera finestra, come prima', () => {
    const examples = window(11, 4);
    const m = measureBucket({ source: 'reviewer-finding', count: examples.length, examples,
      threshold: 3, factor: 2 });
    expect(m.cutoff).toBeNull();
    expect(m.effectiveCount).toBe(examples.length);
    expect(m.aboveLimit).toBe(true);
  });

  it('cutoff = il più recente fra chiusura e regola registrata', () => {
    const rule = Date.parse('2026-09-29T00:00:00Z');
    const m = measureBucket({ source: 'fix-outcome', count: 3,
      examples: [{ issue: 1, at: '2026-09-28T00:00:00Z' }, { issue: 2, at: '2026-09-30T00:00:00Z' }],
      escalationCutoff: cutoff, ruleCutoff: rule });
    expect(m.cutoff).toBe(rule);
    expect(m.effectiveCount).toBe(1);
  });

  it('issue-class non ha timestamp: conteggio invariato anche con un cutoff', () => {
    const m = measureBucket({ source: 'issue-class', count: 9, examples: [{ issue: 1 }],
      escalationCutoff: cutoff });
    expect(m.cutoff).toBeNull();
    expect(m.effectiveCount).toBe(9);
  });
});
