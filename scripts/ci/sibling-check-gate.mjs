/**
 * sibling-check-gate.mjs — PreToolUse hook: blocks `gh pr create` when
 * check-sibling-patterns.mjs --strict finds uncovered sibling files.
 *
 * Fail-safe: any internal error → exit 0 (never block PR on script failure).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const checkScript = join(__dirname, 'check-sibling-patterns.mjs');

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

  try {
    execFileSync('node', [checkScript, '--strict'], { stdio: 'inherit' });
    process.exit(0); // no candidates → allow PR creation
  } catch (e) {
    if (e?.status === 1) {
      // sibling candidates found → block PR creation
      process.stderr.write(
        '\n\u{1F6AB} sibling-check-gate: PR bloccata — file gemello/i non coperti trovati.\n' +
          'Ispeziona i candidati sopra e includi il fix nella STESSA PR (AGENTS.md #6)\n' +
          'oppure giustifica in `## Non implementato`.\n\n',
      );
      process.exit(1);
    }
    process.exit(0); // script error → fail-safe
  }
}

main();
