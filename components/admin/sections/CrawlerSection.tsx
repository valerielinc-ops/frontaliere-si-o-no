import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, RotateCcw, Zap } from 'lucide-react';
import { cdnDataUrl } from '@/services/cdnDataBase';
import { useAdminWorkflow } from '@/components/admin/AdminWorkflowProvider';
import { useAdminNavigation } from '@/components/admin/lib/AdminNavigationContext';
import { loadCrawlerData } from '@/components/admin/lib/jobsCrawlerConfig';
import type { CrawlerChangeFilter, CrawlerSortColumn, CrawlerSummaryRow } from '@/components/admin/lib/adminTypes';
import { isWorkflowRunDispatchLocked } from '../../../scripts/lib/githubWorkflowDispatch.mjs';
import { CrawlerTable } from './workflow/CrawlerTable';
import { AdminButton } from '@/components/admin/ui/AdminButton';
import { useAdminConfirm } from '@/components/admin/ui/AdminConfirmDialog';
import { AdminSectionHeader } from '@/components/admin/ui/AdminSectionHeader';
import { AdminSkeleton } from '@/components/admin/ui/AdminSkeleton';
import { relativeTime } from '@/components/admin/lib/formatters';

function readCrawlerQuery() {
  const params = new URLSearchParams(window.location.search);
  const sortColumns: CrawlerSortColumn[] = ['title', 'schedule', 'lastRun', 'total', 'newCount', 'updatedCount', 'removedCount', 'unchangedCount', 'duration', 'status', 'quality'];
  const requestedSort = params.get('ordina') as CrawlerSortColumn | null;
  const filters: Record<string, CrawlerChangeFilter> = {
    falliti: 'failed', failed: 'failed', 'in-corso': 'in-progress', running: 'in-progress', 'in-progress': 'in-progress',
    invariati: 'unchanged', unchanged: 'unchanged', 'qualita-bassa': 'quality-low', 'quality-low': 'quality-low',
    nuovi: 'new', new: 'new', aggiornati: 'updated', updated: 'updated', rimossi: 'removed', removed: 'removed',
    'nessuna-variazione': 'none', none: 'none',
  };
  return {
    name: params.get('q') || '',
    change: filters[params.get('stato') || ''] || 'all',
    sort: { column: requestedSort && sortColumns.includes(requestedSort) ? requestedSort : 'schedule', direction: params.get('dir') === 'desc' ? 'desc' : 'asc' } as { column: CrawlerSortColumn; direction: 'asc' | 'desc' },
  };
}

export default function CrawlerSection() {
  const {
    actions,
    setCrawlerWorkflows,
    getWorkflowState,
    runWorkflowAction,
    monitorWorkflowRun,
    runWorkflowWithConfirmation,
    refresh,
  } = useAdminWorkflow();
  const { requestConfirmation } = useAdminConfirm();
  const { locationKey } = useAdminNavigation();
  const initialQuery = readCrawlerQuery();
  const [crawlerSummaries, setCrawlerSummaries] = useState<CrawlerSummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const loadedRef = useRef(false);
  const [crawlerNameFilter, setCrawlerNameFilter] = useState(initialQuery.name);
  const [crawlerChangeFilter, setCrawlerChangeFilter] = useState<CrawlerChangeFilter>(initialQuery.change);
  const [crawlerSort, setCrawlerSort] = useState(initialQuery.sort);
  const [expandedCrawlerDetail, setExpandedCrawlerDetail] = useState<Record<string, 'new' | 'updated' | 'removed' | 'unchanged' | 'active' | null>>({});
  const [retryFailedProgress, setRetryFailedProgress] = useState<{ running: boolean; current: number; total: number; currentLabel: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async ({ force = false }: { force?: boolean } = {}) => {
    if (!force && loadedRef.current) return;
    setLoading(true);
    try {
      const data = await loadCrawlerData(cdnDataUrl);
      setCrawlerSummaries(data.summaries);
      setCrawlerWorkflows(data.workflows);
      loadedRef.current = true;
    } finally {
      setLoading(false);
    }
  }, [setCrawlerWorkflows]);

  useEffect(() => { void loadData(); }, [loadData]);

  useEffect(() => {
    if (loadedRef.current && actions.some((action) => action.context === 'jobs')) void refresh('jobs');
  }, [actions, refresh]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setCrawlerNameFilter(params.get('q') || '');
    const state = params.get('stato');
    if (state === 'falliti' || state === 'failed') setCrawlerChangeFilter('failed');
    else if (state === 'in-corso' || state === 'running' || state === 'in-progress') setCrawlerChangeFilter('in-progress');
    else if (state === 'invariati' || state === 'unchanged') setCrawlerChangeFilter('unchanged');
    else if (state === 'qualita-bassa' || state === 'quality-low') setCrawlerChangeFilter('quality-low');
    else if (state === 'nuovi' || state === 'new') setCrawlerChangeFilter('new');
    else if (state === 'aggiornati' || state === 'updated') setCrawlerChangeFilter('updated');
    else if (state === 'rimossi' || state === 'removed') setCrawlerChangeFilter('removed');
    else if (state === 'nessuna-variazione' || state === 'none') setCrawlerChangeFilter('none');
    else setCrawlerChangeFilter('all');
    const sort = params.get('ordina') as CrawlerSortColumn | null;
    if (sort && ['title', 'schedule', 'lastRun', 'total', 'newCount', 'updatedCount', 'removedCount', 'unchangedCount', 'duration', 'status', 'quality'].includes(sort)) {
      setCrawlerSort({ column: sort, direction: params.get('dir') === 'desc' ? 'desc' : 'asc' });
    }
  }, [locationKey]);

  const failedCrawlerWorkflows = actions
    .filter((action) => action.context === 'jobs' && !action.isUtility)
    .filter((action, index, candidates) => candidates.findIndex((candidate) => candidate.id === action.id) === index)
    .filter((action) => {
      const state = getWorkflowState(action.id);
      return state.status === 'completed' && Boolean(state.conclusion) && state.conclusion !== 'success' && !isWorkflowRunDispatchLocked(state);
    });

  const retryFailed = useCallback(async () => {
    if (failedCrawlerWorkflows.length === 0 || retryFailedProgress?.running) return;
    const retrySummary = failedCrawlerWorkflows.map((workflow) => `${workflow.id} (${workflow.expectedDuration})`).join(', ');
    const confirmed = await requestConfirmation({
      title: `Rilancia ${failedCrawlerWorkflows.length} gruppi crawler`,
      what: 'Stai per riavviare i gruppi crawler falliti.',
      impact: 'Ogni gruppo verrà avviato una volta su main; il monitoraggio partirà dopo i dispatch.',
      input: `ref=main, gruppi=${retrySummary}`,
      expectedDuration: failedCrawlerWorkflows.map((workflow) => workflow.expectedDuration).join(' · '),
      confirmLabel: `Rilancia ${failedCrawlerWorkflows.length} gruppi`,
      confirmVariant: 'danger',
    });
    if (!confirmed) return;
    setRetryFailedProgress({ running: true, current: 0, total: failedCrawlerWorkflows.length, currentLabel: '' });
    const monitoring: Array<ReturnType<typeof monitorWorkflowRun>> = [];
    try {
      for (let index = 0; index < failedCrawlerWorkflows.length; index += 1) {
        const workflow = failedCrawlerWorkflows[index];
        setRetryFailedProgress({ running: true, current: index + 1, total: failedCrawlerWorkflows.length, currentLabel: workflow.title });
        const state = await runWorkflowAction(workflow.id, {}, { deferMonitoring: true });
        if (state.runId !== null) monitoring.push(monitorWorkflowRun(workflow.id, state.runId, state.htmlUrl, state));
      }
      await Promise.all(monitoring);
    } finally {
      setRetryFailedProgress(null);
    }
  }, [failedCrawlerWorkflows, monitorWorkflowRun, requestConfirmation, retryFailedProgress?.running, runWorkflowAction]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadData({ force: true });
      await refresh('jobs');
    } finally {
      setRefreshing(false);
    }
  }, [loadData, refresh]);

  const latestCrawlerUpdate = crawlerSummaries.map((summary) => summary.generatedAt).filter(Boolean).sort().at(-1) || null;
  const orchestratorRunning = isWorkflowRunDispatchLocked(getWorkflowState('orchestrate-crawlers.yml'));
  const sectionHeader = (
    <AdminSectionHeader
      title="Crawler"
      summary={`${crawlerSummaries.length} crawler configurati · ${latestCrawlerUpdate ? `aggiornato ${relativeTime(latestCrawlerUpdate) || 'di recente'}` : 'aggiornamento non ancora disponibile'}`}
      primaryAction={<AdminButton variant="primary" icon={<Zap size={16} aria-hidden="true" />} loading={orchestratorRunning} disabled={loading && !orchestratorRunning} onClick={() => void runWorkflowWithConfirmation('orchestrate-crawlers.yml', { group: 'all', delay_seconds: '60', dry_run: 'false' })}>Lancia orchestratore…</AdminButton>}
      secondaryActions={<>
        {failedCrawlerWorkflows.length > 0 && <AdminButton variant="danger" icon={<RotateCcw size={16} aria-hidden="true" />} loading={Boolean(retryFailedProgress?.running)} loadingLabel={retryFailedProgress?.running ? `Rilancio ${retryFailedProgress.current}/${retryFailedProgress.total}…` : 'Rilancio…'} onClick={() => void retryFailed()}>Rilancia {failedCrawlerWorkflows.length} falliti…</AdminButton>}
        <AdminButton icon={<RefreshCw size={16} aria-hidden="true" />} loading={loading || refreshing} onClick={() => void refreshAll()}>Aggiorna stati</AdminButton>
      </>}
    />
  );

  if (loading && crawlerSummaries.length === 0) {
    return <div className="space-y-6">{sectionHeader}<div className="rounded-stripe border border-edge bg-surface p-5"><AdminSkeleton lines={6} /></div></div>;
  }

  return (
    <div className="space-y-6">
      {sectionHeader}
      <CrawlerTable
        workflowActions={actions}
        crawlerSummaries={crawlerSummaries}
        crawlerNameFilter={crawlerNameFilter}
        crawlerChangeFilter={crawlerChangeFilter}
        crawlerSort={crawlerSort}
        expandedCrawlerDetail={expandedCrawlerDetail}
        retryFailedProgress={retryFailedProgress}
        failedWorkflowCount={failedCrawlerWorkflows.length}
        setCrawlerNameFilter={setCrawlerNameFilter}
        setCrawlerChangeFilter={setCrawlerChangeFilter}
        setExpandedCrawlerDetail={setExpandedCrawlerDetail}
        setCrawlerSort={setCrawlerSort}
        getWorkflowState={getWorkflowState}
        isWorkflowRunDispatchLocked={isWorkflowRunDispatchLocked}
        runWorkflowWithConfirmation={runWorkflowWithConfirmation}
      />
    </div>
  );
}
