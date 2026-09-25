/**
 * Strict pagination evidence for HTML listing crawlers.
 *
 * A short page is not proof of a complete source read when the provider has
 * started returning an earlier page again. Every accepted non-empty page must
 * therefore contain stable row identities that are unique within the page and
 * disjoint from all previously accepted pages.
 */

function normalizeRowKey(value) {
  return String(value ?? '').trim();
}

export function createListingPaginationIntegrity({ getRowKey }) {
  if (typeof getRowKey !== 'function') {
    throw new TypeError('createListingPaginationIntegrity: getRowKey must be a function');
  }

  const seenRowKeys = new Set();
  const seenPageKeys = new Set();
  let proven = true;

  return {
    observe(rows) {
      const pageRows = Array.isArray(rows) ? rows : [];
      if (!proven) {
        return { accepted: false, reason: 'previous_page_failed' };
      }
      if (pageRows.length === 0) {
        return { accepted: true, empty: true };
      }

      const rowKeys = pageRows.map((row) => normalizeRowKey(getRowKey(row)));
      const hasAllRowKeys = rowKeys.every(Boolean);
      const hasDuplicateRowKeys = new Set(rowKeys).size !== rowKeys.length;
      const pageKey = hasAllRowKeys ? [...rowKeys].sort().join('\u001f') : '';
      const repeatsPage = Boolean(pageKey && seenPageKeys.has(pageKey));
      const overlapsPreviousPage = rowKeys.some((key) => seenRowKeys.has(key));

      if (!hasAllRowKeys || hasDuplicateRowKeys || repeatsPage || overlapsPreviousPage) {
        proven = false;
        return {
          accepted: false,
          reason: !hasAllRowKeys
            ? 'missing_row_key'
            : hasDuplicateRowKeys
              ? 'duplicate_row_key'
              : repeatsPage
                ? 'repeated_page'
                : 'overlapping_page',
        };
      }

      seenPageKeys.add(pageKey);
      for (const key of rowKeys) seenRowKeys.add(key);
      return { accepted: true, empty: false, rowsSeen: seenRowKeys.size };
    },

    get proven() {
      return proven;
    },
  };
}
