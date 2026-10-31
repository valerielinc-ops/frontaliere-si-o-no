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

function parseSource(source, fileName) {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function directPropertyValue(objectLiteral, wantedName) {
  if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) return null;
  for (const member of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(member) || propertyName(member.name) !== wantedName) continue;
    const initializer = member.initializer;
    if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
      return initializer.text;
    }
    return null;
  }
  return null;
}

function findPropertyValue(sourceFile, wantedName) {
  let value = null;
  function visit(node) {
    if (value !== null) return;
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === wantedName) {
      const initializer = node.initializer;
      if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
        value = initializer.text;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return value;
}

function valueFromArticleMeta(sourceFile) {
  return findPropertyValue(sourceFile, ARTICLE_KEY);
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

function valueFromSeoRecord(sourceFile, property) {
  const record = seoRecord(sourceFile);
  if (!record) return null;
  if (property === 'structuredData.description') {
    const structuredData = record.properties.find(
      (member) => ts.isPropertyAssignment(member) && propertyName(member.name) === 'structuredData',
    )?.initializer;
    return directPropertyValue(structuredData, 'description');
  }
  return directPropertyValue(record, property);
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

function valueFromRecord(record, property) {
  if (property === 'structuredData.description') {
    const structuredData = record.properties.find(
      (member) => ts.isPropertyAssignment(member) && propertyName(member.name) === 'structuredData',
    )?.initializer;
    return directPropertyValue(structuredData, 'description');
  }
  return directPropertyValue(record, property);
}

function checkIsolatedSectionLabelTail(value, label) {
  const normalized = String(value || '').replace(/\s+/gu, ' ').trim();
  if (!normalized) return [];
  if (!ISOLATED_SECTION_LABEL_TAIL.test(normalized)) return [];
  const token = normalized.split(/\s+/u).at(-1);
  return [`${label}: summary ends with isolated section label "${token}"`];
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
  if (TRUNCATED_ENDINGS.some((pattern) => pattern.test(normalized))) {
    failures.push(`${label}: summary ends with a known truncated fragment`);
  }
  if (!/[.!?]$/u.test(normalized)) {
    failures.push(`${label}: summary does not end with sentence punctuation`);
  }
  return failures;
}

export function validateArticleExcerptFiles(files, { all = false } = {}) {
  const failures = [];
  let checked = 0;

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const sourceFile = parseSource(source, file);
    if (all && path.basename(file).startsWith('blog-meta-')) {
      const entries = parseStaticArticleTranslationEntries(source, file)
        .filter((entry) => entry.field === 'excerpt');
      for (const entry of entries) {
        checked += 1;
        failures.push(...checkIsolatedSectionLabelTail(
          entry.value,
          `${file}:blog.article.${entry.articleId}.excerpt`,
        ));
      }
      continue;
    }
    if (all && path.basename(file).startsWith('seo-blog')) {
      for (const { key, object } of allSeoRecords(sourceFile)) {
        for (const property of ['description', 'ogDescription', 'structuredData.description']) {
          checked += 1;
          failures.push(...checkIsolatedSectionLabelTail(
            valueFromRecord(object, property),
            `${file}:${key}.${property}`,
          ));
        }
      }
      continue;
    }
    if (file.endsWith('seo-blog-ch.ts')) {
      for (const property of ['description', 'ogDescription']) {
        const value = valueFromSeoRecord(sourceFile, property);
        checked += 1;
        failures.push(...checkSummary(value, `${file}:${property}`));
      }
      const structuredValue = valueFromSeoRecord(sourceFile, 'structuredData.description');
      checked += 1;
      failures.push(...checkSummary(structuredValue, `${file}:structuredData.description`));
      continue;
    }

    const value = valueFromArticleMeta(sourceFile);
    checked += 1;
    failures.push(...checkSummary(value, `${file}:${ARTICLE_KEY}`));
  }

  return { checked, failures };
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
