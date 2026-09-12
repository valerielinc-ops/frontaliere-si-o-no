import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW = readFileSync(resolve(ROOT, '.github/workflows/followup-drainer.yml'), 'utf8');
const STALE_RESCUER = readFileSync(resolve(ROOT, '.github/workflows/stale-pr-rescuer.yml'), 'utf8');
const RECYCLE = readFileSync(resolve(ROOT, '.github/workflows/recycle-stale-prs.yml'), 'utf8');

describe('followup-drainer trigger durability', () => {
  it('usa il cron durevole e non fan-out workflow_run concorrenti', () => {
    expect(WORKFLOW).toMatch(/schedule:\s*\n\s*- cron: ['"]\*\/20 \* \* \* \*['"]/);
    expect(WORKFLOW).not.toContain('\n  workflow_run:');
    expect(WORKFLOW).toContain('workflow_dispatch:');
    expect(WORKFLOW).toContain('cancel-in-progress: false');
  });

  it('propaga al drainer il fallback Codex già usato da issue-fix', () => {
    const drain = WORKFLOW.slice(WORKFLOW.indexOf('- name: Drain follow-up queue'));
    expect(drain).toContain("FOLLOWUP_CODEX_FALLBACK_MODE: '1'");
  });

  it('riesamina stale-review e rende l azione idempotente per classe e head', () => {
    expect(STALE_RESCUER).not.toContain('già stale-review — skip');
    expect(STALE_RESCUER).toContain('stale-pr-rescuer class=$CLASS head=${HEAD:0:7}');
    expect(STALE_RESCUER).toContain('agent:autofix');
  });

  it('non tronca gli scan delle PR oltre il vecchio limite 50', () => {
    for (const source of [STALE_RESCUER, RECYCLE]) {
      expect(source).toContain('gh api --paginate "repos/$REPO/pulls?state=open&per_page=100"');
      expect(source).not.toContain('gh pr list --repo "$REPO" --state open --limit 50');
    }
  });
});
