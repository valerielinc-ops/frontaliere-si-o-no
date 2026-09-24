import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

// Issue #9321 FU-2026-09-20-008. On the corpus the backlog sweep closed the
// alarm issue `Workflow Failure: Post-merge follow-up triage` (corpus #170)
// with `maybe-resolved` while the last completed run of that workflow was
// still red, and the alarm channel went silent. The corpus twin got a guard in
// corpus PR 1601; this sweep had the same class-C close path without it.
const workflow = readFileSync('.github/workflows/needs-human-sweep.yml', 'utf8');
const doc = YAML.parse(workflow);

function sweepPrompt(): string {
  for (const job of Object.values<any>(doc.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (step?.id === 'codex_sweep') return String(step.with?.prompt ?? '');
    }
  }
  throw new Error('codex_sweep step not found');
}

describe('needs-human sweep: failure issues close only after a green run', () => {
  const prompt = sweepPrompt();

  it('can read Actions runs and the issue creation time the guard compares against', () => {
    expect(doc.permissions?.actions).toBe('read');
    expect(prompt).toMatch(/gh issue view N --repo \$REPO --json body,comments,labels,createdAt/);
  });

  it('applies the close-recovered oracle before any close of a failure issue', () => {
    expect(prompt).toMatch(/Prima di qualsiasi `gh issue close` su un titolo che corrisponde a `\^\(Workflow\|Crawler\|CI\) Failure: `/);
    expect(prompt).toContain('scripts/ci/close-recovered-failure-issues.mjs');
    expect(prompt).toMatch(/gh run list --repo \$REPO -w "\$workflow_name" -b main -L 100 --json databaseId,conclusion,status,createdAt/);
    expect(prompt).toMatch(/status == completed/);
    expect(prompt).toMatch(/conclusion == success` e una data successiva a `createdAt` dell'issue/);
    expect(prompt).toMatch(/step esatto `Run <slug>`/);
  });

  it('keeps the issue open when the last run is red, cancelled, missing or unreadable', () => {
    expect(prompt).toMatch(/ultima run\/step è rossa, `cancelled`, assente o non leggibile, NON chiudere: lascia l'issue aperta/);
    expect(prompt).toMatch(/Un `maybe-resolved`, un verdetto o una decisione di sweep non sostituiscono questa prova/);
  });
});
