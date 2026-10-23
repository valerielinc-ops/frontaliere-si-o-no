import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cdnDataUrl } from '@/services/cdnDataBase';
import { useAdminWorkflow } from '@/components/admin/AdminWorkflowProvider';
import { useAdminNavigation } from '@/components/admin/lib/AdminNavigationContext';
import { loadCrawlerData } from '@/components/admin/lib/jobsCrawlerConfig';
import type { CrawlerChangeFilter, CrawlerSortColumn, CrawlerSummaryRow } from '@/components/admin/lib/adminTypes';
import { isWorkflowRunDispatchLocked } from '../../../scripts/lib/githubWorkflowDispatch.mjs';
import { CrawlerTable } from './workflow/CrawlerTable';

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

  if (loading && crawlerSummaries.length === 0) {
    return <div className="flex items-center justify-center py-16 text-muted" role="status"><Loader2 size={18} className="mr-2 animate-spin" />Caricamento crawler…</div>;
  }

  return (
    <CrawlerTable
      workflowActions={actions}
      crawlerSummaries={crawlerSummaries}
      crawlerNameFilter={crawlerNameFilter}
      crawlerChangeFilter={crawlerChangeFilter}
      crawlerSort={crawlerSort}
      expandedCrawlerDetail={expandedCrawlerDetail}
      retryFailedProgress={retryFailedProgress}
      setCrawlerNameFilter={setCrawlerNameFilter}
      setCrawlerChangeFilter={setCrawlerChangeFilter}
      setExpandedCrawlerDetail={setExpandedCrawlerDetail}
      setCrawlerSort={setCrawlerSort}
      setRetryFailedProgress={setRetryFailedProgress}
      getWorkflowState={getWorkflowState}
      isWorkflowRunDispatchLocked={isWorkflowRunDispatchLocked}
      runWorkflowAction={runWorkflowAction}
      monitorWorkflowRun={monitorWorkflowRun}
      runWorkflowWithConfirmation={runWorkflowWithConfirmation}
      refreshWorkflowSnapshots={() => refresh('jobs')}
      loadCrawlerData={loadData}
    />
  );
}
