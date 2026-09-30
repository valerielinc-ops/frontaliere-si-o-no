import { describe, expect, it, vi } from 'vitest';
import {
  ANSWER_CHECK_SCHEMA,
  answerCheckSystemPrompt,
  checkAnswersWithAi,
} from '../functions/src/assistedApplicationAnswerCheck.js';

const questions = [
  { id: 'availability', question: 'Da quale data saresti disponibile a iniziare?', type: 'date', required: true },
  { id: 'salary', question: 'Qual è la tua pretesa salariale annua lorda?', type: 'text', required: true },
];
const input = (answers: Record<string, string>, codex?: any) => ({ questions, answers, locale: 'it', job: { title: 'Infermiere', company: 'Casa Prova' }, todayIso: '2026-09-30', codex });

describe('AI answer check', () => {
  it('returns the message of every answer Codex finds unusable, in a strict schema', async () => {
    const codex = vi.fn(async () => ({ results: [
      { id: 'availability', ok: true, message: '' },
      { id: 'salary', ok: false, message: 'Indica un importo, per esempio CHF 80’000.' },
      { id: 'invented', ok: false, message: 'x' },
    ] }));
    const result = await checkAnswersWithAi(input({ availability: '2027-01-01', salary: 'boh' }, codex));
    expect(result).toEqual({ ok: false, fields: { salary: 'Indica un importo, per esempio CHF 80’000.' }, checkedBy: 'codex' });
    const request = codex.mock.calls[0][0];
    expect(request).toMatchObject({ schema: ANSWER_CHECK_SCHEMA, name: 'answer_check', timeoutMs: 45_000 });
    expect(JSON.parse(request.userText)).toMatchObject({ today: '2026-09-30', answers: [{ id: 'availability', answer: '2027-01-01' }, { id: 'salary', answer: 'boh' }] });
    expect(answerCheckSystemPrompt('de')).toContain('in German');
  });

  it('checks only the answers given, and falls back to a generic message when Codex gives none', async () => {
    const codex = vi.fn(async () => ({ results: [{ id: 'salary', ok: false, message: '' }] }));
    const result = await checkAnswersWithAi(input({ salary: 'asdf' }, codex));
    expect(result.fields.salary).toContain('Controlla questa risposta');
    expect(JSON.parse(codex.mock.calls[0][0].userText).answers.map((answer: any) => answer.id)).toEqual(['salary']);
    // Nothing answered: no call at all.
    const idle = vi.fn();
    expect(await checkAnswersWithAi(input({ availability: ' ' }, idle))).toEqual({ ok: true, fields: {}, checkedBy: 'none' });
    expect(idle).not.toHaveBeenCalled();
  });

  it('never blocks the candidate when Codex is unavailable', async () => {
    const codex = vi.fn(async () => { throw new Error('codex_auth_expired'); });
    expect(await checkAnswersWithAi(input({ salary: '80000' }, codex))).toEqual({ ok: true, fields: {}, checkedBy: 'unavailable' });
  });
});
