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

/**
 * The body of a `match <header> { … }` block, brace-matched.
 *
 * This replaces an `indexOf('}', start + 80)` slice that did not do what it
 * read as doing. Eighty characters past `match /newsletter_subscribers/{email}`
 * lands inside a comment, and the next `}` from there is the one in the
 * `{eventId}` placeholder of the nested `match /events/{eventId}` header — so
 * the slice that claimed to be "the subscriber document block" actually stopped
 * at the first nested match, and every nested rule was invisible to it. A brace
 * counter cannot drift that way, and nesting is exactly what these assertions
 * are about.
 */
function matchBlock(source: string, header: string): string {
  const at = source.indexOf(header);
  if (at === -1) throw new Error(`missing rule block: ${header}`);
  const open = source.indexOf('{', at + header.length - 1);
  if (open === -1) throw new Error(`no opening brace after: ${header}`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces after: ${header}`);
}

describe('Firestore rules — newsletter_subscribers collection', () => {
  const rules = readFileSync(resolve(root, 'firestore.rules'), 'utf8');
  const subBlock = matchBlock(rules, 'match /newsletter_subscribers/{email}');

  it('has rules for newsletter_subscribers collection', () => {
    expect(rules).toContain('match /newsletter_subscribers/{email}');
  });

  /**
   * The engagement log is append-only and unreadable by any client.
   *
   * Both halves are load-bearing rather than defensive. No browser code path
   * reads this subcollection — services/, components/, hooks/, App.tsx and
   * index.tsx contain no getDoc/getDocs/query/onSnapshot/getCountFromServer/
   * collectionGroup against `events`, and its consumers (scripts/lib/*, the ESP
   * webhook cores) run on the Admin SDK, which does not evaluate rules. And all
   * eight client writers are `addDoc`, so `create` is the whole of what the code
   * needs; `update`/`delete` were reachable and used by nothing.
   *
   * Scoped through `subBlock` on purpose: `match /events/{eventId}` appears
   * twice in this file, the other under `job_alert_subscribers`, and asserting
   * against the wrong one would pass while proving nothing.
   */
  it('keeps the engagement log append-only and closed to client reads', () => {
    const events = matchBlock(subBlock, 'match /events/{eventId}');
    expect(events).toContain('allow read: if false');
    expect(events).toContain('allow create: if true');
    expect(events).toContain('allow update, delete: if false');
    expect(events).not.toMatch(/allow\s+[^;]*write[^;]*:\s*if\s+true/);
  });

  /**
   * Delivery tracking is Admin-SDK-only. Its one client writer is App.tsx's
   * /newsletter/click handler, which nothing reaches: no template emits that
   * URL and tests/newsletter-template-tracking.test.ts asserts none ever will.
   * applyNewsletterDeliveryEvent, the other candidate writer, has no callers.
   */
  it('leaves campaign delivery tracking to the Admin SDK', () => {
    const deliveries = matchBlock(subBlock, 'match /campaign_deliveries/{deliveryId}');
    expect(deliveries).toContain('allow read, write: if false');
  });

  /**
   * The subscriber document itself still carries the auth-gated `private/`
   * subcollection. Asserted here because the brace-matched extraction above is
   * what makes a nested claim meaningful at all.
   */
  it('keeps the private subcollection gated to the owning address', () => {
    const priv = matchBlock(subBlock, 'match /private/{docId}');
    expect(priv).toContain('request.auth != null');
    expect(priv).toContain('request.auth.token.email.lower() == email');
  });
});

/**
 * The sibling of the block above, asserted here because that is where this
 * file's rule assertions already live and `matchBlock` is already defined.
 *
 * `job_alert_subscribers` mirrors `newsletter_subscribers` by design, down to
 * the same two Admin-SDK-only subcollections holding the same category of data.
 * Keeping the two sets of assertions adjacent is what makes a future divergence
 * visible; separating them is how the pair drifted apart in the first place.
 */
describe('Firestore rules — job_alert_subscribers subcollections', () => {
  const rules = readFileSync(resolve(root, 'firestore.rules'), 'utf8');
  const alertBlock = matchBlock(rules, 'match /job_alert_subscribers/{email}');

  it('leaves per-alert delivery state to the Admin SDK', () => {
    expect(matchBlock(alertBlock, 'match /alert_deliveries/{alertId}'))
      .toContain('allow read, write: if false');
  });

  it('leaves the raw ESP event log to the Admin SDK', () => {
    expect(matchBlock(alertBlock, 'match /events/{eventId}'))
      .toContain('allow read, write: if false');
  });

  /**
   * The one client-facing subcollection stays exactly as it was: the preferences
   * controller and services/jobAlertService.ts read and write it, so a change
   * here would be a behaviour change, not a cleanup.
   */
  it('leaves the client-facing alerts subcollection owner-gated', () => {
    const alerts = matchBlock(alertBlock, 'match /alerts/{alertId}');
    expect(alerts).toContain('request.auth != null');
    expect(alerts).toContain('request.auth.token.email.lower() == email');
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
