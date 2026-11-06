import { describe, expect, it } from 'vitest';
import { parseHandoffLedger } from '@/services/rewardedHandoffLedger';

describe('parseHandoffLedger', () => {
  it('keeps valid receipts and rejects malformed fields', () => {
    const valid = { id: 'r1', at: 9_000, jobId: 'job', companyId: 'company', path: 'gpt', route: 'none', opened: 0 };
    const result = parseHandoffLedger(JSON.stringify([
      valid,
      { ...valid, id: 'future', at: 10_001 },
      { ...valid, id: 'bad-route', route: 'unknown' },
      { ...valid, id: 'bad-opened', opened: 2 },
      { ...valid, id: 'bad-job', jobId: { leaked: true } },
    ]), 10_000);
    expect(result).toEqual([valid]);
  });

  it('ignores expired or malformed JSON', () => {
    const expired = { id: 'old', at: 1, jobId: 'job', companyId: 'company', path: 'gpt', route: 'none', opened: 0 };
    expect(parseHandoffLedger(JSON.stringify([expired]), 14 * 24 * 60 * 60 * 1000 + 2)).toEqual([]);
    expect(parseHandoffLedger('{bad json}', 10_000)).toEqual([]);
  });
});
