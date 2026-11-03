#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parseStaticArticleTranslationEntries } from '../../packages/articles/engine/shared/articleStaticSource.mjs';

export const ARTICLE_KEY = 'blog.article.svizzera-vietnam-relazioni-2026.excerpt';
export const SEO_RECORD_KEY = 'blog-svizzera-vietnam-relazioni-2026';
export const MIN_SUMMARY_LENGTH = 120;

const TRUNCATED_ENDINGS = [
  /Parmelin\s+(?:am|received in|reçu à|ricevuto ad)\s+17\.?$/iu,
  /(?:Statements|Déclarations|Dichiarazioni)$/u,
];

// These are the four locale labels that the article generator can leak when
// an excerpt is cut immediately after the facts-key block. Keep the set
// closed: a generic "last capitalized word" heuristic would reject valid
// editorial copy and make the corpus mirror unsafe to run.
export const ISOLATED_SECTION_LABELS = Object.freeze([
  'Oggetto',
  'Gegenstand',
  'Subject',
  'Objet',
]);

const ISOLATED_SECTION_LABEL_TAIL = new RegExp(
  `(?:^|\\s)(?:${ISOLATED_SECTION_LABELS.map((label) => label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')).join('|')})$`,
  'u',
);

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return null;
}

function lastPropertyInitializer(objectLiteral, wantedName) {
  if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) return null;
  let initializer = null;
  let found = false;
  for (const member of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(member) || propertyName(member.name) !== wantedName) continue;
    initializer = member.initializer;
    found = true;
  }
  return found ? initializer : null;
}

function parseSource(source, fileName) {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function directPropertyEntry(objectLiteral, wantedName) {
  if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) return null;
  let entry = null;
  let found = false;
  // RSS and the page generator resolve duplicate static properties last-write-wins.
  for (const member of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(member) || propertyName(member.name) !== wantedName) continue;
    found = true;
    const initializer = member.initializer;
    if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
      entry = { value: initializer.text, node: initializer };
    } else {
      entry = null;
    }
  }
  return found ? entry : null;
}

function findPropertyEntry(sourceFile, wantedName) {
  let entry = null;
  function visit(node) {
    if (entry !== null) return;
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === wantedName) {
      const initializer = node.initializer;
      if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
        entry = { value: initializer.text, node: initializer };
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return entry;
}

function seoRecord(sourceFile) {
  let record = null;
  function visit(node) {
    if (record !== null) return;
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === SEO_RECORD_KEY) {
      if (ts.isObjectLiteralExpression(node.initializer)) record = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return record;
}

function valueFromSeoRecordEntry(sourceFile, property) {
  const record = seoRecord(sourceFile);
  if (!record) return null;
  if (property === 'structuredData.description') {
    const structuredData = lastPropertyInitializer(record, 'structuredData');
    return directPropertyEntry(structuredData, 'description');
  }
  return directPropertyEntry(record, property);
}

function allSeoRecords(sourceFile) {
  const records = [];
  function visit(node) {
    if (
      ts.isPropertyAssignment(node)
      && /^blog-/u.test(propertyName(node.name) || '')
      && ts.isObjectLiteralExpression(node.initializer)
    ) {
      records.push({ key: propertyName(node.name), object: node.initializer });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return records;
}

function valueFromRecordEntry(record, property) {
  if (property === 'structuredData.description') {
    const structuredData = lastPropertyInitializer(record, 'structuredData');
    return directPropertyEntry(structuredData, 'description');
  }
  return directPropertyEntry(record, property);
}

export function articleExcerptFiles(contentRoot) {
  const metaFiles = fs.readdirSync(contentRoot)
    .filter((name) => /^blog-meta-.*\.ts$/u.test(name))
    .map((name) => path.join(contentRoot, name));
  const seoRoot = path.join(contentRoot, 'seo');
  const seoFiles = fs.existsSync(seoRoot)
    ? fs.readdirSync(seoRoot)
      .filter((name) => /^seo-blog.*\.ts$/u.test(name))
      .map((name) => path.join(seoRoot, name))
    : [];
  return [...metaFiles, ...seoFiles];
}

function checkIsolatedSectionLabelTail(value, label) {
  const normalized = String(value || '').replace(/\s+/gu, ' ').trim();
  if (!normalized) return [];
  if (!ISOLATED_SECTION_LABEL_TAIL.test(normalized)) return [];
  const token = normalized.split(/\s+/u).at(-1);
  return [`${label}: summary ends with isolated section label "${token}"`];
}

function checkKnownTruncatedTail(value, label) {
  const normalized = String(value || '').replace(/\s+/gu, ' ').trim();
  const failures = checkIsolatedSectionLabelTail(normalized, label);
  if (TRUNCATED_ENDINGS.some((pattern) => pattern.test(normalized))) {
    failures.push(`${label}: summary ends with a known truncated fragment`);
  }
  return failures;
}

export function hasKnownTruncatedArticleTail(value) {
  return checkKnownTruncatedTail(value, 'article excerpt').length > 0;
}

function checkSummary(value, label) {
  const normalized = String(value || '').replace(/\s+/gu, ' ').trim();
  const failures = [];
  if (!normalized) failures.push(`${label}: value is missing`);
  if (normalized.length < MIN_SUMMARY_LENGTH) {
    failures.push(`${label}: summary is only ${normalized.length} characters`);
  }
  if (/[.…]{3,}\s*$/u.test(normalized)) {
    failures.push(`${label}: summary ends with an ellipsis`);
  }
  failures.push(...checkKnownTruncatedTail(normalized, label));
  if (!/[.!?]$/u.test(normalized)) {
    failures.push(`${label}: summary does not end with sentence punctuation`);
  }
  return failures;
}

function fieldRecord({ file, key, field, value, node, literalStart, literalEnd, failures }) {
  return {
    file,
    key,
    field,
    value,
    literalStart: node ? node.getStart() : literalStart ?? null,
    literalEnd: node ? node.getEnd() : literalEnd ?? null,
    failures,
  };
}

export function inspectArticleExcerptFiles(files, { all = false } = {}) {
  const fields = [];
  const seoFallbacks = [];
  let checked = 0;
  const addField = (entry) => {
    checked += 1;
    fields.push(fieldRecord(entry));
  };

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const sourceFile = parseSource(source, file);
    if (all && path.basename(file).startsWith('blog-meta-')) {
      const entries = parseStaticArticleTranslationEntries(source, file)
        .filter((entry) => entry.field === 'excerpt');
      for (const entry of entries) {
        const key = `blog.article.${entry.articleId}.${entry.field}`;
        addField({
          file,
          key,
          field: entry.field,
          value: entry.value,
          literalStart: entry.valueStart - 1,
          literalEnd: entry.valueEnd + 1,
          failures: checkKnownTruncatedTail(entry.value, `${file}:${key}`),
        });
      }
      continue;
    }
    if (all && path.basename(file).startsWith('seo-blog')) {
      for (const { key, object } of allSeoRecords(sourceFile)) {
        const recordFields = {};
        for (const property of ['description', 'ogDescription', 'structuredData.description']) {
          const entry = valueFromRecordEntry(object, property);
          const failures = checkKnownTruncatedTail(entry?.value, `${file}:${key}.${property}`);
          recordFields[property] = { value: entry?.value ?? null, failures };
          addField({
            file,
            key,
            field: property,
            value: entry?.value ?? null,
            node: entry?.node,
            failures,
          });
        }
        const headline = valueFromRecordEntry(object, 'headline')?.value ?? null;
        seoFallbacks.push({ file, key, fields: recordFields, headline });
      }
      continue;
    }
    if (file.endsWith('seo-blog-ch.ts')) {
      for (const property of ['description', 'ogDescription']) {
        const entry = valueFromSeoRecordEntry(sourceFile, property);
        addField({
          file,
          key: SEO_RECORD_KEY,
          field: property,
          value: entry?.value ?? null,
          node: entry?.node,
          failures: checkSummary(entry?.value, `${file}:${property}`),
        });
      }
      const structuredEntry = valueFromSeoRecordEntry(sourceFile, 'structuredData.description');
      addField({
        file,
        key: SEO_RECORD_KEY,
        field: 'structuredData.description',
        value: structuredEntry?.value ?? null,
        node: structuredEntry?.node,
        failures: checkSummary(structuredEntry?.value, `${file}:structuredData.description`),
      });
      continue;
    }

    const entry = findPropertyEntry(sourceFile, ARTICLE_KEY);
    addField({
      file,
      key: ARTICLE_KEY,
      field: 'excerpt',
      value: entry?.value ?? null,
      node: entry?.node,
      failures: checkSummary(entry?.value, `${file}:${ARTICLE_KEY}`),
    });
  }

  return { checked, fields, seoFallbacks };
}

export function validateArticleExcerptFiles(files, { all = false } = {}) {
  const inspected = inspectArticleExcerptFiles(files, { all });
  const failures = inspected.fields.flatMap((field) => field.failures);
  return { checked: inspected.checked, failures };
}

function runCli() {
  const all = process.argv.includes('--all');
  const files = process.argv.slice(2).filter((file) => file !== '--all').map((file) => path.resolve(file));
  if (files.length === 0) {
    console.error('Usage: node scripts/ci/check-article-excerpt-completeness.mjs <file>...');
    process.exitCode = 2;
    return;
  }

  const result = validateArticleExcerptFiles(files, { all });
  if (result.failures.length > 0) {
    console.error(result.failures.map((failure) => `❌ ${failure}`).join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(`✅ ${result.checked} article excerpt/SEO summaries are complete`);
}

const invokedDirectly = (() => {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] || '');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runCli();
}
