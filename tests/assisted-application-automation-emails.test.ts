import { describe, expect, it } from 'vitest';
import {
  buildCandidateAutomationEmail,
  buildOwnerAutomationEmail,
  describeTakeover,
  formatDeadline,
} from '../functions/src/assistedApplicationAutomationEmails.js';

const DEADLINE = Date.UTC(2026, 8, 30, 19, 30, 0); // 21:30 in Zurich (CEST)
const base = {
  name: 'Maria Rossi',
  job: 'Infermiera',
  company: 'Ospedale',
  jobUrl: 'https://example.ch/job',
  reviewUrl: 'https://frontaliereticino.ch/cerca-lavoro-ticino/?assisted_application_review=ar1.x',
  orderId: 'order_1',
};

describe('automation e-mails', () => {
  it('state the exact automatic-approval time in every language (owner decision)', () => {
    const expectations: Record<string, RegExp> = {
      it: /Se non rispondi entro .*21:30.*la candidatura partirà automaticamente così com’è\./,
      de: /Antwortest du nicht bis .*21:30.*automatisch so versendet\./,
      fr: /Sans réponse de votre part d’ici .*21:30.*partira automatiquement telle quelle\./,
      en: /If you do not reply by .*21:30.*sent automatically as it is\./,
    };
    for (const [locale, pattern] of Object.entries(expectations)) {
      const email = buildCandidateAutomationEmail('candidate_review', { ...base, locale, deadlineAt: DEADLINE });
      expect(email.text).toMatch(pattern);
      expect(email.text).toContain(base.reviewUrl);
      expect(email.html).toContain(base.reviewUrl);
    }
    expect(formatDeadline(DEADLINE, 'it')).toContain('21:30');
  });

  it('never promises an automatic send while questions are open', () => {
    const email = buildCandidateAutomationEmail('candidate_review', { ...base, locale: 'it', held: true, openQuestions: 2, deadlineAt: null });
    expect(email.text).toContain('mi servono alcune informazioni o documenti che solo tu puoi darmi (2)');
    expect(email.text).not.toContain('partirà automaticamente');
  });

  it('reminds a candidate who has not answered, in every language, never promising an automatic send', () => {
    const expectations: Record<string, [RegExp, RegExp]> = {
      it: [/^Promemoria: la tua candidatura per Infermiera aspetta le tue risposte$/, /non può partire finché non mi dai alcune informazioni o documenti/],
      de: [/^Erinnerung: deine Bewerbung für Infermiera wartet auf deine Antworten$/, /kann aber erst raus, wenn du mir/],
      fr: [/^Rappel : votre candidature pour Infermiera attend vos réponses$/, /ne peut pas partir tant que vous ne m’avez pas donné/],
      en: [/^Reminder: your application for Infermiera is waiting for your answers$/, /cannot go out until you give me/],
    };
    for (const [locale, [subject, lead]] of Object.entries(expectations)) {
      const email = buildCandidateAutomationEmail('candidate_questions_reminder', { ...base, locale });
      expect(email.subject).toMatch(subject);
      expect(email.text).toMatch(lead);
      expect(email.text).toContain(base.reviewUrl);
      expect(email.html).toContain(base.reviewUrl);
    }
    expect(buildCandidateAutomationEmail('candidate_questions_reminder', { ...base, locale: 'it' }).text).not.toContain('automaticamente così');
  });

  it('tells Valerie when a candidate has not answered for days', () => {
    const silent = buildOwnerAutomationEmail('owner_candidate_silent', { job: 'Infermiera', company: 'Ospedale', orderId: 'o', days: 5, nudges: 2, candidateEmail: 'candidate@example.com' });
    expect(silent.subject).toBe('[Candidatura] Il candidato non risponde: Infermiera — Ospedale');
    expect(silent.text).toContain('Da 5 giorni la candidatura aspetta risposte che solo il candidato può dare, e ha già ricevuto 2 promemoria.');
    expect(silent.text).toContain('Candidato: candidate@example.com');
    // The lead points to the address: the HTML shows it too (review of #10803).
    expect(silent.html).toContain('mailto:candidate@example.com');
  });

  it('explains the portal handoff and the closed-ad refund', () => {
    const handoff = buildCandidateAutomationEmail('candidate_handoff', { ...base, locale: 'de', reason: 'captcha' });
    expect(handoff.text).toContain('eine Anti-Roboter-Prüfung');
    expect(handoff.text).toContain('«Ich habe die Bewerbung gesendet»');
    // Coop's apprenticeships: the application is a WhatsApp chat from the candidate's phone.
    expect(buildCandidateAutomationEmail('candidate_handoff', { ...base, locale: 'it', reason: 'whatsapp' }).text).toContain('la candidatura si fa solo via WhatsApp, dal tuo telefono');
    expect(buildCandidateAutomationEmail('candidate_handoff', { ...base, locale: 'fr', reason: 'whatsapp' }).text).toContain('uniquement par WhatsApp');
    const closed = buildCandidateAutomationEmail('candidate_posting_closed', { ...base, locale: 'fr', price: '0,99 €' });
    expect(closed.subject).toContain('vous êtes remboursé');
    expect(closed.text).toContain('0,99 €');
    expect(() => buildCandidateAutomationEmail('nope' as any, { ...base, locale: 'it' })).toThrow('unknown_automation_email');
  });

  it('tells Valerie when the draft approves itself, or why it is held', () => {
    const auto = buildOwnerAutomationEmail('owner_review', { job: 'Infermiera', company: 'Ospedale', orderId: 'o', deadlineAt: DEADLINE, flags: [], verdict: 'buono', summary: 'Ok', channel: 'Lever' });
    expect(auto.subject).toBe('[Candidatura] Bozza pronta: Infermiera — Ospedale');
    expect(auto.text).toMatch(/si approva da sola .*21:30/);
    const held = buildOwnerAutomationEmail('owner_review', { job: 'Infermiera', company: 'Ospedale', orderId: 'o', flags: ['fact_check', 'knock_out'] });
    expect(held.subject).toContain('Serve il tuo intervento');
    expect(held.text).toContain('numeri, date o contatti che non compaiono nel CV');
    const takeover = buildOwnerAutomationEmail('owner_takeover', { job: 'Infermiera', company: 'Ospedale', orderId: 'o', reason: 'max_rounds' });
    expect(takeover.text).toContain('rifiutato la bozza per 3 volte');
  });

  it('explains a stopped run in words, with the runner error only as a detail', () => {
    // Trial run 2026-09-30, round 2: the e-mail said only the raw English error.
    const error = 'Codex auth broker rejected the request: Codex CLI timed out after 600000ms';
    const draft = buildOwnerAutomationEmail('owner_takeover', { job: 'Infermiera', company: 'Ospedale', orderId: 'o', reason: error, stage: 'draft', attempts: 3 });
    expect(draft.text).toContain('Motivo: la bozza non è stata generata: Codex non ha risposto in tempo o non era raggiungibile, anche dopo 3 tentativi automatici.');
    expect(draft.text).toContain('«Rigenera»');
    expect(draft.text).toContain(`Dettaglio tecnico: ${error}`);
    expect(draft.html).toContain('Dettaglio tecnico');

    const ambiguous = buildOwnerAutomationEmail('owner_takeover', { job: 'Infermiera', company: 'Ospedale', orderId: 'o', reason: 'email_ambiguous', stage: 'submit', attempts: 1 });
    expect(ambiguous.text).toContain('Motivo: l’invio non è riuscito: non è certo che l’email al datore sia partita');
    expect(ambiguous.text).not.toContain('tentativi');
    expect(ambiguous.text).not.toContain('Dettaglio tecnico');
    expect(describeTakeover({ reason: 'runner_timeout', stage: 'draft', attempts: 2 }).reason).toBe('il runner non ha dato notizie per due volte di seguito');
    // Owner decision 2026-10-01: a portal the robot did not finish comes to Valerie, the candidate does nothing.
    const portal = buildOwnerAutomationEmail('owner_takeover', { job: 'Infermiera', company: 'Ospedale', orderId: 'o', reason: 'portal:captcha', stage: 'submit', attempts: 1 });
    expect(portal.text).toContain('Motivo: l’invio sul portale si è fermato: il portale ha chiesto un controllo anti-robot (CAPTCHA)');
    expect(portal.text).toContain('Il candidato non deve fare nulla');
    expect(portal.text).toContain('«Riprova l’invio automatico»');
    // JOIN, 2026-10-01: a refusal in words is completed by Valerie (the candidate paid for it), with no check for an ambiguous send.
    const refused = describeTakeover({ reason: 'portal_refused', stage: 'submit', attempts: 1 });
    expect(refused.reason).toContain('NON è partita');
    expect(refused.hint).toContain('completala tu sul portale');
    expect(refused.hint).toContain('«Segna come inviata»');
    expect(refused.hint).not.toContain('Affida al candidato');
    expect(refused.hint).not.toContain('prima di inviarla di nuovo');
    expect(describeTakeover({ reason: 'portal_ambiguous', stage: 'submit' }).hint).toContain('prima di inviarla di nuovo');
    expect(describeTakeover({ reason: 'portal:portal_needs_candidate', stage: 'submit' }).reason).toBe('l’invio sul portale si è fermato: il robot non è riuscito a completare una pagina del portale');
    const whatsapp = describeTakeover({ reason: 'portal:whatsapp', stage: 'submit' });
    expect(whatsapp.reason).toContain('solo via WhatsApp');
    expect(whatsapp.hint).toContain('«Affida al candidato»');
    expect(describeTakeover({ reason: 'Unexpected token', stage: 'draft' })).toEqual({
      reason: 'la bozza non è stata generata',
      hint: expect.stringContaining('Rigenera'),
      detail: 'Unexpected token',
    });
  });
});
