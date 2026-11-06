import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'build-plugins/jobsSeoPagesPlugin.ts'), 'utf8');
const TEMPLATE_START = SOURCE.indexOf('const buildSoftLandingHtml =');
const TEMPLATE_END = SOURCE.indexOf('const buildHistoricalArchiveHtml =', TEMPLATE_START);
const SOFT_LANDING_TEMPLATE = SOURCE.slice(TEMPLATE_START, TEMPLATE_END);

describe('jobs SEO soft-landing social metadata', () => {
  it('emits OG metadata from the same values used by the canonical head', () => {
    expect(TEMPLATE_START).toBeGreaterThanOrEqual(0);
    expect(TEMPLATE_END).toBeGreaterThan(TEMPLATE_START);
    expect(SOFT_LANDING_TEMPLATE).toContain(
      'const metaDescription = clampMetaDescription(pageDesc, undefined, locale)',
    );
    expect(SOFT_LANDING_TEMPLATE).toContain(
      '<meta name="description" content="${esc(metaDescription)}">${robotsTag}',
    );
    expect(SOFT_LANDING_TEMPLATE).toContain(
      '<meta property="og:title" content="${pageTitle}">',
    );
    expect(SOFT_LANDING_TEMPLATE).toContain(
      '<meta property="og:description" content="${esc(metaDescription)}">',
    );
    expect(SOFT_LANDING_TEMPLATE).toContain(
      '<meta property="og:url" content="${selfUrl}">',
    );
    expect(SOFT_LANDING_TEMPLATE).toContain(
      '<link rel="canonical" href="${selfUrl}">',
    );
    expect(
      SOFT_LANDING_TEMPLATE.match(/clampMetaDescription\(pageDesc, undefined, locale\)/g),
    ).toHaveLength(1);
  });

  it('keeps a deterministic non-empty description fallback in the shared emitter', () => {
    expect(SOFT_LANDING_TEMPLATE).toContain(
      '|| clampMetaDescription(expiredBannerCopy[locale]?.banner || expiredBannerCopy.it.banner, undefined, locale)',
    );
  });

  it('emits the expired body as a sibling static overlay, not inside #root', () => {
    expect(SOFT_LANDING_TEMPLATE).toContain(
      '<main class="seo-static-content" data-expired-static-body="true"',
    );
    expect(SOFT_LANDING_TEMPLATE).toContain(
      'style="max-width:none;margin:0;padding:0;display:block"',
    );
    expect(SOFT_LANDING_TEMPLATE).toContain('<div id="footer-root">\n ${shell.footer}\n </div>');

    const rootClose = SOFT_LANDING_TEMPLATE.indexOf('</div>\n <main class="seo-static-content"');
    const articleOpen = SOFT_LANDING_TEMPLATE.indexOf('<article class="ft-static-article ft-expired-page">');
    expect(rootClose).toBeGreaterThan(-1);
    expect(articleOpen).toBeGreaterThan(rootClose);
    expect(SOFT_LANDING_TEMPLATE).toContain('data-expired-static-path="${esc(expiredStaticPath)}"');
  });
});
