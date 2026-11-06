/**
 * Remote Config gate for the AI answer check.
 *
 * The local default is deliberately OFF. The browser's public-config
 * activation and the server-side read must both use the same parameter; the
 * server remains authoritative and treats an absent, invalid or unreadable
 * value as disabled.
 */

export const ASSISTED_APPLICATION_ANSWER_AI_RC_KEY = 'ASSISTED_APPLICATION_ANSWER_AI_ENABLED';
export const ASSISTED_APPLICATION_ANSWER_AI_LOCAL_DEFAULT = false;

export function assistedApplicationAnswerAiEnabled(value) {
  if (typeof value !== 'string') return ASSISTED_APPLICATION_ANSWER_AI_LOCAL_DEFAULT;
  return value.trim().toLowerCase() === 'true';
}
