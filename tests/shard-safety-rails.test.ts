// Structural invariants for issue #4881 (shard safety rails, defects A/B):
// push-section-shard.sh and push-locale-shard.sh must (1) read their
// .shard-deploys/.shard-filecount bookkeeping counters via git-plumbing
// (shard_read_counter), never via a working-tree `[ -f ... ]` check that is
// ALWAYS false against a --no-checkout clone, and never via the fragile
// unauthenticated raw.githubusercontent.com fetch it replaced; (2) expose a
// configurable, loud-on-override shrink guard; (3) share retry/flatten logic
// from scripts/lib/shard-git-helpers.sh rather than duplicating it (AGENTS.md
// #6) — runtime behavior of that shared logic is covered separately in
// tests/shard-git-helpers.test.ts against real temp-git-repo fixtures.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(p), 'utf8');

const SCRIPTS = [
  { path: 'scripts/lib/push-section-shard.sh', overrideVarPattern: /SHARD_SHRINK_GUARD_OVERRIDE_\$\{SECTION_UPPER\}_\$\{LOC_UPPER\}/ },
  { path: 'scripts/lib/push-locale-shard.sh', overrideVarPattern: /SHARD_SHRINK_GUARD_OVERRIDE_\$\(echo "\$loc" \| tr a-z A-Z\)/ },
];

describe('shard push scripts — safety rail invariants (issue #4881)', () => {
  for (const { path, overrideVarPattern } of SCRIPTS) {
    describe(path, () => {
      const script = read(path);

      it('sources the shared shard-git-helpers.sh (no duplicated logic, AGENTS.md #6)', () => {
        expect(script).toMatch(/source\s+"\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/shard-git-helpers\.sh"/);
      });

      it('reads bookkeeping counters via git-plumbing, not a --no-checkout working-tree file check', () => {
        expect(script).toMatch(/shard_read_counter\s+"\$stage"\s+\.shard-deploys/);
        expect(script).toMatch(/shard_read_counter\s+"\$stage"\s+\.shard-filecount/);
        // The bug this fixes: `[ -f "$stage/.shard-deploys" ]` (or .shard-filecount)
        // as a LIVE condition is always false post `--no-checkout` clone. Only
        // allow it to appear inside a comment documenting the incident.
        const liveCode = script
          .split('\n')
          .filter((line) => !/^\s*#/.test(line))
          .join('\n');
        expect(liveCode).not.toMatch(/\[\s+-f\s+"\$stage\/\.shard-(deploys|filecount)"\s+\]/);
      });

      it('does not fetch the previous file count from raw.githubusercontent.com', () => {
        // Replaced entirely by the git-plumbing read above — the old fetch was
        // both unauthenticated (60/hr rate limit) and CDN-stale.
        const liveCode = script
          .split('\n')
          .filter((line) => !/^\s*#/.test(line))
          .join('\n');
        expect(liveCode).not.toContain('curl');
        expect(liveCode).not.toContain('raw.githubusercontent.com');
      });

      it('exposes a configurable shrink-guard threshold with a safe default', () => {
        expect(script).toMatch(/SHARD_SHRINK_GUARD_PCT="\$\{SHARD_SHRINK_GUARD_PCT:-50\}"/);
      });

      it('refuses the push on an unguarded shrink with a hard error, never a downgraded warning', () => {
        const idx = script.indexOf('SHARD_SHRINK_GUARD_PCT="${SHARD_SHRINK_GUARD_PCT:-50}"');
        expect(idx).toBeGreaterThan(-1);
        const guardBlock = script.slice(idx, idx + 1200);
        expect(guardBlock).toMatch(/::error::/);
        expect(guardBlock).toMatch(/exit 1/);
      });

      it('logs loudly (::warning::) when the override is used — never silent (AGENTS.md #2)', () => {
        const idx = script.indexOf('SHARD_SHRINK_GUARD_PCT="${SHARD_SHRINK_GUARD_PCT:-50}"');
        const guardBlock = script.slice(idx, idx + 1200);
        expect(guardBlock).toMatch(overrideVarPattern);
        expect(guardBlock).toMatch(/::warning::.*proceeding with an INTENTIONAL shrink push/);
      });

      it('delegates push-with-retry and orphan-init/flatten to the shared helpers', () => {
        expect(script).toMatch(/shard_orphan_init\s+"\$stage"/);
        expect(script).toMatch(/shard_push_with_retry\s+"\$stage"/);
        expect(script).toMatch(/shard_orphan_flatten_and_push\s+"\$stage"/);
      });
    });
  }
});

describe('scripts/lib/shard-git-helpers.sh — shape', () => {
  const script = read('scripts/lib/shard-git-helpers.sh');

  it('shard_read_counter uses git show HEAD:<path>, not a working-tree file check', () => {
    expect(script).toMatch(/git\s+-C\s+"\$dir"\s+show\s+"HEAD:\$path"/);
  });

  it('defaults non-numeric or missing content to 0', () => {
    expect(script).toMatch(/\[\[\s+"\$val"\s+=~\s+\^\[0-9\]\+\$\s+\]\]\s+\|\|\s+val=0/);
  });

  it('retries push up to 3 times, then hands the last resort to the PAT fallback', () => {
    const idx = script.indexOf('shard_push_with_retry()');
    expect(idx).toBeGreaterThan(-1);
    const fnBody = script.slice(idx, script.indexOf('\n}', idx));
    expect(fnBody).toMatch(/for try in 1 2 3/);
    // The retry loop no longer returns 1 itself: shard_pat_push is the tail
    // call, so ITS status is the failure status (incident 2026-07-30 — a
    // refused deploy key made every SSH retry pointless).
    expect(fnBody).toMatch(/shard_pat_push\s+"\$dir"\s+"\$repo"\s+"\$refspec"/);
    expect(fnBody).toMatch(/shard_push_error_is_auth\s+"\$out"/);
  });

  it('never lets the PAT reach the remote URL or argv (credential helper only)', () => {
    // A token in the URL leaks into git's own error messages, which get echoed
    // into the Actions log verbatim.
    expect(script).not.toMatch(/https:\/\/[^\s"']*\$\{?SHARD_PUSH_TOKEN/);
    expect(script).not.toMatch(/https:\/\/x-access-token:/);
    expect(script).toMatch(/credential\.helper=\$_SHARD_CRED_HELPER/);
    expect(script).toMatch(/::add-mask::\$SHARD_PUSH_TOKEN/);
  });

  it('scrubs the token from the fallback push transcript', () => {
    expect(script).toMatch(/sed\s+"s\|\$SHARD_PUSH_TOKEN\|\*\*\*\|g"/);
  });
});
