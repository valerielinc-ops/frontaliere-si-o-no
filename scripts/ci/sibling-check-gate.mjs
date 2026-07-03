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
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, resolve } from 'node:path';
import { extractPrBody } from './pr-body-check-gate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const checkScript = join(__dirname, 'check-sibling-patterns.mjs');

// Explicit AGENTS.md #6 escape-hatch language: the construct is lexically
// similar but belongs to a different semantic/bug class. Mirrors
// SIBLING_CLASS_FALSE_POSITIVE_RE in harvest-agent-lessons.mjs (single
// conceptual pattern; keep in sync if the regex changes there).
const FALSE_POSITIVE_RE =
  /falso positivo|solo lessicalmente simil\w*|lessicalmente simil\w*(?:[^.]{0,40})semanticamente divers\w*|semanticamente divers\w*|non è (?:lo stesso|la stessa) (?:anti-?pattern|costrutto|classe)|not the same (?:anti-?pattern|construct|bug class)|false positive/i;

/**
 * Extract the text under `## Non implementato` from a PR body (up to the next
 * `##` section or end-of-string). Returns empty string when the section is absent.
 */
function extractNonImplementato(body) {
  const m = /#{2,3}\s+Non implementato[^\n]*([\s\S]*?)(?=\n#{2,3}|\s*$)/i.exec(body);
  return m ? m[1] : '';
}

/**
 * True if `candidatePath` is explicitly declared a false positive in the
 * `## Non implementato` section text. Only AGENTS.md #6 escape-hatch language
 * qualifies (see FALSE_POSITIVE_RE above); bare file mentions or deferral notes
 * ("will fix in follow-up") do NOT — those remain genuine unaddressed siblings.
 */
export function isDeclaredFalsePositive(candidatePath, nonImplText) {
  if (!nonImplText || !candidatePath) return false;
  const fname = basename(candidatePath);
  const lines = nonImplText.split('\n').filter(
    (l) => l.includes(candidatePath) || (fname.length > 3 && l.includes(fname)),
  );
  return lines.some((l) => FALSE_POSITIVE_RE.test(l));
}

async function main() {
  let command = '';
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
  let jsonOutput;
  try {
    jsonOutput = execFileSync('node', [checkScript, '--json'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      // Capture stdout (parsed as JSON); let stderr propagate for progress messages.
      stdio: ['pipe', 'pipe', 'inherit'],
    });
  } catch {
    process.exit(0); // check script error → fail-safe
  }

  let candidates;
  try {
    const result = JSON.parse(jsonOutput);
    candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  } catch {
    process.exit(0); // JSON parse error → fail-safe
  }

  if (candidates.length === 0) {
    process.exit(0); // no sibling candidates → allow PR creation
  }

  // Extract PR body for the false-positive filter. If we can't parse the body
  // (undefined), fall back to treating all candidates as genuine (conservative,
  // same behaviour as the old --strict mode) — never silently drop a real check.
  let prBody;
  try {
    prBody = extractPrBody(command);
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
  process.exit(1);
}

// Only run when executed directly (e.g. as a PreToolUse hook), not on import.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main();
}
