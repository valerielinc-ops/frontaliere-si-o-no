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

function quoted(value) {
  return `'${String(value).replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`;
}

function insertAfterProperty(source, property, value) {
  const propertyStart = property.getStart();
  const lineStart = source.lastIndexOf('\n', propertyStart - 1) + 1;
  const indent = source.slice(lineStart, propertyStart).match(/^[ \t]*/u)?.[0] ?? '';
  const commaEnd = source[property.end] === ',' ? property.end + 1 : property.end;
  const nextMemberStart = source.slice(commaEnd).search(/\S/u);
  const between = nextMemberStart < 0 ? '' : source.slice(commaEnd, commaEnd + nextMemberStart);
  const separator = source[property.end] === ',' ? '' : ',';

  if (/\r?\n/u.test(between)) {
    return {
      offset: commaEnd,
      text: `${separator}\n${indent}updatedAt: ${quoted(value)},`,
    };
  }
  return {
    offset: commaEnd,
    text: `${separator} updatedAt: ${quoted(value)},`,
  };
}

function timestamp(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Project the pinned publisher API's enriched `updatedAt` field onto a mirrored
 * TypeScript registry without changing the publication `date`.
 *
 * API rows absent from this source are ignored: the site may carry explicitly
 * preserved local-only articles. Rows shared by both sides must retain the
 * exact publication date, while freshness may only move forward. An empty publication date is the
 * corpus sentinel for unknown and must match on both sides.
 *
 * @returns {{source: string, updatedIds: string[]}}
 */
export function applyPublishedArticleUpdates(
  source,
  publishedRows,
  fileName = 'article-registry.ts',
) {
  const sourceFile = parseStaticSource(source, fileName, {
    errorPrefix: '[article-registry-date-coherence]',
  });
  if (!Array.isArray(publishedRows)) {
    throw new Error(`[article-registry-date-coherence] ${fileName}: published registry is not an array`);
  }
  const publishedById = new Map();
  for (const row of publishedRows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`[article-registry-date-coherence] ${fileName}: published row is not an object`);
    }
    if (typeof row.id !== 'string' || row.id.length === 0) {
      throw new Error(`[article-registry-date-coherence] ${fileName}: published row has no article id`);
    }
    if (publishedById.has(row.id)) {
      throw new Error(`[article-registry-date-coherence] ${fileName}: duplicate published article '${row.id}'`);
    }
    if (typeof row.date !== 'string' || (row.date !== '' && timestamp(row.date) === null)) {
      throw new Error(`[article-registry-date-coherence] ${fileName}: article '${row.id}' has invalid published date`);
    }
    if (row.updatedAt !== undefined
      && (typeof row.updatedAt !== 'string' || timestamp(row.updatedAt) === null)) {
      throw new Error(`[article-registry-date-coherence] ${fileName}: article '${row.id}' has invalid updatedAt`);
    }
    publishedById.set(row.id, row);
  }

  const edits = [];
  const seenPublishedIds = new Set();
  const updatedIds = [];
  for (const object of findTopLevelStaticObjectLiterals(sourceFile)) {
    const properties = readStaticObjectProperties(object, `${fileName} article row`);
    const idProperty = directProperty(properties, 'id', fileName, '<unknown>');
    if (!idProperty) continue;
    const id = literalValue(idProperty, sourceFile, fileName, '<unknown>', 'id');
    const published = publishedById.get(id);
    if (!published) continue;
    if (seenPublishedIds.has(id)) {
      throw new Error(`[article-registry-date-coherence] ${fileName}: duplicate source article '${id}'`);
    }
    seenPublishedIds.add(id);

    const dateProperty = directProperty(properties, 'date', fileName, id);
    if (!dateProperty) {
      throw new Error(`[article-registry-date-coherence] ${fileName}: article '${id}' has no date`);
    }
    const date = literalValue(dateProperty, sourceFile, fileName, id, 'date');
    if (date !== published.date) {
      throw new Error(
        `[article-registry-date-coherence] ${fileName}: article '${id}' publication date `
        + `${JSON.stringify(date)} disagrees with pinned API ${JSON.stringify(published.date)}`,
      );
    }
    if (published.updatedAt === undefined) continue;

    const updatedAtProperty = directProperty(properties, 'updatedAt', fileName, id);
    const current = literalValue(updatedAtProperty, sourceFile, fileName, id, 'updatedAt');
    if (current === published.updatedAt) continue;
    if (current && timestamp(current) > timestamp(published.updatedAt)) {
      throw new Error(
        `[article-registry-date-coherence] ${fileName}: article '${id}' would regress updatedAt `
        + `from ${current} to ${published.updatedAt}`,
      );
    }

    if (updatedAtProperty) {
      edits.push({
        start: updatedAtProperty.initializer.getStart(sourceFile),
        end: updatedAtProperty.initializer.end,
        text: quoted(published.updatedAt),
      });
    } else {
      const insertion = insertAfterProperty(source, dateProperty, published.updatedAt);
      edits.push({ start: insertion.offset, end: insertion.offset, text: insertion.text });
    }
    updatedIds.push(id);
  }

  const missing = [...publishedById.keys()].filter((id) => !seenPublishedIds.has(id));
  if (missing.length > 0) {
    throw new Error(
      `[article-registry-date-coherence] ${fileName}: ${missing.length} pinned API article(s) `
      + `are absent from the mirrored registry: ${missing.slice(0, 5).join(', ')}`,
    );
  }

  let projected = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    projected = projected.slice(0, edit.start) + edit.text + projected.slice(edit.end);
  }
  return { source: projected, updatedIds };
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
