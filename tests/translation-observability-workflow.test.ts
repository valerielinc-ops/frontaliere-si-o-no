import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const workflow = fs.readFileSync(path.resolve('.github/workflows/translate-pending-logic.yml'), 'utf8');

describe('translation observability workflow', () => {
  it('captures baseline after markers and final only after the Phase 2c persistence barrier', () => {
    const before = workflow.indexOf('Capture translation observability baseline');
    const marker = workflow.indexOf('Flag wrong-language job titles');
    const mopup = workflow.indexOf('Phase 2c mop-up');
    const persist = workflow.indexOf('Persist Phase 2c changes to crawler slices');
    const final = workflow.indexOf('Capture final translation observability (shadow)');
    const commit = workflow.indexOf('Commit translations');
    expect(before).toBeGreaterThan(marker);
    expect(final).toBeGreaterThan(mopup);
    expect(final).toBeGreaterThan(persist);
    expect(commit).toBeGreaterThan(final);
    expect(workflow.slice(final, commit)).toContain('if: always()');
    expect(workflow).toContain("retention-days: 14");
    expect(workflow).toContain('inputs.dry_run != true');
    expect(workflow).not.toContain('translation-shadow-plan.mjs');
  });

  it('remains parseable and leaves the translation engine/dispatch commands unchanged', () => {
    const doc: any = YAML.parse(workflow);
    const runs = doc.jobs.translate.steps.map((step: any) => step.run || '').join('\n');
    expect(runs).toContain('node scripts/relocalize-pending-jobs.mjs "${ARGS[@]}"');
    expect(runs).toContain('node scripts/local-mt-mopup.mjs --max-jobs "$INPUT_MOPUP_MAX_JOBS"');
    expect(runs).not.toContain('gh workflow run');
  });
});
