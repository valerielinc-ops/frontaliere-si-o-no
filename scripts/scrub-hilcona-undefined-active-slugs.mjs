#!/usr/bin/env node
/**
 * One-shot scrub: repair Hilcona active locale slugs that regressed back to the
 * literal `…-hilcona-undefined` form after PR #852.
 *
 * Why this exists (issues #904 / #905):
 *   PR #852 scrubbed the broken `…-hilcona-undefined` active slugs in
 *   data/jobs/by-crawler/hilcona.json. A later dedicated-crawler re-run
 *   (commit dc9aa095ed "🥗 Auto-update Hilcona jobs") re-derived the non-source
 *   locale slugs and reintroduced `…-hilcona-undefined` into the ACTIVE
 *   slugByLocale.{de,en,fr} slots while demoting the correct slug into
 *   previousSlugsByLocale. The slug-regeneration pass that normally repairs
 *   this skips records whose locale title is byte-identical to the source-lang
 *   title (isLikelyUntranslated guard), so the broken slug stuck.
 *
 *   The broken slug is `slugify(title)-hilcona-undefined` — the legacy crawler
 *   formula with company token frozen to the COMPANY_KEY literal `hilcona` and
 *   the location token resolved to the string "undefined". The correct slug for
 *   each affected slot is `buildSlug(localeTitle, company, location)` — the same
 *   formula regenerate-slugs-by-locale.mjs uses, derived token-for-token from
 *   the record's own fields (the de/it clean sibling slugs already carry the
 *   correct `-<company>-<location>` suffix, proving the reconstruction).
 *
 * What it does, per affected job/locale slot:
 *   1. Rebuild the active slug via buildSlug(titleByLocale[locale], company,
 *      location). Asserts the result no longer contains "undefined".
 *   2. Preserve the broken `…-hilcona-undefined` slug in
 *      previousSlugsByLocale[locale] for 301 bridge coverage (the broken URL
 *      was emitted under every locale prefix — see data/all-known-job-slugs.json).
 *   3. Keep job.slug (master) in sync when the IT slot changes (it never does
 *      here — IT is already clean — but the guard mirrors the pipeline).
 *
 * Idempotent: re-running finds zero `…-undefined` active slugs and is a no-op.
 * Scope: data/jobs/by-crawler/hilcona.json only. Does NOT run AI translation,
 * does NOT touch other crawlers, does NOT mutate titles/descriptions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSlug } from './lib/regenerate-slugs-helpers.mjs';
import { addPreviousSlugForLocale } from './lib/dedicated-crawler-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SLICE_PATH = path.resolve(__dirname, '..', 'data', 'jobs', 'by-crawler', 'hilcona.json');
const LOCALES = ['it', 'en', 'de', 'fr'];
const UNDEFINED_RE = /undefined/;

function main() {
  const data = JSON.parse(fs.readFileSync(SLICE_PATH, 'utf-8'));
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];

  let fixedSlots = 0;
  let fixedJobs = 0;
  const failures = [];

  for (const job of jobs) {
    const sbl = job.slugByLocale || {};
    const tbl = job.titleByLocale || {};
    const company = job.company || '';
    const location = job.location || job.addressLocality || '';

    const badLocales = LOCALES.filter((l) => UNDEFINED_RE.test(String(sbl[l] || '')));
    if (badLocales.length === 0) continue;

    let jobTouched = false;
    for (const locale of badLocales) {
      const brokenSlug = String(sbl[locale]);
      const title = String(tbl[locale] || tbl[job.sourceLang] || '').trim();
      const rebuilt = buildSlug(title, company, location);

      if (!rebuilt || UNDEFINED_RE.test(rebuilt)) {
        failures.push(`${job.id} [${locale}]: could not rebuild a clean slug (title="${title}", company="${company}", location="${location}")`);
        continue;
      }
      if (rebuilt === brokenSlug) continue;

      // Preserve the broken slug for 301 bridge coverage under this locale.
      addPreviousSlugForLocale(job, locale, brokenSlug, 20, 'scrub-hilcona-undefined');

      sbl[locale] = rebuilt;
      job.slugByLocale = sbl;

      // Keep master slug aligned with IT (master serves the IT path).
      if (locale === 'it' && job.slug && job.slug !== rebuilt) {
        addPreviousSlugForLocale(job, 'it', job.slug, 20, 'scrub-hilcona-undefined/master');
        job.slug = rebuilt;
      }

      fixedSlots += 1;
      jobTouched = true;
      console.log(`  ✅ ${job.id} [${locale}] ${brokenSlug} → ${rebuilt}`);
    }
    if (jobTouched) fixedJobs += 1;
  }

  if (failures.length > 0) {
    console.error('\n❌ Unable to repair some slots:');
    for (const f of failures) console.error(`   ${f}`);
    process.exit(1);
  }

  if (fixedSlots === 0) {
    console.log('✅ No active …-undefined Hilcona slugs found — nothing to do (idempotent).');
    return;
  }

  fs.writeFileSync(SLICE_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  console.log(`\n📊 Repaired ${fixedSlots} active slug slot(s) across ${fixedJobs} job(s); broken slugs preserved in previousSlugsByLocale for 301 coverage.`);
}

main();
