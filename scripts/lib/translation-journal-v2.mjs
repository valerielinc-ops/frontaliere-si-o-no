import {
  assertTranslationExactKeysV2,
  assertTranslationPlainObjectV2,
  canonicalTranslationJsonV2,
  deepFreezeTranslationV2,
  digestTranslationDocumentV2,
} from './translation-unit-identity-v2.mjs';

export const TRANSLATION_JOURNAL_V2_SCHEMA_VERSION = 2;
export const TRANSLATION_JOURNAL_STATES_V2 = Object.freeze([
  'missing',
  'generated',
  'validated',
  'queued',
  'applied',
  'rejected',
  'stale_source',
  'target_absent',
]);

const JOURNAL_KEYS = ['events', 'schemaVersion'];
const EVENT_KEYS = ['attemptKey', 'candidateId', 'eventId', 'fromState', 'schemaVersion', 'toState'];
const CREATE_EVENT_KEYS = ['attemptKey', 'candidateId', 'fromState', 'toState'];
const ATTEMPT_PATTERN = /^translation-attempt:v2:[a-f0-9]{64}$/;
const CANDIDATE_PATTERN = /^translation-candidate:v2:[a-f0-9]{64}$/;
const STATE_SET = new Set(TRANSLATION_JOURNAL_STATES_V2);
const TRANSITIONS = Object.freeze({
  missing: Object.freeze(['generated', 'target_absent']),
  generated: Object.freeze(['validated', 'rejected', 'stale_source', 'target_absent']),
  validated: Object.freeze(['queued', 'stale_source', 'target_absent']),
  queued: Object.freeze(['applied', 'stale_source', 'target_absent']),
  applied: Object.freeze(['stale_source', 'target_absent']),
  rejected: Object.freeze([]),
  stale_source: Object.freeze([]),
  target_absent: Object.freeze(['missing']),
});

function validateState(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !STATE_SET.has(value)) {
    throw new TypeError('translation journal v2 state is invalid');
  }
  return value;
}

function validateEventShape(event) {
  assertTranslationPlainObjectV2(event, 'translation journal v2 event');
  assertTranslationExactKeysV2(event, EVENT_KEYS, 'translation journal v2 event');
  if (event.schemaVersion !== TRANSLATION_JOURNAL_V2_SCHEMA_VERSION) {
    throw new TypeError('unsupported translation journal v2 event schema');
  }
  if (typeof event.attemptKey !== 'string' || !ATTEMPT_PATTERN.test(event.attemptKey)) {
    throw new TypeError('translation journal v2 attemptKey is invalid');
  }
  const fromState = validateState(event.fromState, { nullable: true });
  const toState = validateState(event.toState);
  if (event.candidateId !== null
    && (typeof event.candidateId !== 'string' || !CANDIDATE_PATTERN.test(event.candidateId))) {
    throw new TypeError('translation journal v2 candidateId is invalid');
  }
  if (typeof event.eventId !== 'string' || !/^translation-event:v2:[a-f0-9]{64}$/.test(event.eventId)) {
    throw new TypeError('translation journal v2 eventId is invalid');
  }
  const expectedId = `translation-event:v2:${digestTranslationDocumentV2({
    attemptKey: event.attemptKey,
    candidateId: event.candidateId,
    fromState,
    schemaVersion: event.schemaVersion,
    toState,
  })}`;
  if (event.eventId !== expectedId) throw new TypeError('translation journal v2 eventId does not match');
  return deepFreezeTranslationV2({ ...event });
}

function applyEvent(stateByAttempt, event) {
  const current = stateByAttempt.get(event.attemptKey) ?? { state: null, candidateId: null };
  if (event.fromState !== current.state) {
    throw new TypeError('translation journal v2 event has a stale fromState');
  }
  if (current.state === null) {
    if (event.toState !== 'missing' || event.candidateId !== null) {
      throw new TypeError('translation journal v2 attempts must start missing');
    }
  } else if (!TRANSITIONS[current.state].includes(event.toState)) {
    throw new TypeError(`illegal translation journal v2 transition ${current.state} -> ${event.toState}`);
  }
  if (event.toState === 'generated' && event.candidateId === null) {
    throw new TypeError('generated translation journal v2 state requires a candidate');
  }
  if (['validated', 'queued', 'applied', 'rejected'].includes(event.toState)
    && (event.candidateId === null || event.candidateId !== current.candidateId)) {
    throw new TypeError('translation journal v2 candidate changed within an attempt');
  }
  if (['stale_source', 'target_absent'].includes(event.toState)
    && event.candidateId !== current.candidateId) {
    throw new TypeError('translation journal v2 terminal state changed its candidate');
  }
  if (event.toState === 'missing' && event.candidateId !== null) {
    throw new TypeError('missing translation journal v2 state cannot retain a candidate');
  }
  stateByAttempt.set(event.attemptKey, {
    state: event.toState,
    candidateId: event.candidateId,
  });
}

export function createTranslationJournalEventV2(input) {
  assertTranslationPlainObjectV2(input, 'translation journal v2 event input');
  assertTranslationExactKeysV2(input, CREATE_EVENT_KEYS, 'translation journal v2 event input');
  const event = {
    schemaVersion: TRANSLATION_JOURNAL_V2_SCHEMA_VERSION,
    attemptKey: input.attemptKey,
    candidateId: input.candidateId,
    fromState: input.fromState,
    toState: input.toState,
  };
  return validateEventShape({
    ...event,
    eventId: `translation-event:v2:${digestTranslationDocumentV2(event)}`,
  });
}

export function createEmptyTranslationJournalV2() {
  return deepFreezeTranslationV2({
    schemaVersion: TRANSLATION_JOURNAL_V2_SCHEMA_VERSION,
    events: [],
  });
}

export function replayTranslationJournalV2(events) {
  if (!Array.isArray(events)) throw new TypeError('translation journal v2 replay input must be an array');
  const stateByAttempt = new Map();
  const eventById = new Map();
  const canonicalEvents = [];
  for (const rawEvent of events) {
    const event = validateEventShape(rawEvent);
    const existing = eventById.get(event.eventId);
    if (existing) {
      if (canonicalTranslationJsonV2(existing) !== canonicalTranslationJsonV2(event)) {
        throw new TypeError('translation journal v2 eventId collision');
      }
      continue;
    }
    applyEvent(stateByAttempt, event);
    eventById.set(event.eventId, event);
    canonicalEvents.push(event);
  }
  return deepFreezeTranslationV2({
    schemaVersion: TRANSLATION_JOURNAL_V2_SCHEMA_VERSION,
    events: canonicalEvents,
  });
}

export function validateTranslationJournalV2(journal) {
  assertTranslationPlainObjectV2(journal, 'translation journal v2');
  assertTranslationExactKeysV2(journal, JOURNAL_KEYS, 'translation journal v2');
  if (journal.schemaVersion !== TRANSLATION_JOURNAL_V2_SCHEMA_VERSION) {
    throw new TypeError('unsupported translation journal v2 schema');
  }
  const validated = replayTranslationJournalV2(journal.events);
  if (validated.events.length !== journal.events.length) {
    throw new TypeError('stored translation journal v2 contains duplicate events');
  }
  return validated;
}

export function appendTranslationJournalEventV2(journal, event) {
  const validatedJournal = validateTranslationJournalV2(journal);
  const validatedEvent = validateEventShape(event);
  const existing = validatedJournal.events.find((item) => item.eventId === validatedEvent.eventId);
  if (existing) {
    if (canonicalTranslationJsonV2(existing) !== canonicalTranslationJsonV2(validatedEvent)) {
      throw new TypeError('translation journal v2 eventId collision');
    }
    return validatedJournal;
  }
  return replayTranslationJournalV2([...validatedJournal.events, validatedEvent]);
}

export function getTranslationJournalStateV2(journal, attemptKey) {
  const validatedJournal = validateTranslationJournalV2(journal);
  if (typeof attemptKey !== 'string' || !ATTEMPT_PATTERN.test(attemptKey)) {
    throw new TypeError('translation journal v2 attemptKey is invalid');
  }
  let state = null;
  let candidateId = null;
  for (const event of validatedJournal.events) {
    if (event.attemptKey === attemptKey) {
      state = event.toState;
      candidateId = event.candidateId;
    }
  }
  return Object.freeze({ state, candidateId });
}

export function serializeTranslationJournalV2(journal) {
  return `${canonicalTranslationJsonV2(validateTranslationJournalV2(journal))}\n`;
}
