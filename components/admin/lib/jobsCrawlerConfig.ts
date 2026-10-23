import type { JobsCrawlerConfigMeta, JobsCrawlerConfigState, WorkflowActionDefinition, WorkflowContext, CrawlerSummaryRow } from './adminTypes';
import {
  JOBS_CRAWLER_CONFIG_DEFAULTS,
  JOBS_CRAWLER_CONFIG_LIMITS,
} from '../../../functions/src/jobsCrawlerConfig.js';

export { JOBS_CRAWLER_CONFIG_LIMITS };
import {
  DEFAULT_WORKFLOW_EXPECTED_DURATION,
  isExpectedWorkflowDuration,
} from '@/services/adminWorkflowTimeout';

export const ADMIN_JOBS_CRAWLER_CONFIG_ENDPOINT = 'https://europe-west6-frontaliere-ticino.cloudfunctions.net/adminJobsCrawlerConfig/';

function cloneSeedMap(input: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(input).map(([key, seeds]) => [key, [...seeds]]));
}

export const DEFAULT_JOBS_CRAWLER_CONFIG: JobsCrawlerConfigState = {
  domainWhitelist: [...JOBS_CRAWLER_CONFIG_DEFAULTS.domainWhitelist],
  domainBlacklist: [...JOBS_CRAWLER_CONFIG_DEFAULTS.domainBlacklist],
  minQualityScore: JOBS_CRAWLER_CONFIG_DEFAULTS.minQualityScore,
  minDescriptionChars: JOBS_CRAWLER_CONFIG_DEFAULTS.minDescriptionChars,
  aiLocalizationEnabled: JOBS_CRAWLER_CONFIG_DEFAULTS.aiLocalizationEnabled,
  aiLocalizationMaxJobsPerRun: JOBS_CRAWLER_CONFIG_DEFAULTS.aiLocalizationMaxJobsPerRun,
  contentReuseEnabled: JOBS_CRAWLER_CONFIG_DEFAULTS.contentReuse.enabled,
  contentReuseSimilarityThreshold: JOBS_CRAWLER_CONFIG_DEFAULTS.contentReuse.similarityThreshold,
  contentReuseMinSourceChars: JOBS_CRAWLER_CONFIG_DEFAULTS.contentReuse.minSourceChars,
  contentReuseMaxLengthDeltaRatio: JOBS_CRAWLER_CONFIG_DEFAULTS.contentReuse.maxLengthDeltaRatio,
  companyPriorityByDomain: { ...JOBS_CRAWLER_CONFIG_DEFAULTS.companyPriority.byDomain },
  companyPriorityByName: { ...JOBS_CRAWLER_CONFIG_DEFAULTS.companyPriority.byName },
  sourceSeedsByDomain: cloneSeedMap(JOBS_CRAWLER_CONFIG_DEFAULTS.sourceSeeds.byDomain),
  sourceSeedsByName: cloneSeedMap(JOBS_CRAWLER_CONFIG_DEFAULTS.sourceSeeds.byName),
};

export function parseListInput(value: string): string[] {
  return value.split('\n').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

export function normalizeHost(input: string): string {
  const raw = String(input || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return raw.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

export function parseJsonObject(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON non valido: atteso oggetto {"chiave": valore }');
  }
  return parsed as Record<string, unknown>;
}

export function parseNumberMap(value: string): Record<string, number> {
  const parsed = parseJsonObject(value);
  const result: Record<string, number> = {};
  for (const [key, rawValue] of Object.entries(parsed)) {
    const trimmedKey = key.trim();
    const numericValue = Number(rawValue);
    if (!trimmedKey || !Number.isFinite(numericValue)) {
      throw new Error('JSON non valido: attesi chiavi e punteggi numerici');
    }
    result[trimmedKey] = numericValue;
  }
  return result;
}

export function normalizeSeedMap(input: Record<string, unknown>): Record<string, string[]> {
  const output: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (!key) continue;
    if (Array.isArray(value)) {
      const cleaned = value.map((entry) => String(entry || '').trim()).filter(Boolean);
      if (cleaned.length > 0) output[key.trim().toLowerCase()] = cleaned;
    } else {
      const single = String(value || '').trim();
      if (single) output[key.trim().toLowerCase()] = [single];
    }
  }
  return output;
}

export function mapCrawlerConfig(raw: any): JobsCrawlerConfigState {
  return {
    domainWhitelist: Array.isArray(raw?.domainWhitelist) ? raw.domainWhitelist.map((value: unknown) => normalizeHost(String(value))) : [],
    domainBlacklist: Array.isArray(raw?.domainBlacklist) ? raw.domainBlacklist.map((value: unknown) => normalizeHost(String(value))) : [],
    minQualityScore: Number(raw?.minQualityScore ?? DEFAULT_JOBS_CRAWLER_CONFIG.minQualityScore),
    minDescriptionChars: Number(raw?.minDescriptionChars ?? DEFAULT_JOBS_CRAWLER_CONFIG.minDescriptionChars),
    aiLocalizationEnabled: raw?.aiLocalizationEnabled !== undefined ? Boolean(raw.aiLocalizationEnabled) : DEFAULT_JOBS_CRAWLER_CONFIG.aiLocalizationEnabled,
    aiLocalizationMaxJobsPerRun: Number(raw?.aiLocalizationMaxJobsPerRun ?? DEFAULT_JOBS_CRAWLER_CONFIG.aiLocalizationMaxJobsPerRun),
    contentReuseEnabled: raw?.contentReuse?.enabled !== undefined ? Boolean(raw.contentReuse.enabled) : DEFAULT_JOBS_CRAWLER_CONFIG.contentReuseEnabled,
    contentReuseSimilarityThreshold: Number(raw?.contentReuse?.similarityThreshold ?? DEFAULT_JOBS_CRAWLER_CONFIG.contentReuseSimilarityThreshold),
    contentReuseMinSourceChars: Number(raw?.contentReuse?.minSourceChars ?? DEFAULT_JOBS_CRAWLER_CONFIG.contentReuseMinSourceChars),
    contentReuseMaxLengthDeltaRatio: Number(raw?.contentReuse?.maxLengthDeltaRatio ?? DEFAULT_JOBS_CRAWLER_CONFIG.contentReuseMaxLengthDeltaRatio),
    companyPriorityByDomain: raw?.companyPriority?.byDomain || raw?.companyPriorityByDomain || {},
    companyPriorityByName: raw?.companyPriority?.byName || raw?.companyPriorityByName || {},
    sourceSeedsByDomain: raw?.sourceSeeds?.byDomain || raw?.sourceSeedsByDomain || {},
    sourceSeedsByName: raw?.sourceSeeds?.byName || raw?.sourceSeedsByName || {},
  };
}

export function crawlerFormSignature(config: JobsCrawlerConfigState): string {
  return JSON.stringify(config);
}

export function adminFunctionError(data: any, status: number): string {
  const messages: Record<string, string> = {
    not_admin: 'Accesso negato: questo account non è autorizzato alle funzioni admin.',
    invalid_id_token: 'Sessione admin non valida: accedi di nuovo.',
    config_read_failed: 'Configurazione crawler non disponibile dal server.',
    config_write_failed: 'Salvataggio configurazione crawler non riuscito.',
    invalid_config: 'Configurazione crawler non valida: controlla i campi e gli URL seed.',
  };
  return messages[data?.error] || `Operazione admin non riuscita (${data?.error || status}).`;
}

export interface LoadedCrawlerData {
  summaries: CrawlerSummaryRow[];
  workflows: WorkflowActionDefinition[];
}

async function safeFetchJson(url: string): Promise<any | null> {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.includes('application/json')) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function loadCrawlerData(dataUrl: (path: string) => string): Promise<LoadedCrawlerData> {
  const [summaryJson, workflowJson] = await Promise.all([
    safeFetchJson(dataUrl('/data/jobs-crawler-summaries.json')),
    safeFetchJson(dataUrl('/data/jobs-crawler-workflows.json')),
  ]);
  const summaries = Array.isArray(summaryJson?.summaries) ? summaryJson.summaries.map((entry: any): CrawlerSummaryRow => ({
    key: String(entry?.key || ''),
    label: String(entry?.label || 'Crawler'),
    generatedAt: entry?.generatedAt ? String(entry.generatedAt) : null,
    total: Number(entry?.total || 0),
    activeJobCount: entry?.activeJobCount != null ? Number(entry.activeJobCount) : Number(entry?.total || 0),
    newCount: Number(entry?.newCount || 0),
    updatedCount: Number(entry?.updatedCount || 0),
    removedCount: Number(entry?.removedCount || 0),
    unchangedCount: Number(entry?.unchangedCount || 0),
    durationMs: entry?.durationMs != null ? Number(entry.durationMs) : null,
    avgDurationMs: entry?.avgDurationMs != null ? Number(entry.avgDurationMs) : null,
    newJobs: Array.isArray(entry?.newJobs) ? entry.newJobs : [],
    updatedJobs: Array.isArray(entry?.updatedJobs) ? entry.updatedJobs : [],
    removedJobs: Array.isArray(entry?.removedJobs) ? entry.removedJobs : [],
    unchangedJobs: Array.isArray(entry?.unchangedJobs) ? entry.unchangedJobs : [],
    qualityScore: entry?.qualityScore ? {
      avgScore: Number(entry.qualityScore.avgScore || 0),
      breakdown: {
        cleanliness: Number(entry.qualityScore.breakdown?.cleanliness || 0),
        richness: Number(entry.qualityScore.breakdown?.richness || 0),
        translation: Number(entry.qualityScore.breakdown?.translation || 0),
        completeness: Number(entry.qualityScore.breakdown?.completeness || 0),
      },
      jobCount: Number(entry.qualityScore.jobCount || 0),
      lastUpdated: String(entry.qualityScore.lastUpdated || ''),
      worstJobs: Array.isArray(entry.qualityScore.worstJobs) ? entry.qualityScore.worstJobs : [],
    } : null,
  })) : [];
  const workflows = Array.isArray(workflowJson?.workflows) ? workflowJson.workflows.map((workflow: any): WorkflowActionDefinition => ({
    id: String(workflow.id || ''),
    title: String(workflow.title || ''),
    context: 'jobs' as WorkflowContext,
    description: String(workflow.description || ''),
    details: String(workflow.details || ''),
    expectedDuration: isExpectedWorkflowDuration(String(workflow.expectedDuration || ''))
      ? String(workflow.expectedDuration).trim()
      : DEFAULT_WORKFLOW_EXPECTED_DURATION,
    schedule: workflow.schedule || undefined,
    summaryKey: workflow.summaryKey || null,
    defaultInputs: workflow.defaultInputs || undefined,
    slug: workflow.slug || undefined,
    groupId: workflow.groupId || undefined,
    groupMemberCount: workflow.groupMemberCount != null ? Number(workflow.groupMemberCount) : undefined,
  })) : [];
  return { summaries, workflows };
}

export interface JobsCrawlerConfigPayload {
  domainWhitelist: string[];
  domainBlacklist: string[];
  minQualityScore: number;
  minDescriptionChars: number;
  aiLocalizationEnabled: boolean;
  aiLocalizationMaxJobsPerRun: number;
  contentReuse: {
    enabled: boolean;
    similarityThreshold: number;
    minSourceChars: number;
    maxLengthDeltaRatio: number;
  };
  companyPriority: { byDomain: Record<string, unknown>; byName: Record<string, unknown> };
  sourceSeeds: { byDomain: Record<string, string[]>; byName: Record<string, string[]> };
}

export function buildCrawlerConfigPayload(form: JobsCrawlerConfigState): JobsCrawlerConfigPayload {
  return {
    domainWhitelist: form.domainWhitelist,
    domainBlacklist: form.domainBlacklist,
    minQualityScore: Math.max(JOBS_CRAWLER_CONFIG_LIMITS.minQualityScore.min, Math.min(JOBS_CRAWLER_CONFIG_LIMITS.minQualityScore.max, Math.round(form.minQualityScore))),
    minDescriptionChars: Math.max(JOBS_CRAWLER_CONFIG_LIMITS.minDescriptionChars.min, Math.min(JOBS_CRAWLER_CONFIG_LIMITS.minDescriptionChars.max, Math.round(form.minDescriptionChars))),
    aiLocalizationEnabled: Boolean(form.aiLocalizationEnabled),
    aiLocalizationMaxJobsPerRun: Math.max(JOBS_CRAWLER_CONFIG_LIMITS.aiLocalizationMaxJobsPerRun.min, Math.min(JOBS_CRAWLER_CONFIG_LIMITS.aiLocalizationMaxJobsPerRun.max, Math.round(form.aiLocalizationMaxJobsPerRun))),
    contentReuse: {
      enabled: Boolean(form.contentReuseEnabled),
      similarityThreshold: Math.max(JOBS_CRAWLER_CONFIG_LIMITS.contentReuse.similarityThreshold.min, Math.min(JOBS_CRAWLER_CONFIG_LIMITS.contentReuse.similarityThreshold.max, Number(form.contentReuseSimilarityThreshold))),
      minSourceChars: Math.max(JOBS_CRAWLER_CONFIG_LIMITS.contentReuse.minSourceChars.min, Math.min(JOBS_CRAWLER_CONFIG_LIMITS.contentReuse.minSourceChars.max, Math.round(form.contentReuseMinSourceChars))),
      maxLengthDeltaRatio: Math.max(JOBS_CRAWLER_CONFIG_LIMITS.contentReuse.maxLengthDeltaRatio.min, Math.min(JOBS_CRAWLER_CONFIG_LIMITS.contentReuse.maxLengthDeltaRatio.max, Number(form.contentReuseMaxLengthDeltaRatio))),
    },
    companyPriority: { byDomain: form.companyPriorityByDomain, byName: form.companyPriorityByName },
    sourceSeeds: { byDomain: form.sourceSeedsByDomain, byName: form.sourceSeedsByName },
  };
}

export function configMetaFromResponse(data: any, fallback: JobsCrawlerConfigMeta['source'] = 'default'): JobsCrawlerConfigMeta {
  return {
    source: data?.source === 'firestore' ? 'firestore' : fallback,
    updatedAt: data?.updatedAt ? String(data.updatedAt) : null,
    updatedBy: data?.updatedBy ? String(data.updatedBy) : null,
  };
}
