/** Source-backed correction of restaurant title and employer-brand mistranslations.
 * Only known corruptions are rewritten; identities and URLs are never derived here.
 */
const BAD_CREW = /^(?:United Nations|Nazioni Unite|Vereinte Nationen|Nations Unies|Besatzung)$/i;

export function repairJobTitleSemanticsInPlace(job) {
  if (!job || typeof job !== 'object') return 0;
  const sourceTitle = String(job.titleByLocale?.[job.sourceLang] || job.title || '').trim();
  if (!/^crew$/i.test(sourceTitle)) return 0;
  // Require employer evidence, not the translated title itself. A real UN role
  // or an airline's Crew/Besatzung has no restaurant employer anchor.
  if (!isMcDonaldsEmployer(job)) return 0;
  let changed = 0;
  if (BAD_CREW.test(String(job.title || '').trim())) { job.title = sourceTitle; changed++; }
  for (const [locale, title] of Object.entries(job.titleByLocale || {})) {
    if (locale === job.sourceLang || typeof title !== 'string' || !BAD_CREW.test(title.trim())) continue;
    job.titleByLocale[locale] = sourceTitle;
    changed++;
  }
  return changed;
}

/** Repair only observed brand corruptions backed by the original employer copy. */
export function repairJobDescriptionBrandsInPlace(job) {
  if (!job || typeof job !== 'object') return 0;
  const source = String(job.descriptionByLocale?.[job.sourceLang] || job.description || '');
  const brand = source.match(/\bMcDonald[’']s\b/i)?.[0];
  const corruptBrand = /\b(?:McDonsons|McDonkey[’']s)\b/gi;
  // If the employer itself wrote this token, it is not translation damage.
  if (!brand || new RegExp(corruptBrand.source, 'i').test(source)) return 0;
  if (!isMcDonaldsEmployer(job)) return 0;
  let changed = 0;
  for (const [locale, text] of Object.entries(job.descriptionByLocale || {})) {
    if (locale === job.sourceLang || typeof text !== 'string') continue;
    const repaired = replaceBrandInProse(text, corruptBrand, brand);
    if (repaired !== text) { job.descriptionByLocale[locale] = repaired; changed++; }
  }
  return changed;
}

export function repairJobTranslationSemanticsInPlace(job) {
  return repairJobTitleSemanticsInPlace(job) + repairJobDescriptionBrandsInPlace(job);
}

function isMcDonaldsEmployer(job) {
  let employerHost = '';
  try { employerHost = new URL(job.url).hostname; } catch {}
  return /\bmcdonald[’']?s\b/i.test(String(job.company || ''))
    || employerHost === 'jobs.mcdonalds.ch';
}

function replaceBrandInProse(text, pattern, brand) {
  const protectedRanges = [];
  // Quote-aware tags: a > inside an attribute must not expose href/title text.
  for (const match of text.matchAll(/<(?:[^"'<>]|"[^"]*"|'[^']*')*>|https?:\/\/[^\s<>]+/gi)) {
    protectedRanges.push([match.index, match.index + match[0].length]);
  }
  // Markdown destinations may contain balanced parentheses. Protect only the
  // destination, so a visible link label still gets the source-backed repair.
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== ']' || text[i + 1] !== '(') continue;
    let depth = 1;
    let end = i + 2;
    for (; end < text.length && depth; end++) {
      if (text[end] === '\\') { end++; continue; }
      if (text[end] === '(') depth++;
      if (text[end] === ')') depth--;
    }
    // An incomplete destination remains protected conservatively to the end.
    protectedRanges.push([i + 1, end]);
    i = end - 1;
  }
  return text.replace(pattern, (match, offset) => protectedRanges.some(
    ([start, end]) => offset < end && offset + match.length > start,
  ) ? match : brand);
}
