import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

describe('JobBoard category translations', () => {
  it('does not use missing jobBoard.category.* translation keys in the job detail gate', () => {
    const source = readFileSync(resolve(root, 'components/community/JobBoard.tsx'), 'utf8');

    expect(source).not.toContain('jobBoard.category.${jobCategory}');
    expect(source).toContain('categoryTranslationKey(selectedJob)');
  });
});
