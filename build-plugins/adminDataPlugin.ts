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
 * fetch keeps the data identical and takes it off the critical path.
 */
const RUNTIME_DATA_FILES = [
 'data/job-popularity.json',
];

/** Every file this plugin copies, in one list for the copy loop + dev middleware. */
export const COPIED_DATA_FILES = [...ADMIN_DATA_FILES, ...RUNTIME_DATA_FILES];

export function adminDataPlugin(root: string): Plugin {
 const routeToSource = new Map(
 COPIED_DATA_FILES.map((relPath) => [`/${relPath.replace(/^data\//, 'data/')}`, path.resolve(root, relPath)])
 );

 return {
 name: 'admin-data-plugin',
 configureServer(server) {
 server.middlewares.use((req, res, next) => {
 const pathname = (req.url || '').split('?')[0];
 const src = routeToSource.get(pathname);
 if (!src || !fs.existsSync(src)) {
 next();
 return;
 }

 res.setHeader('Content-Type', 'application/json');
 res.end(fs.readFileSync(src, 'utf8'));
 });
 },
 closeBundle() {
 const distDir = path.resolve(root, 'dist');
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
 fs.copyFileSync(src, dest);
 copied++;
 }

 console.log(` 📋 Source data: copied ${copied} files to dist/data/ (${ADMIN_DATA_FILES.length} admin + ${RUNTIME_DATA_FILES.length} runtime)`);

 // Generate static HTML shell for the admin route so GitHub Pages serves it
 // directly (fresh chunk hashes) without the 404→redirect dance that causes
 // browsers with stale cached index.html to request non-existent old chunks.
 // The slug is intentionally obfuscated; it must stay in sync with router.ts.
 const ADMIN_SLUG = 'gestione-contenuti-xk9mp2q';
 const indexHtml = path.resolve(distDir, 'index.html');
 if (fs.existsSync(indexHtml)) {
 const adminDir = path.resolve(distDir, ADMIN_SLUG);
 fs.mkdirSync(adminDir, { recursive: true });
 // Copy the SPA shell, then force `noindex, nofollow` on the admin route.
 // The admin panel is an internal tool and must never appear in SERPs,
 // so it is exempt from the site-wide BreadcrumbList requirement (D.2).
 let shell = fs.readFileSync(indexHtml, 'utf-8');
 // Quote-flexible: PR #478 baked `removeAttributeQuotes` upstream, so single-token
 // attribute values lose their quotes in dist/ (`name=robots`). A quote-mandatory
 // regex misses the minified shell meta → falls through to the <head> branch and
 // injects a SECOND robots meta while the original survives.
 if (/<meta\s+name=["']?robots["']?[^>]*>/i.test(shell)) {
 shell = shell.replace(
 /<meta\s+name=["']?robots["']?[^>]*>/i,
 '<meta name="robots" content="noindex, nofollow" />'
 );
 } else {
 shell = shell.replace(
 /<head(\s[^>]*)?>/i,
 (m) => `${m}\n <meta name="robots" content="noindex, nofollow" />`
 );
 }
 fs.writeFileSync(path.resolve(adminDir, 'index.html'), shell, 'utf-8');
 console.log(` 🔐 Admin route: generated dist/${ADMIN_SLUG}/index.html (noindex)`);
 }
 },
 };
}
