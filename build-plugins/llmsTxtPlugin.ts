/**
 * Auto-update llms.txt and llms-full.txt with current build date, article count,
 * and a comprehensive auto-generated page index from all sitemaps.
 * Ensures AI search engines always see fresh metadata and can discover ALL pages.
 *
 * Thin wrapper: the actual generation logic lives in
 * scripts/lib/llms-txt-generator.mjs (generateLlmsTxtFamily), extracted for
 * issue #4881 Fase 3 (pushable-origin fast-publish) so the fast-publish
 * pipeline can regenerate the same llms.txt family OUTSIDE a full Vite
 * build (see scripts/generate-llms-txt.mjs, the extraction's other caller).
 * One implementation, never a fork — do not re-add logic here; edit the
 * shared module instead.
 */

import path from 'path';
import type { Plugin } from 'vite';
import { generateLlmsTxtFamily } from '../scripts/lib/llms-txt-generator.mjs';

export function llmsTxtPlugin(rootDir: string): Plugin {
 return {
 name: 'llms-txt-update',
 apply: 'build',
 // `enforce: 'post'` alone is not enough: `closeBundle` hooks can run in
 // parallel across plugins within the same bucket. Without `order: 'post'`
 // + `sequential: true` this plugin (previously default-bucket, no
 // `enforce`) ran BEFORE most sitemap-writing SEO plugins — nearly all of
 // which are `enforce: 'post'` — silently missing their sitemap-*.xml from
 // resolveSitemapFileList()'s dynamic discovery (issue follow-up #4435).
 // Mirrors sitemapAliasPlugin.ts's own ordering guarantee.
 enforce: 'post',
 closeBundle: {
 order: 'post',
 sequential: true,
 async handler() {
 const distDir = path.resolve(rootDir, 'dist');
 const publicDir = path.resolve(rootDir, 'public');
 // Vite copies publicDir into distDir before closeBundle runs, so
 // distDir/llms.txt already exists as a fresh copy of public/llms.txt by
 // this point — the generator patches it in place (see that module's doc
 // for why the standalone CLI caller must replicate this copy manually).
 await generateLlmsTxtFamily({ rootDir, publicDir, distDir });
 },
 },
 };
}
