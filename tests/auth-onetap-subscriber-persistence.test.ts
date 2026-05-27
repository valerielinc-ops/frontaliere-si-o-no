import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const source = readFileSync(resolve(root, 'services/authService.ts'), 'utf8');

/**
 * Regression guard for the bug uncovered when ea096801e7 fixed the GSI
 * loader and One Tap actually started firing in production:
 *
 *   handleOneTapResponse() called signInWithCredential() but did not
 *   write a newsletter_subscribers/{email} document, so One Tap signups
 *   created Auth users that never received the newsletter (215 orphans
 *   accumulated, ~12/day starting 2026-04-21).
 *
 * The popup + redirect flows write the doc via the App.tsx auth listener
 * useEffect on `[authEmail]`. One Tap bypasses that listener (it is lazy
 * and `auth_redirect_provider` is not set), so the upsert must happen
 * directly inside handleOneTapResponse.
 */
describe('Google One Tap — subscriber persistence', () => {
  function sectionBetween(start: string, end: string): string {
    const a = source.indexOf(start);
    const b = source.indexOf(end, a + start.length);
    if (a < 0 || b < 0) throw new Error(`Could not slice section: ${start} → ${end}`);
    return source.slice(a, b);
  }

  it('exports a persistOneTapSubscriber helper', () => {
    expect(source).toMatch(/async function persistOneTapSubscriber\b/);
  });

  it('handleOneTapResponse calls saveUserProfileToFirestore + persistOneTapSubscriber', () => {
    const handler = sectionBetween(
      'async function handleOneTapResponse',
      'async function handleOneTapResponse'.length > 0
        ? '/**\n * Show Google One Tap prompt'
        : '__never__',
    );
    expect(handler).toMatch(/saveUserProfileToFirestore\(result\.user,\s*'google'\)/);
    expect(handler).toMatch(/persistOneTapSubscriber\(result\.user\)/);
  });

  it('persistOneTapSubscriber upserts via the shared newsletterSubscribers service', () => {
    const helper = sectionBetween(
      'async function persistOneTapSubscriber',
      'async function handleOneTapResponse',
    );
    expect(helper).toMatch(/import\(['"]@\/services\/newsletterSubscribers['"]\)/);
    expect(helper).toMatch(/upsertNewsletterSubscriber\(db,\s*\{/);
    expect(helper).toMatch(/sourceChannel:\s*'auth_google'/);
    expect(helper).toMatch(/sourceCta:\s*'one_tap'/);
    expect(helper).toMatch(/sourceComponent:\s*'auth_one_tap'/);
  });

  it('persistOneTapSubscriber respects the local "newsletter_subscribed" flag to avoid double-writes', () => {
    const helper = sectionBetween(
      'async function persistOneTapSubscriber',
      'async function handleOneTapResponse',
    );
    expect(helper).toMatch(/getItem\(['"]newsletter_subscribed['"]\)\s*===\s*['"]true['"]/);
  });

  it('persistOneTapSubscriber is best-effort (does not throw to break sign-in)', () => {
    const helper = sectionBetween(
      'async function persistOneTapSubscriber',
      'async function handleOneTapResponse',
    );
    expect(helper).toMatch(/try\s*{[\s\S]*}\s*catch\s*\(err\)/);
    expect(helper).toMatch(/reportCaughtError\(err,\s*['"]auth\.persistOneTapSubscriber['"]\)/);
  });

  it('handleOneTapResponse swallows persistOneTapSubscriber rejection so sign-in still succeeds', () => {
    const handler = sectionBetween(
      'async function handleOneTapResponse',
      '/**\n * Show Google One Tap prompt',
    );
    // Both side-effect calls must be `.catch()`-ed off the await chain.
    expect(handler).toMatch(/persistOneTapSubscriber\(result\.user\)\.catch\(/);
    expect(handler).toMatch(/saveUserProfileToFirestore\(result\.user,\s*'google'\)\.catch\(/);
  });
});
