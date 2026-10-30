import { parseEmployerResponse, type EmployerResponse } from './assistedApplicationEmployerResponse';
import { MY_ASSISTED_APPLICATIONS_URL } from './functionsBase';

export type AssistedApplicationCandidateStatus =
  | 'awaiting_materials'
  | 'in_progress'
  | 'needs_candidate'
  | 'under_review'
  | 'submitted'
  | 'refunded';

export interface CandidateAssistedApplication {
  orderId: string;
  jobTitle: string;
  companyName: string;
  companyKey?: string | null;
  location?: string | null;
  jobUrl?: string | null;
  applicationUrl?: string | null;
  source: 'single' | 'concierge';
  status: AssistedApplicationCandidateStatus;
  updatedAt: string | null;
  requiresCvUpload: boolean;
  employerResponse?: EmployerResponse | null;
}

interface AuthenticatedUser {
  getIdToken: () => Promise<string>;
}

const CANDIDATE_STATUSES = new Set<AssistedApplicationCandidateStatus>([
  'awaiting_materials',
  'in_progress',
  'needs_candidate',
  'under_review',
  'submitted',
  'refunded',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function optionalLocation(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const location = value.replace(/\s+/g, ' ').trim().slice(0, 180);
  return location || null;
}

function parseCandidateApplication(value: unknown): CandidateAssistedApplication | null {
  if (!isRecord(value)) return null;
  if (typeof value.orderId !== 'string' || !value.orderId.trim()) return null;
  if (typeof value.jobTitle !== 'string' || typeof value.companyName !== 'string') return null;
  const source = value.source;
  if (source !== 'single' && source !== 'concierge') return null;
  if (typeof value.status !== 'string' || !CANDIDATE_STATUSES.has(value.status as AssistedApplicationCandidateStatus)) return null;
  if (typeof value.requiresCvUpload !== 'boolean') return null;
  const updatedAtValue = value.updatedAt;
  let updatedAt: string | null;
  if (typeof updatedAtValue === 'string') {
    if (Number.isNaN(Date.parse(updatedAtValue))) return null;
    updatedAt = updatedAtValue;
  } else if (updatedAtValue === null) {
    updatedAt = null;
  } else {
    return null;
  }

  return {
    orderId: value.orderId,
    jobTitle: value.jobTitle,
    companyName: value.companyName,
    ...(typeof value.companyKey === 'string' ? { companyKey: value.companyKey.trim().slice(0, 200) || null } : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'location') ? { location: optionalLocation(value.location) } : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'jobUrl') ? { jobUrl: safeHttpsUrl(value.jobUrl) } : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'applicationUrl') ? { applicationUrl: safeHttpsUrl(value.applicationUrl) } : {}),
    source,
    status: value.status as AssistedApplicationCandidateStatus,
    updatedAt,
    requiresCvUpload: value.requiresCvUpload,
    ...(Object.prototype.hasOwnProperty.call(value, 'employerResponse') ? { employerResponse: parseEmployerResponse(value.employerResponse) } : {}),
  };
}

export async function fetchMyAssistedApplications(
  user: AuthenticatedUser,
): Promise<CandidateAssistedApplication[]> {
  const token = await user.getIdToken();
  const response = await fetch(MY_ASSISTED_APPLICATIONS_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(payload) || payload.ok !== true || !Array.isArray(payload.applications)) {
    throw new Error('assisted_applications_unavailable');
  }

  const applications: CandidateAssistedApplication[] = [];
  for (const item of payload.applications) {
    const application = parseCandidateApplication(item);
    if (!application) throw new Error('assisted_applications_invalid_response');
    applications.push(application);
  }
  return applications;
}
