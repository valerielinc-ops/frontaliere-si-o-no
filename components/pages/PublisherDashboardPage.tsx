/**
 * PublisherDashboardPage — a publisher's own ads with per-ad metrics, presented
 * as an engaging analytics dashboard:
 *  - an animated "performance" overview band (count-up KPIs + conversion rate),
 *  - per-ad cards with a real views→clicks→applications conversion funnel,
 *  - a gold "Sponsorizzato" tier identity and a best-performer crown.
 *
 * Reads `publisher_jobs` where publisherUid == current user, then the matching
 * `publisher_job_events/{adId}` counters (views, apply-clicks) written by
 * services/publisherAnalyticsService.ts. All aggregates/conversion rates are
 * derived client-side from data already loaded — no extra reads.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Briefcase,
  LogIn,
  Plus,
  Eye,
  MousePointerClick,
  CreditCard,
  FileText,
  Pencil,
  Star,
  Crown,
  TrendingUp,
  Inbox,
  Sparkles,
  Archive,
  RotateCcw,
  ExternalLink,
} from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { useAuth } from '@/services/authService';
import { buildPath } from '@/services/router';
import { CV_URL_ENDPOINT } from '@/services/publisherCvEndpoint';
import { Analytics } from '@/services/analytics';
import { reportCaughtError } from '@/services/errorReporter';
import { getApp } from '@/services/firebase';
import { useCountUp } from '@/hooks/useCountUp';
import type { PublisherJobStatus, PublisherTier } from '@/services/publisherTypes';
import { canArchive, canRestore, isLiveStatus } from '@/services/publisherTypes';

interface DashboardRow {
  id: string;
  title: string;
  tier: PublisherTier;
  status: PublisherJobStatus;
  locations: number;
  views: number;
  applyClicks: number;
  createdAt: number | null;
  renewsAt: number | null;
  publicUrl: string | null;
  projectedAt: number | null;
  contentEditedAt: number | null;
  pendingPaymentAt: number | null;
}

interface ApplicationRow {
  id: string;
  jobId: string;
  candidateName: string;
  candidateEmail: string;
  message: string | null;
  cvUrl: string | null;
  createdAt: number | null;
}

function tsToMillis(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    return (value as { toMillis: () => number }).toMillis();
  }
  return null;
}

// Company name → slug, identical algorithm to scripts/lib/employer-sectors.mjs
// slugify so the dashboard lookup key matches the employer_crawled_traffic doc id.
function slugifyCompanyName(s: string): string {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const BILLING_PORTAL_ENDPOINT =
  'https://europe-west6-frontaliere-ticino.cloudfunctions.net/createPublisherBillingPortal';
const ARCHIVE_ENDPOINT =
  'https://europe-west6-frontaliere-ticino.cloudfunctions.net/archivePublisherAd';
const RESTORE_ENDPOINT =
  'https://europe-west6-frontaliere-ticino.cloudfunctions.net/restorePublisherAd';
const CHECKOUT_ENDPOINT =
  'https://europe-west6-frontaliere-ticino.cloudfunctions.net/createPublisherCheckout';

/** A pasted public link is used as-is; an uploaded CV is a Storage object path
 *  (client-read-denied) that must be exchanged for a signed URL server-side. */
function isExternalCvLink(cvUrl: string): boolean {
  return /^https?:\/\//i.test(cvUrl);
}

// How long after a content edit the "changes pending publication (~1–2h)" hint
// stays visible. The slice sync (~hourly) + deploy propagates the edit within
// this window; past it the hint would be a stale, false claim, so it self-clears.
const MODIFIED_HINT_WINDOW_MS = 3 * 60 * 60 * 1000;

/** Status → semantic pill colours (same meaning everywhere). */
const STATUS_PILL: Record<PublisherJobStatus, string> = {
  draft: 'bg-neutral-subtle text-neutral border-neutral-border',
  pending_payment: 'bg-warning-subtle text-warning border-warning-border',
  paid: 'bg-success-subtle text-success border-success-border',
  published: 'bg-success-subtle text-success border-success-border',
  expired: 'bg-surface-raised text-muted border-edge',
  rejected: 'bg-danger-subtle text-danger border-danger-border',
  archived: 'bg-surface-raised text-muted border-edge',
};

/** A single count-up KPI used in the overview band. */
function CountUpValue({ value, active, decimals = 0 }: { value: number; active: boolean; decimals?: number }): React.ReactElement {
  const display = useCountUp(value, { active, decimals });
  return <>{display.toLocaleString('it-CH', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</>;
}

/**
 * Conversion funnel: views (100%) → apply clicks → applications, each bar
 * scaled to the ad's own views. Bars reveal with a transform (never width) so
 * the motion stays jank-free. Conveys real conversion, not decoration.
 */
function FunnelBar({
  icon,
  label,
  value,
  pct,
  tone,
  mounted,
  delayMs,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  pct: number;
  tone: string;
  mounted: boolean;
  delayMs: number;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-3">
      <span className="inline-flex items-center gap-1.5 text-xs text-subtle w-28 shrink-0">
        {icon}
        {label}
      </span>
      <div className="relative h-2.5 flex-1 rounded-full bg-surface-raised overflow-hidden">
        <div
          className={`absolute inset-y-0 left-0 rounded-full ${tone} origin-left transition-transform duration-700 ease-out w-[var(--bar-w)] [transform:var(--bar-sx)] [transition-delay:var(--bar-delay)]`}
          style={{
            ['--bar-w']: `${Math.max(pct, value > 0 ? 4 : 0)}%`,
            ['--bar-sx']: mounted ? 'scaleX(1)' : 'scaleX(0)',
            ['--bar-delay']: `${delayMs}ms`,
          } as React.CSSProperties}
        />
      </div>
      <span className="text-sm font-semibold tabular-nums text-strong w-12 text-right shrink-0">
        {value.toLocaleString('it-CH')}
      </span>
    </div>
  );
}

const PublisherDashboardPage: React.FC = () => {
  const { t, locale } = useTranslation();
  const { user, loading, signIn } = useAuth();
  const [rows, setRows] = useState<DashboardRow[]>([]);
  const [apps, setApps] = useState<ApplicationRow[]>([]);
  const [crawledCandidates, setCrawledCandidates] = useState(0);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [billingBusy, setBillingBusy] = useState(false);
  const [barsMounted, setBarsMounted] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [resumingCheckoutId, setResumingCheckoutId] = useState<string | null>(null);
  const [cvOpeningId, setCvOpeningId] = useState<string | null>(null);

  useEffect(() => {
    Analytics.trackPageView('/i-miei-annunci/', 'Publisher Dashboard');
  }, []);

  // Uploaded CVs live at a client-read-denied Storage path; exchange it for a
  // server-signed URL, then open it. Pasted public links open directly (handled
  // inline in the render via a plain anchor).
  const handleOpenCv = async (appId: string) => {
    if (!user || cvOpeningId) return;
    setCvOpeningId(appId);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(CV_URL_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ appId }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string };
      if (data.ok && data.url) window.open(data.url, '_blank', 'noopener,noreferrer');
      else reportCaughtError(new Error(`cv_url_failed:${res.status}`), 'publisherDashboard.openCv');
    } catch (error) {
      reportCaughtError(error, 'publisherDashboard.openCv');
    } finally {
      setCvOpeningId(null);
    }
  };

  const handleManageBilling = async () => {
    if (!user || billingBusy) return;
    setBillingBusy(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(BILLING_PORTAL_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ returnUrl: window.location.href }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string };
      if (data.ok && data.url) window.location.assign(data.url);
      else setBillingBusy(false);
    } catch {
      setBillingBusy(false);
    }
  };

  const handleArchive = async (jobId: string) => {
    if (!user || archivingId) return;
    if (typeof window !== 'undefined' && !window.confirm(t('publisherDashboard.archiveConfirm'))) return;
    setArchivingId(jobId);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(ARCHIVE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ jobId }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (!res.ok || !data.ok) throw new Error('archive_failed');
      // Reflect the new state locally without a full reload — the slice rebuild
      // (and removal from the live site) follows on the next publisher-jobs sync.
      setRows((prev) => prev.map((r) => (r.id === jobId ? { ...r, status: 'archived' } : r)));
      Analytics.trackUIInteraction('publisher', 'dashboard', 'archive', 'success');
    } catch (error) {
      reportCaughtError(error, 'publisherDashboard.archive');
      if (typeof window !== 'undefined') window.alert(t('publisherDashboard.archiveError'));
      Analytics.trackUIInteraction('publisher', 'dashboard', 'archive', 'error');
    } finally {
      setArchivingId(null);
    }
  };

  const handleRestore = async (jobId: string) => {
    if (!user || restoringId) return;
    setRestoringId(jobId);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(RESTORE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ jobId }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; status?: PublisherJobStatus };
      if (!res.ok || !data.ok || !data.status) throw new Error('restore_failed');
      // Reflect the resolved destination (paid / published / draft) returned by the CF.
      const next = data.status;
      setRows((prev) => prev.map((r) => (r.id === jobId ? { ...r, status: next } : r)));
      Analytics.trackUIInteraction('publisher', 'dashboard', 'restore', 'success');
    } catch (error) {
      reportCaughtError(error, 'publisherDashboard.restore');
      if (typeof window !== 'undefined') window.alert(t('publisherDashboard.restoreError'));
      Analytics.trackUIInteraction('publisher', 'dashboard', 'restore', 'error');
    } finally {
      setRestoringId(null);
    }
  };

  const handleResumeCheckout = async (jobId: string) => {
    if (!user || resumingCheckoutId) return;
    setResumingCheckoutId(jobId);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(CHECKOUT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          jobIds: [jobId],
          successUrl: `${window.location.origin}${window.location.pathname}`,
          cancelUrl: window.location.href,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string };
      if (data.ok && data.url) {
        window.location.assign(data.url);
      } else {
        if (typeof window !== 'undefined') window.alert(t('publisherDashboard.resumeCheckoutError'));
        setResumingCheckoutId(null);
      }
    } catch (error) {
      reportCaughtError(error, 'publisherDashboard.resumeCheckout');
      if (typeof window !== 'undefined') window.alert(t('publisherDashboard.resumeCheckoutError'));
      setResumingCheckoutId(null);
    }
  };

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setState('loading');
      try {
        const db = (await import('firebase/firestore')).getFirestore(await getApp());
        const { collection, query, where, orderBy, getDocs, getDoc, doc } = await import('firebase/firestore');

        let snap;
        try {
          snap = await getDocs(
            query(collection(db, 'publisher_jobs'), where('publisherUid', '==', user.uid), orderBy('createdAt', 'desc')),
          );
        } catch {
          // Missing composite index → fall back to unordered, sort client-side.
          snap = await getDocs(query(collection(db, 'publisher_jobs'), where('publisherUid', '==', user.uid)));
        }

        const result: DashboardRow[] = await Promise.all(
          snap.docs.map(async (d) => {
            const j = d.data() as Record<string, unknown>;
            let views = 0;
            let applyClicks = 0;
            try {
              const ev = await getDoc(doc(db, 'publisher_job_events', d.id));
              if (ev.exists()) {
                const e = ev.data() as Record<string, unknown>;
                views = Number(e.views) || 0;
                applyClicks = Number(e.applyClicks) || 0;
              }
            } catch {
              // counters optional
            }
            return {
              id: d.id,
              title: String(j.title || ''),
              tier: (j.tier as PublisherTier) || 'sponsored',
              status: (j.status as PublisherJobStatus) || 'draft',
              locations: Array.isArray(j.locations) ? j.locations.length : 0,
              views,
              applyClicks,
              createdAt: tsToMillis(j.createdAt),
              renewsAt: tsToMillis(j.renewsAt),
              publicUrl: typeof j.publicUrl === 'string' ? j.publicUrl : null,
              projectedAt: tsToMillis(j.projectedAt),
              contentEditedAt: tsToMillis(j.contentEditedAt),
              pendingPaymentAt: tsToMillis(j.pendingPaymentAt),
            };
          }),
        );
        result.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

        // Applications received (in-house/forward) — the publisher owns these by publisherUid.
        let appRows: ApplicationRow[] = [];
        try {
          const aSnap = await getDocs(query(collection(db, 'applications'), where('publisherUid', '==', user.uid)));
          appRows = aSnap.docs.map((d) => {
            const a = d.data() as Record<string, unknown>;
            return {
              id: d.id,
              jobId: String(a.jobId || ''),
              candidateName: String(a.candidateName || ''),
              candidateEmail: String(a.candidateEmail || ''),
              message: a.message ? String(a.message) : null,
              cvUrl: a.cvUrl ? String(a.cvUrl) : null,
              createdAt: tsToMillis(a.createdAt),
            };
          });
          appRows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        } catch {
          // applications optional / index building
        }

        // Crawled "free traffic" we already send this employer (proof + upsell):
        // Build candidate keys from all publisher job docs to handle naming variants
        // (e.g. publisher entered "Migros SA" but PostHog key is "migros"):
        //   1. company.companyKey (pre-computed slug from publisher profile)
        //   2. slugify(company.name) — full slug of the display name
        //   3. legal-suffix-stripped stem (strips -sa/-ag/-gmbh/… from the end)
        // All unique keys are fetched in parallel; candidates are deduplicated by
        // Firestore doc id before summing so the same doc is never counted twice.
        let crawledCandidates = 0;
        try {
          const candidateKeys = Array.from(new Set(
            snap.docs.flatMap((d) => {
              const co = (d.data() as Record<string, unknown>)?.company as { name?: string; companyKey?: string } | undefined;
              const keys: string[] = [];
              if (co?.companyKey) keys.push(String(co.companyKey));
              const slug = slugifyCompanyName(String(co?.name || ''));
              if (slug) {
                keys.push(slug);
                const stem = slug.replace(/-(sa|ag|gmbh|srl|sagl|ltd|spa|sas|snc|sapa)$/, '');
                if (stem !== slug) keys.push(stem);
              }
              return keys;
            }),
          )).filter(Boolean);

          if (candidateKeys.length) {
            const snapshots = await Promise.all(
              candidateKeys.map((key) => getDoc(doc(db, 'employer_crawled_traffic', key))),
            );
            const seen = new Set<string>();
            for (const ct of snapshots) {
              if (ct.exists() && !seen.has(ct.id)) {
                seen.add(ct.id);
                crawledCandidates += Number((ct.data() as Record<string, unknown>)?.candidates) || 0;
              }
            }
          }
        } catch {
          // optional — panel just stays hidden if no match / not yet populated
        }

        if (!cancelled) {
          setRows(result);
          setApps(appRows);
          setCrawledCandidates(crawledCandidates);
          setState('ready');
          // Defer two frames so the funnel bars animate from 0 on first paint.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => { if (!cancelled) setBarsMounted(true); }),
          );
        }
      } catch (error) {
        if (!cancelled) setState('error');
        reportCaughtError(error, 'publisherDashboard.load');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // ── Aggregates (derived client-side from already-loaded data) ──
  const appsByJob = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of apps) m.set(a.jobId, (m.get(a.jobId) ?? 0) + 1);
    return m;
  }, [apps]);

  const totals = useMemo(() => {
    const views = rows.reduce((s, r) => s + r.views, 0);
    const clicks = rows.reduce((s, r) => s + r.applyClicks, 0);
    const applications = apps.length;
    // Conversion = apply-clicks per 100 views (intent-to-apply rate), 1 decimal.
    const conversion = views > 0 ? Math.round((clicks / views) * 1000) / 10 : 0;
    return { views, clicks, applications, conversion };
  }, [rows, apps]);

  // Best performer = the ad with the most views (only worth crowning if >0 and
  // there's more than one ad to compare).
  const bestPerformerId = useMemo(() => {
    if (rows.length < 2) return null;
    const top = rows.reduce((best, r) => (r.views > best.views ? r : best), rows[0]);
    return top.views > 0 ? top.id : null;
  }, [rows]);

  // ── Auth gate ───────────────────────────────────────────────
  if (!loading && !user) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12">
        <div className="text-center space-y-4">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-accent-subtle mb-2">
            <Briefcase className="w-7 h-7 text-link" />
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold font-display text-strong">
            {t('publisherDashboard.title')}
          </h1>
          <p className="text-subtle max-w-md mx-auto">{t('publisher.loginRequired')}</p>
          <button
            type="button"
            onClick={() => { void signIn(); }}
            className="mt-2 inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-on-accent bg-accent hover:bg-accent-hover rounded-xl transition-colors"
          >
            <LogIn className="w-4 h-4" />
            {t('publisher.loginCta')}
          </button>
        </div>
      </div>
    );
  }

  const statusLabel = (s: PublisherJobStatus) => t(`publisherDashboard.status.${s}`);
  const isSponsored = (tier: PublisherTier) => tier === 'sponsored';
  const isAzienda = (tier: PublisherTier) => tier === 'azienda';

  // Pipeline-aware status for live-eligible ads. A paid/published ad reads
  // "In revisione" until the publisher-jobs sync has projected it into the slice
  // and triggered the deploy (publicUrl + projectedAt stamped by
  // build-publisher-jobs.mjs), then "Online" with a link to the live page.
  const isLiveEligible = (r: DashboardRow) => r.status === 'paid' || r.status === 'published';
  const displayStatus = (r: DashboardRow): string =>
    isLiveEligible(r)
      ? (r.projectedAt ? t('publisherDashboard.status.online') : t('publisherDashboard.status.review'))
      : statusLabel(r.status);
  // Show the live link once the ad is in the deployed slice. Deploy latency
  // (~1h) is disclosed so a freshly-projected link that 404s for a few minutes
  // doesn't read as broken.
  const liveLink = (r: DashboardRow): { url: string; soon: boolean } | null => {
    if (!isLiveEligible(r) || !r.projectedAt || !r.publicUrl) return null;
    const soon = Date.now() - r.projectedAt < 2 * 3600000;
    return { url: r.publicUrl, soon };
  };

  // "Renews in N days" — for sponsored and azienda paid ads with a future renewsAt.
  const renewalLabel = (r: DashboardRow): string | null => {
    if ((r.tier !== 'sponsored' && r.tier !== 'azienda') || r.status !== 'paid' || r.renewsAt == null) return null;
    const days = Math.ceil((r.renewsAt - Date.now()) / 86400000);
    if (days <= 0) return null;
    return t('publisherDashboard.renewsIn', { days });
  };

  // "Edits pending publication" — a content edit on a LIVE ad isn't visible on the
  // site until the next slice sync (~1–2h). Surfaces that the change is in-flight,
  // but ONLY within a recency window: `contentEditedAt` is stamped on every edit
  // and never cleared, so without this gate the "online entro 1–2 ore" claim would
  // stay (falsely) forever. After the window the edit has long since gone live.
  const modifiedLabel = (r: DashboardRow): string | null => {
    if (!isLiveStatus(r.status) || r.contentEditedAt == null) return null;
    if (Date.now() - r.contentEditedAt > MODIFIED_HINT_WINDOW_MS) return null;
    return t('publisherDashboard.modifiedPending');
  };

  // A draft that was previously in pending_payment (reaped by the stale-checkout
  // reaper) has pendingPaymentAt set. Offer a one-click re-checkout CTA.
  const isReapedDraft = (r: DashboardRow) => r.status === 'draft' && r.pendingPaymentAt != null;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-8">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold font-display text-strong">{t('publisherDashboard.title')}</h1>
          <p className="text-subtle mt-1">{t('publisherDashboard.subtitle')}</p>
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          {rows.some((r) => r.tier === 'sponsored' || r.tier === 'azienda') && (
            <button
              type="button"
              onClick={() => { void handleManageBilling(); }}
              disabled={billingBusy}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-medium text-link border border-edge rounded-xl hover:bg-surface-alt disabled:opacity-60 transition-colors"
            >
              <CreditCard className="w-4 h-4" />
              {t('publisherDashboard.manageBilling')}
            </button>
          )}
          <a
            href={buildPath({ activeTab: 'publish' }, locale)}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-on-accent bg-accent hover:bg-accent-hover rounded-xl transition-colors"
          >
            <Plus className="w-4 h-4" />
            {t('publisherDashboard.createCta')}
          </a>
        </div>
      </div>

      {state === 'loading' && (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-accent border-t-transparent" />
        </div>
      )}

      {state === 'error' && (
        <p className="text-sm text-danger py-8 text-center">{t('publisherDashboard.error')}</p>
      )}

      {/* ── Empty state — welcoming, not a dead end ──────────────── */}
      {state === 'ready' && rows.length === 0 && (
        <div className="rounded-3xl border border-dashed border-edge bg-surface-alt px-6 py-14 text-center animate-fade-in-up">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-accent-subtle text-link mb-4">
            <Inbox className="w-8 h-8" />
          </div>
          <h2 className="text-xl font-bold font-display text-strong mb-1.5">{t('publisherDashboard.empty.title')}</h2>
          <p className="text-subtle max-w-sm mx-auto mb-6">{t('publisherDashboard.empty.body')}</p>
          <a
            href={buildPath({ activeTab: 'publish' }, locale)}
            className="inline-flex items-center gap-1.5 px-5 py-2.5 text-sm font-semibold text-on-accent bg-accent hover:bg-accent-hover rounded-xl transition-colors no-underline"
          >
            <Plus className="w-4 h-4" />
            {t('publisherDashboard.emptyCta')}
          </a>
        </div>
      )}

      {state === 'ready' && rows.length > 0 && (
        <>
          {/* ── Performance overview (animated KPIs) ──────────────── */}
          <section aria-labelledby="dash-overview-heading" className="mb-8 animate-fade-in-up">
            <h2 id="dash-overview-heading" className="sr-only">{t('publisherDashboard.kpi.heading')}</h2>
            <div className="rounded-3xl border border-edge bg-surface-alt p-6 sm:p-7">
              <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-link mb-3">
                <TrendingUp className="w-3.5 h-3.5" />
                {t('publisherDashboard.kpi.eyebrow')}
              </p>
              {/* Hero metric: big, animated — the "wow" moment. */}
              <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
                <span className="text-5xl sm:text-6xl font-bold font-display text-strong tabular-nums leading-none">
                  <CountUpValue value={totals.views} active={state === 'ready'} />
                </span>
                <span className="text-base text-subtle pb-1.5">{t('publisherDashboard.kpi.totalViews')}</span>
              </div>
              {/* Supporting metrics — varied weight, not an identical grid. */}
              <div className="mt-6 grid grid-cols-3 gap-3">
                {[
                  { key: 'clicks', icon: <MousePointerClick className="w-4 h-4" />, value: totals.clicks, label: t('publisherDashboard.kpi.totalClicks'), suffix: '', decimals: 0 },
                  { key: 'apps', icon: <FileText className="w-4 h-4" />, value: totals.applications, label: t('publisherDashboard.kpi.totalApplications'), suffix: '', decimals: 0 },
                  { key: 'conv', icon: <TrendingUp className="w-4 h-4" />, value: totals.conversion, label: t('publisherDashboard.kpi.conversion'), suffix: '%', decimals: 1 },
                ].map((m) => (
                  <div key={m.key} className="rounded-2xl bg-surface p-4 border border-edge">
                    <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-accent-subtle text-link mb-2">
                      {m.icon}
                    </span>
                    <p className="text-2xl font-bold font-display text-strong tabular-nums leading-none">
                      <CountUpValue value={m.value} active={state === 'ready'} decimals={m.decimals} />{m.suffix}
                    </p>
                    <p className="text-xs text-subtle mt-1.5 leading-tight">{m.label}</p>
                  </div>
                ))}
              </div>
              {totals.views === 0 && (
                <p className="mt-4 text-xs text-muted">{t('publisherDashboard.kpi.noDataYet')}</p>
              )}
            </div>
          </section>

          {/* ── Crawled "free traffic we already send you" (proof + upsell) ── */}
          {crawledCandidates > 0 && (
            <section aria-labelledby="dash-crawled-heading" className="mb-8 animate-fade-in-up">
              <h2 id="dash-crawled-heading" className="sr-only">{t('publisherDashboard.crawled.heading')}</h2>
              <div className="rounded-3xl border border-edge bg-success-subtle p-6 sm:p-7">
                <div className="text-2xl font-extrabold font-display text-strong">
                  {crawledCandidates} {t('publisherDashboard.crawled.unit')}
                </div>
                <p className="mt-1 text-sm text-body">{t('publisherDashboard.crawled.desc')}</p>
              </div>
            </section>
          )}

          {/* ── Per-ad cards with conversion funnel ───────────────── */}
          <section aria-labelledby="dash-ads-heading">
            <h2 id="dash-ads-heading" className="text-lg font-bold font-display text-strong mb-4">
              {t('publisherDashboard.adsHeading')}
            </h2>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {rows.map((r, i) => {
                const applications = appsByJob.get(r.id) ?? 0;
                const clickPct = r.views > 0 ? (r.applyClicks / r.views) * 100 : 0;
                const appPct = r.views > 0 ? (applications / r.views) * 100 : 0;
                const sponsored = isSponsored(r.tier);
                const azienda = isAzienda(r.tier);
                const isBest = r.id === bestPerformerId;
                return (
                  <article
                    key={r.id}
                    className={`relative rounded-2xl border bg-surface p-5 animate-fade-in-up [animation-delay:var(--card-delay)] [animation-fill-mode:both] ${
                      sponsored ? 'border-warning-border' : azienda ? 'border-accent' : 'border-edge'
                    }`}
                    style={{ ['--card-delay']: `${Math.min(i * 60, 360)}ms` } as React.CSSProperties}
                  >
                    {isBest && (
                      <span className="absolute -top-2.5 right-4 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-warning text-on-accent shadow-sm">
                        <Crown className="w-3.5 h-3.5" />
                        {t('publisherDashboard.bestPerformer')}
                      </span>
                    )}
                    <h3 className="font-semibold text-strong leading-snug mb-3 pr-2">{r.title}</h3>
                    <div className="flex flex-wrap items-center gap-2 mb-4">
                      {sponsored ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-warning-subtle text-warning border border-warning-border">
                          <Star className="w-3 h-3 fill-warning" />
                          {t('publisherDashboard.tier.sponsored')}
                        </span>
                      ) : azienda ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-accent-subtle text-link border border-accent">
                          <Sparkles className="w-3 h-3" />
                          {t('publisherDashboard.tier.azienda')}
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-surface-raised text-subtle border border-edge">
                          {t('publisherDashboard.tier.free')}
                        </span>
                      )}
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_PILL[r.status]}`}>
                        {displayStatus(r)}
                      </span>
                      {liveLink(r) && (
                        <a
                          href={liveLink(r)!.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-link hover:underline"
                        >
                          <ExternalLink className="w-3 h-3" />
                          {t('publisherDashboard.viewLive')}
                        </a>
                      )}
                      <span className="text-xs text-muted">
                        {r.locations} {t('publisherDashboard.col.locations')}
                      </span>
                    </div>
                    {liveLink(r)?.soon && (
                      <p className="text-xs text-muted mb-3 -mt-2">{t('publisherDashboard.liveSoon')}</p>
                    )}
                    {modifiedLabel(r) && (
                      <p className="text-xs text-muted mb-3 -mt-2">{modifiedLabel(r)}</p>
                    )}

                    {/* Conversion funnel */}
                    <div className="space-y-2.5">
                      <FunnelBar
                        icon={<Eye className="w-3.5 h-3.5" />}
                        label={t('publisherDashboard.col.views')}
                        value={r.views}
                        pct={r.views > 0 ? 100 : 0}
                        tone="bg-accent"
                        mounted={barsMounted}
                        delayMs={i * 40}
                      />
                      <FunnelBar
                        icon={<MousePointerClick className="w-3.5 h-3.5" />}
                        label={t('publisherDashboard.col.applyClicks')}
                        value={r.applyClicks}
                        pct={clickPct}
                        tone="bg-info"
                        mounted={barsMounted}
                        delayMs={i * 40 + 80}
                      />
                      <FunnelBar
                        icon={<FileText className="w-3.5 h-3.5" />}
                        label={t('publisherDashboard.col.applications')}
                        value={applications}
                        pct={appPct}
                        tone="bg-success"
                        mounted={barsMounted}
                        delayMs={i * 40 + 160}
                      />
                    </div>

                    <div className="flex items-center justify-between gap-3 mt-4 pt-3 border-t border-edge">
                      <span className="text-xs text-muted">{renewalLabel(r) ?? ' '}</span>
                      <div className="flex items-center gap-3">
                        <a
                          href={`${buildPath({ activeTab: 'publish' }, locale)}?edit=${r.id}`}
                          className="inline-flex items-center gap-1 text-sm font-medium text-link hover:underline"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                          {t('publisherDashboard.edit')}
                        </a>
                        {canArchive(r.status) && (
                          <button
                            type="button"
                            onClick={() => { void handleArchive(r.id); }}
                            disabled={archivingId === r.id}
                            className="inline-flex items-center gap-1 text-sm font-medium text-subtle hover:text-danger disabled:opacity-60 transition-colors"
                          >
                            <Archive className="w-3.5 h-3.5" />
                            {t('publisherDashboard.archive')}
                          </button>
                        )}
                        {canRestore(r.status) && (
                          <button
                            type="button"
                            onClick={() => { void handleRestore(r.id); }}
                            disabled={restoringId === r.id}
                            className="inline-flex items-center gap-1 text-sm font-medium text-link hover:underline disabled:opacity-60 transition-colors"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            {t('publisherDashboard.restore')}
                          </button>
                        )}
                        {isReapedDraft(r) && (
                          <button
                            type="button"
                            onClick={() => { void handleResumeCheckout(r.id); }}
                            disabled={resumingCheckoutId === r.id}
                            className="inline-flex items-center gap-1 text-sm font-semibold text-on-accent bg-accent hover:bg-accent-hover px-3 py-1.5 rounded-lg disabled:opacity-60 transition-colors"
                          >
                            <CreditCard className="w-3.5 h-3.5" />
                            {t('publisherDashboard.resumeCheckout')}
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </>
      )}

      {/* Applications received (in-house / forward) */}
      {state === 'ready' && (
        <section className="mt-10">
          <h2 className="flex items-center gap-2 text-lg font-bold font-display text-strong mb-3">
            {t('publisherDashboard.applications.title')}
            {apps.length > 0 && (
              <span className="inline-flex items-center justify-center min-w-6 h-6 px-2 rounded-full text-xs font-semibold bg-accent-subtle text-link">
                {apps.length}
              </span>
            )}
          </h2>
          {apps.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-edge bg-surface-alt p-6 text-center">
              <Sparkles className="w-5 h-5 text-muted mx-auto mb-2" />
              <p className="text-sm text-subtle">{t('publisherDashboard.applications.empty')}</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {apps.map((a) => {
                const adTitle = rows.find((r) => r.id === a.jobId)?.title;
                return (
                  <li key={a.id} className="rounded-2xl border border-edge bg-surface-alt p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-semibold text-strong">{a.candidateName}</span>
                      {adTitle && <span className="text-xs text-muted">{adTitle}</span>}
                    </div>
                    <div className="mt-1 text-sm text-body">
                      <a href={`mailto:${a.candidateEmail}`} className="text-link hover:underline">{a.candidateEmail}</a>
                      {a.cvUrl && (
                        <>
                          {' · '}
                          {isExternalCvLink(a.cvUrl) ? (
                            <a href={a.cvUrl} target="_blank" rel="noopener noreferrer" className="text-link hover:underline">CV</a>
                          ) : (
                            <button
                              type="button"
                              onClick={() => { void handleOpenCv(a.id); }}
                              disabled={!!cvOpeningId}
                              className="text-link hover:underline disabled:opacity-60 disabled:cursor-wait"
                            >
                              {cvOpeningId === a.id ? '…' : 'CV'}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                    {a.message && <p className="mt-2 text-sm text-subtle whitespace-pre-line">{a.message}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
};

export default PublisherDashboardPage;
