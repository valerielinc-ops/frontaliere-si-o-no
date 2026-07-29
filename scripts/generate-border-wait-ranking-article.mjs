#!/usr/bin/env node
/**
 * Register / refresh the EVERGREEN "best/worst dogane" wait-time ranking
 * blog article (chained on the border-wait feature, F8).
 *
 * One stable id (`classifica-dogane-ticino`) is registered ONCE into the blog
 * system (slug map + router union, ARTICLES registry, i18n meta, body files,
 * blog SEO/JSON-LD, sitemap, RSS) by reusing create-article.mjs's registrar —
 * no AI, no copy-paste of registration logic (AGENTS.md §6). On every later
 * run only the body files are rewritten with the current 7-day ranking (the
 * registrar is append-only), plus an updatedAt bump — so the repo never
 * floods with one new article per week (same pattern as issue #2963's
 * weekend-events digest). This script also writes a compact
 * `public/data/border-wait-ranking.json` snapshot consumed by the live
 * ranking chart injected into the article (InlineBorderWaitRanking) — under
 * `public/`, not repo-root `data/`, because only `public/` is copied into
 * the Vite build output (same placement as
 * `public/data/switzerland-unemployment-rate.json`); the component fetches
 * it same-origin at `/data/border-wait-ranking.json`.
 *
 * NOTE: this script imports `build-plugins/borderWaitData.ts` (via the
 * content builder) so it MUST run under `tsx`, not plain `node` — same
 * constraint as scripts/check-border-data-health.mjs.
 *
 * Usage:
 *   npx tsx scripts/generate-border-wait-ranking-article.mjs            # register or refresh
 *   DRY_RUN=1 npx tsx scripts/generate-border-wait-ranking-article.mjs  # plan only, no writes
 *   TODAY_ISO=2027-01-01 npx tsx scripts/...                            # pin "today" (tests/CI)
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { computeRanking, computeTrend, computeFunFacts, computeWeekWindow, computeMovers } from './lib/border-wait-ranking.mjs';
import { buildBorderWaitRankingArticle } from './lib/border-wait-ranking-content.mjs';
import { registerArticleFiles, checkArticleIdExists, buildBodyFile } from './create-article.mjs';
import { bumpUpdatedAt, bumpDateModified, bumpSitemapLastmod } from './lib/evergreen-article-refresh.mjs';
import { isTicinoCrossing } from '../build-plugins/borderWaitData.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOCALES = ['it', 'en', 'de', 'fr'];
const HISTORY_DIR = path.join(REPO_ROOT, 'data', 'border-wait-history');
const RANKING_JSON_PATH = path.join(REPO_ROOT, 'public', 'data', 'border-wait-ranking.json');

// Evergreen metadata — registered once, NEVER refreshed (no date/count inside).
const STATIC_META = {
  category: 'novita',
  image: 'mendrisio.webp', // → /images/places/mendrisio.webp (exists in catalog, dogana/confine keywords)
  hasCalculator: false,
  author: { slug: 'redazione', name: 'Redazione Frontaliere Ticino' },
  seo: {
    title: 'Classifica delle dogane in Ticino: le migliori e le peggiori',
    description:
      "Ogni dogana ticinese classificata per tempo medio di attesa, con trend settimanale e quanti minuti si perdono (o guadagnano) scegliendo un valico piuttosto che un altro.",
    keywords:
      'dogane ticino, tempi attesa dogana, classifica dogane, traffico confine ticino, valico ticino, coda dogana',
    ogTitle: 'Classifica delle dogane in Ticino',
    ogDescription:
      "Le dogane ticinesi classificate per tempo di attesa: le più veloci, le più lente, e quanti minuti di vita si perdono a sceglierne una piuttosto che un'altra.",
    headline: 'Classifica delle dogane in Ticino: le migliori e le peggiori per tempo di attesa',
    breadcrumbName: 'Classifica dogane',
  },
};

/** Compute the current ranking/trend/fun-facts/week-window/movers snapshot for todayIso. */
export function computeSnapshot(todayIso, historyDir = HISTORY_DIR) {
  // This snapshot feeds the evergreen "Classifica delle dogane in Ticino"
  // article + its embedded live chart (buildRankingJson below) — both
  // Ticino-only by identity. computeRanking/computeTrend are generic
  // aggregation over ALL registered crossings (now 93, incl. the 67
  // Germany-corridor ones from #4889), so scope to Ticino here, once,
  // before funFacts/movers derive from it — otherwise a German crossing
  // could surface as this Ticino-only article's best/worst/biggest mover.
  const rankingAll = computeRanking(historyDir, todayIso, { days: 7 });
  const ranking = rankingAll
    .filter((r) => isTicinoCrossing(r.slug))
    .map((r, idx) => ({ ...r, rank: idx + 1 }));
  const trendAll = computeTrend(historyDir, todayIso, { days: 7 });
  const trend = Object.fromEntries(Object.entries(trendAll).filter(([slug]) => isTicinoCrossing(slug)));
  const funFacts = computeFunFacts(ranking);
  const { weekStart, weekEnd } = computeWeekWindow(todayIso, 7);
  const movers = computeMovers(trend);
  return { ranking, trend, funFacts, weekStart, weekEnd, movers };
}

/** Build the full registration `data` object from the current ranking snapshot. */
export function buildData(todayIso, historyDir = HISTORY_DIR) {
  const { ranking, trend, funFacts, weekStart, weekEnd, movers } = computeSnapshot(todayIso, historyDir);
  const article = buildBorderWaitRankingArticle({ ranking, trend, funFacts, weekStart, weekEnd, movers, todayIso });
  return {
    id: article.id,
    ...STATIC_META,
    slugs: article.slugs,
    imageAlt: article.imageAlt,
    content: article.content,
    _rankedCount: article._rankedCount,
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

/**
 * Compact per-crossing ranking snapshot for the live chart component
 * (services/borderWaitRankingService.ts → InlineBorderWaitRanking). Kept
 * separate from the (much larger) article body payload.
 */
export function buildRankingJson({ ranking, trend, funFacts, todayIso, weekStart, weekEnd, movers }) {
  return {
    updatedAt: todayIso,
    windowDays: 7,
    weekStart,
    weekEnd,
    ranking: ranking.map((r) => ({
      slug: r.slug,
      rank: r.rank,
      avgMinutes: Math.round(r.avgMinutes * 10) / 10,
      totalSamples: r.totalSamples,
      trend: trend[r.slug]?.direction || 'flat',
      deltaMinutes: trend[r.slug]?.deltaMinutes != null ? Math.round(trend[r.slug].deltaMinutes * 10) / 10 : null,
    })),
    funFacts,
    movers,
  };
}

async function main() {
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  const todayIso = process.env.TODAY_ISO || new Date().toISOString().slice(0, 10);
  const { ranking, trend, funFacts, weekStart, weekEnd, movers } = computeSnapshot(todayIso);
  const data = buildData(todayIso);
  const exists = checkArticleIdExists(data.id);

  console.log(
    `🛂 border-wait ranking article — id=${data.id} ranked=${data._rankedCount} exists=${exists} dry=${dryRun}`,
  );

  if (dryRun) {
    console.log('DRY_RUN — no files written.');
    console.log('  IT title :', data.content.it.title);
    console.log('  IT body1 :', data.content.it.body1.slice(0, 200).replace(/\n/g, ' '));
    return;
  }

  mkdirSync(path.dirname(RANKING_JSON_PATH), { recursive: true });
  writeFileSync(
    RANKING_JSON_PATH,
    JSON.stringify(buildRankingJson({ ranking, trend, funFacts, todayIso, weekStart, weekEnd, movers }), null, 2) + '\n',
  );
  console.log(`  ✅ ${path.relative(REPO_ROOT, RANKING_JSON_PATH)}`);

  if (!exists) {
    console.log('📂 first run — registering the evergreen article across the blog system…');
    await registerArticleFiles(data, { skipNews: true }); // evergreen → not a Google News item
    console.log('✅ registered.');
    return;
  }

  // Refresh only the body files + updatedAt. RSS feeds read the blog SEO file
  // (evergreen headline/description), NOT the body, so they don't need to be
  // regenerated on a body refresh — that would churn ~4 MB of feed files for
  // no content change (same rationale as generate-events-digest-article.mjs).
  console.log('♻️  refreshing body files (article already registered)…');
  refreshBodyFiles(data);
  if (!bumpUpdatedAt(data.id, todayIso)) console.warn('⚠️  updatedAt not bumped (entry not matched).');
  if (!bumpDateModified(data.id, `${todayIso}T00:00:00+02:00`)) {
    console.warn('⚠️  dateModified not bumped (entry/regex not matched) — freshness signal may be stale.');
  }
  if (!bumpSitemapLastmod(data.slugs.it, todayIso)) {
    console.warn('⚠️  sitemap-blog lastmod not bumped (url block not matched) — freshness signal may be stale.');
  }
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
