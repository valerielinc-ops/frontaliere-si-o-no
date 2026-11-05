import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_ARTICLES_MAX_AGE_MS,
  chooseDiscoveryArticle,
  freezeCampaignDiscoverySelection,
  omitDuplicateDiscoveryArticle,
  parseDiscoveryArticleIndex,
} from '../scripts/lib/newsletter-discovery-selection.mjs';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function article(id: string, now: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    publishedAt: new Date(now - 60_000).toISOString(),
    provider: 'google_trends',
    title: { it: `Titolo ${id}`, en: `Title ${id}` },
    excerpt: { it: `Estratto ${id}`, en: `Excerpt ${id}` },
    url: {
      it: `/articoli-frontaliere/${id}/`,
      en: `/en/cross-border-articles/${id}-en/`,
    },
    ...overrides,
  };
}

function index(now = Date.now(), articles = [article('trend-a', now)]) {
  return {
    schema: 1,
    commit: COMMIT,
    generatedAt: new Date(now).toISOString(),
    count: articles.length,
    articles,
  };
}

function parse(payload: ReturnType<typeof index>, now = Date.now()) {
  const raw = JSON.stringify(payload);
  return parseDiscoveryArticleIndex(raw, {
    expectedBytes: Buffer.byteLength(raw, 'utf8'),
    expectedCount: payload.count,
    expectedCommit: COMMIT,
    now,
  });
}

type FrozenSelection = {
  articleId: string;
  provider: string;
  article: {
    id: string;
    provider: string;
    title: string;
    excerpt: string;
    url: string;
  };
} | null;

type CampaignDocument = {
  campaign_id?: string;
  created_at?: Date;
  updated_at?: Date;
  selections?: Record<string, FrozenSelection>;
};

type FakeDocumentReference = {
  id: string;
  path: string;
  collection: (name: string) => FakeCollectionReference;
};

type FakeCollectionReference = {
  doc: (id: string) => FakeDocumentReference;
};

type FakeTransaction = {
  get: (reference: FakeDocumentReference) => Promise<{
    exists: boolean;
    data: () => CampaignDocument | undefined;
  }>;
  set: (
    reference: FakeDocumentReference,
    value: CampaignDocument,
    options?: { merge?: boolean },
  ) => void;
};

function fakeFirestore() {
  const documents = new Map<string, CampaignDocument>();
  const makeCollection = (path: string): FakeCollectionReference => ({
    doc: (id) => makeReference(`${path}/${id}`),
  });
  const makeReference = (path: string): FakeDocumentReference => ({
    path,
    id: path.split('/').at(-1) || '',
    collection: (name) => makeCollection(`${path}/${name}`),
  });
  const transaction: FakeTransaction = {
    get: async (reference) => {
      const value = documents.get(reference.path);
      return { exists: Boolean(value), data: () => value };
    },
    set: (reference, value, options = {}) => {
      const previous = documents.get(reference.path) || {};
      if (!options.merge) {
        documents.set(reference.path, value);
        return;
      }
      documents.set(reference.path, {
        ...previous,
        ...value,
        selections: { ...(previous.selections || {}), ...(value.selections || {}) },
      });
    },
  };
  const db = {
    collection: (name: string) => makeCollection(name),
    runTransaction: async (operation: (transaction: FakeTransaction) => Promise<unknown>) => operation(transaction),
  };
  return { db, documents };
}

describe('parseDiscoveryArticleIndex', () => {
  it('accepts the manifest-pinned public schema with only available locales', () => {
    const now = Date.now();
    expect(parse(index(now), now).articles).toHaveLength(1);
  });

  it('rejects wrong bytes, counts, commit, and stale timestamps', () => {
    const now = Date.now();
    const payload = index(now);
    const raw = JSON.stringify(payload);
    const options = {
      expectedBytes: Buffer.byteLength(raw, 'utf8') + 1,
      expectedCount: 1,
      expectedCommit: COMMIT,
      now,
    };
    expect(() => parseDiscoveryArticleIndex(raw, options)).toThrow(/byte count/);
    expect(() => parseDiscoveryArticleIndex(raw, { ...options, expectedBytes: raw.length, expectedCount: 2 })).toThrow(/count differs/);
    expect(() => parseDiscoveryArticleIndex(raw, { ...options, expectedBytes: raw.length, expectedCommit: 'f'.repeat(40) })).toThrow(/manifest commit/);

    const stale = index(now - DISCOVERY_ARTICLES_MAX_AGE_MS - 1);
    expect(() => parse(stale, now)).toThrow(/stale or in the future/);
  });

  it('rejects unsafe URLs, incomplete locale maps, and unapproved fields', () => {
    const now = Date.now();
    expect(() => parse(index(now, [article('bad-url', now, {
      url: { it: 'https://example.com/unsafe/' },
      title: { it: 'Titolo' },
      excerpt: { it: 'Estratto' },
    })]), now)).toThrow(/url\.it is invalid/);
    expect(() => parse(index(now, [article('partial', now, {
      title: { it: 'Titolo', en: 'Title' },
      excerpt: { it: 'Estratto' },
      url: { it: '/articoli-frontaliere/partial/' },
    })]), now)).toThrow(/incomplete en localization/);
    expect(() => parse(index(now, [article('raw', now, {
      rawQuery: 'not public',
    })]), now)).toThrow(/invalid article contract/);
  });
});

describe('discovery article selection', () => {
  it('picks a deterministic recent localized item and skips missing locales', () => {
    const now = Date.now();
    const payload = parse(index(now, [
      article('old', now - 61 * 24 * 60 * 60 * 1000),
      article('it-only', now, {
        title: { it: 'Solo italiano' },
        excerpt: { it: 'Estratto italiano' },
        url: { it: '/articoli-frontaliere/it-only/' },
      }),
    ]), now);
    const italian = chooseDiscoveryArticle(payload, 'weekly_2026-11-02', 'it', { now });
    const english = chooseDiscoveryArticle(payload, 'weekly_2026-11-02', 'en', { now });

    expect(italian?.articleId).toBe('it-only');
    expect(english).toBeNull();
    expect(chooseDiscoveryArticle(payload, 'weekly_2026-11-02', 'it', { now })).toEqual(italian);
  });

  it('freezes the selected copy, or a no-item result, across campaign resumes', async () => {
    const now = Date.now();
    const { db, documents } = fakeFirestore();
    const initial = parse(index(now, [article('trend-a', now)]), now);
    const first = await freezeCampaignDiscoverySelection(db, 'weekly_2026-11-02', 'it', initial, { now: new Date(now) });
    const changed = parse(index(now, [article('trend-b', now), article('trend-a', now)]), now);
    const resumed = await freezeCampaignDiscoverySelection(db, 'weekly_2026-11-02', 'it', changed, { now: new Date(now + 60_000) });

    expect(resumed).toEqual(first);
    const storedSelection = [...documents.values()][0]?.selections?.it;
    expect(storedSelection && storedSelection.articleId).toBe(first?.articleId);

    const empty = await freezeCampaignDiscoverySelection(db, 'weekly_2026-11-09', 'it', null, { now: new Date(now) });
    const laterFeed = parse(index(now, [article('arrived-later', now)]), now);
    const emptyResume = await freezeCampaignDiscoverySelection(db, 'weekly_2026-11-09', 'it', laterFeed, { now: new Date(now + 60_000) });
    expect(empty).toBeNull();
    expect(emptyResume).toBeNull();

    const legacyResume = await freezeCampaignDiscoverySelection(
      db,
      'weekly_2026-11-16',
      'it',
      laterFeed,
      { now: new Date(now), allowNewSelection: false },
    );
    const legacyResumeAgain = await freezeCampaignDiscoverySelection(
      db,
      'weekly_2026-11-16',
      'it',
      laterFeed,
      { now: new Date(now + 60_000) },
    );
    expect(legacyResume).toBeNull();
    expect(legacyResumeAgain).toBeNull();
  });
});

describe('duplicate discovery article suppression', () => {
  const selection = {
    articleId: 'same-article',
    provider: 'google_trends',
    article: {
      id: 'same-article',
      provider: 'google_trends',
      title: 'Tema',
      excerpt: 'Estratto',
      url: '/articoli-frontaliere/same-article/',
    },
  };

  it('uses article id when the personalized article exposes it', () => {
    expect(omitDuplicateDiscoveryArticle(selection, {
      id: 'same-article',
      url: '/articoli-frontaliere/another-slug/',
    })).toBeNull();
  });

  it('compares canonical URLs when the personalized article has no id', () => {
    expect(omitDuplicateDiscoveryArticle(selection, {
      url: 'https://frontaliereticino.ch/articoli-frontaliere/same-article/?utm_campaign=old#top',
    })).toBeNull();
  });

  it('keeps a different article for the discovery slot', () => {
    expect(omitDuplicateDiscoveryArticle(selection, {
      url: '/articoli-frontaliere/personalized/',
    })).toEqual(selection);
  });
});
