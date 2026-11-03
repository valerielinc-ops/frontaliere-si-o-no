import fs from 'node:fs';
import path from 'node:path';
import {
  articleExcerptFiles,
  hasKnownTruncatedArticleTail,
  inspectArticleExcerptFiles,
  validateArticleExcerptFiles,
} from '../ci/check-article-excerpt-completeness.mjs';

// A few damaged records stay recoverable; dozens at once suggest the extractor
// or incoming corpus shape changed, so the sync must stop before mirroring.
export const MAX_DAMAGED_ARTICLE_EXCERPT_FIELDS = 25;

const sentenceSegmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('und', { granularity: 'sentence' })
  : null;

function lastCompleteSentence(value) {
  if (typeof value !== 'string' || !sentenceSegmenter) return null;

  const segments = [...sentenceSegmenter.segment(value)];
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    const end = segment.index + segment.segment.length;
    const candidate = value.slice(0, end).trimEnd();
    if (!/[.!?]["'’”»)]*$/u.test(candidate)) continue;
    if (/(?:\.{2,}|…)["'’”»)]*$/u.test(candidate)) continue;
    if (hasKnownTruncatedArticleTail(candidate)) continue;
    return candidate;
  }

  return null;
}

function fieldIdentity(field) {
  return `${field.key}\u0000${field.field}`;
}

function sourceFieldIdentity(field, incomingRoot) {
  return `${path.relative(incomingRoot, field.file)}\u0000${fieldIdentity(field)}`;
}

function slugFor(key) {
  if (key.startsWith('blog.article.')) return key.slice('blog.article.'.length).replace(/\.excerpt$/u, '');
  return key.replace(/^blog-/u, '');
}

function localFallbackIndex(localRoot) {
  const exact = new Map();
  const scoped = new Map();
  const files = fs.existsSync(localRoot) ? articleExcerptFiles(localRoot) : [];
  for (const file of files) {
    let fields;
    try {
      fields = inspectArticleExcerptFiles([file], { all: true }).fields;
    } catch {
      continue;
    }
    const isSeoFile = path.basename(file).startsWith('seo-blog');
    const scope = isSeoFile ? 'seo' : `meta:${path.basename(file)}`;
    for (const field of fields) {
      if (typeof field.value !== 'string' || !field.value.trim()) continue;
      const identity = fieldIdentity(field);
      const exactKey = `${path.relative(localRoot, file)}\u0000${identity}`;
      const scopedKey = `${scope}\u0000${identity}`;
      if (!exact.has(exactKey)) exact.set(exactKey, []);
      if (!scoped.has(scopedKey)) scoped.set(scopedKey, []);
      exact.get(exactKey).push(field.value);
      scoped.get(scopedKey).push(field.value);
    }
  }
  return { exact, scoped };
}

function uniqueNonemptyValue(values) {
  const unique = [...new Set(values || [])].filter((value) => value.trim());
  return unique.length === 1 ? unique[0] : null;
}

function safeLocalFallback(field, incomingRoot, localRoot, localIndex) {
  const relative = path.relative(incomingRoot, field.file);
  const localBase = path.resolve(localRoot);
  const localFile = path.resolve(localBase, relative);
  if (localFile !== localBase && !localFile.startsWith(`${localBase}${path.sep}`)) return null;

  const identity = fieldIdentity(field);
  const exactKey = `${path.relative(localRoot, localFile)}\u0000${identity}`;
  const exactValue = uniqueNonemptyValue(localIndex.exact.get(exactKey));
  if (exactValue !== null) return exactValue;

  const scope = path.basename(field.file).startsWith('seo-blog')
    ? 'seo'
    : `meta:${path.basename(field.file)}`;
  return uniqueNonemptyValue(localIndex.scoped.get(`${scope}\u0000${identity}`));
}

function safeSeoFallback(field, seoFallbacks) {
  const seoKey = field.key.startsWith('blog.article.')
    ? `blog-${slugFor(field.key)}`
    : field.key.startsWith('blog-')
      ? field.key
      : null;
  if (!seoKey) return null;

  const records = seoFallbacks.filter((record) => record.key === seoKey);
  if (records.length !== 1) return null;
  const record = records[0];
  // Follow rssFeeds.mjs: excerpt uses ogDescription, then description; the
  // description property uses structuredData.description before ogDescription.
  const preferredFields = field.key.startsWith('blog.article.')
    ? ['ogDescription', 'description', 'structuredData.description']
    : field.field === 'description'
      ? ['structuredData.description', 'ogDescription']
      : field.field === 'ogDescription'
        ? ['description', 'structuredData.description']
        : ['description', 'ogDescription'];

  for (const candidateField of preferredFields) {
    const candidate = record.fields[candidateField];
    if (
      typeof candidate?.value === 'string'
      && candidate.value.trim()
      && candidate.failures.length === 0
      && candidate.value !== field.value
    ) {
      return { value: candidate.value, strategy: 'seo-description-fallback' };
    }
  }
  if (typeof record.headline === 'string' && record.headline.trim() && record.headline !== field.value) {
    return { value: record.headline, strategy: 'seo-headline-fallback' };
  }
  return null;
}

function applyLiteralReplacements(source, replacements) {
  let result = source;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    if (
      !Number.isInteger(replacement.start)
      || !Number.isInteger(replacement.end)
      || replacement.start < 0
      || replacement.end < replacement.start
      || replacement.end > result.length
    ) {
      throw new Error(`invalid article excerpt source span in ${replacement.file}`);
    }
    result = result.slice(0, replacement.start)
      + JSON.stringify(replacement.value)
      + result.slice(replacement.end);
  }
  return result;
}

export function repairArticleExcerptFiles({
  files,
  incomingRoot,
  localRoot,
  maxDamagedFields = MAX_DAMAGED_ARTICLE_EXCERPT_FIELDS,
}) {
  const inspected = inspectArticleExcerptFiles(files, { all: true });
  const seoFallbacks = inspected.seoFallbacks;
  const damaged = inspected.fields.filter((field) => field.failures.length > 0);
  if (damaged.length > maxDamagedFields) {
    const examples = damaged.map((field) => `${field.key} (${path.relative(incomingRoot, field.file)})`);
    throw new Error(
      `incoming corpus has ${damaged.length} damaged excerpt/SEO fields, exceeding the `
      + `${maxDamagedFields}-field systemic-failure threshold:\n  - ${examples.join('\n  - ')}`,
    );
  }

  const actions = [];
  const replacementsByFile = new Map();
  const localIndex = localFallbackIndex(localRoot);

  for (const field of damaged) {
    const complete = lastCompleteSentence(field.value);
    let value = complete;
    let strategy = 'last-complete-sentence';
    if (value === null) {
      value = safeLocalFallback(field, incomingRoot, localRoot, localIndex);
      strategy = value === null ? 'kept-incomplete-no-local-value' : 'local-value';
    }
    if (value === null) {
      const fallback = safeSeoFallback(field, seoFallbacks);
      value = fallback?.value ?? null;
      strategy = fallback?.strategy ?? 'kept-incomplete-no-local-value';
    }

    if (
      value !== null
      && typeof field.literalStart === 'number'
      && typeof field.literalEnd === 'number'
      && value !== field.value
    ) {
      if (!replacementsByFile.has(field.file)) replacementsByFile.set(field.file, []);
      replacementsByFile.get(field.file).push({
        file: field.file,
        start: field.literalStart,
        end: field.literalEnd,
        value,
      });
    } else if (value !== null && (field.literalStart === null || field.literalEnd === null)) {
      strategy = 'kept-incomplete-no-edit-target';
    }

    actions.push({
      slug: slugFor(field.key),
      file: path.relative(incomingRoot, field.file),
      field: field.field,
      strategy,
      value,
    });
  }

  for (const [file, replacements] of replacementsByFile) {
    const source = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, applyLiteralReplacements(source, replacements), 'utf8');
  }

  const after = inspectArticleExcerptFiles(files, { all: true });
  const beforeIds = inspected.fields.map((field) => sourceFieldIdentity(field, incomingRoot)).sort();
  const afterIds = after.fields.map((field) => sourceFieldIdentity(field, incomingRoot)).sort();
  if (JSON.stringify(beforeIds) !== JSON.stringify(afterIds)) {
    throw new Error('article excerpt repair changed the corpus field inventory');
  }

  const validation = validateArticleExcerptFiles(files, { all: true });
  return {
    checked: inspected.checked,
    damagedFields: damaged.length,
    actions,
    remainingFailures: validation.failures,
  };
}
