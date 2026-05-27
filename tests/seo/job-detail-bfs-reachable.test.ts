/**
 * job-detail-bfs-reachable.test.ts
 *
 * Regression test for the orphan-pages-in-sitemaps gate on job-detail pages.
 * Apr 2026 audit found 1039/2409 job-detail pages were unreachable via BFS
 * from `/`. The fix densified outbound links: city/sector hubs now embed
 * 60-90 detail-page cards (was 30) and each detail page links to 10 related
 * jobs (was 4).
 *
 * This test synthesises a tiny dist tree (hub → archive → 3 detail pages)
 * in-memory, runs a BFS from the hub, and asserts all 3 detail pages are
 * reachable. It does NOT rely on the production crawl pipeline — it
 * verifies the BFS graph property the audit depends on.
 */

import { describe, expect, it } from 'vitest';

/** BFS over an in-memory map of `path → outboundPaths`, starting at `start`. */
function bfsReachable(
  graph: Record<string, string[]>,
  start: string,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [start];
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const outbound = graph[path] ?? [];
    for (const next of outbound) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

describe('Job-detail BFS reachability — synthetic dist tree', () => {
  it('hub → archive → 3 detail pages: all 3 details reachable from hub', () => {
    const graph: Record<string, string[]> = {
      '/': ['/cerca-lavoro-ticino/'],
      '/cerca-lavoro-ticino/': ['/cerca-lavoro-ticino/lugano/'],
      '/cerca-lavoro-ticino/lugano/': [
        // City hub embeds detail-page cards directly (60-job cap → all reachable).
        '/cerca-lavoro-ticino/dev-acme-lugano/',
        '/cerca-lavoro-ticino/nurse-eoc-lugano/',
        '/cerca-lavoro-ticino/manager-bsi-lugano/',
      ],
      '/cerca-lavoro-ticino/dev-acme-lugano/': [],
      '/cerca-lavoro-ticino/nurse-eoc-lugano/': [],
      '/cerca-lavoro-ticino/manager-bsi-lugano/': [],
    };

    const reachable = bfsReachable(graph, '/');
    expect(reachable.has('/cerca-lavoro-ticino/dev-acme-lugano/')).toBe(true);
    expect(reachable.has('/cerca-lavoro-ticino/nurse-eoc-lugano/')).toBe(true);
    expect(reachable.has('/cerca-lavoro-ticino/manager-bsi-lugano/')).toBe(true);
    expect(reachable.size).toBe(6);
  });

  it('related-jobs cross-link block creates BFS edges between detail pages', () => {
    // Simulate the post-fix graph where each detail page links to 10
    // related jobs (capped to the 3 we have). With this, even details
    // not directly embedded by the hub stay reachable through siblings.
    const graph: Record<string, string[]> = {
      '/': ['/cerca-lavoro-ticino/'],
      '/cerca-lavoro-ticino/': ['/cerca-lavoro-ticino/lugano/'],
      // Hub only embeds ONE detail (worst case after a deep cap).
      '/cerca-lavoro-ticino/lugano/': ['/cerca-lavoro-ticino/dev-acme-lugano/'],
      // Each detail links to 2 related (the post-fix related-jobs block).
      '/cerca-lavoro-ticino/dev-acme-lugano/': [
        '/cerca-lavoro-ticino/nurse-eoc-lugano/',
        '/cerca-lavoro-ticino/manager-bsi-lugano/',
      ],
      '/cerca-lavoro-ticino/nurse-eoc-lugano/': [
        '/cerca-lavoro-ticino/dev-acme-lugano/',
        '/cerca-lavoro-ticino/manager-bsi-lugano/',
      ],
      '/cerca-lavoro-ticino/manager-bsi-lugano/': [
        '/cerca-lavoro-ticino/dev-acme-lugano/',
        '/cerca-lavoro-ticino/nurse-eoc-lugano/',
      ],
    };

    const reachable = bfsReachable(graph, '/');
    expect(reachable.has('/cerca-lavoro-ticino/dev-acme-lugano/')).toBe(true);
    expect(reachable.has('/cerca-lavoro-ticino/nurse-eoc-lugano/')).toBe(true);
    expect(reachable.has('/cerca-lavoro-ticino/manager-bsi-lugano/')).toBe(true);
  });

  it('orphan detail (no edge from any reachable page) is correctly classified as orphan', () => {
    // Negative case: a page with no inbound edge stays unreachable.
    const graph: Record<string, string[]> = {
      '/': ['/cerca-lavoro-ticino/'],
      '/cerca-lavoro-ticino/': ['/cerca-lavoro-ticino/lugano/'],
      '/cerca-lavoro-ticino/lugano/': ['/cerca-lavoro-ticino/dev-acme-lugano/'],
      '/cerca-lavoro-ticino/dev-acme-lugano/': [],
      // Orphan — no edge from any reachable page.
      '/cerca-lavoro-ticino/orphan-fixture/': [],
    };

    const reachable = bfsReachable(graph, '/');
    expect(reachable.has('/cerca-lavoro-ticino/dev-acme-lugano/')).toBe(true);
    expect(reachable.has('/cerca-lavoro-ticino/orphan-fixture/')).toBe(false);
  });
});
