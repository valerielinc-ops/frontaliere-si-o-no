import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFirestoreFields, readPublicDocument } from '@/services/firestorePublicRead';
import { runOnFirstEngagement } from '@/services/runOnFirstEngagement';

const read = (file: string) => readFileSync(resolve(import.meta.dirname, '..', file), 'utf8');

/**
 * Live 2026-10-31, anonymous visitor, no interaction: vendor-fdb-firestore.js
 * (598 KB decoded) on home, job search and article; the GSI client on all three.
 */
describe('read-only pages do not load the Firestore client', () => {
  it.each([
    'components/community/PublisherApplyForm.tsx',
    'components/community/SignupPromptModal.tsx',
    'components/calculator/SalaryAlertCTA.tsx',
  ])('%s has no static value import: JobBoard reaches it statically', (file) => {
    expect(read(file)).not.toMatch(/^import \{[^}]*\} from 'firebase\/firestore';/m);
  });

  it('the exchange rate and the byline reads go over REST', () => {
    const rate = read('services/exchangeRateService.ts');
    const body = rate.slice(rate.indexOf('async function getFirestoreRate'), rate.indexOf('// Cache Firestore write permission failures'));
    expect(body).toContain("readPublicDocument('config/exchange_rate')");
    expect(body).not.toContain("import('firebase/firestore')");
    const authors = read('services/authorProfileService.ts');
    expect(authors).toContain('readPublicDocument(`article_author_overrides/${articleId}`)');
    expect(authors).toContain('readPublicDocument(`author_profiles/${slug}`)');
  });

  it('the footer newsletter loads GSI only near the viewport', () => {
    const source = read('components/community/Newsletter.tsx');
    expect(source).toContain('new IntersectionObserver');
    expect(source).toMatch(/if \(!googleButtonNearViewport\) return;/);
  });

  it('counts the article view after engagement, not during hydration', () => {
    expect(read('components/community/BlogArticles.tsx')).toMatch(/runOnFirstEngagement\(\(\) => \{ void trackArticleView\(articleId\); \}\)/);
  });

  it('an anonymous visitor without a stored profile skips the profile chunks', () => {
    const app = read('App.tsx');
    const guard = app.indexOf('if (!authUser?.uid && !loadStoredUserProfile(null)) return;');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(app.indexOf("import('@/components/pages/UserProfile')", guard));
  });
});

describe('decodeFirestoreFields', () => {
  it('maps the REST value types to the shapes the SDK readers expect', () => {
    expect(decodeFirestoreFields({
      rate: { doubleValue: 1.07 },
      count: { integerValue: '3' },
      flag: { booleanValue: true },
      name: { stringValue: 'x' },
      none: { nullValue: null },
      at: { timestampValue: '2026-10-31T09:24:06.358Z' },
      nested: { mapValue: { fields: { a: { stringValue: 'b' } } } },
      list: { arrayValue: { values: [{ integerValue: '1' }] } },
      empty: { arrayValue: {} },
    })).toEqual({
      rate: 1.07,
      count: 3,
      flag: true,
      name: 'x',
      none: null,
      at: Date.parse('2026-10-31T09:24:06.358Z'),
      nested: { a: 'b' },
      list: [1],
      empty: [],
    });
  });
});

describe('readPublicDocument', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the decoded document and encodes every path segment', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ fields: { a: { stringValue: 'b' } } }) });
    vi.stubGlobal('fetch', fetchMock);
    await expect(readPublicDocument('author_profiles/a b')).resolves.toEqual({ a: 'b' });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/documents\/author_profiles\/a%20b$/);
  });

  it.each([
    ['a missing document', () => Promise.resolve({ ok: false, status: 404 })],
    ['a denied read', () => Promise.resolve({ ok: false, status: 403 })],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('treats %s as no value', async (_label, respond) => {
    vi.stubGlobal('fetch', vi.fn(respond));
    await expect(readPublicDocument('config/exchange_rate')).resolves.toBeNull();
  });
});

describe('runOnFirstEngagement', () => {
  beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('runs once on the first engagement and cancels the timeout', () => {
    vi.useFakeTimers();
    const task = vi.fn();
    runOnFirstEngagement(task, 1000);
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('pointerdown'));
    vi.advanceTimersByTime(5000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('runs after the timeout when nobody interacts', () => {
    vi.useFakeTimers();
    const task = vi.fn();
    runOnFirstEngagement(task, 1000);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
