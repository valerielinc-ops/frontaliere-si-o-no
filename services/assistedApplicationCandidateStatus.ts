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
  source: 'single' | 'concierge';
  status: AssistedApplicationCandidateStatus;
  updatedAt: string | null;
  requiresCvUpload: boolean;
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

function parseCandidateApplication(value: unknown): CandidateAssistedApplication | null {
  if (!isRecord(value)) return null;
  if (typeof value.orderId !== 'string' || !value.orderId.trim()) return null;
  if (typeof value.jobTitle !== 'string' || typeof value.companyName !== 'string') return null;
  if (value.source !== 'single' && value.source !== 'concierge') return null;
  if (typeof value.status !== 'string' || !CANDIDATE_STATUSES.has(value.status as AssistedApplicationCandidateStatus)) return null;
  if (typeof value.requiresCvUpload !== 'boolean') return null;
  if (value.updatedAt !== null && (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt)))) return null;

  return {
    orderId: value.orderId,
    jobTitle: value.jobTitle,
    companyName: value.companyName,
    source: value.source,
    status: value.status as AssistedApplicationCandidateStatus,
    updatedAt: value.updatedAt,
    requiresCvUpload: value.requiresCvUpload,
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
