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
 * Usage:
 *   node scripts/check-article-hub-landings.mjs
 *   MIN_CARDS=50 SITE_ORIGIN=https://frontaliereticino.ch node scripts/...
 *
 * Exits non-zero when any landing is degraded, and writes a `summary` output
 * for the workflow to put in the issue body.
 */

import { appendFileSync } from 'node:fs';

import { SECTION_ROUTES } from '../infra/cloudflare-worker/locale-router.js';
import { EXTERNALLY_SERVED_SECTIONS } from './lib/externally-served-paths.mjs';

const SITE_ORIGIN = process.env.SITE_ORIGIN ?? 'https://frontaliereticino.ch';
const API_BASE =
  process.env.ARTICLES_API_BASE ?? 'https://nanakokyobashi-rgb.github.io/frontaliere-articles';
/**
 * Both hubs render 100 cards. The floor is deliberately far below that: this
 * is a "did the grid disappear" probe, not a card-count ratchet, and a corpus
 * that legitimately shrinks must not page anyone.
 */
const MIN_CARDS = Number(process.env.MIN_CARDS ?? 50);

const GRID_OPEN = '<div class="ssg-article-grid">';
const CARD_RX = /class="ssg-art-card"/g;

/** Which API documents describe each handed-off section. */
const SECTION_API = {
  articolifrontaliere: { articles: 'articles.json', slugKey: 'blog' },
  articolisvizzera: { articles: 'swiss-articles.json', slugKey: 'swiss' },
};

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

    if (problems.length > 0) {
      lines.push(`FAIL ${label} ${url} — ${problems.join('; ')}`);
      failed++;
    } else {
      lines.push(`ok   ${label} ${url} — ${cards} cards, newest article linked`);
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

  if (failed > 0) {
    console.error(`::error::${failed} of ${routes.length} article-hub landings are degraded`);
    process.exit(1);
  }
  console.log(`[hub-landings] all ${routes.length} landings healthy`);
}

main().catch((err) => {
  console.error(`::error::${err.stack ?? err.message}`);
  process.exit(1);
});
