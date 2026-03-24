import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

describe('LinkedIn auth Cloud Function — user profile enrichment', () => {
  const source = readFileSync(
    resolve(root, 'functions/src/linkedinAuthCallback.js'),
    'utf8'
  );

  it('extracts all OpenID Connect fields from userInfo', () => {
    // Core identity fields
    expect(source).toContain('userInfo.given_name');
    expect(source).toContain('userInfo.family_name');
    expect(source).toContain('userInfo.locale');
    expect(source).toContain('userInfo.email_verified');
    expect(source).toContain('userInfo.sub');
  });

  it('saves enriched profile to Firestore users collection', () => {
    expect(source).toContain("db.collection('users').doc(uid)");
    expect(source).toContain('saveUserProfile(uid,');
    // Must include all profile fields
    expect(source).toContain('firstName,');
    expect(source).toContain('lastName,');
    expect(source).toContain('locale,');
    expect(source).toContain('linkedInSub,');
    expect(source).toContain("provider: 'linkedin'");
    expect(source).toContain("dataSource: 'linkedin_openid'");
  });

  it('sets createdAt only for new users and always updates lastLoginAt', () => {
    expect(source).toContain('createdAt: admin.firestore.FieldValue.serverTimestamp()');
    expect(source).toContain('lastLoginAt: admin.firestore.FieldValue.serverTimestamp()');
    expect(source).toContain('isNewUser');
  });

  it('handles Firestore write failure gracefully (best-effort)', () => {
    expect(source).toContain("console.error('[linkedinAuthCallback] Failed to save user profile:'");
    // The saveUserProfile function must be wrapped in try/catch
    const saveProfileFn = source.slice(
      source.indexOf('async function saveUserProfile'),
      source.indexOf('async function handleLinkedInCallback')
    );
    expect(saveProfileFn).toContain('try {');
    expect(saveProfileFn).toContain('} catch (err) {');
  });

  it('documents that professional data requires additional scopes', () => {
    expect(source).toContain('fetchLinkedInProfessionalData');
    expect(source).toContain('jobTitle: null');
    expect(source).toContain('company: null');
    expect(source).toContain('industry: null');
    // Must document scope limitations
    expect(source).toContain('additional scopes');
  });

  it('tracks isNewUser flag for conditional profile creation', () => {
    expect(source).toContain('let isNewUser = false');
    expect(source).toContain('isNewUser = true');
    expect(source).toContain('}, isNewUser)');
  });

  it('does not overwrite existing data with nulls on login', () => {
    // When updating existing user, only non-null values should be written
    expect(source).toContain('if (value != null)');
  });
});

describe('Firestore rules — users collection', () => {
  const rules = readFileSync(resolve(root, 'firestore.rules'), 'utf8');

  it('has rules for users/{uid} collection', () => {
    expect(rules).toContain("match /users/{uid}");
  });

  it('allows only the owning user to read their profile', () => {
    expect(rules).toContain('allow read: if request.auth != null && request.auth.uid == uid');
  });

  it('allows only the owning user to create their profile', () => {
    expect(rules).toContain('allow create: if request.auth != null && request.auth.uid == uid');
  });

  it('allows only the owning user to update their profile', () => {
    expect(rules).toContain('allow update: if request.auth != null && request.auth.uid == uid');
  });

  it('does not allow delete of user profiles (admin SDK only)', () => {
    // Extract the users block
    const usersBlock = rules.slice(
      rules.indexOf('match /users/{uid}'),
      rules.indexOf('}', rules.indexOf('allow update: if request.auth != null && request.auth.uid == uid') + 10) + 1
    );
    expect(usersBlock).not.toContain('allow delete');
  });
});

describe('Frontend authService — user profile saving', () => {
  const source = readFileSync(resolve(root, 'services/authService.ts'), 'utf8');

  it('exports saveUserProfileToFirestore function', () => {
    expect(source).toContain('export async function saveUserProfileToFirestore');
  });

  it('saves profile after Google popup sign-in', () => {
    // After signInWithPopup for Google, saveUserProfileToFirestore should be called
    const googlePopupSection = source.slice(
      source.indexOf("Analytics.trackUIInteraction('auth', 'google', 'login', 'popup-start')"),
      source.indexOf("throw popupError;")
    );
    expect(googlePopupSection).toContain("saveUserProfileToFirestore(result.user, 'google')");
  });

  it('saves profile after Facebook popup sign-in', () => {
    const facebookSection = source.slice(
      source.indexOf("await patchFacebookData(result);"),
      source.indexOf("} catch (popupError: any) {", source.indexOf("await patchFacebookData(result);"))
    );
    expect(facebookSection).toContain("saveUserProfileToFirestore(result.user, 'facebook')");
  });

  it('saves profile after redirect sign-in', () => {
    const redirectSection = source.slice(
      source.indexOf("'auth', provider, 'login', 'success-redirect'"),
      source.indexOf("// Restore the path the user was on before the redirect")
    );
    expect(redirectSection).toContain('saveUserProfileToFirestore(result.user,');
  });

  it('uses merge mode to avoid overwriting existing data', () => {
    expect(source).toContain("{ merge: true }");
  });

  it('handles Firestore write failure gracefully', () => {
    expect(source).toContain('.catch(() => {})');
    expect(source).toContain("console.warn('[Auth] Failed to save user profile to Firestore:'");
  });

  it('sets createdAt only on first profile creation', () => {
    const profileFn = source.slice(
      source.indexOf('export async function saveUserProfileToFirestore'),
      source.indexOf('// ─── Auth Functions')
    );
    expect(profileFn).toContain('if (!docSnap.exists())');
    expect(profileFn).toContain('profileData.createdAt = fsModule.serverTimestamp()');
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
