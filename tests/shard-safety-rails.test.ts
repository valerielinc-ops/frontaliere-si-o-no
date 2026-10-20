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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildFailureIssue, readShardFailureReasons } from '../scripts/ci/report-shard-push-failure.mjs';

const read = (p: string) => readFileSync(resolve(p), 'utf8');

const SCRIPTS = [
  { path: 'scripts/lib/push-section-shard.sh', overrideVarPattern: /SHARD_SHRINK_GUARD_OVERRIDE_\$\{SECTION_UPPER\}_\$\{LOC_UPPER\}/ },
  { path: 'scripts/lib/push-locale-shard.sh', overrideVarPattern: /SHARD_SHRINK_GUARD_OVERRIDE_\$\(echo "\$loc" \| tr a-z A-Z\)/ },
];

const SSH_TRANSPORT_SCRIPTS = [
  'scripts/lib/push-section-shard.sh',
  'scripts/lib/push-locale-shard.sh',
  'scripts/lib/push-article-shard-incremental.sh',
  'scripts/lib/compact-article-shard-history.sh',
  'scripts/lib/deploy-it-pages-prep.sh',
  '.github/workflows/rerender-article-hubs.yml',
  'scripts/ci/prune-cdn-assets.mjs',
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

      // The guard's own `if … fi`, delimited by its closing `fi` at the block's
      // indent rather than a fixed character window. A fixed window silently
      // stops covering the block when the block grows (it did: the shrink-ack
      // branch pushed `exit 1` past 1200 chars), and it can just as silently
      // start matching unrelated code below the guard — both directions make
      // the assertions stop meaning what they say.
      const guardBlock = (() => {
        const idx = script.indexOf('SHARD_SHRINK_GUARD_PCT="${SHARD_SHRINK_GUARD_PCT:-50}"');
        expect(idx).toBeGreaterThan(-1);
        const rest = script.slice(idx);
        const end = rest.search(/\n {4}fi\n/);
        expect(end).toBeGreaterThan(-1);
        return rest.slice(0, end);
      })();

      it('refuses the push on an unguarded shrink with a hard error, never a downgraded warning', () => {
        expect(guardBlock).toMatch(/::error::/);
        expect(guardBlock).toMatch(/exit 1/);
      });

      it('logs loudly (::warning::) when the override is used — never silent (AGENTS.md #2)', () => {
        expect(guardBlock).toMatch(overrideVarPattern);
        expect(guardBlock).toMatch(/::warning::.*proceeding with an INTENTIONAL shrink push/);
      });

      it('delegates push-with-retry and orphan-init/flatten to the shared helpers', () => {
        expect(script).toMatch(/shard_orphan_init\s+"\$stage"/);
        expect(script).toMatch(/shard_push_with_retry\s+"\$stage"/);
        expect(script).toMatch(/shard_orphan_flatten_and_push\s+"\$stage"/);
      });

      it('preflights every direct stage push and skips orphan self-heal for observer rc 3', () => {
        const pushCalls = [...script.matchAll(/(?:shard_push_with_retry|shard_pat_push)\s+"\$stage"/g)];
        expect(pushCalls.length).toBeGreaterThan(0);
        for (const match of pushCalls) {
          const before = script.slice(Math.max(0, (match.index ?? 0) - 1800), match.index ?? 0);
          expect(before).toContain('shard_report_largest_tree "$stage"');
        }
        expect(script).toMatch(/_push_rc[^\n]*-ne 3/);
        expect(script).toMatch(/_push_attempted/);
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

  it('normalizes and bounds fractional PAT retry delays before sleep/arithmetic', () => {
    expect(script).toMatch(/shard_pat_retry_delay\(\)/);
    expect(script).toMatch(/shard_pat_retry_delay_double/);
    expect(script).toMatch(/pat_delay="\$\(shard_pat_retry_delay\)"/);
  });

  it('espone il classificatore e l’osservatore del limite degli alberi', () => {
    expect(script).toMatch(/shard_push_error_is_remote_object_limit\(\)/);
    expect(script).toMatch(/SHARD_REMOTE_TREE_LIMIT_BYTES:-52428800/);
    expect(script).toMatch(/SHARD_REMOTE_TREE_REJECT_BYTES:-52462972/);
    expect(script).toMatch(/git\s+-C\s+"\$dir"\s+cat-file\s+--batch-check/);
  });

});

describe('scripts/lib/push-article-shard-incremental.sh — tree preflight', () => {
  const script = read('scripts/lib/push-article-shard-incremental.sh');

  it('osserva il commit-tree blobless prima del push diretto e blocca il fallback PAT sul limite permanente', () => {
    expect(script).toMatch(/shard_report_largest_tree\s+"\$stage"\s+"\$commit"/);
    expect(script).toMatch(/if \[ "\$tree_check_rc" -eq 3 \]; then permanent_fail=1; fi/);
    expect(script).toMatch(/\[ "\$permanent_fail" != 1 \] && \[ -n "\$last_commit" \]/);
  });
});

describe('scripts/ci/report-shard-push-failure.mjs — cause ordering', () => {
  it('apre l’issue con la causa letta dal file dello shard', () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), 'shard-report-'));
    const cause = 'GitHub remote object/tree size limit';
    writeFileSync(join(runnerTemp, 'shard-fail-reason-ticino-de'), `${cause}\n`);
    try {
      const reasons = readShardFailureReasons({
        locale: 'de',
        shards: ['ticino'],
        runnerTemp,
      });
      const issue = buildFailureIssue({ locale: 'de', shards: ['ticino'], reasons });
      expect(issue.description).toContain(`- \`ticino-de\`: ${cause}`);
      expect(issue.description.indexOf('### ⚠️ Causa rilevata dallo step di push')).toBeLessThan(
        issue.description.indexOf('### Cosa guardare, in ordine'),
      );
      expect(issue.description).toContain('la lista ordinata sotto è una graduatoria di ipotesi');
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });
});

describe('scripts/ci/prune-cdn-assets.mjs — PAT fallback shape', () => {
  const script = read('scripts/ci/prune-cdn-assets.mjs');

  it('retries only bounded transient PAT failures and preserves the original failure otherwise', () => {
    expect(script).toMatch(/const PAT_PUSH_MAX_ATTEMPTS = 3/);
    expect(script).toMatch(/attempt < PAT_PUSH_MAX_ATTEMPTS && isTransientPushFailure\(fallbackError\)/);
    expect(script).toMatch(/function isTransientPushFailure\(error\)/);
    expect(script).toMatch(/throw err;/);
  });

  it('rechecks the live CDN tip before every PAT force-push attempt', () => {
    expect(script).toMatch(/function pushCdnMain\(repoDir, sshEnv, clonedTip\)/);
    expect(script).toMatch(/for \(let attempt = 1;[\s\S]*?assertFreshRemote\(clonedTip, sshEnv\)/);
    expect(script).toMatch(/pushCdnMain\(repoDir, sshEnv, clonedTip\)/);
  });

  it('classifies the Git HTTP/2 transport interruption as transient', () => {
    expect(script).toContain(String.raw`HTTP\/2 stream \d+ was not closed cleanly`);
  });
});

describe('SSH deploy paths — transport keepalive', () => {
  for (const path of SSH_TRANSPORT_SCRIPTS) {
    it(`${path} keeps long-running SSH operations alive`, () => {
      const source = read(path);
      expect(source).toMatch(/ServerAliveInterval=30/);
      expect(source).toMatch(/ServerAliveCountMax=6/);
      expect(source).toMatch(/TCPKeepAlive=yes/);
    });
  }
});
