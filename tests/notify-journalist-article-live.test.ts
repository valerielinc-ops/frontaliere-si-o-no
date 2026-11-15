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

const cascade = vi.hoisted(() => ({
  impl: null as null | ((items: any[], opts: any) => Promise<any>),
  calls: 0,
}));
vi.mock('../scripts/lib/email-cascade.mjs', () => ({
  sendEmailCascade: async (items: any[], opts: any) => {
    cascade.calls += 1;
    return cascade.impl ? cascade.impl(items, opts) : { sent: items.map((i) => ({ ...i })), failed: [] };
  },
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
    cascade.impl = null;
    cascade.calls = 0;
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
import { claimLiveNotification, loadPendingArticles, releaseLiveNotificationClaim } from '../scripts/notify-journalist-article-live.mjs';

const SERVER_TS = 'SERVER_TIMESTAMP';
const FV = { serverTimestamp: () => SERVER_TS, delete: () => 'FIELD_DELETE' };

function claimRef(initial: Record<string, unknown> | null) {
  let data = initial ? { ...initial } : null;
  const updates: Array<Record<string, unknown>> = [];
  const apply = (patch: Record<string, unknown>) => {
    const next: Record<string, unknown> = { ...(data || {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === 'FIELD_DELETE') delete next[key]; else next[key] = value;
    }
    data = next;
  };
  const ref: any = {
    update: vi.fn(async (patch: Record<string, unknown>) => { apply(patch); updates.push(patch); }),
  };
  ref.firestore = {
    runTransaction: async (fn: (tx: any) => Promise<unknown>) => fn({
      get: async () => ({ exists: data !== null, data: () => data }),
      update: (_r: unknown, patch: Record<string, unknown>) => { apply(patch); updates.push(patch); },
    }),
  };
  return { ref, updates, read: () => data };
}

describe('claim before the email', () => {
  it('every publish clears the claim of an earlier notification cycle', () => {
    // A re-published article gets `liveVerifiedAt: null` again; a claim left from
    // its previous cycle would make the next run stamp it without the email.
    const publisher = readFileSync(path.resolve(__dirname, '../scripts/publish-journalist-article.mjs'), 'utf8');
    const stamp = publisher.slice(publisher.indexOf("status: 'published'"));
    expect(stamp).toContain('liveVerifiedAt: null');
    expect(stamp).toContain('liveNotifyClaimedAt: FieldValue.delete()');
    expect(stamp).toContain('liveNotifyClaimId: FieldValue.delete()');
  });

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

  it('ambiguous outcome (timeout): the claim stays, the article is stamped, nothing is re-sent', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })));
    cascade.calls = 0;
    cascade.impl = async () => { throw new Error('The operation was aborted due to timeout'); };
    const first = claimRef({ status: 'published', liveVerifiedAt: null });
    const docSnap: any = { id: 'doc-a', ref: first.ref, data: () => ({ authorEmail: 'journalist@example.com', publishedUrls: PUBLISHED_URLS, liveVerifiedAt: null }) };
    await processDoc(FV as any, docSnap, { claimId: 'run-1' });
    expect(cascade.calls).toBe(1);
    expect(first.read()).toMatchObject({ liveNotifyClaimId: 'run-1', liveVerifiedAt: SERVER_TS });

    // Next run on a doc that kept the claim but was never stamped: no second email.
    const next = claimRef({ status: 'published', liveVerifiedAt: null, liveNotifyClaimedAt: SERVER_TS, liveNotifyClaimId: 'run-1' });
    const docNext: any = { id: 'doc-a', ref: next.ref, data: () => ({ authorEmail: 'journalist@example.com', publishedUrls: PUBLISHED_URLS, liveVerifiedAt: null }) };
    await processDoc(FV as any, docNext, { claimId: 'run-2' });
    expect(cascade.calls).toBe(1);
    expect(next.read()).toMatchObject({ liveVerifiedAt: SERVER_TS });
  });

  it('an ambiguousDelivery failure flagged by the cascade also keeps the claim', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })));
    cascade.calls = 0;
    cascade.impl = async () => ({ sent: [], failed: [{ error: 'response lost', ambiguousDelivery: true }] });
    const { ref, read } = claimRef({ status: 'published', liveVerifiedAt: null });
    await processDoc(FV as any, { id: 'd', ref, data: () => ({ authorEmail: 'j@example.com', publishedUrls: PUBLISHED_URLS }) } as any, { claimId: 'run-1' });
    expect(read()).toMatchObject({ liveNotifyClaimId: 'run-1', liveVerifiedAt: SERVER_TS });
  });

  it('definite failure: the claim is released, the article is NOT stamped, the next run retries and stamps once sent', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })));
    cascade.calls = 0;
    cascade.impl = async () => ({ sent: [], failed: [{ error: 'provider rejected', ambiguousDelivery: false }] });
    const { ref, read } = claimRef({ status: 'published', liveVerifiedAt: null });
    const docSnap: any = { id: 'd', ref, data: () => ({ authorEmail: 'j@example.com', publishedUrls: PUBLISHED_URLS }) };
    await processDoc(FV as any, docSnap, { claimId: 'run-1' });
    expect(read().liveNotifyClaimedAt).toBeUndefined();
    expect(read().liveNotifyClaimId).toBeUndefined();
    expect(read().liveVerifiedAt).toBeNull();
    expect(cascade.calls).toBe(1);

    // Next run: the provider still refuses -> retried (not stamped).
    await processDoc(FV as any, docSnap, { claimId: 'run-2' });
    expect(cascade.calls).toBe(2);
    expect(read().liveVerifiedAt).toBeNull();

    // Next run: a send succeeds -> stamped, after exactly one more attempt.
    cascade.impl = null;
    await processDoc(FV as any, docSnap, { claimId: 'run-3' });
    expect(cascade.calls).toBe(3);
    expect(read()).toMatchObject({ liveNotifyClaimId: 'run-3', liveVerifiedAt: SERVER_TS });
  });

  it('the release only touches OUR claim and never an already stamped article', async () => {
    const mine = claimRef({ liveNotifyClaimedAt: SERVER_TS, liveNotifyClaimId: 'run-1', liveVerifiedAt: null });
    await expect(releaseLiveNotificationClaim(mine.ref, FV as any, 'run-1')).resolves.toBe('released');
    const theirs = claimRef({ liveNotifyClaimedAt: SERVER_TS, liveNotifyClaimId: 'run-9', liveVerifiedAt: null });
    await expect(releaseLiveNotificationClaim(theirs.ref, FV as any, 'run-1')).resolves.toBe('not-owner');
    expect(theirs.read()).toMatchObject({ liveNotifyClaimId: 'run-9' });
    const done = claimRef({ liveNotifyClaimId: 'run-1', liveVerifiedAt: 'ts' });
    await expect(releaseLiveNotificationClaim(done.ref, FV as any, 'run-1')).resolves.toBe('already-verified');
    await expect(releaseLiveNotificationClaim(claimRef(null).ref, FV as any, 'run-1')).resolves.toBe('missing');
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

  it('the DEFAULT scope reads every published article and filters in memory: an article WITHOUT liveVerifiedAt is returned', async () => {
    const { db, filters } = queryDb([
      { id: 'absent', data: () => ({}) },
      { id: 'null', data: () => ({ liveVerifiedAt: null }) },
      { id: 'done', data: () => ({ liveVerifiedAt: 'ts' }) },
    ]);
    const pending = await loadPendingArticles(db as any);
    expect(filters).toEqual([['status', '==', 'published']]);
    expect(pending.map((d: any) => d.id)).toEqual(['absent', 'null']);
  });

  it('scope=pending is an explicit opt-in: status == published AND liveVerifiedAt == null (no new index)', async () => {
    const { db, filters } = queryDb([{ id: 'a', data: () => ({ liveVerifiedAt: null }) }]);
    const pending = await loadPendingArticles(db as any, { scope: 'pending' });
    expect(filters).toEqual([['status', '==', 'published'], ['liveVerifiedAt', '==', null]]);
    expect(pending).toHaveLength(1);
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
