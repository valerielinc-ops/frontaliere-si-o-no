import { FUNCTIONS_BASE } from './functionsBase';

export const ADMIN_AUDIT_LOG_ENDPOINT = `${FUNCTIONS_BASE}/adminAuditLog/`;

export interface AdminAuditEntry {
  id: string;
  at: string | null;
  uid: string;
  action: string;
  target: string;
  status: number | string;
  details: Record<string, unknown>;
}

export interface AdminAuditPage {
  entries: AdminAuditEntry[];
  nextCursor: string | null;
}

interface AuthLike { getIdToken: () => Promise<string> }

export async function fetchAdminAuditLog(
  user: AuthLike | null | undefined,
  filters: { cursor?: string; action?: string; from?: string; to?: string } = {},
): Promise<AdminAuditPage> {
  if (!user) throw new Error('Devi essere autenticato come admin per leggere il registro.');
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  const response = await fetch(`${ADMIN_AUDIT_LOG_ENDPOINT}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${await user.getIdToken()}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(`Registro non disponibile (${data.error || response.status}).`);
  return {
    entries: Array.isArray(data.entries) ? data.entries as AdminAuditEntry[] : [],
    nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null,
  };
}
