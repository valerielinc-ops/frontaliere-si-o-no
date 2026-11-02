import { parseEmployerResponse, type EmployerResponse } from './assistedApplicationEmployerResponse';
import { APPLICATION_CONCIERGE_URL, MANAGE_APPLICATION_CONCIERGE_URL } from './functionsBase';

export interface ApplicationConciergeProposal {
  proposalId: string;
  jobId: string;
  jobUrl: string;
  companyId: string;
  companyName: string;
  jobTitle: string;
  location?: string | null;
  applyMode?: string | null;
  status: 'proposed' | 'accepted' | 'declined' | 'expired' | 'retracted' | string;
  eligibilityStatus?: 'compatible' | 'incompatible' | 'unverified' | 'needs_verification' | string | null;
  proposedAt?: string | null;
  acceptedAt?: string | null;
  declinedAt?: string | null;
  childApplicationId?: string | null;
  childApplicationState?: string | null;
  childSubmissionStatus?: string | null;
  childCandidateStatus?: string | null;
  childEmployerResponse?: EmployerResponse | null;
  childEmployerResponseTimeline?: EmployerResponse[];
  childSendState?: string | null;
  childRetryScheduled?: boolean;
  withdrawnAt?: string | null;
  matchScore?: number | null;
  matchReasons?: string[];
  matchedAt?: string | null;
  source?: string | null;
}

export type ApplicationConciergeProposalCategory =
  | 'proposed'
  | 'needs_information'
  | 'accepted'
  | 'queued'
  | 'submitted'
  | 'failed'
  | 'reviewing'
  | 'unknown'
  | 'declined'
  | 'retracted'
  | 'expired'
  | 'withdrawn';

export interface ApplicationConciergeProposalGroup {
  category: ApplicationConciergeProposalCategory;
  proposals: ApplicationConciergeProposal[];
}

export interface ApplicationConciergeService {
  serviceId: string;
  paymentStatus: string;
  paymentProvider?: string;
  checkoutSessionStatus?: string;
  serviceStatus: string;
  renewal: boolean;
  amountTotal?: number;
  renewalOffer?: { amountTotal: number; currency: string; discounted: boolean; discountExpiresAt: number; reminderStage: number | null } | null;
  maxPositions: number;
  acceptedPositionsCount: number;
  remainingPositions: number;
  paidAt?: string | null;
  expiresAt?: string | null;
  customerEmail?: string | null;
  applicantName?: string | null;
  applicantEmail?: string | null;
  applicantPhone?: string | null;
  applicantLocation?: string | null;
  /** Explicit selector confirmation; absent on legacy services, so consumers must not infer country from the label. */
  applicantLocationCountry?: string | null;
  hasConsent: boolean;
  hasCv: boolean;
  consentedAt?: string | null;
  cvUploadedAt?: string | null;
  cvFileName?: string | null;
  cvProfileStatus?: 'queued' | 'processing' | 'ready' | 'needs_review' | string | null;
  matchingStatus?: 'queued' | 'running' | 'complete' | 'needs_review' | 'failed' | string | null;
  matchingJobCount?: number | null;
  matchingUnverifiedCount?: number;
  matchingClarificationCount?: number;
  matchingStartedAt?: string | null;
  matchingCompletedAt?: string | null;
  matchingError?: string | null;
  proposals: ApplicationConciergeProposal[];
  userId?: string | null;
  consentVersion?: string | null;
  cvStorageKey?: string | null;
  paidReceiptEmails?: ApplicationConciergePaidReceiptEmail[];
}

export interface ApplicationConciergePaidReceiptEmail {
  audience: 'customer' | 'owner' | string;
  key: string;
  status: string | null;
  providerStatus: 'accepted' | 'failed' | 'unknown' | string;
  deliveryStatus: 'delivered' | 'bounced' | 'complained' | 'unknown' | string;
  provider: string | null;
  messageId: string | null;
  sentAt: string | null;
  providerAcceptedAt: string | null;
  deliveredAt: string | null;
  bouncedAt: string | null;
  complainedAt: string | null;
  providerAccepted: number;
  delivered: number;
  bounces: number;
  complaints: number;
}

export function getCandidateVisibleApplicationConciergeProposals(
  proposals: readonly ApplicationConciergeProposal[],
): ApplicationConciergeProposal[] {
  // Retractions are part of the candidate's application history. Keep them
  // visible and give them their own category instead of silently removing them.
  return [...proposals];
}

/** The decision to accept a proposal is separate from the progress of its application. */
export function conciergeProposalDisplayStatus(proposal: ApplicationConciergeProposal): string {
  const state = proposal.childApplicationState;
  if (proposal.status === 'accepted' || proposal.childApplicationId || proposal.withdrawnAt) {
    const response = parseEmployerResponse(proposal.childEmployerResponse);
    if (response) return `employer_${response.category}`;
    if (proposal.childCandidateStatus === 'submitted' || proposal.childSubmissionStatus === 'submitted' || proposal.childSendState === 'sent' || state === 'submitted') return 'submitted';
  }
  if (proposal.withdrawnAt || (proposal.status === 'accepted' && state === 'withdrawn')) return 'withdrawn';
  if (proposal.status === 'proposed' && proposal.eligibilityStatus === 'needs_verification') return 'needs_verification';
  if (proposal.status !== 'accepted') {
    switch (proposal.status) {
      case 'proposed': return 'proposed';
      case 'declined': return 'declined';
      case 'expired': return 'expired';
      case 'retracted': return 'retracted';
      default: return 'unknown';
    }
  }
  if (state === 'candidate_review') return 'needs_review';
  if (state === 'needs_candidate_action' || state === 'candidate_handoff'
    || proposal.childCandidateStatus === 'needs_candidate' || proposal.childCandidateStatus === 'awaiting_materials') return 'needs_answers';
  if (state === 'submitting') return proposal.childSendState === 'sending' ? 'sending' : 'queued';
  if (proposal.childRetryScheduled) return 'retry_scheduled';
  if (state === 'failed' || proposal.childSubmissionStatus === 'failed' || proposal.childCandidateStatus === 'failed') return 'failed';
  if (state === 'owner_takeover' || state === 'owner_review' || proposal.childCandidateStatus === 'under_review') return 'technical_review';
  if (state === 'drafting' || state === 'regenerating') return 'preparing';
  if (!state) return proposal.childApplicationId ? 'unknown' : 'accepted';
  if (state === 'accepted') return 'accepted';
  return 'unknown';
}

const PROPOSAL_CATEGORY_ORDER: readonly ApplicationConciergeProposalCategory[] = [
  'proposed',
  'needs_information',
  'accepted',
  'queued',
  'submitted',
  'failed',
  'reviewing',
  'unknown',
  'declined',
  'retracted',
  'expired',
  'withdrawn',
];

export function conciergeProposalDisplayCategory(proposal: ApplicationConciergeProposal): ApplicationConciergeProposalCategory {
  const status = conciergeProposalDisplayStatus(proposal);
  if (status.startsWith('employer_')) return 'submitted';
  switch (status) {
    case 'needs_information':
    case 'needs_answers':
    case 'needs_review': return 'needs_information';
    case 'queued':
    case 'sending':
    case 'retry_scheduled': return 'queued';
    case 'preparing':
    case 'accepted': return 'accepted';
    case 'technical_review': return 'reviewing';
    case 'needs_verification':
    case 'proposed': return 'proposed';
    case 'declined': return 'declined';
    case 'retracted': return 'retracted';
    case 'expired': return 'expired';
    case 'withdrawn': return 'withdrawn';
    case 'submitted': return 'submitted';
    case 'failed': return 'failed';
    case 'unknown': return 'unknown';
    default: return 'unknown';
  }
}

export function groupApplicationConciergeProposals(
  proposals: readonly ApplicationConciergeProposal[],
): ApplicationConciergeProposalGroup[] {
  const grouped = new Map<ApplicationConciergeProposalCategory, ApplicationConciergeProposal[]>();
  for (const proposal of proposals) {
    const category = conciergeProposalDisplayCategory(proposal);
    const group = grouped.get(category) || [];
    group.push(proposal);
    grouped.set(category, group);
  }
  return PROPOSAL_CATEGORY_ORDER.flatMap((category) => {
    const items = grouped.get(category);
    return items?.length ? [{ category, proposals: items }] : [];
  });
}

function errorCode(value: unknown): string {
  if (typeof value === 'string' && /^[a-z][a-z0-9_.:/-]{0,63}$/.test(value)) return value;
  return 'application_concierge_request_failed';
}

async function callApplicationConcierge(
  user: any,
  method: 'GET' | 'POST',
  serviceId?: string | null,
  body?: Record<string, unknown>,
): Promise<any> {
  const token = await user.getIdToken();
  const url = method === 'GET' && serviceId
    ? `${APPLICATION_CONCIERGE_URL}?serviceId=${encodeURIComponent(serviceId)}`
    : APPLICATION_CONCIERGE_URL;
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    ...(method === 'POST' ? { body: JSON.stringify({ ...(serviceId ? { serviceId } : {}), ...body }) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) throw new Error(errorCode(data?.error));
  return data;
}

export async function fetchApplicationConciergeService(user: any, serviceId: string): Promise<ApplicationConciergeService> {
  const data = await callApplicationConcierge(user, 'GET', serviceId);
  return data.service as ApplicationConciergeService;
}

export async function fetchApplicationConciergeServices(user: any): Promise<ApplicationConciergeService[]> {
  const data = await callApplicationConcierge(user, 'GET');
  return Array.isArray(data.services) ? data.services as ApplicationConciergeService[] : [];
}

export async function saveApplicationConciergeProfile(
  user: any,
  serviceId: string,
  input: {
    applicantName: string;
    applicantEmail: string;
    applicantPhone?: string;
    applicantLocation?: string;
    applicantLocationCountry?: string;
    consent?: boolean;
    cvStorageKey?: string;
    cvFileName?: string;
  },
): Promise<ApplicationConciergeService> {
  const data = await callApplicationConcierge(user, 'POST', serviceId, { action: 'saveProfile', ...input });
  return data.service as ApplicationConciergeService;
}

export async function recordApplicationConciergeConsent(
  user: any,
  serviceId: string,
  input: { applicantName: string; applicantEmail: string; applicantPhone?: string; applicantLocation?: string; applicantLocationCountry?: string },
): Promise<ApplicationConciergeService> {
  const data = await callApplicationConcierge(user, 'POST', serviceId, { action: 'recordConsent', consent: true, ...input });
  return data.service as ApplicationConciergeService;
}

export async function acceptApplicationConciergeProposal(user: any, serviceId: string, proposalId: string): Promise<{
  service: ApplicationConciergeService;
  childApplicationId: string;
}> {
  const data = await callApplicationConcierge(user, 'POST', serviceId, { action: 'acceptProposal', proposalId });
  return data as { service: ApplicationConciergeService; childApplicationId: string };
}

export async function declineApplicationConciergeProposal(user: any, serviceId: string, proposalId: string): Promise<ApplicationConciergeService> {
  const data = await callApplicationConcierge(user, 'POST', serviceId, { action: 'declineProposal', proposalId });
  return data.service as ApplicationConciergeService;
}

export interface ApplicationConciergeAdminResponse {
  services: ApplicationConciergeService[];
}

export async function fetchApplicationConciergeAdminData(user: any): Promise<ApplicationConciergeAdminResponse> {
  const token = await user.getIdToken();
  const response = await fetch(MANAGE_APPLICATION_CONCIERGE_URL, { headers: { Authorization: `Bearer ${token}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) throw new Error(errorCode(data?.error));
  return data as ApplicationConciergeAdminResponse;
}

export async function createApplicationConciergeProposal(
  user: any,
  input: {
    serviceId: string;
    jobId: string;
    jobUrl: string;
    companyId: string;
    companyName: string;
    jobTitle: string;
    location?: string;
    applyMode?: string;
  },
): Promise<ApplicationConciergeService> {
  const token = await user.getIdToken();
  const response = await fetch(MANAGE_APPLICATION_CONCIERGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: 'createProposal', ...input }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) throw new Error(errorCode(data?.error));
  return data.service as ApplicationConciergeService;
}

/** Recover an anonymous checkout only after independent verified-email sign-in. */
export async function recoverApplicationConciergePaymentSession(user: any, serviceId: string): Promise<string> {
  const data = await callApplicationConcierge(user, 'POST', serviceId, { action: 'recoverPaymentSession' });
  if (typeof data.authToken !== 'string' || !data.authToken) throw new Error('service_not_found');
  return data.authToken;
}


/** A short-lived review token stays in memory, never in the service/job-detail URL. */
export async function openApplicationConciergeChildReview(user: any, serviceId: string, proposalId: string): Promise<string> {
  const data = await callApplicationConcierge(user, 'POST', serviceId, { action: 'openChildReview', proposalId });
  if (typeof data.token !== 'string' || !data.token) throw new Error('application_concierge_request_failed');
  return data.token;
}
