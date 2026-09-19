/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readEmbeddedBuildId } from '../services/buildInfo';

const repoRoot = resolve(__dirname, '..');

describe('runtime build identity contract', () => {
  it('reads the synchronous build marker embedded in the document head', () => {
    document.head.innerHTML = '<meta name="ft-build-id" content="1789306155656">';
    expect(readEmbeddedBuildId()).toBe('1789306155656');
  });

  it('returns an empty value when the marker is absent', () => {
    document.head.innerHTML = '';
    expect(readEmbeddedBuildId()).toBe('');
  });

  it('keeps the Vite root index and static-page head on one marker contract', () => {
    const constants = readFileSync(resolve(repoRoot, 'build-plugins/constants.ts'), 'utf8');
    const plugin = readFileSync(resolve(repoRoot, 'build-plugins/buildIdPlugin.ts'), 'utf8');
    const template = readFileSync(resolve(repoRoot, 'build-plugins/htmlTemplate.ts'), 'utf8');
    expect(constants).toContain('BUILD_ID_META_TAG');
    expect(constants).toContain('name="ft-build-id"');
    expect(plugin).toContain('transformIndexHtml(html)');
    expect(plugin).toContain('BUILD_ID_META_TAG');
    expect(template).toContain('${STATIC_BUILD_ID_META_TAG}');
  });

  it('adds build identity to every runtime health event family', () => {
    const analytics = readFileSync(resolve(repoRoot, 'services/analytics.ts'), 'utf8');
    for (const event of ['app_error', 'error_page_view', 'force_reload', 'resource_load_error', 'css_fallback', 'chunk_retry']) {
      const block = analytics.match(new RegExp(`log\\('${event}',[\\s\\S]*?\\}\\);`));
      expect(block, `${event} payload`).not.toBeNull();
      expect(block![0]).toContain('build_id:');
    }
  });
});
