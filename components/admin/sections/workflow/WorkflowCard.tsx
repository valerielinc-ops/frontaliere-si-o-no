import { AlertTriangle, CheckCircle2, Clock3, Copy, ExternalLink, Loader2, Play } from 'lucide-react';
import type { WorkflowActionDefinition, WorkflowRunState } from '@/components/admin/lib/adminTypes';
import { formatDuration, relativeTime } from '@/components/admin/lib/formatters';

export function WorkflowCard({
  workflow,
  state,
  onRun,
  onCopy,
  onOpen,
}: {
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
  const borderColor = isFailure ? 'border-l-danger' : isSuccess ? 'border-l-success' : isRunning ? 'border-l-accent' : 'border-l-edge';

  return (
    <div className={`rounded-lg border border-edge border-l-4 ${borderColor} bg-surface/40 p-4 space-y-3`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-bold text-strong truncate">{workflow.title}</h4>
            {lastRunAgo && <span className="text-[10px] text-muted font-mono whitespace-nowrap" title={state.updatedAt || ''}>{lastRunAgo}</span>}
          </div>
          <p className="text-[11px] text-muted mt-0.5 leading-snug">{workflow.description}</p>
          {workflow.impact && <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-accent">Impatto: {workflow.impact}</p>}
        </div>
        <span className={`shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide ${isSuccess ? 'bg-success-subtle text-success' : isFailure ? 'bg-danger-subtle text-danger' : isRunning ? 'bg-accent-subtle text-accent' : 'bg-surface-raised text-subtle'}`}>
          {isRunning ? <><Loader2 size={10} className="animate-spin" /> Run</> : isSuccess ? <><CheckCircle2 size={10} /> OK</> : isFailure ? <><AlertTriangle size={10} /> Errore</> : <><Clock3 size={10} /> Idle</>}
        </span>
      </div>

      {isFailure && (state.error || failedSteps.length > 0) && (
        <div className="rounded-lg bg-danger-subtle border border-danger-border px-3 py-2.5 space-y-1.5">
          {state.error && <div className="flex items-start gap-2 text-xs font-semibold text-danger"><AlertTriangle size={13} className="mt-0.5 shrink-0" /><span>{state.error}</span></div>}
          {failedSteps.length > 0 && <div className="text-[11px] text-danger pl-5"><span className="font-semibold">Step falliti:</span>{' '}{failedSteps.slice(0, 6).join(' · ')}{failedSteps.length > 6 && <span className="text-danger"> (+{failedSteps.length - 6})</span>}</div>}
        </div>
      )}
      {!isFailure && state.message && <div className="rounded-lg px-3 py-2 text-[11px] bg-accent-subtle border border-accent-border text-accent">{state.message}</div>}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={onRun} disabled={isRunning} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover disabled:opacity-60 text-on-accent text-xs font-semibold transition-colors"><Play size={11} />{isRunning ? 'In corso…' : 'Avvia'}</button>
        {state.htmlUrl && <a href={state.htmlUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-edge text-subtle text-xs font-semibold hover:bg-surface-raised transition-colors"><ExternalLink size={11} />GitHub</a>}
        {state.error && <button type="button" onClick={onCopy} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-surface-raised hover:bg-surface-raised transition-colors font-mono" title="Copia richiesta fix"><Copy size={12} className="text-muted" />Copia fix</button>}
        {state.error && <button type="button" onClick={onOpen} className="text-xs text-link hover:underline">Apri richiesta AI</button>}
      </div>

      {isFailure && state.logExcerpt && <div><div className="mb-1 text-[10px] font-semibold text-muted uppercase tracking-wide">Log errore (ultime righe)</div><pre className="max-h-32 overflow-auto rounded-md bg-surface-inverted text-danger p-2 text-[10px] font-mono whitespace-pre-wrap break-words leading-relaxed border border-danger-border">{state.logExcerpt}</pre></div>}

      <details className="rounded-lg border border-edge bg-surface-alt/40 p-3 text-xs">
        <summary className="cursor-pointer font-semibold text-subtle select-none">Dettaglio · <span className="font-normal">{workflow.details}</span> · <span className="font-mono text-[10px]">{workflow.expectedDuration}</span></summary>
        <div className="mt-3 space-y-2 text-subtle">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-[11px]">
            <div>Run <span className="font-mono font-semibold">#{state.runNumber || '—'}</span></div>
            <div>Stato: <span className="font-semibold">{state.status || 'idle'}</span></div>
            <div>Esito: <span className={`font-semibold ${state.conclusion === 'success' ? 'text-success' : state.conclusion === 'failure' ? 'text-danger' : ''}`}>{state.conclusion || '—'}</span></div>
            <div>Durata: <span className="font-semibold">{formatDuration(state.durationSeconds)}</span></div>
            <div>Ultimo: <span className="font-mono">{lastRunAgo || 'n/d'}</span></div>
            <div>ID: <span className="font-mono text-[10px]">{state.runId || 'n/d'}</span></div>
          </div>
          {state.jobs.length > 0 && <div className="rounded-md border border-edge overflow-x-auto"><table className="min-w-[420px] w-full text-[11px]"><thead className="bg-surface-raised/40 text-muted"><tr><th className="text-left py-1 px-2">Job</th><th className="text-left py-1 px-2">Esito</th><th className="text-right py-1 px-2">Step</th></tr></thead><tbody>{state.jobs.map((job) => <tr key={`${workflow.id}-${job.id}`} className={`border-t border-edge ${String(job.conclusion) === 'failure' ? 'bg-danger-subtle/50' : ''}`}><td className="py-1 px-2 font-medium">{job.name}</td><td className={`py-1 px-2 font-semibold ${String(job.conclusion) === 'failure' ? 'text-danger' : String(job.conclusion) === 'success' ? 'text-success' : ''}`}>{job.conclusion || job.status || '—'}</td><td className="py-1 px-2 text-right font-mono">{job.completedSteps}/{job.totalSteps}</td></tr>)}</tbody></table></div>}
          {!isFailure && state.logExcerpt && <div><div className="mb-1 text-[10px] font-semibold text-muted">Output log</div><pre className="max-h-36 overflow-auto rounded-md bg-surface-inverted text-heading p-2 text-[10px] whitespace-pre-wrap break-words">{state.logExcerpt}</pre></div>}
          {isFailure && !state.logExcerpt && <div className="text-[11px] italic text-muted">Log non disponibile — apri il run su GitHub per i dettagli completi.</div>}
        </div>
      </details>
    </div>
  );
}
