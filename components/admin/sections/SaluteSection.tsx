import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw } from 'lucide-react';
import { useAuth } from '@/services/authService';
import { getSerpExperimentDiagnostics } from '@/services/seoService';
import { loadAdminHealth, type AdminHealthSnapshot, type HealthIndicator } from '@/services/adminHealth';
import { CopyButton } from '@/components/admin/ui/CopyButton';
import { AdminButton } from '@/components/admin/ui/AdminButton';
import { AdminSectionHeader } from '@/components/admin/ui/AdminSectionHeader';
import { AdminSkeleton } from '@/components/admin/ui/AdminSkeleton';
import { AdminStatusPill, type AdminStatusTone } from '@/components/admin/ui/AdminStatusPill';
import type { OwnerStats, PublicFileStatus, SerpDiagnostics } from '@/components/admin/lib/adminTypes';
import { loadNewsletterStats } from '@/components/admin/lib/newsletterStats';

const PUBLIC_FILES = ['sitemap.xml', 'sitemap-news.xml', 'robots.txt', 'llms.txt', 'manifest.webmanifest'] as const;

function emptyPublicFiles(): Record<string, PublicFileStatus> {
  return Object.fromEntries(PUBLIC_FILES.map((file) => [file, 'unknown'])) as Record<string, PublicFileStatus>;
}

function toneForIndicator(indicator: HealthIndicator): AdminStatusTone {
  return indicator.tone === 'danger' ? 'danger' : indicator.tone === 'warning' ? 'warning' : indicator.tone === 'success' ? 'success' : 'neutral';
}

function indicatorIdFromQuery(): string {
  return new URLSearchParams(window.location.search).get('focus') || '';
}

function verificationLabel(updatedAt: string | null): string {
  if (!updatedAt) return 'Non ancora verificato';
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return 'Non ancora verificato';
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return 'Verificato meno di 1 min fa';
  if (minutes < 60) return `Verificato ${minutes} min fa`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Verificato ${hours} h fa`;
  return `Verificato ${Math.floor(hours / 24)} g fa`;
}

function ownerValue(value: number | null, loading: boolean): { text: string; className: string; prominent: boolean } {
  if (loading) return { text: 'in corso', className: 'text-muted', prominent: false };
  if (value === null) return { text: 'n/d', className: 'text-muted', prominent: false };
  return { text: value.toLocaleString('it-IT'), className: 'text-heading', prominent: true };
}

export default function SaluteSection() {
  const { user } = useAuth();
  const [ownerStats, setOwnerStats] = useState<OwnerStats>({ loading: false, error: null, socialProofTotal: null, simulationDocs: null, forumQuestions: null, newsletterActive: null, publicFiles: emptyPublicFiles() });
  const [serpDiagnostics, setSerpDiagnostics] = useState<SerpDiagnostics>(() => getSerpExperimentDiagnostics());
  const [health, setHealth] = useState<AdminHealthSnapshot | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [focus, setFocus] = useState(indicatorIdFromQuery);

  const refresh = async () => {
    setLoading(true); setHealthError(null); setOwnerStats((current) => ({ ...current, loading: true, error: null }));
    const healthPromise = loadAdminHealth(user);
    const publicFilesPromise = checkPublicFiles();
    try {
      const [socialProofSnap, simulationCountSnap, forumCountSnap, newsletterStats] = await Promise.all([
        (async () => { const { getFirestore, doc, getDoc } = await import('firebase/firestore'); const { app } = await import('@/services/firebase'); return getDoc(doc(getFirestore(app), 'counters', 'simulations')); })(),
        (async () => { const { getFirestore, collection, getCountFromServer } = await import('firebase/firestore'); const { app } = await import('@/services/firebase'); return getCountFromServer(collection(getFirestore(app), 'simulations')); })(),
        (async () => { const { getFirestore, collection, getCountFromServer } = await import('firebase/firestore'); const { app } = await import('@/services/firebase'); return getCountFromServer(collection(getFirestore(app), 'forum_questions')); })(),
        loadNewsletterStats(),
      ]);
      setOwnerStats({ loading: false, error: null, socialProofTotal: socialProofSnap.exists() ? Number(socialProofSnap.data()?.total || 0) : 0, simulationDocs: simulationCountSnap.data().count, forumQuestions: forumCountSnap.data().count, newsletterActive: newsletterStats.subscriberCount, publicFiles: await publicFilesPromise });
    } catch (error) {
      const publicFiles = await publicFilesPromise.catch(() => emptyPublicFiles());
      setOwnerStats((current) => ({ ...current, loading: false, error: 'Indicatori del sito non disponibili.', publicFiles }));
    }
    try { setHealth(await healthPromise); }
    catch (error) { setHealthError(error instanceof Error ? error.message : 'Indicatori tecnici non disponibili.'); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => setSerpDiagnostics(getSerpExperimentDiagnostics()), 1200);
    void refresh();
    const onPopState = () => setFocus(indicatorIdFromQuery());
    window.addEventListener('popstate', onPopState);
    return () => { window.clearTimeout(timer); window.removeEventListener('popstate', onPopState); };
  }, [user]);

  const latestUpdate = health?.indicators.map((indicator) => indicator.updatedAt).filter(Boolean).sort().at(-1) || null;
  const focusClass = (id: string) => focus === id ? 'ring-2 ring-accent ring-offset-2' : '';
  const deployLinks = health?.deploys.filter((deploy) => deploy.url) || [];
  const quickCommands = [
    ['Assembla statistiche lavoro', 'npm run jobs:assemble:stats'],
    ['Esegue i test', 'npm test'],
    ['Anteprima newsletter', 'node scripts/send-newsletter.mjs --preview'],
    ['Avvia deploy sito', 'gh workflow run deploy.yml --ref main'],
    ['Avvia deploy funzioni', 'gh workflow run deploy-cloud-functions.yml --ref main'],
  ];

  return (
    <div className="space-y-6">
      <AdminSectionHeader title="Salute" summary={`${health?.indicators.length || 0} indicatori tecnici · ultimo controllo ${latestUpdate ? new Date(latestUpdate).toLocaleString('it-CH') : loading ? 'in corso' : 'non disponibile'}`} secondaryActions={<AdminButton icon={<RefreshCw size={16} aria-hidden="true" />} loading={loading} onClick={() => void refresh()}>Aggiorna</AdminButton>} />
      {healthError && <p role="alert" className="rounded-stripe border border-danger-border bg-danger-subtle px-4 py-3 text-sm text-danger">{healthError}</p>}

      <section aria-labelledby="salute-indicatori-title" className="space-y-3"><div className="flex items-center justify-between gap-3"><h2 id="salute-indicatori-title" className="font-display text-xl font-light text-heading">Indicatori operativi</h2><span className="text-sm text-subtle">CDN · corpus · API · deploy</span></div>{health ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{health.indicators.map((indicator) => <article key={indicator.id} className={`rounded-stripe border border-edge bg-surface p-4 ${focusClass(indicator.id)}`}><div className="flex items-start justify-between gap-3"><h3 className="text-sm font-semibold text-heading">{indicator.label}</h3><AdminStatusPill tone={toneForIndicator(indicator)}>{indicator.value}</AdminStatusPill></div><p className="mt-2 text-sm text-subtle">{indicator.detail}</p><p className="mt-2 text-xs text-muted">{verificationLabel(indicator.updatedAt)}</p>{indicator.threshold && <p className="mt-1 text-xs text-muted">Soglia: {indicator.threshold}</p>}{indicator.id === 'deploy' && <div className="mt-3 space-y-1">{deployLinks.map((deploy) => <a key={deploy.workflow} href={deploy.url || '#'} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">{deploy.label}<ExternalLink size={12} aria-hidden="true" /></a>)}</div>}</article>)}</div> : <div className="rounded-stripe border border-edge bg-surface p-5"><AdminSkeleton lines={4} /></div>}</section>

      <section className="space-y-3" aria-labelledby="salute-serp-title"><div className={`rounded-stripe border p-4 ${serpDiagnostics.hasRemoteOverride ? 'border-warning-border bg-warning-subtle' : 'border-success-border bg-success-subtle'}`}><div className="flex items-center gap-2 text-sm font-semibold text-heading">{serpDiagnostics.hasRemoteOverride ? <AlertTriangle size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}<h2 id="salute-serp-title">Esperimento SERP: configurazione</h2><AdminStatusPill tone={serpDiagnostics.hasRemoteOverride ? 'warning' : 'success'}>{serpDiagnostics.hasRemoteOverride ? 'Override attivo' : 'Baseline'}</AdminStatusPill></div><p className="mt-2 break-all font-mono text-xs text-body">attivo: abilitato={String(serpDiagnostics.runtime.enabled)}, variante={serpDiagnostics.runtime.variant}, obiettivi={serpDiagnostics.runtime.targets || '(vuoto)'}, anno={serpDiagnostics.runtime.year}</p><p className="mt-1 break-all font-mono text-xs text-subtle">predefinito: abilitato={String(serpDiagnostics.defaults.enabled)}, variante={serpDiagnostics.defaults.variant}, obiettivi={serpDiagnostics.defaults.targets}, anno={serpDiagnostics.defaults.year}</p>{!serpDiagnostics.loaded && <p className="mt-2 text-xs text-subtle">Caricamento stato Remote Config in corso…</p>}</div></section>

      <section className="space-y-3" aria-labelledby="salute-owner-title"><h2 id="salute-owner-title" className="font-display text-xl font-light text-heading">Indicatori del sito</h2><div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[['Prova sociale', ownerStats.socialProofTotal], ['Simulazioni cloud', ownerStats.simulationDocs], ['Domande forum', ownerStats.forumQuestions], ['Newsletter attivi', ownerStats.newsletterActive]].map(([label, value]) => { const display = ownerValue(typeof value === 'number' ? value : null, ownerStats.loading); return <article key={String(label)} className="rounded-stripe border border-edge bg-surface p-4"><p className="text-sm text-subtle">{label}</p><p className={`mt-2 ${display.prominent ? 'text-2xl font-semibold' : 'text-sm font-medium'} tabular-nums ${display.className}`}>{display.text}</p></article>; })}</div><div className="rounded-stripe border border-edge bg-surface p-4"><h3 className="text-sm font-semibold text-heading">File pubblici critici</h3><div className="mt-3 grid gap-2 sm:grid-cols-2">{Object.entries(ownerStats.publicFiles).map(([file, status]) => <div key={file} className="flex items-center justify-between gap-3 text-sm"><span className="font-mono text-body">/{file}</span><AdminStatusPill tone={status === 'ok' ? 'success' : status === 'missing' ? 'danger' : 'neutral'}>{status === 'ok' ? 'OK' : status === 'missing' ? 'Mancante' : 'Non verificato'}</AdminStatusPill></div>)}</div></div></section>

      <section className="space-y-3" aria-labelledby="salute-actions-title"><h2 id="salute-actions-title" className="font-display text-xl font-light text-heading">Collegamenti e comandi</h2><div className="flex flex-wrap gap-2"><a href="/sitemap.xml" target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1 rounded-stripe border border-edge bg-surface px-3 py-2 text-sm font-medium text-body hover:border-accent"><ExternalLink size={14} aria-hidden="true" />Sitemap</a><a href="/robots.txt" target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1 rounded-stripe border border-edge bg-surface px-3 py-2 text-sm font-medium text-body hover:border-accent"><ExternalLink size={14} aria-hidden="true" />Robots</a><a href="/llms.txt" target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1 rounded-stripe border border-edge bg-surface px-3 py-2 text-sm font-medium text-body hover:border-accent"><ExternalLink size={14} aria-hidden="true" />Modelli AI</a></div><div className="grid gap-2 sm:grid-cols-2">{quickCommands.map(([label, command]) => <div key={command} className="flex min-w-0 items-center justify-between gap-3 rounded-stripe border border-edge bg-surface px-3 py-2"><code className="min-w-0 break-all text-xs text-body">{command}</code><CopyButton text={command} label={label} /></div>)}</div></section>
    </div>
  );
}

async function checkPublicFiles(): Promise<Record<string, PublicFileStatus>> {
  const result: Record<string, PublicFileStatus> = emptyPublicFiles();
  await Promise.all(PUBLIC_FILES.map(async (file) => { try { result[file] = (await fetch(`/${file}`, { method: 'GET', cache: 'no-store' })).ok ? 'ok' : 'missing'; } catch { result[file] = 'unknown'; } }));
  return result;
}
