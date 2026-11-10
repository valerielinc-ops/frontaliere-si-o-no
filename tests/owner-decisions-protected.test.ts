/**
 * PROTECTED — owner decisions are not reversed by agents (AGENTS.md Non-Negotiable #10).
 *
 * Incident of 2026-11-10: PR #17844, opened by an agent auditing the concierge
 * backlog, rewrote the owner's DECISIONS.md row of 2026-11-09 with its own
 * wording and removed the platform defaults of the assisted application, with no
 * owner instruction. The owner restored them on 2026-11-10 and asked that they
 * can no longer be removed this way.
 *
 * What this file pins:
 *  1. every owner-decision row (DECISIONS.md + DECISIONS-ARCHIVE.md) is
 *     append-only: a row is never edited or deleted, only superseded by a new
 *     dated row, or moved verbatim to the archive;
 *  2. the decision of 2026-11-09 is active;
 *  3. the behaviour that decision requires.
 *
 * A failure here is not a stale test. Change it only on an explicit owner
 * instruction given in the session, recorded as a NEW dated row in DECISIONS.md
 * and quoted in the PR body; otherwise restore the code.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_STREETS,
  platformCandidateFacts,
  platformDefaultAnswer,
} from '../functions/src/assistedApplicationPlatformDefaults.js';
import { operationalDefaultAnswer } from '../functions/src/assistedApplicationOperationalAnswers.js';
import { candidateWithEdits } from '../functions/src/assistedApplicationCandidateEdits.js';
import { guardMobilityMatch } from '../functions/src/lib/mobilityRequirements.js';

const PROTECTED = 'Decisione del proprietario protetta (AGENTS.md Non-Negotiable #10): '
  + 'si cambia solo su una nuova istruzione esplicita del proprietario, registrata come nuova riga datata in DECISIONS.md.';
const rowsOf = (file: string) => readFileSync(file, 'utf8').split('\n').map((line) => line.trim())
  .filter((line) => /^\| \d{4}-\d{2}-\d{2}/.test(line));
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

describe('owner decisions are append-only', () => {
  it('keeps every recorded owner-decision row, verbatim, in DECISIONS.md or its archive', () => {
    const present = new Set([...rowsOf('DECISIONS.md'), ...rowsOf('DECISIONS-ARCHIVE.md')].map(sha));
    const { rows } = JSON.parse(readFileSync('tests/fixtures/owner-decisions-rows.json', 'utf8'));
    const missing = rows.filter((hash: string) => !present.has(hash));
    expect(missing, `${PROTECTED} Righe modificate o cancellate: ${missing.length}.`).toEqual([]);
  });

  it('keeps the assisted-application decision of 2026-11-09 active', () => {
    const active = rowsOf('DECISIONS.md').find((row) => row.startsWith('| 2026-11-09 | Candidature assistite:'));
    expect(active, PROTECTED).toContain('functions/src/assistedApplicationPlatformDefaults.js');
    expect(active, PROTECTED).toContain('riconfermata 10-11');
  });
});

describe('assisted application: the platform answers (owner decision 2026-11-09, reconfirmed 2026-11-10)', () => {
  const NOW = Date.parse('2026-11-10T10:00:00Z');
  const facts = platformCandidateFacts({
    order: { userId: 'u', salaryMax: 90000, baseSalary: { value: { unitText: 'YEAR' }, currency: 'CHF' } },
    profile: { location: 'Como (CO)', cvLanguage: 'it', languages: [{ language: 'Italian', level: 'B2' }], education: [{ degree: 'Laurea', institution: 'Università di Pavia', start: '2000' }] },
    identity: { firstName: 'Mario', name: 'Mario Rossi' },
    nowMs: NOW,
    locale: 'it',
  });
  const answer = (question: Record<string, unknown>) => platformDefaultAnswer({ required: true, ...question }, facts, { locale: 'it' })?.value ?? null;

  it('deduces postal code and country from the CV town, and a street from the owner list when none is stated', () => {
    expect(facts.address).toMatchObject({ postalCode: '22100', country: 'IT', city: 'Como' });
    expect(PLATFORM_STREETS).toContain(facts.address.streetName);
    expect(Number(facts.address.houseNumber)).toBeGreaterThanOrEqual(1);
    expect(Number(facts.address.houseNumber)).toBeLessThanOrEqual(101);
    expect(answer({ question: 'CAP', type: 'text' }), PROTECTED).toBe('22100');
    expect(answer({ question: 'Qual è la tua via e il numero civico?', type: 'text' }), PROTECTED).toBe(facts.address.street);
  });

  it('deduces the form of address from the name and never asks it', () => {
    expect(facts.salutation, PROTECTED).toBe('Signor');
    expect(candidateWithEdits({ order: { applicantName: 'Alex Morgan', locale: 'it' }, draft: { profile: { fullName: 'Alex Morgan' }, questions: [] }, flow: {} }).answers.salutation, PROTECTED).toBeTruthy();
  });

  it('estimates the birth date (18 at the start of university, on 1 January) and the civil status from the age', () => {
    expect(facts, PROTECTED).toMatchObject({ dateOfBirth: '1982-01-01', age: 44, civilStatus: 'married' });
  });

  it('reads languages from the CV, the CV language as mother tongue', () => {
    expect(facts.languages.find((entry: { code: string }) => entry.code === 'it')?.level, PROTECTED).toBe('native');
  });

  it('sets salary to the estimate maximum, workload 100%, notice and start date three months after submission', () => {
    expect(answer({ question: 'Qual è la tua aspettativa salariale annua in CHF?', type: 'number' }), PROTECTED).toBe('90000');
    expect(answer({ question: 'Da quale data puoi iniziare a lavorare?', type: 'date' }), PROTECTED).toBe('2027-02-10');
    expect(operationalDefaultAnswer({ question: 'Qual è il tuo carico di lavoro preferito?', type: 'text', required: true }, { facts })?.value, PROTECTED).toBe('100%');
    expect(operationalDefaultAnswer({ question: 'Qual è il tuo periodo di preavviso?', type: 'text', required: true }, { facts })?.value, PROTECTED).toBe('3 mesi');
  });

  it('accepts the privacy notice and audio recording, declines marketing', () => {
    expect(answer({ question: 'Puoi fornire il consenso informato alla registrazione della conversazione?', type: 'yes_no', options: ['Sì', 'No'] }), PROTECTED).toBe('Sì');
    expect(answer({ question: 'Desideri ricevere la newsletter con offerte promozionali?', type: 'yes_no', options: ['Sì', 'No'] }), PROTECTED).toBe('No');
    expect(operationalDefaultAnswer({ question: 'Seleziona questa casella per confermare di aver letto l\'Informativa sulla privacy per i candidati.', applicationQuestion: 'Please check this box to acknowledge that you have read the Applicant Privacy Notice.', type: 'text', required: true, source: 'portal' }, { facts }), PROTECTED).toMatchObject({ topic: 'privacy_review_ack' });
  });

  it('declares the candidate available to relocate, to work hybrid and on call', () => {
    for (const question of [
      'Sei disponibile a trasferirti nel Canton Ticino?',
      'Sei disponibile a lavorare in modalità ibrida?',
      'Sei disponibile a partecipare al servizio di picchetto?',
    ]) expect(answer({ question, type: 'yes_no', options: ['Sì', 'No'] }), PROTECTED).toBe('Sì');
    const quote = 'Resident in Switzerland or willingness to relocate.';
    const row = { requirement: quote, quote, importance: 'high', basis: 'stated' };
    const guarded = guardMobilityMatch({ requirements: [row] }, { matches: [{ index: 0, status: 'met', evidence: 'x', evidenceUnverified: false }], verdict: 'good', questions: [] }, { profile: {}, sourceText: '' });
    expect(guarded.matches[0].status, PROTECTED).toBe('met');
    expect(guarded.questions, PROTECTED).toEqual([]);
  });
});
