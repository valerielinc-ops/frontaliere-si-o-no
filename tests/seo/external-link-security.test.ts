import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');

describe('static external link security', () => {
  it('keeps noopener on every patched target-blank emitter', () => {
    const faqHub = fs.readFileSync(path.join(root, 'build-plugins/faqHubPlugin.ts'), 'utf8');
    const comparisonsHub = fs.readFileSync(path.join(root, 'build-plugins/comparisonsHubPlugin.ts'), 'utf8');
    const events = fs.readFileSync(path.join(root, 'build-plugins/eventsSeoPagesPlugin.ts'), 'utf8');
    const publisherAds = fs.readFileSync(path.join(root, 'build-plugins/publisherAdPagesPlugin.ts'), 'utf8');
    const annualReport = fs.readFileSync(path.join(root, 'build-plugins/annualReportPlugin.ts'), 'utf8');

    expect(faqHub).toContain('rel="noopener" target="_blank"');
    expect(faqHub).not.toContain('rel="nofollow noopener" target="_blank"');
    expect(comparisonsHub).not.toContain('rel="nofollow" style=');
    expect(events).toContain('href="${esc(event.url)}" rel="noopener" target="_blank"');
    expect(events).toContain('href="${esc(eventReferralUrl(event.url, event))}" rel="noopener" target="_blank"');
    expect(events).toContain('href="${esc(s.homepage)}" rel="noopener" target="_blank"');
    expect(events).toContain('rel="license noopener" target="_blank"');
    expect(publisherAds).toContain("rel=\"nofollow${target.external ? ' noopener' : ''}\"${target.external ? ' target=\"_blank\"' : ''}");
    expect(annualReport).toContain('rel="nofollow noopener" target="_blank"');
  });
});
