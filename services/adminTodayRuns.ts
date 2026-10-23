import { localDateKey } from './adminCron';
import { createAdminGithubClient, type AdminGithubUser } from '@/components/admin/lib/githubClient';

export interface AdminTodayRun {
  id: number;
  workflowId: string | null;
  status: string;
  conclusion: string | null;
  event: string | null;
  createdAt: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  htmlUrl: string | null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function workflowIdFromRun(run: Record<string, unknown>): string | null {
  const path = stringOrNull(run.path);
  if (path) return path.split('/').at(-1) || null;
  const workflowId = run.workflow_id;
  return typeof workflowId === 'string' ? workflowId : null;
}

export function normalizeAdminTodayRun(run: Record<string, unknown>): AdminTodayRun | null {
  const id = Number(run.id);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  return {
    id,
    workflowId: workflowIdFromRun(run),
    status: String(run.status || 'unknown'),
    conclusion: run.conclusion ? String(run.conclusion) : null,
    event: stringOrNull(run.event),
    createdAt: stringOrNull(run.created_at),
    startedAt: stringOrNull(run.run_started_at),
    updatedAt: stringOrNull(run.updated_at),
    htmlUrl: stringOrNull(run.html_url),
  };
}

/**
 * Ask GitHub for a UTC window wide enough to contain the current Zurich civil
 * day. The UI filters the returned runs again by localDateKey, so the extra
 * margin also covers both DST transitions without weakening the proxy query.
 */
export function adminTodayRunsPath(now = new Date()): string {
  const earliest = new Date(now.getTime() - 36 * 60 * 60 * 1000).toISOString();
  return `/actions/runs?created=${encodeURIComponent(`>=${earliest}`)}&per_page=100&branch=main`;
}

export async function loadAdminTodayRuns(user: AdminGithubUser | null | undefined, now = new Date()): Promise<AdminTodayRun[]> {
  if (!user) return [];
  const github = createAdminGithubClient(user);
  const payload = await github.request('GET', adminTodayRunsPath(now));
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
  return runs.map((run: unknown) => normalizeAdminTodayRun(run as Record<string, unknown>)).filter((run): run is AdminTodayRun => Boolean(run));
}

export function runIsOnLocalDay(run: AdminTodayRun, day: string): boolean {
  const at = run.startedAt || run.createdAt || run.updatedAt;
  const timestamp = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(timestamp) && localDateKey(new Date(timestamp)) === day;
}

export function isCrawlerWorkflowId(workflowId: string | null | undefined): boolean {
  return workflowId === 'orchestrate-crawlers.yml' || /^crawler-group-\d+\.yml$/u.test(workflowId || '');
}

export function failedCrawlerRunCount(runs: readonly AdminTodayRun[], day: string): number {
  return new Set(
    runs
      .filter((run) => isCrawlerWorkflowId(run.workflowId) && runIsOnLocalDay(run, day) && run.status === 'completed' && run.conclusion !== 'success')
      .map((run) => run.workflowId)
      .filter((workflowId): workflowId is string => Boolean(workflowId)),
  ).size;
}
