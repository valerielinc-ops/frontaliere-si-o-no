#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ARTICLE_KEY = 'blog.article.svizzera-vietnam-relazioni-2026.excerpt';
export const SEO_RECORD_KEY = 'blog-svizzera-vietnam-relazioni-2026';
export const MIN_SUMMARY_LENGTH = 120;

const TRUNCATED_ENDINGS = [
  /Parmelin\s+(?:am|received in|reçu à|ricevuto ad)\s+17\.?$/iu,
  /(?:Statements|Déclarations|Dichiarazioni)$/u,
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function valueFromLine(source, property) {
  const propertyPattern = `(?:['"]${escapeRegExp(property)}['"]|${escapeRegExp(property)})`;
  const match = source.match(new RegExp(
    `^\\s*${propertyPattern}\\s*:\\s*(['"])(.*?)\\1\\s*,?\\s*$`,
    'mu',
  ));
  return match?.[2] ?? null;
}

function valueFromArticleMeta(source) {
  return valueFromLine(source, ARTICLE_KEY);
}

function valueFromSeoRecord(source, property) {
  const recordPattern = new RegExp(
    `['"]${escapeRegExp(SEO_RECORD_KEY)}['"]\\s*:\\s*\\{([\\s\\S]*?)^  \\},?\\s*$`,
    'mu',
  );
  const record = source.match(recordPattern)?.[1];
  return record ? valueFromLine(record, property) : null;
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

export function validateArticleExcerptFiles(files) {
  const failures = [];
  let checked = 0;

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (file.endsWith('seo-blog-ch.ts')) {
      for (const property of ['description', 'ogDescription']) {
        const value = valueFromSeoRecord(source, property);
        checked += 1;
        failures.push(...checkSummary(value, `${file}:${property}`));
      }
      const structuredValue = valueFromSeoRecord(source, '"description"');
      checked += 1;
      failures.push(...checkSummary(structuredValue, `${file}:structuredData.description`));
      continue;
    }

    const value = valueFromArticleMeta(source);
    checked += 1;
    failures.push(...checkSummary(value, `${file}:${ARTICLE_KEY}`));
  }

  return { checked, failures };
}

function runCli() {
  const files = process.argv.slice(2).map((file) => path.resolve(file));
  if (files.length === 0) {
    console.error('Usage: node scripts/ci/check-article-excerpt-completeness.mjs <file>...');
    process.exitCode = 2;
    return;
  }

  const result = validateArticleExcerptFiles(files);
  if (result.failures.length > 0) {
    console.error(result.failures.map((failure) => `❌ ${failure}`).join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(`✅ ${result.checked} article excerpt/SEO summaries are complete`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
