import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FACEBOOK_ARTICLE_LEDGER_RELATIVE_PATH,
  recordManualFacebookArticlePost,
} from '../scripts/lib/facebook-manual-post-ledger.mjs';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('manual Facebook article ledger', () => {
  it('uses the shared Meta Graph API base for publishing and token setup', () => {
    const publisher = readFileSync(new URL('../scripts/post-to-facebook.mjs', import.meta.url), 'utf8');
    const setup = readFileSync(new URL('../scripts/setup-facebook-token.mjs', import.meta.url), 'utf8');
    const setupLib = readFileSync(new URL('../scripts/lib/facebook-token-setup.mjs', import.meta.url), 'utf8');

    expect(publisher).toContain("ARTICLE_PLACE_ID, GRAPH_API } from './lib/social-post-utils.mjs'");
    expect(publisher).toContain('${GRAPH_API}/');
    expect(publisher).not.toContain('graph.facebook.com/v21.0');
    expect(setupLib).toContain("import { GRAPH_API } from './instagram-graph-constants.mjs'");
    expect(setupLib).toContain('${GRAPH_API}/');
    expect(setupLib).not.toContain('graph.facebook.com/v21.0');
  });

  it('provisions Facebook credentials without exposing tokens in argv or output', () => {
    const setup = readFileSync(new URL('../scripts/setup-facebook-token.mjs', import.meta.url), 'utf8');
    const setupLib = readFileSync(new URL('../scripts/lib/facebook-token-setup.mjs', import.meta.url), 'utf8');

    expect(setup).not.toContain('process.argv.slice(2)');
    expect(setup).not.toContain('FB_SHORT_LIVED_USER_TOKEN=');
    expect(setup).toContain('result.instagramPublisherConfigured');
    expect(setup).not.toContain('result.instagramBusinessAccountLinked');
    expect(setupLib).not.toContain('console.log(');
    expect(setupLib).not.toContain('console.error(');
    expect(setupLib).not.toContain('gh secret set');
    expect(setupLib).toContain('SERVER_FB_PAGE_ACCESS_TOKEN');
    expect(setupLib).toContain('SERVER_FB_USER_ACCESS_TOKEN');
  });

  it('keeps the reservation held until the canonical ledger write succeeds', () => {
    const publisher = readFileSync(new URL('../scripts/post-to-facebook.mjs', import.meta.url), 'utf8');
    const acceptedPost = publisher.slice(publisher.indexOf('if (response?.ok && data?.id)'));

    expect(acceptedPost.indexOf('recordManualFacebookArticlePost(')).toBeGreaterThanOrEqual(0);
    expect(acceptedPost.indexOf('markSocialPublishReservationPublished('))
      .toBeGreaterThan(acceptedPost.indexOf('recordManualFacebookArticlePost('));
    expect(acceptedPost).toMatch(/if \(canonicalLedgerWritten\)\s*\{[\s\S]*markSocialPublishReservationPublished/u);
  });

  it('writes confirmed native IDs to the canonical scheduled-article ledger', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'fb-manual-ledger-'));
    roots.push(repoRoot);
    mkdirSync(path.join(repoRoot, 'data'));

    recordManualFacebookArticlePost({
      repoRoot,
      articleId: 'cross-border-tax-guide',
      url: 'https://frontaliereticino.ch/articoli-frontaliere/cross-border-tax-guide/',
      postId: 'page_123_456',
      publishedAt: '2026-11-03T12:00:00.000Z',
    });

    const ledger = JSON.parse(readFileSync(path.join(repoRoot, FACEBOOK_ARTICLE_LEDGER_RELATIVE_PATH), 'utf8'));
    expect(ledger).toEqual({
      schemaVersion: 1,
      posted: [{
        id: 'cross-border-tax-guide',
        url: 'https://frontaliereticino.ch/articoli-frontaliere/cross-border-tax-guide/',
        ts: '2026-11-03T12:00:00.000Z',
        fbPostId: 'page_123_456',
        via: 'manual-cli',
      }],
    });
  });

  it('rejects an untrusted native ID or noncanonical non-HTTPS URL before writing', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'fb-manual-ledger-'));
    roots.push(repoRoot);
    mkdirSync(path.join(repoRoot, 'data'));

    expect(() => recordManualFacebookArticlePost({
      repoRoot,
      articleId: 'article',
      url: 'http://example.test/article/',
      postId: 'page_123_456',
      publishedAt: '2026-11-03T12:00:00.000Z',
    })).toThrow('absolute HTTPS URL');
  });
});
