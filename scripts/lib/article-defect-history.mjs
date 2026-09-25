/**
 * Rejection ledger — the second link of the article learning loop described in
 * docs/ARTICLE-LEARNING-LOOP.md.
 *
 * WHY THIS EXISTS. Everything a `generate-article` run learns about its own
 * failures dies in stderr: which gate rejected which attempt, how many attempts
 * the article cost, what the LLM verifier objected to. The signal inventory in
 * §2 of the doc has six rows marked "survives? no", and every metric §6 asks
 * for is a TIME SERIES over exactly those rows. A snapshot of the defect memory
 * answers "what do we currently believe"; it cannot answer "is
 * `fabricated-institution` firing more than it did last week, and did anything
 * ship while it fired". Without that, every later link of the loop — threshold
 * tuning, negative few-shots, new defect classes — is guesswork, because none
 * of them can be shown to have helped or hurt.
 *
 * WHAT THIS IS, PRECISELY: A LEDGER, NOT A CONTROLLER.
 *
 * This module records. It does not decide, and nothing decides from it
 * automatically. That is not modesty, it is the stability argument. The 2026-07-28
 * degeneration (run 30350429920) happened because a measurement was wired
 * straight back into the thing it measured: the fact-checker's own false
 * positives became rewrite instructions, and six iterations later the surviving
 * draft no longer discussed its source at all but passed every check. A ledger
 * with no action surface cannot degenerate in that way — its worst failure mode
 * is "we learn nothing", never "we learn the wrong thing".
 *
 * The separation is enforced structurally, not by convention: this module does
 * not import scripts/lib/article-defect-memory.mjs, and that module does not
 * import this one. There is no code path from a ledger row to a change in a
 * defence. tests/article-defect-history.test.ts pins both directions of that
 * non-edge, so re-wiring them requires deleting a test that says why not to.
 *
 * THE VERIFIER'S OPINIONS ARE QUARANTINED, NOT EXCLUDED.
 *
 * `verifierOpinion` carries the LLM fact-checker's rejection categories. It is
 * the single most diagnostic column in the ledger — the 2026-07-28 signature is
 * literally "verifier rejections per run climbing while publish rate falls and
 * attempts-per-article rises", which this module detects and names — and it is
 * simultaneously the one column that must never be treated as a fact about the
 * world, because it is one language model's opinion about another's output.
 * Both things are true at once, so the field is named for what it is at every
 * read site, `summarizeHistory` tags its series `admissible: false`, and
 * `formatHistorySummary` prints it under a separate heading that says so. A
 * future link that wanted to learn from it would have to strip the label on
 * purpose.
 *
 * BOUNDED BY CONSTRUCTION, AND CONVERGENT UNDER `merge=union`.
 *
 * The workflow runs every 30 minutes (~48 rows/day). An unbounded append is a
 * repo problem, not a feature: data/dist-size-history.jsonl is 42MB and is part
 * of why `git push` from this repo needed a maintenance runbook. Retention
 * (180 days / 12000 rows) is applied by the writer, in the same call that
 * appends, so the file is born bounded and there is never a separate
 * prune-and-recommit step over someone else's archive.
 *
 * Retention rewrites the file, which does not commute with the `merge=union`
 * driver the .gitattributes entry gives this path — a union merge can resurrect
 * rows a compaction just dropped. That tension is resolved by convergence
 * rather than by locking: rows are identified by `runId|at`, `readHistory`
 * deduplicates on that key so a resurrected row can never be counted twice, and
 * the next append's retention pass drops it again. Temporary bloat, permanently
 * correct arithmetic, no coordination required.
 *
 * Zero model calls, zero network: one file read and one append per run.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const HISTORY_SCHEMA_VERSION = 1;
export const DEFAULT_HISTORY_FILE = 'data/article-defect-history.jsonl';

export const HISTORY_RETENTION = {
  /**
   * Rows older than this are dropped. 180 days is ~8600 runs — six months, and
   * six times the longest window `summarizeHistory` compares (30 days). The
   * question this file exists to answer ("is this error class growing?") is
   * asked over weeks; a row from last winter informs nothing and costs a clone.
   */
  maxAgeDays: 180,
  /**
   * Hard row ceiling, ~40% above what 180 days of the current 30-minute cadence
   * produces. It is the backstop for a cadence change (or a second section
   * doubling the rate) silently turning the TTL into no bound at all.
   */
  maxRows: 12_000,
  /**
   * Distinct rejection codes kept per map per row. A run that trips twelve
   * different gate codes has a problem the twelfth code will not clarify, and
   * an unbounded map lets one pathological run write a row larger than a
   * hundred normal ones. Truncation is RECORDED (`__truncated`), never silent —
   * an aggregate that quietly lost its tail is worse than no aggregate.
   */
  maxCodesPerRow: 12,
};

/** Series kinds. `admissible` is about EVIDENCE, not about usefulness. */
export const SERIES_KIND = /** @type {const} */ ({
  /** Deterministic gate verdict over the article text — reproducible, admissible. */
  GATE: 'gate',
  /** Deterministic duplicate-detection verdict — reproducible, admissible. */
  DUPLICATE: 'duplicate',
  /**
   * The LLM verifier's category counts. Diagnostic only: it is a model's
   * opinion about a model's output, so it can move because the world changed,
   * because the writer changed, or because the verifier changed, and the series
   * alone cannot tell those apart. Read by humans, never by a promotion policy.
   */
  VERIFIER: 'verifier',
});

/**
 * Caps a `{code: count}` map and records the truncation instead of hiding it.
 * @param {Record<string, number>|undefined} map
 * @param {number} [limit]
 */
function capCodeMap(map, limit = HISTORY_RETENTION.maxCodesPerRow) {
  const entries = Object.entries(map || {})
    .filter(([code, n]) => code && Number.isFinite(Number(n)) && Number(n) > 0)
    .map(([code, n]) => [String(code), Math.trunc(Number(n))])
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  if (entries.length <= limit) return Object.fromEntries(entries);
  const kept = Object.fromEntries(entries.slice(0, limit));
  kept.__truncated = entries.length - limit;
  return kept;
}

/** Tallies the run's institution observations by source-support verdict. */
function tallySupport(observations) {
  const out = { present: 0, absent: 0, unknown: 0 };
  for (const obs of observations || []) {
    const key = obs?.support;
    if (key === 'present' || key === 'absent') out[key] += 1;
    else out.unknown += 1;
  }
  return out;
}

/**
 * Builds one ledger row from a finalized create-article run report.
 *
 * Pure and total: a truncated or partly-written report yields a row with zeroes
 * rather than throwing, because a run that crashed hard is exactly the run
 * whose row we most want. `status` is copied verbatim from the report
 * (`generated` | `skipped` | `deferred` | `error` | …) rather than remapped to
 * a published/not-published boolean — the remapping is an interpretation, and
 * interpretations belong in the reader, where they can be changed without
 * invalidating six months of rows.
 *
 * @param {object} report parsed .tmp/create-article-run-report.json
 * @param {{now?: string, runId?: string, section?: string}} [ctx]
 * @returns {object} ledger row
 */
export function buildHistoryRow(report, ctx = {}) {
  const f = report?.factuality || {};
  return {
    v: HISTORY_SCHEMA_VERSION,
    at: ctx.now || new Date().toISOString(),
    runId: String(report?.runId || ctx.runId || 'local'),
    section: report?.section || ctx.section || null,
    status: String(report?.status || 'unknown'),
    /** Generation attempts spent across every headline this run tried. */
    attempts: Math.max(0, Math.trunc(Number(f.attempts) || 0)),
    articleId: report?.article?.id || null,
    sourceDomain: report?.article?.sourceDomain || report?.selectedSource || null,
    /** Deterministic gate codes that rejected a draft. Admissible evidence. */
    gateRejections: capCodeMap(f.gateRejectionsByCode),
    /** Deterministic duplicate-detector reasons. Admissible evidence. */
    duplicateRejections: capCodeMap(report?.duplicateReasonBreakdown),
    /** LLM verifier categories. DIAGNOSTIC ONLY — see SERIES_KIND.VERIFIER. */
    verifierOpinion: capCodeMap(f.factCheckRejectionsByCategory),
    /** How the run's own fetched sources answered on the entities it named. */
    sourceSupport: tallySupport(f.institutionObservations),
  };
}

/** Identity of a row. Two rows with the same key are the same observation. */
function rowKey(row) {
  return `${row.runId}|${row.at}`;
}

function isUsableRow(row) {
  return !!row
    && typeof row === 'object'
    && !Array.isArray(row)
    && typeof row.at === 'string'
    && !Number.isNaN(Date.parse(row.at));
}

/**
 * Reads the ledger.
 *
 * Three properties matter more than the parsing:
 *
 * 1. **A malformed line is dropped individually and COUNTED.** One truncated
 *    append (a runner killed mid-write) must not blind six months of rows, and
 *    it must not vanish either — `malformed` is reported all the way up to the
 *    CI step summary.
 * 2. **Duplicates are collapsed on `runId|at`.** This is what makes compaction
 *    safe to combine with `merge=union`: a union merge that resurrects rows a
 *    compaction dropped cannot inflate any count.
 * 3. **A missing file is not degradation.** It is the cold-start state; the
 *    ledger must run from empty on day one, exactly like the defect memory.
 *
 * @param {string} [filePath]
 * @returns {{rows: object[], malformed: number, duplicates: number, degraded: string|null, path: string}}
 */
export function readHistory(filePath = DEFAULT_HISTORY_FILE) {
  if (!existsSync(filePath)) {
    return { rows: [], malformed: 0, duplicates: 0, degraded: null, path: filePath };
  }
  let text;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch (e) {
    return { rows: [], malformed: 0, duplicates: 0, degraded: `file illeggibile: ${e.message}`, path: filePath };
  }

  const seen = new Map();
  let malformed = 0;
  let duplicates = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (!isUsableRow(row)) {
      malformed += 1;
      continue;
    }
    const key = rowKey(row);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.set(key, row);
  }

  const rows = [...seen.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { rows, malformed, duplicates, degraded: null, path: filePath };
}

/**
 * Applies the retention window. Pure, so the caller can decide whether the
 * result needs a rewrite at all.
 * @param {object[]} rows sorted ascending by `at`
 * @param {{now?: string, retention?: object}} [opts]
 */
export function applyRetention(rows, opts = {}) {
  const retention = { ...HISTORY_RETENTION, ...(opts.retention || {}) };
  const now = Date.parse(opts.now || new Date().toISOString());
  const cutoff = now - retention.maxAgeDays * 86_400_000;
  const fresh = rows.filter((r) => Date.parse(r.at) >= cutoff);
  return fresh.length > retention.maxRows ? fresh.slice(fresh.length - retention.maxRows) : fresh;
}

/**
 * Appends one row, compacting only when the file is not already canonical.
 *
 * The fast path is a bare `appendFileSync` — one syscall, and append-only is
 * what makes `merge=union` the correct resolution for this path. The slow path
 * (a full rewrite via temp+rename) runs only when the file has drifted out of
 * canonical form: rows past the retention window, duplicates resurrected by a
 * union merge, or lines a killed writer left half-written. Those conditions are
 * rare and self-clearing, so the steady state is one append per run.
 *
 * Reading the whole file first costs ~3.6MB at the row ceiling, once per 30
 * minutes. That is the price of never appending to a file we have not checked.
 *
 * @param {object} row
 * @param {string} [filePath]
 * @param {{now?: string, retention?: object}} [opts]
 * @returns {{appended: boolean, compacted: number, malformed: number, duplicates: number, total: number}}
 */
export function appendHistoryRow(row, filePath = DEFAULT_HISTORY_FILE, opts = {}) {
  mkdirSync(dirname(filePath), { recursive: true });
  const { rows, malformed, duplicates, degraded } = readHistory(filePath);
  if (degraded) throw new Error(degraded);

  const merged = [...rows, row].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const kept = applyRetention(merged, opts);
  const dropped = merged.length - kept.length;

  if (dropped === 0 && malformed === 0 && duplicates === 0) {
    appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf-8');
    return { appended: true, compacted: 0, malformed: 0, duplicates: 0, total: kept.length };
  }

  // Compaction. temp+rename so a SIGKILL mid-rewrite cannot leave a truncated
  // ledger behind — same guarantee writeJsonAtomic gives the JSON stores, which
  // cannot be reused here because this file is JSONL, not a JSON document.
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''), 'utf-8');
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
  return { appended: true, compacted: dropped, malformed, duplicates, total: kept.length };
}

/**
 * Minimum runs in a window before a delta is reported as a trend.
 *
 * At ~48 runs/day a 7-day window holds ~336 rows, so this bites only on a cold
 * ledger or after an outage. It exists because the loudest way to break trust
 * in a measurement is to print a confident "+200%" computed over three runs.
 * A window below the floor still reports its counts; it just refuses to call
 * them a direction.
 */
export const MIN_RUNS_FOR_TREND = 10;

function inWindow(rows, fromMs, toMs) {
  return rows.filter((r) => {
    const t = Date.parse(r.at);
    return t >= fromMs && t < toMs;
  });
}

function sumCodes(rows, field) {
  const out = {};
  for (const r of rows) {
    for (const [code, n] of Object.entries(r?.[field] || {})) {
      if (code === '__truncated') continue;
      out[code] = (out[code] || 0) + (Number(n) || 0);
    }
  }
  return out;
}

function outcomeStats(rows) {
  const byStatus = {};
  let attempts = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    attempts += Number(r.attempts) || 0;
  }
  const published = byStatus.generated || 0;
  return {
    runs: rows.length,
    byStatus,
    published,
    publishRate: rows.length ? published / rows.length : 0,
    attempts,
    attemptsPerRun: rows.length ? attempts / rows.length : 0,
    /** null, not Infinity: "nothing shipped" is a fact, not a very large cost. */
    attemptsPerPublished: published ? attempts / published : null,
  };
}

function direction(current, previous) {
  if (current === previous) return 'flat';
  return current > previous ? 'up' : 'down';
}

/**
 * The aggregate view §6 of the doc asks for: which error classes are growing or
 * shrinking, at what cost, and is the loop itself misbehaving.
 *
 * Compares the last `windowDays` against the `windowDays` before it. A rolling
 * comparison rather than an all-time rate because the question is "did last
 * week's change help", and an all-time denominator drowns exactly that.
 *
 * Deterministic, no model calls, no network.
 *
 * @param {object[]} rows
 * @param {{now?: string, windowDays?: number, limit?: number}} [opts]
 */
export function summarizeHistory(rows, opts = {}) {
  const now = Date.parse(opts.now || new Date().toISOString());
  const windowDays = Number(opts.windowDays) || 7;
  const limit = Number(opts.limit) || 15;
  const span = windowDays * 86_400_000;

  const current = inWindow(rows, now - span, now + 1);
  const previous = inWindow(rows, now - 2 * span, now - span);

  const currentStats = outcomeStats(current);
  const previousStats = outcomeStats(previous);
  const sampleAdequate = current.length >= MIN_RUNS_FOR_TREND && previous.length >= MIN_RUNS_FOR_TREND;

  const series = [];
  for (const [field, kind, admissible] of [
    ['gateRejections', SERIES_KIND.GATE, true],
    ['duplicateRejections', SERIES_KIND.DUPLICATE, true],
    ['verifierOpinion', SERIES_KIND.VERIFIER, false],
  ]) {
    const cur = sumCodes(current, field);
    const prev = sumCodes(previous, field);
    for (const code of new Set([...Object.keys(cur), ...Object.keys(prev)])) {
      const c = cur[code] || 0;
      const p = prev[code] || 0;
      series.push({
        code,
        kind,
        // Whether this series may ever be used as EVIDENCE about the world.
        // The verifier's opinions are useful and inadmissible at the same time.
        admissible,
        current: c,
        previous: p,
        delta: c - p,
        // Per-run rates, because the two windows can hold different run counts
        // after an outage and raw counts would then read as a trend.
        currentPerRun: current.length ? c / current.length : 0,
        previousPerRun: previous.length ? p / previous.length : 0,
        direction: sampleAdequate ? direction(c, p) : 'unknown',
      });
    }
  }
  series.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.current - a.current || a.code.localeCompare(b.code));

  const warnings = [];
  if (!sampleAdequate) {
    warnings.push(
      `Campione insufficiente per una tendenza: ${current.length} run nella finestra corrente e `
      + `${previous.length} nella precedente (minimo ${MIN_RUNS_FOR_TREND}). I conteggi qui sopra sono reali, `
      + 'la direzione (?) no — non leggerli come un trend.',
    );
  }

  // The 2026-07-28 signature, stated as a detector rather than as a memory.
  // On that day the verifier rejected faithful drafts, the retry loop burned
  // its budget, and what finally shipped had abandoned its source. Every one of
  // those three shows up here: verifier rejections per run climbing, attempts
  // per run climbing, publish rate falling. Any two of the three without the
  // third is noise; all three together is the shape of a verifier that has
  // stopped measuring the world. ADVISORY ONLY — nothing in the pipeline reads
  // this warning, a person does.
  if (sampleAdequate) {
    const verifierNow = current.reduce((n, r) => n + Object.entries(r.verifierOpinion || {})
      .filter(([c]) => c !== '__truncated').reduce((s, [, v]) => s + (Number(v) || 0), 0), 0) / current.length;
    const verifierPrev = previous.reduce((n, r) => n + Object.entries(r.verifierOpinion || {})
      .filter(([c]) => c !== '__truncated').reduce((s, [, v]) => s + (Number(v) || 0), 0), 0) / previous.length;
    const verifierUp = verifierNow >= verifierPrev * 1.5 && verifierNow - verifierPrev >= 0.5;
    const attemptsUp = currentStats.attemptsPerRun > previousStats.attemptsPerRun;
    const publishDown = currentStats.publishRate < previousStats.publishRate;
    if (verifierUp && attemptsUp && publishDown) {
      warnings.push(
        `Sospetta cattura del verificatore: rigetti del fact-check per run ${verifierPrev.toFixed(2)} → `
        + `${verifierNow.toFixed(2)}, tentativi per run ${previousStats.attemptsPerRun.toFixed(2)} → `
        + `${currentStats.attemptsPerRun.toFixed(2)}, quota pubblicata ${(previousStats.publishRate * 100).toFixed(0)}% → `
        + `${(currentStats.publishRate * 100).toFixed(0)}%. È la firma del 2026-07-28: il verificatore rigetta bozze `
        + 'fedeli e il loop di retry converge su ciò che lo soddisfa. Controlla i verdetti a mano PRIMA di toccare i gate.',
      );
    }
  }

  return {
    windowDays,
    generatedAt: new Date(now).toISOString(),
    totalRows: rows.length,
    sampleAdequate,
    current: currentStats,
    previous: previousStats,
    series: series.slice(0, limit),
    seriesTotal: series.length,
    warnings,
  };
}

function pct(n) {
  return `${(n * 100).toFixed(0)}%`;
}

function arrow(d) {
  return d === 'up' ? '▲' : d === 'down' ? '▼' : d === 'flat' ? '=' : '?';
}

/**
 * Renders the summary for the CI step summary and the terminal.
 *
 * Deterministic and inadmissible series are printed under SEPARATE headings, on
 * purpose: the whole quarantine is worthless if the only place it is visible is
 * a field name in a JSONL file nobody opens.
 */
export function formatHistorySummary(summary) {
  const l = [];
  l.push(`📈 Storico rigetti — ultimi ${summary.windowDays}gg vs ${summary.windowDays}gg precedenti `
    + `(${summary.totalRows} run in archivio)`);
  l.push(`   Run: ${summary.current.runs} (prima ${summary.previous.runs}) · `
    + `pubblicati ${summary.current.published} (${pct(summary.current.publishRate)}, prima ${pct(summary.previous.publishRate)}) · `
    + `tentativi/run ${summary.current.attemptsPerRun.toFixed(2)} (prima ${summary.previous.attemptsPerRun.toFixed(2)})`);
  const cost = summary.current.attemptsPerPublished;
  const prevCost = summary.previous.attemptsPerPublished;
  l.push(`   Costo: ${cost === null ? 'n/d (nessuna pubblicazione)' : `${cost.toFixed(2)} tentativi per articolo pubblicato`}`
    + `${prevCost === null ? '' : ` (prima ${prevCost.toFixed(2)})`}`);

  const admissible = summary.series.filter((s) => s.admissible);
  const opinions = summary.series.filter((s) => !s.admissible);

  l.push('');
  l.push('   Rigetti deterministici (riproducibili — evidenza ammissibile):');
  if (!admissible.length) l.push('     (nessuno nella finestra)');
  for (const s of admissible) {
    l.push(`     ${arrow(s.direction)} ${s.code.padEnd(34)} ${s.current} (prima ${s.previous}, `
      + `${s.currentPerRun.toFixed(2)}/run vs ${s.previousPerRun.toFixed(2)})`);
  }

  l.push('');
  l.push('   Verdetti del verificatore LLM (SOLO diagnostici — opinione di un modello su un modello,');
  l.push('   mai ammissibili come prova: nessuna difesa può essere promossa da queste righe):');
  if (!opinions.length) l.push('     (nessuno nella finestra)');
  for (const s of opinions) {
    l.push(`     ${arrow(s.direction)} ${s.code.padEnd(34)} ${s.current} (prima ${s.previous}, `
      + `${s.currentPerRun.toFixed(2)}/run vs ${s.previousPerRun.toFixed(2)})`);
  }

  if (summary.seriesTotal > summary.series.length) {
    l.push(`     … e altre ${summary.seriesTotal - summary.series.length} serie (usa --limit per vederle)`);
  }
  for (const w of summary.warnings) l.push(`\n   ⚠️  ${w}`);
  return l.join('\n');
}
