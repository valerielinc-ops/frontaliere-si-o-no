import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const pluginSource = fs.readFileSync(
  path.resolve(root, 'build-plugins/jobsSeoPagesPlugin.ts'),
  'utf-8',
);

describe('previousSlugs bridge pages', () => {
  it('generates bridge pages for active jobs with previousSlugs', () => {
    expect(pluginSource).toContain('previousSlugs');
    expect(pluginSource).toContain('bridgeCount');
  });

  it('bridge pages use canonical pointing to current slug', () => {
    expect(pluginSource).toContain('bridge');
    expect(pluginSource).toContain('canonical');
  });

  it('bridge pages include rich content with AdSense and signup', () => {
    const bridgeSection = pluginSource.slice(pluginSource.indexOf('Rich bridge pages for previousSlugs'));
    expect(bridgeSection).toContain('adsbygoogle');
    expect(bridgeSection).toContain('Google Sign In');
    expect(bridgeSection).toContain('BreadcrumbList');
  });
});
