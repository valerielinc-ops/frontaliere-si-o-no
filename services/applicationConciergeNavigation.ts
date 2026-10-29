import { buildPath } from './router';
import { resolveJobCanton } from '../build-plugins/shared/cantonSection';
import type { ApplicationConciergeProposal } from './applicationConciergeService';

type Locale = 'it' | 'en' | 'de' | 'fr';
const validId = (value: string | null): value is string => Boolean(value && /^[A-Za-z0-9_-]{1,200}$/.test(value));
export function conciergeProposalContext(search: string): { serviceId: string; proposalId: string } | null {
  const params = new URLSearchParams(search);
  const serviceId = params.get('concierge_service');
  const proposalId = params.get('concierge_proposal');
  return validId(serviceId) && validId(proposalId) ? { serviceId, proposalId } : null;
}
export function conciergeServiceHref(serviceId: string, locale: Locale, childId?: string | null): string {
  const params = new URLSearchParams({ application_concierge_service_id: serviceId });
  if (childId) params.set('application_concierge_application_id', childId);
  return `${buildPath({ activeTab: 'job-board', applicationConciergeLocale: locale }, locale)}?${params}`;
}

/** Resolve the same published locale slug and canton used by JobDetails, without loading the whole index. */
export async function conciergeProposalJobHref(proposal: ApplicationConciergeProposal, serviceId: string, locale: Locale, signal?: AbortSignal): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(proposal.jobId)) throw new Error('job_not_found');
  const response = await fetch(`https://cdn.frontaliereticino.ch/data/job-detail/${encodeURIComponent(proposal.jobId)}.json`, { signal });
  if (!response.ok) throw new Error('job_not_found');
  const detail = await response.json();
  const slug = String(detail?.slugByLocale?.[locale] || '').trim();
  if (!slug || /[/\\?#]/.test(slug)) throw new Error('job_not_found');
  const canton = resolveJobCanton({ canton: String(detail.addressRegion || ''), location: String(detail.addressLocality || proposal.location || '') });
  const path = buildPath({ activeTab: 'job-board', jobSlug: slug, jobBoardCanton: canton }, locale);
  const params = new URLSearchParams({ concierge_service: serviceId, concierge_proposal: proposal.proposalId });
  return `${path}?${params}`;
}
