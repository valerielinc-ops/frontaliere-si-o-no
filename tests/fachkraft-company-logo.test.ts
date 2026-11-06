import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FACHKRAFT_COMPANY_DOMAIN, FACHKRAFT_KEY } from '../scripts/lib/fachkraft-job-parser.mjs';
import { assessLogoQuality, readImageDimensions } from '../scripts/lib/company-logo-audit.mjs';
import { CRAWLED_COMPANY_LOGOS, resolveCompanyLogoUrl } from '../services/jobDataNormalization';

describe('fachkraft company logo', () => {
  it('serves the verified official-domain asset from the local brand path', () => {
    expect(FACHKRAFT_COMPANY_DOMAIN).toBe('fachkraft.ch');
    expect(CRAWLED_COMPANY_LOGOS[FACHKRAFT_KEY]).toBe('/images/brands/fachkraft.png');
    expect(resolveCompanyLogoUrl({
      company: 'fachkraft.ch GmbH',
      companyKey: FACHKRAFT_KEY,
      companyDomain: FACHKRAFT_COMPANY_DOMAIN,
      url: 'https://www.fachkraft.ch/stellen/',
    })).toBe('/images/brands/fachkraft.png');

    const logo = readFileSync(path.resolve('public/images/brands/fachkraft.png'));
    const dimensions = readImageDimensions(logo, 'png');
    expect(dimensions).toEqual({ width: 1024, height: 160, vector: false });
    expect(assessLogoQuality({ format: 'png', ...dimensions! }).status).toBe('good');
  });
});
