/**
 * Does the SERVED `/tutti/` archive still link the topic hubs the site
 * ANNOUNCES for it?
 *
 * ─── The failure this exists to catch (issue #5432) ──────────────────────
 * #5422 added an "Argomenti" nav to every archive page so the topic-hub tier
 * stops being unreachable from `/`. The code landed on `main`; the pages did
 * not. Archive pages are re-rendered only as a side effect of publishing an
 * article INTO THAT SECTION, so `svizzera` — which had not published since
 * 2026-08-08T21:38Z, 64 minutes before the merge — kept serving the old
 * renderer's output for twelve hours. `audit:max-bfs-depth` went red with
 * `sitemap-topics-svizzera.xml 120/120 unreachable` and nothing said why.
 *
 * The watchdog that should have said why was asking the wrong questions: HTTP
 * 200, a card grid, and staleness measured against the CORPUS (does the page
 * link the newest article?). A section that stops publishing is fresh by that
 * definition for ever, which is precisely the state that broke.
 *
 * ─── Why the answer is not a class marker ────────────────────────────────
 * The obvious probe is "does the HTML contain the topics `<nav>`". It does not
 * work, and the reason is worth pinning: `buildArchiveTopicsNavHtml` and the
 * flat page ladder emit the SAME scoped class, `s-4nYHgH`. Measured on the
 * drifted page itself — `frontaliere-articolisvizzera-it@d4580b04`,
 * `articoli-svizzera/tutti/index.html`, the last push before the unblock:
 *
 *     grep -o '<nav class="s-4nYHgH"'      -> 1   (the page ladder)
 *     grep -o 'href="[^"]*argomenti[^"]*"' -> 0   (no topic anchors at all)
 *
 * A presence check on that class reports the broken page healthy. It is not a
 * weaker guard than the href comparison, it is a guard that returns `ok` on
 * the exact input it was written for.
 *
 * ─── The source of truth, and why it needs no npm install ────────────────
 * `sitemap-topics-<section>.xml` is what `renderTopicClusterHubPages`
 * announces and what the BFS audit reads — the same document
 * `tests/article-hub-topics-nav.test.ts` pins the emitted hrefs against. It is
 * served from the site's own deploy, while the archive HTML is written by the
 * corpus's fast-publish: two independent producers, so a disagreement between
 * them is drift by construction, whichever side moved.
 *
 * That keeps the probe under bare `node`. Recomputing the expectation instead
 * — `computeEligibleTopicKeys` from `packages/articles/engine` — is TypeScript
 * (`npx -y tsx@4` would do, no `npm ci`, as `rerender-article-corpus.yml`
 * already shows), but it answers a different question: what the WATCHDOG's
 * checkout would emit, from the site repo's copy of the corpus, not what the
 * site published. Two extra HTTP GETs beat both a TypeScript loader and a
 * second corpus to disagree with.
 *
 * Everything here is derived from the sitemap and the route prefix. No topic
 * slug, no per-locale URL segment (`argomenti`/`topics`/`themen`/`sujets`) and
 * no class hash is restated, so a taxonomy change cannot silently retire the
 * check.
 */

/** Root-relative form of a sitemap `<loc>`, so it compares to an `href`. */
function toPath(loc) {
  return loc.replace(/^https?:\/\/[^/]+/, '');
}

/**
 * The page-1 topic-hub paths the section sitemap announces UNDER one route
 * prefix — i.e. for one section AND one locale, since the prefix carries both
 * (`/articoli-svizzera`, `/en/swiss-articles`, …). One document covers all
 * four locales; this is the slice that belongs to the archive being probed.
 *
 * Page 1 is `<prefix>/<segment>/<slug>/` — exactly two segments past the
 * prefix. `<…>/page-N/` is three, and is deliberately excluded: the archive
 * links page 1 of each hub, and the ladder from there is the hub's own job.
 */
export function topicHubPage1Paths(sitemapXml, routePrefix) {
  const under = `${routePrefix}/`;
  const out = new Set();
  for (const m of sitemapXml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const path = toPath(m[1]);
    if (!path.startsWith(under)) continue;
    if (path.slice(under.length).split('/').filter(Boolean).length !== 2) continue;
    out.add(path);
  }
  return [...out].sort();
}

/**
 * `<prefix>/<segment>/` — the shared base of every topic-hub URL of a route,
 * read off the expectation rather than restated. Used to tell a topic anchor
 * from any other link on the page without knowing the locale's segment word.
 */
export function topicHubBasePath(expectedPaths) {
  if (expectedPaths.length === 0) return null;
  const first = expectedPaths[0];
  return first.slice(0, first.lastIndexOf('/', first.length - 2) + 1);
}

/**
 * Compare a served archive page against the announced set, both directions.
 *
 * Returns a (possibly empty) array of human-readable problems. Throws on an
 * empty expectation: a comparison against nothing passes every input, and a
 * guard that cannot fail is the failure mode this whole file exists to
 * prevent. The caller must decide that case loudly, before probing.
 */
export function archiveTopicAnchorProblems(archiveHtml, expectedPaths) {
  const base = topicHubBasePath(expectedPaths);
  if (base === null) {
    throw new Error('archiveTopicAnchorProblems: empty expectation — refusing a vacuous comparison');
  }

  const linked = new Set();
  for (const m of archiveHtml.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)) {
    let href = m[1];
    if (!href.startsWith(base)) continue;
    // Accept the legacy no-slash form: this asks whether the hub is linked,
    // not whether the link is canonical (same call as the landing probe's).
    if (!href.endsWith('/')) href += '/';
    linked.add(href);
  }

  const problems = [];

  const missing = expectedPaths.filter((p) => !linked.has(p));
  if (missing.length > 0) {
    problems.push(
      `${missing.length}/${expectedPaths.length} announced topic-hub anchors missing `
      + `(${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}) — the served `
      + 'page predates the "Argomenti" nav of #5422/#5423, so every URL in '
      + 'sitemap-topics-*.xml is unreachable from it (renderer drift, issue #5432)',
    );
  }

  const announced = new Set(expectedPaths);
  const stray = [...linked].filter(
    (href) => href.slice(base.length).split('/').filter(Boolean).length === 1
      && !announced.has(href),
  );
  if (stray.length > 0) {
    problems.push(
      `${stray.length} topic-hub anchors the section sitemap does not announce `
      + `(${stray.slice(0, 3).join(', ')}${stray.length > 3 ? ', …' : ''}) — the archive is `
      + 'ahead of the published sitemap, or links hubs that were never rendered',
    );
  }

  return problems;
}
