#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);

export const ALLOWED_ENV_KEYS = Object.freeze([
  'INCREMENTAL_MANIFEST',
  'INCREMENTAL_MANIFEST_VERIFY',
  'JOBS_SEO_REUSE',
  'JOBS_SEO_REUSE_VERIFY',
  'JOBS_SEO_REUSE_VERIFY_SAMPLE',
  'POST_WALK_INCREMENTAL',
  'POST_WALK_INCREMENTAL_VERIFY',
  'POST_WALK_TARGETED_WALK',
  'JOBS_SEO_MEM_GC',
  'JOBS_SEO_SAMPLE',
  'BUILD_PROFILE',
  'BUILD_BENCH',
  'BUILD_STOP_AFTER',
  'CPU_PROFILE',
  'FAST_BUILD',
  'SEQUENTIAL_PROFILE',
  'RELATED_SEARCH_CLUSTERS_NO_CACHE',
]);

const ALLOWED_ENV_KEY_SET = new Set(ALLOWED_ENV_KEYS);
const VARIANT_NAME_RE = /^[a-z0-9-]+$/u;

function fail(message) {
  throw new Error(`matrix-experiment variants: ${message}`);
}

function parseVariantLine(line, lineNumber) {
  const separator = line.indexOf('=');
  if (separator <= 0) {
    fail(`line ${lineNumber} must use name=KEY=VAL,... (received ${JSON.stringify(line)})`);
  }

  const name = line.slice(0, separator).trim();
  if (!VARIANT_NAME_RE.test(name)) {
    fail(`line ${lineNumber} has invalid variant name ${JSON.stringify(name)}; expected [a-z0-9-]+`);
  }

  const assignmentsText = line.slice(separator + 1).trim();
  const env = {};
  if (assignmentsText === '') return { name, env };

  for (const rawAssignment of assignmentsText.split(',')) {
    const assignment = rawAssignment.trim();
    const assignmentSeparator = assignment.indexOf('=');
    if (assignmentSeparator <= 0) {
      fail(`variant ${JSON.stringify(name)} has invalid assignment ${JSON.stringify(assignment)}; expected KEY=VAL`);
    }
    const key = assignment.slice(0, assignmentSeparator).trim();
    const value = assignment.slice(assignmentSeparator + 1).trim();
    if (!ALLOWED_ENV_KEY_SET.has(key)) {
      fail(
        `variant ${JSON.stringify(name)} uses disallowed env key ${JSON.stringify(key)}; `
          + `allowed keys: ${ALLOWED_ENV_KEYS.join(', ')}`,
      );
    }
    if (Object.hasOwn(env, key)) {
      fail(`variant ${JSON.stringify(name)} repeats env key ${JSON.stringify(key)}`);
    }
    env[key] = value;
  }

  return { name, env };
}

export function parseVariants(input = 'base=') {
  const raw = String(input ?? '').trim();
  const source = raw || 'base=';
  const variants = [];
  const names = new Set();

  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const variant = parseVariantLine(line, index + 1);
    if (names.has(variant.name)) {
      fail(`duplicate variant name ${JSON.stringify(variant.name)}`);
    }
    names.add(variant.name);
    variants.push(variant);
  }

  if (variants.length === 0) fail('at least one non-empty variant line is required');
  return variants;
}

export function parseLocales(input = 'it,en,de,fr', allLocales = false) {
  if (allLocales === true || String(allLocales).toLowerCase() === 'true') {
    return [{ locale: 'all', all_locales: true }];
  }

  const wanted = new Set(
    String(input ?? '')
      .split(',')
      .map((locale) => locale.trim().toLowerCase())
      .filter(Boolean),
  );
  const selected = LOCALES.filter((locale) => wanted.has(locale));
  return (selected.length ? selected : LOCALES).map((locale) => ({
    locale,
    all_locales: false,
  }));
}

export function buildMatrix({ locales = 'it,en,de,fr', allLocales = false, variants = 'base=' } = {}) {
  const localeRows = parseLocales(locales, allLocales);
  const variantRows = parseVariants(variants);
  return localeRows.flatMap(({ locale, all_locales }) => variantRows.map(({ name, env }) => ({
    locale,
    variant: name,
    env_json: JSON.stringify(env),
    all_locales,
  })));
}

function main() {
  const matrix = buildMatrix({
    locales: process.env.LOCALES_INPUT ?? 'it,en,de,fr',
    allLocales: process.env.ALL_LOCALES_INPUT ?? false,
    variants: process.env.VARIANTS_INPUT ?? 'base=',
  });
  process.stdout.write(`${JSON.stringify(matrix)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
