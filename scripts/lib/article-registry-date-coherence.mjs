/**
 * Keep optional article freshness metadata conservative at the corpus mirror
 * boundary.
 *
 * A date-only `updatedAt` represents a calendar day, not a time. When the
 * publication `date` has a time component later on that same day, the source
 * cannot prove that the update happened after publication. Dropping the
 * ambiguous optional field is safer than inventing a time or emitting a
 * `dateModified` value that can precede `datePublished`.
 */
import {
  findTopLevelStaticObjectLiterals,
  parseStaticSource,
  readStaticObjectProperties,
  readStaticString,
  staticPropertyName,
} from '../../packages/articles/engine/shared/staticSourceAst.mjs';

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/u;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T/u;

function directProperty(properties, name, fileName, id) {
  const matches = properties.filter((property) => staticPropertyName(property.name) === name);
  if (matches.length > 1) {
    throw new Error(
      `[article-registry-date-coherence] ${fileName}: article '${id}' has duplicate ${name} fields`,
    );
  }
  return matches[0] ?? null;
}

function literalValue(property, sourceFile, fileName, id, name) {
  if (!property) return null;
  return readStaticString(property.initializer, sourceFile, {
    label: `${name} for article '${id}'`,
    errorPrefix: `[article-registry-date-coherence] ${fileName}`,
  });
}

function isAmbiguousPrePublicationUpdate(date, updatedAt) {
  if (!TIMESTAMP_RE.test(date) || !DATE_ONLY_RE.test(updatedAt)) return false;
  const publishedMs = Date.parse(date);
  const updateDayMs = Date.parse(`${updatedAt}T00:00:00Z`);
  return Number.isFinite(publishedMs)
    && Number.isFinite(updateDayMs)
    && updateDayMs < publishedMs;
}

function removalRange(source, sourceFile, property) {
  let end = property.end;
  if (source[end] === ',') end += 1;
  return { start: property.getFullStart(), end };
}

/**
 * Remove only date-only `updatedAt` values that are provably before a
 * timestamped publication date.
 *
 * The operation is pure so the corpus sync can apply it to its temporary
 * incoming tree and tests can exercise it without cloning or writing files.
 *
 * @returns {{source: string, removedIds: string[]}}
 */
export function stripAmbiguousPrePublicationUpdates(source, fileName = 'article-registry.ts') {
  const sourceFile = parseStaticSource(source, fileName, {
    errorPrefix: '[article-registry-date-coherence]',
  });
  const removals = [];
  const removedIds = [];

  for (const object of findTopLevelStaticObjectLiterals(sourceFile)) {
    const properties = readStaticObjectProperties(object, `${fileName} article row`);
    const idProperty = directProperty(properties, 'id', fileName, '<unknown>');
    if (!idProperty) continue;
    const id = literalValue(idProperty, sourceFile, fileName, '<unknown>', 'id');
    if (!id) continue;

    const dateProperty = directProperty(properties, 'date', fileName, id);
    const updatedAtProperty = directProperty(properties, 'updatedAt', fileName, id);
    if (!dateProperty || !updatedAtProperty) continue;

    const date = literalValue(dateProperty, sourceFile, fileName, id, 'date');
    const updatedAt = literalValue(updatedAtProperty, sourceFile, fileName, id, 'updatedAt');
    if (!date || !updatedAt || !isAmbiguousPrePublicationUpdate(date, updatedAt)) continue;

    removals.push(removalRange(source, sourceFile, updatedAtProperty));
    removedIds.push(id);
  }

  let normalized = source;
  for (const { start, end } of removals.sort((a, b) => b.start - a.start)) {
    normalized = normalized.slice(0, start) + normalized.slice(end);
  }
  return { source: normalized, removedIds };
}
