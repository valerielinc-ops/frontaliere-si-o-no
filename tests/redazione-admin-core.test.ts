import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mirrors admin-send-cold-email-handler.test.ts's approach for the
// non-DI handler style (handleManageJournalistRole/adminEmployerInsights):
// mock the two things redazioneAdminCore.js imports — the admin gate and
// the Admin SDK db — so we exercise the real handler logic without a live
// Firebase project.

const verifyIdToken = vi.fn();
vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ verifyIdToken }),
}));

function fakeCollection(store: Record<string, any>) {
  const writes: Array<{ id: string; data: any }> = [];
  return {
    writes,
    async get() {
      const docs = Object.entries(store).map(([id, data]) => ({ id, data: () => data }));
      return { docs };
    },
    doc(id: string) {
      return {
        async set(payload: any, opts?: { merge?: boolean }) {
          writes.push({ id, data: payload });
          store[id] = opts?.merge ? { ...(store[id] || {}), ...payload } : payload;
        },
      };
    },
  };
}

function fakeDb(data: { journalist_articles?: Record<string, any>; author_profiles?: Record<string, any>; article_author_overrides?: Record<string, any> } = {}) {
  const collections: Record<string, ReturnType<typeof fakeCollection>> = {
    journalist_articles: fakeCollection(data.journalist_articles || {}),
    author_profiles: fakeCollection(data.author_profiles || {}),
    article_author_overrides: fakeCollection(data.article_author_overrides || {}),
  };
  return { collection: (name: string) => collections[name], _collections: collections };
}

let mockDb: ReturnType<typeof fakeDb>;
vi.mock('../functions/src/newsletterResendWebhookCore.js', () => ({
  getAdminDb: () => mockDb,
}));

const ADMIN_EMAIL = 'valerielinc@gmail.com';

function adminReq(overrides: Record<string, any> = {}) {
  return {
    method: 'GET',
    get: (h: string) => (h === 'Authorization' ? 'Bearer valid-token' : undefined),
    ...overrides,
  };
}

// eslint-disable-next-line import/first
const { handleRedazioneAdmin } = await import('../functions/src/redazioneAdminCore.js');

describe('handleRedazioneAdmin', () => {
  beforeEach(() => {
    mockDb = fakeDb();
    verifyIdToken.mockReset();
    verifyIdToken.mockResolvedValue({ email: ADMIN_EMAIL, email_verified: true });
  });

  it('rejects a non-admin caller', async () => {
    verifyIdToken.mockResolvedValue({ email: 'someone-else@example.com', email_verified: true });
    const res = await handleRedazioneAdmin(adminReq());
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'not_admin' });
  });

  it('rejects a request with no Authorization header', async () => {
    const res = await handleRedazioneAdmin({ method: 'GET', get: () => undefined });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'missing_id_token' });
  });

  it('rejects an unsupported method', async () => {
    const res = await handleRedazioneAdmin(adminReq({ method: 'DELETE' }));
    expect(res.status).toBe(405);
  });

  it('GET lists journalist articles across all authors plus both override collections', async () => {
    mockDb = fakeDb({
      journalist_articles: {
        'art-1': {
          authorUid: 'uid-1',
          authorName: 'Giulia Bianchi',
          authorEmail: 'giulia@example.com',
          category: 'fiscalita',
          content: { it: { title: 'Titolo articolo' } },
          status: 'published',
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-02T00:00:00.000Z',
          publishedAt: '2026-06-02T00:00:00.000Z',
          publishedUrls: { it: '/blog/titolo-articolo/' },
        },
      },
      author_profiles: { 'marco-ferrari': { bio: 'Bio aggiornata' } },
      article_author_overrides: { 'art-ai-1': { authorSlug: 'samuele-valente', authorName: 'Samuele Valente' } },
    });
    const res = await handleRedazioneAdmin(adminReq());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.journalistArticles).toHaveLength(1);
    expect(res.body.journalistArticles[0]).toMatchObject({
      id: 'art-1',
      authorUid: 'uid-1',
      title: 'Titolo articolo',
      status: 'published',
    });
    expect(res.body.authorProfiles['marco-ferrari']).toEqual({ bio: 'Bio aggiornata' });
    expect(res.body.articleAuthorOverrides['art-ai-1']).toEqual({
      authorSlug: 'samuele-valente',
      authorName: 'Samuele Valente',
    });
  });

  it('POST updateProfile upserts only the allowlisted fields', async () => {
    const res = await handleRedazioneAdmin(
      adminReq({
        method: 'POST',
        body: {
          action: 'updateProfile',
          slug: 'marco-ferrari',
          patch: { bio: 'Nuova bio', role: 'Redattore capo', social: { linkedin: 'https://linkedin.com/in/x' } },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const written = mockDb._collections.author_profiles.writes.at(-1)!.data;
    expect(written.bio).toBe('Nuova bio');
    expect(written.role).toBe('Redattore capo');
    expect(written.social).toEqual({ linkedin: 'https://linkedin.com/in/x' });
    expect(written.updatedBy).toBe(ADMIN_EMAIL);
  });

  it('POST updateProfile rejects a field outside the allowlist', async () => {
    const res = await handleRedazioneAdmin(
      adminReq({
        method: 'POST',
        body: { action: 'updateProfile', slug: 'marco-ferrari', patch: { isAdmin: true } },
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_input');
  });

  it('POST updateProfile rejects an invalid slug', async () => {
    const res = await handleRedazioneAdmin(
      adminReq({
        method: 'POST',
        body: { action: 'updateProfile', slug: 'Not A Slug!', patch: { bio: 'x' } },
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_input');
  });

  it('POST reassignArticle upserts the article override', async () => {
    const res = await handleRedazioneAdmin(
      adminReq({
        method: 'POST',
        body: {
          action: 'reassignArticle',
          articleId: 'la-sospensione-dei-ristorni',
          authorSlug: 'samuele-valente',
          authorName: 'Samuele Valente',
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const written = mockDb._collections.article_author_overrides.writes.at(-1)!.data;
    expect(written).toMatchObject({ authorSlug: 'samuele-valente', authorName: 'Samuele Valente' });
  });

  it('POST reassignArticle rejects missing fields', async () => {
    const res = await handleRedazioneAdmin(
      adminReq({ method: 'POST', body: { action: 'reassignArticle', articleId: 'x' } }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_input');
  });

  it('POST with an unknown action is rejected', async () => {
    const res = await handleRedazioneAdmin(adminReq({ method: 'POST', body: { action: 'deleteEverything' } }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_input');
  });
});
