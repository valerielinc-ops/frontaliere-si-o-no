import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/sync-pharmacy-duties-italy.yml', import.meta.url), 'utf8');
const importer = readFileSync(new URL('../scripts/import-pharmacy-duties-italy.mjs', import.meta.url), 'utf8');
const checker = readFileSync(new URL('../scripts/check-pharmacy-duties-italy.mjs', import.meta.url), 'utf8');

describe('Italian pharmacy duty workflow ownership', () => {
  it('is a separate writer with only the two Italian release artifacts', () => {
    expect(workflow).toContain('name: sync-pharmacy-duties-italy');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('ref: main');
    expect(workflow).toContain('node scripts/import-pharmacy-duties-italy.mjs');
    expect(workflow).toContain('node scripts/check-pharmacy-duties-italy.mjs');
    expect(workflow).toContain('git add data/pharmacy-duties-italy.json data/pharmacy-duties-italy-status.json');
    expect(workflow).toMatch(/Import official Italian duty calendars[\s\S]*Validate Italian duty release[\s\S]*Commit Italian duty snapshots/);
    expect(workflow).toContain('git commit -m "chore(data): refresh Italian pharmacy duty release"');
    expect(workflow).not.toContain('sync-pharmacies-border');
    expect(workflow).not.toContain('pharmacy-duties-ticino');
    expect(workflow).not.toContain('pharmacies-italy-border.json');
  });

  it('does not call the Farmacia Aperta service', () => {
    expect(workflow).not.toMatch(/farmacia-aperta|farmacia_aperta/i);
  });

  it('keeps the scheduled run serialized and exposes a failure gate', () => {
    expect(workflow).toContain("cron: '37 4 * * *'");
    expect(workflow).toContain('group: sync-pharmacy-duties-italy');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('timeout-minutes: 20');
    expect(workflow).toContain('issues: write');
    expect(workflow).toContain('if: failure()');
    expect(workflow).toContain('continue-on-error: true');
    expect(workflow).toContain('git diff --quiet -- data/pharmacy-duties-italy.json data/pharmacy-duties-italy-status.json');
    expect(workflow).toContain('scripts/lib/git-push-with-retry.sh');
    expect(workflow).toContain('--regenerate-cmd');
    expect(workflow).not.toContain('--allow-not-published');
  });

  it('keeps importer/checker source guards and required-vs-best-effort gates', () => {
    expect(importer).toContain('assertOfficialItalyUrl');
    expect(importer).toContain('FETCH_ATTEMPTS = 3');
    expect(importer).toContain('buildAtomicItalyDutySnapshots');
    expect(importer).toContain('sourcePublicationClass(source) === \'best-effort\'');
    expect(checker).toContain('verifyItalyReleaseSnapshots');
    expect(checker).toContain('italyDutyPublicationClassesFromRegistry');
    expect(checker).toContain('required');
    expect(checker).toContain('best-effort');
  });
});
