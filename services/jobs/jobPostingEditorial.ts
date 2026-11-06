import { buildFallbackCanonicalContent } from './canonicalFallback';
import type { Locale } from '../i18n';

/** The access gate never removes the source-owned editorial schema fields. */
export function buildJobPostingEditorialFields(description: string, requirements: string[], locale: Locale) {
  const content = buildFallbackCanonicalContent(description, requirements, locale);
  return {
    ...(content.responsibilities.length ? { responsibilities: content.responsibilities.join('\n') } : {}),
    ...(content.requirements.length ? { qualifications: content.requirements.join('\n') } : {}),
    ...(content.keywords.length ? { skills: content.keywords.join(', ') } : {}),
  };
}
