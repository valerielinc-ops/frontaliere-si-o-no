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
 * SEGNALE = il BRANCH della PR, non il body. La self-feed proviene dal fixer autonomo
 * (`issue-fix.yml`), che lavora SEMPRE su un branch `fix/issue-<N>` (vedi
 * `issue-fix.yml → "Branch isolato: git checkout -b fix/issue-$ISSUE_NUMBER"`). Se #N
 * porta la label `follow-up`, la PR è un fix-di-follow-up → il suo merge minterebbe un
 * NIPOTE → questo gate emette `is_followup_fix=true` e il workflow salta il triage.
 *
 * Perché il branch e NON il body (`Closes #N`): qualunque "closes #N" nella PROSA del
 * body — anche dentro una frase che descrive un'ALTRA PR ("PR #2181 (closes #2177)") —
 * verrebbe parsato come closing-ref reale (lo fa anche GitHub stesso via
 * closingIssuesReferences) → falso positivo che SKIPPA il triage di una PR organica con
 * scope `## Non implementato` reale (regressione osservata in prod su PR #2214, che
 * citava "closes #2177" come esempio di validazione). Il nome del branch non è prosa:
 * non può contenere una citazione accidentale, quindi è immune. Costo: un fix-di-
 * follow-up fatto a mano su un branch NON-`fix/issue-*` non viene skippato (raro, basso
 * volume, e probabilmente PORTA scope nuovo → ok triagiarlo). La self-feed ad alto
 * volume — il fixer autonomo — è coperta al 100%.
 *
 * PROCEED-SAFE: nel dubbio NON skippare. Branch non-`fix/issue-*`, illeggibile, o
 * `gh issue view` in errore → `false` → il triage gira. Meglio over-mintare (un
 * follow-up in più, drenato dai meccanismi di convergenza) che perdere un follow-up
 * legittimo di una PR organica.
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

/**
 * The issue number targeted by an autonomous-fixer branch `fix/issue-<N>` (optionally
 * with a `-slug` suffix, e.g. `fix/issue-2177-staticoverlay-hreflang`), or null.
 *
 * Pure (no I/O) → unit-testable. Immune to prose: a branch name cannot carry an
 * accidental `closes #N` citation, so this never false-positives on an organic PR that
 * merely mentions a follow-up in its body.
 *
 * @param {string} branch  head ref name
 * @returns {number|null}
 */
export function fixIssueNumberFromBranch(branch) {
  const m = /^fix\/issue-(\d+)(?:-|$)/.exec(String(branch || '').trim());
  return m ? Number(m[1]) : null;
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

  const raw = gh(['pr', 'view', String(PR), ...repoArgs, '--json', 'headRefName']);
  if (!raw) {
    console.log(`PR #${PR}: head ref unreadable — proceed-safe (run triage).`);
    return setOutput(false);
  }

  let branch = '';
  try {
    branch = JSON.parse(raw).headRefName || '';
  } catch {
    console.log(`PR #${PR}: head ref unparseable — proceed-safe (run triage).`);
    return setOutput(false);
  }

  const issueN = fixIssueNumberFromBranch(branch);
  if (issueN === null) {
    console.log(`PR #${PR}: branch '${branch}' is not a fix/issue-<N> fixer branch — organic PR, run triage.`);
    return setOutput(false);
  }

  if (!issueHasFollowupLabel(issueN)) {
    console.log(`PR #${PR}: fixes issue #${issueN} but it is not a follow-up — organic fix, run triage.`);
    return setOutput(false);
  }

  console.log(
    `PR #${PR}: branch '${branch}' fixes follow-up #${issueN} → this is a follow-up FIX. ` +
    `Skipping triage to break the grandchild self-feed.`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Grandchild-suppression gate: PR #${PR} is a follow-up fix\n` +
      `Branch \`${branch}\` fixes follow-up #${issueN} → triage skipped ` +
      `(no grandchild follow-up minted, 1 Claude run saved).\n`,
    );
  }
  return setOutput(true);
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
