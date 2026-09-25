import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const pluginSource = fs.readFileSync(
  path.resolve(root, 'build-plugins/jobsSeoPagesPlugin.ts'),
  'utf-8',
);

describe('previousSlugs full-content pages', () => {
  it('generates full-content pages for active jobs with previousSlugs', () => {
    expect(pluginSource).toContain('previousSlugs');
    expect(pluginSource).toContain('bridgeCount');
  });

  it('full-content pages use canonical pointing to current slug', () => {
    expect(pluginSource).toContain('canonical');
    expect(pluginSource).toContain('jobHtmlCache');
  });

  it('full-content pages reuse cached active job HTML', () => {
    expect(pluginSource).toContain('jobHtmlCache.get');
    expect(pluginSource).toContain('jobHtmlCache.set');
    expect(pluginSource).toContain('__BRIDGE_TARGET_SLUG__');
  });
});
