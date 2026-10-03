import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const jobBoardSource = readFileSync(
  resolve(process.cwd(), 'components/community/JobBoard.tsx'),
  'utf8',
);

describe('assisted application JobBoard handoff', () => {
  it('ships with the GPT rewarded video switched off and its paid fallback reachable', () => {
    const gptSource = readFileSync(resolve(process.cwd(), 'components/shared/GptAdSlot.tsx'), 'utf8');
    const rewardedSource = readFileSync(resolve(process.cwd(), 'services/rewardedWebAd.ts'), 'utf8');
    const experimentSource = readFileSync(resolve(process.cwd(), 'services/assistedApplicationExperiment.ts'), 'utf8');

    // Owner decision 2026-10-03: no GPT rewarded request until the unit has demand.
    expect(gptSource).toContain('export const GPT_REWARDED_ENABLED = false;');
    expect(rewardedSource).toContain(
      "if (!GPT_REWARDED_ENABLED) return { reason: 'gpt_unavailable', detail: 'rewarded_disabled' };",
    );
    // The reason the switch reports must keep opening the paid offer instead
    // of a silent hand-off.
    const loadFailures = experimentSource.slice(
      experimentSource.indexOf('export const OFFERWALL_LOAD_FAILURE_REASONS'),
      experimentSource.indexOf('export function isOfferwallLoadFailure'),
    );
    expect(loadFailures).toContain("'gpt_unavailable'");
  });

  it('routes the paid and rewarded treatments through the detail render', () => {
    const start = jobBoardSource.indexOf('const handleApply =');
    const end = jobBoardSource.indexOf('const handleShare =', start);
    const handleApply = jobBoardSource.slice(start, end);
    const rewardedStart = handleApply.indexOf("if (isExternal && assistedApplicationVariant === 'rewarded_ad')");
    const paidStart = handleApply.indexOf("if (assistedApplicationVariant === 'assisted_application')");
    const rewardedArm = handleApply.slice(rewardedStart, paidStart);
    const paidArm = handleApply.slice(paidStart);

    expect(paidArm).toMatch(
      /setAssistedApplicationJob\(job\);[\s\S]*if \(!isJobDetailView\) openDetail\(job, true\);/,
    );
    expect(rewardedArm).toContain("'rewarded_application_offer_requested'");
    expect(rewardedArm).toContain("provider: 'google_gpt_rewarded_web'");
    // The click opens the offer; the offer owns the Google request for that
    // click and opens the video on rewardedSlotReady, so the click handler
    // never decides no-fill from a request that is still pending.
    expect(rewardedArm).not.toContain('showRewardedWebAd(');
    expect(rewardedArm).not.toContain("'not_ready_on_candidate_click'");
    expect(rewardedArm).toContain('setRewardedApplicationJob(job)');
    expect(rewardedArm).toContain('if (!isJobDetailView) openDetail(job, true)');
    expect(jobBoardSource).toContain('openDetail(rewardedApplicationJob, true)');
    expect(jobBoardSource).toContain('RewardedApplicationOffer');
    expect(jobBoardSource).toContain('preloadRewardedWebAd');
    expect(jobBoardSource).toContain("import { preloadRewardedWebAd } from '@/services/rewardedWebAd';");
    expect(jobBoardSource).toContain('shouldPreloadRewardedApplicationAd');
    expect(jobBoardSource).not.toContain('rewarded_application_native_offerwall');
    expect(jobBoardSource).not.toContain('RewardedApplicationPage');
    expect(jobBoardSource).not.toContain('rewardedApplicationHandoff');
    expect(jobBoardSource).toMatch(
      /if \(!assistedApplicationJob \|\| isJobDetailView \|\| !authResolved\) return;[\s\S]*openDetail\(assistedApplicationJob, true\);/,
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

  it('hands off to the employer after the reward, and on a failure without the paid fallback', () => {
    expect(jobBoardSource).toMatch(
      /const handleRewardedApplicationUnavailable = \(\s*reason: string,\s*info\?: RewardedOfferUnavailableInfo,\s*\): Promise<boolean> \| undefined => \{[\s\S]*?if \(!hasTransientUserActivation\(\)\) \{\s*setRewardedApplicationJob\(null\);\s*void redirectExternalApplication\(job, 'rewarded_application_inline_unavailable', true, true, \{\s*handoff: 'direct_external',\s*reason,\s*\}\);\s*return undefined;/,
    );
    expect(jobBoardSource).toMatch(
      /'external_apply_redirected',\s*\{ \.\.\.assistedApplicationJobContext\(job, assistedApplicationVariant\), surface, \.\.\.extraParams \},/,
    );
    expect(jobBoardSource).toMatch(
      /if \(sameTab\) \{[\s\S]*?window\.location\.assign\(applyDestination\);\s*\} else \{\s*window\.open\(applyDestination, '_blank', 'noopener,noreferrer'\);/,
    );
    expect(jobBoardSource).not.toMatch(/rewarded-frontaliere-house|\.mp4\b/i);
  });

  it('keeps the offer until the direct hand-off new tab is confirmed, and retries it from the open card', () => {
    // PR #10366 review: a popup blocked with navigator.userActivation.isActive
    // must leave the offer on screen with its "open" card, not lose the employer.
    const start = jobBoardSource.indexOf('const handleRewardedApplicationUnavailable = (');
    const end = jobBoardSource.indexOf('const handleAssistedPaid = () => {', start);
    const handler = jobBoardSource.slice(start, end);
    const direct = handler.slice(handler.indexOf('rewardedDirectHandoffReasonRef.current = reason;'));
    expect(start).toBeGreaterThan(-1);
    expect(handler.indexOf('rewardedDirectHandoffReasonRef.current = reason;')).toBeGreaterThan(-1);
    // Watching starts before window.open; the offer unmounts only on a confirmed tab.
    expect(direct.indexOf('const opened = watchNewTabOpened();')).toBeGreaterThan(-1);
    expect(direct.indexOf('const opened = watchNewTabOpened();')).toBeLessThan(
      direct.indexOf("redirectExternalApplication(job, 'rewarded_application_inline_unavailable', true, false, {"),
    );
    expect(direct).toMatch(/return opened\.then\(\(ok\) => \{\s*if \(ok\) setRewardedApplicationJob\(null\);\s*return ok;\s*\}\);/);
    expect(direct).not.toContain('window.location.assign');
    // The card's click retries the same direct hand-off in a new tab.
    expect(jobBoardSource).toMatch(
      /\} else if \(directReason !== null\) \{[\s\S]*?redirectExternalApplication\(job, 'rewarded_application_inline_unavailable', false, false, \{\s*handoff: 'direct_external',\s*reason: directReason,\s*\}\);/,
    );
    expect(jobBoardSource).toMatch(/if \(!rewardedApplicationJob\) \{[\s\S]*?rewardedDirectHandoffReasonRef\.current = null;/);
  });

  it('opens the employer in a new tab after the reward and from the free button of the paid offer', () => {
    // Owner decision 2026-09-29: the visitor keeps the site. The offer calls
    // onContinue only inside a click's activation (see RewardedApplicationOffer).
    expect(jobBoardSource).toMatch(
      /const handleRewardedApplicationContinue = \(\): Promise<boolean> => \{[\s\S]*?redirectExternalApplication\(job, 'rewarded_application_inline_completed', true, false, \{\s*handoff: 'rewarded_granted',\s*\}\);/,
    );
    const start = jobBoardSource.indexOf('const handleAssistedExternal = () => {');
    const end = jobBoardSource.indexOf('const handleRewardedApplicationContinue = (): Promise<boolean> => {', start);
    const handler = jobBoardSource.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(handler).toMatch(
      /void redirectExternalApplication\(\s*job,\s*assistedApplicationVariant === 'rewarded_ad' \? 'rewarded_application_fallback' : 'assisted_application_offer',\s*true,\s*\);/,
    );
    // The new tab opens synchronously, inside the click: no await before it.
    const redirect = jobBoardSource.slice(
      jobBoardSource.indexOf('const redirectExternalApplication = async ('),
      jobBoardSource.indexOf('const handleAssistedExternal = () => {'),
    );
    expect(redirect.indexOf('await ')).toBeGreaterThan(redirect.indexOf('if (sameTab) {'));
    expect(redirect.indexOf('await ')).toBeLessThan(redirect.indexOf('} else {'));
  });

  it('keeps the offer until the new tab takes the foreground, so a blocked popup brings the open card back', () => {
    const start = jobBoardSource.indexOf('const handleRewardedApplicationContinue = (): Promise<boolean> => {');
    const end = jobBoardSource.indexOf('// Only a fresh page load can hold the Offerwall', start);
    const handler = jobBoardSource.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    // Watching starts before window.open: the new tab can hide the page at once.
    expect(handler.indexOf('const opened = watchNewTabOpened();')).toBeGreaterThan(-1);
    expect(handler.indexOf('const opened = watchNewTabOpened();')).toBeLessThan(handler.indexOf('redirectExternalApplication('));
    // The offer unmounts only on a confirmed tab; otherwise it shows its card.
    expect(handler).toMatch(/return opened\.then\(\(ok\) => \{\s*if \(ok\) setRewardedApplicationJob\(null\);\s*return ok;\s*\}\);/);
    expect(handler).not.toMatch(/if \(!job\) return Promise\.resolve\(true\);\s*setRewardedApplicationJob\(null\);/);
  });

  it('sends the pending receipts of earlier rewarded grants from a visible job-board page', () => {
    // services/rewardedHandoffLedger.ts: the visitor who never came back to
    // the tab after the employer's page opened is counted on the next visit.
    expect(jobBoardSource).toContain("import { flushHandoffReceipts } from '@/services/rewardedHandoffLedger';");
    expect(jobBoardSource).toMatch(/useEffect\(\(\) => \{\s*flushHandoffReceipts\(\);\s*\}, \[\]\);/);
  });

  it('resumes a click whose access is already granted on the open card, never in this tab', () => {
    const start = jobBoardSource.indexOf('const offerwallResumeCheckedRef = useRef(false);');
    const end = jobBoardSource.indexOf('const handleShare = async', start);
    const effect = jobBoardSource.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(effect).not.toContain("redirectExternalApplication(selectedJob, 'rewarded_application_entitlement', false, true)");
    expect(effect).toMatch(
      /'rewarded_application_access_used'[\s\S]*?applicationOfferOpenRef\.current = true;\s*setRewardedApplicationOpenCardOnly\(true\);\s*setRewardedApplicationResumed\(true\);\s*setRewardedApplicationJob\(selectedJob\);\s*return;/,
    );
    expect(jobBoardSource).toContain('startInHandoff={rewardedApplicationOpenCardOnly}');
    // Its "open" click keeps the entitlement surface and opens a new tab.
    expect(jobBoardSource).toMatch(
      /if \(rewardedApplicationOpenCardOnly\) \{[\s\S]*?redirectExternalApplication\(job, 'rewarded_application_entitlement', false, false\);/,
    );
  });

  it('opens the paid offer when the Offerwall chain failed to load or the ad was refused, with the flag on', () => {
    const start = jobBoardSource.indexOf('const handleRewardedApplicationUnavailable = (');
    const end = jobBoardSource.indexOf('const handleAssistedPaid = () => {', start);
    const handler = jobBoardSource.slice(start, end);
    // No second paid offer after the paid choice shown before the Offerwall.
    const fallback = handler.indexOf(
      'if (offerwallPaidFallbackEnabled && shouldOfferPaidFallback(reason) && !info?.paidOfferShown) {',
    );
    const redirect = handler.indexOf("redirectExternalApplication(job, 'rewarded_application_inline_unavailable'");

    expect(fallback).toBeGreaterThan(-1);
    expect(fallback).toBeLessThan(redirect);
    expect(handler.slice(fallback, redirect)).toMatch(
      /setRewardedApplicationJob\(null\);[\s\S]*setAssistedOfferSource\('offerwall_fallback'\);\s*setAssistedApplicationJob\(job\);[\s\S]*'offerwall_paid_fallback_offered'[\s\S]*return;/,
    );
    expect(jobBoardSource).toMatch(
      /useOfferwallPaidFallback\(\s*alwaysRewardedApplicationSurface && !shouldBypassAssistedApplicationExperiment,\s*\)/,
    );
    expect(jobBoardSource).toContain(
      "|| (assistedApplicationVariant === 'rewarded_ad' && assistedOfferSource === 'offerwall_fallback');",
    );
    expect(jobBoardSource).toContain('const assistedApplicationOfferJsx = assistedApplicationJob && assistedOfferAvailable ? (');
    expect(jobBoardSource).toContain('if (!job || !assistedOfferAvailable) return;');
    expect(jobBoardSource).toMatch(
      /const startAssistedCheckout = async \(job: JobListing, extra: Record<string, unknown> = \{\}\) => \{\s*if \(assistedCheckoutBusy\) return;/,
    );
    expect(jobBoardSource).toContain(
      "experimentVariant: assistedApplicationVariant === 'assisted_application' ? 'assisted_application' : 'offerwall_fallback',",
    );
  });

  it('offers the paid application before the Offerwall under the paid-fallback flag', () => {
    // Owner decision 2026-10-03: the paid choice first, the Offerwall prepared
    // hidden behind it; ASSISTED_APPLICATION_OFFERWALL_FALLBACK off restores
    // the Offerwall-only click.
    const start = jobBoardSource.indexOf('const rewardedApplicationOfferJsx = ');
    const end = jobBoardSource.indexOf('const authGateModalJsx = ', start);
    const offer = jobBoardSource.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(offer).toMatch(
      /paidChoice=\{offerwallPaidFallbackEnabled \? \{\s*onChoosePaid: \(\) => startAssistedCheckout\(rewardedApplicationJob, \{ trigger: 'offerwall_first' \}\),\s*paidLoading: assistedCheckoutBusy,\s*error: assistedCheckoutError,\s*\} : undefined\}/,
    );
    // Closing the choice also clears a checkout it started.
    expect(offer).toMatch(
      /onDismiss=\{\(\) => \{\s*setRewardedApplicationJob\(null\);\s*setAssistedCheckoutBusy\(false\);\s*setAssistedCheckoutError\(null\);\s*\}\}/,
    );
  });

  it('forces the rewarded treatment on every job-board section', () => {
    // Same shared matcher as the click-only Offerwall gate (owner decision
    // 2026-09-26: every canton, the Switzerland aggregator, every locale).
    expect(jobBoardSource).toContain(
      "import { isJobBoardSectionPathname } from '../../scripts/lib/jobBoardSections.mjs';",
    );
    expect(jobBoardSource).toMatch(
      /function isAlwaysRewardedApplicationSurface\(\): boolean \{[^}]*return isJobBoardSectionPathname\(window\.location\.pathname\);\s*\}/,
    );
    expect(jobBoardSource).not.toMatch(/cerca-lavoro-ticino\(\?:/);
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
