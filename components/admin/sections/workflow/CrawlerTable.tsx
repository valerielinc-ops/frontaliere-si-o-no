import { Fragment, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import {
  AlertTriangle, ArrowDown, ArrowUp, ChevronDown, ChevronRight,
  Clock3, ExternalLink, Loader2, Play, Search,
} from 'lucide-react';
import { normalizeExternalJobDetailUrl } from '@/services/jobApplicationDestination';
import { CopyButton } from '@/components/admin/ui/CopyButton';
import { AdminButton } from '@/components/admin/ui/AdminButton';
import { AdminStatusPill } from '@/components/admin/ui/AdminStatusPill';
import { relativeTime } from '@/components/admin/lib/formatters';
import { replaceAdminQuery } from '@/components/admin/lib/adminNavigation';
import { WORKFLOW_CONTEXT_META } from '@/components/admin/AdminWorkflowProvider';
import type {
  CrawlerChangeFilter,
  CrawlerQualityScore,
  CrawlerSortColumn,
  CrawlerSortDirection,
  CrawlerSummaryLinkRow,
  CrawlerSummaryRow,
  WorkflowActionDefinition,
  WorkflowContext,
  WorkflowRunState,
} from '@/components/admin/lib/adminTypes';

function crawlerChangeFilterToQuery(value: CrawlerChangeFilter): string | null {
  switch (value) {
    case 'failed': return 'falliti';
    case 'in-progress': return 'in-corso';
    case 'unchanged': return 'invariati';
    case 'quality-low': return 'qualita-bassa';
    case 'new': return 'nuovi';
    case 'updated': return 'aggiornati';
    case 'removed': return 'rimossi';
    case 'none': return 'nessuna-variazione';
    default: return null;
  }
}

export interface CrawlerTableProps {
  workflowActions: readonly WorkflowActionDefinition[];
  crawlerSummaries: CrawlerSummaryRow[];
  crawlerNameFilter: string;
  crawlerChangeFilter: CrawlerChangeFilter;
  crawlerSort: { column: CrawlerSortColumn; direction: CrawlerSortDirection };
  expandedCrawlerDetail: Record<string, 'new' | 'updated' | 'removed' | 'unchanged' | 'active' | null>;
  retryFailedProgress: { running: boolean; current: number; total: number; currentLabel: string } | null;
  setCrawlerNameFilter: Dispatch<SetStateAction<string>>;
  setCrawlerChangeFilter: Dispatch<SetStateAction<CrawlerChangeFilter>>;
  setExpandedCrawlerDetail: Dispatch<SetStateAction<Record<string, 'new' | 'updated' | 'removed' | 'unchanged' | 'active' | null>>>;
  setCrawlerSort: Dispatch<SetStateAction<{ column: CrawlerSortColumn; direction: CrawlerSortDirection }>>;
  failedWorkflowCount: number;
  getWorkflowState: (workflowId: string) => WorkflowRunState;
  isWorkflowRunDispatchLocked: (state: WorkflowRunState | null | undefined) => boolean;
  runWorkflowWithConfirmation: (workflowId: string, inputs?: Record<string, string>) => Promise<WorkflowRunState | null>;
  renderWorkflowCard?: (workflow: WorkflowActionDefinition) => ReactNode;
}

export function CrawlerTable({
  workflowActions,
  crawlerSummaries,
  crawlerNameFilter,
  crawlerChangeFilter,
  crawlerSort,
  expandedCrawlerDetail,
  retryFailedProgress,
  setCrawlerNameFilter,
  setCrawlerChangeFilter,
  setExpandedCrawlerDetail,
  setCrawlerSort,
  failedWorkflowCount,
  getWorkflowState,
  isWorkflowRunDispatchLocked,
  runWorkflowWithConfirmation,
  renderWorkflowCard = () => null,
}: CrawlerTableProps) {

 const context: WorkflowContext = 'jobs';
 const meta = WORKFLOW_CONTEXT_META[context];
 const grouped = workflowActions.filter((wf) => wf.context === context && !wf.isUtility);
 const isJobsContext = true;

 const findCrawlerSummary = (wf: { id: string; slug?: string; summaryKey?: string | null }): CrawlerSummaryRow | undefined => {
 // Post-consolidation (2026-07), `wf.id` is the crawler's CONTAINING GROUP
 // workflow filename (crawler-group-NN.yml), not a per-crawler
 // update-jobs-{slug}.yml — it can no longer be reverse-derived into a
 // slug by stripping a fixed prefix/suffix. Use the explicit `slug` field
 // the registry now provides (falls back to `id` for any future entry
 // that still follows the old per-crawler naming, e.g. non-jobs contexts).
 const slug = wf.slug || wf.id.replace(/^update-jobs-/, '').replace(/\.yml$/, '');
 // 1. Exact match on summaryKey extracted from crawler script at build time
 if (wf.summaryKey) {
 const byKey = crawlerSummaries.find(s => s.key === wf.summaryKey);
 if (byKey) return byKey;
 }
 // 2. Exact match on crawler slug
 const exact = crawlerSummaries.find(s => s.key === slug);
 if (exact) return exact;
 // 3. Fuzzy: summary key contains slug or slug contains summary key
 return crawlerSummaries.find(s =>
 s.key.includes(slug) || slug.includes(s.key.replace(/-/g, ''))
 );
 };

 const formatDurationMs = (ms: number): string => {
 const sec = Math.round(ms / 1000);
 if (sec < 60) return `${sec}s`;
 const min = Math.floor(sec / 60);
 const remSec = sec % 60;
 return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
 };

 const unmatchedSummaries = isJobsContext
 ? crawlerSummaries.filter(s => !grouped.some(wf => findCrawlerSummary(wf)?.key === s.key))
 : [];

 return (
 <div className="space-y-4">
 <div className="bg-surface rounded-stripe border border-edge p-4 space-y-4">
 {isJobsContext ? (
 <div className="space-y-3">
 {(() => {
 // Build unified row list: workflows + unmatched summaries, sorted by schedule
 type JobRow = { key: string; title: string; description: string; schedule: string | null; wf: typeof grouped[0] | null; summary: CrawlerSummaryRow | undefined };
 const rows: JobRow[] = grouped.map(wf => {
 const summary = findCrawlerSummary(wf);
 // Post-consolidation (2026-07), `wf.id` is the crawler's CONTAINING
 // GROUP workflow filename — many crawlers in `grouped` now share the
 // SAME `id` (all members of the same crawler-group-*.yml), which would
 // collide as a React list key and silently drop rows. Prefer the
 // per-crawler `slug` (unique) when present.
 return { key: wf.slug || wf.id, title: wf.title, description: wf.description, schedule: wf.schedule || null, wf, summary };
 });
 for (const s of unmatchedSummaries) {
 rows.push({ key: `summary-${s.key}`, title: s.label, description: '', schedule: null, wf: null, summary: s });
 }

 // Apply filters
 const filtered = rows.filter(r => {
 if (crawlerNameFilter) {
 const q = crawlerNameFilter.toLowerCase();
 if (!r.title.toLowerCase().includes(q) && !r.key.toLowerCase().includes(q)) return false;
 }
 if (crawlerChangeFilter !== 'all') {
 const s = r.summary;
 if (crawlerChangeFilter === 'none') {
 if (s && (s.newCount > 0 || s.updatedCount > 0 || s.removedCount > 0)) return false;
 } else if (crawlerChangeFilter === 'new') {
 if (!s || s.newCount === 0) return false;
 } else if (crawlerChangeFilter === 'updated') {
 if (!s || s.updatedCount === 0) return false;
 } else if (crawlerChangeFilter === 'removed') {
 if (!s || s.removedCount === 0) return false;
 } else if (crawlerChangeFilter === 'failed') {
 const state = r.wf ? getWorkflowState(r.wf.id) : null;
 if (!state || state.status !== 'completed' || !state.conclusion || state.conclusion === 'success') return false;
 } else if (crawlerChangeFilter === 'in-progress') {
 if (!r.wf || !isWorkflowRunDispatchLocked(getWorkflowState(r.wf.id))) return false;
 } else if (crawlerChangeFilter === 'unchanged') {
 if (!s || s.unchangedCount === 0) return false;
 } else if (crawlerChangeFilter === 'quality-low') {
 if (!s?.qualityScore || s.qualityScore.avgScore >= 75) return false;
 }
 }
 return true;
 });

 const getCrawlerStatusRank = (row: JobRow): number => {
 const wfState = row.wf ? getWorkflowState(row.wf.id) : null;
 const isSuccess = wfState?.status === 'completed' && wfState.conclusion === 'success';
 const isFailure = wfState?.status === 'completed' && wfState.conclusion != null && wfState.conclusion !== 'success';
 const isRunning = isWorkflowRunDispatchLocked(wfState);
 if (isFailure) return 0;
 if (isRunning) return 1;
 if (isSuccess) return 2;
 return 3;
 };

 const getLastRunTimestamp = (row: JobRow): number => {
 const wfState = row.wf ? getWorkflowState(row.wf.id) : null;
 const rawValue = wfState?.updatedAt || row.summary?.generatedAt || '';
 const parsed = rawValue ? Date.parse(rawValue) : Number.NaN;
 return Number.isFinite(parsed) ? parsed : -1;
 };

 const compareCrawlerRows = (a: JobRow, b: JobRow): number => {
 const direction = crawlerSort.direction === 'asc' ? 1 : -1;

 const compareNullableText = (left: string | null, right: string | null): number => {
 if (left && right) return left.localeCompare(right);
 if (left) return -1;
 if (right) return 1;
 return 0;
 };

 const compareNumber = (left: number, right: number): number => left - right;

 let result = 0;
 switch (crawlerSort.column) {
 case 'title':
 result = a.title.localeCompare(b.title);
 break;
 case 'schedule':
 result = compareNullableText(a.schedule, b.schedule);
 break;
 case 'lastRun':
 result = compareNumber(getLastRunTimestamp(a), getLastRunTimestamp(b));
 break;
 case 'newCount':
 result = compareNumber(a.summary?.newCount || 0, b.summary?.newCount || 0);
 break;
 case 'updatedCount':
 result = compareNumber(a.summary?.updatedCount || 0, b.summary?.updatedCount || 0);
 break;
 case 'removedCount':
 result = compareNumber(a.summary?.removedCount || 0, b.summary?.removedCount || 0);
 break;
 case 'unchangedCount':
 result = compareNumber(a.summary?.unchangedCount || 0, b.summary?.unchangedCount || 0);
 break;
 case 'total':
 result = compareNumber(a.summary?.activeJobCount || 0, b.summary?.activeJobCount || 0);
 break;
 case 'duration':
 result = compareNumber(a.summary?.durationMs || 0, b.summary?.durationMs || 0);
 break;
 case 'status':
 result = compareNumber(getCrawlerStatusRank(a), getCrawlerStatusRank(b));
 break;
 case 'quality':
 result = compareNumber(a.summary?.qualityScore?.avgScore || 0, b.summary?.qualityScore?.avgScore || 0);
 break;
 }

 if (result !== 0) return result * direction;
 return a.title.localeCompare(b.title);
 };

 const sorted = [...filtered].sort(compareCrawlerRows);

 // Aggregate totals for the header (from filtered rows)
 const totals = sorted.reduce((acc, r) => {
 if (r.summary) {
 acc.newCount += r.summary.newCount;
 acc.updated += r.summary.updatedCount;
 acc.removed += r.summary.removedCount;
 acc.unchanged += r.summary.unchangedCount;
 acc.total += r.summary.total;
 acc.active += r.summary.activeJobCount;
 }
 return acc;
 }, { newCount: 0, updated: 0, removed: 0, unchanged: 0, total: 0, active: 0 });

 // Latest generatedAt across all rows — used to timestamp the summary bar.
 // This is the last crawler run timestamp, distinct from the daily board delta.
 const latestSummaryAt = rows
 .map(r => r.summary?.generatedAt)
 .filter((t): t is string => Boolean(t))
 .sort()
 .at(-1) ?? null;

 const toggleExpand = (key: string, type: 'new' | 'updated' | 'removed' | 'unchanged' | 'active') => {
 setExpandedCrawlerDetail(prev => ({
 ...prev,
 [key]: prev[key] === type ? null : type,
 }));
 };

 const renderExpandedJobs = (jobs: CrawlerSummaryLinkRow[], type: 'new' | 'updated' | 'removed' | 'unchanged' | 'active') => {
 if (jobs.length === 0) return <div className="text-sm text-muted py-1">Nessun elemento.</div>;
 const styleMap = {
 new: 'border-success-border bg-success-subtle/50',
 updated: 'border-accent-border bg-accent-subtle/50',
 removed: 'border-danger-border bg-danger-subtle/50',
 unchanged: 'border-warning-border bg-warning-subtle',
 active: 'border-edge bg-surface',
 } as const;
 const jobSiteUrl = (slug: string) => slug ? `https://frontaliereticino.ch/cerca-lavoro-ticino/${slug}/` : '';
 return (
 <div className="space-y-1">
 {(jobs as (CrawlerSummaryLinkRow & { _status?: 'new' | 'updated' | 'unchanged' })[]).map((job, idx) => {
 const rowStyle = type === 'active' && job._status ? styleMap[job._status] : styleMap[type];
 const siteUrl = jobSiteUrl(job.slug);
 const qs = job._qualityScore;
 const qsBadge = qs != null ? (() => {
 const color = qs >= 75
 ? 'bg-success-subtle text-success'
 : qs >= 50
 ? 'bg-warning-subtle text-warning'
 : 'bg-danger-subtle text-danger';
 const bd = job._qualityBreakdown;
 const tip = bd
 ? `Pulizia: ${bd.cleanliness}/25\nRicchezza: ${bd.richness}/25\nTraduzione: ${bd.translation}/25\nCompletezza: ${bd.completeness}/25`
 : `Quality: ${qs}/100`;
 return (
 <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-sm font-semibold ${color} cursor-help`} title={tip}>
 {qs}
 </span>
 );
 })() : null;
 return (
 <div key={`${job.slug || idx}`} className={`rounded-stripe border px-2 py-1.5 ${rowStyle}`}>
 <div className="flex items-center gap-1.5">
 <span className="text-sm font-medium text-strong">{job.title || 'Job senza titolo'}</span>
 {qsBadge}
 </div>
 <div className="text-sm text-muted">
 {job.company || 'Azienda n/d'}{job.location ? ` \u00B7 ${job.location}` : ''}
 </div>
 <div className="flex gap-3 mt-0.5">
 {job.url && <a href={normalizeExternalJobDetailUrl(job.url)} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1 text-sm text-link hover:underline"><ExternalLink size={13} aria-hidden="true" />Sorgente</a>}
 {siteUrl && (type === 'removed' ? (
 <a href={siteUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1 text-sm text-muted hover:underline"><Clock3 size={13} aria-hidden="true" />Sito (archiviato)</a>
 ) : (
 <a href={siteUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1 text-sm text-accent hover:underline"><ExternalLink size={13} aria-hidden="true" />Sito</a>
 ))}
 </div>
 </div>
 );
 })}
 </div>
 );
 };

 const renderCrawlerSortHeader = (
 column: CrawlerSortColumn,
 label: string,
 options?: { align?: 'left' | 'center'; className?: string },
 ) => {
 const isActive = crawlerSort.column === column;
 const Icon = isActive && crawlerSort.direction === 'desc' ? ArrowDown : ArrowUp;
 const justifyClass = options?.align === 'center' ? 'justify-center' : 'justify-start';
 return (
 <button
 type="button"
 onClick={() => {
 const next = crawlerSort.column === column
 ? { column, direction: crawlerSort.direction === 'asc' ? 'desc' as const : 'asc' as const }
 : { column, direction: column === 'title' ? 'asc' as const : 'desc' as const };
 setCrawlerSort(next);
 replaceAdminQuery({ ordina: next.column, dir: next.direction });
 }}
 className={`inline-flex w-full items-center gap-1 ${justifyClass} ${options?.className || ''} hover:text-heading `}
 aria-sort={isActive ? (crawlerSort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
 >
 <span>{label}</span>
 <Icon size={11} className={isActive ? 'opacity-100' : 'opacity-25'} />
 </button>
 );
 };

 return (
 <>
 {/* Summary bar + filters */}
 <div className="flex flex-col gap-2">
 <div className="flex flex-wrap items-center gap-3 px-3 py-2 rounded-stripe bg-surface-alt/40 border border-edge text-sm">
 <span className="font-semibold text-body">{filtered.length}/{rows.length} crawler</span>
 {/* Source badge: makes clear these numbers are per-crawler last-run diffs,
 NOT the daily job-board delta from jobs-stats.json (todayAdded/todayUpdated/todayRemoved). */}
 <span
 className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-stripe bg-warning-subtle text-warning font-semibold text-sm"
 title="Aggiunti / Aggiornati / Rimossi / Invariati mostrano il diff dell'ultima singola esecuzione di ogni crawler. Sono metriche distinte dal delta giornaliero del job board (jobs-stats.json) che confronta l'intero board con il commit HEAD della giornata."
 >
 Δ ultima run
 </span>
 {latestSummaryAt && (
 <span
 className="text-muted text-sm font-mono whitespace-nowrap"
 title={`Dati aggiornati: ${latestSummaryAt}`}
 >
 {relativeTime(latestSummaryAt, true)}
 </span>
 )}
 <span className="text-muted" aria-hidden="true">·</span>
 <span className="font-semibold text-subtle">{totals.active} annunci attivi</span>
 {totals.newCount > 0 && <span className="text-success font-semibold" title="Totale aggiunti nelle ultime run (Δ run, ≠ delta giornaliero)">+{totals.newCount} nuove</span>}
 {totals.updated > 0 && <span className="text-accent font-semibold" title="Totale aggiornati nelle ultime run (Δ run, ≠ delta giornaliero)">~{totals.updated} agg.</span>}
 {totals.removed > 0 && <span className="text-danger font-semibold" title="Totale rimossi nelle ultime run (Δ run, ≠ delta giornaliero)">-{totals.removed} rim.</span>}
 {totals.unchanged > 0 && <span className="text-muted" title="Totale invariati nelle ultime run (Δ run, ≠ delta giornaliero)">={totals.unchanged} inv.</span>}
 {failedWorkflowCount > 0 && (
 <>
 <span className="text-muted" aria-hidden="true">·</span>
 <span className="text-danger font-semibold">{failedWorkflowCount} falliti</span>
 </>
 )}
 </div>
 {retryFailedProgress?.running && (
 <div className="flex items-center gap-2 px-3 py-1.5 rounded-stripe bg-warning-subtle border border-warning-border text-sm text-warning">
 <Loader2 size={12} className="animate-spin" />
 <span>Rilancio {retryFailedProgress.current}/{retryFailedProgress.total}: <strong>{retryFailedProgress.currentLabel}</strong></span>
 </div>
 )}
 {/* Filters */}
 <div className="flex flex-wrap items-center gap-2 px-1">
 <div className="relative">
 <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
 <input
 type="text"
 value={crawlerNameFilter}
 onChange={e => {
 const value = e.target.value;
 setCrawlerNameFilter(value);
 replaceAdminQuery({ q: value.trim() || null });
 }}
 placeholder="Filtra crawler…"
 className="pl-7 pr-2 py-1.5 rounded-stripe border border-edge bg-surface text-sm text-strong w-44 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
 aria-label="Filtra per nome crawler"
 />
 </div>
 <select
 value={crawlerChangeFilter}
 onChange={e => {
 const value = e.target.value as CrawlerChangeFilter;
 setCrawlerChangeFilter(value);
 replaceAdminQuery({ stato: crawlerChangeFilterToQuery(value) });
 }}
 className="px-2 py-1.5 rounded-stripe border border-edge bg-surface text-sm text-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
 aria-label="Filtra per tipo variazione"
 >
 <option value="all">Tutte le variazioni</option>
 <option value="new">Con aggiunti</option>
 <option value="updated">Con aggiornati</option>
 <option value="removed">Con rimossi</option>
 <option value="none">Nessuna variazione</option>
 <option value="failed">Falliti</option>
 <option value="in-progress">In corso</option>
 <option value="unchanged">Invariati</option>
 <option value="quality-low">Qualità bassa</option>
 </select>
 {(crawlerNameFilter || crawlerChangeFilter !== 'all') && (
 <button
 onClick={() => {
 setCrawlerNameFilter('');
 setCrawlerChangeFilter('all');
 setCrawlerSort({ column: 'schedule', direction: 'asc' });
 replaceAdminQuery({ q: null, stato: null, ordina: null, dir: null });
 }}
 className="min-h-10 px-2 text-sm text-link hover:underline"
 >
 Rimuovi filtri
 </button>
 )}
 </div>
 </div>

 {/* Table */}
 <div className="w-full overflow-x-auto rounded-stripe border border-edge">
 <table className="min-w-[800px] w-full text-sm tabular-nums">
 <thead>
 <tr className="bg-surface-alt/40 text-subtle border-b border-edge">
 <th className="text-left py-2 px-3 font-semibold">{renderCrawlerSortHeader('title', 'Crawler')}</th>
 <th className="text-center py-2 px-2 font-semibold whitespace-nowrap">{renderCrawlerSortHeader('schedule', 'Pianificazione', { align: 'center' })}</th>
 <th className="text-center py-2 px-2 font-semibold">{renderCrawlerSortHeader('lastRun', 'Ultimo', { align: 'center' })}</th>
 <th className="text-center py-2 px-1.5 font-semibold whitespace-nowrap" title="Nuove offerte aggiunte nell'ultima esecuzione del crawler (Δ run — distinto dal delta giornaliero del job board)">{renderCrawlerSortHeader('newCount', 'Aggiunti', { align: 'center' })}</th>
 <th className="text-center py-2 px-1.5 font-semibold whitespace-nowrap" title="Offerte aggiornate nell'ultima esecuzione del crawler (Δ run — distinto dal delta giornaliero del job board)">{renderCrawlerSortHeader('updatedCount', 'Aggiornati', { align: 'center' })}</th>
 <th className="text-center py-2 px-1.5 font-semibold whitespace-nowrap" title="Offerte rimosse nell'ultima esecuzione del crawler (Δ run — distinto dal delta giornaliero del job board)">{renderCrawlerSortHeader('removedCount', 'Rimossi', { align: 'center' })}</th>
 <th className="text-center py-2 px-1.5 font-semibold whitespace-nowrap" title="Offerte non cambiate nell'ultima esecuzione del crawler (Δ run — distinto dal delta giornaliero del job board)">{renderCrawlerSortHeader('unchangedCount', 'Invariati', { align: 'center' })}</th>
 <th className="text-center py-2 px-1.5 font-semibold whitespace-nowrap" title="Totale offerte attive nella slice del crawler (dal job slice, non dal delta dell'ultima run)">{renderCrawlerSortHeader('total', 'Attivi', { align: 'center' })}</th>
 <th className="text-center py-2 px-1.5 font-semibold whitespace-nowrap">{renderCrawlerSortHeader('duration', 'Durata', { align: 'center' })}</th>
 <th className="text-center py-2 px-1.5 font-semibold whitespace-nowrap" title="Quality score: media ponderata su pulizia testo, ricchezza contenuto, qualità traduzione, completezza dati (0–100)">{renderCrawlerSortHeader('quality', 'Qualità', { align: 'center' })}</th>
 <th className="text-center py-2 px-2 font-semibold">{renderCrawlerSortHeader('status', 'Stato', { align: 'center' })}</th>
 <th className="text-center py-2 px-2 font-semibold">Azioni</th>
 </tr>
 </thead>
 <tbody>
 {sorted.map(row => {
 const wfState = row.wf ? getWorkflowState(row.wf.id) : null;
 const isSuccess = wfState?.status === 'completed' && wfState.conclusion === 'success';
 const isFailure = wfState?.status === 'completed' && wfState.conclusion != null && wfState.conclusion !== 'success';
 const isRunning = isWorkflowRunDispatchLocked(wfState);
 // Post-consolidation (2026-07): `wfState` reflects the whole GROUP
 // workflow run (crawler-group-*.yml), shared by every crawler in that
 // group — `failedSteps` therefore includes sibling crawlers' failures
 // too. When we know this row's own crawler slug, narrow to just its own
 // "Run <slug>" background step so the failure detail shown for THIS
 // crawler isn't noisy with unrelated siblings' errors.
 const ownStepName = row.wf?.slug ? `Run ${row.wf.slug}` : null;
 const allFailedSteps = wfState?.jobs.flatMap(j => j.failedSteps.map(s => `${j.name}: ${s}`)) || [];
 const failedSteps = ownStepName
 ? allFailedSteps.filter(s => s.includes(ownStepName))
 : allFailedSteps;
 const lastRunAgo = wfState?.updatedAt ? relativeTime(wfState.updatedAt, true)
 : row.summary?.generatedAt ? relativeTime(row.summary.generatedAt, true) : null;
 const s = row.summary;
 const expanded = expandedCrawlerDetail[row.key] || null;

 return (
 <Fragment key={row.key}>
 <tr className={`border-b border-edge hover:bg-surface-alt/70 ${
 row.wf?.id === 'orchestrate-crawlers.yml' ? 'bg-accent-subtle/50'
 : isFailure ? 'bg-danger-subtle/50' : ''
 }`}>
 {/* Crawler name */}
 <td className="py-2 px-3" title={row.description}>
 <span className={`font-semibold ${row.wf?.id === 'orchestrate-crawlers.yml' ? 'text-accent' : 'text-strong'}`}>{row.title}</span>
 </td>
 {/* Schedule */}
 <td className="text-center py-2 px-2 font-mono text-sm text-subtle whitespace-nowrap">
 {row.schedule ? <span title={`UTC ${row.schedule}`}>{row.schedule}</span> : '—'}
 </td>
 {/* Last run */}
 <td className="text-center py-2 px-2 text-sm text-muted whitespace-nowrap">
 {lastRunAgo || '—'}
 </td>
 {/* Aggiunti */}
 <td className="text-center py-2 px-1.5">
 {s && s.newCount > 0 ? (
 <button onClick={() => toggleExpand(row.key, 'new')}
 className={`inline-flex items-center gap-0.5 text-success font-semibold hover:underline cursor-pointer ${expanded === 'new' ? 'underline' : ''}`}>
 {expanded === 'new' ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
 +{s.newCount}
 </button>
 ) : s ? (
 <span className="text-muted text-sm">0</span>
 ) : '—'}
 </td>
 {/* Aggiornati */}
 <td className="text-center py-2 px-1.5">
 {s && s.updatedCount > 0 ? (
 <button onClick={() => toggleExpand(row.key, 'updated')}
 className={`inline-flex items-center gap-0.5 text-accent font-semibold hover:underline cursor-pointer ${expanded === 'updated' ? 'underline' : ''}`}>
 {expanded === 'updated' ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
 ~{s.updatedCount}
 </button>
 ) : s ? (
 <span className="text-muted text-sm">0</span>
 ) : '—'}
 </td>
 {/* Rimossi */}
 <td className="text-center py-2 px-1.5">
 {s && s.removedCount > 0 ? (
 <button onClick={() => toggleExpand(row.key, 'removed')}
 className={`inline-flex items-center gap-0.5 text-danger font-semibold hover:underline cursor-pointer ${expanded === 'removed' ? 'underline' : ''}`}>
 {expanded === 'removed' ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
 -{s.removedCount}
 </button>
 ) : s ? (
 <span className="text-muted text-sm">0</span>
 ) : '—'}
 </td>
 {/* Invariati */}
 <td className="text-center py-2 px-1.5">
 {s && s.unchangedCount > 0 ? (
 <button onClick={() => toggleExpand(row.key, 'unchanged')}
 className={`inline-flex items-center gap-0.5 text-warning font-semibold hover:underline cursor-pointer ${expanded === 'unchanged' ? 'underline' : ''}`}>
 {expanded === 'unchanged' ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
 {s.unchangedCount}
 </button>
 ) : s ? (
 <span className="text-muted text-sm">0</span>
 ) : '—'}
 </td>
 {/* Annunci (attivi) — from actual job slice, not crawl-run delta */}
 <td className="text-center py-2 px-1.5">
 {s && s.activeJobCount > 0 ? (
 <button onClick={() => toggleExpand(row.key, 'active')}
 className={`inline-flex items-center gap-0.5 text-accent font-semibold hover:underline cursor-pointer ${expanded === 'active' ? 'underline' : ''}`}>
 {expanded === 'active' ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
 {s.activeJobCount}
 </button>
 ) : s ? (
 <span className="text-muted text-sm">0</span>
 ) : '—'}
 </td>
 {/* Durata */}
 <td className="text-center py-2 px-1.5">
 {s?.durationMs != null ? (
 <span className="text-sm font-mono text-subtle" title={s.avgDurationMs != null ? `Media: ${formatDurationMs(s.avgDurationMs)}` : undefined}>
 {formatDurationMs(s.durationMs)}
 {s.avgDurationMs != null && (
 <span className="block text-sm text-muted">ø {formatDurationMs(s.avgDurationMs)}</span>
 )}
 </span>
 ) : '—'}
 </td>
 {/* Quality Score (FRO-585) */}
 <td className="text-center py-2 px-1.5">
 {s?.qualityScore ? (() => {
 const qs = s.qualityScore;
 const avg = qs.avgScore;
 const badgeColor = avg >= 75
 ? 'bg-success-subtle text-success'
 : avg >= 50
 ? 'bg-warning-subtle text-warning'
 : 'bg-danger-subtle text-danger';
 const tooltipLines = [
 `Pulizia: ${qs.breakdown.cleanliness}/25`,
 `Ricchezza: ${qs.breakdown.richness}/25`,
 `Traduzione: ${qs.breakdown.translation}/25`,
 `Completezza: ${qs.breakdown.completeness}/25`,
 `---`,
 `Jobs analizzati: ${qs.jobCount}`,
 ...(qs.worstJobs.length > 0 ? [`Peggiori:`, ...qs.worstJobs.slice(0, 3).map((w: CrawlerQualityScore['worstJobs'][0]) => ` ${w.score}/100 — ${w.title}`)] : []),
 ].join('\n');
 return (
 <span
 className={`inline-flex items-center px-2 py-0.5 rounded-full text-sm font-semibold ${badgeColor} cursor-help`}
 title={tooltipLines}
 >
 {avg}
 </span>
 );
 })() : (
 <span className="text-muted text-sm">—</span>
 )}
 </td>
 {/* Status */}
 <td className="text-center py-2 px-2">
 {wfState ? (
 <AdminStatusPill tone={isSuccess ? 'success' : isFailure ? 'danger' : isRunning ? 'accent' : 'neutral'}>{isRunning ? 'In corso' : isSuccess ? 'OK' : isFailure ? 'Errore' : 'In attesa'}</AdminStatusPill>
 ) : (
 <span className="text-muted text-sm">—</span>
 )}
 </td>
 {/* Actions */}
 <td className="text-center py-2 px-2">
 {row.wf ? (
 <div className="inline-flex items-center gap-1.5">
 <AdminButton
 variant="primary"
 icon={<Play size={14} aria-hidden="true" />}
 loading={!!isRunning}
 loadingLabel="Avvio…"
 onClick={() => void runWorkflowWithConfirmation(row.wf!.id)}
 aria-label={`Avvia il gruppo ${row.wf?.groupId || row.wf?.id || row.title} con ${row.wf?.groupMemberCount || 1} crawler`}
 title={`Avvia il gruppo ${row.wf?.groupId || row.wf?.id || row.title} con ${row.wf?.groupMemberCount || 1} crawler`}
 >Avvia gruppo {row.wf?.groupId || row.wf?.id || row.title} · {row.wf?.groupMemberCount || 1} crawler</AdminButton>
 {wfState?.htmlUrl && (
 <a href={wfState.htmlUrl} target="_blank" rel="noreferrer"
 className="inline-flex min-h-10 items-center px-2 py-2 rounded-stripe border border-edge text-muted text-sm hover:bg-surface-raised transition-colors"
 aria-label={`GitHub ${row.title}`}>
 <ExternalLink size={10} />
 </a>
 )}
 {wfState?.error && (
 <CopyButton text={`${row.title}\n${wfState.error}\n${failedSteps.join(' | ')}`} label={`errore ${row.title}`} />
 )}
 </div>
 ) : (
 <span className="text-muted text-sm">—</span>
 )}
 </td>
 </tr>
 {/* Expanded job details row */}
 {expanded && s && (
 <tr>
 <td colSpan={12} className={`px-3 py-2 border-b border-edge ${
 expanded === 'new' ? 'bg-success-subtle/50'
 : expanded === 'updated' ? 'bg-accent-subtle/50'
 : expanded === 'unchanged' ? 'bg-warning-subtle/50'
 : expanded === 'active' ? 'bg-accent-subtle/50'
 : 'bg-danger-subtle/50'
 }`}>
 <div className="text-sm font-semibold text-body mb-1.5">
 {expanded === 'new' ? `Aggiunti (${s.newCount})`
 : expanded === 'updated' ? `Aggiornati (${s.updatedCount})`
 : expanded === 'unchanged' ? `Invariati (${s.unchangedCount}${s.unchangedCount > s.unchangedJobs.length ? ` — mostrati ${s.unchangedJobs.length}` : ''})`
 : expanded === 'active' ? <>Annunci attivi ({s.total - s.removedCount}) — <span className="text-success">{s.newCount} nuovi</span> / <span className="text-accent">{s.updatedCount} aggiornati</span> / <span className="text-warning">{s.unchangedCount} invariati</span></>
 : `Rimossi (${s.removedCount})`}
 </div>
 {renderExpandedJobs(
 expanded === 'new' ? s.newJobs
 : expanded === 'updated' ? s.updatedJobs
 : expanded === 'unchanged' ? s.unchangedJobs
 : expanded === 'active' ? [
 ...s.newJobs.map(j => ({ ...j, _status: 'new' as const })),
 ...s.updatedJobs.map(j => ({ ...j, _status: 'updated' as const })),
 ...s.unchangedJobs.map(j => ({ ...j, _status: 'unchanged' as const })),
 ]
 : s.removedJobs,
 expanded,
 )}
 </td>
 </tr>
 )}
 {/* Error detail row */}
 {isFailure && (wfState?.error || failedSteps.length > 0 || wfState?.logExcerpt) && (
 <tr>
 <td colSpan={12} className="px-3 py-2 bg-danger-subtle/50 border-b border-danger-border">
 <div className="space-y-1">
 {wfState.error && (
 <div className="flex items-start gap-2 text-sm text-danger">
 <AlertTriangle size={12} className="mt-0.5 shrink-0" />
 <span className="font-semibold">{wfState.error}</span>
 </div>
 )}
 {failedSteps.length > 0 && (
 <div className="text-sm text-danger pl-5">
 Step falliti: {failedSteps.slice(0, 4).join(' · ')}
 {failedSteps.length > 4 && <span className="text-danger"> (+{failedSteps.length - 4})</span>}
 </div>
 )}
 {wfState.logExcerpt && (
 <pre className="max-h-20 overflow-auto rounded-stripe bg-surface-inverted text-danger p-2 text-sm font-mono whitespace-pre-wrap break-words leading-relaxed border border-danger-border">
 {wfState.logExcerpt}
 </pre>
 )}
 </div>
 </td>
 </tr>
 )}
 </Fragment>
 );
 })}
 </tbody>
 </table>
 </div>
 </>
 );
 })()}
 </div>
 ) : (
 <div className="space-y-4">
 <div className="rounded-stripe border border-edge bg-surface-alt/40 px-3 py-2">
 <div className="text-sm font-semibold text-body">{meta.label}</div>
 <div className="text-sm text-muted mt-0.5">{meta.description}</div>
 </div>
 <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
 {grouped.map(renderWorkflowCard)}
 </div>
 </div>
 )}
 </div>
 </div>
 );
}
