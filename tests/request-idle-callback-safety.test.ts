import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const SOURCES = [
  'App.tsx',
  'components/community/NewsFeed.tsx',
  'components/shared/GptAdSlot.tsx',
  'hooks/useUIState.ts',
  'hooks/useUserState.ts',
  'services/mobileUxMonitor.ts',
  'services/prefetch.ts',
];

describe('requestIdleCallback guards', () => {
  it('checks callability before invoking the optional browser API', () => {
    for (const relativePath of SOURCES) {
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
      expect(source, relativePath).not.toMatch(/if \(\s*['"]requestIdleCallback['"]\s+in\s+window/);
      expect(source, relativePath).not.toContain('(window as any).requestIdleCallback');
    }
  });
});
