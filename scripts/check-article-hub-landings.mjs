#!/usr/bin/env node
/**
 * Is anybody still writing the article-hub landings?
 *
 * ─── The failure this exists to catch ────────────────────────────────────
 * `/articoli-frontaliere/` and `/articoli-svizzera/` (x4 locales) are the
 * entry surface for 3702 articles. Two producers can write them, and for a
 * week neither did:
 *
 *   - the SITE cannot — `scripts/lib/deploy-shard-sections.sh` excludes both
 *     article sections from the shard push loop, so nothing this build emits
 *     for them reaches the shard the Worker serves;
 *   - the CORPUS would not — its refresher could only SWAP an existing
 *     `ssg-article-grid`, and `/articoli-svizzera/` (emitted by the generic
 *     fallback branch, before the hub branch existed) had no marker to swap.
 *     It logged "nothing to refresh" and exited 0.
 *
 * Both sides were behaving as written. Nothing failed, nothing was red, and
 * 617 articles sat behind 9 KB of copy. `ensureArticleHubCards` makes that
 * state unreachable by construction, and `tests/build-emit-skip-gate.test.ts`
 * pins the invariant in the source — but the source is not what serves. This
 * probe asks production directly, which is the only check that stays true when
 * the next handoff moves a path somewhere neither test is looking.
 *
 * ─── What "healthy" means ────────────────────────────────────────────────
 * Per landing: 200, the grid marker present, at least MIN_CARDS cards, and
 * the section's newest published article linked from it. The last one is the
 * staleness test — it needs no clock and no date parsing across four locales:
 * the hub is fresh exactly when it shows what the corpus most recently
 * published.
 *
 * Plus, on the landing AND on its `/tutti/` archive: no same-origin
 * `/assets/…` reference (issue #5270). That one is not a staleness question,
 * it is a "was this page ever put through the CDN offload" question, and it
 * needs to be asked HERE for the same reason the rest of this probe does —
 * the two pages have different writers in two different repos, and asserting
 * the ordering in one repo's source leaves the other repo's publishes
 * unguarded. `scripts/lib/article-archive-assets.mjs` documents the failure
 * mode and owns the pattern.
 *
 * And, on each `/tutti/` archive: every topic hub the section's own
 * `sitemap-topics-<section>.xml` announces for that locale must be linked from
 * it. That is the one question here whose answer moves when the RENDERER
 * changes rather than when the corpus does — issue #5432: #5422's "Argomenti"
 * nav sat on `main` for twelve hours while `/articoli-svizzera/tutti/` kept
 * serving the previous renderer, because an archive is re-rendered only as a
 * side effect of publishing into its section and `svizzera` had stopped
 * publishing. Every other check on this page stayed green throughout — the
 * corpus-relative staleness test above says a section that never publishes is
 * fresh for ever. `scripts/lib/archive-topic-anchors.mjs` owns the comparison
 * and records why a marker on the nav's CLASS does not work: the topics nav
 * and the page ladder emit the same one.
 *
 * Usage:
 *   node scripts/check-article-hub-landings.mjs
 *   MIN_CARDS=50 SITE_ORIGIN=https://frontaliereticino.ch node scripts/...
 *
 * Exits non-zero when any landing is degraded, and writes a `summary` output
 * for the workflow to put in the issue body.
 */

import { appendFileSync } from 'node:fs';

import { SECTION_ROUTES } from '../infra/cloudflare-worker/locale-router.js';
import {
  archiveTopicAnchorProblems,
  topicHubPage1Paths,
} from './lib/archive-topic-anchors.mjs';
import {
  ARCHIVE_ALL_SLUG,
  countSameOriginAssetRefs,
} from './lib/article-archive-assets.mjs';
import { ARTICLES_API_BASE as API_BASE } from './lib/articles-api-base.mjs';
import { EXTERNALLY_SERVED_SECTIONS } from './lib/externally-served-paths.mjs';

const SITE_ORIGIN = process.env.SITE_ORIGIN ?? 'https://frontaliereticino.ch';
/**
 * Both hubs render 100 cards. The floor is deliberately far below that: this
 * is a "did the grid disappear" probe, not a card-count ratchet, and a corpus
 * that legitimately shrinks must not page anyone.
 */
const MIN_CARDS = Number(process.env.MIN_CARDS ?? 50);

const GRID_OPEN = '<div class="ssg-article-grid">';
const CARD_RX = /class="ssg-art-card"/g;

/**
 * Which API documents describe each handed-off section, and which section
 * sitemap announces its topic hubs. The sitemap is served by the SITE deploy
 * while the archive HTML is written by the CORPUS publisher, so comparing one
 * against the other is a cross-producer drift check — see
 * `scripts/lib/archive-topic-anchors.mjs` for why that comparison, and not a
 * marker on the nav's class, is what catches issue #5432.
 */
const SECTION_API = {
  articolifrontaliere: {
    articles: 'articles.json',
    slugKey: 'blog',
    topicsSitemap: 'sitemap-topics-frontaliere.xml',
  },
  articolisvizzera: {
    articles: 'swiss-articles.json',
    slugKey: 'swiss',
    topicsSitemap: 'sitemap-topics-svizzera.xml',
  },
};

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'check-article-hub-landings' } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'check-article-hub-landings' } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

async function main() {
  // Derived from the Worker's own routing table via EXTERNALLY_SERVED_SECTIONS,
  // so a section handed off tomorrow is covered without editing this file —
  // which is the whole point: the gap opened where nobody was looking.
  const routes = SECTION_ROUTES.filter((r) => EXTERNALLY_SERVED_SECTIONS.has(r.section));
  if (routes.length === 0) {
    console.error(
      '::error::no externally-served section routes — EXTERNALLY_SERVED_SECTIONS and '
      + 'SECTION_ROUTES disagree, so this probe would silently check nothing',
    );
    process.exit(1);
  }

  const slugs = await getJson(`${API_BASE}/slugs.json`);
  /** section -> newest published article id, by date desc. */
  const newestBySection = new Map();
  /** section -> the raw `sitemap-topics-<section>.xml` the site publishes. */
  const topicSitemapBySection = new Map();
  for (const section of new Set(routes.map((r) => r.section))) {
    const api = SECTION_API[section];
    if (!api) {
      console.error(`::error::no API mapping for handed-off section "${section}"`);
      process.exit(1);
    }
    const articles = await getJson(`${API_BASE}/${api.articles}`);
    const newest = [...articles].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
    if (!newest) {
      console.error(`::error::${api.articles} is empty`);
      process.exit(1);
    }
    newestBySection.set(section, { id: newest.id, slugKey: api.slugKey });
    topicSitemapBySection.set(section, await getText(`${SITE_ORIGIN}/${api.topicsSitemap}`));
  }

  // ── What each archive is REQUIRED to link ─────────────────────────────────
  //
  // Computed up front and structurally, because the interesting failure of a
  // guard is not "it went red", it is "it went green against nothing". An
  // archive whose section sitemap announces no topic hub for its locale cannot
  // be judged: `archiveTopicAnchorProblems` refuses that input, and so does
  // this loop — loudly, before a single page is fetched, rather than by
  // reporting sixteen healthy pages.
  const expectedTopicsByRoute = new Map();
  for (const route of routes) {
    const expected = topicHubPage1Paths(topicSitemapBySection.get(route.section), route.prefix);
    if (expected.length === 0) {
      console.error(
        `::error::${SECTION_API[route.section].topicsSitemap} announces no topic hub under `
        + `"${route.prefix}/" — either the sitemap moved or the topic tier stopped being `
        + 'published; either way this probe would check nothing for that archive',
      );
      process.exit(1);
    }
    expectedTopicsByRoute.set(`${route.section}/${route.locale}`, expected);
  }

  const lines = [];
  let failed = 0;

  for (const route of routes) {
    const url = `${SITE_ORIGIN}${route.prefix}/`;
    const label = `${route.section}/${route.locale}`;
    let html;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'check-article-hub-landings' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (err) {
      lines.push(`FAIL ${label} ${url} — ${err.message}`);
      failed++;
      continue;
    }

    const problems = [];
    if (!html.includes(GRID_OPEN)) {
      // THE symptom. A landing with no marker is one no writer can refresh:
      // the site is not on its serving path and the corpus needs the marker.
      problems.push('no ssg-article-grid marker — no writer can refresh this page');
    }
    const cards = (html.match(CARD_RX) ?? []).length;
    if (cards < MIN_CARDS) problems.push(`${cards} cards, under the ${MIN_CARDS} floor`);

    const newest = newestBySection.get(route.section);
    const newestSlug = slugs[newest.slugKey]?.[newest.id]?.[route.locale];
    if (!newestSlug) {
      problems.push(`slugs.json has no ${route.locale} slug for the newest article "${newest.id}"`);
    } else {
      const prefix = route.prefix;
      // Accept both link shapes: the slashed canonical this build emits and
      // the legacy no-slash form still on pages the corpus has not rewritten
      // yet. Staleness is the question here, not link canonicalisation.
      const slashed = `href="${prefix}/${newestSlug}/"`;
      const bare = `href="${prefix}/${newestSlug}"`;
      if (!html.includes(slashed) && !html.includes(bare)) {
        problems.push(`does not link the newest article "${newest.id}" (${newestSlug}) — stale`);
      }
    }

    const strayAssets = countSameOriginAssetRefs(html);
    if (strayAssets > 0) {
      problems.push(`${strayAssets} same-origin /assets/ refs — all 404, page renders unstyled`);
    }

    if (problems.length > 0) {
      lines.push(`FAIL ${label} ${url} — ${problems.join('; ')}`);
      failed++;
    } else {
      lines.push(`ok   ${label} ${url} — ${cards} cards, newest article linked`);
    }

    // ── The /tutti/ archive, same section, same locale ────────────────────
    //
    // Added after #5270: the landing and the archive have DIFFERENT writers,
    // and only the landing was watched. The landing is refreshed by swapping
    // the card grid inside already-offloaded HTML, so its asset refs survive;
    // the archive is re-rendered whole by `renderArticleHubPages`, which emits
    // fresh `/assets/…` text that only the CDN offload rewrites. When the
    // publisher ran that offload BEFORE the archive render, the landing stayed
    // healthy and the archive shipped 9 dead refs — 200 OK, no CSS, no SPA.
    //
    // Two producers write these pages (this repo's fast-publish and the
    // corpus's own copy of the same script, which no mirror keeps in sync), so
    // a source-order test in either repo only covers half the traffic. This
    // asks the served bytes, which is the only question that stays answerable
    // when the next handoff moves the writer again.
    const archiveUrl = `${SITE_ORIGIN}${route.prefix}/${ARCHIVE_ALL_SLUG[route.locale]}/`;
    const archiveLabel = `${label} archive`;
    try {
      const res = await fetch(archiveUrl, {
        headers: { 'User-Agent': 'check-article-hub-landings' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const archiveHtml = await res.text();
      const archiveProblems = [];
      const stray = countSameOriginAssetRefs(archiveHtml);
      if (stray > 0) {
        archiveProblems.push(
          `${stray} same-origin /assets/ refs (404: no CSS, no SPA bundle, no AdSense `
          + 'loader) — the CDN offload ran BEFORE the archive was rendered (issue #5270)',
        );
      }
      // Renderer drift (issue #5432): the archive must link every topic hub
      // its section sitemap announces for this locale. Staleness measured
      // against the CODE's output, not against the corpus — a section that
      // stops publishing is "fresh" by the corpus test for ever, and that is
      // exactly the state that shipped twelve hours of unreachable hubs.
      const expectedTopics = expectedTopicsByRoute.get(label);
      archiveProblems.push(...archiveTopicAnchorProblems(archiveHtml, expectedTopics));

      if (archiveProblems.length > 0) {
        lines.push(`FAIL ${archiveLabel} ${archiveUrl} — ${archiveProblems.join('; ')}`);
        failed++;
      } else {
        lines.push(
          `ok   ${archiveLabel} ${archiveUrl} — asset refs on the CDN, `
          + `all ${expectedTopics.length} announced topic hubs linked`,
        );
      }
    } catch (err) {
      lines.push(`FAIL ${archiveLabel} ${archiveUrl} — ${err.message}`);
      failed++;
    }
  }

  const summary = lines.join('\n');
  console.log(summary);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `summary<<CHECK_EOF\n${summary}\nCHECK_EOF\n`,
      'utf-8',
    );
  }

  // Two pages per route since #5270: the landing and its /tutti/ archive.
  const probed = routes.length * 2;
  if (failed > 0) {
    console.error(`::error::${failed} of ${probed} article-hub pages are degraded`);
    process.exit(1);
  }
  console.log(`[hub-landings] all ${probed} pages healthy (${routes.length} landings + archives)`);
}

main().catch((err) => {
  console.error(`::error::${err.stack ?? err.message}`);
  process.exit(1);
});
