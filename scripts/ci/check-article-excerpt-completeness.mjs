#!/usr/bin/env node
/**
 * Check the metadata summaries for the Switzerland–Vietnam article.
 *
 * The article is emitted from five source files: four locale excerpts and
 * the Italian SEO record.  The SEO record repeats its summary in the HTML
 * description, Open Graph description and NewsArticle description, so all
 * three copies are checked together.  This is intentionally a source check:
 * importing the large TypeScript metadata modules would make the observer
 * depend on the application runtime instead of the text that the build
 * plugins consume.
 *
 * Usage:
 *   node scripts/ci/check-article-excerpt-completeness.mjs \
 *     packages/articles/content/blog-meta-ch-de.ts \
 *     packages/articles/content/blog-meta-ch-en.ts \
 *     packages/articles/content/blog-meta-ch-fr.ts \
 *     packages/articles/content/blog-meta-ch-it.ts \
 *     packages/articles/content/seo/seo-blog-ch.ts
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

export const ARTICLE_SLUG = 'svizzera-vietnam-relazioni-2026';
export const REQUIRED_LOCALES = Object.freeze(['de', 'en', 'fr', 'it']);
export const MIN_WORDS = 12;
export const MIN_CHARACTERS = 80;

const META_FILE_RE = /^blog-meta-ch-(de|en|fr|it)\.ts$/u;
const SEO_FILE_NAME = 'seo-blog-ch.ts';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Read a single quoted or double quoted TypeScript literal from one line.
 * A regex that stops at the first quote would misread escaped apostrophes in
 * otherwise valid French/Italian summaries.
 */
export function readStringLiteral(line, start) {
  let index = start;
  while (/\s/u.test(line[index] ?? '')) index += 1;
  const quote = line[index];
  if (quote !== "'" && quote !== '"') return null;

  const contentStart = index + 1;
  for (let cursor = contentStart; cursor < line.length; cursor += 1) {
    if (line[cursor] === '\\') {
      cursor += 1;
      continue;
    }
    if (line[cursor] === quote) {
      return decodeStringLiteral(line.slice(contentStart, cursor));
    }
  }
  return null;
}

function decodeStringLiteral(raw) {
  return raw
    .replace(/\\([\\'"`])/gu, '$1')
    .replace(/\\n/gu, '\n')
    .replace(/\\r/gu, '\r')
    .replace(/\\t/gu, '\t');
}

function propertyPrefix(propertyName) {
  const escaped = escapeRegExp(propertyName);
  return new RegExp(`^\\s*(?:['"])?${escaped}(?:['"])?\\s*:\\s*`, 'u');
}

/**
 * Find a literal property in a source block.  The source files use one
 * property per line, which lets this stay syntax-aware for quotes without
 * evaluating arbitrary TypeScript.
 */
export function findPropertyLiteral(source, propertyName) {
  const prefix = propertyPrefix(propertyName);
  for (const line of String(source).split(/\r?\n/u)) {
    const match = prefix.exec(line);
    if (!match) continue;
    const value = readStringLiteral(line, match[0].length);
    return value === null
      ? { value: null, reason: 'not a complete string literal' }
      : { value, reason: null };
  }
  return { value: null, reason: `missing property ${propertyName}` };
}

function articleMetaKey(locale) {
  return `blog.article.${ARTICLE_SLUG}.excerpt`;
}

function articleSeoBlock(source) {
  const entry = new RegExp(
    `^\\s*['"]blog-${escapeRegExp(ARTICLE_SLUG)}['"]\\s*:\\s*\\{`,
    'mu',
  ).exec(source);
  if (!entry) return null;

  const start = entry.index + entry[0].length;
  const nextEntry = /^\s*['"]blog-[^'"]+['"]\s*:\s*\{/gmu;
  nextEntry.lastIndex = start;
  const next = nextEntry.exec(source);
  return source.slice(start, next?.index ?? source.length);
}

function wordCount(text) {
  return (text.match(/[\p{L}\p{M}\p{N}]+(?:['’\-][\p{L}\p{M}\p{N}]+)*/gu) ?? []).length;
}

/**
 * Return concrete completeness findings for one plain-text summary.
 */
export function summaryFindings(value) {
  const findings = [];
  const normalized = String(value ?? '').replace(/\s+/gu, ' ').trim();

  if (!normalized) findings.push('empty');
  if (/\.\.\.|…/u.test(normalized)) findings.push('contains ellipsis');
  if (/\[[^\]]+\]\([^)]*\)|[`*_#|]/u.test(normalized)) {
    findings.push('contains Markdown');
  }
  if (normalized.length < MIN_CHARACTERS) {
    findings.push(`only ${normalized.length} characters (minimum ${MIN_CHARACTERS})`);
  }
  if (wordCount(normalized) < MIN_WORDS) {
    findings.push(`only ${wordCount(normalized)} words (minimum ${MIN_WORDS})`);
  }
  if (!/[.!?]["'»”’)]?$/u.test(normalized)) {
    findings.push('does not end with sentence punctuation');
  }

  return findings;
}

function addSummary(report, label, value, sourceFile) {
  const findings = summaryFindings(value);
  report.values.push({ label, sourceFile, value, findings });
  if (findings.length) report.errors.push(`${label} (${sourceFile}): ${findings.join('; ')}`);
}

/**
 * Check the five source files named by the follow-up command.
 *
 * @param {string[]} filePaths
 * @returns {{ok: boolean, values: object[], errors: string[]}}
 */
export function checkFiles(filePaths) {
  const report = { ok: false, values: [], errors: [] };
  const metaPaths = new Map();
  const seoPaths = [];

  for (const filePath of filePaths) {
    const fileName = basename(filePath);
    const metaMatch = META_FILE_RE.exec(fileName);
    if (metaMatch) metaPaths.set(metaMatch[1], filePath);
    else if (fileName === SEO_FILE_NAME) seoPaths.push(filePath);
    else report.errors.push(`${filePath}: unexpected input file`);
  }

  for (const locale of REQUIRED_LOCALES) {
    const filePath = metaPaths.get(locale);
    if (!filePath) {
      report.errors.push(`missing locale metadata file blog-meta-ch-${locale}.ts`);
      continue;
    }
    const source = readFileSync(filePath, 'utf8');
    const key = articleMetaKey(locale);
    const result = findPropertyLiteral(source, key);
    if (result.value === null) {
      report.errors.push(`${key} (${filePath}): ${result.reason}`);
      continue;
    }
    addSummary(report, `${locale} excerpt`, result.value, filePath);
  }

  if (seoPaths.length !== 1) {
    report.errors.push(`expected exactly one ${SEO_FILE_NAME}, found ${seoPaths.length}`);
  } else {
    const filePath = seoPaths[0];
    const source = readFileSync(filePath, 'utf8');
    const block = articleSeoBlock(source);
    if (!block) {
      report.errors.push(`${filePath}: missing blog-${ARTICLE_SLUG} SEO entry`);
    } else {
      for (const property of ['description', 'ogDescription']) {
        const result = findPropertyLiteral(block, property);
        if (result.value === null) {
          report.errors.push(`${property} (${filePath}): ${result.reason}`);
        } else {
          addSummary(report, `SEO ${property}`, result.value, filePath);
        }
      }

      const structuredStart = block.indexOf('structuredData');
      const structured = structuredStart === -1 ? '' : block.slice(structuredStart);
      const result = findPropertyLiteral(structured, 'description');
      if (result.value === null) {
        report.errors.push(`structuredData.description (${filePath}): ${result.reason}`);
      } else {
        addSummary(report, 'NewsArticle description', result.value, filePath);
      }
    }
  }

  report.ok = report.errors.length === 0 && report.values.length === 7;
  return report;
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

export function main(filePaths = process.argv.slice(2)) {
  if (filePaths.length !== 5) {
    console.error('Usage: node scripts/ci/check-article-excerpt-completeness.mjs <four blog-meta-ch-*.ts files> seo-blog-ch.ts');
    return 1;
  }

  let report;
  try {
    report = checkFiles(filePaths);
  } catch (error) {
    console.error(`❌ could not read article metadata: ${error.message}`);
    return 1;
  }

  if (!report.ok) {
    console.error(`❌ ${ARTICLE_SLUG}: incomplete excerpt/SEO summary metadata`);
    for (const error of report.errors) console.error(`  - ${error}`);
    return 1;
  }

  console.log(`✅ ${ARTICLE_SLUG}: ${report.values.length} plain-text summary values are complete`);
  return 0;
}

if (isDirectInvocation()) process.exitCode = main();
