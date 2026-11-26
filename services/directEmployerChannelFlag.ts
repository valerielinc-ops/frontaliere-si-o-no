import { FUNCTIONS_BASE } from './functionsBase';

export const DIRECT_EMPLOYER_LIST_ENDPOINT = `${FUNCTIONS_BASE}/getPermanentEmployers/`;

export async function readDirectEmployerChannelEnabled(): Promise<boolean> {
  try {
    const response = await fetch(`${DIRECT_EMPLOYER_LIST_ENDPOINT}?status=1`, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
    });
    if (response.status !== 200) return false;
    const data = await response.json();
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return false;
    const keys = Object.keys(data);
    return keys.length === 1 && keys[0] === 'enabled' && data.enabled === true;
  } catch {
    return false;
  }
}
