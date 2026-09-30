import { describe, expect, it } from 'vitest';
import {
  buildCandidateAutomationEmail,
  buildOwnerAutomationEmail,
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
    expect(email.text).toContain('mi servono alcune informazioni che solo tu puoi darmi (2)');
    expect(email.text).not.toContain('partirà automaticamente');
  });

  it('explains the portal handoff and the closed-ad refund', () => {
    const handoff = buildCandidateAutomationEmail('candidate_handoff', { ...base, locale: 'de', reason: 'captcha' });
    expect(handoff.text).toContain('eine Anti-Roboter-Prüfung');
    expect(handoff.text).toContain('«Ich habe die Bewerbung gesendet»');
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
});
