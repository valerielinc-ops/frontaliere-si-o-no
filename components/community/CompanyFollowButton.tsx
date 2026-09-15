import React, { useCallback, useEffect, useState } from 'react';
import { BellRing, Check, Loader2, Mail } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import type { Locale } from '@/services/i18n';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import {
  companyAlertKey,
  deleteAlert,
  findCompanyAlert,
  subscribeCompanyAlert,
} from '@/services/jobAlertService';
import { savePendingCompanyFollow } from '@/services/companyFollowIntent';
import { upsertUnifiedEmailSubscriber, requestConfirmationEmail } from '@/services/newsletterSubscribers';
import EmailConsentCheckbox from '@/components/shared/EmailConsentCheckbox';
import CompanyFollowPlaceholder from './CompanyFollowPlaceholder';
import { getFirestore } from 'firebase/firestore';
import { getApp } from '@/services/firebase';
import { reportCaughtError } from '@/services/errorReporter';
import { buildPath } from '@/services/router';

export type CompanyFollowButtonStatus =
  | 'idle'
  | 'loading'
  | 'submitting'
  | 'following'
  | 'error'
  /** Anonymous visitor tapped "Segui": the email field is open (#5012 phase 2). */
  | 'capture'
  /** Access email sent; the follow is parked until the link is used. */
  | 'pendingOptIn';

export interface CompanyFollowButtonProps {
  /** Employer display name (`job.company`). */
  company: string;
  /** Optional crawler company key (`job.companyKey`) — improves canonicalisation. */
  companyKey?: string | null;
  /** Authenticated user id. `null`/absent → the anonymous email-capture path. */
  userId?: string | null;
  /** Authenticated user email. `null`/absent → the anonymous email-capture path. */
  email?: string | null;
  /** Active locale — passed straight to the alert config. */
  locale: Locale;
  /** Slug of the job the user followed from — stored as provenance. */
  sourceJobSlug?: string | null;
  /** Full canonical URL of that job — stored as provenance. */
  sourceJobUrl?: string | null;
  /** Title of that job — stored as provenance. */
  sourceJobTitle?: string | null;
  /** Called on a successful follow (analytics / cache invalidation). */
  onSubscribed?: () => void;
  /** Called on a successful unfollow. */
  onUnsubscribed?: () => void;
  /** Called once an anonymous visitor's opt-in email has been requested. */
  onOptInRequested?: (email: string) => void;
  /** Called when a write throws. */
  onErrored?: (error: unknown) => void;
  /** Test seams. */
  lookup?: typeof findCompanyAlert;
  subscribe?: typeof subscribeCompanyAlert;
  unfollow?: typeof deleteAlert;
  captureEmail?: (email: string, intent: { company: string; companyKey?: string | null }) => Promise<void>;
}

/**
 * "Segui questa azienda" — CompanyAlert subscribe/unsubscribe (issue #5012).
 *
 * Pins a job alert to one employer via `specificCompanyKey`, the filter the
 * matcher (services/jobAlertMatching.mjs) has always supported as a hard scope.
 * The persisted token is `companyAlertKey()` — the canonical `/aziende/<slug>/`
 * slug, the ONE normalisation shared with the matcher.
 *
 * ── TWO PATHS (phase 2) ───────────────────────────────────────────────────
 * Signed in  → write the alert immediately (`subscribeCompanyAlert`).
 * Anonymous  → register the address under the site's terms-based relationship,
 *              request an access link, and PARK the follow in
 *              services/companyFollowIntent.ts. App.tsx replays it once the
 *              login link signs the visitor in.
 *
 * Phase 1 returned `null` for anonymous visitors, so the highest-intent reader
 * on the page — someone looking at a specific employer's ad — could not follow
 * at all. The follow intent is parked while the address is authenticated; the
 * terms-based base relationship is written immediately and the concrete
 * company alert is replayed after login.
 *
 * Unfollow DEACTIVATES the alert (`deleteAlert` → `active:false` + `unsubscribed_at`).
 *
 * An earlier revision only cleared the pin, on the reasoning that keeping one
 * re-targetable row made the follow state readable back. That was wrong in a way that
 * mattered: the row stayed ACTIVE, and `buildAlertProfile` still derives softTokens from
 * the `sourceJobTitle`/`sourceJobSlug` the follow captured — so an unfollowed employer kept
 * producing weak-intent matches built from the title of whatever job the user happened to
 * be reading. An unsubscribe that keeps sending email is a GDPR problem, not a UX nicety.
 * It also kept consuming a MAX_ALERTS_PER_USER slot for a cancelled subscription.
 *
 * Consequence, deliberate: `findCompanyAlert` filters on `active == true`, so a re-follow
 * creates a NEW alert document rather than reviving the deactivated one. That is the
 * correct audit trail — the withdrawal stays on record with its `unsubscribed_at` — and it
 * costs one document, not one query.
 *
 * No new Firestore query: `findCompanyAlert` filters `getUserAlerts()` in
 * memory, reusing the already-deployed (userId, active, createdAt desc)
 * collectionGroup index. `firestore.indexes.json` is NOT applied by CI, so a
 * surface that needed a new index would ship broken.
 */
export default function CompanyFollowButton({
  company,
  companyKey,
  userId,
  email,
  locale,
  sourceJobSlug,
  sourceJobUrl,
  sourceJobTitle,
  onSubscribed,
  onUnsubscribed,
  onOptInRequested,
  onErrored,
  lookup = findCompanyAlert,
  subscribe = subscribeCompanyAlert,
  unfollow = deleteAlert,
  captureEmail,
}: CompanyFollowButtonProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CompanyFollowButtonStatus>('loading');
  const [alertId, setAlertId] = useState<string | null>(null);
 const [typedEmail, setTypedEmail] = useState('');
 const [captureError, setCaptureError] = useState('');

  const slug = companyAlertKey(company, companyKey || undefined);
  const signedIn = Boolean(userId && email);

  useEffect(() => {
    let cancelled = false;
    if (!slug || !userId) { setStatus('idle'); return undefined; }
    setStatus('loading');
    lookup(userId, { name: company, companyKey })
      .then((existing) => {
        if (cancelled) return;
        setAlertId(existing?.id ?? null);
        setStatus(existing ? 'following' : 'idle');
      })
      .catch(() => { if (!cancelled) setStatus('idle'); });
    return () => { cancelled = true; };
  }, [company, companyKey, lookup, slug, userId]);

  const handleFollow = useCallback(async () => {
    if (!slug) return;
    // Anonymous: open the capture field instead of writing. The concrete alert
    // needs an authenticated user id; asking for the address here supplies the
    // identity needed to replay the follow after the access link is used.
    if (!signedIn) { setStatus('capture'); return; }
    setStatus('submitting');
    try {
      const created = await subscribe(userId as string, email as string, { name: company, companyKey }, locale, {
        slug: sourceJobSlug ?? null,
        url: sourceJobUrl ?? null,
          title: sourceJobTitle ?? null,
      }, {
        email: email as string,
        source: 'company_follow_button',
        // Keep the authenticated and anonymous follow paths on the same
        // unified-consent channel. The legacy `company_follow_button` value is
        // retained only for historical rows/backfills whose purpose was
        // company-follow-only; using it here would silently omit the user from
        // the other email channels despite the shared checkbox.
        sourceChannel: 'company_follow_unified',
        sourcePage: typeof window !== 'undefined' ? window.location.pathname : null,
        sourceCta: 'company_follow_button',
        sourceComponent: 'CompanyFollowButton',
        sourceRouteFamily: 'company-follow',
        locale,
        jobContext: { company },
      });
      setAlertId(created.id);
      setStatus('following');
      if (onSubscribed) onSubscribed();
    } catch (error: unknown) {
      setStatus('error');
      if (onErrored) onErrored(error);
    }
  }, [company, companyKey, email, locale, onErrored, onSubscribed, signedIn, slug, sourceJobSlug, sourceJobTitle, sourceJobUrl, subscribe, userId]);

  /**
   * Anonymous submit. Reuses the site's ONE consent mechanism end to end:
   * `upsertUnifiedEmailSubscriber` writes the terms-based relationship. The
   * access email is separate from consent: it only authenticates the address
   * so App.tsx can replay the parked follow. A proofless historical row may
   * still receive the dedicated remediation flow; without an access branch a
   * returning visitor would tap "Segui", receive no email, and never be
   * followed.
   */
  const handleCaptureSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (status === 'submitting') return;
    const trimmed = typedEmail.trim().toLowerCase();
    if (!validateEmailStrict(trimmed).valid) {
      setCaptureError(t('newsletter.invalidEmail'));
      return;
    }
    setCaptureError('');
    setStatus('submitting');
    try {
      if (captureEmail) {
        await captureEmail(trimmed, { company, companyKey });
      } else {
        const firestore = getFirestore(await getApp());
        const upsert = await upsertUnifiedEmailSubscriber(firestore, {
          email: trimmed,
          source: 'company_follow_button',
          // Do not use the legacy `company_follow_button` channel here: that
          // compatibility path intentionally authorises only the follow
          // purpose. This gate is the unified email choice and enables the
          // shared jobs relationship; company-follow remains a separate alert
          // record under that relationship.
          sourceChannel: 'company_follow_unified',
          sourcePage: typeof window !== 'undefined' ? window.location.pathname : '',
          sourceCta: 'company_follow_button',
          sourceComponent: 'CompanyFollowButton',
          sourceRouteFamily: 'company-follow',
          locale,
          jobContext: { company },
        });
        // A proofless historical row can remain `pending` while the dedicated
        // remediation flow is open; in that case the upsert already requested
        // the fresh DOI and a second login email would be redundant. A row with
        // existing proof still needs the access link because no DOI is sent.
        if (upsert.status !== 'pending' || upsert.hadConfirmationProof) {
          await requestConfirmationEmail(trimmed, 'login');
        }
      }
      // Park the follow. It becomes a concrete alert after the login link lands
      // (App.tsx → flushPendingCompanyFollows), while the base relationship is
      // already present.
      savePendingCompanyFollow({
        company,
        companyKey: companyKey ?? null,
        locale: locale as 'it' | 'en' | 'de' | 'fr',
        sourceJobSlug: sourceJobSlug ?? null,
        sourceJobUrl: sourceJobUrl ?? null,
        sourceJobTitle: sourceJobTitle ?? null,
        email: trimmed,
      });
      setStatus('pendingOptIn');
      if (onOptInRequested) onOptInRequested(trimmed);
    } catch (error: unknown) {
      reportCaughtError(error, 'companyFollow.captureEmail');
      setCaptureError(t('jobAlert.companyFollow.error'));
      setStatus('capture');
      if (onErrored) onErrored(error);
    }
  }, [captureEmail, company, companyKey, locale, onErrored, onOptInRequested, sourceJobSlug, sourceJobTitle, sourceJobUrl, status, t, typedEmail]);

  const handleUnfollow = useCallback(async () => {
    if (!alertId || !email) return;
    setStatus('submitting');
    try {
      // Deactivates the alert (active:false + unsubscribed_at) rather than only
      // nulling the pin (#5012 review). Clearing specificCompanyKey alone left the row
      // ACTIVE, and buildAlertProfile still derives softTokens from the sourceJobTitle /
      // sourceJobSlug the follow captured — so an "unfollowed" employer kept sending
      // weak-intent matches from the title of the job the user happened to be reading.
      // It also kept consuming a MAX_ALERTS_PER_USER slot for a subscription the user
      // had explicitly cancelled.
      await unfollow(email, alertId);
      setAlertId(null);
      setStatus('idle');
      if (onUnsubscribed) onUnsubscribed();
    } catch (error: unknown) {
      setStatus('error');
      if (onErrored) onErrored(error);
    }
  }, [alertId, email, onErrored, onUnsubscribed, unfollow]);

  // No employer key means no alert to write: nothing to reserve either.
  if (!slug) return null;
  // `loading` is the `findCompanyAlert` round trip for a signed-in visitor. It
  // used to render nothing, which was free while this CTA lived below the fold
  // and is a layout shift now that the job detail renders it in the header.
  if (status === 'loading') return <CompanyFollowPlaceholder />;

  if (status === 'pendingOptIn') {
    return (
      <div className="mt-3 rounded-lg border border-edge bg-surface-raised px-4 py-3">
        <p className="text-sm font-semibold text-heading flex items-center gap-2">
          <Mail className="w-4 h-4 text-accent" aria-hidden="true" />
          {t('jobAlert.companyFollow.optInSentTitle')}
        </p>
        <p className="mt-1 text-xs text-muted">
          {t('jobAlert.companyFollow.optInSentBody')}
        </p>
      </div>
    );
  }

  const busy = status === 'submitting';
  const following = status === 'following';

  if (status === 'capture' || (busy && !signedIn)) {
    return (
      <form className="mt-3 rounded-lg border border-edge bg-surface-raised px-4 py-3" onSubmit={handleCaptureSubmit}>
        <label className="block text-sm font-semibold text-heading" htmlFor="company-follow-email">
          {t('jobAlert.companyFollow.emailLabel')}
        </label>
        <p className="mt-1 text-xs text-muted">
          {t('jobAlert.companyFollow.emailHint')}
        </p>
        <div className="mt-2 flex flex-col sm:flex-row gap-2">
          <EmailInput
            id="company-follow-email"
            value={typedEmail}
            onChange={setTypedEmail}
            className="flex-1"
            ariaLabel={t('jobAlert.companyFollow.emailLabel')}
          />
          <button
            type="submit"
            disabled={busy}
            aria-busy={busy}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] text-sm font-semibold rounded-lg border border-accent-border bg-accent text-on-accent hover:bg-accent-hover disabled:opacity-60"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <BellRing className="w-4 h-4" aria-hidden="true" />}
            {t('jobAlert.companyFollow.cta')}
          </button>
        </div>
        <EmailConsentCheckbox
          id="company-follow-email-consent"
          locale={locale}
          consentKey="communicationsOptIn"
          className="mt-2 flex items-start gap-2 cursor-pointer"
          noticeClassName="text-[10px] text-muted leading-snug"
        />
        {captureError && <p className="mt-2 text-xs text-danger">{captureError}</p>}
      </form>
    );
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={following ? handleUnfollow : handleFollow}
        disabled={busy}
        aria-busy={busy}
        aria-pressed={following}
        className={`inline-flex items-center gap-2 px-4 py-2 min-h-[44px] text-sm font-semibold rounded-lg border transition-colors disabled:opacity-60 ${
          following
            ? 'border-edge bg-surface-raised text-body'
            : 'border-accent-border bg-surface text-accent hover:bg-accent-subtle'
        }`}
      >
        {busy ? (
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
        ) : following ? (
          <Check className="w-4 h-4" aria-hidden="true" />
        ) : (
          // A bell, not a building. Two reasons: on the job detail this control
          // now sits directly under EmployerHubCta, which already carries a
          // Building2 — two identical glyphs one above the other read as one
          // repeated link, not as two different actions. And the convention for
          // "follow an employer" on job boards is a notification bell (Indeed,
          // LinkedIn's job-alert control), never the star/bookmark that means
          // "save this item" — which on THIS page is a different control with a
          // different verb, the Bookmark "Salva" in the header corner.
          <BellRing className="w-4 h-4" aria-hidden="true" />
        )}
        {following
          ? t('jobAlert.companyFollow.following', 'Stai seguendo questa azienda')
          : t('jobAlert.companyFollow.cta', 'Segui questa azienda')}
      </button>
      <p className="mt-2 text-[11px] text-muted">
        {following
          ? t('jobAlert.companyFollow.followingHint', 'Ti scriviamo quando pubblica un nuovo annuncio. Tocca per smettere di seguirla.')
          : t('jobAlert.companyFollow.hint', 'Ricevi una email quando questa azienda pubblica nuovi lavori.')}
      </p>
      {!following && (
        <EmailConsentCheckbox
          id="company-follow-signed-in-consent"
          locale={locale}
          consentKey="communicationsOptIn"
          className="mt-2 flex items-start gap-2 cursor-pointer"
          noticeClassName="text-[10px] text-muted leading-snug"
        />
      )}
      {following && (
        // Entry point to the dedicated manager (#5012 phase 2). Built through
        // buildPath, never a hardcoded /it|/en|… segment — that is what
        // scripts/ci/check-hardcoded-locale-segments.mjs guards.
        <a
          href={buildPath({ activeTab: 'followed-companies' }, locale)}
          className="mt-1 inline-block text-xs font-semibold text-accent hover:underline"
        >
          {t('jobAlert.companyFollow.manageAll')}
        </a>
      )}
      {status === 'error' && (
        <p className="mt-2 text-xs text-danger">
          {t('jobAlert.companyFollow.error', 'Non sono riuscito ad aggiornare il seguito. Riprova.')}
        </p>
      )}
    </div>
  );
}
