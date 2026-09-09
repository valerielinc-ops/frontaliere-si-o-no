import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'components/community/JobBoard.tsx'),
  'utf8',
);

describe('JobBoard free-text search history', () => {
 it('pushes explicit q commits while the debounce stays replace-only', () => {
    expect(source).toContain("type QueryHistoryMode = 'replace' | 'push';");
    expect(source).toContain("window.history.pushState(window.history.state, '', newUrl);");
    expect(source).toContain("const commitSearchQuery = useCallback((value: string) => {");
    expect(source).toContain("syncQueryParamsToUrl({ q: next || null }, 'push');");
    expect(source).toContain("syncQueryParamsToUrl({ q: null });");
    expect(source).toContain("syncQueryParamsToUrl({ q: deferredSearchQuery.trim() });");
    expect(source).not.toContain("syncQueryParamsToUrl({ q: deferredSearchQuery.trim() }, 'push');");
    expect(source).toContain('onKeyDown={(e) => {');
 });

  it('keeps pagination and non-search URL updates replace-only', () => {
    expect(source).toContain('syncQueryParamsToUrl({ page: null });');
    expect(source).toContain('syncQueryParamsToUrl({ page: p > 1 ? String(p) : null });');
    expect(source).toContain('syncQueryParamsToUrl({ salarioMin: null, salarioMax: null });');
  });
});
