/**
 * Serve the real homepage with production React, without a full site build.
 * NODE_ENV=production PERF_HOME_REF=<base> npx vite --config scripts/perf/home-lab.vite.config.mjs
 * Omit PERF_HOME_REF for the working tree. Restart Vite between variants.
 * Missing sparse data is read from the common checkout (never modified).
 * Blog shard metadata is stubbed: this fixture profiles calculator interactions.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const commonGit = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const common = path.dirname(commonGit);
const baselineFiles = ['components/tabs/CalcolatoreTabContent.tsx', 'components/calculator/InputCard.tsx'];
export default defineConfig({
 root,
 plugins: [react(), {
  name: 'homepage-lab-sparse-data', enforce: 'pre',
  resolveId(id, importer) {
   if (id.endsWith('/data/blog-articles-data') || id === '@/data/blog-articles-data') return path.join(common, 'packages/articles/content/blog-articles-data.ts');
   if (id === 'virtual:seo-blog-shard-index') return '\0empty-blog-index';
   if (!importer || (!id.startsWith('.') && !id.startsWith('@/') && !id.startsWith(root + '/'))) return;
   const candidate = id.startsWith('@/') ? path.join(root, id.slice(2)) : path.resolve(path.dirname(importer), id);
   if (!candidate.startsWith(root + '/')) return;
   for (const extension of ['', '.ts', '.tsx', '.json']) {
    if (fs.existsSync(candidate + extension)) return;
    const fallback = path.join(common, path.relative(root, candidate + extension));
    if (fs.existsSync(fallback)) return fallback;
   }
  },
  load(id) {
   const baseline = baselineFiles.find(file => id === path.join(root, file));
   if (process.env.PERF_HOME_REF && baseline) return execFileSync('git', ['show', `${process.env.PERF_HOME_REF}:${baseline}`], { encoding: 'utf8', cwd: root });
   if (id === '\0empty-blog-index') return 'export default {}';
  },
 }],
 resolve: { alias: { '@': root } }, publicDir: path.join(common, 'public'),
 optimizeDeps: { entries: [] },
 server: { host: '127.0.0.1', port: 4319, strictPort: true, watch: { ignored: ['**/tmp/**'] }, fs: { allow: [common] } },
});
