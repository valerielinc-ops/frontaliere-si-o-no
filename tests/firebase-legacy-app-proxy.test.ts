import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { reportCaughtError } = vi.hoisted(() => ({
  reportCaughtError: vi.fn(),
}));

vi.mock('@/services/errorReporter', () => ({ reportCaughtError }));

describe('legacy Firebase app proxy', () => {
  const originalFirebaseApiKey = process.env.FIREBASE_API_KEY;
  const originalViteFirebaseApiKey = process.env.VITE_FIREBASE_API_KEY;

  afterEach(() => {
    if (originalFirebaseApiKey === undefined) delete process.env.FIREBASE_API_KEY;
    else process.env.FIREBASE_API_KEY = originalFirebaseApiKey;
    if (originalViteFirebaseApiKey === undefined) delete process.env.VITE_FIREBASE_API_KEY;
    else process.env.VITE_FIREBASE_API_KEY = originalViteFirebaseApiKey;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('reports a rejected lazy initialization instead of leaving it unhandled', async () => {
    delete process.env.FIREBASE_API_KEY;
    delete process.env.VITE_FIREBASE_API_KEY;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('public config unavailable')));
    const { app } = await import('@/services/firebase');

    void app.name;

    await vi.waitFor(() => {
      expect(reportCaughtError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Firebase Web API key unavailable from runtime public config',
        }),
        'firebase.legacyAppProxy',
      );
    });
  });

  it('makes the JobBoard Firestore read await the real app instance', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'components/community/JobBoard.tsx'),
      'utf8',
    );
    const profileRead = source.match(
      /const \[\{ getFirestore, doc, getDoc \}[\s\S]*?const snap = await getDoc\([\s\S]*?\n\s*if \(cancelled/,
    )?.[0];

    expect(profileRead).toBeDefined();
    expect(profileRead).toContain('{ getApp }');
    expect(profileRead).toContain('getFirestore(await getApp())');
    expect(profileRead).not.toContain('{ app }');
  });
});
