// Owner decision 2026-11-11: «aggiungiamo ai termini che il rimborso non è mai consentito una volta che il
// processo è stato avviato o trova la forma migliore».
// The process starts when the automated flow is created (startAutomation: after the payment and the verified
// CV, the first draft is dispatched). Under the Terms 6.5 the candidate accepts with the mandate v3 (and for
// every application of the automated search), nothing is refunded by itself once it started: a posting the
// employer closed or withdrew withdraws the application, as PR #18084 does for a round that waited for the
// candidate, with one e-mail and no refund. Before the start, and for an order under the older Terms, nothing
// changes. Every order, name, posting and address here is invented.
import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { CANDIDATE_REVIEW_MS, HELD_REMINDERS_AFTER_MS, employerWithdrawalPending, transition as flowTransition } from '../functions/src/assistedApplicationFlow.js';
import { applyAutomationEvent as applyEvent, runAutomationSweep as sweep } from '../functions/src/assistedApplicationAutomation.js';
import { runAutomationEffect } from '../functions/src/assistedApplicationAutomationEffects.js';
import { buildCandidateAutomationEmail, buildOwnerAutomationEmail, describeTakeover } from '../functions/src/assistedApplicationAutomationEmails.js';
import {
  ASSISTED_APPLICATION_CONSENT_VERSIONS,
  NO_REFUND_AFTER_START_CONSENT_VERSION,
  refundEndsAtStart,
} from '../functions/src/assistedApplicationConstants.js';
import { EMPLOYER_WITHDRAWAL_REASON } from '../functions/src/assistedApplicationEmployerWithdrawal.js';
import { ASSISTED_APPLICATION_CONSENT_VERSION } from '../services/assistedApplicationExperiment';
import { getTermsLegalDocument } from '../services/legal/terms';
import itCore from '../services/locales/it-core';
import enCore from '../services/locales/en-core';
import deCore from '../services/locales/de-core';
import frCore from '../services/locales/fr-core';

// The modules are JavaScript with JSDoc defaults narrower than their contracts: called loosely here.
const transition: (...args: any[]) => any = flowTransition as any;
const applyAutomationEvent: (...args: any[]) => Promise<any> = applyEvent as any;
const runAutomationSweep: (...args: any[]) => Promise<any> = sweep as any;

const T0 = Date.UTC(2026, 10, 12, 8, 0, 0);
const HOUR = 60 * 60 * 1000;
const ORDER = 'assisted_applications/o1';
const FLOW = `${ORDER}/automation/flow`;
const draft = { status: 'ready', round: 1, job: { source: 'job_detail', title: 'Sachbearbeiterin' }, channel: { type: 'portal' }, factCheck: { ok: true, unsupported: [] }, questions: [] as any[] };
const newTerms = { consentVersion: 'assisted-application-v3', consentedAt: T0 - HOUR };
const olderTerms = { consentVersion: 'assisted-application-v2', consentedAt: T0 - HOUR };
const conciergeChild = { billingMode: 'application_concierge', consentVersion: 'assisted-application-v2', consentedAt: T0 - HOUR };
const OPEN_STATES = ['drafting', 'regenerating', 'owner_review', 'candidate_review', 'submitting'];
// Nobody waited for the candidate in this round: the case the older Terms refunded by themselves.
const notWaited = (state: string) => ({ state, round: 1, shownRounds: state === 'drafting' ? [] : [1], heldBy: [] });
const kinds = (effects: any[]) => effects.map((effect: any) => (effect.type === 'email' ? `${effect.kind}${effect.reason ? `:${effect.reason}` : ''}` : effect.type));

describe('the rule follows the Terms the candidate accepted', () => {
  it('holds from the mandate v3, which the page now asks for, and for every application of the automated search', () => {
    expect(NO_REFUND_AFTER_START_CONSENT_VERSION).toBe('assisted-application-v3');
    expect(ASSISTED_APPLICATION_CONSENT_VERSION).toBe(NO_REFUND_AFTER_START_CONSENT_VERSION);
    expect(ASSISTED_APPLICATION_CONSENT_VERSIONS.at(-1)).toBe(NO_REFUND_AFTER_START_CONSENT_VERSION);
    expect(refundEndsAtStart(newTerms)).toBe(true);
    expect(refundEndsAtStart(conciergeChild)).toBe(true);
    // The older mandates, a mandate with no time, a CV sent by e-mail with no mandate: the older Terms.
    for (const order of [olderTerms, { consentVersion: 'assisted-application-v1', consentedAt: T0 }, { consentVersion: 'assisted-application-v3', consentedAt: null }, {}, null]) {
      expect(refundEndsAtStart(order), JSON.stringify(order)).toBe(false);
    }
  });
});

describe('after the start, under the new Terms: no refund', () => {
  it('withdraws the application on the posting\'s own word, whether or not the round waited, and refunds nothing', () => {
    for (const order of [newTerms, conciergeChild]) {
      for (const state of OPEN_STATES) {
        for (const reason of ['http_gone', 'expired_body', 'ats_api_closed']) {
          const step = transition(notWaited(state), { type: 'posting_closed', reason }, { order, draft, nowMs: T0 });
          expect(step.flow, `${state} ${reason}`).toMatchObject({ state: 'withdrawn', withdrawnReason: EMPLOYER_WITHDRAWAL_REASON, withdrawalEvidence: { kind: reason } });
          expect(step.effects, `${state} ${reason}`).toEqual([{ type: 'email', kind: 'candidate_posting_withdrawn' }]);
        }
      }
    }
  });

  it('takes the employer\'s own e-mail as proof without a wait, never over a send that may have left', () => {
    const mail = { type: 'posting_closed', reason: 'employer_mail', closedAt: T0 - HOUR };
    expect(transition(notWaited('submitting'), mail, { order: newTerms, draft, nowMs: T0 }).flow).toMatchObject({ state: 'withdrawn', withdrawalEvidence: { kind: 'employer_mail', source: 'employer_mail' } });
    expect(transition(notWaited('submitting'), mail, { order: newTerms, draft, nowMs: T0, sendMayHaveLeft: true }).ignored).toBe('mail_closure_not_waited');
  });

  it('hands a reading of ours, or a send that may have left, to the owner: nothing withdrawn, nothing refunded', () => {
    const held = { state: 'owner_takeover', heldBy: ['posting_closed'] };
    for (const event of [{ type: 'posting_closed' }, { type: 'posting_closed', reason: 'dataset' }, { type: 'posting_closed', reason: 'listing_page' }]) {
      const step = transition(notWaited('submitting'), event, { order: newTerms, draft, nowMs: T0 });
      expect(step.flow).toMatchObject(held);
      expect(kinds(step.effects)).toEqual(['owner_takeover:posting_closed_after_start']);
    }
    // A round that waited, read by us only: the new Terms decide, not the wait.
    const waiting = { state: 'candidate_review', round: 1, shownRounds: [1], heldBy: ['question:q1'], heldSince: T0, reminderAt: T0 + HELD_REMINDERS_AFTER_MS[0] };
    expect(kinds(transition(waiting, { type: 'posting_closed' }, { order: newTerms, draft, nowMs: T0 }).effects)).toEqual(['owner_takeover:posting_closed_after_start']);
    const mayHaveLeft = transition(notWaited('submitting'), { type: 'posting_closed', reason: 'http_gone' }, { order: newTerms, draft, nowMs: T0, sendMayHaveLeft: true });
    expect(mayHaveLeft.flow).toMatchObject({ ...held, postingClosure: { code: 'http_gone' } });
    expect(kinds(mayHaveLeft.effects)).toEqual(['owner_takeover:posting_closed_after_start']);
    expect(describeTakeover({ reason: 'posting_closed_after_start' }).reason).toContain('NESSUN rimborso automatico');
  });

  it('withdraws, on the sweep\'s look before a reminder, a review the candidate had not been asked anything in', () => {
    const review = { state: 'candidate_review', round: 1, shownRounds: [1], heldBy: [], deadlineAt: T0 + CANDIDATE_REVIEW_MS, reminderAt: T0 + HOUR };
    const tick = { type: 'tick', postingExpired: true, postingClosure: { reason: 'http_gone' } };
    const withdrawn = transition(review, tick, { order: newTerms, draft, nowMs: T0 + HOUR });
    expect(withdrawn.flow).toMatchObject({ state: 'withdrawn', withdrawnReason: EMPLOYER_WITHDRAWAL_REASON });
    expect(withdrawn.effects).toEqual([{ type: 'email', kind: 'candidate_posting_withdrawn' }]);
    // Under the older Terms the same look keeps today's silent wait, for the owner to decide.
    const older = transition(review, tick, { order: olderTerms, draft, nowMs: T0 + HOUR });
    expect(older.flow).toMatchObject({ state: 'candidate_review', postingExpiredAt: T0 + HOUR });
    expect(older.effects).toEqual([{ type: 'email', kind: 'owner_posting_expired', since: T0 + HOUR }]);
  });

  it('closes an order held for a closed ad once the proof is recorded, without a wait', () => {
    const held = { state: 'owner_takeover', round: 1, heldBy: ['posting_closed'], postingClosure: { code: 'http_gone', source: 'posting_page', at: T0 } };
    expect(employerWithdrawalPending(held, newTerms)).toBe(true);
    expect(employerWithdrawalPending(held, olderTerms)).toBe(false);
    expect(employerWithdrawalPending(held)).toBe(false);
    expect(transition(held, { type: 'posting_closure_recorded' }, { order: newTerms, draft, nowMs: T0 + HOUR }).flow).toMatchObject({ state: 'withdrawn' });
    expect(transition(held, { type: 'posting_closure_recorded' }, { order: olderTerms, draft, nowMs: T0 + HOUR }).ignored).toBe('no_recorded_withdrawal');
  });

  it('writes the withdrawal on the order, with no refund and one e-mail', async () => {
    const store = createMemoryFirestore({
      [ORDER]: { paymentStatus: 'paid', submissionStatus: 'in_progress', automationState: 'drafting', jobId: 'esempio-1', companyName: 'Esempio AG', jobTitle: 'Sachbearbeiterin', ...newTerms },
      [FLOW]: { state: 'drafting', round: 1, shownRounds: [], heldBy: [], startedAt: T0 - HOUR, dispatch: { mode: 'draft', round: 1, requestedAt: T0 - HOUR } },
    });
    const sent: string[] = [];
    const issueRefund = vi.fn(async () => ({ status: 200 }));
    const runEffect = (context: any) => runAutomationEffect(context, { issueRefund, sendNotification: async ({ key }: any) => { sent.push(key); return { ok: true, key }; } });
    const result = await applyAutomationEvent({ db: store.db, orderId: 'o1', event: { type: 'posting_closed', reason: 'http_gone', round: 1 }, actor: 'runner', runEffect, nowMs: T0 });
    expect(result).toMatchObject({ ok: true });
    expect(store.read(ORDER)).toMatchObject({ submissionStatus: 'withdrawn', automationState: 'withdrawn', withdrawalReason: EMPLOYER_WITHDRAWAL_REASON, automationRefundDueAt: null });
    expect(store.read(ORDER)?.automationRefund).toBeUndefined();
    expect(issueRefund).not.toHaveBeenCalled();
    expect(sent).toEqual(['auto_candidate_posting_withdrawn']);
  });

  it('never refunds by itself through the effect or the sweep\'s retry, even when asked', async () => {
    for (const terms of [newTerms, conciergeChild]) {
      const store = createMemoryFirestore({
        [ORDER]: { paymentStatus: 'paid', submissionStatus: 'in_progress', ...terms, automationRefund: { status: 'retrying', attempts: 1, reason: 'posting_closed' }, automationRefundDueAt: T0 - 1 },
        [FLOW]: { state: 'owner_takeover', round: 1, heldBy: ['posting_closed'] },
      });
      const issueRefund = vi.fn(async () => ({ status: 200 }));
      const sendNotification = vi.fn(async ({ key }: any) => ({ ok: true, key }));
      const runEffect = (context: any) => runAutomationEffect(context, { issueRefund, sendNotification });
      expect(await runEffect({ db: store.db, orderId: 'o1', effect: { type: 'refund', reason: 'posting_closed', notify: 'candidate_posting_closed' }, flow: { round: 1 }, nowMs: T0 })).toEqual({ ok: false, skipped: 'no_refund_after_start' });
      expect(store.read(ORDER)?.automationRefundDueAt).toBeNull();
      await store.db.collection('assisted_applications').doc('o1').set({ automationRefundDueAt: T0 - 1 }, { merge: true });
      await runAutomationSweep({ db: store.db, runEffect, nowMs: T0 });
      expect(issueRefund).not.toHaveBeenCalled();
      expect(sendNotification).not.toHaveBeenCalled();
      expect(store.read(ORDER)?.automationRefundDueAt).toBeNull();
    }
  });
});

describe('before the start, or under the older Terms: as before', () => {
  it('changes nothing before the start: no flow, no automatic refund, the manual refund is the owner\'s', async () => {
    const store = createMemoryFirestore({ [ORDER]: { paymentStatus: 'paid', submissionStatus: 'awaiting_upload', ...newTerms } });
    const runEffect = vi.fn(async () => ({ ok: true }));
    expect(await applyAutomationEvent({ db: store.db, orderId: 'o1', event: { type: 'posting_closed', reason: 'http_gone' }, actor: 'runner', runEffect, nowMs: T0 })).toMatchObject({ ok: false, ignored: 'no_flow' });
    expect(runEffect).not.toHaveBeenCalled();
    expect(store.read(ORDER)).toMatchObject({ paymentStatus: 'paid', submissionStatus: 'awaiting_upload' });
  });

  it('still refunds by itself an ad that closed with nobody waiting, for an order under the older Terms', async () => {
    const refund = ['refund', 'owner_takeover:posting_closed'];
    for (const state of OPEN_STATES) {
      expect(kinds(transition(notWaited(state), { type: 'posting_closed', reason: 'http_gone' }, { order: olderTerms, draft, nowMs: T0 }).effects), state).toEqual(refund);
      expect(kinds(transition(notWaited(state), { type: 'posting_closed' }, { order: {}, draft, nowMs: T0 }).effects), state).toEqual(refund);
    }
    const store = createMemoryFirestore({ [ORDER]: { paymentStatus: 'paid', submissionStatus: 'in_progress', ...olderTerms } });
    const issueRefund = vi.fn(async () => ({ status: 200 }));
    await runAutomationEffect({ db: store.db, orderId: 'o1', effect: { type: 'refund', reason: 'posting_closed' }, flow: { round: 1 }, nowMs: T0 }, { issueRefund, sendNotification: async () => ({ ok: true }) });
    expect(issueRefund).toHaveBeenCalledTimes(1);
  });
});

describe('what the candidate and the owner read', () => {
  const base = { name: 'Maria Rossi', job: 'Sachbearbeiterin', company: 'Esempio AG', jobUrl: 'https://jobs.example.com/1', reviewUrl: 'https://example.com/review', orderId: 'o1' };

  it('cites, in the withdrawal e-mail, the clause the candidate accepted', () => {
    const afterStart = { it: 'una volta avviata la preparazione della candidatura l’importo non è rimborsabile', de: 'sobald die Vorbereitung der Bewerbung begonnen hat', fr: 'une fois la préparation de la candidature commencée, le montant n’est pas remboursable', en: 'once the preparation of the application has started the amount is non-refundable' };
    const waited = { it: 'mentre la candidatura attende documenti o risposte', de: 'während die Bewerbung auf Unterlagen oder Antworten wartet', fr: 'pendant que la candidature attend des documents', en: 'while the application is waiting for documents or answers' };
    for (const locale of ['it', 'de', 'fr', 'en'] as const) {
      const now = buildCandidateAutomationEmail('candidate_posting_withdrawn', { ...base, locale, refundEndsAtStart: true }).text;
      expect(now, locale).toContain(afterStart[locale]);
      expect(now, locale).not.toContain(waited[locale]);
      expect(buildCandidateAutomationEmail('candidate_posting_withdrawn', { ...base, locale }).text, locale).toContain(waited[locale]);
    }
  });

  it('tells the owner not to refund an order under the new Terms', () => {
    const vars = { job: 'Sachbearbeiterin', company: 'Esempio AG', orderId: 'o1' };
    const now = buildOwnerAutomationEmail('owner_posting_expired', { ...vars, refundEndsAtStart: true }).text;
    expect(now).toContain('non rimborsare');
    expect(now).not.toContain('rimborsa dalla coda');
    expect(buildOwnerAutomationEmail('owner_posting_expired', vars).text).toContain('rimborsa dalla coda');
  });
});

describe('Terms 6.5 and the mandate say it, in the four languages', () => {
  const clause = (locale: 'it' | 'en' | 'de' | 'fr') => {
    const section = getTermsLegalDocument(locale).sections.find((item) => item.id === 'candidatura-assistita');
    return (section?.blocks || []).map((block: any) => String(block.html || '')).find((html) => html.includes('<strong>6.5')) || '';
  };
  const words = {
    it: ['Il processo si considera avviato quando', 'la redazione della prima bozza', 'Prima dell’avvio puoi chiedere il rimborso dell’intero importo', 'per una causa che dipende da noi, ti rimborsiamo', 'il corrispettivo non è rimborsabile in nessun caso', 'chiuso o ritirato dal datore di lavoro', 'ritiri la candidatura', 'l’azienda non risponde', 'chiedi espressamente che il servizio inizi subito', 'diritto di recesso', 'Restano salvi i diritti inderogabili', 'versione precedente di questi Termini'],
    en: ['The process starts when', 'drafting of the first version', 'Before the process starts, you may request a refund of the full amount', 'for a reason attributable to us, we refund', 'the fee is non-refundable in all cases', 'closed or withdrawn by the employer', 'withdraw the application', 'the company does not reply', 'expressly request that the service start immediately', 'right of withdrawal', 'without prejudice to the mandatory rights', 'earlier version of these Terms'],
    de: ['Der Prozess gilt als begonnen', 'Erstellung des ersten Entwurfs', 'Vor Beginn des Prozesses können Sie die Rückerstattung des vollständigen Betrags verlangen', 'den wir zu vertreten haben, nicht begonnen werden, erstatten wir', 'in keinem Fall erstattungsfähig', 'Stellenangebot schliesst oder zurückzieht', 'die Bewerbung zurückziehen', 'nicht antwortet', 'verlangen Sie ausdrücklich, dass die Dienstleistung sofort beginnt', 'Widerrufsrecht', 'Zwingende Rechte', 'früheren Fassung dieser Bedingungen'],
    fr: ['Le processus est considéré comme commencé', 'la rédaction de la première version', 'Avant le début du processus, vous pouvez demander le remboursement de la totalité du montant', 'qui nous est imputable, nous remboursons', 'n’est remboursable dans aucun cas', 'clôture ou retire l’offre', 'retirez la candidature', 'ne répond pas', 'vous demandez expressément que le service commence immédiatement', 'droit de rétractation', 'Les droits impératifs', 'version antérieure des présentes Conditions'],
  };

  it('writes the clause, and keeps it free of any date', () => {
    for (const [locale, list] of Object.entries(words) as [keyof typeof words, string[]][]) {
      const html = clause(locale);
      for (const sentence of list) expect(html, `${locale}: ${sentence}`).toContain(sentence);
      expect(html, locale).not.toMatch(/rimborsiamo automaticamente|automatically refund|erstatten wir automatisch|remboursons automatiquement/);
      expect(html, locale).not.toMatch(/20\d\d/);
    }
    expect(getTermsLegalDocument('it').updated).toBe('Ultimo aggiornamento: 11 novembre 2026');
    expect(getTermsLegalDocument('en').updated).toBe('Last updated: 11 November 2026');
  });

  it('asks for the express request and the acknowledgement in the mandate, before anything starts', () => {
    const consent = {
      it: [itCore, 'Chiedo espressamente che il servizio inizi subito', 'perdo l’eventuale diritto di recesso', 'punto 6.5 dei Termini'],
      en: [enCore, 'I expressly request that the service start immediately', 'I lose any right of withdrawal', 'section 6.5 of the Terms'],
      de: [deCore, 'Ich verlange ausdrücklich, dass die Dienstleistung sofort beginnt', 'Widerrufsrecht verliere', 'Ziffer 6.5 der Nutzungsbedingungen'],
      fr: [frCore, 'Je demande expressément que le service commence immédiatement', 'je perds tout droit de rétractation', 'point 6.5 des Conditions'],
    } as const;
    for (const [locale, [dictionary, ...sentences]] of Object.entries(consent)) {
      const text = (dictionary as Record<string, string>)['jobBoard.assisted.consent'];
      for (const sentence of sentences) expect(text, `${locale}: ${sentence}`).toContain(sentence);
    }
  });
});
