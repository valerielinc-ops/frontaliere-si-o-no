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
    expect(jobBoardSource).toContain('preloadRewardedWebAd');
    expect(jobBoardSource).toContain('shouldPreloadRewardedApplicationAd');
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

  it('keeps the anonymous job-board login gate while allowing the detail request', () => {
    expect(jobBoardSource).toContain("assistedApplicationVariant === 'rewarded_ad' && !authUser?.uid && !isJobDetailView");
    expect(jobBoardSource).toContain('const hasAccess = isLoggedIn || emailAccessGranted || isCrawlerVisitor;');
    expect(jobBoardSource).toContain('isCrawlerVisitorAgent');
  });

  it('preloads the rewarded request only where the Candidati CTA is reachable past the login gate', () => {
    const start = jobBoardSource.indexOf('const shouldPreloadRewardedApplicationAd = Boolean(');
    const end = jobBoardSource.indexOf(');', start);
    const condition = jobBoardSource.slice(start, end);

    expect(condition).toContain('isJobDetailView');
    expect(condition).toContain('authResolved');
    expect(condition).toContain('hasAccess');
    expect(condition).toContain("assistedApplicationVariant === 'rewarded_ad'");
    expect(condition).toContain('getRewardedApplicationAccessExpiresAt() === null');
  });

  it('discloses the rewarded video on the labelled Candidati CTAs that open it', () => {
    const start = jobBoardSource.indexOf('const rewardedCtaDisclosure = selectedJob');
    const end = jobBoardSource.indexOf(': null;', start);
    const condition = jobBoardSource.slice(start, end);

    expect(condition).toContain('isExternalApplicationJob(selectedJob)');
    expect(condition).toContain("assistedApplicationVariant === 'rewarded_ad'");
    expect(condition).toContain('!killSwitches.rewardedApplicationAd');
    expect(condition).toContain('getRewardedApplicationAccessExpiresAt() === null');
    expect(condition).toContain("t('jobBoard.assisted.rewardedTitle')");
    expect(jobBoardSource.match(/data-testid="rewarded-cta-disclosure">\{rewardedCtaDisclosure\}/g)).toHaveLength(2);
  });

  it('treats a double click on Candidati as one application offer', () => {
    const start = jobBoardSource.indexOf('const handleApply =');
    const end = jobBoardSource.indexOf('const handleShare =', start);
    const handleApply = jobBoardSource.slice(start, end);
    const guard = 'if (applicationOfferOpenRef.current) return;';

    expect(handleApply.indexOf(guard)).toBeGreaterThan(-1);
    expect(handleApply.indexOf(guard)).toBeLessThan(handleApply.indexOf('trackPublisherApplySignals('));
    expect(handleApply).toMatch(/applicationOfferOpenRef\.current = true;\s*setRewardedApplicationJob\(job\);/);
    expect(handleApply).toMatch(/applicationOfferOpenRef\.current = true;\s*setAssistedApplicationJob\(job\);/);
    expect(jobBoardSource).toMatch(
      /useEffect\(\(\) => \{\s*if \(!rewardedApplicationJob && !assistedApplicationJob\) applicationOfferOpenRef\.current = false;\s*\}, \[assistedApplicationJob, rewardedApplicationJob\]\);/,
    );
  });

  it('redirects straight to the employer on no-fill and only after the reward otherwise', () => {
    expect(jobBoardSource).toMatch(
      /const handleRewardedApplicationUnavailable = \(reason: string\) => \{[\s\S]*?redirectExternalApplication\(job, 'rewarded_application_inline_unavailable', true, true, \{\s*handoff: 'direct_external',\s*reason,\s*\}\);/,
    );
    expect(jobBoardSource).toMatch(
      /const handleRewardedApplicationContinue = \(\) => \{[\s\S]*?redirectExternalApplication\(job, 'rewarded_application_inline_completed', true, true, \{\s*handoff: 'rewarded_granted',\s*\}\);/,
    );
    expect(jobBoardSource).toMatch(
      /'external_apply_redirected',\s*\{ \.\.\.assistedApplicationJobContext\(job, assistedApplicationVariant\), surface, \.\.\.extraParams \},/,
    );
    expect(jobBoardSource).toMatch(
      /if \(sameTab\) \{[\s\S]*?window\.location\.assign\(applyDestination\);/,
    );
    expect(jobBoardSource).not.toMatch(/rewarded-frontaliere-house|\.mp4\b/i);
  });

  it('forces the rewarded treatment on the Italian Ticino job-board surface', () => {
    expect(jobBoardSource).toMatch(
      /function isAlwaysRewardedApplicationSurface\(\): boolean[\s\S]*\/\^\\\/cerca-lavoro-ticino\(\?:\\\/\|\$\)\//,
    );
    expect(jobBoardSource).toMatch(
      /const assistedApplicationVariant = shouldBypassAssistedApplicationExperiment[\s\S]*\? 'control'[\s\S]*: alwaysRewardedApplicationSurface[\s\S]*'rewarded_ad'/,
    );
    expect(jobBoardSource).toContain('killSwitches.rewardedApplicationAd');
  });

  it('bypasses the paid and rewarded experiment for crawlers and automated browsers', () => {
    expect(jobBoardSource).toContain(
      "const isCrawlerVisitor = useMemo(() => isCrawlerVisitorAgent(navigator.userAgent || ''), []);",
    );
    expect(jobBoardSource).toContain("import { isLikelyBot } from '@/services/botPatterns';");
    expect(jobBoardSource).toContain(
      'const shouldBypassAssistedApplicationExperiment = isCrawlerVisitor || isLikelyBotVisitor;',
    );
    expect(jobBoardSource).toContain(
      'const isLikelyBotVisitor = useMemo(() => isLikelyBot(), []);',
    );
    expect(jobBoardSource).toMatch(
      /useAssistedApplicationVariant\([\s\S]*!shouldBypassAssistedApplicationExperiment[\s\S]*\)/,
    );
    expect(jobBoardSource).toMatch(
      /const assistedApplicationVariant = shouldBypassAssistedApplicationExperiment[\s\S]*\? 'control'/,
    );
    expect(jobBoardSource).toMatch(
      /if \(shouldBypassAssistedApplicationExperiment \|\| !assistedApplicationVariantReady[\s\S]*trackAssistedApplicationEvent\(/,
    );
  });
});
