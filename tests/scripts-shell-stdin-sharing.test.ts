import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scanFiles, stripShellComments } from '../scripts/lib/stdin-sharing-loop-scan.mjs';

/**
 * #7777 — the standing watch for the #7392–#7505 class outside `.github`.
 *
 * The class is a `while … read` loop whose list IS its stdin: every external
 * command in the body inherits that stream, and whatever one of them reads is
 * a line the next `read` never sees. The loop then finishes early and logs an
 * ordinary success. Nine sites were closed in #7716, all of them under
 * `.github`, and the scanner built there deliberately scans `.github` only —
 * it is the guardrail of that family (`allGithubShellFiles()`, #7392–#7504)
 * and widening its perimeter in place would denature it.
 *
 * That left the libraries unwatched, which is a real hole and not a
 * theoretical one: the seventh site of the sweep, `resolve-append-conflicts.sh`,
 * lives right here in `scripts/lib`. The only presidio on this tree was
 * `sibling-check-gate.mjs`, which fires on the FILES A PR TOUCHES — it can
 * only see a site when someone happens to edit near it, so a loop that grows a
 * `gh`/`node` in its body years from now goes unnoticed. This test is the
 * standing half: same scanner code, different perimeter.
 */

const SCRIPTS_DIR = 'scripts';

/** Every shell file under `scripts/**`. */
function allScriptShellFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (p.endsWith('.sh')) out.push(p);
    }
  };
  walk(SCRIPTS_DIR);
  return out;
}

function codeOnly(file: string): string {
  return stripShellComments(readFileSync(file, 'utf8'));
}

describe('scripts/** shell loops never share their stdin with the body', () => {
  it('#7777 — no file-fed while-read runs a stdin consumer on fd 0', () => {
    const files = allScriptShellFiles();
    // The perimeter itself is an assertion: a walk that stops finding files
    // (a moved directory, a renamed suffix) would make everything below pass
    // vacuously, which is the exact way this class hid in the first place.
    expect(files.length).toBeGreaterThan(20);
    // The site this test was opened for: `bp_section_order`'s here-string loop
    // schedules the deploy fan-out, so a line lost there is a whole section
    // that stops being pushed. Its body is `jq … "$slugs_json"` / `find` /
    // `wc` / `printf` — all argument-fed, none of them a stdin consumer, so it
    // is not an offender today. It is IN THE SCAN that the value lies: the day
    // someone adds a `gh` or a `node` in there, this test says so.
    expect(files).toContain('scripts/lib/bounded-parallel.sh');

    const { loops, offenders } = scanFiles(files, codeOnly);
    expect(loops.length).toBeGreaterThanOrEqual(5);
    // A scanner whose consumer half silently stops matching reports zero
    // offenders forever. `resolve-append-conflicts.sh` is the known positive:
    // it has a consumer in the body AND it is already isolated on fd 9.
    const known = loops.find((l) => l.file === 'scripts/lib/resolve-append-conflicts.sh');
    expect(known?.hasConsumer).toBe(true);
    expect(known?.isolated).toBe(true);

    expect(offenders).toEqual([]);
  });
});
