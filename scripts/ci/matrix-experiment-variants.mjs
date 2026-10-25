#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

export const LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);

export const ALLOWED_ENV_KEYS = Object.freeze([
  'INCREMENTAL_MANIFEST',
  'INCREMENTAL_MANIFEST_VERIFY',
  'JOBS_SEO_REUSE',
  'JOBS_SEO_REUSE_VERIFY',
  'JOBS_SEO_REUSE_VERIFY_SAMPLE',
  'JOBS_SEO_REUSE_PROBE',
  'JOBS_SEO_REUSE_PROBE_RATE',
  'JOBS_SEO_REUSE_PROBE_MIN',
  'JOBS_SEO_REUSE_PROBE_MAX',
  'JOBS_SEO_REUSE_PROBE_PER_STRATUM',
  'POST_WALK_INCREMENTAL',
  'POST_WALK_INCREMENTAL_VERIFY',
  'POST_WALK_TARGETED_WALK',
  'JOBS_SEO_MEM_GC',
  // Investigation-only (#9613): names ONE extra corpus-release retainer so the
  // `[mem] jobsSeoPages: after corpus-release candidate=<name>` line carries
  // its gcFreed. The `retention_probe` input feeds JOBS_SEO_RETENTION_PROBE,
  // whose parser rejects these candidates; a variant is the only channel.
  // Empty/absent keeps the default release plan (see jobsSeoRetentionProbe.ts).
  'JOBS_SEO_GCFREED_PROBE',
  'JOBS_SEO_SAMPLE',
  'BUILD_PROFILE',
  'BUILD_BENCH',
  'BUILD_STOP_AFTER',
  'CPU_PROFILE',
  'FAST_BUILD',
  'SEQUENTIAL_PROFILE',
  'RELATED_SEARCH_CLUSTERS_NO_CACHE',
  'RELATED_SEARCH_POSTINGS_SPARSE',
  // build-plugins/profilePlugin.ts: skip the per-plugin forced GC after a
  // plugin that grew heap/RSS by less than this many MB.
  'PROFILE_GC_MIN_GROWTH_MB',
  // Campagna «durata del deploy»: profilo CPU per fase dei plugin medi
  // (build-plugins/shared/phaseInstrument.ts).
  'PHASE_CPU_PROFILE',
  // Scansione blog-image condivisa col post-walk coordinator (blogImageFold.ts).
  'BLOG_IMAGE_CDN_FOLD',
  // Riduzioni di lavoro dei plugin medi, output identico (midPluginFlags.ts).
  'MID_PLUGINS_FAST',
  // Pool di thread libuv per le I/O asincrone del build (default Node: 4).
  'UV_THREADPOOL_SIZE',
  // Salta border-wait-pages (webcam live): il banco di determinismo lo esclude
  // quando la cattura degli input di replay e' incompleta.
  'SKIP_BORDER_WAIT',
  // A/B del costo delle correzioni di determinismo (=0 ripristina il percorso storico).
  'WRITE_COLLECTOR_CHAIN',
  'POST_WALK_BRIDGES_LAST',
  // Opzioni V8 aggiuntive per `npm run build:ci` (es. --max-semi-space-size=64).
  'BUILD_EXTRA_NODE_OPTIONS',
  // Readdir paralleli nell'enumerazione del post-walk (richiede BLOG_IMAGE_CDN_FOLD=1).
  'POST_WALK_WALK_LANES',
  // Operazioni asincrone in volo per worker del post-walk (default 4).
  'POST_WALK_IN_FLIGHT',
  // Output-neutral jobs SEO CPU flags: per-closeBundle sector-match memo,
  // precompiled orphan-slug parsing.
  'JOBS_SEO_SECTOR_MEMO',
  'JOBS_SEO_SLUG_INFO_FAST',
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

if (process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
