import { FUNCTIONS_BASE } from './functionsBase';

export const ADMIN_REMOTE_CONFIG_ENDPOINT = `${FUNCTIONS_BASE}/adminRemoteConfig/`;

export interface AdminRemoteConfigParameter {
  name: string;
  hidden?: boolean;
  reason?: 'nome sensibile' | 'non è un flag';
  value?: string;
  defaultValue?: string;
  conditionalValues?: Array<{ condition: string; value: string }>;
  description?: string;
}

interface AuthLike { getIdToken: () => Promise<string> }

export async function fetchAdminRemoteConfig(user: AuthLike | null | undefined): Promise<AdminRemoteConfigParameter[]> {
  if (!user) throw new Error('Devi essere autenticato come admin per leggere i flag.');
  const response = await fetch(ADMIN_REMOTE_CONFIG_ENDPOINT, { headers: { Authorization: `Bearer ${await user.getIdToken()}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(`Flag non disponibili (${data.error || response.status}).`);
  return Array.isArray(data.parameters) ? data.parameters as AdminRemoteConfigParameter[] : [];
}
