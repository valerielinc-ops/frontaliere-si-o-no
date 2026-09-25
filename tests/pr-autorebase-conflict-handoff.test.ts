import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildConflictHandoffIssue,
  conflictHandoffMarker,
  shouldHandOffConflict,
} from '../scripts/ci/pr-autorebase.mjs';

const SOURCE = readFileSync(new URL('../scripts/ci/pr-autorebase.mjs', import.meta.url), 'utf8');
const HEAD = '685bcb73'.padEnd(40, '0');

describe('pr-autorebase — conflitto dopo LGTM affidato a issue-fix (#9260)', () => {
  it('passa la mano solo con LGTM e una volta per HEAD', () => {
    expect(shouldHandOffConflict({ lgtm: true, alreadyHandedOff: false })).toBe(true);
    expect(shouldHandOffConflict({ lgtm: false, alreadyHandedOff: false })).toBe(false);
    expect(shouldHandOffConflict({ lgtm: true, alreadyHandedOff: true })).toBe(false);
  });

  it('il marker e\' legato alla HEAD: una HEAD nuova e\' un conflitto nuovo', () => {
    expect(conflictHandoffMarker(HEAD)).toBe('<!-- AUTOREBASE_CONFLICT_HANDOFF head=685bcb730000 -->');
    expect(conflictHandoffMarker('b'.repeat(40))).not.toBe(conflictHandoffMarker(HEAD));
  });

  it('la issue porta PR, branch, HEAD e file, con un titolo stabile e senza keyword di chiusura sulla PR', () => {
    const { title, body } = buildConflictHandoffIssue({
      num: 9260,
      branch: 'fix/issue-8931-bfs-depth-20260919',
      head: HEAD,
      files: ['build-plugins/plateAuctionsPagesPlugin.ts', 'services/plateAuctions/paths.ts', 'services/router.ts'],
    });
    expect(title).toBe('Conflitto con main dopo LGTM: riapplicare la PR #9260 su main');
    expect(body).toContain('`fix/issue-8931-bfs-depth-20260919`');
    expect(body).toContain('`685bcb730000`');
    expect(body).toContain('- `services/router.ts`');
    expect(body).toContain('Supersedes #9260');
    // Una keyword di chiusura adiacente a #9260 chiuderebbe la PR vecchia al
    // merge della nuova PR prima che qualcuno verifichi la sostituzione.
    expect(body).not.toMatch(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#9260\b/i);
  });

  it('ogni ramo che abortisce un conflitto non auto-risolvibile passa la mano', () => {
    const aborts = SOURCE.match(/ensureStaleLabel\(num\);\n\s+commentConflictOnce\(num, branch\);\n\s+handOffConflictToFixer\(num, branch, head, lgtm\);/g) || [];
    const bare = SOURCE.match(/commentConflictOnce\(num, branch\);/g) || [];
    expect(aborts.length).toBe(3);
    expect(bare.length).toBe(aborts.length);
  });

  it('la issue salta il triage e riceve agent:fix con un evento separato', () => {
    expect(SOURCE).toContain("'--label', 'agent:triaged'");
    expect(SOURCE).toMatch(/'issue', 'edit', issue, '--repo', REPO, '--add-label', 'agent:fix'/);
  });
});

describe('pr-autorebase — hand-off fail-closed (review #1620)', () => {
  it('merge-tree deve confermare il conflitto e il marker segue il routing confermato', () => {
    const fn = SOURCE.slice(SOURCE.indexOf('function handOffConflictToFixer('), SOURCE.indexOf('function commentConflictOnce('));
    expect(fn).toContain("if (verdict.state !== 'conflicted')");
    const routed = fn.indexOf("if (!ghOk(['issue', 'edit', issue, '--repo', REPO, '--add-label', 'agent:fix']))");
    const marker = fn.indexOf('${marker}');
    expect(routed).toBeGreaterThan(0);
    expect(marker).toBeGreaterThan(routed);
    expect(fn).toMatch(/'issue', 'list'[\s\S]*in:title/);
  });
});
