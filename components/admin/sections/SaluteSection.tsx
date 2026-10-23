import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw } from 'lucide-react';
import { getSerpExperimentDiagnostics } from '@/services/seoService';
import { CopyButton } from '@/components/admin/ui/CopyButton';
import { HealthBadge } from '@/components/admin/ui/HealthBadge';
import type { OwnerStats, SerpDiagnostics } from '@/components/admin/lib/adminTypes';
import { loadNewsletterStats } from '@/components/admin/lib/newsletterStats';
import { AdminButton } from '@/components/admin/ui/AdminButton';
import { AdminSectionHeader } from '@/components/admin/ui/AdminSectionHeader';

export default function SaluteSection() {
  const [ownerStats, setOwnerStats] = useState<OwnerStats>({ loading: false, error: null, socialProofTotal: null, simulationDocs: null, forumQuestions: null, newsletterActive: null, publicFiles: {} });
  const [serpDiagnostics, setSerpDiagnostics] = useState<SerpDiagnostics>(() => getSerpExperimentDiagnostics());

  useEffect(() => {
    const refresh = () => setSerpDiagnostics(getSerpExperimentDiagnostics());
    const timer = window.setTimeout(refresh, 1200);
    return () => window.clearTimeout(timer);
  }, []);

  const refreshOwnerStats = async () => {
    setOwnerStats((current) => ({ ...current, loading: true, error: null }));
    try {
      const [socialProofSnap, simulationCountSnap, forumCountSnap, newsletterStats, files] = await Promise.all([
        (async () => { const { getFirestore, doc, getDoc } = await import('firebase/firestore'); const { app } = await import('@/services/firebase'); return getDoc(doc(getFirestore(app), 'counters', 'simulations')); })(),
        (async () => { const { getFirestore, collection, getCountFromServer } = await import('firebase/firestore'); const { app } = await import('@/services/firebase'); return getCountFromServer(collection(getFirestore(app), 'simulations')); })(),
        (async () => { const { getFirestore, collection, getCountFromServer } = await import('firebase/firestore'); const { app } = await import('@/services/firebase'); return getCountFromServer(collection(getFirestore(app), 'forum_questions')); })(),
        loadNewsletterStats(),
        (async () => { const checks = ['sitemap.xml', 'sitemap-news.xml', 'robots.txt', 'llms.txt', 'manifest.webmanifest']; const result: Record<string, boolean> = {}; await Promise.all(checks.map(async (file) => { try { result[file] = (await fetch(`/${file}`, { method: 'GET', cache: 'no-store' })).ok; } catch { result[file] = false; } })); return result; })(),
      ]);
      setOwnerStats({ loading: false, error: null, socialProofTotal: socialProofSnap.exists() ? Number(socialProofSnap.data()?.total || 0) : 0, simulationDocs: simulationCountSnap.data().count, forumQuestions: forumCountSnap.data().count, newsletterActive: newsletterStats.subscriberCount, publicFiles: files });
    } catch (error) {
      setOwnerStats((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : 'Errore sconosciuto' }));
    }
  };

  useEffect(() => { void refreshOwnerStats(); }, []);

  return (
    <div className="space-y-4">
      <AdminSectionHeader title="Salute" summary={`${Object.keys(ownerStats.publicFiles).length} file controllati · aggiornato ${ownerStats.loading ? 'in corso' : 'adesso'}`} secondaryActions={<AdminButton icon={<RefreshCw size={16} aria-hidden="true" />} loading={ownerStats.loading} onClick={() => void refreshOwnerStats()}>Aggiorna</AdminButton>} />
      {ownerStats.error && <div className="bg-danger-subtle border border-danger-border rounded-stripe px-3 py-2 text-sm text-danger">Errore lettura dati owner: {ownerStats.error}</div>}
      <div className="bg-surface rounded-stripe border border-edge px-4 py-2"><p className="text-sm text-muted">Panoramica KPI e check runtime. Usa questa vista per un controllo rapido.</p></div>
      <div className={`rounded-stripe border p-4 ${serpDiagnostics.hasRemoteOverride ? 'bg-warning-subtle border-warning-border' : 'bg-success-subtle border-success-border'}`}>
        <div className="flex items-center gap-2 text-sm font-semibold">{serpDiagnostics.hasRemoteOverride ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}SEO SERP Experiment Config Check</div>
        <div className="mt-2 text-xs text-body font-mono break-all">attivo: abilitato={String(serpDiagnostics.runtime.enabled)}, variante={serpDiagnostics.runtime.variant}, obiettivi={serpDiagnostics.runtime.targets || '(vuoto)'}, anno={serpDiagnostics.runtime.year}</div>
        <div className="mt-1 text-xs text-subtle font-mono break-all">predefinito: abilitato={String(serpDiagnostics.defaults.enabled)}, variante={serpDiagnostics.defaults.variant}, obiettivi={serpDiagnostics.defaults.targets}, anno={serpDiagnostics.defaults.year}</div>
        {!serpDiagnostics.loaded && <div className="mt-2 text-xs text-subtle">Caricamento stato Remote Config in corso…</div>}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">{[
        ['Social proof (counters/simulations)', ownerStats.socialProofTotal], ['Simulazioni cloud (collection)', ownerStats.simulationDocs], ['Domande forum', ownerStats.forumQuestions], ['Newsletter attivi', ownerStats.newsletterActive],
      ].map(([label, value]) => <div key={String(label)} className="bg-surface rounded-stripe border border-edge p-4"><div className="text-xs text-muted mb-1">{label}</div><div className="text-2xl font-semibold text-strong">{ownerStats.loading ? '…' : value ?? '—'}</div></div>)}</div>
      <div className="bg-surface rounded-stripe border border-edge p-4 space-y-3"><h3 className="text-sm font-semibold text-strong">File pubblici critici</h3>{Object.entries(ownerStats.publicFiles).map(([file, ok]) => { const isHealthy = Boolean(ok); return <div key={file} className="flex items-center justify-between text-sm"><span className="font-mono text-body">/{file}</span><HealthBadge ok={isHealthy} label={isHealthy ? 'OK' : 'Mancante'} /></div>; })}</div>
      <div className="bg-surface rounded-stripe border border-edge p-4 space-y-3"><h3 className="text-sm font-semibold text-strong">Azioni rapide</h3><div className="flex flex-wrap gap-2"><CopyButton text="npm run build && npm run validate:structured-data && npm test" label="pipeline locale" /><CopyButton text="node scripts/send-newsletter.mjs --preview > /tmp/newsletter.html && open /tmp/newsletter.html" label="preview newsletter" /><a href="/sitemap.xml" target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1 rounded-stripe border border-edge px-3 py-2 text-sm font-medium text-body hover:bg-surface-raised"><ExternalLink size={14} />Apri sitemap.xml</a><a href="/robots.txt" target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1 rounded-stripe border border-edge px-3 py-2 text-sm font-medium text-body hover:bg-surface-raised"><ExternalLink size={14} />Apri robots.txt</a></div></div>
    </div>
  );
}
