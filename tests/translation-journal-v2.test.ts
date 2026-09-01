import { describe, expect, it } from 'vitest';
import {
  appendTranslationJournalEventV2,
  createEmptyTranslationJournalV2,
  createTranslationJournalEventV2,
  getTranslationJournalStateV2,
  replayTranslationJournalV2,
  serializeTranslationJournalV2,
} from '../scripts/lib/translation-journal-v2.mjs';
import {
  createTranslationAttemptKeyV2,
  createTranslationUnitIdentityV2,
} from '../scripts/lib/translation-unit-identity-v2.mjs';

const identity = createTranslationUnitIdentityV2({
  kind: 'job',
  fieldPath: 'title',
  sourceLocale: 'de',
  targetLocale: 'it',
  sourceText: 'SRC_A',
  context: { company: 'COMPANY_A', location: 'LOCATION_A' },
});
const attemptKey = createTranslationAttemptKeyV2({
  identity,
  engineVersion: 'engine-1',
  gateVersion: 'gate-1',
});
const candidateId = `translation-candidate:v2:${'a'.repeat(64)}`;

function event(sequence: number, fromState: string | null, toState: string, candidate: string | null) {
  return createTranslationJournalEventV2({
    attemptKey,
    candidateId: candidate,
    fromState,
    sequence,
    toState,
  });
}

describe('translation journal v2 state machine', () => {
  it('accepts the happy path and replays the same event idempotently', () => {
    const events = [
      event(1, null, 'missing', null),
      event(2, 'missing', 'generated', candidateId),
      event(3, 'generated', 'validated', candidateId),
      event(4, 'validated', 'queued', candidateId),
      event(5, 'queued', 'applied', candidateId),
    ];
    const replayed = replayTranslationJournalV2([...events, events[2]]);

    expect(replayed.events).toHaveLength(events.length);
    expect(getTranslationJournalStateV2(replayed, attemptKey)).toEqual({
      state: 'applied',
      candidateId,
    });
    expect(Object.isFrozen(replayed.events)).toBe(true);
  });

  it('supports rejected, stale_source and target_absent without illegal shortcuts', () => {
    const rejected = replayTranslationJournalV2([
      event(1, null, 'missing', null),
      event(2, 'missing', 'generated', candidateId),
      event(3, 'generated', 'rejected', candidateId),
    ]);
    expect(getTranslationJournalStateV2(rejected, attemptKey).state).toBe('rejected');

    const stale = replayTranslationJournalV2([
      event(1, null, 'missing', null),
      event(2, 'missing', 'generated', candidateId),
      event(3, 'generated', 'validated', candidateId),
      event(4, 'validated', 'stale_source', candidateId),
    ]);
    expect(getTranslationJournalStateV2(stale, attemptKey).state).toBe('stale_source');

    const deleteReaddDelete = [
      event(1, null, 'missing', null),
      event(2, 'missing', 'target_absent', null),
      event(3, 'target_absent', 'missing', null),
      event(4, 'missing', 'target_absent', null),
    ];
    const replayedWithRetry = replayTranslationJournalV2([
      ...deleteReaddDelete,
      deleteReaddDelete[3],
    ]);
    expect(replayedWithRetry.events).toHaveLength(4);
    expect(getTranslationJournalStateV2(replayedWithRetry, attemptKey).state).toBe('target_absent');
  });

  it('rejects stale fromState, skipped validation and candidate substitution', () => {
    const missing = appendTranslationJournalEventV2(
      createEmptyTranslationJournalV2(),
      event(1, null, 'missing', null),
    );
    expect(() => appendTranslationJournalEventV2(
      missing,
      event(2, 'generated', 'validated', candidateId),
    )).toThrow(/stale fromState/);
    expect(() => replayTranslationJournalV2([
      event(1, null, 'missing', null),
      createTranslationJournalEventV2({
        attemptKey,
        candidateId,
        fromState: 'missing',
        sequence: 2,
        toState: 'applied',
      }),
    ])).toThrow(/illegal/);
    expect(() => replayTranslationJournalV2([
      event(1, null, 'missing', null),
      event(2, 'missing', 'generated', candidateId),
      createTranslationJournalEventV2({
        attemptKey,
        candidateId: `translation-candidate:v2:${'b'.repeat(64)}`,
        fromState: 'generated',
        sequence: 3,
        toState: 'validated',
      }),
    ])).toThrow(/candidate changed/);
    expect(() => replayTranslationJournalV2([
      event(1, null, 'missing', null),
      event(3, 'missing', 'target_absent', null),
    ])).toThrow(/not contiguous/);
    expect(() => replayTranslationJournalV2([
      event(1, null, 'missing', null),
      event(2, 'missing', 'target_absent', null),
      event(2, 'missing', 'generated', candidateId),
    ])).toThrow(/conflicting events/);
  });

  it('serializes canonically, stays immutable and rejects expanded schemas', () => {
    const initial = createEmptyTranslationJournalV2();
    const firstEvent = event(1, null, 'missing', null);
    const appended = appendTranslationJournalEventV2(initial, firstEvent);
    const repeated = appendTranslationJournalEventV2(appended, firstEvent);

    expect(repeated).toEqual(appended);
    expect(initial.events).toHaveLength(0);
    expect(serializeTranslationJournalV2(repeated)).toBe(serializeTranslationJournalV2(appended));
    expect(() => replayTranslationJournalV2([{ ...firstEvent, timestamp: 1 }])).toThrow(/schema/);
  });
});
