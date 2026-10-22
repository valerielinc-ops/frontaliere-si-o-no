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
  it.each(files)('%s commits the durable marker only after completeness validation', (file) => {
    const source = readFileSync(resolve(file), 'utf8');
    expect(source).toContain('Record durable translation completeness handoff');
    expect(source).toContain("node scripts/validate-translation-completeness.mjs");
    expect(source).toContain('TRANSLATION_DEPLOY_HANDOFF_STATE=complete');
    expect(source).toContain('TRANSLATION_DEPLOY_HANDOFF_STATE=fallback');
    expect(source).toContain('Release translation deploy fallback after a failed phase');
    expect(source).toContain('data/translation-deploy-handoff.json');
    expect(source).not.toContain("context='frontaliere/translation-complete'");
    expect(source).not.toContain('gh api --method POST');
    expect(source.indexOf('validate-translation-completeness.mjs'))
      .toBeLessThan(source.indexOf('TRANSLATION_DEPLOY_HANDOFF_STATE=complete'));
  });
});
