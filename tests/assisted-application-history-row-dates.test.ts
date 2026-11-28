import { describe, expect, it } from 'vitest';
import { historyRowDates, platformCandidateFacts, platformDefaultAnswer } from '../functions/src/assistedApplicationPlatformDefaults.js';
import { withOperationalQuestionAnswers } from '../functions/src/assistedApplicationOperationalAnswers.js';

// Census 2026-11-28 (Rituals): a portal that repeats «Work Experience N» asked 14 From/To dates of a candidate
// whose CV had every period. The rows are answered from the CV's own periods, row N = Nth experience.
const experience = [
  { role: 'Responsabile vendite', employer: 'Alfa Retail SA', start: '03/2026', end: '08/2026', kind: 'job' },
  { role: 'Consulente', employer: 'Beta Servizi', start: '01/2016', end: '01/2026', kind: 'job' },
  { role: 'Addetto', employer: 'Gamma Srl', start: '2009', end: '12/2015', kind: 'job' },
];

const row = (n: number, field: 'from' | 'to', extra: object = {}) => ({
  id: `portal_${field}_r${n}`,
  question: field === 'from' ? 'Da*' : 'A*',
  applicationQuestion: field === 'from' ? 'From*' : 'To*',
  context: field === 'from' ? 'From*' : 'To*',
  addressContext: { section: field === 'from' ? 'From*' : 'To*', owners: [field === 'from' ? 'From*' : 'To*', `Work Experience ${n}`, 'Work Experience'], unknown: false },
  type: 'date',
  required: true,
  source: 'portal',
  validation: { example: '2020-01-01', minLength: 10, maxLength: 10 },
  ...extra,
});
const rows = (count: number) => Array.from({ length: count }, (_, index) => [row(index + 1, 'from'), row(index + 1, 'to')]).flat();
const factsFor = (questions: object[], jobs: object[] = experience) => platformCandidateFacts({ profile: { experience: jobs }, questions, nowMs: Date.UTC(2026, 10, 28) });

describe('From/To dates of a work-experience row', () => {
  it('answers row N from the Nth experience of the CV', () => {
    const questions = rows(3);
    expect(historyRowDates({ questions, experience })).toEqual({
      portal_from_r1: '2026-03-01', portal_to_r1: '2026-08-01',
      portal_from_r2: '2016-01-01', portal_to_r2: '2026-01-01',
      portal_from_r3: '2009-01-01', portal_to_r3: '2015-12-01',
    });
    const facts = factsFor(questions);
    expect(platformDefaultAnswer(questions[0], facts, { locale: 'it' })).toMatchObject({ value: '2026-03-01', topic: 'platform:history_row_date', source: 'policy_default' });
    expect(platformDefaultAnswer(questions[5], facts, { locale: 'it' })?.value).toBe('2015-12-01');
  });

  it('is a projected default, so the candidate is not asked', () => {
    const questions = rows(2);
    const { answers, defaults } = withOperationalQuestionAnswers(questions, {}, { locale: 'it', facts: factsFor(questions) });
    expect(answers.portal_from_r1).toBe('2026-03-01');
    expect(answers.portal_to_r2).toBe('2026-01-01');
    expect(defaults.portal_to_r1.source).toBe('policy_default');
  });

  it('reads only a date control as a row date', () => {
    const textual = [{ ...row(1, 'from'), type: 'text' }];
    expect(historyRowDates({ questions: textual, experience })).toEqual({});
    expect(platformDefaultAnswer(textual[0], factsFor(textual), { locale: 'it' })).toBeNull();
  });

  it('never invents: an ongoing job, an unreadable period or a gap in the numbering stays a question', () => {
    const ongoing = [{ role: 'Capo', employer: 'Delta', start: '03/2022', end: 'ad oggi', kind: 'job' }];
    expect(historyRowDates({ questions: rows(1), experience: ongoing })).toEqual({ portal_from_r1: '2022-03-01' });
    const unreadable = [{ role: 'Capo', employer: 'Delta', start: 'primavera 2022', end: '2023', kind: 'job' }];
    expect(historyRowDates({ questions: rows(1), experience: unreadable })).toEqual({ portal_to_r1: '2023-01-01' });
    // Row numbers that do not start at 1 or skip one cannot be aligned with the CV's order.
    expect(historyRowDates({ questions: [row(2, 'from'), row(2, 'to')], experience })).toEqual({});
    expect(historyRowDates({ questions: [row(1, 'from'), row(3, 'from')], experience })).toEqual({});
    // More rows than the CV has jobs, or a non-job entry among them.
    expect(historyRowDates({ questions: rows(4), experience })).toEqual({});
    expect(historyRowDates({ questions: rows(1), experience: [{ ...experience[0], kind: 'education' }] })).toEqual({});
    // Two From fields in one row: which one is which is not known.
    expect(historyRowDates({ questions: [row(1, 'from'), { ...row(1, 'from'), id: 'again' }, row(1, 'to')], experience })).toEqual({ portal_to_r1: '2026-08-01' });
  });

  it('leaves education rows, other dates and the start-date rule alone', () => {
    const education = { ...row(1, 'from'), addressContext: { section: 'Education', owners: ['Education 1', 'Education'], unknown: false }, context: 'Education 1 · From*' };
    const start = { id: 'start', question: 'Da quale data sei disponibile?', type: 'date', source: 'match' };
    expect(historyRowDates({ questions: [education], experience })).toEqual({});
    const facts = factsFor([education, start]);
    expect(platformDefaultAnswer(education, facts, { locale: 'it' })).toBeNull();
    expect(platformDefaultAnswer(start, facts, { locale: 'it' })?.topic).toBe('platform:start_date');
  });

  it('is empty without a CV experience or without rows', () => {
    expect(historyRowDates({ questions: rows(2), experience: [] })).toEqual({});
    expect(historyRowDates({ questions: [], experience })).toEqual({});
    expect(historyRowDates()).toEqual({});
  });
});
