export const NO_APPLICATION_RECOVERY_MARKER = '[no-application-recovery]';

export function shouldApplyApplicationRecovery({ eventName, selectedRevisionMessage } = {}) {
  if (!['push', 'workflow_dispatch'].includes(eventName)) throw new TypeError('unsupported application recovery trigger');
  if (typeof selectedRevisionMessage !== 'string') throw new TypeError('selected revision commit message is required');
  return !selectedRevisionMessage.includes(NO_APPLICATION_RECOVERY_MARKER);
}
