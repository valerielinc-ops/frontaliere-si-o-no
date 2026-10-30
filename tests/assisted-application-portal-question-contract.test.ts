import { describe, expect, it } from 'vitest';
import { localizePortalQuestions, portalRequirementsFromMissingRequired } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { portalAnswerForApplication } from '../scripts/assisted-application/lib/portal/question-key.mjs';
import { validateAnswer } from '../functions/src/lib/answerRules.js';

const planned = { fieldId: 'source', question: 'Come hai trovato questo lavoro?', type: 'text', options: [], why: '' };
const field = { id: 'source', kind: 'select', label: 'Wie haben Sie uns gefunden?', required: true, options: [{ label: 'Homepage' }, { label: 'Empfehlung' }] };

describe('portal candidate question contract', () => {
  it('uses a required live select and its full catalogue even when the planner describes text', () => {
    const options = Array.from({ length: 25 }, (_, index) => ({ label: `Source ${index + 1}` }));
    const { questions } = portalRequirementsFromMissingRequired([{ ...field, options }], [{ ...planned, options: ['Invented'] }]);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ type: 'choice', required: true, options: options.map(option => option.label), applicationOptions: options.map(option => option.label) });
    expect(questions[0].optionMap).toHaveLength(25);
    expect(portalAnswerForApplication(questions[0], 'Source 25')).toBe('Source 25');
    expect(validateAnswer('Invented', questions[0])).toMatchObject({ ok: false, reason: 'not_an_option' });
  });

  it('does not ask the candidate for a proven optional field wrongly called missing by the planner', () => {
    expect(portalRequirementsFromMissingRequired([{ ...field, required: false }], [planned])).toEqual({ questions: [], documents: [] });
  });

  it('retains a live rejected field without a mandatory marker', () => {
    const { questions } = portalRequirementsFromMissingRequired([{ ...field, required: false, invalid: true }], [planned]);
    expect(questions).toEqual([expect.objectContaining({ type: 'choice', required: true, applicationQuestion: field.label, options: ['Homepage', 'Empfehlung'] })]);
  });

  it('retains rejected or unknown file requirements as uploads while excluding the core documents', () => {
    for (const metadata of [{ required: false, invalid: true }, { required: undefined }]) {
      const files = [
        { id: 'certificate', kind: 'file', label: 'Arbeitszeugnisse', ...metadata },
        { id: 'cv', kind: 'file', label: 'Resume / CV', ...metadata },
        { id: 'letter', kind: 'file', label: 'Cover letter', ...metadata },
      ];
      const result = portalRequirementsFromMissingRequired(files, files.map(file => ({ fieldId: file.id, question: file.label, type: 'text', options: [] })));
      expect(result.questions).toEqual([]);
      expect(result.documents).toEqual([expect.objectContaining({ label: 'Arbeitszeugnisse', required: true })]);
    }
  });

  it('preserves requests when mandatory status or the live control is unknown', () => {
    const { required: _required, ...unknown } = field;
    expect(portalRequirementsFromMissingRequired([unknown], [planned]).questions).toEqual([expect.objectContaining({ required: true, type: 'choice' })]);
    expect(portalRequirementsFromMissingRequired([], [planned]).questions).toEqual([expect.objectContaining({ required: true, type: 'text', question: planned.question })]);
  });

  it('does not borrow optionality from a neighboring or ambiguous label', () => {
    const optional = { ...field, required: false, label: 'Recruitment source' };
    const request = { ...planned, fieldId: 'not-extracted', question: 'Recruitment source details' };
    expect(portalRequirementsFromMissingRequired([optional], [request]).questions).toHaveLength(1);
    const ambiguous = [{ ...optional, id: 'first' }, { ...optional, id: 'second', required: true }];
    expect(portalRequirementsFromMissingRequired(ambiguous, [{ ...request, question: optional.label }]).questions).toHaveLength(1);
  });

  it('does not retain model choices for a live free text field', () => {
    const { questions } = portalRequirementsFromMissingRequired([{ ...field, kind: 'text', options: [] }], [{ ...planned, type: 'choice', options: ['Invented'], applicationOptions: ['Invented'] }]);
    expect(questions[0]).toMatchObject({ type: 'text', options: [] });
    expect(questions[0].applicationOptions).toBeUndefined();
  });

  it('keeps a complete explicit translation map and the exact ATS catalogue', async () => {
    const { questions } = portalRequirementsFromMissingRequired([field], [planned]);
    const localized = await localizePortalQuestions(questions, {
      candidateLocale: 'it', applicationLocale: 'de',
      codex: async () => ({ questions: [{ id: questions[0].id, question: planned.question, options: ['Sito aziendale', 'Raccomandazione'], optionMap: [{ candidate: 'Sito aziendale', application: 'Homepage' }, { candidate: 'Raccomandazione', application: 'Empfehlung' }] }] }),
    });
    expect(localized[0]).toMatchObject({ type: 'choice', required: true, options: ['Sito aziendale', 'Raccomandazione'], applicationOptions: ['Homepage', 'Empfehlung'] });
    expect(portalAnswerForApplication(localized[0], 'Raccomandazione')).toBe('Empfehlung');
  });

  it('preserves the complete catalogue on a partial or unmapped translation', async () => {
    const { questions } = portalRequirementsFromMissingRequired([field], [planned]);
    for (const copy of [
      { options: ['Sito aziendale'], optionMap: [{ candidate: 'Sito aziendale', application: 'Homepage' }] },
      { options: ['Sito aziendale', 'Raccomandazione'], optionMap: [] },
    ]) {
      const localized = await localizePortalQuestions(questions, {
        candidateLocale: 'it', applicationLocale: 'de',
        codex: async () => ({ questions: [{ id: questions[0].id, question: planned.question, ...copy }] }),
      });
      expect(localized[0].options).toEqual(['Homepage', 'Empfehlung']);
      expect(portalAnswerForApplication(localized[0], 'Empfehlung')).toBe('Empfehlung');
    }
  });

  it('preserves the full catalogue and mapping when localization fails', async () => {
    const { questions } = portalRequirementsFromMissingRequired([field], [planned]);
    const localized = await localizePortalQuestions(questions, {
      candidateLocale: 'it', applicationLocale: 'de',
      codex: async () => { throw new Error('unavailable'); },
    });
    expect(localized[0].options).toEqual(['Homepage', 'Empfehlung']);
    expect(portalAnswerForApplication(localized[0], 'Empfehlung')).toBe('Empfehlung');
  });
});
