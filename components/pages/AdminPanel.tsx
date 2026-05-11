/**
 * AdminPanel — Hidden admin route for owner operations.
 * Accessible only via direct URL: /gestione-contenuti-xk9mp2q
 */

import { Fragment, useState, useEffect, useRef, useMemo } from 'react';
import { getSerpExperimentDiagnostics } from '@/services/seoService';
import { getConfigValue } from '@/services/firebase';
import { useAuth } from '@/services/authService';
import { buildNewsletterPreviewHtml } from '@/services/newsletterPreview';
import {
 Shield, Copy, Check, ExternalLink,
 AlertTriangle, CheckCircle2, Eye,
 Mail, Users, Send, RefreshCw, ToggleLeft, ToggleRight, Database, Activity, Calendar, Terminal,
 Play, Loader2, Clock3, ListChecks, FileText, ArrowUp, ArrowDown, Search, ChevronDown, ChevronRight, RotateCcw, Zap
} from 'lucide-react';

/* ─── Types ─── */

interface OwnerStats {
 loading: boolean;
 error: string | null;
 socialProofTotal: number | null;
 simulationDocs: number | null;
 forumQuestions: number | null;
 newsletterActive: number | null;
 publicFiles: Record<string, boolean>;
}

interface NewsletterInsight {
 currentRate: number;
 previousWeekRate: number;
 weeklyDeltaPct: number;
 currentMonthAvg: number;
 previousMonthAvg: number;
 monthDeltaPct: number;
 bestWeekday: string;
 providerRanking: Array<{ name: string; netEur: number }>;
 recommendation: string;
}

interface SerpDiagnostics {
 loaded: boolean;
 runtime: { enabled: boolean; variant: string; targets: string; year: string };
 defaults: { enabled: boolean; variant: string; targets: string; year: string };
 hasRemoteOverride: boolean;
}

interface JobsCrawlerConfigState {
 domainWhitelist: string[];
 domainBlacklist: string[];
 minQualityScore: number;
 minDescriptionChars: number;
 aiLocalizationEnabled: boolean;
 aiLocalizationMaxJobsPerRun: number;
 contentReuseEnabled: boolean;
 contentReuseSimilarityThreshold: number;
 contentReuseMinSourceChars: number;
 contentReuseMaxLengthDeltaRatio: number;
 companyPriorityByDomain: Record<string, number>;
 companyPriorityByName: Record<string, number>;
 sourceSeedsByDomain: Record<string, string[]>;
 sourceSeedsByName: Record<string, string[]>;
}

interface CrawlerSummaryLinkRow {
 title: string;
 company: string;
 location: string;
 url: string;
 slug: string;
 _qualityScore?: number;
 _qualityBreakdown?: { cleanliness: number; richness: number; translation: number; completeness: number };
}

interface CrawlerQualityScore {
 avgScore: number;
 breakdown: { cleanliness: number; richness: number; translation: number; completeness: number };
 jobCount: number;
 lastUpdated: string;
 worstJobs: Array<{ slug: string; title: string; score: number; breakdown: { cleanliness: number; richness: number; translation: number; completeness: number } }>;
}

interface CrawlerSummaryRow {
 key: string;
 label: string;
 generatedAt: string | null;
 total: number;
 activeJobCount: number;
 newCount: number;
 updatedCount: number;
 removedCount: number;
 unchangedCount: number;
 durationMs: number | null;
 avgDurationMs: number | null;
 newJobs: CrawlerSummaryLinkRow[];
 updatedJobs: CrawlerSummaryLinkRow[];
 removedJobs: CrawlerSummaryLinkRow[];
 unchangedJobs: CrawlerSummaryLinkRow[];
 qualityScore?: CrawlerQualityScore | null;
}

type CrawlerSortColumn = 'title' | 'schedule' | 'lastRun' | 'total' | 'newCount' | 'updatedCount' | 'removedCount' | 'unchangedCount' | 'duration' | 'status' | 'quality';
type CrawlerSortDirection = 'asc' | 'desc';

type WorkflowContext = 'jobs' | 'content' | 'seo' | 'analytics';

interface WorkflowActionDefinition {
 id: string;
 title: string;
 context: WorkflowContext;
 description: string;
 details: string;
 expectedDuration: string;
 schedule?: string; // cron time (UTC), e.g. '08:45'
 summaryKey?: string | null; // key in jobs-crawler-summaries.json (extracted from crawler script)
 defaultInputs?: Record<string, string>;
 isUtility?: boolean; // true for non-crawler workflows (e.g. merge utilities) — excluded from crawler table
}

interface WorkflowJobSummary {
 id: number;
 name: string;
 status: string;
 conclusion: string;
 totalSteps: number;
 completedSteps: number;
 failedSteps: string[];
}

interface WorkflowRunState {
 loading: boolean;
 runId: number | null;
 runNumber: number | null;
 status: string;
 conclusion: string | null;
 htmlUrl: string | null;
 startedAt: string | null;
 updatedAt: string | null;
 completedAt: string | null;
 durationSeconds: number | null;
 message: string | null;
 error: string | null;
 jobs: WorkflowJobSummary[];
 logExcerpt: string | null;
 aiPrompt: string | null;
}

const DEFAULT_JOBS_CRAWLER_CONFIG: JobsCrawlerConfigState = {
 domainWhitelist: [],
 domainBlacklist: [],
 minQualityScore: 6,
 minDescriptionChars: 160,
 aiLocalizationEnabled: false,
 aiLocalizationMaxJobsPerRun: 12,
 contentReuseEnabled: true,
 contentReuseSimilarityThreshold: 0.93,
 contentReuseMinSourceChars: 220,
 contentReuseMaxLengthDeltaRatio: 0.2,
 companyPriorityByDomain: {},
 companyPriorityByName: {},
 sourceSeedsByDomain: {},
 sourceSeedsByName: {},
};

/** Non-jobs workflow actions (content, seo, analytics). Jobs crawlers are loaded dynamically. */
const STATIC_WORKFLOW_ACTIONS: WorkflowActionDefinition[] = [
 {
 id: 'generate-article.yml',
 title: 'Genera nuovo articolo',
 context: 'content',
 description: 'Avvia la pipeline editoriale automatica per un nuovo articolo.',
 details: 'Seleziona una notizia o tema evergreen, genera contenuti multi-lingua e aggiorna sitemap.',
 expectedDuration: '8-30 min',
 },
 {
 id: 'update-unemployment-rate.yml',
 title: 'Aggiorna tasso disoccupazione CH',
 context: 'analytics',
 description: 'Aggiorna automaticamente il dataset statistico Svizzera.',
 details: 'Utile quando vuoi forzare un aggiornamento dati prima del run schedulato.',
 expectedDuration: '2-8 min',
 },
 {
 id: 'analytics.yml',
 title: 'Report analytics',
 context: 'analytics',
 description: 'Report completo: traffico, GSC, indicizzazione, Core Web Vitals.',
 details: 'Genera report settimanale con segnali utili per decisioni prodotto/SEO.',
 expectedDuration: '10-30 min',
 defaultInputs: { days: '30', sections: 'all' },
 },
 // \u2500\u2500 SEO & Qualit\u00e0 \u2500\u2500
 {
 id: 'seo-serp-autopilot.yml',
 title: 'SEO SERP Autopilot',
 context: 'seo',
 description: 'Analizza SERP, trova opportunit\u00e0 e applica esperimenti SEO.',
 details: 'Anticipa il run settimanale per vedere subito suggerimenti/azioni.',
 expectedDuration: '10-30 min',
 defaultInputs: { days: '28', dry_run: 'false' },
 },
 {
 id: 'adsense-prereview.yml',
 title: 'Controllo AdSense',
 context: 'seo',
 description: 'Checklist qualit\u00e0 contenuti pre-review AdSense.',
 details: 'Identifica pagine thin/deboli e segnali policy a rischio rifiuto.',
 expectedDuration: '8-20 min',
 defaultInputs: { sample: '140', strict: 'true' },
 },
];

const WORKFLOW_CONTEXT_META: Record<WorkflowContext, { label: string; description: string }> = {
 jobs: {
 label: 'Lavoro & Crawler',
 description: 'Aggiornamenti offerte, validazione nuove aziende e qualità del catalogo lavori.',
 },
 content: {
 label: 'Contenuti editoriali',
 description: 'Generazione e refresh contenuti per mantenere il sito aggiornato e indicizzabile.',
 },
 seo: {
 label: 'SEO & Qualità',
 description: 'Controlli pre-review e automazioni SEO per migliorare visibilità e conformità.',
 },
 analytics: {
 label: 'Analytics & Dati',
 description: 'Aggiornamento dataset e report per capire traffico e comportamento utenti.',
 },
};

/* ─── Helpers ─── */

function CopyButton({ text, label }: { text: string; label?: string }) {
 const [copied, setCopied] = useState(false);
 const handleCopy = () => {
 navigator.clipboard.writeText(text).then(() => {
 setCopied(true);
 setTimeout(() => setCopied(false), 2000);
 });
 };
 return (
 <button
 onClick={handleCopy}
 className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-surface-raised hover:bg-surface-raised transition-colors font-mono"
 title={`Copia: ${text}`}
 aria-label={`Copia ${label || text}`}
 >
 {copied ? <Check size={12} className="text-success" /> : <Copy size={12} className="text-muted" />}
 <span className="max-w-[200px] truncate">{text}</span>
 </button>
 );
}

function HealthBadge({ ok, label }: { ok: boolean; label: string }) {
 return (
 <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
 ok
 ? 'bg-success-subtle text-success'
 : 'bg-danger-subtle text-danger'
 }`}>
 {ok ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
 {label}
 </span>
 );
}

/* ─── Main Component ─── */

export default function AdminPanel() {
 const { user } = useAuth();
 const hasPreloadedWorkflowSnapshots = useRef(false);
 const [copiedCmd, setCopiedCmd] = useState(false);
 const [activeSection, setActiveSection] = useState<'newsletter' | 'owner' | WorkflowContext>('jobs');
 const [ownerTab] = useState<'overview'>('overview');
 const [workflowStates, setWorkflowStates] = useState<Record<string, WorkflowRunState>>({});
 const [copiedAiPromptFor, setCopiedAiPromptFor] = useState<string | null>(null);
 const [ownerStats, setOwnerStats] = useState<OwnerStats>({
 loading: false,
 error: null,
 socialProofTotal: null,
 simulationDocs: null,
 forumQuestions: null,
 newsletterActive: null,
 publicFiles: {},
 });
 const [serpDiagnostics, setSerpDiagnostics] = useState<SerpDiagnostics>(() => getSerpExperimentDiagnostics());
 const [jobsCrawlerConfig, setJobsCrawlerConfig] = useState<JobsCrawlerConfigState>(DEFAULT_JOBS_CRAWLER_CONFIG);
 const [jobsCrawlerConfigLoading, setJobsCrawlerConfigLoading] = useState(false);
 const [jobsCrawlerConfigSaving, setJobsCrawlerConfigSaving] = useState(false);
 const [jobsCrawlerConfigMessage, setJobsCrawlerConfigMessage] = useState<string | null>(null);
 const [crawlerSummaries, setCrawlerSummaries] = useState<CrawlerSummaryRow[]>([]);
 const [dynamicCrawlerWorkflows, setDynamicCrawlerWorkflows] = useState<WorkflowActionDefinition[]>([]);
 const [domainWhitelistText, setDomainWhitelistText] = useState('');
 const [domainBlacklistText, setDomainBlacklistText] = useState('');
 const [minQualityScoreInput, setMinQualityScoreInput] = useState(6);
 const [minDescriptionCharsInput, setMinDescriptionCharsInput] = useState(160);
 const [aiLocalizationEnabledInput, setAiLocalizationEnabledInput] = useState(false);
 const [aiLocalizationMaxJobsPerRunInput, setAiLocalizationMaxJobsPerRunInput] = useState(12);
 const [contentReuseEnabledInput, setContentReuseEnabledInput] = useState(true);
 const [contentReuseSimilarityThresholdInput, setContentReuseSimilarityThresholdInput] = useState(0.93);
 const [contentReuseMinSourceCharsInput, setContentReuseMinSourceCharsInput] = useState(220);
 const [contentReuseMaxLengthDeltaRatioInput, setContentReuseMaxLengthDeltaRatioInput] = useState(0.2);
 const [companyPriorityByDomainText, setCompanyPriorityByDomainText] = useState('{}');
 const [companyPriorityByNameText, setCompanyPriorityByNameText] = useState('{}');
 const [sourceSeedsByDomainText, setSourceSeedsByDomainText] = useState('{}');
 const [sourceSeedsByNameText, setSourceSeedsByNameText] = useState('{}');

 // Newsletter state
 const [nlSubscriberCount, setNlSubscriberCount] = useState<number | null>(null);
 const [nlLastSend, setNlLastSend] = useState<string | null>(null);
 const [nlSubject, setNlSubject] = useState('');
 const [nlPreviewHtml, setNlPreviewHtml] = useState<string | null>(null);
 const [nlPreviewLoading, setNlPreviewLoading] = useState(false);
 const [nlSending, setNlSending] = useState(false);
 const [nlSendResult, setNlSendResult] = useState<string | null>(null);
 const [nlLoading, setNlLoading] = useState(false);
 const [nlRecipients, setNlRecipients] = useState<string[]>([]);
 const [nlInsights, setNlInsights] = useState<NewsletterInsight | null>(null);
 const [nlInsightLoading, setNlInsightLoading] = useState(false);
 const [crawlerDispatchLoading, setCrawlerDispatchLoading] = useState(false);
 const [crawlerDispatchMessage, setCrawlerDispatchMessage] = useState<string | null>(null);
 const [parserCompanyName, setParserCompanyName] = useState('');
 const [parserCompanyWebsite, setParserCompanyWebsite] = useState('');
 const [parserCompanyKey, setParserCompanyKey] = useState('');
 const [parserApplyConfig, setParserApplyConfig] = useState(false);
 const [parserDispatchLoading, setParserDispatchLoading] = useState(false);
 const [parserDispatchMessage, setParserDispatchMessage] = useState<string | null>(null);
 // Crawler table filters & expansion
 const [crawlerNameFilter, setCrawlerNameFilter] = useState('');
 const [crawlerChangeFilter, setCrawlerChangeFilter] = useState<'all' | 'new' | 'updated' | 'removed' | 'none'>('all');
 const [expandedCrawlerDetail, setExpandedCrawlerDetail] = useState<Record<string, 'new' | 'updated' | 'removed' | 'unchanged' | 'active' | null>>({});
 const [crawlerSort, setCrawlerSort] = useState<{ column: CrawlerSortColumn; direction: CrawlerSortDirection }>({
 column: 'schedule',
 direction: 'asc',
 });
 const [retryFailedProgress, setRetryFailedProgress] = useState<{ running: boolean; current: number; total: number; currentLabel: string } | null>(null);
 // Merged workflow actions: static (content/seo/analytics) + dynamically loaded crawler workflows
 const workflowActions = useMemo(() => {
 const ids = new Set(STATIC_WORKFLOW_ACTIONS.map(w => w.id));
 const dynamic = dynamicCrawlerWorkflows.filter(w => !ids.has(w.id));
 return [...STATIC_WORKFLOW_ACTIONS, ...dynamic];
 }, [dynamicCrawlerWorkflows]);

 const getWorkflowState = (workflowId: string): WorkflowRunState => {
 return workflowStates[workflowId] || {
 loading: false,
 runId: null,
 runNumber: null,
 status: 'idle',
 conclusion: null,
 htmlUrl: null,
 startedAt: null,
 updatedAt: null,
 completedAt: null,
 durationSeconds: null,
 message: null,
 error: null,
 jobs: [],
 logExcerpt: null,
 aiPrompt: null,
 };
 };

 const setWorkflowState = (workflowId: string, patch: Partial<WorkflowRunState>) => {
 setWorkflowStates((prev) => {
 const current = prev[workflowId] || {
 loading: false,
 runId: null,
 runNumber: null,
 status: 'idle',
 conclusion: null,
 htmlUrl: null,
 startedAt: null,
 updatedAt: null,
 completedAt: null,
 durationSeconds: null,
 message: null,
 error: null,
 jobs: [],
 logExcerpt: null,
 aiPrompt: null,
 };
 return {
 ...prev,
 [workflowId]: {
 ...current,
 ...patch,
 },
 };
 });
 };

 const parseListInput = (value: string): string[] => {
 return value
 .split('\n')
 .map((x) => x.trim().toLowerCase())
 .filter(Boolean);
 };

 const normalizeHost = (input: string): string => {
 const raw = String(input || '').trim();
 if (!raw) return '';
 try {
 const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
 return url.hostname.toLowerCase().replace(/^www\./, '');
 } catch {
 return raw.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
 }
 };

 const parseJsonObject = (value: string): Record<string, any> => {
 const trimmed = value.trim();
 if (!trimmed) return {};
 const parsed = JSON.parse(trimmed);
 if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
 throw new Error('JSON non valido: atteso oggetto {"chiave": valore }');
 }
 return parsed as Record<string, any>;
 };

 const normalizeSeedMap = (input: Record<string, any>): Record<string, string[]> => {
 const out: Record<string, string[]> = {};
 for (const [k, v] of Object.entries(input || {})) {
 if (!k || typeof k !== 'string') continue;
 if (Array.isArray(v)) {
 const cleaned = v.map((x) => String(x || '').trim()).filter(Boolean);
 if (cleaned.length > 0) out[k.trim().toLowerCase()] = cleaned;
 continue;
 }
 const single = String(v || '').trim();
 if (single) out[k.trim().toLowerCase()] = [single];
 }
 return out;
 };

 /** Fetch JSON silently — returns null on 404, network error, or non-JSON response */
 const safeFetchJson = async (url: string): Promise<any | null> => {
 try {
 const res = await fetch(url, { cache: 'no-store' });
 const ct = res.headers.get('content-type') || '';
 if (!res.ok || !ct.includes('application/json')) return null;
 return await res.json();
 } catch {
 return null;
 }
 };

 // Load newsletter stats when tab is active
 useEffect(() => {
 if (activeSection !== 'newsletter') return;
 let cancelled = false;
 fetchNewsletterInsights().catch(() => undefined);
 (async () => {
 setNlLoading(true);
 try {
 const { getFirestore, collection, query, where, getDocs, getCountFromServer, limit, doc: firestoreDoc, getDoc } = await import('firebase/firestore');
 const { app } = await import('@/services/firebase');
 const db = getFirestore(app);

 const activeSubsQ = query(collection(db, 'newsletter_subscribers'), where('isActive', '==', true));

 // Subscriber count (count() aggregation = 1 Firestore read regardless
 // of collection size; previously this fetched every active doc).
 const countSnap = await getCountFromServer(activeSubsQ);
 if (!cancelled) setNlSubscriberCount(countSnap.data().count);

 // Last send (stored under newsletter_subscribers/_meta_)
 const metaSnap = await getDoc(firestoreDoc(db, 'newsletter_subscribers', '_meta_'));
 if (!cancelled && metaSnap.exists()) {
 const d = metaSnap.data();
 const date = d.last_sent_at?.toDate?.() ?? new Date(d.last_sent_at);
 setNlLastSend(date.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }));
 }

 // Recipient emails (first 10, masked) — bounded query so we never pull
 // the whole collection just to render the preview list.
 const sampleSnap = await getDocs(query(activeSubsQ, limit(10)));
 const recipDocs: string[] = [];
 sampleSnap.forEach(d => {
 const email = d.data().email;
 if (email && recipDocs.length < 10) {
 const [user, domain] = email.split('@');
 recipDocs.push(`${user.slice(0, 2)}***@${domain}`);
 }
 });
 if (!cancelled) setNlRecipients(recipDocs);
 } catch (err) {
 console.warn('[AdminPanel] Newsletter stats load failed:', err);
 } finally {
 if (!cancelled) setNlLoading(false);
 }
 })();
 return () => { cancelled = true; };
 }, [activeSection]);

 useEffect(() => {
 const refresh = () => setSerpDiagnostics(getSerpExperimentDiagnostics());
 refresh();
 const timer = setTimeout(refresh, 1200);
 return () => clearTimeout(timer);
 }, []);

 const loadJobsCrawlerAdminConfig = async () => {
 setJobsCrawlerConfigLoading(true);
 setJobsCrawlerConfigMessage(null);
 try {
 const fromStatic = async (): Promise<JobsCrawlerConfigState> => {
 const raw = await safeFetchJson('/data/jobs-crawler-config.json');
 if (!raw) return DEFAULT_JOBS_CRAWLER_CONFIG;
 return {
 domainWhitelist: Array.isArray(raw?.domainWhitelist) ? raw.domainWhitelist : [],
 domainBlacklist: Array.isArray(raw?.domainBlacklist) ? raw.domainBlacklist : [],
 minQualityScore: Number(raw?.minQualityScore || 6),
 minDescriptionChars: Number(raw?.minDescriptionChars || 160),
 aiLocalizationEnabled: Boolean(raw?.aiLocalizationEnabled),
 aiLocalizationMaxJobsPerRun: Number(raw?.aiLocalizationMaxJobsPerRun || 12),
 contentReuseEnabled: raw?.contentReuse?.enabled !== undefined ? Boolean(raw?.contentReuse?.enabled) : true,
 contentReuseSimilarityThreshold: Number(raw?.contentReuse?.similarityThreshold ?? 0.93),
 contentReuseMinSourceChars: Number(raw?.contentReuse?.minSourceChars ?? 220),
 contentReuseMaxLengthDeltaRatio: Number(raw?.contentReuse?.maxLengthDeltaRatio ?? 0.2),
 companyPriorityByDomain: raw?.companyPriority?.byDomain || {},
 companyPriorityByName: raw?.companyPriority?.byName || {},
 sourceSeedsByDomain: raw?.sourceSeeds?.byDomain || {},
 sourceSeedsByName: raw?.sourceSeeds?.byName || {},
 };
 };

 let cfg: JobsCrawlerConfigState | null = null;
 try {
 const { getFirestore, doc, getDoc } = await import('firebase/firestore');
 const { app } = await import('@/services/firebase');
 const db = getFirestore(app);
 const snap = await getDoc(doc(db, 'admin_config', 'jobsCrawler'));
 if (snap.exists()) {
 const raw = snap.data();
 cfg = {
 domainWhitelist: Array.isArray(raw?.domainWhitelist) ? raw.domainWhitelist : [],
 domainBlacklist: Array.isArray(raw?.domainBlacklist) ? raw.domainBlacklist : [],
 minQualityScore: Number(raw?.minQualityScore || 6),
 minDescriptionChars: Number(raw?.minDescriptionChars || 160),
 aiLocalizationEnabled: Boolean(raw?.aiLocalizationEnabled),
 aiLocalizationMaxJobsPerRun: Number(raw?.aiLocalizationMaxJobsPerRun || 12),
 contentReuseEnabled: raw?.contentReuse?.enabled !== undefined ? Boolean(raw?.contentReuse?.enabled) : true,
 contentReuseSimilarityThreshold: Number(raw?.contentReuse?.similarityThreshold ?? 0.93),
 contentReuseMinSourceChars: Number(raw?.contentReuse?.minSourceChars ?? 220),
 contentReuseMaxLengthDeltaRatio: Number(raw?.contentReuse?.maxLengthDeltaRatio ?? 0.2),
 companyPriorityByDomain: raw?.companyPriority?.byDomain || {},
 companyPriorityByName: raw?.companyPriority?.byName || {},
 sourceSeedsByDomain: raw?.sourceSeeds?.byDomain || {},
 sourceSeedsByName: raw?.sourceSeeds?.byName || {},
 };
 }
 } catch {
 // ignore firestore issues and fallback to static file
 }

 if (!cfg) cfg = await fromStatic();
 setJobsCrawlerConfig(cfg);
 setDomainWhitelistText((cfg.domainWhitelist || []).join('\n'));
 setDomainBlacklistText((cfg.domainBlacklist || []).join('\n'));
 setMinQualityScoreInput(Number(cfg.minQualityScore || 6));
 setMinDescriptionCharsInput(Number(cfg.minDescriptionChars || 160));
 setAiLocalizationEnabledInput(Boolean(cfg.aiLocalizationEnabled));
 setAiLocalizationMaxJobsPerRunInput(Number(cfg.aiLocalizationMaxJobsPerRun || 12));
 setContentReuseEnabledInput(Boolean(cfg.contentReuseEnabled));
 setContentReuseSimilarityThresholdInput(Number(cfg.contentReuseSimilarityThreshold ?? 0.93));
 setContentReuseMinSourceCharsInput(Number(cfg.contentReuseMinSourceChars ?? 220));
 setContentReuseMaxLengthDeltaRatioInput(Number(cfg.contentReuseMaxLengthDeltaRatio ?? 0.2));
 setCompanyPriorityByDomainText(JSON.stringify(cfg.companyPriorityByDomain || {}, null, 2));
 setCompanyPriorityByNameText(JSON.stringify(cfg.companyPriorityByName || {}, null, 2));
 setSourceSeedsByDomainText(JSON.stringify(cfg.sourceSeedsByDomain || {}, null, 2));
 setSourceSeedsByNameText(JSON.stringify(cfg.sourceSeedsByName || {}, null, 2));

 {
 const crawlerSummariesJson = await safeFetchJson('/data/jobs-crawler-summaries.json');
 const summaries = Array.isArray(crawlerSummariesJson?.summaries) ? crawlerSummariesJson.summaries : [];
 setCrawlerSummaries(
 summaries.map((entry: any) => ({
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
 })),
 );
 }
 {
 const crawlerWorkflowsJson = await safeFetchJson('/data/jobs-crawler-workflows.json');
 if (crawlerWorkflowsJson?.workflows) {
 setDynamicCrawlerWorkflows(
 (crawlerWorkflowsJson.workflows as any[]).map((w: any) => ({
 id: String(w.id || ''),
 title: String(w.title || ''),
 context: 'jobs' as WorkflowContext,
 description: String(w.description || ''),
 details: String(w.details || ''),
 expectedDuration: String(w.expectedDuration || '5-20 min'),
 schedule: w.schedule || undefined,
 summaryKey: w.summaryKey || null,
 defaultInputs: w.defaultInputs || undefined,
 })),
 );
 }
 }

 } catch (err) {
 setCrawlerSummaries([]);
 setJobsCrawlerConfigMessage(`Errore caricamento config crawler: ${err instanceof Error ? err.message : String(err)}`);
 } finally {
 setJobsCrawlerConfigLoading(false);
 }
 };

 const saveJobsCrawlerAdminConfig = async (
 domainWhitelistText: string,
 domainBlacklistText: string,
 minQualityScore: number,
 minDescriptionChars: number,
 aiLocalizationEnabled: boolean,
 aiLocalizationMaxJobsPerRun: number,
 contentReuseEnabled: boolean,
 contentReuseSimilarityThreshold: number,
 contentReuseMinSourceChars: number,
 contentReuseMaxLengthDeltaRatio: number,
 companyPriorityByDomainText: string,
 companyPriorityByNameText: string,
 sourceSeedsByDomainText: string,
 sourceSeedsByNameText: string,
 ) => {
 setJobsCrawlerConfigSaving(true);
 setJobsCrawlerConfigMessage(null);
 try {
 const domainWhitelist = parseListInput(domainWhitelistText);
 const domainBlacklist = parseListInput(domainBlacklistText);
 const companyPriorityByDomain = parseJsonObject(companyPriorityByDomainText);
 const companyPriorityByName = parseJsonObject(companyPriorityByNameText);
 const sourceSeedsByDomain = normalizeSeedMap(parseJsonObject(sourceSeedsByDomainText));
 const sourceSeedsByName = normalizeSeedMap(parseJsonObject(sourceSeedsByNameText));

 const payload = {
 domainWhitelist,
 domainBlacklist,
 minQualityScore: Math.max(4, Math.min(10, Math.round(minQualityScore))),
 minDescriptionChars: Math.max(80, Math.min(600, Math.round(minDescriptionChars))),
 aiLocalizationEnabled: Boolean(aiLocalizationEnabled),
 aiLocalizationMaxJobsPerRun: Math.max(0, Math.min(100, Math.round(aiLocalizationMaxJobsPerRun))),
 contentReuse: {
 enabled: Boolean(contentReuseEnabled),
 similarityThreshold: Math.max(0.7, Math.min(1, Number(contentReuseSimilarityThreshold))),
 minSourceChars: Math.max(120, Math.min(8000, Math.round(contentReuseMinSourceChars))),
 maxLengthDeltaRatio: Math.max(0.02, Math.min(1, Number(contentReuseMaxLengthDeltaRatio))),
 },
 companyPriority: {
 byDomain: companyPriorityByDomain,
 byName: companyPriorityByName,
 },
 sourceSeeds: {
 byDomain: sourceSeedsByDomain,
 byName: sourceSeedsByName,
 },
 updatedAt: new Date().toISOString(),
 };

 const { getFirestore, doc, setDoc } = await import('firebase/firestore');
 const { app } = await import('@/services/firebase');
 const db = getFirestore(app);
 await setDoc(doc(db, 'admin_config', 'jobsCrawler'), payload, { merge: true });

 setJobsCrawlerConfig({
 domainWhitelist: payload.domainWhitelist,
 domainBlacklist: payload.domainBlacklist,
 minQualityScore: payload.minQualityScore,
 minDescriptionChars: payload.minDescriptionChars,
 aiLocalizationEnabled: payload.aiLocalizationEnabled,
 aiLocalizationMaxJobsPerRun: payload.aiLocalizationMaxJobsPerRun,
 contentReuseEnabled: payload.contentReuse.enabled,
 contentReuseSimilarityThreshold: payload.contentReuse.similarityThreshold,
 contentReuseMinSourceChars: payload.contentReuse.minSourceChars,
 contentReuseMaxLengthDeltaRatio: payload.contentReuse.maxLengthDeltaRatio,
 companyPriorityByDomain: payload.companyPriority.byDomain,
 companyPriorityByName: payload.companyPriority.byName,
 sourceSeedsByDomain: payload.sourceSeeds.byDomain,
 sourceSeedsByName: payload.sourceSeeds.byName,
 });
 setJobsCrawlerConfigMessage('Configurazione crawler salvata su Firestore. Verrà applicata al prossimo run hourly.');
 } catch (err) {
 setJobsCrawlerConfigMessage(`Errore salvataggio config crawler: ${err instanceof Error ? err.message : String(err)}`);
 } finally {
 setJobsCrawlerConfigSaving(false);
 }
 };

 // Send test newsletter
 const sendTestNewsletter = async () => {
 if (!user?.email) {
 setNlSendResult('✗ Nessuna email admin disponibile nella sessione corrente.');
 return;
 }
 setNlSending(true);
 setNlSendResult(null);
 try {
 const state = await runWorkflowAction('send-newsletter.yml', {
 mode: 'test',
 target_email: String(user.email).trim().toLowerCase(),
 subject: nlSubject.trim() || 'Frontaliere Weekly',
 });
 if (state.conclusion === 'success') {
 setNlSendResult(`✓ Email test inviata a ${String(user.email).trim().toLowerCase()}.`);
 } else {
 setNlSendResult(`✗ Invio test non riuscito: ${state.error || state.message || 'controlla il workflow GitHub.'}`);
 }
 } catch (err) {
 setNlSendResult(`✗ Errore: ${err instanceof Error ? err.message : String(err)}`);
 } finally {
 setNlSending(false);
 }
 };

 const computeNewsletterInsights = (series: Array<{ date: string; rate: number }>): NewsletterInsight | null => {
 if (!series.length) return null;
 const mean = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
 const latest = series[series.length - 1].rate;
 const previousWeekRate = series[Math.max(0, series.length - 8)]?.rate || latest;
 const weeklyDeltaPct = previousWeekRate > 0 ? ((latest - previousWeekRate) / previousWeekRate) * 100 : 0;

 const now = new Date();
 const currentMonth = now.getMonth();
 const currentYear = now.getFullYear();
 const prevMonthDate = new Date(currentYear, currentMonth - 1, 1);
 const prevMonth = prevMonthDate.getMonth();
 const prevYear = prevMonthDate.getFullYear();

 const currentMonthValues = series.filter((p) => {
 const d = new Date(`${p.date}T00:00:00`);
 return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
 }).map((p) => p.rate);
 const prevMonthValues = series.filter((p) => {
 const d = new Date(`${p.date}T00:00:00`);
 return d.getMonth() === prevMonth && d.getFullYear() === prevYear;
 }).map((p) => p.rate);

 const currentMonthAvg = mean(currentMonthValues) || latest;
 const previousMonthAvg = mean(prevMonthValues) || previousWeekRate;
 const monthDeltaPct = previousMonthAvg > 0 ? ((currentMonthAvg - previousMonthAvg) / previousMonthAvg) * 100 : 0;

 const weekdays = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];
 const buckets = new Map<number, number[]>();
 for (const p of series) {
 const w = new Date(`${p.date}T00:00:00`).getDay();
 const arr = buckets.get(w) || [];
 arr.push(p.rate);
 buckets.set(w, arr);
 }
 let bestWeekday = 'N/D';
 let best = -Infinity;
 for (const [w, vals] of buckets.entries()) {
 const avg = mean(vals);
 if (avg > best) {
 best = avg;
 bestWeekday = weekdays[w] || 'N/D';
 }
 }

 const providers = [
 { name: 'Wise', feePct: 0.0025 },
 { name: 'Cambiovalute.ch', feePct: 0.0031 },
 { name: 'Revolut', feePct: 0.0028 },
 ];
 const providerRanking = providers
 .map((p) => ({ name: p.name, netEur: (1000 * (1 - p.feePct)) * latest }))
 .sort((a, b) => b.netEur - a.netEur);

 const recommendation = monthDeltaPct >= 0.4
 ? 'Fine mese favorevole: possibile conversione graduale CHF→EUR.'
 : monthDeltaPct <= -0.4
 ? 'Fine mese debole: meglio strategia a tranche e monitoraggio settimanale.'
 : 'Fine mese neutro: procedi a tranche e usa il comparatore per il provider.';

 return { currentRate: latest, previousWeekRate, weeklyDeltaPct, currentMonthAvg, previousMonthAvg, monthDeltaPct, bestWeekday, providerRanking, recommendation };
 };

 const fetchNewsletterInsights = async () => {
 setNlInsightLoading(true);
 try {
 const end = new Date();
 const start = new Date(end);
 start.setDate(end.getDate() - 120);
 const startStr = start.toISOString().slice(0, 10);
 const endStr = end.toISOString().slice(0, 10);

 const endpoints = [
 `https://api.frankfurter.dev/v2/rates?base=CHF&quotes=EUR&from=${startStr}&to=${endStr}`,
 `https://api.frankfurter.app/v2/rates?base=CHF&quotes=EUR&from=${startStr}&to=${endStr}`,
 ];

 let series: Array<{ date: string; rate: number }> = [];
 for (const url of endpoints) {
 try {
 const res = await fetch(url);
 if (!res.ok) continue;
 const data = await res.json();
 series = (Array.isArray(data) ? data : [])
 .map((entry: { date: string; rate: number }) => ({ date: entry.date, rate: Number(entry.rate || 0) }))
 .filter((r) => Number.isFinite(r.rate) && r.rate > 0)
 .sort((a, b) => a.date.localeCompare(b.date));
 if (series.length >= 20) break;
 } catch {
 // try next endpoint
 }
 }
 setNlInsights(computeNewsletterInsights(series));
 } finally {
 setNlInsightLoading(false);
 }
 };

 // Generate preview HTML with real data and the same template used for sending.
 const generatePreview = async () => {
 setNlPreviewLoading(true);
 setNlSendResult(null);
 try {
 const result = await buildNewsletterPreviewHtml({
 subject: nlSubject.trim() || '',
 });
 setNlPreviewHtml(result.html);
 // Update subject field with AI-generated subject if user hasn't typed one
 if (!nlSubject.trim() || nlSubject === 'Frontaliere Weekly') {
 setNlSubject(result.subject);
 }
 } catch (err) {
 setNlSendResult(`✗ Errore generazione anteprima: ${err instanceof Error ? err.message : String(err)}`);
 } finally {
 setNlPreviewLoading(false);
 }
 };

 const renderCrawlerConfigPanel = () => (
 <div className="space-y-4 mt-2">
 {jobsCrawlerConfigMessage && (
 <div className={`rounded-lg px-3 py-2 text-xs ${
 jobsCrawlerConfigMessage.toLowerCase().includes('errore')
 ? 'bg-danger-subtle border border-danger-border text-danger'
 : 'bg-success-subtle border border-success-border text-success'
 }`}>
 {jobsCrawlerConfigMessage}
 </div>
 )}
 {crawlerDispatchMessage && (
 <div className={`rounded-lg px-3 py-2 text-xs ${
 crawlerDispatchMessage.startsWith('✅')
 ? 'bg-success-subtle border border-success-border text-success'
 : 'bg-danger-subtle border border-danger-border text-danger'
 }`}>
 {crawlerDispatchMessage}
 </div>
 )}
 {parserDispatchMessage && (
 <div className={`rounded-lg px-3 py-2 text-xs ${
 parserDispatchMessage.startsWith('✅')
 ? 'bg-success-subtle border border-success-border text-success'
 : 'bg-danger-subtle border border-danger-border text-danger'
 }`}>
 {parserDispatchMessage}
 </div>
 )}
 <details className="group rounded-xl border border-edge bg-surface">
 <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer select-none">
 <Shield size={14} className="text-accent" />
 <span className="text-sm font-semibold text-strong">Configurazione crawler</span>
 <span className="ml-auto text-[10px] text-muted group-open:hidden">▸</span>
 <span className="ml-auto text-[10px] text-muted hidden group-open:inline">▾</span>
 </summary>
 <div className="px-4 pb-4 space-y-4 border-t border-edge">
 {/* Genera parser AI */}
 <div className="rounded-lg border border-edge bg-surface-alt/40 p-3 space-y-3 mt-4">
 <div className="text-xs font-semibold text-body">
 Genera parser/crawler AI per nuova azienda
 </div>
 <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
 <label className="text-sm text-subtle">
 Nome azienda
 <input
 type="text"
 value={parserCompanyName}
 onChange={(e) => setParserCompanyName(e.target.value)}
 placeholder="es. VF International"
 aria-label="Nome azienda"
 className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface text-strong"
 />
 </label>
 <label className="text-sm text-subtle">
 URL sito azienda
 <input
 type="url"
 value={parserCompanyWebsite}
 onChange={(e) => setParserCompanyWebsite(e.target.value)}
 placeholder="https://azienda.ch"
 aria-label="URL sito azienda"
 className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface text-strong"
 />
 </label>
 <label className="text-sm text-subtle">
 Company key (opzionale)
 <input
 type="text"
 value={parserCompanyKey}
 onChange={(e) => setParserCompanyKey(e.target.value)}
 placeholder="es. vf-international"
 aria-label="Company key"
 className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface text-strong"
 />
 </label>
 </div>
 <div className="flex flex-wrap items-center gap-2">
 <button
 type="button"
 onClick={() => setParserApplyConfig((v) => !v)}
 className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors ${
 parserApplyConfig
 ? 'border-warning-border bg-warning-subtle text-warning'
 : 'border-edge bg-surface text-body'
 }`}
 >
 {parserApplyConfig ? <ToggleRight size={13} /> : <ToggleLeft size={13} />}
 {parserApplyConfig ? 'Applica config automaticamente' : 'Solo proposta (no apply)'}
 </button>
 <button
 onClick={runGenerateParserNow}
 disabled={parserDispatchLoading}
 className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover disabled:opacity-60 text-on-accent text-xs font-semibold transition-colors"
 >
 <Terminal size={13} className={parserDispatchLoading ? 'animate-pulse' : ''} />
 {parserDispatchLoading ? 'Generazione…' : 'Genera parser AI'}
 </button>
 </div>
 </div>

 {/* ── Section 1: Quality Gates ── */}
 <details className="group rounded-lg border border-edge bg-surface/50" open>
 <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer select-none">
 <Shield size={14} className="text-warning" />
 <span className="text-sm font-semibold text-strong">Filtri qualità</span>
 <span className="ml-auto text-[10px] text-muted group-open:hidden">▸</span>
 <span className="ml-auto text-[10px] text-muted hidden group-open:inline">▾</span>
 </summary>
 <div className="px-4 pb-4 space-y-3">
 <p className="text-[11px] text-muted">Soglie minime per accettare un annuncio. Job sotto queste soglie vengono scartati.</p>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
 <label className="text-sm text-subtle">
 <span className="flex items-center gap-1">Punteggio qualità minimo <span className="text-[10px] text-muted">(4–10)</span></span>
 <input type="number" inputMode="numeric" min={4} max={10} value={minQualityScoreInput} onChange={e => setMinQualityScoreInput(Number(e.target.value))}
 aria-label="Punteggio qualità minimo"
 className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong text-sm" />
 </label>
 <label className="text-sm text-subtle">
 <span className="flex items-center gap-1">Lunghezza descrizione minima <span className="text-[10px] text-muted">(80–600 car.)</span></span>
 <input type="number" inputMode="numeric" min={80} max={600} value={minDescriptionCharsInput} onChange={e => setMinDescriptionCharsInput(Number(e.target.value))}
 aria-label="Lunghezza descrizione minima"
 className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong text-sm" />
 </label>
 </div>
 </div>
 </details>

 {/* ── Section 2: AI Localization ── */}
 <details className="group rounded-lg border border-edge bg-surface/50">
 <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer select-none">
 <Activity size={14} className="text-accent" />
 <span className="text-sm font-semibold text-strong">Traduzione AI</span>
 <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold ${aiLocalizationEnabledInput ? 'bg-success-subtle text-success' : 'bg-surface-raised text-muted'}`}>
 {aiLocalizationEnabledInput ? 'ON' : 'OFF'}
 </span>
 <span className="ml-auto text-[10px] text-muted group-open:hidden">▸</span>
 <span className="ml-auto text-[10px] text-muted hidden group-open:inline">▾</span>
 </summary>
 <div className="px-4 pb-4 space-y-3">
 <p className="text-[11px] text-muted">Traduzione automatica annunci in IT/EN/DE/FR tramite LLM (free-first, paid fallback).</p>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
 <label className="text-sm text-subtle">
 Stato
 <button type="button" onClick={() => setAiLocalizationEnabledInput(v => !v)}
 className={`mt-1 w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border transition-colors text-sm font-medium ${
 aiLocalizationEnabledInput
 ? 'border-success-border bg-success-subtle text-success'
 : 'border-edge bg-surface-alt text-body'
 }`}>
 {aiLocalizationEnabledInput ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
 {aiLocalizationEnabledInput ? 'Attivo' : 'Disattivo'}
 </button>
 </label>
 <label className="text-sm text-subtle">
 <span className="flex items-center gap-1">Max job tradotti per run <span className="text-[10px] text-muted">(0–100)</span></span>
 <input type="number" inputMode="numeric" min={0} max={100} value={aiLocalizationMaxJobsPerRunInput} onChange={e => setAiLocalizationMaxJobsPerRunInput(Number(e.target.value))}
 aria-label="Max job tradotti per run"
 className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong text-sm" />
 </label>
 </div>
 </div>
 </details>

 {/* ── Section 3: Content Reuse ── */}
 <details className="group rounded-lg border border-edge bg-surface/50">
 <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer select-none">
 <Copy size={14} className="text-link" />
 <span className="text-sm font-semibold text-strong">Riuso traduzioni</span>
 <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold ${contentReuseEnabledInput ? 'bg-success-subtle text-success' : 'bg-surface-raised text-muted'}`}>
 {contentReuseEnabledInput ? 'ON' : 'OFF'}
 </span>
 <span className="ml-auto text-[10px] text-muted group-open:hidden">▸</span>
 <span className="ml-auto text-[10px] text-muted hidden group-open:inline">▾</span>
 </summary>
 <div className="px-4 pb-4 space-y-3">
 <p className="text-[11px] text-muted">Se la descrizione di un job è molto simile al run precedente, riusa le traduzioni già fatte (risparmia crediti AI).</p>
 <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
 <label className="text-sm text-subtle">
 Stato
 <button type="button" onClick={() => setContentReuseEnabledInput(v => !v)}
 className={`mt-1 w-full inline-flex items-center justify-center gap-1 px-2 py-2 rounded-lg border text-sm font-medium transition-colors ${
 contentReuseEnabledInput
 ? 'border-success-border bg-success-subtle text-success'
 : 'border-edge bg-surface-alt text-body'
 }`}>
 {contentReuseEnabledInput ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
 {contentReuseEnabledInput ? 'ON' : 'OFF'}
 </button>
 </label>
 <label className="text-sm text-subtle">
 <span>Similarità min <span className="text-[10px] text-muted">(0.70–1.00)</span></span>
 <input type="number" inputMode="decimal" min={0.7} max={1} step={0.01} value={contentReuseSimilarityThresholdInput} onChange={e => setContentReuseSimilarityThresholdInput(Number(e.target.value))}
 aria-label="Soglia similarità minima"
 className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong text-sm" />
 </label>
 <label className="text-sm text-subtle">
 <span>Char sorgente min <span className="text-[10px] text-muted">(120–8000)</span></span>
 <input type="number" inputMode="numeric" min={120} max={8000} value={contentReuseMinSourceCharsInput} onChange={e => setContentReuseMinSourceCharsInput(Number(e.target.value))}
 aria-label="Caratteri sorgente minimi"
 className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong text-sm" />
 </label>
 <label className="text-sm text-subtle">
 <span>Delta lunghezza max <span className="text-[10px] text-muted">(0.02–1.00)</span></span>
 <input type="number" inputMode="decimal" min={0.02} max={1} step={0.01} value={contentReuseMaxLengthDeltaRatioInput} onChange={e => setContentReuseMaxLengthDeltaRatioInput(Number(e.target.value))}
 aria-label="Delta lunghezza massimo"
 className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong text-sm" />
 </label>
 </div>
 </div>
 </details>

 {/* ── Section 4: Domain Scope ── */}
 <details className="group rounded-lg border border-edge bg-surface/50">
 <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer select-none">
 <Shield size={14} className="text-subtle" />
 <span className="text-sm font-semibold text-strong">Filtro domini</span>
 <span className="ml-2 text-[10px] text-muted">{domainWhitelistText.split('\n').filter(Boolean).length} whitelist · {domainBlacklistText.split('\n').filter(Boolean).length} blacklist</span>
 <span className="ml-auto text-[10px] text-muted group-open:hidden">▸</span>
 <span className="ml-auto text-[10px] text-muted hidden group-open:inline">▾</span>
 </summary>
 <div className="px-4 pb-4 space-y-3">
 <p className="text-[11px] text-muted">Whitelist: se compilata, solo questi domini vengono crawlati. Blacklist: domini sempre esclusi.</p>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
 <label className="text-sm text-subtle">
 Domain Whitelist <span className="text-[10px] text-muted">(1 host per riga)</span>
 <textarea rows={5} value={domainWhitelistText} onChange={e => setDomainWhitelistText(e.target.value)} placeholder="esempio.com"
 aria-label="Domain Whitelist"
 className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong font-mono text-xs" />
 </label>
 <label className="text-sm text-subtle">
 Domain Blacklist <span className="text-[10px] text-muted">(1 host per riga)</span>
 <textarea rows={5} value={domainBlacklistText} onChange={e => setDomainBlacklistText(e.target.value)} placeholder="esempio-da-escludere.com"
 aria-label="Domain Blacklist"
 className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong font-mono text-xs" />
 </label>
 </div>
 </div>
 </details>

 {/* ── Section 5: Company Priority & Seeds ── */}
 <details className="group rounded-lg border border-edge bg-surface/50">
 <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer select-none">
 <Database size={14} className="text-success" />
 <span className="text-sm font-semibold text-strong">Priorità aziende &amp; seed URL</span>
 <span className="ml-auto text-[10px] text-muted group-open:hidden">▸</span>
 <span className="ml-auto text-[10px] text-muted hidden group-open:inline">▾</span>
 </summary>
 <div className="px-4 pb-4 space-y-3">
 <p className="text-[11px] text-muted">Priorità: punteggio numerico per ordinare le aziende nel crawl. Seed: URL career page iniziali.</p>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
 <label className="text-sm text-subtle">
 Priorità per dominio <span className="text-[10px] text-muted">(JSON: {`{"host": score}`})</span>
 <textarea rows={6} value={companyPriorityByDomainText} onChange={e => setCompanyPriorityByDomainText(e.target.value)}
 aria-label="Priorità per dominio"
 className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong font-mono text-xs" />
 </label>
 <label className="text-sm text-subtle">
 Priorità per nome <span className="text-[10px] text-muted">(JSON: {`{"name": score}`})</span>
 <textarea rows={6} value={companyPriorityByNameText} onChange={e => setCompanyPriorityByNameText(e.target.value)}
 aria-label="Priorità per nome"
 className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong font-mono text-xs" />
 </label>
 </div>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
 <label className="text-sm text-subtle">
 Seed URL per dominio <span className="text-[10px] text-muted">(JSON: {`{"host": ["url1","url2"]}`})</span>
 <textarea rows={6} value={sourceSeedsByDomainText} onChange={e => setSourceSeedsByDomainText(e.target.value)}
 aria-label="Seed URL per dominio"
 className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong font-mono text-xs" />
 </label>
 <label className="text-sm text-subtle">
 Seed URL per nome azienda <span className="text-[10px] text-muted">(JSON: {`{"name": ["url1"]}`})</span>
 <textarea rows={6} value={sourceSeedsByNameText} onChange={e => setSourceSeedsByNameText(e.target.value)}
 aria-label="Seed URL per nome azienda"
 className="mt-1 w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-strong font-mono text-xs" />
 </label>
 </div>
 </div>
 </details>

 {/* ── Save ── */}
 <div className="flex flex-wrap items-center gap-3 pt-2">
 <button
 onClick={() => saveJobsCrawlerAdminConfig(
 domainWhitelistText,
 domainBlacklistText,
 minQualityScoreInput,
 minDescriptionCharsInput,
 aiLocalizationEnabledInput,
 aiLocalizationMaxJobsPerRunInput,
 contentReuseEnabledInput,
 contentReuseSimilarityThresholdInput,
 contentReuseMinSourceCharsInput,
 contentReuseMaxLengthDeltaRatioInput,
 companyPriorityByDomainText,
 companyPriorityByNameText,
 sourceSeedsByDomainText,
 sourceSeedsByNameText,
 )}
 disabled={jobsCrawlerConfigSaving || jobsCrawlerConfigLoading}
 className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent hover:bg-accent-hover disabled:opacity-60 text-on-accent text-sm font-semibold transition-colors"
 >
 {jobsCrawlerConfigSaving ? <RefreshCw size={14} className="animate-spin" /> : <Database size={14} />}
 Salva configurazione
 </button>
 <span className="text-[11px] text-muted">
 Salvato in Firestore · applicato al prossimo run crawler.
 </span>
 </div>
 </div>
 </details>
 </div>
 );

 const refreshOwnerStats = async () => {
 setOwnerStats(prev => ({ ...prev, loading: true, error: null }));
 try {
 const [socialProofSnap, simulationCountSnap, forumCountSnap, newsletterCountSnap, files] = await Promise.all([
 (async () => {
 const { getFirestore, doc, getDoc } = await import('firebase/firestore');
 const { app } = await import('@/services/firebase');
 const db = getFirestore(app);
 return getDoc(doc(db, 'counters', 'simulations'));
 })(),
 (async () => {
 const { getFirestore, collection, getCountFromServer } = await import('firebase/firestore');
 const { app } = await import('@/services/firebase');
 const db = getFirestore(app);
 return getCountFromServer(collection(db, 'simulations'));
 })(),
 (async () => {
 const { getFirestore, collection, getCountFromServer } = await import('firebase/firestore');
 const { app } = await import('@/services/firebase');
 const db = getFirestore(app);
 return getCountFromServer(collection(db, 'forum_questions'));
 })(),
 (async () => {
 const { getFirestore, collection, query, where, getCountFromServer } = await import('firebase/firestore');
 const { app } = await import('@/services/firebase');
 const db = getFirestore(app);
 return getCountFromServer(query(collection(db, 'newsletter_subscribers'), where('isActive', '==', true)));
 })(),
 (async () => {
 const checks = ['sitemap.xml', 'sitemap_news.xml', 'robots.txt', 'llms.txt', 'manifest.webmanifest'];
 const results: Record<string, boolean> = {};
 await Promise.all(checks.map(async (f) => {
 try {
 const res = await fetch(`/${f}`, { method: 'GET', cache: 'no-store' });
 results[f] = res.ok;
 } catch {
 results[f] = false;
 }
 }));
 return results;
 })(),
 ]);

 setOwnerStats({
 loading: false,
 error: null,
 socialProofTotal: socialProofSnap.exists() ? Number(socialProofSnap.data()?.total || 0) : 0,
 simulationDocs: simulationCountSnap.data().count,
 forumQuestions: forumCountSnap.data().count,
 newsletterActive: newsletterCountSnap.data().count,
 publicFiles: files,
 });
 } catch (err) {
 setOwnerStats(prev => ({
 ...prev,
 loading: false,
 error: err instanceof Error ? err.message : 'Errore sconosciuto',
 }));
 }
 };

 useEffect(() => {
 if (activeSection !== 'owner' && activeSection !== 'jobs') return;
 refreshOwnerStats();
 loadJobsCrawlerAdminConfig();
 }, [activeSection]);

 useEffect(() => {
 if (!['jobs', 'content', 'seo', 'analytics'].includes(activeSection)) return;
 refreshWorkflowSnapshots();
 }, [activeSection]);

 useEffect(() => {
 if (hasPreloadedWorkflowSnapshots.current) return;
 hasPreloadedWorkflowSnapshots.current = true;
 refreshWorkflowSnapshots();
 }, []);

 // Re-fetch workflow snapshots when dynamic crawler list loads (stale closure fix)
 useEffect(() => {
 if (dynamicCrawlerWorkflows.length === 0) return;
 refreshWorkflowSnapshots();
 }, [dynamicCrawlerWorkflows]);

 const getWorkflowTabSummary = (context: WorkflowContext) => {
 const workflows = workflowActions.filter((wf) => wf.context === context && !wf.isUtility);
 let ok = 0;
 let error = 0;
 let pending = 0;
 for (const workflow of workflows) {
 const state = workflowStates[workflow.id];
 if (!state) { pending += 1; continue; }
 const status = String(state.status || '').toLowerCase();
 const conclusion = String(state.conclusion || '').toLowerCase();
 if (status === 'in_progress' || status === 'queued') {
 pending += 1;
 continue;
 }
 if (conclusion === 'success') {
 ok += 1;
 continue;
 }
 if (
 state.error ||
 ['failure', 'cancelled', 'timed_out', 'action_required'].includes(conclusion)
 ) {
 error += 1;
 } else {
 pending += 1;
 }
 }
 return { ok, error, pending };
 };

 const renderWorkflowControlRoom = (context: WorkflowContext) => {
 const meta = WORKFLOW_CONTEXT_META[context];
 const grouped = workflowActions.filter((wf) => wf.context === context && !wf.isUtility);
 const isJobsContext = context === 'jobs';

 const findCrawlerSummary = (wf: { id: string; summaryKey?: string | null }): CrawlerSummaryRow | undefined => {
 const slug = wf.id.replace(/^update-jobs-/, '').replace(/\.yml$/, '');
 // 1. Exact match on summaryKey extracted from crawler script at build time
 if (wf.summaryKey) {
 const byKey = crawlerSummaries.find(s => s.key === wf.summaryKey);
 if (byKey) return byKey;
 }
 // 2. Exact match on workflow filename slug
 const exact = crawlerSummaries.find(s => s.key === slug);
 if (exact) return exact;
 // 3. Fuzzy: summary key contains slug or slug contains summary key
 return crawlerSummaries.find(s =>
 s.key.includes(slug) || slug.includes(s.key.replace(/-/g, ''))
 );
 };

 const relativeTime = (iso: string | null) => {
 if (!iso) return null;
 const diff = Date.now() - Date.parse(iso);
 if (diff < 0 || isNaN(diff)) return null;
 const mins = Math.floor(diff / 60000);
 if (mins < 1) return 'adesso';
 if (mins < 60) return `${mins}m fa`;
 const hrs = Math.floor(mins / 60);
 if (hrs < 24) return `${hrs}h fa`;
 const days = Math.floor(hrs / 24);
 return days === 1 ? 'ieri' : `${days}gg fa`;
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
 <div className="flex items-center justify-between">
 <h2 className="text-lg font-bold font-display text-strong flex items-center gap-2">
 <ListChecks size={20} className="text-accent" />
 {meta.label}
 </h2>
 <div className="flex items-center gap-2">
 {isJobsContext && (
 <button
 onClick={runCrawlerNow}
 disabled={crawlerDispatchLoading}
 className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-success-strong hover:bg-success-strong-hover disabled:opacity-60 text-on-accent text-sm font-medium transition-colors"
 >
 <Send size={14} className={crawlerDispatchLoading ? 'animate-pulse' : ''} />
 {crawlerDispatchLoading ? 'Avvio…' : 'Run crawler now'}
 </button>
 )}
 <button
 onClick={refreshWorkflowSnapshots}
 className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-accent hover:bg-accent-hover text-on-accent text-sm font-medium transition-colors"
 >
 <ListChecks size={14} />
 Aggiorna stati workflow
 </button>
 <button
 onClick={loadJobsCrawlerAdminConfig}
 className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-raised text-body text-sm font-medium hover:bg-surface-raised transition-colors"
 >
 <RefreshCw size={14} />
 Ricarica
 </button>
 </div>
 </div>

 <div className="bg-surface rounded-xl border border-edge p-4 space-y-4">
 <div className="rounded-lg border border-edge bg-surface-alt/40 p-3">
 <div className="text-xs font-semibold text-body mb-2">
 Azioni automatiche: avvio workflow e monitoraggio completo
 </div>
 <p className="text-sm text-muted">
 Ogni bottone avvia un workflow GitHub, ne mostra lo stato in tempo reale e riassume output/errori direttamente qui.
 </p>
 </div>

 {isJobsContext ? (
 <div className="space-y-3">
 {(() => {
 // Build unified row list: workflows + unmatched summaries, sorted by schedule
 type JobRow = { key: string; title: string; description: string; schedule: string | null; wf: typeof grouped[0] | null; summary: CrawlerSummaryRow | undefined };
 const rows: JobRow[] = grouped.map(wf => {
 const summary = findCrawlerSummary(wf);
 return { key: wf.id, title: wf.title, description: wf.description, schedule: wf.schedule || null, wf, summary };
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
 }
 }
 return true;
 });

 const getCrawlerStatusRank = (row: JobRow): number => {
 const wfState = row.wf ? getWorkflowState(row.wf.id) : null;
 const isSuccess = wfState?.status === 'completed' && wfState.conclusion === 'success';
 const isFailure = wfState?.status === 'completed' && wfState.conclusion != null && wfState.conclusion !== 'success';
 const isRunning = wfState?.loading || wfState?.status === 'queued' || wfState?.status === 'in_progress';
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
 if (jobs.length === 0) return <div className="text-[11px] text-muted py-1">Nessun elemento.</div>;
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
 const borderColor = type === 'active' && job._status
 ? (job._status === 'new' ? 'border-l-emerald-500' : job._status === 'updated' ? 'border-l-stripe-500' : 'border-l-amber-400')
 : '';
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
 <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-bold ${color} cursor-help`} title={tip}>
 {qs}
 </span>
 );
 })() : null;
 return (
 <div key={`${job.slug || idx}`} className={`rounded-md border px-2 py-1.5 ${rowStyle} ${borderColor ? `border-l-2 ${borderColor}` : ''}`}>
 <div className="flex items-center gap-1.5">
 <span className="text-xs font-medium text-strong">{job.title || 'Job senza titolo'}</span>
 {qsBadge}
 </div>
 <div className="text-[11px] text-muted">
 {job.company || 'Azienda n/d'}{job.location ? ` \u00B7 ${job.location}` : ''}
 </div>
 <div className="flex gap-3 mt-0.5">
 {job.url && <a href={job.url} target="_blank" rel="noreferrer" className="text-[10px] text-link hover:underline">🔗 Sorgente</a>}
 {siteUrl && (type === 'removed' ? (
 <a href={siteUrl} target="_blank" rel="noreferrer" className="text-[10px] text-muted hover:underline">🏚 Sito (archiviato)</a>
 ) : (
 <a href={siteUrl} target="_blank" rel="noreferrer" className="text-[10px] text-accent hover:underline">🏠 Sito</a>
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
 setCrawlerSort((prev) => (
 prev.column === column
 ? { column, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
 : { column, direction: column === 'title' ? 'asc' : 'desc' }
 ));
 }}
 className={`inline-flex w-full items-center gap-1 ${justifyClass} ${options?.className || ''} hover:text-heading `}
 >
 <span>{label}</span>
 <Icon size={11} className={isActive ? 'opacity-100' : 'opacity-25'} />
 </button>
 );
 };

 const failedCrawlers = rows.filter(r => {
 if (!r.wf) return false;
 const st = getWorkflowState(r.wf.id);
 return st.status === 'completed' && st.conclusion != null && st.conclusion !== 'success';
 });

 const retryAllFailed = async () => {
 if (failedCrawlers.length === 0 || retryFailedProgress?.running) return;
 setRetryFailedProgress({ running: true, current: 0, total: failedCrawlers.length, currentLabel: '' });
 for (let i = 0; i < failedCrawlers.length; i++) {
 const row = failedCrawlers[i];
 setRetryFailedProgress({ running: true, current: i + 1, total: failedCrawlers.length, currentLabel: row.title });
 await runWorkflowAction(row.wf!.id);
 }
 setRetryFailedProgress(null);
 };

 return (
 <>
 {/* Summary bar + filters */}
 <div className="flex flex-col gap-2">
 <div className="flex flex-wrap items-center gap-3 px-3 py-2 rounded-lg bg-surface-alt/40 border border-edge text-xs">
 <span className="font-semibold text-body">{filtered.length}/{rows.length} crawler</span>
 {/* Source badge: makes clear these numbers are per-crawler last-run diffs,
 NOT the daily job-board delta from jobs-stats.json (todayAdded/todayUpdated/todayRemoved). */}
 <span
 className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-warning-subtle text-warning font-semibold text-[10px] uppercase tracking-wide"
 title="Aggiunti / Aggiornati / Rimossi / Invariati mostrano il diff dell'ultima singola esecuzione di ogni crawler. Sono metriche distinte dal delta giornaliero del job board (jobs-stats.json) che confronta l'intero board con il commit HEAD della giornata."
 >
 Δ ultima run
 </span>
 {latestSummaryAt && (
 <span
 className="text-muted text-[10px] font-mono whitespace-nowrap"
 title={`Dati aggiornati: ${latestSummaryAt}`}
 >
 {relativeTime(latestSummaryAt)}
 </span>
 )}
 <span className="text-muted">|</span>
 <span className="font-semibold text-subtle">{totals.active} annunci attivi</span>
 {totals.newCount > 0 && <span className="text-success font-bold" title="Totale aggiunti nelle ultime run (Δ run, ≠ delta giornaliero)">+{totals.newCount} nuove</span>}
 {totals.updated > 0 && <span className="text-accent font-bold" title="Totale aggiornati nelle ultime run (Δ run, ≠ delta giornaliero)">~{totals.updated} agg.</span>}
 {totals.removed > 0 && <span className="text-danger font-bold" title="Totale rimossi nelle ultime run (Δ run, ≠ delta giornaliero)">-{totals.removed} rim.</span>}
 {totals.unchanged > 0 && <span className="text-muted" title="Totale invariati nelle ultime run (Δ run, ≠ delta giornaliero)">={totals.unchanged} inv.</span>}
 {failedCrawlers.length > 0 && (
 <>
 <span className="text-muted">|</span>
 <span className="text-danger font-bold">{failedCrawlers.length} falliti</span>
 </>
 )}
 {failedCrawlers.length > 0 && (
 <button
 onClick={() => void retryAllFailed()}
 disabled={!!retryFailedProgress?.running}
 className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-danger-strong hover:bg-danger-strong-hover disabled:opacity-60 text-on-accent text-[11px] font-semibold transition-colors"
 aria-label={`Rilancia ${failedCrawlers.length} crawler falliti`}
 >
 {retryFailedProgress?.running ? (
 <><Loader2 size={12} className="animate-spin" /> {retryFailedProgress.current}/{retryFailedProgress.total}</>
 ) : (
 <><RotateCcw size={12} /> Rilancia {failedCrawlers.length} falliti</>
 )}
 </button>
 )}
 {/* Orchestrator dispatch button */}
 {(() => {
 const orchState = getWorkflowState('orchestrate-crawlers.yml');
 const orchRunning = orchState.status === 'in_progress' || orchState.status === 'queued' || orchState.loading;
 return (
 <button
 onClick={() => void runWorkflowAction('orchestrate-crawlers.yml', { group: 'all', delay_seconds: '20', dry_run: 'false' })}
 disabled={orchRunning}
 className={`inline-flex items-center gap-1.5 ${failedCrawlers.length === 0 ? 'ml-auto' : ''} px-3 py-1.5 rounded-md bg-accent hover:bg-accent-hover disabled:opacity-60 text-on-accent text-[11px] font-semibold transition-colors`}
 aria-label="Avvia orchestratore crawler"
 >
 {orchRunning ? (
 <><Loader2 size={12} className="animate-spin" /> Orchestratore in corso…</>
 ) : (
 <><Zap size={12} /> Lancia tutti i crawler</>
 )}
 </button>
 );
 })()}
 </div>
 {retryFailedProgress?.running && (
 <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-warning-subtle border border-warning-border text-xs text-warning">
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
 onChange={e => setCrawlerNameFilter(e.target.value)}
 placeholder="Filtra crawler…"
 className="pl-7 pr-2 py-1.5 rounded-md border border-edge bg-surface text-xs text-strong w-44 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
 aria-label="Filtra per nome crawler"
 />
 </div>
 <select
 value={crawlerChangeFilter}
 onChange={e => setCrawlerChangeFilter(e.target.value as typeof crawlerChangeFilter)}
 className="px-2 py-1.5 rounded-md border border-edge bg-surface text-xs text-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
 aria-label="Filtra per tipo variazione"
 >
 <option value="all">Tutte le variazioni</option>
 <option value="new">Con aggiunti</option>
 <option value="updated">Con aggiornati</option>
 <option value="removed">Con rimossi</option>
 <option value="none">Nessuna variazione</option>
 </select>
 {(crawlerNameFilter || crawlerChangeFilter !== 'all') && (
 <button
 onClick={() => { setCrawlerNameFilter(''); setCrawlerChangeFilter('all'); }}
 className="text-[10px] text-link hover:underline"
 >
 Rimuovi filtri
 </button>
 )}
 </div>
 </div>

 {/* Table */}
 <div className="w-full overflow-x-auto rounded-lg border border-edge">
 <table className="min-w-[800px] w-full text-xs">
 <thead>
 <tr className="bg-surface-alt/40 text-subtle border-b border-edge">
 <th className="text-left py-2 px-3 font-semibold">{renderCrawlerSortHeader('title', 'Crawler')}</th>
 <th className="text-center py-2 px-2 font-semibold whitespace-nowrap">{renderCrawlerSortHeader('schedule', '⏰ Pianif.', { align: 'center' })}</th>
 <th className="text-center py-2 px-2 font-semibold">{renderCrawlerSortHeader('lastRun', 'Ultimo', { align: 'center' })}</th>
 <th className="text-center py-2 px-1.5 font-semibold text-success whitespace-nowrap" title="Nuove offerte aggiunte nell'ultima esecuzione del crawler (Δ run — distinto dal delta giornaliero del job board)">{renderCrawlerSortHeader('newCount', 'Aggiunti', { align: 'center', className: 'text-success' })}</th>
 <th className="text-center py-2 px-1.5 font-semibold text-accent whitespace-nowrap" title="Offerte aggiornate nell'ultima esecuzione del crawler (Δ run — distinto dal delta giornaliero del job board)">{renderCrawlerSortHeader('updatedCount', 'Aggiornati', { align: 'center', className: 'text-accent' })}</th>
 <th className="text-center py-2 px-1.5 font-semibold text-danger whitespace-nowrap" title="Offerte rimosse nell'ultima esecuzione del crawler (Δ run — distinto dal delta giornaliero del job board)">{renderCrawlerSortHeader('removedCount', 'Rimossi', { align: 'center', className: 'text-danger' })}</th>
 <th className="text-center py-2 px-1.5 font-semibold text-muted whitespace-nowrap" title="Offerte non cambiate nell'ultima esecuzione del crawler (Δ run — distinto dal delta giornaliero del job board)">{renderCrawlerSortHeader('unchangedCount', 'Invariati', { align: 'center', className: 'text-muted' })}</th>
 <th className="text-center py-2 px-1.5 font-semibold text-accent whitespace-nowrap" title="Totale offerte attive nella slice del crawler (dal job slice, non dal delta dell'ultima run)">{renderCrawlerSortHeader('total', 'Attivi', { align: 'center', className: 'text-accent' })}</th>
 <th className="text-center py-2 px-1.5 font-semibold text-muted whitespace-nowrap">{renderCrawlerSortHeader('duration', '⏱️ Durata', { align: 'center', className: 'text-muted' })}</th>
 <th className="text-center py-2 px-1.5 font-semibold whitespace-nowrap" title="Quality score: media ponderata su pulizia testo, ricchezza contenuto, qualità traduzione, completezza dati (0–100)">{renderCrawlerSortHeader('quality', '📊 Qualità', { align: 'center' })}</th>
 <th className="text-center py-2 px-2 font-semibold">{renderCrawlerSortHeader('status', 'Stato', { align: 'center' })}</th>
 <th className="text-center py-2 px-2 font-semibold">Azioni</th>
 </tr>
 </thead>
 <tbody>
 {sorted.map(row => {
 const wfState = row.wf ? getWorkflowState(row.wf.id) : null;
 const isSuccess = wfState?.status === 'completed' && wfState.conclusion === 'success';
 const isFailure = wfState?.status === 'completed' && wfState.conclusion != null && wfState.conclusion !== 'success';
 const isRunning = wfState?.loading || wfState?.status === 'queued' || wfState?.status === 'in_progress';
 const failedSteps = wfState?.jobs.flatMap(j => j.failedSteps.map(s => `${j.name}: ${s}`)) || [];
 const lastRunAgo = wfState?.updatedAt ? relativeTime(wfState.updatedAt)
 : row.summary?.generatedAt ? relativeTime(row.summary.generatedAt) : null;
 const s = row.summary;
 const expanded = expandedCrawlerDetail[row.key] || null;

 return (
 <Fragment key={row.key}>
 <tr className={`border-b border-edge hover:bg-surface-alt/70 /40 ${
 row.wf?.id === 'orchestrate-crawlers.yml' ? 'bg-accent-subtle/50'
 : isFailure ? 'bg-danger-subtle/50' : ''
 }`}>
 {/* Crawler name */}
 <td className="py-2 px-3" title={row.description}>
 <span className={`font-semibold ${row.wf?.id === 'orchestrate-crawlers.yml' ? 'text-accent' : 'text-strong'}`}>{row.title}</span>
 </td>
 {/* Schedule */}
 <td className="text-center py-2 px-2 font-mono text-[11px] text-subtle whitespace-nowrap">
 {row.schedule ? <span title={`UTC ${row.schedule}`}>{row.schedule}</span> : '—'}
 </td>
 {/* Last run */}
 <td className="text-center py-2 px-2 text-[11px] text-muted whitespace-nowrap">
 {lastRunAgo || '—'}
 </td>
 {/* Aggiunti */}
 <td className="text-center py-2 px-1.5">
 {s && s.newCount > 0 ? (
 <button onClick={() => toggleExpand(row.key, 'new')}
 className={`inline-flex items-center gap-0.5 text-success font-bold hover:underline cursor-pointer ${expanded === 'new' ? 'underline' : ''}`}>
 {expanded === 'new' ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
 +{s.newCount}
 </button>
 ) : s ? (
 <span className="text-muted text-[10px]">0</span>
 ) : '—'}
 </td>
 {/* Aggiornati */}
 <td className="text-center py-2 px-1.5">
 {s && s.updatedCount > 0 ? (
 <button onClick={() => toggleExpand(row.key, 'updated')}
 className={`inline-flex items-center gap-0.5 text-accent font-bold hover:underline cursor-pointer ${expanded === 'updated' ? 'underline' : ''}`}>
 {expanded === 'updated' ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
 ~{s.updatedCount}
 </button>
 ) : s ? (
 <span className="text-muted text-[10px]">0</span>
 ) : '—'}
 </td>
 {/* Rimossi */}
 <td className="text-center py-2 px-1.5">
 {s && s.removedCount > 0 ? (
 <button onClick={() => toggleExpand(row.key, 'removed')}
 className={`inline-flex items-center gap-0.5 text-danger font-bold hover:underline cursor-pointer ${expanded === 'removed' ? 'underline' : ''}`}>
 {expanded === 'removed' ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
 -{s.removedCount}
 </button>
 ) : s ? (
 <span className="text-muted text-[10px]">0</span>
 ) : '—'}
 </td>
 {/* Invariati */}
 <td className="text-center py-2 px-1.5">
 {s && s.unchangedCount > 0 ? (
 <button onClick={() => toggleExpand(row.key, 'unchanged')}
 className={`inline-flex items-center gap-0.5 text-warning font-bold hover:underline cursor-pointer ${expanded === 'unchanged' ? 'underline' : ''}`}>
 {expanded === 'unchanged' ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
 {s.unchangedCount}
 </button>
 ) : s ? (
 <span className="text-muted text-[10px]">0</span>
 ) : '—'}
 </td>
 {/* Annunci (attivi) — from actual job slice, not crawl-run delta */}
 <td className="text-center py-2 px-1.5">
 {s && s.activeJobCount > 0 ? (
 <button onClick={() => toggleExpand(row.key, 'active')}
 className={`inline-flex items-center gap-0.5 text-accent font-bold hover:underline cursor-pointer ${expanded === 'active' ? 'underline' : ''}`}>
 {expanded === 'active' ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
 {s.activeJobCount}
 </button>
 ) : s ? (
 <span className="text-muted text-[10px]">0</span>
 ) : '—'}
 </td>
 {/* Durata */}
 <td className="text-center py-2 px-1.5">
 {s?.durationMs != null ? (
 <span className="text-[10px] font-mono text-subtle" title={s.avgDurationMs != null ? `Media: ${formatDurationMs(s.avgDurationMs)}` : undefined}>
 {formatDurationMs(s.durationMs)}
 {s.avgDurationMs != null && (
 <span className="block text-[9px] text-muted">ø {formatDurationMs(s.avgDurationMs)}</span>
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
 className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${badgeColor} cursor-help`}
 title={tooltipLines}
 >
 {avg}
 </span>
 );
 })() : (
 <span className="text-muted text-[10px]">—</span>
 )}
 </td>
 {/* Status */}
 <td className="text-center py-2 px-2">
 {wfState ? (
 <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${
 isSuccess ? 'bg-success-subtle text-success'
 : isFailure ? 'bg-danger-subtle text-danger'
 : isRunning ? 'bg-accent-subtle text-accent'
 : 'bg-surface-raised text-subtle'
 }`}>
 {isRunning ? (<><Loader2 size={10} className="animate-spin" /> Run</>)
 : isSuccess ? (<><CheckCircle2 size={10} /> OK</>)
 : isFailure ? (<><AlertTriangle size={10} /> Err</>)
 : (<><Clock3 size={10} /> —</>)}
 </span>
 ) : (
 <span className="text-muted text-[10px]">—</span>
 )}
 </td>
 {/* Actions */}
 <td className="text-center py-2 px-2">
 {row.wf ? (
 <div className="inline-flex items-center gap-1.5">
 <button
 onClick={() => void runWorkflowAction(row.wf!.id)}
 disabled={!!isRunning}
 className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-accent hover:bg-accent-hover disabled:opacity-60 text-on-accent text-[10px] font-semibold transition-colors"
 aria-label={`Avvia ${row.title}`}
 >
 <Play size={10} />
 {isRunning ? '…' : 'Avvia'}
 </button>
 {wfState?.htmlUrl && (
 <a href={wfState.htmlUrl} target="_blank" rel="noreferrer"
 className="inline-flex items-center px-1.5 py-1 rounded-md border border-edge text-muted text-[10px] hover:bg-surface-raised transition-colors"
 aria-label={`GitHub ${row.title}`}>
 <ExternalLink size={10} />
 </a>
 )}
 {wfState?.error && (
 <CopyButton text={`${row.title}\n${wfState.error}\n${failedSteps.join(' | ')}`} label={`errore ${row.title}`} />
 )}
 </div>
 ) : (
 <span className="text-muted text-[10px]">—</span>
 )}
 </td>
 </tr>
 {/* Expanded job details row */}
 {expanded && s && (
 <tr>
 <td colSpan={10} className={`px-3 py-2 border-b border-edge ${
 expanded === 'new' ? 'bg-success-subtle/50'
 : expanded === 'updated' ? 'bg-accent-subtle/50'
 : expanded === 'unchanged' ? 'bg-warning-subtle/50'
 : expanded === 'active' ? 'bg-accent-subtle/50'
 : 'bg-danger-subtle/50'
 }`}>
 <div className="text-[11px] font-semibold text-body mb-1.5">
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
 <td colSpan={10} className="px-3 py-2 bg-danger-subtle/50 border-b border-danger-border">
 <div className="space-y-1">
 {wfState.error && (
 <div className="flex items-start gap-2 text-xs text-danger">
 <AlertTriangle size={12} className="mt-0.5 shrink-0" />
 <span className="font-semibold">{wfState.error}</span>
 </div>
 )}
 {failedSteps.length > 0 && (
 <div className="text-[11px] text-danger pl-5">
 Step falliti: {failedSteps.slice(0, 4).join(' · ')}
 {failedSteps.length > 4 && <span className="text-danger"> (+{failedSteps.length - 4})</span>}
 </div>
 )}
 {wfState.logExcerpt && (
 <pre className="max-h-20 overflow-auto rounded-md bg-surface-inverted text-danger p-2 text-[10px] font-mono whitespace-pre-wrap break-words leading-relaxed border border-danger-border">
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
 <div className="rounded-lg border border-edge bg-surface-alt/40 px-3 py-2">
 <div className="text-xs font-bold text-body">{meta.label}</div>
 <div className="text-[11px] text-muted mt-0.5">{meta.description}</div>
 </div>
 <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
 {grouped.map(renderWorkflowCard)}
 </div>
 </div>
 )}
 {isJobsContext && renderCrawlerConfigPanel()}
 </div>
 </div>
 );
 };

 const copyCommand = (cmd: string) => {
 navigator.clipboard.writeText(cmd).then(() => {
 setCopiedCmd(true);
 setTimeout(() => setCopiedCmd(false), 2000);
 });
 };

 const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

 const formatDuration = (seconds: number | null): string => {
 if (!Number.isFinite(Number(seconds)) || Number(seconds) < 0) return 'n/d';
 const s = Math.round(Number(seconds));
 const m = Math.floor(s / 60);
 const rem = s % 60;
 return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
 };

 const stripAnsi = (value: string): string =>
 String(value || '').replace(
 // eslint-disable-next-line no-control-regex
 /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
 '',
 );

 const getWorkflowDef = (workflowId: string): WorkflowActionDefinition => {
 return workflowActions.find((x) => x.id === workflowId) || {
 id: workflowId,
 title: workflowId,
 context: 'jobs',
 description: 'Workflow manuale',
 details: 'Workflow custom avviato dal pannello Admin.',
 expectedDuration: 'variabile',
 };
 };

 const buildAiPromptForWorkflow = (workflow: WorkflowActionDefinition, state: WorkflowRunState): string => {
 const failedJobs = state.jobs.filter((j) => String(j.conclusion) === 'failure');
 const failedSteps = failedJobs.flatMap((j) => j.failedSteps.map((s) => `${j.name}: ${s}`));
 return [
 `Sto eseguendo il workflow GitHub"${workflow.title}" (${workflow.id}) del repo Frontaliere Ticino.`,
 `Run URL: ${state.htmlUrl || 'n/d'}`,
 `Run ID: ${state.runId || 'n/d'} | Run number: ${state.runNumber || 'n/d'}`,
 `Status: ${state.status} | Conclusion: ${state.conclusion || 'n/d'}`,
 `Messaggio errore: ${state.error || 'n/d'}`,
 `Durata: ${formatDuration(state.durationSeconds)}`,
 failedSteps.length ? `Step falliti: ${failedSteps.join(' | ')}` : 'Step falliti: n/d',
 state.logExcerpt ? `Estratto log:\n${state.logExcerpt}` : 'Estratto log: non disponibile',
 '',
 'Mi proponi una fix concreta con patch minima e test di verifica?',
 ].join('\n');
 };

 const getGitHubConnection = async () => {
 const [token, ownerCfg, repoCfg] = await Promise.all([
 getConfigValue('GITHUB_PAT'),
 getConfigValue('GITHUB_REPO_OWNER'),
 getConfigValue('GITHUB_REPO_NAME'),
 ]);
 const ghToken = (token || '').trim();
 if (!ghToken) {
 throw new Error(
 'GITHUB_PAT mancante in Remote Config. ' +
 'Verifica che il parametro esista nella console Firebase Remote Config e che App Check sia attivo.'
 );
 }
 if (!ghToken.startsWith('github_pat_') && !ghToken.startsWith('ghp_') && !ghToken.startsWith('gho_')) {
 console.warn('⚠️ GITHUB_PAT non sembra un token GitHub valido (non inizia con github_pat_, ghp_, gho_)');
 }
 const owner = (ownerCfg || 'valerielinc-ops').trim();
 const repo = (repoCfg || 'frontaliere-si-o-no').trim();
 return { token: ghToken, owner, repo };
 };

 const githubRequest = async (
 connection: { token: string; owner: string; repo: string },
 endpoint: string,
 options: RequestInit = {},
 asText = false,
 ) => {
 const res = await fetch(`https://api.github.com/repos/${connection.owner}/${connection.repo}${endpoint}`, {
 ...options,
 headers: {
 Authorization: `Bearer ${connection.token}`,
 Accept: 'application/vnd.github+json',
 'Content-Type': 'application/json',
 'X-GitHub-Api-Version': '2022-11-28',
 ...(options.headers || {}),
 },
 });

 const isDispatch = endpoint.includes('/dispatches');

 if (!res.ok) {
 const txt = await res.text().catch(() => '');

 // GitHub dispatch API sometimes returns 500 even though the workflow was
 // accepted and will run. When this happens, don't treat it as fatal —
 // return null and let the polling logic verify the run was created.
 if (isDispatch && res.status >= 500) {
 console.warn(`⚠️ GitHub dispatch returned ${res.status} (likely transient). Proceeding to poll for run.`);
 return null;
 }

 if (res.status === 403 && txt.includes('not accessible by personal access token')) {
 const isFineGrained = connection.token.startsWith('github_pat_');
 const hint = isFineGrained
 ? 'Il token fine-grained necessita dei permessi: Actions (Read & Write) + Contents (Read & Write). '
 + 'Vai su GitHub → Settings → Developer Settings → Fine-grained tokens → Edit → Permissions.'
 : 'Il token classic necessita dello scope"repo" (che include Actions write). '
 + 'Vai su GitHub → Settings → Developer Settings → Personal access tokens → Edit → seleziona"repo".';
 throw new Error(
 `GitHub API 403: il PAT non ha i permessi necessari${isDispatch ? ' per avviare workflow' : ''}. ${hint}`,
 );
 }
 if (res.status === 404 && endpoint.includes('/actions/workflows/')) {
 const workflowRef = endpoint.match(/\/actions\/workflows\/([^/]+)/)?.[1] || 'workflow';
 throw new Error(
 `Workflow GitHub non trovato: ${workflowRef}. ` +
 'Verifica che il file sia stato pushato su origin/main prima di avviarlo dal pannello Admin.',
 );
 }
 throw new Error(`GitHub API ${res.status}${txt ? `: ${txt.slice(0, 260)}` : ''}`);
 }

 // HTTP 204 No Content — GitHub returns this for successful dispatch calls.
 // Don't try to parse JSON from an empty body.
 // 204 No Content (e.g. workflow dispatch success) has no body
 if (res.status === 204 || res.headers.get('content-length') === '0') return null;

 if (asText) return await res.text();
 return await res.json();
 };

 const listWorkflowRuns = async (
 connection: { token: string; owner: string; repo: string },
 workflowId: string,
 ): Promise<any[]> => {
 const json = await githubRequest(
 connection,
 `/actions/workflows/${workflowId}/runs?per_page=20`,
 { method: 'GET' },
 );
 return Array.isArray(json?.workflow_runs) ? json.workflow_runs : [];
 };

 const listRunJobs = async (
 connection: { token: string; owner: string; repo: string },
 runId: number,
 ): Promise<WorkflowJobSummary[]> => {
 const json = await githubRequest(connection, `/actions/runs/${runId}/jobs?per_page=100`, { method: 'GET' });
 const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
 return jobs.map((job: any) => {
 const steps = Array.isArray(job?.steps) ? job.steps : [];
 const failedSteps = steps
 .filter((s: any) => String(s?.conclusion || '') === 'failure')
 .map((s: any) => String(s?.name || 'step fallito'));
 const completedSteps = steps.filter((s: any) => String(s?.status || '') === 'completed').length;
 return {
 id: Number(job?.id || 0),
 name: String(job?.name || 'Job'),
 status: String(job?.status || 'unknown'),
 conclusion: String(job?.conclusion || ''),
 totalSteps: steps.length,
 completedSteps,
 failedSteps,
 };
 });
 };

 const tryFetchLogExcerpt = async (
 connection: { token: string; owner: string; repo: string },
 failedJobId: number | null,
 ): Promise<string | null> => {
 if (!failedJobId) return null;
 try {
 // The GitHub job-logs endpoint returns a 302 redirect to Azure Blob Storage.
 // If fetch auto-follows, it can forward the GitHub Bearer token to Azure.
 // Follow redirect manually and fetch the blob URL without auth headers.
 const redirectRes = await fetch(
 `https://api.github.com/repos/${connection.owner}/${connection.repo}/actions/jobs/${failedJobId}/logs`,
 {
 method: 'GET',
 redirect: 'manual',
 headers: {
 Authorization: `Bearer ${connection.token}`,
 Accept: 'application/vnd.github+json',
 'X-GitHub-Api-Version': '2022-11-28',
 },
 },
 );

 const location = redirectRes.headers.get('location');
 if (!location) {
 const txt = await redirectRes.text().catch(() => '');
 if (!txt.trim()) return null;
 const lines = stripAnsi(txt.replace(/\r/g, '\n')).split('\n').filter(Boolean);
 return lines.slice(-150).join('\n').slice(-12000);
 }

 const logRes = await fetch(location);
 if (!logRes.ok) return null;
 const raw = await logRes.text();
 const cleaned = stripAnsi(String(raw || '').replace(/\r/g, '\n'));
 if (!cleaned.trim()) return null;
 const lines = cleaned.split('\n').filter(Boolean);
 return lines.slice(-150).join('\n').slice(-12000);
 } catch {
 return null;
 }
 };

 const runWorkflowAction = async (workflowId: string, overrideInputs: Record<string, string> = {}): Promise<WorkflowRunState> => {
 const workflow = getWorkflowDef(workflowId);
 setWorkflowState(workflowId, {
 loading: true,
 status: 'dispatching',
 conclusion: null,
 error: null,
 message: 'Invio richiesta a GitHub Actions…',
 logExcerpt: null,
 aiPrompt: null,
 });

 try {
 const connection = await getGitHubConnection();
 const beforeRuns = await listWorkflowRuns(connection, workflowId);
 const beforeIds = new Set<number>(beforeRuns.map((r: any) => Number(r?.id || 0)));

 await githubRequest(
 connection,
 `/actions/workflows/${workflowId}/dispatches`,
 {
 method: 'POST',
 body: JSON.stringify({
 ref: 'main',
 inputs: {
 ...(workflow.defaultInputs || {}),
 ...(overrideInputs || {}),
 },
 }),
 },
 );

 setWorkflowState(workflowId, {
 message: 'Workflow avviato. Cerco il run creato…',
 });

 const dispatchedAt = Date.now();
 let matchedRun: any = null;
 for (let i = 0; i < 18; i += 1) {
 const runs = await listWorkflowRuns(connection, workflowId);
 matchedRun = runs.find((run: any) => {
 const id = Number(run?.id || 0);
 const createdAt = Date.parse(String(run?.created_at || '')) || 0;
 return !beforeIds.has(id) && createdAt >= (dispatchedAt - 2 * 60 * 1000);
 }) || null;
 if (matchedRun) break;
 await sleep(4000);
 }

 if (!matchedRun) {
 const runs = await listWorkflowRuns(connection, workflowId);
 matchedRun = runs[0] || null;
 }

 if (!matchedRun || !Number(matchedRun?.id)) {
 throw new Error('Run non trovato dopo il dispatch. Verifica GitHub Actions e riprova.');
 }

 const runId = Number(matchedRun.id);
 setWorkflowState(workflowId, {
 runId,
 runNumber: Number(matchedRun?.run_number || 0) || null,
 htmlUrl: String(matchedRun?.html_url || ''),
 status: String(matchedRun?.status || 'queued'),
 message: 'Run identificato. Monitoraggio in corso…',
 });

 for (let i = 0; i < 90; i += 1) {
 const run = await githubRequest(connection, `/actions/runs/${runId}`, { method: 'GET' });
 const jobs = await listRunJobs(connection, runId);
 const startedAt = String(run?.run_started_at || run?.created_at || '') || null;
 const completedAt = String(run?.updated_at || '') || null;
 const durationSeconds =
 startedAt && completedAt
 ? Math.max(0, Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000))
 : null;

 const failedJobs = jobs.filter((j) => String(j.conclusion) === 'failure');
 const completedJobs = jobs.filter((j) => String(j.status) === 'completed').length;
 const summary = `Job completati ${completedJobs}/${jobs.length}${failedJobs.length ? ` · falliti ${failedJobs.length}` : ''}`;

 setWorkflowState(workflowId, {
 status: String(run?.status || 'unknown'),
 conclusion: run?.conclusion ? String(run.conclusion) : null,
 htmlUrl: String(run?.html_url || ''),
 startedAt,
 updatedAt: String(run?.updated_at || '') || null,
 completedAt: run?.status === 'completed' ? (String(run?.updated_at || '') || null) : null,
 durationSeconds,
 jobs,
 message: run?.status === 'completed' ? summary : `In esecuzione… ${summary}`,
 });

 if (String(run?.status || '') === 'completed') {
 let errorMessage: string | null = null;
 let logExcerpt: string | null = null;
 const primaryJobId = failedJobs[0]?.id || jobs[0]?.id || null;
 logExcerpt = await tryFetchLogExcerpt(connection, primaryJobId);
 if (String(run?.conclusion || '') !== 'success') {
 errorMessage = failedJobs.length > 0
 ? `Step critici: ${failedJobs.flatMap((j) => j.failedSteps).slice(0, 6).join(' | ') || 'vedi log run'}`
 : `Conclusione workflow: ${String(run?.conclusion || 'failure')}`;
 }

 const nextState: Partial<WorkflowRunState> = {
 loading: false,
 error: errorMessage,
 logExcerpt,
 };
 const finalState = { ...getWorkflowState(workflowId), ...nextState };
 nextState.aiPrompt = errorMessage ? buildAiPromptForWorkflow(workflow, finalState) : null;
 setWorkflowState(workflowId, nextState);
 return finalState;
 }

 await sleep(6000);
 }

 setWorkflowState(workflowId, {
 loading: false,
 error: 'Timeout monitoraggio: run avviato ma ancora in esecuzione. Apri GitHub per i dettagli.',
 });
 return {
 ...getWorkflowState(workflowId),
 loading: false,
 error: 'Timeout monitoraggio: run avviato ma ancora in esecuzione. Apri GitHub per i dettagli.',
 };
 } catch (err) {
 const msg = err instanceof Error ? err.message : 'Errore sconosciuto';
 const failedState = {
 ...getWorkflowState(workflowId),
 loading: false,
 status: 'error',
 error: msg,
 message: 'Avvio non riuscito',
 };
 setWorkflowState(workflowId, {
 loading: false,
 status: 'error',
 error: msg,
 message: 'Avvio non riuscito',
 aiPrompt: buildAiPromptForWorkflow(workflow, failedState),
 });
 return failedState;
 }
 };

 const dispatchGitHubWorkflow = async (workflowId: string, inputs: Record<string, string> = {}) => {
 const connection = await getGitHubConnection();
 await githubRequest(
 connection,
 `/actions/workflows/${workflowId}/dispatches`,
 {
 method: 'POST',
 body: JSON.stringify({
 ref: 'main',
 inputs,
 }),
 },
 );
 return true;
 };

 const runCrawlerNow = async () => {
 if (crawlerDispatchLoading) return;
 setCrawlerDispatchLoading(true);
 setCrawlerDispatchMessage(null);
 try {
 await runWorkflowAction('update-jobs.yml');
 setCrawlerDispatchMessage('✅ Avvio inviato. Vedi avanzamento e output nel tab workflow della categoria corrispondente.');
 } catch (err) {
 const msg = err instanceof Error ? err.message : 'Errore sconosciuto';
 setCrawlerDispatchMessage(`❌ Run crawler failed: ${msg}`);
 } finally {
 setCrawlerDispatchLoading(false);
 }
 };

 const copyAiFixRequest = async (workflowId: string) => {
 const state = getWorkflowState(workflowId);
 const payload = state.aiPrompt || buildAiPromptForWorkflow(getWorkflowDef(workflowId), state);
 await navigator.clipboard.writeText(payload);
 setCopiedAiPromptFor(workflowId);
 setTimeout(() => setCopiedAiPromptFor((prev) => (prev === workflowId ? null : prev)), 2000);
 };

 const openAiFixRequest = async (workflowId: string) => {
 const state = getWorkflowState(workflowId);
 const payload = state.aiPrompt || buildAiPromptForWorkflow(getWorkflowDef(workflowId), state);
 const encoded = encodeURIComponent(payload);
 const targets = [
 `https://chatgpt.com/?q=${encoded}`,
 `https://chat.openai.com/?q=${encoded}`,
 ];
 let opened = false;
 for (const url of targets) {
 const win = window.open(url, '_blank', 'noopener,noreferrer');
 if (win) {
 opened = true;
 break;
 }
 }
 if (!opened) {
 await copyAiFixRequest(workflowId);
 setWorkflowState(workflowId, {
 message: 'Popup bloccato: richiesta AI copiata negli appunti.',
 });
 }
 };

 const renderWorkflowCard = (wf: WorkflowActionDefinition) => {
 const wfState = getWorkflowState(wf.id);
 const isSuccess = wfState.status === 'completed' && wfState.conclusion === 'success';
 const isFailure = wfState.status === 'completed' && wfState.conclusion && wfState.conclusion !== 'success';
 const isRunning = wfState.loading || wfState.status === 'queued' || wfState.status === 'in_progress';
 const failedSteps = wfState.jobs.flatMap((j) => j.failedSteps.map((s) => `${j.name}: ${s}`));

 // Relative time helper
 const relativeTime = (iso: string | null) => {
 if (!iso) return null;
 const diff = Date.now() - Date.parse(iso);
 if (diff < 0 || isNaN(diff)) return null;
 const mins = Math.floor(diff / 60000);
 if (mins < 1) return 'adesso';
 if (mins < 60) return `${mins} min fa`;
 const hrs = Math.floor(mins / 60);
 if (hrs < 24) return `${hrs}h fa`;
 const days = Math.floor(hrs / 24);
 return days === 1 ? 'ieri' : `${days}gg fa`;
 };
 const lastRunAgo = relativeTime(wfState.updatedAt);

 // Status border color
 const borderColor = isFailure
 ? 'border-l-danger'
 : isSuccess
 ? 'border-l-success'
 : isRunning
 ? 'border-l-accent'
 : 'border-l-edge';

 return (
 <div key={wf.id} className={`rounded-lg border border-edge border-l-4 ${borderColor} bg-surface/40 p-4 space-y-3`}>
 {/* ── Header: title + badge + last run ── */}
 <div className="flex items-start justify-between gap-3">
 <div className="min-w-0">
 <div className="flex items-center gap-2 flex-wrap">
 <h4 className="text-sm font-bold text-strong truncate">{wf.title}</h4>
 {lastRunAgo && (
 <span className="text-[10px] text-muted font-mono whitespace-nowrap" title={wfState.updatedAt || ''}>
 {lastRunAgo}
 </span>
 )}
 </div>
 <p className="text-[11px] text-muted mt-0.5 leading-snug">{wf.description}</p>
 </div>
 <span className={`shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide ${
 isSuccess
 ? 'bg-success-subtle text-success'
 : isFailure
 ? 'bg-danger-subtle text-danger'
 : isRunning
 ? 'bg-accent-subtle text-accent'
 : 'bg-surface-raised text-subtle'
 }`}>
 {isRunning ? (
 <><Loader2 size={10} className="animate-spin" /> Run</>
 ) : isSuccess ? (
 <><CheckCircle2 size={10} /> OK</>
 ) : isFailure ? (
 <><AlertTriangle size={10} /> Errore</>
 ) : (
 <><Clock3 size={10} /> Idle</>
 )}
 </span>
 </div>

 {/* ── Error banner (always visible when there's an error) ── */}
 {isFailure && (wfState.error || failedSteps.length > 0) && (
 <div className="rounded-lg bg-danger-subtle border border-danger-border px-3 py-2.5 space-y-1.5">
 {wfState.error && (
 <div className="flex items-start gap-2 text-xs font-semibold text-danger">
 <AlertTriangle size={13} className="mt-0.5 shrink-0" />
 <span>{wfState.error}</span>
 </div>
 )}
 {failedSteps.length > 0 && (
 <div className="text-[11px] text-danger pl-5">
 <span className="font-semibold">Step falliti:</span>{' '}
 {failedSteps.slice(0, 6).join(' · ')}
 {failedSteps.length > 6 && <span className="text-danger"> (+{failedSteps.length - 6})</span>}
 </div>
 )}
 </div>
 )}

 {/* ── Status message (non-error) ── */}
 {!isFailure && wfState.message && (
 <div className="rounded-lg px-3 py-2 text-[11px] bg-accent-subtle border border-accent-border text-accent">
 {wfState.message}
 </div>
 )}

 {/* ── Action bar ── */}
 <div className="flex flex-wrap items-center gap-2">
 <button
 onClick={() => void runWorkflowAction(wf.id)}
 disabled={isRunning}
 className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover disabled:opacity-60 text-on-accent text-xs font-semibold transition-colors"
 >
 <Play size={11} />
 {isRunning ? 'In corso…' : 'Avvia'}
 </button>
 {wfState.htmlUrl && (
 <a
 href={wfState.htmlUrl}
 target="_blank"
 rel="noreferrer"
 className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-edge text-subtle text-xs font-semibold hover:bg-surface-raised transition-colors"
 >
 <ExternalLink size={11} />
 GitHub
 </a>
 )}
 {wfState.error && (
 <CopyButton
 text={`${wf.title}\n${wfState.error}\n${failedSteps.join(' | ')}`}
 label={`errore ${wf.title}`}
 />
 )}
 </div>

 {/* ── Log excerpt preview (visible immediately on failure) ── */}
 {isFailure && wfState.logExcerpt && (
 <div>
 <div className="mb-1 text-[10px] font-semibold text-muted uppercase tracking-wide">
 Log errore (ultime righe)
 </div>
 <pre className="max-h-32 overflow-auto rounded-md bg-surface-inverted text-danger p-2 text-[10px] font-mono whitespace-pre-wrap break-words leading-relaxed border border-danger-border">
 {wfState.logExcerpt}
 </pre>
 </div>
 )}

 {/* ── Collapsible execution detail ── */}
 <details className="rounded-lg border border-edge bg-surface-alt/40 p-3 text-xs">
 <summary className="cursor-pointer font-semibold text-subtle select-none">
 Dettaglio · <span className="font-normal">{wf.details}</span> · <span className="font-mono text-[10px]">{wf.expectedDuration}</span>
 </summary>
 <div className="mt-3 space-y-2 text-subtle">
 <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-[11px]">
 <div>Run <span className="font-mono font-semibold">#{wfState.runNumber || '—'}</span></div>
 <div>Stato: <span className="font-semibold">{wfState.status || 'idle'}</span></div>
 <div>Esito: <span className={`font-semibold ${wfState.conclusion === 'success' ? 'text-success' : wfState.conclusion === 'failure' ? 'text-danger' : ''}`}>{wfState.conclusion || '—'}</span></div>
 <div>Durata: <span className="font-semibold">{formatDuration(wfState.durationSeconds)}</span></div>
 <div>Ultimo: <span className="font-mono">{lastRunAgo || 'n/d'}</span></div>
 <div>ID: <span className="font-mono text-[10px]">{wfState.runId || 'n/d'}</span></div>
 </div>

 {wfState.jobs.length > 0 && (
 <div className="rounded-md border border-edge overflow-x-auto">
 <table className="min-w-[420px] w-full text-[11px]">
 <thead className="bg-surface-raised/40 text-muted">
 <tr>
 <th className="text-left py-1 px-2">Job</th>
 <th className="text-left py-1 px-2">Esito</th>
 <th className="text-right py-1 px-2">Step</th>
 </tr>
 </thead>
 <tbody>
 {wfState.jobs.map((job) => (
 <tr key={`${wf.id}-${job.id}`} className={`border-t border-edge ${String(job.conclusion) === 'failure' ? 'bg-danger-subtle/50' : ''}`}>
 <td className="py-1 px-2 font-medium">{job.name}</td>
 <td className={`py-1 px-2 font-semibold ${String(job.conclusion) === 'failure' ? 'text-danger' : String(job.conclusion) === 'success' ? 'text-success' : ''}`}>
 {job.conclusion || job.status || '—'}
 </td>
 <td className="py-1 px-2 text-right font-mono">{job.completedSteps}/{job.totalSteps}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 )}

 {/* Log in details for successful runs too */}
 {!isFailure && wfState.logExcerpt && (
 <div>
 <div className="mb-1 text-[10px] font-semibold text-muted">Output log</div>
 <pre className="max-h-36 overflow-auto rounded-md bg-surface-inverted text-heading p-2 text-[10px] whitespace-pre-wrap break-words">
 {wfState.logExcerpt}
 </pre>
 </div>
 )}

 {isFailure && !wfState.logExcerpt && (
 <div className="text-[11px] italic text-muted">
 Log non disponibile — apri il run su GitHub per i dettagli completi.
 </div>
 )}
 </div>
 </details>
 </div>
 );
 };

 const refreshWorkflowSnapshots = async () => {
 try {
 const connection = await getGitHubConnection();
 await Promise.all(workflowActions.map(async (workflow) => {
 try {
 const runs = await listWorkflowRuns(connection, workflow.id);
 const run = runs[0];
 if (!run) return;
 const runId = Number(run?.id || 0);
 const jobs = runId ? await listRunJobs(connection, runId) : [];
 const startedAt = String(run?.run_started_at || run?.created_at || '') || null;
 const completedAt = String(run?.updated_at || '') || null;
 const durationSeconds =
 startedAt && completedAt
 ? Math.max(0, Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000))
 : null;
 const failedJobs = jobs.filter((j) => String(j.conclusion) === 'failure').length;
 const completedJobs = jobs.filter((j) => String(j.status) === 'completed').length;
 const failedJobDetails = jobs.filter((j) => String(j.conclusion) === 'failure');
 let logExcerpt: string | null = null;
 let errorMessage: string | null = null;
 if (String(run?.conclusion || '') !== 'success' && String(run?.status || '') === 'completed') {
 const primaryJobId = failedJobDetails[0]?.id || jobs[0]?.id || null;
 logExcerpt = await tryFetchLogExcerpt(connection, primaryJobId);
 errorMessage = failedJobDetails.length > 0
 ? `Step critici: ${failedJobDetails.flatMap((j) => j.failedSteps).slice(0, 6).join(' | ') || 'vedi log run'}`
 : `Conclusione workflow: ${String(run?.conclusion || 'failure')}`;
 }
 setWorkflowState(workflow.id, {
 runId: runId || null,
 runNumber: Number(run?.run_number || 0) || null,
 htmlUrl: String(run?.html_url || ''),
 status: String(run?.status || 'idle'),
 conclusion: run?.conclusion ? String(run?.conclusion) : null,
 startedAt,
 updatedAt: String(run?.updated_at || '') || null,
 completedAt: String(run?.status || '') === 'completed' ? completedAt : null,
 durationSeconds,
 jobs,
 error: errorMessage,
 logExcerpt,
 message: jobs.length ? `Ultimo run: ${completedJobs}/${jobs.length} job completati${failedJobs ? ` · ${failedJobs} falliti` : ''}` : 'Ultimo run disponibile',
 });
 } catch {
 // keep old state if a single workflow snapshot fails
 }
 }));
 } catch {
 // handled by per-action run, ignore on global snapshot refresh
 }
 };

 const runGenerateParserNow = async () => {
 if (parserDispatchLoading) return;
 const companyName = parserCompanyName.trim();
 const companyWebsite = parserCompanyWebsite.trim();
 if (!companyName || !companyWebsite) {
 setParserDispatchMessage('❌ Inserisci nome azienda e URL sito prima di lanciare la generazione parser.');
 return;
 }

 setParserDispatchLoading(true);
 setParserDispatchMessage(null);
 try {
 await dispatchGitHubWorkflow('generate-company-parser.yml', {
 company_name: companyName,
 company_website: companyWebsite,
 company_key: parserCompanyKey.trim(),
 apply_config: parserApplyConfig ? 'true' : 'false',
 });
 setParserDispatchMessage(
 `✅ Generazione parser avviata per"${companyName}" (${parserApplyConfig ? 'applica config: sì' : 'solo proposta'}).`
 );
 } catch (err) {
 const msg = err instanceof Error ? err.message : 'Errore sconosciuto';
 setParserDispatchMessage(`❌ Generazione parser fallita: ${msg}`);
 } finally {
 setParserDispatchLoading(false);
 }
 };

 return (
 <div className="space-y-6">
 {/* Header */}
 <div className="bg-gradient-to-br from-accent-strong to-accent-strong-hover rounded-2xl p-6 text-on-accent shadow-lg">
 <div className="flex items-center gap-3 mb-2">
 <Shield size={28} />
 <h1 className="text-2xl font-bold font-display">Pannello Amministrazione</h1>
 </div>
 <p className="text-on-accent/70 text-sm">
 Dashboard operativa owner (crawler jobs, segnali SEO runtime e newsletter).
 Questo pannello è accessibile solo tramite URL diretto.
 </p>
 </div>

 {/* Tab navigation */}
 <div className="flex gap-2 border-b border-edge pb-1 flex-wrap">
 {[
 { id: 'jobs' as const, label: 'Workflow Jobs', icon: ListChecks },
 { id: 'owner' as const, label: 'Owner Tools', icon: Activity },
 { id: 'content' as const, label: 'Contenuti', icon: FileText },
 { id: 'seo' as const, label: 'SEO/Qualità', icon: Shield },
 { id: 'analytics' as const, label: 'Dati', icon: Database },
 { id: 'newsletter' as const, label: 'Newsletter', icon: Mail },
 ].map(tab => {
 const summary = ['jobs', 'content', 'seo', 'analytics'].includes(tab.id)
 ? getWorkflowTabSummary(tab.id as WorkflowContext)
 : null;
 return (
 <button
 key={tab.id}
 onClick={() => setActiveSection(tab.id as typeof activeSection)}
 className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-t-lg transition-colors ${
 activeSection === tab.id
 ? 'bg-surface text-accent border border-b-0 border-edge'
 : 'text-muted hover:text-body'
 }`}
 aria-label={tab.label}
 >
 <tab.icon size={16} />
 <span className="hidden sm:inline">{tab.label}</span>
 {summary && (
 <span className="ml-1 inline-flex items-center gap-1">
 <span className="inline-flex min-w-5 justify-center rounded-full bg-success-subtle px-1.5 py-0.5 text-[10px] font-bold text-success">
 {summary.ok}
 </span>
 {summary.error > 0 && (
 <span className="inline-flex min-w-5 justify-center rounded-full bg-danger-subtle px-1.5 py-0.5 text-[10px] font-bold text-danger">
 {summary.error}
 </span>
 )}
 {summary.pending > 0 && (
 <span className="inline-flex min-w-5 justify-center rounded-full bg-warning-subtle px-1.5 py-0.5 text-[10px] font-bold text-warning">
 {summary.pending}
 </span>
 )}
 </span>
 )}
 </button>
 );
 })}
 </div>

 {/* Owner tools section */}
 {activeSection === 'owner' && (
 <div className="space-y-4">
 <div className="flex items-center justify-between">
 <h2 className="text-lg font-bold font-display text-strong flex items-center gap-2">
 <Database size={20} className="text-accent" />
 Owner Tools
 </h2>
 <button
 onClick={refreshOwnerStats}
 className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-accent hover:bg-accent-hover text-on-accent text-sm font-medium transition-colors"
 >
 <RefreshCw size={14} />
 Aggiorna
 </button>
 </div>

 {ownerStats.error && (
 <div className="bg-danger-subtle border border-danger-border rounded-lg px-3 py-2 text-sm text-danger">
 Errore lettura dati owner: {ownerStats.error}
 </div>
 )}

 <div className="bg-surface rounded-xl border border-edge px-4 py-2">
 <p className="text-sm text-muted">Panoramica KPI e check runtime. Usa questa vista per un controllo rapido.</p>
 </div>

 {ownerTab === 'overview' && (
 <>
 <div className={`rounded-xl border p-4 ${
 serpDiagnostics.hasRemoteOverride
 ? 'bg-warning-subtle border-warning-border'
 : 'bg-success-subtle border-success-border'
 }`}>
 <div className="flex items-center gap-2 text-sm font-semibold">
 {serpDiagnostics.hasRemoteOverride ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
 SEO SERP Experiment Config Check
 </div>
 <div className="mt-2 text-xs text-body font-mono break-all">
 runtime: enabled={String(serpDiagnostics.runtime.enabled)}, variant={serpDiagnostics.runtime.variant}, targets={serpDiagnostics.runtime.targets || '(vuoto)'}, year={serpDiagnostics.runtime.year}
 </div>
 <div className="mt-1 text-xs text-subtle font-mono break-all">
 default: enabled={String(serpDiagnostics.defaults.enabled)}, variant={serpDiagnostics.defaults.variant}, targets={serpDiagnostics.defaults.targets}, year={serpDiagnostics.defaults.year}
 </div>
 {!serpDiagnostics.loaded && (
 <div className="mt-2 text-xs text-subtle">Caricamento stato Remote Config in corso…</div>
 )}
 </div>

 <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
 <div className="bg-surface rounded-xl border border-edge p-4">
 <div className="text-xs text-muted mb-1">Social proof (counters/simulations)</div>
 <div className="text-2xl font-bold text-strong">
 {ownerStats.loading ? '…' : (ownerStats.socialProofTotal ?? '—')}
 </div>
 </div>
 <div className="bg-surface rounded-xl border border-edge p-4">
 <div className="text-xs text-muted mb-1">Simulazioni cloud (collection)</div>
 <div className="text-2xl font-bold text-strong">
 {ownerStats.loading ? '…' : (ownerStats.simulationDocs ?? '—')}
 </div>
 </div>
 <div className="bg-surface rounded-xl border border-edge p-4">
 <div className="text-xs text-muted mb-1">Domande forum</div>
 <div className="text-2xl font-bold text-strong">
 {ownerStats.loading ? '…' : (ownerStats.forumQuestions ?? '—')}
 </div>
 </div>
 <div className="bg-surface rounded-xl border border-edge p-4">
 <div className="text-xs text-muted mb-1">Newsletter attivi</div>
 <div className="text-2xl font-bold text-strong">
 {ownerStats.loading ? '…' : (ownerStats.newsletterActive ?? '—')}
 </div>
 </div>
 </div>

 <div className="bg-surface rounded-xl border border-edge p-4 space-y-3">
 <h3 className="text-sm font-bold text-strong">File Pubblici Critici</h3>
 <div className="space-y-2">
 {(Object.entries(ownerStats.publicFiles) as [string, boolean][]).map(([file, ok]) => (
 <div key={file} className="flex items-center justify-between text-sm">
 <span className="font-mono text-body">/{file}</span>
 <HealthBadge ok={ok} label={ok ? 'OK' : 'Missing'} />
 </div>
 ))}
 </div>
 </div>

 <div className="bg-surface rounded-xl border border-edge p-4 space-y-3">
 <h3 className="text-sm font-bold text-strong">Azioni Rapide Owner</h3>
 <div className="flex flex-wrap gap-2">
 <CopyButton text="npm run build && npm run validate:structured-data && npm test" label="pipeline locale" />
 <CopyButton text="node scripts/send-newsletter.mjs --preview > /tmp/newsletter.html && open /tmp/newsletter.html" label="preview newsletter" />
 <a
 href="/sitemap.xml"
 target="_blank"
 rel="noreferrer"
 className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-accent-subtle text-accent hover:bg-accent-subtle transition-colors"
 >
 <ExternalLink size={12} />
 Apri sitemap.xml
 </a>
 <a
 href="/robots.txt"
 target="_blank"
 rel="noreferrer"
 className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-accent-subtle text-accent hover:bg-accent-subtle transition-colors"
 >
 <ExternalLink size={12} />
 Apri robots.txt
 </a>
 </div>
 </div>

 {/* TODO / Da Implementare */}
 <div className="bg-surface rounded-xl border border-warning-border/50 p-4 space-y-3">
 <h3 className="text-sm font-bold text-warning flex items-center gap-2">
 <ListChecks size={16} />
 TODO — Da Implementare
 </h3>
 <ul className="space-y-2 text-xs">
 <li className="flex items-start gap-2 p-2 rounded-lg bg-warning-subtle border border-warning-border/40">
 <span className="shrink-0 mt-0.5 w-4 h-4 rounded border-2 border-warning-border" />
 <div>
 <a
 href="/digest-settimanale/"
 className="font-semibold text-warning hover:underline"
 >
 Weekly Digest — Pagina Digest Settimanale
 </a>
 <p className="text-muted mt-0.5">
 Implementare invio automatico del digest settimanale via newsletter: tasso CHF/EUR, nuovi articoli, offerte di lavoro, aggiornamenti fiscali. Collegare con Resend API e cron workflow.
 </p>
 </div>
 </li>
 </ul>

 </div>
 </>
 )}

 </div>
 )}

 {(['jobs', 'content', 'seo', 'analytics'] as WorkflowContext[]).includes(activeSection as WorkflowContext) &&
 renderWorkflowControlRoom(activeSection as WorkflowContext)}

 {/* Newsletter section */}
 {activeSection === 'newsletter' && (
 <div className="space-y-4">
 <div className="bg-warning-subtle border border-warning-border rounded-xl p-4 text-sm text-warning">
 <strong>Preview reale:</strong> l'anteprima usa dati veri. Il test invia una sola email all'admin loggato tramite workflow protetto.
 </div>

 {/* Stats row */}
 <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
 <div className="bg-surface rounded-xl border border-edge p-4">
 <div className="flex items-center gap-2 text-subtle text-sm mb-1">
 <Users size={16} />
 Iscritti attivi
 </div>
 <div className="text-2xl font-bold text-strong">
 {nlLoading ? '…' : nlSubscriberCount ?? '—'}
 </div>
 </div>
 <div className="bg-surface rounded-xl border border-edge p-4">
 <div className="flex items-center gap-2 text-subtle text-sm mb-1">
 <Calendar size={16} />
 Ultimo invio
 </div>
 <div className="text-sm font-medium text-strong mt-1">
 {nlLoading ? '…' : nlLastSend ?? 'Nessun invio'}
 </div>
 </div>
 <div className="bg-surface rounded-xl border border-edge p-4">
 <div className="flex items-center gap-2 text-subtle text-sm mb-1">
 <Mail size={16} />
 Destinatari (anteprima)
 </div>
 <div className="text-xs text-subtle mt-1 space-y-0.5">
 {nlLoading ? '…' : nlRecipients.length > 0
 ? nlRecipients.map((e, i) => <div key={i} className="font-mono">{e}</div>)
 : <span>Nessun iscritto</span>}
 </div>
 </div>
 </div>

 <div className="bg-surface rounded-xl border border-edge p-6 space-y-3">
 <div className="flex items-center justify-between">
 <h3 className="text-sm font-bold text-strong">Insight Cambio (settimana/mese)</h3>
 <button
 onClick={fetchNewsletterInsights}
 className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-raised hover:bg-surface-raised text-xs font-medium"
 >
 <RefreshCw size={13} />
 Aggiorna
 </button>
 </div>
 {nlInsightLoading ? (
 <div className="text-sm text-muted">Calcolo insight in corso…</div>
 ) : nlInsights ? (
 <div className="space-y-3">
 <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
 <div className="rounded-lg bg-surface-alt p-3">
 <div className="text-muted text-xs mb-1">Settimana vs precedente</div>
 <div className="font-semibold text-strong">
 {nlInsights.weeklyDeltaPct >= 0 ? '+' : ''}{nlInsights.weeklyDeltaPct.toFixed(2)}%
 </div>
 </div>
 <div className="rounded-lg bg-surface-alt p-3">
 <div className="text-muted text-xs mb-1">Mese corrente vs precedente</div>
 <div className="font-semibold text-strong">
 {nlInsights.monthDeltaPct >= 0 ? '+' : ''}{nlInsights.monthDeltaPct.toFixed(2)}%
 </div>
 </div>
 <div className="rounded-lg bg-surface-alt p-3">
 <div className="text-muted text-xs mb-1">Giorno medio migliore</div>
 <div className="font-semibold text-strong">{nlInsights.bestWeekday}</div>
 </div>
 </div>
 <div className="text-sm text-body">{nlInsights.recommendation}</div>
 <div className="rounded-lg border border-edge p-3">
 <div className="text-xs text-muted mb-2">Provider consigliati (netto su 1.000 CHF)</div>
 <div className="space-y-1">
 {nlInsights.providerRanking.map((p) => (
 <div key={p.name} className="flex items-center justify-between text-sm">
 <span className="text-body">{p.name}</span>
 <span className="font-semibold text-strong">{p.netEur.toFixed(2)} EUR</span>
 </div>
 ))}
 </div>
 </div>
 <a
 href="/compara-servizi/cambio-franco-euro/"
 target="_blank"
 rel="noreferrer"
 className="inline-flex items-center gap-1 text-sm text-link hover:underline"
 >
 Apri miglior comparatore cambio →
 </a>
 </div>
 ) : (
 <div className="text-sm text-muted">Insight non disponibili.</div>
 )}
 </div>

 {/* Content toggles + subject */}
 <div className="bg-surface rounded-xl border border-edge p-6 space-y-4">
 <h2 className="text-lg font-bold font-display text-strong flex items-center gap-2">
 <Mail size={20} className="text-accent" />
 Configura Newsletter
 </h2>

 <div>
 <label htmlFor="nl-subject" className="block text-sm font-medium text-body mb-1">Oggetto email</label>
 <input
 id="nl-subject"
 type="text"
 value={nlSubject}
 onChange={e => setNlSubject(e.target.value)}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface text-strong text-sm focus-visible:ring-2 focus-visible:ring-accent"
 aria-label="Oggetto email newsletter"
 />
 </div>

 <div className="rounded-lg border border-edge bg-surface-alt p-4">
 <p className="text-sm font-semibold text-strong mb-2">Newsletter v2 — AI Personalizzata</p>
 <p className="text-xs text-subtle leading-relaxed">
 Ogni iscritto riceve un&apos;email unica: briefing AI personalizzato, job matching per zona/settore, oggetto generato dall&apos;AI.
 Non ci sono più varianti (jobs/tax/general) né sezioni configurabili. Il template è fisso e minimale.
 </p>
 </div>

 {/* Actions */}
 <div className="flex flex-wrap gap-3 pt-2">
 <button
 onClick={generatePreview}
 disabled={nlPreviewLoading}
 className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent hover:bg-accent-hover text-on-accent text-sm font-medium transition-colors"
 aria-label="Genera anteprima newsletter"
 >
 <RefreshCw size={16} />
 {nlPreviewLoading ? 'Genero…' : 'Genera Preview'}
 </button>
 <button
 onClick={sendTestNewsletter}
 disabled={nlSending || !nlPreviewHtml || !user?.email}
 className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-on-accent text-sm font-medium transition-colors"
 aria-label="Invia test newsletter all'admin loggato"
 >
 <Send size={16} />
 {nlSending ? 'Invio…' : `Invia Test${user?.email ? ` a ${String(user.email).trim().toLowerCase()}` : ''}`}
 </button>
 </div>

 {nlSendResult && (
 <div className={`text-sm px-3 py-2 rounded-lg ${
 nlSendResult.startsWith('✓')
 ? 'bg-success-subtle text-success'
 : 'bg-danger-subtle text-danger'
 }`}>
 {nlSendResult}
 </div>
 )}
 </div>

 {/* Preview */}
 {nlPreviewHtml && (
 <div className="bg-surface rounded-xl border border-edge overflow-hidden">
 <div className="px-4 py-3 border-b border-edge flex items-center gap-2">
 <Eye size={16} className="text-accent" />
 <span className="text-sm font-semibold text-strong">Anteprima Newsletter</span>
 </div>
 <iframe
 srcDoc={nlPreviewHtml}
 title="Newsletter preview"
 className="w-full border-0"
 style={{ height: '680px' }}
 sandbox="allow-same-origin"
 />
 </div>
 )}

 {/* Double Opt-In — Confirmation Email Preview */}
 <div className="bg-surface rounded-xl border border-edge overflow-hidden">
 <div className="px-4 py-3 border-b border-edge flex items-center gap-2">
 <CheckCircle2 size={16} className="text-warning" />
 <span className="text-sm font-semibold text-strong">Double Opt-In — Anteprima Email di Conferma</span>
 <span className="ml-auto text-xs bg-warning-subtle text-warning px-2 py-0.5 rounded-full font-medium">DRY RUN</span>
 </div>
 <div className="p-4 space-y-3">
 <p className="text-xs text-subtle">
 Quando il sistema sarà attivo, i nuovi iscritti riceveranno questa email di conferma.
 L'invio sarà gestito tramite GitHub Actions workflow dispatch.
 Per ora i subscriber vengono salvati con <code className="text-xs bg-surface-raised px-1 py-0.5 rounded">status: 'pending'</code>.
 </p>
 <iframe
 srcDoc={`<!DOCTYPE html>
<html lang="it">
<head>
 <meta charset="UTF-8">
 <meta name="viewport" content="width=device-width, initial-scale=1.0">
 <title>Conferma la tua iscrizione alla newsletter – Frontaliere Ticino</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
 <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px;">
 <tr><td align="center">
 <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
 <tr><td style="text-align:center;padding-bottom:24px;">
 <a href="https://frontaliereticino.ch" style="text-decoration:none;">
 <img src="https://frontaliereticino.ch/icons/icon-192x192.png" alt="Frontaliere Ticino" width="48" height="48" style="display:block;margin:0 auto 8px;border-radius:12px;" />
 <div style="font-size:22px;font-weight:800;color:#2563EB;">Frontaliere Ticino</div>
 <div style="font-size:12px;color:#6b7280;letter-spacing:.04em;">La guida per i lavoratori frontalieri</div>
 </a>
 </td></tr>
 <tr><td style="background:#ffffff;border:1px solid #dbe2ea;border-radius:16px;padding:32px 28px;">
 <div style="font-size:28px;font-weight:800;color:#0f172a;padding-bottom:8px;">Conferma la tua iscrizione ✉️</div>
 <div style="font-size:15px;line-height:1.6;color:#1f2937;padding-bottom:20px;">
 Grazie per esserti iscritto alla newsletter di <strong>Frontaliere Ticino</strong>! Per attivare la tua iscrizione e ricevere aggiornamenti settimanali su tasso di cambio, offerte di lavoro, novità fiscali e guide pratiche, conferma cliccando il pulsante qui sotto.
 </div>
 <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
 <tr><td align="center">
 <a href="#" style="display:inline-block;background:#2563EB;color:#ffffff;text-decoration:none;padding:16px 32px;border-radius:12px;font-size:16px;font-weight:700;letter-spacing:.02em;">
 Conferma iscrizione
 </a>
 </td></tr>
 </table>
 <div style="font-size:13px;color:#6b7280;padding-bottom:10px;">
 Oppure copia e incolla questo link nel browser:
 </div>
 <div style="background:#f8fafc;border:1px solid #dbe2ea;border-radius:8px;padding:12px;font-size:12px;color:#6b7280;word-break:break-all;">
 https://frontaliereticino.ch/?action=confirm_newsletter&amp;email=esempio@email.com&amp;token=abc123
 </div>
 <div style="border-top:1px solid #dbe2ea;margin:24px 0;"></div>
 <div style="font-size:14px;color:#1f2937;line-height:1.6;">
 <strong>Cosa riceverai ogni settimana:</strong>
 <ul style="padding-left:20px;margin:10px 0;">
 <li>📊 Tasso di cambio CHF-EUR aggiornato</li>
 <li>💼 Nuove offerte di lavoro in Ticino</li>
 <li>📋 Aggiornamenti fiscali e normativi</li>
 <li>📖 Guide pratiche per frontalieri</li>
 </ul>
 </div>
 <div style="border-top:1px solid #dbe2ea;margin:24px 0;"></div>
 <div style="font-size:13px;color:#6b7280;line-height:1.6;">
 <strong>Non ti sei iscritto?</strong> Ignora questa email in tutta sicurezza. Il link è valido per 7 giorni.
 </div>
 </td></tr>
 <tr><td style="text-align:center;padding:20px 0 8px;">
 <div style="font-size:12px;color:#6b7280;">
 © ${new Date().getFullYear()} Frontaliere Ticino ·
 <a href="https://frontaliereticino.ch" style="color:#6b7280;text-decoration:none;">frontaliereticino.ch</a>
 </div>
 </td></tr>
 </table>
 </td></tr>
 </table>
</body>
</html>`}
 title="Confirmation email preview"
 className="w-full border border-edge rounded-lg"
 style={{ height: '720px' }}
 sandbox="allow-same-origin"
 />
 <div className="bg-surface-alt rounded-lg p-3 space-y-2">
 <h4 className="text-xs font-semibold text-body">Workflow dispatch (quando attivo):</h4>
 <CopyButton
 text="gh workflow run send-confirmation-email.yml -f email=subscriber@example.com -f token=UUID"
 label="Workflow dispatch"
 />
 <p className="text-sm text-muted">
 Il workflow legge i subscriber con <code className="bg-surface-raised px-1 py-0.5 rounded text-xs">status: 'pending'</code> da Firestore,
 genera un link di conferma con token, e invia via Resend.
 Al click del link, una Cloud Function aggiorna <code className="bg-surface-raised px-1 py-0.5 rounded text-xs">status: 'confirmed'</code> e <code className="bg-surface-raised px-1 py-0.5 rounded text-xs">isActive: true</code>.
 </p>
 </div>
 </div>
 </div>

 {/* CLI Commands */}
 <div className="bg-surface rounded-xl border border-edge p-6 space-y-3">
 <h3 className="text-sm font-bold text-strong flex items-center gap-2">
 <Terminal size={16} className="text-accent" />
 Comandi Newsletter
 </h3>
 {[
 { label: 'Preview HTML', cmd: 'node scripts/send-newsletter.mjs --preview > /tmp/newsletter.html && open /tmp/newsletter.html' },
 { label: 'Insight JSON', cmd: 'node scripts/send-newsletter.mjs --analyze' },
 { label: 'Check Resend domain', cmd: 'RESEND_API_KEY=... NEWSLETTER_FROM=\"Frontaliere Ticino <newsletter@frontaliereticino.ch>\" node scripts/check-resend-domain.mjs' },
 { label: 'Invio test (solo go-live)', cmd: 'NEWSLETTER_EXPERIMENTAL_MODE=false NEWSLETTER_ENABLE_SEND=true GOOGLE_APPLICATION_CREDENTIALS=path/to/sa.json node scripts/send-newsletter.mjs --test' },
 { label: 'Invio a tutti (solo go-live)', cmd: 'NEWSLETTER_EXPERIMENTAL_MODE=false NEWSLETTER_ENABLE_SEND=true GOOGLE_APPLICATION_CREDENTIALS=path/to/sa.json node scripts/send-newsletter.mjs --send' },
 ].map(item => (
 <div key={item.label} className="flex items-center gap-2">
 <span className="text-sm text-muted w-24 shrink-0">{item.label}:</span>
 <CopyButton text={item.cmd} label={item.label} />
 </div>
 ))}
 </div>
 </div>
 )}

 {/* Footer note */}
 <div className="bg-warning-subtle border border-warning-border rounded-xl p-4 flex gap-3">
 <AlertTriangle size={20} className="text-warning shrink-0 mt-0.5" />
 <p className="text-warning text-sm">
 <strong>Nota:</strong> Questo pannello copre solo strumenti owner/crawler/newsletter.
 Le attività editoriali restano fuori da questa dashboard.
 </p>
 </div>
 </div>
 );
}
