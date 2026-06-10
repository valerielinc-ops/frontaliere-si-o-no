/**
 * PublisherDashboardPage — a publisher's own ads with per-ad metrics.
 *
 * Reads `publisher_jobs` where publisherUid == current user, then the matching
 * `publisher_job_events/{adId}` counters (views, apply-clicks) written by
 * services/publisherAnalyticsService.ts.
 */

import React, { useEffect, useState } from 'react';
import { Briefcase, LogIn, Plus, Eye, MousePointerClick, CreditCard, FileText, Pencil } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { useAuth } from '@/services/authService';
import { buildPath } from '@/services/router';
import { Analytics } from '@/services/analytics';
import { reportCaughtError } from '@/services/errorReporter';
import { getApp } from '@/services/firebase';
import type { PublisherJobStatus, PublisherTier } from '@/services/publisherTypes';

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

const BILLING_PORTAL_ENDPOINT =
  'https://europe-west6-frontaliere-ticino.cloudfunctions.net/createPublisherBillingPortal';

const PublisherDashboardPage: React.FC = () => {
  const { t, locale } = useTranslation();
  const { user, loading, signIn } = useAuth();
  const [rows, setRows] = useState<DashboardRow[]>([]);
  const [apps, setApps] = useState<ApplicationRow[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [billingBusy, setBillingBusy] = useState(false);

  useEffect(() => {
    Analytics.trackPageView('/i-miei-annunci', 'Publisher Dashboard');
  }, []);

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

        if (!cancelled) {
          setRows(result);
          setApps(appRows);
          setState('ready');
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
  const tierLabel = (tier: PublisherTier) =>
    tier === 'free' ? t('publisherDashboard.tier.free') : t('publisherDashboard.tier.sponsored');

  // "Renews in N days" — only for sponsored+paid ads with a future renewsAt.
  const renewalLabel = (r: DashboardRow): string | null => {
    if (r.tier !== 'sponsored' || r.status !== 'paid' || r.renewsAt == null) return null;
    const days = Math.ceil((r.renewsAt - Date.now()) / 86400000);
    if (days <= 0) return null;
    return t('publisherDashboard.renewsIn', { days });
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold font-display text-strong">{t('publisherDashboard.title')}</h1>
          <p className="text-subtle mt-1">{t('publisherDashboard.subtitle')}</p>
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          {rows.some((r) => r.tier === 'sponsored') && (
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

      {state === 'ready' && rows.length === 0 && (
        <div className="text-center py-12 space-y-3">
          <p className="text-subtle">{t('publisherDashboard.empty')}</p>
          <a
            href={buildPath({ activeTab: 'publish' }, locale)}
            className="inline-flex items-center gap-1.5 text-link font-medium hover:underline"
          >
            <Plus className="w-4 h-4" />
            {t('publisherDashboard.emptyCta')}
          </a>
        </div>
      )}

      {state === 'ready' && rows.length > 0 && (
        <>
          {/* Desktop table */}
          <div className="hidden sm:block overflow-x-auto rounded-2xl border border-edge">
            <table className="w-full text-sm">
              <thead className="bg-surface-alt text-subtle">
                <tr>
                  <th scope="col" className="text-left font-medium px-4 py-3">{t('publisherDashboard.col.title')}</th>
                  <th scope="col" className="text-left font-medium px-3 py-3">{t('publisherDashboard.col.tier')}</th>
                  <th scope="col" className="text-left font-medium px-3 py-3">{t('publisherDashboard.col.status')}</th>
                  <th scope="col" className="text-right font-medium px-3 py-3">{t('publisherDashboard.col.locations')}</th>
                  <th scope="col" className="text-right font-medium px-3 py-3">{t('publisherDashboard.col.views')}</th>
                  <th scope="col" className="text-right font-medium px-3 py-3">{t('publisherDashboard.col.applyClicks')}</th>
                  <th scope="col" className="text-right font-medium px-4 py-3">{t('publisherDashboard.col.applications')}</th>
                  <th scope="col" className="text-right font-medium px-4 py-3"><span className="sr-only">{t('publisherDashboard.edit')}</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-edge">
                    <td className="px-4 py-3 text-strong font-medium">{r.title}</td>
                    <td className="px-3 py-3 text-subtle">{tierLabel(r.tier)}</td>
                    <td className="px-3 py-3 text-subtle">
                      {statusLabel(r.status)}
                      {renewalLabel(r) && (
                        <span className="block text-xs text-muted mt-0.5">{renewalLabel(r)}</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right text-body">{r.locations}</td>
                    <td className="px-3 py-3 text-right text-body">{r.views}</td>
                    <td className="px-3 py-3 text-right text-body">{r.applyClicks}</td>
                    <td className="px-4 py-3 text-right text-body">{apps.filter((a) => a.jobId === r.id).length}</td>
                    <td className="px-4 py-3 text-right">
                      <a
                        href={`${buildPath({ activeTab: 'publish' }, locale)}?edit=${r.id}`}
                        className="inline-flex items-center gap-1 text-link hover:underline"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                        {t('publisherDashboard.edit')}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="sm:hidden space-y-3">
            {rows.map((r) => (
              <div key={r.id} className="rounded-2xl border border-edge bg-surface-alt p-4">
                <div className="font-semibold text-strong">{r.title}</div>
                <div className="text-xs text-subtle mt-1">
                  {tierLabel(r.tier)} · {statusLabel(r.status)} · {r.locations} {t('publisherDashboard.col.locations')}
                </div>
                {renewalLabel(r) && (
                  <div className="text-xs text-muted mt-1">{renewalLabel(r)}</div>
                )}
                <div className="flex gap-4 mt-3 text-sm text-body">
                  <span className="inline-flex items-center gap-1"><Eye className="w-4 h-4 text-subtle" />{r.views}</span>
                  <span className="inline-flex items-center gap-1"><MousePointerClick className="w-4 h-4 text-subtle" />{r.applyClicks}</span>
                  <span className="inline-flex items-center gap-1"><FileText className="w-4 h-4 text-subtle" />{apps.filter((a) => a.jobId === r.id).length}</span>
                </div>
                <a
                  href={`${buildPath({ activeTab: 'publish' }, locale)}?edit=${r.id}`}
                  className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-link hover:underline"
                >
                  <Pencil className="w-4 h-4" />
                  {t('publisherDashboard.edit')}
                </a>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Applications received (in-house / forward) */}
      {state === 'ready' && (
        <section className="mt-10">
          <h2 className="text-lg font-bold font-display text-strong mb-3">
            {t('publisherDashboard.applications.title')}
          </h2>
          {apps.length === 0 ? (
            <p className="text-sm text-subtle">{t('publisherDashboard.applications.empty')}</p>
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
                          <a href={a.cvUrl} target="_blank" rel="noopener noreferrer" className="text-link hover:underline">CV</a>
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
