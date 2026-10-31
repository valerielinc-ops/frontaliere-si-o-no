import { describe, expect, it } from 'vitest';
import { captureAnswerContracts, answerContractsChanged, nativeAnswerDetails } from '../services/assistedApplicationAnswerContracts';

const privacy = { id: 'consent', question: 'I agree to the privacy policy', required: true };
describe('answer form contract snapshot', () => {
  it('retains the originally displayed question and hash when a same-ID question changes', () => {
    const questions = [{ ...privacy }], contracts = { consent: 'original' };
    const snapshot = captureAnswerContracts('order:round1', questions, contracts);
    const localInput = { consent: 'Yes' };
    questions[0].question = 'I hold a work permit';
    contracts.consent = 'new-owner';
    expect(answerContractsChanged(snapshot, 'order:round1', questions, contracts)).toBe(true);
    expect(snapshot.questions[0].question).toBe(privacy.question);
    expect(snapshot.contracts).toEqual({ consent: 'original' });
    expect(localInput).toEqual({ consent: 'Yes' });
    // This is the POST body: the old Yes never silently acquires the new hash.
    expect({ answers: localInput, answerContracts: snapshot.contracts }).toEqual({ answers: { consent: 'Yes' }, answerContracts: { consent: 'original' } });
  });
  it('detects ownership changes even when visible text and IDs stay identical', () => {
    const snapshot = captureAnswerContracts('order:round1', [privacy], { consent: 'privacy-owner' });
    expect(answerContractsChanged(snapshot, 'order:round1', [privacy], { consent: 'marketing-owner' })).toBe(true);
    expect(answerContractsChanged(snapshot, 'order:round2', [privacy], { consent: 'privacy-owner' })).toBe(true);
  });
  it('keeps legacy input unbound until the server returns a real contract', () => {
    const snapshot = captureAnswerContracts('order', [privacy]);
    expect(snapshot.contracts).toEqual({});
    expect(answerContractsChanged(snapshot, 'order', [privacy], { consent: 'server-hash' })).toBe(true);
  });
  it('handles nonempty to empty and captures the empty actual form explicitly', () => {
    const snapshot = captureAnswerContracts('order', [privacy], { consent: 'old' });
    expect(answerContractsChanged(snapshot, 'order', [], {})).toBe(true);
    const actual = captureAnswerContracts('order', [], {});
    expect(answerContractsChanged(actual, 'order', [], {})).toBe(false);
    expect(actual.questions).toEqual([]);
  });
  it('shows the complete own assertion and original native text, without hiding a qualifying tail', () => {
    const tail = 'I hold a work permit';
    const actual = 'Privacy '.repeat(50) + tail;
    expect(nativeAnswerDetails({ question: 'Accetto la privacy', applicationQuestion: actual,
      ownConsentText: [actual, 'I hold a degree'], ownConsentLinks: ['https://jobs.example/privacy-policy', 'javascript:alert(1)'] }))
      .toEqual({ texts: [actual.trim(), 'I hold a degree'], links: ['https://jobs.example/privacy-policy'] });
  });
  it('shows original native qualifiers for noncheckbox questions before confirmation', () => {
    expect(nativeAnswerDetails({ question: 'Do you hold a university degree?', originalQuestionContext: 'Only University X degrees qualify', originalQuestionSection: 'Education' }))
      .toEqual({ texts: ['Only University X degrees qualify', 'Education'], links: [] });
  });
  it('preserves stable contracts and distinguishes same-ID validation changes', () => {
    const original = { ...privacy, validation: { pattern: '^Yes$' } };
    const snapshot = captureAnswerContracts('order', [original], { consent: 'same' });
    expect(answerContractsChanged(snapshot, 'order', [structuredClone(original)], { consent: 'same' })).toBe(false);
    expect(answerContractsChanged(snapshot, 'order', [{ ...original, validation: { pattern: '^No$' } }], { consent: 'same' })).toBe(true);
  });
});
