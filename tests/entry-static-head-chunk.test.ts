import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { linkCheck } from '@/scripts/ci/cdn-chunk-graph.mjs';
import { buildLocalModuleGraph } from '@/scripts/verify-spa-module-links.mjs';

/**
 * Deploy 40311562227 (#15381, all four locales) stopped at verify-spa-module-links:
 *   JobBoard.js  → index-entry.js 'applyCanonicalHref' (missing_export)
 *   seoService.js → index-entry.js 'resolveRobotsDirective' (missing_export) …
 * The static-head authority landed in the entry chunk, so the lazy chunks imported
 * its names from `index-entry.js`; the build-scoped bootstrap that replaces the
 * stable root entry exports nothing, so the root aliases no longer linked.
 */
describe('static-head authority is homed outside the entry', () => {
  it('manualChunks sends it to the i18n chunk the entry already imports', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'vite.config.ts'), 'utf-8');
    const head = src.indexOf("if (id.includes('services/seo/staticHeadAuthority')) return 'i18n';");
    const i18n = src.indexOf("if (id.includes('services/i18n')) return 'i18n';");
    expect(head).toBeGreaterThan(-1);
    expect(i18n).toBeGreaterThan(head);
  });

  it('a root alias importing the names from an export-less bootstrap entry is a broken link (the failure)', () => {
    const graph = buildLocalModuleGraph(new Map([
      ['index-entry.js', '/* FRONTALIERE_VERSIONED_CDN_BOOTSTRAP */import("./releases/1/index-entry.js");'],
      ['releases/1/index-entry.js', 'console.log(1);'],
      ['JobBoard.js', 'import{applyCanonicalHref,clearSpaNoindex}from"./index-entry.js";console.log(applyCanonicalHref,clearSpaNoindex);'],
    ]));
    expect(linkCheck(graph.modules, graph.served).map((b: { name: string }) => b.name).sort())
      .toEqual(['applyCanonicalHref', 'clearSpaNoindex']);
  });

  it('with the module in the i18n chunk the same alias links, and the entry exports nothing (the fix)', () => {
    const graph = buildLocalModuleGraph(new Map([
      ['index-entry.js', '/* FRONTALIERE_VERSIONED_CDN_BOOTSTRAP */import("./releases/1/index-entry.js");'],
      ['releases/1/index-entry.js', 'console.log(1);'],
      ['i18n.js', 'const a=1,b=2;export{a as applyCanonicalHref,b as clearSpaNoindex};'],
      ['JobBoard.js', 'import{applyCanonicalHref,clearSpaNoindex}from"./i18n.js";console.log(applyCanonicalHref,clearSpaNoindex);'],
    ]));
    expect(linkCheck(graph.modules, graph.served)).toEqual([]);
  });
});
