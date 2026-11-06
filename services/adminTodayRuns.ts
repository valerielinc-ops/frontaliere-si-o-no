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

export interface AdminTodayRunsResult {
  runs: AdminTodayRun[];
  truncated: boolean;
  totalFetched: number;
}

export const ADMIN_TODAY_RUNS_PAGE_SIZE = 100;
export const ADMIN_TODAY_RUNS_MAX_PAGES = 10;

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
export function adminTodayRunsPath(now = new Date(), page = 1): string {
  const earliest = new Date(now.getTime() - 36 * 60 * 60 * 1000).toISOString();
  const safePage = Number.isInteger(page) && page >= 1 && page <= ADMIN_TODAY_RUNS_MAX_PAGES ? page : 1;
  const pageQuery = safePage === 1 ? '' : `&page=${safePage}`;
  return `/actions/runs?created=${encodeURIComponent(`>=${earliest}`)}&per_page=${ADMIN_TODAY_RUNS_PAGE_SIZE}&branch=main${pageQuery}`;
}

export async function loadAdminTodayRuns(user: AdminGithubUser | null | undefined, now = new Date()): Promise<AdminTodayRunsResult> {
  if (!user) return { runs: [], truncated: false, totalFetched: 0 };
  const github = createAdminGithubClient(user);
  const earliestMs = now.getTime() - 36 * 60 * 60 * 1000;
  const runsById = new Map<number, AdminTodayRun>();
  let truncated = false;

  for (let page = 1; page <= ADMIN_TODAY_RUNS_MAX_PAGES; page += 1) {
    const payload = await github.request('GET', adminTodayRunsPath(now, page));
    const rawRuns = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
    for (const rawRun of rawRuns) {
      const rawRecord = recordOrNull(rawRun);
      if (!rawRecord) continue;
      const run = normalizeAdminTodayRun(rawRecord);
      if (run) runsById.set(run.id, run);
    }

    const totalCount = Number(payload?.total_count);
    const hasOlderRun = rawRuns.some((rawRun: unknown) => {
      const rawRecord = recordOrNull(rawRun);
      if (!rawRecord) return false;
      const createdAt = rawRecord.created_at;
      return typeof createdAt === 'string' && Number.isFinite(Date.parse(createdAt)) && Date.parse(createdAt) < earliestMs;
    });
    const reachedTotal = Number.isSafeInteger(totalCount) && totalCount <= page * ADMIN_TODAY_RUNS_PAGE_SIZE;
    if (rawRuns.length < ADMIN_TODAY_RUNS_PAGE_SIZE || reachedTotal || hasOlderRun) break;
    if (page === ADMIN_TODAY_RUNS_MAX_PAGES) {
      truncated = true;
      break;
    }
  }

  const runs = [...runsById.values()];
  return { runs, truncated, totalFetched: runs.length };
}

export function adminTodayRunsTruncationNotice(result: Pick<AdminTodayRunsResult, 'truncated' | 'totalFetched'>): string | null {
  return result.truncated
    ? `Esecuzioni troncate: mostrate le più recenti ${result.totalFetched.toLocaleString('it-IT')}.`
    : null;
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
