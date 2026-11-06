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
 * Authentication is a registration channel under the site terms. One Tap may
 * create/enrich the central relationship, without a second checkbox or DOI.
 */
describe('Google One Tap — central terms registration', () => {
  function sectionBetween(start: string, end: string): string {
    const a = source.indexOf(start);
    const b = source.indexOf(end, a + start.length);
    if (a < 0 || b < 0) throw new Error(`Could not slice section: ${start} → ${end}`);
    return source.slice(a, b);
  }

  it('handleOneTapResponse delegates the terms-based registration to the central writer', () => {
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

  it('records the base relationship without an explicit checkbox or DOI', () => {
    expect(source).toContain('upsertNewsletterSubscriber');
    expect(source).toContain('registrationTermsAccepted: true');
    expect(source).toMatch(/skipConfirmationEmail:\s*provider !== 'email'/);
    expect(source).not.toMatch(/requestConfirmationEmail/);
  });

  it('keeps the historical orphan inventory report-only', () => {
    expect(orphanBackfill).toMatch(/REPORT ONLY/);
    expect(orphanBackfill).toMatch(/Refusing --apply/);
    expect(orphanBackfill).not.toMatch(/batch\.set|\.set\(db\.collection|FieldValue\.serverTimestamp|Timestamp\.fromDate/);
  });
});
