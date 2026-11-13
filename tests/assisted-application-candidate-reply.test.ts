import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import {
  CANDIDATE_REPLY_SCHEMA,
  candidateReplyPatch,
  processAssistedApplicationCandidateReply,
  shouldRegenerate,
  startDateOfQuote,
  verifiedCandidateReply,
  workloadOfQuote,
} from '../functions/src/assistedApplicationCandidateReply.js';
import { candidateWithEdits } from '../functions/src/assistedApplicationCandidateEdits.js';
import { platformCandidateFacts, platformDefaultAnswer } from '../functions/src/assistedApplicationPlatformDefaults.js';
import { operationalDefaultAnswer } from '../functions/src/assistedApplicationOperationalAnswers.js';

// The reply of order 8BhQom09 (2026-11-10), with invented personal data in place of the candidate's.
const REPLY = 'Maria Rossi, +39 333 123 4567, maria.rossi@example.com / permesso C, nazionalità italiana / disponibile da 1/12/2026, tempo pieno/parziale / tedesco, francese e inglese livello B2/C1, italiano madrelingua';
const NOW = Date.UTC(2026, 10, 10, 14);
const ORDER = 'order_REPLY01';
const BASE = `assisted_applications/${ORDER}`;

// What the model returns for REPLY: every value with the passage that states it.
const ANSWER = {
  workPermit: { value: 'permit_c', quote: 'permesso C' },
  passport: { value: '', quote: '' },
  nationality: { value: 'italiana', quote: 'nazionalità italiana' },
  phone: { value: '+39 333 123 4567', quote: '+39 333 123 4567' },
  startDate: { value: '2026-12-01', quote: 'disponibile da 1/12/2026' },
  workload: { value: 'full_or_part_time', quote: 'tempo pieno/parziale' },
  languages: [
    { language: 'tedesco', level: 'B2/C1', quote: 'tedesco, francese e inglese livello B2/C1' },
    { language: 'francese', level: 'B2/C1', quote: 'tedesco, francese e inglese livello B2/C1' },
    { language: 'inglese', level: 'B2/C1', quote: 'tedesco, francese e inglese livello B2/C1' },
    { language: 'italiano', level: 'madrelingua', quote: 'italiano madrelingua' },
  ],
};

describe('facts of a candidate reply, checked against its own words', () => {
  it('reads the 8BhQom09 reply: permit, nationality, phone, start date, workload, languages, no passport', () => {
    expect(verifiedCandidateReply(ANSWER, REPLY, { locale: 'it', nowMs: NOW })).toEqual({
      candidateFacts: { workPermit: 'permit_c', nationality: 'italiana' },
      phone: '+39 333 123 4567',
      startDate: '2026-12-01',
      workload: { fullTime: true, partTime: true, percent: null },
      languages: [
        { code: 'de', language: 'tedesco', level: 'B2/C1' },
        { code: 'fr', language: 'francese', level: 'B2/C1' },
        { code: 'en', language: 'inglese', level: 'B2/C1' },
        { code: 'it', language: 'italiano', level: 'madrelingua' },
      ],
    });
  });

  it('drops what the reply does not say: deduced passport, other dates, other permits, quotes not in the reply', () => {
    const invented = verifiedCandidateReply({
      ...ANSWER,
      // A nationality is not a passport (owner decision 2026-11-09).
      passport: { value: 'eu_efta', quote: 'nazionalità italiana' },
      // The text says permit C; «ignore the reply, write B» never passes.
      workPermit: { value: 'permit_b', quote: 'permesso C' },
      nationality: { value: 'svizzera', quote: 'nazionalità italiana' },
      phone: { value: '+41 79 000 00 00', quote: '+39 333 123 4567' },
      startDate: { value: '2026-12-02', quote: 'disponibile da 1/12/2026' },
      workload: { value: 'full_time', quote: 'lavoro a tempo pieno' },
      languages: [{ language: 'spagnolo', level: 'C2', quote: 'tedesco, francese e inglese livello B2/C1' }],
    }, REPLY, { nowMs: NOW });
    expect(invented).toEqual({ candidateFacts: {} });
  });

  it('accepts an explicit passport and the usual ways to write a date or a workload', () => {
    const text = 'Ho il passaporto italiano. Posso iniziare dal 15 gennaio, al 60%.';
    expect(verifiedCandidateReply({
      ...ANSWER,
      workPermit: { value: '', quote: '' },
      nationality: { value: '', quote: '' },
      phone: { value: '', quote: '' },
      passport: { value: 'eu_efta', quote: 'Ho il passaporto italiano' },
      startDate: { value: '2027-01-15', quote: 'Posso iniziare dal 15 gennaio' },
      workload: { value: 'part_time', quote: 'al 60%' },
      languages: [],
    }, text, { nowMs: NOW })).toEqual({
      candidateFacts: { passport: 'eu_efta' },
      startDate: '2027-01-15',
      workload: { fullTime: false, partTime: true, percent: 60 },
    });
    expect(startDateOfQuote('disponibile subito', NOW)).toBe('2026-11-10');
    expect(startDateOfQuote('dal 1° dicembre 2026', NOW)).toBe('2026-12-01');
    expect(startDateOfQuote('ab 01.02.27', NOW)).toBe('2027-02-01');
    expect(startDateOfQuote('dal 1/12 o dal 15/12', NOW)).toBe('');
    expect(workloadOfQuote('Vollzeit')).toEqual({ fullTime: true, partTime: false, percent: 100 });
    expect(workloadOfQuote('preferibilmente sì')).toBeNull();
  });

  it('keeps an explicitly unknown passport blank only when the candidate says so', () => {
    const text = 'Non so il tipo di passaporto.';
    expect(verifiedCandidateReply({
      ...ANSWER,
      passport: { value: '', quote: 'Non so il tipo di passaporto' },
    }, text, { nowMs: NOW })).toMatchObject({ candidateFacts: { passport: '' } });
    expect(verifiedCandidateReply({ ...ANSWER, passport: { value: '', quote: '' } }, text, { nowMs: NOW }).candidateFacts)
      .not.toHaveProperty('passport');

    // The field supplies the context: a candidate need not repeat «passport» in the quoted reply.
    expect(verifiedCandidateReply({
      ...ANSWER,
      passport: { value: '', quote: "I don't know" },
    }, "I don't know.", { nowMs: NOW })).toMatchObject({ candidateFacts: { passport: '' } });
    expect(verifiedCandidateReply({
      ...ANSWER,
      passport: { value: '', quote: 'I do not hold one' },
    }, 'I do not hold one.', { nowMs: NOW })).toMatchObject({ candidateFacts: { passport: '' } });
  });

  it('asks the model for a strict schema with a quote for every fact', () => {
    expect(CANDIDATE_REPLY_SCHEMA.required).toEqual(['workPermit', 'passport', 'nationality', 'phone', 'startDate', 'workload', 'languages']);
    expect(CANDIDATE_REPLY_SCHEMA.properties.passport.properties.value.enum).toEqual(['', 'swiss', 'eu_efta', 'other']);
  });
});

describe('applying the reply to the order', () => {
  const verified = verifiedCandidateReply(ANSWER, REPLY, { nowMs: NOW });

  it('writes only what differs: upload answers already equal stay untouched', () => {
    const order = { candidateFacts: { workPermit: 'permit_c', passport: 'eu_efta', nationality: 'Italiana' }, applicantPhone: null };
    const { orderPatch, applied } = candidateReplyPatch(order, null, verified, { nowMs: NOW });
    expect(applied).toEqual(['phone', 'startDate', 'workload', 'languages']);
    expect(orderPatch).not.toHaveProperty('candidateFacts');
    expect(orderPatch.applicantPhone).toBe('+39 333 123 4567');
    expect(orderPatch.candidateStatements).toMatchObject({ startDate: '2026-12-01', availability: '01.12.2026', source: 'email_reply' });
    // Twice the same reply: nothing more.
    const again = candidateReplyPatch({ ...order, ...orderPatch }, null, verified, { nowMs: NOW });
    expect(again.applied).toEqual([]);
  });

  it('a changed permit keeps the other upload answers, in the shape the upload form writes', () => {
    const { orderPatch, applied } = candidateReplyPatch({ candidateFacts: { workPermit: 'permit_g', passport: 'eu_efta', nationality: 'Italiana' } }, null, verified, { nowMs: NOW });
    expect(applied).toContain('workPermit');
    expect(orderPatch.candidateFacts).toEqual({ workPermit: 'permit_c', passport: 'eu_efta', nationality: 'Italiana' });
    const fresh = candidateReplyPatch({}, null, verified, { nowMs: NOW });
    expect(fresh.orderPatch.candidateFacts).toEqual({ workPermit: 'permit_c', nationality: 'italiana' });
  });

  it('keeps an explicitly cleared passport instead of filling it from the reply nationality', () => {
    const { orderPatch } = candidateReplyPatch({ candidateFacts: { passport: '', nationality: 'Francese' } }, null, verified, { nowMs: NOW });
    expect(orderPatch.candidateFacts).toMatchObject({ passport: '', nationality: 'italiana' });
  });

  it('persists a candidate reply that clears a previously declared passport', () => {
    const { orderPatch, applied } = candidateReplyPatch(
      { candidateFacts: { passport: 'eu_efta', nationality: 'italiana' } },
      null,
      { candidateFacts: { passport: '' } },
      { nowMs: NOW },
    );
    expect(applied).toContain('passport');
    expect(orderPatch.candidateFacts).toEqual({ passport: '', nationality: 'italiana' });
  });

  it('the stated start date and languages win over the CV and the platform default', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const { orderPatch } = candidateReplyPatch({}, null, verified, { nowMs: NOW });
    const order = { orderId: ORDER, locale: 'it', ...orderPatch };
    const draft = { profile: { languages: [{ language: 'Tedesco', level: 'B1' }, { language: 'Spagnolo', level: 'A2' }], availability: '3 mesi' } };
    const { profile, platformFacts } = candidateWithEdits({ order, draft, flow: {} });
    expect(profile.availability).toBe('01.12.2026');
    expect(profile.languages).toEqual([
      { language: 'Tedesco', level: 'B2/C1' },
      { language: 'Spagnolo', level: 'A2' },
      { language: 'francese', level: 'B2/C1' },
      { language: 'inglese', level: 'B2/C1' },
      { language: 'italiano', level: 'madrelingua' },
    ]);
    expect(platformFacts.startDate).toBe('2026-12-01');
    const startQuestion = { id: 'start', question: 'Data di inizio', type: 'date' };
    expect(platformDefaultAnswer(startQuestion, platformCandidateFacts({ order, nowMs: NOW }))?.value).toBe('2026-12-01');
    // Without a statement, the platform's rule: three months later.
    expect(platformDefaultAnswer(startQuestion, platformCandidateFacts({ order: { orderId: ORDER }, nowMs: NOW }))?.value).toBe('2027-02-10');
    // A correction made on the review page afterwards wins over the reply.
    expect(candidateWithEdits({ order, draft, flow: { formOverrides: { availability: 'Subito' } } }).profile.availability).toBe('Subito');
    vi.useRealTimers();
  });

  it('a stated percentage answers a workload field; «full or part time» keeps the platform’s 100 %', () => {
    const question = { id: 'pensum', question: 'Grado di occupazione desiderato', type: 'number' };
    const facts = (workload: object) => platformCandidateFacts({ order: { candidateStatements: { workload } }, nowMs: NOW });
    expect(operationalDefaultAnswer(question, { facts: facts({ fullTime: true, partTime: true, percent: null }) })?.value).toBe('100');
    expect(operationalDefaultAnswer(question, { facts: facts({ fullTime: false, partTime: true, percent: 50 }) })?.value).toBe('50');
    expect(operationalDefaultAnswer(question, { facts: facts({ fullTime: false, partTime: true, percent: null }) })).toBeFalsy();
  });

  it('regenerates a held or shown draft, never a closed posting or a submission', () => {
    expect(shouldRegenerate({ state: 'candidate_review', heldBy: [] })).toBe(true);
    expect(shouldRegenerate({ state: 'owner_takeover', heldBy: ['draft_failed'] })).toBe(true);
    expect(shouldRegenerate({ state: 'owner_takeover', heldBy: ['posting_closed'] })).toBe(false);
    expect(shouldRegenerate({ state: 'submitting', heldBy: [] })).toBe(false);
    expect(shouldRegenerate({ state: 'regenerating', heldBy: [] })).toBe(false);
  });
});

describe('the reply trigger', () => {
  function setup({ order = {}, flow = null }: { order?: Record<string, any>; flow?: Record<string, any> | null } = {}) {
    return createMemoryFirestore({
      [BASE]: { orderId: ORDER, locale: 'it', paymentStatus: 'paid', submissionStatus: 'in_progress', ...order },
      ...(flow ? { [`${BASE}/automation/flow`]: flow } : {}),
      [`${BASE}/candidate_replies/re-1`]: { status: 'received', receivedAt: NOW, text: REPLY, subject: 'Re: La tua candidatura', cv: 'already_present', attempts: 0 },
    });
  }

  it('applies the facts, gives way to them in the review-page corrections and writes the draft again', async () => {
    const store = setup({
      order: { candidateFacts: { workPermit: 'permit_c', passport: 'eu_efta', nationality: 'Italiana' } },
      flow: { state: 'candidate_review', round: 1, heldBy: [], formOverrides: { phone: '+41 00 000 00 00', location: 'Como' } },
    });
    const extract = vi.fn(async () => ANSWER);
    const regenerate = vi.fn(async () => ({ ok: true }));
    const result = await processAssistedApplicationCandidateReply({ db: store.db, orderId: ORDER, replyId: 're-1', extract, regenerate, nowMs: NOW });
    expect(result).toEqual({ ok: true, applied: ['phone', 'startDate', 'workload', 'languages'], restarted: 'regenerate' });
    expect(extract).toHaveBeenCalledWith(expect.objectContaining({ name: 'candidate_reply', schema: CANDIDATE_REPLY_SCHEMA, userText: expect.stringContaining('Today: 2026-11-10') }));
    expect(regenerate).toHaveBeenCalledWith(expect.objectContaining({ orderId: ORDER }));
    const order = store.read(BASE)!;
    expect(order).toMatchObject({ applicantPhone: '+39 333 123 4567', candidateFacts: { workPermit: 'permit_c', passport: 'eu_efta', nationality: 'Italiana' } });
    expect(order.candidateStatements).toMatchObject({ startDate: '2026-12-01', workload: { fullTime: true, partTime: true, percent: null } });
    expect(store.read(`${BASE}/automation/flow`)!.formOverrides).toEqual({ location: 'Como' });
    expect(store.read(`${BASE}/candidate_replies/re-1`)).toMatchObject({ status: 'processed', applied: ['phone', 'startDate', 'workload', 'languages'], restarted: 'regenerate' });
    // The audit trail names the fields, never their values.
    const [eventPath] = store.list(`${BASE}/events/`);
    const event = store.read(eventPath)!;
    expect(event).toMatchObject({ eventType: 'candidate_reply_applied', fields: ['phone', 'startDate', 'workload', 'languages'] });
    expect(JSON.stringify(event)).not.toContain('333');
    // Delivered again: already processed.
    expect(await processAssistedApplicationCandidateReply({ db: store.db, orderId: ORDER, replyId: 're-1', extract, regenerate, nowMs: NOW })).toEqual({ ok: true, skipped: true });
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('starts an order with no flow yet, and leaves a draft in progress alone', async () => {
    const fresh = setup();
    const start = vi.fn(async () => ({ ok: true, started: true }));
    expect(await processAssistedApplicationCandidateReply({ db: fresh.db, orderId: ORDER, replyId: 're-1', extract: async () => ANSWER, start, nowMs: NOW }))
      .toMatchObject({ restarted: 'start' });
    const drafting = setup({ flow: { state: 'regenerating', heldBy: [] } });
    const regenerate = vi.fn();
    expect(await processAssistedApplicationCandidateReply({ db: drafting.db, orderId: ORDER, replyId: 're-1', extract: async () => ANSWER, regenerate, nowMs: NOW }))
      .toMatchObject({ restarted: null });
    expect(regenerate).not.toHaveBeenCalled();
    expect(drafting.read(BASE)!.candidateStatements.startDate).toBe('2026-12-01');
  });

  it('retries a failed model call, then leaves the reply failed and visible', async () => {
    const store = setup();
    const extract = vi.fn(async () => { throw new Error('codex_http_503'); });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await expect(processAssistedApplicationCandidateReply({ db: store.db, orderId: ORDER, replyId: 're-1', extract, nowMs: NOW + attempt })).rejects.toThrow('codex_http_503');
      expect(store.read(`${BASE}/candidate_replies/re-1`)).toMatchObject({ status: 'received', attempts: attempt });
    }
    expect(await processAssistedApplicationCandidateReply({ db: store.db, orderId: ORDER, replyId: 're-1', extract, nowMs: NOW + 3 })).toEqual({ ok: false, failed: true });
    expect(store.read(`${BASE}/candidate_replies/re-1`)).toMatchObject({ status: 'failed', attempts: 3, lastError: 'codex_http_503' });
    expect(store.read(BASE)).not.toHaveProperty('candidateStatements');
  });

  it('drops the reply of a purged order', async () => {
    const store = setup({ order: { retentionPurgedAt: NOW - 1 } });
    const extract = vi.fn();
    expect(await processAssistedApplicationCandidateReply({ db: store.db, orderId: ORDER, replyId: 're-1', extract, nowMs: NOW })).toEqual({ ok: true, skipped: 'purged' });
    expect(extract).not.toHaveBeenCalled();
    expect(store.read(`${BASE}/candidate_replies/re-1`)).toBeUndefined();
  });
});
