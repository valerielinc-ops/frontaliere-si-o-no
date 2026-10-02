import { createAnalyticsEmissionId } from './analyticsEmissionId';

/** Tab-scoped application journeys. Never store account IDs, URLs, UTMs or text. */
export type JobJourneyStep = 'list_select' | 'detail_view' | 'gate_view' | 'auth_start' | 'auth_success' | 'auth_error' | 'gate_dismiss' | 'apply_click' | 'handoff' | 'handoff_error';
export type JobJourneyIdentity = { jobSlug: string; employerKey?: string; jobId?: string };
type Journey = {
 id: string;
 jobSlug: string;
 jobId?: string;
 aliases: string[];
 employerKey: string;
 startedAt: number;
 source: string;
 device: string;
 entry: 'list' | 'direct';
 steps: JobJourneyStep[];
};
const STORAGE_KEY = 'ft_job_application_journeys_v1';
const TTL = 30 * 60 * 1000;
const memory = new Map<string, Journey>();

/** Only categorical attribution survives. Arbitrary query values never do. */
export function classifyJobJourneySource(search: string, referrer: string): string {
 const params = new URLSearchParams(search);
 const source = (params.get('utm_source') || '').toLowerCase();
 const medium = (params.get('utm_medium') || '').toLowerCase();
 if (['job_alert', 'job-alert', 'job_alerts', 'jobalert'].includes(source)) return 'job_alert';
 if (source === 'newsletter') return 'newsletter';
 if (medium === 'email') return 'email';
 try {
  const host = new URL(referrer).hostname;
  if (/(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com)$/.test(host)) return 'search';
  if (host === 'frontaliereticino.ch') return 'internal';
  return 'referral';
 } catch { return 'direct'; }
}

function readJourneys(): Map<string, Journey> {
 try {
  const stored: Journey[] = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]');
  for (const item of stored) {
   if (typeof item.id === 'string' && typeof item.jobSlug === 'string'
    && Array.isArray(item.steps) && Array.isArray(item.aliases) && Date.now() - item.startedAt < TTL) memory.set(item.jobSlug, item);
  }
 } catch { /* In-memory continuity when storage is refused. */ }
 for (const [key, item] of memory) if (Date.now() - item.startedAt >= TTL) memory.delete(key);
 return memory;
}

function persist(): void {
 while (memory.size > 20) memory.delete(memory.keys().next().value!);
 try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...memory.values()])); } catch { /* Tab memory remains usable. */ }
}

function journeyFor(identity: JobJourneyIdentity, startFromList = false): Journey {
 const journeys = readJourneys();
 let journey = journeys.get(identity.jobSlug) || [...journeys.values()].find((item) =>
  (identity.jobId && item.jobId === identity.jobId) || item.aliases?.includes(identity.jobSlug));
 if (journey && startFromList) journeys.delete(journey.jobSlug);
 if (!journey || startFromList) {
  journey = {
   id: createAnalyticsEmissionId(), jobSlug: identity.jobSlug, jobId: identity.jobId, aliases: [identity.jobSlug],
   employerKey: identity.employerKey || 'unknown', startedAt: Date.now(),
   source: classifyJobJourneySource(typeof location === 'undefined' ? '' : location.search, typeof document === 'undefined' ? '' : document.referrer),
   device: typeof window === 'undefined' ? 'unknown' : window.innerWidth < 768 ? 'mobile' : window.innerWidth < 1024 ? 'tablet' : 'desktop',
   entry: startFromList ? 'list' : 'direct', steps: [],
  };
  journeys.set(identity.jobSlug, journey);
 }
 if (!journey.aliases.includes(identity.jobSlug)) journey.aliases.push(identity.jobSlug);
 // Attribution is immutable: enrichment cannot split a cohort between employers.
 persist();
 return journey;
}

const MILESTONES = new Set<JobJourneyStep>(['list_select', 'detail_view', 'gate_view', 'auth_success', 'apply_click', 'handoff']);

const PATH_CODES: Partial<Record<JobJourneyStep, string>> = { list_select: 'l', detail_view: 'd', gate_view: 'g', auth_success: 'a', apply_click: 'c', handoff: 'h' };

function fields(journey: Journey) {
 const cohort = new Date(journey.startedAt).toISOString().slice(0, 10);
 const path = journey.steps.filter((step) => MILESTONES.has(step));
 return {
  journey_id: journey.id, job_slug: journey.jobSlug, employer_key: journey.employerKey,
  journey_source: journey.source, journey_device: journey.device, journey_entry: journey.entry,
  journey_cohort: cohort,
  journey_path: path.join('>'),
  // One GA4 dimension fits the property quota. Bounded categorical values,
  // no job/user identifier; longest valid context stays below 100 characters.
  journey_context: [cohort, journey.source, journey.entry, journey.steps.at(-1) || 'entry', path.map((step) => PATH_CODES[step]).join('>')].join('|'),
 };
}

export function jobJourneyFields(identity: JobJourneyIdentity) {
 return fields(journeyFor(identity));
}

/** One event per stage per journey: re-renders and auth callbacks cannot inflate it. */
export function recordJobJourneyStep(identity: JobJourneyIdentity, step: JobJourneyStep) {
 if (!identity.jobSlug) return null;
 const journey = journeyFor(identity, step === 'list_select');
 if (journey.steps.includes(step)) return null;
 const previous = journey.steps.at(-1) || 'entry';
 journey.steps.push(step);
 persist();
 return { ...fields(journey), journey_step: step, previous_step: previous, step_index: journey.steps.length };
}
