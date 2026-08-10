#!/usr/bin/env node
/**
 * validate-translation-completeness.mjs — Deploy gate for 4-locale locale-slot
 * coverage.
 *
 * ── WHAT BLOCKS THE DEPLOY (exit 1) ───────────────────────────────────────
 * Unchanged, byte for byte, by the 2026-08-10 honesty pass:
 *   - `titleByLocale[locale]` shorter than 3 characters
 *   - `descriptionByLocale[locale]` shorter than 120 characters
 *     (for the source locale, `job.description` is accepted as a fallback)
 *   - jobs.json missing/unparseable (exit 1) or absent entirely (exit 2, via
 *     requireDataPath)
 * Nothing else exits non-zero unless `--strict` is passed, and no workflow
 * passes it. This matters: translate-pending.yml gates the deploy TRIGGER on
 * this exit code (line ~395) and post-deploy-validate-dist.yml runs it as a
 * blocking validator (line ~501). There is a real backlog — a run with 26208
 * of 26321 jobs slot-complete had 113 incomplete and 1930 flagged for
 * retranslation — so promoting any new signal to fatal today would stop every
 * deploy.
 *
 * ── WHAT IT REPORTS BUT DOES NOT BLOCK ON (advisory) ──────────────────────
 *   - jobs carrying `needsRetranslation: true` (always counted)
 *   - `--language-audit`: target title slots that do not read as the target
 *     language (opt-in; requires `titleLooksUntranslated`, see the seam below)
 * `--strict` promotes the advisory findings to fatal. It exists so a future PR
 * can turn the screw deliberately, in its own change, with its own measurement.
 *
 * ── S4: this header used to describe behaviour that did not exist ─────────
 * It claimed the script "Flags jobs with needsRetranslation: true". The loop
 * never read the field, so 1930 flagged jobs passed a BLOCKING deploy
 * validator while the summary line said coverage was complete. The documented
 * behaviour is now implemented (`collectRetranslationFlags`) rather than the
 * header being quietly corrected — but implemented as advisory, per above.
 *
 * ── "complete" here has never meant "translated" ──────────────────────────
 * The blocking checks count CHARACTERS. A German title copied verbatim into
 * the `it` slot is 40 characters long and passes. The old success line
 * ("all N jobs have complete 4-locale coverage") is one of the two lines that
 * produced the belief that job translation is at 100%; the other is the
 * `Math.round` in scripts/log-translation-stats.mjs. The wording here now says
 * "locale slots populated" and states, on the same line, that language is not
 * verified.
 *
 * ── Rounding direction ────────────────────────────────────────────────────
 * Problem rates are CEILED here (`formatFlaggedRate`), so a non-zero problem
 * can never print as "0%". Success rates are FLOORED in log-translation-stats
 * (`formatCompleteRatio`), so they can never print as "100%" unless exact.
 * Same reason, opposite direction — do not merge the two helpers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireDataPath, ROOT } from './lib/resolve-data-path.mjs';

export const LOCALES = ['it', 'en', 'de', 'fr'];
export const MIN_TITLE_CHARS = 3;
export const MIN_DESCRIPTION_CHARS = 120;
const SAMPLE_LIMIT = 10;

/**
 * Format a PROBLEM rate so a non-zero count can never print as "0%".
 * Ceils to one decimal; only an exactly-zero count returns `0%`.
 *
 * @param {number} part
 * @param {number} total
 * @returns {string} e.g. `1930/26321 (7.4%)`, `1/26321 (0.1%)`, `0/26321 (0%)`
 */
export function formatFlaggedRate(part, total) {
  if (!Number.isFinite(total) || total <= 0) return `${part}/${total || 0} (n/a)`;
  if (part <= 0) return `0/${total} (0%)`;
  const ceiled = Math.max(Math.ceil((part / total) * 1000) / 10, 0.1);
  return `${part}/${total} (${ceiled.toFixed(1)}%)`;
}

/**
 * The BLOCKING check. This function is the whole of what can exit 1 on job
 * content, and its rules are identical to the pre-2026-08-10 inline loop.
 * Anything added here tightens the deploy gate — do not.
 *
 * @param {object[]} jobs
 * @returns {{slug: string, locale: string, reason: string}[]}
 */
export function collectBlockingIssues(jobs) {
  const issues = [];
  for (const job of jobs) {
    const slug = job.slug || '(unknown)';
    const sourceLang = job.sourceLang || 'it';

    for (const locale of LOCALES) {
      // Title check
      const title = String(job.titleByLocale?.[locale] || '').trim();
      if (title.length < MIN_TITLE_CHARS) {
        issues.push({ slug, locale, reason: `missing/short title (${title.length} chars)` });
      }

      // Description check
      const desc = String(job.descriptionByLocale?.[locale] || '').trim();
      if (desc.length < MIN_DESCRIPTION_CHARS) {
        // For the source language, allow the main description field as fallback
        if (locale === sourceLang) {
          const mainDesc = String(job.description || '').trim();
          if (mainDesc.length < MIN_DESCRIPTION_CHARS) {
            issues.push({ slug, locale, reason: `missing/short description (${desc.length} chars, main: ${mainDesc.length} chars)` });
          }
        } else {
          issues.push({ slug, locale, reason: `missing/short description (${desc.length} chars)` });
        }
      }
    }
  }
  return issues;
}

/**
 * The behaviour the header always claimed and never had (S4). Advisory.
 *
 * @param {object[]} jobs
 * @returns {string[]} slugs of jobs carrying `needsRetranslation: true`
 */
export function collectRetranslationFlags(jobs) {
  const flagged = [];
  for (const job of jobs) {
    if (job?.needsRetranslation) flagged.push(job.slug || '(unknown)');
  }
  return flagged;
}

/* ── SEAM: language verification ──────────────────────────────────────────
 * Everything below is the plug for the ONE missing signal: whether a populated
 * slot is actually in the target language. The check itself is NOT implemented
 * here on purpose — `titleLooksUntranslated` belongs in
 * scripts/lib/job-locale-utils.mjs so there is a single implementation. The
 * repo already carries five hand-rolled weaker variants of this idea; a sixth
 * inside a deploy gate would be the worst place for it.
 *
 * Contract consumed here (implemented in the detector PR):
 *   titleLooksUntranslated({ title, sourceTitle, sourceLang, targetLocale,
 *                            company, location, overlapThreshold })
 *     → { untranslated: boolean, reason: string, overlap: number,
 *         detected: { lang: string, confidence: number } }
 *
 * Activation is opt-in (`--language-audit` / TRANSLATION_LANGUAGE_AUDIT=1) and
 * the result is advisory. Two reasons, both deliberate: the export does not
 * exist yet, and its per-call cost over ~26k jobs × 4 locales has not been
 * measured against this gate's CI budget. Wiring it into the workflows is a
 * follow-up PR, not a side effect of this one.
 */

/**
 * Resolve the detector if it exists. Never throws: a missing export, a renamed
 * module or an import-time error must not be able to take the deploy gate down.
 *
 * @returns {Promise<Function|null>}
 */
export async function loadTitleLanguageCheck() {
  try {
    const mod = await import('./lib/job-locale-utils.mjs');
    return typeof mod.titleLooksUntranslated === 'function' ? mod.titleLooksUntranslated : null;
  } catch {
    return null;
  }
}

/**
 * Run the detector over every non-source locale slot. Advisory output only.
 *
 * @param {object[]} jobs
 * @param {Function} titleLooksUntranslated
 * @returns {{ suspects: {slug: string, locale: string, reason: string, overlap: number|undefined}[], errors: number }}
 */
export function collectLanguageSuspects(jobs, titleLooksUntranslated) {
  const suspects = [];
  let errors = 0;
  if (typeof titleLooksUntranslated !== 'function') return { suspects, errors };

  for (const job of jobs) {
    const sourceLang = job.sourceLang || 'it';
    const sourceTitle = String(job.titleByLocale?.[sourceLang] || job.title || '');
    for (const locale of LOCALES) {
      if (locale === sourceLang) continue;
      const title = String(job.titleByLocale?.[locale] || '').trim();
      if (!title) continue;
      let verdict;
      try {
        verdict = titleLooksUntranslated({
          title,
          sourceTitle,
          sourceLang,
          targetLocale: locale,
          company: job.company || '',
          location: job.location || '',
        });
      } catch {
        errors++;
        continue;
      }
      if (verdict?.untranslated) {
        suspects.push({
          slug: job.slug || '(unknown)',
          locale,
          reason: verdict.reason || 'untranslated',
          overlap: verdict.overlap,
        });
      }
    }
  }
  return { suspects, errors };
}

/**
 * Single entry point for the analysis, so the split between "blocks" and
 * "reports" is visible in one place.
 *
 * @param {object[]} jobs
 * @param {{ languageCheck?: Function|null }} [opts]
 */
export function analyzeJobs(jobs, { languageCheck = null } = {}) {
  const blocking = collectBlockingIssues(jobs);
  const flagged = collectRetranslationFlags(jobs);
  const { suspects, errors } = collectLanguageSuspects(jobs, languageCheck);
  return { blocking, flagged, languageSuspects: suspects, languageErrors: errors };
}

async function main() {
  const argv = process.argv.slice(2);
  const strict = argv.includes('--strict');
  const wantLanguageAudit = argv.includes('--language-audit') ||
    process.env.TRANSLATION_LANGUAGE_AUDIT === '1';

  /* ── Load jobs ── */
  const DATA_JOBS = requireDataPath('jobs.json', 'validate-translation-completeness');
  console.log(`Reading jobs dataset from: ${path.relative(ROOT, DATA_JOBS)}`);

  let jobs;
  try {
    jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  } catch (err) {
    console.error(`❌ Failed to parse jobs.json: ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(jobs) || jobs.length === 0) {
    console.log('✅ Translation completeness: no jobs to validate.');
    process.exit(0);
  }

  /* ── Analyse ── */
  let languageCheck = null;
  if (wantLanguageAudit) {
    languageCheck = await loadTitleLanguageCheck();
    if (!languageCheck) {
      console.log('ℹ️  --language-audit requested but titleLooksUntranslated is not exported by scripts/lib/job-locale-utils.mjs — audit skipped (advisory either way).');
    }
  }
  const { blocking, flagged, languageSuspects, languageErrors } = analyzeJobs(jobs, { languageCheck });

  /* ── Advisory report (always printed, never fatal unless --strict) ── */
  console.log('');
  console.log(`ℹ️  Advisory (does NOT block the deploy${strict ? ', but --strict is on' : ''}):`);
  console.log(`     needsRetranslation: ${formatFlaggedRate(flagged.length, jobs.length)} jobs flagged — a flagged job is NOT translated, it only has its slots filled in.`);
  for (const slug of flagged.slice(0, SAMPLE_LIMIT)) console.log(`       - ${slug}`);
  if (flagged.length > SAMPLE_LIMIT) console.log(`       ... and ${flagged.length - SAMPLE_LIMIT} more`);
  if (languageCheck) {
    console.log(`     wrong-language title slots: ${languageSuspects.length}${languageErrors ? ` (${languageErrors} slots errored and were skipped)` : ''}`);
    for (const s of languageSuspects.slice(0, SAMPLE_LIMIT)) {
      console.log(`       - ${s.slug} [${s.locale}]: ${s.reason}${typeof s.overlap === 'number' ? ` (overlap ${s.overlap.toFixed(2)})` : ''}`);
    }
    if (languageSuspects.length > SAMPLE_LIMIT) console.log(`       ... and ${languageSuspects.length - SAMPLE_LIMIT} more`);
  } else {
    console.log('     wrong-language title slots: not measured (pass --language-audit once the detector lands).');
  }
  console.log('');

  /* ── Blocking report ── */
  if (blocking.length > 0) {
    const uniqueJobs = new Set(blocking.map(i => i.slug));
    console.error(`❌ Translation completeness check FAILED: ${uniqueJobs.size} jobs have incomplete translations (${blocking.length} issues total).`);
    console.error('');
    const sample = blocking.slice(0, SAMPLE_LIMIT);
    for (const { slug, locale, reason } of sample) {
      console.error(`  - ${slug} [${locale}]: ${reason}`);
    }
    if (blocking.length > SAMPLE_LIMIT) {
      console.error(`  ... and ${blocking.length - SAMPLE_LIMIT} more issues`);
    }
    console.error('');
    console.error('Run translate-pending workflow before deploying.');
    process.exit(1);
  }

  if (strict && (flagged.length > 0 || languageSuspects.length > 0)) {
    console.error(`❌ --strict: ${flagged.length} jobs flagged needsRetranslation, ${languageSuspects.length} wrong-language title slots.`);
    process.exit(1);
  }

  // "complete" is deliberately not the word here: this is a presence check.
  if (flagged.length === 0 && languageSuspects.length === 0) {
    console.log(`✅ Translation completeness: all ${jobs.length} jobs have all 4 locale slots populated and none is flagged for retranslation.`);
  } else {
    console.log(`⚠️  Translation completeness: all ${jobs.length} jobs have all 4 locale slots populated, but ${flagged.length} are flagged for retranslation${languageCheck ? ` and ${languageSuspects.length} title slots look untranslated` : ''} — populated is not translated.`);
    console.log('   Deploy gate PASSES (exit 0): these findings are advisory.');
  }
}

// Main-guarded so the pure helpers above can be imported by tests without
// requiring data/jobs.json (which is gitignored and assembled at build time).
const isMainModule = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) await main();
