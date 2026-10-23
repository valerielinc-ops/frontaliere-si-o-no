import { cdnDataUrl } from './cdnDataBase';
import { articlesApiBase } from './articlesApiBase';
import { createAdminGithubClient, type AdminGithubUser } from '@/components/admin/lib/githubClient';

export type HealthTone = 'success' | 'warning' | 'danger' | 'neutral';

export interface HealthIndicator {
  id: string;
  label: string;
  value: string;
  tone: HealthTone;
  detail: string;
  updatedAt: string | null;
  threshold?: string;
}

export interface ArticleCorpusHealth {
  commit: string | null;
  expected: number;
  available: number;
  missing: number;
  truncated: boolean;
  previous: { expected: number; available: number; missing: number; savedAt: string } | null;
}

export interface DeployHealth {
  workflow: string;
  label: string;
  status: string;
  conclusion: string | null;
  at: string | null;
  url: string | null;
}

export interface AdminHealthSnapshot {
  indicators: HealthIndicator[];
  cdn: { generatedAt: string | null; activeJobs: number | null; activeJobsDelta: number | null; activeCompanies: number | null; crawlerCount: number | null };
  articleCorpus: ArticleCorpusHealth;
  rateLimit: { remaining: number | null; limit: number | null; resetAt: string | null };
  deploys: DeployHealth[];
}

async function getJson(url: string): Promise<any | null> {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}

function corpusCounts(manifest: any): { expected: number; available: number; missing: number } {
  const count = (value: unknown): number => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  };
  if (manifest?.counts && typeof manifest.counts === 'object') {
    return { expected: count(manifest.counts.expected), available: count(manifest.counts.available), missing: count(manifest.counts.missing) };
  }
  const sections = manifest?.capabilities?.articleBodies?.sections;
  if (!sections || typeof sections !== 'object') return { expected: 0, available: 0, missing: 0 };
  const total = { expected: 0, available: 0, missing: 0 };
  for (const section of Object.values(sections) as any[]) {
    for (const locale of Object.values(section?.locales || {}) as any[]) {
      total.expected += count(locale?.expected);
      total.available += count(locale?.available);
      total.missing += count(locale?.missing);
    }
  }
  return total;
}

function readPreviousCorpus(): ArticleCorpusHealth['previous'] {
  try {
    const raw = localStorage.getItem('frontaliere-admin-article-corpus-counts');
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || !Number.isFinite(parsed.expected) || !Number.isFinite(parsed.available) || !Number.isFinite(parsed.missing) || typeof parsed.savedAt !== 'string') return null;
    return parsed;
  } catch { return null; }
}

function saveCorpus(counts: { expected: number; available: number; missing: number }, savedAt: string): void {
  try { localStorage.setItem('frontaliere-admin-article-corpus-counts', JSON.stringify({ ...counts, savedAt })); } catch { /* storage is optional */ }
}

function ageTone(generatedAt: string | null, now: number, warningHours: number, dangerHours: number): HealthTone {
  if (!generatedAt) return 'neutral';
  const ageHours = Math.max(0, now - Date.parse(generatedAt)) / 3_600_000;
  if (!Number.isFinite(ageHours)) return 'neutral';
  return ageHours > dangerHours ? 'danger' : ageHours > warningHours ? 'warning' : 'success';
}

export async function loadAdminHealth(user: AdminGithubUser | null | undefined, now = new Date()): Promise<AdminHealthSnapshot> {
  const github = createAdminGithubClient(user);
  const results = await Promise.allSettled([
    getJson(cdnDataUrl('/data/jobs-stats.json')),
    getJson(cdnDataUrl('/data/jobs-crawler-summaries.json')),
    getJson(`${articlesApiBase()}/manifest.json`),
    github.request('GET', '/rate_limit'),
    github.request('GET', '/actions/workflows/deploy.yml/runs?per_page=100&status=completed&branch=main'),
    github.request('GET', '/actions/workflows/deploy-cloud-functions.yml/runs?per_page=100&status=completed&branch=main'),
  ]);
  const value = <T,>(index: number): T | null => {
    const result = results[index];
    return result.status === 'fulfilled' ? result.value as T : null;
  };
  const stats = value<any>(0);
  const summaries = value<any>(1);
  const manifest = value<any>(2);
  const rateLimit = value<any>(3);
  const deploy = value<any>(4);
  const deployFunctions = value<any>(5);
  const generatedAt = typeof stats?.generatedAt === 'string' ? stats.generatedAt : (typeof summaries?.generatedAt === 'string' ? summaries.generatedAt : null);
  const crawlerCount = Array.isArray(summaries?.summaries) && summaries.summaries.length > 0 ? summaries.summaries.length : null;
  const counts = corpusCounts(manifest);
  const previous = readPreviousCorpus();
  const truncated = Boolean(previous && (counts.expected < previous.expected || counts.available < previous.available || counts.missing > previous.missing));
  const savedAt = now.toISOString();
  if (manifest && typeof manifest === 'object' && !truncated) saveCorpus(counts, savedAt);
  const rate = rateLimit?.resources?.core || rateLimit?.rate || {};
  const remaining = Number.isFinite(Number(rate.remaining)) ? Number(rate.remaining) : null;
  const limit = Number.isFinite(Number(rate.limit)) ? Number(rate.limit) : null;
  const resetAt = Number.isFinite(Number(rate.reset)) ? new Date(Number(rate.reset) * 1000).toISOString() : null;
  const deploys = [
    { workflow: 'deploy.yml', label: 'Deploy sito', run: deploy?.workflow_runs?.[0] },
    { workflow: 'deploy-cloud-functions.yml', label: 'Deploy funzioni', run: deployFunctions?.workflow_runs?.[0] },
  ].map(({ workflow, label, run }): DeployHealth => ({
    workflow, label, status: String(run?.status || 'non disponibile'), conclusion: run?.conclusion ? String(run.conclusion) : null,
    at: run?.updated_at || run?.created_at ? String(run.updated_at || run.created_at) : null,
    url: run?.html_url ? String(run.html_url) : null,
  }));
  const deployTone = deploys.some((item) => item.conclusion && item.conclusion !== 'success') ? 'danger' : deploys.some((item) => item.status === 'non disponibile') ? 'neutral' : 'success';
  const activeJobs = Number.isFinite(Number(stats?.totals?.activeJobs)) ? Number(stats.totals.activeJobs) : null;
  const previousActiveJobs = Number.isFinite(Number(stats?.totals?.previousActiveJobs)) ? Number(stats.totals.previousActiveJobs)
    : Number.isFinite(Number(stats?.totals?.activeJobsYesterday)) ? Number(stats.totals.activeJobsYesterday)
      : null;
  const explicitActiveJobsDelta = [stats?.totals?.activeJobsDelta, stats?.delta?.activeJobs, stats?.comparison?.activeJobsDelta]
    .filter((candidate) => candidate !== null && candidate !== undefined)
    .map((candidate) => Number(candidate)).find((candidate) => Number.isFinite(candidate));
  const activeJobsDelta = explicitActiveJobsDelta === undefined ? (activeJobs !== null && previousActiveJobs !== null ? activeJobs - previousActiveJobs : null) : explicitActiveJobsDelta;
  const deployValue = deploys.some((item) => item.conclusion && item.conclusion !== 'success') ? 'Da verificare' : deploys.some((item) => item.status === 'non disponibile') ? 'Non disponibile' : 'OK';
  return {
    cdn: { generatedAt, activeJobs, activeJobsDelta, activeCompanies: Number.isFinite(Number(stats?.totals?.activeCompanies)) ? Number(stats.totals.activeCompanies) : null, crawlerCount },
    articleCorpus: { commit: typeof manifest?.commit === 'string' ? manifest.commit : null, ...counts, truncated, previous },
    rateLimit: { remaining, limit, resetAt },
    deploys,
    indicators: [
      { id: 'cdn', label: 'CDN dati', value: generatedAt ? new Date(generatedAt).toLocaleString('it-CH') : 'Non disponibile', tone: ageTone(generatedAt, now.getTime(), 26, 50), detail: 'jobs-stats.json e riepilogo crawler', threshold: 'attenzione oltre 26 h · problema oltre 50 h', updatedAt: generatedAt },
      { id: 'corpus', label: 'Corpus articoli', value: counts.expected ? `${counts.available}/${counts.expected}` : 'Non disponibile', tone: counts.expected === 0 ? 'neutral' : truncated ? 'danger' : counts.missing > 0 ? 'warning' : 'success', detail: `${counts.missing} documenti mancanti${truncated ? ' · conteggi in calo rispetto al controllo precedente' : ''} · commit ${typeof manifest?.commit === 'string' ? manifest.commit.slice(0, 8) : 'n/d'}`, threshold: 'nessun conteggio deve diminuire', updatedAt: savedAt },
      { id: 'github', label: 'GitHub API', value: remaining === null ? 'Non disponibile' : `${remaining}/${limit ?? 'n/d'} richieste`, tone: remaining === null ? 'neutral' : remaining < 100 ? 'danger' : remaining < 500 ? 'warning' : 'success', detail: resetAt ? `reset ${new Date(resetAt).toLocaleTimeString('it-CH')}` : 'rate limit core', threshold: 'attenzione sotto 500 · problema sotto 100 richieste', updatedAt: now.toISOString() },
      { id: 'deploy', label: 'Ultimo deploy', value: deployValue, tone: deployTone, detail: deploys.map((item) => `${item.label}: ${item.conclusion || item.status}`).join(' · '), threshold: 'ultima run disponibile completata con successo', updatedAt: deploys.map((item) => item.at).filter(Boolean).sort().at(-1) || null },
    ],
  };
}
