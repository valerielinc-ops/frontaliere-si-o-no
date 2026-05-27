// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import viteConfig from '../vite.config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function isNamedPlugin(plugin: unknown): plugin is { name: string } {
  return Boolean(plugin)
    && typeof plugin === 'object'
    && 'name' in plugin
    && typeof (plugin as { name?: unknown }).name === 'string';
}

function pluginNames(): string[] {
  const resolved = typeof viteConfig === 'function'
    ? viteConfig({ command: 'build', mode: 'production' })
    : viteConfig;
  const plugins = Array.isArray(resolved.plugins) ? resolved.plugins.flat() : [];
  return plugins.filter(isNamedPlugin).map((plugin) => plugin.name);
}

function expectPluginAfter(names: string[], consumer: string, producer: string): void {
  const producerIdx = names.indexOf(producer);
  const consumerIdx = names.indexOf(consumer);

  expect(producerIdx, `${producer} must be registered`).toBeGreaterThanOrEqual(0);
  expect(consumerIdx, `${consumer} must be registered`).toBeGreaterThanOrEqual(0);
  expect(consumerIdx, `${consumer} waits for ${producer}; it must run later in sequential closeBundle`).toBeGreaterThan(producerIdx);
}

describe('build plugin ordering', () => {
  it('keeps signal consumers after their producers in sequential closeBundle builds', () => {
    const names = pluginNames();

    expectPluginAfter(names, 'border-municipality-pages', 'static-pages');
    expectPluginAfter(names, 'profession-landings-links', 'static-pages');
    expectPluginAfter(names, 'profession-landings-links', 'profession-landings');
    expectPluginAfter(names, 'salary-hub-index-link', 'static-pages');
    expectPluginAfter(names, 'salary-hub-index-link', 'salary-hub-seo');
    expectPluginAfter(names, 'related-search-clusters', 'jobs-seo-pages');
    expectPluginAfter(names, 'post-walk-coordinator', 'related-search-clusters');
  });

  it('keeps deploy output guards before artifact upload', () => {
    const workflow = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/deploy.yml'), 'utf-8');
    const criticalGuardIdx = workflow.indexOf('node scripts/validate-critical-dist-pages.mjs');
    const profileGuardIdx = workflow.indexOf('node scripts/validate-build-profile-markers.mjs /tmp/build.log');
    const uploadIdx = workflow.indexOf('Upload Pages artifact');

    expect(criticalGuardIdx).toBeGreaterThanOrEqual(0);
    expect(profileGuardIdx).toBeGreaterThan(criticalGuardIdx);
    expect(uploadIdx).toBeGreaterThan(profileGuardIdx);
  });
});
