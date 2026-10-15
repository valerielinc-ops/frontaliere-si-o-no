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
  status: 'proposed' | 'accepted' | 'declined' | 'expired' | string;
  proposedAt?: string | null;
  acceptedAt?: string | null;
  declinedAt?: string | null;
  childApplicationId?: string | null;
  matchScore?: number | null;
  matchReasons?: string[];
  matchedAt?: string | null;
  source?: string | null;
}

export interface ApplicationConciergeService {
  serviceId: string;
  paymentStatus: string;
  serviceStatus: string;
  renewal: boolean;
  maxPositions: number;
  acceptedPositionsCount: number;
  remainingPositions: number;
  paidAt?: string | null;
  expiresAt?: string | null;
  customerEmail?: string | null;
  applicantName?: string | null;
  applicantEmail?: string | null;
  applicantPhone?: string | null;
  hasConsent: boolean;
  hasCv: boolean;
  consentedAt?: string | null;
  cvUploadedAt?: string | null;
  cvFileName?: string | null;
  cvProfileStatus?: 'queued' | 'processing' | 'ready' | 'needs_review' | string | null;
  matchingStatus?: 'queued' | 'running' | 'complete' | 'needs_review' | 'failed' | string | null;
  matchingJobCount?: number | null;
  matchingStartedAt?: string | null;
  matchingCompletedAt?: string | null;
  matchingError?: string | null;
  proposals: ApplicationConciergeProposal[];
  userId?: string | null;
  consentVersion?: string | null;
  cvStorageKey?: string | null;
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
  input: { applicantName: string; applicantEmail: string; applicantPhone?: string },
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
