import { useCallback, useEffect, useState } from 'react';
import { Building2, Check, Loader2 } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import type { Locale } from '@/services/i18n';
import {
  companyAlertKey,
  findCompanyAlert,
  subscribeCompanyAlert,
  updateAlert,
} from '@/services/jobAlertService';

export type CompanyFollowButtonStatus = 'idle' | 'loading' | 'submitting' | 'following' | 'error';

export interface CompanyFollowButtonProps {
  /** Employer display name (`job.company`). */
  company: string;
  /** Optional crawler company key (`job.companyKey`) — improves canonicalisation. */
  companyKey?: string | null;
  /** Authenticated user id. */
  userId: string;
  /** Authenticated user email. */
  email: string;
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
  /** Called when a write throws. */
  onErrored?: (error: unknown) => void;
  /** Test seams. */
  lookup?: typeof findCompanyAlert;
  subscribe?: typeof subscribeCompanyAlert;
  unfollow?: typeof updateAlert;
}

/**
 * "Segui questa azienda" — CompanyAlert subscribe/unsubscribe (issue #5012).
 *
 * Pins a job alert to one employer via `specificCompanyKey`, the filter the
 * matcher (services/jobAlertMatching.mjs) has always supported as a hard scope.
 * The persisted token is `companyAlertKey()` — the canonical `/aziende/<slug>/`
 * slug, the ONE normalisation shared with the matcher.
 *
 * Unfollow clears the pin rather than soft-deleting the alert doc, so the user
 * keeps a single alert row they can re-target — and, more importantly, the
 * follow state is always readable back (`findCompanyAlert`), which is what makes
 * the subscription manageable at all (GDPR: the user must be able to withdraw).
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
  onErrored,
  lookup = findCompanyAlert,
  subscribe = subscribeCompanyAlert,
  unfollow = updateAlert,
}: CompanyFollowButtonProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CompanyFollowButtonStatus>('loading');
  const [alertId, setAlertId] = useState<string | null>(null);

  const slug = companyAlertKey(company, companyKey || undefined);

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
    setStatus('submitting');
    try {
      const created = await subscribe(userId, email, { name: company, companyKey }, locale, {
        slug: sourceJobSlug ?? null,
        url: sourceJobUrl ?? null,
        title: sourceJobTitle ?? null,
      });
      setAlertId(created.id);
      setStatus('following');
      if (onSubscribed) onSubscribed();
    } catch (error: unknown) {
      setStatus('error');
      if (onErrored) onErrored(error);
    }
  }, [company, companyKey, email, locale, onErrored, onSubscribed, slug, sourceJobSlug, sourceJobTitle, sourceJobUrl, subscribe, userId]);

  const handleUnfollow = useCallback(async () => {
    if (!alertId) return;
    setStatus('submitting');
    try {
      await unfollow(email, alertId, { specificCompanyKey: null });
      setAlertId(null);
      setStatus('idle');
      if (onUnsubscribed) onUnsubscribed();
    } catch (error: unknown) {
      setStatus('error');
      if (onErrored) onErrored(error);
    }
  }, [alertId, email, onErrored, onUnsubscribed, unfollow]);

  if (!slug || !userId || !email) return null;
  if (status === 'loading') return null;

  const busy = status === 'submitting';
  const following = status === 'following';

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
          <Building2 className="w-4 h-4" aria-hidden="true" />
        )}
        {following
          ? t('jobAlert.companyFollow.following', 'Stai seguendo questa azienda')
          : t('jobAlert.companyFollow.cta', 'Segui questa azienda')}
      </button>
      <p className="mt-2 text-xs text-muted">
        {following
          ? t('jobAlert.companyFollow.followingHint', 'Ti scriviamo quando pubblica un nuovo annuncio. Tocca per smettere di seguirla.')
          : t('jobAlert.companyFollow.hint', 'Ricevi una email quando questa azienda pubblica nuovi lavori.')}
      </p>
      {status === 'error' && (
        <p className="mt-2 text-xs text-danger">
          {t('jobAlert.companyFollow.error', 'Non sono riuscito ad aggiornare il seguito. Riprova.')}
        </p>
      )}
    </div>
  );
}
