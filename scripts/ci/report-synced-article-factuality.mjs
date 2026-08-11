#!/usr/bin/env node
/**
 * report-synced-article-factuality.mjs — surface deterministic factuality-gate
 * findings for the article bodies `sync-articles-sitemaps.yml` has just pulled
 * from the corpus repo, in the window before it commits them to `main`.
 *
 * ── Why this exists (issue #5595) ───────────────────────────────────────────
 *
 * The gate itself was never the problem. `scripts/lib/article-factuality-gates.mjs`
 * is deterministic, makes zero model calls, and catches this class of defect:
 * run against the article the issue reports
 * (`lastminute-com-perdita-obiettivi-trimestre`) it flags
 * `unknown-institution` on "Autorità di controllo del turismo svizzero (ACTS)",
 * an entity that does not exist. It was simply never connected to the path that
 * publishes articles.
 *
 * Since the 2026-08-02 cutover (#4974) bodies are generated in
 * nanakokyobashi-rgb/frontaliere-articles and land here through the sync
 * workflow, which commits `packages/articles/content` STRAIGHT TO `main` with
 * no PR. Every committed-diff hook is therefore dead on that path — verified,
 * not assumed:
 *
 *   - `pull_request` runs of tests.yml never see these bodies: there is no PR;
 *   - the `push: branches: [main]` run never STARTS — the sync pushes with the
 *     workflow's own GITHUB_TOKEN and GitHub does not trigger workflows on such
 *     pushes (2026-08-11: sync commit 7f1a3b4f carries four check-runs, all
 *     `schedule`/`workflow_run`, zero `push`);
 *   - and if it did start, `github.base_ref` is empty on a push, so
 *     `--changed origin/${{ github.base_ref || 'main' }}` diffs `origin/main`
 *     against itself → empty scope → green having checked nothing.
 *
 * The only surviving diff of what is about to be published is the sync job's
 * own uncommitted working tree. That is what this reads, via
 * `audit-article-factuality.mjs --changed-worktree`.
 *
 * ── Why it reports instead of blocking ──────────────────────────────────────
 *
 * A non-zero exit here would stop the commit, i.e. hold back the WHOLE synced
 * batch — correct articles included — and with it the sitemaps, the ten RSS
 * feeds and the news ticker that ride the same commit. Measured over the
 * corpus on 2026-08-11: 3.173 flagged body-locales out of 15.640 (20,3%), of
 * which only 206 blocking. The dominant classes are `translation-number-dropped`
 * (3.359 occurrences) and `incomplete-ending` (1.517) — real defects, but
 * translation-fidelity ones that predate any given sync. Blocking on them would
 * stop publishing several times a day; blocking on `critical` only would still
 * miss the case #5595 actually reports, which scores `major`.
 *
 * So: report, always; escalate, selectively; never block. Turning this into a
 * hard gate is an owner decision, not this script's.
 *
 * ── What gets escalated, and why that rule ──────────────────────────────────
 *
 * Two channels, because two different readers need different things:
 *
 *   1. `$GITHUB_STEP_SUMMARY`, EVERY run, every severity. Free, no backlog
 *      cost, and it is what makes a currently invisible event visible at the
 *      moment it happens.
 *   2. One deduplicated GitHub issue, only for the findings the rule below
 *      selects.
 *
 * The rule is `critical` (any locale) OR any finding on the ITALIAN body:
 *
 *   - the Italian body is the GENERATED original, so it is the only place where
 *     "the generator invented something" is decidable at all; the other three
 *     locales are translations of it;
 *   - measured per locale: it 164/3.912 flagged (4,2%), en 956 (24%), de 975
 *     (25%), fr 1.078 (28%). Escalating every finding would mean roughly 13
 *     comments a day at the current ~22 articles/day, essentially all of them
 *     translation-number drift. The rule selects ~330 of the 3.173 (~10%), i.e.
 *     one or two sync runs a day — a cadence a human can actually read;
 *   - it is a rule over SEVERITY and LOCALE, not a curated list of codes, so a
 *     gate class added later escalates by default instead of being silently
 *     out of scope. That failure mode — a list that goes stale and quietly
 *     narrows coverage — is the same one this whole script exists to undo.
 *
 * `FACTUALITY_ISSUE_SCOPE` overrides it (`it-or-critical` default, `critical`,
 * `all`) so the owner can widen or narrow without a code change.
 *
 * Usage:
 *   node scripts/ci/report-synced-article-factuality.mjs
 * (after `pull-articles-corpus.mjs`, before the sync commit)
 */

import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AUDIT = path.join(ROOT, 'scripts', 'audit-article-factuality.mjs');

/** Stable across runs: dedup in github-issue-creator.mjs keys on the title. */
export const ISSUE_TITLE =
  'Content grounding: articoli sincronizzati con claim non verificati';

/**
 * Hard ceiling on what goes into the issue body. GitHub rejects a body over
 * 65.536 characters, and `gh issue create` failing is caught by main()'s
 * handler — so an unusually large sync would file NOTHING and exit 0, which is
 * precisely the silent-no-op shape being repaired. Truncating is the behaviour
 * that degrades instead of vanishing.
 */
const MAX_ARTICLES_IN_BODY = 25;
const MAX_ISSUES_PER_ARTICLE = 8;
const MAX_BODY_CHARS = 60000;

const SCOPES = new Set(['it-or-critical', 'critical', 'all']);

/** @returns {'it-or-critical'|'critical'|'all'} */
export function issueScope(env = process.env) {
  const raw = (env.FACTUALITY_ISSUE_SCOPE || '').trim();
  return SCOPES.has(raw) ? raw : 'it-or-critical';
}

/**
 * Does this finding deserve a backlog entry? See the module header for the
 * measurement behind the default.
 *
 * @param {{ locale: string, criticalCount: number }} finding
 * @param {string} scope
 */
export function isEscalatable(finding, scope = 'it-or-critical') {
  if (scope === 'all') return true;
  if (finding.criticalCount > 0) return true;
  if (scope === 'critical') return false;
  return finding.locale === 'it';
}

/**
 * Runs the audit scoped to the uncommitted working tree.
 *
 * `cwd: ROOT` is load-bearing, not tidiness: the audit resolves its scope with
 * `git diff` in the inherited cwd, and from anywhere else git would fail, the
 * audit would report an unavailable scope and check nothing — green, silent,
 * and wrong. Same reason the audit path is resolved from `import.meta.url`
 * rather than assumed relative.
 *
 * @returns {{ scanned: number, flagged: number, diffUnavailable: boolean, findings: object[] }}
 */
export function runAudit() {
  const out = execFileSync(process.execPath, [AUDIT, '--json', '--changed-worktree'], {
    cwd: ROOT,
    encoding: 'utf-8',
    // The corpus is ~15k files: a full refresh can print a report far past
    // execFileSync's 1 MB default, and ENOBUFS would throw away the report for
    // the largest change there is.
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(out);
}

/** One markdown line per finding, evidence trimmed. */
function renderFinding(f) {
  const shown = f.issues.slice(0, MAX_ISSUES_PER_ARTICLE);
  const lines = [
    `### [${f.locale}] \`${f.id}\` — ${f.criticalCount} bloccanti / ${f.issueCount} totali`,
    ...shown.map(
      (i) =>
        `- **${i.code}** (${i.severity}): ${i.message}`
        + (i.evidence ? `\n  \`${String(i.evidence).slice(0, 160).replace(/`/g, "'")}\`` : ''),
    ),
  ];
  if (f.issues.length > shown.length) {
    lines.push(`- … altri ${f.issues.length - shown.length} problemi su questo body.`);
  }
  lines.push('');
  return lines;
}

/**
 * Markdown for the issue. Kept separate from the filing so a test can assert
 * the shape without touching GitHub.
 *
 * @param {{ scanned: number, flagged: number, findings: object[] }} report
 * @param {object[]} escalated findings selected by isEscalatable()
 */
export function buildReportIssue(report, escalated, runUrl) {
  const shown = escalated.slice(0, MAX_ARTICLES_IN_BODY);
  const criticalCount = escalated.filter((f) => f.criticalCount > 0).length;

  const head = [
    '## Articoli appena sincronizzati con claim potenzialmente non supportati',
    '',
    `Il gate deterministico \`scripts/lib/article-factuality-gates.mjs\` ha segnalato `
    + `**${escalated.length}** body-locale (di cui **${criticalCount}** con problemi bloccanti) `
    + `sui ${report.scanned} appena tirati dal corpus `
    + `(nanakokyobashi-rgb/frontaliere-articles) da `
    + '`.github/workflows/sync-articles-sitemaps.yml`.',
    '',
    '**Nessuna pubblicazione è stata bloccata**: la sincronizzazione ha committato normalmente. '
    + 'Il perché è in `scripts/ci/report-synced-article-factuality.mjs`. '
    + 'Serve una verifica claim-by-claim contro la fonte citata nell\'articolo.',
    '',
    runUrl ? `Run: ${runUrl}` : '',
    '',
  ].filter((l) => l !== null);

  const body = shown.flatMap(renderFinding);

  const tail = [];
  if (escalated.length > shown.length) {
    tail.push(
      `… altri ${escalated.length - shown.length} body-locale segnalati in questo sync, `
      + 'non elencati qui. Riproducili con `node scripts/audit-article-factuality.mjs --limit 0`.',
      '',
    );
  }
  tail.push(
    '## Suggested action',
    '',
    '- Le correzioni al TESTO si fanno nel repo del corpus '
    + '(`nanakokyobashi-rgb/frontaliere-articles`, `content/blog-body[-ch]/<locale>/<id>.ts`): '
    + 'una modifica fatta qui verrebbe sovrascritta dal prossimo sync.',
    '- Se il claim non è supportato dalla fonte, correggi o rimuovi il passaggio.',
    '- Se è un falso positivo (ente reale non ancora in allowlist), aggiungilo alla allowlist '
    + 'in `scripts/lib/article-factuality-gates.mjs` **su questo repo** — il file scende al '
    + 'corpus dal mirror, non risale.',
    '- Non abbassare le soglie e non cancellare il passaggio per far tacere il gate.',
  );

  let description = [...head, ...body, ...tail].join('\n');
  if (description.length > MAX_BODY_CHARS) {
    description = `${description.slice(0, MAX_BODY_CHARS)}\n\n… corpo troncato a ${MAX_BODY_CHARS} caratteri.`;
  }
  return { title: ISSUE_TITLE, description };
}

/** Job-summary markdown — written on every run, findings or not. */
export function buildStepSummary(report, escalated) {
  if (report.diffUnavailable) {
    return [
      '### ⚠️ Factuality: scope non calcolabile',
      '',
      'Il diff del working tree non è stato leggibile, quindi **nessun articolo è stato '
      + 'verificato** in questo sync. Non è un via libera.',
      '',
    ].join('\n');
  }
  if (!report.scanned) {
    return '### Factuality: nessun body articolo modificato in questo sync.\n';
  }
  const lines = [
    `### Factuality dei body sincronizzati — ${report.scanned} analizzati, `
    + `${report.flagged} segnalati, ${escalated.length} escalati`,
    '',
    '| body-locale | bloccanti | totali | codici |',
    '| --- | --- | --- | --- |',
  ];
  for (const f of report.findings.slice(0, MAX_ARTICLES_IN_BODY)) {
    const codes = [...new Set(f.issues.map((i) => i.code))].join(', ');
    lines.push(`| \`${f.id}\` [${f.locale}] | ${f.criticalCount} | ${f.issueCount} | ${codes} |`);
  }
  if (report.findings.length > MAX_ARTICLES_IN_BODY) {
    lines.push(`| … altri ${report.findings.length - MAX_ARTICLES_IN_BODY} | | | |`);
  }
  lines.push('', 'Report only — nessuna pubblicazione bloccata.', '');
  return lines.join('\n');
}

function writeStepSummary(text) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) {
    console.log(text);
    return;
  }
  try {
    appendFileSync(target, `${text}\n`);
  } catch (err) {
    console.error(`⚠️  step summary non scritto: ${err?.message || err}`);
  }
}

async function main() {
  const report = runAudit();
  const scope = issueScope();
  const escalated = report.diffUnavailable
    ? []
    : (report.findings || []).filter((f) => isEscalatable(f, scope));

  writeStepSummary(buildStepSummary(report, escalated));

  if (report.diffUnavailable) {
    // Loud on stdout too: a step summary is easy to miss and this is the state
    // in which the check covered nothing at all.
    console.error('⚠️  Scope non calcolabile — nessun articolo verificato in questo sync.');
    return 0;
  }
  console.log(
    `[factuality] ${report.scanned} body-locale sincronizzati, ${report.flagged} segnalati, `
    + `${escalated.length} escalati (scope=${scope}).`,
  );
  if (!escalated.length) return 0;

  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined;

  const { title, description } = buildReportIssue(report, escalated, runUrl);
  await createGithubIssue({
    title,
    description,
    priority: 2,
    labels: ['content-quality'],
    workflow: 'Sync article sitemaps, feeds and ticker from the articles API',
  });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // Never let reporting turn a tolerated finding into a stopped publish:
      // the sync must still commit. The step is `continue-on-error` too, so
      // this is belt and braces on purpose.
      console.error(
        '⚠️  report-synced-article-factuality failed (non-fatal):',
        err?.message || err,
      );
      process.exit(0);
    });
}
