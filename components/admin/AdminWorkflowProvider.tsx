import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '@/services/authService';
import { createAdminGithubClient, ADMIN_GITHUB_REPOSITORY } from './lib/githubClient';
import { formatDuration } from './lib/formatters';
import type { WorkflowActionDefinition, WorkflowContext, WorkflowJobSummary, WorkflowRunState } from './lib/adminTypes';
import {
  classifyWorkflowRunUiOutcome,
  dispatchWorkflowOnce,
  isWorkflowRunDispatchLocked,
  mergeWorkflowSnapshotState,
  planWorkflowSnapshotRead,
  validateWorkflowDispatchRun,
  workflowDispatchErrorIdentity,
  WorkflowDispatchError,
} from '../../scripts/lib/githubWorkflowDispatch.mjs';

export type AdminWorkflowContext = WorkflowContext;
export type AdminWorkflowImpact = 'lettura' | 'modifica dati' | 'pubblicazione';
export type AdminWorkflowRunState = WorkflowRunState;

export interface AdminWorkflowDispatchErrorShape {
  ambiguous: boolean;
  runId: number | null;
  htmlUrl: string | null;
}

export class AdminWorkflowDispatchError extends Error implements AdminWorkflowDispatchErrorShape {
  ambiguous: boolean;
  runId: number | null;
  htmlUrl: string | null;

  constructor(message: string, ambiguous: boolean, runId: number | null = null, htmlUrl: string | null = null) {
    super(message);
    this.name = 'AdminWorkflowDispatchError';
    this.ambiguous = ambiguous;
    this.runId = runId;
    this.htmlUrl = htmlUrl;
  }
}

export interface AdminWorkflowContextValue {
  actions: readonly WorkflowActionDefinition[];
  workflowStates: Readonly<Record<string, WorkflowRunState>>;
  getWorkflowState: (workflowId: string) => WorkflowRunState;
  getSummary: (context: WorkflowContext) => { ok: number; error: number; pending: number };
  isRunning: (workflowId: string) => boolean;
  runWorkflowAction: (workflowId: string, inputs?: Record<string, string>, options?: { deferMonitoring?: boolean }) => Promise<WorkflowRunState>;
  monitorWorkflowRun: (workflowId: string, runId: number, initialHtmlUrl: string | null, initialState: WorkflowRunState) => Promise<WorkflowRunState>;
  runWorkflowWithConfirmation: (workflowId: string, inputs?: Record<string, string>) => Promise<WorkflowRunState | null>;
  dispatchWorkflow: (workflowId: string, inputs?: Record<string, string>) => Promise<{ runId: number; run: Record<string, unknown> }>;
  refresh: (context?: WorkflowContext) => Promise<void>;
  setCrawlerWorkflows: (actions: WorkflowActionDefinition[]) => void;
  buildAiPromptForWorkflow: (workflow: WorkflowActionDefinition, state: WorkflowRunState) => string;
  copyAiFixRequest: (workflowId: string) => Promise<void>;
  openAiFixRequest: (workflowId: string) => void;
  classifyOutcome: typeof classifyWorkflowRunUiOutcome;
}

export const ADMIN_WORKFLOW_ACTIONS: readonly WorkflowActionDefinition[] = [
  {
    id: 'generate-article.yml',
    title: 'Genera nuovo articolo',
    context: 'content',
    impact: 'pubblicazione',
    description: 'Avvia la pipeline editoriale automatica per un nuovo articolo.',
    details: 'Seleziona una notizia o tema evergreen, genera contenuti multi-lingua e aggiorna sitemap.',
    expectedDuration: '8-30 min',
  },
  {
    id: 'update-unemployment-rate.yml',
    title: 'Aggiorna tasso disoccupazione CH',
    context: 'analytics',
    impact: 'modifica dati',
    description: 'Aggiorna automaticamente il dataset statistico Svizzera.',
    details: 'Utile quando vuoi forzare un aggiornamento dati prima del run schedulato.',
    expectedDuration: '2-8 min',
  },
  {
    id: 'analytics.yml',
    title: 'Report analytics',
    context: 'analytics',
    impact: 'lettura',
    description: 'Report completo: traffico, GSC, indicizzazione, Core Web Vitals.',
    details: 'Genera report settimanale con segnali utili per decisioni prodotto/SEO.',
    expectedDuration: '10-30 min',
    defaultInputs: { days: '30', sections: 'all' },
  },
  {
    id: 'seo-serp-autopilot.yml',
    title: 'SEO SERP Autopilot',
    context: 'seo',
    impact: 'modifica dati',
    description: 'Analizza SERP, trova opportunità e applica esperimenti SEO.',
    details: 'Anticipa il run settimanale per vedere subito suggerimenti/azioni.',
    expectedDuration: '10-30 min',
    defaultInputs: { days: '28', dry_run: 'false' },
  },
  {
    id: 'adsense-prereview.yml',
    title: 'Controllo AdSense',
    context: 'seo',
    impact: 'lettura',
    description: 'Checklist qualità contenuti pre-review AdSense.',
    details: 'Identifica pagine thin/deboli e segnali policy a rischio rifiuto.',
    expectedDuration: '8-20 min',
    defaultInputs: { sample: '140', strict: 'true' },
  },
];

export const WORKFLOW_CONTEXT_META: Record<WorkflowContext, { label: string; description: string }> = {
  jobs: { label: 'Lavoro & Crawler', description: 'Aggiornamenti offerte, validazione nuove aziende e qualità del catalogo lavori.' },
  content: { label: 'Contenuti editoriali', description: 'Generazione e refresh contenuti per mantenere il sito aggiornato e indicizzabile.' },
  seo: { label: 'SEO & Qualità', description: 'Controlli pre-review e automazioni SEO per migliorare visibilità e conformità.' },
  analytics: { label: 'Analytics & Dati', description: 'Aggiornamento dataset e report per capire traffico e comportamento utenti.' },
};

function emptyState(): WorkflowRunState {
  return {
    loading: false, runId: null, runNumber: null, status: 'idle', conclusion: null, htmlUrl: null,
    startedAt: null, updatedAt: null, completedAt: null, durationSeconds: null, message: null,
    error: null, jobs: [], logExcerpt: null, aiPrompt: null,
  };
}

function normalizeJob(job: any): WorkflowJobSummary {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  return {
    id: Number(job?.id || 0), name: String(job?.name || 'Job'), status: String(job?.status || 'unknown'),
    conclusion: String(job?.conclusion || ''), totalSteps: steps.length,
    completedSteps: steps.filter((step: any) => String(step?.status || '') === 'completed').length,
    failedSteps: steps.filter((step: any) => String(step?.conclusion || '') === 'failure').map((step: any) => String(step?.name || 'step fallito')),
  };
}

function expectedWorkflowTimeoutMs(expectedDuration: string): number {
  const values = [...expectedDuration.matchAll(/(\d+(?:\.\d+)?)\s*(?:-|–)\s*(\d+(?:\.\d+)?)\s*min/gi)].flatMap((match) => [Number(match[1]), Number(match[2])]).filter(Number.isFinite);
  const fallback = [...expectedDuration.matchAll(/(\d+(?:\.\d+)?)\s*min/gi)].map((match) => Number(match[1])).filter(Number.isFinite);
  const expectedMinutes = Math.max(...(values.length ? values : fallback), 30);
  return Math.min(120 * 60_000, Math.max(15 * 60_000, Math.ceil(expectedMinutes * 1.5 * 60_000)));
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return String(value || '').replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '');
}

const AdminWorkflowContextObject = createContext<AdminWorkflowContextValue | null>(null);

export function AdminWorkflowProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const client = useMemo(() => createAdminGithubClient(user), [user]);
  const [workflowStates, setWorkflowStates] = useState<Record<string, WorkflowRunState>>({});
  const [crawlerWorkflows, setCrawlerWorkflowsState] = useState<WorkflowActionDefinition[]>([]);
  const stateRef = useRef<Record<string, WorkflowRunState>>({});
  const actionsRef = useRef<WorkflowActionDefinition[]>([]);
  const mountedRef = useRef(true);
  const refreshFlightRef = useRef<Promise<void> | null>(null);
  const pollingControllersRef = useRef(new Map<string, AbortController>());

  useEffect(() => () => {
    mountedRef.current = false;
    pollingControllersRef.current.forEach((controller) => controller.abort());
    pollingControllersRef.current.clear();
  }, []);

  const actions = useMemo(() => {
    const ids = new Set(ADMIN_WORKFLOW_ACTIONS.map((action) => action.id));
    return [...ADMIN_WORKFLOW_ACTIONS, ...crawlerWorkflows.filter((action) => !ids.has(action.id))];
  }, [crawlerWorkflows]);
  useEffect(() => { actionsRef.current = actions; }, [actions]);

  const setWorkflowState = useCallback((workflowId: string, patch: Partial<WorkflowRunState>) => {
    if (!mountedRef.current) return;
    const current = stateRef.current[workflowId] || emptyState();
    const next = { ...current, ...patch };
    stateRef.current = { ...stateRef.current, [workflowId]: next };
    setWorkflowStates((previous) => ({ ...previous, [workflowId]: next }));
  }, []);

  const mergeWorkflowState = useCallback((workflowId: string, snapshotState: Partial<WorkflowRunState>) => {
    if (!mountedRef.current) return;
    const current = stateRef.current[workflowId] || emptyState();
    const snapshot = { ...current, ...snapshotState };
    const next = mergeWorkflowSnapshotState(current, snapshot);
    stateRef.current = { ...stateRef.current, [workflowId]: next };
    setWorkflowStates((previous) => ({ ...previous, [workflowId]: next }));
  }, []);

  const getWorkflowState = useCallback((workflowId: string) => stateRef.current[workflowId] || emptyState(), []);
  const getWorkflowDef = useCallback((workflowId: string): WorkflowActionDefinition => actionsRef.current.find((action) => action.id === workflowId) || {
    id: workflowId, title: workflowId, context: 'jobs', description: 'Workflow manuale', details: 'Workflow custom avviato dal pannello Admin.', expectedDuration: 'variabile',
  }, []);

  const request = useCallback(async (method: string, endpoint: string, body?: Record<string, unknown>, signal?: AbortSignal) => {
    const result = await client.requestWithStatus(method, endpoint, body, signal);
    if (result.status < 200 || result.status >= 300 || !result.body?.ok) throw new Error(String(result.body?.message || result.body?.error || `GitHub API ${result.status}`));
    return result.body.data;
  }, [client]);

  const requestWithStatus = useCallback(async (method: string, endpoint: string, body?: Record<string, unknown>, signal?: AbortSignal) => {
    const result = await client.requestWithStatus(method, endpoint, body, signal);
    return { status: result.status, body: result.body?.data ?? result.body };
  }, [client]);

  const sleep = useCallback((milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds);
    if (!signal) return;
    const onAbort = () => { window.clearTimeout(timer); reject(new DOMException('Polling interrotto', 'AbortError')); };
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  }), []);

  const buildAiPromptForWorkflow = useCallback((workflow: WorkflowActionDefinition, state: WorkflowRunState) => {
    const failedJobs = state.jobs.filter((job) => String(job.conclusion) === 'failure');
    const failedSteps = failedJobs.flatMap((job) => job.failedSteps.map((step) => `${job.name}: ${step}`));
    return [
      `Sto eseguendo il workflow GitHub"${workflow.title}" (${workflow.id}) del repo Frontaliere Ticino.`,
      `Run URL: ${state.htmlUrl || 'n/d'}`, `Run ID: ${state.runId || 'n/d'} | Run number: ${state.runNumber || 'n/d'}`,
      `Status: ${state.status} | Conclusion: ${state.conclusion || 'n/d'}`, `Messaggio errore: ${state.error || 'n/d'}`,
      `Durata: ${formatDuration(state.durationSeconds)}`, failedSteps.length ? `Step falliti: ${failedSteps.join(' | ')}` : 'Step falliti: n/d',
      state.logExcerpt ? `Estratto log:\n${state.logExcerpt}` : 'Estratto log: non disponibile', '', 'Mi proponi una fix concreta con patch minima e test di verifica?',
    ].join('\n');
  }, []);

  const fetchRunJobs = useCallback(async (runId: number, signal?: AbortSignal): Promise<WorkflowJobSummary[]> => {
    const json = await request('GET', `/repos/${ADMIN_GITHUB_REPOSITORY}/actions/runs/${runId}/jobs?per_page=100`, undefined, signal);
    return Array.isArray(json?.jobs) ? json.jobs.map(normalizeJob) : [];
  }, [request]);

  const fetchLogExcerpt = useCallback(async (jobId: number | null, signal?: AbortSignal): Promise<string | null> => {
    if (!jobId) return null;
    try {
      const raw = await request('GET', `/repos/${ADMIN_GITHUB_REPOSITORY}/actions/jobs/${jobId}/logs`, undefined, signal);
      const cleaned = stripAnsi(String(typeof raw === 'string' ? raw : raw?.text || '').replace(/\r/g, '\n'));
      return cleaned.trim() ? cleaned.split('\n').filter(Boolean).slice(-150).join('\n').slice(-12000) : null;
    } catch { return null; }
  }, [request]);

  const dispatchWorkflow = useCallback(async (workflowId: string, inputs: Record<string, string> = {}) => {
    const workflow = getWorkflowDef(workflowId);
    const requestDispatch = async ({ method, path, body }: { method: string; path: string; body?: Record<string, unknown> }) => {
      const prefix = `/repos/${ADMIN_GITHUB_REPOSITORY}`;
      if (!path.startsWith(prefix)) throw new Error('Percorso repository non consentito.');
      return requestWithStatus(method, path.slice(prefix.length) || '/', body);
    };
    try {
      return await dispatchWorkflowOnce({
        repository: ADMIN_GITHUB_REPOSITORY, workflowFile: workflow.id, ref: 'main', inputs: { ...(workflow.defaultInputs || {}), ...inputs },
        request: requestDispatch, sleep: (milliseconds: number) => sleep(milliseconds),
      }) as { runId: number; run: Record<string, unknown> };
    } catch (error) {
      const identity = workflowDispatchErrorIdentity(error);
      if (identity.runId !== null && identity.htmlUrl !== null) throw new AdminWorkflowDispatchError(`GitHub ha creato il run ${identity.runId}, ma non è stato possibile verificarne il binding. Non ricliccare: controlla il run in Actions (${identity.htmlUrl}).`, true, identity.runId, identity.htmlUrl);
      if (error instanceof WorkflowDispatchError && error.status === 403) throw new AdminWorkflowDispatchError('GitHub API 403: il PAT configurato non ha i permessi per avviare workflow. Verifica Actions (Read & Write) e Contents (Read & Write).', false);
      if (error instanceof WorkflowDispatchError && error.status === 404) throw new AdminWorkflowDispatchError(`Workflow GitHub non trovato: ${workflowId}. Verifica che il file sia presente su origin/main.`, false);
      throw new AdminWorkflowDispatchError('GitHub non ha confermato il risultato del dispatch: il workflow potrebbe essere partito. Non ricliccare; controlla GitHub Actions prima di riprovare.', true);
    }
  }, [getWorkflowDef, requestWithStatus, sleep]);

  const monitorWorkflowRun = useCallback(async (workflowId: string, workflow: WorkflowActionDefinition, runId: number, initialHtmlUrl: string | null, initialState: WorkflowRunState, controller: AbortController): Promise<WorkflowRunState> => {
    let latestState = initialState;
    let knownRunHtmlUrl = initialHtmlUrl;
    const startedPollingAt = Date.now();
    try {
      for (let attempt = 0; Date.now() - startedPollingAt < expectedWorkflowTimeoutMs(workflow.expectedDuration); attempt += 1) {
        if (controller.signal.aborted || !mountedRef.current) return latestState;
        const run = await request('GET', `/repos/${ADMIN_GITHUB_REPOSITORY}/actions/runs/${runId}`, undefined, controller.signal);
        const jobs = await fetchRunJobs(runId, controller.signal);
        const startedAt = String(run?.run_started_at || run?.created_at || '') || null;
        const updatedAt = String(run?.updated_at || '') || null;
        const durationSeconds = startedAt && updatedAt ? Math.max(0, Math.round((Date.parse(updatedAt) - Date.parse(startedAt)) / 1000)) : null;
        const failedJobs = jobs.filter((job) => String(job.conclusion) === 'failure');
        const completedJobs = jobs.filter((job) => String(job.status) === 'completed').length;
        const status = String(run?.status || 'unknown');
        knownRunHtmlUrl = String(run?.html_url || knownRunHtmlUrl || '');
        const patch: Partial<WorkflowRunState> = {
          status, conclusion: run?.conclusion ? String(run.conclusion) : null, htmlUrl: knownRunHtmlUrl || null, startedAt, updatedAt,
          completedAt: status === 'completed' ? updatedAt : null, durationSeconds, jobs,
          message: status === 'completed' ? `Job completati ${completedJobs}/${jobs.length}${failedJobs.length ? ` · falliti ${failedJobs.length}` : ''}` : `In esecuzione… Job completati ${completedJobs}/${jobs.length}`,
        };
        latestState = { ...latestState, ...patch };
        setWorkflowState(workflowId, patch);
        if (status === 'completed') {
          const primaryJobId = failedJobs[0]?.id || jobs[0]?.id || null;
          const logExcerpt = await fetchLogExcerpt(primaryJobId, controller.signal);
          const errorMessage = String(run?.conclusion || '') !== 'success' ? failedJobs.length > 0 ? `Step critici: ${failedJobs.flatMap((job) => job.failedSteps).slice(0, 6).join(' | ') || 'vedi log run'}` : `Conclusione workflow: ${String(run?.conclusion || 'failure')}` : null;
          const finalState = { ...latestState, loading: false, error: errorMessage, logExcerpt };
          setWorkflowState(workflowId, { loading: false, error: errorMessage, logExcerpt, aiPrompt: errorMessage ? buildAiPromptForWorkflow(workflow, finalState) : null });
          return finalState;
        }
        await sleep(Math.min(30_000, 6_000 + attempt * 2_000), controller.signal);
      }
      const timeoutState = { loading: false, status: 'unknown', error: 'Run avviato, ma monitoraggio scaduto: esito da verificare in GitHub Actions.' };
      setWorkflowState(workflowId, timeoutState);
      return { ...latestState, ...timeoutState };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return latestState;
      const message = error instanceof Error ? error.message : 'Errore monitoraggio workflow.';
      const next = { loading: false, status: 'unknown', error: message, message: 'Esito da verificare in GitHub Actions.' };
      setWorkflowState(workflowId, next);
      return { ...latestState, ...next };
    }
  }, [buildAiPromptForWorkflow, fetchLogExcerpt, fetchRunJobs, request, setWorkflowState, sleep]);

  const runWorkflowAction = useCallback(async (workflowId: string, inputs: Record<string, string> = {}, options: { deferMonitoring?: boolean } = {}) => {
    const workflow = getWorkflowDef(workflowId);
    const initial: WorkflowRunState = { ...emptyState(), loading: true, status: 'dispatching', message: 'Invio richiesta a GitHub Actions…' };
    setWorkflowState(workflowId, initial);
    let knownRunId: number | null = null;
    let knownRunHtmlUrl: string | null = null;
    try {
      const result = await dispatchWorkflow(workflowId, inputs);
      knownRunId = Number(result.runId) || null;
      knownRunHtmlUrl = String(result.run?.html_url || '') || null;
      const next = { ...initial, loading: false, runId: knownRunId, runNumber: Number(result.run?.run_number || 0) || null, status: String(result.run?.status || 'queued'), htmlUrl: knownRunHtmlUrl, updatedAt: String(result.run?.updated_at || '') || null, message: 'Run avviato. Monitoraggio disponibile in GitHub Actions.' };
      setWorkflowState(workflowId, next);
      if (options.deferMonitoring || !knownRunId) return next;
      const controller = new AbortController();
      pollingControllersRef.current.set(workflowId, controller);
      try { return await monitorWorkflowRun(workflowId, workflow, knownRunId, knownRunHtmlUrl, next, controller); }
      finally { pollingControllersRef.current.delete(workflowId); }
    } catch (error) {
      const identity = error instanceof AdminWorkflowDispatchError ? { runId: error.runId, htmlUrl: error.htmlUrl } : { runId: knownRunId, htmlUrl: knownRunHtmlUrl };
      const dispatchAmbiguous = error instanceof AdminWorkflowDispatchError && error.ambiguous;
      const message = error instanceof Error ? error.message : 'Errore sconosciuto';
      const failedState = { ...initial, loading: false, status: dispatchAmbiguous ? 'unknown' : 'error', error: message, message: dispatchAmbiguous ? 'Esito da verificare in GitHub Actions.' : 'Avvio non riuscito', runId: identity.runId, htmlUrl: identity.htmlUrl, aiPrompt: dispatchAmbiguous ? buildAiPromptForWorkflow(workflow, { ...initial, ...identity, status: 'unknown', error: message }) : null };
      setWorkflowState(workflowId, failedState);
      return failedState;
    }
  }, [buildAiPromptForWorkflow, dispatchWorkflow, getWorkflowDef, monitorWorkflowRun, setWorkflowState]);

  const monitorWorkflowRunPublic = useCallback((workflowId: string, runId: number, initialHtmlUrl: string | null, initialState: WorkflowRunState) => {
    const controller = new AbortController();
    pollingControllersRef.current.set(workflowId, controller);
    const workflow = getWorkflowDef(workflowId);
    return monitorWorkflowRun(workflowId, workflow, runId, initialHtmlUrl, initialState, controller)
      .finally(() => pollingControllersRef.current.delete(workflowId));
  }, [getWorkflowDef, monitorWorkflowRun]);

  const runWorkflowWithConfirmation = useCallback(async (workflowId: string, inputs: Record<string, string> = {}) => {
    const workflow = getWorkflowDef(workflowId);
    if (isWorkflowRunDispatchLocked(getWorkflowState(workflowId))) return null;
    const needsConfirmation = workflowId === 'orchestrate-crawlers.yml'
      || workflowId === 'generate-article.yml'
      || (workflowId === 'seo-serp-autopilot.yml' && inputs.dry_run === 'false')
      || workflow.context === 'jobs';
    if (needsConfirmation && typeof window !== 'undefined') {
      const inputSummary = Object.entries({ ...(workflow.defaultInputs || {}), ...inputs }).map(([key, value]) => `${key}=${value}`).join(', ') || 'nessuno';
      const impact = workflowId === 'orchestrate-crawlers.yml'
        ? 'Avvierà il gruppo orchestratore e potrà modificare i dati dei crawler.'
        : workflowId === 'generate-article.yml'
          ? 'Genererà e pubblicherà contenuti multi-lingua.'
          : workflowId === 'seo-serp-autopilot.yml' && inputs.dry_run === 'false'
            ? 'Applicherà le azioni SEO previste dal workflow.'
            : 'Avvierà un run GitHub Actions con effetti sui dati del sito.';
      if (!window.confirm(`${workflow.title}\n\nImpatto: ${impact}\nInput: ${inputSummary}\nDurata attesa: ${workflow.expectedDuration}\n\nProcedere?`)) return null;
    }
    return runWorkflowAction(workflowId, inputs);
  }, [getWorkflowDef, getWorkflowState, runWorkflowAction]);

  const refresh = useCallback(async (context?: WorkflowContext) => {
    if (refreshFlightRef.current) return refreshFlightRef.current;
    const flight = (async () => {
      const candidates = actionsRef.current.filter((action) => (!context || action.context === context) && !action.isUtility);
      const seenIds = new Set<string>();
      await Promise.all(candidates.filter((action) => { if (seenIds.has(action.id)) return false; seenIds.add(action.id); return true; }).map(async (workflow) => {
        try {
          const current = getWorkflowState(workflow.id);
          const snapshotRead = planWorkflowSnapshotRead(current);
          if (snapshotRead.mode === 'skip') return;
          const run = snapshotRead.mode === 'exact'
            ? await request('GET', `/repos/${ADMIN_GITHUB_REPOSITORY}/actions/runs/${snapshotRead.runId}`)
            : (await request('GET', `/repos/${ADMIN_GITHUB_REPOSITORY}/actions/workflows/${workflow.id}/runs?per_page=20`))?.workflow_runs?.[0];
          if (!run) return;
          const runId = Number(run.id || 0);
          if (snapshotRead.mode === 'exact') {
            const validation = validateWorkflowDispatchRun(run, { repository: ADMIN_GITHUB_REPOSITORY, workflowFile: workflow.id, ref: 'main', runId: snapshotRead.runId });
            if (!validation.valid) return;
          }
          const jobs = runId ? await fetchRunJobs(runId) : [];
          const startedAt = String(run.run_started_at || run.created_at || '') || null;
          const updatedAt = String(run.updated_at || '') || null;
          const failedJobs = jobs.filter((job) => String(job.conclusion) === 'failure');
          const error = String(run.conclusion || '') !== 'success' && String(run.status || '') === 'completed' ? failedJobs.length > 0 ? `Step critici: ${failedJobs.flatMap((job) => job.failedSteps).slice(0, 6).join(' | ') || 'vedi log run'}` : `Conclusione workflow: ${String(run.conclusion || 'failure')}` : null;
          mergeWorkflowState(workflow.id, { runId: runId || null, runNumber: Number(run.run_number || 0) || null, htmlUrl: String(run.html_url || '') || null, status: String(run.status || 'idle'), conclusion: run.conclusion ? String(run.conclusion) : null, startedAt, updatedAt, completedAt: String(run.status || '') === 'completed' ? updatedAt : null, durationSeconds: startedAt && updatedAt ? Math.max(0, Math.round((Date.parse(updatedAt) - Date.parse(startedAt)) / 1000)) : null, jobs, error, message: jobs.length ? `Ultimo run: ${jobs.filter((job) => String(job.status) === 'completed').length}/${jobs.length} job completati${failedJobs.length ? ` · ${failedJobs.length} falliti` : ''}` : 'Ultimo run disponibile' });
        } catch {
          // Preserve a previous snapshot when one workflow cannot be read.
        }
      }));
    })().finally(() => { if (refreshFlightRef.current === flight) refreshFlightRef.current = null; });
    refreshFlightRef.current = flight;
    return flight;
  }, [fetchRunJobs, getWorkflowState, mergeWorkflowState, request]);

  const copyAiFixRequest = useCallback(async (workflowId: string) => {
    const workflow = getWorkflowDef(workflowId);
    const state = getWorkflowState(workflowId);
    const payload = state.aiPrompt || buildAiPromptForWorkflow(workflow, state);
    try { await navigator.clipboard.writeText(payload); setWorkflowState(workflowId, { message: 'Richiesta fix copiata negli appunti.' }); }
    catch { setWorkflowState(workflowId, { message: 'Popup bloccato: richiesta AI copiata negli appunti.' }); }
  }, [buildAiPromptForWorkflow, getWorkflowDef, getWorkflowState, setWorkflowState]);

  const openAiFixRequest = useCallback((workflowId: string) => {
    const workflow = getWorkflowDef(workflowId);
    const state = getWorkflowState(workflowId);
    const payload = state.aiPrompt || buildAiPromptForWorkflow(workflow, state);
    const encoded = encodeURIComponent(payload);
    const win = window.open(`https://chatgpt.com/?q=${encoded}`, '_blank', 'noopener,noreferrer');
    if (!win) void navigator.clipboard.writeText(payload).catch(() => undefined);
  }, [buildAiPromptForWorkflow, getWorkflowDef, getWorkflowState]);

  const getSummary = useCallback((context: WorkflowContext) => {
    const seenIds = new Set<string>();
    const states = actions.filter((action) => {
      if (action.context !== context || action.isUtility || seenIds.has(action.id)) return false;
      seenIds.add(action.id);
      return true;
    }).map((action) => getWorkflowState(action.id));
    return {
      ok: states.filter((state) => state.status === 'completed' && state.conclusion === 'success').length,
      error: states.filter((state) => state.status === 'error' || (state.status === 'completed' && state.conclusion && state.conclusion !== 'success')).length,
      pending: states.filter((state) => isWorkflowRunDispatchLocked(state)).length,
    };
  }, [actions, getWorkflowState]);

  const value = useMemo<AdminWorkflowContextValue>(() => ({
    actions, workflowStates, getWorkflowState, getSummary,
    isRunning: (workflowId) => isWorkflowRunDispatchLocked(getWorkflowState(workflowId)),
    runWorkflowAction, monitorWorkflowRun: monitorWorkflowRunPublic, runWorkflowWithConfirmation, dispatchWorkflow, refresh,
    setCrawlerWorkflows: setCrawlerWorkflowsState, buildAiPromptForWorkflow, copyAiFixRequest, openAiFixRequest,
    classifyOutcome: classifyWorkflowRunUiOutcome,
  }), [actions, buildAiPromptForWorkflow, copyAiFixRequest, dispatchWorkflow, getSummary, getWorkflowState, monitorWorkflowRunPublic, openAiFixRequest, refresh, runWorkflowAction, runWorkflowWithConfirmation, workflowStates]);

  return <AdminWorkflowContextObject.Provider value={value}>{children}</AdminWorkflowContextObject.Provider>;
}

export function useAdminWorkflow(): AdminWorkflowContextValue {
  const context = useContext(AdminWorkflowContextObject);
  if (!context) throw new Error('useAdminWorkflow deve essere usato dentro AdminWorkflowProvider.');
  return context;
}
