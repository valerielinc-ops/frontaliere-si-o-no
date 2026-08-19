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
 * Plus the SSG islands: the employer profile page, its below-floor variant and
 * the per-employer «aziende che assumono» city hub, all mounted through
 * CompanyFollowMount.
 *
 * Seven call sites is well past where a copied invocation starts drifting — one
 * gets the cache invalidation, another forgets `onUnsubscribed`, a third reports
 * under the wrong surface. Hence one component, one set of callbacks.
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
import type { findCompanyAlert } from '@/services/jobAlertService';
import { invalidateUserAlertsCache } from '@/services/userAlertsCache';
import CompanyFollowButton from './CompanyFollowButton';
import CompanyFollowPlaceholder from './CompanyFollowPlaceholder';

/**
 * Analytics name per surface. They report apart because the questions differ:
 * the gated job detail competes with the sign-in for one click, the expired and
 * orphan views have no other conversion left, and the SSG employer pages take
 * organic search traffic the job detail never sees. Collapsing them into one
 * name would make each of those unanswerable.
 *
 * `company_follow_suggestion` is the newest and the odd one out: it is the only
 * surface where the site CHOSE the employer instead of the reader arriving on
 * one. Its conversion rate is therefore not a UI measurement but the only
 * available verdict on the ranking in services/employerSuggestions.ts — which,
 * with slug + active-ad count as its entire input, needs one.
 */
export type CompanyFollowSurface =
  | 'company_follow_button'
  | 'company_follow_gate'
  | 'company_follow_profile'
  | 'company_follow_below_floor'
  | 'company_follow_orphan'
  | 'company_follow_expired'
  | 'company_follow_city'
  | 'company_follow_suggestion';

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
  /**
   * "Is this employer already followed?", answered by the CALLER.
   *
   * `CompanyFollowButton` resolves its initial follow/unfollow state by calling
   * `findCompanyAlert`, which runs `getUserAlerts` — an uncached collectionGroup
   * query, one per mounted button. That is right for the six surfaces that know
   * nothing about the visitor's alerts, and redundant for a caller that just
   * read the whole list and derived what to render FROM it: the suggestions on
   * /aziende-seguite/ are, by construction, the employers that list says are
   * not followed. Five buttons there would otherwise re-ask Firestore five
   * times for a list already sitting in the page's state.
   *
   * Pass a STABLE function reference. It reaches the button's `lookup` prop,
   * which is in its effect's dependency array, so a fresh closure on every
   * render would re-run the lookup and reset a button the user had just
   * flipped to "following".
   */
  lookupAlert?: typeof findCompanyAlert;
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
  lookupAlert,
}) => {
  const { user } = useAuth();
  // An employer with no name has no alert key either: rendering would strand an
  // empty box where a CTA is promised.
  if (!company) return null;

  const uid = userId !== undefined ? userId : user?.uid ?? null;
  const mail = email !== undefined ? email : user?.email ?? null;

  return (
    // A reserving fallback, not `null`. On the job detail this CTA now renders
    // in the header, above the fold: a null fallback means the whole block
    // appears out of nowhere when the chunk lands and shoves the article down.
    // See components/community/CompanyFollowPlaceholder.tsx.
    <Suspense fallback={<CompanyFollowPlaceholder />}>
      <CompanyFollowButton
        company={String(company)}
        companyKey={companyKey}
        userId={uid}
        email={mail}
        locale={locale}
        sourceJobSlug={sourceJobSlug}
        sourceJobUrl={sourceJobUrl}
        sourceJobTitle={sourceJobTitle}
        // `undefined` falls through to the button's own default
        // (`findCompanyAlert`), so the six surfaces that pass nothing keep
        // querying exactly as before.
        lookup={lookupAlert}
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
