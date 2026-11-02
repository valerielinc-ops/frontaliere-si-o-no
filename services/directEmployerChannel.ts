import { FUNCTIONS_BASE } from './functionsBase';
import { ensureAppCheck, fetchAndActivate, getConfigValue } from './firebase';
import { cdnDataUrl } from './cdnDataBase';
import { DIRECT_EMPLOYER_CHANNEL_FLAG } from './directEmployerFeature';

export const DIRECT_EMPLOYER_VERIFY_ENDPOINT = `${FUNCTIONS_BASE}/verifyDirectEmployerListing/`;
export const DIRECT_EMPLOYER_RENEW_ENDPOINT = `${FUNCTIONS_BASE}/renewDirectEmployerListing/`;
export const DIRECT_EMPLOYER_ADMIN_ENDPOINT = `${FUNCTIONS_BASE}/adminDirectEmployerListings/`;
export const DIRECT_EMPLOYER_LIST_ENDPOINT = `${FUNCTIONS_BASE}/getPermanentEmployers/`;
const PROSPECTOR_PERMANENT_EMPLOYER_FEED = '/data/permanent-employers.json';

export interface DirectEmployerFormInput {
  companyName: string;
  companyWebsite?: string;
  title: string;
  locationLabel: string;
  streetAddress?: string;
  postalCode?: string;
  canton?: string;
  employmentType: string;
  salaryMin?: string;
  salaryMax?: string;
  description: string;
  contactEmail?: string;
  contactPhone?: string;
  websiteConfirm?: string;
  locale?: string;
  origin?: string;
}
export interface PermanentEmployer {
  id: string;
  companyName: string;
  website: string;
  locationLabel?: string;
}

export interface DirectEmployerModerationListing {
  id: string;
  companyName: string;
  companyWebsite?: string;
  title: string;
  description: string;
  locationLabel: string;
  canton?: string;
  employmentType?: string;
  contactType?: string;
  contactEmail?: string;
  contactPhone?: string;
  riskFlags?: string[];
  status: string;
  createdAt?: { _seconds?: number } | string;
}

export interface DirectEmployerModerationPage<T> {
  items: T[];
  nextPageToken: string | null;
}

export interface PermanentEmployerSignal {
  id: string;
  companyName: string;
  website: string;
  locationLabel?: string;
  status: string;
  candidateMarks?: number;
}

async function assertFeatureEnabled(): Promise<boolean> {
  await fetchAndActivate();
  return (await getConfigValue(DIRECT_EMPLOYER_CHANNEL_FLAG)).trim().toLowerCase() === 'true';
}

async function callFunction<T>(name: string, data: unknown): Promise<T> {
  await ensureAppCheck();
  const [{ getFunctions, httpsCallable }, appModule] = await Promise.all([
    import('firebase/functions'),
    import('./firebase'),
  ]);
  const app = await appModule.getApp();
  const callable = httpsCallable(getFunctions(app, 'europe-west6'), name);
  const result = await callable(data);
  return result.data as T;
}

export async function isDirectEmployerChannelEnabled(): Promise<boolean> {
  return assertFeatureEnabled();
}

export async function submitDirectEmployerListing(input: DirectEmployerFormInput): Promise<{ ok: boolean; status?: string; error?: string; fields?: string[]; renewalUrl?: string }> {
  if (!(await assertFeatureEnabled())) return { ok: false, error: 'channel_disabled' };
  return callFunction('submitDirectEmployerListing', input);
}

export async function verifyDirectEmployerListing(rawToken: string): Promise<{ ok: boolean; status?: string; error?: string }> {
  const response = await fetch(`${DIRECT_EMPLOYER_VERIFY_ENDPOINT}?token=${encodeURIComponent(rawToken)}`, { credentials: 'omit', cache: 'no-store' });
  return response.json() as Promise<{ ok: boolean; status?: string; error?: string }>;
}

export async function renewDirectEmployerListing(rawToken: string): Promise<{ ok: boolean; expiresAt?: string; error?: string }> {
  const response = await fetch(`${DIRECT_EMPLOYER_RENEW_ENDPOINT}?token=${encodeURIComponent(rawToken)}`, { credentials: 'omit', cache: 'no-store' });
  return response.json() as Promise<{ ok: boolean; expiresAt?: string; error?: string }>;
}

export async function loadPermanentEmployers(): Promise<{ enabled: boolean; employers: PermanentEmployer[] }> {
  if (!(await assertFeatureEnabled())) return { enabled: false, employers: [] };
  const [response, prospectorResponse] = await Promise.all([
    fetch(DIRECT_EMPLOYER_LIST_ENDPOINT, { credentials: 'omit', cache: 'no-store' }),
    fetch(cdnDataUrl(PROSPECTOR_PERMANENT_EMPLOYER_FEED), { credentials: 'omit', cache: 'force-cache' }).catch(() => null),
  ]);
  if (!response.ok) return { enabled: false, employers: [] };
  const data = await response.json() as { enabled?: boolean; employers?: PermanentEmployer[] };
  if (data.enabled !== true) return { enabled: false, employers: [] };
  const prospector = prospectorResponse?.ok
    ? await prospectorResponse.json() as { employers?: PermanentEmployer[] }
    : {};
  const merged = new Map<string, PermanentEmployer>();
  for (const employer of [...(Array.isArray(data.employers) ? data.employers : []), ...(Array.isArray(prospector.employers) ? prospector.employers : [])]) {
    if (!employer?.companyName || !employer.website) continue;
    const key = `${employer.companyName.toLowerCase()}\u0000${employer.website.toLowerCase()}`;
    merged.set(key, employer);
  }
  return { enabled: true, employers: [...merged.values()] };
}

export async function markPermanentEmployer(data: { companyName: string; website: string; locationLabel?: string }): Promise<{ ok: boolean; status?: string; error?: string }> {
  if (!(await assertFeatureEnabled())) return { ok: false, error: 'channel_disabled' };
  return callFunction('markPermanentEmployer', data);
}

export async function getDirectEmployerContact(jobId: string): Promise<{ ok: boolean; email?: string | null; phone?: string | null; error?: string }> {
  if (!(await assertFeatureEnabled())) return { ok: false, error: 'channel_disabled' };
  return callFunction('getDirectEmployerContact', { jobId });
}

export async function fetchAdminDirectEmployerListings(user: { getIdToken: () => Promise<string> } | null, status = 'pending_moderation', cursor = ''): Promise<DirectEmployerModerationPage<DirectEmployerModerationListing>> {
  if (!user) throw new Error('Admin authentication required.');
  const query = new URLSearchParams({ status });
  if (cursor) query.set('cursor', cursor);
  const response = await fetch(`${DIRECT_EMPLOYER_ADMIN_ENDPOINT}?${query.toString()}`, { headers: { Authorization: `Bearer ${await user.getIdToken()}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Moderation queue unavailable.');
  return { items: Array.isArray(data.listings) ? data.listings as DirectEmployerModerationListing[] : [], nextPageToken: typeof data.nextPageToken === 'string' ? data.nextPageToken : null };
}

export async function moderateDirectEmployerListing(user: { getIdToken: () => Promise<string> } | null, id: string, action: 'approve' | 'reject'): Promise<void> {
  if (!user) throw new Error('Admin authentication required.');
  const response = await fetch(DIRECT_EMPLOYER_ADMIN_ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${await user.getIdToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Moderation action failed.');
}

export async function fetchAdminPermanentEmployerSignals(user: { getIdToken: () => Promise<string> } | null, status = 'pending_moderation', cursor = ''): Promise<DirectEmployerModerationPage<PermanentEmployerSignal>> {
  if (!user) throw new Error('Admin authentication required.');
  const query = new URLSearchParams({ kind: 'permanent', status });
  if (cursor) query.set('cursor', cursor);
  const response = await fetch(`${DIRECT_EMPLOYER_ADMIN_ENDPOINT}?${query.toString()}`, { headers: { Authorization: `Bearer ${await user.getIdToken()}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Permanent-employer queue unavailable.');
  return { items: Array.isArray(data.signals) ? data.signals as PermanentEmployerSignal[] : [], nextPageToken: typeof data.nextPageToken === 'string' ? data.nextPageToken : null };
}

export async function moderatePermanentEmployerSignal(user: { getIdToken: () => Promise<string> } | null, id: string, action: 'approve' | 'reject'): Promise<void> {
  if (!user) throw new Error('Admin authentication required.');
  const response = await fetch(DIRECT_EMPLOYER_ADMIN_ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${await user.getIdToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'permanent', id, action }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Permanent-employer moderation failed.');
}
