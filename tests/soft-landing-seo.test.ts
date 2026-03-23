import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const pluginSource = fs.readFileSync(
  path.resolve(root, 'build-plugins/jobsSeoPagesPlugin.ts'),
  'utf-8'
);

describe('Soft-landing SEO pages for expired jobs', () => {
  it('does NOT use noindex for expired job pages', () => {
    const expiredSection = pluginSource.slice(pluginSource.indexOf('Expired-job'));
    expect(expiredSection).not.toContain('content="noindex,follow"');
  });

  it('uses self-referencing canonical for expired pages', () => {
    const expiredSection = pluginSource.slice(pluginSource.indexOf('Expired-job'));
    expect(expiredSection).not.toContain('canonical" href="${redirectUrl}"');
  });

  it('reads expired-jobs.json for data', () => {
    expect(pluginSource).toContain('expired-jobs.json');
  });

  it('generates previousSlugs bridge pages for active jobs', () => {
    expect(pluginSource).toContain('previousSlugs');
  });

  it('does NOT include JobPosting schema for expired jobs', () => {
    // Scope to only the expired-job section — bridge pages (which follow) legitimately have JobPosting
    const expiredStart = pluginSource.indexOf('Expired-job');
    const bridgeStart = pluginSource.indexOf('Rich bridge pages');
    const expiredSection = bridgeStart > expiredStart
      ? pluginSource.slice(expiredStart, bridgeStart)
      : pluginSource.slice(expiredStart);
    expect(expiredSection).not.toContain("'JobPosting'");
    expect(expiredSection).not.toContain('"JobPosting"');
  });

  it('includes expired jobs in sitemap at low priority', () => {
    expect(pluginSource).toContain('sitemap-jobs-expired.xml');
  });
});
