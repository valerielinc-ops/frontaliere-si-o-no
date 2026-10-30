import { describe, expect, it } from 'vitest';
import { candidateAnswerFact, candidateFactIdentity, candidateQuestionFact } from '../functions/src/lib/candidateAnswerFacts.js';
import { permitOptions } from '../functions/src/lib/permitStatus.js';

const today = new Date().toISOString().slice(0, 10);
const previousYear = new Date().getUTCFullYear() - 30;
const birth = `${previousYear}-02-20`;
const question = (label: string, type = 'text', extra = {}) => ({ id: 'synthetic', question: label, type, ...extra });

describe('positive typed candidate answer contracts', () => {
  it.each(['What is your date of birth?', 'Qual è la tua data di nascita?', 'Was ist Ihr Geburtsdatum?', 'Quelle est votre date de naissance?'])('preserves a positively typed birth date: %s', label => {
    expect(candidateAnswerFact(question(label, 'date'), birth)).toMatchObject({ type: 'birth_date', subject: 'candidate', unit: 'calendar_date', scope: 'candidate' });
  });
  it.each(['Place of birth', 'Geburtsort', 'Comune di nascita', 'Luogo di nascita', 'Lieu de naissance', "What is your child's date of birth?", 'What is your expected date of birth?'])('never aliases a place or a different person/date: %s', label => {
    expect(candidateQuestionFact(question(label, 'date'))).toBeNull();
  });
  it('requires an actual past ISO date rather than inferring a date from text or age', () => {
    const q = question('What is your date of birth?', 'date');
    for (const answer of ['20.02.1995', '30', 'Zurich', `${previousYear}-02-30`, '9999-01-01']) expect(candidateAnswerFact(q, answer)).toBeNull();
    expect(candidateQuestionFact({ ...q, type: 'text' })).toBeNull();
    expect(candidateAnswerFact(q, today)).not.toBeNull();
  });
  it.each(['How many years of experience do you have with Python?', 'Quanti anni di esperienza hai con Python?', 'Wie viele Jahre Erfahrung haben Sie mit Python?', "Combien d'années d'expérience avez-vous avec Python?"])('keeps the explicit experience subject and duration unit: %s', label => {
    expect(candidateAnswerFact(question(label, 'number'), '3.5')).toMatchObject({ type: 'experience_duration', subject: 'python', unit: 'years', scope: 'candidate' });
  });
  it('does not convert units or generalise neighbouring subjects and future/employer conditions', () => {
    const years = question('How many years of experience do you have with Python?', 'number');
    const months = question('How many months of experience do you have with Python?', 'number');
    const sql = question('How many years of experience do you have with SQL?', 'number');
    expect(candidateFactIdentity(candidateQuestionFact(years))).not.toBe(candidateFactIdentity(candidateQuestionFact(months)));
    expect(candidateFactIdentity(candidateQuestionFact(years))).not.toBe(candidateFactIdentity(candidateQuestionFact(sql)));
    for (const subject of ['Python for this employer', 'Python after training', 'the required system', 'Python and SQL']) expect(candidateQuestionFact(question(`How many years of experience do you have with ${subject}?`, 'number'))).toBeNull();
    for (const answer of ['3 years', '-1', 'Infinity', '', true]) expect(candidateAnswerFact(years, answer)).toBeNull();
  });
  it.each(['Do you hold the PMP certification?', 'Possiedi la certificazione PMP?', 'Besitzen Sie die Zertifizierung PMP?', 'Possédez-vous la certification PMP?'])('records only the specifically named credential assertion: %s', label => {
    expect(candidateAnswerFact(question(label, 'yes_no'), 'Yes')).toMatchObject({ type: 'credential_held', subject: 'pmp', unit: 'boolean', relation: 'held_not_document_verified', scope: 'candidate' });
  });
  it('does not turn a vague credential, attachment or plan into a held certification', () => {
    for (const label of ['Do you hold the required certification?', 'Do you plan to obtain the PMP certification?', 'Have you attached the PMP certification?', 'Do you hold the PMP certification for this employer?']) expect(candidateQuestionFact(question(label, 'yes_no'))).toBeNull();
    expect(candidateAnswerFact(question('Do you hold the PMP certification?', 'yes_no'), 'In progress')).toBeNull();
  });
  it.each(['What is your current Swiss work permit status?', 'Quale permesso svizzero possiedi attualmente?', 'Welche Schweizer Bewilligung besitzen Sie aktuell?', 'Quel permis suisse possédez-vous actuellement?'])('preserves jurisdiction and possession instead of inventing work rights: %s', label => {
    const q = question(label, 'choice', { options: permitOptions('en') });
    expect(candidateAnswerFact(q, permitOptions('en')[1])).toMatchObject({ type: 'permit_status', jurisdiction: 'CH', status: 'permit_c', relation: 'reported_possession_not_work_right', scope: 'candidate' });
    expect(candidateAnswerFact(q, permitOptions('en')[4])).toMatchObject({ status: 'permit_g', scope: 'job' });
  });
  it('does not promote an unknown jurisdiction, pending permit, sponsorship or opaque Yes to a status', () => {
    for (const label of ['What is your work permit status?', 'Do you need sponsorship in Switzerland?', 'Are you authorized to work for this employer?']) expect(candidateQuestionFact(question(label, 'choice'))).toBeNull();
    const q = question('What is your current Swiss work permit status?', 'choice');
    for (const value of ['Yes', 'Permit G pending', 'G or B']) expect(candidateAnswerFact(q, value)).toBeNull();
  });
  it.each([{ context: 'This employer' }, { section: 'Dependent child' }, { autocomplete: 'other-fact' }, { source: 'policy_default' }, { applicationQuestion: 'What is your expected date of birth?' }])('refuses to erase contextual provenance: %j', metadata => {
    expect(candidateQuestionFact(question('What is your date of birth?', 'date', metadata))).toBeNull();
  });
});
