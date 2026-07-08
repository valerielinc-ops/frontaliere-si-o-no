/**
 * Tests for the eHnv (Étab. Hospitaliers du Nord Vaudois) Johdi Suite parser.
 *
 * eHnv moved off the jobup.ch mask feed (which returned 0 jobs for 5+
 * consecutive days while the real career page listed ~15 openings —
 * confirmed via live browser capture 2026-07-08) to its actual source:
 * the Johdi Suite ATS embedded on https://www.ehnv.ch/emplois.
 *
 * Verifies exported constants and matcher behavior; see
 * `tests/parsers/jobup-ch-feed-parser.test.ts` for the shared jobup.ch
 * parser tests (still used by Pôle Santé Pays-d'Enhaut).
 */
import { describe, it, expect } from 'vitest';
import {
  EHNV_KEY,
  EHNV_COMPANY_NAME,
  EHNV_COMPANY_DOMAIN,
  isEhnvJob,
  isTrustedDomain as isEhnvTrusted,
} from '../../scripts/lib/ehnv-job-parser.mjs';

describe('eHnv (Johdi Suite) — exported constants', () => {
  it('has the expected key, name and domain', () => {
    expect(EHNV_KEY).toBe('ehnv');
    expect(EHNV_COMPANY_NAME).toMatch(/Nord Vaudois/);
    expect(EHNV_COMPANY_DOMAIN).toBe('ehnv.ch');
  });
});

describe('isEhnvJob — matcher', () => {
  it('matches by companyKey', () => {
    expect(isEhnvJob({ companyKey: 'ehnv', url: 'https://ats.johdisuite.ch/offer/1' })).toBe(true);
  });

  it('matches by corporate domain in url', () => {
    expect(isEhnvJob({ url: 'https://www.ehnv.ch/emplois#offer/4220/x' })).toBe(true);
  });

  it('does not match unrelated jobs', () => {
    expect(isEhnvJob({ companyKey: 'daler-hopital', url: 'https://daler.ch/emplois/' })).toBe(false);
    expect(isEhnvJob({ url: 'https://malicious.example/x' })).toBe(false);
  });
});

describe('isTrustedDomain — eHnv trusts its own domain and johdisuite.ch', () => {
  it('trusts ehnv.ch and ats.johdisuite.ch', () => {
    expect(isEhnvTrusted('https://www.ehnv.ch/emplois')).toBe(true);
    expect(isEhnvTrusted('https://ats.johdisuite.ch/api/company/x/offer/1')).toBe(true);
  });

  it('rejects unrelated or malformed URLs', () => {
    expect(isEhnvTrusted('https://malicious.example/x')).toBe(false);
    expect(isEhnvTrusted('not-a-url')).toBe(false);
    expect(isEhnvTrusted('')).toBe(false);
  });
});
