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

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Building2, Loader2, ArrowUpRight } from 'lucide-react';
import { resolveCompanyLogoUrl } from '@/services/jobDataNormalization';
import { handleCompanyLogoError } from '@/services/logoService';
import { cdnImageUrl } from '@/services/cdnImageBase';
import {
  employerHubPath,
  employerOpenRolesLabel,
  fetchEmployerHubCounts,
} from '@/hooks/useEmployerHub';
import { getLocale } from '@/services/i18n';
import type { Locale } from '@/services/i18n';
import { useAuth } from '@/services/authService';
import { deleteAlert, listFollowedCompanies, updateAlert } from '@/services/jobAlertService';
import type { JobAlert, findCompanyAlert } from '@/services/jobAlertService';
import { rankEmployerSuggestions } from '@/services/employerSuggestions';
import CompanyFollowCta from '@/components/community/CompanyFollowCta';
import { reportCaughtError } from '@/services/errorReporter';

/**
 * The cadences a followed employer can carry, in escalating patience.
 *
 * `immediate` is the one CompanyAlert introduced and the only one routed to the
 * event-driven sender: `isImmediateCompanyAlert`
 * (scripts/lib/company-alert-routing.mjs) requires `frequency === 'immediate'`,
 * and scripts/send-job-alerts.mjs claims everything else. So picking `daily` or
 * `weekly` here is not a cosmetic preference — it hands the alert to the digest,
 * where this employer's new ads arrive grouped with the subscriber's other
 * alerts instead of in their own email. The copy under the control says so,
 * because a user who picks "weekly" and then waits for a dedicated email would
 * read the silence as the follow being broken.
 */
const CADENCES = ['immediate', 'daily', 'weekly'] as const;
type Cadence = (typeof CADENCES)[number];

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
  weeklyBadge: string;
  cadenceLabel: string;
  cadenceImmediate: string;
  cadenceDaily: string;
  cadenceWeekly: string;
  loadError: string;
  saveError: string;
  unfollowAll: string;
  unfollowAllConfirm: string;
  suggestTitle: string;
  /** Shown when the user already follows someone — the ranking had a seed. */
  suggestIntro: string;
  /** Cold start: nothing followed yet, so the order is activity and only activity. */
  suggestIntroCold: string;
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
    immediateBadge: 'Email appena pubblica un annuncio.',
    digestBadge: 'Nel riepilogo giornaliero, insieme agli altri avvisi.',
    weeklyBadge: 'Nel riepilogo settimanale, insieme agli altri avvisi.',
    cadenceLabel: 'Quando avvisarti',
    cadenceImmediate: 'Subito',
    cadenceDaily: 'Ogni giorno',
    cadenceWeekly: 'Ogni settimana',
    loadError: 'Non sono riuscito a caricare le aziende seguite. Ricarica la pagina.',
    saveError: 'Non sono riuscito a salvare la frequenza. Riprova.',
    unfollowAll: 'Smetti di seguire tutte',
    unfollowAllConfirm: 'Vuoi smettere di seguire tutte le aziende? Non riceverai piu\' queste email.',
    suggestTitle: 'Altre aziende da seguire',
    suggestIntro: 'Tra quelle che stanno assumendo di piu\' adesso, con la precedenza a chi somiglia alle aziende che gia\' segui.',
    suggestIntroCold: 'Le aziende che stanno assumendo di piu\' adesso. Seguine una e ti avvisiamo al suo prossimo annuncio.',
  },
  en: {
    title: 'Companies I follow',
    intro: 'Get an email as soon as one of these companies posts a new job.',
    signedOut: 'Sign in to see the companies you follow.',
    empty: "You don't follow any company yet.",
    emptyHint: 'Open a job ad and tap "Follow this company" to start.',
    unfollow: 'Stop following',
    viewJobs: 'See all jobs',
    immediateBadge: 'Emailed as soon as they post.',
    digestBadge: 'In the daily digest, alongside your other alerts.',
    weeklyBadge: 'In the weekly digest, alongside your other alerts.',
    cadenceLabel: 'When to notify you',
    cadenceImmediate: 'Right away',
    cadenceDaily: 'Daily',
    cadenceWeekly: 'Weekly',
    loadError: "Couldn't load your followed companies. Reload the page.",
    saveError: "Couldn't save the frequency. Please try again.",
    unfollowAll: 'Stop following all',
    unfollowAllConfirm: 'Stop following every company? You will no longer receive these emails.',
    suggestTitle: 'More companies to follow',
    suggestIntro: 'Among those hiring the most right now, preferring the ones closest to the companies you already follow.',
    suggestIntroCold: 'The companies hiring the most right now. Follow one and we email you their next job.',
  },
  de: {
    title: 'Meine gefolgten Unternehmen',
    intro: 'Erhalte eine E-Mail, sobald eines dieser Unternehmen eine neue Stelle ausschreibt.',
    signedOut: 'Melde dich an, um deine gefolgten Unternehmen zu sehen.',
    empty: 'Du folgst noch keinem Unternehmen.',
    emptyHint: 'Öffne eine Anzeige und tippe auf «Diesem Unternehmen folgen».',
    unfollow: 'Nicht mehr folgen',
    viewJobs: 'Alle Stellen ansehen',
    immediateBadge: 'E-Mail, sobald eine Stelle erscheint.',
    digestBadge: 'In der täglichen Übersicht, zusammen mit deinen anderen Alerts.',
    weeklyBadge: 'In der wöchentlichen Übersicht, zusammen mit deinen anderen Alerts.',
    cadenceLabel: 'Wann benachrichtigen',
    cadenceImmediate: 'Sofort',
    cadenceDaily: 'Täglich',
    cadenceWeekly: 'Wöchentlich',
    loadError: 'Gefolgte Unternehmen konnten nicht geladen werden. Bitte Seite neu laden.',
    saveError: 'Die Frequenz konnte nicht gespeichert werden. Bitte erneut versuchen.',
    unfollowAll: 'Allen nicht mehr folgen',
    unfollowAllConfirm: 'Allen Unternehmen nicht mehr folgen? Du erhaeltst diese E-Mails dann nicht mehr.',
    suggestTitle: 'Weitere Unternehmen zum Folgen',
    suggestIntro: 'Aus jenen mit den meisten offenen Stellen, bevorzugt solche, die deinen gefolgten Unternehmen ähneln.',
    suggestIntroCold: 'Die Unternehmen mit den meisten offenen Stellen. Folge einem und du bekommst eine E-Mail zur nächsten Anzeige.',
  },
  fr: {
    title: 'Mes entreprises suivies',
    intro: 'Recevez un e-mail dès qu\'une de ces entreprises publie une nouvelle offre.',
    signedOut: 'Connectez-vous pour voir les entreprises que vous suivez.',
    empty: 'Vous ne suivez encore aucune entreprise.',
    emptyHint: 'Ouvrez une annonce et touchez « Suivre cette entreprise » pour commencer.',
    unfollow: 'Ne plus suivre',
    viewJobs: 'Voir toutes les offres',
    immediateBadge: 'E-mail dès la publication d\'une offre.',
    digestBadge: 'Dans le récapitulatif quotidien, avec vos autres alertes.',
    weeklyBadge: 'Dans le récapitulatif hebdomadaire, avec vos autres alertes.',
    cadenceLabel: 'Quand vous prévenir',
    cadenceImmediate: 'Tout de suite',
    cadenceDaily: 'Chaque jour',
    cadenceWeekly: 'Chaque semaine',
    loadError: 'Impossible de charger vos entreprises suivies. Rechargez la page.',
    saveError: 'Impossible d\'enregistrer la fréquence. Réessayez.',
    unfollowAll: 'Ne plus suivre aucune',
    unfollowAllConfirm: 'Ne plus suivre aucune entreprise ? Vous ne recevrez plus ces e-mails.',
    suggestTitle: 'D\'autres entreprises à suivre',
    suggestIntro: 'Parmi celles qui recrutent le plus en ce moment, en privilégiant celles proches des entreprises que vous suivez déjà.',
    suggestIntroCold: 'Les entreprises qui recrutent le plus en ce moment. Suivez-en une et nous vous écrirons à sa prochaine offre.',
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
 * Segmented cadence picker for one followed employer.
 *
 * A local control rather than the `FrequencyToggle` inside
 * SubscriptionPreferencesController: that one is a two-value daily/weekly
 * switch bound to that file's `SectionStrings`, and CompanyAlert's whole point
 * is the THIRD value it does not model (`immediate`). Widening it would have
 * changed the generic-alert editor's UI for a page it does not serve.
 */
const CadenceToggle: React.FC<{
  value: Cadence;
  labels: Record<Cadence, string>;
  groupLabel: string;
  busy: boolean;
  onChange: (next: Cadence) => void;
}> = ({ value, labels, groupLabel, busy, onChange }) => (
  <div
    role="group"
    aria-label={groupLabel}
    className="mt-2 flex w-full flex-wrap overflow-hidden rounded-lg border border-edge bg-surface"
  >
    {CADENCES.map((c) => (
      <button
        key={c}
        type="button"
        onClick={() => c !== value && onChange(c)}
        disabled={busy}
        aria-pressed={c === value}
        className={`flex-1 min-w-[86px] px-3 py-2 min-h-[44px] text-xs font-bold transition-colors ${
          c === value ? 'bg-accent text-on-accent' : 'text-body hover:bg-surface-alt'
        } ${busy ? 'opacity-60 cursor-wait' : ''}`}
      >
        {labels[c]}
      </button>
    ))}
  </div>
);

/**
 * The follow-state lookup handed to every SUGGESTION CTA.
 *
 * `CompanyFollowButton` normally resolves "am I already following this?" by
 * calling `findCompanyAlert`, which runs an uncached `getUserAlerts`
 * collectionGroup query — once per mounted button. On this page that would be
 * up to five extra round-trips for an answer the page already holds: the
 * suggestions ARE `rankEmployerSuggestions(...)` minus everything in `alerts`,
 * so "not followed" is not a guess, it is the filter that produced the list.
 * That is the same in-memory-over-second-query rule `listFollowedCompanies`
 * and `findCompanyAlert` are both written to (see their comments): the page
 * reads the alert list once and everything else derives from it.
 *
 * Module-level, therefore referentially stable for the life of the page. It
 * lands in the button's lookup effect dependency array, so a closure recreated
 * on every render would re-run that effect and flip a button the reader had
 * just turned into "following" back to "follow".
 *
 * The accepted cost: if the same employer got followed in ANOTHER tab since
 * this page loaded, its card here still offers "follow" and a second tap would
 * write a duplicate alert. The stale list is what put the card on screen in the
 * first place, so the query would only have masked a wrong suggestion, not
 * prevented it — and the page's own reload is the fix for both.
 */
const notFollowedByConstruction: typeof findCompanyAlert = async () => null;

export const FollowedCompaniesPage: React.FC = () => {
  const locale = getLocale();
  const S = STRINGS[locale] || STRINGS.it;
  const { user, loading: authLoading } = useAuth();
  const [alerts, setAlerts] = useState<JobAlert[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cadenceBusyId, setCadenceBusyId] = useState<string | null>(null);
  /**
   * slug → active openings, from the slim map employerProfilePagesPlugin emits
   * (dist/data/employer-job-counts.json, ~20 KB, `max-age=600` at the edge).
   *
   * Best-effort and deliberately un-awaited by the list: the page's job is to
   * show WHICH employers you follow and let you change or drop them, and none
   * of that may wait on — or break with — a decorative count. A failed fetch
   * leaves the rows without the line, nothing else.
   */
  const [jobCounts, setJobCounts] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    let cancelled = false;
    // `fetchEmployerHubCounts` is the ONE reader of that map (hooks/useEmployerHub.ts),
    // module-cached: the job-detail surfaces that link the hub already warmed it,
    // so arriving here from a CompanyAlert email usually costs no request at all.
    fetchEmployerHubCounts()
      .then((data) => { if (!cancelled && data) setJobCounts(data); })
      .catch(() => { /* decorative — a missing count is not an error state */ });
    return () => { cancelled = true; };
  }, []);

  /**
   * «Altre aziende da seguire» (#5012 fase 3) — derived, never fetched.
   *
   * Both inputs are already on this page: `jobCounts` is the published
   * slug → active-ads map the rows above use for their «N annunci attivi»
   * line, and `alerts` is the list the page loaded to render itself. So the
   * suggestion block adds ZERO requests and cannot delay, block or fail the
   * list — which matters here more than anywhere else on the site, because
   * this page is also how people get OUT of these emails. Every uncertain
   * state (map in flight, fetch failed, nothing left to suggest) resolves to
   * an empty array and the section is simply not rendered.
   *
   * The ranking itself, and the honest account of how poor its input is, live
   * in services/employerSuggestions.ts.
   */
  const followedSlugs = useMemo(
    () => (alerts || []).map((a) => String(a.specificCompanyKey || '')).filter(Boolean),
    [alerts],
  );
  const suggestions = useMemo(
    () => rankEmployerSuggestions(jobCounts, followedSlugs),
    [jobCounts, followedSlugs],
  );

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

  const handleCadence = useCallback(async (alert: JobAlert, next: Cadence) => {
    if (!alert.email) return;
    const previous = (alert.frequency || 'immediate') as Cadence;
    if (previous === next) return;
    setCadenceBusyId(alert.id);
    setError('');
    // Optimistic: the row is the only reader of this value and the write is a
    // single field, so showing the new cadence immediately and rolling back on
    // failure beats a spinner that blocks the other rows.
    setAlerts((prev) => (prev || []).map((a) => (a.id === alert.id ? { ...a, frequency: next } : a)));
    try {
      // `frequencyOverride: true` for the same reason JobAlertForm's picker
      // sets it: an explicit choice must survive the adaptive-cadence engine,
      // which would otherwise be free to move this alert back on its own and
      // make the control look like it silently forgot the setting.
      await updateAlert(alert.email, alert.id, { frequency: next, frequencyOverride: true });
    } catch (err) {
      reportCaughtError(err, 'followedCompanies.cadence');
      setAlerts((prev) => (prev || []).map((a) => (a.id === alert.id ? { ...a, frequency: previous } : a)));
      setError(S.saveError);
    } finally {
      setCadenceBusyId(null);
    }
  }, [S.saveError]);

  const [bulkBusy, setBulkBusy] = useState(false);
  const handleUnfollowAll = useCallback(async () => {
    const rows = alerts || [];
    if (!rows.length) return;
    // eslint-disable-next-line no-alert -- one destructive, irreversible action;
    // the site has no confirm-dialog primitive and silently dropping every
    // follow on a mis-tap is worse than a native prompt.
    if (typeof window !== 'undefined' && !window.confirm(S.unfollowAllConfirm)) return;
    setBulkBusy(true);
    setError('');
    // Sequential, not Promise.all: each row is its own Firestore write and a
    // partial failure must leave the rows it did not reach untouched AND still
    // visible — a parallel burst that half-fails would render a list that
    // disagrees with the backend in both directions.
    const failed: JobAlert[] = [];
    for (const alert of rows) {
      if (!alert.email) { failed.push(alert); continue; }
      try {
        await deleteAlert(alert.email, alert.id);
      } catch (err) {
        reportCaughtError(err, 'followedCompanies.unfollowAll');
        failed.push(alert);
      }
    }
    setAlerts(failed);
    if (failed.length) setError(S.loadError);
    setBulkBusy(false);
  }, [S.loadError, S.unfollowAllConfirm, alerts]);

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

      {user?.uid && alerts !== null && alerts.length > 1 && (
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={() => void handleUnfollowAll()}
            disabled={bulkBusy}
            aria-busy={bulkBusy}
            className="inline-flex items-center gap-2 px-3 py-2 min-h-[44px] text-xs font-semibold rounded-lg border border-edge text-muted hover:bg-surface-raised hover:text-body disabled:opacity-60"
          >
            {bulkBusy && <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />}
            {S.unfollowAll}
          </button>
        </div>
      )}

      {user?.uid && alerts !== null && alerts.length > 0 && (
        <ul className="mt-3 space-y-3">
          {alerts.map((alert) => {
            const slug = String(alert.specificCompanyKey || '');
            const busy = busyId === alert.id;
            const cadenceBusy = cadenceBusyId === alert.id;
            // Anything not explicitly daily/weekly is the CompanyAlert default.
            // Never fall back to 'daily' on an unknown value: that would render
            // a row claiming the digest owns an alert the immediate sender is
            // in fact still sending.
            // The alert stores only the slug, so the logo is resolved from it
            // through the SAME map the job cards use — `companyKey` first, then
            // the display name. No new data source, no second normalisation.
            const logoUrl = cdnImageUrl(
              resolveCompanyLogoUrl({ company: companyLabelFromSlug(slug), companyKey: slug }),
            );
            const cadence: Cadence =
              alert.frequency === 'daily' || alert.frequency === 'weekly' ? alert.frequency : 'immediate';
            return (
              <li key={alert.id} className="rounded-lg border border-edge bg-surface px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      {logoUrl ? (
                        <img
                          src={logoUrl}
                          alt=""
                          width={24}
                          height={24}
                          loading="lazy"
                          onError={handleCompanyLogoError}
                          className="w-6 h-6 rounded object-contain bg-surface-alt shrink-0"
                        />
                      ) : (
                        <Building2 className="w-5 h-5 text-muted shrink-0" aria-hidden="true" />
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-heading truncate">{companyLabelFromSlug(slug)}</p>
                        {typeof jobCounts?.[slug] === 'number' && (
                          <p className="text-xs text-muted">{employerOpenRolesLabel(jobCounts[slug], locale)}</p>
                        )}
                      </div>
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      {cadence === 'immediate' ? S.immediateBadge : cadence === 'daily' ? S.digestBadge : S.weeklyBadge}
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
                <CadenceToggle
                  value={cadence}
                  groupLabel={`${S.cadenceLabel} — ${companyLabelFromSlug(slug)}`}
                  labels={{
                    immediate: S.cadenceImmediate,
                    daily: S.cadenceDaily,
                    weekly: S.cadenceWeekly,
                  }}
                  busy={cadenceBusy || busy}
                  onChange={(next) => void handleCadence(alert, next)}
                />
                {/* Same membership test the rest of this feature uses: the counts
                    map is written by the emitter and contains ONLY slugs that got
                    a page, so a hit proves the destination exists. Unconditional,
                    this link could point at an employer that has since dropped out
                    of the corpus — and «un conteggio che punta a un 404 è peggio di
                    nessun conteggio» has to hold for the link too, not just for the
                    number next to it. While the map is in flight (`null`) the link
                    is shown: it was the status quo for months, and hiding it on
                    every load would be a worse regression than the rare 404. */}
                {(jobCounts === null || typeof jobCounts[slug] === 'number') && (
                  <a
                    href={employerHubPath(slug, locale)}
                    className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline"
                  >
                    {S.viewJobs}
                    <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/*
        Suggestions sit BELOW everything, including the empty state — and the
        empty state is the case they exist for. Someone who follows nothing is
        one tap from the whole feature and currently gets only «apri un annuncio
        e tocca Segui», which sends them away from the page to do it. Someone
        who already follows four employers is being offered a fifth, which is
        worth less and must never come before the controls for the four.

        Signed-in only. Signed out, the followed set is unknown, so every card
        could be an employer the reader already follows — «segui X» shown to
        someone who follows X is a broken promise — and this page's signed-out
        state is usually the split second before the CompanyAlert email's
        autologin resolves, where a block appearing and rearranging is noise.
      */}
      {user?.uid && alerts !== null && suggestions.length > 0 && (
        <section className="mt-10 border-t border-edge pt-6" aria-labelledby="suggested-companies-title">
          <h2 id="suggested-companies-title" className="text-lg font-bold font-display text-heading">
            {S.suggestTitle}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {alerts.length === 0 ? S.suggestIntroCold : S.suggestIntro}
          </p>
          <ul className="mt-3 space-y-3">
            {suggestions.map((suggestion) => {
              // Same derivation as the followed rows above: the display name is
              // title-cased from the slug and the logo resolved through the map
              // the job cards use. Nothing here knows a second name for an
              // employer, which is what keeps the token this card writes
              // (`companyAlertKey(label, slug)`) equal to the slug it was
              // ranked under — pinned by tests/employer-suggestions.test.ts.
              const label = companyLabelFromSlug(suggestion.slug);
              const logoUrl = cdnImageUrl(
                resolveCompanyLogoUrl({ company: label, companyKey: suggestion.slug }),
              );
              return (
                <li key={suggestion.slug} className="rounded-lg border border-edge bg-surface px-4 py-3">
                  <div className="flex items-center gap-2 min-w-0">
                    {logoUrl ? (
                      <img
                        src={logoUrl}
                        alt=""
                        width={24}
                        height={24}
                        loading="lazy"
                        onError={handleCompanyLogoError}
                        className="w-6 h-6 rounded object-contain bg-surface-alt shrink-0"
                      />
                    ) : (
                      <Building2 className="w-5 h-5 text-muted shrink-0" aria-hidden="true" />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-heading truncate">{label}</p>
                      {/* Always present, unlike on the rows above: a suggestion
                          only exists because the map gave it a count at or above
                          MIN_ACTIVE_JOBS, and that count is the entire reason it
                          is being suggested. Showing it is showing the criterion. */}
                      <p className="text-xs text-muted">
                        {employerOpenRolesLabel(suggestion.activeJobs, locale)}
                      </p>
                    </div>
                  </div>
                  {/* The ONE follow interaction (components/community/CompanyFollowCta.tsx),
                      under its own analytics surface: this is the only place on
                      the site where the employer was chosen by us, so its
                      conversion is the only read we get on whether the ranking
                      is worth anything. */}
                  <div className="mt-2">
                    <CompanyFollowCta
                      company={label}
                      companyKey={suggestion.slug}
                      locale={locale}
                      surface="company_follow_suggestion"
                      userId={user.uid}
                      email={user.email ?? null}
                      lookupAlert={notFollowedByConstruction}
                    />
                  </div>
                  {/* Safe to link unconditionally, exactly like the rows above:
                      the floor in rankEmployerSuggestions is MIN_ACTIVE_JOBS, so
                      a suggested employer always has a full, emitted
                      `/aziende/<slug>/` page rather than a noindex bridge or the
                      blank-page chain an un-emitted one produces. */}
                  <a
                    href={employerHubPath(suggestion.slug, locale)}
                    className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline"
                  >
                    {S.viewJobs}
                    <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
};

export default FollowedCompaniesPage;
