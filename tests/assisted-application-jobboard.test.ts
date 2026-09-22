import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const jobBoardSource = readFileSync(
  resolve(process.cwd(), 'components/community/JobBoard.tsx'),
  'utf8',
);

describe('assisted application JobBoard handoff', () => {
  it('routes the paid and rewarded treatments through the detail render', () => {
    const start = jobBoardSource.indexOf('const handleApply =');
    const end = jobBoardSource.indexOf('const handleShare =', start);
    const handleApply = jobBoardSource.slice(start, end);
    const rewardedStart = handleApply.indexOf("if (isExternal && assistedApplicationVariant === 'rewarded_ad')");
    const paidStart = handleApply.indexOf("if (assistedApplicationVariant === 'assisted_application')");
    const rewardedArm = handleApply.slice(rewardedStart, paidStart);
    const paidArm = handleApply.slice(paidStart);

    expect(paidArm).toMatch(
      /setAssistedApplicationJob\(job\);[\s\S]*if \(!isJobDetailView\) openDetail\(job\);/,
    );
    expect(rewardedArm).toContain("'rewarded_application_offer_requested'");
    expect(rewardedArm).toContain("provider: 'google_gpt_rewarded_web'");
    expect(rewardedArm).toContain('setRewardedApplicationJob(job)');
    expect(rewardedArm).toContain('if (!isJobDetailView) openDetail(job)');
    expect(jobBoardSource).toContain('RewardedApplicationOffer');
    expect(jobBoardSource).not.toContain('rewarded_application_native_offerwall');
    expect(jobBoardSource).not.toContain('RewardedApplicationPage');
    expect(jobBoardSource).not.toContain('rewardedApplicationHandoff');
    expect(jobBoardSource).toMatch(
      /if \(!assistedApplicationJob \|\| isJobDetailView \|\| !authResolved\) return;[\s\S]*openDetail\(assistedApplicationJob\);/,
    );
  });

  it('keeps the offer mounted in both supported detail render branches', () => {
    expect(jobBoardSource.match(/\{assistedApplicationOfferJsx\}/g)?.length).toBeGreaterThanOrEqual(2);
    expect(jobBoardSource.match(/\{rewardedApplicationOfferJsx\}/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the rewarded action account-gated and restores the detail gate', () => {
    expect(jobBoardSource).toContain("assistedApplicationVariant === 'rewarded_ad' && !authUser?.uid");
    expect(jobBoardSource).toContain('const hasAccess = isLoggedIn || emailAccessGranted || isCrawlerVisitor;');
    expect(jobBoardSource).toContain('isCrawlerVisitorAgent');
  });

  it('forces the rewarded treatment on the Italian Ticino job-board surface', () => {
    expect(jobBoardSource).toMatch(
      /function isAlwaysRewardedApplicationSurface\(\): boolean[\s\S]*\/\^\\\/cerca-lavoro-ticino\(\?:\\\/\|\$\)\//,
    );
    expect(jobBoardSource).toMatch(
      /const assistedApplicationVariant = alwaysRewardedApplicationSurface[\s\S]*'rewarded_ad'/,
    );
    expect(jobBoardSource).toContain('killSwitches.rewardedApplicationAd');
  });
});
