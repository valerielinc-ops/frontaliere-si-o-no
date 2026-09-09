import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'components/community/JobBoard.tsx'),
  'utf8',
);

describe('JobBoard free-text search history', () => {
  it('pushes committed q changes so back/forward can restore the query', () => {
    expect(source).toContain("type QueryHistoryMode = 'replace' | 'push';");
    expect(source).toContain("window.history.pushState(window.history.state, '', newUrl);");
    expect(source).toContain("syncQueryParamsToUrl({ q: null }, 'push');");
    expect(source).toContain("syncQueryParamsToUrl({ q: deferredSearchQuery.trim() }, 'push');");
  });

  it('keeps pagination and non-search URL updates replace-only', () => {
    expect(source).toContain('syncQueryParamsToUrl({ page: null });');
    expect(source).toContain('syncQueryParamsToUrl({ page: p > 1 ? String(p) : null });');
    expect(source).toContain('syncQueryParamsToUrl({ salarioMin: null, salarioMax: null });');
  });
});
