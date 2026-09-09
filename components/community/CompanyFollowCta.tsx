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
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BellRing, Loader2, X } from 'lucide-react';
import { useTranslation, type Locale } from '@/services/i18n';
import { getAuthEmail, useAuth } from '@/services/authService';
import { Analytics } from '@/services/analytics';
import { companyAlertKey, findCompanyAlert } from '@/services/jobAlertService';
import { invalidateUserAlertsCache } from '@/services/userAlertsCache';
import BottomPromptShell from '@/components/shared/BottomPromptShell';
import { POPUP_PRIORITY } from '@/services/popupQueue';
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
  | 'company_follow_hub'
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
  const mail = email !== undefined ? email : getAuthEmail(user);
  const followKey = companyAlertKey(String(company), companyKey || undefined);

  return (
    <div
      data-company-follow-inline={followKey || undefined}
      // A reserving fallback, not `null`. Nothing under this boundary suspends
      // today — `CompanyFollowButton` is a plain import — so this is the
      // defensive half: the reservation that actually fires is the button's own
      // `loading` return (the findCompanyAlert round trip) plus the Suspense
      // JobBoard puts around the `lazyRetry` import of THIS component. Kept
      // consistent so the three boundaries cannot disagree about what an
      // unresolved follow CTA looks like — which matters now that it renders in
      // the job-detail header, above the fold, where an unreserved insertion
      // shoves the whole article down.
      // See components/community/CompanyFollowPlaceholder.tsx.
    >
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
    </div>
  );
};

export default CompanyFollowCta;

const COMPANY_FOLLOW_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const COMPANY_FOLLOW_AUTO_OPEN_DELAY_MS = 900;
const COMPANY_FOLLOW_LOOKUP_SLOW_MS = 1200;
const COMPANY_FOLLOW_COOLDOWN_PREFIX = 'company_follow_prompt_dismissed:';
const COMPANY_FOLLOW_TITLE_ID = 'company-follow-prompt-title';

function companyFollowCooldownKey(company: string, companyKey?: string | null): string {
  return `${COMPANY_FOLLOW_COOLDOWN_PREFIX}${companyAlertKey(company, companyKey || undefined)}`;
}

function hasCompanyFollowCooldown(key: string, now = Date.now()): boolean {
  if (!key || typeof window === 'undefined') return false;
  try {
    const dismissedAt = Number(window.localStorage.getItem(key) || 0);
    return Number.isFinite(dismissedAt) && dismissedAt > 0 && now - dismissedAt < COMPANY_FOLLOW_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function saveCompanyFollowCooldown(key: string): void {
  if (!key || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, String(Date.now()));
  } catch {
    // Storage can be blocked in privacy mode; the prompt remains session-safe.
  }
}

function findInlineCompanyFollowButton(companyKey: string): HTMLButtonElement | null {
  if (!companyKey || typeof document === 'undefined') return null;
  const mounts = Array.from(document.querySelectorAll<HTMLElement>('[data-company-follow-inline]'));
  for (const mount of mounts) {
    if (mount.dataset.companyFollowInline !== companyKey) continue;
    // The canonical toggle is the only button carrying aria-pressed. The
    // anonymous email form's submit button must never be mistaken for it.
    const button = mount.querySelector<HTMLButtonElement>('button[aria-pressed]');
    if (button && !button.disabled) return button;
  }
  return null;
}

export interface CompanyFollowPopupProps {
  company: string;
  companyKey?: string | null;
  locale: Locale;
  /** Analytics provenance for the inline CTA this popup activates. */
  surface: CompanyFollowSurface;
  /** Explicit app-session override; omitted means the popup reads useAuth(). */
  userId?: string | null;
  email?: string | null;
  /** JobBoard already owns the app-level auth state; static islands can omit it. */
  authLoading?: boolean;
  /** Test seam; production uses the same existing company lookup as the button. */
  lookupAlert?: typeof findCompanyAlert;
  /** Optional observer for isolated tests/host instrumentation. */
  onShown?: () => void;
}

type CompanyFollowPopupEligibility = 'auth-loading' | 'lookup' | 'eligible' | 'following' | 'error';

/**
 * Auto-opened company follow prompt for a page that names exactly one employer.
 *
 * This component owns eligibility and arbitration only. The acceptance action
 * clicks the one inline `CompanyFollowButton` already rendered by the caller;
 * it never calls subscribeCompanyAlert itself, so the popup cannot create a
 * second `immediate` alert path or claim a subscription before persistence.
 */
export const CompanyFollowPopup: React.FC<CompanyFollowPopupProps> = ({
  company,
  companyKey = null,
  locale,
  surface,
  userId,
  email,
  authLoading,
  lookupAlert = findCompanyAlert,
  onShown,
}) => {
  const { user, loading: hookAuthLoading } = useAuth();
  const { t } = useTranslation();
  const effectiveAuthLoading = authLoading !== undefined ? authLoading : hookAuthLoading;
  const uid = userId !== undefined ? userId : user?.uid ?? null;
  const mail = email !== undefined ? email : getAuthEmail(user);
  const followKey = useMemo(
    () => companyAlertKey(String(company || ''), companyKey || undefined),
    [company, companyKey],
  );
  const cooldownKey = useMemo(
    () => companyFollowCooldownKey(String(company || ''), companyKey),
    [company, companyKey],
  );
  const slotId = `company-follow-prompt:${followKey}`;
  const signedIn = Boolean(uid && mail);
  const [eligibility, setEligibility] = useState<CompanyFollowPopupEligibility>('auth-loading');
  const [open, setOpen] = useState(false);
  const [actionError, setActionError] = useState(false);
  const autoOpenedRef = useRef(false);

  const openIfEligible = useCallback(() => {
    if (!followKey || autoOpenedRef.current || hasCompanyFollowCooldown(cooldownKey)) return;
    autoOpenedRef.current = true;
    setActionError(false);
    setOpen(true);
  }, [cooldownKey, followKey]);

  // A company route can change in-place on a JobBoard SPA navigation. Reset the
  // popup state for the new company, but keep a company-level dismissal cooldown.
  useEffect(() => {
    autoOpenedRef.current = false;
    setOpen(false);
    setActionError(false);
    setEligibility(effectiveAuthLoading ? 'auth-loading' : signedIn ? 'lookup' : 'eligible');
  }, [effectiveAuthLoading, followKey, signedIn]);

  useEffect(() => {
    let cancelled = false;
    if (!followKey) return undefined;
    if (effectiveAuthLoading) {
      setEligibility('auth-loading');
      return () => { cancelled = true; };
    }

    const showAfter = (delayMs: number) => {
      const timer = window.setTimeout(() => {
        if (!cancelled) openIfEligible();
      }, delayMs);
      return () => window.clearTimeout(timer);
    };

    if (!signedIn) {
      setEligibility('eligible');
      return showAfter(COMPANY_FOLLOW_AUTO_OPEN_DELAY_MS);
    }

    setEligibility('lookup');
    let slowTimer: number | null = window.setTimeout(() => {
      slowTimer = null;
      if (!cancelled) openIfEligible();
    }, COMPANY_FOLLOW_LOOKUP_SLOW_MS);

    lookupAlert(uid as string, { name: String(company), companyKey })
      .then((existing) => {
        if (cancelled) return;
        if (slowTimer !== null) window.clearTimeout(slowTimer);
        slowTimer = null;
        if (existing) {
          setEligibility('following');
          setOpen(false);
          return;
        }
        setEligibility('eligible');
        openIfEligible();
      })
      .catch(() => {
        if (cancelled) return;
        if (slowTimer !== null) window.clearTimeout(slowTimer);
        slowTimer = null;
        // Fail closed for subscription eligibility, but make the failure
        // visible once so a lookup outage cannot silently look like an opt-out.
        setEligibility('error');
        openIfEligible();
      });

    return () => {
      cancelled = true;
      if (slowTimer !== null) window.clearTimeout(slowTimer);
    };
  }, [company, companyKey, effectiveAuthLoading, followKey, lookupAlert, openIfEligible, signedIn, uid]);

  const closeWithCooldown = useCallback(() => {
    saveCompanyFollowCooldown(cooldownKey);
    setOpen(false);
    Analytics.trackJobAlertCtaClick(surface, 'dismiss', String(company));
  }, [company, cooldownKey, surface]);

  const handleAccept = useCallback(() => {
    const button = findInlineCompanyFollowButton(followKey);
    if (!button) {
      setActionError(true);
      return;
    }
    if (button.getAttribute('aria-pressed') === 'true') {
      setEligibility('following');
      setOpen(false);
      return;
    }
    Analytics.trackJobAlertCtaClick(surface, 'accept', String(company));
    // The canonical button owns auth/capture/persistence. Closing here does
    // not claim success; the inline component will render its real state.
    button.click();
    setOpen(false);
  }, [company, followKey, surface]);

  const handleShown = useCallback(() => {
    // BottomPromptShell calls this only after this slot wins and renders. A
    // queued request therefore cannot create an impression.
    Analytics.trackJobAlertCtaShown('company_follow_button', String(company));
    onShown?.();
  }, [company, onShown]);

  if (!company || !followKey || !open || eligibility === 'following') return null;

  const loading = eligibility === 'auth-loading' || eligibility === 'lookup';
  const title = loading
    ? t('jobAlert.companyFollow.popupLoading')
    : eligibility === 'error'
    ? t('jobAlert.companyFollow.popupUnavailable')
    : t('jobAlert.companyFollow.popupTitle', { company: String(company) });
  const body = loading
    ? t('jobAlert.companyFollow.popupLoadingBody')
    : eligibility === 'error'
    ? t('jobAlert.companyFollow.popupUnavailableBody')
    : signedIn
    ? t('jobAlert.companyFollow.popupBody', { company: String(company) })
    : t('jobAlert.companyFollow.popupAnonymousBody', { company: String(company) });

  return (
    <BottomPromptShell
      slotId={slotId}
      priority={POPUP_PRIORITY.COMPANY_FOLLOW_PROMPT}
      width="md"
      ariaLabelledBy={COMPANY_FOLLOW_TITLE_ID}
      onShown={handleShown}
      onEscape={closeWithCooldown}
    >
      <div className="relative p-3.5 rounded-xl border border-accent-border bg-surface shadow-lg shadow-accent/20">
        <button
          type="button"
          onClick={closeWithCooldown}
          aria-label={t('common.close')}
          className="absolute top-2 right-2 p-1 text-muted hover:text-strong transition-colors"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
        <div className="flex items-start gap-3">
          <span className="flex-shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full bg-accent-strong text-on-accent shadow-sm">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <BellRing className="w-4 h-4" aria-hidden="true" />}
          </span>
          <div className="flex-1 min-w-0 pr-4">
            <h3 id={COMPANY_FOLLOW_TITLE_ID} className="text-sm font-bold text-heading">{title}</h3>
            <p className="mt-0.5 text-xs text-subtle">{body}</p>
            {actionError && <p className="mt-2 text-xs text-danger">{t('jobAlert.companyFollow.popupInlineUnavailable')}</p>}
            <div className="mt-2 flex items-center gap-2">
              {loading ? (
                <span className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[44px] text-xs font-medium text-muted" aria-live="polite">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  {t('jobAlert.companyFollow.popupChecking')}
                </span>
              ) : eligibility === 'error' ? (
                <button
                  type="button"
                  onClick={closeWithCooldown}
                  className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[44px] text-xs font-medium text-muted hover:text-strong transition-colors"
                >
                  {t('jobAlert.companyFollow.popupDismiss')}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleAccept}
                    className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[44px] text-xs font-semibold rounded-lg bg-accent-strong text-on-accent hover:bg-accent-strong-hover transition-colors"
                  >
                    {t('jobAlert.companyFollow.popupAccept', { company: String(company) })}
                  </button>
                  <button
                    type="button"
                    onClick={closeWithCooldown}
                    className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[44px] text-xs font-medium text-muted hover:text-strong transition-colors"
                  >
                    {t('jobAlert.companyFollow.popupDismiss')}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </BottomPromptShell>
  );
};
