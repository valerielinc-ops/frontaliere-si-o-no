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

  // Owner decision 2026-10-03: a profile that is not a full match goes on, and the candidate is told.
  it('tells the candidate that the CV does not show every requirement, before the button and in every language', () => {
    const expectations: Record<string, [RegExp, RegExp]> = {
      it: [/alcuni requisiti dell’annuncio non risultano dal tuo CV/, /indispensabile un requisito che dal tuo CV non risulta/],
      de: [/Einige Anforderungen der Stelle gehen aus deinem Lebenslauf nicht hervor/, /als zwingend, die aus deinem Lebenslauf nicht hervorgeht/],
      fr: [/certaines exigences de l’annonce ne ressortent pas de votre CV/, /comme indispensable une exigence qui ne ressort pas de votre CV/],
      en: [/some requirements of the posting do not show in your CV/, /as essential a requirement your CV does not show/],
    };
    for (const [locale, [partial, low]] of Object.entries(expectations)) {
      const plain = buildCandidateAutomationEmail('candidate_review', { ...base, locale, deadlineAt: DEADLINE });
      expect(plain.text).not.toMatch(partial);
      expect(plain.text).not.toMatch(low);
      const some = buildCandidateAutomationEmail('candidate_review', { ...base, locale, deadlineAt: DEADLINE, fit: 'partial' });
      expect(some.text).toMatch(partial);
      expect(some.html).toMatch(partial);
      expect(some.text.indexOf(base.reviewUrl)).toBeGreaterThan(some.text.search(partial));
      const missing = buildCandidateAutomationEmail('candidate_review', { ...base, locale, held: true, openQuestions: 2, deadlineAt: null, fit: 'low' });
      expect(missing.text).toMatch(low);
      // Only the review e-mail says it: a reminder keeps to its own subject.
      expect(buildCandidateAutomationEmail('candidate_reminder', { ...base, locale, deadlineAt: DEADLINE, fit: 'low' }).text).not.toMatch(low);
    }
  });

  // Close-out of 2026-10-03: the e-mail promises the page's list only when there is one, and its answers
  // only when the page asks questions (the wording comes from assistedApplicationFitNotice.js).
  it('words the fit paragraph for what the page shows, in every language', () => {
    const expectations: Record<string, { far: RegExp; list: RegExp; answers: RegExp; edit: RegExp }> = {
      it: { far: /il tuo profilo sembra lontano da quello che chiede l’annuncio/, list: /Nella pagina trovi qual/, answers: /nelle risposte/, edit: /scrivilo nella lettera con «Modifica» o chiedi una nuova versione con «Chiedi modifiche»/ },
      de: { far: /wirkt dein Profil weit entfernt von dem, was die Stelle verlangt/, list: /Auf der Seite siehst du, welche/, answers: /in den Antworten/, edit: /mit «Bearbeiten» ins Anschreiben oder bitte mit «Änderungen wünschen» um eine neue Version/ },
      fr: { far: /votre profil semble éloigné de ce que demande l’annonce/, list: /La page indique lesquel|La page indique laquelle/, answers: /dans vos réponses/, edit: /dans la lettre avec « Modifier » ou demandez une nouvelle version avec « Demander des modifications »/ },
      en: { far: /your profile looks far from what the posting asks for/, list: /The page (lists them|says which)/, answers: /in your answers/, edit: /in the letter with “Edit” or ask for a new version with “Ask for changes”/ },
    };
    for (const [locale, words] of Object.entries(expectations)) {
      const review = (fit: string, fitVia: string) => buildCandidateAutomationEmail('candidate_review', { ...base, locale, deadlineAt: DEADLINE, fit, fitVia } as any);
      // A verdict «poor» with no decisive requirement missing: no list to point to.
      const far = review('far', 'answers');
      expect(far.text).toMatch(words.far);
      expect(far.html).toMatch(words.far);
      expect(far.text).not.toMatch(words.list);
      expect(far.text).toMatch(words.answers);
      // A draft with no questions: the letter or a new version, the two things the page offers.
      for (const fit of ['partial', 'low', 'far']) {
        const edit = review(fit, 'edit');
        expect(edit.text).toMatch(words.edit);
        expect(edit.text).not.toMatch(words.answers);
      }
      expect(review('partial', 'edit').text).toMatch(words.list);
    }
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
    // Two of the flags the flow raises today (#11026 took `knock_out` out of them, and its words out of here).
    const held = buildOwnerAutomationEmail('owner_review', { job: 'Infermiera', company: 'Ospedale', orderId: 'o', flags: ['fact_check', 'channel_unknown'] });
    expect(held.subject).toContain('Serve il tuo intervento');
    expect(held.text).toContain('numeri, date o contatti che non compaiono nel CV');
    expect(held.text).toContain('non è chiaro come candidarsi');
    expect(buildOwnerAutomationEmail('owner_review', { job: 'Infermiera', company: 'Ospedale', orderId: 'o', flags: ['knock_out'] }).text).not.toContain('requisito indispensabile');
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
    // #11161: a retry completes a WhatsApp application by e-mail when the channel has a PastaHR https link.
    const whatsapp = describeTakeover({ reason: 'portal:whatsapp', stage: 'submit' });
    expect(whatsapp.reason).toContain('solo via WhatsApp');
    expect(whatsapp.hint).toContain('«Affida al candidato»');
    expect(whatsapp.hint).toContain('nella chat WhatsApp del datore');
    expect(whatsapp.hint).toContain('Se il canale ha un link PastaHR (https), dalla coda «Riprova l’invio automatico» chiude l’ordine');
    expect(whatsapp.hint).toContain('Altrimenti premi «Affida al candidato»');
    expect(describeTakeover({ reason: 'Unexpected token', stage: 'draft' })).toEqual({
      reason: 'la bozza non è stata generata',
      hint: expect.stringContaining('Rigenera'),
      detail: 'Unexpected token',
    });
  });
});
