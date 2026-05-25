// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import viteConfig from '../vite.config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function pluginNames(): string[] {
  const resolved = typeof viteConfig === 'function'
    ? viteConfig({ command: 'build', mode: 'production' })
    : viteConfig;
  const plugins = Array.isArray(resolved.plugins) ? resolved.plugins.flat() : [];
  return plugins.map((plugin) => plugin?.name).filter((name): name is string => Boolean(name));
}

describe('build plugin ordering', () => {
  it('runs border municipality pages after static pages in sequential closeBundle builds', () => {
    const names = pluginNames();
    const staticIdx = names.indexOf('static-pages');
    const borderIdx = names.indexOf('border-municipality-pages');
    const relatedIdx = names.indexOf('related-search-clusters');

    expect(staticIdx).toBeGreaterThanOrEqual(0);
    expect(borderIdx).toBeGreaterThan(staticIdx);
    expect(relatedIdx).toBeGreaterThan(borderIdx);
  });

  it('keeps the deploy critical-dist guard before artifact upload', () => {
    const workflow = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/deploy.yml'), 'utf-8');
    const guardIdx = workflow.indexOf('node scripts/validate-critical-dist-pages.mjs');
    const uploadIdx = workflow.indexOf('Upload Pages artifact');

    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(uploadIdx).toBeGreaterThan(guardIdx);
  });
});
