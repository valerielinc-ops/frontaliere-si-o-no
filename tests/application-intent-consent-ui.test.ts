import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const jobBoardSource = readFileSync(
  resolve(projectRoot, 'components/community/JobBoard.tsx'),
  'utf8',
);
const applicationIntentSource = readFileSync(
  resolve(projectRoot, 'services/applicationIntent.ts'),
  'utf8',
);
const localeSources = ['it', 'en', 'de', 'fr'].map((locale) => readFileSync(
  resolve(projectRoot, `services/locales/${locale}-core.ts`),
  'utf8',
));

describe('application-intent consent copy', () => {
  it('defines the same localized consent key in all four core locale shards', () => {
    const key = "'jobBoard.applicationIntentConsent':";

    expect(localeSources).toHaveLength(4);
    expect(localeSources.every((source) => source.includes(key))).toBe(true);
  });

  it('renders consent copy only for external application CTAs', () => {
    const helperStart = jobBoardSource.indexOf('const renderApplicationIntentConsent');
    const helperEnd = jobBoardSource.indexOf('// Publisher / sponsored ad:', helperStart);
    const helper = jobBoardSource.slice(helperStart, helperEnd);

    expect(helper).toContain('isExternalApplicationJob(selectedJob)');
    expect(helper).toContain('jobBoard.applicationIntentConsent');
    expect(jobBoardSource.match(/\{renderApplicationIntentConsent/g)).toHaveLength(4);
  });

  it('records the displayed copy before external hand-off, never for in-house forms', () => {
    const start = jobBoardSource.indexOf('const handleApply =');
    const end = jobBoardSource.indexOf('const handleShare =', start);
    const handleApply = jobBoardSource.slice(start, end);
    const intentBranch = handleApply.indexOf('if (isExternal) {');
    const inHouseBranch = handleApply.indexOf("if (mode === 'in_house'");

    expect(intentBranch).toBeGreaterThanOrEqual(0);
    expect(inHouseBranch).toBeGreaterThan(intentBranch);
    expect(handleApply.slice(intentBranch, inHouseBranch)).toContain('recordJobApplicationIntent(job, surface)');
    expect(handleApply.slice(inHouseBranch)).not.toContain('recordJobApplicationIntent');
    expect(jobBoardSource).toContain("consentText: t('jobBoard.applicationIntentConsent')");
    expect(jobBoardSource).toContain("origin: typeof window !== 'undefined' ? window.location.pathname : '/'");
    expect(applicationIntentSource).toContain("APPLICATION_INTENT_CONSENT_VERSION = 'application-intent-v1'");
    expect(applicationIntentSource).toContain('consentVersion: APPLICATION_INTENT_CONSENT_VERSION');
  });
});
