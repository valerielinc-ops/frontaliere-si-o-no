#!/usr/bin/env node
/**
 * claim-issue-in-flight.mjs — zero-Claude MUTUAL-EXCLUSION pre-flight gate for issue-fix.yml.
 *
 * STRUCTURAL fix for the #4788/#4793 collision: an interactive/local Claude Code session
 * and the autonomous `issue-fix` fixer independently worked the SAME issue (#4788) at the
 * same time, producing two competing PRs (#4792 merged, #4793 a strict subset, closed as
 * duplicate). The only prior defense was a PROMPT-level instruction inside the fixer's own
 * Claude step ("check `gh pr list` for an open PR citing this issue before starting") —
 * evaluated deep in the agent's reasoning, AFTER checkout/npm-install/tier-classification,
 * and only able to see a competing PR that has *already been opened*. Two sessions starting
 * around the same time both see "no PR yet" and both proceed; #4793 was created well before
 * the (necessarily longer, since it included root-cause analysis + tests) local session had
 * anything to show for it. This gate replaces "detect the other side's finished PR" with a
 * real CLAIM staked the moment work starts: label `agent:in-progress`, checked-then-set as
 * the FIRST pre-flight step (before tier classification, before npm-heavy work), so the
 * collision window shrinks from "an entire Claude run" (minutes-hours) to "one gh API
 * round-trip" (seconds). The same label is the contract interactive/local sessions are
 * expected to honor too (see `/fix-issue` command + ISSUES.md "Fix flow") — whichever side
 * claims first wins; the other sees the label and skips before spending any turns/tokens.
 *
 * Output (GITHUB_OUTPUT): `in_flight=true|false`.
 *   - true  → label was ALREADY present (someone else claimed first) → issue-fix.yml skips
 *             every downstream step (tier/resume/Claude/telemetry/classify), zero quota
 *             spent. Does NOT touch the existing claim — not this run's to remove.
 *   - false → label was absent; THIS run just added it (claimed). issue-fix.yml proceeds
 *             normally. The paired "Release in-progress claim" step (`if: always()`, gated
 *             on this same output) removes it again on every terminal path so a dead/failed
 *             run never leaves the issue locked forever.
 *
 * PROCEED-SAFE (mirrors check-issue-already-resolved.mjs / check-workflows-scope.mjs): any
 * gh/API/parse fault → in_flight=false (assume nobody else claimed, let the normal fixer
 * run). The accepted risk here is a rare duplicate-work race — never a stranded issue.
 *
 * Env:
 *   GH_TOKEN      required for gh reads/writes (Actions GITHUB_TOKEN is enough).
 *   GH_REPO       optional `owner/repo` (else gh infers from cwd).
 *   ISSUE_NUMBER  required, the candidate issue.
 *   DRY_RUN       "1" → detect + print, no label/comment writes, still emits output.
 *   GITHUB_OUTPUT optional, Actions step output file.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DRY_RUN = process.env.DRY_RUN === '1';
const ISSUE = process.env.ISSUE_NUMBER;
const CLAIM_LABEL = 'agent:in-progress';

function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (allowFail) return '';
    throw e;
  }
}

const repoArgs = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];

function setOutput(inFlight) {
  console.log(`in_flight=${inFlight}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `in_flight=${inFlight}\n`);
  }
}

function main() {
  if (!ISSUE) {
    console.log('ISSUE_NUMBER not set — proceeding (no gate possible).');
    setOutput(false);
    return;
  }

  const raw = gh(['issue', 'view', ISSUE, ...repoArgs, '--json', 'labels'], { allowFail: true });
  if (!raw) {
    console.log('Issue fetch failed — proceeding (proceed-safe, cannot prove a claim exists).');
    setOutput(false);
    return;
  }

  let labels;
  try {
    labels = (JSON.parse(raw).labels || []).map((l) => l.name);
  } catch {
    console.log('Issue label parse failed — proceeding (proceed-safe).');
    setOutput(false);
    return;
  }

  if (labels.includes(CLAIM_LABEL)) {
    console.log(`Issue #${ISSUE}: \`${CLAIM_LABEL}\` already present → another session (interactive or a concurrent run) claimed it first. Skipping the Claude fixer, zero quota spent.`);
    if (!DRY_RUN) {
      const comment = `⏭️ **Pre-flight (auto, zero-Claude)**: questa issue porta già la label \`${CLAIM_LABEL}\` — un'altra sessione (interattiva o un run concorrente) l'ha reclamata per prima. Salto il fixer autonomo per evitare PR duplicate/in conflitto (classe #4788/#4793). Se il claim è stale (run morto senza rilascio), rimuovi \`${CLAIM_LABEL}\` a mano e ri-labella \`agent:fix\`.

<!-- FIX_OUTCOME: overlap-skip -->`;
      gh(['issue', 'comment', ISSUE, ...repoArgs, '--body', comment], { allowFail: true });
    }
    setOutput(true);
    return;
  }

  console.log(`Issue #${ISSUE}: no \`${CLAIM_LABEL}\` present — claiming now.`);
  if (!DRY_RUN) {
    gh(['label', 'create', CLAIM_LABEL, '--color', 'fbca04',
        '--description', 'Un fixer (CI o sessione interattiva) sta lavorando questa issue ORA — mutex anti-doppione (#4788/#4793)',
        ...repoArgs], { allowFail: true });
    gh(['issue', 'edit', ISSUE, ...repoArgs, '--add-label', CLAIM_LABEL], { allowFail: true });
  }
  setOutput(false);
}

// Run only as a CLI entrypoint (mirrors check-issue-already-resolved.mjs's guard).
//
// TOTAL / PROCEED-SAFE: an uncaught throw here must never strand the issue labeled
// `agent:fix` but undispatched. Any error → in_flight=false, exit 0 → the normal fixer
// (with the OLD, softer prompt-level check) runs unchanged — no worse than before this
// gate existed.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error('Claim gate error — proceeding (normal fixer runs):', e && e.message ? e.message : e);
    setOutput(false);
    process.exit(0);
  }
}
