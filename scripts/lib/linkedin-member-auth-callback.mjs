/** Classify one LinkedIn OAuth callback without allowing stale tabs to abort a live flow. */
export function classifyLinkedInMemberAuthCallback({ code, error, state }, expectedState) {
  if (state !== expectedState) return { kind: 'stale' };
  if (error) return { kind: 'error', error };
  if (!code) return { kind: 'invalid' };
  return { kind: 'success', code };
}
