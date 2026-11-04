/**
 * adminDataPlugin — Copy source-level data files to dist/data/ at build time.
 *
 * These JSON files live in data/ at source level (updated by CI crawlers or
 * scheduled refresh workflows) and are fetched at runtime from /data/*.json.
 * Rather than duplicating them into public/, this plugin copies them
 * into the final dist/data/ directory during build so they're served
 * by GitHub Pages — and, after `scripts/offload-generated-images-cdn.mjs`
 * runs, by the CDN (the deploy `cp -r dist/data` precedes the offload, and
 * `services/cdnDataBase.ts` cdnDataUrl() resolves the runtime URL).
 *
 * Two lists, one copy implementation:
 *   - ADMIN_DATA_FILES   — consumed only by AdminPanel.tsx (internal tool).
 *   - RUNTIME_DATA_FILES — consumed by the public SPA at runtime.
 * The export name is kept as `adminDataPlugin` deliberately: it is referenced
 * from vite.config.ts and renaming it buys nothing over this docblock.
 */
import fs from 'fs';
import path from 'path';
import type { Plugin } from 'vite';
import { ADMIN_SECTION_SLUGS } from '../components/admin/adminSections';
import { buildAdminWorkflowSchedulePayload } from './adminWorkflowSchedules';
import { projectPermanentEmployerFeed } from '../scripts/lib/permanentEmployerProjection.mjs';
import { isDirectEmployerBuildEnabled } from '../services/directEmployerFeature';

/** Admin-only files to copy from data/ → dist/data/ (relative to project root). */
const ADMIN_DATA_FILES = [
 'data/jobs-crawler-config.json',
 'data/jobs-crawler-audit.json',
 'data/jobs-crawler-summaries.json',
 'data/ticino-companies-extra.json',
 'data/jobs-crawler-adapters/registry.json',
 // jobs-crawler-parser-proposals.json — copied when it exists
 'data/jobs-crawler-parser-proposals.json',
];

/**
 * Public-SPA files to copy from data/ → dist/data/.
 *
 * job-popularity.json (issue #5001): a {slug: viewCount} map refreshed by
 * .github/workflows/refresh-job-popularity.yml. It used to be a STATIC import
 * in components/community/JobBoard.tsx, so Rollup inlined it into the JobBoard
 * chunk — measured on production 2026-08-07: 3.6 MB of a 4.1 MB chunk (88%),
 * 812 KB gzipped, and that chunk is `modulepreload`ed at high priority by the
 * static shell of /cerca-lavoro-ticino/ (staticPagesPlugin sectionChunks). The
 * whole map exists to rank a 4-card "trending" strip. Serving it as a runtime
 * fetch takes it off the critical path.
 *
 * The runtime copy is also trimmed (trimJobPopularity): the source grew to 96,616
 * entries, 7.2 MB raw and 1.5 MB brotli on every job search and job detail view,
 * and 58,987 of those entries have exactly 1 view, which is noise for a ranking.
 */
const RUNTIME_DATA_FILES = [
 'data/job-popularity.json',
 'data/image-credits-blog.json',
];

// The miner's raw candidates include rationale and demand metrics. Publish only
// the explicit projection below; the raw source file must never enter dist/data.
export const EXPERIMENTAL_CANDIDATES_SOURCE_PATH = 'data/experimental-candidates.json';
export const EXPERIMENTAL_CANDIDATE_FEED_FILE_PATH = 'data/experimental-candidate-feed.json';
export const EXPERIMENTAL_CANDIDATE_FEED_PATH = '/data/experimental-candidate-feed.json';
const GENERATED_RUNTIME_DATA_FILES = [EXPERIMENTAL_CANDIDATE_FEED_FILE_PATH];
const EXPERIMENTAL_CANDIDATE_KEYWORD_MAX_LENGTH = 180;
const EXPERIMENTAL_CANDIDATE_ANGLE_MAX_LENGTH = 180;
const EXPERIMENTAL_CANDIDATE_FEED_MAX_COUNT = 100;
const EXPERIMENTAL_SOURCE_LABELS = new Map([
 ['redditTicino', 'reddit'],
 ['redditItaly', 'reddit'],
 ['redditLugano', 'reddit'],
 ['redditSwitzerland', 'reddit'],
 ['googleNewsRss', 'google-news-rss'],
]);
const EXPERIMENTAL_LOCALES = new Set(['it', 'en', 'de', 'fr']);

type ExperimentalCandidateFeedItem = {
 id: string;
 keyword: string;
 angle: string | null;
 locale: string;
 sources: string[];
 totalScore: number;
 redditPermalink?: string;
};

export type ExperimentalCandidateFeed = {
 schemaVersion: 1;
 generatedAt: string | null;
 candidates: ExperimentalCandidateFeedItem[];
};

function emptyExperimentalCandidateFeed(): ExperimentalCandidateFeed {
 return { schemaVersion: 1, generatedAt: null, candidates: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
 return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function boundedFeedText(value: unknown, maxLength: number): string | null {
 if (typeof value !== 'string') return null;
 const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
 const bounded = Array.from(cleaned).slice(0, maxLength).join('').trim();
 return bounded || null;
}

function normalizeRedditPermalink(value: unknown): string | null {
 if (typeof value !== 'string' || value.length > 2048) return null;
 try {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'www.reddit.com'
   || url.username || url.password || url.port
   || !/^\/r\/[a-z0-9_]+\/comments\/[a-z0-9]+(?:\/|$)/iu.test(url.pathname)) return null;
  url.search = '';
  url.hash = '';
  return url.href;
 } catch {
  return null;
 }
}

/** Project the miner's private working file onto the versioned public feed. */
export function projectExperimentalCandidateFeed(source: string | null | undefined): ExperimentalCandidateFeed {
 if (typeof source !== 'string') return emptyExperimentalCandidateFeed();

 let parsed: unknown;
 try {
  parsed = JSON.parse(source);
 } catch {
  return emptyExperimentalCandidateFeed();
 }
 if (!isRecord(parsed) || !Array.isArray(parsed.candidates) || typeof parsed.generatedAt !== 'string') {
  return emptyExperimentalCandidateFeed();
 }
 const generatedAtMs = Date.parse(parsed.generatedAt);
 if (!Number.isFinite(generatedAtMs)) return emptyExperimentalCandidateFeed();

 const candidates: ExperimentalCandidateFeedItem[] = [];
 for (const candidate of parsed.candidates) {
  if (!isRecord(candidate)
   || typeof candidate.id !== 'string'
   || !/^[a-f0-9]{8}$/iu.test(candidate.id)) continue;

  const keyword = boundedFeedText(candidate.keyword, EXPERIMENTAL_CANDIDATE_KEYWORD_MAX_LENGTH);
  const locale = typeof candidate.locale === 'string' ? candidate.locale.toLowerCase() : '';
  const totalScore = candidate.totalScore;
  const sources = Array.isArray(candidate.sources)
   ? [...new Set(candidate.sources.flatMap((sourceLabel) => {
    const normalized = typeof sourceLabel === 'string' ? EXPERIMENTAL_SOURCE_LABELS.get(sourceLabel) : undefined;
    return normalized ? [normalized] : [];
   }))]
   : [];
  if (!keyword || !EXPERIMENTAL_LOCALES.has(locale) || sources.length === 0
   || typeof totalScore !== 'number' || !Number.isFinite(totalScore) || totalScore < 0 || totalScore > 1) continue;

  const projected: ExperimentalCandidateFeedItem = {
   id: candidate.id.toLowerCase(),
   keyword,
   angle: boundedFeedText(candidate.angle, EXPERIMENTAL_CANDIDATE_ANGLE_MAX_LENGTH),
   locale,
   sources,
   totalScore,
  };
  const redditPermalink = isRecord(candidate.demandSignals)
   ? normalizeRedditPermalink(candidate.demandSignals.redditUrl)
   : null;
  if (redditPermalink && sources.includes('reddit')) {
   projected.redditPermalink = redditPermalink;
  }
  candidates.push(projected);
  if (candidates.length >= EXPERIMENTAL_CANDIDATE_FEED_MAX_COUNT) break;
 }

 return {
  schemaVersion: 1,
  generatedAt: new Date(generatedAtMs).toISOString(),
  candidates,
 };
}

function buildExperimentalCandidateFeed(root: string): string {
 let source: string | null = null;
 try {
  source = fs.readFileSync(path.resolve(root, EXPERIMENTAL_CANDIDATES_SOURCE_PATH), 'utf8');
 } catch {
  // A missing miner output is represented as a valid, empty feed.
 }
 return `${JSON.stringify(projectExperimentalCandidateFeed(source), null, 2)}\n`;
}

const SOURCE_DATA_FILES = [...ADMIN_DATA_FILES, ...RUNTIME_DATA_FILES];

const JOB_POPULARITY_PATH = 'data/job-popularity.json';
const PROSPECTOR_CANDIDATES_PATH = 'data/prospector/candidates.json';
export const PERMANENT_EMPLOYER_FEED_PATH = '/data/permanent-employers.json';
/** A single view says nothing about demand; the strip only compares the top of the list. */
export const JOB_POPULARITY_MIN_VIEWS = 2;

/**
 * The browser copy of the popularity map, without the entries that cannot rank.
 * The source file stays complete: scripts read it from the repository.
 */
export function trimJobPopularity(source: string): string {
  const parsed: unknown = JSON.parse(source);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return source;
  const trimmed = Object.entries(parsed).filter(
    ([, views]) => typeof views !== 'number' || views >= JOB_POPULARITY_MIN_VIEWS,
  );
  return JSON.stringify(Object.fromEntries(trimmed));
}

/** Emit a public-safe projection of prospector permanent-application signals. */
export function buildPermanentEmployerFeed(root: string, enabled = isDirectEmployerBuildEnabled(process.env)): string {
 if (!enabled) return JSON.stringify({ version: 1, generatedAt: null, employers: [] });
 const sourcePath = path.resolve(root, PROSPECTOR_CANDIDATES_PATH);
 if (!fs.existsSync(sourcePath)) return JSON.stringify({ version: 1, generatedAt: null, employers: [] });
 try {
  const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8')) as unknown;
  return JSON.stringify(projectPermanentEmployerFeed(source));
 } catch (error) {
  console.warn(` ⚠️ Permanent-employer feed skipped: ${error instanceof Error ? error.message : String(error)}`);
  return JSON.stringify({ version: 1, generatedAt: null, employers: [] });
 }
}

/** Every file this plugin copies, in one list shared with the dev middleware. */
export const COPIED_DATA_FILES = [...SOURCE_DATA_FILES, ...GENERATED_RUNTIME_DATA_FILES];
export const ADMIN_WORKFLOW_SCHEDULES_PATH = '/data/admin-workflow-schedules.json';

export const ADMIN_ROUTE_SLUG = 'gestione-contenuti-xk9mp2q';
export const ADMIN_STATIC_SECTION_SLUGS = ADMIN_SECTION_SLUGS;

function withAdminRobots(shell: string): string {
 // Quote-flexible: dist-shrink may remove quotes from single-token
 // attributes, so replace an existing robots tag before injecting a new one.
 if (/<meta\s+name=["']?robots["']?[^>]*>/i.test(shell)) {
  return shell.replace(
   /<meta\s+name=["']?robots["']?[^>]*>/i,
   '<meta name="robots" content="noindex, nofollow" />',
  );
 }
 return shell.replace(
  /<head(\s[^>]*)?>/i,
  (match) => `${match}\n <meta name="robots" content="noindex, nofollow" />`,
 );
}

/** Emit one noindex shell for every live section, including the admin root. */
export function emitAdminStaticShells(distDir: string, indexHtml: string): string[] {
 const emitted: string[] = [];
 const shell = withAdminRobots(indexHtml);
 for (const sectionSlug of ADMIN_STATIC_SECTION_SLUGS) {
  const sectionDir = sectionSlug
   ? path.resolve(distDir, ADMIN_ROUTE_SLUG, sectionSlug)
   : path.resolve(distDir, ADMIN_ROUTE_SLUG);
  fs.mkdirSync(sectionDir, { recursive: true });
  const target = path.resolve(sectionDir, 'index.html');
  fs.writeFileSync(target, shell, 'utf-8');
  emitted.push(target);
 }
 return emitted;
}

export function adminDataPlugin(root: string): Plugin {
 let distDir = path.resolve(root, 'dist');

 return {
 name: 'admin-data-plugin',
 apply: 'build',
 enforce: 'post',
 configResolved(config) {
 distDir = path.resolve(config.root, config.build.outDir);
 },
 closeBundle() {
 let copied = 0;

 for (const relPath of SOURCE_DATA_FILES) {
 const src = path.resolve(root, relPath);
 // Preserve the data/ prefix in dist (e.g. dist/data/jobs-crawler-config.json)
 const dest = path.resolve(distDir, relPath);

 if (!fs.existsSync(src)) {
 // Non-blocking: file may not exist yet (e.g. parser-proposals)
 continue;
 }

 fs.mkdirSync(path.dirname(dest), { recursive: true });
 if (relPath === JOB_POPULARITY_PATH) {
 fs.writeFileSync(dest, trimJobPopularity(fs.readFileSync(src, 'utf8')));
 } else {
 fs.copyFileSync(src, dest);
 }
 copied++;
 }

 const feedDest = path.resolve(distDir, EXPERIMENTAL_CANDIDATE_FEED_FILE_PATH);
 fs.mkdirSync(path.dirname(feedDest), { recursive: true });
 fs.writeFileSync(feedDest, buildExperimentalCandidateFeed(root), 'utf-8');

 console.log(` 📋 Source data: copied ${copied} files to dist/data/ (${ADMIN_DATA_FILES.length} admin + ${RUNTIME_DATA_FILES.length + GENERATED_RUNTIME_DATA_FILES.length} runtime)`);

 const schedulesDest = path.resolve(distDir, ADMIN_WORKFLOW_SCHEDULES_PATH.slice(1));
 fs.mkdirSync(path.dirname(schedulesDest), { recursive: true });
 fs.writeFileSync(schedulesDest, JSON.stringify(buildAdminWorkflowSchedulePayload(root), null, 2), 'utf-8');
 console.log(` 🗓️ Admin schedules: emitted ${schedulesDest}`);

 const permanentEmployerFeedDest = path.resolve(distDir, PERMANENT_EMPLOYER_FEED_PATH.slice(1));
 fs.mkdirSync(path.dirname(permanentEmployerFeedDest), { recursive: true });
 fs.writeFileSync(permanentEmployerFeedDest, buildPermanentEmployerFeed(root), 'utf-8');
 console.log(` 🧭 Permanent employers: emitted ${permanentEmployerFeedDest}`);

 // Generate static HTML shells for every live admin section so GitHub Pages
 // serves direct deep links without the 404→redirect dance that causes stale
 // browsers to request old chunks.
 const indexHtml = path.resolve(distDir, 'index.html');
 if (fs.existsSync(indexHtml)) {
 const emitted = emitAdminStaticShells(distDir, fs.readFileSync(indexHtml, 'utf-8'));
 console.log(` 🔐 Admin routes: generated ${emitted.length} section shell(s) under dist/${ADMIN_ROUTE_SLUG}/ (noindex)`);
 }
 },
 };
}

function adminDataRouteToSource(root: string): Map<string, string> {
 return new Map(
  COPIED_DATA_FILES.map((relPath) => [`/${relPath}`, path.resolve(root, relPath)]),
 );
}

/** Serve the same source-level admin/runtime JSON files during Vite `serve`. */
export function adminDataDevPlugin(root: string): Plugin {
 const routeToSource = adminDataRouteToSource(root);

 return {
  name: 'admin-data-dev-plugin',
  apply: 'serve',
  configureServer(server) {
   server.middlewares.use((req, res, next) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname === PERMANENT_EMPLOYER_FEED_PATH) {
     res.setHeader('Content-Type', 'application/json');
     res.end(buildPermanentEmployerFeed(root));
     return;
    }
    if (pathname === ADMIN_WORKFLOW_SCHEDULES_PATH) {
     res.setHeader('Content-Type', 'application/json');
     res.end(JSON.stringify(buildAdminWorkflowSchedulePayload(root), null, 2));
     return;
    }
    if (pathname === EXPERIMENTAL_CANDIDATE_FEED_PATH) {
     res.setHeader('Content-Type', 'application/json');
     res.end(buildExperimentalCandidateFeed(root));
     return;
    }
    const src = routeToSource.get(pathname);
    if (!src || !fs.existsSync(src)) {
     next();
     return;
    }

    res.setHeader('Content-Type', 'application/json');
    res.end(fs.readFileSync(src, 'utf8'));
   });
  },
 };
}
