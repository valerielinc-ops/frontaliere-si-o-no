import { FUNCTIONS_BASE } from './functionsBase';
import type { Locale } from './i18n';

export const STABIO_DOSSO_PETITION_ID = 'stabio-dosso';

export type PetitionSignatureResponse = {
  success: boolean;
  signed?: boolean;
  alreadySigned?: boolean;
  error?: string;
};

/** Submit one verified account's signature through the server-owned gate. */
export async function signStabioDossoPetition(
  user: any,
  locale: Locale,
): Promise<PetitionSignatureResponse> {
  if (!user?.getIdToken) throw new Error('petition/auth-required');
  const token = await user.getIdToken();
  const response = await fetch(`${FUNCTIONS_BASE}/signStabioDossoPetition`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      petitionId: STABIO_DOSSO_PETITION_ID,
      locale,
      sourcePath: typeof window !== 'undefined' ? window.location.pathname : null,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.success !== true) {
    throw new Error(String(data?.error || `petition/sign-failed:${response.status}`));
  }
  return data as PetitionSignatureResponse;
}
