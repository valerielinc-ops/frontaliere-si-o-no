/**
 * sibling-check-gate.mjs — PreToolUse hook: blocks `gh pr create` when
 * check-sibling-patterns.mjs finds uncovered sibling files that have NOT been
 * declared as false positives in the PR body's `## Non implementato` section.
 *
 * False-positive filter (issue #3325): a candidate is a genuine sibling only
 * when it is NOT explicitly invoked as a false positive (AGENTS.md #6 escape
 * hatch: "solo lessicalmente simile ma semanticamente diverso" / "falso
 * positivo"). Mere deferral ("will fix in follow-up") is NOT a false positive —
 * the gate still blocks on it, consistently with AGENTS.md #8 (deferral ≠
 * closure). Mirrors the analogous isGenuinePrBodyContractViolation filter in
 * pr-body-check-gate.mjs (shipped in #3332).
 *
 * Fail-safe: any internal error → exit 0 (never block PR on script failure).
 *
 * Exit codes are Claude Code hook semantics, NOT Unix convention: for
 * PreToolUse only **2** blocks the tool call. 1 is a "non-blocking error" —
 * stderr is shown and `gh pr create` runs anyway. This gate printed
 * "PR bloccata" and exited 1, so it had never actually blocked anything; the
 * message asserted an enforcement that did not happen, which is the same
 * class of defect as the silent skip below (#5195) — a guard that reads as a
 * guard without being one. Use EXIT_BLOCK, never a bare 1.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, resolve } from 'node:path';
import { extractPrBody } from './pr-body-check-gate.mjs';
import { FALSE_POSITIVE_DECLARATION_RE } from './lib/false-positive-declaration.mjs';
import {
  ALLOW_UNRESOLVED_ENV,
  unresolvedBaseOverrideActive,
} from './lib/resolve-merge-base.mjs';
import { EXIT_BLOCK } from './lib/hook-exit-codes.mjs';
import { resolveHookTargetCwd } from './lib/hook-target-cwd.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const checkScript = join(__dirname, 'check-sibling-patterns.mjs');

/**
 * Extract the text under `## Non implementato` from a PR body (up to the next
 * `##` section or end-of-string). Returns empty string when the section is absent.
 */
function extractNonImplementato(body) {
  const m = /#{2,3}\s+Non implementato[^\n]*([\s\S]*?)(?=\n#{2,3}|\s*$)/i.exec(body);
  return m ? m[1] : '';
}

/**
 * Full path (dir/basename, last 2 segments) match against a bare-basename
 * mention in the PR body that names a DIFFERENT full path. Disambiguates
 * same-named files in different directories (e.g. `scripts/lib/scoring/
 * constants.mjs` vs `scripts/ci/lib/constants.mjs`): a basename-only FP
 * declaration for one must NOT be read as covering the other.
 */
function lineNamesADifferentPath(line, candidatePath, fname) {
  const pathRe = /(?:^|[\s`"'(])((?:[\w.-]+\/)+[\w.-]+)/g;
  let m;
  while ((m = pathRe.exec(line))) {
    if (basename(m[1]) === fname && m[1] !== candidatePath) return true;
  }
  return false;
}

/**
 * True if `candidatePath` is explicitly declared a false positive in the
 * `## Non implementato` section text. Only AGENTS.md #6 escape-hatch language
 * qualifies (see FALSE_POSITIVE_DECLARATION_RE); bare file mentions or
 * deferral notes ("will fix in follow-up") do NOT — those remain genuine
 * unaddressed siblings. A basename-only match is rejected when the line names
 * a full path for a DIFFERENT file with the same basename.
 */
export function isDeclaredFalsePositive(candidatePath, nonImplText) {
  if (!nonImplText || !candidatePath) return false;
  const fname = basename(candidatePath);
  const lines = nonImplText.split('\n').filter((l) => {
    if (l.includes(candidatePath)) return true;
    if (fname.length > 3 && l.includes(fname)) {
      return !lineNamesADifferentPath(l, candidatePath, fname);
    }
    return false;
  });
  return lines.some((l) => FALSE_POSITIVE_DECLARATION_RE.test(l));
}

async function main() {
  let command = '';
  let targetCwd;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (raw) {
      try {
        const payload = JSON.parse(raw);
        command =
          payload?.tool_input?.command ??
          payload?.command ??
          '';
        targetCwd = resolveHookTargetCwd(payload);
      } catch {
        command = raw; // raw text fallback — grep for gh pr create
      }
    }
  } catch {
    process.exit(0); // stdin failure → fail-safe
  }

  if (!command.includes('gh pr create')) {
    process.exit(0);
  }

  // Run check-sibling-patterns.mjs --json to get the structured candidate list.
  // `cwd: targetCwd` (see lib/hook-target-cwd.mjs) makes it analyze the
  // worktree the gated `gh pr create` is actually running in, not whatever
  // ambient directory this hook subprocess itself was launched from.
  let jsonOutput;
  try {
    jsonOutput = execFileSync('node', [checkScript, '--json'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      // Capture stdout (parsed as JSON); let stderr propagate for progress messages.
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: targetCwd,
    });
  } catch {
    process.exit(0); // check script error → fail-safe
  }

  let candidates;
  let result;
  try {
    result = JSON.parse(jsonOutput);
    candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  } catch {
    process.exit(0); // JSON parse error → fail-safe
  }

  // Issue #5195, second half. check-sibling-patterns.mjs emits
  // `skipped: true` when it could not compute a merge-base — a deliberate
  // "I did not run" signal. This gate used to read only `candidates` and so
  // treated that as `candidates.length === 0` → exit 0, ZERO output, PR
  // created. That is the failure mode the shallow-clone fix was supposed to
  // remove, not relocate: 640 false positives at least got read, a silent
  // all-clear never does. An un-run analysis blocks, and says so.
  if (result?.skipped) {
    const override = unresolvedBaseOverrideActive();
    process.stderr.write(
      `\n🚫 sibling-check-gate: sweep sibling NON ESEGUITO (${result.reason ?? 'sconosciuto'}).\n` +
        'Nessun file gemello è stato verificato: questo NON equivale a "nessun candidato".\n' +
        (override
          ? `${ALLOW_UNRESOLVED_ENV} attivo → PR consentita senza verifica sibling (scelta dichiarata).\n\n`
          : 'Rimedio: `git fetch --deepen=500 origin` (clone shallow) e riprova, oppure\n' +
            `procedi deliberatamente con ${ALLOW_UNRESOLVED_ENV}=1.\n\n`),
    );
    process.exit(override ? 0 : EXIT_BLOCK);
  }

  if (candidates.length === 0) {
    process.exit(0); // no sibling candidates → allow PR creation
  }

  // Extract PR body for the false-positive filter. If we can't parse the body
  // (undefined), fall back to treating all candidates as genuine (conservative,
  // same behaviour as the old --strict mode) — never silently drop a real check.
  // `targetCwd` resolves a relative `--body-file` against the worktree the
  // gated command is in, same fix as the check-script invocation above.
  let prBody;
  try {
    prBody = extractPrBody(command, targetCwd);
  } catch {
    // body extraction error → conservative: treat all candidates as genuine
  }

  let genuineCandidates = candidates;
  if (prBody !== undefined) {
    const nonImplText = extractNonImplementato(prBody);
    genuineCandidates = candidates.filter(
      (c) => !isDeclaredFalsePositive(c.file, nonImplText),
    );
  }

  if (genuineCandidates.length === 0) {
    // All candidates declared false positives in ## Non implementato → allow.
    process.exit(0);
  }

  // Print the genuine candidate list for the fixer to inspect.
  process.stdout.write(
    `\n⚠ ${genuineCandidates.length} file gemello/i NON toccato/i condivide/ono costrutti modificati da questo branch:\n\n`,
  );
  for (const c of genuineCandidates) {
    process.stdout.write(`  ${c.file}\n`);
    if (c.tokens?.length) {
      process.stdout.write(`      costrutti condivisi: ${c.tokens.join(', ')}\n`);
    }
  }

  process.stderr.write(
    '\n\u{1F6AB} sibling-check-gate: PR bloccata — file gemello/i non coperti trovati.\n' +
      'Ispeziona i candidati sopra e includi il fix nella STESSA PR (AGENTS.md #6),\n' +
      'oppure giustifica in `## Non implementato` con linguaggio esplicito di falso\n' +
      'positivo (es. "falso positivo — solo lessicalmente simile ma semanticamente\n' +
      'diverso"). Un semplice rinvio a follow-up NON bypassa questo gate.\n\n',
  );
  process.exit(EXIT_BLOCK);
}

// Only run when executed directly (e.g. as a PreToolUse hook), not on import.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main();
}
