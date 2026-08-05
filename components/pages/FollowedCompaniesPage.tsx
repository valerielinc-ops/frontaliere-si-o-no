/**
 * "Le mie aziende seguite" — CompanyAlert manager (issue #5012 phase 2).
 *
 * The dedicated view the issue asks for. Phase 1 surfaced followed employers as
 * labelled rows inside the generic subscription list
 * (SubscriptionPreferencesController): you could unfollow, but there was no
 * page that answered "which companies am I following?" — and no destination for
 * the «Gestisci le aziende seguite» link the CompanyAlert email now carries.
 *
 * ── NO NEW FIRESTORE QUERY ────────────────────────────────────────────────
 * `listFollowedCompanies` filters `getUserAlerts()` in memory, reusing the
 * already-deployed (userId, active, createdAt desc) collectionGroup index.
 * `firestore.indexes.json` is NOT applied by CI (deploy-firestore-rules.yml
 * ships `firestore:rules` only), so a page that needed a new composite index
 * would merge green and then throw FAILED_PRECONDITION on its first real load.
 *
 * ── i18n ──────────────────────────────────────────────────────────────────
 * Local `STRINGS: Record<Locale, …>` rather than `t()` keys, matching
 * NewsletterPreferences.tsx. tests/i18n-completeness.test.ts scans
 * components/** for `t('key')` and requires the key in all four locale files;
 * a self-contained private page keeps its copy next to its markup and still
 * ships all four languages, which is the actual requirement.
 *
 * Private by omission, the site's convention for authed pages: no sitemap
 * entry, no `services/seo/seo-pages.ts` record, and deliberately absent from
 * `standalones` in tests/seo-completeness.test.ts. Same as
 * /preferenze-newsletter/ and /i-miei-annunci/.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Building2, Loader2, ArrowUpRight } from 'lucide-react';
import { getLocale } from '@/services/i18n';
import type { Locale } from '@/services/i18n';
import { useAuth } from '@/services/authService';
import { deleteAlert, listFollowedCompanies } from '@/services/jobAlertService';
import type { JobAlert } from '@/services/jobAlertService';
import { reportCaughtError } from '@/services/errorReporter';

interface PageStrings {
  title: string;
  intro: string;
  signedOut: string;
  empty: string;
  emptyHint: string;
  unfollow: string;
  viewJobs: string;
  immediateBadge: string;
  digestBadge: string;
  loadError: string;
}

const STRINGS: Record<Locale, PageStrings> = {
  it: {
    title: 'Le mie aziende seguite',
    intro: 'Ricevi una email appena una di queste aziende pubblica un nuovo annuncio.',
    signedOut: 'Accedi per vedere le aziende che segui.',
    empty: 'Non segui ancora nessuna azienda.',
    emptyHint: 'Apri un annuncio e tocca «Segui questa azienda» per iniziare.',
    unfollow: 'Smetti di seguire',
    viewJobs: 'Vedi tutte le offerte',
    immediateBadge: 'Avviso immediato',
    digestBadge: 'Nel riepilogo',
    loadError: 'Non sono riuscito a caricare le aziende seguite. Ricarica la pagina.',
  },
  en: {
    title: 'Companies I follow',
    intro: 'Get an email as soon as one of these companies posts a new job.',
    signedOut: 'Sign in to see the companies you follow.',
    empty: "You don't follow any company yet.",
    emptyHint: 'Open a job ad and tap "Follow this company" to start.',
    unfollow: 'Stop following',
    viewJobs: 'See all jobs',
    immediateBadge: 'Immediate alert',
    digestBadge: 'In the digest',
    loadError: "Couldn't load your followed companies. Reload the page.",
  },
  de: {
    title: 'Meine gefolgten Unternehmen',
    intro: 'Erhalte eine E-Mail, sobald eines dieser Unternehmen eine neue Stelle ausschreibt.',
    signedOut: 'Melde dich an, um deine gefolgten Unternehmen zu sehen.',
    empty: 'Du folgst noch keinem Unternehmen.',
    emptyHint: 'Öffne eine Anzeige und tippe auf «Diesem Unternehmen folgen».',
    unfollow: 'Nicht mehr folgen',
    viewJobs: 'Alle Stellen ansehen',
    immediateBadge: 'Sofortige Benachrichtigung',
    digestBadge: 'In der Übersicht',
    loadError: 'Gefolgte Unternehmen konnten nicht geladen werden. Bitte Seite neu laden.',
  },
  fr: {
    title: 'Mes entreprises suivies',
    intro: 'Recevez un e-mail dès qu\'une de ces entreprises publie une nouvelle offre.',
    signedOut: 'Connectez-vous pour voir les entreprises que vous suivez.',
    empty: 'Vous ne suivez encore aucune entreprise.',
    emptyHint: 'Ouvrez une annonce et touchez « Suivre cette entreprise » pour commencer.',
    unfollow: 'Ne plus suivre',
    viewJobs: 'Voir toutes les offres',
    immediateBadge: 'Alerte immédiate',
    digestBadge: 'Dans le récapitulatif',
    loadError: 'Impossible de charger vos entreprises suivies. Rechargez la page.',
  },
};

/**
 * Display name from the persisted slug. The alert stores only
 * `specificCompanyKey` (the canonical `/aziende/<slug>/` slug) — the display
 * name is not persisted, deliberately: storing it would create a second source
 * of truth for the employer's identity that could drift from the slug the
 * matcher compares, which is precisely the defect #5151 removed four copies of.
 * Title-casing the slug is lossy but honest and never disagrees with the link.
 */
export function companyLabelFromSlug(slug: string): string {
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * `/aziende/<slug>/` — ONE literal segment for every locale (see
 * services/companyAlertEmail.mjs and build-plugins/employerProfilePagesPlugin.ts).
 */
export function companyHubPath(slug: string, locale: Locale): string {
  const prefix = locale === 'it' ? '' : `/${locale}`;
  return `${prefix}/aziende/${encodeURIComponent(slug)}/`;
}

export const FollowedCompaniesPage: React.FC = () => {
  const locale = getLocale();
  const S = STRINGS[locale] || STRINGS.it;
  const { user, loading: authLoading } = useAuth();
  const [alerts, setAlerts] = useState<JobAlert[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!user?.uid) { setAlerts(null); return undefined; }
    listFollowedCompanies(user.uid)
      .then((rows) => { if (!cancelled) setAlerts(rows); })
      .catch((err) => {
        reportCaughtError(err, 'followedCompanies.load');
        if (!cancelled) { setAlerts([]); setError(S.loadError); }
      });
    return () => { cancelled = true; };
  }, [S.loadError, user?.uid]);

  const handleUnfollow = useCallback(async (alert: JobAlert) => {
    if (!alert.email) return;
    setBusyId(alert.id);
    try {
      // Same deactivation the follow button performs: active:false +
      // unsubscribed_at, not a pin-clear. A row left ACTIVE keeps producing
      // weak-intent matches from its stored sourceJobTitle — an unsubscribe
      // that keeps sending email is a GDPR problem (#5151).
      await deleteAlert(alert.email, alert.id);
      setAlerts((prev) => (prev || []).filter((a) => a.id !== alert.id));
    } catch (err) {
      reportCaughtError(err, 'followedCompanies.unfollow');
      setError(S.loadError);
    } finally {
      setBusyId(null);
    }
  }, [S.loadError]);

  if (authLoading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12 text-center">
        <Loader2 className="w-6 h-6 animate-spin mx-auto text-muted" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold font-display text-heading flex items-center gap-2">
        <Building2 className="w-6 h-6 text-accent" aria-hidden="true" />
        {S.title}
      </h1>
      <p className="mt-2 text-sm text-muted">{S.intro}</p>

      {!user?.uid && <p className="mt-8 text-sm text-body">{S.signedOut}</p>}

      {user?.uid && alerts === null && (
        <div className="mt-8 text-center">
          <Loader2 className="w-5 h-5 animate-spin mx-auto text-muted" aria-hidden="true" />
        </div>
      )}

      {error && <p className="mt-4 text-sm text-danger">{error}</p>}

      {user?.uid && alerts !== null && alerts.length === 0 && (
        <div className="mt-8 rounded-lg border border-edge bg-surface-raised px-4 py-6 text-center">
          <p className="text-sm font-semibold text-heading">{S.empty}</p>
          <p className="mt-1 text-xs text-muted">{S.emptyHint}</p>
        </div>
      )}

      {user?.uid && alerts !== null && alerts.length > 0 && (
        <ul className="mt-6 space-y-3">
          {alerts.map((alert) => {
            const slug = String(alert.specificCompanyKey || '');
            const busy = busyId === alert.id;
            return (
              <li key={alert.id} className="rounded-lg border border-edge bg-surface px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-heading truncate">{companyLabelFromSlug(slug)}</p>
                    <p className="mt-1 text-xs text-muted">
                      {alert.frequency === 'immediate' ? S.immediateBadge : S.digestBadge}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleUnfollow(alert)}
                    disabled={busy}
                    aria-busy={busy}
                    className="shrink-0 inline-flex items-center gap-2 px-3 py-2 min-h-[44px] text-xs font-semibold rounded-lg border border-edge text-body hover:bg-surface-raised disabled:opacity-60"
                  >
                    {busy && <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />}
                    {S.unfollow}
                  </button>
                </div>
                <a
                  href={companyHubPath(slug, locale)}
                  className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline"
                >
                  {S.viewJobs}
                  <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default FollowedCompaniesPage;
