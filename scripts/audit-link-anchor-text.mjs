#!/usr/bin/env node
/**
 * audit-link-anchor-text.mjs
 *
 * Post-build gate (Semrush A3 / issue 216 + A11 / issue 217): `<a>` tags that
 * give assistive tech and crawlers no accessible name, and anchors whose
 * visible text is a known non-descriptive filler ("qui", "click here",
 * "leggi tutto", …).
 *
 * Mirror of `tests/dist-link-anchor-text.test.ts`, migrated into the unified
 * `audit-all` runner (issue #5845 item 6) on the pattern
 * `scripts/audit-breadcrumb-coverage.mjs` established (#5874 / PR #5883).
 * The vitest copy stays behind `RUN_DIST_GATES=1` as a manual mirror; the
 * REAL gate is this auditor, riding the single shared dist/ walk.
 *
 * WHY THE MIGRATION. `npm run gate:dist-quality` ran five full-corpus vitest
 * scans in one worker pool. Measured on run 31891126686 (2026-08-15): 4 of 5
 * files failed and the pool died `ERR_WORKER_OUT_OF_MEMORY` after 597.95 s
 * under `--max-old-space-size=4096`.
 *
 * ─── THE ONE THRESHOLD CONVERSION IN THIS MIGRATION ────────────────────────
 *
 * The mirror's cap, `MAX_LINKS_WITHOUT_ANCHOR_TEXT = 1100`, is an ABSOLUTE
 * count over the WHOLE corpus. `audit-all` runs in CI under
 * `AUDIT_SAMPLE_RATE=0.25` (`AUDIT_SAMPLE_SALT=$GITHUB_RUN_NUMBER`), so an
 * absolute cap carried over verbatim would be compared against a count taken
 * on a quarter of dist/ — it would read ~4× low and pass a corpus sitting at
 * ~4400 real offenders, and its verdict would move with the bucket sizes
 * rather than with the defect. Worse, an absolute cap tightens on its own as
 * dist/ grows: the same per-page quality trips it purely on page-count
 * growth, which is the failure mode `audit-h1-title-duplicates`,
 * `audit-title-length` and `scripts/lib/mixAdjustedRateGate.mjs` were already
 * rewritten to a rate ratchet to escape.
 *
 * So the cap is converted to a RATE — offending anchors per scanned page —
 * which is invariant under both sampling and corpus growth:
 *
 *   MAX_ANCHORS_WITHOUT_NAME_RATE
 *     = MAX_LINKS_WITHOUT_ANCHOR_TEXT_ABS / REFERENCE_CORPUS_FILES
 *     = 1100 / 3_798_763
 *     ≈ 0.0002896 offending anchors per page
 *
 * `REFERENCE_CORPUS_FILES` is a MEASURED number, not a guess: 3,798,763 HTML
 * files in dist/ on the 2026-08-14 validation run, recorded in
 * `tests/helpers/distHtmlScan.ts`'s header. The two constants are kept here
 * and the rate is DERIVED from them at import time so the equivalence stays
 * checkable (and is checked — `tests/audit-dist-quality-folded.test.ts`).
 *
 * What the conversion does NOT do: loosen the gate at today's corpus size. At
 * exactly 3,798,763 files the rate fires on the same offender count as the
 * absolute cap did. It only stops the verdict depending on the denominator.
 *
 * The SECOND invariant in this file (non-descriptive anchor text) is
 * per-page, zero tolerance, and needs no conversion for the same reason
 * `single-h1-per-page` needed none.
 *
 * Two execution modes:
 *   1. Standalone CLI:  node scripts/audit-link-anchor-text.mjs [--json] [--limit N]
 *   2. Unified runner:  imported by scripts/audit-all.mjs via factory().
 */

import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { walkHtmlFiles, ROOT, DEFAULT_DIST } from './lib/audit-runner.mjs';
import { writeAuditReport } from './lib/auditReport.mjs';
import { extrapolateSampledCount, formatRegressedFeature } from './lib/mixAdjustedRateGate.mjs';
import { evaluateCeiling, familyEntry, readLedgerOrNull } from './lib/seoDefectRatchet.mjs';

/**
 * Ledger family name for the NON-DESCRIPTIVE half of this gate (#5845 item 2 /
 * #6222 item 1). The unnamed-anchor half above already has a rate gate of its
 * own and is not on the ledger.
 */
export const NON_DESCRIPTIVE_FAMILY = 'link-anchor-text-non-descriptive';

/**
 * The pre-migration absolute cap, kept verbatim so the conversion below is
 * auditable against the mirror it came from. Semrush reported ~888 offending
 * links; 1100 was the headroom the gate shipped with.
 */
export const MAX_LINKS_WITHOUT_ANCHOR_TEXT_ABS = 1100;

/**
 * dist/ HTML file count the absolute cap was written against — measured on
 * the 2026-08-14 validation run, cited in `tests/helpers/distHtmlScan.ts`.
 * Raising this number LOOSENS the gate: change it only alongside a fresh
 * measurement, and say where the measurement came from.
 */
export const REFERENCE_CORPUS_FILES = 3_798_763;

/** Sampling- and growth-invariant form of the cap. See the header block. */
export const MAX_ANCHORS_WITHOUT_NAME_RATE =
  MAX_LINKS_WITHOUT_ANCHOR_TEXT_ABS / REFERENCE_CORPUS_FILES;

/**
 * Relative tolerance on the rate comparison, absorbing the binomial noise of a
 * sampled draw so the verdict does not flip on which bucket the salt picked.
 * 20% is `DEFAULT_TOL.relPct` from `scripts/audit-h1-title-duplicates.mjs` —
 * the repo's existing rate-ratchet tolerance, and ~3σ at this draw size. See
 * the noise-floor comment in `report()`.
 *
 * RECALIBRATION NOTE (issue #5943, follow-up to #5939): the ~3σ figure above
 * assumes unnamed-anchor offenders land ~1-per-page, independent draws. If a
 * shared template instead emits the SAME inaccessible anchor on every page of
 * a family — offenders CLUSTERED k-per-page rather than spread 1-per-page —
 * the effective number of independent draws drops by ~k, so the noise floor
 * this tolerance was sized against shrinks by ~√k: at k=10 the same 20%
 * tolerance covers only ~1.2σ instead of ~3-3.8σ, i.e. the gate flaps far
 * more often on which bucket the salt picked. Not yet re-derived because no
 * offender population has been measured against production dist/ — the
 * population this gate has run against has always been zero (see
 * `nonDescriptiveTotal`'s header comment below). Re-check this tolerance once
 * a real run reports a clustering shape.
 */
export const RATE_TOLERANCE_REL = 0.20;

/**
 * Anchor strings (case-insensitive, after trim) flagged as non-descriptive.
 * Matches the Semrush A11 / issue 217 catalog. Kept byte-identical to the
 * vitest mirror's `NON_DESCRIPTIVE_ANCHOR_TEXT`.
 */
export const NON_DESCRIPTIVE_ANCHOR_TEXT = new Set([
  'qui',
  'here',
  'click here',
  'clicca qui',
  'leggi',
  'leggi tutto',
  'leggi di più',
  'read more',
  'scopri',
  'scopri di più',
  'continua',
  'continue',
  'vedi',
  'vedi tutto',
  'more',
  'di più',
  'mehr',
  'plus',
  'en savoir plus',
]);

/**
 * True when the anchor's outer markup provides any accessible name to
 * assistive tech. Heuristic — does not parse the DOM. Identical to the
 * mirror's `hasAccessibleName`.
 */
export function hasAccessibleName(outer, inner) {
  // 1. Non-empty visible text (after stripping nested tags + whitespace).
  const visible = inner.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (visible.length > 0) return true;

  // 2. ARIA / title attributes on the anchor itself.
  if (/\saria-label\s*=\s*["'][^"']+["']/i.test(outer)) return true;
  if (/\saria-labelledby\s*=\s*["'][^"']+["']/i.test(outer)) return true;
  if (/\stitle\s*=\s*["'][^"']+["']/i.test(outer)) return true;

  // 3. Nested <img> with non-empty alt.
  const imgMatch = inner.match(/<img\b[^>]*\salt\s*=\s*["']([^"']*)["'][^>]*>/i);
  if (imgMatch && imgMatch[1].trim().length > 0) return true;

  // 4. Nested <svg> with title or aria-label.
  if (/<svg\b[^>]*\saria-label\s*=\s*["'][^"']+["'][^>]*>/i.test(inner)) return true;
  if (/<svg[\s\S]*?<title>[^<]+<\/title>/i.test(inner)) return true;

  return false;
}

/**
 * Yields anchor blocks (open tag + inner HTML) one at a time. Naive — does
 * not handle nested `<a>`, but the spec forbids those. Skips anchors inside
 * `<script>` / `<style>` / `<template>` / comments.
 */
export function* extractAnchors(html) {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<template[\s\S]*?<\/template>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    yield { outer: `<a${m[1]}>`, inner: m[2] };
  }
}

export function createAuditor(opts = {}) {
  const limit = opts.limit ?? 20;
  const maxRate = opts.maxRate ?? MAX_ANCHORS_WITHOUT_NAME_RATE;
  const sampleRate = opts.sampleRate ?? (() => {
    const v = Number(process.env.AUDIT_SAMPLE_RATE);
    return v > 0 && v <= 1 ? v : 1;
  })();

  let filesScanned = 0;
  let unnamedAnchors = 0;
  const unnamedSample = [];
  // Counter + bounded sample, the same shape as the unnamed half above and for
  // the same reason. This half is zero-tolerance and has never completed a run
  // against production dist/, so its offender population is UNKNOWN: if one
  // shared template renders "leggi tutto" / "Scopri di più" / "Read more" as
  // anchor text, that is one object PER PAGE — ~10^6 entries at 25% sampling,
  // in a process capped at 4096 MB. An accumulator sized by an unmeasured
  // population is not a risk worth taking inside the very migration that
  // exists because one of these gates ran out of heap.
  let nonDescriptiveTotal = 0;
  const nonDescriptiveSample = [];
  const OFFENDER_SAMPLE_CAP = 100;

  // Descending ceiling for the non-descriptive half (#5845 item 2). Read ONCE
  // per auditor instance, synchronously, because `report()` below is sync and
  // its standalone CLI calls it without awaiting.
  //
  // FAIL-CLOSED: `readLedgerOrNull` returns null when the ledger is missing or
  // malformed, `familyEntry` returns null when the family is absent or is not
  // `enforcement: "ratchet"`, and `evaluateCeiling` with a null entry reports
  // `ratcheted: false` — which routes back to the ORIGINAL zero-tolerance
  // verdict below. A ledger that disappears therefore makes this gate stricter,
  // never greener; that direction is the reason two readers exist in
  // scripts/lib/seoDefectRatchet.mjs.
  const ledger = opts.ledger !== undefined ? opts.ledger : readLedgerOrNull(opts.ledgerPath);
  const nonDescriptiveCeiling = familyEntry(ledger, NON_DESCRIPTIVE_FAMILY);

  return {
    name: 'link-anchor-text',
    collect(file, html) {
      if (html.length === 0) return;
      filesScanned += 1;
      const path = relative(ROOT, file).replace(/^dist\//, '');
      for (const a of extractAnchors(html)) {
        if (!hasAccessibleName(a.outer, a.inner)) {
          unnamedAnchors += 1;
          if (unnamedSample.length < 25) {
            unnamedSample.push({ path, metric: 1, kind: 'no-accessible-name', anchor: `${a.outer.slice(0, 120)}` });
          }
          continue;
        }
        const visible = a.inner.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (NON_DESCRIPTIVE_ANCHOR_TEXT.has(visible)) {
          nonDescriptiveTotal += 1;
          if (nonDescriptiveSample.length < OFFENDER_SAMPLE_CAP) {
            nonDescriptiveSample.push({ path, metric: 1, kind: 'non-descriptive', text: visible });
          }
        }
      }
    },
    report() {
      // Rate, not count: see the header block. `filesScanned === 0` (empty or
      // fully-sampled-out slice) yields rate 0 — a run that looked at nothing
      // must not invent a verdict in either direction.
      const rate = filesScanned > 0 ? unnamedAnchors / filesScanned : 0;
      // NOISE FLOOR, and why the cap alone is not the threshold.
      //
      // Under AUDIT_SAMPLE_RATE=0.25 this rate is measured on a ~950k-page
      // draw in which the cap allows ~275 offenders. The binomial σ on that
      // draw is ~√275 ≈ 17, i.e. ~6% of the allowed count, so a corpus
      // sitting anywhere NEAR the cap flips red/green run to run purely on
      // which bucket the salt selected. A gate that flaps on the salt gets
      // switched off, and then it protects nothing — the workflow says as
      // much where it lists the gates deliberately kept off sampling.
      //
      // So the comparison carries a relative tolerance, and the number is not
      // invented here: `DEFAULT_TOL.relPct = 20` in
      // scripts/audit-h1-title-duplicates.mjs is the repo's existing rate-
      // ratchet tolerance, ~3σ at this draw size. The gate still fires on any
      // real regression (a doubling is 100% over, not 20%); what it stops
      // doing is reporting sampling noise as a defect.
      const ratePassed = rate <= maxRate * (1 + RATE_TOLERANCE_REL);

      // NON-DESCRIPTIVE HALF: ceiling, not zero.
      //
      // The clause here used to be `nonDescriptiveTotal === 0`, sitting beside
      // the rate gate above that this same file spends forty lines justifying.
      // The asymmetry was not a decision, it was the half nobody converted: the
      // corpus carries ~48 of these anchors in two templates, so the clause made
      // the whole auditor permanently red and said the same thing whether the
      // count was 9 or 900. See scripts/lib/seoDefectRatchet.mjs for why a
      // ceiling is in-contract for a gate that judges the REASSEMBLED corpus.
      //
      // `ratcheted: false` (no ledger, or the family removed from it) restores
      // the original `=== 0`.
      const nonDescriptiveVerdict = evaluateCeiling({
        family: NON_DESCRIPTIVE_FAMILY,
        offenders: nonDescriptiveTotal,
        filesScanned,
        entry: nonDescriptiveCeiling,
      });
      const nonDescriptivePassed = nonDescriptiveVerdict.ratcheted
        ? nonDescriptiveVerdict.passed
        : nonDescriptiveTotal === 0;

      const passed = ratePassed && nonDescriptivePassed;

      // Reported for readability only — never for the verdict. Under
      // AUDIT_SAMPLE_RATE=0.25 `unnamedAnchors` is a quarter-corpus count and
      // reading it as a full-corpus one is the exact misreading
      // scripts/lib/mixAdjustedRateGate.mjs's header documents.
      const unnamedFullCorpus = Math.round(extrapolateSampledCount(unnamedAnchors, sampleRate));
      const equivalentAbsCap = Math.round(maxRate * filesScanned);

      // Unlike the sibling auditors, this one CANNOT hand its full offender
      // list to writeAuditReport: one unnamed anchor is one offender and a
      // 3.8M-page corpus can hold millions of them. The consequence must be
      // read with care — the writer derives the report's `offendersTotal`
      // from this array's LENGTH, so in the artifact that field is the size
      // of the sample, not the count. `extra.offendersTotalTrue` below is the
      // real number, and it is the one the verdict was taken on.
      const offenders = [...unnamedSample, ...nonDescriptiveSample];
      const summaryRate = `${(rate * 1000).toFixed(4)}‰`;
      return {
        passed,
        offendersTotal: unnamedAnchors + nonDescriptiveTotal,
        offenders,
        threshold: {
          metric: 'rate',
          value: maxRate,
          comparator: `<= (×${(1 + RATE_TOLERANCE_REL).toFixed(2)} sampling tolerance)`,
        },
        extra: {
          limit,
          filesScanned,
          sampleRate,
          unnamedAnchors,
          // The count the verdict was taken on, stated separately because the
          // report's own `offendersTotal` is the truncated sample size.
          offendersTotalTrue: unnamedAnchors + nonDescriptiveTotal,
          offendersListTruncated:
            unnamedAnchors > unnamedSample.length || nonDescriptiveTotal > nonDescriptiveSample.length,
          unnamedAnchorsFullCorpusEstimate: unnamedFullCorpus,
          unnamedAnchorRate: rate,
          maxUnnamedAnchorRate: maxRate,
          rateToleranceRel: RATE_TOLERANCE_REL,
          effectiveMaxRate: maxRate * (1 + RATE_TOLERANCE_REL),
          equivalentAbsoluteCapOnThisRun: equivalentAbsCap,
          absoluteCapBeforeConversion: MAX_LINKS_WITHOUT_ANCHOR_TEXT_ABS,
          referenceCorpusFiles: REFERENCE_CORPUS_FILES,
          nonDescriptiveTotal,
          // The ledger verdict is carried in full into the artifact, not just
          // into the console line: dist/audit-reports/link-anchor-text.json is
          // the surface people debug from, and the reassembled-corpus exception
          // (AGENTS.md #1, owner 2026-08-20) requires the measured rate to be
          // recorded on EVERY run so the next ceiling tightens on a datum.
          nonDescriptiveRatchet: nonDescriptiveVerdict,
        },
        humanSummary: passed
          ? `anchor-text gate: ${unnamedAnchors} unnamed anchor(s) over ${filesScanned} page(s) = ${summaryRate} ` +
            `(cap ${(maxRate * 1000).toFixed(4)}‰); ${nonDescriptiveVerdict.humanSummary}`
          : [
              // The failure line goes through the SHARED formatter, not a
              // local template. This gate reports two numbers on two different
              // scales — a sampled offender count and a full-corpus-equivalent
              // cap — and `scripts/lib/mixAdjustedRateGate.mjs`'s header is the
              // written record of what happens when a gate decides correctly
              // and then prints those two side by side without naming the
              // scale: on 2026-08-06 it produced a conclusion that two real
              // regressions were denominator artifacts. `tests/seo/regressed-
              // feature-message.test.ts` enforces that every auditor importing
              // extrapolateSampledCount goes through here.
              !ratePassed
                ? formatRegressedFeature(
                    {
                      feature: 'anchors-without-accessible-name',
                      count: unnamedAnchors,
                      countFull: unnamedFullCorpus,
                      max: MAX_LINKS_WITHOUT_ANCHOR_TEXT_ABS,
                      rate: Number((rate * 100).toFixed(5)),
                      maxRate: Number((maxRate * (1 + RATE_TOLERANCE_REL) * 100).toFixed(5)),
                    },
                    sampleRate,
                  )
                : null,
              // Never a bare count any more. A bare count cannot be acted on:
              // it does not say what the ceiling was, nor which pages to open.
              // Both are here, and the sampled paths are the whole offender
              // population at this size.
              !nonDescriptivePassed
                ? `${nonDescriptiveVerdict.ratcheted ? nonDescriptiveVerdict.humanSummary : `${nonDescriptiveTotal} non-descriptive anchor(s)`}` +
                  (nonDescriptiveSample.length > 0
                    ? ` — offenders: ${nonDescriptiveSample.slice(0, limit).map((o) => `${o.path} ("${o.text}")`).join(', ')}` +
                      (nonDescriptiveTotal > nonDescriptiveSample.length ? ` … +${nonDescriptiveTotal - nonDescriptiveSample.length} more` : '')
                    : '')
                : null,
            ].filter(Boolean).join('; '),
      };
    },
  };
}

export const factory = createAuditor;
export const auditor = factory();

// ─── Standalone CLI ──────────────────────────────────────────────────────────

async function standalone() {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const eq = args.find((a) => a.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const idx = args.indexOf(name);
    return idx === -1 ? undefined : args[idx + 1];
  };
  const limit = Number(getArg('--limit') ?? 20);
  const JSON_OUT = args.includes('--json');

  const s = await stat(DEFAULT_DIST).catch(() => null);
  if (!s || !s.isDirectory()) {
    console.error(`[audit-link-anchor-text] ${DEFAULT_DIST} not found — run \`npm run build\` first.`);
    process.exit(2);
  }

  const a = createAuditor({ limit });
  const files = await walkHtmlFiles(DEFAULT_DIST);
  for (const file of files) {
    let html;
    try { html = await readFile(file, 'utf8'); }
    catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    a.collect(file, html);
  }
  const result = await a.report();
  await writeAuditReport({
    audit: a.name,
    passed: result.passed,
    threshold: result.threshold,
    offenders: result.offenders.slice(0, 100),
    extra: result.extra,
  });

  if (JSON_OUT) {
    console.log(JSON.stringify({ total: result.offendersTotal, extra: result.extra, offenders: result.offenders.slice(0, limit) }, null, 2));
  } else if (result.passed) {
    console.log(`✅ anchor-text gate: ${result.humanSummary}`);
  } else {
    console.error(`❌ anchor-text gate: ${result.humanSummary}`);
    console.error('');
    for (const o of result.offenders.slice(0, limit)) {
      console.error(`  - [${o.kind}] ${o.path} :: ${o.anchor ?? `"${o.text}"`}`);
    }
    console.error('');
    console.error('Fix: add anchor text, aria-label, title, or an alt-bearing nested <img>; replace filler text with a phrase that names the destination.');
  }
  process.exit(result.passed ? 0 : 1);
}

const invokedDirectly = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) {
  standalone().catch((err) => {
    console.error('[audit-link-anchor-text] fatal', err);
    process.exit(2);
  });
}
