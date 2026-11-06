import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const BROWSER_SOURCES = [
  'components/pages/UserProfile.tsx',
  'services/assistedApplicationQuestionLocalization.ts',
  'services/jobCategoryNormalization.mjs',
  'services/privacy/faqSearchCategory.ts',
  'services/profileFirestore.ts',
  'services/residenceLocalities.ts',
];

describe('legacy browser runtime compatibility', () => {
  it('does not call Object.hasOwn in browser-loaded modules', () => {
    for (const relativePath of BROWSER_SOURCES) {
      const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8');
      expect(source, relativePath).not.toMatch(/\bObject\.hasOwn\s*\(/);
    }
  });
});
