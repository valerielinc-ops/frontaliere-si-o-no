/** Shared client for the authenticated admin GitHub proxy. */

export const ADMIN_GITHUB_ENDPOINT = 'https://europe-west6-frontaliere-ticino.cloudfunctions.net/adminGithub/';
export const ADMIN_GITHUB_REPOSITORY = 'valerielinc-ops/frontaliere-si-o-no';

export interface AdminGithubUser {
  getIdToken: () => Promise<string>;
}

export interface AdminGithubClient {
  request: (method: string, endpoint: string, body?: Record<string, unknown>) => Promise<any>;
  requestWithStatus: (method: string, endpoint: string, body?: Record<string, unknown>, signal?: AbortSignal) => Promise<{ status: number; body: any }>;
}

export function createAdminGithubClient(user: AdminGithubUser | null | undefined): AdminGithubClient {
  const requestWithStatus = async (method: string, endpoint: string, body?: Record<string, unknown>, signal?: AbortSignal) => {
    if (!user) throw new Error('Devi essere autenticato come admin per usare le funzioni GitHub.');
    const idToken = await user.getIdToken();
    const response = await fetch(ADMIN_GITHUB_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, path: endpoint, ...(body !== undefined ? { body } : {}) }),
      signal,
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, body: data };
  };
  return {
    request: async (method, endpoint, body) => {
      const response = await requestWithStatus(method, endpoint, body);
      if (response.status < 200 || response.status >= 300 || !response.body?.ok) {
        throw new Error(String(response.body?.message || response.body?.error || `GitHub API ${response.status}`));
      }
      return response.body.data;
    },
    requestWithStatus,
  };
}
