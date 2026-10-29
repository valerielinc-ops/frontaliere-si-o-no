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

import { languageCodesIn, explicitLanguageEntry, hasCompleteLanguageList } from './lib/languageFacts.js';

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
  const found = new Map();
  for (const row of match.matches) {
    if (found.has(row.index)) return { status: 'unverified', gaps: [] };
    found.set(row.index, row);
  }
  const gaps = rows.flatMap((row, index) => {
    if (!DECISIVE.includes(row.importance)) return [];
    const evidence = found.get(index);
    if (row.basis !== 'stated' || !row.quote || row.quoteUnverified || !evidence || evidence.evidenceUnverified
      || evidence.status !== 'met' || !String(evidence.evidence || '').trim()) {
      return [{ index, requirement: row.requirement, importance: row.importance, status: evidence?.status || 'unknown' }];
    }
    return [];
  });
  // A one-language must-have cannot be satisfied by evidence about a different language.
  // Multi-language alternatives and combined clauses remain with the two-pass evaluator.
  for (const [index, row] of rows.entries()) {
    if (!profile || !DECISIVE.includes(row.importance)) continue;
    const codes = languageCodesIn(row.quote || '');
    if (codes.length !== 1) continue;
    const code = codes[0];
    const entry = explicitLanguageEntry(profile, code);
    const remembered = answers[`language_${code}_any_proficiency`];
    const level = String(remembered || entry?.level || '');
    const rank = value => ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].indexOf(String(value).toUpperCase().match(/\b[ABC][12]\b/)?.[0]);
    const requested = rank(row.quote);
    const fluent = /\b(?:fluent|fluente|fließend|fliessend|courant|verhandlungssicher)\b/iu.test(row.quote || '');
    const minimum = requested >= 0 ? requested : fluent ? 4 : -1;
    const knownAbsent = !entry && !remembered && profile.languagesExplicitList === true && hasCompleteLanguageList(profile);
    if (knownAbsent || (!entry && !remembered) || (minimum >= 0 && (rank(level) < minimum))) {
      if (!gaps.some(gap => gap.index === index)) gaps.push({ index, requirement: row.requirement, importance: row.importance, status: knownAbsent ? 'missing' : 'unknown' });
    }
  }
  const notice = fitNoticeOf({ requirements: rows, matches: match.matches, verdict: match.verdict });
  if (gaps.length || notice) {
    return { status: match.verdict === 'poor' ? 'incompatible' : 'clarification_required', gaps, questions: match.questions || [] };
  }
  if (!['strong', 'good'].includes(match.verdict)) return { status: 'unverified', gaps: [] };
  return { status: 'compatible', gaps: [] };
}
