#!/usr/bin/env node
/**
 * audit-duplicate-meta-description.mjs
 *
 * Post-build gate (Semrush E6 / issue 6): no `<meta name="description">`
 * string may be shared by more than `MAX_DUPLICATE_PAGES_PER_DESCRIPTION`
 * URLs. The recurring offender is a plugin fallback ("Calcolatore stipendio…")
 * emitted verbatim on a whole family of pages.
 *
 * Mirror of `tests/dist-duplicate-meta-description.test.ts`, migrated into the
 * unified `audit-all` runner (issue #5845 item 6) on the pattern
 * `scripts/audit-breadcrumb-coverage.mjs` established (#5874 / PR #5883).
 * The vitest copy stays behind `RUN_DIST_GATES=1` as a manual mirror; the
 * REAL gate is this auditor, riding the single shared dist/ walk.
 *
 * WHY THE MIGRATION. `npm run gate:dist-quality` ran five full-corpus vitest
 * scans in one worker pool. Measured on run 31891126686 (2026-08-15): 4 of 5
 * files failed and the pool died `ERR_WORKER_OUT_OF_MEMORY` after 597.95 s.
 *
 * ─── THE SAMPLING SEMANTICS, DECLARED ──────────────────────────────────────
 *
 * This is the one invariant of the four that is CUMULATIVE: its subject is a
 * GROUP of pages sharing a string, not a page. Under CI's
 * `AUDIT_SAMPLE_RATE=0.25` a group of 8 real pages shows up as ~2 sampled
 * ones, so the threshold cannot be carried over naively and cannot be
 * converted to a rate either — "descriptions duplicated per page scanned" is
 * not a quantity anyone can act on, and scaling the group threshold down
 * (`ceil(2 × 0.25)` = 1) would fail every page that merely HAS a description.
 *
 * What is done instead, and what it costs, stated plainly:
 *
 *   The threshold stays 2, applied to group sizes WITHIN THE SCANNED SET.
 *   A group of >2 pages in the sample is a group of >2 pages in dist/ (the
 *   sample is a subset), so the gate NEVER fires on a duplication that does
 *   not exist: no false positives, ever, at any sample rate.
 *   What it loses is RECALL: a group of 3-8 pages split across buckets may go
 *   unseen in a given run. The salt rotation does not fully repair that —
 *   buckets are disjoint, so a group is only ever seen through one bucket at
 *   a time. Concretely at rate 0.25 the gate reliably catches the wide
 *   fallback families it exists for (a 14-page family shows ~3-4 sampled) and
 *   under-reports the narrow ones near the threshold.
 *
 * That is the same direction of error every sampled gate in this runner
 * already accepts — under-report, never over-report — and it is stated in the
 * report `extra` (`samplingSemantics`) so nobody reads a green run as proof
 * the corpus is clean.
 *
 * Two execution modes:
 *   1. Standalone CLI:  node scripts/audit-duplicate-meta-description.mjs [--json] [--limit N]
 *   2. Unified runner:  imported by scripts/audit-all.mjs via factory().
 */

import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { walkHtmlFiles, ROOT, DEFAULT_DIST, sharedExtract } from './lib/audit-runner.mjs';
import { writeAuditReport } from './lib/auditReport.mjs';
import { extractMetaDescriptionRaw } from './lib/meta-description-extract.mjs';
import { evaluateCeiling, familyEntry, readLedgerOrNull } from './lib/seoDefectRatchet.mjs';

export const MAX_DUPLICATE_PAGES_PER_DESCRIPTION = 2;

/** Ledger family name (#6222 item 1). See scripts/lib/seoDefectRatchet.mjs. */
export const DUPLICATE_META_FAMILY = 'duplicate-meta-description';

/**
 * RECALIBRATION NOTE (issue #5943, follow-up to #5939 which introduced the
 * sampling semantics documented in the header above): the per-run recall
 * loss described there ("a group of 3-8 pages split across buckets may go
 * unseen in a given run") understates the effect for the NARROW end of that
 * range, because bucket membership is DETERMINISTIC on file path
 * (`scripts/lib/audit-runner.mjs::sampleFiles` hashes the path), not
 * re-rolled per run — a given page falls in the same bucket on every run,
 * forever, until the salt (`AUDIT_SAMPLE_SALT`) itself changes. Flagging a
 * group requires `count > maxPages` WITHIN one active bucket, i.e. for a
 * 3-page group, all 3 pages must share a bucket. Whether they do is decided
 * ONCE per salt, by where their paths hash to — not re-drawn per run. So a
 * 3-page group is either detectable under the CURRENT salt (all 3 share a
 * bucket) or blind under it (split across ≥2 buckets) — never a fresh
 * per-run coin flip. At `AUDIT_SAMPLE_RATE=0.25` (4 buckets) the fraction of
 * 3-page groups that land in the detectable case is `rate^(n-1) = 0.25² ≈
 * 6%`; the other ~94% stay invisible to this gate for as long as the salt
 * does not rotate them into the same bucket. This is the accepted design
 * trade-off restated, not a bug: the gate exists to catch WIDE fallback
 * families (a 14-page group only needs 3 of its pages to share a bucket,
 * which is far likelier), and narrow near-threshold groups were already the
 * stated cost. Recorded here, next to the threshold, so the next reader does
 * not have to re-derive why a green run on a narrow duplicate can stay green
 * for many runs in a row.
 */

/**
 * Description prefixes duplicated BY DESIGN (404 / soft-404 stubs share one
 * noindex description). Kept byte-identical to the vitest mirror's
 * `ALLOWLIST_PREFIXES`.
 */
export const ALLOWLIST_PREFIXES = Object.freeze([
  'Pagina non trovata',
  'Page not found',
  'Seite nicht gefunden',
  'Page introuvable',
]);

export function createAuditor(opts = {}) {
  const limit = opts.limit ?? 20;
  const maxPages = opts.maxPagesPerDescription ?? MAX_DUPLICATE_PAGES_PER_DESCRIPTION;
  const sampleRate = opts.sampleRate ?? (() => {
    const v = Number(process.env.AUDIT_SAMPLE_RATE);
    return v > 0 && v <= 1 ? v : 1;
  })();

  /**
   * hash(description) → { count, paths, sample }.
   *
   * KEYED BY HASH, NOT BY THE DESCRIPTION. This auditor shares ONE Node
   * process (and one `--max-old-space-size=4096`) with sixteen other
   * accumulating auditors, and its entry count is inherently the number of
   * DISTINCT descriptions — near-unique on job and article pages, so ~950k
   * entries on a 25% sample of a 3.8M-file corpus. Retaining the full
   * description string as the key made each of those entries carry its own
   * 150-300 char string: hundreds of MB of live heap, the same accumulator
   * shape as the OOM this migration exists to fix, only divided by four.
   * `scripts/audit-content-duplicates.mjs` hit this first and stores a
   * `sha256` for the same reason.
   *
   * What is bounded here and what is NOT, stated so the next reader does not
   * have to re-derive it: per-entry size IS bounded (a 16-char key, a counter,
   * ≤5 paths, a ≤100-char sample); the NUMBER of entries is not — it is the
   * distinct-description count, and no single-pass duplicate detector can
   * avoid that. `PATHS_PER_DESCRIPTION_CAP` bounds only the path list, which
   * was never the dominant term.
   *
   * The `sample` string is deferred to the SECOND occurrence (issue #5943): a
   * description seen once can never become an offender (`count > maxPages`,
   * and `maxPages` starts at 2), yet it was the majority shape of this Map —
   * near-unique descriptions on job/article pages mean most entries never see
   * a second occurrence. Not allocating the 100-char sample for those removes
   * the new dominant term the fold's own review measured at ~950k entries ×
   * ~400-600 B ≈ 0.4-0.6 GB on a 25% sample — inside the 4096 MB budget, but
   * the largest single accumulator left once the OOM-causing ones (see the
   * sibling fold auditors) were capped.
   */
  // Descending ceiling (#6222 item 1). Read once, synchronously — `report()`
  // below is sync. FAIL-CLOSED in the same direction as
  // scripts/audit-link-anchor-text.mjs: a missing or malformed ledger yields a
  // null entry, `evaluateCeiling` reports `ratcheted: false`, and the verdict
  // falls back to the original `offenders.length === 0`. Losing the ledger
  // tightens this gate; it can never loosen it.
  const ledger = opts.ledger !== undefined ? opts.ledger : readLedgerOrNull(opts.ledgerPath);
  const ceilingEntry = familyEntry(ledger, DUPLICATE_META_FAMILY);

  const byDescription = new Map();
  const PATHS_PER_DESCRIPTION_CAP = 5;
  const DESCRIPTION_SAMPLE_CHARS = 100;
  let filesScanned = 0;

  /**
   * Return a string with the SAME CONTENT and no reference to whatever it was
   * sliced out of.
   *
   * V8 represents `big.slice(a, b)` as a SlicedString: a pointer to the parent
   * plus an offset. Keeping the 100-char sample therefore keeps the whole page
   * it came from alive. This was known — the line here used to be
   * `` sample: `${desc.slice(0, DESCRIPTION_SAMPLE_CHARS)}` `` with a comment
   * saying "the template literal forces a flat copy". It does not. Measured on
   * this V8, 40'000 samples taken out of ~10 KB parents:
   *
   *     desc.slice(0, 100)                    10'115 B/entry
   *     `${desc.slice(0, 100)}`               10'114 B/entry   ← no-op
   *     s.normalize() / s.repeat(1) / padEnd  ~10'100 B/entry  ← also no-ops
   *     Buffer.from(s,'utf8').toString()         131 B/entry
   *     s.split('').join('')                     130 B/entry
   *
   * A single-substitution template literal is optimised away, as are the other
   * "obvious" flatteners; only routing the bytes outside the JS heap and back
   * builds a fresh SeqString. Buffer is also the fastest of the working ones
   * (120 ms vs 405 ms per 40'000 on the same measurement).
   *
   * What it cost: the entry count here is the DISTINCT-DESCRIPTION count, so
   * a post-deploy run held ~1M pages resident instead of ~1M short strings.
   * Probing all 17 registered auditors over an identical corpus put this one
   * at 3'462 B/file against 127 B/file for the next worst and ~1 B/file for
   * the other fifteen — 96 % of everything `audit:all` retained. That is what
   * hit `--max-old-space-size=4096` and killed run 32261742920 with
   * `FATAL ERROR: Ineffective mark-compacts near heap limit`, which in turn
   * reached the failure classifier as the unclassifiable name `audit:all` and,
   * fail-closed, sequestered `publish`.
   *
   * The round-trip is content-exact here: `html` was read with utf8 encoding,
   * so it cannot contain lone surrogates for the encoder to replace.
   *
   * @param {string} s
   * @returns {string}
   */
  const flatten = (s) => Buffer.from(s, 'utf8').toString('utf8');

  // 64-bit FNV-1a as 16 hex chars. Non-cryptographic is right here: the input
  // is our own build output, not adversarial, and at ~1M distinct keys the
  // 64-bit birthday collision probability is ~3e-7 — orders of magnitude below
  // the recall this gate already gives up to sampling.
  const hashKey = (s) => {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
    }
    return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
  };

  return {
    name: 'duplicate-meta-description',
    collect(file, html) {
      if (html.length === 0) return;
      filesScanned += 1;
      const desc = extractMetaDescriptionRaw(html);
      if (!desc) return;
      if (ALLOWLIST_PREFIXES.some((p) => desc.startsWith(p))) return;
      // `noindex,follow` bridge/tombstone pages (below-floor, legacy-redirect,
      // self-heal) share a templated description by design and never compete
      // for a SERP snippet — same reasoning as `isNoindex()` in
      // audit-cannibalization.mjs, reused here via the shared extractor
      // instead of a second copy of the regex (#6501).
      if (sharedExtract(html).isNoindex) return;
      const path = relative(ROOT, file).replace(/^dist\//, '');
      const key = hashKey(desc);
      const entry = byDescription.get(key);
      if (entry) {
        entry.count += 1;
        if (entry.paths.length < PATHS_PER_DESCRIPTION_CAP) entry.paths.push(path);
        // Deferred to the second occurrence — see the class header comment
        // above `byDescription`. `maxPages` starts at 2, so `sample` is
        // always populated well before an entry can become a real offender
        // (`count > maxPages`).
        if (entry.sample === undefined) entry.sample = flatten(desc.slice(0, DESCRIPTION_SAMPLE_CHARS));
      } else {
        byDescription.set(key, { count: 1, paths: [path], sample: undefined });
      }
    },
    report() {
      const offenders = [];
      for (const { count, paths, sample } of byDescription.values()) {
        if (count > maxPages) {
          offenders.push({
            path: paths[0],
            description: sample,
            metric: count,
            pages: paths.slice(0, 5),
          });
        }
      }
      offenders.sort((a, b) => b.metric - a.metric);

      // CEILING, not zero. `MAX_DUPLICATE_PAGES_PER_DESCRIPTION = 2` is the
      // per-GROUP quality threshold and is untouched — a description on three
      // pages is still an offender. What changes is the corpus-level verdict:
      // the rehydrated dist/ carries ~197'000 offender pages emitted over
      // months, so `offenders.length === 0` made this auditor report an
      // unchanging red regardless of whether anyone was fixing it. See
      // scripts/lib/seoDefectRatchet.mjs for the reassembled-corpus exception
      // this sits inside.
      const ratchet = evaluateCeiling({
        family: DUPLICATE_META_FAMILY,
        offenders: offenders.length,
        filesScanned,
        entry: ceilingEntry,
      });
      const passed = ratchet.ratcheted ? ratchet.passed : offenders.length === 0;
      return {
        passed,
        offendersTotal: offenders.length,
        // Deliberately NOT sliced: writeAuditReport derives the report's own
        // `offendersTotal` from this array's length and truncates
        // `topOffenders` itself (flagging it via `topOffendersTruncated`).
        // Slicing here would under-report the total in the artifact, which is
        // the surface people actually debug from. The list is bounded by
        // construction — only descriptions ALREADY over the threshold.
        offenders,
        threshold: { metric: 'pagesPerDescription', value: maxPages, comparator: '<= (within the scanned set)' },
        extra: {
          limit,
          filesScanned,
          sampleRate,
          distinctDescriptions: byDescription.size,
          samplingSemantics:
            sampleRate < 1
              ? `group sizes are counted WITHIN the ${(sampleRate * 100).toFixed(0)}% sampled slice: no false positives (a sampled group is a real group), reduced recall (a real group may be split across buckets and never seen whole). A green run is not proof the corpus is clean.`
              : 'full walk: group sizes are corpus-exact.',
          // Full ledger verdict into the artifact — see the identical field in
          // scripts/audit-link-anchor-text.mjs and the reason there.
          ratchet,
        },
        // The measured rate is printed on EVERY run, pass or fail. That is not
        // decoration: it is the condition the reassembled-corpus exception
        // attaches to using a rate at all (AGENTS.md #1, owner 2026-08-20) —
        // the next ceiling has to tighten on a datum, and a datum nobody prints
        // is not one.
        humanSummary: passed
          ? `duplicate meta-description gate: ${offenders.length} description(s) on more than ${maxPages} of ` +
            `${filesScanned} scanned page(s)${offenders.length > 0 ? ` (worst group: ${offenders[0].metric} pages)` : ''} — ${ratchet.humanSummary}`
          : ratchet.ratcheted
            ? `${ratchet.humanSummary} — worst group: ${offenders[0].metric} pages sharing "${offenders[0].description}"`
            : `${offenders.length} description(s) shared by more than ${maxPages} pages (worst: ${offenders[0].metric} pages)`,
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
    console.error(`[audit-duplicate-meta-description] ${DEFAULT_DIST} not found — run \`npm run build\` first.`);
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
    offenders: result.offenders,
    extra: result.extra,
  });

  if (JSON_OUT) {
    console.log(JSON.stringify({ total: result.offendersTotal, extra: result.extra, offenders: result.offenders.slice(0, limit) }, null, 2));
  } else if (result.passed) {
    console.log(`✅ ${result.humanSummary}.`);
  } else {
    console.error(`❌ ${result.humanSummary}.`);
    console.error('');
    for (const o of result.offenders.slice(0, limit)) {
      console.error(`  - "${o.description}…" on ${o.metric} pages: ${o.pages.join(', ')}${o.metric > o.pages.length ? ', …' : ''}`);
    }
    console.error('');
    console.error('Fix: parameterise the plugin fallback with path-specific keywords (staticPagesPlugin, ogPagesPlugin, jobsSeoPagesPlugin).');
  }
  process.exit(result.passed ? 0 : 1);
}

const invokedDirectly = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) {
  standalone().catch((err) => {
    console.error('[audit-duplicate-meta-description] fatal', err);
    process.exit(2);
  });
}
