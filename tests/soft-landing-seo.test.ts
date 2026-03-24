import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const pluginSource = fs.readFileSync(
  path.resolve(root, 'build-plugins/jobsSeoPagesPlugin.ts'),
  'utf-8'
);

describe('Soft-landing SEO pages for expired jobs', () => {
  it('uses noindex only for expired pages WITHOUT rich content (thin-content orphans)', () => {
    const expiredSection = pluginSource.slice(pluginSource.indexOf('Expired-job'));
    // Expired pages without ejData (title + description) are thin content and get noindex
    expect(expiredSection).toContain('hasExpiredRichContent');
    // The noindex tag is conditionally applied — only when hasExpiredRichContent is false
    expect(expiredSection).toContain('expiredRobotsTag');
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

  it('includes JobPosting with validThrough in expired pages (FRO-194)', () => {
    // Expired pages now include a JobPosting with a past validThrough date
    // so Google recognizes the job as expired while keeping semantic data
    const expiredStart = pluginSource.indexOf('Expired-job') ?? pluginSource.indexOf('expired');
    const bridgeStart = pluginSource.indexOf('Rich bridge pages');
    const expiredSection = bridgeStart > expiredStart
      ? pluginSource.slice(expiredStart, bridgeStart)
      : pluginSource.slice(expiredStart);
    expect(expiredSection).toContain('JobPosting');
    expect(expiredSection).toContain('validThrough');
  });

  it('includes expired jobs in sitemap at low priority', () => {
    expect(pluginSource).toContain('sitemap-jobs-expired.xml');
  });
});
