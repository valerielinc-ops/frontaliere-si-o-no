import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  resolve(__dirname, '../components/community/JobBoard.tsx'),
  'utf8',
);
const LOAD_START = SOURCE.indexOf('const relatedArticleMetadataRef');
const LOAD_END = SOURCE.indexOf('const relatedArticles = useMemo', LOAD_START);
const LOAD_SOURCE = SOURCE.slice(LOAD_START, LOAD_END);

describe('JobBoard related article metadata loading', () => {
  it('waits for an authorized reader to approach the related article section', () => {
    expect(LOAD_SOURCE).toContain('if (!selectedJob || !hasAccess || blogMetaReady) return;');
    expect(LOAD_SOURCE).toContain('new IntersectionObserver(');
    expect(LOAD_SOURCE).toContain("{ rootMargin: '900px 0px' }");
    expect(LOAD_SOURCE).toContain('relatedArticleMetadataRequestedFor !== selectedJob.id');
    expect(LOAD_SOURCE).toContain('relatedArticleMetadataRef.current');
    expect(SOURCE).toContain('<div ref={relatedArticleMetadataRef} aria-hidden="true" className="h-0" />');
  });

  it('keeps crawler metadata loading eager and cancels stale job requests', () => {
    expect(LOAD_SOURCE).toContain('if (isCrawlerVisitor || typeof IntersectionObserver === \'undefined\')');
    expect(LOAD_SOURCE).toContain('let cancelled = false;');
    expect(LOAD_SOURCE).toContain('if (cancelled) return;');
    expect(LOAD_SOURCE).toContain('return () => { cancelled = true; };');
  });
});
