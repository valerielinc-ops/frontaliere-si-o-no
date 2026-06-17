import { describe, it, expect } from 'vitest';
import { buildTrafficDocs } from '../scripts/write-employer-traffic.mjs';

describe('buildTrafficDocs', () => {
  it('maps employers with candidates>0 to Firestore docs keyed by slug', () => {
    const docs = buildTrafficDocs({
      source: 'posthog', days: 90,
      employers: [{ key: 'casale-sa', name: 'Casale SA', candidates: 88, clicks: 117 }],
    });
    expect(docs).toHaveLength(1);
    expect(docs[0].key).toBe('casale-sa');
    expect(docs[0].data).toMatchObject({ company: 'Casale SA', candidates: 88, clicks: 117, windowDays: 90, source: 'posthog' });
  });

  it('drops entries with no key or candidates<=0 (no "0 candidati" noise)', () => {
    const docs = buildTrafficDocs({
      days: 30,
      employers: [
        { key: '', name: 'NoKey', candidates: 5 },
        { key: 'zero', name: 'Zero', candidates: 0 },
        { key: 'nan', name: 'NaN', candidates: undefined },
        { key: 'ok', name: 'Ok', candidates: 3 },
      ],
    });
    expect(docs.map((d) => d.key)).toEqual(['ok']);
  });

  it('returns [] for empty / invalid report', () => {
    expect(buildTrafficDocs(null)).toEqual([]);
    expect(buildTrafficDocs({})).toEqual([]);
    expect(buildTrafficDocs({ employers: 'nope' })).toEqual([]);
  });
});
