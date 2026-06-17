import { describe, it, expect } from 'vitest';
import { apexDomain, decodeCfEmail, extractCompanyEmails, scoreEmail, pickBestEmail, inferPatternEmail } from '../scripts/lib/email-finder.mjs';

describe('apexDomain', () => {
  it('strips scheme/www/subdomains to the registrable domain', () => {
    expect(apexDomain('https://www.recruit.casale.ch/')).toBe('casale.ch');
    expect(apexDomain('hq.centiel.com')).toBe('centiel.com');
    expect(apexDomain('https://pemsa.ch/it/contatti')).toBe('pemsa.ch');
    expect(apexDomain('tsmg.co')).toBe('tsmg.co');
  });
});

describe('extractCompanyEmails (company-domain filter kills noise)', () => {
  it('keeps only on-domain emails, drops third-party/code junk', () => {
    const html = `
      <a href="mailto:info@casale.ch">scrivici</a>
      crm.admin@casale.ch hr@casale.ch
      noise: st@ic.css jquery-migrate@e.min.js fonts@gstatic.com tracker@hotjar.com
    `;
    const got = extractCompanyEmails(html, 'casale.ch').sort();
    expect(got).toEqual(['crm.admin@casale.ch', 'hr@casale.ch', 'info@casale.ch']);
  });

  it('accepts subdomain emails of the company domain', () => {
    expect(extractCompanyEmails('media@hq.centiel.com', 'centiel.com')).toContain('media@hq.centiel.com');
  });

  it('decodes Cloudflare cf-email', () => {
    // encode "a@b.ch" with key 0x10
    const enc = (s: string) => { const k = 0x10; let h = k.toString(16).padStart(2, '0'); for (const c of s) h += (c.charCodeAt(0) ^ k).toString(16).padStart(2, '0'); return h; };
    const html = `<span data-cfemail="${enc('hr@b.ch')}"></span>`;
    expect(extractCompanyEmails(html, 'b.ch')).toContain('hr@b.ch');
    expect(decodeCfEmail(enc('hr@b.ch'))).toBe('hr@b.ch');
  });
});

describe('scoreEmail / pickBestEmail', () => {
  it('ranks HR > city > general > other > low-value', () => {
    expect(scoreEmail('hr@x.ch')).toBeGreaterThan(scoreEmail('lugano@x.ch'));
    expect(scoreEmail('lugano@x.ch')).toBeGreaterThan(scoreEmail('info@x.ch'));
    expect(scoreEmail('info@x.ch')).toBeGreaterThan(scoreEmail('mario.rossi@x.ch'));
    expect(scoreEmail('mario.rossi@x.ch')).toBeGreaterThan(scoreEmail('privacy@x.ch'));
  });
  it('picks the highest-scored, prefers shorter on ties', () => {
    expect(pickBestEmail(['info@x.ch', 'lavoro@x.ch', 'privacy@x.ch'])).toBe('lavoro@x.ch');
    expect(pickBestEmail(['contatti@x.ch', 'info@x.ch'])).toBe('info@x.ch'); // both general → shorter
    expect(pickBestEmail([])).toBeNull();
  });
});

describe('inferPatternEmail', () => {
  it('learns first.last from a found person email and applies to the LinkedIn name', () => {
    expect(inferPatternEmail(['mario.rossi@casale.ch'], 'Denise Parise', 'casale.ch')).toBe('denise.parise@casale.ch');
  });
  it('learns f.last pattern', () => {
    expect(inferPatternEmail(['m.rossi@x.ch'], 'Lisa Castelli', 'x.ch')).toBe('l.castelli@x.ch');
  });
  it('returns null when only role emails exist (no person pattern to learn)', () => {
    expect(inferPatternEmail(['info@x.ch', 'hr@x.ch'], 'Denise Parise', 'x.ch')).toBeNull();
  });
  it('strips accents in the name', () => {
    expect(inferPatternEmail(['mario.rossi@x.ch'], 'Renée Müller', 'x.ch')).toBe('renee.muller@x.ch');
  });
});
