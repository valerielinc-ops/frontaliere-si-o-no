// @vitest-environment jsdom
/**
 * The `chatbot_question` event must carry no free text at all (issue #5196).
 *
 * This is the test the previous fix could not have. Redaction tests assert that
 * a KNOWN bad shape is stripped, which is only ever as good as the list of
 * shapes someone thought of. This one asserts a property of the emitted event
 * that does not depend on that list: whatever the user typed, none of it comes
 * out. A future gap in `redactPii.ts` cannot make this fail, because the text
 * is not in the payload to begin with.
 *
 * It exercises the REAL `services/analytics.ts` (the suite mocks it globally,
 * so it is unmocked here) and captures at `posthogCapture` — the fan-out point
 * in `log()`. That matters: `log()` hands the SAME params object to PostHog and
 * to Firebase/GA4 one after the other, with no scrubbing layer in between, so
 * asserting on what PostHog receives is asserting on what both vendors receive.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('@/services/analytics');

import { Analytics } from '@/services/analytics';
import { QUESTION_TOPICS } from '@/services/privacy/questionTopic';
import { REDACTION_TOKENS } from '@/services/privacy/redactPii';
import { captureEvent as posthogCapture } from '@/services/posthog';

const posthogMock = vi.mocked(posthogCapture);

/**
 * The payload's own fixed vocabulary: topic names, redaction-kind names, key
 * names, sentinels.
 *
 * The leak check below has to subtract these, and the reason is worth stating
 * because it is the one place this test could be argued to weaken itself. A
 * word that belongs to a closed set appears in the payload BY CONSTRUCTION, for
 * every input, so its presence is not evidence of anything — "My name is John
 * Smith" contains the word "name", and `redacted_kinds: "name"` is the schema
 * saying a name was stripped, not the name. Subtracting a finite, enumerated
 * vocabulary cannot hide a leak of user text: an actual leak would have to
 * consist entirely of words that are already members of this set, in which case
 * it carries no user information either.
 */
const CLOSED_VOCABULARY = new Set<string>([
  ...QUESTION_TOPICS,
  ...Object.keys(REDACTION_TOKENS),
  'none',
  'guest',
  'authed',
  'send',
  'question',
  'topic',
  'length',
  'word',
  'count',
  'redacted',
  'kinds',
  'auth',
  'state',
  'trigger',
]);

/** The params object `log()` handed to BOTH vendors for a given event name. */
function payloadFor(eventName: string): Record<string, unknown> | undefined {
  const call = [...posthogMock.mock.calls].reverse().find((c) => c[0] === eventName);
  return call?.[1] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  posthogMock.mockClear();
});

describe('chatbot_question carries the shape of the question, never the question', () => {
  // Deliberately stuffed with the exact data #5196 was opened about, plus the
  // shapes that walked through the first two versions of the redactor.
  const LOADED = [
    'Nome: Marco Bernasconi, nato il 22/02/1988, Via alla Stampa 11B, 6965 Cadro. Che permesso mi serve?',
    "Je m'appelle François Dupont, 5 rue de la Gare, quel permis frontalier ?",
    'Ich heiße Jürgen Müller, Bahnhofstrasse 12 — wie hoch ist die Quellensteuer?',
    'sono mario rossi, targa TI 123456, passaporto YA1234567, quante tasse pago?',
    'My name is John Smith, 221B Baker Street, john.smith@example.com, AVS 756.1234.5678.97',
  ];

  for (const question of LOADED) {
    it(`emits nothing from: "${question.slice(0, 42)}…"`, () => {
      Analytics.trackChatbotQuestion(question, { auth_state: 'guest', trigger: 'send' });

      const payload = payloadFor('chatbot_question');
      expect(payload, 'no chatbot_question event was emitted').toBeDefined();

      // 1. The field is gone outright.
      expect(payload).not.toHaveProperty('question_text');

      // 2. No value in the payload is, or contains, any word the user typed.
      //    Checked word by word rather than as a whole string, because a
      //    partial leak (a surname on its own, a house number) is the failure
      //    mode that matters and a whole-string compare would miss it.
      const serialised = JSON.stringify(payload).toLowerCase();
      const userWords = question
        .split(/[\s,.:;!?]+/)
        .map((w) => w.replace(/[^\p{L}\p{N}@/]/gu, '').toLowerCase())
        .filter((w) => w.length >= 4)
        .filter((w) => !CLOSED_VOCABULARY.has(w));

      expect(userWords.length, 'the fixture must still have words to check').toBeGreaterThan(3);

      for (const word of userWords) {
        expect(serialised, `leaked "${word}" into the event`).not.toContain(word);
      }
    });
  }

  it('every value it does emit is from a closed set or is a number', () => {
    Analytics.trackChatbotQuestion('Quali documenti servono per il permesso G?', {
      auth_state: 'authed',
      trigger: 'send',
    });
    const payload = payloadFor('chatbot_question')!;

    expect(QUESTION_TOPICS).toContain(payload.question_topic);
    expect(typeof payload.question_length).toBe('number');
    expect(typeof payload.question_word_count).toBe('number');
    expect(typeof payload.redacted_count).toBe('number');
    // `redacted_kinds` is a join of the closed RedactionKind union.
    const KINDS = ['address', 'date', 'email', 'iban', 'id', 'name', 'phone', 'url'];
    for (const k of String(payload.redacted_kinds).split(',')) {
      expect([...KINDS, 'none']).toContain(k);
    }

    // The complete key set — a new key carrying text would have to be added
    // here deliberately, which is the review checkpoint this test exists to be.
    expect(Object.keys(payload).sort()).toEqual(
      [
        'auth_state',
        'question_length',
        'question_topic',
        'question_word_count',
        'redacted_count',
        'redacted_kinds',
        'trigger',
      ].sort(),
    );
  });

  it('still reports WHICH kinds of personal data were present — the signal is kept', () => {
    // Removing the text must not blind the owner to "are users still pasting
    // addresses?". That question stays answerable without holding an address.
    Analytics.trackChatbotQuestion('Mi chiamo Marco Bernasconi, Via alla Stampa 11B, nato il 22/02/1988');
    const payload = payloadFor('chatbot_question')!;
    const reported = String(payload.redacted_kinds).split(',');
    expect(reported).toContain('address');
    expect(reported).toContain('date');
    expect(reported).toContain('name');
    expect(payload.redacted_count).toBeGreaterThan(0);
  });
});

describe('the other free-text sinks are redacted before the same fan-out', () => {
  it('search_term is redacted', () => {
    Analytics.trackSearch('mario.rossi@example.com IBAN CH9300762011623852957', { resultsCount: 0 });
    const payload = payloadFor('search')!;
    expect(String(payload.search_term)).not.toContain('mario.rossi@example.com');
    expect(String(payload.search_term)).not.toContain('CH9300762011623852957');
  });

  it('job-alert keywords are redacted', () => {
    Analytics.trackJobAlertCreated({ keywords: 'infermiere mario.rossi@example.com', location: 'Via alla Stampa 11B' });
    const payload = payloadFor('job_alert_created')!;
    expect(String(payload.alert_keywords)).not.toContain('mario.rossi@example.com');
    expect(String(payload.alert_location)).not.toContain('11B');
  });

  it('the job-alert CTA keyword is redacted — it used to be truncated only', () => {
    Analytics.trackJobAlertCtaShown('sticky_banner', 'infermiere mario.rossi@example.com');
    const payload = payloadFor('job_alert_cta_shown')!;
    expect(String(payload.cta_keyword)).not.toContain('mario.rossi@example.com');
    // The useful part survives, so the field keeps its purpose.
    expect(String(payload.cta_keyword)).toContain('infermiere');
  });
});
