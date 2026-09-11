import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

describe('JobBoard apply URL preference', () => {
  it('prefers applyUrl over the generic job url for the candidati CTA', () => {
    const source = readFileSync(resolve(root, 'components/community/JobBoard.tsx'), 'utf8');
    expect(source).toContain('const applyUrl = buildJobReferralUrl(selectedJob);');
  });

  it('uses the preferred destination for imperative apply hand-offs too', () => {
    const source = readFileSync(resolve(root, 'components/community/JobBoard.tsx'), 'utf8');
    expect(source).toContain('const applyDestination = buildJobReferralUrl(job);');
    expect(source).toContain("window.open(applyDestination, '_blank', 'noopener,noreferrer');");
  });

  it('keeps the static job-detail emitters on the same typed applyUrl chain', () => {
    const plugin = readFileSync(resolve(root, 'build-plugins/jobsSeoPagesPlugin.ts'), 'utf8');
    const context = readFileSync(resolve(root, 'build-plugins/shared/jobDetailHtml/context.ts'), 'utf8');
    const mobileBlock = readFileSync(resolve(root, 'build-plugins/shared/jobDetailHtml/mobileActionBlock.ts'), 'utf8');
    expect(plugin).toContain('applyUrl: job.applyUrl,');
    expect(plugin).toContain('referralUrl(job.applyUrl || job.url || canonicalUrl, job)');
    expect(context).toContain('readonly applyUrl?: string;');
    expect(mobileBlock).toContain('referralUrl(job.applyUrl || job.url || canonicalUrl, job)');
    expect(plugin).not.toContain('const referralUrl = (raw: string, job: any): string =>');
  });
});
