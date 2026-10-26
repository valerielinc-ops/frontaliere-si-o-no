import { describe, expect, it } from 'vitest';
import { chunkAbiHash } from '@/build-plugins/shared/abiChunkNaming';
import {
  checkChunkInterfaceNames,
  checkHtmlAssetReferences,
  formatInterfaceProblems,
} from '@/scripts/lib/spa-chunk-interface-check.mjs';
import { buildLocalModuleGraph } from '@/scripts/verify-spa-module-links.mjs';

const modulesOf = (files: Record<string, string>) => buildLocalModuleGraph(new Map(Object.entries(files))).modules;

describe('checkChunkInterfaceNames', () => {
  const hash = chunkAbiHash(['Analytics', 'isLikelyBot']);

  it('accepts a chunk whose filename carries the hash of its real exports', () => {
    const modules = modulesOf({
      [`mx.${hash}.js`]: 'const a=1,b=2;export{a as Analytics,b as isLikelyBot};',
    });
    expect(checkChunkInterfaceNames(modules)).toEqual([]);
  });

  it('flags a chunk with named exports whose filename has no hash', () => {
    const modules = modulesOf({ 'mx.js': 'const a=1;export{a as Analytics};' });
    const problems = checkChunkInterfaceNames(modules);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ file: 'mx.js', kind: 'abi_missing' });
  });

  it('flags a chunk whose hash was computed from a different interface than the shipped one', () => {
    const modules = modulesOf({ [`mx.${hash}.js`]: 'const a=1;export{a as Analytics};' });
    const problems = checkChunkInterfaceNames(modules);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'abi_mismatch' });
    expect(formatInterfaceProblems(problems)[0]).toContain('expected suffix');
  });

  it('flags a hash on a default-only chunk', () => {
    const modules = modulesOf({ [`it-core.${hash}.js`]: 'const a=1;export{a as default};' });
    expect(checkChunkInterfaceNames(modules)[0]).toMatchObject({ kind: 'abi_unexpected' });
  });

  it('accepts default-only chunks under their plain name', () => {
    const modules = modulesOf({ 'it-core.js': 'const a=1;export{a as default};' });
    expect(checkChunkInterfaceNames(modules)).toEqual([]);
  });

  it('does not judge content-hashed bundler assets that are not Rollup chunks (worker bundles)', () => {
    const modules = modulesOf({ 'pdf.worker-CPbhI6B3.mjs': 'const a=1;export{a as WorkerMessageHandler};' });
    expect(checkChunkInterfaceNames(modules)).toEqual([]);
  });

  it('exempts locale-keyed blog bodies', () => {
    const modules = modulesOf({
      'some-article.it.js': 'const a=1;export{a as meta,a as default};',
      'some-article.ch.de.js': 'const a=1;export{a as meta};',
    });
    expect(checkChunkInterfaceNames(modules)).toEqual([]);
  });

  it('requires the hash on a page component that exports names (JobBoard is imported by lazy children)', () => {
    const jobBoardHash = chunkAbiHash(['JobBoard', 'JOB_ALERT_LOCATIONS']);
    const hashed = modulesOf({
      [`JobBoard.${jobBoardHash}.js`]: 'const a=1,b=2;export{a as JobBoard,b as JOB_ALERT_LOCATIONS};',
      'JobAlertForm.js': `import{JOB_ALERT_LOCATIONS as x}from"./JobBoard.${jobBoardHash}.js";console.log(x);`,
    });
    expect(checkChunkInterfaceNames(hashed)).toEqual([]);

    const plain = modulesOf({ 'JobBoard.js': 'const a=1,b=2;export{a as JobBoard,b as JOB_ALERT_LOCATIONS};' });
    expect(checkChunkInterfaceNames(plain)[0]).toMatchObject({ file: 'JobBoard.js', kind: 'abi_missing' });
  });

  it('keeps the chunks a renderer outside the build spells by plain name default-only', () => {
    const clean = modulesOf({
      'it-core.js': 'const a=1;export{a as default};',
      'blog-meta-it.js': 'const a=1;export{a as default};',
    });
    expect(checkChunkInterfaceNames(clean)).toEqual([]);

    const leaking = modulesOf({ 'blog-meta-it.js': 'const a=1,b=2;export{a as default,b as BLOG_META};' });
    const problems = checkChunkInterfaceNames(leaking);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ file: 'blog-meta-it.js', kind: 'plain_chunk_has_exports' });
    expect(problems[0].detail).toContain('BLOG_META');
  });

  it('flags an interface hash on a chunk the publisher spells by plain name', () => {
    const modules = modulesOf({ [`it-core.${hash}.js`]: 'const a=1;export{a as default};' });
    expect(checkChunkInterfaceNames(modules)[0]).toMatchObject({ kind: 'abi_unexpected' });
  });

  it('keeps vendor-react plain only on its baseline interface', () => {
    const baseline = 'const a=1;export{a as React,a as React$1,a as client,a as commonjsGlobal,a as getAugmentedNamespace,a as getDefaultExportFromCjs,a as jsxRuntimeExports,a as reactDomExports,a as reactExports,a as requireReact};';
    expect(checkChunkInterfaceNames(modulesOf({ 'vendor-react.js': baseline }))).toEqual([]);

    const grown = baseline.replace('};', ',a as useId};');
    expect(checkChunkInterfaceNames(modulesOf({ 'vendor-react.js': grown }))[0]).toMatchObject({
      file: 'vendor-react.js',
      kind: 'abi_missing',
    });
  });

  it('requires the fixed-name SPA entry to export nothing', () => {
    const clean = modulesOf({ 'index-entry.js': 'console.log(1);' });
    expect(checkChunkInterfaceNames(clean)).toEqual([]);

    const leaking = modulesOf({ 'index-entry.js': 'const a=1;export{a as applyCanonicalHref};' });
    const problems = checkChunkInterfaceNames(leaking);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ file: 'index-entry.js', kind: 'entry_exports' });
    expect(problems[0].detail).toContain('applyCanonicalHref');
  });
});

describe('checkHtmlAssetReferences', () => {
  const assets = new Set(['index-entry.js', 'vendor-react.5a1b2c3d.js', 'it-core.js', 'early-boot.js']);
  const page = (...hrefs: string[]) => hrefs
    .map((h) => (h.endsWith('.css') ? `<link rel="stylesheet" href="/assets/${h}">` : `<link rel="modulepreload" href="/assets/${h}">`))
    .join('\n');

  it('accepts references to emitted files, including the CDN-absolute spelling', () => {
    const html = `${page('vendor-react.5a1b2c3d.js', 'it-core.js')}\n<script type="module" src="https://cdn.frontaliereticino.ch/assets/index-entry.js"></script>`;
    expect(checkHtmlAssetReferences(new Map([['index.html', html]]), assets)).toEqual([]);
  });

  it('flags a preload of the plain name of a chunk that is only emitted under its interface hash', () => {
    const missing = checkHtmlAssetReferences(new Map([['calcola/index.html', page('vendor-react.js')]]), assets);
    expect(missing).toEqual([
      { page: 'calcola/index.html', asset: 'vendor-react.js', reason: 'chunk is emitted only under its interface-hashed name' },
    ]);
  });

  it('flags a reference to an interface-hashed file that was not emitted', () => {
    const missing = checkHtmlAssetReferences(new Map([['index.html', page('vendor-react.deadbeef.js')]]), assets);
    expect(missing[0]).toMatchObject({ asset: 'vendor-react.deadbeef.js', reason: 'interface-hashed file not emitted' });
  });

  it('does not judge assets that never go through Rollup', () => {
    // e.g. a script copied from public/ or written by a static-scripts plugin
    const html = page('some-copied-script.js', 'seo-static.css');
    expect(checkHtmlAssetReferences(new Map([['index.html', html]]), assets)).toEqual([]);
  });
});
