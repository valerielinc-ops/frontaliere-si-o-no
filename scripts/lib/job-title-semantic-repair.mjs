/** Source-backed correction of known job-title and employer-brand mistranslations.
 * Only known corruptions are rewritten; identities and URLs are never derived here.
 */
const CREW_TITLE = /^crew$/i;
const BAD_CREW = /^(?:United Nations|Nazioni Unite|Vereinte Nationen|Nations Unies|Besatzung)$/i;
const MIGROS_SERVICE_COUNTER_TITLE = /^Verkäufer(?:[*:/]?in)?\s+Metzgerei\s+bedient$/iu;
const MIGROS_KNOWN_BAD_IT_TITLE = 'Assistente vendita servita da macelleria';
const MIGROS_SERVICE_COUNTER_TRANSLATIONS = {
  it: 'Addetto/a alla vendita al banco macelleria',
  en: 'Meat Counter Sales Assistant',
  fr: 'Vendeur·euse au comptoir de boucherie',
};

export function repairJobTitleSemanticsInPlace(job) {
  if (!job || typeof job !== 'object') return 0;
  let changed = repairMigrosServiceCounterTitleInPlace(job);
  // sourceLang describes the body; a borrowed source title may have a different
  // effective language. An original Crew must not be hidden by that locale slot.
  const originalTitle = String(job.title || '').trim();
  const sourceTitle = [originalTitle, ...Object.values(job.titleByLocale || {})]
    .map((value) => String(value || '').trim())
    .find((value) => CREW_TITLE.test(value)) || '';
  if (!CREW_TITLE.test(sourceTitle)) return changed;
  // Require employer evidence, not the translated title itself. A real UN role
  // or an airline's Crew/Besatzung has no restaurant employer anchor.
  if (!isMcDonaldsEmployer(job)) return changed;
  if (BAD_CREW.test(String(job.title || '').trim())) { job.title = sourceTitle; changed++; }
  for (const [locale, title] of Object.entries(job.titleByLocale || {})) {
    if (typeof title !== 'string' || !BAD_CREW.test(title.trim())) continue;
    job.titleByLocale[locale] = sourceTitle;
    changed++;
  }
  return changed;
}

/**
 * "Metzgerei bedient" means a staffed butcher's counter. Require the complete
 * original German title and Migros employer evidence. Fill missing slots,
 * replace source-language copies, and repair the one observed Italian
 * mistranslation; preserve other existing translations, including valid
 * stylistic variants. Qualified source variants (for example "Stv." or a
 * workload suffix) are deliberately left alone so their extra meaning cannot
 * be discarded.
 */
export function repairMigrosServiceCounterTitleInPlace(job) {
  if (!job || typeof job !== 'object') return 0;
  if (!migrosServiceCounterTitleSourceLang(job)) return 0;
  const titleByLocale = job.titleByLocale && typeof job.titleByLocale === 'object'
    ? job.titleByLocale
    : (job.titleByLocale = {});
  const sourceTitle = String(titleByLocale.de ?? job.title ?? '').trim();
  const normalizedSourceTitle = normalizeTitleForMatch(sourceTitle);
  const normalizedKnownBadItTitle = normalizeTitleForMatch(MIGROS_KNOWN_BAD_IT_TITLE);
  let changed = 0;
  for (const [locale, translation] of Object.entries(MIGROS_SERVICE_COUNTER_TRANSLATIONS)) {
    const currentTitle = String(titleByLocale[locale] || '').trim();
    if (currentTitle === translation) continue;
    const normalizedCurrentTitle = normalizeTitleForMatch(currentTitle);
    const isSourceCopy = normalizedCurrentTitle && normalizedCurrentTitle === normalizedSourceTitle;
    const isKnownCorruption = locale === 'it' && normalizedCurrentTitle === normalizedKnownBadItTitle;
    if (normalizedCurrentTitle && !isSourceCopy && !isKnownCorruption) continue;
    titleByLocale[locale] = translation;
    changed++;
  }
  return changed;
}

/**
 * A Migros counter title is German even when `sourceLang` describes a body in
 * another language or is missing. Prefer the populated German locale slot as
 * the source-backed evidence; fall back to the display title only when it is
 * the sole available title field.
 */
export function migrosServiceCounterTitleSourceLang(job) {
  if (!job || typeof job !== 'object') return '';
  // The German slot is the source-backed title even when the display title has
  // already been localized (or otherwise corrupted by a previous pass).
  const sourceTitle = String(job.titleByLocale?.de ?? job.title ?? '').trim();
  if (!sourceTitle || !MIGROS_SERVICE_COUNTER_TITLE.test(sourceTitle)) return '';
  return isMigrosEmployer(job) ? 'de' : '';
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

function isMigrosEmployer(job) {
  let employerHost = '';
  try { employerHost = new URL(job.url).hostname; } catch {}
  return /\bmigros\b/i.test(String(job.company || ''))
    || /(?:^|\.)jobs\.migros\.ch$/i.test(employerHost);
}

function normalizeTitleForMatch(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
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
