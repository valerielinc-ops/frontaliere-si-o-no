import { createHash } from 'node:crypto';

/** Fingerprint the exact Codex hook/CTA pair without exposing either string. */
export function socialCopyRevisionId({ copyHook, copyCta, hook, cta } = {}) {
  const hookText = String(copyHook ?? hook ?? '').replace(/\r\n?/gu, '\n');
  const ctaText = String(copyCta ?? cta ?? '').replace(/\r\n?/gu, '\n');
  if (!hookText || !ctaText || hookText.length > 512 || ctaText.length > 512) return null;
  return createHash('sha256')
    .update(JSON.stringify({ version: 1, hook: hookText, cta: ctaText }))
    .digest('hex')
    .slice(0, 16);
}
