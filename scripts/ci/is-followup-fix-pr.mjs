/**
 * is-followup-fix-pr.mjs — grandchild-suppression gate (zero-Claude, deterministico).
 *
 * Rompe il SELF-FEED del loop follow-up. `post-merge-followup.yml` gira su OGNI PR
 * mergiata dall'owner — incluse le PR che FIXANO un follow-up. Quindi:
 *
 *     follow-up #A → fix PR → merge → reviewer lascia un 🟡 → nuovo follow-up #B (nipote)
 *
 * è self-perpetuante by-construction: il fix di un follow-up può sempre generarne un
 * altro. Con ~357 PR mergiate / 7gg e ~156 follow-up/7gg auto-generate (×~3 run Claude
 * l'una: triage → issue-fix → pr-review), il treadmill brucia ~470 run/sett sulla quota
 * Max OAuth CONDIVISA con la sessione interattiva owner (AGENTS.md § frugalità).
 *
 * Questo gate, eseguito PRIMA dello step Claude di triage, emette `is_followup_fix=true`
 * quando la PR mergiata dichiara di chiudere/superare (`Closes`/`Fixes`/`Resolves`/
 * `Supersedes #N`) almeno una issue con label `follow-up`. Il workflow salta interamente
 * il triage → niente nipote + run Claude risparmiata. Lo scope deferred di un fix-di-
 * follow-up, se reale, appartiene alla issue follow-up PADRE (che resta aperta finché non
 * risolta del tutto): non va mintato un nipote.
 *
 * PROCEED-SAFE (direzione opposta al gate already-resolved): nel dubbio NON skippare. Se
 * il body PR è illeggibile, i ref non si parsano, o `gh issue view` fallisce → emetti
 * `false` → il triage gira normalmente. Meglio over-mintare (un follow-up in più, drenato
 * dai meccanismi di convergenza) che perdere un follow-up legittimo di una PR organica.
 * Una sola label sbagliata costa una run; un follow-up perso costa scope funnel.
 *
 * Output (GITHUB_OUTPUT): `is_followup_fix=true|false`.
 * Uso:  node scripts/ci/is-followup-fix-pr.mjs
 * Env:  PR_NUMBER (richiesto), GH_REPO|GITHUB_REPOSITORY, GITHUB_OUTPUT (opzionale),
 *       FOLLOWUP_LABEL (default `follow-up`). Richiede `gh` in PATH.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { closedIssueRefs } from './followup-resolution-match.mjs';

const PR = process.env.PR_NUMBER;
const FOLLOWUP_LABEL = process.env.FOLLOWUP_LABEL || 'follow-up';
const repoArgs = (process.env.GH_REPO || process.env.GITHUB_REPOSITORY)
  ? ['--repo', process.env.GH_REPO || process.env.GITHUB_REPOSITORY]
  : [];

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return ''; // proceed-safe: any gh fault → treated as "can't confirm" → false.
  }
}

function setOutput(isFollowupFix) {
  console.log(`is_followup_fix=${isFollowupFix}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `is_followup_fix=${isFollowupFix}\n`);
  }
}

/** True if issue #n carries the follow-up label. Proceed-safe: unreadable → false. */
function issueHasFollowupLabel(n) {
  const raw = gh(['issue', 'view', String(n), ...repoArgs, '--json', 'labels']);
  if (!raw) return false;
  try {
    const labels = JSON.parse(raw).labels || [];
    return labels.some((l) => l.name === FOLLOWUP_LABEL);
  } catch {
    return false;
  }
}

export function main() {
  if (!PR || !/^\d+$/.test(String(PR).trim())) {
    console.log('No valid PR_NUMBER — proceed-safe (run triage).');
    return setOutput(false);
  }

  const raw = gh(['pr', 'view', String(PR), ...repoArgs, '--json', 'title,body']);
  if (!raw) {
    console.log(`PR #${PR}: body unreadable — proceed-safe (run triage).`);
    return setOutput(false);
  }

  let title = '';
  let body = '';
  try {
    const pr = JSON.parse(raw);
    title = pr.title || '';
    body = pr.body || '';
  } catch {
    console.log(`PR #${PR}: body unparseable — proceed-safe (run triage).`);
    return setOutput(false);
  }

  const refs = closedIssueRefs(`${title}\n${body}`);
  if (!refs.length) {
    console.log(`PR #${PR}: no closing-keyword issue refs — organic PR, run triage.`);
    return setOutput(false);
  }

  const followupRefs = refs.filter(issueHasFollowupLabel);
  if (followupRefs.length) {
    console.log(
      `PR #${PR}: closes follow-up issue(s) ${followupRefs.map((n) => `#${n}`).join(', ')} ` +
      `→ this is a follow-up FIX. Skipping triage to break the grandchild self-feed.`,
    );
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Grandchild-suppression gate: PR #${PR} is a follow-up fix\n` +
        `Closes follow-up ${followupRefs.map((n) => `#${n}`).join(', ')} → triage skipped ` +
        `(no grandchild follow-up minted, 1 Claude run saved).\n`,
      );
    }
    return setOutput(true);
  }

  console.log(`PR #${PR}: closes #${refs.join(', #')} but none are follow-up → organic PR, run triage.`);
  return setOutput(false);
}

// CLI entrypoint only (importing for tests must not invoke gh). Proceed-safe: any
// uncaught error → emit false (run triage), never strand a real follow-up.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.log(`is-followup-fix-pr: unexpected error (${e?.message || e}) — proceed-safe (run triage).`);
    setOutput(false);
  }
}
