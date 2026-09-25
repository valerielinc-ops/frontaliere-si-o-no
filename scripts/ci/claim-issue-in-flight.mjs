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
 * Output (GITHUB_OUTPUT): `in_flight=true|false`, `claim_acquired=true|false`,
 * `claim_owner=local|remote|unknown|contended|''`, `claim_error=true|false`.
 *   - true  → label was ALREADY present (someone else claimed first) → issue-fix.yml skips
 *             every downstream step (tier/resume/Claude/telemetry/classify), zero quota
 *             spent. Does NOT touch the existing claim — not this run's to remove.
 *   - false → label was absent; THIS run just added it (claimed). issue-fix.yml proceeds
 *             normally. The paired "Release in-progress claim" step (`if: always()`, gated
 *             on this same output) removes it again on every terminal path so a dead/failed
 *             run never leaves the issue locked forever.
 *
 * LOCAL/REMOTE OWNERSHIP: the base mutex alone cannot tell a local session from the
 * remote fixer. Both paths therefore add their own visible owner label. A release
 * removes only a claim carrying the same owner label; in particular, the remote
 * workflow can never clear a local claim.
 *
 * FAIL-CLOSED: a gh/API/parse fault → `in_flight=true`, `claim_acquired=false` and
 * `claim_error=true`. Proceeding on an unreadable mutex was the unsafe direction:
 * it can create two PRs and the old release step could then remove the other claim.
 *
 * Env:
 *   GH_TOKEN      required for gh reads/writes (Actions GITHUB_TOKEN is enough).
 *   GH_REPO       optional `owner/repo` (else gh infers from cwd).
 *   ISSUE_NUMBER  required, the candidate issue.
 *   DRY_RUN       "1" → detect + print, no label/comment writes, still emits output.
 *   CLAIM_ACTION  "acquire" (default) or "release".
 *   CLAIM_OWNER   "remote" (default) or "local".
 *   GITHUB_OUTPUT optional, Actions step output file.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DRY_RUN = process.env.DRY_RUN === '1';
const ISSUE = process.env.ISSUE_NUMBER;
const CLAIM_LABEL = 'agent:in-progress';
const OWNER_LABELS = Object.freeze({ local: 'agent:local', remote: 'agent:remote' });
const CLAIM_ACTION = process.env.CLAIM_ACTION === 'release' ? 'release' : 'acquire';
const CLAIM_OWNER = process.env.CLAIM_OWNER === 'local' ? 'local' : 'remote';
const OWNER_LABEL = OWNER_LABELS[CLAIM_OWNER];

function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (allowFail) return '';
    throw e;
  }
}

const repoArgs = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];

function setOutput(inFlight, claimAcquired = false, owner = '', claimError = false) {
  const values = {
    in_flight: inFlight,
    claim_acquired: claimAcquired,
    claim_owner: owner,
    claim_error: claimError,
  };
  for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n',
    );
  }
}

function ownerFromLabels(labels) {
  const owners = Object.entries(OWNER_LABELS)
    .filter(([, label]) => labels.includes(label))
    .map(([owner]) => owner);
  if (owners.length > 1) return 'contended';
  if (owners.length === 1) return owners[0];
  return labels.includes(CLAIM_LABEL) ? 'unknown' : '';
}

function isOccupied(labels) {
  return labels.includes(CLAIM_LABEL) || Object.values(OWNER_LABELS).some((label) => labels.includes(label));
}

function commentOverlap(labels) {
  const owner = ownerFromLabels(labels);
  return '⏭️ **Pre-flight (auto, zero-Claude)**: questa issue è già occupata dal claim `' +
    '`' + CLAIM_LABEL + '` (owner: `' + (owner || 'unknown') + '`). Non avvio il fixer per evitare ' +
    'PR duplicate/in conflitto. Rimuovere il claim solo dopo aver verificato che il lavoro ' +
    'non sia più attivo.';
}

function readLabels() {
  const raw = gh(['issue', 'view', ISSUE, ...repoArgs, '--json', 'labels'], { allowFail: true });
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.labels)) return null;
    const labels = parsed.labels.map((label) => String(label?.name || '')).filter(Boolean);
    return labels;
  } catch {
    return null;
  }
}

function release(labels) {
  const owner = ownerFromLabels(labels);
  if (owner !== CLAIM_OWNER) {
    console.log('Release ignorato: il claim appartiene a `' + (owner || 'unknown') + '`, non a `' + CLAIM_OWNER + '`.');
    setOutput(isOccupied(labels), false, owner);
    return;
  }
  if (!DRY_RUN) {
    const remove = [OWNER_LABEL];
    const otherOwner = Object.entries(OWNER_LABELS)
      .filter(([name]) => name !== CLAIM_OWNER)
      .some(([, label]) => labels.includes(label));
    if (!otherOwner && labels.includes(CLAIM_LABEL)) remove.push(CLAIM_LABEL);
    const removeArgs = remove.flatMap((label) => ['--remove-label', label]);
    gh(['issue', 'edit', ISSUE, ...repoArgs, ...removeArgs]);
  }
  console.log('Release claim `' + CLAIM_OWNER + '` su issue #' + ISSUE + '.');
  setOutput(false, false, CLAIM_OWNER);
}

function main() {
  if (!/^\d+$/.test(String(ISSUE || ''))) {
    console.log('ISSUE_NUMBER missing or invalid — fail-closed: no fixer and no release.');
    setOutput(true, false, 'unknown', true);
    return;
  }

  const labels = readLabels();
  if (!labels) {
    console.log('Issue fetch/label parse failed — fail-closed: no fixer and no release.');
    setOutput(true, false, 'unknown', true);
    return;
  }

  if (CLAIM_ACTION === 'release') {
    release(labels);
    return;
  }

  if (isOccupied(labels)) {
    const owner = ownerFromLabels(labels);
    console.log(`Issue #${ISSUE}: claim già presente (owner=${owner || 'unknown'}) → skip fixer, zero quota.`);
    if (!DRY_RUN) {
      gh(['issue', 'comment', ISSUE, ...repoArgs, '--body', `${commentOverlap(labels)}\n\n<!-- FIX_OUTCOME: overlap-skip -->`], { allowFail: true });
    }
    setOutput(true, false, owner);
    return;
  }

  console.log(`Issue #${ISSUE}: nessun claim — acquisisco owner=\`${CLAIM_OWNER}\`.`);
  if (!DRY_RUN) {
    gh(['label', 'create', CLAIM_LABEL, '--color', 'fbca04',
        '--description', 'Un fixer (CI o sessione interattiva) sta lavorando questa issue ORA — mutex anti-doppione (#4788/#4793)',
        ...repoArgs], { allowFail: true });
    gh(['label', 'create', OWNER_LABEL, '--color', CLAIM_OWNER === 'local' ? '1d76db' : '5319e7',
        '--description', `Claim ${CLAIM_OWNER}: indica chi sta lavorando la issue; accompagna ${CLAIM_LABEL}`,
        ...repoArgs], { allowFail: true });
    gh(['issue', 'edit', ISSUE, ...repoArgs, '--add-label', CLAIM_LABEL, '--add-label', OWNER_LABEL]);

    // Checked-then-set cannot be made atomic with the GitHub labels API. Re-read
    // immediately: if local and remote raced, neither side is allowed to proceed.
    const after = readLabels();
    if (!after) throw new Error('claim verification failed after label write');
    const owner = ownerFromLabels(after);
    if (owner !== CLAIM_OWNER || !after.includes(CLAIM_LABEL)) {
      console.log(`Issue #${ISSUE}: claim conteso/non verificabile (owner=${owner || 'unknown'}) → skip.`);
      setOutput(true, false, owner || 'unknown');
      return;
    }
  }
  setOutput(false, !DRY_RUN, CLAIM_OWNER);
}

// Run only as a CLI entrypoint (mirrors check-issue-already-resolved.mjs's guard).
//
// TOTAL / FAIL-CLOSED: an uncaught throw must never make the fixer assume that the
// mutex is free. A partial label write remains visible to the stale-claim detector;
// the current run skips rather than risking a duplicate PR.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error('Claim gate error — fail-closed (fixer skipped):', e && e.message ? e.message : e);
    setOutput(true, false, 'unknown', true);
    process.exit(0);
  }
}
