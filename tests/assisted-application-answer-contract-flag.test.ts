import { describe, expect, it, vi } from 'vitest';
import { ANSWER_CONTRACT_REQUIRED_RC_KEY, answerContractRequired, answerContractRequiredDetails } from '../functions/src/assistedApplicationAnswerConfirmation.js';

describe('assisted application answer-contract rollout switch', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    [' FALSE ', false],
    ['1', false],
    ['yes', false],
    [' true ', true],
    [true, true],
  ])('normalizes only the canonical true value (%j)', async (value, expected) => {
    const getValue = vi.fn(async (key: string) => {
      expect(key).toBe(ANSWER_CONTRACT_REQUIRED_RC_KEY);
      return value;
    });
    await expect(answerContractRequired(getValue)).resolves.toBe(expected);
    expect(getValue).toHaveBeenCalledOnce();
  });

  it('fails open when Remote Config is unavailable or the reader is absent', async () => {
    await expect(answerContractRequired(undefined)).resolves.toBe(false);
    await expect(answerContractRequired(async () => { throw new Error('remote_config_unavailable'); })).resolves.toBe(false);
  });

  it('exposes one exclusive candidate-review handoff payload for strict mode', () => {
    expect(answerContractRequiredDetails).toEqual({
      reviewRequired: true,
      answerConfirmation: { status: 'review_required', authority: false },
    });
    expect(Object.keys(answerContractRequiredDetails)).toEqual(['reviewRequired', 'answerConfirmation']);
  });
});
