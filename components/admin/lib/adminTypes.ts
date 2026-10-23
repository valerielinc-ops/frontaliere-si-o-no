import type { EmployerInsightsWindow, EmployerOutreachStatus, EmployerInsightsRow } from '@/services/adminInsights';

export type WorkflowContext = 'jobs' | 'content' | 'seo' | 'analytics';
export type WorkflowImpact = 'lettura' | 'modifica dati' | 'pubblicazione';

export interface WorkflowActionDefinition {
  id: string;
  title: string;
  context: WorkflowContext;
  impact?: WorkflowImpact;
  description: string;
  details: string;
  expectedDuration: string;
  schedule?: string;
  summaryKey?: string | null;
  defaultInputs?: Record<string, string>;
  isUtility?: boolean;
  slug?: string;
  groupId?: string;
  groupMemberCount?: number;
}

export interface WorkflowJobSummary {
  id: number;
  name: string;
  status: string;
  conclusion: string;
  totalSteps: number;
  completedSteps: number;
  failedSteps: string[];
}

export interface WorkflowRunState {
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

export interface CrawlerSummaryLinkRow {
  title: string;
  company: string;
  location: string;
  url: string;
  slug: string;
  _qualityScore?: number;
  _qualityBreakdown?: { cleanliness: number; richness: number; translation: number; completeness: number };
}

export interface CrawlerQualityScore {
  avgScore: number;
  breakdown: { cleanliness: number; richness: number; translation: number; completeness: number };
  jobCount: number;
  lastUpdated: string;
  worstJobs: Array<{
    slug: string;
    title: string;
    score: number;
    breakdown: { cleanliness: number; richness: number; translation: number; completeness: number };
  }>;
}

export interface CrawlerSummaryRow {
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

export type CrawlerSortColumn = 'title' | 'schedule' | 'lastRun' | 'total' | 'newCount' | 'updatedCount' | 'removedCount' | 'unchangedCount' | 'duration' | 'status' | 'quality';
export type CrawlerSortDirection = 'asc' | 'desc';
export type CrawlerChangeFilter = 'all' | 'new' | 'updated' | 'removed' | 'none' | 'failed' | 'in-progress' | 'unchanged' | 'quality-low';

export type InsightsSortColumn = 'companyName' | 'views' | 'applyClicks' | 'applyClickUsers' | 'applications' | 'profileViews' | 'adsObserved' | 'generatedAt' | 'window';

export interface OwnerStats {
  loading: boolean;
  error: string | null;
  socialProofTotal: number | null;
  simulationDocs: number | null;
  forumQuestions: number | null;
  newsletterActive: number | null;
  publicFiles: Record<string, boolean>;
}

export interface NewsletterInsight {
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

export interface SerpDiagnostics {
  loaded: boolean;
  runtime: { enabled: boolean; variant: string; targets: string; year: string };
  defaults: { enabled: boolean; variant: string; targets: string; year: string };
  hasRemoteOverride: boolean;
}

export interface JobsCrawlerConfigState {
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

export interface JobsCrawlerConfigMeta {
  source: 'firestore' | 'default';
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface EmployerSequenceInput {
  company: string;
  metricValue?: number | null;
  metricLabel?: string;
  periodLabel: string;
  contactName?: string;
  topRole?: string;
  optOutEmail?: string;
}

export type { EmployerInsightsRow, EmployerInsightsWindow, EmployerOutreachStatus };
