import { Copy, Database, Eye, ExternalLink, Megaphone, Play } from 'lucide-react';
import type { WorkflowActionDefinition, WorkflowRunState } from '@/components/admin/lib/adminTypes';
import { formatDuration, relativeTime } from '@/components/admin/lib/formatters';
import { AdminButton } from '@/components/admin/ui/AdminButton';
import { AdminStatusPill } from '@/components/admin/ui/AdminStatusPill';

const IMPACT_META = {
  lettura: { label: 'Solo lettura', icon: Eye, className: 'bg-surface-raised text-subtle' },
  'modifica dati': { label: 'Modifica dati', icon: Database, className: 'bg-warning-subtle text-warning' },
  pubblicazione: { label: 'Pubblica contenuti', icon: Megaphone, className: 'bg-danger-subtle text-danger' },
} as const;

export function WorkflowCard({
  workflow,
  state,
  onRun,
  onCopy,
  onOpen,
}: {
  key?: string | number;
  workflow: WorkflowActionDefinition;
  state: WorkflowRunState;
  onRun: () => void;
  onCopy: () => void;
  onOpen: () => void;
}) {
  const isSuccess = state.status === 'completed' && state.conclusion === 'success';
  const isFailure = state.status === 'completed' && Boolean(state.conclusion) && state.conclusion !== 'success';
  const isRunning = state.loading || ['dispatching', 'requested', 'queued', 'pending', 'waiting', 'in_progress', 'unknown'].includes(state.status);
  const failedSteps = state.jobs.flatMap((job) => job.failedSteps.map((step) => `${job.name}: ${step}`));
  const lastRunAgo = relativeTime(state.updatedAt);

  return (
    <article className="space-y-3 rounded-stripe border border-edge bg-surface p-4 shadow-stripe-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="truncate text-sm font-semibold text-heading">{workflow.title}</h4>
            {lastRunAgo && <span className="whitespace-nowrap font-mono text-xs text-muted" title={state.updatedAt || ''}>{lastRunAgo}</span>}
          </div>
          <p className="mt-1 text-sm leading-snug text-subtle">{workflow.description}</p>
          {workflow.impact && (() => {
            const impact = IMPACT_META[workflow.impact];
            const ImpactIcon = impact.icon;
            return <span className={`mt-2 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${impact.className}`}><ImpactIcon size={13} aria-hidden="true" />{impact.label}</span>;
          })()}
        </div>
        <AdminStatusPill tone={isSuccess ? 'success' : isFailure ? 'danger' : isRunning ? 'accent' : 'neutral'}>
          {isRunning ? 'In corso' : isSuccess ? 'OK' : isFailure ? 'Errore' : 'In attesa'}
        </AdminStatusPill>
      </div>

      {isFailure && (state.error || failedSteps.length > 0) && (
        <div className="space-y-1.5 rounded-stripe border border-danger-border bg-danger-subtle px-3 py-2.5">
          {state.error && <div className="text-xs font-semibold text-danger">{state.error}</div>}
          {failedSteps.length > 0 && <div className="text-sm text-danger"><span className="font-semibold">Step falliti:</span>{' '}{failedSteps.slice(0, 6).join(' · ')}{failedSteps.length > 6 && <span> (+{failedSteps.length - 6})</span>}</div>}
        </div>
      )}
      {!isFailure && state.message && <div className="rounded-stripe border border-accent-border bg-accent-subtle px-3 py-2 text-sm text-accent">{state.message}</div>}

      <div className="flex flex-wrap items-center gap-2">
        <AdminButton variant="primary" icon={<Play size={15} aria-hidden="true" />} onClick={onRun} disabled={isRunning}>{isRunning ? 'In corso…' : 'Avvia…'}</AdminButton>
        {state.htmlUrl && <a href={state.htmlUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1.5 rounded-stripe border border-edge px-3.5 py-2 text-sm font-medium text-body transition-colors hover:border-accent hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><ExternalLink size={15} aria-hidden="true" />GitHub</a>}
        {state.error && <AdminButton icon={<Copy size={15} aria-hidden="true" />} onClick={onCopy} title="Copia richiesta fix">Copia fix</AdminButton>}
        {state.error && <AdminButton variant="secondary" onClick={onOpen}>Apri richiesta AI</AdminButton>}
      </div>

      {isFailure && state.logExcerpt && <div><div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Log errore (ultime righe)</div><pre className="max-h-32 overflow-auto rounded-stripe border border-danger-border bg-surface-inverted p-2 text-xs font-mono leading-relaxed text-danger whitespace-pre-wrap break-words">{state.logExcerpt}</pre></div>}

      <details className="rounded-stripe border border-edge bg-surface-alt p-3 text-sm">
        <summary className="cursor-pointer select-none font-semibold text-subtle">Dettaglio · <span className="font-normal">{workflow.details}</span> · <span className="font-mono text-xs">{workflow.expectedDuration}</span></summary>
        <div className="mt-3 space-y-2 text-subtle">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
            <div>Esecuzione <span className="font-mono font-semibold">#{state.runNumber || '—'}</span></div>
            <div>Stato: <span className="font-semibold">{state.status || 'in attesa'}</span></div>
            <div>Esito: <span className={`font-semibold ${state.conclusion === 'success' ? 'text-success' : state.conclusion === 'failure' ? 'text-danger' : ''}`}>{state.conclusion || '—'}</span></div>
            <div>Durata: <span className="font-semibold">{formatDuration(state.durationSeconds)}</span></div>
            <div>Ultimo: <span className="font-mono">{lastRunAgo || 'n/d'}</span></div>
            <div>ID: <span className="font-mono text-xs">{state.runId || 'n/d'}</span></div>
          </div>
          {state.jobs.length > 0 && <div className="overflow-x-auto rounded-stripe border border-edge"><table className="min-w-[420px] w-full text-sm tabular-nums"><thead className="bg-surface-raised text-muted"><tr><th scope="col" className="px-2 py-2 text-left">Job</th><th scope="col" className="px-2 py-2 text-left">Esito</th><th scope="col" className="px-2 py-2 text-right">Step</th></tr></thead><tbody>{state.jobs.map((job) => <tr key={`${workflow.id}-${job.id}`} className={`border-t border-edge ${String(job.conclusion) === 'failure' ? 'bg-danger-subtle/50' : ''}`}><td className="px-2 py-2 font-medium">{job.name}</td><td className={`px-2 py-2 font-semibold ${String(job.conclusion) === 'failure' ? 'text-danger' : String(job.conclusion) === 'success' ? 'text-success' : ''}`}>{job.conclusion || job.status || '—'}</td><td className="px-2 py-2 text-right font-mono tabular-nums">{job.completedSteps}/{job.totalSteps}</td></tr>)}</tbody></table></div>}
          {!isFailure && state.logExcerpt && <div><div className="mb-1 text-xs font-semibold text-muted">Output log</div><pre className="max-h-36 overflow-auto rounded-stripe border border-edge bg-surface-inverted p-2 text-xs whitespace-pre-wrap break-words">{state.logExcerpt}</pre></div>}
          {isFailure && !state.logExcerpt && <div className="text-sm italic text-muted">Log non disponibile — apri il run su GitHub per i dettagli completi.</div>}
        </div>
      </details>
    </article>
  );
}
