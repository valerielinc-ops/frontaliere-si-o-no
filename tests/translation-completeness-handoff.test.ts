// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const files = [
  '.github/workflows/translate-pending-logic.yml',
  '.github/corpus-workflows/translate-pending.yml',
  '.github/workflows/translate-pending.yml',
];

describe('translation completeness handoff', () => {
  it.each(files)('%s records a durable status only after completeness validation', (file) => {
    const source = readFileSync(resolve(file), 'utf8');
    expect(source).toContain('Record durable translation completeness handoff');
    expect(source).toContain("node scripts/validate-translation-completeness.mjs");
    expect(source).toContain("gh api --method POST");
    expect(source).toContain("statuses/${source_sha}");
    expect(source).toContain("-f context='frontaliere/translation-complete'");
    expect(source).not.toContain('GH_TOKEN: ${{ env.GH_TOKEN }}');
    expect(source).toContain('exit 0');
    expect(source.indexOf('validate-translation-completeness.mjs'))
      .toBeLessThan(source.indexOf('gh api --method POST'));
  });
});
