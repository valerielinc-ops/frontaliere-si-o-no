import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, ArrowRight, CalendarClock, CheckCircle2, CircleAlert, ExternalLink, RefreshCw, RotateCcw } from 'lucide-react';
import { useAuth } from '@/services/authService';
import { useAdminWorkflow } from '@/components/admin/AdminWorkflowProvider';
import { adminSectionPath } from '@/components/admin/lib/adminNavigation';
import { buildTodaySummary, formatTodayDate } from '@/components/admin/lib/adminToday';
import { describeCronForLocalDay, localDateKey } from '@/services/adminCron';
import { loadAdminHealth, type AdminHealthSnapshot } from '@/services/adminHealth';
import { failedCrawlerRunCount, isCrawlerWorkflowId, loadAdminTodayRuns, runIsOnLocalDay, type AdminTodayRun } from '@/services/adminTodayRuns';
import { fetchAdminEmployerInsights, type EmployerInsightsRow } from '@/services/adminInsights';
import { fetchAssistedApplicationOrders, type AssistedApplicationAdminOrder, type AssistedApplicationAdminStatus } from '@/services/assistedApplicationAdminService';
import { loadNewsletterStats, type NewsletterStats } from '@/components/admin/lib/newsletterStats';
import { AdminButton } from '@/components/admin/ui/AdminButton';
import { AdminSectionHeader } from '@/components/admin/ui/AdminSectionHeader';
import { AdminSkeleton } from '@/components/admin/ui/AdminSkeleton';
import { AdminStatusPill, type AdminStatusTone } from '@/components/admin/ui/AdminStatusPill';
import { useAdminConfirm } from '@/components/admin/ui/AdminConfirmDialog';

interface SchedulePayload {
  generatedAt: string;
  timezone: string;
  workflows: Array<{ id: string; name: string; schedules: Array<{ cron: string; source: string }> }>;
}

type BoardStatus = 'scheduled' | 'success' | 'running' | 'failure';
interface BoardRow {
  id: string;
  workflowId: string;
  name: string;
  scheduledAt: Date;
  source: string;
  status: BoardStatus;
  actualAt: string | null;
  url: string | null;
  detail: string | null;
  impact: string;
  duration: string | null;
  deltaJobs: number | null;
}

interface TriageItem {
  id: string;
  title: string;
  description: string;
  count: number;
  href: string;
  tone: AdminStatusTone;
}

interface TodaySourceErrors {
  schedule: string | null;
  runs: string | null;
}

async function loadSchedules(): Promise<SchedulePayload> {
  const response = await fetch('/data/admin-workflow-schedules.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('schedule_unavailable');
  const payload = await response.json() as Partial<SchedulePayload>;
  if (!payload || !Array.isArray(payload.workflows)) throw new Error('schedule_invalid');
  return payload as SchedulePayload;
}

function boardStatusLabel(status: BoardStatus): string {
  return status === 'failure' ? 'Errore' : status === 'running' ? 'In corso' : status === 'success' ? 'Completata' : 'Prevista';
}

function boardStatusTone(status: BoardStatus): AdminStatusTone {
  return status === 'failure' ? 'danger' : status === 'running' ? 'accent' : status === 'success' ? 'success' : 'neutral';
}

function impactForWorkflow(workflowId: string): string {
  if (workflowId === 'send-newsletter.yml') return 'Newsletter';
  if (workflowId === 'orchestrate-crawlers.yml' || workflowId.startsWith('crawler-group-')) return 'Catalogo offerte';
  return 'Controllo dati';
}

function crawlerGroupCount(payload: SchedulePayload | null): number | null {
  const count = payload?.workflows.filter((entry) => /^crawler-group-\d+\.yml$/u.test(entry.id)).length || 0;
  return count > 0 ? count : null;
}

function durationLabel(run: AdminTodayRun | null, now: Date): string | null {
  if (!run) return null;
  const startedAt = Date.parse(run.startedAt || run.createdAt || '');
  if (!Number.isFinite(startedAt)) return null;
  const endedAt = run.status === 'completed' ? Date.parse(run.updatedAt || '') : now.getTime();
  const elapsed = Math.max(0, (Number.isFinite(endedAt) ? endedAt : now.getTime()) - startedAt);
  const seconds = Math.round(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min`;
}

function statusForRun(run: AdminTodayRun | null): Pick<BoardRow, 'status' | 'actualAt' | 'url' | 'detail' | 'duration'> {
  if (!run) return { status: 'scheduled', actualAt: null, url: null, detail: null, duration: null };
  const actualAt = run.startedAt || run.createdAt || run.updatedAt;
  const detail = run.status === 'completed' && run.conclusion && run.conclusion !== 'success'
    ? `Esito: ${run.conclusion}`
    : `Run #${run.id}`;
  if (run.status === 'completed') return { status: run.conclusion === 'success' ? 'success' : 'failure', actualAt, url: run.htmlUrl, detail, duration: null };
  if (['queued', 'in_progress', 'requested', 'waiting', 'pending'].includes(run.status)) return { status: 'running', actualAt, url: run.htmlUrl, detail, duration: null };
  return { status: 'scheduled', actualAt, url: run.htmlUrl, detail, duration: null };
}

function matchingRun(workflowId: string, scheduledAt: Date, runs: readonly AdminTodayRun[], day: string, now: Date, usedRunIds: Set<number>): AdminTodayRun | null {
  const candidates = runs.filter((run) => run.workflowId === workflowId && runIsOnLocalDay(run, day) && !usedRunIds.has(run.id));
  const eligible = candidates.filter((run) => {
    const actual = Date.parse(run.startedAt || run.createdAt || '');
    return Number.isFinite(actual) && actual <= now.getTime() + 5 * 60_000;
  });
  const selected = eligible.sort((left, right) => Math.abs(Date.parse(left.startedAt || left.createdAt || '') - scheduledAt.getTime()) - Math.abs(Date.parse(right.startedAt || right.createdAt || '') - scheduledAt.getTime()))[0];
  if (!selected) return null;
  if (Math.abs(Date.parse(selected.startedAt || selected.createdAt || '') - scheduledAt.getTime()) > 8 * 60 * 60_000) return null;
  usedRunIds.add(selected.id);
  return selected;
}

function statusForWorkflow(workflowId: string, workflow: ReturnType<typeof useAdminWorkflow>, scheduledAt: Date, actualRun: AdminTodayRun | null, now: Date): Pick<BoardRow, 'status' | 'actualAt' | 'url' | 'detail' | 'duration'> {
  if (actualRun) {
    const status = statusForRun(actualRun);
    return { ...status, duration: durationLabel(actualRun, now) };
  }
  const state = workflow.getWorkflowState(workflowId);
  const stateUpdatedAt = state.updatedAt ? Date.parse(state.updatedAt) : Number.NaN;
  const actualToday = state.updatedAt && Number.isFinite(stateUpdatedAt) && stateUpdatedAt <= now.getTime() && localDateKey(new Date(stateUpdatedAt)) === localDateKey(scheduledAt);
  if (!actualToday) return { status: 'scheduled', actualAt: null, url: null, detail: null, duration: null };
  if (state.status === 'completed' && state.conclusion && state.conclusion !== 'success') return { status: 'failure', actualAt: state.updatedAt, url: state.htmlUrl, detail: state.error || `Esito: ${state.conclusion}`, duration: state.durationSeconds ? `${Math.round(state.durationSeconds / 60)} min` : null };
  if (state.status === 'completed' && state.conclusion === 'success') return { status: 'success', actualAt: state.updatedAt, url: state.htmlUrl, detail: state.message || 'Esecuzione completata', duration: state.durationSeconds ? `${Math.round(state.durationSeconds / 60)} min` : null };
  if (workflow.isRunning(workflowId)) return { status: 'running', actualAt: state.updatedAt, url: state.htmlUrl, detail: state.message || 'Esecuzione in corso', duration: state.durationSeconds ? `${Math.round(state.durationSeconds / 60)} min` : null };
  return { status: 'scheduled', actualAt: state.updatedAt, url: state.htmlUrl, detail: state.message || null, duration: null };
}

function boardRows(payload: SchedulePayload | null, workflow: ReturnType<typeof useAdminWorkflow>, now: Date, runs: readonly AdminTodayRun[], deltaJobs: number | null): BoardRow[] {
  if (!payload) return [];
  const day = localDateKey(now);
  const usedRunIds = new Set<number>();
  const scheduledRows = payload.workflows.flatMap((entry) => entry.schedules.flatMap((schedule) => describeCronForLocalDay(schedule.cron, day).map((occurrence) => {
    const scheduledAt = new Date(occurrence.at);
    const actualRun = matchingRun(entry.id, scheduledAt, runs, day, now, usedRunIds);
    return {
      id: `${entry.id}:${schedule.cron}:${occurrence.at}`,
      workflowId: entry.id,
      name: entry.name,
      scheduledAt,
      source: schedule.source,
      impact: impactForWorkflow(entry.id),
      deltaJobs: entry.id === 'orchestrate-crawlers.yml' || entry.id.startsWith('crawler-group-') ? deltaJobs : null,
      ...statusForWorkflow(entry.id, workflow, scheduledAt, actualRun, now),
    };
  })));
  const knownWorkflows = new Map(payload.workflows.map((entry) => [entry.id, entry]));
  const extraRuns = runs.flatMap((run) => {
    if (!run.workflowId || usedRunIds.has(run.id) || !runIsOnLocalDay(run, day)) return [];
    const entry = knownWorkflows.get(run.workflowId);
    const at = Date.parse(run.startedAt || run.createdAt || run.updatedAt || '');
    if (!entry || !Number.isFinite(at) || at > now.getTime() + 5 * 60_000) return [];
    usedRunIds.add(run.id);
    return [{
      id: `${run.workflowId}:actual:${run.id}`,
      workflowId: run.workflowId,
      name: entry.name,
      scheduledAt: new Date(at),
      source: 'github-actions',
      impact: impactForWorkflow(run.workflowId),
      deltaJobs: run.workflowId === 'orchestrate-crawlers.yml' || run.workflowId.startsWith('crawler-group-') ? deltaJobs : null,
      ...statusForRun(run),
      duration: durationLabel(run, now),
    }];
  });
  return [...scheduledRows, ...extraRuns].sort((left, right) => left.scheduledAt.getTime() - right.scheduledAt.getTime());
}

function pendingApplication(order: AssistedApplicationAdminOrder): boolean {
  return ['ready_for_manual_submission', 'in_progress', 'blocked'].includes(order.submissionStatus);
}

function runHref(section: string, params: Record<string, string>): string {
  const url = new URL(adminSectionPath(section), window.location.origin);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return `${url.pathname}${url.search}`;
}

export default function OggiSection() {
  const { user } = useAuth();
  const workflow = useAdminWorkflow();
  const { requestConfirmation } = useAdminConfirm();
  const [schedulePayload, setSchedulePayload] = useState<SchedulePayload | null>(null);
  const [actualRuns, setActualRuns] = useState<AdminTodayRun[]>([]);
  const [health, setHealth] = useState<AdminHealthSnapshot | null>(null);
  const [insights, setInsights] = useState<EmployerInsightsRow[]>([]);
  const [applications, setApplications] = useState<AssistedApplicationAdminOrder[]>([]);
  const [newsletterStats, setNewsletterStats] = useState<NewsletterStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sourceErrors, setSourceErrors] = useState<TodaySourceErrors>({ schedule: null, runs: null });
  const now = new Date();

  const refresh = useCallback(async () => {
    setRefreshing(true); setSourceErrors({ schedule: null, runs: null });
    const results = await Promise.allSettled([
      loadSchedules(),
      user ? loadAdminTodayRuns(user) : Promise.reject(new Error('github_auth_required')),
      loadAdminHealth(user),
      fetchAdminEmployerInsights(user),
      Promise.all((['ready_for_manual_submission', 'in_progress', 'blocked'] as AssistedApplicationAdminStatus[]).map((status) => fetchAssistedApplicationOrders(user, status))).then((groups) => groups.flat()),
      loadNewsletterStats(),
    ]);
    const [schedules, runsResult, healthResult, insightResult, applicationResult, newsletterResult] = results;
    if (schedules.status === 'fulfilled') setSchedulePayload(schedules.value);
    else {
      setSchedulePayload(null);
      setSourceErrors((current) => ({ ...current, schedule: 'Calendario dei workflow non disponibile: il file non è stato pubblicato.' }));
    }
    if (runsResult.status === 'fulfilled') setActualRuns(runsResult.value);
    else {
      setActualRuns([]);
      setSourceErrors((current) => ({ ...current, runs: 'Esecuzioni GitHub non disponibili: il tabellone mostra solo la pianificazione.' }));
    }
    if (healthResult.status === 'fulfilled') setHealth(healthResult.value);
    if (insightResult.status === 'fulfilled') setInsights(insightResult.value);
    if (applicationResult.status === 'fulfilled') setApplications(applicationResult.value);
    if (newsletterResult.status === 'fulfilled') setNewsletterStats(newsletterResult.value);
    setLoading(false); setRefreshing(false);
  }, [user]);

  useEffect(() => { void refresh(); }, [refresh]);

  const rows = useMemo(() => boardRows(schedulePayload, workflow, now, actualRuns, health?.cdn.activeJobsDelta ?? null), [schedulePayload, workflow, now.getTime(), actualRuns, health?.cdn.activeJobsDelta]);
  const boardStats = useMemo(() => rows.reduce((stats, row) => {
    stats.planned += 1;
    if (row.status === 'success') stats.completed += 1;
    if (row.status === 'running') stats.running += 1;
    if (row.status === 'failure') stats.failed += 1;
    return stats;
  }, { planned: 0, completed: 0, running: 0, failed: 0 }), [rows]);
  const summary = buildTodaySummary({ ...(schedulePayload ? boardStats : { planned: null, completed: null, running: null, failed: null }), crawlerCount: health?.cdn.crawlerCount, crawlerGroups: crawlerGroupCount(schedulePayload), activeJobs: health?.cdn.activeJobs, activeJobsDelta: health?.cdn.activeJobsDelta });
  const boardEmptyMessage = sourceErrors.schedule || 'Nessuna esecuzione prevista oggi.';

  const failedWorkflows = useMemo(() => {
    const failed = new Set(actualRuns.filter((run) => isCrawlerWorkflowId(run.workflowId) && runIsOnLocalDay(run, localDateKey(now)) && run.status === 'completed' && run.conclusion !== 'success').map((run) => run.workflowId));
    workflow.actions.forEach((action) => {
      const state = workflow.getWorkflowState(action.id);
      if (action.context === 'jobs' && !action.isUtility && state.status === 'completed' && state.conclusion && state.conclusion !== 'success') failed.add(action.id);
    });
    return Math.max(failed.size, failedCrawlerRunCount(actualRuns, localDateKey(now)));
  }, [actualRuns, now.getTime(), workflow.actions, workflow.workflowStates]);
  const repliedCompanies = insights.filter((row) => row.outreach?.replied && !row.outreach.suppressed);
  const pendingApplications = applications.filter(pendingApplication);
  const triage: TriageItem[] = [
    failedWorkflows > 0 ? { id: 'crawler-failures', title: 'Crawler da verificare', description: 'Una o più esecuzioni recenti hanno chiuso con errore.', count: failedWorkflows, href: runHref('crawler', { stato: 'falliti' }), tone: 'danger' } : null,
    repliedCompanies.length > 0 ? { id: 'outreach-replies', title: 'Risposte aziende', description: 'Ci sono risposte outreach da aprire e lavorare.', count: repliedCompanies.length, href: runHref('aziende', { azienda: repliedCompanies[0].companyKey }), tone: 'warning' } : null,
    pendingApplications.length > 0 ? { id: 'applications', title: 'Candidature in coda', description: 'Ordini pronti o bloccati richiedono una decisione.', count: pendingApplications.length, href: runHref('candidature', { ordine: pendingApplications[0].orderId }), tone: 'warning' } : null,
    newsletterStats ? { id: 'newsletter', title: 'Prossimo invio newsletter', description: `${newsletterStats.subscriberCount ?? 'n/d'} iscritti attivi · anteprima da preparare${newsletterStats.lastSend ? ` · ultimo invio ${newsletterStats.lastSend}` : ''}.`, count: 1, href: adminSectionPath('newsletter'), tone: 'info' } : null,
  ].filter((item): item is TriageItem => Boolean(item));

  const retryBoardRow = async (row: BoardRow) => {
    if (row.status !== 'failure') return;
    const confirmed = await requestConfirmation({
      title: 'Rilancia workflow fallito',
      what: `Stai per rilanciare «${row.name}».`,
      impact: 'Avvierà una nuova esecuzione GitHub Actions e potrà modificare i dati prodotti dal workflow.',
      workflowFile: row.workflowId,
      input: `workflow=${row.workflowId}, ref=main`,
      expectedDuration: 'variabile secondo il workflow',
      confirmLabel: 'Rilancia workflow',
      confirmVariant: 'danger',
    });
    if (confirmed) await workflow.runWorkflowWithConfirmation(row.workflowId);
  };

  if (loading) return <div className="space-y-6"><AdminSectionHeader title="Oggi" summary="Sto leggendo calendario, esecuzioni e dati operativi…" secondaryActions={<AdminButton icon={<RefreshCw size={16} aria-hidden="true" />} loading>Aggiorna</AdminButton>} /><div className="rounded-stripe border border-edge bg-surface p-5"><AdminSkeleton lines={8} /></div></div>;

  return (
    <div className="space-y-6">
      <AdminSectionHeader title="Oggi" summary={<><span>{formatTodayDate(now)}</span>{summary && <span className="mt-1 block font-display text-xl font-light leading-snug text-heading lg:ml-1 lg:mt-0 lg:inline lg:font-sans lg:text-sm lg:font-normal lg:text-subtle"><span className="hidden lg:inline" aria-hidden="true">· </span>{summary}</span>}</>} primaryAction={<a href={adminSectionPath('crawler')} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-stripe border border-accent bg-accent px-3.5 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Apri crawler <ArrowRight size={16} aria-hidden="true" /></a>} secondaryActions={<AdminButton icon={<RefreshCw size={16} aria-hidden="true" />} loading={refreshing} onClick={() => void refresh()}>Aggiorna</AdminButton>} />

      <div className="grid grid-cols-3 gap-2 lg:hidden" aria-label="Riepilogo rapido"><span className="rounded-full border border-warning-border bg-warning-subtle px-2 py-2 text-center text-xs font-medium text-warning">Tocca a te · {user ? triage.reduce((total, item) => total + item.count, 0) : '—'}</span><span className="rounded-full border border-accent-border bg-accent-subtle px-2 py-2 text-center text-xs font-medium text-accent">In corso · {schedulePayload ? boardStats.running : '—'}</span><span className="rounded-full border border-success-border bg-success-subtle px-2 py-2 text-center text-xs font-medium text-success">Tutto ok · {schedulePayload ? boardStats.completed : '—'}</span></div>

      {(sourceErrors.schedule || sourceErrors.runs) && <div role="status" className="space-y-2 rounded-stripe border border-warning-border bg-warning-subtle px-4 py-3 text-sm text-warning">{sourceErrors.schedule && <p>{sourceErrors.schedule}</p>}{sourceErrors.runs && <p>{sourceErrors.runs}</p>}</div>}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)] xl:items-start xl:gap-5">
        <section aria-labelledby="oggi-board-title" className="order-2 min-w-0 space-y-3 xl:order-1"><div className="flex items-center gap-2"><CalendarClock size={18} className="text-accent" aria-hidden="true" /><h2 id="oggi-board-title" className="font-display text-xl font-light text-heading">Tabellone delle esecuzioni</h2><span className="text-sm text-subtle">Europe/Zurich</span></div><div className="hidden min-w-0 max-w-full overflow-x-auto rounded-stripe border border-edge bg-surface lg:block"><table className="w-full table-fixed text-left text-sm"><caption className="sr-only">Run workflow previste oggi e stato reale</caption><colgroup><col className="w-[9%]" /><col className="w-[25%]" /><col className="w-[14%]" /><col className="w-[16%]" /><col className="w-[11%]" /><col className="w-[10%]" /><col className="w-[15%]" /></colgroup><thead className="bg-surface-alt text-xs font-semibold text-muted"><tr><th scope="col" className="whitespace-normal break-words px-2 py-3 leading-4">Ora</th><th scope="col" className="whitespace-normal break-words px-2 py-3 leading-4">Workflow</th><th scope="col" className="whitespace-normal break-words px-2 py-3 leading-4">Impatto</th><th scope="col" className="whitespace-normal break-words px-2 py-3 leading-4">Stato</th><th scope="col" className="whitespace-normal break-words px-2 py-3 leading-4">Durata</th><th scope="col" className="whitespace-normal break-words px-2 py-3 leading-4">Δ annunci</th><th scope="col" className="whitespace-normal break-words px-2 py-3 text-right leading-4">Azione</th></tr></thead><tbody>{rows.map((row) => <BoardTableRow key={row.id} row={row} onRetry={retryBoardRow} />)}{rows.length === 0 && <tr><td colSpan={7} className="whitespace-normal break-words px-4 py-8 text-center text-subtle">{boardEmptyMessage}</td></tr>}</tbody></table></div><div className="space-y-3 lg:hidden">{rows.map((row) => <BoardCard key={row.id} row={row} onRetry={retryBoardRow} />)}{rows.length === 0 && <p className="rounded-stripe border border-edge bg-surface px-4 py-8 text-center text-sm text-subtle">{boardEmptyMessage}</p>}</div></section>

        <section aria-labelledby="oggi-triage-title" className="order-1 space-y-3 xl:order-2"><div className="flex items-center gap-2"><Activity size={18} className="text-accent" aria-hidden="true" /><h2 id="oggi-triage-title" className="font-display text-xl font-light text-heading">Tocca a te</h2></div>{triage.length === 0 ? <div className="rounded-stripe border border-success-border bg-success-subtle p-5"><div className="flex items-center gap-2 font-medium text-success"><CheckCircle2 size={18} aria-hidden="true" />Niente da fare adesso</div><p className="mt-1 text-sm text-subtle">Le fonti operative non segnalano decisioni urgenti.</p></div> : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-1">{triage.map((item) => <a key={item.id} href={item.href} className={`rounded-stripe border p-4 transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${item.tone === 'danger' ? 'border-danger-border bg-danger-subtle' : 'border-edge bg-surface'}`}><div className="flex items-start justify-between gap-3"><div><h3 className="font-medium text-heading">{item.title}</h3><p className="mt-1 text-sm leading-5 text-subtle">{item.description}</p></div><AdminStatusPill tone={item.tone}>{item.count}</AdminStatusPill></div><span className="mt-4 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-accent">Apri coda <ArrowRight size={14} aria-hidden="true" /></span></a>)}</div>}</section>
      </div>

      <section aria-labelledby="oggi-health-title" className="space-y-3"><div className="flex items-center gap-2"><CircleAlert size={18} className="text-accent" aria-hidden="true" /><h2 id="oggi-health-title" className="font-display text-xl font-light text-heading">Salute</h2><a href={adminSectionPath('salute')} className="ml-auto inline-flex min-h-10 items-center gap-1 text-sm font-medium text-accent hover:underline">Dettagli <ExternalLink size={14} aria-hidden="true" /></a></div><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{(health?.indicators || []).map((indicator) => <a key={indicator.id} href={runHref('salute', { focus: indicator.id })} className="rounded-stripe border border-edge bg-surface p-4 hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><div className="flex items-start justify-between gap-2"><h3 className="text-sm font-semibold text-heading">{indicator.label}</h3><AdminStatusPill tone={indicator.tone === 'danger' ? 'danger' : indicator.tone === 'warning' ? 'warning' : indicator.tone === 'success' ? 'success' : 'neutral'}>{indicator.value}</AdminStatusPill></div><p className="mt-2 text-sm text-subtle">{indicator.detail}</p></a>)}</div></section>
    </div>
  );
}

function BoardTableRow({ row, onRetry }: { key?: string | number; row: BoardRow; onRetry: (row: BoardRow) => void | Promise<void> }) {
  return <tr className={`border-t border-edge ${row.status === 'failure' ? 'bg-danger-subtle' : ''}`}><td className="whitespace-nowrap px-2 py-3 font-display text-base font-medium tabular-nums text-heading">{row.scheduledAt.toLocaleTimeString('it-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit' })}</td><td className="min-w-0 break-words px-2 py-3"><div className="break-words font-medium text-heading">{row.name}</div><div className="mt-0.5 break-words text-xs leading-4 text-subtle">{row.detail || (row.source === 'cloud-scheduler' ? 'Cloud Scheduler' : 'GitHub Actions')}</div></td><td className="px-2 py-3 text-subtle"><span className="inline-flex max-w-full items-center justify-center whitespace-normal break-words rounded-full bg-surface-raised px-2 py-1 text-center text-xs font-medium leading-4 text-subtle">{row.impact}</span></td><td className="px-2 py-3"><AdminStatusPill tone={boardStatusTone(row.status)}>{boardStatusLabel(row.status)}</AdminStatusPill></td><td className="whitespace-nowrap px-2 py-3 tabular-nums text-subtle">{row.duration || 'n/d'}</td><td className="whitespace-nowrap px-2 py-3 tabular-nums text-subtle">{row.deltaJobs === null ? 'n/d' : `${row.deltaJobs >= 0 ? '+' : ''}${row.deltaJobs}`}</td><td className="px-2 py-3 text-right">{row.status === 'failure' && <AdminButton variant="danger" icon={<RotateCcw size={14} aria-hidden="true" />} onClick={() => void onRetry(row)}>Rilancia</AdminButton>}</td></tr>;
}

function BoardCard({ row, onRetry }: { key?: string | number; row: BoardRow; onRetry: (row: BoardRow) => void | Promise<void> }) {
  return <article className={`rounded-stripe border p-4 ${row.status === 'failure' ? 'border-danger-border bg-danger-subtle' : 'border-edge bg-surface'}`}><div className="flex items-start justify-between gap-3"><div><p className="font-mono text-sm text-heading">{row.scheduledAt.toLocaleTimeString('it-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit' })}</p><h3 className="mt-1 font-medium text-heading">{row.name}</h3><p className="mt-1 text-sm text-subtle">{row.detail || (row.source === 'cloud-scheduler' ? 'Cloud Scheduler' : 'GitHub Actions')}</p></div><AdminStatusPill tone={boardStatusTone(row.status)}>{boardStatusLabel(row.status)}</AdminStatusPill></div><dl className="mt-3 grid grid-cols-3 gap-2 text-xs"><div><dt className="text-muted">Impatto</dt><dd className="mt-0.5 text-subtle">{row.impact}</dd></div><div><dt className="text-muted">Durata</dt><dd className="mt-0.5 tabular-nums text-subtle">{row.duration || 'n/d'}</dd></div><div><dt className="text-muted">Δ annunci</dt><dd className="mt-0.5 tabular-nums text-subtle">{row.deltaJobs === null ? 'n/d' : `${row.deltaJobs >= 0 ? '+' : ''}${row.deltaJobs}`}</dd></div></dl>{row.url && <a href={row.url} target="_blank" rel="noreferrer" className="mt-3 inline-flex min-h-10 items-center gap-1 text-sm font-medium text-accent">Apri run <ExternalLink size={14} aria-hidden="true" /></a>}{row.status === 'failure' && <AdminButton variant="danger" icon={<RotateCcw size={14} aria-hidden="true" />} className="mt-3 w-full" onClick={() => void onRetry(row)}>Rilancia workflow</AdminButton>}</article>;
}
