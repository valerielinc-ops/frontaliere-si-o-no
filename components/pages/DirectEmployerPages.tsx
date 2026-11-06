import React, { useEffect, useState } from 'react';
import { ArrowUpRight, CheckCircle2, ExternalLink, Printer, Store, TriangleAlert } from 'lucide-react';
import { useTranslation, loadNamespaceTranslations } from '@/services/i18n';
import { TranslationNamespaceGate } from '@/components/shared/TranslationNamespaceGate';
import { buildPath } from '@/services/router';
import { isDirectEmployerChannelEnabled, loadPermanentEmployers, markPermanentEmployer, type PermanentEmployer } from '@/services/directEmployerChannel';
import { normalizeEmployerOrigin } from '@/services/employerChannelOrigin.mjs';

function sourceParam(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('origin') || '';
}

function PageFrame({ children, eyebrow, title, intro }: { children: React.ReactNode; eyebrow: string; title: string; intro: string }) {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">{eyebrow}</p>
        <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-heading sm:text-4xl">{title}</h1>
        <p className="mt-4 text-base leading-7 text-body">{intro}</p>
      </header>
      <div className="mt-8">{children}</div>
    </div>
  );
}

function StatusNotice({ tone, children }: { tone: 'success' | 'danger' | 'warning'; children: React.ReactNode }) {
  const styles = tone === 'success'
    ? 'border-success-border bg-success-subtle text-success'
    : tone === 'danger'
      ? 'border-danger-border bg-danger-subtle text-danger'
      : 'border-warning-border bg-warning-subtle text-warning';
  return <div role="status" className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm leading-6 ${styles}`}>{tone === 'success' ? <CheckCircle2 size={18} aria-hidden="true" /> : <TriangleAlert size={18} aria-hidden="true" />}<span>{children}</span></div>;
}

function Field({ label, id, hint, children }: { label: string; id: string; hint?: string; children: React.ReactNode }) {
  return <label htmlFor={id} className="block text-sm font-medium text-strong"><span>{label}</span>{hint && <span className="mt-1 block text-xs font-normal leading-5 text-subtle">{hint}</span>}{children}</label>;
}

const inputClass = 'mt-2 min-h-11 w-full rounded-xl border border-edge bg-surface px-3.5 py-2.5 text-base text-strong shadow-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/30';

function PermanentEmployerMarkForm() {
  const { t } = useTranslation();
  const [companyName, setCompanyName] = useState('');
  const [website, setWebsite] = useState('');
  const [locationLabel, setLocationLabel] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const result = await markPermanentEmployer({ companyName, website, locationLabel });
      setMessage(result.ok ? t('directEmployer.permanentSubmitted') : t('directEmployer.permanentSubmitError'));
    } catch {
      setMessage(t('directEmployer.permanentSubmitError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-edge bg-surface p-4 shadow-sm sm:p-6">
      <h2 className="font-display text-xl font-semibold text-heading">{t('directEmployer.permanentMarkTitle')}</h2>
      <p className="mt-2 text-sm leading-6 text-subtle">{t('directEmployer.permanentMarkIntro')}</p>
      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <Field id="permanent-company" label={t('directEmployer.companyName')}><input id="permanent-company" className={inputClass} value={companyName} onChange={(event) => setCompanyName(event.target.value)} required /></Field>
        <Field id="permanent-website" label={t('directEmployer.website')}><input id="permanent-website" className={inputClass} value={website} onChange={(event) => setWebsite(event.target.value)} type="url" placeholder="https://" required /></Field>
        <Field id="permanent-location" label={t('directEmployer.location')} hint={t('directEmployer.optional')}><input id="permanent-location" className={inputClass} value={locationLabel} onChange={(event) => setLocationLabel(event.target.value)} /></Field>
      </div>
      {message && <p className="mt-4 text-sm text-body" role="status">{message}</p>}
      <button type="submit" disabled={busy} className="mt-5 min-h-11 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent disabled:opacity-60">{busy ? t('directEmployer.submitting') : t('directEmployer.permanentMarkSubmit')}</button>
    </form>
  );
}

function PermanentEmployersContent() {
  const { t } = useTranslation();
  const [employers, setEmployers] = useState<PermanentEmployer[]>([]);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    void loadPermanentEmployers()
      .then((result) => {
        if (!mounted) return;
        setEmployers(result.employers);
        setEnabled(result.enabled);
      })
      .catch(() => { if (mounted) setEnabled(false); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);

  return (
    <PageFrame eyebrow={t('directEmployer.permanentEyebrow')} title={t('directEmployer.permanentTitle')} intro={t('directEmployer.permanentIntro')}>
      <div className="rounded-xl border border-warning-border bg-warning-subtle px-4 py-3 text-sm leading-6 text-warning">{t('directEmployer.permanentDisclaimer')}</div>
      {loading ? <p className="mt-6 text-sm text-subtle" role="status">{t('directEmployer.loading')}</p> : enabled !== true ? <div className="mt-6"><StatusNotice tone="warning">{t('directEmployer.disabled')}</StatusNotice></div> : employers.length === 0 ? <p className="mt-6 rounded-2xl border border-edge bg-surface p-5 text-sm text-subtle">{t('directEmployer.permanentEmpty')}</p> : <ul className="mt-6 grid gap-4 sm:grid-cols-2" aria-label={t('directEmployer.permanentListLabel')}>{employers.map((employer) => <li key={employer.id} className="rounded-2xl border border-edge bg-surface p-5 shadow-sm"><div className="flex items-start justify-between gap-3"><div><h2 className="font-display text-lg font-semibold text-heading">{employer.companyName}</h2>{employer.locationLabel && <p className="mt-1 text-sm text-subtle">{employer.locationLabel}</p>}</div><Store size={20} className="shrink-0 text-accent" aria-hidden="true" /></div><a className="mt-4 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-accent underline-offset-4 hover:underline" href={employer.website} target="_blank" rel="noreferrer">{t('directEmployer.officialWebsite')}<ExternalLink size={15} aria-hidden="true" /></a></li>)}</ul>}
      {!loading && enabled === true && <div className="mt-10"><PermanentEmployerMarkForm /></div>}
    </PageFrame>
  );
}

export function PermanentEmployersPage() { return <TranslationNamespaceGate namespace="publisher"><PermanentEmployersContent /></TranslationNamespaceGate>; }

function DirectEmployerQrContent() {
  const { t } = useTranslation();
  const [qr, setQr] = useState('');
  const [error, setError] = useState(false);
  const [origin, setOrigin] = useState(sourceParam() || 'vetrina');
  const safeOrigin = normalizeEmployerOrigin(origin) || 'vetrina';
  const target = `${window.location.origin}${buildPath({ activeTab: 'direct-employers' })}?origin=${encodeURIComponent(safeOrigin)}`;

  useEffect(() => {
    let mounted = true;
    void import('qrcode')
      .then((module) => (module.default ?? module).toDataURL(target, { errorCorrectionLevel: 'M', margin: 2, width: 640 }))
      .then((value) => { if (mounted) setQr(value); })
      .catch(() => { if (mounted) setError(true); });
    return () => { mounted = false; };
  }, [target]);

  return <PageFrame eyebrow={t('directEmployer.qrEyebrow')} title={t('directEmployer.qrTitle')} intro={t('directEmployer.qrIntro')}><div className="direct-employer-qr-page rounded-2xl border border-edge bg-surface p-5 text-center shadow-sm sm:p-8"><div className="print:hidden"><Field id="qr-origin" label={t('directEmployer.qrOriginLabel')} hint={t('directEmployer.qrOriginHint')}><input id="qr-origin" className={`${inputClass} mx-auto max-w-md text-left`} value={origin} onChange={(event) => setOrigin(event.target.value)} inputMode="text" autoComplete="off" /></Field></div>{qr ? <img src={qr} width={640} height={640} alt={t('directEmployer.qrAlt')} className="direct-employer-qr-code mx-auto mt-6 h-auto w-full max-w-[22rem]" /> : error ? <div className="mt-6 print:hidden"><StatusNotice tone="danger">{t('directEmployer.qrError')}</StatusNotice></div> : <p role="status" className="mt-6 text-sm text-subtle print:hidden">{t('directEmployer.loading')}</p>}<p className="mt-5 text-sm leading-6 text-subtle print:hidden">{t('directEmployer.qrSource', { origin: safeOrigin })}</p><button type="button" onClick={() => window.print()} className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-xl border border-edge px-4 py-2.5 text-sm font-semibold text-strong hover:bg-surface-raised print:hidden"><Printer size={17} aria-hidden="true" />{t('directEmployer.print')}</button></div></PageFrame>;
}

export function DirectEmployerQrPage() { return <TranslationNamespaceGate namespace="publisher"><DirectEmployerQrContent /></TranslationNamespaceGate>; }

void loadNamespaceTranslations('publisher');
