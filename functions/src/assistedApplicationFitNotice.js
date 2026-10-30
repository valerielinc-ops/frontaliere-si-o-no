/**
 * What the candidate is told when the profile is not a full match of the
 * posting (owner decision 2026-10-03).
 *
 * Until then a verdict «poor» stopped the draft at the owner (`knock_out`),
 * who had to tick "send anyway" before the candidate saw anything. Now the
 * draft goes on like any other, and the review page says — above the
 * questions — which of the posting's own requirements the CV does not show:
 * the candidate answers, adds what the CV left out, or sends knowing it.
 *
 * Only the requirements the posting itself makes decisive (importance
 * `critical` or `high`, fixed before the CV was read) that the match found
 * `missing` or `partial`. Never the operator's summary, the verdict's word or
 * the fact warnings.
 */

import { languageCodesIn, explicitLanguageEntry, hasCompleteLanguageList, isLanguageAbilityQuestion, isLanguageNameOnly } from './lib/languageFacts.js';

export const DECISIVE_REQUIREMENT_IMPORTANCES = ['critical', 'high'];
const DECISIVE = DECISIVE_REQUIREMENT_IMPORTANCES;
const OPEN = ['missing', 'partial'];
export const MAX_FIT_GAPS = 6;

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * @param {object|null} draft the AI draft (requirements, matches, verdict)
 * @returns {{level:'low'|'partial', gaps:Array<{requirement:string, quote:string, importance:string, status:string}>}|null}
 *   `low`: a must-have is clearly missing (verdict «poor»); `partial`: the
 *   rest; null when every decisive requirement is met.
 */
export function fitNoticeOf(draft) {
  const found = new Map((draft?.matches || []).map((match) => [match.index, match.status]));
  const gaps = (draft?.requirements || [])
    .map((item, index) => ({ index, importance: item?.importance, status: found.get(index), requirement: text(item?.requirement, 200), quote: text(item?.quote, 300) }))
    .filter((item) => DECISIVE.includes(item.importance) && OPEN.includes(item.status) && (item.requirement || item.quote))
    // The must-haves first, what is missing before what is partly there, then the posting's own order.
    .sort((a, b) => DECISIVE.indexOf(a.importance) - DECISIVE.indexOf(b.importance) || OPEN.indexOf(a.status) - OPEN.indexOf(b.status) || a.index - b.index)
    .slice(0, MAX_FIT_GAPS)
    .map(({ requirement, quote, importance, status }) => ({ requirement, quote, importance, status }));
  const low = draft?.verdict === 'poor';
  if (!gaps.length && !low) return null;
  return { level: low ? 'low' : 'partial', gaps };
}

/**
 * How the notice reads, in the review e-mail and on the page alike (close-out
 * of 2026-10-03). `far`: a verdict «poor» with no decisive requirement to
 * list, so the words promise no list. `via`: where the candidate adds what
 * the CV leaves out — the answers when the page asks questions, otherwise the
 * letter («Modifica») or a new version («Chiedi modifiche»), which candidate
 * review offers; null when the page offers neither.
 * @param {{level:'low'|'partial', gaps?:Array<object>}|null} fit fitNoticeOf's result
 * @param {{questions?:boolean, edit?:boolean}} page what the page shows
 * @returns {{kind:'low'|'partial'|'far', via:'answers'|'edit'|null}|null}
 */
export function fitNoticeWording(fit, { questions = false, edit = true } = {}) {
  if (!fit) return null;
  const kind = fit.level === 'low' && !(fit.gaps || []).length ? 'far' : fit.level;
  return { kind, via: questions ? 'answers' : edit ? 'edit' : null };
}


/** The proposal funnel uses the same decisive rows as review, and requires verified positive evidence. */
export function conciergeProposalEligibility(requirements, match, { profile = null, answers = {} } = {}) {
  const rows = Array.isArray(requirements?.requirements) ? requirements.requirements : [];
  if (!rows.length || !Array.isArray(match?.matches)) return { status: 'unverified', gaps: [] };
  // The separate language list must not bypass the numbered, evidence-checked
  // requirements. An omitted clause is incomplete extraction, not a candidate gap.
  if ((requirements?.languageRequirements || []).some(language => {
    const quote = text(language?.quote, 300).toLocaleLowerCase();
    return !quote || !rows.some(row => row.basis === 'stated' && !row.quoteUnverified
      && text(row.quote, 400).toLocaleLowerCase().includes(quote));
  })) return { status: 'unverified', reason: 'requirements_incomplete', gaps: [] };
  const found = new Map();
  for (const row of match.matches) {
    if (found.has(row.index)) return { status: 'unverified', gaps: [] };
    found.set(row.index, row);
  }
  // Bad citations and omitted rows are technical failures of the analysis,
  // not missing candidate qualifications to cache or ask the person about.
  if (rows.some((row, index) => {
    if (!DECISIVE.includes(row.importance)) return false;
    const evidence = found.get(index);
    return row.basis !== 'stated' || !row.quote || row.quoteUnverified || !evidence
      || evidence.evidenceUnverified || (evidence.status === 'met' && !String(evidence.evidence || '').trim());
  })) return { status: 'unverified', reason: 'evidence_incomplete', gaps: [] };
  const gaps = rows.flatMap((row, index) => {
    if (!DECISIVE.includes(row.importance)) return [];
    const evidence = found.get(index);
    if (row.basis !== 'stated' || !row.quote || row.quoteUnverified || !evidence || evidence.evidenceUnverified
      || evidence.status !== 'met' || !String(evidence.evidence || '').trim()) {
      return [{ index, requirement: row.requirement, importance: row.importance, status: evidence?.status || 'unknown' }];
    }
    return [];
  });
  // A language must-have cannot be satisfied by evidence about another language.
  for (const [index, row] of rows.entries()) {
    const listedLanguages = (requirements?.languageRequirements || []).filter(language => language.quote && text(row.quote, 400).toLocaleLowerCase().includes(text(language.quote, 300).toLocaleLowerCase()));
    if (!DECISIVE.includes(row.importance) || (!listedLanguages.length && !isLanguageAbilityQuestion(row.quote))) continue;
    const codes = [...new Set([...languageCodesIn(row.quote || ''), ...listedLanguages.flatMap(language => languageCodesIn(language.language))])];
    const rank = value => {
      const label = String(value);
      const cefr = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].indexOf(label.toUpperCase().match(/\b[ABC][12]\b/)?.[0]);
      if (cefr >= 0) return cefr;
      if (/\b(?:native|mother tongue|madrelingua|muttersprache|muttersprachlich(?:e|en|er|es|em)?|langue maternelle)\b/iu.test(label)) return 5;
      return /\b(?:fluent|fluente|fluenti|(?:fließend|fliessend|verhandlungssicher)(?:e|en|er|es|em)?|courant(?:e|es|s)?)\b/iu.test(label) ? 4 : -1;
    };
    const minimum = rank(row.quote);
    if (codes.length > 1) {
      const names = [...String(row.quote).matchAll(/\p{L}+/gu)].filter(word => isLanguageNameOnly(word[0]));
      const bridges = names.slice(1).map((word, position) => row.quote.slice(names[position].index + names[position][0].length, word.index).trim());
      const alternative = bridges.length > 0 && bridges.every(bridge => /^(?:or|oder|ou|o)$/iu.test(bridge));
      const conjunction = bridges.length > 0 && bridges.every(bridge => /^(?:and|und|et|e|&)$/iu.test(bridge));
      const levelWords = [...String(row.quote).matchAll(/\b(?:[ABC][12]|native|mother tongue|madrelingua|muttersprache|muttersprachlich(?:e|en|er|es|em)?|langue maternelle|fluent|fluente|fluenti|(?:fließend|fliessend|verhandlungssicher)(?:e|en|er|es|em)?|courant(?:e|es|s)?)\b/giu)];
      const levels = new Set(levelWords.map(word => rank(word[0])));
      // A shared level must sit outside a directly joined language list.
      // "German C1 and basic English" does not establish one shared minimum.
      const sharedLevel = names.length === codes.length && levelWords.length > 0
        && (levelWords.every(word => word.index + word[0].length <= names[0].index)
          || levelWords.every(word => word.index >= names.at(-1).index + names.at(-1)[0].length));
      // Mixed clauses, different per-language levels and unspecified levels
      // need a complete analysis, never a guess from one positive language.
      if (!profile || minimum < 0 || levels.size > 1 || !sharedLevel || alternative === conjunction) {
        return { status: 'unverified', reason: 'language_clause_unverified', gaps: [] };
      }
      const states = codes.map(code => {
        const entry = explicitLanguageEntry(profile, code);
        const remembered = answers[`language_${code}_any_proficiency`];
        const level = rank(remembered || entry?.level || '');
        const absent = !entry && !remembered && profile.languagesExplicitList === true && hasCompleteLanguageList(profile);
        return { met: level >= minimum, knownMissing: absent || (level >= 0 && level < minimum) };
      });
      if (alternative ? states.some(state => state.met) : states.every(state => state.met)) continue;
      const knownMissing = alternative ? states.every(state => state.knownMissing) : states.some(state => state.knownMissing);
      const existing = gaps.find(gap => gap.index === index);
      if (existing) existing.knownMissing = knownMissing;
      else gaps.push({ index, requirement: row.requirement, importance: row.importance, status: 'unknown', knownMissing });
      continue;
    }
    if (!profile || codes.length !== 1) continue;
    const code = codes[0];
    const entry = explicitLanguageEntry(profile, code);
    const remembered = answers[`language_${code}_any_proficiency`];
    const level = String(remembered || entry?.level || '');
    if (minimum < 0 && !/(?:knowledge|proficien|kenntnis|conoscenz|maîtrise|parlato|written|spoken)/iu.test(row.quote || '')) continue;
    const knownAbsent = !entry && !remembered && profile.languagesExplicitList === true && hasCompleteLanguageList(profile);
    if (knownAbsent || (!entry && !remembered) || (minimum >= 0 && (rank(level) < minimum))) {
      const knownMissing = knownAbsent || (minimum >= 0 && rank(level) >= 0 && rank(level) < minimum);
      const existing = gaps.find(gap => gap.index === index);
      if (existing) existing.knownMissing = knownMissing;
      else gaps.push({ index, requirement: row.requirement, importance: row.importance, status: knownAbsent ? 'missing' : 'unknown', knownMissing });
    } else if (minimum < 0 && found.get(index)?.status === 'met') {
      const evidenceCodes = languageCodesIn(found.get(index)?.evidence || '');
      if (evidenceCodes.length && !evidenceCodes.includes(code)) return { status: 'unverified', reason: 'evidence_incomplete', gaps: [] };
    }
  }
  const notice = fitNoticeOf({ requirements: rows, matches: match.matches, verdict: match.verdict });
  if (gaps.length || notice) {
    return { status: match.verdict === 'poor' || gaps.some(gap => gap.knownMissing) ? 'incompatible' : 'clarification_required', gaps, questions: match.questions || [] };
  }
  if (!['strong', 'good'].includes(match.verdict)) return { status: 'unverified', gaps: [] };
  return { status: 'compatible', gaps: [] };
}
