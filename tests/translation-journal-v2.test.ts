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

function event(fromState: string | null, toState: string, candidate: string | null) {
  return createTranslationJournalEventV2({
    attemptKey,
    candidateId: candidate,
    fromState,
    toState,
  });
}

describe('translation journal v2 state machine', () => {
  it('accepts the happy path and replays the same event idempotently', () => {
    const events = [
      event(null, 'missing', null),
      event('missing', 'generated', candidateId),
      event('generated', 'validated', candidateId),
      event('validated', 'queued', candidateId),
      event('queued', 'applied', candidateId),
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
      event(null, 'missing', null),
      event('missing', 'generated', candidateId),
      event('generated', 'rejected', candidateId),
    ]);
    expect(getTranslationJournalStateV2(rejected, attemptKey).state).toBe('rejected');

    const stale = replayTranslationJournalV2([
      event(null, 'missing', null),
      event('missing', 'generated', candidateId),
      event('generated', 'validated', candidateId),
      event('validated', 'stale_source', candidateId),
    ]);
    expect(getTranslationJournalStateV2(stale, attemptKey).state).toBe('stale_source');

    const absentThenReadded = replayTranslationJournalV2([
      event(null, 'missing', null),
      event('missing', 'target_absent', null),
      event('target_absent', 'missing', null),
    ]);
    expect(getTranslationJournalStateV2(absentThenReadded, attemptKey).state).toBe('missing');
  });

  it('rejects stale fromState, skipped validation and candidate substitution', () => {
    const missing = appendTranslationJournalEventV2(
      createEmptyTranslationJournalV2(),
      event(null, 'missing', null),
    );
    expect(() => appendTranslationJournalEventV2(
      missing,
      event('generated', 'validated', candidateId),
    )).toThrow(/stale fromState/);
    expect(() => replayTranslationJournalV2([
      event(null, 'missing', null),
      createTranslationJournalEventV2({
        attemptKey,
        candidateId,
        fromState: 'missing',
        toState: 'applied',
      }),
    ])).toThrow(/illegal/);
    expect(() => replayTranslationJournalV2([
      event(null, 'missing', null),
      event('missing', 'generated', candidateId),
      createTranslationJournalEventV2({
        attemptKey,
        candidateId: `translation-candidate:v2:${'b'.repeat(64)}`,
        fromState: 'generated',
        toState: 'validated',
      }),
    ])).toThrow(/candidate changed/);
  });

  it('serializes canonically, stays immutable and rejects expanded schemas', () => {
    const initial = createEmptyTranslationJournalV2();
    const firstEvent = event(null, 'missing', null);
    const appended = appendTranslationJournalEventV2(initial, firstEvent);
    const repeated = appendTranslationJournalEventV2(appended, firstEvent);

    expect(repeated).toEqual(appended);
    expect(initial.events).toHaveLength(0);
    expect(serializeTranslationJournalV2(repeated)).toBe(serializeTranslationJournalV2(appended));
    expect(() => replayTranslationJournalV2([{ ...firstEvent, timestamp: 1 }])).toThrow(/schema/);
  });
});
