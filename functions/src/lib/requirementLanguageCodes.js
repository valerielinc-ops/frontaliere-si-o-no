/** The numbered requirement and its source-verified language sidecar share one interpretation. */
import { languageCodeOf, languageCodesIn } from './languageFacts.js';
const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max).toLocaleLowerCase();

export function listedRequirementLanguages(requirements, row) {
  if (row?.basis !== 'stated' || row.quoteUnverified || !row.quote) return [];
  return (requirements?.languageRequirements || []).filter(language => language.quote
    && text(row.quote, 400).includes(text(language.quote, 300)));
}

export function requirementLanguageCodes(requirements, row) {
  return [...new Set([...languageCodesIn(row?.quote || row?.requirement || ''),
    ...listedRequirementLanguages(requirements, row).flatMap(({ language }) => {
      const code = languageCodeOf(language);
      return code ? [code] : languageCodesIn(language);
    })])];
}
