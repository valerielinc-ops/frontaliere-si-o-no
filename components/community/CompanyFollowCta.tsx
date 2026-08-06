/**
 * CompanyFollowCta — the ONE wiring of «Segui questa azienda» (issue #5012).
 *
 * `CompanyFollowButton` is the interaction (follow / unfollow / anonymous email
 * capture). This is everything that has to happen AROUND it and had started to
 * be retyped per surface: the session, the four analytics callbacks, and the
 * `invalidateUserAlertsCache()` every write owes the other surfaces' cached
 * eligibility reads.
 *
 * ── WHY IT EXISTS ─────────────────────────────────────────────────────────
 * A job detail is rendered by FOUR different components depending on the state
 * of the ad, and each one draws its own auth gate:
 *
 *   JobBoard (unlocked) · JobBoard (!hasAccess gate) · JobOrphanView · JobExpiredView
 *
 * Phase 2 wired the CTA into the first only. The second was the bug this file
 * came with — measured live 2026-08-06: logged out, three job pages, no CTA
 * anywhere. The last two are the surfaces where following an employer is the
 * MOST useful thing left to offer: the ad is gone, and "tell me when they post
 * again" is the only action that still means anything.
 *
 * Four call sites is exactly where a copied invocation starts drifting — one
 * gets the cache invalidation, another forgets `onUnsubscribed`, a third
 * reports under the wrong surface. Hence one component, four props.
 *
 * ── AUTH ──────────────────────────────────────────────────────────────────
 * `useAuth()` is standalone (no provider), so a caller that has no session in
 * hand gets one for free. JobBoard DOES have one — it receives `authUser` as a
 * prop from App — so it passes `userId`/`email` explicitly and those win: two
 * subscriptions to the same store can otherwise settle a frame apart, and the
 * button would flash the anonymous capture at a signed-in user.
 */
import React, { Suspense } from 'react';
import type { Locale } from '@/services/i18n';
import { useAuth } from '@/services/authService';
import { Analytics } from '@/services/analytics';
import { invalidateUserAlertsCache } from '@/services/userAlertsCache';
import CompanyFollowButton from './CompanyFollowButton';

/**
 * Analytics name per surface. They report apart because the questions differ:
 * the gated job detail competes with the sign-in for one click, the expired and
 * orphan views have no other conversion left, and the SSG employer pages take
 * organic search traffic the job detail never sees. Collapsing them into one
 * name would make each of those unanswerable.
 */
export type CompanyFollowSurface =
  | 'company_follow_button'
  | 'company_follow_gate'
  | 'company_follow_profile'
  | 'company_follow_below_floor'
  | 'company_follow_orphan'
  | 'company_follow_expired';

export interface CompanyFollowCtaProps {
  company: string;
  companyKey?: string | null;
  locale: Locale;
  surface: CompanyFollowSurface;
  sourceJobSlug?: string | null;
  sourceJobUrl?: string | null;
  sourceJobTitle?: string | null;
  /** Session override — see the AUTH note above. */
  userId?: string | null;
  email?: string | null;
}

const CompanyFollowCta: React.FC<CompanyFollowCtaProps> = ({
  company,
  companyKey = null,
  locale,
  surface,
  sourceJobSlug = null,
  sourceJobUrl = null,
  sourceJobTitle = null,
  userId,
  email,
}) => {
  const { user } = useAuth();
  // An employer with no name has no alert key either: rendering would strand an
  // empty box where a CTA is promised.
  if (!company) return null;

  const uid = userId !== undefined ? userId : user?.uid ?? null;
  const mail = email !== undefined ? email : user?.email ?? null;

  return (
    <Suspense fallback={null}>
      <CompanyFollowButton
        company={String(company)}
        companyKey={companyKey}
        userId={uid}
        email={mail}
        locale={locale}
        sourceJobSlug={sourceJobSlug}
        sourceJobUrl={sourceJobUrl}
        sourceJobTitle={sourceJobTitle}
        onSubscribed={() => {
          Analytics.trackJobAlertCtaClick(surface, 'success', String(company));
          Analytics.trackJobAlertCreated({
            keywords: String(company),
            frequency: 'immediate',
            // trackJobAlertCreated counts CREATED alerts site-wide; the single
            // CompanyAlert name keeps that series comparable while the CTA
            // event above answers "from which page".
            surface: 'company_follow_button',
          });
          // Every other surface reads eligibility from the shared getUserAlerts
          // cache; a follow that skips this leaves them one alert behind.
          invalidateUserAlertsCache();
        }}
        onUnsubscribed={() => { invalidateUserAlertsCache(); }}
        onOptInRequested={() => {
          // 'accept', not 'success': the address is captured but the follow is
          // parked pending confirmation. Counting it as created would inflate
          // the funnel with un-consented subscriptions.
          Analytics.trackJobAlertCtaClick(surface, 'accept', String(company));
        }}
        onErrored={() => {
          Analytics.trackJobAlertCtaClick(surface, 'error', String(company));
        }}
      />
    </Suspense>
  );
};

export default CompanyFollowCta;
