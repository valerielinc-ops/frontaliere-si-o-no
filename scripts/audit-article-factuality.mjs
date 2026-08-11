#!/usr/bin/env node
/**
 * Retro-audit: runs the deterministic factuality gates over every published
 * article body and reports what would have been blocked.
 *
 * Added with the gates themselves (2026-07-28, incident on
 * `frontalieri-altre-tasse-2026`). The gates stop NEW defects at generation
 * time; this script finds the ones already live.
 *
 * The source page of a published article is not retained, so the two
 * source-relative gates (fidelity, freshness) cannot run here. Everything
 * decidable from the text alone does: arithmetic, tax plausibility,
 * cross-section contradictions, invented institutions, contradictory norm
 * dates and truncation.
 *
 * Usage:
 *   node scripts/audit-article-factuality.mjs              # human report
 *   node scripts/audit-article-factuality.mjs --json       # machine-readable
 *   node scripts/audit-article-factuality.mjs --critical   # blocking only
 *   node scripts/audit-article-factuality.mjs --limit 20   # cap output
 *   node scripts/audit-article-factuality.mjs --changed <base>   # CI gate
 *   node scripts/audit-article-factuality.mjs --changed-worktree # pre-commit report
 *
 * Corpus mode exits 0 always — it is a report, not a gate. Nothing is ever
 * modified and no page is ever unpublished: that is an owner decision.
 *
 * `--changed <ref>` restricts the scan to article bodies touched in the diff
 * against <ref> and exits 1 if any of them has a blocking issue. The gates live
 * inside create-article.mjs, which covers the LLM generation path where the
 * 2026-07-28 defects came from; this is the backstop for every other way an
 * article body can reach main (hand edits, repair scripts, other generators).
 *
 * `--changed-worktree` is the SAME scoping sourced differently: uncommitted
 * working-tree/index changes instead of a committed ref-to-ref diff. It exists
 * because `--changed <ref>` cannot see the path that actually publishes
 * articles today (issue #5595).
 *
 * Since the 2026-08-02 cutover (#4974) article bodies are generated in
 * nanakokyobashi-rgb/frontaliere-articles and reach this repo through
 * `.github/workflows/sync-articles-sitemaps.yml`, which pulls the corpus and
 * commits `packages/articles/content` STRAIGHT TO `main` with no PR. Both
 * committed-diff hooks are therefore dead on that path, and measurably so:
 *
 *   - the `pull_request` run of tests.yml never sees these bodies — there is
 *     no PR;
 *   - its `push: branches: [main]` run never even STARTS, because the sync
 *     pushes with the workflow's own GITHUB_TOKEN and GitHub does not trigger
 *     workflows on such pushes (verified 2026-08-11: sync commit 7f1a3b4f has
 *     four check-runs, all `schedule`/`workflow_run`, zero `push`);
 *   - and if it did start, `github.base_ref` is empty on a push, so the gate
 *     diffs `origin/main...HEAD` with `origin/main == HEAD` → empty set →
 *     green while verifying nothing.
 *
 * The one moment a diff of what is ABOUT TO be published still exists is
 * between the corpus pull and the commit, in the sync job's working tree. That
 * is what this mode reads. Unlike `--changed`, it never sets a non-zero exit
 * code: see scripts/ci/report-synced-article-factuality.mjs for why blocking
 * that job is an owner decision and not this script's to take.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { runFactualityGates, SEVERITY, formatIssues } from './lib/article-factuality-gates.mjs';
import { BODY_DIRS, LOCALES, extractBodies } from './lib/blog-body-io.mjs';

const AS_JSON = process.argv.includes('--json');
const CRITICAL_ONLY = process.argv.includes('--critical');
/**
 * Which locales to scan. Italian is the generated body and the reference the
 * other three are compared against, so it is always read even when not scanned.
 * `--locale it` reproduces the pre-2026-07-29 report exactly, which is how the
 * "Italian verdict unchanged" claim is checked.
 */
const LOCALE_FILTER = (() => {
  const i = process.argv.indexOf('--locale');
  if (i === -1) return LOCALES;
  const wanted = (process.argv[i + 1] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return wanted.length ? LOCALES.filter((l) => wanted.includes(l)) : LOCALES;
})();
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i !== -1 ? Number(process.argv[i + 1]) || Infinity : Infinity;
})();
const CHANGED_BASE = (() => {
  const i = process.argv.indexOf('--changed');
  return i !== -1 ? (process.argv[i + 1] || 'origin/main') : null;
})();
const CHANGED_WORKTREE = process.argv.includes('--changed-worktree');

// Refuse rather than pick one. The two modes answer different questions and
// only `--changed` sets an exit code; silently letting one win would produce a
// gate whose verdict does not match the scope it printed.
if (CHANGED_BASE && CHANGED_WORKTREE) {
  console.error('❌ --changed <ref> e --changed-worktree si escludono a vicenda.');
  process.exit(2);
}

// Two prefixes, because `services/locales/blog-body[-ch]` is a SYMLINK to
// `packages/articles/content/blog-body[-ch]`. The audit walks the symlink and
// reads the real files, but `git diff --name-only` reports the resolved path —
// so a regex anchored on the symlink prefix alone matched nothing, and the gate
// exited 0 on every PR: verifying nothing while looking green. A gate that
// silently stops gating is the exact failure this one exists to prevent, so it
// accepts whichever prefix the repo is currently using.
//
// Any locale, not just `it`: the gate judges translations too, and a PR that
// only touches <root>/blog-body/en/<id>.ts is exactly the shape of change
// ("border guards") it was extended to catch.
const BODY_PATH_RE =
  /^(?:services\/locales|packages\/articles\/content)\/blog-body(?:-ch)?\/(?:it|en|de|fr)\/(.+)\.ts$/;

/** Article ids named by `git diff --name-only`-shaped output. */
function articleIdsFromPaths(out) {
  const ids = new Set();
  for (const line of out.split('\n')) {
    const m = line.match(BODY_PATH_RE);
    if (m) ids.add(m[1]);
  }
  return ids;
}

// The index carries 30k+ entries and the corpus alone is ~15k files, so a
// full-corpus refresh can print a name list far past execFileSync's 1 MB
// default. ENOBUFS there would be caught by the `catch` below and reported as
// "diff unavailable" — i.e. the scan would silently cover nothing on exactly
// the largest, most interesting change. Same reasoning as the maxBuffer in
// tests/workflows/git-add-symlinked-corpus.test.ts.
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const GIT_OPTS = { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: GIT_MAX_BUFFER };

/** Italian article ids touched in the diff against `base`. */
function changedArticleIds(base) {
  let out = '';
  try {
    // Three-dot first (changes introduced by this branch since the merge base).
    // CI checks out shallow, so the merge base is often absent — fall back to a
    // plain two-dot tree diff, which only needs both tips to be present.
    try {
      out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], GIT_OPTS);
    } catch {
      out = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], GIT_OPTS);
    }
  } catch {
    // Shallow clone or unknown ref. Do NOT fall back to the whole corpus: this
    // gate only ever judges what the diff introduces, and the corpus still
    // carries pre-existing debt (47 blocking findings at the time of writing)
    // that would turn every PR red. Report loudly and let the PR through — a
    // gate that cannot compute its scope must not invent one.
    console.error(`⚠️  git diff contro "${base}" non riuscito (clone shallow o ref assente).`);
    console.error('   Gate NON eseguito su questo diff — nessun articolo verificato.');
    return 'unavailable';
  }
  return articleIdsFromPaths(out);
}

/**
 * Article ids changed in the working tree but not yet committed: unstaged
 * edits, staged edits and new untracked files.
 *
 * All three, because the caller runs between `pull-articles-corpus.mjs` (which
 * overwrites tracked bodies AND drops brand-new ones in, untracked) and the
 * `git add` that stages them. Reading only the unstaged diff would miss every
 * NEW article — the majority of what a sync brings — and reading only the
 * index would miss everything if the caller ever moves earlier. The union is
 * correct at any point before the commit, which is the property that keeps
 * this from breaking the next time the step order changes.
 */
function changedArticleIdsWorktree() {
  let out = '';
  try {
    out = [
      execFileSync('git', ['diff', '--name-only'], GIT_OPTS),
      execFileSync('git', ['diff', '--name-only', '--cached'], GIT_OPTS),
      execFileSync('git', ['ls-files', '--others', '--exclude-standard'], GIT_OPTS),
    ].join('\n');
  } catch {
    // Same contract as changedArticleIds(): a scope that cannot be computed is
    // reported loudly and scans nothing, never silently widened to the corpus.
    console.error('⚠️  git diff/ls-files sul working tree non riuscito.');
    console.error('   Scan NON eseguito — nessun articolo verificato.');
    return 'unavailable';
  }
  return articleIdsFromPaths(out);
}

const changedIdsRaw = CHANGED_WORKTREE
  ? changedArticleIdsWorktree()
  : CHANGED_BASE
    ? changedArticleIds(CHANGED_BASE)
    : null;
const diffUnavailable = changedIdsRaw === 'unavailable';
// An empty Set means "diff computed, no article touched" → scan nothing.
const changedIds = diffUnavailable ? new Set() : changedIdsRaw;

const findings = [];
let scanned = 0;
/** locale → { scanned, flagged, critical, byCode } — for the per-locale table. */
const perLocale = new Map();
function tally(locale) {
  if (!perLocale.has(locale)) {
    perLocale.set(locale, {
      scanned: 0, flagged: 0, critical: 0, byCode: new Map(),
    });
  }
  return perLocale.get(locale);
}

/** Reads one article's body sections for one locale; {} when absent. */
function sectionsFor(bodyDir, locale, file, id) {
  const path = join(bodyDir, locale, file);
  if (!existsSync(path)) return {};
  return extractBodies(readFileSync(path, 'utf-8'), id);
}

for (const bodyDir of BODY_DIRS) {
  const itDir = join(bodyDir, 'it');
  if (!existsSync(itDir)) continue;

  // The Italian file list drives the walk in every locale: an article that
  // exists only as a translation has no reference to be judged against.
  for (const file of readdirSync(itDir).filter((f) => f.endsWith('.ts'))) {
    const id = file.replace('.ts', '');
    if (changedIds && !changedIds.has(id)) continue;
    const italianSections = extractBodies(readFileSync(join(itDir, file), 'utf-8'), id);
    if (!Object.keys(italianSections).length) continue;

    for (const locale of LOCALE_FILTER) {
      const sections = locale === 'it' ? italianSections : sectionsFor(bodyDir, locale, file, id);
      if (!Object.keys(sections).length) continue;
      scanned++;
      const t = tally(locale);
      t.scanned++;

      // No sourceText / sourceDate: those gates are skipped by construction.
      const { issues, blocking } = runFactualityGates({ sections, locale, italianSections });
      const relevant = CRITICAL_ONLY ? blocking : issues;
      if (!relevant.length) continue;

      t.flagged++;
      if (blocking.length) t.critical++;
      for (const i of issues) t.byCode.set(i.code, (t.byCode.get(i.code) || 0) + 1);

      findings.push({
        id,
        dir: bodyDir,
        locale,
        criticalCount: blocking.length,
        issueCount: issues.length,
        worst: Math.max(...issues.map((i) => SEVERITY[i.severity] || 0)),
        issues: relevant,
      });
    }
  }
}

findings.sort((a, b) => b.criticalCount - a.criticalCount || b.worst - a.worst || b.issueCount - a.issueCount);
const shown = findings.slice(0, LIMIT);

if (AS_JSON) {
  console.log(JSON.stringify({
    scanned,
    flagged: findings.length,
    // Machine-readable scope, so a wrapper can tell "diff computed, nothing to
    // check" (scanned 0, diffUnavailable false) apart from "scope could not be
    // computed, nothing was checked" (diffUnavailable true). Without it the two
    // are the same empty report, and a scoped run that silently stopped scoping
    // reads exactly like a clean one — the failure this whole mode exists to
    // stop being invisible.
    mode: CHANGED_WORKTREE ? 'changed-worktree' : CHANGED_BASE ? 'changed' : 'corpus',
    diffUnavailable,
    truncated: findings.length > shown.length,
    perLocale: Object.fromEntries([...perLocale].map(([l, t]) => [l, {
      scanned: t.scanned,
      flagged: t.flagged,
      critical: t.critical,
      byCode: Object.fromEntries([...t.byCode].sort((a, b) => b[1] - a[1])),
    }])),
    findings: shown,
  }, null, 2));
} else {
  const icon = { critical: '🚨', major: '⚠️', minor: 'ℹ️' };
  console.log(`\n📊 Audit factuality — ${scanned} articoli analizzati, ${findings.length} con problemi\n`);
  const withCritical = findings.filter((f) => f.criticalCount > 0).length;
  console.log(`   🚨 con problemi BLOCCANTI: ${withCritical}`);
  console.log(`   ⚠️  solo warning:          ${findings.length - withCritical}\n`);

  if (perLocale.size > 1) {
    console.log('   Per locale (analizzati / con problemi / bloccanti):');
    for (const locale of LOCALE_FILTER) {
      const t = perLocale.get(locale);
      if (!t) continue;
      console.log(`     ${locale}  ${String(t.scanned).padStart(5)} / ${String(t.flagged).padStart(5)} / ${String(t.critical).padStart(5)}`);
    }
    console.log('');
  }

  // Which defect classes are most common across the corpus.
  const byCode = new Map();
  for (const f of findings) {
    for (const i of f.issues) byCode.set(i.code, (byCode.get(i.code) || 0) + 1);
  }
  console.log('   Classi di difetto per frequenza:');
  for (const [code, n] of [...byCode].sort((a, b) => b[1] - a[1])) {
    const split = LOCALE_FILTER
      .map((l) => [l, perLocale.get(l)?.byCode.get(code) || 0])
      .filter(([, v]) => v > 0)
      .map(([l, v]) => `${l}:${v}`)
      .join(' ');
    console.log(`     ${String(n).padStart(4)}×  ${code.padEnd(34)} ${split}`);
  }
  console.log('');

  for (const f of shown) {
    console.log(`\n─── [${f.locale}] ${f.id}  (${f.criticalCount} bloccanti / ${f.issueCount} totali)`);
    for (const i of f.issues) {
      console.log(`  ${icon[i.severity] || '•'} [${i.code}] ${i.message}`);
      if (i.evidence) console.log(`       ↳ ${i.evidence.slice(0, 160)}`);
    }
  }
  if (findings.length > shown.length) {
    console.log(`\n   … altri ${findings.length - shown.length} articoli non mostrati (usa --limit).`);
  }
  console.log('');
}

// ── CI gate mode ──
if (CHANGED_BASE) {
  const blocking = findings.filter((f) => f.criticalCount > 0);
  if (diffUnavailable) {
    // Already reported above. Non-blocking by design — see changedArticleIds().
    process.exit(0);
  }
  if (!scanned) {
    console.log('✅ Nessun body articolo modificato in questo diff — niente da verificare.');
    process.exit(0);
  }
  if (!blocking.length) {
    console.log(`✅ ${scanned} articoli modificati, nessun problema bloccante.`);
    process.exit(0);
  }
  console.error(`\n🚫 ${blocking.length} articoli modificati con problemi BLOCCANTI:\n`);
  for (const f of blocking) {
    console.error(`─── [${f.locale}] ${f.id}`);
    console.error(formatIssues(f.issues.filter((i) => i.severity === 'critical')));
  }
  console.error('\nOgni problema riporta la correzione richiesta (🔧). Correggi il contenuto:');
  console.error('non abbassare le soglie e non rimuovere il passaggio per far passare il gate.\n');
  process.exit(1);
}

// ── Pre-commit report mode (--changed-worktree) ──
//
// Deliberately exit-code-free. This mode runs inside the job that PUBLISHES,
// not inside a PR check: a non-zero here would stop `sync-articles-sitemaps.yml`
// from committing, i.e. it would hold back every article in the batch — the
// correct ones included — on a `major` finding the gate is not certain enough
// about to block on. Escalation is the caller's job; see
// scripts/ci/report-synced-article-factuality.mjs.
if (CHANGED_WORKTREE && !AS_JSON) {
  if (diffUnavailable) {
    console.error('⚠️  Scope non calcolabile — nessun articolo verificato (vedi sopra).');
  } else if (!scanned) {
    console.log('✅ Nessun body articolo modificato nel working tree — niente da verificare.');
  } else {
    const blocking = findings.filter((f) => f.criticalCount > 0);
    console.log(
      `📋 ${scanned} body-locale in arrivo, ${findings.length} segnalati `
      + `(${blocking.length} con problemi bloccanti). Report only — nessuna pubblicazione bloccata.`,
    );
  }
}
