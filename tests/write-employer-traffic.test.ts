import { describe, it, expect } from 'vitest';
import { buildTrafficDocs } from '../scripts/write-employer-traffic.mjs';

const WINDOW = {
  from: '2026-06-10T22:00:00.000Z',
  to: '2026-09-08T22:00:00.000Z',
  kind: 'days:90',
  timezone: 'UTC',
  inclusive: '[from,to)',
};

describe('buildTrafficDocs', () => {
  it('maps employers with measured clicks/proxy to Firestore docs keyed by slug', () => {
    const docs = buildTrafficDocs({
      source: 'posthog', days: 90, window: WINDOW,
      employers: [{ key: 'casale-sa', name: 'Casale SA', applyClicks: 117, applyClickProxy: 88 }],
    });
    expect(docs).toHaveLength(1);
    expect(docs[0].key).toBe('casale-sa');
    expect(docs[0].data).toMatchObject({
      company: 'Casale SA',
      applyClicks: 117,
      applyClickProxy: 88,
      window: WINDOW,
      source: 'posthog',
    });
    expect(docs[0].data).not.toHaveProperty('candidates');
  });

  it('drops entries without a measured field but preserves an explicit zero', () => {
    const docs = buildTrafficDocs({
      days: 30, window: WINDOW,
      employers: [
        { key: '', name: 'NoKey', applyClickProxy: 5 },
        { key: 'zero', name: 'Zero', applyClicks: 0, applyClickProxy: 0 },
        { key: 'nan', name: 'NaN', applyClickProxy: undefined },
        { key: 'legacy', name: 'Legacy', candidates: 99 },
        { key: 'ok', name: 'Ok', applyClicks: 3, applyClickProxy: 3 },
      ],
    });
    expect(docs.map((d) => d.key)).toEqual(['zero', 'ok']);
    expect(docs[0].data).toMatchObject({ applyClicks: 0, applyClickProxy: 0, window: WINDOW });
  });

  it('does not persist a number when the report has no explicit window', () => {
    expect(buildTrafficDocs({
      source: 'posthog', days: 90,
      employers: [{ key: 'casale-sa', applyClicks: 117, applyClickProxy: 88 }],
    })).toEqual([]);
  });

  it('returns [] for empty / invalid report', () => {
    expect(buildTrafficDocs(null)).toEqual([]);
    expect(buildTrafficDocs({})).toEqual([]);
    expect(buildTrafficDocs({ employers: 'nope' })).toEqual([]);
  });
});
