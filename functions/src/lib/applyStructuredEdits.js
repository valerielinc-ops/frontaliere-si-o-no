/**
 * Pure deterministic engine for applying structured edits from the Reviewer subagent,
 * ported from the ai-job-search Part A structured edit workflow (MIT).
 *
 * Each edit is an atomic patch:
 *   { file: 'letter' | 'cv', old_string: string, new_string: string, reason: string }
 *
 * Strict safety rules:
 * - old_string must exist in the text.
 * - old_string must be unique in the text (surrounding context required to disambiguate).
 * - new_string must not be identical to old_string.
 * - Rejected edits are recorded with explicit reason rather than failing silently or corrupting text.
 */

/**
 * Counts occurrences of a substring in a string.
 * @param {string} text
 * @param {string} search
 * @returns {number}
 */
export function countOccurrences(text, search) {
  if (!text || !search) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(search, pos)) !== -1) {
    count++;
    pos += search.length;
  }
  return count;
}

/**
 * Applies a list of structured edits to a document text.
 * @param {string} text - current document text
 * @param {Array<{old_string: string, new_string: string, reason?: string, file?: string}>} edits
 * @returns {{
 *   updatedText: string,
 *   applied: Array<{old_string: string, new_string: string, reason: string}>,
 *   rejected: Array<{edit: object, reason: string}>,
 * }}
 */
export function applyStructuredEdits(text, edits) {
  let current = String(text || '');
  const applied = [];
  const rejected = [];

  if (!Array.isArray(edits)) {
    return { updatedText: current, applied, rejected };
  }

  for (const edit of edits) {
    const oldStr = String(edit?.old_string || '');
    const newStr = String(edit?.new_string || '');
    const reason = String(edit?.reason || 'unspecified');

    if (!oldStr) {
      rejected.push({ edit, reason: 'empty_old_string' });
      continue;
    }

    if (oldStr === newStr) {
      rejected.push({ edit, reason: 'identical_replacement' });
      continue;
    }

    const occurrences = countOccurrences(current, oldStr);
    if (occurrences === 0) {
      rejected.push({ edit, reason: 'old_string_not_found' });
      continue;
    }

    if (occurrences > 1) {
      rejected.push({
        edit,
        reason: `ambiguous_match: found ${occurrences} occurrences; needs more surrounding context`,
      });
      continue;
    }

    // Exact single match - apply replacement
    current = current.replace(oldStr, newStr);
    applied.push({
      old_string: oldStr,
      new_string: newStr,
      reason,
    });
  }

  return {
    updatedText: current,
    applied,
    rejected,
  };
}

/**
 * Formats a clean summary report of applied reviewer patches.
 * @param {Array<object>} applied
 * @param {Array<object>} rejected
 * @returns {string}
 */
export function summarizeStructuredEdits(applied, rejected) {
  const lines = [];
  lines.push(`Reviewer Structured Edits: ${applied.length} applied, ${rejected.length} rejected.`);
  if (applied.length) {
    lines.push('\nApplied edits:');
    applied.forEach((item, idx) => {
      lines.push(`  ${idx + 1}. [${item.reason}] "${item.old_string.slice(0, 50)}..." -> "${item.new_string.slice(0, 50)}..."`);
    });
  }
  if (rejected.length) {
    lines.push('\nRejected edits:');
    rejected.forEach((item, idx) => {
      lines.push(`  ${idx + 1}. [${item.reason}] "${String(item.edit?.old_string || '').slice(0, 40)}..."`);
    });
  }
  return lines.join('\n');
}
