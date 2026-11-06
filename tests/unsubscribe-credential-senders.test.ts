import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDormantWinbackStage1Email } from '../services/dormantWinbackStage1Email.mjs';
import { buildWinbackEmail } from '../services/winbackEmail.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const RECIPIENT = 'subscriber@example.com';
const SECRET = 'test-newsletter-secret';

function stripComments(source) {
  return source.replace(/\/\/.*$/gm, '');
}

function unsubscribeHrefs(html) {
  return [...html.matchAll(/href=["']([^"']+)["']/gi)]
    .map((match) => match[1].replaceAll('&amp;', '&'))
    .filter((href) => new URL(href).searchParams.get('action') === 'unsubscribe');
}

describe('unsubscribe credential sender coverage', () => {
  let previousSecret;

  beforeEach(() => {
    previousSecret = process.env.NEWSLETTER_SECRET;
    process.env.NEWSLETTER_SECRET = SECRET;
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.NEWSLETTER_SECRET;
    else process.env.NEWSLETTER_SECRET = previousSecret;
  });

  it('uses scoped-token endpoints in win-back body footers', () => {
    const emails = [
      buildWinbackEmail({ email: RECIPIENT }),
      buildDormantWinbackStage1Email({ email: RECIPIENT, articles: [] }),
    ];

    for (const email of emails) {
      const links = unsubscribeHrefs(email.html);
      expect(links).toHaveLength(1);

      const url = new URL(links[0]);
      expect(url.pathname).toBe('/disiscrivi-newsletter/');
      expect(url.searchParams.get('token')).toBeTruthy();
      expect(url.searchParams.has('ac')).toBe(false);
    }
  });

  it('keeps every production sender off the ac-only unsubscribe footer path', () => {
    const callSites = [
      ['scripts/send-onboarding-drip.mjs', 'unsubscribeUrl: makeOneClickUnsubscribeUrl('],
      ['scripts/blast-publisher-ads.mjs', 'unsubscribeUrl: makeOneClickUnsubscribeUrl('],
      ['services/winbackEmail.mjs', 'footerUnsubUrl = makeOneClickUnsubscribeUrl('],
      ['services/dormantWinbackStage1Email.mjs', 'footerUnsubUrl = makeOneClickUnsubscribeUrl('],
    ];

    for (const [relativePath, expectedCall] of callSites) {
      const source = stripComments(fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'));
      expect(source).toContain(expectedCall);
      expect(source).not.toMatch(/makeAuthenticatedActionUrl\(\s*['"]unsubscribe['"]/);
    }
  });
});
