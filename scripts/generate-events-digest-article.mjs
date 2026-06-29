#!/usr/bin/env node
/**
 * Register / refresh the EVERGREEN "weekend events in Ticino" digest blog article
 * (chained feature on issue #2963).
 *
 * One stable id (`eventi-weekend-ticino`) is registered ONCE into the blog system
 * (slug map + router union, ARTICLES registry, i18n meta, body files, blog
 * SEO/JSON-LD, sitemap, RSS) by reusing create-article.mjs's registrar — no
 * AI, no copy-paste of registration logic (AGENTS.md §6). On every later run only
 * the four body files are rewritten with the current weekend's events (the
 * registrar is append-only), plus an updatedAt bump and an RSS refresh — so the
 * repo never floods with one new article per week (#2963: "avoid flooding the
 * repo"). The always-fresh per-weekend surface stays the SSG digest landing pages
 * (`/eventi/ticino/questo-weekend/`), which this article links to.
 *
 * Usage:
 *   node scripts/generate-events-digest-article.mjs            # register or refresh
 *   DRY_RUN=1 node scripts/generate-events-digest-article.mjs  # plan only, no writes
 *   TODAY_ISO=2027-01-01 node scripts/...                      # pin "today" (tests/CI)
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadEventsDataset, isoDay } from './lib/events-utils.mjs';
import { buildWeekendDigestArticle } from './lib/events-digest-content.mjs';
import { registerArticleFiles, checkArticleIdExists, buildBodyFile } from './create-article.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOCALES = ['it', 'en', 'de', 'fr'];

// Evergreen metadata — registered once, NEVER refreshed (no date/count inside).
const STATIC_META = {
  category: 'novita',
  image: 'lugano-view.webp', // → /images/places/lugano-view.webp (exists in catalog)
  hasCalculator: false,
  author: { slug: 'redazione', name: 'Redazione Frontaliere Ticino' },
  seo: {
    title: 'Eventi del weekend in Ticino: cosa fare',
    description:
      'Agenda degli eventi del weekend in Ticino: concerti, mostre, feste e mercati, comune per comune, aggiornata ogni giorno.',
    keywords: 'eventi ticino, eventi weekend ticino, cosa fare in ticino, agenda eventi ticino, eventi lugano',
    ogTitle: 'Eventi del weekend in Ticino',
    ogDescription:
      'Concerti, mostre, feste e mercati questo weekend in Ticino, comune per comune. Aggiornato ogni giorno.',
    headline: 'Eventi del weekend in Ticino: cosa fare sabato e domenica',
    breadcrumbName: 'Eventi del weekend',
  },
};

/** Build the full registration `data` object from the current weekend's events. */
export function buildData(todayIso) {
  const dataset = loadEventsDataset(path.join(REPO_ROOT, 'data', 'events.json'));
  const article = buildWeekendDigestArticle({ events: dataset.events, todayIso });
  return {
    id: article.id,
    ...STATIC_META,
    slugs: article.slugs,
    imageAlt: article.imageAlt,
    content: article.content,
    _eventCount: article.eventCount,
    _weekend: `${article.weekendStart}..${article.weekendEnd}`,
  };
}

/** Rewrite only the 4 body files (idempotent refresh; registration is append-only). */
export function refreshBodyFiles(data, repoRoot = REPO_ROOT, log = console.log) {
  for (const locale of LOCALES) {
    const dir = path.join(repoRoot, 'services', 'locales', 'blog-body', locale);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${data.id}.ts`);
    writeFileSync(file, buildBodyFile(data, locale));
    log(`  ✅ ${path.relative(repoRoot, file)}`);
  }
}

/** Bump (or insert) updatedAt on the ARTICLES entry so sitemap lastmod reflects the refresh. */
export function bumpUpdatedAt(id, todayIso, repoRoot = REPO_ROOT) {
  const file = path.join(repoRoot, 'data', 'blog-articles-data.ts');
  let src = readFileSync(file, 'utf-8');
  const entryRe = new RegExp(`(\\n([ \\t]*)id: '${id}',[\\s\\S]*?)(\\n[ \\t]*\\},)`);
  const m = src.match(entryRe);
  if (!m) return false;
  const indent = m[2];
  let block = m[1];
  if (/updatedAt:/.test(block)) {
    block = block.replace(/updatedAt: '[^']*'/, `updatedAt: '${todayIso}'`);
  } else {
    block = block.replace(/(\n[ \t]*date: '[^']*',)/, `$1\n${indent}updatedAt: '${todayIso}',`);
  }
  if (block === m[1]) return false;
  src = src.replace(m[1], block);
  writeFileSync(file, src);
  return true;
}

async function main() {
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  const todayIso = process.env.TODAY_ISO || isoDay(new Date());
  const data = buildData(todayIso);
  const exists = checkArticleIdExists(data.id);

  console.log(
    `🗓️  events digest article — id=${data.id} weekend=${data._weekend} events=${data._eventCount} exists=${exists} dry=${dryRun}`,
  );

  if (dryRun) {
    console.log('DRY_RUN — no files written.');
    console.log('  IT title :', data.content.it.title);
    console.log('  IT body1 :', data.content.it.body1.slice(0, 160).replace(/\n/g, ' '));
    return;
  }

  if (!exists) {
    console.log('📂 first run — registering the evergreen article across the blog system…');
    await registerArticleFiles(data, { skipNews: true }); // evergreen → not a Google News item
    console.log('✅ registered.');
    return;
  }

  // Refresh only the body files + updatedAt. RSS feeds read the blog SEO file
  // (evergreen headline/description), NOT the body, so they don't need to be
  // regenerated on a body refresh — that would churn ~4 MB of feed files for no
  // content change.
  console.log('♻️  refreshing body files (article already registered)…');
  refreshBodyFiles(data);
  bumpUpdatedAt(data.id, todayIso);
  console.log('✅ refreshed.');
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || '').href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
  });
}
