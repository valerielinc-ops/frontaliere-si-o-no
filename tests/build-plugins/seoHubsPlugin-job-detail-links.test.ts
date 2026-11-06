import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emitSeoHubs } from '../../build-plugins/seoHubsPlugin';
import { HUB_LOCALES, HUB_SLUGS, hubSlugFor } from '../../build-plugins/seoHubsData';
import { writeAllKnownJobSlugs } from '../../scripts/lib/all-known-job-slugs-store.mjs';

describe('SEO job archive detail links', () => {
  let rootDir = '';

  afterEach(() => {
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
    rootDir = '';
  });

  it('does not link historical registry entries without an emitted detail page', () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-hub-job-links-'));
    const dataDir = path.join(rootDir, 'data');
    const distDir = path.join(rootDir, 'dist');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });
    fs.mkdirSync(path.join(rootDir, 'services'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'services/jobDataNormalization.ts'), 'export const CRAWLED_COMPANY_LOGOS = {};');

    const emittedPath = '/cerca-lavoro-appenzello/published-listing/';
    const retiredPath = '/cerca-lavoro-appenzello/retired-listing/';
    writeAllKnownJobSlugs({
      'published-listing': { it: emittedPath },
      'retired-listing': { it: retiredPath },
    }, rootDir);
    const emittedFile = path.join(distDir, emittedPath.slice(1), 'index.html');
    fs.mkdirSync(path.dirname(emittedFile), { recursive: true });
    fs.writeFileSync(emittedFile, '<!doctype html><title>Published listing</title>');

    emitSeoHubs({
      rootDir,
      distDir,
      fs,
      np: path,
      entryJs: '/assets/entry.js',
      entryCss: '/assets/entry.css',
      hasSpaBundle: false,
      qw: (file, html) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, html);
      },
    });

    const hubFile = path.join(distDir, HUB_SLUGS.it.jobsAll.slice(1), 'index.html');
    const html = fs.readFileSync(hubFile, 'utf8');
    expect(html).toContain(`href="${emittedPath}"`);
    expect(html).not.toContain(`href="${retiredPath}"`);

    // The legacy company directory lives outside the job-board section.
    // Its existence must not suppress the canton-local company indexes.
    for (const locale of HUB_LOCALES) {
      const companyPath = hubSlugFor('TI', locale, 'aziende');
      const companyHtml = fs.readFileSync(path.join(distDir, companyPath.slice(1), 'index.html'), 'utf8');
      expect(companyHtml).toContain(`<link rel="canonical" href="https://frontaliereticino.ch${companyPath}">`);
      for (const alternate of HUB_LOCALES) {
        expect(companyHtml).toContain(`<link rel="alternate" hreflang="${alternate}" href="https://frontaliereticino.ch${hubSlugFor('TI', alternate, 'aziende')}">`);
      }
    }
  });
});
