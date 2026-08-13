import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { directRules, matchBlock } from './helpers/firestoreRulesBlock';

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
  const subBlock = matchBlock(rules, 'match /newsletter_subscribers/{email}');

  it('has rules for newsletter_subscribers collection', () => {
    expect(rules).toContain('match /newsletter_subscribers/{email}');
  });

  /**
   * The subscriber list is not enumerable (#5751).
   *
   * `allow read` is `get` PLUS `list`, so the single word that used to sit here
   * — `allow read, write: if true` — was a standing offer to page the whole
   * collection: no predicate could reject a query, which makes
   * `collection('newsletter_subscribers')` with no `where` exactly as permitted
   * as any filtered one. The project id needed to send it ships in the client
   * bundle.
   *
   * Asserted through `directRules` rather than the raw block because the
   * subcollections underneath carry their own `allow read`/`allow write` lines;
   * against the raw text a re-opened parent would hide behind `events`'
   * `allow read: if false`.
   */
  it('does not let a client enumerate the subscriber list', () => {
    const own = directRules(subBlock);
    // `read` is banned as a verb here: it silently re-grants `list`.
    expect(own).not.toMatch(/allow[^;:]*\bread\b[^;:]*:/);
    expect(own).toContain('allow list: if isSiteAdmin()');
    expect(own).not.toMatch(/allow\s+list\s*:\s*if\s+true/);
  });

  /**
   * The two grants that must NOT have moved, pinned so the next narrowing pass
   * has to argue with a test instead of a silence.
   *
   * `write` stays public because anonymous subscription is the product (App.tsx's
   * unsubscribe fall-through also depends on it), and `get` stays public because
   * the anonymous subscribe path READS before it writes —
   * `captureNewsletterSubscriber` and `isNewsletterOptedOut`, the latter with
   * callers in TaxCalendar, JobBoard and PublisherPublishPage that have no
   * signed-in user. `isNewsletterOptedOut` fails closed, so denying that read
   * would suppress subscriptions without raising anything.
   */
  it('keeps anonymous subscribe working: get and write stay public', () => {
    const own = directRules(subBlock);
    expect(own).toContain('allow get: if true');
    expect(own).toContain('allow write: if true');
  });

  /**
   * The one lister left is the owner's admin panel, and the rule that admits it
   * has to be the same identity the SPA gates that panel with — otherwise the
   * dashboard reads zero and nobody finds out until someone looks.
   */
  it('scopes the admin exception to the SPA admin allowlist', () => {
    const fn = matchBlock(rules, 'function isSiteAdmin()');
    expect(fn).toContain('request.auth != null');
    expect(fn).toContain('request.auth.token.email_verified == true');
    expect(fn).toContain("request.auth.token.email.lower() == 'valerielinc@gmail.com'");
    const app = readFileSync(resolve(root, 'App.tsx'), 'utf8');
    expect(app).toContain("ADMIN_EMAIL_WHITELIST = ['valerielinc@gmail.com']");
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

  /**
   * The same close, on the same day, for the same class of data (#5751). This
   * one takes the scoped `get` outright: nothing in the browser reads the root
   * document — services/jobAlertService.ts only `setDoc`s it, and the
   * preferences centre reads `alerts` below — so there was no anonymous read to
   * preserve, unlike its newsletter twin.
   */
  it('does not let a client enumerate or read another address book entry', () => {
    const own = directRules(alertBlock);
    expect(own).not.toMatch(/allow[^;:]*\bread\b[^;:]*:/);
    expect(own).toContain('allow list: if false');
    expect(own).toContain('request.auth != null');
    expect(own).toContain('request.auth.token.email.lower() == email');
    // Job alerts are still created from the client — the close is about reads.
    expect(own).toContain('allow write: if true');
  });

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

/**
 * The metric, written as an assertion so it cannot drift back (#5751).
 *
 * Before: two PII collections whose `list` an unauthenticated browser could
 * run. After: zero. Both halves are checked from the rules text, not from a
 * memory of what was changed — a `list` predicate counts as closed only if it
 * mentions `request.auth`, which `if true` does not.
 *
 * The client half matters just as much and fails the other way round: a `list`
 * that survives in the browser after the rule is deployed does not fail here,
 * it fails in production, on whatever screen still runs it. So the file set is
 * pinned. Adding a lister means changing this list on purpose.
 */
describe('PII enumeration — rules and client agree (#5751)', () => {
  const rules = readFileSync(resolve(root, 'firestore.rules'), 'utf8');
  const PII_COLLECTIONS = [
    'match /newsletter_subscribers/{email}',
    'match /job_alert_subscribers/{email}',
  ];

  /**
   * A predicate is closed to an anonymous caller when it is literally `false` or
   * when it consults `request.auth`. Helper calls are inlined first: `list` on
   * newsletter_subscribers reads `if isSiteAdmin()`, and a check that only
   * grepped the predicate for `request.auth` would score the strictest rule in
   * the block as wide open.
   */
  const closedToAnonymous = (predicate: string): boolean => {
    const expanded = predicate.replace(/([A-Za-z_$][\w$]*)\s*\(\s*\)/g, (whole, name) => {
      try {
        return matchBlock(rules, `function ${name}()`);
      } catch {
        return whole;
      }
    });
    return expanded.trim() === 'false' || expanded.includes('request.auth');
  };

  it('leaves no PII collection listable by an unauthenticated caller', () => {
    const open = PII_COLLECTIONS.filter((header) => {
      const own = directRules(matchBlock(rules, header));
      // `read` would re-grant `list` under another name.
      if (/allow[^;:]*\bread\b[^;:]*:/.test(own)) return true;
      const list = own.match(/allow\s+list\s*:\s*if\s+([^;]+);/);
      if (!list) return true; // no `list` rule at all → whatever `read` said
      return !closedToAnonymous(list[1]);
    });
    expect(open).toEqual([]);
  });

  /**
   * Every construct that needs `list`: `query(collection(…))`,
   * `getDocs(collection(…))`, `getCountFromServer(collection(…))`. Reads keyed
   * by document id go through `doc(…)` and are deliberately not matched.
   */
  // No `g` flag on purpose: a global regex carries `lastIndex` between
  // `.test()` calls, so the second file in the loop would start matching from
  // wherever the first one stopped and the scan would quietly under-report.
  const LIST_CALL =
    /(?:query|getDocs|getCountFromServer|onSnapshot)\s*\(\s*collection\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*'(?:newsletter_subscribers|job_alert_subscribers)'/;

  /**
   * Symlinks are skipped, not followed. `services/` carries 22 of them and they
   * all point into `packages/articles/content` — generated article data, never a
   * Firestore caller. Following them would walk the corpus in CI and, in a
   * sparse worktree where that path is not materialised, blow up on a dangling
   * link instead of reporting anything about this file's subject.
   */
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  };

  it('leaves exactly one lister in the client, and it is the admin panel', () => {
    const files = [
      resolve(root, 'App.tsx'),
      resolve(root, 'index.tsx'),
      ...walk(resolve(root, 'components')),
      ...walk(resolve(root, 'services')),
      ...walk(resolve(root, 'hooks')),
    ];
    const listers = files
      .filter((f) => LIST_CALL.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f))
      .sort();
    expect(listers).toEqual(['components/pages/AdminPanel.tsx']);
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
