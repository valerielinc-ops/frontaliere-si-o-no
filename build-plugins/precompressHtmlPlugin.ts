/**
 * Pre-compress every dist/**\/*.html (≥ 1 KB) to .br + .gz siblings.
 *
 * Why:
 *   GitHub Pages can serve a pre-encoded `.br` / `.gz` payload when a client
 *   sends `Accept-Encoding: br` / `gzip`. Pre-compressing at build time means
 *   the CDN never has to compress at request time, and the upload-pages-
 *   artifact step ships fewer bytes overall (large HTML pages compress to
 *   ~15-20 % of their plain size with brotli quality 11). Pages too small
 *   to benefit (< 1 KB) are skipped — the gz/br header overhead can exceed
 *   the savings on tiny redirect bridges.
 *
 * Order:
 *   Runs in `closeBundle` with `enforce: 'post'` and `order: 'post'`, so it
 *   fires after every other plugin has finished writing/rewriting HTML
 *   (including hreflangPostprocessPlugin and flatHtmlRedirectPlugin).
 *
 * Concurrency:
 *   Files are processed in batches of 16 parallel workers. Brotli quality
 *   11 is CPU-bound; saturating more than a handful of cores yields
 *   diminishing returns and risks OOM on shared CI runners.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import type { Plugin } from 'vite';

const brotliCompress = promisify(zlib.brotliCompress);
const gzipCompress = promisify(zlib.gzip);

/** Skip files smaller than this — overhead of pre-compression exceeds savings. */
const MIN_SIZE = 1024;

/** Recursively collect every .html file under `dir` into `out`. */
async function walkHtml(dir: string, out: string[]): Promise<void> {
 const entries = await fs.promises.readdir(dir, { withFileTypes: true });
 await Promise.all(
 entries.map(async (e) => {
 const full = path.join(dir, e.name);
 if (e.isDirectory()) return walkHtml(full, out);
 if (e.isFile() && e.name.endsWith('.html')) out.push(full);
 }),
 );
}

export function precompressHtmlPlugin(rootDir: string): Plugin {
 return {
 name: 'precompress-html',
 enforce: 'post',
 closeBundle: {
 order: 'post',
 sequential: true,
 async handler() {
 const distDir = path.resolve(rootDir, 'dist');
 if (!fs.existsSync(distDir)) return;

 const files: string[] = [];
 await walkHtml(distDir, files);

 const start = Date.now();
 let compressed = 0;
 const concurrency = 16;

 for (let i = 0; i < files.length; i += concurrency) {
 const batch = files.slice(i, i + concurrency);
 await Promise.all(
 batch.map(async (f) => {
 const stat = await fs.promises.stat(f);
 if (stat.size < MIN_SIZE) return;
 const buf = await fs.promises.readFile(f);
 const [br, gz] = await Promise.all([
 brotliCompress(buf, {
 params: {
 [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
 [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
 },
 }),
 gzipCompress(buf, { level: 9 }),
 ]);
 await Promise.all([
 fs.promises.writeFile(`${f}.br`, br),
 fs.promises.writeFile(`${f}.gz`, gz),
 ]);
 compressed++;
 }),
 );
 }

 const dur = ((Date.now() - start) / 1000).toFixed(1);
 console.log(`[precompress-html] compressed ${compressed} HTML files (br + gz) in ${dur}s`);
 },
 },
 };
}
