import {
  PUBLIC_CONFIG_FUNCTION_ENDPOINT,
  PUBLIC_CONFIG_PATH,
  PUBLIC_CONFIG_SITE_HOST,
} from './publicConfigConstants.mjs';

/** Use the Worker route only on the production apex where it is deployed. */
export function getPublicConfigEndpoint(hostname?: string): string {
  const host = (hostname ?? (typeof window !== 'undefined' ? window.location.hostname : '')).toLowerCase();
  return host === PUBLIC_CONFIG_SITE_HOST ? PUBLIC_CONFIG_PATH : PUBLIC_CONFIG_FUNCTION_ENDPOINT;
}

/** Fall back to the function if the production Worker route is unavailable. */
export async function fetchPublicConfigResponse(
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const init: RequestInit = { credentials: 'omit', cache: 'default' };
  let response: Response;
  try {
    response = await fetchImpl(endpoint, init);
  } catch (error) {
    if (endpoint === PUBLIC_CONFIG_FUNCTION_ENDPOINT) throw error;
    return fetchImpl(PUBLIC_CONFIG_FUNCTION_ENDPOINT, init);
  }

  if (!response.ok && endpoint !== PUBLIC_CONFIG_FUNCTION_ENDPOINT) {
    try {
      const fallback = await fetchImpl(PUBLIC_CONFIG_FUNCTION_ENDPOINT, init);
      if (fallback.ok) return fallback;
    } catch {
      // Keep the first response for the caller's normal fail-open path.
    }
  }
  return response;
}
