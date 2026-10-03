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

const DECISIVE = ['critical', 'high'];
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
