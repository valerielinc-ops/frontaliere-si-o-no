/**
 * Guard for the "your article is online" email premature-send incident:
 * the email must only fire once every locale URL is actually reachable
 * (post-deploy), never based on publish/commit time alone.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

vi.mock('../scripts/lib/journalist-article-identity.mjs', () => ({
  checkArticleIdExists: vi.fn(() => false),
  slugify: (input: string) => input,
}));

import { checkAllLocalesLive, processDoc } from '../scripts/notify-journalist-article-live.mjs';
import { checkArticleIdExists } from '../scripts/lib/journalist-article-identity.mjs';

const PUBLISHED_URLS = {
  it: 'https://frontaliereticino.ch/articoli-frontaliere/test/',
  en: 'https://frontaliereticino.ch/en/cross-border-articles/test/',
  de: 'https://frontaliereticino.ch/de/grenzgaenger-artikel/test/',
  fr: 'https://frontaliereticino.ch/fr/articles-frontalier/test/',
};

describe('checkAllLocalesLive', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is false when any locale still 404s (partial deploy)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => Promise.resolve({ ok: !url.includes('/en/') })),
    );
    await expect(checkAllLocalesLive(PUBLISHED_URLS)).resolves.toBe(false);
  });

  it('is false when a locale URL is missing entirely', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { fr: _fr, ...missingFr } = PUBLISHED_URLS;
    await expect(checkAllLocalesLive(missingFr)).resolves.toBe(false);
  });

  it('is true only once all 4 locales return ok', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })));
    await expect(checkAllLocalesLive(PUBLISHED_URLS)).resolves.toBe(true);
  });
});

describe('processDoc', () => {
  beforeEach(() => {
    vi.stubEnv('RESEND_API_KEY', '');
    // mockReturnValueOnce queues leak across tests if a prior test never
    // actually calls the mock (e.g. the grace-window test short-circuits
    // before reaching checkArticleIdExists) — reset the queue every test.
    vi.mocked(checkArticleIdExists).mockReset().mockReturnValue(false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function makeDocSnap(overrides: Record<string, unknown> = {}) {
    const data = {
      authorEmail: 'journalist@example.com',
      publishedUrls: PUBLISHED_URLS,
      ...overrides,
    };
    const ref: any = { update: vi.fn().mockResolvedValue(undefined) };
    // The "online" email is claimed in a transaction before it is sent (perf-plan
    // email senders, F3): the double reads the same document the snapshot carries.
    ref.firestore = {
      runTransaction: async (fn: (tx: any) => Promise<unknown>) => fn({
        get: async () => ({ exists: true, data: () => data }),
        update: (_ref: unknown, patch: Record<string, unknown>) => { ref.update(patch); },
      }),
    };
    return { id: 'test-doc', data: () => data, ref };
  }

  it('does not stamp liveVerifiedAt while any locale is still 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => Promise.resolve({ ok: !url.includes('/de/') })),
    );
    const docSnap = makeDocSnap();
    const FieldValue = { serverTimestamp: () => 'SERVER_TIMESTAMP' };

    await processDoc(FieldValue as any, docSnap as any);

    expect(docSnap.ref.update).not.toHaveBeenCalled();
  });

  it('stamps liveVerifiedAt once all 4 locales are live', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })));
    const docSnap = makeDocSnap();
    const FieldValue = { serverTimestamp: () => 'SERVER_TIMESTAMP' };

    await processDoc(FieldValue as any, docSnap as any);

    expect(docSnap.ref.update).toHaveBeenCalledWith({ liveVerifiedAt: 'SERVER_TIMESTAMP' });
    // The claim is written first, the stamp last.
    const calls = docSnap.ref.update.mock.calls.map(([patch]: any[]) => Object.keys(patch)[0]);
    expect(calls).toEqual(['liveNotifyClaimedAt', 'liveVerifiedAt']);
  });

  it('requeues a doc still 404 past the orphan threshold when its id is absent from the registry', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false })));
    const fourHoursAgo = { toMillis: () => Date.now() - 4 * 60 * 60 * 1000 };
    const docSnap = makeDocSnap({ publishedAt: fourHoursAgo });
    const FieldValue = { serverTimestamp: () => 'SERVER_TIMESTAMP', delete: () => 'FIELD_DELETE' };

    await processDoc(FieldValue as any, docSnap as any);

    expect(docSnap.ref.update).toHaveBeenCalledWith({
      status: 'queued',
      publishedAt: 'FIELD_DELETE',
      publishedUrls: 'FIELD_DELETE',
      slugs: 'FIELD_DELETE',
      liveVerifiedAt: 'FIELD_DELETE',
    });
  });

  it('does not requeue while still within the orphan grace window', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false })));
    const oneHourAgo = { toMillis: () => Date.now() - 1 * 60 * 60 * 1000 };
    const docSnap = makeDocSnap({ publishedAt: oneHourAgo });
    const FieldValue = { serverTimestamp: () => 'SERVER_TIMESTAMP', delete: () => 'FIELD_DELETE' };

    await processDoc(FieldValue as any, docSnap as any);

    expect(docSnap.ref.update).not.toHaveBeenCalled();
  });

  it('does not requeue past the threshold when the id IS present in the registry (commit landed, deploy just slow)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false })));
    vi.mocked(checkArticleIdExists).mockReturnValueOnce(true);
    const fourHoursAgo = { toMillis: () => Date.now() - 4 * 60 * 60 * 1000 };
    const docSnap = makeDocSnap({ publishedAt: fourHoursAgo });
    const FieldValue = { serverTimestamp: () => 'SERVER_TIMESTAMP', delete: () => 'FIELD_DELETE' };

    await processDoc(FieldValue as any, docSnap as any);

    expect(docSnap.ref.update).not.toHaveBeenCalled();
  });
});

// ── F3 (perf-plan email senders): narrowed query and claim before the email ──────
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { claimLiveNotification, loadPendingArticles } from '../scripts/notify-journalist-article-live.mjs';

const SERVER_TS = 'SERVER_TIMESTAMP';
const FV = { serverTimestamp: () => SERVER_TS, delete: () => 'FIELD_DELETE' };

function claimRef(initial: Record<string, unknown> | null) {
  let data = initial ? { ...initial } : null;
  const updates: Array<Record<string, unknown>> = [];
  const ref: any = {
    update: vi.fn(async (patch: Record<string, unknown>) => { data = { ...(data || {}), ...patch }; updates.push(patch); }),
  };
  ref.firestore = {
    runTransaction: async (fn: (tx: any) => Promise<unknown>) => fn({
      get: async () => ({ exists: data !== null, data: () => data }),
      update: (_r: unknown, patch: Record<string, unknown>) => { data = { ...(data || {}), ...patch }; updates.push(patch); },
    }),
  };
  return { ref, updates, read: () => data };
}

describe('claim before the email', () => {
  it('claims once: the first run claims, a second run never claims again', async () => {
    const { ref, read } = claimRef({ status: 'published', liveVerifiedAt: null });
    await expect(claimLiveNotification(ref, FV as any, 'run-1')).resolves.toBe('claimed');
    expect(read()).toMatchObject({ liveNotifyClaimedAt: SERVER_TS, liveNotifyClaimId: 'run-1' });
    await expect(claimLiveNotification(ref, FV as any, 'run-2')).resolves.toBe('already-claimed');
    expect(read()).toMatchObject({ liveNotifyClaimId: 'run-1' });
  });

  it('an article already stamped live is never claimed', async () => {
    const { ref, updates } = claimRef({ status: 'published', liveVerifiedAt: 'stamped' });
    await expect(claimLiveNotification(ref, FV as any, 'run-1')).resolves.toBe('already-verified');
    expect(updates).toEqual([]);
  });

  it('a missing document is reported, not created', async () => {
    const { ref, updates } = claimRef(null);
    await expect(claimLiveNotification(ref, FV as any, 'run-1')).resolves.toBe('missing');
    expect(updates).toEqual([]);
  });

  it('the email goes out AFTER the claim and BEFORE the stamp; a failed stamp cannot cause a second email', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })));
    const order: string[] = [];
    const { ref } = claimRef({ status: 'published', liveVerifiedAt: null });
    const realUpdate = ref.update;
    ref.update = vi.fn(async (patch: any) => {
      order.push(`update:${Object.keys(patch)[0]}`);
      // The stamp fails (Firestore unavailable) after the email left.
      if ('liveVerifiedAt' in patch) throw new Error('UNAVAILABLE');
      return realUpdate(patch);
    });
    const docSnap: any = {
      id: 'doc-a', ref,
      data: () => ({ authorEmail: 'journalist@example.com', publishedUrls: PUBLISHED_URLS, liveVerifiedAt: null }),
    };
    await expect(processDoc(FV as any, docSnap)).rejects.toThrow('UNAVAILABLE');
    expect(order[0]).toBe('update:liveVerifiedAt'); // (the transactional claim bypasses ref.update)

    // Next run: the claim is present, so the notification is NOT sent again and the article is stamped.
    const next = claimRef({ status: 'published', liveVerifiedAt: null, liveNotifyClaimedAt: SERVER_TS });
    const sendSpy = vi.fn();
    vi.stubGlobal('fetch', vi.fn((...args: unknown[]) => { sendSpy(...args); return Promise.resolve({ ok: true }); }));
    const docNext: any = { id: 'doc-a', ref: next.ref, data: () => ({ authorEmail: 'journalist@example.com', publishedUrls: PUBLISHED_URLS, liveVerifiedAt: null, liveNotifyClaimedAt: SERVER_TS }) };
    await processDoc(FV as any, docNext);
    expect(next.read()).toMatchObject({ liveVerifiedAt: SERVER_TS });
    // Only the four live-checks hit the network: no provider call.
    expect(sendSpy.mock.calls.every(([url]) => String(url).startsWith('https://frontaliereticino.ch'))).toBe(true);
  });

  it('dry-run reads and checks but claims, sends, stamps and requeues nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })));
    const { ref, updates } = claimRef({ status: 'published', liveVerifiedAt: null });
    const docSnap: any = { id: 'doc-b', ref, data: () => ({ publishedUrls: PUBLISHED_URLS }) };
    await processDoc(FV as any, docSnap, { dryRun: true });
    expect(updates).toEqual([]);
    expect(ref.update).not.toHaveBeenCalled();
  });
});

describe('narrowed pending query', () => {
  function queryDb(docs: any[]) {
    const filters: Array<[string, string, unknown]> = [];
    const make = (f: Array<[string, string, unknown]>): any => ({
      where: (field: string, op: string, value: unknown) => make([...f, [field, op, value]]),
      get: async () => { filters.push(...f); return { docs }; },
    });
    return { db: { collection: (name: string) => { expect(name).toBe('journalist_articles'); return make([]); } }, filters };
  }

  it('the default query is status == published AND liveVerifiedAt == null (two equalities, no new index)', async () => {
    const { db, filters } = queryDb([{ id: 'a', data: () => ({ liveVerifiedAt: null }) }]);
    const pending = await loadPendingArticles(db as any);
    expect(filters).toEqual([['status', '==', 'published'], ['liveVerifiedAt', '==', null]]);
    expect(pending).toHaveLength(1);
  });

  it('the kill switch scope=all reads every published article and filters in memory', async () => {
    const { db, filters } = queryDb([
      { id: 'pending', data: () => ({}) },
      { id: 'null', data: () => ({ liveVerifiedAt: null }) },
      { id: 'done', data: () => ({ liveVerifiedAt: 'ts' }) },
    ]);
    const pending = await loadPendingArticles(db as any, { scope: 'all' });
    expect(filters).toEqual([['status', '==', 'published']]);
    expect(pending.map((d: any) => d.id)).toEqual(['pending', 'null']);
  });

  it('PRECONDITION: the publisher is the only writer of published and always stamps liveVerifiedAt: null', () => {
    const publisher = readFileSync(path.resolve(__dirname, '../scripts/publish-journalist-article.mjs'), 'utf8');
    expect(publisher).toMatch(/liveVerifiedAt: null,/);
    for (const rel of ['scripts', 'functions/src']) {
      // No other module sets status 'published' on journalist_articles without the null stamp.
      const stack = [path.resolve(__dirname, '..', rel)];
      const offenders: string[] = [];
      const fs = require('node:fs');
      while (stack.length) {
        const dir = stack.pop()!;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { if (entry.name !== 'node_modules') stack.push(full); continue; }
          if (!/\.(m?js)$/.test(entry.name)) continue;
          const text = fs.readFileSync(full, 'utf8');
          if (text.includes('journalist_articles') && /status:\s*['"]published['"]/.test(text) && !text.includes('liveVerifiedAt')) {
            offenders.push(path.relative(path.resolve(__dirname, '..'), full));
          }
        }
      }
      expect(offenders, `writers of status published without liveVerifiedAt: ${offenders.join(', ')}`).toEqual([]);
    }
  });
});
