import { Activity, ArrowRight, RefreshCw } from 'lucide-react';
import { useAdminWorkflow } from '@/components/admin/AdminWorkflowProvider';
import { adminSectionPath } from '@/components/admin/lib/adminNavigation';
import { relativeTime } from '@/components/admin/lib/formatters';
import { AdminButton } from '@/components/admin/ui/AdminButton';
import { AdminSectionHeader } from '@/components/admin/ui/AdminSectionHeader';
import { AdminSkeleton } from '@/components/admin/ui/AdminSkeleton';
import { AdminStatusPill } from '@/components/admin/ui/AdminStatusPill';

const SUMMARY_CONTEXTS = ['jobs', 'content', 'seo', 'analytics'] as const;

export default function OggiSection() {
  const workflow = useAdminWorkflow();
  const actions = workflow.actions.filter((action) => !action.isUtility);
  const summaries = SUMMARY_CONTEXTS.map((context) => ({ context, summary: workflow.getSummary(context) }));
  const totalPending = summaries.reduce((total, item) => total + item.summary.pending, 0);
  const totalErrors = summaries.reduce((total, item) => total + item.summary.error, 0);
  const latestUpdate = actions.map((action) => workflow.getWorkflowState(action.id).updatedAt).filter((value): value is string => Boolean(value)).sort().at(-1) || null;
  const updatedLabel = latestUpdate ? `aggiornato ${relativeTime(latestUpdate) || 'di recente'}` : 'non ancora aggiornato';

  return (
    <div className="space-y-6">
      <AdminSectionHeader
        title="Oggi"
        summary={<><strong className="font-semibold text-heading">{actions.length}</strong> azioni disponibili · {totalPending} in corso · {totalErrors} con errore · {updatedLabel}</>}
        primaryAction={<a href={adminSectionPath('crawler')} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-stripe border border-accent bg-accent px-3.5 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Apri crawler <ArrowRight size={16} aria-hidden="true" /></a>}
        secondaryActions={<AdminButton variant="secondary" icon={<RefreshCw size={16} aria-hidden="true" />} loading={false} onClick={() => void workflow.refresh()}>Aggiorna</AdminButton>}
      />

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Riepilogo operativo">
        {summaries.map(({ context, summary }) => {
          const label = context === 'jobs' ? 'Lavoro' : context === 'content' ? 'Contenuti' : context === 'seo' ? 'SEO & qualità' : 'Analytics & dati';
          const tone = summary.error > 0 ? 'danger' : summary.pending > 0 ? 'accent' : summary.ok > 0 ? 'success' : 'neutral';
          return <article key={context} className="rounded-stripe border border-edge bg-surface p-4 shadow-stripe-sm"><div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold text-heading">{label}</h2><AdminStatusPill tone={tone}>{summary.error > 0 ? `${summary.error} errori` : summary.pending > 0 ? `${summary.pending} in corso` : summary.ok > 0 ? `${summary.ok} ok` : 'In attesa'}</AdminStatusPill></div><p className="mt-3 text-3xl font-light tabular-nums text-heading">{summary.ok + summary.error + summary.pending}</p><p className="mt-1 text-sm text-subtle">stati rilevati</p></article>;
        })}
      </section>

      {actions.length === 0 ? <AdminSkeleton lines={3} /> : <section className="rounded-stripe border border-edge bg-surface p-4" aria-labelledby="oggi-attivita-title"><div className="flex items-center gap-2"><Activity size={18} className="text-accent" aria-hidden="true" /><h2 id="oggi-attivita-title" className="font-display text-xl font-light text-heading">Ultime attività</h2></div><div className="mt-4 divide-y divide-edge">{actions.slice(0, 6).map((action) => { const state = workflow.getWorkflowState(action.id); const isFailure = state.status === 'error' || (state.status === 'completed' && state.conclusion && state.conclusion !== 'success'); const isRunning = workflow.isRunning(action.id); return <div key={action.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"><div className="min-w-0"><p className="truncate text-sm font-medium text-heading">{action.title}</p><p className="mt-1 text-sm text-subtle">{state.updatedAt ? `Aggiornato ${relativeTime(state.updatedAt) || 'di recente'}` : 'Nessuna esecuzione registrata'}</p></div><AdminStatusPill tone={isFailure ? 'danger' : isRunning ? 'accent' : state.conclusion === 'success' ? 'success' : 'neutral'}>{isFailure ? 'Errore' : isRunning ? 'In corso' : state.conclusion === 'success' ? 'OK' : 'In attesa'}</AdminStatusPill></div>; })}</div></section>}
    </div>
  );
}
