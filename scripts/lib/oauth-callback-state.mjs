/** Classify one OAuth callback without letting stale tabs abort a live flow. */
export function classifyOAuthCallback({ code, error, state }, expectedState) {
  if (state !== expectedState) return { kind: 'stale' };
  if (error) return { kind: 'error', error };
  if (!code) return { kind: 'invalid' };
  return { kind: 'success', code };
}
