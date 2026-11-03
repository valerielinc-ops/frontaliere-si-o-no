import { FUNCTIONS_BASE } from './functionsBase';
import { ensureAppCheck, fetchAndActivate, getConfigValue } from './firebase';
import { cdnDataUrl } from './cdnDataBase';
import { DIRECT_EMPLOYER_CHANNEL_FLAG } from './directEmployerFeature';

export const DIRECT_EMPLOYER_LIST_ENDPOINT = `${FUNCTIONS_BASE}/getPermanentEmployers/`;
export const DIRECT_EMPLOYER_ADMIN_ENDPOINT = `${FUNCTIONS_BASE}/adminPermanentEmployerSignals/`;
const PROSPECTOR_PERMANENT_EMPLOYER_FEED = '/data/permanent-employers.json';

export interface PermanentEmployer {
  id: string;
  companyName: string;
  website: string;
  locationLabel?: string;
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
  // Browser-safe equivalent of Remote Config fetchAndActivate: refresh the
  // allowlisted public config before every feature entrypoint and fail closed
  // if that refresh cannot prove the current flag value.
  if (!(await fetchAndActivate())) return false;
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

export async function loadPermanentEmployers(): Promise<{ enabled: boolean; employers: PermanentEmployer[] }> {
  if (!(await assertFeatureEnabled())) return { enabled: false, employers: [] };
  const [response, prospectorResponse] = await Promise.all([
    fetch(DIRECT_EMPLOYER_LIST_ENDPOINT, { credentials: 'omit', cache: 'no-store' }).catch(() => null),
    fetch(cdnDataUrl(PROSPECTOR_PERMANENT_EMPLOYER_FEED), { credentials: 'omit', cache: 'force-cache' }).catch(() => null),
  ]);
  // The generated prospector feed is the primary source.  The Firestore
  // endpoint only adds moderated candidate signals, so an endpoint outage
  // must not turn an enabled channel into the misleading "preparing" state.
  // A successful endpoint response with enabled:false remains authoritative.
  let runtimeEmployers: PermanentEmployer[] = [];
  if (response?.ok) {
    const data = await response.json().catch(() => ({})) as { enabled?: boolean; employers?: PermanentEmployer[] };
    if (data.enabled !== true) return { enabled: false, employers: [] };
    runtimeEmployers = Array.isArray(data.employers) ? data.employers : [];
  }
  const prospector = prospectorResponse?.ok
    ? await prospectorResponse.json() as { employers?: PermanentEmployer[] }
    : {};
  const merged = new Map<string, PermanentEmployer>();
  for (const employer of [...runtimeEmployers, ...(Array.isArray(prospector.employers) ? prospector.employers : [])]) {
    if (!employer?.companyName || !employer.website) continue;
    const key = `${employer.companyName.toLowerCase()}\u0000${employer.website.toLowerCase()}`;
    // The runtime list is moderated; the generated prospector feed only fills
    // keys that are not already present in that authoritative source.
    if (!merged.has(key)) merged.set(key, employer);
  }
  return { enabled: true, employers: [...merged.values()] };
}

export async function markPermanentEmployer(data: { companyName: string; website: string; locationLabel?: string }): Promise<{ ok: boolean; status?: string; error?: string }> {
  if (!(await assertFeatureEnabled())) return { ok: false, error: 'channel_disabled' };
  return callFunction('markPermanentEmployer', data);
}

export async function fetchAdminPermanentEmployerSignals(user: { getIdToken: () => Promise<string> } | null, status = 'pending_moderation', cursor = ''): Promise<DirectEmployerModerationPage<PermanentEmployerSignal>> {
  if (!user) throw new Error('Admin authentication required.');
  const query = new URLSearchParams({ status });
  if (cursor) query.set('cursor', cursor);
  const response = await fetch(`${DIRECT_EMPLOYER_ADMIN_ENDPOINT}?${query.toString()}`, { headers: { Authorization: `Bearer ${await user.getIdToken()}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Permanent-employer queue unavailable.');
  return { items: Array.isArray(data.signals) ? data.signals as PermanentEmployerSignal[] : [], nextPageToken: typeof data.nextPageToken === 'string' ? data.nextPageToken : null };
}

export async function moderatePermanentEmployerSignal(user: { getIdToken: () => Promise<string> } | null, id: string, action: 'approve' | 'reject'): Promise<void> {
  if (!user) throw new Error('Admin authentication required.');
  const response = await fetch(DIRECT_EMPLOYER_ADMIN_ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${await user.getIdToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Permanent-employer moderation failed.');
}
