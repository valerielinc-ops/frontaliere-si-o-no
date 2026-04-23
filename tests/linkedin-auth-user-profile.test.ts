import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

describe('LinkedIn auth Cloud Function — subscriber profile enrichment', () => {
  const source = readFileSync(
    resolve(root, 'functions/src/linkedinAuthCallback.js'),
    'utf8'
  );

  it('extracts all OpenID Connect fields from userInfo', () => {
    expect(source).toContain('userInfo.given_name');
    expect(source).toContain('userInfo.family_name');
    expect(source).toContain('userInfo.locale');
    expect(source).toContain('userInfo.email_verified');
    expect(source).toContain('userInfo.sub');
  });

  it('enriches newsletter_subscribers collection with LinkedIn data', () => {
    expect(source).toContain("db.collection('newsletter_subscribers')");
    expect(source).toContain('enrichSubscriberProfile(email,');
    expect(source).toContain('firstName,');
    expect(source).toContain('lastName,');
    expect(source).toContain('linkedInSub,');
    expect(source).toContain("auth_provider: 'linkedin'");
  });

  it('always updates lastLoginAt and updatedAt on login', () => {
    expect(source).toContain('lastLoginAt: admin.firestore.FieldValue.serverTimestamp()');
    expect(source).toContain('updatedAt: admin.firestore.FieldValue.serverTimestamp()');
  });

  it('handles Firestore write failure gracefully (best-effort)', () => {
    expect(source).toContain("console.error('[linkedinAuthCallback] Failed to enrich subscriber profile:'");
    const enrichFn = source.slice(
      source.indexOf('async function enrichSubscriberProfile'),
      source.indexOf('async function handleLinkedInCallback')
    );
    expect(enrichFn).toContain('try {');
    expect(enrichFn).toContain('} catch (err) {');
  });

  it('fetches basic profile via r_basicprofile scope', () => {
    expect(source).toContain('fetchLinkedInBasicProfile');
    expect(source).toContain('/v2/me');
    expect(source).toContain('localizedHeadline');
    expect(source).toContain('vanityName');
  });

  it('does not overwrite existing data with nulls on login', () => {
    expect(source).toContain('if (value != null)');
  });

  it('uses merge mode for subscriber document', () => {
    expect(source).toContain("{ merge: true }");
  });
});

describe('Firestore rules — newsletter_subscribers collection', () => {
  const rules = readFileSync(resolve(root, 'firestore.rules'), 'utf8');

  it('has rules for newsletter_subscribers collection', () => {
    expect(rules).toContain('match /newsletter_subscribers/{email}');
  });

  it('allows public read and write for subscriber documents', () => {
    const subBlock = rules.slice(
      rules.indexOf('match /newsletter_subscribers/{email}'),
      rules.indexOf('}', rules.indexOf('match /newsletter_subscribers/{email}') + 80) + 1
    );
    expect(subBlock).toContain('allow read, write: if true');
  });
});

describe('Frontend authService — subscriber profile enrichment', () => {
  const source = readFileSync(resolve(root, 'services/authService.ts'), 'utf8');

  it('exports saveUserProfileToFirestore function', () => {
    expect(source).toContain('export async function saveUserProfileToFirestore');
  });

  it('writes to newsletter_subscribers collection', () => {
    const profileFn = source.slice(
      source.indexOf('export async function saveUserProfileToFirestore'),
      source.indexOf('// ─── Auth Functions')
    );
    expect(profileFn).toContain("'newsletter_subscribers'");
  });

  it('uses email as document key', () => {
    const profileFn = source.slice(
      source.indexOf('export async function saveUserProfileToFirestore'),
      source.indexOf('// ─── Auth Functions')
    );
    expect(profileFn).toContain('.trim().toLowerCase()');
  });

  it('uses merge mode to avoid overwriting existing data', () => {
    expect(source).toContain("{ merge: true }");
  });

  it('handles Firestore write failure gracefully', () => {
    expect(source).toContain('.catch(() => {})');
    expect(source).toContain("console.warn('[Auth] Failed to enrich subscriber profile:'");
  });
});

describe('Frontend App.tsx — LinkedIn profile saving', () => {
  const source = readFileSync(resolve(root, 'App.tsx'), 'utf8');

  it('imports saveUserProfileToFirestore', () => {
    expect(source).toContain("saveUserProfileToFirestore,");
  });

  it('saves profile after LinkedIn sign-in', () => {
    const linkedinSection = source.slice(
      source.indexOf("'auth', 'linkedin', 'login', user ? 'success' : 'no-user'"),
      source.indexOf("if (cancelled) return;", source.indexOf("'auth', 'linkedin', 'login', user ? 'success' : 'no-user'"))
    );
    expect(linkedinSection).toContain("saveUserProfileToFirestore(user, 'linkedin')");
  });
});

describe('App.tsx — LinkedIn callback path resilience', () => {
  const source = readFileSync(resolve(root, 'App.tsx'), 'utf8');

  const handlerStart = source.indexOf('// LinkedIn OAuth2 callback handler');
  // The handler's own `useEffect(() => {` is the first match after the comment.
  // We want the NEXT useEffect after the handler closes — skip two occurrences.
  const firstUseEffect = source.indexOf('useEffect(() => {', handlerStart);
  const handlerEnd = source.indexOf('useEffect(() => {', firstUseEffect + 1);
  const callbackHandler = source.slice(handlerStart, handlerEnd);

  it('does not hard-fail when pathname is / instead of /auth/linkedin/callback', () => {
    // Regression: users whose browsers fail the sessionStorage-based SPA restoration
    // land on /?code=...&state=... instead of /auth/linkedin/callback. The handler
    // must still process the code in that case.
    expect(callbackHandler).toContain("path !== '/auth/linkedin/callback' && path !== '/'");
  });

  it('requires state param to decode to a path (guards against false positives)', () => {
    expect(callbackHandler).toContain("if (!decodedState.startsWith('/')) return;");
  });

  it('requires state param to be present', () => {
    expect(callbackHandler).toContain('if (!state) return;');
  });

  it('returns early when neither code nor error is present', () => {
    expect(callbackHandler).toContain('if (!code && !errorParam) return;');
  });

  it('uses the decoded state as redirect target after successful sign-in', () => {
    expect(callbackHandler).toContain("window.location.replace(decodedState || '/')");
  });
});

describe('UserProfile.tsx — profile persistence', () => {
  const source = readFileSync(resolve(root, 'components/pages/UserProfile.tsx'), 'utf8');

  it('saves profile to newsletter_subscribers collection', () => {
    expect(source).toContain("doc(db, 'newsletter_subscribers', key)");
  });

  it('loads profile from newsletter_subscribers collection', () => {
    const loadFn = source.slice(
      source.indexOf('const loadProfileFromFirestore'),
      source.indexOf('} catch {', source.indexOf('const loadProfileFromFirestore'))
    );
    expect(loadFn).toContain("'newsletter_subscribers'");
  });

  it('does not reference user_profiles collection', () => {
    expect(source).not.toContain("'user_profiles'");
  });
});
