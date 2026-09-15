import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const source = readFileSync(resolve(root, 'services/authService.ts'), 'utf8');
const orphanBackfill = readFileSync(
  resolve(root, 'scripts/dev/backfill-onetap-orphan-subscribers.mjs'),
  'utf8',
);

/**
 * Authentication is not newsletter consent. One Tap may enrich an existing
 * profile, but it must not create or reactivate newsletter_subscribers/{email}.
 */
describe('Google One Tap — no newsletter side effect', () => {
  function sectionBetween(start: string, end: string): string {
    const a = source.indexOf(start);
    const b = source.indexOf(end, a + start.length);
    if (a < 0 || b < 0) throw new Error(`Could not slice section: ${start} → ${end}`);
    return source.slice(a, b);
  }

  it('handleOneTapResponse only performs profile enrichment after auth', () => {
    const handler = sectionBetween(
      'async function handleOneTapResponse',
      '/**\n * Show Google One Tap prompt',
    );
    expect(handler).toMatch(/saveUserProfileToFirestore\(result\.user,\s*'google'\)/);
    expect(handler).not.toMatch(/newsletterSubscribers|upsertNewsletterSubscriber|newsletter_subscribed/);
  });

  it('does not define a One Tap newsletter persistence helper', () => {
    expect(source).not.toMatch(/persistOneTapSubscriber\b/);
  });

  it('does not write a newsletter record anywhere in the auth service', () => {
    expect(source).not.toMatch(/upsertNewsletterSubscriber|newsletterSubscribers/);
  });

  it('keeps the historical orphan inventory report-only', () => {
    expect(orphanBackfill).toMatch(/REPORT ONLY/);
    expect(orphanBackfill).toMatch(/Refusing --apply/);
    expect(orphanBackfill).not.toMatch(/batch\.set|\.set\(db\.collection|FieldValue\.serverTimestamp|Timestamp\.fromDate/);
  });
});
