/** Source-backed correction of restaurant Crew mistranslations.
 * Only known corruptions are rewritten; identities and URLs are never derived here.
 */
const BAD_CREW = /^(?:United Nations|Nazioni Unite|Vereinte Nationen|Nations Unies|Besatzung)$/i;

export function repairJobTitleSemanticsInPlace(job) {
  if (!job || typeof job !== 'object') return 0;
  const sourceTitle = String(job.titleByLocale?.[job.sourceLang] || job.title || '').trim();
  if (!/^crew$/i.test(sourceTitle)) return 0;
  // Require employer evidence, not the translated title itself. A real UN role
  // or an airline's Crew/Besatzung has no restaurant employer anchor.
  let employerHost = '';
  try { employerHost = new URL(job.url).hostname; } catch {}
  const restaurant = /\bmcdonald[’']?s\b/i.test(String(job.company || ''))
    || employerHost === 'jobs.mcdonalds.ch';
  if (!restaurant) return 0;
  let changed = 0;
  if (BAD_CREW.test(String(job.title || '').trim())) { job.title = sourceTitle; changed++; }
  for (const [locale, title] of Object.entries(job.titleByLocale || {})) {
    if (locale === job.sourceLang || typeof title !== 'string' || !BAD_CREW.test(title.trim())) continue;
    job.titleByLocale[locale] = sourceTitle;
    changed++;
  }
  return changed;
}
