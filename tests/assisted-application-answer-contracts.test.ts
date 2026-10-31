import { describe, expect, it } from 'vitest';
import { captureAnswerContracts, answerContractsChanged } from '../services/assistedApplicationAnswerContracts';

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
  it('preserves stable contracts and distinguishes same-ID validation changes', () => {
    const original = { ...privacy, validation: { pattern: '^Yes$' } };
    const snapshot = captureAnswerContracts('order', [original], { consent: 'same' });
    expect(answerContractsChanged(snapshot, 'order', [structuredClone(original)], { consent: 'same' })).toBe(false);
    expect(answerContractsChanged(snapshot, 'order', [{ ...original, validation: { pattern: '^No$' } }], { consent: 'same' })).toBe(true);
  });
});
