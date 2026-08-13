#!/usr/bin/env node
/**
 * report-synced-article-fabrication.mjs — run the curated
 * `article-fabrication-guard` denylist (institutions, acronyms, incorrect
 * facts, vague sourcing — see scripts/lib/article-fabrication-patterns.mjs)
 * over the article bodies `sync-articles-sitemaps.yml` has just pulled from
 * the corpus repo, in the window before it commits them to `main`.
 *
 * ── Why this exists (issue #5671) ────────────────────────────────────────
 *
 * `tests/article-fabrication-guard.test.ts` already catches this class of
 * defect — it is what caught, after the fact, both 2026-08-11 incidents this
 * issue names ("Ufficio federale del lavoro", the acronym "LTL"). But it only
 * ever runs inside `npm test`, and the sync job commits `packages/articles/
 * content` STRAIGHT TO `main` with NO PR:
 *
 *   - `pull_request` runs of tests.yml never see these bodies — there is no PR;
 *   - the `push: branches: [main]` run never even STARTS — the sync pushes
 *     with the workflow's own GITHUB_TOKEN and GitHub does not trigger
 *     workflows on such pushes;
 *   - and if it did start, a push has no base ref to diff against anyway.
 *
 * So the test that WOULD have caught both incidents at generation time never
 * ran on the one path that actually publishes. Both landed on `main`, and the
 * only symptom was `tests.yml` going red on unrelated, already-open PRs —
 * hours later, naming no article.
 *
 * This script is the SAME patterns run at the point they can still do
 * something useful: the sync job's own uncommitted working tree, between the
 * corpus pull and the commit. `scripts/lib/article-fabrication-patterns.mjs`
 * is the single definition both this script and the vitest test import, so
 * the two copies cannot drift apart (AGENTS.md #6).
 *
 * ── Why the delta, not the whole corpus ──────────────────────────────────
 *
 * The corpus is ~14.7k body files; the vitest test scans every one of them in
 * ~4s, so a full scan is not slow enough on its own to force this choice. The
 * reason is signal, the same one `report-synced-article-factuality.mjs`
 * already made: a full-corpus scan would re-report every pre-existing match
 * on every single sync (multiple times a day), drowning the one thing this
 * step exists to surface — an article that JUST landed. Scoping to what the
 * sync is about to commit (`changedArticleIdsWorktree()`, shared with
 * `audit-article-factuality.mjs`) keeps the report proportional to the event.
 *
 * ── Why it reports (and only optionally blocks) ──────────────────────────
 *
 * Whether an article-fabrication match should hold back the WHOLE synced
 * batch — sitemaps, ten RSS feeds and the news ticker included — is an owner
 * decision (see #5630, #5595, #5696: the same "block or signal?" question,
 * asked and not yet answered, three times). Measured 2026-08-13: this
 * curated denylist is high-signal (unlike the broader factuality gate, every
 * match here is a confirmed-fabricated string or a confirmed-wrong fact, not
 * a "might be unsupported" heuristic) but still unproven at production
 * volume — it has never run against live sync traffic before this PR.
 *
 * So: exit 1 when the delta contains a match — an honest signal, not a fake
 * one — but whether that exit code actually stops the job is controlled by
 * the workflow's `continue-on-error`, gated on the `ARTICLE_FABRICATION_GUARD_BLOCKING`
 * repository variable (OFF unless explicitly set to the literal string
 * `true`). Flip it in Settings → Secrets and variables → Actions → Variables.
 *
 * Usage:
 *   node scripts/ci/report-synced-article-fabrication.mjs
 * (after `pull-articles-corpus.mjs`, before the sync commit)
 */

import { appendFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { BODY_DIRS, changedArticleIdsWorktree } from '../lib/blog-body-io.mjs';
import { scanFabricationPatterns, extractTextContentFromSource } from '../lib/article-fabrication-patterns.mjs';
import { createGithubIssue, resolveGithubIssue } from '../lib/github-issue-creator.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'];

/** Stable across runs: dedup in github-issue-creator.mjs keys on the title. */
export const FINDINGS_ISSUE_TITLE =
  'Content fabrication: articoli sincronizzati con pattern noti di invenzione';

/**
 * Stable title for the DIFFERENT situation where this script could not even
 * compute its scope — i.e. the guard did not actually check the content that
 * is about to be published, whatever the reason. That is a distinct failure
 * from "checked, found nothing": the whole point of #5671 is that a guard
 * which silently stops covering the publish path is worse than no guard,
 * because it still looks green. Given to this script by the issue's own
 * scoping (field 5 of the tracking report) so a future reader of the open
 * issue and of this source agree on what it means.
 */
export const FAILURE_ISSUE_TITLE = 'guard di fabbricazione sganciato dal sync articoli';

const MAX_ARTICLES_IN_BODY = 30;

/**
 * Runs the fabrication-pattern scan over the article bodies touched in the
 * job's working tree (unstaged + staged + untracked — see
 * changedArticleIdsWorktree() for why all three).
 *
 * @returns {{ scanned: number, flagged: number, diffUnavailable: boolean, findings: object[] }}
 */
export function runFabricationScan() {
  const changedIds = changedArticleIdsWorktree();
  const diffUnavailable = changedIds === 'unavailable';
  const findings = [];
  let scanned = 0;

  if (!diffUnavailable) {
    for (const bodyDir of BODY_DIRS) {
      const itDir = path.join(bodyDir, 'it');
      if (!existsSync(itDir)) continue;
      // The Italian file list drives the walk, same as audit-article-factuality.mjs:
      // an id that only exists as a translation has no reference to name it by.
      for (const file of readdirSync(itDir).filter((f) => f.endsWith('.ts'))) {
        const id = file.replace('.ts', '');
        if (!changedIds.has(id)) continue;

        for (const locale of LOCALES) {
          const filePath = path.join(bodyDir, locale, file);
          if (!existsSync(filePath)) continue;
          scanned++;
          const text = extractTextContentFromSource(readFileSync(filePath, 'utf-8'));
          const violations = scanFabricationPatterns(text, locale);
          if (violations.length) {
            findings.push({ id, dir: bodyDir, locale, violations });
          }
        }
      }
    }
  }

  return { scanned, flagged: findings.length, diffUnavailable, findings };
}

/** One markdown line per finding. */
function renderFinding(f) {
  return [
    `### [${f.locale}] \`${f.id}\``,
    ...f.violations.map((v) => `- **${v.code}**: ${v.desc}\n  \`${v.evidence.replace(/`/g, "'")}\``),
    '',
  ];
}

/**
 * Markdown for the findings issue. Separate from the filing so a test can
 * assert the shape without touching GitHub.
 */
export function buildFindingsIssue(report, runUrl) {
  const shown = report.findings.slice(0, MAX_ARTICLES_IN_BODY);
  const head = [
    '## Articoli appena sincronizzati con pattern noti di fabbricazione',
    '',
    `\`tests/article-fabrication-guard.test.ts\` (via \`scripts/lib/article-fabrication-patterns.mjs\`) `
    + `ha segnalato **${report.findings.length}** body-locale sui ${report.scanned} appena tirati dal `
    + 'corpus (nanakokyobashi-rgb/frontaliere-articles) da `.github/workflows/sync-articles-sitemaps.yml`.',
    '',
    '**Nessuna pubblicazione è stata bloccata** a meno che la repository variable '
    + '`ARTICLE_FABRICATION_GUARD_BLOCKING` non sia impostata a `true` — vedi `scripts/ci/report-synced-article-fabrication.mjs`.',
    '',
    runUrl ? `Run: ${runUrl}` : '',
    '',
  ].filter((l) => l !== null);

  const body = shown.flatMap(renderFinding);
  const tail = [];
  if (report.findings.length > shown.length) {
    tail.push(`… altri ${report.findings.length - shown.length} body-locale segnalati in questo sync, non elencati qui.`, '');
  }
  tail.push(
    '## Suggested action',
    '',
    '- Le correzioni al TESTO si fanno nel repo del corpus '
    + '(`nanakokyobashi-rgb/frontaliere-articles`, `content/blog-body[-ch]/<locale>/<id>.ts`): '
    + 'una modifica fatta qui verrebbe sovrascritta dal prossimo sync.',
    '- Se è un falso positivo, correggi il pattern in `scripts/lib/article-fabrication-patterns.mjs` '
    + '**su questo repo** (il file scende al corpus dal mirror, non risale) e dichiaralo esplicitamente nella PR.',
  );

  return { title: FINDINGS_ISSUE_TITLE, description: [...head, ...body, ...tail].join('\n') };
}

/** Job-summary markdown — written on every run, findings or not. */
export function buildStepSummary(report) {
  if (report.diffUnavailable) {
    return [
      '### ⚠️ Fabrication guard: scope non calcolabile',
      '',
      'Il diff del working tree non è stato leggibile, quindi **nessun articolo è stato '
      + 'verificato** contro il denylist di fabbricazione in questo sync. Non è un via libera.',
      '',
    ].join('\n');
  }
  if (!report.scanned) {
    return '### Fabrication guard: nessun body articolo modificato in questo sync.\n';
  }
  const lines = [
    `### Fabrication guard sui body sincronizzati — ${report.scanned} analizzati, ${report.flagged} segnalati`,
    '',
  ];
  if (!report.flagged) {
    lines.push('Nessun pattern noto di fabbricazione trovato nel contenuto appena sincronizzato.', '');
    return lines.join('\n');
  }
  lines.push('| body-locale | codici |', '| --- | --- |');
  for (const f of report.findings.slice(0, MAX_ARTICLES_IN_BODY)) {
    const codes = [...new Set(f.violations.map((v) => v.code))].join(', ');
    lines.push(`| \`${f.id}\` [${f.locale}] | ${codes} |`);
  }
  if (report.findings.length > MAX_ARTICLES_IN_BODY) {
    lines.push(`| … altri ${report.findings.length - MAX_ARTICLES_IN_BODY} | |`);
  }
  const blocking = process.env.ARTICLE_FABRICATION_GUARD_BLOCKING === 'true';
  lines.push(
    '',
    blocking
      ? '🚫 ARTICLE_FABRICATION_GUARD_BLOCKING=true — questo step FALLISCE e blocca il commit del sync.'
      : 'Report only — nessuna pubblicazione bloccata (ARTICLE_FABRICATION_GUARD_BLOCKING è spento).',
    '',
  );
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

function runUrl() {
  return process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;
}

async function main() {
  const report = runFabricationScan();
  writeStepSummary(buildStepSummary(report));

  const workflow = 'Sync article sitemaps, feeds and ticker from the articles API';
  const url = runUrl();

  if (report.diffUnavailable) {
    // The guard did not check the content it exists to check — a distinct,
    // louder failure than "checked, found nothing". See FAILURE_ISSUE_TITLE.
    console.error('⚠️  Scope non calcolabile — nessun articolo verificato dal fabrication guard in questo sync.');
    await createGithubIssue({
      title: FAILURE_ISSUE_TITLE,
      description: [
        'Il fabrication guard non è riuscito a calcolare il diff del working tree in questo sync, quindi ',
        '**nessun body appena arrivato è stato verificato** contro `scripts/lib/article-fabrication-patterns.mjs`.',
        '',
        'Non è un "nessun problema trovato": è il guard che non ha girato affatto su questo batch.',
        '',
        url ? `Run: ${url}` : '',
      ].filter(Boolean).join('\n'),
      priority: 2,
      labels: ['content-quality'],
      workflow,
    });
    return 0;
  }

  // Scope WAS computable this run — the guard is connected. Auto-close a
  // stuck "disconnected" issue from an earlier run, same idiom as this
  // workflow's own "Clear the skip escalation" step.
  resolveGithubIssue(FAILURE_ISSUE_TITLE, { workflow, runUrl: url });

  console.log(
    `[fabrication-guard] ${report.scanned} body-locale sincronizzati, ${report.flagged} segnalati.`,
  );

  if (report.flagged) {
    const { title, description } = buildFindingsIssue(report, url);
    await createGithubIssue({ title, description, priority: 2, labels: ['content-quality'], workflow });
  }

  const blocking = process.env.ARTICLE_FABRICATION_GUARD_BLOCKING === 'true';
  if (report.flagged && blocking) {
    console.error(
      `🚫 ARTICLE_FABRICATION_GUARD_BLOCKING=true e ${report.flagged} body-locale segnalati — step in errore.`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // Never let a bug IN THE REPORTER turn into a stopped publish unless the
      // owner explicitly opted into blocking — and even then, a crash here is
      // not the same signal as a real finding, so it always falls through to
      // 0. The step is `continue-on-error` in signalling mode too; this is
      // belt and braces on the same invariant as report-synced-article-factuality.mjs.
      console.error('⚠️  report-synced-article-fabrication failed (non-fatal):', err?.message || err);
      process.exit(0);
    });
}
