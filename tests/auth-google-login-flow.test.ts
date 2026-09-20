import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

describe('Google auth flow hardening', () => {
  it('initializes GIS only once and keeps explicit sign-in on a popup/redirect path', () => {
    const source = readFileSync(resolve(root, 'services/authService.ts'), 'utf8');
    const initializeMatches = source.match(/window\.google\.accounts\.id\.initialize\(/g) || [];

    expect(source).toContain('let oneTapInitPromise: Promise<boolean> | null = null;');
    expect(source).toContain('if (oneTapInitPromise) return oneTapInitPromise;');
    expect(initializeMatches).toHaveLength(1);
    expect(source).toContain("setAuthRedirectState('google');");
    expect(source).toContain('await _authModule.signInWithRedirect(authInstance, googleProvider);');
  });

  it('does not spend the interactive subscription quota on auth profile reconciliation', () => {
    const source = readFileSync(resolve(root, 'services/authService.ts'), 'utf8');
    const start = source.indexOf('export async function saveUserProfileToFirestore');
    const end = source.indexOf('// ─── Auth Functions', start);
    const profileWriter = source.slice(start, end);

    expect(profileWriter).toMatch(
      /upsertNewsletterSubscriber\(db,[\s\S]*?skipRateLimit:\s*true[\s\S]*?\}\);/,
    );
  });
});
