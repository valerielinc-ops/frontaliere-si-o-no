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
 * Eccezione controllata: una PR parziale con `Addresses #<bucket>` +
 * `Follow-up item: FU-...` emette anche `followup_partial=true`, così il triage può
 * cercare finding nuovi nel bucket padre senza coniare un nipote.
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
 * Output (GITHUB_OUTPUT): `is_followup_fix=true|false`, `followup_partial=true|false`.
 * Uso:  node scripts/ci/is-followup-fix-pr.mjs
 * Env:  PR_NUMBER (richiesto), GH_REPO|GITHUB_REPOSITORY, GITHUB_OUTPUT (opzionale),
 *       FOLLOWUP_LABEL (default `follow-up`). Richiede `gh` in PATH.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  closedIssueRefs,
  dailyBucketInfo,
  followupItemDailyKey,
  followupItemMarkers,
  parseFollowupItems,
} from './followup-resolution-match.mjs';

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

function setOutput(isFollowupFix, { partial = false, parentNumbers = [] } = {}) {
  const values = [
    `is_followup_fix=${isFollowupFix}`,
    `followup_partial=${partial}`,
    `followup_parent_issues=${parentNumbers.join(',')}`,
  ];
  console.log(values.join('\n'));
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${values.join('\n')}\n`);
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

/** Stable item markers carried by a partial daily-bucket fix PR. */
export function followupItemMarkerIds(body) {
  return followupItemMarkers(body);
}

/** Parent follow-up issues explicitly addressed by a partial-fix PR. */
export function addressedFollowupNumbers(body) {
  const out = [];
  const seen = new Set();
  for (const match of String(body || '').matchAll(/\bAddresses\s+#(\d+)\b/gi)) {
    const number = Number(match[1]);
    if (Number.isInteger(number) && number > 0 && !seen.has(number)) {
      seen.add(number);
      out.push(number);
    }
  }
  return out;
}

/**
 * A partial daily fix is eligible for parent-bucket triage only when both stable
 * item identity and an explicit non-closing parent reference are present.
 */
export function isPartialDailyFollowupFix(body) {
  const markers = followupItemMarkerIds(body);
  const addressed = addressedFollowupNumbers(body);
  // The fixer circuit-breaker is one item and one parent per PR. Requiring the
  // singular shape here prevents a broad PR from entering the parent-bucket
  // exception merely because it mentions at least one valid marker.
  if (markers.length !== 1 || addressed.length !== 1) return false;
  // `Addresses` is deliberately non-closing. A body that also declares the same
  // parent through a GitHub closing keyword must not enter the parent-bucket path:
  // GitHub would close the bucket at merge before the other FU items are handled.
  const closing = new Set(closedIssueRefs(body));
  return !addressed.some((number) => closing.has(number));
}

const issueDetailsCache = new Map();

/** Read the parent shape once; unreadable data is never treated as a daily bucket. */
function issueDetails(n) {
  const number = Number(n);
  if (!Number.isInteger(number) || number <= 0) return null;
  if (issueDetailsCache.has(number)) return issueDetailsCache.get(number);
  const raw = gh(['issue', 'view', String(number), ...repoArgs, '--json', 'labels,title,body']);
  if (!raw) {
    issueDetailsCache.set(number, null);
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    const result = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    issueDetailsCache.set(number, result);
    return result;
  } catch {
    issueDetailsCache.set(number, null);
    return null;
  }
}

function isDailyFollowupParent(n, markerIds = []) {
  const issue = issueDetails(n);
  if (!issue || !Array.isArray(issue.labels) || !issue.labels.some((label) => label?.name === FOLLOWUP_LABEL)) return false;
  const info = dailyBucketInfo(issue.title || '');
  if (!info) return false;
  // A PR carries `Follow-up item: FU-...`, while the parent bucket carries the
  // same identity in its stable `### FU-... — ...` heading.  Looking only for
  // the PR marker made descriptive branches appear organic even when they
  // explicitly addressed a real daily bucket.
  const parentIds = new Set([
    ...followupItemMarkerIds(issue.body || ''),
    ...parseFollowupItems(issue.body || '').map((item) => item.id).filter(Boolean),
  ]);
  return markerIds.every((id) => followupItemDailyKey(id) === info.dailyKey && parentIds.has(id));
}

/** True if issue #n carries the follow-up label. Proceed-safe: unreadable → false. */
function issueHasFollowupLabel(n) {
  const raw = gh(['issue', 'view', String(n), ...repoArgs, '--json', 'labels']);
  if (!raw) return false;
  try {
    const labels = JSON.parse(raw).labels || [];
    return labels.some((label) => label?.name === FOLLOWUP_LABEL);
  } catch {
    return false;
  }
}

export function main() {
  if (!PR || !/^\d+$/.test(String(PR).trim())) {
    console.log('No valid PR_NUMBER — proceed-safe (run triage).');
    return setOutput(false);
  }

  const raw = gh(['pr', 'view', String(PR), ...repoArgs, '--json', 'headRefName,body,title']);
  if (!raw) {
    console.log(`PR #${PR}: head ref unreadable — proceed-safe (run triage).`);
    return setOutput(false);
  }

  let branch = '';
  let body = '';
  try {
    const pr = JSON.parse(raw);
    branch = pr.headRefName || '';
    body = pr.body || '';
  } catch {
    console.log(`PR #${PR}: head ref unparseable — proceed-safe (run triage).`);
    return setOutput(false);
  }

  const issueN = fixIssueNumberFromBranch(branch);
  const itemMarkers = followupItemMarkerIds(body);
  const addressed = addressedFollowupNumbers(body);
  const partialDailyShape = isPartialDailyFollowupFix(body);
  // The fixer normally names its parent in `fix/issue-<N>`, but a daily item
  // may intentionally use a descriptive branch (`fix/daily-seo`).  In that
  // shape the `Addresses #bucket` + stable item marker is the authoritative
  // parent signal; resolve it before the organic-branch early return.
  const partialParent = partialDailyShape
    ? addressed.find((number) => isDailyFollowupParent(number, itemMarkers))
    : null;
  if (issueN === null) {
    if (partialParent) {
      console.log(
        `PR #${PR}: partial daily follow-up fix (${itemMarkers.join(', ')}) uses descriptive branch `
        + `'${branch}' and addresses bucket #${partialParent} without a Closes keyword → grandchild-suppression gate active.`,
      );
      return setOutput(true, { partial: true, parentNumbers: [partialParent] });
    }
    console.log(`PR #${PR}: branch '${branch}' is not a fix/issue-<N> fixer branch — organic PR, run triage.`);
    return setOutput(false);
  }

  const canonicalFollowup = issueN !== null && issueHasFollowupLabel(issueN);
  if (!canonicalFollowup) {
    // A daily bucket partial fix may use a descriptive branch. Its stable item marker
    // is meaningful only together with an explicit Addresses #bucket reference; query
    // that parent and keep the proceed-safe default if either side is unreadable.
    if (!partialDailyShape) {
      console.log(`PR #${PR}: fixes issue #${issueN} but it is not a follow-up — organic fix, run triage.`);
      return setOutput(false);
    }
    const parent = partialParent;
    if (!parent) {
      console.log(`PR #${PR}: Follow-up item marker(s) ${itemMarkers.join(', ')} have no readable daily follow-up parent — proceed-safe, run triage.`);
      return setOutput(false);
    }
    console.log(
      `PR #${PR}: partial daily follow-up fix (${itemMarkers.join(', ')}) addresses bucket #${parent} ` +
      `without a Closes keyword → grandchild-suppression gate active.`,
    );
    return setOutput(true, { partial: true, parentNumbers: [parent] });
  }

  // The canonical fixer branch identifies its parent issue, but the partial
  // exception is daily-only and must still prove that the body names that same
  // bucket and item. A normal legacy follow-up fix remains fully suppressed.
  const canonicalDaily = partialDailyShape
    && addressed.includes(issueN)
    && isDailyFollowupParent(issueN, itemMarkers);

  console.log(
    `PR #${PR}: branch '${branch}' fixes follow-up #${issueN} → this is a follow-up FIX. ` +
    `Skipping triage to break the grandchild self-feed.`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Grandchild-suppression gate: PR #${PR} is a follow-up fix\n` +
      (canonicalDaily
        ? `Branch \`${branch}\` carries a daily item marker → parent-bucket triage only ` +
          `(no grandchild follow-up minted).\n`
        : `Branch \`${branch}\` fixes follow-up #${issueN} → triage skipped ` +
          `(no grandchild follow-up minted, 1 Claude run saved).\n`),
    );
  }
  return setOutput(true, { partial: canonicalDaily, parentNumbers: canonicalDaily ? [issueN] : addressed });
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
