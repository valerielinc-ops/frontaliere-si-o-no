/** Keep only the archive fields read by cross-locale reconciliation. */
export function compactExpiredArchiveRowForCrossLocale<T extends Record<string, unknown>>(
  row: T,
): number {
  const retainedFields = new Set(['id', 'slug', 'slugByLocale', 'canton', 'location']);
  let releasedFields = 0;

  for (const key in row) {
    if (!Object.prototype.hasOwnProperty.call(row, key) || retainedFields.has(key)) continue;
    delete row[key];
    releasedFields += 1;
  }

  return releasedFields;
}

/** Release a rendered archive row, retaining only metadata when reconciliation still needs it. */
export function releaseExpiredArchiveRowAfterRender<T extends Record<string, unknown>>(
  rows: Array<T | null>,
  index: number,
  row: T,
  keepForCrossLocale: boolean,
): { kind: 'compacted' | 'removed'; fieldsReleased: number } {
  if (keepForCrossLocale) {
    return {
      kind: 'compacted',
      fieldsReleased: compactExpiredArchiveRowForCrossLocale(row),
    };
  }

  if (rows[index] === row) rows[index] = null;
  return { kind: 'removed', fieldsReleased: 0 };
}
