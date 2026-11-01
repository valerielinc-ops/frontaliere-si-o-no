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

const JOB_POPULARITY_PATH = 'data/job-popularity.json';
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

/** Every file this plugin copies, in one list shared with the dev middleware. */
export const COPIED_DATA_FILES = [...ADMIN_DATA_FILES, ...RUNTIME_DATA_FILES];
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

 for (const relPath of COPIED_DATA_FILES) {
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

 console.log(` 📋 Source data: copied ${copied} files to dist/data/ (${ADMIN_DATA_FILES.length} admin + ${RUNTIME_DATA_FILES.length} runtime)`);

 const schedulesDest = path.resolve(distDir, ADMIN_WORKFLOW_SCHEDULES_PATH.slice(1));
 fs.mkdirSync(path.dirname(schedulesDest), { recursive: true });
 fs.writeFileSync(schedulesDest, JSON.stringify(buildAdminWorkflowSchedulePayload(root), null, 2), 'utf-8');
 console.log(` 🗓️ Admin schedules: emitted ${schedulesDest}`);

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
    if (pathname === ADMIN_WORKFLOW_SCHEDULES_PATH) {
     res.setHeader('Content-Type', 'application/json');
     res.end(JSON.stringify(buildAdminWorkflowSchedulePayload(root), null, 2));
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
