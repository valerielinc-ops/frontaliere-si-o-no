#!/usr/bin/env node
/**
 * check-workflows-scope.mjs — zero-Claude PRE-FLIGHT capability guard for issue-fix.yml.
 *
 * STRUCTURAL partial fix for the recurring `fix-outcome:blocked-workflows-scope` burn
 * (escalation #3887, bucket 6×/14d: #3869 #3839 #3820 #3800 #3776). The autonomous
 * `issue-fix` agent repeatedly spent ~1M tokens diagnosing and implementing fixes that
 * require .github/workflows/** changes, only to fail at `git push` (GH_TOKEN lacks
 * `workflows` scope). The prose rule ("detect early, terminate") was not load-bearing.
 *
 * This script makes the detection EXECUTABLE and deterministic for issues that
 * EXPLICITLY cite .github/workflows/** paths in their body (code blocks, backtick refs,
 * Suggested action sections). For such issues it short-circuits BEFORE Claude runs,
 * posting the blocked comment + FIX_OUTCOME marker and emitting `workflows_blocked=true`
 * so the Claude job is skipped via its `if:` condition → zero Max OAuth quota spent.
 *
 * COMPLEMENT: The .githooks/pre-commit hook handles the harder case where the fix target
 * is discovered DURING diagnosis (agent implements, commits, hook fires at commit time
 * with a clear "use PAT" message). Both guards are needed:
 *   - This script: catches body-explicit paths → zero implementation tokens wasted.
 *   - pre-commit hook: catches diagnosis-discovered paths → implementation tokens spent
 *     but push/confusion tokens saved and a clean FIX_OUTCOME posted.
 *
 * WIRING (requires a human with `workflows` scope PAT — documented here as a PR diff):
 *   In .github/workflows/issue-fix.yml, add after the `preflight` step:
 *
 *     - name: Pre-flight — workflows-scope capability guard (zero-Claude)
 *       id: scope_guard
 *       continue-on-error: true
 *       env:
 *         GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
 *         GH_REPO: ${{ github.repository }}
 *         ISSUE_NUMBER: ${{ github.event.issue.number }}
 *       run: node scripts/ci/check-workflows-scope.mjs
 *
 *   Then add to the `Run Claude fix` step `if:` condition:
 *     && steps.scope_guard.outputs.workflows_blocked != 'true'
 *
 *   Also add to downstream steps that reference `already_resolved != 'true'`:
 *     && steps.scope_guard.outputs.workflows_blocked != 'true'
 *
 * PROCEED-SAFE (bias to proceed — a false positive silently drops a legitimate fix,
 * far worse than a false negative that lets the pre-commit hook or prose rule handle it):
 *   - Only triggers on EXPLICIT .github/workflows/** path mentions in backtick refs
 *     or code blocks. Prose mentions ("the workflow was failing") are ignored.
 *   - Any ambiguity or parse failure → emit workflows_blocked=false, proceed normally.
 *   - Aggregate issues are NOT short-circuited (one item non-blocked ≠ all safe).
 *
 * On detection: removes `agent:fix` label, adds `blocked-workflows-scope` advisory,
 * posts ONE comment with the paths found + FIX_OUTCOME marker. Does NOT close the issue.
 *
 * Output (GITHUB_OUTPUT): `workflows_blocked=true|false`.
 * issue-fix.yml gates the Claude step on `workflows_blocked != 'true'`.
 *
 * Env:
 *   GH_TOKEN       required for gh reads/writes
 *   GH_REPO        optional `owner/repo`
 *   ISSUE_NUMBER   required
 *   DRY_RUN        "1" → detect + print, no side effects, still emits output
 *   GITHUB_OUTPUT  optional Actions step output file
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DRY_RUN = process.env.DRY_RUN === '1';
const ISSUE = process.env.ISSUE_NUMBER;
const OUTCOME_MARKER = '<!-- FIX_OUTCOME: blocked-workflows-scope -->';
const BLOCKED_LABEL = 'blocked-workflows-scope';

function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    if (allowFail) return '';
    throw e;
  }
}

const repoArgs = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];

function setOutput(blocked) {
  console.log(`workflows_blocked=${blocked}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `workflows_blocked=${blocked}\n`);
  }
}

/**
 * Extract explicit .github/workflows/** path references from an issue body.
 *
 * Searches two high-precision locations:
 *   1. Backtick refs: `...path...` where the path starts with .github/workflows/
 *   2. Code blocks: fenced ``` or ~~~ blocks containing .github/workflows/ paths
 *
 * Intentionally DOES NOT search plain prose: "the traffic-scheduler workflow" or
 * "the crawlers' group workflows" must not trigger a false block.
 *
 * Returns an array of unique matched paths (empty if none found).
 */
export function extractWorkflowPaths(body) {
  const found = new Set();
  const text = body || '';

  // Pattern 1: backtick refs — `.github/workflows/foo.yml`
  // Matches anything inside backticks that starts with .github/workflows/
  for (const m of text.matchAll(/`(\.github\/workflows\/[^`\s]+)`/g)) {
    found.add(m[1]);
  }

  // Pattern 2: code block content — lines starting with (optional whitespace +) the path
  // Handles both ``` and ~~~ fences; path can appear as a filename, a key in YAML, etc.
  const codeBlockPattern = /(?:```|~~~)[^\n]*\n([\s\S]*?)(?:```|~~~)/g;
  for (const block of text.matchAll(codeBlockPattern)) {
    const content = block[1];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      // Match lines that start with the workflow path (possibly followed by : for YAML keys)
      if (/^\.github\/workflows\/\S+/.test(trimmed)) {
        // Extract just the path portion (stop at whitespace, :, or end of line)
        const match = trimmed.match(/^(\.github\/workflows\/[^\s:,'"]+)/);
        if (match) found.add(match[1]);
      }
      // Also match GitHub Actions file: annotations like "# file: .github/workflows/foo.yml"
      const fileAnnotation = trimmed.match(/file:\s*(\.github\/workflows\/\S+)/);
      if (fileAnnotation) found.add(fileAnnotation[1]);
    }
  }

  return [...found];
}

function main() {
  if (!ISSUE) {
    console.error('ISSUE_NUMBER not set — proceeding (no gate).');
    setOutput(false);
    return;
  }

  const raw = gh(
    ['issue', 'view', ISSUE, ...repoArgs, '--json', 'number,title,body,labels,state'],
    { allowFail: true },
  );
  if (!raw) {
    console.log('Issue fetch failed — proceeding.');
    setOutput(false);
    return;
  }

  let iss;
  try {
    iss = JSON.parse(raw);
  } catch {
    console.log('Issue parse failed — proceeding.');
    setOutput(false);
    return;
  }

  // Closed issues: issue-fix.yml already guards on OPEN state; this is belt-and-suspenders.
  if (String(iss.state || '').toUpperCase() === 'CLOSED') {
    console.log(`Issue #${ISSUE} is CLOSED — skip guard (no work on a closed issue).`);
    setOutput(false);
    return;
  }

  const body = iss.body || '';

  // Extract explicit .github/workflows/** path references from the issue body.
  const workflowPaths = extractWorkflowPaths(body);

  if (workflowPaths.length === 0) {
    // No explicit workflow paths → proceed. The pre-commit hook handles
    // fixes discovered during agent diagnosis.
    console.log(
      `Issue #${ISSUE}: no explicit .github/workflows/** paths in body — proceeding ` +
        `(pre-commit hook guards diagnosis-time discoveries).`,
    );
    setOutput(false);
    return;
  }

  // STRONG SIGNAL: explicit workflow paths found in the issue body.
  console.log(
    `Issue #${ISSUE}: BLOCKED — explicit .github/workflows/** paths found:\n` +
      workflowPaths.map((p) => `  ${p}`).join('\n'),
  );

  if (!DRY_RUN) {
    const pathList = workflowPaths.map((p) => `- \`${p}\``).join('\n');
    const comment =
      `⏭️ **Pre-flight (auto, zero-Claude) — blocco scope \`workflows\`**\n\n` +
      `L'issue body cita esplicitamente file in \`.github/workflows/\`:\n${pathList}\n\n` +
      `L'ambiente \`issue-fix.yml\` usa \`GH_TOKEN\` (GitHub App — nessun scope \`workflows\`): ` +
      `il push di questi file fallisce sempre. Fix richiede una PAT con scope \`workflows\` ` +
      `o intervento manuale.\n\n` +
      `Rimossa la label \`agent:fix\` (no re-dispatch). Gate strutturale #3887.\n\n` +
      OUTCOME_MARKER;

    gh(['issue', 'comment', ISSUE, ...repoArgs, '--body', comment], { allowFail: true });
    gh(['issue', 'edit', ISSUE, ...repoArgs, '--remove-label', 'agent:fix'], { allowFail: true });
    // Advisory label (best-effort — label may not exist yet)
    gh(
      [
        'label',
        'create',
        BLOCKED_LABEL,
        '--color',
        'e4e669',
        '--description',
        'Fix requires .github/workflows scope PAT — auto-fix skipped',
        ...repoArgs,
      ],
      { allowFail: true },
    );
    gh(['issue', 'edit', ISSUE, ...repoArgs, '--add-label', BLOCKED_LABEL], { allowFail: true });
  }

  setOutput(true);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(
      'Scope-guard error — proceeding (normal fixer runs):',
      e && e.message ? e.message : e,
    );
    setOutput(false);
    process.exit(0);
  }
}
