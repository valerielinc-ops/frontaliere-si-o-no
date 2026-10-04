import { describe, expect, it } from 'vitest';
import { renderLegalEditorial, resolveLegalPage } from '../build-plugins/shared/legalEditorial';
import { DATA_CONTROLLER_NAME } from '../functions/src/lib/dataControllerIdentity.js';
import { PUBLIC_CONTACT_EMAIL } from '../services/publicContact';

/** Preserve the public controller/contact contract after moving copy into shared documents. */
describe('static legal data-controller contact', () => {
  it.each(['it', 'en', 'de', 'fr'] as const)('%s renders the canonical controller and public mailbox', locale => {
    const html = renderLegalEditorial('privacy', locale).join('');
    expect(html).toContain(DATA_CONTROLLER_NAME);
    expect(html).toContain(`href="mailto:${PUBLIC_CONTACT_EMAIL}"`);
    const mailboxes = [...html.matchAll(/href="mailto:([^"]+)"/g)].map(match => match[1]);
    expect(mailboxes.length).toBeGreaterThan(0);
    expect(new Set(mailboxes)).toEqual(new Set([PUBLIC_CONTACT_EMAIL]));
  });

  it('the legacy privacy URL resolves to the same legal document', () => {
    expect(resolveLegalPage('/privacy/')).toBe('privacy');
    expect(resolveLegalPage('/privacy-policy/')).toBe('privacy');
  });
});
